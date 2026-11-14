/**
 * Regression test for a measured performance trap, kept in its own file so it gets a cold module state.
 *
 * With web-tree-sitter 0.22.6 the first Language.load AFTER the C++ grammar took ~6 s (whichever language it was).
 * parser.ts therefore loads python, java and finally cpp together on first use.  If someone reverts to lazy,
 * request-ordered loading, the second language below takes seconds instead of milliseconds.
 */
import { describe, expect, it } from 'vitest';
import { analyzeSubmission } from './index';
import { LIS } from './fixtures';

describe('cold start', () => {
  it('first use in the worst order (cpp first) stays fast for every language', async () => {
    const timings: Record<string, number> = {};
    for (const language of ['cpp', 'python', 'java'] as const) {
      const started = performance.now();
      await analyzeSubmission(language, LIS[language].dp);
      timings[language] = performance.now() - started;
    }
    console.log(`[anticheat cold start] cpp(first, includes runtime + all grammars)=${timings.cpp?.toFixed(0)}ms python=${timings.python?.toFixed(0)}ms java=${timings.java?.toFixed(0)}ms`);
    // The old behaviour was ~6000 ms for the language loaded after cpp; allow a very generous 2.5 s for loaded CI boxes.
    expect(timings.python).toBeLessThan(2500);
    expect(timings.java).toBeLessThan(2500);
    expect(timings.cpp).toBeLessThan(5000);
  });
});
