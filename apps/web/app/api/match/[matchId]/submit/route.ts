import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/session';
import { isValidId } from '@/lib/validation';
import { db } from '@zapdos/db';
import { judgeSubmission, getLanguage } from '@zapdos/judge';
import type { LanguageId } from '@zapdos/judge';
import { MATCH_CONFIG } from '@zapdos/match';
import { finalizeMatch } from '@zapdos/match';
import { emitToMatch, emitToUser } from '@/lib/socket';
import type { SubmissionVerdictPayload, OpponentSnapshot, MatchEndPayload } from '@zapdos/realtime';
import { checkRateLimit } from '@/lib/rate-limit';
import { incrementAndCheckBudget, budgetExceededResponse } from '@/lib/budget';
import { withJudgeConcurrency } from '@/lib/judge-limiter';

export const dynamic = 'force-dynamic';
// Vercel Hobby allows up to 300s per function invocation. A batch judge run
// (compile + every test case) must fit inside this budget.
export const maxDuration = 300;

/** Build an OpponentSnapshot for a player. */
async function buildOpponentSnapshot(matchId: string, userId: string, totalProblems: number): Promise<OpponentSnapshot> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, username: true } });
  const progress = await db.matchProgress.findMany({
    where: { matchId, userId },
    orderBy: { problemOrder: 'asc' },
  });
  const solvedCount = progress.filter((p) => p.status === 'SOLVED').length;
  const score = progress.reduce((sum, p) => sum + p.scoreEarned, 0);

  return {
    userId,
    username: user?.username ?? 'Unknown',
    score,
    problems: progress.map((p) => ({
      problemOrder: p.problemOrder,
      status: p.status as 'LOCKED' | 'UNLOCKED' | 'SOLVED',
      passed: null,
      total: null,
      wrongSubmissions: p.wrongSubmissions,
    })),
    raceProgress: totalProblems > 0 ? solvedCount / totalProblems : 0,
    solvedCount,
    totalProblems,
  };
}

export async function POST(
  req: Request,
  { params }: { params: { matchId: string } },
) {
  try {
    const user = await requireUser();
    const { matchId } = params;

    if (!isValidId(matchId)) {
      return NextResponse.json({ error: 'Invalid match ID' }, { status: 400 });
    }

    const body = await req.json();

    // Per-user rate limit: 10/min, 50/hr, 200/day
    const rateLimit = await checkRateLimit(user.id);
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: rateLimit.reason, retryAfterMs: rateLimit.retryAfterMs },
        { status: 429 },
      );
    }

    const { problemId, language, code, mode } = body as {
      problemId: string;
      language: LanguageId;
      code: string;
      mode?: 'RUN' | 'SUBMIT';
    };

    if (!problemId || !language || !code) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    if (code.length > 64000) {
      return NextResponse.json({ error: 'Code exceeds maximum length (64KB)' }, { status: 413 });
    }

    const langConfig = getLanguage(language);
    if (!langConfig) {
      return NextResponse.json({ error: 'Unsupported language' }, { status: 400 });
    }

    const match = await db.match.findUnique({
      where: { id: matchId },
      include: { progress: true },
    });

    if (!match) {
      return NextResponse.json({ error: 'Match not found' }, { status: 404 });
    }

    if (match.playerAId !== user.id && match.playerBId !== user.id) {
      return NextResponse.json({ error: 'Not your match' }, { status: 403 });
    }

    if (match.status !== 'IN_PROGRESS') {
      return NextResponse.json({ error: 'Match is not in progress' }, { status: 409 });
    }

    // Validate problemId is in this match's problem sequence
    if (!match.problemSequence.includes(problemId)) {
      return NextResponse.json({ error: 'Problem not in this match' }, { status: 400 });
    }

    // Verify the problem is unlocked for this user
    const progress = match.progress.find(
      (p) => p.userId === user.id && p.problemId === problemId,
    );
    if (!progress || progress.status === 'LOCKED') {
      return NextResponse.json({ error: 'Problem is locked' }, { status: 403 });
    }

    // Already solved — no resubmission
    if (progress.status === 'SOLVED') {
      return NextResponse.json({ error: 'Already solved' }, { status: 409 });
    }

    const problem = await db.problem.findUnique({
      where: { id: problemId },
      include: { testCases: { orderBy: { order: 'asc' } } },
    });

    if (!problem) {
      return NextResponse.json({ error: 'Problem not found' }, { status: 404 });
    }

    const submissionMode = mode === 'RUN' ? 'RUN' : 'SUBMIT';

    // Monthly budget: atomically increment-then-check for SUBMIT only.
    // Using incrementAndCheckBudget avoids the TOCTOU race between separate
    // checkBudget() and incrementBudget() calls.
    if (submissionMode === 'SUBMIT') {
      const budget = await incrementAndCheckBudget(user.id);
      if (!budget.allowed) {
        return budgetExceededResponse();
      }
    }

    // For RUN: only sample test cases. For SUBMIT: all test cases.
    const testCases =
      submissionMode === 'RUN'
        ? problem.testCases.filter((tc) => tc.isSample)
        : problem.testCases;

    if (testCases.length === 0) {
      return NextResponse.json({ error: 'No test cases available' }, { status: 500 });
    }

    // Create submission record
    const submission = await db.submission.create({
      data: {
        matchId: match.id,
        userId: user.id,
        problemId,
        language,
        code,
        mode: submissionMode,
        verdict: 'RUNNING',
        total: testCases.length,
      },
    });

    // Judge (with concurrency limiting to protect Judge0)
    let result;
    try {
      result = await withJudgeConcurrency(() => judgeSubmission({
        language: langConfig,
        source: code,
        testCases: testCases.map((tc) => ({ input: tc.input, expected: tc.expectedOutput })),
        timeLimitMs: problem.timeLimitMs,
        memoryLimitMb: problem.memoryLimitMb,
      }));
    } catch (judgeErr) {
      const msg = judgeErr instanceof Error ? judgeErr.message : String(judgeErr);
      console.error('[submit] judge error:', msg);
      await db.submission.update({
        where: { id: submission.id },
        data: { verdict: 'CE', passed: 0, error: msg.slice(0, 2000) },
      });
      return NextResponse.json({
        submissionId: submission.id,
        verdict: 'CE',
        passed: 0,
        total: testCases.length,
        timeMs: null,
        memoryKb: null,
        error: 'Judge unavailable. Please try again.',
        earlyFinish: false,
        matchStatus: 'IN_PROGRESS',
        nextProblem: null,
        winnerId: null,
      });
    }

    if (!result) {
      return NextResponse.json({ error: 'Judge returned no result' }, { status: 500 });
    }

    // Update submission and progress atomically after judging
    const postJudgeResult = await db.$transaction(async (tx) => {
      await tx.submission.update({
        where: { id: submission.id },
        data: {
          verdict: result.verdict,
          passed: result.passed,
          timeMs: result.timeMs,
          memoryKb: result.memoryKb,
          error: result.compileError ?? result.runtimeError ?? null,
        },
      });

      // Re-read the MatchProgress row WITH a lock to prevent the WA+AC race:
      // two concurrent submissions (WA then AC) must not both see wrongSubmissions=0.
      const progressRows = await tx.$queryRaw<
        Array<{
          id: string;
          status: string;
          wrongSubmissions: number;
          scoreEarned: number;
          problemOrder: number;
          problemId: string;
        }>
      >`SELECT * FROM "MatchProgress" WHERE "matchId" = ${matchId} AND "userId" = ${user.id} AND "problemId" = ${problemId} FOR UPDATE`;

      const currentProgress = progressRows[0];
      if (!currentProgress) {
        throw new Error('Progress row not found');
      }

      // Re-check inside the transaction: already solved → no resubmission
      if (currentProgress.status === 'SOLVED') {
        return { earlyFinish: false, matchStatus: 'IN_PROGRESS', nextProblem: null, winnerId: null as string | null };
      }

      let earlyFinish = false;
      let matchStatus = 'IN_PROGRESS';
      let nextProblem: { slug: string; problemId: string; problemOrder: number } | null = null;
      let winnerId: string | null = null;

      // If SUBMIT and AC, update progress and unlock next problem
      if (submissionMode === 'SUBMIT' && result.verdict === 'AC') {
        const scoreEarned = Math.max(
          0,
          problem.points - currentProgress.wrongSubmissions * MATCH_CONFIG.wrongSubmissionPenalty,
        );
        await tx.matchProgress.update({
          where: { id: currentProgress.id },
          data: {
            status: 'SOLVED',
            solvedAt: new Date(),
            scoreEarned,
          },
        });

        // Unlock next problem in the sequence (by problemOrder)
        const nextOrder = currentProgress.problemOrder + 1;
        const nextProgress = await tx.matchProgress.findFirst({
          where: { matchId: match.id, userId: user.id, problemOrder: nextOrder },
        });
        if (nextProgress) {
          await tx.matchProgress.update({
            where: { id: nextProgress.id },
            data: { status: 'UNLOCKED', unlockedAt: new Date() },
          });
          const nextProb = await tx.problem.findUnique({ where: { id: nextProgress.problemId } });
          nextProblem = nextProb ? { slug: nextProb.slug, problemId: nextProb.id, problemOrder: nextProgress.problemOrder } : null;
        }

        // Check for early finish — re-read inside the transaction
        const updatedProgress = await tx.matchProgress.findMany({
          where: { matchId: match.id, userId: user.id },
        });
        const allDone = updatedProgress.every((p) => p.status === 'SOLVED');

        if (allDone) {
          earlyFinish = true;
          matchStatus = 'COMPLETED';
          winnerId = user.id;
        }
      }

      // If SUBMIT and not AC, increment wrong submissions atomically
      if (submissionMode === 'SUBMIT' && result.verdict !== 'AC') {
        await tx.matchProgress.update({
          where: { id: currentProgress.id },
          data: { wrongSubmissions: { increment: 1 } },
        });
      }

      return { earlyFinish, matchStatus, nextProblem, winnerId };
    });

    // If early finish was detected, finalize the match
    if (postJudgeResult.earlyFinish) {
      try {
        const finalResult = await finalizeMatch({
          matchId: match.id,
          reason: 'early_finish',
        });
        postJudgeResult.winnerId = finalResult?.winnerId ?? user.id;

        // Emit match:end to both players
        const matchData = await db.match.findUnique({ where: { id: matchId } });
        if (matchData) {
          const endPayload: MatchEndPayload = {
            matchId,
            status: 'COMPLETED',
            winnerId: matchData.winnerId,
            scoreA: matchData.scoreA,
            scoreB: matchData.scoreB,
            eloDeltaA: matchData.eloDeltaA,
            eloDeltaB: matchData.eloDeltaB,
            reason: 'early_finish',
          };
          await emitToMatch(matchId, 'match:end', endPayload);
        }
      } catch (e) {
        console.error('[submit] early finish finalization failed:', e);
      }
    }

    // --- Emit Socket.IO events ---

    // 1. Build the verdict payload WITH the submitter's userId (so the client
    //    can filter whose verdict it is) and the full error (only sent to the
    //    submitter, not the opponent).
    const fullVerdictPayload: SubmissionVerdictPayload = {
      matchId,
      submissionId: submission.id,
      userId: user.id,
      problemId,
      problemOrder: progress.problemOrder,
      verdict: result.verdict as SubmissionVerdictPayload['verdict'],
      passed: result.passed,
      total: result.total,
      timeMs: result.timeMs,
      memoryKb: result.memoryKb,
      error: result.compileError ?? result.runtimeError ?? undefined,
    };
    // Sanitized version for the opponent (no error text — prevents leaking
    // compile/runtime errors that hint at the expected approach).
    const sanitizedVerdictPayload: SubmissionVerdictPayload = {
      ...fullVerdictPayload,
      error: undefined,
    };

    // 2. Build progress snapshots for both players.
    const opponentId = user.id === match.playerAId ? match.playerBId : match.playerAId;
    const [playerSnapshot, opponentSnapshot] = await Promise.all([
      buildOpponentSnapshot(matchId, user.id, match.totalProblems),
      buildOpponentSnapshot(matchId, opponentId, match.totalProblems),
    ]);

    // 3. Emit in parallel:
    //    - Full verdict (with errors) ONLY to the submitter.
    //    - Sanitized verdict (no errors) to the whole match room (so the
    //      opponent sees the verdict happened, but not the error text).
    //    - Both progress snapshots to the whole room.
    const socketPromises: Promise<boolean>[] = [
      emitToUser(user.id, 'submission:verdict', fullVerdictPayload),
      emitToMatch(matchId, 'submission:verdict', sanitizedVerdictPayload),
      emitToMatch(matchId, 'opponent:progress', playerSnapshot),
      emitToMatch(matchId, 'opponent:progress', opponentSnapshot),
    ];
    if (postJudgeResult.nextProblem) {
      socketPromises.push(
        emitToMatch(matchId, 'problem:unlocked', {
          problemOrder: postJudgeResult.nextProblem.problemOrder,
        }),
      );
    }
    await Promise.all(socketPromises);

    return NextResponse.json({
      submissionId: submission.id,
      verdict: result.verdict,
      passed: result.passed,
      total: result.total,
      timeMs: result.timeMs,
      memoryKb: result.memoryKb,
      error: result.compileError ?? result.runtimeError ?? null,
      earlyFinish: postJudgeResult.earlyFinish,
      matchStatus: postJudgeResult.matchStatus,
      nextProblem: postJudgeResult.nextProblem,
      winnerId: postJudgeResult.winnerId,
    });
  } catch (e) {
    if (e instanceof Error && e.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
