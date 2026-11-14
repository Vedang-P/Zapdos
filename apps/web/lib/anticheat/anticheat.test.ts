import { describe, expect, it } from 'vitest';
import {
  ANTICHEAT_LANGUAGES,
  analyzeSubmission,
  compareFingerprints,
  compareSubmissions,
  MIN_FINGERPRINTS,
  type AntiCheatLanguage,
} from './index';
import { winnow } from './fingerprint';
import {
  FORBIDDEN_REAL,
  FORBIDDEN_WORDS_ONLY,
  HARDCODED,
  LIS,
  OWN_FUNCTION_NAMES,
  lookupChain,
} from './fixtures';

const languages = [...ANTICHEAT_LANGUAGES];

describe('similarity of structurally identical programs (renamed / reformatted)', () => {
  it.each(languages)('%s: renaming, re-layout, comments and std:: qualifiers keep similarity >= 0.9', async (language) => {
    const result = await compareSubmissions(language, LIS[language].dp, LIS[language].dpTwin);
    expect(result.comparable).toBe(true);
    expect(result.similarity).toBeGreaterThanOrEqual(0.9);
  });

  it.each(languages)('%s: a program is identical to itself', async (language) => {
    const result = await compareSubmissions(language, LIS[language].dp, LIS[language].dp);
    expect(result.similarity).toBe(1);
    expect(result.containment).toBe(1);
  });
});

describe('similarity of different algorithms', () => {
  it.each(languages)('%s: O(n^2) DP vs O(n log n) binary search scores < 0.5', async (language) => {
    const result = await compareSubmissions(language, LIS[language].dp, LIS[language].search);
    expect(result.comparable).toBe(true);
    expect(result.similarity).toBeLessThan(0.5);
  });

  it('operators are part of the fingerprint: a + b and a * b are different programs', async () => {
    const make = (op: string) => `
int main() {
  int n; cin >> n; long long acc = 0;
  for (int i = 0; i < n; i++) { int x; cin >> x; acc = acc ${op} x; acc = acc ${op} i; acc = acc ${op} 3; }
  for (int i = 0; i < n; i++) { acc = acc ${op} i; if (acc ${op} 2) acc = acc ${op} 1; }
  cout << acc;
}`;
    const swapped = await compareSubmissions('cpp', make('+'), make('*'));
    const same = await compareSubmissions('cpp', make('+'), make('+'));
    // Only the operators differ, so most of the skeleton is shared - but it must NOT look identical.
    expect(same.similarity).toBe(1);
    expect(swapped.similarity).toBeLessThan(0.65);
  });

  it('tiny programs are marked non-comparable instead of producing a misleading 1.0', async () => {
    const result = await compareSubmissions('python', 'print(sum(map(int, input().split())))', 'print(sum(map(int, input().split())))');
    expect(result.comparable).toBe(false);
    expect(compareFingerprints([], []).similarity).toBe(0);
  });
});

describe('winnowing', () => {
  it('guarantees a shared fingerprint for any common run of k + w - 1 tokens', () => {
    const shared = ['loop', 'ID', 'binary:+', 'NUM', 'call', 'ID', 'STR', 'return'];
    const a = winnow(['x1', 'x2', 'x3', ...shared, 'y1', 'y2']);
    const b = winnow(['z9', 'z8', ...shared, 'w1', 'w2', 'w3']);
    expect(a.filter((hash) => b.includes(hash)).length).toBeGreaterThanOrEqual(1);
  });

  it('keeps only a fraction of all k-grams', () => {
    const tokens = Array.from({ length: 400 }, (_, i) => `t${(i * 7919) % 97}`);
    expect(winnow(tokens).length).toBeLessThan(tokens.length * 0.6);
  });
});

describe('hard-coded output and lookup tables', () => {
  it.each(languages)('%s: constant output without reading input is flagged', async (language) => {
    const analysis = await analyzeSubmission(language, HARDCODED[language]);
    expect(analysis.metrics.readsInput).toBe(false);
    expect(analysis.flags.map((f) => f.type)).toContain('hardcoded_output');
  });

  it.each(languages)('%s: a real solution that reads input and prints computed values is not flagged', async (language) => {
    const analysis = await analyzeSubmission(language, LIS[language].dp);
    expect(analysis.metrics.readsInput).toBe(true);
    expect(analysis.flags).toEqual([]);
  });

  it.each(languages)('%s: 20 `if (x == literal) print(literal)` branches are flagged as an answer table', async (language) => {
    const analysis = await analyzeSubmission(language, lookupChain(language, 20));
    expect(analysis.metrics.literalBranches).toBeGreaterThanOrEqual(20);
    const flag = analysis.flags.find((f) => f.type === 'lookup_chain');
    expect(flag?.severity).toBe('high');
  });

  it('a handful of literal comparisons (normal edge cases) is not a lookup chain', async () => {
    const analysis = await analyzeSubmission('python', lookupChain('python', 4));
    expect(analysis.flags.find((f) => f.type === 'lookup_chain')).toBeUndefined();
  });

  it('flags one huge literal collection', async () => {
    const numbers = Array.from({ length: 80 }, (_, i) => i * 13).join(', ');
    const analysis = await analyzeSubmission('python', `table = [${numbers}]\nx = int(input())\nprint(table[x % 80])\n`);
    expect(analysis.flags.find((f) => f.type === 'large_literal_table')?.severity).toBe('medium');
    const small = await analyzeSubmission('python', 'primes = [2, 3, 5, 7, 11]\nprint(primes[int(input()) % 5])\n');
    expect(small.flags).toEqual([]);
  });
});

describe('forbidden calls are found in call nodes, not in text', () => {
  it.each(languages)('%s: a real call to a process-spawning API is flagged high', async (language) => {
    const analysis = await analyzeSubmission(language, FORBIDDEN_REAL[language]);
    const flag = analysis.flags.find((f) => f.type === 'forbidden_call');
    expect(flag?.severity).toBe('high');
    expect(flag?.line).toBeGreaterThan(0);
  });

  it.each(languages)('%s: the same words inside strings and comments are NOT flagged', async (language) => {
    const analysis = await analyzeSubmission(language, FORBIDDEN_WORDS_ONLY[language]);
    expect(analysis.flags.filter((f) => f.type === 'forbidden_call' || f.type === 'forbidden_import')).toEqual([]);
  });

  it('a function the submission defines itself (connect/accept in a union-find) is not the libc call', async () => {
    const analysis = await analyzeSubmission('cpp', OWN_FUNCTION_NAMES);
    expect(analysis.flags.filter((f) => f.type === 'forbidden_call')).toEqual([]);
  });

  it('resolves Python import aliases: sp.run, from-imports and aliased modules', async () => {
    const aliased = await analyzeSubmission('python', 'import subprocess as sp\nx = int(input())\nsp.run(["ls"])\nprint(x)\n');
    expect(aliased.flags.some((f) => f.type === 'forbidden_call' && f.evidence === 'subprocess.run')).toBe(true);
    const fromImport = await analyzeSubmission('python', 'from os import system as sh\nx = int(input())\nsh("ls")\nprint(x)\n');
    expect(fromImport.flags.some((f) => f.type === 'forbidden_call' && f.evidence === 'os.system')).toBe(true);
  });

  it('flags networking / process imports and file streams as medium findings', async () => {
    const cpp = await analyzeSubmission('cpp', '#include <sys/socket.h>\n#include <fstream>\nint main(){ std::ifstream f("in.txt"); int x; f >> x; }\n');
    expect(cpp.flags.some((f) => f.type === 'forbidden_import' && f.severity === 'medium')).toBe(true);
    expect(cpp.flags.some((f) => f.type === 'file_access')).toBe(true);
    const java = await analyzeSubmission('java', 'import java.net.*;\npublic class Main { public static void main(String[] a) { new Socket("evil.example", 80); } }\n');
    expect(java.flags.some((f) => f.type === 'forbidden_call' && f.evidence === 'Socket')).toBe(true);
    expect(java.flags.some((f) => f.type === 'forbidden_import')).toBe(true);
  });
});

describe('metrics and robustness', () => {
  it('detects loops and recursion from the tree', async () => {
    const recursive = await analyzeSubmission('python', 'def fib(n):\n    return n if n < 2 else fib(n-1) + fib(n-2)\nprint(fib(int(input())))\n');
    expect(recursive.metrics.recursion).toBe(true);
    expect(recursive.metrics.loops).toBe(0);
    const looped = await analyzeSubmission('java', LIS.java.dp);
    expect(looped.metrics.loops).toBe(3);
    expect(looped.metrics.recursion).toBe(false);
  });

  it('does not throw on syntactically broken code and says so', async () => {
    for (const language of languages) {
      const analysis = await analyzeSubmission(language, 'int main( { ]]] ((');
      expect(analysis.metrics.hasSyntaxErrors).toBe(true);
    }
  });

  it('handles empty input and large inputs', async () => {
    const empty = await analyzeSubmission('cpp', '');
    expect(empty.fingerprints.length).toBeLessThan(MIN_FINGERPRINTS);
    const big = await analyzeSubmission('python', 'x = int(input())\n' + 'x = x + 1\n'.repeat(5000) + 'print(x)\n');
    expect(big.metrics.nodeCount).toBeGreaterThan(5000);
  });

  it('is deterministic', async () => {
    const first = await analyzeSubmission('cpp', LIS.cpp.dp);
    const second = await analyzeSubmission('cpp', LIS.cpp.dp);
    expect(second.fingerprints).toEqual(first.fingerprints);
  });
});

describe('performance', () => {
  it.each(languages)('%s: parse + analyse + fingerprint stays fast (p95 < 50 ms over 200 runs)', async (language) => {
    await analyzeSubmission(language, LIS[language].dp); // warm up: WASM runtime + grammar load
    const times: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      const started = performance.now();
      await analyzeSubmission(language, LIS[language].dp);
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    const p50 = times[Math.floor(times.length * 0.5)] as number;
    const p95 = times[Math.floor(times.length * 0.95)] as number;
    console.log(`[anticheat perf] ${language}: p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms (n=200)`);
    expect(p95).toBeLessThan(50);
  });
});

describe('type surface', () => {
  it('exposes the three judged languages', () => {
    const expected: AntiCheatLanguage[] = ['cpp', 'python', 'java'];
    expect(languages).toEqual(expected);
  });
});
