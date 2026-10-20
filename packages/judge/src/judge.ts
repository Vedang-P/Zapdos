/**
 * High-level judging: run a submission against a list of test cases and
 * produce a single verdict.
 *
 * Flow:
 *   1. Compile once (Piston does this per call, but compile errors short-circuit
 *      before any test case is run).
 *   2. Run each test case sequentially. Stop on first non-AC case for a clear
 *      verdict (TLE / MLE / RE / WA). CP convention: report the first failure.
 *   3. AC only if every case passes.
 *
 * Verdict precedence on failure: CE > TLE > MLE > RE > WA. We surface the
 * FIRST failing case's category, which matches user expectations on CF/Kattis.
 */

import { isOutputCorrect } from './compare';
import {
  executeBatch as executeBatchJudge0,
  pingPiston,
  TimeoutError,
  type BatchCaseResult,
} from './judge0';
import { executeBatchInSandbox, pingSandbox } from './sandbox';
import type { LanguageConfig } from './languages';

export type JudgeBackend = 'judge0' | 'sandbox';

/**
 * `judge0` is the local/self-hosted default. Production on Vercel uses
 * `sandbox` because the public Judge0 CPU/wall/file limits are too small.
 */
function judgeBackend(): JudgeBackend {
  return (process.env.JUDGE_BACKEND ?? 'judge0').toLowerCase() === 'sandbox'
    ? 'sandbox'
    : 'judge0';
}

export async function pingJudge(): Promise<{
  ok: boolean;
  backend: JudgeBackend;
  detail?: string;
}> {
  if (judgeBackend() === 'sandbox') return pingSandbox();
  const ok = await pingPiston();
  return {
    ok,
    backend: 'judge0',
    detail: ok ? undefined : 'Judge0 unreachable',
  };
}

export type Verdict = 'AC' | 'WA' | 'TLE' | 'MLE' | 'RE' | 'CE';

export interface TestCase {
  input: string;
  expected: string;
}

export interface SubmissionSpec {
  language: LanguageConfig;
  source: string;
  testCases: TestCase[];
  timeLimitMs: number; // base limit from the problem
  memoryLimitMb: number; // base limit from the problem
}

export interface TestCaseResult {
  verdict: Verdict;
  passed: boolean;
  timeMs: number | null;
  memoryKb: number | null;
}

export interface JudgeResult {
  verdict: Verdict;
  passed: number;
  total: number;
  /** Max time across all run cases; null if compile failed. */
  timeMs: number | null;
  /** Max memory across all run cases; null if compile failed. */
  memoryKb: number | null;
  /** Compile error text (CE only), truncated. */
  compileError: string | null;
  /** First runtime stderr for non-AC cases, truncated (debugging aid). */
  runtimeError: string | null;
}

const MAX_ERROR_LEN = 2000;

/**
 * Global hardware-calibration multiplier applied to every time limit.
 *
 * Problem time limits are imported verbatim from Codeforces, whose judges run
 * on fast dedicated hardware. Our Judge0 runs on a small shared cloud vCPU
 * (e2-standard-2) that is materially slower, so a CORRECT solution calibrated
 * for CF can exceed the raw limit here. This multiplier scales every limit up
 * to compensate. Tunable via JUDGE_HW_MULTIPLIER (default 2.5).
 *
 * The per-language `timeMultiplier` is separate — it covers interpreter/JVM
 * startup overhead, not the speed of the underlying machine.
 */
const HW_MULTIPLIER = (() => {
  const v = Number(process.env.JUDGE_HW_MULTIPLIER ?? '2.5');
  return Number.isFinite(v) && v > 0 ? v : 2.5;
})();

/** Upper bound on any effective limit, to stay within Judge0's MAX_CPU_TIME_LIMIT. */
const MAX_EFFECTIVE_TIME_MS = 15000;

function truncate(s: string): string {
  const trimmed = s.trim();
  return trimmed.length > MAX_ERROR_LEN ? trimmed.slice(0, MAX_ERROR_LEN) + '\n…[truncated]' : trimmed;
}

const MEMORY_ERROR_RE = /bad_alloc|MemoryError|OutOfMemoryError|Cannot allocate memory|std::length_error/i;

/**
 * Classify one batch case from its harness exit code and output.
 *
 * Exit-code convention (from the run harness):
 *   0        -> ran cleanly; AC/WA decided by output comparison
 *   124      -> `timeout` fired (per-case wall backstop)        -> TLE
 *   137,152  -> killed by SIGKILL/SIGXCPU (ulimit -t CPU limit) -> TLE (or MLE
 *               if the program reported an allocation failure first)
 *   139      -> SIGSEGV                                         -> RE
 *   other ≠0 -> runtime error                                  -> RE (or MLE)
 */
function classifyCase(c: BatchCaseResult, expected: string): Verdict {
  const code = c.exitCode;
  if (code === 0) {
    return isOutputCorrect(c.stdout, expected) ? 'AC' : 'WA';
  }
  if (code === 124 || code === 137 || code === 152) {
    return MEMORY_ERROR_RE.test(c.stderr) ? 'MLE' : 'TLE';
  }
  // Any other non-zero exit is a runtime error — unless the program clearly ran
  // out of memory, in which case surface MLE.
  return MEMORY_ERROR_RE.test(c.stderr) ? 'MLE' : 'RE';
}

export async function judgeSubmission(spec: SubmissionSpec): Promise<JudgeResult> {
  const { language, source, testCases, timeLimitMs, memoryLimitMb } = spec;

  if (testCases.length === 0) {
    // No test cases is a data error; treat as AC so we don't block on it.
    return { verdict: 'AC', passed: 0, total: 0, timeMs: 0, memoryKb: 0, compileError: null, runtimeError: null };
  }

  const effectiveTimeMs = Math.min(
    MAX_EFFECTIVE_TIME_MS,
    Math.round(timeLimitMs * language.timeMultiplier * HW_MULTIPLIER),
  );
  const effectiveMemMb = Math.round(memoryLimitMb * language.memoryMultiplier);
  // Per-case wall backstop: generously larger than the CPU limit so that
  // wall-clock contention under concurrent load can never trip a false TLE —
  // only the CPU limit (ulimit -t) gates real TLE.
  const wallMs = effectiveTimeMs + 8000;

  // Compile once, run every case in one sandbox/judge job.
  const executeBatch =
    judgeBackend() === 'sandbox' ? executeBatchInSandbox : executeBatchJudge0;
  let batch;
  try {
    batch = await executeBatch({
      language,
      source,
      inputs: testCases.map((tc) => tc.input),
      cpuTimeLimitMs: effectiveTimeMs,
      wallTimeLimitMs: wallMs,
      memoryLimitMb: effectiveMemMb,
    });
  } catch (err) {
    if (err instanceof TimeoutError) {
      return { verdict: 'TLE', passed: 0, total: testCases.length, timeMs: effectiveTimeMs, memoryKb: null, compileError: null, runtimeError: null };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { verdict: 'CE', passed: 0, total: testCases.length, timeMs: null, memoryKb: null, compileError: `Judge unavailable: ${truncate(msg)}`, runtimeError: null };
  }

  // Compile error short-circuits everything.
  if (batch.compileError !== null) {
    return { verdict: 'CE', passed: 0, total: testCases.length, timeMs: null, memoryKb: null, compileError: truncate(batch.compileError), runtimeError: null };
  }

  // Walk cases in order; the first non-AC decides the verdict (CP convention).
  let passed = 0;
  let maxTime = 0;
  for (let i = 0; i < testCases.length; i++) {
    const c = batch.cases[i];
    if (!c) {
      // The harness stopped producing cases without a failing verdict above it.
      // If it didn't run to completion, the sandbox killed it at the box level
      // (out of overall time) — report TLE. Otherwise it's a genuine judge fault.
      if (!batch.completed) {
        return { verdict: 'TLE', passed, total: testCases.length, timeMs: maxTime || effectiveTimeMs, memoryKb: null, compileError: null, runtimeError: null };
      }
      return { verdict: 'CE', passed, total: testCases.length, timeMs: maxTime || null, memoryKb: null, compileError: 'Judge produced incomplete results', runtimeError: null };
    }

    if (c.timeMs > maxTime) maxTime = c.timeMs;
    const verdict = classifyCase(c, testCases[i]!.expected);
    if (verdict === 'AC') {
      passed++;
      continue;
    }
    return {
      verdict,
      passed,
      total: testCases.length,
      timeMs: maxTime || null,
      memoryKb: null,
      compileError: null,
      runtimeError: verdict === 'RE' || verdict === 'MLE' ? truncate(c.stderr) || null : null,
    };
  }

  return { verdict: 'AC', passed, total: testCases.length, timeMs: maxTime || null, memoryKb: null, compileError: null, runtimeError: null };
}
