import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/session';
import { queueJoin, queueLeave } from '@/lib/socket';
import { db } from '@zapdos/db';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const user = await requireUser();

    // Read optional mode from request body
    let mode = 'SPRINT';
    try {
      const body = await req.json();
      if (body.mode === 'SPRINT' || body.mode === 'PROGRESSIVE') {
        mode = body.mode;
      }
    } catch {
      // No body or invalid JSON — default to SPRINT
    }

    // Check if user is already in an active match
    const activeMatch = await db.match.findFirst({
      where: {
        status: 'IN_PROGRESS',
        OR: [{ playerAId: user.id }, { playerBId: user.id }],
      },
    });
    if (activeMatch) {
      return NextResponse.json({ error: 'Already in a match' }, { status: 409 });
    }

    const dbUser = await db.user.findUnique({ where: { id: user.id }, select: { elo: true } });
    if (!dbUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const result = await queueJoin({ userId: user.id, elo: dbUser.elo, mode });
    if (!result) {
      return NextResponse.json({ error: 'Matchmaking unavailable' }, { status: 503 });
    }

    if (result.status === 'already_queued') {
      return NextResponse.json({ status: 'already_queued' });
    }

    return NextResponse.json({ status: 'queued', mode });
  } catch (e) {
    if (e instanceof Error && e.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const user = await requireUser();
    const ok = await queueLeave(user.id);
    if (!ok) {
      return NextResponse.json({ error: 'Matchmaking unavailable' }, { status: 503 });
    }
    return NextResponse.json({ status: 'dequeued' });
  } catch (e) {
    if (e instanceof Error && e.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
