# AST anti-cheat

Zapdos judges C++, Python and Java. After every **SUBMIT** the server inspects the submitted code with a real
parser (tree-sitter, compiled to WebAssembly) and records anything suspicious in the `SubmissionCheatFlag` table.
It never changes a verdict, never blocks the match and is never shown to players: it produces *evidence for a human
reviewer*, not bans.

Code: [`apps/web/lib/anticheat/`](../apps/web/lib/anticheat) · wired into
[`submit/route.ts`](../apps/web/app/api/match/%5BmatchId%5D/submit/route.ts) · tests: `pnpm test`.

## Pipeline

```
source ──tree-sitter──▶ concrete syntax tree ─┬─▶ facts (calls, imports, loops, I/O, literals) ──▶ rule flags
                                              └─▶ normalised node-type sequence ─▶ 5-grams ─▶ winnowing ─▶ fingerprints
                                                                                                              │
                                      Jaccard / containment against other accepted submissions ◀──────────────┘
```

* **Parsing** – `web-tree-sitter` 0.22.6 + the prebuilt grammars from `tree-sitter-wasms` 0.1.11 (about 5.5 MB for
  the three grammars we ship; no native build step, so it works on Vercel/Render). Runtime and grammars load once per
  process, parse trees are freed after use.
* **Normalisation** – throw away what a cheater can change for free, keep what they cannot:

  | Source construct | Becomes |
  |---|---|
  | variable / function / class names, `std::cin`, `java.util.Arrays`, `sys.stdin.readline` (pure name chains) | `ID` |
  | `std::vector<int>` vs `vector<int>` | same tokens (qualifier unwrapped) |
  | numeric / string / char literals, `true`/`null` | `NUM` / `STR` |
  | comments, `#include`, `import`, `using`, `package`, `#define` | dropped |
  | parentheses, whitespace, layout | transparent / never in the tree |
  | `for` / `while` / `do` / range-for | `LOOP` |
  | operators of binary / unary / assignment nodes | **kept** (`a + b` ≠ `a * b`) |

* **Winnowing** (Schleimer, Wilkerson, Aiken 2003 – the algorithm behind MOSS): hash every k-gram of the token
  sequence (k = 5), slide a window of w = 4 hashes and keep the minimum of each window. Guarantee: any shared run of
  at least k + w − 1 = 8 tokens produces at least one shared fingerprint, while only ~40 % of k-grams are kept.
* **Similarity** – Jaccard of the two fingerprint sets (`similarity`); `containment` = |A∩B| / min(|A|,|B|) catches
  padding with dead code. Programs with fewer than 12 fingerprints are marked `comparable: false` (a one-line `print(a+b)`
  is identical for everyone and says nothing).

## Rule checks (on AST nodes, not text)

| Flag | Severity | Fires when |
|---|---|---|
| `forbidden_call` | high | a **call node** reaches `system`/`popen`/`fork`/`exec*`/`socket`/`connect`/`ptrace`/`dlopen` (C++), `os.system`/`subprocess.*`/`socket.*`/`ctypes.*`/`exec`/`__import__` (Python), `Runtime.exec`/`ProcessBuilder`/`Socket`/`URL`/`System.load*` (Java). Python import aliases are resolved (`import subprocess as sp; sp.run()`, `from os import system`). Names the program defines itself are ignored (a union-find `connect()` is not a socket call). `eval`, `multiprocessing`, `Class.forName` are medium. |
| `forbidden_import` | medium | importing a networking / process / reflection module |
| `file_access` | medium | `fopen`, `ifstream`, `open(...)`, `new File(...)`, `Files.*` … inside the judge |
| `hardcoded_output` | high | prints a constant (literal-only output statements) and never reads the input |
| `lookup_chain` | high / medium | ≥ 15 `if (x == literal)` / `case literal:` branches and ≥ 10 literal-only outputs (high), or ≥ 30 literal branches (medium) |
| `large_literal_table` | medium | a single array/list/dict/initializer with ≥ 64 literals |
| `similarity` | high (same match) / medium | normalised AST similarity ≥ `ANTICHEAT_SIMILARITY_THRESHOLD` (0.85) with the opponent's AC code in this match, or with one of the last 25 AC submissions of other users for the problem |
| `containment` | medium | ≥ 95 % of the smaller program's fingerprints appear in another accepted submission (and similarity ≥ 0.4) |

A word inside a string or comment is **not** a finding: `// never call system("ls")` and
`cout << "fork() is forbidden"` produce no flags (covered by tests in all three languages).

## Integration

1. `beginAnalysis()` starts the own-code analysis (rules + fingerprints) right after the submission row is created – it
   runs while the judge works.
2. After the verdict and the gameplay socket events, `finishAntiCheat()` awaits it. For **AC** submissions it compares
   against the opponent's accepted code in the same match and ≤ 25 other accepted submissions (same problem and
   language), within a time budget (`ANTICHEAT_BUDGET_MS`, default 1500 ms; findings are skipped, not delayed, past it).
3. Findings are written to the standalone `SubmissionCheatFlag` table (one JSON row per flagged submission; no row when nothing was flagged) and logged as
   `[anticheat] submission … flagged: similarity/high`. Every error is caught and logged; the request never fails because of it.

Settings: `ANTICHEAT_ENABLED`, `ANTICHEAT_SIMILARITY_THRESHOLD`, `ANTICHEAT_BUDGET_MS`, `ANTICHEAT_WASM_DIR`
(see `.env.example`). Serverless: `next.config.mjs` ships `web-tree-sitter` and only the three needed `.wasm` files.

## Measured results

`pnpm --filter web exec tsx scripts/bench-anticheat.ts` → [`docs/results/anticheat_bench.json`](results/anticheat_bench.json)
(MacBook, Apple silicon, Node 22; machine load average was ~50 on 8 cores while this ran, so latencies are pessimistic).
Program: longest-increasing-subsequence solution, ~100–160 normalised tokens.

| | C++ | Python | Java |
|---|---|---|---|
| parse + analyse + fingerprint, p50 / p95 (200 runs) | 0.8 / 5.2 ms | 0.4 / 1.1 ms | 0.7 / 2.1 ms |
| similarity: renamed + reformatted + commented copy | 1.000 | 1.000 | 1.000 |
| similarity: different algorithm (O(n²) DP vs O(n log n) binary search) | 0.105 | 0.216 | 0.244 |
| analysing 26 other submissions (no DB) | 25 ms | 14 ms | 28 ms |

First-use cost: ~100 ms once per process (WASM runtime + all three grammars).
Grammars are loaded together with C++ **last** – with this web-tree-sitter version the first `Language.load` after the C++
grammar took 5–8 s in our measurements; loading order removes it (`coldstart.test.ts` guards this).

Tests (`pnpm test`): 47 anti-cheat tests – similarity ≥ 0.9 for renamed copies and < 0.5 for different algorithms in
all three languages, hard-coded output, lookup chains, forbidden calls vs words in strings/comments, Python alias
resolution, user-defined `connect()`, syntax-error tolerance, determinism, latency, cold start – plus an integration
test against the real Postgres (copy of the opponent's code → `similarity/high` stored, clean submission → `NULL`).

## Limits (read before trusting a flag)

* **Flags are signals, not verdicts.** Short or textbook problems make many honest solutions structurally identical
  (the same DP, the same sieve). That is why programs under 12 fingerprints are not compared, why the threshold is high
  (0.85) and why nothing is enforced automatically.
* **No template removal.** Standard I/O boilerplate is not subtracted, so two tiny programs that differ only in one
  line can look very similar.
* **Structure, not semantics.** Reordering independent statements, inlining/outlining functions or re-implementing the
  same algorithm differently defeats it. Macros (`#define`) are not expanded. Only same-language pairs are compared.
* **Rule checks are static.** They see the call, not what a string passed to `exec` does, and `eval`/dynamic imports are
  only medium findings. Real containment of untrusted code is the judge's job (see `judge-backends.md`).
* Syntax-error programs are still analysed (tree-sitter recovers), but `hasSyntaxErrors` is recorded in the metrics.

## Deploying safely

Findings live in their own table (`SubmissionCheatFlag`: no foreign keys, no column added to `Submission`). The migration
(`packages/db/prisma/migrations/20261114000000_add_submission_cheat_flags`) is purely additive, so code that contains this feature can be
deployed *before* `pnpm db:migrate:deploy` has run: no existing query touches the new table, and the one anti-cheat write fails quietly
(it is wrapped and logged) until the migration is applied. Run the migration on the production database to switch the recording on.
