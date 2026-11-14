/**
 * Offline evaluation of the problem recommender on the real, imported corpus.
 *
 *   pnpm --filter web eval:recommender
 *
 * Needs the problems in Postgres (`pnpm import-codeforces`) and the downloaded Codeforces JSON for the tags
 * (CF_PROBLEMS_PATH, default /tmp/cf_problems.json). Tags are NEVER fed to the embedder - they are only the answer key:
 * a neighbour counts as relevant when it shares at least one tag with the query problem.
 *
 * Reports precision@5 against an exact random baseline (the expected precision of picking 5 problems uniformly at
 * random), a stricter variant that ignores the three most common tags, the diversity cost of MMR, index build time,
 * and the latency of the full recommend() pipeline.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '@zapdos/db';
import { dot } from '../lib/recommender/embedding';
import { mmrSelect } from '../lib/recommender/retrieval';
import { prismaRepository } from '../lib/recommender/repository';
import { Recommender, type RecommenderRepository } from '../lib/recommender/service';

const here = path.dirname(fileURLToPath(import.meta.url));
const TAGS_PATH = process.env.CF_PROBLEMS_PATH ?? '/tmp/cf_problems.json';
const K = 5;
const QUERIES = Number(process.env.EVAL_QUERIES ?? 1000);

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}
const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

/** Small deterministic PRNG so the synthetic users are the same on every run. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  const tagsBySlug = new Map<string, Set<string>>();
  for (const row of JSON.parse(readFileSync(TAGS_PATH, 'utf-8')) as Array<{ contest_id: string | number; index: string; tags: string[] }>) {
    tagsBySlug.set(`cf-${row.contest_id}-${row.index}`, new Set(row.tags));
  }

  // --- index build time (database read + embedding), median of 5 cold builds -------------------------------------
  const buildTimes: number[] = [];
  let recommender = new Recommender(prismaRepository);
  for (let i = 0; i < 5; i++) {
    recommender = new Recommender(prismaRepository);
    buildTimes.push((await recommender.ensureIndex()).buildMs);
  }
  buildTimes.sort((a, b) => a - b);
  const state = await recommender.ensureIndex();
  const items = state.index.all();
  const n = items.length;

  // --- tag statistics --------------------------------------------------------------------------------------------
  const tagCounts = new Map<string, number>();
  const tagsOf = (slug: string) => tagsBySlug.get(slug) ?? new Set<string>();
  for (const item of items) for (const tag of tagsOf(item.meta.slug)) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  const generic = new Set([...tagCounts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([tag]) => tag));
  const withTags = items.filter((item) => tagsOf(item.meta.slug).size > 0);

  const shares = (a: Set<string>, b: Set<string>, ignore?: Set<string>) => {
    for (const tag of a) if (b.has(tag) && !(ignore?.has(tag))) return true;
    return false;
  };
  const jaccard = (a: Set<string>, b: Set<string>) => {
    let inter = 0;
    for (const tag of a) if (b.has(tag)) inter++;
    const union = a.size + b.size - inter;
    return union === 0 ? 0 : inter / union;
  };

  // --- precision@5 vs exact random baseline ----------------------------------------------------------------------
  let hits = 0, strictHits = 0, strictQueries = 0, jac = 0;
  let baseline = 0, strictBaseline = 0, baselineJac = 0;
  let mmrHits = 0, mmrStrict = 0, intraPure = 0, intraMmr = 0;
  for (const query of withTags) {
    const qTags = tagsOf(query.meta.slug);
    const neighbours = state.index.search(query.vector, K, new Set([query.id]));
    const hasStrict = [...qTags].some((tag) => !generic.has(tag));
    if (hasStrict) strictQueries++;
    for (const nb of neighbours) {
      const nTags = tagsOf(nb.meta.slug);
      if (shares(qTags, nTags)) hits++;
      if (hasStrict && shares(qTags, nTags, generic)) strictHits++;
      jac += jaccard(qTags, nTags);
    }
    // exact expectation for a uniformly random other problem
    let randomShare = 0, randomStrict = 0, randomJac = 0, others = 0;
    for (const other of withTags) {
      if (other.id === query.id) continue;
      const oTags = tagsOf(other.meta.slug);
      others++;
      if (shares(qTags, oTags)) randomShare++;
      if (hasStrict && shares(qTags, oTags, generic)) randomStrict++;
      randomJac += jaccard(qTags, oTags);
    }
    baseline += (randomShare / others) * K;
    strictBaseline += hasStrict ? (randomStrict / others) * K : 0;
    baselineJac += (randomJac / others) * K;

    // MMR (lambda 0.7) over a pool of 30 versus the pure top-5
    const pool = state.index.search(query.vector, 30, new Set([query.id])).map((hit) => ({ item: hit, relevance: hit.score }));
    const picked = mmrSelect(pool, K, 0.7);
    for (const p of picked) if (shares(qTags, tagsOf(p.item.meta.slug))) mmrHits++;
    for (const p of picked) if (hasStrict && shares(qTags, tagsOf(p.item.meta.slug), generic)) mmrStrict++;
    const intra = (list: Float32Array[]) => {
      let sum = 0, pairs = 0;
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) { sum += dot(list[i]!, list[j]!); pairs++; }
      return pairs ? sum / pairs : 0;
    };
    intraPure += intra(neighbours.map((h) => h.vector));
    intraMmr += intra(picked.map((p) => p.item.vector));
  }
  const q = withTags.length;
  const precision = hits / (q * K);
  const randomPrecision = baseline / (q * K);
  const strictPrecision = strictHits / (strictQueries * K);
  const strictRandom = strictBaseline / (strictQueries * K);

  // --- full recommend() latency over synthetic users -------------------------------------------------------------
  const rand = mulberry32(7);
  const headers = await prismaRepository.loadProblemHeaders();
  const bodies = await prismaRepository.loadProblemBodies();
  let currentHistory: Awaited<ReturnType<RecommenderRepository['loadHistory']>> = [];
  const memoryRepo: RecommenderRepository = {
    loadProblemHeaders: async () => headers,
    loadProblemBodies: async () => bodies,
    loadUser: async () => ({ elo: 1000 + Math.floor(rand() * 600) }),
    loadHistory: async () => currentHistory,
  };
  const timed = new Recommender(memoryRepo);
  await timed.ensureIndex();
  const latencies: number[] = [];
  for (let i = 0; i < QUERIES; i++) {
    const size = 1 + Math.floor(rand() * 6);
    currentHistory = Array.from({ length: size }, () => {
      const problem = headers[Math.floor(rand() * headers.length)]!;
      const solved = rand() < 0.4;
      return { problemId: problem.id, outcome: solved ? 'solved' as const : 'failed' as const, wrongSubmissions: Math.floor(rand() * 5), lastActivityAt: new Date(Date.now() - Math.floor(rand() * 60) * 86_400_000) };
    });
    const result = await timed.recommend(`synthetic-${i}`, { limit: 5 });
    latencies.push(result.meta.queryMs);
  }
  latencies.sort((a, b) => a - b);

  const report = {
    generated_at: new Date().toISOString(),
    corpus: {
      problems: n,
      problems_with_tags: q,
      distinct_tags: tagCounts.size,
      most_common_tags: [...tagCounts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([tag, count]) => ({ tag, count })),
      generic_tags_ignored_in_strict_metric: [...generic],
    },
    embedding: { dim: 384, kind: 'signed feature hashing of TF-IDF unigrams+bigrams (lexical)', tags_used_as_input: false },
    index_build_ms: { median: round(buildTimes[2]!, 1), min: round(buildTimes[0]!, 1), max: round(buildTimes[4]!, 1), includes: 'Postgres read of all statements + fit IDF + embed every problem' },
    retrieval_quality: {
      k: K,
      precision_at_5_shares_any_tag: { recommender: round(precision), random_baseline: round(randomPrecision), lift: round(precision / randomPrecision, 3) },
      precision_at_5_shares_specific_tag: { recommender: round(strictPrecision), random_baseline: round(strictRandom), lift: round(strictPrecision / strictRandom, 3), queries: strictQueries },
      mean_tag_jaccard_of_top5: { recommender: round(jac / (q * K)), random_baseline: round(baselineJac / (q * K)) },
      mmr_lambda_0_7: {
        precision_at_5_shares_any_tag: round(mmrHits / (q * K)),
        precision_at_5_shares_specific_tag: round(mmrStrict / (strictQueries * K)),
        mean_intra_list_similarity: { pure_top5: round(intraPure / q), mmr: round(intraMmr / q), note: 'lower = more diverse' },
      },
    },
    recommend_latency_ms: {
      queries: QUERIES,
      scope: 'full recommend() pipeline (profile + cosine search over the corpus + MMR + evidence + template rationale), in-memory repository, index already built',
      p50: round(percentile(latencies, 50), 3),
      p95: round(percentile(latencies, 95), 3),
      p99: round(percentile(latencies, 99), 3),
      max: round(latencies[latencies.length - 1]!, 3),
    },
  };

  const outDir = path.join(here, 'results');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'recommender-eval.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await db.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect().catch(() => undefined);
  process.exit(1);
});
