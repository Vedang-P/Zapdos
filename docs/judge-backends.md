# Judge backends

`@zapdos/judge` runs a submission against its test cases through one of three interchangeable backends, selected with
`JUDGE_BACKEND`. All three implement the same contract – compile **once**, run every test input, stop at the first case
that does not exit cleanly, return per-case stdout / stderr / exit code / time – and `judgeSubmission()` turns that into
a verdict (AC / WA / TLE / MLE / RE / CE) identically for all of them.

| `JUDGE_BACKEND` | Where code runs | Isolation | Use for |
|---|---|---|---|
| `judge0` (default) | self-hosted Judge0 CE (`docker-compose.yml`, `isolate`) | isolate sandbox, cgroups | production on a VM you control |
| `sandbox` | Vercel Sandbox microVM from a prebuilt snapshot | microVM, `deny-all` network | production on Vercel |
| `local` | the compilers installed on this machine | **none** | development, CI, demos |

## The `local` backend

[`packages/judge/src/local.ts`](../packages/judge/src/local.ts) was added so the whole platform – matchmaking, battles,
verdicts, anti-cheat – runs end to end on a laptop without Judge0 (which needs cgroup v1 and a privileged container) and
without a cluster. Requirements: `g++`, `python3`, `javac` + `java` on `PATH` (override with `LOCAL_JUDGE_GPP`,
`LOCAL_JUDGE_PYTHON`, `LOCAL_JUDGE_JAVAC`, `LOCAL_JUDGE_JAVA`).

```bash
JUDGE_BACKEND=local pnpm dev          # and the usual workers
```

What it enforces

* compile step per language: `g++ -O2 -std=c++17`, `python3 -m py_compile` (syntax errors are CE, like the Judge0
  harness), `javac Main.java`;
* **CPU time** per case with `ulimit -t` (SIGXCPU → exit 152 → TLE) plus a **wall-clock** kill of the entire process group
  (exit 124 → TLE);
* stdout cap (16 MiB) and stderr cap (64 KiB): runaway output kills the program (→ RE);
* memory: `-Xmx` for Java (heap exhaustion → `OutOfMemoryError` → MLE); `ulimit -v` for C++/Python **on Linux only**;
* the program runs with a **minimal environment** (`PATH`, `HOME`, `TMPDIR` in a throw-away directory), so submitted code
  cannot read `AUTH_SECRET`, `DATABASE_URL` or `REDIS_URL` from the server's environment;
* a `<bits/stdc++.h>` shim (used only when the system lacks it, e.g. macOS libc++) so typical competitive-programming C++ compiles.

What it deliberately does **not** do – this is a development backend, not a security boundary

* no filesystem or network isolation: a submission can read files and open sockets as the server's user (the AST
  anti-cheat flags such calls, but detecting is not preventing);
* no memory limit for C++/Python on macOS;
* limits are per case, not per process tree beyond the group kill.

Never point `local` at the public internet. For untrusted code use `judge0` or `sandbox`.

## Tests

`pnpm test` runs [`local.test.ts`](../packages/judge/src/local.test.ts) through `judgeSubmission` with the real
toolchains: for each of C++, Python and Java – AC, WA, CE, RE and TLE (an infinite loop is killed by the CPU limit) – plus
Java MLE, "the server's secrets are not visible to the submission", the output cap, and first-failure stop. A language whose
toolchain is missing is skipped. `pingJudge()` (used by `/api/health`) reports the local backend and lists missing toolchains.

## Judge0 on Kubernetes

See [`judge0-on-kubernetes.md`](judge0-on-kubernetes.md) for how Judge0 would be run on a cluster, and why that is not
part of this repo.
