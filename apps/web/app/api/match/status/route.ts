import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/session';
import { queueStatus } from '@/lib/socket';
import { db } from '@zapdos/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await requireUser();

    // Check the realtime queue. If the bridge is down, fall through to the
    // database check so an in-progress match still resolves.
    const queued = await queueStatus(user.id);
    if (queued?.status === 'queued') {
      return NextResponse.json({ status: 'queued' });
    }

    // Check for active match
    const activeMatch = await db.match.findFirst({
      where: {
        status: 'IN_PROGRESS',
        OR: [{ playerAId: user.id }, { playerBId: user.id }],
      },
      include: {
        playerA: { select: { id: true, username: true, elo: true } },
        playerB: { select: { id: true, username: true, elo: true } },
      },
    });

    if (activeMatch) {
      return NextResponse.json({
        status: 'in_match',
        match: {
          id: activeMatch.id,
          endsAt: activeMatch.endsAt?.toISOString(),
          mode: activeMatch.mode,
          opponent:
            activeMatch.playerAId === user.id
              ? activeMatch.playerB
              : activeMatch.playerA,
        },
      });
    }

    return NextResponse.json({ status: 'idle' });
  } catch (e) {
    if (e instanceof Error && e.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
