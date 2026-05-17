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
import type { GraphNode, GraphEdge } from '../graph/index.js';
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

export function startMCPServer(): void {
  const server = new Server(
    { name: 'larkx', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'get_project_index',
        description: 'Get compact overview of the codebase. Use level + folder to control token cost. ALWAYS use this first instead of reading files. level 1: file paths only (~5 tok/file) for "what files exist". level 2: + symbols (~80 tok/file) for general exploration. level 3: + function signatures (~150 tok/file) before refactoring. level 4: + AI summaries (~250 tok/file) for architectural questions. folder: scope to a subtree (cuts cost proportionally).',
        inputSchema: {
          type: 'object',
          properties: {
            level: { type: 'number', enum: [1, 2, 3, 4], description: 'Detail level: 1=paths, 2=symbols, 3=signatures, 4=summaries. Default 2.' },
            folder: { type: 'string', description: 'Restrict to files under this folder, e.g. "src/auth". Optional.' },
          },
          required: [],
        },
      },
      {
        name: 'get_file_summary',
        description: 'Get symbols and imports for one file without reading its full content',
        inputSchema: {
          type: 'object',
          properties: { filepath: { type: 'string', description: 'Relative file path' } },
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

    const graph = loadJson<{ nodes: GraphNode[]; edges: GraphEdge[] }>('graph.json');
    const index = loadJson<FileSymbols[]>('index.json');
    const summaries = loadJson<Record<string, string>>('summaries.json') ?? {};
    const nodes = graph?.nodes ?? [];

    const tool = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    let text = '';

    switch (tool) {
      case 'get_project_index': {
        const level = (args.level as ContextLevel) ?? 2;
        const folder = (args.folder as string) ?? null;
        text = serializeIndex(nodes, summaries, { level, folder, fileSymbols: index ?? [] });
        break;
      }

      case 'get_file_summary': {
        const fp = (args.filepath as string ?? '').replace(/\\/g, '/');
        const fileNode = nodes.find(n => n.type === 'file' && (n.file === fp || n.file.endsWith('/' + fp)));
        const fileSym = index?.find(s => s.file === fp || s.file.endsWith('/' + fp));
        if (!fileNode || !fileSym) {
          text = serializeError(`File not found in index: ${fp}`);
        } else {
          text = serializeFile(fileNode, fileSym, summaries[fileNode.file]);
        }
        break;
      }

      case 'search_symbol': {
        const query = ((args.name as string) ?? '').toLowerCase();
        const matches = nodes.filter(
          n => n.type !== 'file' && n.name.toLowerCase().includes(query)
        );
        if (matches.length === 0) {
          text = `No symbol found matching "${args.name}"`;
        } else {
          text = matches
            .map(n => `${n.name} — ${n.file} line ${n.line ?? '?'} (${n.type})`)
            .join('\n');
        }
        break;
      }

      case 'get_impact': {
        const fp = (args.filepath as string ?? '').replace(/\\/g, '/');
        const resolvedFp = nodes.find(n => n.type === 'file' && (n.file === fp || n.file.endsWith('/' + fp)))?.file ?? fp;
        const dependents = nodes.filter(n =>
          n.type === 'file' &&
          graph?.edges.some(e => e.to === resolvedFp && e.from === n.file && e.type === 'imports')
        );
        text = serializeImpact(resolvedFp, dependents);
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
        let targetNodes = nodes.filter(n => n.type === 'function' && n.name === sym);
        if (targetNodes.length === 0) {
          targetNodes = nodes.filter(n => n.type === 'function' && n.name.toLowerCase() === symLower);
        }
        if (targetNodes.length === 0) {
          targetNodes = nodes.filter(n => n.type === 'function' && n.name.toLowerCase().includes(symLower));
        }
        if (targetNodes.length === 0) {
          text = serializeError(`Symbol not found: ${sym}`);
          break;
        }
        const target = targetNodes[0];
        const callerIds = (graph?.edges ?? [])
          .filter(e => e.to === target.id && e.type === 'calls')
          .map(e => e.from);
        const calleeIds = (graph?.edges ?? [])
          .filter(e => e.from === target.id && e.type === 'calls')
          .map(e => e.to);
        const callers = nodes.filter(n => callerIds.includes(n.id));
        const callees = nodes.filter(n => calleeIds.includes(n.id));
        text = serializeCallChain(sym, callers, callees);
        break;
      }

      default:
        text = serializeError(`Unknown tool: ${tool}`);
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
