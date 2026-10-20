/**
 * Monthly budget tracking for judge submissions.
 *
 * Hard cap: 1000 submissions/month per user. Stored as one Postgres `Counter`
 * row per user with `resetAt` at the start of the next UTC month.
 */

import { NextResponse } from 'next/server';
import { consumeCounter, readCounter } from './counters';

export const MONTHLY_SUBMISSION_CAP = 1000;

function monthKey(userId: string): string {
  return `budget:${userId}`;
}

function nextMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}

export async function incrementAndCheckBudget(userId: string): Promise<{
  count: number;
  allowed: boolean;
}> {
  const now = new Date();
  const { count } = await consumeCounter(monthKey(userId), now, nextMonthStart(now));
  return { count, allowed: count < MONTHLY_SUBMISSION_CAP };
}

/** Check budget without incrementing. Returns current count and whether allowed. */
export async function checkBudget(userId: string): Promise<{
  count: number;
  allowed: boolean;
}> {
  const now = new Date();
  const row = await readCounter(monthKey(userId));
  const count = row && row.resetAt > now ? row.count : 0;
  return { count, allowed: count < MONTHLY_SUBMISSION_CAP };
}

/** Increment budget counter (called after successful judge). */
export async function incrementBudget(userId: string): Promise<number> {
  const now = new Date();
  const { count } = await consumeCounter(monthKey(userId), now, nextMonthStart(now));
  return count;
}

export async function getMonthlyCount(userId: string): Promise<number> {
  const now = new Date();
  const row = await readCounter(monthKey(userId));
  return row && row.resetAt > now ? row.count : 0;
}

export function budgetExceededResponse(): NextResponse {
  const now = new Date();
  return NextResponse.json(
    {
      error:
        'Monthly submission limit reached. The service is temporarily at capacity.',
      retryAfterMs: nextMonthStart(now).getTime() - now.getTime(),
    },
    { status: 429 },
  );
}
