/**
 * Codeforces problem importer — imports problems from the open-r1/codeforces
 * HuggingFace dataset with FULL test cases (hidden + visible).
 *
 * Usage:
 *   1. First download the dataset:
 *      pip install datasets
 *      python3 scripts/download-codeforces.py
 *
 *   2. Then run the import:
 *      pnpm import-codeforces
 *
 * Features:
 *   - Reads from /tmp/cf_problems.json (pre-downloaded)
 *   - All problems rated 800-1200 map to EASY difficulty
 *   - examples → isSample=true (visible to users)
 *   - official_tests → isSample=false (hidden, used for scoring)
 *   - Strips \r from test case I/O (Codeforces uses \r\n)
 *   - Batched DB saves (every 10 problems)
 *   - Upsert by slug — re-running updates existing problems
 */

import { db } from '@zapdos/db';
import * as fs from 'fs';
import * as path from 'path';
import type { Difficulty } from '@zapdos/db';
import { DEFAULT_CODE } from '../lib/default-code';

// ─── Types ────────────────────────────────────────────────────────────

interface CodeforcesTestCase {
  input: string;
  output: string;
}

interface CodeforcesProblem {
  id: string;
  contest_id: string;
  index: string;
  title: string;
  description: string;
  input_format: string;
  output_format: string;
  note: string | null;
  time_limit: number;
  memory_limit: number;
  rating: number;
  tags: string[];
  official_tests: CodeforcesTestCase[];
  official_tests_complete: boolean;
  examples: CodeforcesTestCase[];
  input_mode: string;
  generated_checker: string | null;
  interaction_format: string | null;
}

interface ScrapedTestCase {
  input: string;
  expectedOutput: string;
  isSample: boolean;
  explanation?: string;
}

interface ScrapedProblem {
  slug: string;
  title: string;
  difficulty: Difficulty;
  descriptionMd: string;
  timeLimitMs: number;
  memoryLimitMb: number;
  points: number;
  starterCode: Record<string, string>;
  testCases: ScrapedTestCase[];
}

// ─── Utilities ────────────────────────────────────────────────────────

/** Live progress logger — prints with timestamp, flushes immediately. */
function progress(msg: string): void {
  const ts = new Date().toISOString().split('T')[1]!.slice(0, 8);
  process.stdout.write(`[${ts}] ${msg}\n`);
}

/** Strip \r from strings (Codeforces uses \r\n line endings). */
function stripCr(s: string): string {
  return s.replace(/\r/g, '');
}

// Use shared starter code from default-code.ts
const DEFAULT_STARTER_CODE = DEFAULT_CODE;

// ─── Batched DB Import ────────────────────────────────────────────────

const BATCH_SIZE = 10;
let batchBuffer: ScrapedProblem[] = [];
let totalImported = 0;
let totalUpdated = 0;
let totalFailed = 0;

async function flushBatch(): Promise<void> {
  if (batchBuffer.length === 0) return;
  const batch = batchBuffer.splice(0);
  for (const prob of batch) {
    try {
      await db.$transaction(async (tx) => {
        const existing = await tx.problem.findUnique({
          where: { slug: prob.slug },
          include: { testCases: { select: { id: true } } },
        });

        if (existing) {
          await tx.testCase.deleteMany({ where: { problemId: existing.id } });
          await tx.problem.update({
            where: { id: existing.id },
            data: {
              title: prob.title,
              difficulty: prob.difficulty,
              descriptionMd: prob.descriptionMd,
              timeLimitMs: prob.timeLimitMs,
              memoryLimitMb: prob.memoryLimitMb,
              points: prob.points,
              starterCode: prob.starterCode,
              isVisible: true,
            },
          });
          for (let i = 0; i < prob.testCases.length; i++) {
            const tc = prob.testCases[i]!;
            await tx.testCase.create({
              data: {
                problemId: existing.id,
                order: i,
                input: tc.input,
                expectedOutput: tc.expectedOutput,
                isSample: tc.isSample,
                explanation: tc.explanation,
              },
            });
          }
          totalUpdated++;
        } else {
          await tx.problem.create({
            data: {
              slug: prob.slug,
              title: prob.title,
              difficulty: prob.difficulty,
              descriptionMd: prob.descriptionMd,
              timeLimitMs: prob.timeLimitMs,
              memoryLimitMb: prob.memoryLimitMb,
              points: prob.points,
              starterCode: prob.starterCode,
              isVisible: true,
              testCases: {
                create: prob.testCases.map((tc, i) => ({
                  order: i,
                  input: tc.input,
                  expectedOutput: tc.expectedOutput,
                  isSample: tc.isSample,
                  explanation: tc.explanation,
                })),
              },
            },
          });
          totalImported++;
        }
      });
    } catch (err) {
      progress(`  X DB error for ${prob.slug}: ${err instanceof Error ? err.message : err}`);
      totalFailed++;
    }
  }
  progress(`  Saved batch -- total: ${totalImported} new, ${totalUpdated} updated, ${totalFailed} failed`);
}

/** Queue a problem for batched import. Flushes automatically every BATCH_SIZE. */
async function queueImport(prob: ScrapedProblem): Promise<void> {
  batchBuffer.push(prob);
  if (batchBuffer.length >= BATCH_SIZE) {
    await flushBatch();
  }
}

// ─── Codeforces Importer ──────────────────────────────────────────────

function convertProblem(cf: CodeforcesProblem): ScrapedProblem | null {
  // Validate: must have enough official tests
  const officialTests = (cf.official_tests || []).filter(
    (t) => t.input != null && t.output != null,
  );
  if (officialTests.length < 5) {
    return null;
  }

  // Skip interactive / file-mode / checker problems
  if (cf.input_mode !== 'stdio') return null;
  if (cf.interaction_format) return null;
  if (cf.generated_checker) return null;

  // Build slug
  const slug = `cf-${cf.contest_id}-${cf.index}`;

  // Build description markdown
  const parts: string[] = [];
  if (cf.description) {
    parts.push(stripCr(cf.description));
  }
  if (cf.input_format) {
    parts.push(`\n\n## Input\n\n${stripCr(cf.input_format)}`);
  }
  if (cf.output_format) {
    parts.push(`\n\n## Output\n\n${stripCr(cf.output_format)}`);
  }
  if (cf.note) {
    parts.push(`\n\n## Note\n\n${stripCr(cf.note)}`);
  }
  const descriptionMd = parts.join('');

  // Build test cases
  const testCases: ScrapedTestCase[] = [];

  // 1. Examples (visible to users) — first 1-2
  const examples = (cf.examples || []).filter(
    (t) => t.input != null && t.output != null,
  );
  for (let i = 0; i < Math.min(examples.length, 2); i++) {
    testCases.push({
      input: stripCr(examples[i]!.input),
      expectedOutput: stripCr(examples[i]!.output),
      isSample: true,
      explanation: i === 0 ? 'Example' : `Example ${i + 1}`,
    });
  }

  // 2. Official tests (hidden, used for scoring)
  for (const test of officialTests) {
    testCases.push({
      input: stripCr(test.input),
      expectedOutput: stripCr(test.output),
      isSample: false,
    });
  }

  // Map rating to difficulty (all EASY for 800-1200)
  const difficulty: Difficulty = 'EASY';

  // Time limit: convert seconds to ms, default 2000ms
  const timeLimitMs = cf.time_limit
    ? Math.round(cf.time_limit * 1000)
    : 2000;

  // Memory limit: convert MB, default 256MB
  const memoryLimitMb = cf.memory_limit || 256;

  return {
    slug,
    title: cf.title || `${cf.contest_id}${cf.index}`,
    difficulty,
    descriptionMd,
    timeLimitMs,
    memoryLimitMb,
    points: 100,
    starterCode: { ...DEFAULT_STARTER_CODE },
    testCases,
  };
}

async function importCodeforces(): Promise<void> {
  progress('=== Codeforces Importer ===');
  // Same default as scripts/download-codeforces.py; override both with CF_PROBLEMS_PATH / CF_OUTPUT_PATH.
  const jsonPath = process.env.CF_PROBLEMS_PATH ?? '/tmp/cf_problems.json';
  progress(`Reading ${jsonPath}...`);
  if (!fs.existsSync(jsonPath)) {
    progress(`ERROR: ${jsonPath} not found.`);
    progress('Run the download script first:');
    progress('  pip install datasets');
    progress('  python3 scripts/download-codeforces.py');
    process.exit(1);
  }

  const rawData = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as CodeforcesProblem[];
  progress(`Loaded ${rawData.length} problems from JSON`);

  // Filter and convert
  let converted = 0;
  let skipped = 0;

  for (const cf of rawData) {
    const prob = convertProblem(cf);
    if (prob) {
      await queueImport(prob);
      converted++;
      if (converted % 25 === 0) {
        progress(`  Progress: ${converted} converted, ${skipped} skipped`);
      }
    } else {
      skipped++;
    }
  }

  // Flush remaining
  await flushBatch();

  progress('');
  progress('=== Import Complete ===');
  progress(`Converted: ${converted}, Skipped: ${skipped}`);
  progress(`DB: ${totalImported} new, ${totalUpdated} updated, ${totalFailed} failed`);

  // Print final DB stats
  const dbCount = await db.problem.count();
  const dbEasy = await db.problem.count({ where: { difficulty: 'EASY' } });
  const dbMedium = await db.problem.count({ where: { difficulty: 'MEDIUM' } });
  const dbHard = await db.problem.count({ where: { difficulty: 'HARD' } });
  const sampleCount = await db.testCase.count({ where: { isSample: true } });
  const hiddenCount = await db.testCase.count({ where: { isSample: false } });

  progress('');
  progress('=== Database Stats ===');
  progress(`Problems: ${dbCount} (${dbEasy}E / ${dbMedium}M / ${dbHard}H)`);
  progress(`Test cases: ${sampleCount + hiddenCount} (${sampleCount} visible, ${hiddenCount} hidden)`);

  await db.$disconnect();
  process.exit(0);
}

// ─── Run ──────────────────────────────────────────────────────────────

importCodeforces().catch((err) => {
  progress(`FATAL: ${err}`);
  process.exit(1);
});
