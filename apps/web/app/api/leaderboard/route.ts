import { NextResponse } from 'next/server';
import { db } from '@zapdos/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const users = await db.user.findMany({
      orderBy: [{ elo: 'desc' }, { wins: 'desc' }],
      take: 100,
      select: {
        id: true,
        username: true,
        elo: true,
        gamesPlayed: true,
        wins: true,
        losses: true,
        draws: true,
      },
    });

    return NextResponse.json(users, {
      headers: {
        // Vercel's CDN absorbs the read burst; no Redis cache needed.
        'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
      },
    });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
