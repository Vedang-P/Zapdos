/**
 * Problem recommender - see docs/recommender.md.
 *
 *   embedding.ts   deterministic 384-d hashed TF-IDF embeddings
 *   retrieval.ts   cosine index, MMR diversification, user profile
 *   rationale.ts   grounded explanations (template, optional LLM)
 *   service.ts     the pipeline
 */

import { cacheFromEnv } from './cache';
import { llmConfigFromEnv } from './rationale';
import { prismaRepository } from './repository';
import { Recommender } from './service';

export * from './embedding';
export * from './retrieval';
export * from './rationale';
export { Recommender } from './service';
export type { RecommendationResult, Recommendation, RecommenderRepository } from './service';

const globalForRecommender = globalThis as unknown as { __zapdosRecommender?: Recommender };

/** Process-wide recommender (survives Next.js dev hot reloads); the index is built lazily on first use. */
export function getRecommender(): Recommender {
  globalForRecommender.__zapdosRecommender ??= new Recommender(prismaRepository, {
    llm: llmConfigFromEnv(),
    cache: cacheFromEnv(),
  });
  return globalForRecommender.__zapdosRecommender;
}
