/**
 * Deterministic local embeddings: signed feature hashing of TF-IDF weighted unigrams + bigrams, 384-d, L2-normalised.
 *
 * Why not a neural model? The corpus is ~250 short, keyword-rich statements, the recommender must run inside a
 * serverless function with no model download and no network, and results must be reproducible. Feature hashing
 * ("the hashing trick") maps an unbounded vocabulary into a fixed 384-dim vector: each feature is assigned a bucket
 * and a +/-1 sign by hashing, so unrelated collisions cancel in expectation. TF-IDF weighting makes rare topical
 * words ("palindrome", "bipartite") dominate common ones ("array", "sum"). The vectors are lexical, not semantic -
 * see docs/recommender.md for the limits.
 */

import { extractFeatures } from './text';

export const EMBEDDING_DIM = 384;

/**
 * Bigrams (`foo_bar`) contribute at a fraction of a unigram's weight. At full weight they are sparse noise in ~250
 * short statements: on the offline evaluation (docs/recommender.md) down-weighting them to 0.15 raised precision@5 on
 * specific topical tags from 0.134 to 0.178 while leaving the any-tag score unchanged.
 */
const BIGRAM_WEIGHT = 0.15;

/** 32-bit FNV-1a hash. */
export function fnv1a(input: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function l2Normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i]! * vector[i]!;
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let i = 0; i < vector.length; i++) vector[i] = vector[i]! / norm;
  return vector;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let total = 0;
  for (let i = 0; i < a.length; i++) total += a[i]! * b[i]!;
  return total;
}

export interface EmbeddedDocument {
  id: string;
  vector: Float32Array;
  /** The most characteristic unigram terms, used to explain matches. */
  terms: string[];
}

export class Embedder {
  private readonly idf = new Map<string, number>();
  private fallbackIdf = 1;
  private fitted = false;

  constructor(readonly dim: number = EMBEDDING_DIM) {}

  /** Learn inverse document frequencies from the whole corpus: idf = ln((N + 1) / (df + 1)) + 1. */
  fit(documents: Array<{ title: string; body: string }>): this {
    const documentFrequency = new Map<string, number>();
    for (const doc of documents) {
      for (const feature of extractFeatures(doc.title, doc.body).keys()) {
        documentFrequency.set(feature, (documentFrequency.get(feature) ?? 0) + 1);
      }
    }
    const n = documents.length;
    this.idf.clear();
    for (const [feature, df] of documentFrequency) this.idf.set(feature, Math.log((n + 1) / (df + 1)) + 1);
    this.fallbackIdf = Math.log(n + 1) + 1; // a feature never seen in the corpus is maximally rare
    this.fitted = true;
    return this;
  }

  private weight(feature: string, count: number): number {
    const idf = this.fitted ? (this.idf.get(feature) ?? this.fallbackIdf) : 1;
    return (1 + Math.log(count)) * idf * (feature.includes('_') ? BIGRAM_WEIGHT : 1); // sublinear term frequency x idf
  }

  embedFeatures(features: Map<string, number>): Float32Array {
    const vector = new Float32Array(this.dim);
    for (const [feature, count] of features) {
      const bucket = fnv1a(feature) % this.dim;
      const sign = (fnv1a(feature, 0x9e3779b9) & 1) === 0 ? 1 : -1;
      vector[bucket] = vector[bucket]! + sign * this.weight(feature, count);
    }
    return l2Normalize(vector);
  }

  embed(title: string, body: string): Float32Array {
    return this.embedFeatures(extractFeatures(title, body));
  }

  /** Highest TF-IDF unigrams (bigrams are skipped: they read badly in explanations). */
  topTerms(title: string, body: string, limit = 24): string[] {
    const features = extractFeatures(title, body);
    return [...features]
      .filter(([feature]) => !feature.includes('_'))
      .map(([feature, count]) => [feature, this.weight(feature, count)] as const)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([feature]) => feature);
  }

  embedDocument(id: string, title: string, body: string): EmbeddedDocument {
    return { id, vector: this.embed(title, body), terms: this.topTerms(title, body) };
  }
}
