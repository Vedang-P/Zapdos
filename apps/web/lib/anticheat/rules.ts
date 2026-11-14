/**
 * Rule checks on the syntax tree.
 *
 * Every rule looks at *node types*, never at raw text, so a forbidden name inside a string or a comment is not a
 * finding, while a real call is - however it is spaced, qualified or aliased (`import subprocess as sp; sp.run(...)`).
 * Names the submission defines itself are ignored (a union-find `connect(u, v)` is not a socket call).
 */

import type { AntiCheatLanguage, CheatFlag, FlagType, Severity } from './types';
import type { SyntaxNode } from './parser';

export interface Facts {
  nodeCount: number;
  loops: number;
  recursion: boolean;
  readsInput: boolean;
  outputStatements: number;
  literalOnlyOutputs: number;
  literalBranches: number;
  maxLiteralCollection: number;
  hasSyntaxErrors: boolean;
  /** Findings that do not depend on the whole file (imports, file streams). */
  flags: CheatFlag[];
  /** Calls to check against the forbidden-name rules once every definition and import alias is known. */
  pendingCalls: Array<{ name: string; line: number }>;
  definedFunctions: Set<string>;
  moduleAliases: Map<string, string>;
  fromImports: Map<string, string>;
}

interface Rule {
  pattern: RegExp;
  type: FlagType;
  severity: Severity;
  why: string;
}

const rule = (pattern: RegExp, type: FlagType, severity: Severity, why: string): Rule => ({ pattern, type, severity, why });

const CALL_RULES: Record<AntiCheatLanguage, Rule[]> = {
  cpp: [
    rule(/^(?:std::|::)?(?:system|popen|pclose|fork|vfork|execl|execlp|execle|execv|execvp|execve|execvpe|posix_spawn|posix_spawnp|waitpid|ptrace|dlopen|dlsym|syscall|socket|connect|bind|listen|accept|getaddrinfo|gethostbyname|setuid|setgid|chroot|clone)$/, 'forbidden_call', 'high', 'spawns a process, opens a network connection or escalates privileges'),
    rule(/^(?:std::|::)?(?:fopen|freopen|open|openat|creat|remove|unlink|rename|mkdir|rmdir|opendir|ifstream|ofstream|fstream|getenv)$/, 'file_access', 'medium', 'touches the filesystem or environment of the judge'),
  ],
  python: [
    rule(/^os\.(?:system|popen|exec\w*|spawn\w*|fork|forkpty|kill|killpg|setuid|chroot)$/, 'forbidden_call', 'high', 'spawns a process or signals one'),
    rule(/^(?:subprocess|socket|ctypes|pty|importlib|urllib|requests|httpx|http|ftplib|smtplib|telnetlib|paramiko|asyncio\.subprocess)\./, 'forbidden_call', 'high', 'process, network or foreign-code access'),
    rule(/^(?:exec|__import__|compile)$/, 'forbidden_call', 'high', 'executes dynamically built code'),
    rule(/^eval$/, 'forbidden_call', 'medium', 'evaluates dynamically built code'),
    rule(/^multiprocessing\./, 'forbidden_call', 'medium', 'spawns processes'),
    rule(/^(?:open|io\.open|os\.(?:remove|unlink|rmdir|rename|listdir|walk|chdir|getenv)|shutil\.\w+)$/, 'file_access', 'medium', 'touches the filesystem or environment of the judge'),
  ],
  java: [
    rule(/^Runtime\.getRuntime\(\)\.(?:exec|load|loadLibrary|halt)$/, 'forbidden_call', 'high', 'spawns a process or loads native code'),
    rule(/^System\.(?:load|loadLibrary|setSecurityManager)$/, 'forbidden_call', 'high', 'loads native code or changes the security manager'),
    rule(/^(?:ProcessBuilder|Socket|ServerSocket|DatagramSocket|URL|HttpURLConnection|HttpClient|InetSocketAddress|ScriptEngineManager)$/, 'forbidden_call', 'high', 'spawns a process or opens a network connection'),
    rule(/^Class\.forName$/, 'forbidden_call', 'medium', 'loads classes reflectively'),
    rule(/^(?:File|FileReader|FileWriter|FileInputStream|FileOutputStream|RandomAccessFile|Files\.\w+|Paths\.get|Path\.of)$/, 'file_access', 'medium', 'touches the filesystem of the judge'),
  ],
};

const IMPORT_RULES: Record<AntiCheatLanguage, RegExp> = {
  cpp: /^(?:sys\/socket\.h|netinet\/in\.h|arpa\/inet\.h|netdb\.h|sys\/ptrace\.h|dlfcn\.h|spawn\.h|sys\/wait\.h)$/,
  python: /^(?:subprocess|socket|ctypes|pty|importlib|urllib|requests|httpx|http|ftplib|smtplib|telnetlib|paramiko|multiprocessing)(?:\.|$)/,
  java: /^java\.(?:net|nio\.file|lang\.reflect)(?:\.|$)|^javax\.script(?:\.|$)/,
};

const INPUT_CALLS: Record<AntiCheatLanguage, ReadonlySet<string>> = {
  cpp: new Set(['scanf', 'fscanf', 'getchar', 'getc', 'fgetc', 'gets', 'fgets', 'getline', 'read', 'fread', 'getchar_unlocked']),
  python: new Set(['input', 'raw_input']),
  java: new Set(),
};
const INPUT_IDENTIFIERS: Record<AntiCheatLanguage, ReadonlySet<string>> = {
  cpp: new Set(['cin', 'stdin', 'std::cin']),
  python: new Set(['stdin']),
  java: new Set(['Scanner', 'BufferedReader', 'StreamTokenizer', 'DataInputStream', 'InputStreamReader', 'Console']),
};
const OUTPUT_FUNCTIONS = new Set(['printf', 'puts', 'putchar', 'fputs', 'fputc', 'fwrite', 'fprintf', 'putc', 'write', 'print']);
const OUTPUT_STREAMS = new Set(['cout', 'cerr', 'clog', 'std::cout', 'std::cerr', 'std::clog']);
const JAVA_PRINT_METHODS = new Set(['print', 'println', 'printf', 'write', 'format', 'append']);
const NEUTRAL_IDENTIFIERS = new Set([
  'cout', 'cerr', 'clog', 'endl', 'flush', 'ends', 'std', 'std::cout', 'std::cerr', 'std::endl', 'std::flush',
  'stdout', 'stderr', 'System', 'out', 'err', 'sys', 'end', 'sep', 'file',
]);

const LITERAL_TYPES = new Set([
  'number_literal', 'string_literal', 'raw_string_literal', 'char_literal', 'character_literal', 'integer', 'float',
  'string', 'true', 'false', 'decimal_integer_literal', 'hex_integer_literal', 'octal_integer_literal',
  'binary_integer_literal', 'decimal_floating_point_literal', 'hex_floating_point_literal', 'text_block', 'concatenated_string',
]);
const STRING_TYPES = new Set(['string_literal', 'raw_string_literal', 'char_literal', 'character_literal', 'string', 'concatenated_string', 'text_block']);

function isLiteral(node: SyntaxNode | null): boolean {
  if (!node) return false;
  if (LITERAL_TYPES.has(node.type)) return true;
  if ((node.type === 'unary_expression' || node.type === 'unary_operator') && node.namedChildCount === 1) {
    return isLiteral(node.namedChild(0));
  }
  if (node.type === 'parenthesized_expression' && node.namedChildCount === 1) return isLiteral(node.namedChild(0));
  return false;
}

function line(node: SyntaxNode): number {
  return node.startPosition.row + 1;
}

function lastSegment(name: string): string {
  const parts = name.split(/::|\./);
  return parts[parts.length - 1] ?? name;
}

function compact(text: string): string {
  return text.replace(/\s+/g, '');
}

function hasDataIdentifier(node: SyntaxNode): boolean {
  const type = node.type;
  if (type === 'identifier' || type === 'qualified_identifier') return !NEUTRAL_IDENTIFIERS.has(compact(node.text));
  if (type === 'keyword_argument') {
    const value = node.childForFieldName('value');
    return value ? hasDataIdentifier(value) : false;
  }
  for (let i = 0; i < node.namedChildCount; i += 1) {
    const child = node.namedChild(i);
    if (child && hasDataIdentifier(child)) return true;
  }
  return false;
}

function containsLiteral(node: SyntaxNode): boolean {
  if (LITERAL_TYPES.has(node.type)) return true;
  for (let i = 0; i < node.namedChildCount; i += 1) {
    const child = node.namedChild(i);
    if (child && containsLiteral(child)) return true;
  }
  return false;
}

function literalCount(node: SyntaxNode): { all: number } {
  let all = 0;
  for (let i = 0; i < node.namedChildCount; i += 1) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (isLiteral(child)) all += 1;
    else if (child.type === 'pair') all += isLiteral(child.childForFieldName('key')) ? 1 : 0;
    else if (child.type === 'initializer_list' || child.type === 'array_initializer' || child.type === 'list' || child.type === 'tuple') {
      all += literalCount(child).all;
    }
  }
  return { all };
}

function functionName(node: SyntaxNode, language: AntiCheatLanguage): string | null {
  if (language === 'cpp' && node.type === 'function_definition') {
    let declarator = node.childForFieldName('declarator');
    while (declarator && declarator.type !== 'function_declarator') declarator = declarator.childForFieldName('declarator');
    const name = declarator?.childForFieldName('declarator');
    return name ? lastSegment(compact(name.text)) : '';
  }
  if (language === 'python' && node.type === 'function_definition') return node.childForFieldName('name')?.text ?? '';
  if (language === 'java' && (node.type === 'method_declaration' || node.type === 'constructor_declaration')) {
    return node.childForFieldName('name')?.text ?? '';
  }
  return null;
}

function calleeName(node: SyntaxNode, language: AntiCheatLanguage): string | null {
  if (language === 'cpp' && node.type === 'call_expression') {
    let fn = node.childForFieldName('function');
    if (fn?.type === 'template_function') fn = fn.childForFieldName('name');
    return fn ? compact(fn.text) : null;
  }
  if (language === 'python' && node.type === 'call') {
    const fn = node.childForFieldName('function');
    const text = fn ? compact(fn.text) : null;
    return text && !text.includes('(') ? text : null;
  }
  if (language === 'java' && node.type === 'method_invocation') {
    const name = node.childForFieldName('name')?.text;
    if (!name) return null;
    const object = node.childForFieldName('object');
    return object ? `${compact(object.text)}.${name}` : name;
  }
  if (language === 'java' && node.type === 'object_creation_expression') {
    const type = node.childForFieldName('type');
    return type ? compact(type.text).replace(/<.*>$/, '') : null;
  }
  return null;
}

function equalityWithLiteral(node: SyntaxNode): boolean {
  if (node.type === 'binary_expression' && node.childForFieldName('operator')?.type === '==') {
    return isLiteral(node.childForFieldName('left')) || isLiteral(node.childForFieldName('right'));
  }
  if (node.type === 'comparison_operator') {
    let hasEquals = false;
    for (let i = 0; i < node.childCount; i += 1) {
      const child = node.child(i);
      if (child && !child.isNamed && child.type === '==') hasEquals = true;
    }
    if (!hasEquals) return false;
    for (let i = 0; i < node.namedChildCount; i += 1) if (isLiteral(node.namedChild(i))) return true;
  }
  return false;
}

/** Leftmost operand of a `a << b << c` chain, if the chain is a C++ stream insertion. */
function streamHead(node: SyntaxNode): string | null {
  let current: SyntaxNode | null = node;
  let chained = false;
  while (current && current.type === 'binary_expression' && current.childForFieldName('operator')?.type === '<<') {
    chained = true;
    current = current.childForFieldName('left');
  }
  return chained && current ? compact(current.text) : null;
}

export function collectFacts(root: SyntaxNode, language: AntiCheatLanguage): Facts {
  const facts: Facts = {
    nodeCount: 0, loops: 0, recursion: false, readsInput: false, outputStatements: 0, literalOnlyOutputs: 0,
    literalBranches: 0, maxLiteralCollection: 0, hasSyntaxErrors: root.hasError, flags: [], pendingCalls: [],
    definedFunctions: new Set(), moduleAliases: new Map(), fromImports: new Map(),
  };
  const importRule = IMPORT_RULES[language];
  const functionStack: string[] = [];

  const noteOutput = (argumentsNode: SyntaxNode | null): void => {
    facts.outputStatements += 1;
    if (argumentsNode && !hasDataIdentifier(argumentsNode) && containsLiteral(argumentsNode)) facts.literalOnlyOutputs += 1;
  };

  const flagImport = (module: string, node: SyntaxNode): void => {
    if (importRule.test(module)) {
      facts.flags.push({
        type: 'forbidden_import', severity: 'medium', line: line(node), evidence: module,
        detail: `Imports \`${module}\`, which gives access to processes, sockets or foreign code`,
      });
    }
  };

  const visit = (node: SyntaxNode): void => {
    facts.nodeCount += 1;
    const type = node.type;

    const defined = functionName(node, language);
    if (defined !== null) {
      if (defined) facts.definedFunctions.add(defined);
      functionStack.push(defined);
    }

    if (type === 'for_statement' || type === 'while_statement' || type === 'do_statement' || type === 'for_range_loop' || type === 'enhanced_for_statement') {
      facts.loops += 1;
    }
    if (language === 'python' && (type === 'list_comprehension' || type === 'generator_expression' || type === 'set_comprehension' || type === 'dictionary_comprehension')) {
      facts.loops += 1;
    }

    if (equalityWithLiteral(node)) facts.literalBranches += 1;
    if (type === 'case_statement' && isLiteral(node.childForFieldName('value'))) facts.literalBranches += 1;
    if (type === 'switch_label') {
      for (let i = 0; i < node.namedChildCount; i += 1) {
        if (isLiteral(node.namedChild(i))) { facts.literalBranches += 1; break; }
      }
    }

    if (type === 'initializer_list' || type === 'array_initializer' || type === 'list' || type === 'tuple' || type === 'set' || type === 'dictionary') {
      const count = literalCount(node).all;
      if (count > facts.maxLiteralCollection) facts.maxLiteralCollection = count;
    }

    // ---- input
    if (type === 'identifier' || type === 'type_identifier' || type === 'qualified_identifier') {
      if (INPUT_IDENTIFIERS[language].has(compact(node.text))) facts.readsInput = true;
    }
    if (language === 'python' && type === 'attribute' && compact(node.text).startsWith('sys.stdin')) facts.readsInput = true;
    if (language === 'java' && type === 'field_access' && compact(node.text) === 'System.in') facts.readsInput = true;

    // ---- calls and constructions
    const callee = calleeName(node, language);
    if (callee !== null) {
      const simple = lastSegment(callee.replace(/^(?:std::|::)/, ''));
      if (INPUT_CALLS[language].has(callee.replace(/^(?:std::|::)/, ''))) facts.readsInput = true;
      if (language === 'python' && callee === 'open') {
        const first = node.childForFieldName('arguments')?.namedChild(0);
        if (first && first.text === '0') facts.readsInput = true; // open(0) reads stdin
      }
      if (simple && functionStack.includes(simple)) facts.recursion = true;
      facts.pendingCalls.push({ name: callee, line: line(node) });

      // ---- output statements
      if (language === 'cpp' && OUTPUT_FUNCTIONS.has(callee.replace(/^(?:std::|::)/, ''))) {
        noteOutput(node.childForFieldName('arguments'));
      } else if (language === 'python' && (callee === 'print' || /^(?:sys\.)?stdout\.write$/.test(callee))) {
        noteOutput(node.childForFieldName('arguments'));
      } else if (language === 'java' && type === 'method_invocation') {
        const name = node.childForFieldName('name')?.text ?? '';
        const object = compact(node.childForFieldName('object')?.text ?? '');
        if (JAVA_PRINT_METHODS.has(name) && (/^System\.(?:out|err)$/.test(object) || /^(?:out|writer|pw|bw|printWriter)$/i.test(object))) {
          noteOutput(node.childForFieldName('arguments'));
        }
        if (name === 'equals' && node.childForFieldName('arguments') && containsLiteral(node.childForFieldName('arguments') as SyntaxNode) && !hasDataIdentifier(node.childForFieldName('arguments') as SyntaxNode)) {
          facts.literalBranches += 1;
        }
      }
    }

    // C++ stream insertion statements: `cout << a << b;`
    if (language === 'cpp' && type === 'expression_statement' && node.namedChildCount === 1) {
      const expression = node.namedChild(0);
      const head = expression ? streamHead(expression) : null;
      if (expression && head && OUTPUT_STREAMS.has(head)) noteOutput(expression);
    }
    if (language === 'cpp' && (type === 'qualified_identifier' || type === 'type_identifier')) {
      const text = compact(node.text).replace(/^std::/, '');
      if (/^(?:ifstream|ofstream|fstream)$/.test(text)) {
        facts.flags.push({
          type: 'file_access', severity: 'medium', line: line(node), evidence: text,
          detail: `Uses \`${text}\` to touch the filesystem of the judge`,
        });
      }
    }

    // ---- imports
    if (language === 'cpp' && type === 'preproc_include') {
      const path = node.childForFieldName('path')?.text ?? '';
      flagImport(path.replace(/^[<"]|[>"]$/g, ''), node);
    }
    if (language === 'java' && type === 'import_declaration') {
      flagImport(compact(node.text).replace(/^import(?:static)?/, '').replace(/;$/, '').replace(/\.\*$/, ''), node);
    }
    if (language === 'python' && type === 'import_statement') {
      for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (!child) continue;
        if (child.type === 'aliased_import') {
          const moduleName = compact(child.childForFieldName('name')?.text ?? '');
          const alias = child.childForFieldName('alias')?.text;
          if (alias && moduleName) facts.moduleAliases.set(alias, moduleName);
          flagImport(moduleName, node);
        } else {
          flagImport(compact(child.text), node);
        }
      }
    }
    if (language === 'python' && type === 'import_from_statement') {
      const moduleName = compact(node.namedChild(0)?.text ?? '');
      flagImport(moduleName, node);
      for (let i = 1; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (!child) continue;
        const name = child.type === 'aliased_import' ? compact(child.childForFieldName('name')?.text ?? '') : compact(child.text);
        const alias = child.type === 'aliased_import' ? (child.childForFieldName('alias')?.text ?? name) : name;
        if (moduleName && name) facts.fromImports.set(alias, `${moduleName}.${name}`);
      }
    }

    for (let i = 0; i < node.namedChildCount; i += 1) {
      const child = node.namedChild(i);
      if (child) visit(child);
    }
    if (defined !== null) functionStack.pop();
  };

  visit(root);
  return facts;
}

function resolvePythonName(name: string, facts: Facts): string {
  const [first = '', ...rest] = name.split('.');
  const aliased = facts.moduleAliases.get(first);
  if (aliased) return [aliased, ...rest].join('.');
  const imported = facts.fromImports.get(first);
  if (imported) return [imported, ...rest].join('.');
  return name;
}

export interface Thresholds {
  lookupBranches: number;
  lookupLiteralOutputs: number;
  largeTable: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { lookupBranches: 15, lookupLiteralOutputs: 10, largeTable: 64 };

/** Turn collected facts into flags. */
export function deriveFlags(facts: Facts, language: AntiCheatLanguage, thresholds: Thresholds = DEFAULT_THRESHOLDS): CheatFlag[] {
  const flags: CheatFlag[] = [...facts.flags];
  const seen = new Set<string>();
  const push = (flag: CheatFlag): void => {
    const key = `${flag.type}|${flag.evidence ?? flag.detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    flags.push(flag);
  };
  flags.splice(0, flags.length).forEach(push);

  for (const call of facts.pendingCalls) {
    const resolved = language === 'python' ? resolvePythonName(call.name, facts) : call.name;
    const simple = lastSegment(call.name.replace(/^(?:std::|::)/, ''));
    // A name the submission defines itself (e.g. `connect` in a union-find) is its own function, not the libc one.
    if (!call.name.includes('.') && !call.name.includes('::') && facts.definedFunctions.has(simple) && resolved === call.name) continue;
    for (const candidate of CALL_RULES[language]) {
      if (candidate.pattern.test(resolved)) {
        push({
          type: candidate.type, severity: candidate.severity, line: call.line, evidence: resolved,
          detail: `Calls \`${resolved}\`, which ${candidate.why}`,
        });
        break;
      }
    }
  }

  if (!facts.readsInput && facts.literalOnlyOutputs >= 1) {
    push({
      type: 'hardcoded_output', severity: 'high',
      detail: `Prints constant output (${facts.literalOnlyOutputs} literal-only output statement${facts.literalOnlyOutputs === 1 ? '' : 's'}) and never reads the input`,
    });
  }
  if (facts.literalBranches >= thresholds.lookupBranches) {
    const answersLiterals = facts.literalOnlyOutputs >= thresholds.lookupLiteralOutputs;
    if (answersLiterals || facts.literalBranches >= thresholds.lookupBranches * 2) {
      push({
        type: 'lookup_chain', severity: answersLiterals ? 'high' : 'medium',
        detail: `${facts.literalBranches} branches compare the input against literal constants` + (answersLiterals ? ` and ${facts.literalOnlyOutputs} print literal answers: an answer table in disguise` : ''),
      });
    }
  }
  if (facts.maxLiteralCollection >= thresholds.largeTable) {
    push({
      type: 'large_literal_table', severity: 'medium',
      detail: `A single literal collection holds ${facts.maxLiteralCollection} constants (possible embedded answers)`,
    });
  }
  return flags;
}

export { STRING_TYPES };
