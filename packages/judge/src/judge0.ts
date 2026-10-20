/**
 * Judge0 CE API client + job execution.
 *
 * Drop-in replacement for the Piston client. Implements the same `executeOnce`
 * and `pingPiston` interfaces so the rest of the judge pipeline (`judge.ts`,
 * `compare.ts`) stays unchanged.
 *
 * Judge0 API shape (v1.13.1):
 *   POST /submissions?base64_encoded=true&wait=true
 *   { language_id, source_code (base64), stdin (base64), compiler_options?,
 *     cpu_time_limit, cpu_extra_time, memory_limit, ... }
 *   -> { stdout (base64), stderr (base64), compile_output (base64), time, memory,
 *        status: { id, description }, exit_code, ... }
 *
 * IMPORTANT: We use base64 encoding because Judge0 CE v1.13.1 fails with
 * "cannot be converted to UTF-8" when compiler_options contain special chars
 * like `++` in `-std=c++17`.
 */

import type { LanguageConfig } from './languages';
import { createZip } from './zip';

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

const JUDGE0_URL = process.env.JUDGE0_URL ?? 'http://localhost:2358';
const JUDGE0_API_KEY = process.env.JUDGE0_API_KEY ?? '';

function getJudge0Headers(): Record<string, string> {
  if (JUDGE0_API_KEY) {
    return {
      'X-RapidAPI-Key': JUDGE0_API_KEY,
      'X-RapidAPI-Host': 'judge0-ce.p.rapidapi.com',
    };
  }
  return {};
}

/**
 * Judge0 language IDs for the languages Zapdos supports.
 * These match Judge0 CE v1.13.1.
 */
const JUDGE0_LANGUAGE_IDS: Record<string, number> = {
  cpp: 54,     // C++ (GCC 9.2.0)
  python: 71,  // Python (3.8.1)
  java: 62,    // Java (OpenJDK 13.0.1)
};

/**
 * Judge0 status IDs that map to our verdicts.
 */
const Judge0Status = {
  ACCEPTED: 3,
  WRONG_ANSWER: 4,
  TLE: 5,
  COMPILATION_ERROR: 6,
  RE_SIGSEGV: 7,
  RE_SIGXFSZ: 8,
  RE_SIGFPE: 9,
  RE_SIGABRT: 10,
  RE_NZEC: 11,
  RE_OTHER: 12,
  INTERNAL_ERROR: 13,
  EXEC_FORMAT_ERROR: 14,
} as const;

export interface PistonRunResult {
  compile: { stdout: string; stderr: string; code: number | null } | null;
  run: {
    stdout: string;
    stderr: string;
    code: number | null;
    signal: string | null;
    cpu_time_ms: number | null;
    memory_bytes: number | null;
  };
}

export interface ExecuteOptions {
  language: LanguageConfig;
  source: string;
  stdin: string;
  cpuTimeLimitMs: number;
  memoryLimitMb: number;
  httpTimeoutMs?: number;
}

interface Judge0SubmissionResponse {
  stdout: string | null;
  stderr: string | null;
  compile_output: string | null;
  time: string | null;
  memory: number | null;
  exit_code: number | null;
  status: { id: number; description: string };
  message: string | null;
}

interface Judge0ErrorResponse {
  error: string;
  token?: string;
}

/**
 * Global throttle on concurrent in-flight Judge0 jobs.
 *
 * With compile-once batching each submission is a SINGLE Judge0 job (not one
 * per test case), so this caps how many submissions we judge at once. It sits a
 * bit above the worker pool (6) so workers stay fed without us flooding Judge0
 * or building hundreds of zips at once. Queue-wait does not cause false TLE:
 * per-case limits are CPU-time based (ulimit -t), and our poll/abort budget
 * scales with the box wall limit. Configured via JUDGE0_MAX_CONCURRENT.
 */
const JUDGE0_MAX_CONCURRENT = (() => {
  const v = Number(process.env.JUDGE0_MAX_CONCURRENT ?? '12');
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 12;
})();

let activeJudge0 = 0;
const judge0Queue: (() => void)[] = [];

function acquireJudge0Slot(): Promise<void> {
  if (activeJudge0 < JUDGE0_MAX_CONCURRENT) {
    activeJudge0++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    judge0Queue.push(() => {
      activeJudge0++;
      resolve();
    });
  });
}

function releaseJudge0Slot(): void {
  activeJudge0--;
  const next = judge0Queue.shift();
  if (next) next();
}

function decodeBase64(s: string | null): string {
  if (!s) return '';
  return Buffer.from(s, 'base64').toString('utf-8');
}

function mapJudge0ToPistonResult(data: Judge0SubmissionResponse): PistonRunResult {
  const compileOutput = decodeBase64(data.compile_output);
  const hasCompileOutput = compileOutput.trim().length > 0;
  const compileFailed = hasCompileOutput && data.status.id !== Judge0Status.ACCEPTED;

  return {
    compile: hasCompileOutput
      ? {
          stdout: '',
          stderr: compileOutput,
          code: compileFailed ? 1 : 0,
        }
      : null,
    run: {
      stdout: decodeBase64(data.stdout),
      stderr: decodeBase64(data.stderr),
      code: data.exit_code ?? 0,
      signal: mapStatusToSignal(data.status.id),
      cpu_time_ms: data.time ? Math.round(parseFloat(data.time) * 1000) : null,
      memory_bytes: data.memory ? data.memory * 1024 : null, // Judge0 reports KB
    },
  };
}

function mapStatusToSignal(statusId: number): string | null {
  switch (statusId) {
    case Judge0Status.TLE:
      return 'SIGKILL';
    case Judge0Status.RE_SIGSEGV:
      return 'SIGSEGV';
    case Judge0Status.RE_SIGFPE:
    case Judge0Status.RE_SIGXFSZ:
    case Judge0Status.RE_SIGABRT:
      return 'SIGBUS';
    default:
      return null;
  }
}

export async function executeOnce(opts: ExecuteOptions): Promise<PistonRunResult> {
  const { language, source, stdin, cpuTimeLimitMs, memoryLimitMb, httpTimeoutMs } = opts;

  const languageId = JUDGE0_LANGUAGE_IDS[language.id];
  if (!languageId) {
    throw new Error(`Unsupported language for Judge0: ${language.id}`);
  }

  // NOTE: The Judge0 server runs GCC 9.2.0 (verified via /languages/54), which
  // does NOT support -std=c++20 (that needs GCC 10+). Using c++20 here makes the
  // compiler reject the flag and turns EVERY C++ submission into a compile error.
  // Keep c++17 until the Judge0 image is upgraded to a newer GCC.
  const compilerOptions =
    language.id === 'cpp' ? '-O2 -std=c++17' : undefined;

  // IMPORTANT: wait=false (async submit + poll). Synchronous wait=true mode is
  // unreliable on this Judge0 deployment — it intermittently holds the HTTP
  // connection open indefinitely instead of returning, which then trips our
  // abort timer and surfaces a CORRECT solution as a false TLE. Async submit +
  // GET-poll is Judge0's recommended production pattern and is rock-solid here.
  const params = new URLSearchParams({
    base64_encoded: 'true',
    wait: 'false',
  });

  // CPU limit as a float (Judge0 accepts decimals) — avoids the lossy
  // integer rounding that could silently shrink a 1.5s limit. Floor at 1s.
  const cpuSeconds = Math.max(1, Number((cpuTimeLimitMs / 1000).toFixed(2)));
  // Wall limit must be generous: under CPU contention a CORRECT program needs
  // far more wall time than CPU time. A tight wall limit causes false TLE.
  const wallSeconds = Math.min(60, Math.ceil(cpuSeconds) + 10);

  const body: Record<string, unknown> = {
    language_id: languageId,
    source_code: Buffer.from(source).toString('base64'),
    stdin: Buffer.from(stdin).toString('base64'),
    cpu_time_limit: cpuSeconds,
    cpu_extra_time: 2,
    wall_time_limit: wallSeconds,
    // Memory limit in KB. Cap at Judge0 CE max (512000 KB).
    // Use at least 128MB for compilation.
    memory_limit: Math.min(Math.max(memoryLimitMb * 1024, 128000), 512000),
    stack_limit: 128000,
    max_file_size: 4096,
    enable_network: false,
    // CRITICAL: keep BOTH per-process limit flags FALSE so isolate runs in
    // cgroup mode (`isolate --cg ... --cg-mem=...`). The host kernel uses
    // cgroup v2, on which isolate's non-cgroup `-m` (RLIMIT_AS) path is broken:
    // it hangs the sandbox and Judge0 records a status-13 Internal Error. We
    // verified directly against the live server that the per-process path fails
    // en masse while cgroup mode runs the same code correctly in milliseconds.
    enable_per_process_and_thread_time_limit: false,
    enable_per_process_and_thread_memory_limit: false,
  };

  if (compilerOptions) {
    body.compiler_options = compilerOptions;
  }

  // Acquire a Judge0 slot BEFORE starting the abort timer, so queue-wait time
  // is never counted against the request's HTTP timeout (which would falsely
  // surface as TLE for a submission that simply waited in line).
  await acquireJudge0Slot();

  const controller = new AbortController();
  // HTTP timeout generously exceeds the wall limit so a legitimately slow
  // (but within-limit) run completes rather than aborting into a false TLE.
  const httpTimeout = httpTimeoutMs ?? wallSeconds * 1000 + 20000;
  const timer = setTimeout(() => controller.abort(), httpTimeout);

  try {
    // Up to 2 attempts: a transient Judge0 status-13 Internal Error (rare in
    // cgroup mode, but possible under heavy isolate-box contention) is retried
    // once before we give up, rather than letting it corrupt a verdict.
    let lastInternalError: Judge0SubmissionResponse | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      // Submit the code (async — returns a token immediately).
      const res = await fetch(`${JUDGE0_URL}/submissions?${params}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getJudge0Headers(),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Judge0 HTTP ${res.status}: ${text}`);
      }

      const data = await res.json();

      // Async mode returns {token}. (If a future server honours wait=true and
      // returns a full result inline, use it directly.)
      let resultData: Judge0SubmissionResponse;
      if (data.token && !data.status) {
        resultData = await pollForResult(data.token, controller.signal);
      } else {
        resultData = data as Judge0SubmissionResponse;
      }

      // Judge0 returns an error object instead of status when something is wrong
      if ('error' in resultData) {
        throw new Error(`Judge0 error: ${(resultData as unknown as Judge0ErrorResponse).error}`);
      }

      // Status 13 = Internal Error (isolate failed). Retry once; if it persists,
      // surface it as an error so the caller reports a judge fault, NOT a TLE/WA.
      if (resultData.status?.id === Judge0Status.INTERNAL_ERROR) {
        lastInternalError = resultData;
        continue;
      }

      return mapJudge0ToPistonResult(resultData);
    }

    const detail = lastInternalError?.message
      ? decodeBase64(lastInternalError.message)
      : 'unknown';
    throw new Error(`Judge0 internal error (status 13) after retry: ${detail}`);
  } catch (err) {
    // Map AbortError to TLE so the submission route shows TLE instead of CE
    if (err instanceof Error && err.name === 'AbortError') {
      throw new TimeoutError(`Judge0 request timed out after ${httpTimeout}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    releaseJudge0Slot();
  }
}

/**
 * Poll Judge0 for a submission result by token.
 * Retries every 200ms until the submission is no longer "In Queue" or "Processing".
 */
async function pollForResult(token: string, signal: AbortSignal): Promise<Judge0SubmissionResponse> {
  // The real bound is the caller's abort signal (its timeout scales with the
  // job's box wall limit). This cap is just a safety ceiling (~150s) so a
  // never-firing signal can't loop forever.
  const maxAttempts = 750;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (signal.aborted) throw new TimeoutError('Polling aborted');

    const res = await fetch(`${JUDGE0_URL}/submissions/${token}?base64_encoded=true`, {
      headers: getJudge0Headers(),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Judge0 poll HTTP ${res.status}: ${text}`);
    }

    const data = (await res.json()) as Judge0SubmissionResponse;

    // Status IDs: 1=In Queue, 2=Processing, 3+=Done (AC/WA/TLE/etc.)
    if (data.status && data.status.id > 2) {
      return data;
    }
  }
  throw new TimeoutError(`Judge0 submission ${token} timed out after polling`);
}

// ---------------------------------------------------------------------------
// Compile-once, run-many (Judge0 "Multi-file program", language id 89).
//
// A single submission with N test cases used to mean N Judge0 submissions, each
// recompiling the source — catastrophic when `#include <bits/stdc++.h> -O2`
// takes ~2s to compile and a problem has dozens of cases. Here we bundle the
// source, a compile script, a run harness, and every test input into one zip,
// so the code compiles ONCE and the harness runs the compiled program against
// each input in turn. One Judge0 job per submission instead of N.
//
// The harness enforces a per-case CPU limit via `ulimit -t` (CPU time, immune
// to wall-clock contention — the key to no false TLE under concurrent load) and
// a generous per-case wall timeout as a backstop against hung processes. It
// streams a nonce-delimited transcript we parse back into per-case results, and
// stops at the first failing case (CP convention: first failure decides).
// ---------------------------------------------------------------------------

const MULTI_FILE_LANGUAGE_ID = 89;

export interface BatchCaseResult {
  stdout: string;
  stderr: string;
  /** Process exit code; 128+signal when killed by a signal. */
  exitCode: number;
  /** Wall time for the case in ms (approximate; CPU limit is what gates TLE). */
  timeMs: number;
}

export interface BatchResult {
  /** Non-null only on compile failure; the verdict is then CE. */
  compileError: string | null;
  /** Per-case results, in order, up to and including the first failing case. */
  cases: BatchCaseResult[];
  /** True if the harness ran to completion (vs the sandbox killing it early). */
  completed: boolean;
}

export interface ExecuteBatchOptions {
  language: LanguageConfig;
  source: string;
  inputs: string[];
  /** Per-case CPU limit (ms). Enforced via ulimit -t (rounded up to seconds). */
  cpuTimeLimitMs: number;
  /** Per-case wall backstop (ms). */
  wallTimeLimitMs: number;
  /** Memory limit (MB) for the sandbox cgroup. */
  memoryLimitMb: number;
}

interface MultiFileLang {
  sourceName: string;
  compileScript: string;
  /** Command the harness runs per case (stdin/stdout redirected by the harness). */
  runOneScript: string;
}

function multiFileLangConfig(language: LanguageConfig): MultiFileLang {
  switch (language.id) {
    case 'cpp':
      return {
        sourceName: 'main.cpp',
        compileScript:
          '#!/usr/bin/env bash\n' +
          '/usr/local/gcc-9.2.0/bin/g++ -O2 -std=c++17 main.cpp -o a.out\n',
        runOneScript:
          '#!/usr/bin/env bash\n' +
          'export LD_LIBRARY_PATH=/usr/local/gcc-9.2.0/lib64\n' +
          'exec ./a.out\n',
      };
    case 'python':
      return {
        sourceName: 'script.py',
        // py_compile turns a syntax error into a compile error (CE) instead of a
        // runtime error on the first case.
        compileScript:
          '#!/usr/bin/env bash\n' +
          '/usr/local/python-3.8.1/bin/python3 -m py_compile script.py\n',
        runOneScript:
          '#!/usr/bin/env bash\n' +
          'exec /usr/local/python-3.8.1/bin/python3 script.py\n',
      };
    case 'java':
      return {
        sourceName: 'Main.java',
        compileScript:
          '#!/usr/bin/env bash\n' +
          '/usr/local/openjdk13/bin/javac Main.java\n',
        runOneScript:
          '#!/usr/bin/env bash\n' +
          'exec /usr/local/openjdk13/bin/java -XX:+UseSerialGC Main\n',
      };
    default:
      throw new Error(`Unsupported language for batch judging: ${language.id}`);
  }
}

/** Build the bash harness that runs the compiled program against every case. */
export function buildRunHarness(
  n: number,
  cpuSeconds: number,
  wallSeconds: number,
  cap: number,
  nonce: string,
  memoryMb?: number,
): string {
  return [
    '#!/usr/bin/env bash',
    `N=${n}`,
    `CPU_S=${cpuSeconds}`,
    `WALL_S=${wallSeconds}`,
    `CAP=${cap}`,
    ...(memoryMb ? [`export MEM_MB=${memoryMb}`] : []),
    `S='${nonce}'`,
    'for ((i=1;i<=N;i++)); do',
    '  start=$(date +%s%N)',
    '  ( ulimit -t "$CPU_S"; exec timeout -s KILL "${WALL_S}s" bash __run_one.sh ) < "tc_${i}.txt" > "out_${i}" 2> "err_${i}"',
    '  code=$?',
    '  end=$(date +%s%N)',
    '  ms=$(( (end - start) / 1000000 ))',
    "  printf '%sH%d %d %d\\n' \"$S\" \"$i\" \"$code\" \"$ms\"",
    '  head -c "$CAP" "out_${i}"',
    "  printf '%sR%d\\n' \"$S\" \"$i\"",
    '  head -c 800 "err_${i}"',
    "  printf '%sT%d\\n' \"$S\" \"$i\"",
    '  if [ "$code" -ne 0 ]; then break; fi',
    'done',
    "printf '%sDONE\\n' \"$S\"",
    '',
  ].join('\n');
}

/** Parse the harness transcript back into ordered per-case results. */
export function parseBatchTranscript(transcript: string, nonce: string, n: number): BatchCaseResult[] {
  const cases: BatchCaseResult[] = [];
  for (let i = 1; i <= n; i++) {
    const hMarker = `${nonce}H${i} `;
    const rMarker = `${nonce}R${i}`;
    const tMarker = `${nonce}T${i}`;
    const hIdx = transcript.indexOf(hMarker);
    if (hIdx === -1) break; // not reached (we stop at first failure)
    const hLineEnd = transcript.indexOf('\n', hIdx);
    if (hLineEnd === -1) break;
    const header = transcript.slice(hIdx + hMarker.length, hLineEnd); // "code ms"
    const [codeStr, msStr] = header.split(' ');
    const rIdx = transcript.indexOf(rMarker, hLineEnd);
    const tIdx = rIdx === -1 ? -1 : transcript.indexOf(tMarker, rIdx);
    if (rIdx === -1 || tIdx === -1) break; // truncated transcript
    const stdout = transcript.slice(hLineEnd + 1, rIdx);
    const stderr = transcript.slice(rIdx + rMarker.length, tIdx);
    cases.push({
      exitCode: Number(codeStr ?? '0') || 0,
      timeMs: Number(msStr ?? '0') || 0,
      stdout,
      stderr,
    });
  }
  return cases;
}

/**
 * Compile once and run the source against every input in a single Judge0 job.
 */
export async function executeBatch(opts: ExecuteBatchOptions): Promise<BatchResult> {
  const { language, source, inputs, cpuTimeLimitMs, wallTimeLimitMs, memoryLimitMb } = opts;
  if (inputs.length === 0) return { compileError: null, cases: [], completed: true };

  const cfg = multiFileLangConfig(language);
  const nonce = `J0x${randomNonce()}x`;
  const cpuSeconds = Math.max(1, Math.ceil(cpuTimeLimitMs / 1000));
  const wallSeconds = Math.max(cpuSeconds + 2, Math.ceil(wallTimeLimitMs / 1000));
  const OUTPUT_CAP_BYTES = 5_000_000; // per-case stdout cap

  // Box-level (whole run) limits, kept within the Judge0 server's configured
  // MAX_CPU_TIME_LIMIT (40) / MAX_WALL_TIME_LIMIT (60). Per-case limits are
  // enforced inside the harness; these are generous backstops. Break-on-failure
  // keeps the real total small for correct/WA solutions (every case exits fast).
  const boxCpu = Math.min(38, inputs.length * cpuSeconds + 12);
  const boxWall = Math.min(58, boxCpu + 20);

  const files = [
    { name: cfg.sourceName, content: source },
    { name: 'compile', content: cfg.compileScript },
    { name: 'run', content: buildRunHarness(inputs.length, cpuSeconds, wallSeconds, OUTPUT_CAP_BYTES, nonce) },
    { name: '__run_one.sh', content: cfg.runOneScript },
    ...inputs.map((input, i) => ({ name: `tc_${i + 1}.txt`, content: input })),
  ];
  const zipB64 = createZip(files).toString('base64');

  const params = new URLSearchParams({ base64_encoded: 'true', wait: 'false' });
  const body = {
    language_id: MULTI_FILE_LANGUAGE_ID,
    additional_files: zipB64,
    cpu_time_limit: boxCpu,
    cpu_extra_time: 2,
    wall_time_limit: boxWall,
    memory_limit: Math.min(Math.max(memoryLimitMb * 1024 + 32000, 256000), 512000),
    stack_limit: 128000,
    max_file_size: 65536,
    enable_network: false,
    enable_per_process_and_thread_time_limit: false,
    enable_per_process_and_thread_memory_limit: false,
  };

  await acquireJudge0Slot();
  const controller = new AbortController();
  const httpTimeout = boxWall * 1000 + 30000;
  const timer = setTimeout(() => controller.abort(), httpTimeout);

  try {
    let lastInternalError: Judge0SubmissionResponse | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`${JUDGE0_URL}/submissions?${params}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getJudge0Headers() },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Judge0 HTTP ${res.status}: ${text}`);
      }
      const data = await res.json();
      const resultData: Judge0SubmissionResponse =
        data.token && !data.status ? await pollForResult(data.token, controller.signal) : (data as Judge0SubmissionResponse);

      if ('error' in resultData) {
        throw new Error(`Judge0 error: ${(resultData as unknown as Judge0ErrorResponse).error}`);
      }
      if (resultData.status?.id === Judge0Status.INTERNAL_ERROR) {
        lastInternalError = resultData;
        continue;
      }

      // Compilation failed -> CE. (Judge0 marks the whole job status 6.)
      const compileOutput = decodeBase64(resultData.compile_output);
      if (resultData.status?.id === Judge0Status.COMPILATION_ERROR || (compileOutput.trim() && resultData.status?.id !== Judge0Status.ACCEPTED && (resultData.stdout ?? '') === '')) {
        return { compileError: compileOutput.trim() || 'Compilation failed', cases: [], completed: true };
      }

      const transcript = decodeBase64(resultData.stdout);
      return {
        compileError: null,
        cases: parseBatchTranscript(transcript, nonce, inputs.length),
        completed: transcript.includes(`${nonce}DONE`),
      };
    }

    const detail = lastInternalError?.message ? decodeBase64(lastInternalError.message) : 'unknown';
    throw new Error(`Judge0 internal error (status 13) after retry: ${detail}`);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new TimeoutError(`Judge0 batch request timed out after ${httpTimeout}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    releaseJudge0Slot();
  }
}

function randomNonce(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Liveness check used by health endpoints. */
export async function pingPiston(): Promise<boolean> {
  try {
    const res = await fetch(`${JUDGE0_URL}/languages`, {
      headers: getJudge0Headers(),
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
