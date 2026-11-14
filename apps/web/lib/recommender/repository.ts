/**
 * Prisma-backed data access for the recommender. Kept apart from service.ts so the recommender logic stays
 * database-free and unit-testable.
 */

import { db } from '@zapdos/db';
import type { HistoryEntry } from './retrieval';
import type { ProblemBody, ProblemHeader, RecommenderRepository } from './service';

const WRONG_VERDICTS = new Set(['WA', 'TLE', 'MLE', 'RE', 'CE']);

interface Aggregate {
  solved: boolean;
  progressWrong: number;
  submissionWrong: number;
  attempted: boolean;
  lastActivityAt: Date;
}

export const prismaRepository: RecommenderRepository = {
  async loadProblemHeaders(): Promise<ProblemHeader[]> {
    return db.problem.findMany({
      where: { isVisible: true },
      select: { id: true, slug: true, title: true, difficulty: true, points: true, updatedAt: true },
      orderBy: { slug: 'asc' },
    });
  },

  async loadProblemBodies(): Promise<ProblemBody[]> {
    return db.problem.findMany({
      where: { isVisible: true },
      select: { id: true, descriptionMd: true },
      orderBy: { slug: 'asc' },
    });
  },

  async loadUser(userId: string) {
    return db.user.findUnique({ where: { id: userId }, select: { elo: true } });
  },

  /**
   * Per-problem history from both sources of truth: match progress (wrong-submission counters, solved state) and raw
   * graded submissions. A problem counts as `solved` once it was accepted anywhere, and as `failed` if it was attempted
   * but never accepted. Wrong-submission counts take the larger of the two sources instead of adding them (a wrong
   * submission is recorded in both).
   */
  async loadHistory(userId: string): Promise<HistoryEntry[]> {
    const [progress, submissions] = await Promise.all([
      db.matchProgress.findMany({
        where: { userId },
        select: { problemId: true, status: true, wrongSubmissions: true, solvedAt: true, updatedAt: true },
      }),
      db.submission.findMany({
        where: { userId, mode: 'SUBMIT' },
        select: { problemId: true, verdict: true, createdAt: true },
      }),
    ]);

    const byProblem = new Map<string, Aggregate>();
    const slot = (problemId: string, when: Date): Aggregate => {
      let entry = byProblem.get(problemId);
      if (!entry) {
        entry = { solved: false, progressWrong: 0, submissionWrong: 0, attempted: false, lastActivityAt: when };
        byProblem.set(problemId, entry);
      }
      if (when > entry.lastActivityAt) entry.lastActivityAt = when;
      return entry;
    };

    for (const row of progress) {
      const entry = slot(row.problemId, row.solvedAt ?? row.updatedAt);
      if (row.status === 'SOLVED') entry.solved = true;
      entry.progressWrong += row.wrongSubmissions;
      if (row.status === 'SOLVED' || row.wrongSubmissions > 0) entry.attempted = true;
    }
    for (const row of submissions) {
      const entry = slot(row.problemId, row.createdAt);
      if (row.verdict === 'AC') {
        entry.solved = true;
        entry.attempted = true;
      } else if (WRONG_VERDICTS.has(row.verdict)) {
        entry.submissionWrong += 1;
        entry.attempted = true;
      }
    }

    const history: HistoryEntry[] = [];
    for (const [problemId, entry] of byProblem) {
      if (!entry.attempted) continue; // unlocked but never submitted: no signal
      history.push({
        problemId,
        outcome: entry.solved ? 'solved' : 'failed',
        wrongSubmissions: Math.max(entry.progressWrong, entry.submissionWrong),
        lastActivityAt: entry.lastActivityAt,
      });
    }
    return history;
  },
};
