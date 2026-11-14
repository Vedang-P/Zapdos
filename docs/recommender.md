# Problem recommender (retrieval-augmented)

`GET /api/recommendations?limit=5` returns problems the signed-in user has not solved, ranked by similarity to the
problems they struggled with, diversified, and each explained with a rationale grounded in that evidence.
The same list is shown as a "Recommended for you" card on the dashboard.

```
 submissions + match progress ──► history ──► profile vector      (what does this user struggle with?)
                                                   │
 240 problems ─► hashed TF-IDF embeddings ─► cosine index ─► top-30 unsolved ─► ELO penalty ─► MMR top-k   ◄─ RETRIEVAL
                                                   │
 evidence (failed/solved problems, similarity, shared terms) ──► rationale (template | optional LLM)      ◄─ GENERATION
```

Code: [`apps/web/lib/recommender/`](../apps/web/lib/recommender) · route: [`app/api/recommendations/route.ts`](../apps/web/app/api/recommendations/route.ts)

## Corpus: 240 real Codeforces problems

`apps/web/scripts/download-codeforces.py` streams the `open-r1/codeforces` dataset from Hugging Face, keeps problems
rated 800-1200 with stdio input, no interactor/checker and at least 5 official tests, and `pnpm import-codeforces`
loads them. The limit used to be a hard-coded 200; it is now `CF_PROBLEM_LIMIT` (default **240**). Paths are
overridable (`CF_OUTPUT_PATH` / `CF_PROBLEMS_PATH`, defaults unchanged).

| | |
|---|---|
| problems in Postgres | **240** (all `EASY`: ratings 800-1200) |
| test cases | 7,745 (411 visible samples, 7,334 hidden) |
| download | streamed, early stop after 1,878 rows scanned, 199 s, 19.5 MB JSON (`columns=` projection skips unused heavy columns) |

```bash
pip install datasets
CF_PROBLEM_LIMIT=240 CF_SCAN_FACTOR=1 python3 apps/web/scripts/download-codeforces.py   # writes /tmp/cf_problems.json
pnpm --filter web import-codeforces
```

`CF_SCAN_FACTOR=1` keeps the first 240 qualifying problems. The default (3) scans three times as many and keeps the 240 with
the most tests, which streams about three times the data. Set `CF_STREAMING=0` to download the whole split like the original script.

## Embeddings: deterministic, local, 384-d

`embedding.ts` + `text.ts`. For each problem: strip math/code/links, lower-case, drop stop-words and recurring
character names (Vasya, Petya, ...), light stemming (`palindromes` -> `palindrome`, but `string` stays `string`),
then **unigrams and bigrams** weighted by sublinear TF x IDF (IDF fitted on the corpus). Features are mapped into 384
buckets with a signed hash (**feature hashing**, FNV-1a) and L2-normalised, so cosine similarity is a dot product.

Why hashing instead of a neural embedding: no model download, no network, no API key, runs inside a serverless
function, and the output is byte-for-byte reproducible. The price is that the vectors are **lexical** - see Limits.

Bigrams contribute at 0.15 of a unigram's weight. That value was chosen from a small search on the offline evaluation
below (same tags used for scoring, so treat the lift as indicative):

| variant | P@5 any tag | P@5 specific tag |
|---|---|---|
| bigrams full weight, names kept | 0.578 | 0.128 |
| bigrams full weight, names stopped | 0.583 | 0.134 |
| no bigrams | 0.569 | 0.181 |
| bigram weight 0.5 | 0.588 | 0.167 |
| bigram weight 0.3 | 0.583 | 0.169 |
| **bigram weight 0.15 (shipped)** | **0.583** | **0.178** |

## Retrieval

* **Profile** (`retrieval.ts`): a weighted sum of the vectors of the problems in the user's history. A problem the user
  failed weighs `1 + 0.5 x wrong submissions` (capped at 6); one solved after struggling `0.4 + 0.4 x wrong`; a clean
  solve `0.2`. Weights halve every 45 days.
* **Exclusion**: solved problems are never recommended; attempted-but-unsolved ones are not re-recommended either.
* **Cold start** (no history): the corpus centroid stands in for the profile, so the user gets diversified "starter
  picks".
* **ELO window**: a soft penalty `0.12 x |problem level - target level|` where the target level rises from 0 (EASY) at
  ELO 1000 to 2 (HARD) at ELO 1800. It is a no-op on today's corpus because every imported problem is `EASY`; it
  activates as soon as MEDIUM/HARD problems exist.
* **MMR** (lambda 0.7): from the 30 best candidates repeatedly pick the one maximising
  `0.7 x relevance - 0.3 x (highest similarity to what is already chosen)`.
* Index: built lazily from Postgres on first use (cached 10 minutes, rebuilt when the problem set changes); optional
  Redis cache of the vectors (`RECOMMENDER_REDIS_CACHE=1`) so a cold serverless instance skips reading every statement.

## Generation (the "A" in RAG)

Each recommendation carries an *evidence record*: the up-to-3 history problems that drove the match (title, outcome, wrong
submissions, similarity) and the key terms they share. The rationale is generated **only from that record**:

* **Template (default, the no-API-key workaround)**: *"Recommended because you got stuck on "X" (3 wrong submissions);
  "Y" matches those problems (similarity 0.41). Key ideas in common: parity, modulo."*
* **LLM (optional)**: with `RECOMMENDER_LLM_URL` + `RECOMMENDER_LLM_API_KEY` (any OpenAI-compatible chat endpoint,
  `RECOMMENDER_LLM_MODEL` default `gpt-4o-mini`) the same evidence is sent to the model, which may only explain the
  retrieved problems. The reply is validated: it must be a JSON object keyed by the retrieved problem ids, each text
  <= 500 chars, and it must not mention the title of any *other* corpus problem. Anything else (timeout, bad JSON,
  an invented problem) silently falls back to the template. The LLM never chooses problems.

## API

```jsonc
GET /api/recommendations?limit=3        // session cookie required (401 otherwise); limit 1-20, default 5
{
  "coldStart": false, "elo": 1200,
  "recommendations": [{
    "rank": 1,
    "problem": { "id": "...", "slug": "cf-1234-B", "title": "...", "difficulty": "EASY", "points": 100 },
    "score": 0.41, "similarity": 0.41,
    "rationale": "Recommended because you got stuck on ...", "rationaleSource": "template",
    "because": [{ "problemId": "...", "title": "...", "outcome": "failed", "wrongSubmissions": 3, "similarity": 0.52 }],
    "sharedTerms": ["parity", "modulo"]
  }],
  "meta": { "indexSize": 240, "indexSource": "database", "indexBuildMs": 114.1, "queryMs": 1.2, "mmrLambda": 0.7, "historyEntries": 4, "llm": false }
}
```

## Offline evaluation (real corpus)

`pnpm --filter web eval:recommender` (needs the imported problems and the downloaded JSON for tags). Codeforces tags are
**never** fed to the embedder; they are only the answer key: a neighbour is "relevant" if it shares a tag with the query
problem. The random baseline is the exact expectation for 5 problems drawn uniformly at random.

| metric (240 queries, k = 5) | recommender | random baseline | lift |
|---|---|---|---|
| precision@5, shares **any** tag | 0.583 | 0.525 | 1.11x |
| precision@5, shares a **specific** tag (ignoring the 3 most common: implementation, math, greedy; 127 queries) | **0.178** | 0.106 | **1.68x** |
| mean tag Jaccard of the top 5 | 0.283 | 0.247 | 1.15x |
| with MMR (lambda 0.7): specific-tag P@5 / intra-list similarity | 0.156 / 0.151 | - | list is 25% less redundant (0.201 -> 0.151) |

| performance | value |
|---|---|
| index build (Postgres read of all statements + IDF fit + embed 240 problems), median of 5 | **114 ms** |
| `recommend()` end to end, 1,000 synthetic users, in-memory repository | p50 **0.71 ms**, p95 2.35 ms, p99 4.38 ms, max 7.83 ms |

(The latency run shared the machine with an iCloud sync storm, so these are pessimistic.)

## Limits - say these out loud

* **Lexical, not semantic.** Two problems about the same idea in different words are not close; the lift over random is
  real but modest (1.1x on any tag, 1.7x on specific tags). A sentence-embedding model would do better and could replace
  `Embedder` behind the same interface.
* **Tags are a proxy.** "Shares a tag" is a reasonable offline label, not proof that users learn more; there is no online
  A/B test.
* **Small corpus, all EASY.** Everything is rated 800-1200, so the ELO window is inert and recommendations are about topic,
  not difficulty progression.
* **Cold start** gets starter picks, not personalisation; a user needs a few submissions before the profile means anything.
* The embedding variant (bigram weight, name stop-list) was selected on the same tags used for scoring, from six variants.

## Tests

`apps/web/lib/recommender/recommender.test.ts` (25 unit tests: determinism and normalisation, IDF behaviour, cosine and
MMR, profile weighting and decay, template cites the evidence, LLM output validation and fallback, caching, service end
to end) and `recommender.integration.test.ts` (real corpus; skipped when Postgres is unreachable; asserts the corpus has
more than 200 problems). Run: `pnpm test`.
