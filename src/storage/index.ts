import fs from 'fs';
import path from 'path';

function cgDir(projectRoot: string): string {
  return path.join(projectRoot, '.larkx');
}

function cgFile(projectRoot: string, name: string): string {
  return path.join(cgDir(projectRoot), name);
}

function writeJson(filePath: string, data: object): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function readJson(filePath: string): object | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

const DEFAULT_CONFIG: CodeGraphConfig = {
  exclude: [
    '.env',
    '.env.*',
    '*.key',
    '*.pem',
    '*.cert',
    '*.crt',
    '*.p12',
    '*.pfx',
    '*.jks',
    'credentials*',
    'secrets/',
    'private/',
    '*.secret',
    '*.token',
  ],
  entryPoints: [],
};

export type AiConfig = {
  provider: 'local-claude' | 'anthropic';
  apiKey?: string;
};

export type CodeGraphConfig = {
  exclude: string[];
  entryPoints: string[];
  ai?: AiConfig;
  agents?: string[];
  mcpEnabled?: boolean;
};

export function initStorage(projectRoot: string): void {
  const dir = cgDir(projectRoot);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const dataDefaults: Record<string, object> = {
    'index.json': [],
    'graph.json': { nodes: [], edges: [] },
    'summaries.json': {},
    'meta.json': {},
  };
  for (const [f, defaultVal] of Object.entries(dataDefaults)) {
    const fp = path.join(dir, f);
    if (!fs.existsSync(fp)) {
      fs.writeFileSync(fp, JSON.stringify(defaultVal, null, 2), 'utf-8');
    }
  }

  const configPath = cgFile(projectRoot, 'config.json');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
  }

  const gitignorePath = path.join(projectRoot, '.gitignore');
  const entry = '.larkx';
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    if (!content.includes(entry)) {
      fs.appendFileSync(gitignorePath, `\n${entry}\n`, 'utf-8');
    }
  } else {
    fs.writeFileSync(gitignorePath, `${entry}\n`, 'utf-8');
  }

  console.log('✓ Initialized .larkx/');
}

export function saveIndex(projectRoot: string, data: object): void {
  writeJson(cgFile(projectRoot, 'index.json'), data);
}

export function loadIndex(projectRoot: string): object | null {
  return readJson(cgFile(projectRoot, 'index.json'));
}

export function saveGraph(projectRoot: string, data: object): void {
  writeJson(cgFile(projectRoot, 'graph.json'), data);
}

export function loadGraph(projectRoot: string): object | null {
  return readJson(cgFile(projectRoot, 'graph.json'));
}

export function saveReverseIndex(projectRoot: string, data: object): void {
  writeJson(cgFile(projectRoot, 'reverse.json'), data);
}

export function loadReverseIndex(projectRoot: string): object | null {
  return readJson(cgFile(projectRoot, 'reverse.json'));
}

export function saveContext(projectRoot: string, content: string): void {
  fs.writeFileSync(cgFile(projectRoot, 'context.md'), content, 'utf-8');
}

export function saveSummaries(projectRoot: string, data: object): void {
  writeJson(cgFile(projectRoot, 'summaries.json'), data);
}

export function loadSummaries(projectRoot: string): object | null {
  return readJson(cgFile(projectRoot, 'summaries.json'));
}

export function saveMeta(projectRoot: string, data: object): void {
  writeJson(cgFile(projectRoot, 'meta.json'), data);
}

export function loadConfig(projectRoot: string): CodeGraphConfig {
  const raw = readJson(cgFile(projectRoot, 'config.json')) as Partial<CodeGraphConfig> | null;
  return {
    exclude:     raw?.exclude     ?? DEFAULT_CONFIG.exclude,
    entryPoints: raw?.entryPoints ?? DEFAULT_CONFIG.entryPoints,
    ai:          raw?.ai,
    agents:      raw?.agents,
    mcpEnabled:  raw?.mcpEnabled,
  };
}

export function isInitialized(projectRoot: string): boolean {
  return fs.existsSync(cgDir(projectRoot));
}
