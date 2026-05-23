import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import path from 'path';
import fs from 'fs';
import {
  serializeIndex,
  serializeFile,
  serializeImpact,
  serializeCallChain,
  serializeDeadCode,
  serializeError,
  type ContextLevel,
} from './serializer.js';
import type { GraphNode, GraphEdge, ReverseIndex } from '../graph/index.js';
import type { FileSymbols } from '../parser/treesitter.js';
import { findDeadNodes } from '../graph/reachability.js';
import { loadConfig } from '../storage/index.js';

function getProjectRoot(): string {
  return process.cwd();
}

function cgPath(file: string): string {
  return path.join(getProjectRoot(), '.larkx', file);
}

function isReady(): boolean {
  return fs.existsSync(path.join(getProjectRoot(), '.larkx'));
}

function loadJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(cgPath(file), 'utf-8')) as T;
  } catch {
    return null;
  }
}

type CacheData = {
  graph: { nodes: GraphNode[]; edges: GraphEdge[] } | null;
  index: FileSymbols[] | null;
  summaries: Record<string, string>;
  mtimeMs: number;
  // Derived indexes for O(1) lookup
  symbolsByName: Map<string, GraphNode[]>;
  nodesByFile: Map<string, GraphNode[]>;
  fileNodeByPath: Map<string, GraphNode>;
  dependents: Map<string, GraphNode[]>;
  callersByFn: Map<string, string[]>;
  calleesByFn: Map<string, string[]>;
  nodeById: Map<string, GraphNode>;
};

let cache: CacheData | null = null;

const RESPONSE_CACHE_CAP = 20;
const responseCache = new Map<string, string>();

const INLINE_LINE_THRESHOLD = 150;

function fileMtime(file: string): number {
  try { return fs.statSync(cgPath(file)).mtimeMs; } catch { return 0; }
}

function buildIndexes(
  graph: { nodes: GraphNode[]; edges: GraphEdge[] } | null,
  reverse: ReverseIndex | null
): Pick<CacheData, 'symbolsByName' | 'nodesByFile' | 'fileNodeByPath' | 'dependents' | 'callersByFn' | 'calleesByFn' | 'nodeById'> {
  const symbolsByName = new Map<string, GraphNode[]>();
  const nodesByFile = new Map<string, GraphNode[]>();
  const fileNodeByPath = new Map<string, GraphNode>();
  const dependents = new Map<string, GraphNode[]>();
  const callersByFn = new Map<string, string[]>();
  const calleesByFn = new Map<string, string[]>();
  const nodeById = new Map<string, GraphNode>();

  if (!graph) return { symbolsByName, nodesByFile, fileNodeByPath, dependents, callersByFn, calleesByFn, nodeById };

  for (const n of graph.nodes) {
    nodeById.set(n.id, n);
    if (n.type === 'file') {
      fileNodeByPath.set(n.file, n);
    } else {
      const key = n.name.toLowerCase();
      const arr = symbolsByName.get(key);
      if (arr) arr.push(n); else symbolsByName.set(key, [n]);

      const fileArr = nodesByFile.get(n.file);
      if (fileArr) fileArr.push(n); else nodesByFile.set(n.file, [n]);
    }
  }

  if (reverse) {
    // Fast path: use precomputed reverse index from disk
    for (const [file, importerPaths] of Object.entries(reverse.dependents)) {
      const importerNodes = importerPaths
        .map(p => fileNodeByPath.get(p))
        .filter((n): n is GraphNode => !!n);
      if (importerNodes.length > 0) dependents.set(file, importerNodes);
    }
    for (const [fnId, callerIds] of Object.entries(reverse.callers)) {
      callersByFn.set(fnId, callerIds);
    }
    // calleesByFn still needs forward-edge scan since reverse.json only stores reverse maps
    for (const e of graph.edges) {
      if (e.type === 'calls') {
        const out = calleesByFn.get(e.from);
        if (out) out.push(e.to); else calleesByFn.set(e.from, [e.to]);
      }
    }
  } else {
    // Fallback: build everything in memory from edges
    for (const e of graph.edges) {
      if (e.type === 'imports') {
        const fromNode = fileNodeByPath.get(e.from);
        if (fromNode) {
          const arr = dependents.get(e.to);
          if (arr) arr.push(fromNode); else dependents.set(e.to, [fromNode]);
        }
      } else if (e.type === 'calls') {
        const out = calleesByFn.get(e.from);
        if (out) out.push(e.to); else calleesByFn.set(e.from, [e.to]);
        const inc = callersByFn.get(e.to);
        if (inc) inc.push(e.from); else callersByFn.set(e.to, [e.from]);
      }
    }
  }

  return { symbolsByName, nodesByFile, fileNodeByPath, dependents, callersByFn, calleesByFn, nodeById };
}

function loadCached(): CacheData {
  const mtimeMs = Math.max(
    fileMtime('graph.json'),
    fileMtime('index.json'),
    fileMtime('summaries.json'),
    fileMtime('reverse.json'),
  );
  if (cache && cache.mtimeMs === mtimeMs) {
    return cache;
  }
  // Index changed — invalidate the response cache too
  responseCache.clear();
  const graph = loadJson<{ nodes: GraphNode[]; edges: GraphEdge[] }>('graph.json');
  const reverse = loadJson<ReverseIndex>('reverse.json');
  const indexes = buildIndexes(graph, reverse);
  cache = {
    graph,
    index: loadJson<FileSymbols[]>('index.json'),
    summaries: loadJson<Record<string, string>>('summaries.json') ?? {},
    mtimeMs,
    ...indexes,
  };
  return cache;
}

export function startMCPServer(): void {
  const server = new Server(
    { name: 'larkx', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'get_project_index',
        description: 'Get compact overview of the codebase. Use level + folder to control token cost. ALWAYS use this first instead of reading files. level 1: file paths only (~5 tok/file) for "what files exist". level 2: + symbols (~80 tok/file) for general exploration. level 3: + function signatures (~150 tok/file) before refactoring. level 4: + AI summaries (~250 tok/file) for architectural questions. folder: scope to a subtree (cuts cost proportionally). omit_internal: hide noisy internal symbols for 20-40% smaller output. rank: order files by import-frequency centrality (most depended-on first). limit: cap output to top N files (implies rank).',
        inputSchema: {
          type: 'object',
          properties: {
            level: { type: 'number', enum: [1, 2, 3, 4], description: 'Detail level: 1=paths, 2=symbols, 3=signatures, 4=summaries. Default 2.' },
            folder: { type: 'string', description: 'Restrict to files under this folder, e.g. "src/auth". Optional.' },
            omit_internal: { type: 'boolean', description: 'Hide internal/private symbols (names starting with _ or $, single-letter names, common test helpers). Default false.' },
            rank: { type: 'boolean', description: 'Sort files by importance (dependent count + 0.1 × symbol count, ties broken by path). Default false.' },
            limit: { type: 'number', description: 'Show only the top N files. Implies rank=true. Output ends with a "… (X more files; pass limit=null to see all)" footer.' },
            expand: { type: 'array', items: { type: 'string' }, description: 'List of folder paths to inline even if they exceed the 15-file collapse threshold (e.g. ["src/components"]). Dense folders are auto-collapsed to a one-line summary; use expand to opt back into full listing for specific ones.' },
          },
          required: [],
        },
      },
      {
        name: 'get_file_summary',
        description: 'Get symbols, imports, and (for small files ≤150 lines) the full file content inlined — no separate read needed. Returns the AI summary if available, then symbols/imports, then file content when inlined.',
        inputSchema: {
          type: 'object',
          properties: {
            filepath: { type: 'string', description: 'Relative file path' },
            omit_internal: { type: 'boolean', description: 'Hide internal/private symbols. Default false.' },
            inline: { type: 'string', enum: ['auto', 'always', 'never'], description: 'Inline full file content. "auto" (default): inline if file ≤150 lines. "always": always inline regardless of size. "never": symbols only (legacy behavior).' },
          },
          required: ['filepath'],
        },
      },
      {
        name: 'search_symbol',
        description: 'Find which file and line a function or class is defined in',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string', description: 'Symbol name to search for' } },
          required: ['name'],
        },
      },
      {
        name: 'get_impact',
        description: 'Find all files that depend on or import a given file. Use before making changes.',
        inputSchema: {
          type: 'object',
          properties: { filepath: { type: 'string', description: 'Relative file path' } },
          required: ['filepath'],
        },
      },
      {
        name: 'get_dead_code',
        description: 'Find files and functions that nothing else calls or imports',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'get_call_chain',
        description: 'Trace what calls a symbol and what that symbol calls',
        inputSchema: {
          type: 'object',
          properties: { symbol: { type: 'string', description: 'Function or symbol name' } },
          required: ['symbol'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (!isReady()) {
      return { content: [{ type: 'text', text: serializeError("Run 'larkx index' first") }] };
    }

    const cached = loadCached();
    const { graph, index, summaries } = cached;
    const nodes = graph?.nodes ?? [];

    const tool = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    const cacheKey = `${tool}:${JSON.stringify(args)}:${cached.mtimeMs}`;
    const hit = responseCache.get(cacheKey);
    if (hit !== undefined) {
      // LRU bump: re-insert so this becomes the most recently used
      responseCache.delete(cacheKey);
      responseCache.set(cacheKey, hit);
      if (process.env.LARKX_DEBUG) console.error(`[larkx] cache hit ${cacheKey}`);
      return { content: [{ type: 'text', text: hit }] };
    }

    let text = '';

    switch (tool) {
      case 'get_project_index': {
        const level = (args.level as ContextLevel) ?? 2;
        const folder = (args.folder as string) ?? null;
        const omitInternal = (args.omit_internal as boolean) ?? false;
        const rank = (args.rank as boolean) ?? false;
        const limit = typeof args.limit === 'number' ? args.limit : undefined;
        const expand = Array.isArray(args.expand) ? (args.expand as string[]) : undefined;
        let importance: Map<string, number> | undefined;
        if (rank || limit !== undefined) {
          importance = new Map<string, number>();
          for (const n of nodes) {
            if (n.type === 'file') {
              const depCount = cached.dependents.get(n.file)?.length ?? 0;
              const symCount = cached.nodesByFile.get(n.file)?.length ?? 0;
              importance.set(n.file, depCount + 0.1 * symCount);
            }
          }
        }
        text = serializeIndex(nodes, summaries, { level, folder, fileSymbols: index ?? [], omitInternal, importance, limit, expand });
        break;
      }

      case 'get_file_summary': {
        const fp = (args.filepath as string ?? '').replace(/\\/g, '/');
        const omitInternal = (args.omit_internal as boolean) ?? false;
        const inline = (args.inline as 'auto' | 'always' | 'never') ?? 'auto';
        const fileNode = nodes.find(n => n.type === 'file' && (n.file === fp || n.file.endsWith('/' + fp)));
        const fileSym = index?.find(s => s.file === fp || s.file.endsWith('/' + fp));
        if (!fileNode || !fileSym) {
          text = serializeError(`File not found in index: ${fp}`);
        } else {
          text = serializeFile(fileNode, fileSym, summaries[fileNode.file], { omitInternal });
          if (inline !== 'never') {
            try {
              const abs = path.join(getProjectRoot(), fileNode.file);
              const content = fs.readFileSync(abs, 'utf-8');
              const lineCount = content.split('\n').length;
              const shouldInline = inline === 'always' || (inline === 'auto' && lineCount <= INLINE_LINE_THRESHOLD);
              if (shouldInline) {
                text += `\n\n--- Full file content (${lineCount} lines, inlined to avoid a follow-up read) ---\n${content}`;
              }
            } catch {
              // file not readable — fall back to symbols-only output
            }
          }
        }
        break;
      }

      case 'search_symbol': {
        const query = ((args.name as string) ?? '').toLowerCase();
        const matches: GraphNode[] = [];
        for (const [name, ns] of cached.symbolsByName) {
          if (name.includes(query)) {
            for (const n of ns) matches.push(n);
          }
        }
        if (matches.length === 0) {
          text = `No symbol found matching "${args.name}"`;
        } else {
          text = matches
            .map(n => `${n.name}@${n.line ?? '?'} ${n.file} (${n.type})`)
            .join('\n');
        }
        break;
      }

      case 'get_impact': {
        const fp = (args.filepath as string ?? '').replace(/\\/g, '/');
        let resolvedFp = fp;
        if (!cached.fileNodeByPath.has(fp)) {
          for (const [p] of cached.fileNodeByPath) {
            if (p.endsWith('/' + fp)) { resolvedFp = p; break; }
          }
        }
        const deps = cached.dependents.get(resolvedFp) ?? [];
        text = serializeImpact(resolvedFp, deps);
        break;
      }

      case 'get_dead_code': {
        const config = loadConfig(getProjectRoot());
        const dead = findDeadNodes(nodes, graph?.edges ?? [], getProjectRoot(), config.entryPoints);
        text = serializeDeadCode(dead);
        break;
      }

      case 'get_call_chain': {
        const sym = (args.symbol as string) ?? '';
        const symLower = sym.toLowerCase();
        const candidates = (cached.symbolsByName.get(symLower) ?? []).filter(n => n.type === 'function');
        let targetNodes: GraphNode[] = candidates.filter(n => n.name === sym);
        if (targetNodes.length === 0) targetNodes = candidates;
        if (targetNodes.length === 0) {
          for (const [name, ns] of cached.symbolsByName) {
            if (name.includes(symLower)) {
              for (const n of ns) if (n.type === 'function') targetNodes.push(n);
            }
          }
        }
        if (targetNodes.length === 0) {
          text = serializeError(`Symbol not found: ${sym}`);
          break;
        }
        const target = targetNodes[0];
        const callerIds = cached.callersByFn.get(target.id) ?? [];
        const calleeIds = cached.calleesByFn.get(target.id) ?? [];
        const callers = callerIds.map(id => cached.nodeById.get(id)).filter((n): n is GraphNode => !!n);
        const callees = calleeIds.map(id => cached.nodeById.get(id)).filter((n): n is GraphNode => !!n);
        text = serializeCallChain(sym, callers, callees);
        break;
      }

      default:
        text = serializeError(`Unknown tool: ${tool}`);
    }

    responseCache.set(cacheKey, text);
    if (responseCache.size > RESPONSE_CACHE_CAP) {
      const oldest = responseCache.keys().next().value;
      if (oldest !== undefined) responseCache.delete(oldest);
    }

    return { content: [{ type: 'text', text }] };
  });

  const transport = new StdioServerTransport();
  server.connect(transport);
}

export async function checkMCPServer(): Promise<void> {
  const { spawn } = await import('child_process');
  const binPath = new URL('../../bin/larkx.js', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');

  const child = spawn(process.execPath, [binPath, 'mcp'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const initRequest = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'health-check', version: '1' },
    },
  });

  let responded = false;

  child.stdout.on('data', (data: Buffer) => {
    const text = data.toString();
    if (text.includes('"result"') || text.includes('"id"')) {
      responded = true;
      child.kill();
      console.log('✓ MCP server responding correctly');
      process.exit(0);
    }
  });

  child.stdin.write(initRequest + '\n');

  setTimeout(() => {
    child.kill();
    if (!responded) {
      console.log('✗ MCP server did not respond');
      process.exit(1);
    }
  }, 5000);
}
