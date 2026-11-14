/**
 * Optional Redis cache for the embedded corpus.
 *
 * Embedding ~250 statements costs tens of milliseconds and needs every problem's full markdown out of Postgres;
 * with the cache a cold serverless instance only reads the small problem headers and the cached vectors.
 * Enabled with RECOMMENDER_REDIS_CACHE=1 (uses REDIS_URL). Every failure degrades to "no cache".
 */

import type { CachedEmbeddings, EmbeddingCache } from './service';

const KEY_PREFIX = 'zapdos:recommender:embeddings:v1:';

export class RedisEmbeddingCache implements EmbeddingCache {
  private client: { get(key: string): Promise<string | null>; set(...args: unknown[]): Promise<unknown>; connect(): Promise<void> } | null = null;

  constructor(
    private readonly url: string,
    private readonly ttlSeconds = 3600,
  ) {}

  private async redis() {
    if (!this.client) {
      const ioredis = await import('ioredis');
      const Redis = (ioredis as unknown as { default: new (url: string, options: object) => NonNullable<RedisEmbeddingCache['client']> & { on(event: string, handler: () => void): void } }).default;
      const client = new Redis(this.url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 1500, enableOfflineQueue: false });
      client.on('error', () => undefined);
      await client.connect();
      this.client = client;
    }
    return this.client;
  }

  async get(signature: string): Promise<CachedEmbeddings | null> {
    try {
      const raw = await (await this.redis()).get(KEY_PREFIX + signature);
      return raw ? (JSON.parse(raw) as CachedEmbeddings) : null;
    } catch {
      return null;
    }
  }

  async set(signature: string, value: CachedEmbeddings): Promise<void> {
    try {
      await (await this.redis()).set(KEY_PREFIX + signature, JSON.stringify(value), 'EX', this.ttlSeconds);
    } catch {
      // cache is best-effort
    }
  }
}

export function cacheFromEnv(env: Record<string, string | undefined> = process.env): EmbeddingCache | null {
  return env.RECOMMENDER_REDIS_CACHE === '1' && env.REDIS_URL ? new RedisEmbeddingCache(env.REDIS_URL) : null;
}
