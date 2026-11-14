/**
 * AST-based anti-cheat.
 *
 *   analyzeSubmission(language, code)      -> { flags, metrics, fingerprints }
 *   compareSubmissions(language, a, b)     -> { similarity, jaccard, containment, ... }
 *
 * Both parse with tree-sitter (real syntax trees for C++, Python and Java).  Nothing here touches the database;
 * `service.ts` wires it into the submit route.  See docs/anticheat.md.
 */

import { compareFingerprints, normalizedTokens, uniqueSorted, winnow } from './fingerprint';
import { withTree } from './parser';
import { DEFAULT_THRESHOLDS, collectFacts, deriveFlags, type Thresholds } from './rules';
import type { Analysis, AntiCheatLanguage, ComparisonResult } from './types';

export * from './types';
export { compareFingerprints, MIN_FINGERPRINTS } from './fingerprint';
export { DEFAULT_THRESHOLDS } from './rules';

/** Parse one submission and return rule findings, structural metrics and its winnowed fingerprint set. */
export async function analyzeSubmission(
  language: AntiCheatLanguage,
  code: string,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): Promise<Analysis> {
  const started = performance.now();
  return withTree(language, code, (root) => {
    const facts = collectFacts(root, language);
    const tokens = normalizedTokens(root, language);
    const fingerprints = uniqueSorted(winnow(tokens));
    return {
      flags: deriveFlags(facts, language, thresholds),
      fingerprints,
      metrics: {
        language,
        nodeCount: facts.nodeCount,
        tokenCount: tokens.length,
        fingerprintCount: fingerprints.length,
        loops: facts.loops,
        recursion: facts.recursion,
        readsInput: facts.readsInput,
        outputStatements: facts.outputStatements,
        literalOnlyOutputs: facts.literalOnlyOutputs,
        literalBranches: facts.literalBranches,
        maxLiteralCollection: facts.maxLiteralCollection,
        hasSyntaxErrors: facts.hasSyntaxErrors,
        analysisMs: performance.now() - started,
      },
    };
  });
}

/** Structural similarity of two submissions in the same language (1.0 = identical normalised ASTs). */
export async function compareSubmissions(language: AntiCheatLanguage, a: string, b: string): Promise<ComparisonResult> {
  const [first, second] = await Promise.all([analyzeSubmission(language, a), analyzeSubmission(language, b)]);
  return compareFingerprints(first.fingerprints, second.fingerprints);
}
