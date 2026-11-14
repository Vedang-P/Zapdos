/**
 * The matchmaker's distributed lock.
 *
 * Pairing is read-modify-write on shared state (find a pair in the Redis sorted set -> dequeue both -> create the
 * match), so two matchmaker processes must never do it at the same time or one player could be put in two matches.
 * The lock is the standard single-Redis pattern:
 *
 *   acquire:  SET key <token> PX <ttl> NX   - succeeds for exactly one caller; PX makes it self-expiring, so a worker
 *                                             that crashes while holding it cannot wedge matchmaking forever;
 *   release:  Lua compare-and-delete        - delete the key only if it still holds OUR token.  Without the check a
 *                                             worker whose lock already expired would delete the lock of whoever
 *                                             acquired it next.  Running it as a script makes GET+DEL atomic.
 *
 * The token is a random value (pid + time + UUID): an exact-match check is only meaningful if no two holders can
 * ever share a token, and pid/timestamp alone can repeat across containers (every container's first process is pid 1).
 *
 * Known limits (documented, accepted): this is a single-Redis lock, not Redlock, and there is no fencing token.  If the
 * TTL elapses while a worker is still inside the critical section (a long GC pause, a stalled database), a second
 * worker may enter.  The TTL (15 s) is therefore chosen far longer than the real work (a few ms to a few hundred ms),
 * and a Redis failover can drop the lock.  Making pairing safe even then would need a database-level guard.
 */

import { QUEUE_LOCK_KEY } from './queue';

/** Generous enough to cover findPair + dequeue + createMatch even under DB load. */
export const LOCK_TTL_MS = 15_000;

/** The slice of an ioredis client the lock needs (ioredis satisfies it as-is). */
export interface LockRedis {
  set(key: string, value: string, mode: 'PX', ttlMs: number, flag: 'NX'): Promise<unknown>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

/** Release only if we still hold the lock (atomic via Lua). */
export const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
`;

export function newLockToken(): string {
  const pid = typeof process !== 'undefined' ? process.pid : 0;
  return `${pid}-${Date.now()}-${globalThis.crypto.randomUUID()}`;
}

export interface LockOptions {
  key?: string;
  ttlMs?: number;
  token?: string;
}

/** Try to take the lock. Returns the holder's token, or null if somebody else holds it. */
export async function acquireLock(redis: LockRedis, options: LockOptions = {}): Promise<string | null> {
  const token = options.token ?? newLockToken();
  const result = await redis.set(options.key ?? QUEUE_LOCK_KEY, token, 'PX', options.ttlMs ?? LOCK_TTL_MS, 'NX');
  return result === 'OK' ? token : null;
}

/** Release the lock if (and only if) `token` still owns it. Returns whether the lock was actually deleted. */
export async function releaseLock(redis: LockRedis, token: string, key: string = QUEUE_LOCK_KEY): Promise<boolean> {
  const deleted = await redis.eval(RELEASE_LOCK_SCRIPT, 1, key, token);
  return Number(deleted) === 1;
}
