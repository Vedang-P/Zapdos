/**
 * Recommender service: lazy vector index + user profile + MMR + grounded rationale.
 *
 * Pipeline (the "RAG" shape):
 *   history -> profile vector            (what does this user struggle with?)
 *   profile -> top-k unsolved problems   (retrieval: cosine over the embedded corpus, ELO-aware, MMR-diversified)
 *   evidence -> rationale                (generation: template, or an LLM constrained to the retrieved evidence)
 */

import { Embedder } from './embedding';
import { dot } from './embedding';
import {
  VectorIndex,
  buildProfile,
  centroid,
  difficultyPenalty,
  mmrSelect,
  type HistoryEntry,
} from './retrieval';
import {
  generateRationales,
  type EvidenceItem,
  type LlmConfig,
  type RationaleSource,
  type RecommendationEvidence,
} from './rationale';

export interface ProblemHeader {
  id: string;
  slug: string;
  title: string;
  difficulty: string;
  points: number;
  updatedAt: Date;
}

export interface ProblemBody {
  id: string;
  descriptionMd: string;
}

export interface RecommenderRepository {
  loadProblemHeaders(): Promise<ProblemHeader[]>;
  loadProblemBodies(): Promise<ProblemBody[]>;
  loadUser(userId: string): Promise<{ elo: number } | null>;
  loadHistory(userId: string): Promise<HistoryEntry[]>;
}

/** Optional cache for the embedded corpus (the Redis implementation lives in cache.ts). */
export interface EmbeddingCache {
  get(signature: string): Promise<CachedEmbeddings | null>;
  set(signature: string, value: CachedEmbeddings): Promise<void>;
}

export interface CachedEmbeddings {
  dim: number;
  items: Array<{ id: string; vector: number[]; terms: string[] }>;
}

export interface ProblemMeta {
  slug: string;
  title: string;
  difficulty: string;
  points: number;
  terms: string[];
}

export interface IndexState {
  index: VectorIndex<ProblemMeta>;
  signature: string;
  builtAt: number;
  buildMs: number;
  source: 'database' | 'cache';
  titles: Set<string>;
}

export interface Recommendation {
  rank: number;
  problem: { id: string; slug: string; title: string; difficulty: string; points: number };
  /** Ranking score: cosine similarity to the profile minus the difficulty penalty. */
  score: number;
  similarity: number;
  rationale: string;
  rationaleSource: RationaleSource;
  because: EvidenceItem[];
  sharedTerms: string[];
}

export interface RecommendationResult {
  userId: string;
  elo: number;
  coldStart: boolean;
  limit: number;
  recommendations: Recommendation[];
  meta: {
    indexSize: number;
    indexSource: 'database' | 'cache';
    indexBuildMs: number;
    queryMs: number;
    mmrLambda: number;
    historyEntries: number;
    llm: boolean;
  };
}

export interface RecommenderOptions {
  llm?: LlmConfig | null;
  fetchImpl?: typeof fetch;
  cache?: EmbeddingCache | null;
  /** How long a built index is reused before the corpus signature is re-checked (default 10 minutes). */
  indexTtlMs?: number;
  mmrLambda?: number;
  /** Candidates retrieved before diversification, as a multiple of `limit` (min 30). */
  poolFactor?: number;
  now?: () => Date;
}

const DEFAULT_ELO = 1200;

function signatureOf(headers: readonly ProblemHeader[]): string {
  const newest = headers.reduce((max, h) => Math.max(max, h.updatedAt.getTime()), 0);
  return `${headers.length}:${newest}`;
}

export class Recommender {
  private state: IndexState | null = null;
  private building: Promise<IndexState> | null = null;

  constructor(
    private readonly repo: RecommenderRepository,
    private readonly options: RecommenderOptions = {},
  ) {}

  invalidate(): void {
    this.state = null;
  }

  /** Build (or reuse) the embedded corpus. Concurrent callers share one build. */
  async ensureIndex(): Promise<IndexState> {
    const ttl = this.options.indexTtlMs ?? 10 * 60_000;
    if (this.state && Date.now() - this.state.builtAt < ttl) return this.state;
    this.building ??= this.build().finally(() => {
      this.building = null;
    });
    return this.building;
  }

  private async build(): Promise<IndexState> {
    const started = performance.now();
    const headers = await this.repo.loadProblemHeaders();
    const signature = signatureOf(headers);
    if (this.state && this.state.signature === signature) {
      this.state.builtAt = Date.now(); // corpus unchanged: just extend the TTL
      return this.state;
    }

    const index = new VectorIndex<ProblemMeta>();
    let source: IndexState['source'] = 'database';
    const cached = await this.options.cache?.get(signature).catch(() => null);
    if (cached && cached.items.length === headers.length) {
      const byId = new Map(cached.items.map((item) => [item.id, item]));
      for (const header of headers) {
        const hit = byId.get(header.id);
        if (!hit) continue;
        index.add({ id: header.id, vector: Float32Array.from(hit.vector), meta: { slug: header.slug, title: header.title, difficulty: header.difficulty, points: header.points, terms: hit.terms } });
      }
      source = 'cache';
    }
    if (index.size !== headers.length) {
      const bodies = new Map((await this.repo.loadProblemBodies()).map((b) => [b.id, b.descriptionMd]));
      const embedder = new Embedder().fit(headers.map((h) => ({ title: h.title, body: bodies.get(h.id) ?? '' })));
      const fresh = new VectorIndex<ProblemMeta>();
      const cacheItems: CachedEmbeddings['items'] = [];
      for (const header of headers) {
        const doc = embedder.embedDocument(header.id, header.title, bodies.get(header.id) ?? '');
        fresh.add({ id: header.id, vector: doc.vector, meta: { slug: header.slug, title: header.title, difficulty: header.difficulty, points: header.points, terms: doc.terms } });
        cacheItems.push({ id: header.id, vector: Array.from(doc.vector, (v) => Math.round(v * 1e5) / 1e5), terms: doc.terms });
      }
      void this.options.cache?.set(signature, { dim: embedder.dim, items: cacheItems }).catch(() => undefined);
      this.state = this.finish(fresh, signature, 'database', started);
      return this.state;
    }
    this.state = this.finish(index, signature, source, started);
    return this.state;
  }

  private finish(index: VectorIndex<ProblemMeta>, signature: string, source: IndexState['source'], started: number): IndexState {
    return {
      index,
      signature,
      builtAt: Date.now(),
      buildMs: performance.now() - started,
      source,
      titles: new Set(index.all().map((item) => item.meta.title)),
    };
  }

  async recommend(userId: string, { limit = 5 }: { limit?: number } = {}): Promise<RecommendationResult> {
    const state = await this.ensureIndex();
    const started = performance.now();
    const [user, history] = await Promise.all([this.repo.loadUser(userId), this.repo.loadHistory(userId)]);
    const elo = user?.elo ?? DEFAULT_ELO;
    const mmrLambda = this.options.mmrLambda ?? 0.7;
    const wanted = Math.max(1, Math.min(limit, 50));

    const vectors = new Map(state.index.all().map((item) => [item.id, item.vector] as const));
    const profile = buildProfile(history, vectors, { now: this.options.now?.() });
    const coldStart = profile.query === null;
    const query = profile.query ?? centroid(vectors.values());
    if (!query) return this.emptyResult(userId, elo, wanted, state, history.length, mmrLambda, started);

    const exclude = new Set([...profile.solved, ...profile.failed]);
    const pool = Math.max(30, wanted * (this.options.poolFactor ?? 6));
    const candidates = state.index.search(query, pool, exclude).map((hit) => ({
      item: hit,
      relevance: hit.score - difficultyPenalty(hit.meta.difficulty, elo),
    }));
    candidates.sort((a, b) => b.relevance - a.relevance);
    const selected = mmrSelect(candidates, wanted, mmrLambda);

    const evidence: RecommendationEvidence[] = selected.map(({ item }) => {
      const contributions = profile.evidence
        .slice(0, 12)
        .map((e) => {
          const source = state.index.get(e.problemId);
          const similarity = source ? dot(item.vector, source.vector) : 0;
          return { e, source, similarity, contribution: e.weight * Math.max(similarity, 0) };
        })
        .filter((c) => c.source && c.similarity > 0)
        .sort((a, b) => b.contribution - a.contribution)
        .slice(0, 3);
      const because: EvidenceItem[] = contributions.map((c) => ({
        problemId: c.e.problemId,
        title: c.source!.meta.title,
        outcome: c.e.outcome,
        wrongSubmissions: c.e.wrongSubmissions,
        similarity: Number(c.similarity.toFixed(3)),
      }));
      const supportTerms = new Set(contributions.flatMap((c) => c.source!.meta.terms));
      const shared = item.meta.terms.filter((term) => supportTerms.has(term));
      return {
        problemId: item.id,
        title: item.meta.title,
        difficulty: item.meta.difficulty,
        similarity: Number(dot(query, item.vector).toFixed(3)),
        because,
        sharedTerms: (shared.length > 0 ? shared : item.meta.terms).slice(0, 5),
        coldStart,
        elo,
      };
    });

    const rationales = await generateRationales(evidence, {
      llm: this.options.llm,
      corpusTitles: state.titles,
      fetchImpl: this.options.fetchImpl,
    });

    const recommendations: Recommendation[] = selected.map(({ item, relevance }, i) => {
      const ev = evidence[i]!;
      const rationale = rationales.get(item.id)!;
      return {
        rank: i + 1,
        problem: { id: item.id, slug: item.meta.slug, title: item.meta.title, difficulty: item.meta.difficulty, points: item.meta.points },
        score: Number(relevance.toFixed(4)),
        similarity: ev.similarity,
        rationale: rationale.text,
        rationaleSource: rationale.source,
        because: ev.because,
        sharedTerms: ev.sharedTerms,
      };
    });

    return {
      userId,
      elo,
      coldStart,
      limit: wanted,
      recommendations,
      meta: {
        indexSize: state.index.size,
        indexSource: state.source,
        indexBuildMs: Number(state.buildMs.toFixed(1)),
        queryMs: Number((performance.now() - started).toFixed(2)),
        mmrLambda,
        historyEntries: history.length,
        llm: Boolean(this.options.llm),
      },
    };
  }

  private emptyResult(userId: string, elo: number, limit: number, state: IndexState, historyEntries: number, mmrLambda: number, started: number): RecommendationResult {
    return {
      userId, elo, coldStart: true, limit, recommendations: [],
      meta: { indexSize: state.index.size, indexSource: state.source, indexBuildMs: Number(state.buildMs.toFixed(1)), queryMs: Number((performance.now() - started).toFixed(2)), mmrLambda, historyEntries, llm: Boolean(this.options.llm) },
    };
  }
}
