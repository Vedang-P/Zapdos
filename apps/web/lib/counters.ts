/**
 * Postgres-backed counters.
 *
 * The web app runs on Vercel where there is no shared Redis. Rate limits and
 * the monthly judge budget therefore live in Postgres. Each key is a single row
 * with a `resetAt` timestamp; the upsert below atomically either increments the
 * current window or starts a new one.
 */

import { db } from '@zapdos/db';

export interface CounterResult {
  count: number;
  resetAt: Date;
}

/**
 * Atomically increment `key`. If the stored window has expired, reset the
 * count to 1 and move `resetAt` to the supplied end-of-window timestamp.
 */
export async function consumeCounter(
  key: string,
  now: Date,
  resetAt: Date,
): Promise<CounterResult> {
  const rows = await db.$queryRaw<CounterResult[]>`
    INSERT INTO "Counter" ("key", "count", "resetAt")
    VALUES (${key}, 1, ${resetAt})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE
        WHEN "Counter"."resetAt" <= ${now} THEN 1
        ELSE "Counter"."count" + 1
      END,
      "resetAt" = CASE
        WHEN "Counter"."resetAt" <= ${now} THEN ${resetAt}
        ELSE "Counter"."resetAt"
      END
    RETURNING "count", "resetAt"
  `;

  const row = rows[0];
  if (!row) throw new Error(`Counter upsert returned no row for ${key}`);
  return row;
}

/** Read a counter without incrementing it. */
export async function readCounter(key: string): Promise<CounterResult | null> {
  const rows = await db.$queryRaw<CounterResult[]>`
    SELECT "count", "resetAt"
    FROM "Counter"
    WHERE "key" = ${key}
    LIMIT 1
  `;
  return rows[0] ?? null;
}
