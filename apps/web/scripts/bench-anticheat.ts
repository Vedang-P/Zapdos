/**
 * Anti-cheat benchmark: cold start, warm latency and the similarity table on real C++ / Python / Java programs.
 *
 *   pnpm --filter web exec tsx scripts/bench-anticheat.ts
 *
 * Writes docs/results/anticheat_bench.json at the repository root.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ANTICHEAT_LANGUAGES, analyzeSubmission, compareSubmissions } from '../lib/anticheat/index';
import { LIS } from '../lib/anticheat/fixtures';

const RUNS = 200;

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] as number;
}

async function main(): Promise<void> {
  const report: Record<string, unknown> = {
    machine: { platform: `${os.platform()} ${os.arch()}`, cpus: os.cpus().length, node: process.version },
    runsPerLanguage: RUNS,
    languages: {} as Record<string, unknown>,
  };

  for (const language of ANTICHEAT_LANGUAGES) {
    const source = LIS[language].dp;
    const coldStart = performance.now();
    await analyzeSubmission(language, source); // WASM runtime (first language only) + grammar load + first parse
    const coldMs = performance.now() - coldStart;

    const times: number[] = [];
    let last = await analyzeSubmission(language, source);
    for (let i = 0; i < RUNS; i += 1) {
      const started = performance.now();
      last = await analyzeSubmission(language, source);
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);

    const twin = await compareSubmissions(language, LIS[language].dp, LIS[language].dpTwin);
    const different = await compareSubmissions(language, LIS[language].dp, LIS[language].search);

    // The cost of the post-AC similarity search without the database: analyse 26 other submissions.
    const batchStart = performance.now();
    for (let i = 0; i < 26; i += 1) await analyzeSubmission(language, i % 2 === 0 ? LIS[language].dpTwin : LIS[language].search);
    const batchMs = performance.now() - batchStart;

    (report.languages as Record<string, unknown>)[language] = {
      coldStartMs: Number(coldMs.toFixed(1)),
      warmMs: {
        p50: Number(percentile(times, 0.5).toFixed(2)),
        p95: Number(percentile(times, 0.95).toFixed(2)),
        p99: Number(percentile(times, 0.99).toFixed(2)),
        mean: Number((times.reduce((a, b) => a + b, 0) / times.length).toFixed(2)),
      },
      tokens: last.metrics.tokenCount,
      fingerprints: last.metrics.fingerprintCount,
      similarity: {
        renamedAndReformattedCopy: Number(twin.similarity.toFixed(3)),
        differentAlgorithm: Number(different.similarity.toFixed(3)),
      },
      compare26OthersMs: Number(batchMs.toFixed(1)),
    };
  }

  console.log(JSON.stringify(report, null, 2));
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const out = join(root, 'docs', 'results', 'anticheat_bench.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(`wrote ${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
