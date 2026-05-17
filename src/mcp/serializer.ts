import type { GraphNode } from '../graph/index.js';
import type { FileSymbols } from '../parser/treesitter.js';
import { estimateTokens, formatTokens } from './tokens.js';

const MAX_SYM_CHARS = 300;
const MAX_IMPORT_CHARS = 200;

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

export function serializeIndex(
  nodes: GraphNode[],
  summaries: Record<string, string>,
  options: { level?: ContextLevel; folder?: string | null; fileSymbols?: FileSymbols[] } = {}
): string {
  const level = options.level ?? 2;
  const folder = options.folder ?? null;
  const symbolsByPath = new Map<string, FileSymbols>();
  (options.fileSymbols ?? []).forEach(fs => symbolsByPath.set(fs.file, fs));

  const fileNodes = nodes
    .filter(n => n.type === 'file')
    .filter(n => inFolder(n.file, folder));

  const symbolsByFile = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    if (n.type !== 'file') {
      const arr = symbolsByFile.get(n.file) ?? [];
      arr.push(n);
      symbolsByFile.set(n.file, arr);
    }
  }

  const body: string[] = [];

  for (const fn of fileNodes) {
    // Level 4: prepend AI summary if available
    if (level === 4) {
      const summary = summaries[fn.file];
      if (summary) body.push(`// ${summary}`);
    }

    if (level === 1) {
      body.push(`${fn.file}[${fn.lang ?? '?'}]`);
      continue;
    }

    const symbols = symbolsByFile.get(fn.file) ?? [];
    const sig = symbolsByPath.get(fn.file);

    let symPart: string;
    if (level >= 3 && sig) {
      // Use signatures from FileSymbols if available
      const parts: string[] = [];
      for (const f of sig.functions) {
        const s = (f as { signature?: string }).signature;
        parts.push(s ? `${s}@${f.line}` : `${f.name}@${f.line}`);
      }
      for (const c of sig.classes) {
        parts.push(`class ${c.name}@${c.line}`);
      }
      symPart = parts.join(', ');
    } else {
      symPart = symbols
        .map(s => s.line !== undefined ? `${s.name}@${s.line}` : s.name)
        .join(', ');
    }

    const importPart = (level >= 2 && sig)
      ? sig.imports.map(i => `+${i.source}`).join(',')
      : '';

    const line = `${fn.file}[${fn.lang ?? '?'}]: ${truncatePart(symPart, MAX_SYM_CHARS)}${importPart ? ' | ' + truncatePart(importPart, MAX_IMPORT_CHARS) : ''}`;
    body.push(line);
  }

  const bodyText = body.join('\n');
  const tokens = estimateTokens(bodyText);
  const header = `# larkx context · level ${level}${folder ? ' · folder ' + folder : ''} · ~${formatTokens(tokens)} tokens · ${fileNodes.length} files`;
  return `${header}\n${bodyText}`;
}

export function serializeFile(
  node: GraphNode,
  symbols: FileSymbols,
  summary?: string
): string {
  const lines: string[] = [];

  if (summary) {
    lines.push(`// ${summary}`);
  }

  const symPart = [
    ...symbols.functions.map(f => f.signature ? `${f.signature}@${f.line}` : `${f.name}@${f.line}`),
    ...symbols.classes.map(c => `class ${c.name}@${c.line}`),
  ].join(', ');

  const importPart = symbols.imports.map(i => `+${i.source}`).join(',');

  lines.push(`${node.file}[${node.lang ?? 'unknown'}]: ${truncatePart(symPart, MAX_SYM_CHARS)} | ${truncatePart(importPart, MAX_IMPORT_CHARS)}`);

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
