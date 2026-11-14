/**
 * Local judge backend (`JUDGE_BACKEND=local`): compile and run submissions with the toolchains installed on this
 * machine.  It exists so the whole platform - matchmaking, battles, verdicts, anti-cheat - runs end to end on a
 * laptop or CI box with no Judge0, no Docker-in-Docker and no cgroups.
 *
 * Same contract as `executeBatch` (Judge0) and `executeBatchInSandbox` (Vercel Sandbox): compile ONCE, run every
 * test input, stop at the first case that does not exit cleanly, report per-case stdout / stderr / exit code / wall
 * time.  `judgeSubmission` then classifies the cases exactly as it does for the other backends.
 *
 * What it does enforce
 *   - a compile step per language (CE on failure; Python is syntax-checked with py_compile like the Judge0 harness);
 *   - a CPU-time limit per case (`ulimit -t`, kills with SIGXCPU -> exit 152 -> TLE);
 *   - a wall-clock backstop per case that kills the whole process group (-> exit 124 -> TLE);
 *   - stdout / stderr caps (runaway output kills the process -> exit 153 -> RE);
 *   - an address-space limit (`ulimit -v`) on Linux for C++/Python, and `-Xmx` for Java (-> MLE via the error text);
 *   - a minimal environment: the submission never sees this process's secrets (AUTH_SECRET, DATABASE_URL ...).
 *
 * What it does NOT do (this is a development backend, NOT a security boundary - use Judge0/isolate or the Vercel
 * Sandbox for untrusted code in production):
 *   - no filesystem or network isolation: a submission can read files and open sockets as the server's user;
 *     (the AST anti-cheat flags such calls, but that is detection, not prevention);
 *   - no memory limit for C++/Python on macOS (`ulimit -v` is not enforced there);
 *   - no CPU-time accounting for child processes the submission itself spawns beyond the process group kill.
 */

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { constants as osConstants, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCaseResult, BatchResult, ExecuteBatchOptions } from './judge0';

const COMPILE_TIMEOUT_MS = 60_000;
const STDOUT_CAP_BYTES = 16 * 1024 * 1024;
const STDERR_CAP_BYTES = 64 * 1024;
const TOTAL_BUDGET_MS = 5 * 60_000;

/** Exit codes the shared classifier in judge.ts already understands (see classifyCase). */
const EXIT_WALL_TIMEOUT = 124; // what `timeout(1)` returns
const EXIT_OUTPUT_LIMIT = 153; // 128 + SIGXFSZ

function tool(name: 'gpp' | 'python' | 'javac' | 'java'): string {
  const env = {
    gpp: process.env.LOCAL_JUDGE_GPP,
    python: process.env.LOCAL_JUDGE_PYTHON,
    javac: process.env.LOCAL_JUDGE_JAVAC,
    java: process.env.LOCAL_JUDGE_JAVA,
  }[name];
  return env || { gpp: 'g++', python: 'python3', javac: 'javac', java: 'java' }[name];
}

/** macOS's libc++ has no <bits/stdc++.h>, which most competitive-programming C++ includes. Shim it when missing. */
const BITS_SHIM = [
  'algorithm', 'array', 'bitset', 'cassert', 'cctype', 'chrono', 'climits', 'cmath', 'complex', 'cstdint', 'cstdio',
  'cstdlib', 'cstring', 'ctime', 'deque', 'functional', 'iomanip', 'iostream', 'iterator', 'limits', 'list', 'map',
  'numeric', 'queue', 'random', 'set', 'sstream', 'stack', 'string', 'tuple', 'unordered_map', 'unordered_set',
  'utility', 'vector',
].map((header) => `#include <${header}>`).join('\n');

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  wallMs: number;
  timedOut: boolean;
  outputTruncated: boolean;
  spawnError?: string;
}

interface RunOptions {
  cwd: string;
  input?: string;
  wallMs: number;
  stdoutCap?: number;
  stderrCap?: number;
}

function minimalEnv(home: string): NodeJS.ProcessEnv {
  // Deliberately NOT a copy of process.env: submitted code must not see AUTH_SECRET, DATABASE_URL, REDIS_URL ...
  // (the cast is only because Next's type augmentation makes NODE_ENV mandatory on ProcessEnv).
  return { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: home, TMPDIR: home } as unknown as NodeJS.ProcessEnv;
}

function runProcess(command: string, args: string[], options: RunOptions): Promise<ProcessResult> {
  const stdoutCap = options.stdoutCap ?? STDOUT_CAP_BYTES;
  const stderrCap = options.stderrCap ?? STDERR_CAP_BYTES;
  return new Promise((resolve) => {
    const started = performance.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let outputTruncated = false;
    let settled = false;

    const finish = (result: Partial<ProcessResult> & { exitCode: number }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout, stderr, timedOut, outputTruncated, wallMs: performance.now() - started, ...result,
      });
    };

    let child: ReturnType<typeof spawn>;
    try {
      // detached => its own process group, so a kill takes down anything the program forked as well.
      child = spawn(command, args, { cwd: options.cwd, env: minimalEnv(options.cwd), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (error) {
      resolve({ exitCode: 127, stdout, stderr, wallMs: 0, timedOut: false, outputTruncated: false, spawnError: String(error) });
      return;
    }
    const killGroup = (): void => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, options.wallMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length + chunk.length > stdoutCap) {
        outputTruncated = true;
        stdout += chunk.toString('utf8').slice(0, Math.max(0, stdoutCap - stdout.length));
        killGroup();
      } else {
        stdout += chunk.toString('utf8');
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < stderrCap) stderr += chunk.toString('utf8').slice(0, stderrCap - stderr.length);
    });
    child.stdin?.on('error', () => { /* the program may exit without reading its input (EPIPE) */ });
    child.stdin?.end(options.input ?? '');
    child.on('error', (error: NodeJS.ErrnoException) => finish({ exitCode: 127, spawnError: error.code === 'ENOENT' ? `${command}: command not found` : error.message }));
    child.on('close', (code, signal) => {
      const exitCode = signal ? 128 + (osConstants.signals[signal as keyof typeof osConstants.signals] ?? 0) : (code ?? 0);
      finish({ exitCode });
    });
  });
}

interface LanguageSetup {
  sourceName: string;
  /** null = nothing to compile before running. */
  compile: ((dir: string) => { command: string; args: string[] }) | null;
  run: (memoryMb: number) => string[];
  preparation?: (dir: string) => Promise<void>;
}

function setupFor(id: string): LanguageSetup {
  switch (id) {
    case 'cpp':
      return {
        sourceName: 'main.cpp',
        preparation: async (dir) => {
          await mkdir(join(dir, 'include', 'bits'), { recursive: true });
          await writeFile(join(dir, 'include', 'bits', 'stdc++.h'), `#pragma once\n${BITS_SHIM}\n`);
        },
        // -idirafter: the shim is only used when the system really has no <bits/stdc++.h>
        compile: (dir) => ({ command: tool('gpp'), args: ['-O2', '-std=c++17', '-pipe', '-idirafter', join(dir, 'include'), 'main.cpp', '-o', 'a.out'] }),
        run: () => ['./a.out'],
      };
    case 'python':
      return {
        sourceName: 'script.py',
        // py_compile turns a syntax error into a compile error (CE), as the Judge0 harness does.
        compile: () => ({ command: tool('python'), args: ['-m', 'py_compile', 'script.py'] }),
        run: () => [tool('python'), 'script.py'],
      };
    case 'java':
      return {
        sourceName: 'Main.java',
        compile: () => ({ command: tool('javac'), args: ['Main.java'] }),
        run: (memoryMb) => [tool('java'), '-XX:+UseSerialGC', `-Xmx${Math.max(64, memoryMb)}m`, 'Main'],
      };
    default:
      throw new Error(`Unsupported language for the local judge: ${id}`);
  }
}

/** Wraps the program so the CPU-time (and, on Linux, address-space) limit is set in the child before it is exec'd. */
const LIMIT_SCRIPT = 'ulimit -t "$1" 2>/dev/null; if [ "$2" -gt 0 ]; then ulimit -v "$2" 2>/dev/null; fi; shift 2; exec "$@"';

export async function executeBatchLocal(options: ExecuteBatchOptions): Promise<BatchResult> {
  const setup = setupFor(options.language.id);
  const dir = await mkdtemp(join(tmpdir(), 'zapdos-judge-'));
  try {
    await setup.preparation?.(dir);
    await writeFile(join(dir, setup.sourceName), options.source);

    if (setup.compile) {
      const { command, args } = setup.compile(dir);
      const compiled = await runProcess(command, args, { cwd: dir, wallMs: COMPILE_TIMEOUT_MS });
      if (compiled.spawnError) throw new Error(`Local judge toolchain unavailable (${compiled.spawnError})`);
      if (compiled.exitCode !== 0) {
        return { compileError: (compiled.stderr || compiled.stdout || 'Compilation failed').trim(), cases: [], completed: true };
      }
    }

    const cpuSeconds = Math.max(1, Math.ceil(options.cpuTimeLimitMs / 1000));
    // `ulimit -v` breaks the JVM (it reserves a lot of address space) and is ignored by macOS, so only C++/Python on Linux.
    const addressSpaceKb = process.platform === 'linux' && options.language.id !== 'java' ? options.memoryLimitMb * 1024 * 4 : 0;
    const command = setup.run(options.memoryLimitMb);
    const deadline = performance.now() + TOTAL_BUDGET_MS;

    const cases: BatchCaseResult[] = [];
    for (const input of options.inputs) {
      if (performance.now() > deadline) return { compileError: null, cases, completed: false };
      const result = await runProcess(
        '/bin/sh',
        ['-c', LIMIT_SCRIPT, 'sh', String(cpuSeconds), String(addressSpaceKb), ...command],
        { cwd: dir, input, wallMs: options.wallTimeLimitMs },
      );
      const exitCode = result.timedOut ? EXIT_WALL_TIMEOUT : result.outputTruncated ? EXIT_OUTPUT_LIMIT : result.exitCode;
      cases.push({ stdout: result.stdout, stderr: result.stderr, exitCode, timeMs: Math.round(result.wallMs) });
      if (exitCode !== 0) break; // same as the Judge0 harness: stop at the first case that fails to run cleanly
    }
    return { compileError: null, cases, completed: true };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Health check: are the compilers / interpreters for the three judged languages installed? */
export async function pingLocal(): Promise<{ ok: boolean; backend: 'local'; detail?: string }> {
  const probes: Array<[string, string, string[]]> = [
    ['cpp', tool('gpp'), ['--version']],
    ['python', tool('python'), ['--version']],
    ['java', tool('javac'), ['-version']],
  ];
  const missing: string[] = [];
  for (const [language, command, args] of probes) {
    const result = await runProcess(command, args, { cwd: tmpdir(), wallMs: 10_000 });
    if (result.spawnError || result.exitCode !== 0) missing.push(language);
  }
  return missing.length === 0
    ? { ok: true, backend: 'local' }
    : { ok: false, backend: 'local', detail: `Missing toolchain for: ${missing.join(', ')}` };
}
