'use client';

import { useEffect, useState } from 'react';
import { TerminalWindow } from '@/components/TerminalWindow';

interface Recommendation {
  rank: number;
  problem: { id: string; slug: string; title: string; difficulty: string };
  rationale: string;
}

/** "Recommended for you": retrieval-augmented picks from GET /api/recommendations (see docs/recommender.md). */
export function RecommendedProblems({ limit = 3 }: { limit?: number }) {
  const [items, setItems] = useState<Recommendation[] | null>(null);

  useEffect(() => {
    fetch(`/api/recommendations?limit=${limit}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setItems(data?.recommendations ?? []))
      .catch(() => setItems([]));
  }, [limit]);

  if (!items || items.length === 0) return null;
  return (
    <TerminalWindow title="recommended/for-you.log" className="mb-8">
      <ul className="space-y-3 font-mono text-xs">
        {items.map((rec) => (
          <li key={rec.problem.id}>
            <span className="text-text-secondary">
              {rec.rank}. {rec.problem.title}
            </span>{' '}
            <span className="text-text-muted">[{rec.problem.difficulty.toLowerCase()}]</span>
            <p className="mt-0.5 text-text-muted">{rec.rationale}</p>
          </li>
        ))}
      </ul>
    </TerminalWindow>
  );
}
