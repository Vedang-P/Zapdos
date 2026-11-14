/**
 * Retrieval: an in-memory cosine index, MMR diversification, and user-profile construction.
 *
 * Vectors are L2-normalised, so cosine similarity is a dot product. At ~250 problems a brute-force scan is a few
 * microseconds per query, so there is no ANN structure to maintain.
 */

import { dot, l2Normalize } from './embedding';

export interface IndexedItem<M> {
  id: string;
  vector: Float32Array;
  meta: M;
}

export interface SearchHit<M> extends IndexedItem<M> {
  score: number;
}

export class VectorIndex<M> {
  private readonly items: IndexedItem<M>[] = [];
  private readonly byId = new Map<string, IndexedItem<M>>();

  get size(): number {
    return this.items.length;
  }

  add(item: IndexedItem<M>): void {
    this.items.push(item);
    this.byId.set(item.id, item);
  }

  get(id: string): IndexedItem<M> | undefined {
    return this.byId.get(id);
  }

  all(): readonly IndexedItem<M>[] {
    return this.items;
  }

  search(query: Float32Array, k: number, exclude?: ReadonlySet<string>): SearchHit<M>[] {
    const hits: SearchHit<M>[] = [];
    for (const item of this.items) {
      if (exclude?.has(item.id)) continue;
      hits.push({ ...item, score: dot(query, item.vector) });
    }
    hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return hits.slice(0, k);
  }
}

/**
 * Maximal Marginal Relevance: repeatedly take the candidate that maximises
 * `lambda * relevance - (1 - lambda) * (its highest similarity to anything already chosen)`.
 * lambda = 1 is pure relevance; lower values trade relevance for variety.
 */
export function mmrSelect<M>(
  candidates: ReadonlyArray<{ item: IndexedItem<M>; relevance: number }>,
  k: number,
  lambda = 0.7,
): Array<{ item: IndexedItem<M>; relevance: number; mmr: number }> {
  const remaining = [...candidates];
  const chosen: Array<{ item: IndexedItem<M>; relevance: number; mmr: number }> = [];
  while (chosen.length < k && remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]!;
      let redundancy = 0;
      for (const picked of chosen) redundancy = Math.max(redundancy, dot(candidate.item.vector, picked.item.vector));
      const score = lambda * candidate.relevance - (1 - lambda) * redundancy;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    const [picked] = remaining.splice(bestIndex, 1);
    chosen.push({ ...picked!, mmr: bestScore });
  }
  return chosen;
}

// ---------------------------------------------------------------------------------------------------------------
// User profile
// ---------------------------------------------------------------------------------------------------------------

export type Outcome = 'solved' | 'failed';

export interface HistoryEntry {
  problemId: string;
  /** `solved` = accepted at least once; `failed` = attempted but never accepted. */
  outcome: Outcome;
  /** Wrong (non-AC) submissions burned on the problem. */
  wrongSubmissions: number;
  lastActivityAt?: Date;
}

export interface ProfileEvidence {
  problemId: string;
  outcome: Outcome;
  wrongSubmissions: number;
  weight: number;
}

export interface ProfileOptions {
  /** Half-life of a history entry's influence in days (recent struggles matter more). */
  halfLifeDays?: number;
  now?: Date;
}

/**
 * Weight of one history entry in the profile.
 *
 * - failed problems carry the strongest signal: 1.0 plus 0.5 per wrong submission (capped at 6);
 * - solved problems that cost wrong submissions still show a weak spot: 0.4 plus 0.4 per wrong submission;
 * - clean solves only say "this topic is within reach": 0.2;
 * - everything decays with a half-life so last month's struggle outweighs last year's.
 */
export function entryWeight(entry: HistoryEntry, options: ProfileOptions = {}): number {
  const wrong = Math.min(Math.max(entry.wrongSubmissions, 0), 6);
  let weight: number;
  if (entry.outcome === 'failed') weight = 1 + 0.5 * wrong;
  else weight = wrong > 0 ? 0.4 + 0.4 * wrong : 0.2;
  if (entry.lastActivityAt) {
    const now = (options.now ?? new Date()).getTime();
    const ageDays = Math.max(0, (now - entry.lastActivityAt.getTime()) / 86_400_000);
    weight *= Math.max(0.2, Math.pow(0.5, ageDays / (options.halfLifeDays ?? 45)));
  }
  return weight;
}

export interface Profile {
  /** Unit vector summarising what the user struggles with; null for a cold-start user. */
  query: Float32Array | null;
  evidence: ProfileEvidence[];
  /** Problems the user has already solved - never recommended. */
  solved: Set<string>;
  /** Problems the user has attempted without solving - not recommended again by default. */
  failed: Set<string>;
}

export function buildProfile(
  history: readonly HistoryEntry[],
  vectors: ReadonlyMap<string, Float32Array>,
  options: ProfileOptions = {},
): Profile {
  const solved = new Set<string>();
  const failed = new Set<string>();
  const evidence: ProfileEvidence[] = [];
  let accumulator: Float32Array | null = null;
  for (const entry of history) {
    (entry.outcome === 'solved' ? solved : failed).add(entry.problemId);
    const vector = vectors.get(entry.problemId);
    if (!vector) continue;
    const weight = entryWeight(entry, options);
    evidence.push({ problemId: entry.problemId, outcome: entry.outcome, wrongSubmissions: entry.wrongSubmissions, weight });
    accumulator ??= new Float32Array(vector.length);
    for (let i = 0; i < vector.length; i++) accumulator[i] = accumulator[i]! + weight * vector[i]!;
  }
  for (const id of solved) failed.delete(id); // solved wins if a problem appears both ways
  evidence.sort((a, b) => b.weight - a.weight);
  return { query: accumulator ? l2Normalize(accumulator) : null, evidence, solved, failed };
}

export function centroid(vectors: Iterable<Float32Array>): Float32Array | null {
  let total: Float32Array | null = null;
  for (const vector of vectors) {
    total ??= new Float32Array(vector.length);
    for (let i = 0; i < vector.length; i++) total[i] = total[i]! + vector[i]!;
  }
  return total ? l2Normalize(total) : null;
}

const DIFFICULTY_LEVEL: Record<string, number> = { EASY: 0, MEDIUM: 1, HARD: 2 };

/** Preferred difficulty on a 0..2 scale for a rating: ~1000 -> easy, ~1400 -> medium, ~1800 -> hard. */
export function targetDifficulty(elo: number): number {
  return Math.min(2, Math.max(0, (elo - 1000) / 400));
}

/** Soft penalty (not a hard filter) for problems far from the level suited to the user's rating. */
export function difficultyPenalty(difficulty: string, elo: number, weight = 0.12): number {
  const level = DIFFICULTY_LEVEL[difficulty] ?? 0;
  return weight * Math.abs(level - targetDifficulty(elo));
}
