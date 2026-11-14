/**
 * Glue between the pure AST analysis (`./index`) and the submit route.
 *
 * Design rules:
 *   - never block or fail gameplay: the own-code analysis starts before judging and runs while the judge works;
 *     the similarity search only runs for accepted submissions, is capped (1 opponent + 25 others) and time-boxed;
 *     every error is logged and swallowed;
 *   - flags are written to the standalone `SubmissionCheatFlag` table only when something was found, and are never
 *     sent to players. A separate table (not a column on Submission) means a deploy that runs before the migration
 *     cannot break any existing Submission query; the write just fails and is swallowed.
 */

import { db, Prisma } from '@zapdos/db';
import {
  MIN_FINGERPRINTS,
  analyzeSubmission,
  compareFingerprints,
  isAntiCheatLanguage,
  type Analysis,
  type AntiCheatLanguage,
  type CheatFlag,
  type SimilarSubmission,
  type StoredCheatFlags,
} from './index';

const MAX_OTHER_SUBMISSIONS = 25;
/** One program being (almost) a subset of another, even when overall similarity is lower: padding / dead-code attack. */
const CONTAINMENT_THRESHOLD = 0.95;
const MIN_FINGERPRINTS_FOR_CONTAINMENT = 40;

export function antiCheatEnabled(): boolean {
  return (process.env.ANTICHEAT_ENABLED ?? 'true').toLowerCase() !== 'false';
}

/** Similarity at or above which two accepted submissions are flagged (default 0.85, `ANTICHEAT_SIMILARITY_THRESHOLD`). */
export function similarityThreshold(): number {
  const value = Number(process.env.ANTICHEAT_SIMILARITY_THRESHOLD ?? '0.85');
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : 0.85;
}

function budgetMs(): number {
  const value = Number(process.env.ANTICHEAT_BUDGET_MS ?? '1500');
  return Number.isFinite(value) && value > 0 ? value : 1500;
}

/** Start analysing a submission's own code. Resolves to null when disabled, unsupported or on any error. */
export function beginAnalysis(language: string, code: string): Promise<Analysis | null> {
  if (!antiCheatEnabled() || !isAntiCheatLanguage(language)) return Promise.resolve(null);
  return analyzeSubmission(language, code).catch((error: unknown) => {
    console.error('[anticheat] analysis failed:', error instanceof Error ? error.message : error);
    return null;
  });
}

interface SimilarityContext {
  submissionId: string;
  userId: string;
  opponentId: string;
  matchId: string;
  problemId: string;
  language: AntiCheatLanguage;
  analysis: Analysis;
}

/** Compare against the opponent's accepted code in this match and recent accepted code from other users. */
export async function findSimilar(ctx: SimilarityContext): Promise<SimilarSubmission[]> {
  const select = { id: true, userId: true, code: true } as const;
  const base = { problemId: ctx.problemId, language: ctx.language, verdict: 'AC', mode: 'SUBMIT' } as const;
  const [sameMatch, others] = await Promise.all([
    db.submission.findMany({
      where: { ...base, matchId: ctx.matchId, userId: ctx.opponentId },
      select, orderBy: { createdAt: 'desc' }, take: 1,
    }),
    db.submission.findMany({
      // `matchId: { not }` alone would silently drop rows with a NULL matchId (SQL three-valued logic).
      where: { ...base, userId: { not: ctx.userId }, OR: [{ matchId: null }, { matchId: { not: ctx.matchId } }] },
      select, orderBy: { createdAt: 'desc' }, take: MAX_OTHER_SUBMISSIONS,
    }),
  ]);

  const results: SimilarSubmission[] = [];
  for (const [row, isSameMatch] of [...sameMatch.map((r) => [r, true] as const), ...others.map((r) => [r, false] as const)]) {
    const other = await analyzeSubmission(ctx.language, row.code);
    const comparison = compareFingerprints(ctx.analysis.fingerprints, other.fingerprints);
    if (!comparison.comparable) continue;
    results.push({
      submissionId: row.id, userId: row.userId, sameMatch: isSameMatch,
      similarity: Number(comparison.similarity.toFixed(3)), containment: Number(comparison.containment.toFixed(3)),
    });
  }
  return results.sort((a, b) => b.similarity - a.similarity);
}

function similarityFlags(similar: SimilarSubmission[], own: Analysis, threshold: number): CheatFlag[] {
  const flags: CheatFlag[] = [];
  for (const match of similar) {
    if (match.similarity >= threshold) {
      flags.push({
        type: 'similarity', severity: match.sameMatch ? 'high' : 'medium', evidence: match.submissionId,
        detail: `Normalised AST is ${(match.similarity * 100).toFixed(0)}% similar to ${match.sameMatch ? "the opponent's accepted code in this match" : 'an earlier accepted submission'}`,
      });
    } else if (match.containment >= CONTAINMENT_THRESHOLD && own.fingerprints.length >= MIN_FINGERPRINTS_FOR_CONTAINMENT && match.similarity >= 0.4) {
      flags.push({
        type: 'containment', severity: 'medium', evidence: match.submissionId,
        detail: `${(match.containment * 100).toFixed(0)}% of the smaller program's structure appears inside another accepted submission (padding?)`,
      });
    }
  }
  return flags;
}

function withBudget<T>(work: Promise<T>, fallback: T, ms: number): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => {
        clearTimeout(timer);
        console.error('[anticheat] similarity search failed:', error instanceof Error ? error.message : error);
        resolve(fallback);
      },
    );
  });
}

export interface FinishInput {
  analysis: Promise<Analysis | null>;
  submissionId: string;
  userId: string;
  opponentId: string;
  matchId: string;
  problemId: string;
  language: string;
  verdict: string;
}

/** Called once the verdict is known. Never throws. */
export async function finishAntiCheat(input: FinishInput): Promise<StoredCheatFlags | null> {
  try {
    const analysis = await input.analysis;
    if (!analysis || !isAntiCheatLanguage(input.language)) return null;

    let similar: SimilarSubmission[] = [];
    if (input.verdict === 'AC' && analysis.fingerprints.length >= MIN_FINGERPRINTS) {
      similar = await withBudget(
        findSimilar({ ...input, language: input.language, analysis }),
        [],
        budgetMs(),
      );
    }

    const flags = [...analysis.flags, ...similarityFlags(similar, analysis, similarityThreshold())];
    if (flags.length === 0) return null;

    const stored: StoredCheatFlags = {
      version: 1,
      flags,
      similar: similar.slice(0, 5),
      metrics: {
        tokenCount: analysis.metrics.tokenCount, fingerprintCount: analysis.metrics.fingerprintCount,
        loops: analysis.metrics.loops, readsInput: analysis.metrics.readsInput,
        outputStatements: analysis.metrics.outputStatements, literalOnlyOutputs: analysis.metrics.literalOnlyOutputs,
        literalBranches: analysis.metrics.literalBranches, maxLiteralCollection: analysis.metrics.maxLiteralCollection,
      },
    };
    const payload = stored as unknown as Prisma.InputJsonValue;
    await db.submissionCheatFlag.upsert({
      where: { submissionId: input.submissionId },
      create: {
        submissionId: input.submissionId,
        userId: input.userId,
        matchId: input.matchId,
        problemId: input.problemId,
        flags: payload,
      },
      update: { flags: payload },
    });
    console.warn(
      `[anticheat] submission ${input.submissionId} (user ${input.userId}, match ${input.matchId}) flagged: ` +
        flags.map((flag) => `${flag.type}/${flag.severity}`).join(', '),
    );
    return stored;
  } catch (error) {
    console.error('[anticheat] failed to finish:', error instanceof Error ? error.message : error);
    return null;
  }
}
