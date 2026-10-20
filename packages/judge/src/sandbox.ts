/**
 * Vercel Sandbox judge backend.
 *
 * The public Judge0 instance is too small for Zapdos (20s CPU / 30s wall /
 * 20KB source), and Vercel Hobby functions can run for 300s. This backend runs
 * the same compile-once/run-many harness inside a Vercel Sandbox:
 *
 *   Sandbox.create({ source: { type: 'snapshot', snapshotId } })
 *     -> write source + harness + test inputs
 *     -> bash compile.sh
 *     -> bash run.sh
 *     -> parse the nonce-delimited transcript
 *     -> sandbox.stop()
 *
 * The snapshot is built by `packages/judge/scripts/create-sandbox-snapshot.ts`
 * and must contain g++, python3, and OpenJDK 21. Sandboxes are single-use and
 * get `networkPolicy: 'deny-all'`; the only resource they consume is the
 * Hobby plan's sandbox CPU-hours.
 */

import type { Sandbox as SandboxInstance } from '@vercel/sandbox';
import type { LanguageConfig } from './languages';
import {
  TimeoutError,
  buildRunHarness,
  parseBatchTranscript,
  type BatchResult,
  type ExecuteBatchOptions,
} from './judge0';

const SNAPSHOT_ID = process.env.JUDGE_SANDBOX_SNAPSHOT_ID ?? '';
const SANDBOX_REGION = process.env.JUDGE_SANDBOX_REGION ?? 'iad1';
const MAX_CONCURRENT = (() => {
  const v = Number(process.env.JUDGE_SANDBOX_MAX_CONCURRENT ?? '6');
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 6;
})();

type SandboxModule = typeof import('@vercel/sandbox');

let sandboxModulePromise: Promise<SandboxModule> | null = null;

/**
 * Load the SDK through Node's native ESM loader.
 *
 * The package is ESM but Next's serverless bundle runs as CommonJS and its
 * `require` shim cannot load ESM-only dependencies (`@workflow/serde`, `jose`).
 * `scripts/bundle-sandbox.mjs` produces a standalone ESM bundle so native
 * `import()` does not depend on pnpm's symlink layout in the deployment.
 */
export function loadSandboxModule(): Promise<SandboxModule> {
  if (!sandboxModulePromise) {
    sandboxModulePromise = (async () => {
      const [{ existsSync }, { join, dirname }, { pathToFileURL }] = await Promise.all([
        import('node:fs'),
        import('node:path'),
        import('node:url'),
      ]);
      const candidates: string[] = [];
      let dir = process.cwd();
      for (let i = 0; i < 4; i += 1) {
        candidates.push(
          join(dir, 'sandbox', 'sandbox.mjs'),
          join(dir, 'apps', 'web', 'sandbox', 'sandbox.mjs'),
        );
        dir = dirname(dir);
      }
      const entry = candidates.find((candidate) => existsSync(candidate));
      if (!entry) {
        throw new Error(`Sandbox bundle not found from ${process.cwd()}`);
      }
      const nativeImport = new Function(
        'specifier',
        'return import(specifier)',
      ) as (specifier: string) => Promise<SandboxModule>;
      return nativeImport(pathToFileURL(entry).href);
    })();
  }
  return sandboxModulePromise;
}

let active = 0;
const waiters: (() => void)[] = [];

function acquireSlot(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    waiters.push(() => {
      active++;
      resolve();
    });
  });
}

function releaseSlot(): void {
  active--;
  waiters.shift()?.();
}

interface SandboxLanguageConfig {
  sourceName: string;
  compileScript: string;
  runOneScript: string;
}

function sandboxLanguageConfig(language: LanguageConfig): SandboxLanguageConfig {
  switch (language.id) {
    case 'cpp':
      return {
        sourceName: 'main.cpp',
        compileScript:
          '#!/usr/bin/env bash\n' +
          'set -euo pipefail\n' +
          'g++ -O2 -std=c++17 main.cpp -o a.out\n',
        runOneScript:
          '#!/usr/bin/env bash\n' +
          'ulimit -v $((MEM_MB * 1024)) 2>/dev/null || true\n' +
          'exec ./a.out\n',
      };
    case 'python':
      return {
        sourceName: 'script.py',
        compileScript:
          '#!/usr/bin/env bash\n' +
          'set -euo pipefail\n' +
          'python3 -m py_compile script.py\n',
        runOneScript:
          '#!/usr/bin/env bash\n' +
          'ulimit -v $((MEM_MB * 1024)) 2>/dev/null || true\n' +
          'exec python3 script.py\n',
      };
    case 'java':
      return {
        sourceName: 'Main.java',
        compileScript:
          '#!/usr/bin/env bash\n' +
          'set -euo pipefail\n' +
          'javac Main.java\n',
        runOneScript:
          '#!/usr/bin/env bash\n' +
          'exec java -Xmx"${MEM_MB}"m -XX:MaxMetaspaceSize=256m -XX:+UseSerialGC Main\n',
      };
    default:
      throw new Error(`Unsupported language for sandbox judging: ${language.id}`);
  }
}

function isTimeout(error: unknown): boolean {
  if (error instanceof TimeoutError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /timed?\s*out|timeout|SIGKILL/i.test(message);
}

/**
 * Compile once and run every test input inside a fresh Vercel Sandbox.
 * Mirrors `judge0.executeBatch`, so `judge.ts` can switch backends unchanged.
 */
export async function executeBatchInSandbox(
  opts: ExecuteBatchOptions,
): Promise<BatchResult> {
  const { language, source, inputs, cpuTimeLimitMs, wallTimeLimitMs, memoryLimitMb } = opts;
  if (inputs.length === 0) return { compileError: null, cases: [], completed: true };
  if (!SNAPSHOT_ID) {
    throw new Error('JUDGE_SANDBOX_SNAPSHOT_ID is not set');
  }

  const cfg = sandboxLanguageConfig(language);
  const nonce = `VSx${Math.random().toString(36).slice(2)}x${Date.now().toString(36)}x`;
  const cpuSeconds = Math.max(1, Math.ceil(cpuTimeLimitMs / 1000));
  const wallSeconds = Math.max(cpuSeconds + 2, Math.ceil(wallTimeLimitMs / 1000));
  const OUTPUT_CAP_BYTES = 5_000_000;

  // Whole-run backstops. Break-on-first-failure keeps the real cost low for
  // correct/WA solutions, while a worst-case run still fits under the 300s
  // Vercel function limit.
  const boxCpu = Math.min(38, inputs.length * cpuSeconds + 12);
  const boxWall = Math.min(58, boxCpu + 20);

  const files = [
    { path: cfg.sourceName, content: source },
    { path: 'compile.sh', content: cfg.compileScript, mode: 0o755 },
    {
      path: 'run.sh',
      content: buildRunHarness(
        inputs.length,
        cpuSeconds,
        wallSeconds,
        OUTPUT_CAP_BYTES,
        nonce,
        memoryLimitMb,
      ),
      mode: 0o755,
    },
    { path: '__run_one.sh', content: cfg.runOneScript, mode: 0o755 },
    ...inputs.map((input, i) => ({ path: `tc_${i + 1}.txt`, content: input })),
  ];

  const { Sandbox } = await loadSandboxModule();
  await acquireSlot();

  let sandbox: SandboxInstance | null = null;
  try {
    sandbox = await Sandbox.create({
      source: { type: 'snapshot', snapshotId: SNAPSHOT_ID },
      timeout: Math.min(280_000, boxWall * 1000 + 60_000),
      resources: { vcpus: 1 },
      networkPolicy: 'deny-all',
      persistent: false,
      region: SANDBOX_REGION,
    });

    await sandbox.writeFiles(files);

    const compile = await sandbox.runCommand({
      cmd: 'bash',
      args: ['compile.sh'],
      timeoutMs: 60_000,
    });

    if (compile.exitCode !== 0) {
      const [stderr, stdout] = await Promise.all([compile.stderr(), compile.stdout()]);
      return {
        compileError: (stderr || stdout || 'Compilation failed').trim(),
        cases: [],
        completed: true,
      };
    }

    const run = await sandbox.runCommand({
      cmd: 'bash',
      args: ['run.sh'],
      timeoutMs: boxWall * 1000 + 20_000,
    });

    const transcript = await run.stdout();
    return {
      compileError: null,
      cases: parseBatchTranscript(transcript, nonce, inputs.length),
      completed: transcript.includes(`${nonce}DONE`),
    };
  } catch (error) {
    if (isTimeout(error)) {
      throw new TimeoutError(
        `Sandbox batch timed out: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw error;
  } finally {
    try {
      await sandbox?.stop();
    } catch (err) {
      console.error('[judge] failed to stop sandbox:', err);
    }
    releaseSlot();
  }
}

/**
 * Best-effort health signal. A real sandbox probe would consume CPU-hours on
 * every health check, so only verify the required configuration.
 */
export async function pingSandbox(): Promise<{
  ok: boolean;
  backend: 'sandbox';
  detail?: string;
}> {
  if (!SNAPSHOT_ID) {
    return {
      ok: false,
      backend: 'sandbox',
      detail: 'JUDGE_SANDBOX_SNAPSHOT_ID is not set',
    };
  }
  return { ok: true, backend: 'sandbox', detail: 'snapshot configured' };
}
