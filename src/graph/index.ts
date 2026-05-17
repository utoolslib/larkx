import path from 'path';
import type { FileSymbols } from '../parser/treesitter.js';

export type NodeType = 'file' | 'function' | 'class';
export type EdgeType = 'contains' | 'imports' | 'calls' | 'inherits' | 'tested_by';

export type GraphNode = {
  id: string;
  type: NodeType;
  file: string;
  name: string;
  line?: number;
  lang?: string;
};

export type GraphEdge = {
  from: string;
  to: string;
  type: EdgeType;
};

export type Graph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

function isTestFile(filePath: string): boolean {
  return filePath.includes('test') || filePath.includes('.spec.') || filePath.includes('.test.');
}

function resolveImport(fromFile: string, importSource: string, fileSet: Set<string>): string | null {
  if (!importSource.startsWith('.')) return null;

  const dir = path.dirname(fromFile);
  const rawResolved = path.join(dir, importSource).replace(/\\/g, '/');

  // strip existing extension so we can try all variants
  const base = rawResolved.replace(/\.(js|jsx|ts|tsx|mjs|cjs)$/, '');

  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
  for (const ext of extensions) {
    const candidate = base + ext;
    if (fileSet.has(candidate)) return candidate;
  }
  if (fileSet.has(rawResolved)) return rawResolved;

  // try index file
  for (const ext of extensions) {
    const candidate = base + '/index' + ext;
    if (fileSet.has(candidate)) return candidate;
  }

  return null;
}

export function buildGraph(allFileSymbols: FileSymbols[]): Graph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeIds = new Set<string>();
  const edgeKeys = new Set<string>();
  const fileSet = new Set(allFileSymbols.map(f => f.file));

  function addNode(node: GraphNode): void {
    if (!nodeIds.has(node.id)) {
      nodeIds.add(node.id);
      nodes.push(node);
    }
  }

  function addEdge(from: string, to: string, type: EdgeType): void {
    const key = `${from}|${to}|${type}`;
    if (!edgeKeys.has(key)) {
      edgeKeys.add(key);
      edges.push({ from, to, type });
    }
  }

  // first pass: create all nodes
  for (const sym of allFileSymbols) {
    addNode({
      id: sym.file,
      type: 'file',
      file: sym.file,
      name: path.basename(sym.file),
      lang: sym.lang,
    });

    const isTest = isTestFile(sym.file);

    for (const fn of sym.functions) {
      const fnId = `${sym.file}::${fn.name}`;
      addNode({
        id: fnId,
        type: 'function',
        file: sym.file,
        name: fn.name,
        line: fn.line,
      });
      addEdge(sym.file, fnId, isTest ? 'tested_by' : 'contains');
    }

    for (const cls of sym.classes) {
      const clsId = `${sym.file}::${cls.name}`;
      addNode({
        id: clsId,
        type: 'class',
        file: sym.file,
        name: cls.name,
        line: cls.line,
      });
      addEdge(sym.file, clsId, 'contains');
    }
  }

  // second pass: imports and calls edges
  for (const sym of allFileSymbols) {
    for (const imp of sym.imports) {
      const targetFile = resolveImport(sym.file, imp.source, fileSet);
      if (targetFile) {
        addEdge(sym.file, targetFile, 'imports');
      }
    }

    for (const call of sym.calls) {
      const callerId = `${sym.file}::${call.caller}`;
      if (!nodeIds.has(callerId)) continue;

      // search all nodes for a function with matching name
      let found = false;
      for (const node of nodes) {
        if (node.type === 'function' && node.name === call.callee && node.id !== callerId) {
          addEdge(callerId, node.id, 'calls');
          found = true;
          break;
        }
      }
      // Also try same-file call
      if (!found) {
        const sameFileCalleeId = `${sym.file}::${call.callee}`;
        if (nodeIds.has(sameFileCalleeId) && sameFileCalleeId !== callerId) {
          addEdge(callerId, sameFileCalleeId, 'calls');
        }
      }
    }
  }

  return { nodes, edges };
}
