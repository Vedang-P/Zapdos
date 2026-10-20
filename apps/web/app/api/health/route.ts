/**
 * Health check endpoint.
 *
 * Probes Postgres, the Render realtime service, and the configured judge
 * backend. Used as the Render liveness path and as a quick deployment check.
 *
 *   GET /api/health -> { status, services: {...}, ts }
 */

import { NextResponse } from 'next/server';
import { db } from '@zapdos/db';
import { pingJudge } from '@zapdos/judge';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

async function probe<T>(name: string, fn: () => Promise<T>): Promise<[string, T | { error: string }]> {
  try {
    const result = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ]);
    return [name, result as T | { error: string }];
  } catch {
    return [name, { error: 'check failed' }];
  }
}

export async function GET() {
  const [pg, realtime, judge] = await Promise.all([
    probe('postgres', async () => {
      const result = await db.$queryRaw`SELECT 1 AS ok`;
      return result;
    }),
    probe('realtime', async () => {
      const res = await fetch(`${env.realtimeUrl.replace(/\/+$/, '')}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`realtime HTTP ${res.status}`);
      return (await res.json()) as { status: string };
    }),
    probe('judge', async () => {
      const result = await pingJudge();
      if (!result.ok) throw new Error(result.detail ?? 'judge not configured');
      return result;
    }),
  ]);

  const services = { [pg[0]]: pg[1], [realtime[0]]: realtime[1], [judge[0]]: judge[1] };
  const allOk = !Object.values(services).some((v) => v && typeof v === 'object' && 'error' in v);

  return NextResponse.json(
    { status: allOk ? 'ok' : 'degraded', services, ts: new Date().toISOString() },
    { status: allOk ? 200 : 503 },
  );
}
