import fs from 'fs';
import path from 'path';

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage',
  '.larkx', '.turbo', '.cache', '__pycache__',
]);

const IGNORE_PATTERNS = [
  /\.min\.js$/,
  /\.min\.css$/,
  /\.lock$/,
  /\.log$/,
  /^package-lock\.json$/,
  /^yarn\.lock$/,
  /^pnpm-lock\.yaml$/,
];

const SUPPORTED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.cpp', '.c', '.cs',
]);

function parseIgnoreFile(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
}

function matchesIgnorePattern(relPath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (!pattern) continue;
    const normalized = pattern.replace(/\\/g, '/');
    const relNorm = relPath.replace(/\\/g, '/');
    if (normalized.endsWith('/')) {
      if (relNorm.startsWith(normalized) || relNorm.includes('/' + normalized)) return true;
    } else if (normalized.includes('/')) {
      if (relNorm === normalized || relNorm.startsWith(normalized + '/')) return true;
    } else {
      const parts = relNorm.split('/');
      if (parts.includes(normalized) || parts[parts.length - 1] === normalized) return true;
      if (normalized.includes('*')) {
        const regex = new RegExp('^' + normalized.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
        if (regex.test(parts[parts.length - 1])) return true;
      }
    }
  }
  return false;
}

function walkDir(
  dir: string,
  projectRoot: string,
  ignorePatterns: string[],
  results: string[]
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(projectRoot, fullPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      if (matchesIgnorePattern(relPath, ignorePatterns)) continue;
      walkDir(fullPath, projectRoot, ignorePatterns, results);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (!SUPPORTED_EXTENSIONS.has(ext)) continue;
      if (IGNORE_PATTERNS.some(p => p.test(entry.name))) continue;
      if (matchesIgnorePattern(relPath, ignorePatterns)) continue;
      results.push(relPath);
    }
  }
}

export function walkProject(projectRoot: string, extraExclude: string[] = []): string[] {
  const gitignorePatterns = parseIgnoreFile(path.join(projectRoot, '.gitignore'));
  const claudeignorePatterns = parseIgnoreFile(path.join(projectRoot, '.claudeignore'));
  const ignorePatterns = [...gitignorePatterns, ...claudeignorePatterns, ...extraExclude];

  const results: string[] = [];
  walkDir(projectRoot, projectRoot, ignorePatterns, results);
  results.sort();

  console.log(`✓ Found ${results.length} files`);
  return results;
}
