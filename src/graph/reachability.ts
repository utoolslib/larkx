import fs from 'fs';
import path from 'path';
import type { GraphNode, GraphEdge } from './index.js';

// Universal entry patterns — files that frameworks/runtimes pick up by convention,
// not by import. If a project file matches any of these, it's treated as a seed
// for reachability analysis.
const UNIVERSAL_ENTRY_PATTERNS: RegExp[] = [
  // Generic entry files
  /(?:^|\/)index\.(?:ts|tsx|js|jsx|mjs|cjs)$/,
  /(?:^|\/)main\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java)$/,
  /(?:^|\/)app\.(?:ts|tsx|js|jsx|mjs|cjs)$/,
  /(?:^|\/)cli\/index\.(?:ts|js)$/,
  // Tests (runner-discovered)
  /\.test\.(?:ts|tsx|js|jsx)$/,
  /\.spec\.(?:ts|tsx|js|jsx)$/,
  // Stories (Storybook)
  /\.stories\.(?:ts|tsx|js|jsx)$/,
  // Config files (build-tool entries)
  /(?:^|\/)[a-zA-Z][\w-]*\.config\.(?:ts|js|mjs|cjs)$/,
];

// Framework-specific entry patterns activated when package.json indicates the framework.
const FRAMEWORK_PATTERNS: Record<string, RegExp[]> = {
  next: [
    /(?:^|\/)app\/.*\/?(?:page|layout|loading|error|not-found|template|default|route)\.(?:ts|tsx|js|jsx)$/,
    /(?:^|\/)pages\/.+\.(?:ts|tsx|js|jsx)$/,
    /(?:^|\/)middleware\.(?:ts|js)$/,
    /(?:^|\/)next\.config\.(?:ts|js|mjs)$/,
    /(?:^|\/)instrumentation\.(?:ts|js)$/,
  ],
  '@nestjs/core': [
    /\.controller\.(?:ts|js)$/,
    /\.module\.(?:ts|js)$/,
    /\.service\.(?:ts|js)$/,
    /\.guard\.(?:ts|js)$/,
    /(?:^|\/)main\.(?:ts|js)$/,
  ],
  '@angular/core': [
    /\.component\.(?:ts|js)$/,
    /\.module\.(?:ts|js)$/,
    /\.service\.(?:ts|js)$/,
  ],
  express: [
    /(?:^|\/)routes\/.+\.(?:ts|js)$/,
    /(?:^|\/)server\.(?:ts|js)$/,
  ],
  fastify: [
    /(?:^|\/)routes\/.+\.(?:ts|js)$/,
  ],
  vite: [
    /(?:^|\/)vite\.config\.(?:ts|js|mjs)$/,
  ],
  '@sveltejs/kit': [
    /(?:^|\/)\+(?:page|layout|server|error)\.(?:ts|tsx|js|svelte)$/,
  ],
  remix: [
    /(?:^|\/)routes\/.+\.(?:ts|tsx|js|jsx)$/,
    /(?:^|\/)root\.(?:ts|tsx|js|jsx)$/,
  ],
};

export function detectFrameworks(projectRoot: string): string[] {
  const pkgPath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return [];
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    return Object.keys(FRAMEWORK_PATTERNS).filter(name => all[name] !== undefined);
  } catch {
    return [];
  }
}

export function getEntryPatterns(projectRoot: string, userEntryPoints: string[]): RegExp[] {
  const frameworks = detectFrameworks(projectRoot);
  const patterns: RegExp[] = [...UNIVERSAL_ENTRY_PATTERNS];
  for (const fw of frameworks) {
    patterns.push(...FRAMEWORK_PATTERNS[fw]);
  }
  // User-defined entry points: treat as literal globs (matched as prefix or exact)
  for (const ep of userEntryPoints) {
    const norm = ep.replace(/\\/g, '/').replace(/\/$/, '');
    // exact file or anything under that folder
    patterns.push(new RegExp(`^${norm.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}(?:/.*)?$`));
  }
  return patterns;
}

export function isEntryFile(file: string, patterns: RegExp[]): boolean {
  const norm = file.replace(/\\/g, '/');
  return patterns.some(p => p.test(norm));
}

// BFS reachability from seed files through any kind of edge.
// Returns the set of node IDs reachable from any entry.
export function computeReachable(
  nodes: GraphNode[],
  edges: GraphEdge[],
  entryPatterns: RegExp[]
): Set<string> {
  // Build adjacency (forward + reverse to catch test-runner / contains-style)
  const forward = new Map<string, string[]>();
  for (const e of edges) {
    const arr = forward.get(e.from) ?? [];
    arr.push(e.to);
    forward.set(e.from, arr);
  }

  const seeds: string[] = nodes
    .filter(n => n.type === 'file' && isEntryFile(n.file, entryPatterns))
    .map(n => n.id);

  const visited = new Set<string>(seeds);
  const queue = [...seeds];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of forward.get(cur) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return visited;
}

export function findDeadNodes(
  nodes: GraphNode[],
  edges: GraphEdge[],
  projectRoot: string,
  userEntryPoints: string[]
): GraphNode[] {
  const patterns = getEntryPatterns(projectRoot, userEntryPoints);
  const reachable = computeReachable(nodes, edges, patterns);
  return nodes.filter(n => {
    if (reachable.has(n.id)) return false;
    if (n.type === 'file') return true;
    if (n.type === 'function') return true;
    return false;
  });
}
