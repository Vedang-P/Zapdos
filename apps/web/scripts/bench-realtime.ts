/**
 * Realtime latency benchmark: Socket.IO + Redis pub/sub (the @socket.io/redis-adapter), across TWO real realtime
 * server instances sharing one Redis.
 *
 *   pnpm --filter web bench:realtime
 *
 * Topology (CLIENTS sockets, CLIENTS/2 matches):
 *
 *      bench process (200 socket.io clients + HTTP emitter, one monotonic clock)
 *            |  player A of every match                  |  player B of every match
 *            v                                           v
 *      realtime instance 1  <---- Redis pub/sub ---->  realtime instance 2
 *            ^                                           ^
 *            +--------- POST /emit (HMAC-signed) --------+   alternating between the two instances
 *
 * Every event is published into a match room through the HMAC-signed `/emit` bridge (the same path the web app and the
 * matchmaker use). The room has one member on each instance, so one emit produces two deliveries:
 *
 *   same-instance   the member connected to the instance that received the POST (no Redis hop)
 *   cross-instance  the member connected to the other instance (delivered through Redis pub/sub)
 *
 * Latency = (client receive time) - (time just before the POST was issued), measured with process.hrtime on one
 * machine, so it includes the HTTP bridge hop. The cross-minus-same difference is the cost of the Redis fan-out.
 * Fixtures (users, matches) are created in Postgres and removed afterwards.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, platform, release } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io as connect, type Socket } from 'socket.io-client';
import { db } from '@zapdos/db';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(here, '..');

const CLIENTS = Number(process.env.BENCH_CLIENTS ?? 200); // sockets; must be even
const EVENTS = Number(process.env.BENCH_EVENTS ?? 5000); // measured events (each yields one same- and one cross-instance delivery)
const WARMUP = Number(process.env.BENCH_WARMUP ?? 500);
const RATE = Number(process.env.BENCH_RATE ?? 250); // events per second (open loop)
const PAYLOAD_PAD = Number(process.env.BENCH_PAYLOAD_PAD ?? 200); // filler bytes, so the payload resembles a real progress update
const PORTS = [Number(process.env.BENCH_PORT_A ?? 3112), Number(process.env.BENCH_PORT_B ?? 3113)] as const;
const AUTH_SECRET = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? '';
const OUT_DIR = path.join(here, 'results');
const RUN_ID = randomBytes(4).toString('hex');
const EMAIL_PREFIX = 'bench-rt-';

if (!AUTH_SECRET) throw new Error('AUTH_SECRET is not set (run via `pnpm --filter web bench:realtime`, which loads ../../.env)');
if (CLIENTS % 2 !== 0) throw new Error('BENCH_CLIENTS must be even');

// ---------------------------------------------------------------------------------------------------------------

const b64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/** Same token format as apps/web/lib/socket-token.ts (HMAC-SHA256 JWS). */
function mintToken(userId: string, username: string): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({ sub: userId, name: username, iat: now, exp: now + 3600 }));
  const sig = createHmac('sha256', AUTH_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1);
  const round = (x: number) => Math.round(x * 1000) / 1000;
  return {
    n: sorted.length,
    mean_ms: round(mean),
    p50_ms: round(percentile(sorted, 50)),
    p90_ms: round(percentile(sorted, 90)),
    p95_ms: round(percentile(sorted, 95)),
    p99_ms: round(percentile(sorted, 99)),
    p999_ms: round(percentile(sorted, 99.9)),
    max_ms: round(sorted[sorted.length - 1] ?? NaN),
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------------------------
// Server instances
// ---------------------------------------------------------------------------------------------------------------

const children: ChildProcess[] = [];

function startRealtime(port: number): Promise<ChildProcess> {
  const child = spawn('pnpm', ['exec', 'tsx', '--env-file=../../.env', 'server/index.ts'], {
    cwd: WEB_DIR,
    env: { ...process.env, REALTIME_PORT: String(port), DISCONNECT_FORFEIT_GRACE_MS: '3600000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stdout?.on('data', () => undefined); // drain: an unread pipe would eventually block the server
  child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[realtime:${port}] ${chunk}`));
  return (async () => {
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) return child;
      } catch {
        // not listening yet
      }
      await sleep(250);
    }
    throw new Error(`realtime instance on :${port} did not become healthy`);
  })();
}

async function stopChildren(): Promise<void> {
  for (const child of children) child.kill('SIGTERM');
  await sleep(1000);
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
}

// ---------------------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------------------

interface Fixture {
  matchId: string;
  userA: { id: string; username: string };
  userB: { id: string; username: string };
}

async function createFixtures(pairs: number): Promise<Fixture[]> {
  const users = Array.from({ length: pairs * 2 }, (_, i) => ({
    email: `${EMAIL_PREFIX}${RUN_ID}-${i}@bench.local`,
    username: `bench_${RUN_ID}_${i}`,
  }));
  await db.user.createMany({ data: users });
  const created = await db.user.findMany({ where: { email: { startsWith: `${EMAIL_PREFIX}${RUN_ID}-` } }, select: { id: true, username: true, email: true } });
  const byEmail = new Map(created.map((u) => [u.email, u]));
  const fixtures: Fixture[] = [];
  for (let i = 0; i < pairs; i++) {
    const a = byEmail.get(users[2 * i]!.email)!;
    const b = byEmail.get(users[2 * i + 1]!.email)!;
    const match = await db.match.create({ data: { playerAId: a.id, playerBId: b.id, problemSequence: [] }, select: { id: true } });
    fixtures.push({ matchId: match.id, userA: a, userB: b });
  }
  return fixtures;
}

async function removeFixtures(): Promise<void> {
  const where = { email: { startsWith: EMAIL_PREFIX } };
  await db.match.deleteMany({ where: { playerA: where } });
  await db.user.deleteMany({ where });
}

// ---------------------------------------------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------------------------------------------

interface Delivery {
  seq: number;
  path: 'same' | 'cross';
  latencyMs: number;
}

async function connectClient(port: number, user: { id: string; username: string }, matchId: string, onEvent: (payload: { seq: number; t0: string; via: number }, port: number) => void): Promise<Socket> {
  const socket = connect(`http://127.0.0.1:${port}`, {
    transports: ['websocket'],
    auth: { token: mintToken(user.id, user.username) },
    reconnection: false,
    forceNew: true,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', (err) => reject(err));
  });
  const joined = await new Promise<boolean>((resolve) => socket.emit('match:join', matchId, (ok: boolean) => resolve(ok)));
  if (!joined) throw new Error(`match:join refused for ${user.username}`);
  // 'bench:tick' is a custom event name: the server relays any event name through io.to(room).emit(...).
  socket.on('bench:tick', (payload: { seq: number; t0: string; via: number }) => onEvent(payload, port));
  return socket;
}

// ---------------------------------------------------------------------------------------------------------------

async function main() {
  const loadBefore = loadavg();
  console.log(`[bench] starting 2 realtime instances on :${PORTS[0]} and :${PORTS[1]} ...`);
  await Promise.all(PORTS.map(startRealtime));

  const pairs = CLIENTS / 2;
  console.log(`[bench] creating ${pairs} matches / ${CLIENTS} users ...`);
  const fixtures = await createFixtures(pairs);

  const deliveries: Delivery[] = [];
  const received = { count: 0 };
  const onEvent = (payload: { seq: number; t0: string; via: number }, port: number) => {
    const t1 = process.hrtime.bigint();
    received.count++;
    if (payload.seq < 0) return; // warm-up
    deliveries.push({
      seq: payload.seq,
      path: PORTS[payload.via] === port ? 'same' : 'cross',
      latencyMs: Number(t1 - BigInt(payload.t0)) / 1e6,
    });
  };

  console.log(`[bench] connecting ${CLIENTS} clients (A -> instance 1, B -> instance 2) ...`);
  const sockets: Socket[] = [];
  try {
    for (const batch of Array.from({ length: Math.ceil(fixtures.length / 20) }, (_, i) => fixtures.slice(i * 20, i * 20 + 20))) {
      const group = await Promise.all(
        batch.flatMap((f) => [
          connectClient(PORTS[0], f.userA, f.matchId, onEvent),
          connectClient(PORTS[1], f.userB, f.matchId, onEvent),
        ]),
      );
      sockets.push(...group);
    }
    console.log(`[bench] ${sockets.length} clients joined their match rooms`);

    const pad = 'x'.repeat(PAYLOAD_PAD);
    const url = (via: number) => `http://127.0.0.1:${PORTS[via]}/emit`;
    let payloadBytes = 0;
    const ackTimes: number[] = [];
    let failures = 0;

    const emit = async (seq: number, i: number) => {
      const via = i % 2; // alternate which instance receives the POST
      const room = `match:${fixtures[i % fixtures.length]!.matchId}`;
      const t0 = process.hrtime.bigint();
      const body = JSON.stringify({ room, event: 'bench:tick', payload: { seq, t0: t0.toString(), via, pad } });
      payloadBytes = Buffer.byteLength(JSON.stringify({ seq, t0: t0.toString(), via, pad }));
      const sig = createHmac('sha256', AUTH_SECRET).update(body).digest('hex');
      try {
        const res = await fetch(url(via), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Signature': sig }, body });
        await res.arrayBuffer();
        if (!res.ok) failures++;
        if (seq >= 0) ackTimes.push(Number(process.hrtime.bigint() - t0) / 1e6);
      } catch {
        failures++;
      }
    };

    const total = WARMUP + EVENTS;
    console.log(`[bench] sending ${WARMUP} warm-up + ${EVENTS} measured events at ${RATE}/s ...`);
    const started = process.hrtime.bigint();
    const inflight: Promise<void>[] = [];
    for (let i = 0; i < total; i++) {
      const dueMs = (i / RATE) * 1000;
      const waitMs = dueMs - Number(process.hrtime.bigint() - started) / 1e6;
      if (waitMs > 1) await sleep(waitMs);
      inflight.push(emit(i < WARMUP ? -1 : i - WARMUP, i));
    }
    await Promise.all(inflight);

    const expected = total * 2;
    for (let waited = 0; received.count < expected && waited < 15_000; waited += 50) await sleep(50);
    const elapsedS = Number(process.hrtime.bigint() - started) / 1e9;

    const same = deliveries.filter((d) => d.path === 'same').map((d) => d.latencyMs);
    const cross = deliveries.filter((d) => d.path === 'cross').map((d) => d.latencyMs);
    const loadAfter = loadavg();
    const result = {
      generated_at: new Date().toISOString(),
      claim: 'Socket.IO + Redis pub/sub at p99 < 20ms',
      method:
        'latency = client receive time - time just before the signed POST /emit was issued (process.hrtime, one machine); ' +
        'same-instance = the room member on the instance that received the POST, cross-instance = the member on the other instance (Redis pub/sub)',
      config: {
        clients: CLIENTS,
        matches: pairs,
        instances: 2,
        transport: 'websocket',
        measured_events: EVENTS,
        warmup_events: WARMUP,
        target_rate_per_s: RATE,
        achieved_rate_per_s: Math.round((total / elapsedS) * 10) / 10,
        payload_bytes: payloadBytes,
        redis: 'local Docker redis:7-alpine with requirepass',
      },
      machine: {
        platform: `${platform()} ${release()}`,
        cpus: cpus().length,
        cpu_model: cpus()[0]?.model,
        node: process.version,
        loadavg_before: loadBefore.map((x) => Math.round(x * 100) / 100),
        loadavg_after: loadAfter.map((x) => Math.round(x * 100) / 100),
      },
      deliveries: { expected: expected, received: received.count, emit_failures: failures },
      same_instance: summarize(same),
      cross_instance: summarize(cross),
      bridge_ack_ms: summarize(ackTimes),
      p99_under_20ms: { same_instance: percentile([...same].sort((a, b) => a - b), 99) < 20, cross_instance: percentile([...cross].sort((a, b) => a - b), 99) < 20 },
    };

    mkdirSync(OUT_DIR, { recursive: true });
    const jsonPath = path.join(OUT_DIR, process.env.BENCH_OUT_NAME ?? 'realtime-latency.json');
    writeFileSync(jsonPath, JSON.stringify(result, null, 2));
    writeFileSync(jsonPath.replace(/\.json$/, '.md'), renderMarkdown(result));
    console.log(JSON.stringify({ same_instance: result.same_instance, cross_instance: result.cross_instance, bridge_ack_ms: result.bridge_ack_ms, deliveries: result.deliveries, loadavg: result.machine.loadavg_after }, null, 2));
    console.log(`[bench] wrote ${jsonPath}`);
  } finally {
    for (const socket of sockets) socket.disconnect();
    await stopChildren();
    await removeFixtures();
    await db.$disconnect();
  }
}

function renderMarkdown(r: {
  generated_at: string;
  config: Record<string, unknown>;
  machine: Record<string, unknown>;
  deliveries: Record<string, number>;
  same_instance: ReturnType<typeof summarize>;
  cross_instance: ReturnType<typeof summarize>;
  bridge_ack_ms: ReturnType<typeof summarize>;
  p99_under_20ms: { same_instance: boolean; cross_instance: boolean };
}): string {
  const row = (name: string, s: ReturnType<typeof summarize>) =>
    `| ${name} | ${s.n} | ${s.mean_ms} | ${s.p50_ms} | ${s.p90_ms} | ${s.p95_ms} | **${s.p99_ms}** | ${s.p999_ms} | ${s.max_ms} |`;
  return [
    '# Realtime latency (Socket.IO + Redis adapter, 2 instances)',
    '',
    `Generated ${r.generated_at}. Reproduce: \`pnpm --filter web bench:realtime\`.`,
    '',
    '| path | n | mean ms | p50 | p90 | p95 | p99 | p99.9 | max |',
    '|---|---|---|---|---|---|---|---|---|',
    row('same instance (no Redis hop)', r.same_instance),
    row('cross instance (Redis pub/sub)', r.cross_instance),
    row('HTTP bridge ack (POST /emit round trip)', r.bridge_ack_ms),
    '',
    `p99 < 20 ms: same-instance **${r.p99_under_20ms.same_instance}**, cross-instance **${r.p99_under_20ms.cross_instance}**.`,
    '',
    `Deliveries: expected ${r.deliveries.expected}, received ${r.deliveries.received}, emit failures ${r.deliveries.emit_failures}.`,
    '',
    '```json',
    JSON.stringify({ config: r.config, machine: r.machine }, null, 2),
    '```',
    '',
  ].join('\n');
}

main().catch(async (err) => {
  console.error('[bench] failed:', err);
  await stopChildren().catch(() => undefined);
  await removeFixtures().catch(() => undefined);
  await db.$disconnect().catch(() => undefined);
  process.exit(1);
});
