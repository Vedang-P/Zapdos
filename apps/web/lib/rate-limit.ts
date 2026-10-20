/**
 * Postgres-backed fixed-window rate limiter.
 *
 * Three tiers: per-minute (10), per-hour (50), per-day (200).
 * Returns { allowed: true } or { allowed: false, retryAfterMs, reason }.
 *
 * Each window is a single `Counter` row keyed by `rl:<key>:<window>`. Its
 * `resetAt` marks the end of the current window; the atomic upsert in
 * `counters.ts` resets the row when the window rolls over.
 */

import { consumeCounter } from './counters';

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterMs?: number;
  reason?: string;
}

interface WindowConfig {
  name: string;
  limit: number;
  windowMs: number;
}

const WINDOWS: WindowConfig[] = [
  { name: 'min', limit: 10, windowMs: 60_000 },
  { name: 'hr', limit: 50, windowMs: 3_600_000 },
  { name: 'day', limit: 200, windowMs: 86_400_000 },
];

function windowResetAt(nowMs: number, windowMs: number): Date {
  return new Date(Math.floor(nowMs / windowMs) * windowMs + windowMs);
}

async function consumeWindow(
  counterKey: string,
  window: WindowConfig,
  nowMs: number,
): Promise<WindowConfig & { count: number; resetAt: Date }> {
  const result = await consumeCounter(
    counterKey,
    new Date(nowMs),
    windowResetAt(nowMs, window.windowMs),
  );
  return { ...window, count: result.count, resetAt: result.resetAt };
}

export async function checkRateLimit(key: string): Promise<RateLimitResult> {
  const nowMs = Date.now();

  const results = await Promise.all(
    WINDOWS.map((window) => consumeWindow(`rl:${key}:${window.name}`, window, nowMs)),
  );

  for (const result of results) {
    if (result.count > result.limit) {
      return {
        allowed: false,
        limit: result.limit,
        remaining: 0,
        retryAfterMs: Math.max(1, result.resetAt.getTime() - nowMs),
        reason: `Rate limit exceeded: ${result.limit} per ${result.name}`,
      };
    }
  }

  const tightest = results[0]!;
  return {
    allowed: true,
    limit: tightest.limit,
    remaining: Math.max(0, tightest.limit - tightest.count),
  };
}

export async function checkIpSignupLimit(ip: string): Promise<RateLimitResult> {
  const nowMs = Date.now();
  const windows: WindowConfig[] = [
    { name: 'min', limit: 50, windowMs: 60_000 },
    { name: 'hr', limit: 200, windowMs: 3_600_000 },
  ];

  const results = await Promise.all(
    windows.map((window) =>
      consumeWindow(`rl:signup:${ip}:${window.name}`, window, nowMs),
    ),
  );

  for (const result of results) {
    if (result.count > result.limit) {
      return {
        allowed: false,
        limit: result.limit,
        remaining: 0,
        retryAfterMs: Math.max(1, result.resetAt.getTime() - nowMs),
        reason: 'Too many signup attempts. Try again later.',
      };
    }
  }

  const tightest = results[0]!;
  return {
    allowed: true,
    limit: tightest.limit,
    remaining: Math.max(0, tightest.limit - tightest.count),
  };
}

/** Login attempts: 20 per 15 minutes per IP. */
export async function checkLoginRateLimit(ip: string): Promise<RateLimitResult> {
  const nowMs = Date.now();
  const window: WindowConfig = { name: '15min', limit: 20, windowMs: 15 * 60_000 };
  const result = await consumeWindow(`rl:login:${ip}`, window, nowMs);

  if (result.count > result.limit) {
    return {
      allowed: false,
      limit: result.limit,
      remaining: 0,
      retryAfterMs: Math.max(1, result.resetAt.getTime() - nowMs),
      reason: 'Too many login attempts. Please try again later.',
    };
  }

  return {
    allowed: true,
    limit: result.limit,
    remaining: Math.max(0, result.limit - result.count),
  };
}
