/**
 * The "generation" half of the recommender (RAG): explain each retrieved problem using only the evidence that
 * retrieval produced.
 *
 * Two generators share one contract:
 * - a deterministic template that cites exactly the evidence (always available - the no-API-key workaround);
 * - an optional OpenAI-compatible LLM call that is handed the same evidence and may only *explain* the retrieved
 *   problems. Its output is validated: it must map retrieved problem ids to short strings and must not mention any
 *   other problem title from the corpus; anything else falls back to the template.
 */

export interface EvidenceItem {
  problemId: string;
  title: string;
  outcome: 'solved' | 'failed';
  wrongSubmissions: number;
  /** Cosine similarity between the recommended problem and this history problem. */
  similarity: number;
}

export interface RecommendationEvidence {
  problemId: string;
  title: string;
  difficulty: string;
  similarity: number;
  because: EvidenceItem[];
  sharedTerms: string[];
  coldStart: boolean;
  elo: number;
}

export type RationaleSource = 'template' | 'llm';

export interface Rationale {
  text: string;
  source: RationaleSource;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function describe(item: EvidenceItem): string {
  if (item.outcome === 'failed') {
    return item.wrongSubmissions > 0
      ? `you got stuck on "${item.title}" (${plural(item.wrongSubmissions, 'wrong submission')})`
      : `you attempted "${item.title}" without solving it`;
  }
  return item.wrongSubmissions > 0
    ? `you needed ${plural(item.wrongSubmissions + 1, 'try')} to solve "${item.title}"`
    : `you solved "${item.title}"`;
}

/** Deterministic rationale that cites exactly the retrieval evidence. */
export function templateRationale(evidence: RecommendationEvidence): string {
  const terms = evidence.sharedTerms.slice(0, 4);
  const termText = terms.length > 0 ? ` Key ideas in common: ${terms.join(', ')}.` : '';
  if (evidence.coldStart || evidence.because.length === 0) {
    return (
      `Starter pick for a rating around ${Math.round(evidence.elo)}: "${evidence.title}" ` +
      `(${evidence.difficulty.toLowerCase()}) is representative of the problem set.${terms.length > 0 ? ` Topics: ${terms.join(', ')}.` : ''}`
    );
  }
  const reasons = joinList(evidence.because.map(describe));
  return (
    `Recommended because ${reasons}; "${evidence.title}" matches those problems ` +
    `(similarity ${evidence.similarity.toFixed(2)}).${termText}`
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Optional LLM generation
// ---------------------------------------------------------------------------------------------------------------

export interface LlmConfig {
  /** Chat-completions endpoint, or an API base ending in /v1 (then /chat/completions is appended). */
  url: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export function llmConfigFromEnv(env: Record<string, string | undefined> = process.env): LlmConfig | null {
  const url = env.RECOMMENDER_LLM_URL?.trim();
  const apiKey = env.RECOMMENDER_LLM_API_KEY?.trim();
  if (!url || !apiKey) return null;
  return {
    url: /\/chat\/completions\/?$/.test(url) ? url : `${url.replace(/\/+$/, '')}/chat/completions`,
    apiKey,
    model: env.RECOMMENDER_LLM_MODEL?.trim() || 'gpt-4o-mini',
    timeoutMs: Number(env.RECOMMENDER_LLM_TIMEOUT_MS ?? 5000) || 5000,
  };
}

const SYSTEM_PROMPT =
  'You explain programming-problem recommendations. You are given JSON evidence for each recommended problem: ' +
  'the problems the learner struggled with or solved, the similarity, and shared key terms. ' +
  'Reply with ONE JSON object mapping each problemId to a one- or two-sentence explanation (max 300 characters). ' +
  'Use ONLY the supplied evidence. Never mention, invent or recommend any problem that is not in the evidence.';

function parseJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    const value: unknown = JSON.parse(cleaned);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Ask the LLM to explain the retrieved problems. Returns only the explanations that pass validation; the caller
 * fills the rest from the template. Never throws.
 */
export async function llmRationales(
  evidence: readonly RecommendationEvidence[],
  corpusTitles: ReadonlySet<string>,
  config: LlmConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, string>> {
  const accepted = new Map<string, string>();
  if (evidence.length === 0) return accepted;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(config.url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        max_tokens: 150 * evidence.length,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify({ recommendations: evidence }) },
        ],
      }),
    });
    if (!response.ok) return accepted;
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const parsed = parseJsonObject(body.choices?.[0]?.message?.content ?? '');
    if (!parsed) return accepted;

    for (const item of evidence) {
      const text = parsed[item.problemId];
      if (typeof text !== 'string' || text.trim().length === 0 || text.length > 500) continue;
      // Grounding check: the text may name this problem and its own evidence, but no other corpus problem.
      const allowed = new Set([item.title, ...item.because.map((b) => b.title)]);
      const invented = [...corpusTitles].some((title) => title.length >= 8 && !allowed.has(title) && text.includes(title));
      if (!invented) accepted.set(item.problemId, text.trim());
    }
  } catch {
    // timeout, network error, bad JSON: the template covers everything
  } finally {
    clearTimeout(timer);
  }
  return accepted;
}

export async function generateRationales(
  evidence: readonly RecommendationEvidence[],
  options: { llm?: LlmConfig | null; corpusTitles?: ReadonlySet<string>; fetchImpl?: typeof fetch } = {},
): Promise<Map<string, Rationale>> {
  const result = new Map<string, Rationale>();
  for (const item of evidence) result.set(item.problemId, { text: templateRationale(item), source: 'template' });
  if (options.llm) {
    const generated = await llmRationales(evidence, options.corpusTitles ?? new Set(), options.llm, options.fetchImpl);
    for (const [id, text] of generated) result.set(id, { text, source: 'llm' });
  }
  return result;
}
