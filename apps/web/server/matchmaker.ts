/**
 * Matchmaking worker — polls the Redis queue and creates matches.
 *
 * Runs as a separate process (`pnpm dev:matchmaker`). Pairs players whose
 * ELO gap fits their time-widened matchmaking window.
 *
 * Safety: uses a Redis SET NX lock around the find-pair → dequeue → create
 * pipeline so multiple matchmaker instances can't double-pair a player.
 *
 * After creating a match, emits match:start to both players via the
 * HMAC-authenticated realtime bridge.
 */

import { findPair, dequeue, enqueue, createMatch, acquireLock, releaseLock, type RedisLike } from '@zapdos/match';
import Redis from 'ioredis';
import { db } from '@zapdos/db';
import { matchRoom } from '@zapdos/realtime';
import type { MatchStartPayload } from '@zapdos/realtime';
import { createHmac } from 'node:crypto';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const POLL_INTERVAL_MS = 2000;
// The lock (SET NX PX + Lua compare-and-delete) lives in @zapdos/match/lock.ts so it can be tested on its own.
// Its 15s TTL is deliberately far longer than findPair + dequeue + createMatch, even under DB load.
const REALTIME_URL = process.env.REALTIME_URL ?? 'http://localhost:3002';
const AUTH_SECRET = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? '';

const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
});

const redisCompat = redis as unknown as RedisLike;
const META_PREFIX = 'zapdos:matchmaking:meta:';

/** Emit a socket event via the HMAC-authenticated HTTP bridge. */
async function emitSocketEvent(room: string, event: string, payload: unknown): Promise<boolean> {
  try {
    const body = JSON.stringify({ room, event, payload });
    const sig = createHmac('sha256', AUTH_SECRET).update(body).digest('hex');
    const res = await fetch(`${REALTIME_URL}/emit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Signature': sig,
      },
      body,
    });
    return res.ok;
  } catch (err) {
    console.error(`[matchmaker] Failed to emit ${event} to ${room}:`, err);
    return false;
  }
}

async function poll(): Promise<void> {
  // Acquire lock to prevent double-pairing across instances
  const lockValue = await acquireLock(redis);
  if (!lockValue) return;

  try {
    const pair = await findPair(redisCompat, Date.now());
    if (!pair) return;

    const [playerAId, playerBId] = pair;

    // Read mode from the first player's queue metadata
    const raw = await redis.get(`${META_PREFIX}${playerAId}`);
    let meta: { mode?: string } = {};
    if (raw) {
      try {
        meta = JSON.parse(raw);
      } catch {
        console.warn(`[matchmaker] Failed to parse metadata for ${playerAId}`);
      }
    }
    const mode = (meta.mode ?? 'SPRINT') as 'SPRINT' | 'PROGRESSIVE';

    console.log(`[matchmaker] Pairing ${playerAId} vs ${playerBId} (${mode})`);

    // Remove both from queue BEFORE creating the match, so a concurrent
    // findPair can't re-pair them.
    const metaA = await redis.get(`${META_PREFIX}${playerAId}`);
    const metaB = await redis.get(`${META_PREFIX}${playerBId}`);
    await Promise.all([
      dequeue(redisCompat, playerAId),
      dequeue(redisCompat, playerBId),
    ]);

    // Create the match
    let matchId;
    try {
      matchId = await createMatch(playerAId, playerBId, mode);
    } catch (err) {
      console.error(`[matchmaker] createMatch failed, re-queuing both players:`, err);
      // Re-queue both players so they're not orphaned
      const requeueA = metaA ? JSON.parse(metaA) : { elo: 1200, joinedAtMs: Date.now(), mode };
      const requeueB = metaB ? JSON.parse(metaB) : { elo: 1200, joinedAtMs: Date.now(), mode };
      await Promise.all([
        enqueue(redisCompat, { userId: playerAId, elo: requeueA.elo, joinedAtMs: requeueA.joinedAtMs, mode }),
        enqueue(redisCompat, { userId: playerBId, elo: requeueB.elo, joinedAtMs: requeueB.joinedAtMs, mode }),
      ]);
      return;
    }
    console.log(`[matchmaker] Match created: ${matchId} (${mode})`);

    // Fetch full match data to build match:start payload
    const match = await db.match.findUnique({
      where: { id: matchId },
      include: {
        progress: {
          include: { problem: true },
          orderBy: { problemOrder: 'asc' },
        },
        playerA: { select: { id: true, username: true, elo: true } },
        playerB: { select: { id: true, username: true, elo: true } },
      },
    });

    if (!match) {
      console.error(`[matchmaker] Match ${matchId} not found after creation`);
      return;
    }

    // Build the problem brief list (same for both players)
    const problems = match.progress
      .filter((p) => p.userId === playerAId)
      .map((p) => ({
        problemId: p.problemId,
        problemOrder: p.problemOrder,
        slug: p.problem.slug,
        title: p.problem.title,
        starterCode: p.problem.starterCode as Record<string, string>,
        timeLimitMs: p.problem.timeLimitMs,
        memoryLimitMb: p.problem.memoryLimitMb,
      }));

    // Emit match:start to both players (each gets their own opponent view)
    const payloadA: MatchStartPayload = {
      matchId,
      endsAt: (match.endsAt ?? new Date()).toISOString(),
      durationSeconds: match.durationSec,
      mode: match.mode as MatchStartPayload['mode'],
      totalProblems: match.totalProblems,
      opponent: { userId: match.playerB.id, username: match.playerB.username, elo: match.playerB.elo },
      problems,
    };

    const payloadB: MatchStartPayload = {
      matchId,
      endsAt: (match.endsAt ?? new Date()).toISOString(),
      durationSeconds: match.durationSec,
      mode: match.mode as MatchStartPayload['mode'],
      totalProblems: match.totalProblems,
      opponent: { userId: match.playerA.id, username: match.playerA.username, elo: match.playerA.elo },
      problems,
    };

    await Promise.all([
      emitSocketEvent(`user:${playerAId}`, 'match:start', payloadA),
      emitSocketEvent(`user:${playerBId}`, 'match:start', payloadB),
    ]);

    console.log(`[matchmaker] Emitted match:start to both players for ${matchId}`);
  } catch (err) {
    console.error('[matchmaker] Error:', err);
  } finally {
    await releaseLock(redis, lockValue);
  }
}

// Recursive setTimeout — prevents overlapping polls (unlike setInterval)
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let shuttingDown = false;

function scheduleNextPoll() {
  if (shuttingDown) return;
  pollTimer = setTimeout(async () => {
    await poll();
    scheduleNextPoll();
  }, POLL_INTERVAL_MS);
}

// Graceful shutdown
function shutdown(signal: string) {
  console.log(`[matchmaker] Received ${signal}, shutting down...`);
  shuttingDown = true;
  if (pollTimer) clearTimeout(pollTimer);
  redis.disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => console.error('[matchmaker] Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('[matchmaker] Uncaught exception:', err));

console.log('[matchmaker] Starting matchmaking worker...');
scheduleNextPoll();
