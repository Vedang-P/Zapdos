/**
 * Standalone Socket.IO realtime server.
 *
 * Runs as a separate process from Next.js (`pnpm dev:realtime`). In production
 * both are started by the deployment; for dev they run side by side.
 *
 * Handles:
 * - Auth-verified room joins
 * - Timer sync via heartbeat
 * - HTTP bridge for other processes to emit events (POST /emit)
 * - Disconnect cleanup
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import type { ClientEvents, ServerEvents } from '@zapdos/realtime';
import { matchRoom, userRoom } from '@zapdos/realtime';
import { db } from '@zapdos/db';
import { enqueue, dequeue, QUEUE_KEY, type RedisLike } from '@zapdos/match';

const PORT = Number(process.env.REALTIME_PORT ?? process.env.PORT ?? 3002);
const AUTH_SECRET = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? '';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const CORS_ORIGINS = (process.env.REALTIME_CORS_ORIGIN ?? 'http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

interface AuthenticatedSocket extends Socket {
  userId?: string;
  username?: string;
}

const MAX_BODY = 1_000_000; // 1MB cap

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function readBody(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
  return new Promise((resolve) => {
    let body = '';
    let bodySize = 0;
    let settled = false;

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      bodySize += chunk.length;
      if (bodySize > MAX_BODY) {
        sendJson(res, 413, { error: 'Body too large' });
        req.destroy();
        finish(null);
        return;
      }
      body += chunk.toString('utf8');
    });
    req.on('end', () => finish(body));
    req.on('error', () => {
      if (settled) return;
      sendJson(res, 400, { error: 'Invalid request' });
      finish(null);
    });
  });
}

/** Read a JSON body and verify its HMAC signature. */
async function readSignedJson(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<unknown | null> {
  const body = await readBody(req, res);
  if (body === null) return null;

  const sig = req.headers['x-internal-signature'] as string | undefined;
  if (!AUTH_SECRET || !sig) {
    sendJson(res, 403, { error: 'Missing signature' });
    return null;
  }

  const expectedSig = createHmac('sha256', AUTH_SECRET).update(body).digest('hex');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    sendJson(res, 403, { error: 'Invalid signature' });
    return null;
  }

  try {
    return JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON' });
    return null;
  }
}

/**
 * Matchmaking queue bridge. The web app (on Vercel) has no Redis, so join /
 * leave / status calls are forwarded here, where the queue and matchmaker live.
 */
async function handleQueue(
  path: string,
  data: unknown,
  res: ServerResponse,
): Promise<void> {
  const payload = (data ?? {}) as { userId?: unknown; elo?: unknown; mode?: unknown };
  const userId = typeof payload.userId === 'string' ? payload.userId : '';
  if (!userId) {
    sendJson(res, 400, { error: 'Missing userId' });
    return;
  }

  try {
    if (path === '/queue/join') {
      const elo = Number(payload.elo);
      if (!Number.isFinite(elo)) {
        sendJson(res, 400, { error: 'Invalid elo' });
        return;
      }
      const mode = payload.mode === 'PROGRESSIVE' ? 'PROGRESSIVE' : 'SPRINT';
      const score = await pubClient.zscore(QUEUE_KEY, userId);
      if (score !== null) {
        sendJson(res, 200, { status: 'already_queued' });
        return;
      }
      await enqueue(queueRedis, {
        userId,
        elo,
        joinedAtMs: Date.now(),
        mode,
      });
      sendJson(res, 200, { status: 'queued' });
      return;
    }

    if (path === '/queue/leave') {
      await dequeue(queueRedis, userId);
      sendJson(res, 200, { status: 'dequeued' });
      return;
    }

    if (path === '/queue/status') {
      const score = await pubClient.zscore(QUEUE_KEY, userId);
      sendJson(res, 200, { status: score !== null ? 'queued' : 'idle' });
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('[realtime] queue bridge error:', err);
    sendJson(res, 500, { error: 'Queue unavailable' });
  }
}

const httpServer = createServer(async (req, res) => {
  // Health check (also used by the Cloudflare keepalive cron and Render).
  if (req.url === '/health') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  // HMAC-signed internal bridge endpoints.
  if (
    req.method === 'POST' &&
    (req.url === '/emit' || req.url?.startsWith('/queue/'))
  ) {
    const data = await readSignedJson(req, res);
    if (data === null) return;

    if (req.url === '/emit') {
      const { room, event, payload } = data as {
        room?: string;
        event?: string;
        payload?: unknown;
      };
      if (!room || !event) {
        sendJson(res, 400, { error: 'Missing room or event' });
        return;
      }
      io.to(room).emit(event as any, payload);
      sendJson(res, 200, { ok: true });
      return;
    }

    await handleQueue(req.url!, data, res);
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

const io: InstanceType<typeof Server<ClientEvents, ServerEvents>> = new Server<ClientEvents, ServerEvents>(httpServer, {
  cors: { origin: CORS_ORIGINS, credentials: true },
  maxHttpBufferSize: 1e6,
  connectTimeout: 10000,
});

// Redis adapter — enables horizontal scaling: multiple realtime instances
// share rooms and can emit to sockets connected to any instance.
const pubClient = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const subClient = pubClient.duplicate();
const queueRedis = pubClient as unknown as RedisLike;
pubClient.on('error', (err) => console.error('[realtime] Redis error:', err.message));
subClient.on('error', (err) => console.error('[realtime] Redis subscriber error:', err.message));
io.adapter(createAdapter(pubClient, subClient));

// Track connected sockets per match
const matchSockets = new Map<string, Set<string>>();
const socketMatches = new Map<string, string>();

// Disconnect → auto-forfeit. When a player's LAST socket for a match drops, we
// start a grace timer; if they don't reconnect within it, the opponent wins by
// forfeit instead of waiting out the full match clock.
const socketUser = new Map<string, string>(); // socketId -> userId
const forfeitTimers = new Map<string, NodeJS.Timeout>(); // `${matchId}:${userId}` -> timer
const DISCONNECT_FORFEIT_GRACE_MS = Number(process.env.DISCONNECT_FORFEIT_GRACE_MS ?? 30_000);

function userHasSocketInMatch(matchId: string, userId: string): boolean {
  const sockets = matchSockets.get(matchId);
  if (!sockets) return false;
  for (const sid of sockets) {
    if (socketUser.get(sid) === userId) return true;
  }
  return false;
}

function cancelForfeit(matchId: string, userId: string): void {
  const key = `${matchId}:${userId}`;
  const timer = forfeitTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    forfeitTimers.delete(key);
  }
}

function scheduleForfeit(matchId: string, userId: string): void {
  const key = `${matchId}:${userId}`;
  if (forfeitTimers.has(key)) return; // already pending
  const timer = setTimeout(async () => {
    forfeitTimers.delete(key);
    try {
      // Reconnected during the grace window? Then don't forfeit.
      if (userHasSocketInMatch(matchId, userId)) return;
      const match = await db.match.findUnique({
        where: { id: matchId },
        select: { status: true, playerAId: true, playerBId: true },
      });
      // No-op if the match already ended (finalizeMatch is idempotent anyway).
      if (!match || match.status !== 'IN_PROGRESS') return;
      if (match.playerAId !== userId && match.playerBId !== userId) return;

      const { finalizeMatch } = await import('@zapdos/match');
      const { emitSocketEvent } = await import('../lib/socket');
      await finalizeMatch({ matchId, reason: 'disconnect', forfeiterId: userId });

      const matchData = await db.match.findUnique({ where: { id: matchId } });
      if (matchData) {
        await emitSocketEvent(matchRoom(matchId), 'match:end', {
          matchId,
          status: 'COMPLETED',
          winnerId: matchData.winnerId,
          scoreA: matchData.scoreA,
          scoreB: matchData.scoreB,
          eloDeltaA: matchData.eloDeltaA,
          eloDeltaB: matchData.eloDeltaB,
          reason: 'disconnect',
        });
      }
      console.log(`[realtime] auto-forfeit: ${userId} disconnected from ${matchId}`);
    } catch (err) {
      console.error(`[realtime] auto-forfeit failed for ${matchId}/${userId}:`, err);
    }
  }, DISCONNECT_FORFEIT_GRACE_MS);
  forfeitTimers.set(key, timer);
}

/** Verify a NextAuth-style JWT (HMAC-SHA256) using only Node crypto. */
function verifyJwt(token: string, secret: string): { userId: string; username?: string } | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, sig] = parts as [string, string, string];
    const expectedSig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
    const sigBuf = Buffer.from(sig);
    const expectedBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!data.sub || typeof data.sub !== 'string') return null;
    // Reject expired tokens (exp is in seconds since epoch)
    if (typeof data.exp === 'number' && data.exp * 1000 < Date.now()) return null;
    return { userId: data.sub, username: data.name };
  } catch {
    return null;
  }
}

// Auth middleware — verify JWT from handshake
io.use((socket: AuthenticatedSocket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token || typeof token !== 'string') {
    return next(new Error('Authentication required'));
  }
  if (!AUTH_SECRET) {
    return next(new Error('Server misconfigured'));
  }
  const decoded = verifyJwt(token, AUTH_SECRET);
  if (!decoded) {
    return next(new Error('Invalid token'));
  }
  socket.userId = decoded.userId;
  socket.username = decoded.username ?? '';
  next();
});

io.on('connection', (socket: AuthenticatedSocket) => {
  console.log(`[realtime] connect ${socket.id} user=${socket.userId}`);

  // Join the user's personal room so emitToUser() events reach them
  if (socket.userId) {
    void socket.join(userRoom(socket.userId));
    socketUser.set(socket.id, socket.userId);
  }

  socket.on('match:join', (matchId, ack) => {
    // Verify the user is a participant in this match
    db.match.findUnique({ where: { id: matchId }, select: { playerAId: true, playerBId: true } })
      .then((match) => {
        if (!match) { ack?.(false); return; }
        if (match.playerAId !== socket.userId && match.playerBId !== socket.userId) {
          ack?.(false); return;
        }
        void socket.join(matchRoom(matchId));
        if (!matchSockets.has(matchId)) matchSockets.set(matchId, new Set());
        matchSockets.get(matchId)!.add(socket.id);
        socketMatches.set(socket.id, matchId);
        if (socket.userId) {
          socketUser.set(socket.id, socket.userId);
          cancelForfeit(matchId, socket.userId); // (re)connected → cancel any pending forfeit
        }
        console.log(`[realtime] ${socket.id} joined match ${matchId}`);
        ack?.(true);
      })
      .catch(() => ack?.(false));
  });

  socket.on('match:leave', (matchId) => {
    void socket.leave(matchRoom(matchId));
    matchSockets.get(matchId)?.delete(socket.id);
    socketMatches.delete(socket.id);
    console.log(`[realtime] ${socket.id} left match ${matchId}`);
  });

  socket.on('match:forfeit', async (matchId) => {
    try {
      // Verify the user is a participant in this match
      const match = await db.match.findUnique({
        where: { id: matchId },
        select: { playerAId: true, playerBId: true, status: true },
      });
      if (!match || match.status !== 'IN_PROGRESS') return;
      if (match.playerAId !== socket.userId && match.playerBId !== socket.userId) return;

      // Determine the winner (the opponent of the forfeiter)
      const opponentId = socket.userId === match.playerAId ? match.playerBId : match.playerAId;

      // Import and call finalizeMatch directly (no HTTP request needed)
      const { finalizeMatch } = await import('@zapdos/match');
      const { emitSocketEvent } = await import('../lib/socket');
      const { matchRoom } = await import('@zapdos/realtime');

      const result = await finalizeMatch({ matchId, reason: 'forfeit', forfeiterId: socket.userId });

      // Emit match:end to both players
      const matchData = await db.match.findUnique({ where: { id: matchId } });
      if (matchData) {
        const endPayload = {
          matchId,
          status: 'COMPLETED',
          winnerId: matchData.winnerId,
          scoreA: matchData.scoreA,
          scoreB: matchData.scoreB,
          eloDeltaA: matchData.eloDeltaA,
          eloDeltaB: matchData.eloDeltaB,
          reason: 'forfeit',
        };
        await emitSocketEvent(matchRoom(matchId), 'match:end', endPayload);
      }

      console.log(`[realtime] ${socket.id} forfeited match ${matchId}`);
    } catch (err) {
      console.error(`[realtime] forfeit failed for match ${matchId}:`, err);
    }
  });

  socket.on('match:heartbeat', (matchId) => {
    db.match.findUnique({
      where: { id: matchId },
      select: { endsAt: true, playerAId: true, playerBId: true },
    })
      .then((match) => {
        if (!match) return;
        // Only respond if the socket user is a participant
        if (match.playerAId !== socket.userId && match.playerBId !== socket.userId) return;
        const endsAt = match.endsAt ?? new Date();
        const remainingMs = Math.max(0, endsAt.getTime() - Date.now());
        socket.emit('timer:sync', {
          endsAt: endsAt.toISOString(),
          remainingMs,
        });
      })
      .catch(() => {});
  });

  socket.on('disconnect', () => {
    const matchId = socketMatches.get(socket.id);
    const userId = socket.userId;
    if (matchId) {
      matchSockets.get(matchId)?.delete(socket.id);
      socketMatches.delete(socket.id);
      // If this was the user's last socket in the match, start the grace timer.
      if (userId && !userHasSocketInMatch(matchId, userId)) {
        scheduleForfeit(matchId, userId);
      }
    }
    socketUser.delete(socket.id);
    console.log(`[realtime] disconnect ${socket.id}`);
  });
});

// Export io for use by other modules (matchmaking worker, etc.)
export { io, matchRoom, userRoom };

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[realtime] Socket.IO server listening on :${PORT}`);
});

// Graceful shutdown
function shutdown(signal: string) {
  console.log(`[realtime] Received ${signal}, shutting down...`);
  io.close(() => {
    pubClient.disconnect();
    subClient.disconnect();
    httpServer.close(() => process.exit(0));
  });
  // Force exit after 5s if graceful close hangs
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => console.error('[realtime] Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('[realtime] Uncaught exception:', err));
