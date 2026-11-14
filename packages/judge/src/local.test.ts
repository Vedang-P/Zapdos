/**
 * Local judge backend, end to end through `judgeSubmission` with the real toolchains on this machine.
 * A language whose toolchain is missing is skipped (CI boxes without a JDK, for example).
 */
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { judgeSubmission, pingJudge } from './judge';
import { getLanguage, type LanguageId } from './languages';

const original = { backend: process.env.JUDGE_BACKEND, secret: process.env.AUTH_SECRET };
beforeAll(() => {
  process.env.JUDGE_BACKEND = 'local';
});
afterAll(() => {
  if (original.backend === undefined) delete process.env.JUDGE_BACKEND;
  else process.env.JUDGE_BACKEND = original.backend;
  if (original.secret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = original.secret;
});

const has = (command: string, args: string[]): boolean => {
  const result = spawnSync(command, args, { stdio: 'ignore' });
  return !result.error && result.status === 0;
};
const toolchain: Record<LanguageId, boolean> = {
  cpp: has('g++', ['--version']),
  python: has('python3', ['--version']),
  java: has('javac', ['-version']),
};

const cases = [
  { input: '1 2\n', expected: '3' },
  { input: '10 20\n', expected: '30' },
  { input: '-5 5\n', expected: '0' },
];

const programs: Record<LanguageId, { ac: string; wa: string; loop: string; crash: string; syntax: string }> = {
  cpp: {
    ac: '#include <iostream>\nint main(){ long long a,b; std::cin>>a>>b; std::cout<<a+b<<"\\n"; }',
    wa: '#include <iostream>\nint main(){ long long a,b; std::cin>>a>>b; std::cout<<a-b<<"\\n"; }',
    loop: 'int main(){ volatile unsigned long long x = 0; for(;;){ x = x + 1; } }',
    crash: '#include <cstdlib>\nint main(){ std::abort(); }',
    syntax: 'int main( { return 0; }',
  },
  python: {
    ac: 'a, b = map(int, input().split())\nprint(a + b)\n',
    wa: 'a, b = map(int, input().split())\nprint(a - b)\n',
    loop: 'while True:\n    pass\n',
    crash: 'raise ValueError("boom")\n',
    syntax: 'def broken(:\n    pass\n',
  },
  java: {
    ac: 'import java.util.*;\npublic class Main { public static void main(String[] x){ Scanner s = new Scanner(System.in); long a = s.nextLong(), b = s.nextLong(); System.out.println(a + b); } }',
    wa: 'import java.util.*;\npublic class Main { public static void main(String[] x){ Scanner s = new Scanner(System.in); long a = s.nextLong(), b = s.nextLong(); System.out.println(a - b); } }',
    loop: 'public class Main { public static void main(String[] a){ long x = 0; while (true) { x++; } } }',
    crash: 'public class Main { public static void main(String[] a){ throw new RuntimeException("boom"); } }',
    syntax: 'public class Main { void f( }',
  },
};

function judge(language: LanguageId, source: string, overrides: { timeLimitMs?: number; memoryLimitMb?: number } = {}) {
  return judgeSubmission({
    language: getLanguage(language)!,
    source,
    testCases: cases,
    timeLimitMs: overrides.timeLimitMs ?? 2000,
    memoryLimitMb: overrides.memoryLimitMb ?? 256,
  });
}

for (const language of ['cpp', 'python', 'java'] as const) {
  describe.skipIf(!toolchain[language])(`local judge: ${language}`, () => {
    it('accepts a correct solution and reports pass counts and timing', async () => {
      const result = await judge(language, programs[language].ac);
      expect(result.verdict).toBe('AC');
      expect(result.passed).toBe(3);
      expect(result.total).toBe(3);
      expect(result.timeMs).toBeGreaterThan(0);
    });

    it('reports Wrong Answer on the first failing case', async () => {
      const result = await judge(language, programs[language].wa);
      expect(result.verdict).toBe('WA');
      expect(result.passed).toBe(0); // a - b is wrong for the first sample already
    });

    it('reports Compile Error with the compiler message', async () => {
      const result = await judge(language, programs[language].syntax);
      expect(result.verdict).toBe('CE');
      expect(result.compileError ?? '').not.toBe('');
    });

    it('reports Runtime Error for a crash', async () => {
      const result = await judge(language, programs[language].crash);
      expect(result.verdict).toBe('RE');
    });

    it('kills an infinite loop and reports Time Limit Exceeded', async () => {
      const started = Date.now();
      const result = await judge(language, programs[language].loop, { timeLimitMs: 300 });
      expect(result.verdict).toBe('TLE');
      expect(Date.now() - started).toBeLessThan(25_000); // killed by the CPU limit, not waited out
    }, 40_000);
  });
}

describe.skipIf(!toolchain.java)('local judge: memory (best effort)', () => {
  it('maps a Java heap exhaustion to Memory Limit Exceeded (-Xmx)', async () => {
    const hog = 'public class Main { public static void main(String[] a){ long[] big = new long[600_000_000]; System.out.println(big.length); } }';
    const result = await judge('java', hog, { memoryLimitMb: 32 });
    expect(result.verdict).toBe('MLE');
  }, 40_000);
});

describe.skipIf(!toolchain.python)('local judge: containment properties', () => {
  it('does not leak the server environment to submitted code', async () => {
    process.env.AUTH_SECRET = 'super-secret-do-not-leak';
    const source = 'import os\nprint(os.environ.get("AUTH_SECRET", ""))\nprint(os.environ.get("DATABASE_URL", ""))\n';
    const result = await judgeSubmission({
      language: getLanguage('python')!,
      source,
      testCases: [{ input: '', expected: '' }], // expected output: nothing, i.e. both variables are unset
      timeLimitMs: 2000,
      memoryLimitMb: 256,
    });
    expect(result.verdict).toBe('AC');
  });

  it('caps runaway output instead of buffering it forever', async () => {
    const source = 'while True:\n    print("x" * 100000)\n';
    const result = await judgeSubmission({
      language: getLanguage('python')!,
      source,
      testCases: [{ input: '', expected: '1' }],
      timeLimitMs: 5000,
      memoryLimitMb: 256,
    });
    expect(result.verdict).toBe('RE');
  }, 40_000);

  it('runs every case with its own stdin and stops at the first failing case', async () => {
    const source = 'n = int(input())\nif n == 2:\n    raise SystemExit(3)\nprint(n)\n';
    const result = await judgeSubmission({
      language: getLanguage('python')!,
      source,
      testCases: [
        { input: '1\n', expected: '1' },
        { input: '2\n', expected: '2' },
        { input: '3\n', expected: '3' },
      ],
      timeLimitMs: 2000,
      memoryLimitMb: 256,
    });
    expect(result.verdict).toBe('RE');
    expect(result.passed).toBe(1);
  });
});

describe('local judge: health check and selection', () => {
  it('pingJudge reports the local backend', async () => {
    const ping = await pingJudge();
    expect(ping.backend).toBe('local');
    expect(ping.ok).toBe(Object.values(toolchain).every(Boolean));
    if (!ping.ok) expect(ping.detail).toMatch(/Missing toolchain/);
  });
});
