import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/session';
import { getRecommender } from '@/lib/recommender';
import type { RecommendationResult } from '@/lib/recommender';

export const dynamic = 'force-dynamic';

const MAX_LIMIT = 20;
const CACHE_TTL_MS = 30_000;
// Per-instance memo so a user refreshing the dashboard does not re-run retrieval (or an optional LLM call) each time.
const recent = new Map<string, { at: number; result: RecommendationResult }>();

/**
 * GET /api/recommendations?limit=5
 *
 * Retrieval-augmented recommendations: problems the signed-in user has not solved, ranked by similarity to the
 * problems they struggled with, diversified with MMR, each with a rationale grounded in that evidence.
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(req.url);
    const requested = Number.parseInt(searchParams.get('limit') ?? '5', 10);
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(requested) ? requested : 5));

    const key = `${user.id}:${limit}`;
    const hit = recent.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return NextResponse.json(hit.result);

    const result = await getRecommender().recommend(user.id, { limit });
    recent.set(key, { at: Date.now(), result });
    if (recent.size > 500) recent.delete(recent.keys().next().value as string);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof Error && e.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
