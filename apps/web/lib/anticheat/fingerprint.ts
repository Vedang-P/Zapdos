/**
 * Structural fingerprints of a program, robust to renaming and reformatting.
 *
 * Pipeline: concrete syntax tree -> *normalised node-type sequence* -> k-gram hashes -> winnowing (Schleimer,
 * Wilkerson & Aiken, "Winnowing: Local Algorithms for Document Fingerprinting", SIGMOD 2003 - the algorithm behind MOSS).
 *
 * Normalisation throws away what a cheater can change for free and keeps what they cannot:
 *   - identifiers (variable / function / class names)  -> `ID`      (renaming does nothing)
 *   - numeric / string / char literals and booleans     -> `NUM`/`STR` (changing constants does nothing)
 *   - comments, imports, #include, `using`, `package`   -> dropped
 *   - parentheses                                       -> transparent
 *   - `for` / `while` / `do` / range-for                -> `LOOP`   (rewriting one loop form as another does nothing)
 *   - whitespace and layout                             -> never part of the tree
 *   - operators of binary/unary/assignment nodes        -> KEPT (`a + b` and `a * b` are different programs)
 * What remains is the program's control-flow and expression skeleton.
 */

import type { AntiCheatLanguage, ComparisonResult } from './types';
import type { SyntaxNode } from './parser';

/** k-gram length and winnowing window: any shared run of >= K + W - 1 = 8 tokens is guaranteed to be detected. */
export const K = 5;
export const W = 4;
/** Below this many fingerprints a program is too small for a similarity score to mean anything (e.g. `print(a+b)`). */
export const MIN_FINGERPRINTS = 12;
const MAX_TOKENS = 30_000;

const DROP: Record<AntiCheatLanguage, ReadonlySet<string>> = {
  cpp: new Set([
    'comment', 'preproc_include', 'preproc_def', 'preproc_function_def', 'preproc_call', 'preproc_ifdef',
    'preproc_if', 'preproc_else', 'preproc_elif', 'using_declaration', 'namespace_alias_definition',
  ]),
  python: new Set(['comment', 'import_statement', 'import_from_statement', 'future_import_statement']),
  java: new Set(['line_comment', 'block_comment', 'import_declaration', 'package_declaration']),
};

const IDENTIFIER: Record<AntiCheatLanguage, ReadonlySet<string>> = {
  cpp: new Set(['identifier', 'field_identifier', 'namespace_identifier', 'statement_identifier', 'qualified_identifier', 'destructor_name', 'operator_name', 'this']),
  python: new Set(['identifier']),
  java: new Set(['identifier', 'scoped_identifier', 'this']),
};

const TYPE_LEAF: Record<AntiCheatLanguage, ReadonlySet<string>> = {
  cpp: new Set(['primitive_type', 'sized_type_specifier', 'type_identifier', 'placeholder_type_specifier', 'auto']),
  python: new Set(),
  java: new Set(['integral_type', 'floating_point_type', 'boolean_type', 'void_type', 'type_identifier', 'scoped_type_identifier']),
};

const STRING_LIKE = new Set([
  'string_literal', 'raw_string_literal', 'char_literal', 'character_literal', 'string', 'concatenated_string', 'text_block',
]);
const CONSTANT_WORDS = new Set(['true', 'false', 'null', 'nullptr', 'none', 'None', 'null_literal']);
const LOOPS = new Set(['for_statement', 'while_statement', 'do_statement', 'for_range_loop', 'enhanced_for_statement']);
/** Nodes whose meaning depends on an operator symbol that tree-sitter keeps as an anonymous child. */
const OPERATOR_NODES = new Set([
  'binary_expression', 'unary_expression', 'assignment_expression', 'update_expression', 'compound_assignment_expr',
  'binary_operator', 'unary_operator', 'boolean_operator', 'augmented_assignment', 'comparison_operator',
]);

function isNumberLike(type: string): boolean {
  return (
    type === 'number_literal' || type === 'integer' || type === 'float' ||
    (type.endsWith('_literal') && !STRING_LIKE.has(type))
  );
}

/** True for `a.b.c`-style member chains made only of plain names (Java field_access, Python attribute, C++ field_expression). */
function isNameChain(node: SyntaxNode): boolean {
  const type = node.type;
  if (type === 'identifier' || type === 'field_identifier') return true;
  let objectField: string;
  let nameField: string;
  if (type === 'field_access') { objectField = 'object'; nameField = 'field'; }
  else if (type === 'attribute') { objectField = 'object'; nameField = 'attribute'; }
  else if (type === 'field_expression') { objectField = 'argument'; nameField = 'field'; }
  else return false;
  const object = node.childForFieldName(objectField);
  const name = node.childForFieldName(nameField);
  return !!object && !!name && isNameChain(object) && (name.type === 'identifier' || name.type === 'field_identifier');
}

function operatorOf(node: SyntaxNode): string {
  const field = node.childForFieldName('operator');
  if (field) return field.type;
  if (node.type === 'comparison_operator') {
    // python chains: `a < b <= c` keeps several operator tokens
    const symbols: string[] = [];
    for (let i = 0; i < node.childCount; i += 1) {
      const child = node.child(i);
      if (child && !child.isNamed) symbols.push(child.type);
    }
    return symbols.join('');
  }
  return '';
}

/** The normalised node-type sequence of a parsed program. */
export function normalizedTokens(root: SyntaxNode, language: AntiCheatLanguage): string[] {
  const drop = DROP[language];
  const identifiers = IDENTIFIER[language];
  const types = TYPE_LEAF[language];
  const tokens: string[] = [];

  const visit = (node: SyntaxNode): void => {
    if (tokens.length >= MAX_TOKENS) return;
    const type = node.type;
    if (drop.has(type)) return;
    if (type === 'parenthesized_expression') {
      for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (child) visit(child);
      }
      return;
    }
    if (STRING_LIKE.has(type)) { tokens.push('STR'); return; }
    if (isNumberLike(type) || CONSTANT_WORDS.has(type)) { tokens.push('NUM'); return; }
    // `std::vector<int>` must look like `vector<int>`: unwrap the qualifier, keep the template structure.
    if (language === 'cpp' && type === 'qualified_identifier') {
      const name = node.childForFieldName('name');
      if (name && (name.type === 'template_type' || name.type === 'template_function')) {
        visit(name);
      } else {
        tokens.push('ID');
      }
      return;
    }
    // `java.util.Arrays`, `sys.stdin.readline`, `obj.field`: a pure chain of names is just a name.
    if (isNameChain(node)) { tokens.push('ID'); return; }
    if (identifiers.has(type)) { tokens.push('ID'); return; }
    if (types.has(type)) { tokens.push('TYPE'); return; }
    if (LOOPS.has(type)) {
      tokens.push('LOOP');
    } else if (OPERATOR_NODES.has(type)) {
      tokens.push(`${type}:${operatorOf(node)}`);
    } else {
      tokens.push(type);
    }
    for (let i = 0; i < node.namedChildCount; i += 1) {
      const child = node.namedChild(i);
      if (child) visit(child);
    }
  };

  visit(root);
  return tokens;
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Winnowing: hash every k-gram, slide a window of `w` hashes, keep the minimum of each window (rightmost on ties).
 * Guarantees that any common substring of at least `k + w - 1` tokens contributes a shared fingerprint, while
 * keeping only ~2/(w+1) of all k-grams.
 */
export function winnow(tokens: readonly string[], k = K, w = W): number[] {
  if (tokens.length === 0) return [];
  if (tokens.length < k) return [fnv1a(tokens.join('\u0001'))];
  const grams: number[] = [];
  for (let i = 0; i + k <= tokens.length; i += 1) grams.push(fnv1a(tokens.slice(i, i + k).join('\u0001')));
  if (grams.length <= w) return [Math.min(...grams)];

  const picked: number[] = [];
  let lastPosition = -1;
  for (let start = 0; start + w <= grams.length; start += 1) {
    let minimum = start;
    for (let j = start + 1; j < start + w; j += 1) {
      if ((grams[j] as number) <= (grams[minimum] as number)) minimum = j;
    }
    if (minimum !== lastPosition) {
      picked.push(grams[minimum] as number);
      lastPosition = minimum;
    }
  }
  return picked;
}

export function uniqueSorted(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/** Compare two fingerprint sets. */
export function compareFingerprints(a: readonly number[], b: readonly number[]): ComparisonResult {
  const setA = new Set(a);
  const setB = new Set(b);
  let shared = 0;
  const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  for (const value of small) if (large.has(value)) shared += 1;
  const union = setA.size + setB.size - shared;
  const smaller = Math.min(setA.size, setB.size);
  const jaccard = union === 0 ? 0 : shared / union;
  const containment = smaller === 0 ? 0 : shared / smaller;
  return {
    similarity: jaccard,
    jaccard,
    containment,
    sharedFingerprints: shared,
    fingerprintsA: setA.size,
    fingerprintsB: setB.size,
    comparable: setA.size >= MIN_FINGERPRINTS && setB.size >= MIN_FINGERPRINTS,
  };
}
