import { describe, expect, it } from 'vitest';
import { EMBEDDING_DIM, Embedder, dot } from './embedding';
import {
  VectorIndex,
  buildProfile,
  centroid,
  difficultyPenalty,
  entryWeight,
  mmrSelect,
  targetDifficulty,
  type HistoryEntry,
} from './retrieval';
import { generateRationales, llmConfigFromEnv, llmRationales, templateRationale, type RecommendationEvidence } from './rationale';
import { stem, tokenize } from './text';
import {
  Recommender,
  type CachedEmbeddings,
  type EmbeddingCache,
  type ProblemBody,
  type ProblemHeader,
  type RecommenderRepository,
} from './service';

// A small corpus with clearly separated topics.
const CORPUS = [
  { id: 'p1', title: 'Palindrome Checker', body: 'Given a string, determine whether the string is a palindrome. Characters are letters; ignore case. A palindrome reads the same backwards.' },
  { id: 'p2', title: 'Longest Palindrome Substring', body: 'Find the longest palindrome substring of the given string. A palindrome reads the same forwards and backwards.' },
  { id: 'p3', title: 'Shortest Path in a Graph', body: 'Given a graph with weighted edges and vertices, find the shortest path between two vertices using BFS or Dijkstra over the graph.' },
  { id: 'p4', title: 'Tree Diameter', body: 'A tree is a connected graph without cycles. Find the diameter of the tree: the longest path between two vertices of the tree.' },
  { id: 'p5', title: 'Prime Factorization', body: 'Find the prime factorization of a number. A prime number has exactly two divisors. Use trial division by primes.' },
  { id: 'p6', title: 'Greatest Common Divisor', body: 'Compute the greatest common divisor of two numbers using the Euclidean algorithm. The divisor divides both numbers.' },
  { id: 'p7', title: 'Coin Change Dynamic Programming', body: 'Use dynamic programming to compute the minimum number of coins needed to make the amount. Define dp over amounts.' },
  { id: 'p8', title: 'Sort the Array', body: 'Sort the array in non-decreasing order and print the sorted array. Sorting can be done with any comparison sort.' },
];

function fitted() {
  const embedder = new Embedder().fit(CORPUS);
  const vectors = new Map(CORPUS.map((d) => [d.id, embedder.embed(d.title, d.body)] as const));
  return { embedder, vectors };
}

describe('text processing', () => {
  it('strips math and markup and removes stop-words', () => {
    const tokens = tokenize('Given $a_i \\le 10^9$ and **a palindrome** string, print the answer. See https://example.com/x');
    expect(tokens).toContain('palindrome');
    expect(tokens).toContain('string');
    expect(tokens).not.toContain('le');
    expect(tokens).not.toContain('given');
    expect(tokens.join(' ')).not.toContain('example');
  });

  it('merges simple inflections', () => {
    expect(stem('palindromes')).toBe(stem('palindrome'));
    expect(stem('queries')).toBe('query');
    expect(stem('sorted')).toBe('sort');
    expect(stem('ass')).toBe('ass');
    expect(stem('string')).toBe('string'); // a real topic word must survive stemming
    expect(stem('sorting')).toBe('sort');
  });
});

describe('embedding', () => {
  it('is deterministic and unit length with 384 dimensions', () => {
    const a = new Embedder().fit(CORPUS).embed(CORPUS[0]!.title, CORPUS[0]!.body);
    const b = new Embedder().fit(CORPUS).embed(CORPUS[0]!.title, CORPUS[0]!.body);
    expect(a.length).toBe(EMBEDDING_DIM);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Math.sqrt(dot(a, a))).toBeCloseTo(1, 6);
  });

  it('puts topically similar problems closer than unrelated ones', () => {
    const { vectors } = fitted();
    const v = (id: string) => vectors.get(id)!;
    expect(dot(v('p1'), v('p2'))).toBeGreaterThan(dot(v('p1'), v('p3')));
    expect(dot(v('p3'), v('p4'))).toBeGreaterThan(dot(v('p3'), v('p5')));
    expect(dot(v('p5'), v('p6'))).toBeGreaterThan(dot(v('p5'), v('p7')));
  });

  it('weights rare topical words above ubiquitous ones (idf)', () => {
    const docs = [
      { title: 'A', body: 'array palindrome' },
      { title: 'B', body: 'array sum' },
      { title: 'C', body: 'array product' },
      { title: 'D', body: 'array count' },
    ];
    const embedder = new Embedder().fit(docs);
    // Same term frequency in document A, so only the idf differs: the rare word must rank first.
    const terms = embedder.topTerms('A', 'array palindrome');
    expect(terms.indexOf('palindrome')).toBeLessThan(terms.indexOf('array'));
  });

  it('gives an empty text a zero vector without NaNs', () => {
    const vector = new Embedder().embed('', '');
    expect(Array.from(vector).every((x) => x === 0)).toBe(true);
  });
});

describe('index, cosine and MMR', () => {
  it('returns hits sorted by cosine and honours exclusions', () => {
    const { vectors } = fitted();
    const index = new VectorIndex<{ title: string }>();
    for (const doc of CORPUS) index.add({ id: doc.id, vector: vectors.get(doc.id)!, meta: { title: doc.title } });
    const hits = index.search(vectors.get('p1')!, 3);
    expect(hits[0]!.id).toBe('p1');
    expect(hits[1]!.id).toBe('p2');
    expect(hits.map((h) => h.score)).toEqual([...hits.map((h) => h.score)].sort((a, b) => b - a));
    expect(index.search(vectors.get('p1')!, 3, new Set(['p1']))[0]!.id).toBe('p2');
  });

  it('MMR trades a little relevance for diversity', () => {
    // a and b are near-duplicates; c is different and only slightly less relevant.
    const item = (id: string, vector: number[]) => ({ id, vector: Float32Array.from(vector), meta: {} });
    const a = item('a', [1, 0]);
    const b = item('b', [0.999, 0.045]);
    const c = item('c', [0.6, 0.8]);
    const candidates = [
      { item: a, relevance: 0.95 },
      { item: b, relevance: 0.94 },
      { item: c, relevance: 0.8 },
    ];
    expect(mmrSelect(candidates, 2, 1).map((s) => s.item.id)).toEqual(['a', 'b']); // pure relevance
    expect(mmrSelect(candidates, 2, 0.5).map((s) => s.item.id)).toEqual(['a', 'c']); // diversified
  });
});

describe('user profile', () => {
  const now = new Date('2026-01-01T00:00:00Z');

  it('weights failed > solved-after-struggle > clean solve', () => {
    const failed = entryWeight({ problemId: 'x', outcome: 'failed', wrongSubmissions: 3 });
    const struggled = entryWeight({ problemId: 'x', outcome: 'solved', wrongSubmissions: 3 });
    const clean = entryWeight({ problemId: 'x', outcome: 'solved', wrongSubmissions: 0 });
    expect(failed).toBeGreaterThan(struggled);
    expect(struggled).toBeGreaterThan(clean);
    expect(entryWeight({ problemId: 'x', outcome: 'failed', wrongSubmissions: 9 })).toBe(entryWeight({ problemId: 'x', outcome: 'failed', wrongSubmissions: 6 })); // capped
  });

  it('halves an entry\'s weight every half-life', () => {
    const fresh = entryWeight({ problemId: 'x', outcome: 'failed', wrongSubmissions: 1, lastActivityAt: now }, { now, halfLifeDays: 30 });
    const old = entryWeight({ problemId: 'x', outcome: 'failed', wrongSubmissions: 1, lastActivityAt: new Date(now.getTime() - 30 * 86_400_000) }, { now, halfLifeDays: 30 });
    expect(old / fresh).toBeCloseTo(0.5, 6);
  });

  it('builds a profile that points toward what the user failed, and excludes solved problems', () => {
    const { vectors } = fitted();
    const history: HistoryEntry[] = [
      { problemId: 'p3', outcome: 'failed', wrongSubmissions: 4 },
      { problemId: 'p1', outcome: 'solved', wrongSubmissions: 0 },
    ];
    const profile = buildProfile(history, vectors);
    expect(profile.solved).toEqual(new Set(['p1']));
    expect(profile.failed).toEqual(new Set(['p3']));
    expect(profile.evidence[0]!.problemId).toBe('p3'); // strongest signal first
    const toFailed = dot(profile.query!, vectors.get('p3')!);
    const toSolved = dot(profile.query!, vectors.get('p1')!);
    expect(toFailed).toBeGreaterThan(toSolved);
    expect(Math.sqrt(dot(profile.query!, profile.query!))).toBeCloseTo(1, 6);
  });

  it('has no query for a cold-start user; the corpus centroid is a usable fallback', () => {
    const { vectors } = fitted();
    expect(buildProfile([], vectors).query).toBeNull();
    expect(centroid(vectors.values())).not.toBeNull();
  });

  it('ELO-based difficulty penalty is soft and irrelevant when every problem is EASY', () => {
    expect(targetDifficulty(900)).toBe(0);
    expect(targetDifficulty(1400)).toBeCloseTo(1, 6);
    expect(targetDifficulty(3000)).toBe(2);
    expect(difficultyPenalty('EASY', 1200)).toBe(difficultyPenalty('EASY', 1200));
    expect(difficultyPenalty('HARD', 900)).toBeGreaterThan(difficultyPenalty('EASY', 900));
    expect(difficultyPenalty('EASY', 2000)).toBeGreaterThan(difficultyPenalty('HARD', 2000));
  });
});

describe('rationale', () => {
  const evidence: RecommendationEvidence = {
    problemId: 'p4',
    title: 'Tree Diameter',
    difficulty: 'EASY',
    similarity: 0.61,
    because: [
      { problemId: 'p3', title: 'Shortest Path in a Graph', outcome: 'failed', wrongSubmissions: 3, similarity: 0.5 },
      { problemId: 'p1', title: 'Palindrome Checker', outcome: 'solved', wrongSubmissions: 0, similarity: 0.1 },
    ],
    sharedTerms: ['graph', 'path', 'vertex'],
    coldStart: false,
    elo: 1200,
  };

  it('template cites exactly the evidence: titles, wrong-submission counts, shared terms', () => {
    const text = templateRationale(evidence);
    expect(text).toContain('"Shortest Path in a Graph"');
    expect(text).toContain('3 wrong submissions');
    expect(text).toContain('"Palindrome Checker"');
    expect(text).toContain('graph, path, vertex');
    expect(text).toContain('"Tree Diameter"');
    expect(text).not.toContain('Prime Factorization');
  });

  it('cold-start template does not claim a history', () => {
    const text = templateRationale({ ...evidence, because: [], coldStart: true });
    expect(text).toContain('Starter pick');
    expect(text).not.toContain('Recommended because');
  });

  it('reads configuration from the environment and needs both URL and key', () => {
    expect(llmConfigFromEnv({})).toBeNull();
    expect(llmConfigFromEnv({ RECOMMENDER_LLM_URL: 'https://x/v1' })).toBeNull();
    const config = llmConfigFromEnv({ RECOMMENDER_LLM_URL: 'https://x/v1/', RECOMMENDER_LLM_API_KEY: 'k' });
    expect(config?.url).toBe('https://x/v1/chat/completions');
    expect(config?.model).toBe('gpt-4o-mini');
  });

  const config = { url: 'https://llm.test/v1/chat/completions', apiKey: 'k', model: 'm', timeoutMs: 500 };
  const titles = new Set(CORPUS.map((d) => d.title));
  const reply = (content: unknown, ok = true) =>
    (async () => ({ ok, json: async () => ({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }) })) as unknown as typeof fetch;

  it('accepts a grounded LLM explanation', async () => {
    const accepted = await llmRationales([evidence], titles, config, reply({ p4: 'You struggled with graph paths, and trees are graphs.' }));
    expect(accepted.get('p4')).toContain('graph paths');
  });

  it('rejects an explanation that mentions a problem outside the evidence', async () => {
    const accepted = await llmRationales([evidence], titles, config, reply({ p4: 'Try "Prime Factorization" next, it is related.' }));
    expect(accepted.size).toBe(0);
  });

  it('ignores ids it was not asked about and invalid payloads, and never throws', async () => {
    expect((await llmRationales([evidence], titles, config, reply({ zzz: 'invented' }))).size).toBe(0);
    expect((await llmRationales([evidence], titles, config, reply('not json'))).size).toBe(0);
    expect((await llmRationales([evidence], titles, config, reply({}, false))).size).toBe(0);
    const boom = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    expect((await llmRationales([evidence], titles, config, boom)).size).toBe(0);
  });

  it('falls back to the template for anything the LLM did not cover', async () => {
    const second: RecommendationEvidence = { ...evidence, problemId: 'p5', title: 'Prime Factorization' };
    const out = await generateRationales([evidence, second], { llm: config, corpusTitles: titles, fetchImpl: reply({ p4: 'Grounded explanation.' }) });
    expect(out.get('p4')).toEqual({ text: 'Grounded explanation.', source: 'llm' });
    expect(out.get('p5')!.source).toBe('template');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Service with an in-memory repository
// ---------------------------------------------------------------------------------------------------------------

function fakeRepository(history: HistoryEntry[] = [], counters = { bodies: 0, headers: 0 }): RecommenderRepository {
  const updatedAt = new Date('2026-01-01T00:00:00Z');
  const headers: ProblemHeader[] = CORPUS.map((d) => ({ id: d.id, slug: `cf-${d.id}`, title: d.title, difficulty: 'EASY', points: 100, updatedAt }));
  return {
    async loadProblemHeaders() { counters.headers += 1; return headers; },
    async loadProblemBodies(): Promise<ProblemBody[]> { counters.bodies += 1; return CORPUS.map((d) => ({ id: d.id, descriptionMd: d.body })); },
    async loadUser() { return { elo: 1250 }; },
    async loadHistory() { return history; },
  };
}

describe('Recommender service', () => {
  it('recommends unsolved problems related to what the user failed, with grounded rationales', async () => {
    const recommender = new Recommender(fakeRepository([
      { problemId: 'p3', outcome: 'failed', wrongSubmissions: 4 },
      { problemId: 'p1', outcome: 'solved', wrongSubmissions: 0 },
    ]));
    const result = await recommender.recommend('u1', { limit: 3 });
    const ids = result.recommendations.map((r) => r.problem.id);
    expect(result.coldStart).toBe(false);
    expect(ids).toHaveLength(3);
    expect(ids).not.toContain('p1'); // solved
    expect(ids).not.toContain('p3'); // attempted, not re-recommended
    expect(ids[0]).toBe('p4'); // the other graph problem is the nearest unsolved neighbour
    const top = result.recommendations[0]!;
    expect(top.rationaleSource).toBe('template');
    expect(top.rationale).toContain('Shortest Path in a Graph');
    expect(top.rationale).toContain('4 wrong submissions');
    expect(top.because[0]!.problemId).toBe('p3');
    expect(result.meta.indexSize).toBe(CORPUS.length);
  });

  it('serves a cold-start user diversified starter picks', async () => {
    const result = await new Recommender(fakeRepository([])).recommend('new-user', { limit: 4 });
    expect(result.coldStart).toBe(true);
    expect(result.recommendations).toHaveLength(4);
    expect(new Set(result.recommendations.map((r) => r.problem.id)).size).toBe(4);
    expect(result.recommendations[0]!.rationale).toContain('Starter pick');
  });

  it('builds the index once even for concurrent callers', async () => {
    const counters = { bodies: 0, headers: 0 };
    const recommender = new Recommender(fakeRepository([], counters));
    await Promise.all([recommender.recommend('a'), recommender.recommend('b'), recommender.recommend('c')]);
    expect(counters.bodies).toBe(1);
  });

  it('uses and fills the embedding cache', async () => {
    const stored = new Map<string, CachedEmbeddings>();
    const cache: EmbeddingCache = {
      async get(signature) { return stored.get(signature) ?? null; },
      async set(signature, value) { stored.set(signature, value); },
    };
    const firstCounters = { bodies: 0, headers: 0 };
    const first = await new Recommender(fakeRepository([], firstCounters), { cache }).recommend('u', { limit: 3 });
    expect(first.meta.indexSource).toBe('database');
    expect(firstCounters.bodies).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 5)); // the cache write is fire-and-forget
    expect(stored.size).toBe(1);

    const secondCounters = { bodies: 0, headers: 0 };
    const second = await new Recommender(fakeRepository([], secondCounters), { cache }).recommend('u', { limit: 3 });
    expect(second.meta.indexSource).toBe('cache');
    expect(secondCounters.bodies).toBe(0); // no statement text was loaded
    expect(second.recommendations.map((r) => r.problem.id)).toEqual(first.recommendations.map((r) => r.problem.id));
  });

  it('uses the LLM only to explain retrieved problems, and falls back when it invents one', async () => {
    const history: HistoryEntry[] = [{ problemId: 'p3', outcome: 'failed', wrongSubmissions: 2 }];
    const llm = { url: 'https://llm.test/chat/completions', apiKey: 'k', model: 'm', timeoutMs: 500 };
    let askedFor: string[] = [];
    const goodFetch = (async (_url: string, init: { body: string }) => {
      const sent = JSON.parse(init.body) as { messages: Array<{ content: string }> };
      const ids = (JSON.parse(sent.messages[1]!.content) as { recommendations: Array<{ problemId: string }> }).recommendations.map((r) => r.problemId);
      askedFor = ids;
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(Object.fromEntries(ids.map((id) => [id, `LLM says why ${id}.`]))) } }] }) };
    }) as unknown as typeof fetch;
    const viaLlm = await new Recommender(fakeRepository(history), { llm, fetchImpl: goodFetch }).recommend('u', { limit: 2 });
    expect(askedFor).toEqual(viaLlm.recommendations.map((r) => r.problem.id)); // only retrieved ids were sent
    expect(viaLlm.recommendations.every((r) => r.rationaleSource === 'llm')).toBe(true);
    expect(viaLlm.meta.llm).toBe(true);

    const inventing = (async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ p4: 'Also try "Coin Change Dynamic Programming".' }) } }] }) })) as unknown as typeof fetch;
    const guarded = await new Recommender(fakeRepository(history), { llm, fetchImpl: inventing }).recommend('u', { limit: 2 });
    expect(guarded.recommendations.every((r) => r.rationaleSource === 'template')).toBe(true);
  });
});
