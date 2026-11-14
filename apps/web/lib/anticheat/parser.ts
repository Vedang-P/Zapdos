/**
 * tree-sitter (WASM) parsers for the three judged languages.
 *
 * `web-tree-sitter` runs the real tree-sitter runtime compiled to WebAssembly and `tree-sitter-wasms` ships the
 * prebuilt C++ / Python / Java grammars, so the server gets genuine concrete syntax trees with no native build step
 * (which matters on Vercel / Render).  Runtime and grammars are loaded once per process and reused.
 *
 * File location: bundlers rewrite `require.resolve`, so the grammar directory is found by walking up from the
 * working directory (same approach as the Vercel sandbox loader in `@zapdos/judge`).  Override with
 * `ANTICHEAT_WASM_DIR`.  `next.config.mjs` lists the three .wasm files in `outputFileTracingIncludes` so they are
 * shipped with serverless functions.
 */

import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Parser from 'web-tree-sitter';
import type { AntiCheatLanguage } from './types';

const GRAMMAR_FILE: Record<AntiCheatLanguage, string> = {
  cpp: 'tree-sitter-cpp.wasm',
  python: 'tree-sitter-python.wasm',
  java: 'tree-sitter-java.wasm',
};

/** `<dir>/node_modules/.pnpm/<pkg>@<version>/node_modules/<pkg>/<inner>` for every installed version of `pkg`. */
function pnpmStoreCandidates(dir: string, pkg: string, inner: string): string[] {
  const store = join(dir, 'node_modules', '.pnpm');
  try {
    return readdirSync(store)
      .filter((entry) => entry.startsWith(`${pkg}@`))
      .map((entry) => join(store, entry, 'node_modules', pkg, inner));
  } catch {
    return [];
  }
}

function searchUp(relative: string[], marker: string, store?: { pkg: string; inner: string }): string | null {
  const override = process.env.ANTICHEAT_WASM_DIR;
  if (override && existsSync(join(override, marker))) return override;
  let dir = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    const candidates = relative.map((rel) => join(dir, rel));
    // A traced serverless bundle keeps pnpm's store layout and may not keep the symlinks into it.
    if (store) candidates.push(...pnpmStoreCandidates(dir, store.pkg, store.inner));
    for (const candidate of candidates) {
      if (existsSync(join(candidate, marker))) return candidate;
    }
    dir = dirname(dir);
  }
  return null;
}

/** Directory holding the prebuilt grammar .wasm files. */
export function grammarDirectory(): string {
  const found = searchUp(
    [
      'node_modules/tree-sitter-wasms/out',
      'apps/web/node_modules/tree-sitter-wasms/out',
      'web/node_modules/tree-sitter-wasms/out',
    ],
    GRAMMAR_FILE.python,
    { pkg: 'tree-sitter-wasms', inner: 'out' },
  );
  if (!found) {
    throw new Error('tree-sitter grammars not found; install tree-sitter-wasms or set ANTICHEAT_WASM_DIR');
  }
  return found;
}

function runtimeDirectory(): string | null {
  return searchUp(
    ['node_modules/web-tree-sitter', 'apps/web/node_modules/web-tree-sitter', 'web/node_modules/web-tree-sitter'],
    'tree-sitter.wasm',
    { pkg: 'web-tree-sitter', inner: '' },
  );
}

/**
 * Grammars are loaded together, once, in this order - C++ LAST.
 *
 * Measured with web-tree-sitter 0.22.6: the first `Language.load` that happens *after* the (4.6 MB) C++ grammar has
 * been linked takes ~6 seconds, whichever grammar it is (python-after-cpp, java-after-cpp ...), while every other
 * load takes 1-50 ms.  Loading lazily per language would therefore stall the first submission that happens to
 * arrive in the "wrong" order.  Loading all three up front with C++ last costs ~15 ms in total and removes the
 * order dependence.
 */
const LOAD_ORDER: readonly AntiCheatLanguage[] = ['python', 'java', 'cpp'];

let initPromise: Promise<void> | null = null;
let grammarsPromise: Promise<Map<AntiCheatLanguage, Parser.Language>> | null = null;
const parsers = new Map<AntiCheatLanguage, Parser>();

function initRuntime(): Promise<void> {
  if (!initPromise) {
    const runtime = runtimeDirectory();
    initPromise = Parser.init(
      runtime ? { locateFile: (name: string) => join(runtime, name) } : undefined,
    ).catch((error: unknown) => {
      initPromise = null; // allow a retry on the next call
      throw error;
    });
  }
  return initPromise;
}

function loadGrammars(): Promise<Map<AntiCheatLanguage, Parser.Language>> {
  if (!grammarsPromise) {
    grammarsPromise = (async () => {
      await initRuntime();
      const directory = grammarDirectory();
      const loaded = new Map<AntiCheatLanguage, Parser.Language>();
      for (const language of LOAD_ORDER) {
        loaded.set(language, await Parser.Language.load(join(directory, GRAMMAR_FILE[language])));
      }
      return loaded;
    })().catch((error: unknown) => {
      grammarsPromise = null; // allow a retry on the next call
      throw error;
    });
  }
  return grammarsPromise;
}

async function parserFor(language: AntiCheatLanguage): Promise<Parser> {
  const grammars = await loadGrammars();
  let parser = parsers.get(language);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(grammars.get(language) as Parser.Language);
    parsers.set(language, parser);
  }
  return parser;
}

/** Load the WASM runtime and all grammars now (call at server start to keep the first submission fast). */
export async function warmUpParsers(): Promise<void> {
  await loadGrammars();
}

/**
 * Parse `code` and hand the tree to `use`.  The WASM-side tree is freed afterwards, so nodes must not escape the
 * callback.  `parse` itself is synchronous, so a shared parser instance is safe in Node's single thread.
 */
export async function withTree<T>(
  language: AntiCheatLanguage,
  code: string,
  use: (root: Parser.SyntaxNode) => T,
): Promise<T> {
  const parser = await parserFor(language);
  const tree = parser.parse(code);
  try {
    return use(tree.rootNode);
  } finally {
    tree.delete();
  }
}

export type SyntaxNode = Parser.SyntaxNode;
