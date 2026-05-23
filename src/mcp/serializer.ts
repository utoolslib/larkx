import type { GraphNode } from '../graph/index.js';
import type { FileSymbols } from '../parser/treesitter.js';
import { estimateTokens, formatTokens } from './tokens.js';

const MAX_SYM_CHARS = 300;
const MAX_IMPORT_CHARS = 200;
const FOLDER_COLLAPSE_THRESHOLD = 15;

export type ContextLevel = 1 | 2 | 3 | 4;

function truncatePart(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function inFolder(file: string, folder: string | null): boolean {
  if (!folder) return true;
  const f = folder.replace(/\\/g, '/').replace(/\/$/, '');
  const p = file.replace(/\\/g, '/');
  return p === f || p.startsWith(f + '/');
}

function parentFolder(file: string): string {
  const idx = file.lastIndexOf('/');
  return idx >= 0 ? file.slice(0, idx) : '';
}

function basename(file: string): string {
  const idx = file.lastIndexOf('/');
  return idx >= 0 ? file.slice(idx + 1) : file;
}

function abbrevLang(lang: string | undefined): string {
  switch (lang) {
    case 'typescript': return 'ts';
    case 'javascript': return 'js';
    case 'python': return 'py';
    case 'go': return 'go';
    default: return lang ?? '?';
  }
}

function normalizeImportSource(source: string): string {
  if (source.startsWith('.')) {
    return source.replace(/\.(js|ts|tsx|jsx|mjs|cjs)$/, '');
  }
  // Collapse to package root: @scope/pkg/sub → @scope/pkg, pkg/sub → pkg
  const parts = source.split('/');
  return parts[0].startsWith('@') && parts.length > 1
    ? `${parts[0]}/${parts[1]}`
    : parts[0];
}

const TEST_HELPER_NAMES = new Set(['it', 'test', 'expect', 'beforeEach', 'afterEach', 'describe']);

function isInternalSymbol(name: string): boolean {
  if (!name) return true;
  if (name.startsWith('_') || name.startsWith('$')) return true;
  if (name.length === 1) return true;
  if (TEST_HELPER_NAMES.has(name)) return true;
  return false;
}

export function serializeIndex(
  nodes: GraphNode[],
  summaries: Record<string, string>,
  options: {
    level?: ContextLevel;
    folder?: string | null;
    fileSymbols?: FileSymbols[];
    omitInternal?: boolean;
    importance?: Map<string, number>;
    limit?: number;
    expand?: string[];
  } = {}
): string {
  const level = options.level ?? 2;
  const folder = options.folder ?? null;
  const omitInternal = options.omitInternal ?? false;
  const importance = options.importance;
  const limit = options.limit;
  const expandSet = new Set((options.expand ?? []).map(p => p.replace(/\\/g, '/').replace(/\/$/, '')));
  const symbolsByPath = new Map<string, FileSymbols>();
  (options.fileSymbols ?? []).forEach(fs => symbolsByPath.set(fs.file, fs));

  let fileNodes = nodes
    .filter(n => n.type === 'file')
    .filter(n => inFolder(n.file, folder));

  // Opt-in: sort by importance (desc) with path tie-break (asc)
  if (importance) {
    fileNodes = [...fileNodes].sort((a, b) => {
      const sa = importance.get(a.file) ?? 0;
      const sb = importance.get(b.file) ?? 0;
      if (sb !== sa) return sb - sa;
      return a.file.localeCompare(b.file);
    });
  }

  const totalCount = fileNodes.length;
  let truncated = false;
  if (limit !== undefined && limit >= 0 && limit < fileNodes.length) {
    fileNodes = fileNodes.slice(0, limit);
    truncated = true;
  }

  const symbolsByFile = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    if (n.type !== 'file') {
      if (omitInternal && isInternalSymbol(n.name)) continue;
      const arr = symbolsByFile.get(n.file) ?? [];
      arr.push(n);
      symbolsByFile.set(n.file, arr);
    }
  }

  // Detect dense folders for collapse (skipped when caller already scoped via `folder`)
  const filesByFolder = new Map<string, GraphNode[]>();
  if (!folder) {
    for (const fn of fileNodes) {
      const p = parentFolder(fn.file);
      if (!p) continue;
      const arr = filesByFolder.get(p);
      if (arr) arr.push(fn); else filesByFolder.set(p, [fn]);
    }
  }
  const denseFolders = new Set<string>();
  for (const [p, files] of filesByFolder) {
    if (files.length > FOLDER_COLLAPSE_THRESHOLD && !expandSet.has(p)) {
      denseFolders.add(p);
    }
  }
  const emittedFolderSummary = new Set<string>();
  let collapsedFolderCount = 0;
  let collapsedFileCount = 0;

  const body: string[] = [];

  for (const fn of fileNodes) {
    const p = parentFolder(fn.file);
    if (denseFolders.has(p)) {
      if (emittedFolderSummary.has(p)) continue;
      emittedFolderSummary.add(p);
      const filesInFolder = filesByFolder.get(p) ?? [];
      const totalSyms = filesInFolder.reduce((s, f) => s + (symbolsByFile.get(f.file)?.length ?? 0), 0);
      const sampleNames = filesInFolder.slice(0, 3).map(f => basename(f.file)).join(', ');
      const more = filesInFolder.length - 3;
      const moreText = more > 0 ? ` (+${more} more)` : '';
      body.push(`${p}/ [${filesInFolder.length} files, ${totalSyms} symbols] — sample: ${sampleNames}${moreText}`);
      collapsedFolderCount++;
      collapsedFileCount += filesInFolder.length;
      continue;
    }

    // Level 4: prepend AI summary if available
    if (level === 4) {
      const summary = summaries[fn.file];
      if (summary) body.push(`// ${summary}`);
    }

    if (level === 1) {
      body.push(`${fn.file}[${abbrevLang(fn.lang)}]`);
      continue;
    }

    const symbols = symbolsByFile.get(fn.file) ?? [];
    const sig = symbolsByPath.get(fn.file);

    let symPart: string;
    if (level >= 3 && sig) {
      // Use signatures from FileSymbols if available
      const parts: string[] = [];
      for (const f of sig.functions) {
        if (omitInternal && isInternalSymbol(f.name)) continue;
        const s = (f as { signature?: string }).signature;
        parts.push(s ? `${s}@${f.line}` : `${f.name}@${f.line}`);
      }
      for (const c of sig.classes) {
        if (omitInternal && isInternalSymbol(c.name)) continue;
        parts.push(`class ${c.name}@${c.line}`);
      }
      symPart = parts.join(', ');
    } else {
      symPart = symbols
        .map(s => s.line !== undefined ? `${s.name}@${s.line}` : s.name)
        .join(', ');
    }

    const importPart = (level >= 2 && sig)
      ? [...new Set(sig.imports.map(i => normalizeImportSource(i.source)))].map(s => `+${s}`).join(',')
      : '';

    const line = `${fn.file}[${abbrevLang(fn.lang)}]: ${truncatePart(symPart, MAX_SYM_CHARS)}${importPart ? ' | ' + truncatePart(importPart, MAX_IMPORT_CHARS) : ''}`;
    body.push(line);
  }

  if (truncated) {
    body.push(`… (${totalCount - fileNodes.length} more files; pass limit=null to see all)`);
  }

  const bodyText = body.join('\n');
  const tokens = estimateTokens(bodyText);
  const fileCountLabel = truncated ? `${fileNodes.length} of ${totalCount} files` : `${fileNodes.length} files`;
  const collapseLabel = collapsedFolderCount > 0 ? ` · ${collapsedFolderCount} folder${collapsedFolderCount === 1 ? '' : 's'} collapsed (${collapsedFileCount} files; pass expand=[...] to inline)` : '';
  const header = `# larkx context · level ${level}${folder ? ' · folder ' + folder : ''} · ~${formatTokens(tokens)} tokens · ${fileCountLabel}${collapseLabel}`;
  return `${header}\n${bodyText}`;
}

export function serializeFile(
  node: GraphNode,
  symbols: FileSymbols,
  summary?: string,
  options: { omitInternal?: boolean } = {}
): string {
  const omitInternal = options.omitInternal ?? false;
  const lines: string[] = [];

  if (summary) {
    lines.push(`// ${summary}`);
  }

  const fns = omitInternal ? symbols.functions.filter(f => !isInternalSymbol(f.name)) : symbols.functions;
  const cls = omitInternal ? symbols.classes.filter(c => !isInternalSymbol(c.name)) : symbols.classes;

  const symPart = [
    ...fns.map(f => f.signature ? `${f.signature}@${f.line}` : `${f.name}@${f.line}`),
    ...cls.map(c => `class ${c.name}@${c.line}`),
  ].join(', ');

  const importPart = [...new Set(symbols.imports.map(i => normalizeImportSource(i.source)))].map(s => `+${s}`).join(',');

  lines.push(`${node.file}[${abbrevLang(node.lang)}]: ${truncatePart(symPart, MAX_SYM_CHARS)} | ${truncatePart(importPart, MAX_IMPORT_CHARS)}`);

  return lines.join('\n');
}

export function serializeImpact(
  targetFile: string,
  dependents: GraphNode[]
): string {
  if (dependents.length === 0) {
    return `Nothing imports ${targetFile}`;
  }
  const list = dependents.map(n => `  ${n.file}`).join('\n');
  return `${dependents.length} files depend on ${targetFile}:\n${list}`;
}

export function serializeCallChain(
  symbol: string,
  callers: GraphNode[],
  callees: GraphNode[]
): string {
  const callerList = callers.length > 0
    ? callers.map(n => n.name).join(', ')
    : 'nothing';
  const calleeList = callees.length > 0
    ? callees.map(n => n.name).join(', ')
    : 'nothing';

  return [
    `${symbol} is called by: ${callerList}`,
    `${symbol} calls: ${calleeList}`,
  ].join('\n');
}

export function serializeDeadCode(nodes: GraphNode[]): string {
  if (nodes.length === 0) return 'No dead code found.';
  const lines = nodes.map(n => {
    const kind = n.type === 'file' ? 'file' : 'function';
    return `  ${n.id} (${kind})`;
  });
  return `Dead code candidates:\n${lines.join('\n')}`;
}

export function serializeError(message: string): string {
  return `⚠ ${message}`;
}
