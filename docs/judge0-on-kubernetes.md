# Running Judge0 on Kubernetes (design notes – not implemented here)

Zapdos does not run Judge0 on Kubernetes. Locally it uses the `local` backend, in production a Judge0 box
(`docker-compose.yml` / `deploy/`) or the Vercel Sandbox. This note records how it *would* be done and why we stopped short.

## Shape of the deployment

```
            Next.js / API pods ──HTTP──▶  judge0-server (Deployment, 2+ replicas, stateless Rails API)
                                                 │ enqueue                          ▲ results
                                                 ▼                                  │
                                           Redis (queue)  ◀──poll──  judge0-worker (Deployment, N replicas)
                                                 │                      each runs `isolate` per test
                                           Postgres (submissions state)
```

* **server** and **workers** are the same image with different commands. The server is stateless; scale it on CPU.
* **Postgres and Redis**: use managed services (RDS/Cloud SQL, ElastiCache/Memorystore) rather than StatefulSets in the cluster.
* The app keeps its current pattern: submit one job per submission (compile once, run many) and **poll**; no inbound callbacks needed.

## The hard part: `isolate` needs privileges

Judge0 sandboxes every run with [`isolate`](https://github.com/ioi/isolate), which uses Linux namespaces and **cgroups**
and must run privileged (`privileged: true`, or at minimum `SYS_ADMIN`). This repo's own notes show the pain: Judge0 needs
cgroup **v1** (the `systemd.unified_cgroup_hierarchy=0` boot parameter), and on a cgroup-v2 host the non-cgroup memory path
hangs, so the harness forces `--cg` mode. On Kubernetes that means:

* a **dedicated node pool** for judge workers, with a node image/boot setting that provides the cgroup mode your Judge0
  build expects (v1, or a Judge0/isolate build with cgroup v2 support);
* that pool **tainted** (`judge=true:NoSchedule`) and workers given the matching toleration + `nodeSelector`, so untrusted
  code never shares a node with the API, Redis clients or anything holding secrets;
* a namespace with **Pod Security `privileged`** *only for that namespace* (the `restricted` profile rejects the pods), and
  a **NetworkPolicy** that denies everything except worker → Postgres/Redis (the submissions themselves already run without
  network inside isolate);
* CPU `requests == limits` and the static CPU-manager policy for the worker pods, so timing is stable. Keep the existing
  hardware calibration (`JUDGE_HW_MULTIPLIER`) – cloud vCPUs are slower than Codeforces' judges.

## Scaling

Workers are queue consumers, so scale on **queue depth**, not CPU: a KEDA `ScaledObject` on the Redis queue length (with CPU
HPA as fallback), a floor of 2 workers for warm capacity and a ceiling set by the node pool. Cap concurrent jobs per worker
(the repo already throttles with `JUDGE0_MAX_CONCURRENT` / `JUDGE_CONCURRENCY`) and keep a `PodDisruptionBudget` so a node
drain does not kill running judgements. A worker `preStop` hook should let in-flight cases finish.

## Stronger isolation than `isolate` alone

Privileged containers sharing a kernel are a weak boundary for hostile code. Options, from least to most change:

1. run the worker pods under **gVisor** (`RuntimeClass: gvisor`) – note that `isolate`'s cgroup use must be supported by it;
2. **Kata Containers / Firecracker** microVM pods – one VM per worker;
3. drop Judge0 and run **one short-lived microVM or pod per submission** – which is what the existing Vercel Sandbox backend
   already does (snapshot with g++/python/JDK, `deny-all` network, destroyed after the run).

## Why this is not in the repo

It needs a cluster, a privileged tainted node pool, a cgroup-aware node image, and ongoing operation – for no product gain
at the current scale, where a single Judge0 VM (or the Sandbox) is enough and the `local` backend covers development and CI.
The parts of the design that *are* real in this repo: the batch contract all backends share (`ExecuteBatchOptions` /
`BatchResult`), the per-case CPU + wall limits, the HW-calibrated time limits and the concurrency throttle.
