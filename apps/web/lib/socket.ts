/**
 * Helper to talk to the standalone realtime process.
 *
 * The Socket.IO server runs on Render (or localhost:3002 in development). This
 * module sends HMAC-signed HTTP requests to its internal bridge endpoints:
 *
 *   POST /emit          broadcast an event to a room
 *   POST /queue/join    enqueue a player
 *   POST /queue/leave   remove a player from the queue
 *   POST /queue/status  query whether a player is queued
 *
 * Security: every request is signed with AUTH_SECRET so that external
 * attackers can't forge events or poison the matchmaking queue even if they
 * can reach the realtime port.
 */

import { createHmac } from 'node:crypto';
import { matchRoom } from '@zapdos/realtime';

const REALTIME_URL = (process.env.REALTIME_URL ?? 'http://localhost:3002').replace(/\/+$/, '');
const AUTH_SECRET = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? '';

async function signedPost<T>(path: string, payload: unknown): Promise<T | null> {
  if (!AUTH_SECRET) {
    console.error(`[realtime] AUTH_SECRET is not set; refusing to POST ${path}`);
    return null;
  }

  try {
    const body = JSON.stringify(payload);
    const sig = createHmac('sha256', AUTH_SECRET).update(body).digest('hex');
    const res = await fetch(`${REALTIME_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Signature': sig,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[realtime] ${path} failed: HTTP ${res.status} ${text}`);
      return null;
    }

    return (await res.json()) as T;
  } catch (err) {
    console.error(`[realtime] ${path} failed:`, err);
    return null;
  }
}

export async function emitSocketEvent(
  room: string,
  event: string,
  payload: unknown,
): Promise<boolean> {
  const result = await signedPost<{ ok: boolean }>('/emit', { room, event, payload });
  return result?.ok === true;
}

/** Emit an event to a match room. */
export function emitToMatch(matchId: string, event: string, payload: unknown) {
  return emitSocketEvent(matchRoom(matchId), event, payload);
}

/** Emit an event to a specific user's room. */
export function emitToUser(userId: string, event: string, payload: unknown) {
  return emitSocketEvent(`user:${userId}`, event, payload);
}

export interface QueueJoinResult {
  status: 'queued' | 'already_queued';
}

export interface QueueStatusResult {
  status: 'queued' | 'idle';
}

export function queueJoin(payload: {
  userId: string;
  elo: number;
  mode: string;
}): Promise<QueueJoinResult | null> {
  return signedPost<QueueJoinResult>('/queue/join', payload);
}

export async function queueLeave(userId: string): Promise<boolean> {
  const result = await signedPost<{ status: string }>('/queue/leave', { userId });
  return result?.status === 'dequeued';
}

export function queueStatus(userId: string): Promise<QueueStatusResult | null> {
  return signedPost<QueueStatusResult>('/queue/status', { userId });
}
