import path from 'path';

export type FileSymbols = {
  file: string;
  lang: string;
  functions: Array<{ name: string; line: number; signature?: string }>;
  classes: Array<{ name: string; line: number }>;
  imports: Array<{ source: string }>;
  exports: Array<{ name: string }>;
  calls: Array<{ caller: string; callee: string; line: number }>;
};

export function extractSignature(lines: string[], line: number): string | undefined {
  if (line < 1 || line > lines.length) return undefined;
  // Concatenate up to 3 lines from the function declaration to capture multi-line signatures
  const start = line - 1;
  let raw = '';
  for (let i = start; i < Math.min(start + 3, lines.length); i++) {
    raw += lines[i] + ' ';
    if (raw.includes(')')) break;
  }
  raw = raw.trim();
  // Cut at first `{`, `=>` or `;` to drop the body
  const cutAt = (() => {
    const idx = [raw.indexOf('{'), raw.indexOf('=>'), raw.indexOf(';')]
      .filter(i => i >= 0)
      .sort((a, b) => a - b)[0];
    return idx ?? raw.length;
  })();
  const sig = raw.slice(0, cutAt).replace(/\s+/g, ' ').trim();
  // Strip common modifiers to save tokens but keep the core
  return sig.replace(/^(export\s+)?(default\s+)?(async\s+)?/, '').slice(0, 140);
}

let treeSitterWarned = false;
let treeSitterAvailable: boolean | null = null;

function detectLang(filepath: string): string {
  const ext = path.extname(filepath).toLowerCase();
  switch (ext) {
    case '.ts':
    case '.tsx':
      return 'typescript';
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.py':
      return 'python';
    case '.go':
      return 'go';
    default:
      return 'unknown';
  }
}

function regexParse(filepath: string, content: string, lang: string): FileSymbols {
  const functions: Array<{ name: string; line: number; signature?: string }> = [];
  const classes: Array<{ name: string; line: number }> = [];
  const imports: Array<{ source: string }> = [];
  const exports: Array<{ name: string }> = [];
  const calls: Array<{ caller: string; callee: string; line: number }> = [];

  const lines = content.split('\n');

  // Matches: function declarations, const arrow functions, and class methods
  const fnPattern = /(?:^|\s)(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:^|\s)(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(|(?:^\s*)(?:(?:public|private|protected|static|abstract|override|async)\s+)*(?:get\s+|set\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*\S+\s*)?\{/gm;
  const classPattern = /(?:^|\s)class\s+(\w+)/gm;
  const importPattern = /from\s+['"]([^'"]+)['"]/g;
  const exportPattern = /export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const)\s+(\w+)/g;
  const callPattern = /(\w+)\s*\(/g;

  let m: RegExpExecArray | null;

  const METHOD_KEYWORDS = new Set(['if', 'else', 'for', 'while', 'switch', 'catch', 'return', 'new', 'delete', 'typeof', 'instanceof', 'throw', 'await', 'yield', 'case', 'default', 'try', 'finally', 'do', 'in', 'of', 'class', 'extends', 'super', 'this', 'import', 'export', 'from', 'constructor']);
  while ((m = fnPattern.exec(content)) !== null) {
    const name = m[1] || m[2] || m[3];
    if (name && !METHOD_KEYWORDS.has(name)) {
      const lineNum = content.substring(0, m.index).split('\n').length;
      const signature = extractSignature(lines, lineNum);
      functions.push({ name, line: lineNum, signature });
    }
  }

  while ((m = classPattern.exec(content)) !== null) {
    const name = m[1];
    const lineNum = content.substring(0, m.index).split('\n').length;
    classes.push({ name, line: lineNum });
  }

  while ((m = importPattern.exec(content)) !== null) {
    imports.push({ source: m[1] });
  }

  while ((m = exportPattern.exec(content)) !== null) {
    exports.push({ name: m[1] });
  }

  // best-effort call extraction: attribute each line's calls to the enclosing function
  const sortedFns = [...functions].sort((a, b) => a.line - b.line);
  const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'instanceof', 'new', 'delete', 'void', 'throw', 'await', 'yield']);

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    // Find the last function whose start line is <= this line
    let currentFn: string | null = null;
    for (const fn of sortedFns) {
      if (fn.line <= lineNo) currentFn = fn.name;
      else break;
    }
    if (!currentFn) continue;

    const callPat = /\b(\w+)\s*\(/g;
    let cm: RegExpExecArray | null;
    while ((cm = callPat.exec(lines[i])) !== null) {
      const callee = cm[1];
      if (callee !== currentFn && !KEYWORDS.has(callee) && callee.length > 1) {
        calls.push({ caller: currentFn, callee, line: lineNo });
      }
    }
  }

  return { file: filepath, lang, functions, classes, imports, exports, calls };
}

async function tryTreeSitter(filepath: string, content: string, lang: string): Promise<FileSymbols | null> {
  if (treeSitterAvailable === false) return null;

  try {
    const { default: Parser } = await import('tree-sitter');

    let grammar;
    if (lang === 'typescript') {
      const mod = await import('tree-sitter-typescript');
      grammar = (mod as any).default?.typescript ?? (mod as any).typescript;
    } else {
      const mod = await import('tree-sitter-javascript');
      grammar = (mod as any).default ?? mod;
    }

    const parser = new (Parser as any)();
    parser.setLanguage(grammar);
    const tree = parser.parse(content);

    const functions: Array<{ name: string; line: number; signature?: string }> = [];
    const classes: Array<{ name: string; line: number }> = [];
    const imports: Array<{ source: string }> = [];
    const exports: Array<{ name: string }> = [];
    const calls: Array<{ caller: string; callee: string; line: number }> = [];

    function getNodeText(node: any): string {
      return content.slice(node.startIndex, node.endIndex);
    }

    function findFunctionName(node: any): string | null {
      if (node.type === 'function_declaration' || node.type === 'method_definition') {
        const nameNode = node.childForFieldName?.('name') ?? node.children?.find((c: any) => c.type === 'identifier');
        return nameNode ? getNodeText(nameNode) : null;
      }
      if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
        const decl = node.children?.find((c: any) => c.type === 'variable_declarator');
        if (decl) {
          const nameNode = decl.childForFieldName?.('name') ?? decl.children?.[0];
          const val = decl.childForFieldName?.('value');
          if (val && (val.type === 'arrow_function' || val.type === 'function')) {
            return nameNode ? getNodeText(nameNode) : null;
          }
        }
      }
      return null;
    }

    function collectCalls(node: any, currentFn: string): void {
      if (node.type === 'call_expression') {
        const fnNode = node.childForFieldName?.('function') ?? node.children?.[0];
        if (fnNode && fnNode.type === 'identifier') {
          const callee = getNodeText(fnNode);
          calls.push({ caller: currentFn, callee, line: node.startPosition.row + 1 });
        } else if (fnNode && fnNode.type === 'member_expression') {
          const prop = fnNode.childForFieldName?.('property');
          if (prop) {
            calls.push({ caller: currentFn, callee: getNodeText(prop), line: node.startPosition.row + 1 });
          }
        }
      }
      for (let i = 0; i < (node.childCount ?? 0); i++) {
        collectCalls(node.child(i), currentFn);
      }
    }

    function visit(node: any, currentFn: string | null): void {
      if (!node) return;

      if (
        node.type === 'import_statement' ||
        node.type === 'import_declaration'
      ) {
        const src = node.childForFieldName?.('source') ?? node.children?.find((c: any) => c.type === 'string');
        if (src) {
          const raw = getNodeText(src).replace(/^['"]|['"]$/g, '');
          imports.push({ source: raw });
        }
      }

      if (
        node.type === 'function_declaration' ||
        node.type === 'method_definition' ||
        node.type === 'lexical_declaration' ||
        node.type === 'variable_declaration'
      ) {
        const name = findFunctionName(node);
        if (name) {
          const line = node.startPosition.row + 1;
          const signature = extractSignature(content.split('\n'), line);
          functions.push({ name, line, signature });
          collectCalls(node, name);
          for (let i = 0; i < (node.childCount ?? 0); i++) {
            visit(node.child(i), name);
          }
          return;
        }
      }

      if (node.type === 'class_declaration') {
        const nameNode = node.childForFieldName?.('name');
        if (nameNode) {
          const className = getNodeText(nameNode);
          classes.push({ name: className, line: node.startPosition.row + 1 });
        }
      }

      if (
        node.type === 'export_statement' ||
        node.type === 'export_named_declaration' ||
        node.type === 'export_default_declaration'
      ) {
        const decl = node.childForFieldName?.('declaration') ?? node.children?.find((c: any) =>
          c.type === 'function_declaration' || c.type === 'class_declaration' || c.type === 'lexical_declaration'
        );
        if (decl) {
          const nameNode = decl.childForFieldName?.('name') ??
            decl.children?.find((c: any) => c.type === 'identifier');
          if (nameNode) {
            exports.push({ name: getNodeText(nameNode) });
          }
        }
      }

      for (let i = 0; i < (node.childCount ?? 0); i++) {
        visit(node.child(i), currentFn);
      }
    }

    visit(tree.rootNode, null);
    treeSitterAvailable = true;
    return { file: filepath, lang, functions, classes, imports, exports, calls };
  } catch {
    treeSitterAvailable = false;
    if (!treeSitterWarned) {
      treeSitterWarned = true;
      console.warn('⚠ tree-sitter native bindings unavailable — using regex fallback');
    }
    return null;
  }
}

export async function parseFile(filepath: string, content: string): Promise<FileSymbols> {
  const lang = detectLang(filepath);

  if (lang === 'typescript' || lang === 'javascript') {
    try {
      const result = await tryTreeSitter(filepath, content, lang);
      if (result) return result;
    } catch {
      // fallback below
    }
    return regexParse(filepath, content, lang);
  }

  // For other languages, return minimal structure via regex where possible
  return regexParse(filepath, content, lang);
}
