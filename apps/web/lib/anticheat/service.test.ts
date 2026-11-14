/**
 * Integration test: the anti-cheat service against the real local Postgres.
 * Skipped automatically when the database is not reachable (set DATABASE_URL to run elsewhere; only localhost is
 * allowed by default so the test can never write to a shared database by accident).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FORBIDDEN_REAL, LIS } from './fixtures';

const url =
  process.env.DATABASE_URL ?? 'postgresql://zapdos:zapdos_local@localhost:5432/zapdos?schema=public';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);

type Db = typeof import('@zapdos/db')['db'];
let db: Db | null = null;
let service: typeof import('./service') | null = null;
const created = { users: [] as string[], problems: [] as string[], matches: [] as string[], submissions: [] as string[] };

async function connect(): Promise<boolean> {
  if (!isLocal) return false;
  process.env.DATABASE_URL = url;
  try {
    ({ db } = await import('@zapdos/db'));
    service = await import('./service');
    await db.$queryRaw`SELECT 1`;
    // the table must exist (pnpm db:push / the migration adds it)
    await db.$queryRaw`SELECT 1 FROM "SubmissionCheatFlag" LIMIT 1`;
    return true;
  } catch {
    return false;
  }
}

const available = await connect();

describe.skipIf(!available)('anti-cheat service (real Postgres)', () => {
  const tag = `ac${Date.now().toString(36)}`;
  let ids: { a: string; b: string; c: string; problem: string; match: string; otherMatch: string };

  beforeAll(async () => {
    const d = db as Db;
    const mk = async (name: string) =>
      (await d.user.create({ data: { email: `${tag}-${name}@test.local`, username: `${tag}${name}` } })).id;
    const [a, b, c] = [await mk('a'), await mk('b'), await mk('c')];
    created.users.push(a, b, c);
    const problem = (
      await d.problem.create({
        data: { slug: `${tag}-lis`, title: 'LIS', difficulty: 'EASY', descriptionMd: 'x', points: 100, starterCode: {} },
      })
    ).id;
    created.problems.push(problem);
    const match = (await d.match.create({ data: { playerAId: a, playerBId: b, problemSequence: [problem], status: 'IN_PROGRESS' } })).id;
    const otherMatch = (await d.match.create({ data: { playerAId: c, playerBId: b, problemSequence: [problem], status: 'COMPLETED' } })).id;
    created.matches.push(match, otherMatch);
    ids = { a, b, c, problem, match, otherMatch };

    const accepted = async (userId: string, matchId: string | null, code: string) => {
      const row = await d.submission.create({
        data: { userId, matchId, problemId: problem, language: 'python', code, mode: 'SUBMIT', verdict: 'AC', passed: 1, total: 1 },
      });
      created.submissions.push(row.id);
      return row.id;
    };
    // B already solved it in this very match; C solved it earlier in another match.
    await accepted(b, match, LIS.python.dp);
    await accepted(c, otherMatch, LIS.python.dp);
  });

  afterAll(async () => {
    if (!db) return;
    await db.submissionCheatFlag.deleteMany({ where: { submissionId: { in: created.submissions } } });
    await db.submission.deleteMany({ where: { id: { in: created.submissions } } });
    await db.match.deleteMany({ where: { id: { in: created.matches } } });
    await db.problem.deleteMany({ where: { id: { in: created.problems } } });
    await db.user.deleteMany({ where: { id: { in: created.users } } });
    await db.$disconnect();
  });

  async function submit(code: string, verdict: string) {
    const d = db as Db;
    const row = await d.submission.create({
      data: { userId: ids.a, matchId: ids.match, problemId: ids.problem, language: 'python', code, mode: 'SUBMIT', verdict: verdict as 'AC' | 'WA', passed: 1, total: 1 },
    });
    created.submissions.push(row.id);
    const stored = await (service as typeof import('./service')).finishAntiCheat({
      analysis: (service as typeof import('./service')).beginAnalysis('python', code),
      submissionId: row.id, userId: ids.a, opponentId: ids.b, matchId: ids.match, problemId: ids.problem, language: 'python', verdict,
    });
    const persisted = await d.submissionCheatFlag.findUnique({ where: { submissionId: row.id } });
    return { stored, persisted: persisted?.flags ?? null, row: persisted };
  }

  it('flags a renamed copy of the opponent\'s accepted code (same match) as high severity', async () => {
    const { stored, persisted } = await submit(LIS.python.dpTwin, 'AC');
    const flag = stored?.flags.find((f) => f.type === 'similarity' && f.severity === 'high');
    expect(flag).toBeDefined();
    expect(stored?.similar.some((s) => s.sameMatch && s.similarity >= 0.85)).toBe(true);
    // ... and also notices the earlier accepted submission from another match
    expect(stored?.similar.some((s) => !s.sameMatch && s.userId === ids.c)).toBe(true);
    expect(persisted).toMatchObject({ version: 1 });
  });

  it('a genuinely different solution leaves no cheat-flag row', async () => {
    const { stored, persisted } = await submit(LIS.python.search, 'AC');
    expect(stored).toBeNull();
    expect(persisted).toBeNull();
  });

  it('rule findings are stored even when the verdict is not AC (no similarity search is run)', async () => {
    const { stored, persisted } = await submit(FORBIDDEN_REAL.python, 'WA');
    expect(stored?.flags.some((f) => f.type === 'forbidden_call' && f.severity === 'high')).toBe(true);
    expect(stored?.similar).toEqual([]);
    expect(persisted).not.toBeNull();
  });

  it('respects ANTICHEAT_ENABLED=false and unsupported languages', async () => {
    process.env.ANTICHEAT_ENABLED = 'false';
    expect(await (service as typeof import('./service')).beginAnalysis('python', LIS.python.dp)).toBeNull();
    delete process.env.ANTICHEAT_ENABLED;
    expect(await (service as typeof import('./service')).beginAnalysis('brainfuck', '+')).toBeNull();
  });

  it('the similarity threshold is configurable with a safe default', () => {
    const s = service as typeof import('./service');
    expect(s.similarityThreshold()).toBe(0.85);
    process.env.ANTICHEAT_SIMILARITY_THRESHOLD = '0.7';
    expect(s.similarityThreshold()).toBe(0.7);
    process.env.ANTICHEAT_SIMILARITY_THRESHOLD = 'banana';
    expect(s.similarityThreshold()).toBe(0.85);
    delete process.env.ANTICHEAT_SIMILARITY_THRESHOLD;
  });
});
