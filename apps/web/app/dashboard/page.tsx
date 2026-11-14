'use client';

import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { StatusBadge } from '@/components/StatusBadge';
import { StatCard } from '@/components/StatCard';
import { DashboardSkeleton } from '@/components/DashboardSkeleton';
import { EmptyState } from '@/components/EmptyState';
import { TerminalWindow } from '@/components/TerminalWindow';
import { RecommendedProblems } from '@/components/RecommendedProblems';
import { GlowText } from '@/components/GlowText';
import { getRankTier, getNextTier } from '@/lib/rank-tiers';

interface UserProfile {
  id: string;
  username: string;
  email: string;
  elo: number;
  gamesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
}

interface MatchHistory {
  id: string;
  playerA: { id: string; username: string };
  playerB: { id: string; username: string };
  winner: { id: string; username: string } | null;
  scoreA: number;
  scoreB: number;
  eloDeltaA: number;
  eloDeltaB: number;
  createdAt: string;
}

export default function DashboardPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [history, setHistory] = useState<MatchHistory[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.push('/signin?callbackUrl=/dashboard');
      return;
    }
    if (status === 'authenticated') {
      Promise.all([
        fetch('/api/user/profile').then((r) => r.json()),
        fetch('/api/match/history').then((r) => r.json()),
      ]).then(([p, h]) => {
        setProfile(p);
        setHistory(h);
        setLoading(false);
      }).catch(() => setLoading(false));
    }
  }, [status, router]);

  if (loading) return <DashboardSkeleton />;

  if (!profile) {
    return (
      <div className="flex min-h-[calc(100vh-3rem)] items-center justify-center">
        <div className="text-center">
          <p className="font-mono text-sm text-error glow-red">error: failed to load profile</p>
          <button onClick={() => window.location.reload()} className="btn-ghost mt-3 h-8 font-mono text-xs">&gt; retry</button>
        </div>
      </div>
    );
  }

  const winRate = profile.gamesPlayed > 0
    ? ((profile.wins / profile.gamesPlayed) * 100).toFixed(0)
    : '0';

  // Calculate current win streak from history (most recent first)
  let recentWins = 0;
  if (history.length > 0) {
    const sorted = [...history].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    for (const m of sorted) {
      if (m.winner?.id === profile.id) recentWins++;
      else break;
    }
  }

  const tier = getRankTier(profile.elo);
  const nextTier = getNextTier(profile.elo);
  const eloToNext = nextTier ? nextTier.minElo - profile.elo : 0;

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-10 animate-fade-in">
      {/* Profile header */}
      <div className="mb-8">
        <div className="flex items-baseline justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight" style={{ fontFamily: 'var(--font-space-grotesk)' }}>
              <GlowText color="green">{profile.username}</GlowText>
            </h1>
            <p className="mt-0.5 font-mono text-xs text-text-muted">{profile.email}</p>
            <div className="mt-2 flex items-center gap-2">
              <span
                className="font-mono text-xs px-2 py-0.5 rounded border"
                style={{ color: tier.color, borderColor: `${tier.color}40`, backgroundColor: `${tier.color}10` }}
              >
                {tier.name}
              </span>
              {recentWins >= 3 && (
                <span className="font-mono text-xs text-warning glow-amber">
                  {recentWins}x streak
                </span>
              )}
            </div>
          </div>
          <div className="text-right">
            <div className="font-mono text-3xl font-semibold text-brand tabular-nums glow-green">{profile.elo}</div>
            <div className="font-mono text-xs text-text-muted">ELO</div>
            {nextTier && (
              <div className="mt-1 font-mono text-[10px] text-text-muted/60">
                {eloToNext} to {nextTier.name}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Stats row */}
      <TerminalWindow title="stats/summary.log" className="mb-8">
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-4">
          <StatCard label="games" value={profile.gamesPlayed} />
          <StatCard label="wins" value={profile.wins} />
          <StatCard label="losses" value={profile.losses} />
          <StatCard label="draws" value={profile.draws} />
          <StatCard label="win %" value={`${winRate}%`} accent />
        </div>
      </TerminalWindow>

      {/* CTA */}
      <div className="mb-8">
        <Link href="/play" className="btn-primary w-full h-10 font-mono text-sm">
          &gt; find match
        </Link>
      </div>

      <RecommendedProblems />

      {/* Match history */}
      <h2 className="mb-3 font-mono text-sm font-medium text-text-secondary tracking-tight">
        <span className="text-text-muted/50">$</span> recent matches
      </h2>
      {history.length === 0 ? (
        <EmptyState
          title="no matches yet"
          description="start playing to build your history"
          action={<Link href="/play" className="btn-ghost h-8 font-mono text-xs">&gt; find match</Link>}
        />
      ) : (
        <div className="space-y-px">
          {history.map((match) => {
            const isPlayerA = match.playerA.id === profile.id;
            const opponent = isPlayerA ? match.playerB : match.playerA;
            const myScore = isPlayerA ? match.scoreA : match.scoreB;
            const opScore = isPlayerA ? match.scoreB : match.scoreA;
            const myDelta = isPlayerA ? match.eloDeltaA : match.eloDeltaB;
            const won = match.winner?.id === profile.id;
            const draw = !match.winner;

            return (
              <div key={match.id} className="card flex items-center justify-between px-4 py-3">
                <div className="flex items-center gap-3">
                  <StatusBadge variant={draw ? 'draw' : won ? 'win' : 'loss'}>
                    {draw ? 'DRAW' : won ? 'WIN' : 'LOSS'}
                  </StatusBadge>
                  <span className="font-mono text-sm text-text-secondary">vs {opponent.username}</span>
                </div>
                <div className="flex items-center gap-4">
                  <span className="font-mono text-sm text-text-secondary tabular-nums">
                    {myScore}–{opScore}
                  </span>
                  <span
                    className={`font-mono text-xs tabular-nums ${
                      myDelta > 0 ? 'text-success glow-green' : myDelta < 0 ? 'text-error glow-red' : 'text-text-muted'
                    }`}
                  >
                    {myDelta > 0 ? '+' : ''}{myDelta}
                  </span>
                  <span className="font-mono text-xs text-text-muted">
                    {new Date(match.createdAt).toLocaleDateString()}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
