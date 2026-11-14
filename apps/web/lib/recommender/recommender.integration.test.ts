/**
 * Integration test on the real imported corpus (Postgres). Skipped automatically when the database is unreachable
 * or empty, so `pnpm test` stays green on a machine without the local infrastructure.
 */
import { afterAll, describe, expect, it } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://zapdos:zapdos_local@localhost:5432/zapdos?schema=public';
const { db } = await import('@zapdos/db');
const { prismaRepository } = await import('./repository');
const { Recommender } = await import('./service');

async function corpusSize(): Promise<number> {
  try {
    return await Promise.race([
      db.problem.count({ where: { isVisible: true } }),
      new Promise<number>((resolve) => setTimeout(() => resolve(-1), 3000)),
    ]);
  } catch {
    return -1;
  }
}

const size = await corpusSize();
const ready = size > 0;
const EMAIL_PREFIX = 'rec-it-';

describe.skipIf(!ready)('recommender on the real corpus', () => {
  afterAll(async () => {
    await db.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } }); // cascades to the fixture submissions
    await db.$disconnect();
  });

  it('the corpus is larger than 200 problems', () => {
    expect(size).toBeGreaterThan(200);
  });

  it('recommends unsolved problems related to a failed one, with a grounded rationale', async () => {
    const [failedProblem, solvedProblem] = await db.problem.findMany({ take: 2, orderBy: { slug: 'asc' }, select: { id: true, title: true } });
    const user = await db.user.create({
      data: { email: `${EMAIL_PREFIX}${Date.now()}@test.local`, username: `rec_it_${Date.now()}`, elo: 1200 },
      select: { id: true },
    });
    await db.submission.createMany({
      data: [
        ...[1, 2, 3].map(() => ({ userId: user.id, problemId: failedProblem!.id, language: 'cpp', code: '// wrong', verdict: 'WA' as const, mode: 'SUBMIT' as const })),
        { userId: user.id, problemId: solvedProblem!.id, language: 'cpp', code: '// ok', verdict: 'AC' as const, mode: 'SUBMIT' as const },
      ],
    });

    const recommender = new Recommender(prismaRepository);
    const result = await recommender.recommend(user.id, { limit: 5 });
    const ids = result.recommendations.map((r) => r.problem.id);

    expect(result.coldStart).toBe(false);
    expect(result.recommendations).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    expect(ids).not.toContain(solvedProblem!.id);
    expect(ids).not.toContain(failedProblem!.id);
    expect(result.recommendations[0]!.because[0]!.problemId).toBe(failedProblem!.id); // the failed problem drove the match
    expect(result.recommendations[0]!.rationale).toContain(failedProblem!.title);
    expect(result.recommendations[0]!.rationale).toContain('3 wrong submissions');
    // Other test files create short-lived fixture problems in this same database while these run in parallel, so the
    // count taken at import time and the index size can differ by a row or two. What matters: the whole corpus is indexed.
    expect(result.meta.indexSize).toBeGreaterThan(200);
    expect(Math.abs(result.meta.indexSize - size)).toBeLessThanOrEqual(5);
    expect(result.meta.queryMs).toBeLessThan(250);
  });

  it('gives a brand-new user starter picks', async () => {
    const user = await db.user.create({
      data: { email: `${EMAIL_PREFIX}new-${Date.now()}@test.local`, username: `rec_it_new_${Date.now()}` },
      select: { id: true },
    });
    const result = await new Recommender(prismaRepository).recommend(user.id, { limit: 3 });
    expect(result.coldStart).toBe(true);
    expect(result.recommendations).toHaveLength(3);
  });
});
