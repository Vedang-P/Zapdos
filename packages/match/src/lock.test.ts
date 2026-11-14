/**
 * Lock-safe concurrent pairing, against the REAL Redis (docker compose up -d redis).
 *
 * Six workers race to pair 200 queued players through the production code path (`findPair` + `dequeue` under
 * `acquireLock` / `releaseLock`).  Skipped when Redis is unreachable, when REDIS_URL is not a local host, or when the
 * real matchmaking keys already hold data (so a running dev matchmaker is never disturbed).
 */
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { matchmakingWindow } from './config';
import { acquireLock, LOCK_TTL_MS, releaseLock, type LockRedis } from './lock';
import { dequeue, enqueue, findPair, QUEUE_KEY, QUEUE_LOCK_KEY, queueSize, type RedisLike } from './queue';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://:zapdos_redis_pass@localhost:6379';
const isLocal = /@(localhost|127\.0\.0\.1)(:|\/|$)|^redis:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(REDIS_URL);
const META_PREFIX = 'zapdos:matchmaking:meta:';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let redis: Redis | null = null;
let skipReason = '';

async function connect(): Promise<void> {
  if (!isLocal) { skipReason = 'REDIS_URL is not a local host'; return; }
  const client = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null, connectTimeout: 1500 });
  client.on('error', () => { /* reported through skipReason */ });
  try {
    await client.connect();
    await client.ping();
    if ((await client.zcard(QUEUE_KEY)) > 0 || (await client.exists(QUEUE_LOCK_KEY)) > 0) {
      skipReason = 'the real matchmaking keys are in use';
      client.disconnect();
      return;
    }
    redis = client;
  } catch {
    skipReason = 'Redis is not reachable';
    client.disconnect();
  }
}

await connect();

interface Pair { a: string; b: string; nowMs: number; worker: number }

describe.skipIf(!redis)(`distributed lock and concurrent pairing (real Redis)${skipReason ? ` [skipped: ${skipReason}]` : ''}`, () => {
  const run = Date.now().toString(36);
  const compat = (): RedisLike => redis as unknown as RedisLike;
  const lockClient = (): LockRedis => redis as unknown as LockRedis;
  const created: string[] = [];

  async function seedQueue(count: number, seed: number): Promise<Map<string, { elo: number; joinedAtMs: number }>> {
    const random = mulberry32(seed);
    const players = new Map<string, { elo: number; joinedAtMs: number }>();
    const joinedAtMs = Date.now() - 120_000; // waited 2 minutes: the ELO window has widened to its 250 cap
    for (let i = 0; i < count; i += 1) {
      const userId = `lt-${run}-${seed}-${i}`;
      const elo = 1000 + Math.floor(random() * 600);
      players.set(userId, { elo, joinedAtMs });
      created.push(userId);
      await enqueue(compat(), { userId, elo, joinedAtMs, mode: 'SPRINT' });
    }
    return players;
  }

  async function clean(): Promise<void> {
    const client = redis as Redis;
    await client.del(QUEUE_KEY, QUEUE_LOCK_KEY, ...created.map((id) => `${META_PREFIX}${id}`));
  }

  beforeAll(clean);
  afterAll(async () => {
    await clean();
    redis?.disconnect();
  });

  it('six workers pair 200 players: nobody is paired twice, windows are respected, the lock is never shared', async () => {
    const players = await seedQueue(200, 1);
    const pairs: Pair[] = [];
    let holders = 0;
    let maxHolders = 0;
    let lockMisses = 0;
    let finished = false;

    async function worker(id: number): Promise<void> {
      while (!finished) {
        const token = await acquireLock(lockClient(), { ttlMs: 5000 });
        if (!token) {
          lockMisses += 1;
          await sleep(1 + Math.random() * 3);
          continue;
        }
        holders += 1;
        maxHolders = Math.max(maxHolders, holders);
        try {
          const nowMs = Date.now();
          const pair = await findPair(compat(), nowMs);
          if (!pair) {
            finished = true;
          } else {
            await Promise.all([dequeue(compat(), pair[0]), dequeue(compat(), pair[1])]);
            pairs.push({ a: pair[0], b: pair[1], nowMs, worker: id });
          }
        } finally {
          holders -= 1;
          await releaseLock(lockClient(), token);
        }
      }
    }

    const started = performance.now();
    await Promise.all([0, 1, 2, 3, 4, 5].map(worker));
    const seconds = (performance.now() - started) / 1000;
    console.log(`[lock test] ${pairs.length} pairs by 6 workers in ${seconds.toFixed(2)}s = ${(pairs.length / seconds).toFixed(1)} pairs/s, ` +
      `${lockMisses} failed acquisitions, workers that paired: ${new Set(pairs.map((p) => p.worker)).size}`);

    const everyone = pairs.flatMap((pair) => [pair.a, pair.b]);
    expect(new Set(everyone).size).toBe(everyone.length); // nobody paired twice
    expect(everyone.length).toBe(200); // nobody lost, nobody left over
    expect(await queueSize(compat())).toBe(0);
    expect(maxHolders).toBe(1); // mutual exclusion held for every critical section

    for (const pair of pairs) {
      const a = players.get(pair.a) as { elo: number; joinedAtMs: number };
      const b = players.get(pair.b) as { elo: number; joinedAtMs: number };
      const gap = Math.abs(a.elo - b.elo);
      expect(gap).toBeLessThanOrEqual(matchmakingWindow((pair.nowMs - a.joinedAtMs) / 1000));
      expect(gap).toBeLessThanOrEqual(matchmakingWindow((pair.nowMs - b.joinedAtMs) / 1000));
    }
    expect(new Set(pairs.map((p) => p.worker)).size).toBeGreaterThan(1); // the work really was shared
    expect(lockMisses).toBeGreaterThan(0); // and the workers really did contend for the lock
  }, 60_000);

  it('negative control: the same race WITHOUT the lock double-pairs players', async () => {
    let sawDuplicate = false;
    for (let attempt = 0; attempt < 5 && !sawDuplicate; attempt += 1) {
      await clean();
      await seedQueue(60, 100 + attempt);
      const pairs: Pair[] = [];
      let finished = false;
      const unlockedWorker = async (id: number): Promise<void> => {
        while (!finished) {
          const nowMs = Date.now();
          const pair = await findPair(compat(), nowMs);
          if (!pair) { finished = true; break; }
          await Promise.all([dequeue(compat(), pair[0]), dequeue(compat(), pair[1])]);
          pairs.push({ a: pair[0], b: pair[1], nowMs, worker: id });
        }
      };
      await Promise.all([0, 1, 2, 3, 4, 5].map(unlockedWorker));
      const everyone = pairs.flatMap((pair) => [pair.a, pair.b]);
      sawDuplicate = new Set(everyone).size < everyone.length;
    }
    expect(sawDuplicate).toBe(true);
  }, 60_000);

  describe('lock semantics', () => {
    const keyFor = () => `zapdos:test:lock:${run}:${Math.random().toString(36).slice(2)}`;

    it('only one of many concurrent acquirers wins', async () => {
      const key = keyFor();
      const tokens = await Promise.all(Array.from({ length: 20 }, () => acquireLock(lockClient(), { key, ttlMs: 2000 })));
      expect(tokens.filter(Boolean)).toHaveLength(1);
      await (redis as Redis).del(key);
    });

    it('a stale release (wrong token) does not delete another holder\'s lock', async () => {
      const key = keyFor();
      const stale = await acquireLock(lockClient(), { key, ttlMs: 80 });
      expect(stale).not.toBeNull();
      await sleep(150); // the first holder's TTL expires while it is "stuck"
      const current = await acquireLock(lockClient(), { key, ttlMs: 5000 });
      expect(current).not.toBeNull();
      expect(current).not.toBe(stale);

      expect(await releaseLock(lockClient(), stale as string, key)).toBe(false); // the late release is a no-op
      expect(await (redis as Redis).get(key)).toBe(current); // the new holder still owns the lock
      expect(await acquireLock(lockClient(), { key })).toBeNull(); // ... so nobody else can enter

      expect(await releaseLock(lockClient(), current as string, key)).toBe(true);
      expect(await (redis as Redis).get(key)).toBeNull();
    });

    it('TTL expiry lets another worker proceed (a crashed holder cannot wedge matchmaking)', async () => {
      const key = keyFor();
      expect(await acquireLock(lockClient(), { key, ttlMs: 120 })).not.toBeNull();
      expect(await acquireLock(lockClient(), { key, ttlMs: 120 })).toBeNull(); // still held
      await sleep(200);
      const next = await acquireLock(lockClient(), { key, ttlMs: 5000 });
      expect(next).not.toBeNull();
      await releaseLock(lockClient(), next as string, key);
    });

    it('tokens are unique and the production TTL is far above the work it protects', async () => {
      const key = keyFor();
      const first = await acquireLock(lockClient(), { key, ttlMs: 1000 });
      await releaseLock(lockClient(), first as string, key);
      const second = await acquireLock(lockClient(), { key, ttlMs: 1000 });
      expect(second).not.toBe(first);
      await releaseLock(lockClient(), second as string, key);
      expect(LOCK_TTL_MS).toBeGreaterThanOrEqual(10_000);
    });
  });
});
