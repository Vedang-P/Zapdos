# Zapdos

**1v1 competitive programming duels.** Race head-to-head against another programmer — progressive-unlock problems (Easy → Medium), live timer, see your opponent's progress but never their code. Climb the ELO ladder.

```
██████████                         █████
░█░░░░░░███                         ░░███
░     ███░    ██████   ████████   ███████   ██████   █████
     ███     ░░░░░███ ░░███░░███ ███░░███  ███░░███ ███░░
    ███       ███████  ░███ ░███░███ ░███ ░███ ░███░░█████
  ████     █ ███░░███  ░███ ░███░███ ░███ ░███ ░███ ░░░░███
 ███████████░░████████ ░███████ ░░████████░░██████  ██████
░░░░░░░░░░░  ░░░░░░░░  ░███░░░   ░░░░░░░░  ░░░░░░  ░░░░░░
                       ░███
                       █████
                      ░░░░░
```

## Features

- **Progressive Unlock** — Solve Easy problems to unlock Medium
- **Live Timer** — 20-minute server-authoritative countdown
- **Opponent Awareness** — See test cases passed, wrong submissions, current problem — never their code
- **ELO Matchmaking** — Classic Elo rating system with skill-based pairing
- **3 Languages** — C++, Python, Java via Judge0 sandbox (or a local-compiler backend for development, see [docs/judge-backends.md](docs/judge-backends.md))
- **Real-time Battle** — Socket.IO-powered opponent progress feed with Redis adapter for horizontal scaling (cross-instance latency is benchmarked in [docs/realtime-benchmark.md](docs/realtime-benchmark.md))
- **Code Editor** — In-browser Monaco editor with syntax highlighting
- **240 Real Problems** — Sourced from Codeforces (rating 800-1200)
- **AST-based Anti-cheat** — tree-sitter syntax trees for C++/Python/Java, winnowed structural fingerprints and AST rule checks (forbidden calls, hard-coded output); findings are flagged for review and never shown to players ([docs/anticheat.md](docs/anticheat.md))
- **Problem Recommendations** — retrieval over problem embeddings with MMR, and a rationale grounded in the retrieved evidence (deterministic template, or an optional LLM that may only explain the retrieved problems) ([docs/recommender.md](docs/recommender.md))
- **ELO Rank Tiers** — Bronze → Silver → Gold → Platinum → Diamond → Master → Grandmaster
- **Win Streaks** — Track hot streaks with visual indicators
- **Practice Mode** — Play against AI bot with Easy/Medium difficulty
- **OAuth** — Sign in with Google, GitHub, or email/password
- **Anonymous Feedback** — Built-in feedback system
- **Interactive Terminal Landing** — Type commands, explore the platform
- **Music Player** — Playlist with loop-all, mute toggle, persisted preferences

## Architecture

```
Browser ──HTTPS/WSS──> Nginx ──► Next.js (:3000)
                                └─REST──> PostgreSQL
                                └─REST──> Redis (queue, limits, adapter)
                                └─enqueue──> matchmaker ──► createMatch
                                └─Redis pub/sub──> Socket.IO (any instance)

Next.js (:3000) ──REST──> Judge0 (:2358) ──> isolate sandbox

Workers (separate processes):
  - realtime   (Socket.IO server on :3002, Redis adapter)
  - matchmaker (Redis sorted set, HMAC-signed emit bridge)
  - finalizer  (SELECT FOR UPDATE, idempotent, emits match:end)
  - bot        (practice AI, recursive setTimeout, graceful shutdown)
```

### Monorepo (pnpm workspaces)

| Path | Package | Purpose |
|------|---------|---------|
| `apps/web` | `web` | Next.js app (frontend + REST API) + Socket.IO server + workers |
| `packages/db` | `@zapdos/db` | Prisma schema, client singleton, migrations |
| `packages/elo` | `@zapdos/elo` | Pure Elo rating math |
| `packages/realtime` | `@zapdos/realtime` | Shared Socket.IO event contracts |
| `packages/judge` | `@zapdos/judge` | Judge0 client, token-based output compare, verdict logic |
| `packages/match` | `@zapdos/match` | Matchmaking queue, scoring, match lifecycle |

---

## Prerequisites

- **Node.js ≥ 20** and **pnpm ≥ 9** (`npm i -g pnpm`)
- **Docker Desktop** (for Postgres + Redis + Judge0)
- **Git**

## Getting Started (Local Development)

```bash
# 1. Clone and install
git clone https://github.com/Vedang-P/cp-battle.git
cd zapdos
pnpm install

# 2. Copy env and fill in secrets
cp .env.example .env
# Edit .env — set AUTH_SECRET and NEXTAUTH_SECRET to random strings

# 3. Start infrastructure (postgres, redis, Judge0)
pnpm infra:up
# Judge0's first run may take ~30s to be ready

# 4. Apply DB schema + seed problems
pnpm db:generate
pnpm db:push

# 5. Import Codeforces problems
pnpm import-codeforces

# 6. Start all services (each in a separate terminal, or use start-dev.sh)
pnpm dev                # Next.js on :3000
pnpm dev:realtime       # Socket.IO on :3002
pnpm dev:matchmaker     # Matchmaking worker
pnpm dev:finalizer      # Match finalization worker
pnpm dev:bot            # Practice bot worker
```

Or start all at once:
```bash
bash scripts/start-dev.sh
```

Open [http://localhost:3000](http://localhost:3000).

Verify infrastructure at [http://localhost:3000/api/health](http://localhost:3000/api/health) — all three services should report `ok`.

---

## Match Rules

| Rule | Value |
|------|-------|
| **Format** | Progressive unlock — Easy → Medium |
| **Clock** | 20 minutes (server-authoritative) |
| **Scoring** | Easy 100 / Medium 200 points |
| **Penalty** | -10 points per wrong submission (floor 0) |
| **Winner** | Higher total score; tiebreak on total solve time; else draw |
| **ELO** | K=40 provisional (first 10 games), K=32 established, default 1200 |

## Supported Languages

| Language | Judge0 ID | Std | Time Multiplier | Memory Multiplier |
|----------|-----------|-----|-----------------|-------------------|
| C++ | 54 (GCC 9.2.0) | C++17 | 1x | 1x |
| Python | 71 (3.8.1) | 3.8 | 3x | 2x |
| Java | 62 (OpenJDK 13.0.1) | 13 | 2x | 2x |

> **Versions are pinned to what the live Judge0 server actually runs.** GCC 9.2
> does **not** support `-std=c++20`, Python is **3.8** (no `match`/`case`), and
> Java is **OpenJDK 13** (no records). Don't rely on newer-version syntax.

### Judging architecture

Each submission is **one** Judge0 job, not one per test case. We use Judge0's
multi-file language (id 89): the source, a compile script, a run harness, and
every test input are zipped together, so the code **compiles once** and the
harness runs the compiled program against each case in turn. This matters —
`#include <bits/stdc++.h> -O2` takes ~1.6s to compile, and problems average ~38
test cases, so per-test-case compilation was the dominant cost under load.

Key properties (`packages/judge`):

- **Async submit + poll.** We never use Judge0's synchronous `wait=true` (it can
  hang the connection on our deployment and surface a correct solution as a false
  TLE). We submit, then poll for the result.
- **cgroup isolate mode.** The host kernel is cgroup v2, on which isolate's
  non-cgroup memory path hangs and returns internal errors. Both
  `enable_per_process_and_thread_*` flags are kept **false** so isolate runs in
  `--cg` mode.
- **CPU-time-based per-case limits.** The harness enforces each case with
  `ulimit -t` (CPU time) plus a generous wall backstop, so wall-clock contention
  under concurrent load can never cause a false TLE. It stops at the first
  failing case (first failure decides the verdict).
- **Precompiled header.** A prebuilt `<bits/stdc++.h>` PCH is mounted into the
  Judge0 containers (`/opt/judge0-pch`, rebuilt via its `build.sh`), cutting each
  C++ compile from ~1.6s to ~0.4s.

### Time-limit calibration

Problem time limits are imported verbatim from Codeforces, whose judges run on
fast dedicated hardware. Our Judge0 runs on a smaller shared cloud vCPU, so a
**correct** solution can legitimately use more CPU than the raw limit:

```
effective_limit = base_limit × language_multiplier × JUDGE_HW_MULTIPLIER
```

- `language_multiplier` — interpreter/JVM startup overhead (table above).
- `JUDGE_HW_MULTIPLIER` — slow-hardware calibration (default **2.5**), capped at
  a 15s effective limit.
- In-flight submissions are throttled by `JUDGE0_MAX_CONCURRENT` (default **12**)
  and `JUDGE_CONCURRENCY` (app-level, default **12**), sized a little above the
  Judge0 worker pool (6 workers on the 2-vCPU box).

---

## Problem Corpus

Zapdos uses **real problems** sourced from Codeforces — not generated.

| Source | Count | How to add |
|--------|-------|------------|
| Codeforces (rating 800-1200) | 240 | `pnpm import-codeforces` |
| **Total** | **240** | |

### Importing problems

```bash
pip install datasets
python3 apps/web/scripts/download-codeforces.py   # writes /tmp/cf_problems.json; CF_PROBLEM_LIMIT (default 240) sets how many
pnpm import-codeforces                            # 240 Codeforces easy problems
```

The importer:
- Downloads from the `open-r1/codeforces` HuggingFace dataset
- Filters to rating 800-1200 (easy difficulty)
- Generates hidden test cases from input/output pairs
- Upserts by slug (re-running updates existing problems)

### Adding your own music

Drop MP3 files into `apps/web/public/audio/music/` and update `apps/web/public/audio/manifest.json`:

```json
{
  "tracks": [
    { "file": "my-track-1.mp3", "title": "My Track 1" },
    { "file": "my-track-2.mp3", "title": "My Track 2" }
  ]
}
```

The music player loops through all tracks and back to the start. Users can mute/unmute from the navbar.

---

## Production Deployment

### Current Setup: Two GCP VMs

| VM | Machine Type | IP | Purpose |
|----|-------------|-----|---------|
| `cpb-web` | e2-medium | 35.232.246.89 (static) | Next.js + all workers + Postgres + Redis + Nginx |
| `cpb-judge0` | e2-standard-2 | 10.128.0.3 (internal) | Judge0 CE (6 workers, privileged mode) |

### Architecture

All app services run in Docker containers on the web VM:

```
┌─ cpb-web (e2-medium, 2 vCPU, 4GB) ─────────────────────┐
│                                                          │
│  Nginx (:80) ──► Next.js (:3000)                        │
│              ──► Socket.IO (:3002)                       │
│                                                          │
│  ┌─ Docker Compose Stack ──────────────────────────────┐ │
│  │ postgres  redis  web  realtime  matchmaker  ...     │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                          │
│  Judge0 runs on a separate VM (needs privileged mode)    │
└──────────────────────────────────────────────────────────┘

┌─ cpb-judge0 (e2-standard-2, 2 vCPU, 8GB) ──────────────┐
│  judge0-server (:2358)                                   │
│  judge0-worker ×3 containers (COUNT=2 → 6 workers)       │
│  judge0-db (Postgres)                                    │
│  judge0-redis                                            │
└──────────────────────────────────────────────────────────┘
```

### Deploying Changes

```bash
# From local machine
git push origin master

# SSH into web VM
gcloud compute ssh cpb-web --zone=us-central1-a

# Pull changes, rebuild, restart
cd /home/vedang/cp-battle
git pull
sudo docker build -t zapdos-web:latest .
sudo docker compose --env-file .env.production -f deploy/docker-compose.web.yml \
  up -d --force-recreate web realtime matchmaker finalizer bot nginx
```

> **Why `nginx` is in that list:** recreating `web` gives it a new Docker IP.
> nginx uses a DNS resolver (see `deploy/nginx.conf`) to re-resolve upstreams
> within ~10s, but recreating nginx alongside `web` makes the cutover instant
> and reloads any nginx config changes. Omitting it can cause a brief 502.

### Database Migrations

```bash
# On the web VM. Run as root (-u root): the container's app user can't write
# Prisma's engine cache, which fails the default-user invocation.
cd /home/vedang/cp-battle
sudo docker compose --env-file .env.production -f deploy/docker-compose.web.yml \
  exec -u root -T web pnpm --filter @zapdos/db migrate:deploy
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `APP_URL` | Yes | — | Base URL of the app |
| `AUTH_SECRET` | Yes | — | NextAuth secret (32+ chars) |
| `NEXTAUTH_SECRET` | Yes | — | NextAuth secret (32+ chars) |
| `NEXTAUTH_URL` | Yes | — | NextAuth base URL |
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `REDIS_URL` | Yes | — | Redis connection string |
| `JUDGE0_URL` | No | `http://localhost:2358` | Judge0 judge URL |
| `JUDGE0_API_KEY` | No | — | RapidAPI key (production) |
| `JUDGE_CONCURRENCY` | No | `4` | Max concurrent `judgeSubmission` calls |
| `JUDGE0_MAX_CONCURRENT` | No | `3` | Global cap on in-flight Judge0 requests (match the worker pool) |
| `JUDGE_HW_MULTIPLIER` | No | `2.5` | Slow-hardware time-limit calibration |
| `JUDGE_BACKEND` | No | `judge0` | `judge0`, `sandbox` (Vercel), or `local` (compiles with this machine's g++/python3/javac; **no isolation**, development and CI only) |
| `ANTICHEAT_SIMILARITY_THRESHOLD` | No | `0.85` | Flag two accepted submissions whose normalised ASTs are at least this similar |
| `RECOMMENDER_LLM_URL` / `RECOMMENDER_LLM_API_KEY` | No | — | Optional OpenAI-compatible endpoint for recommendation rationales (`RECOMMENDER_LLM_MODEL`, default `gpt-4o-mini`); without it a deterministic template is used |
| `MATCH_DURATION_SECONDS` | No | `1200` | Battle duration (20 min) |
| `WRONG_SUBMISSION_PENALTY` | No | `10` | Points deducted per wrong submission |
| `REALTIME_CORS_ORIGIN` | No | `http://localhost:3000` | CORS origin for Socket.IO |
| `REALTIME_URL` | No | `http://localhost:3002` | Internal URL for /emit bridge |
| `NEXT_PUBLIC_REALTIME_URL` | No | `http://localhost:3002` | Public URL for browser Socket.IO |
| `GOOGLE_CLIENT_ID` | No | — | Google OAuth client ID (provider registered only if set) |
| `GOOGLE_CLIENT_SECRET` | No | — | Google OAuth client secret |
| `GITHUB_CLIENT_ID` | No | — | GitHub OAuth client ID (provider registered only if set) |
| `GITHUB_CLIENT_SECRET` | No | — | GitHub OAuth client secret |
| `ADMIN_SECRET` | No | — | Required (as `X-Admin-Secret` header) to read `GET /api/feedback` |

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check (Postgres, Redis, Judge0) |
| POST | `/api/auth/signup` | Create account |
| GET/POST | `/api/auth/[...nextauth]` | NextAuth handlers (credentials + Google OAuth) |
| GET | `/api/auth/socket-token` | Get JWT for Socket.IO auth |
| GET | `/api/user/profile` | Current user profile |
| GET | `/api/leaderboard` | Top 100 players by ELO |
| POST | `/api/match/join` | Join matchmaking queue |
| DELETE | `/api/match/join` | Leave matchmaking queue |
| GET | `/api/match/status` | Current queue/match status |
| POST | `/api/match/practice` | Start practice match vs bot |
| GET | `/api/match/[matchId]/problems` | Match problems + progress |
| GET | `/api/match/[matchId]/opponent` | Opponent progress (sanitized) |
| POST | `/api/match/[matchId]/submit` | Run or submit code |
| POST | `/api/match/[matchId]/forfeit` | Forfeit match |
| GET | `/api/match/[matchId]/result` | Match result |
| GET | `/api/match/history` | User's match history |
| POST | `/api/feedback` | Submit anonymous feedback |
| GET | `/api/feedback` | Read feedback (requires `X-Admin-Secret` header) |

---

## Commands Reference

| Command | Description |
|---------|-------------|
| `pnpm dev` | Run Next.js dev server (`:3000`) |
| `pnpm dev:realtime` | Run Socket.IO server (`:3002`) |
| `pnpm dev:matchmaker` | Run matchmaking worker |
| `pnpm dev:finalizer` | Run match finalization worker |
| `pnpm dev:bot` | Run practice bot worker |
| `pnpm build` | Build Next.js for production |
| `pnpm start` | Start production server |
| `pnpm db:push` | Sync schema to DB (dev) |
| `pnpm db:migrate:deploy` | Apply migrations (production) |
| `pnpm db:seed` | Seed initial problems (now a no-op, use importer) |
| `pnpm import-codeforces` | Import 240 Codeforces problems |
| `pnpm infra:up` | Start Docker services |
| `pnpm infra:down` | Stop Docker services |
| `pnpm typecheck` | Typecheck all workspaces |
| `pnpm lint` | Lint all workspaces |
| `pnpm test` | Run the vitest suites (anti-cheat, local judge, recommender, matchmaking lock, Elo); integration tests use the local Postgres/Redis and skip when they are not running |
| `pnpm --filter web bench:realtime` | Socket.IO + Redis pub/sub latency across two server instances ([docs/realtime-benchmark.md](docs/realtime-benchmark.md)) |
| `pnpm --filter web eval:recommender` | Offline recommender quality and latency ([docs/recommender.md](docs/recommender.md)) |

---

## Testing

### E2E Match Test

```bash
# Requires running dev server + seeded DB with test users
BASE_URL=http://localhost:3000 pnpm tsx scripts/e2e-match.js
```

### Stress Test

```bash
# Run with default 100 virtual users
BASE_URL=http://localhost:3000 pnpm tsx scripts/stress-test.ts

# Custom user count
USERS=50 DURATION=60 pnpm tsx scripts/stress-test.ts
```

---

## Documentation

| Topic | Doc |
|-------|-----|
| AST-based anti-cheat (how it works, limits, benchmark) | [docs/anticheat.md](docs/anticheat.md) |
| Judge backends (Judge0, Vercel Sandbox, local) | [docs/judge-backends.md](docs/judge-backends.md) |
| Running Judge0 on Kubernetes (in theory) | [docs/judge0-on-kubernetes.md](docs/judge0-on-kubernetes.md) |
| Problem recommender | [docs/recommender.md](docs/recommender.md) |
| Realtime latency benchmark (Socket.IO + Redis) | [docs/realtime-benchmark.md](docs/realtime-benchmark.md) |

---

## Security

- **HMAC-signed /emit bridge** — all internal Socket.IO event emissions are signed with AUTH_SECRET
- **JWT-expiry verification** — Socket.IO tokens expire after 1 hour
- **CSRF protection** — Origin/Referer check on all mutating API routes; requests with neither header are rejected
- **Security headers** — `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy` (set at both Next.js and Nginx)
- **Row-level locking** — `SELECT FOR UPDATE` on Match and User rows during finalization
- **Atomic rate limiting + budget** — Lua scripts for INCR+PEXPIRE (no orphaned keys); the monthly submission budget is incremented-and-checked atomically (no TOCTOU over-cap)
- **Unspoofable client IP** — login/signup rate limits key off Nginx's `X-Real-IP`, not the client-controllable `X-Forwarded-For`
- **OAuth takeover protection** — OAuth sign-in cannot silently claim an existing password account with the same email; providers are only registered when their credentials are configured
- **Sanitized opponent data** — compile/runtime errors never sent to the opponent; internal judge errors are not leaked to clients
- **Judge0 sandbox** — `enable_network: false`, per-process time/memory limits, global request throttle
- **bcrypt password hashing** — cost factor 12
- **Disposable email blocklist** — 200+ domains blocked at signup
- **Input validation** — Zod schemas on all API inputs

---

## License

MIT
