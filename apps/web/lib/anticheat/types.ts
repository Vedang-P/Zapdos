/** Shared types for the AST anti-cheat module (see docs/anticheat.md). */

export type AntiCheatLanguage = 'cpp' | 'python' | 'java';

export const ANTICHEAT_LANGUAGES: readonly AntiCheatLanguage[] = ['cpp', 'python', 'java'];

export function isAntiCheatLanguage(value: string): value is AntiCheatLanguage {
  return (ANTICHEAT_LANGUAGES as readonly string[]).includes(value);
}

export type Severity = 'high' | 'medium' | 'low';

export type FlagType =
  | 'forbidden_call' // process spawn, sockets, dynamic loading, eval/exec ... found as a real call node
  | 'forbidden_import' // importing a networking / process module
  | 'file_access' // opening files from inside the judge
  | 'hardcoded_output' // prints constant output and never reads the input
  | 'lookup_chain' // many `if (x == literal) print(literal)` branches: an answer table in disguise
  | 'large_literal_table' // one huge literal collection (possible embedded answers)
  | 'similarity' // fingerprint similarity with another player's accepted code
  | 'containment'; // one program is (nearly) a subset of another: padding / dead-code attack

export interface CheatFlag {
  type: FlagType;
  severity: Severity;
  detail: string;
  /** 1-based source line of the offending node, when there is one. */
  line?: number;
  /** The matched callee / import / snippet (never the whole program). */
  evidence?: string;
}

export interface SubmissionMetrics {
  language: AntiCheatLanguage;
  nodeCount: number;
  /** Length of the normalised node-type sequence the fingerprints are computed from. */
  tokenCount: number;
  fingerprintCount: number;
  loops: number;
  recursion: boolean;
  readsInput: boolean;
  outputStatements: number;
  /** Output statements whose arguments contain no identifier at all (pure literals). */
  literalOnlyOutputs: number;
  /** `x == literal` comparisons and `case literal:` labels. */
  literalBranches: number;
  /** Largest number of literal elements in a single array / list / dict / initializer. */
  maxLiteralCollection: number;
  hasSyntaxErrors: boolean;
  /** Wall time spent parsing + analysing + fingerprinting, in milliseconds. */
  analysisMs: number;
}

export interface Analysis {
  flags: CheatFlag[];
  metrics: SubmissionMetrics;
  /** Winnowed fingerprint set of the normalised AST (hash values). */
  fingerprints: number[];
}

export interface ComparisonResult {
  /** Headline score in [0, 1]: Jaccard similarity of the two winnowed fingerprint sets. */
  similarity: number;
  jaccard: number;
  /** |A ∩ B| / min(|A|, |B|): high when one program is nearly contained in the other. */
  containment: number;
  sharedFingerprints: number;
  fingerprintsA: number;
  fingerprintsB: number;
  /** False when either program is too small for a similarity score to mean anything. */
  comparable: boolean;
}

export interface SimilarSubmission {
  submissionId: string;
  userId: string;
  sameMatch: boolean;
  similarity: number;
  containment: number;
}

/** What is persisted in `SubmissionCheatFlag.flags`. */
export interface StoredCheatFlags {
  version: 1;
  flags: CheatFlag[];
  similar: SimilarSubmission[];
  metrics: Pick<
    SubmissionMetrics,
    'tokenCount' | 'fingerprintCount' | 'loops' | 'readsInput' | 'outputStatements' | 'literalOnlyOutputs' | 'literalBranches' | 'maxLiteralCollection'
  >;
}
