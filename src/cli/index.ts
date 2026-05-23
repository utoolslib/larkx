import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AGENT_CONFIGS, getInstruction, createAgentFile } from '../agents.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getVersion(): string {
  try {
    const pkgPath = path.join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.version ?? '0.1.0';
  } catch {
    return '0.1.0';
  }
}


const program = new Command();

program
  .name('larkx')
  .description('Code intelligence graph for AI agents — reduce token usage by 60-85%')
  .version(`larkx v${getVersion()}`, '-v, --version', 'Print version');

// init
program
  .command('init')
  .description('Initialize .larkx/ in current directory')
  .action(async () => {
    const { isInitialized, initStorage } = await import('../storage/index.js');
    const projectRoot = process.cwd();
    if (isInitialized(projectRoot)) {
      console.log(chalk.yellow('⚠ Already initialized. Run: larkx index'));
      return;
    }
    initStorage(projectRoot);

    // Ask about AI summaries
    await promptAI(projectRoot);


    const mcpEnabled = await promptMCP(projectRoot);

    // which agen to configure, then create their files + hooks
    const agents = await promptAgents();
    const silentHook = agents.includes('claude') ? await promptHookMode() : true;
    createAgentFiles(projectRoot, agents, mcpEnabled, silentHook);

    console.log(chalk.green('✓ Initialized. Run: larkx index'));
  });

// index
program
  .command('index')
  .description('Index the project')
  .option('--force', 'Re-parse all files, ignoring cache')
  .option('--ai', 'Generate AI summaries after indexing (requires ANTHROPIC_API_KEY)')
  .option('--watch', 'Watch for file changes and re-index automatically')
  .action(async (opts) => {
    const { isInitialized } = await import('../storage/index.js');
    const { indexProject, watchProject } = await import('../parser/index.js');
    const projectRoot = process.cwd();

    if (!isInitialized(projectRoot)) {
      console.error(chalk.red('✗ Not initialized. Run: larkx init'));
      process.exit(1);
    }

    const result = await indexProject(projectRoot, { force: opts.force });

    if (opts.ai) {
      const { loadConfig } = await import('../storage/index.js');
      const config = loadConfig(projectRoot);
      let aiConfig: { provider: 'local-claude' | 'anthropic'; apiKey?: string } | null = config.ai?.provider
        ? config.ai
        : process.env.ANTHROPIC_API_KEY
          ? { provider: 'anthropic' as const }
          : null;

      if (!aiConfig) {
        const hasClaude = await checkClaudeCLI();
        if (hasClaude) {
          saveAIConfig(projectRoot, { provider: 'local-claude' });
          aiConfig = { provider: 'local-claude' };
        } else {
          console.log(chalk.yellow('⚠ AI not configured.'));
          console.log(chalk.dim('  Install Claude Code (https://claude.ai/download) and re-run, or set ANTHROPIC_API_KEY.'));
        }
      }

      if (aiConfig) {
        const { generateSummaries } = await import('../ai/summarizer.js');
        await generateSummaries(projectRoot, result.nodes, aiConfig);
      }
    }

    if (opts.watch) {
      await watchProject(projectRoot);
    }
  });

// bench
program
  .command('bench [prompt...]')
  .description('Real before/after benchmark — runs Claude Code twice per query and reports actual tokens')
  .option('--only <ids>', 'Comma-separated query ids to run')
  .option('--ask <prompt>', 'Add a custom prompt on top of the suite')
  .option('--trials <n>', 'Average over N runs per side', '1')
  .option('--model <name>', 'Claude model to use (e.g. claude-haiku-4-5-20251001)')
  .option('--timeout <sec>', 'Per-call timeout in seconds', '120')
  .option('--detail', 'Show per-query token breakdown (input / cache-write / cache-read / output)')
  .option('--history [n]', 'Print trend table of last N saved runs without running new calls (default 10)')
  .action(async (prompt: string[], opts) => {
    const { runBenchmark, showBenchHistory } = await import('../bench/index.js');
    if (opts.history !== undefined) {
      const n = opts.history === true ? 10 : Number(opts.history) || 10;
      showBenchHistory(process.cwd(), n);
      return;
    }
    const ask = opts.ask ?? (prompt.length ? prompt.join(' ') : undefined);
    await runBenchmark(process.cwd(), {
      only: opts.only,
      ask,
      trials: Number(opts.trials) || 1,
      model: opts.model ?? null,
      timeoutSec: Number(opts.timeout) || 120,
      detail: !!opts.detail,
    });
  });

// stats
program
  .command('stats')
  .description('Show indexing statistics + AI token estimates')
  .action(async () => {
    const { isInitialized, loadIndex, loadGraph, loadSummaries } = await import('../storage/index.js');
    const { serializeIndex } = await import('../mcp/serializer.js');
    const { detectFrameworks } = await import('../graph/reachability.js');
    const { estimateTokens, formatTokens } = await import('../mcp/tokens.js');
    const projectRoot = process.cwd();

    if (!isInitialized(projectRoot)) {
      console.error(chalk.red('✗ Not initialized. Run: larkx init'));
      process.exit(1);
    }

    const metaPath = path.join(projectRoot, '.larkx', 'meta.json');
    if (!fs.existsSync(metaPath)) {
      console.error(chalk.red('✗ No index found. Run: larkx index'));
      process.exit(1);
    }

    const meta: any = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    const lastIndexed = meta.lastIndexed ? timeAgo(new Date(meta.lastIndexed)) : 'never';

    console.log(chalk.bold('\nProject Stats'));
    console.log(`  Files:        ${chalk.green(meta.fileCount ?? 0)}`);
    console.log(`  Functions:    ${chalk.green(meta.functionCount ?? 0)}`);
    console.log(`  Classes:      ${chalk.green(meta.classCount ?? 0)}`);
    console.log(`  Edges:        ${chalk.green(meta.edgeCount ?? 0)}`);
    console.log(`  Last indexed: ${chalk.cyan(lastIndexed)}`);

    if (meta.languages) {
      const langs = Object.entries(meta.languages as Record<string, number>)
        .map(([lang, count]) => `${lang} (${count})`)
        .join(', ');
      console.log(`  Languages:    ${chalk.cyan(langs)}`);
    }

    const frameworks = detectFrameworks(projectRoot);
    if (frameworks.length) {
      console.log(`  Frameworks:   ${chalk.cyan(frameworks.join(', '))}`);
    }

    // Token estimates
    const graph = loadGraph(projectRoot) as any | null;
    const index = loadIndex(projectRoot) as any[] | null;
    const summaries: Record<string, string> = (loadSummaries(projectRoot) as any) ?? {};

    if (graph?.nodes && index) {
      console.log(chalk.bold('\nAI Token Estimates (per get_project_index call)'));
      for (const level of [1, 2, 3, 4] as const) {
        const text = serializeIndex(graph.nodes, summaries, { level, fileSymbols: index });
        const tokens = estimateTokens(text);
        const label = ['paths', 'symbols', 'signatures', 'summaries'][level - 1];
        console.log(`  Level ${level} (${label.padEnd(10)}): ${chalk.green('~' + formatTokens(tokens) + ' tokens')}`);
      }

      // Rough comparison: reading every file fully
      const fileCount = meta.fileCount ?? 0;
      const fullRead = fileCount * 2000; // ~2KB avg file ≈ 600 tokens
      const fullTokens = Math.round(fullRead / 3.5);
      console.log(chalk.dim(`\n  Reading all files would cost ~${formatTokens(fullTokens)} tokens (rough estimate).`));
    }
  });

// search
program
  .command('search <symbol>')
  .description('Find a function or class by name')
  .action(async (symbol: string) => {
    const { isInitialized, loadIndex } = await import('../storage/index.js');
    const projectRoot = process.cwd();

    if (!isInitialized(projectRoot)) {
      console.error(chalk.red('✗ Not initialized. Run: larkx init'));
      process.exit(1);
    }

    const index = loadIndex(projectRoot) as any[] | null;
    if (!index || !Array.isArray(index)) {
      console.error(chalk.red('✗ No index found. Run: larkx index'));
      process.exit(1);
    }

    const results: string[] = [];
    const query = symbol.toLowerCase();

    for (const sym of index) {
      for (const fn of (sym.functions ?? [])) {
        if (fn.name.toLowerCase().includes(query)) {
          results.push(`${chalk.cyan(sym.file)}::${chalk.green(fn.name)} (function, line ${fn.line})`);
        }
      }
      for (const cls of (sym.classes ?? [])) {
        if (cls.name.toLowerCase().includes(query)) {
          results.push(`${chalk.cyan(sym.file)}::${chalk.blue(cls.name)} (class, line ${cls.line})`);
        }
      }
    }

    if (results.length === 0) {
      console.log(chalk.yellow(`No results for "${symbol}"`));
    } else {
      console.log(chalk.bold(`Search results for "${symbol}":`));
      results.forEach(r => console.log('  ' + r));
    }
  });

// impact
program
  .command('impact <filepath>')
  .description('Find all files that depend on a given file')
  .action(async (filepath: string) => {
    const { isInitialized, loadGraph } = await import('../storage/index.js');
    const projectRoot = process.cwd();

    if (!isInitialized(projectRoot)) {
      console.error(chalk.red('✗ Not initialized. Run: larkx init'));
      process.exit(1);
    }

    const graph = loadGraph(projectRoot) as any | null;
    if (!graph) {
      console.error(chalk.red('✗ No graph found. Run: larkx index'));
      process.exit(1);
    }

    const normalizedTarget = filepath.replace(/\\/g, '/');
    const dependents: string[] = [];

    for (const edge of (graph.edges ?? [])) {
      if (edge.to === normalizedTarget && edge.type === 'imports') {
        dependents.push(edge.from);
      }
    }

    if (dependents.length === 0) {
      console.log(chalk.yellow(`Nothing imports "${filepath}"`));
    } else {
      console.log(chalk.bold(`These files depend on ${chalk.cyan(filepath)}:`));
      dependents.forEach(d => console.log('  ' + chalk.cyan(d)));
    }
  });

// deadcode
program
  .command('deadcode')
  .description('Find files and functions unreachable from any entry point')
  .action(async () => {
    const { isInitialized, loadGraph, loadConfig } = await import('../storage/index.js');
    const { findDeadNodes, detectFrameworks } = await import('../graph/reachability.js');
    const projectRoot = process.cwd();

    if (!isInitialized(projectRoot)) {
      console.error(chalk.red('✗ Not initialized. Run: larkx init'));
      process.exit(1);
    }

    const graph = loadGraph(projectRoot) as { nodes: any[]; edges: any[] } | null;
    if (!graph) {
      console.error(chalk.red('✗ No graph found. Run: larkx index'));
      process.exit(1);
    }

    const config = loadConfig(projectRoot);
    const frameworks = detectFrameworks(projectRoot);
    if (frameworks.length) {
      console.log(chalk.dim(`Detected frameworks: ${frameworks.join(', ')}`));
    }

    const dead = findDeadNodes(graph.nodes, graph.edges, projectRoot, config.entryPoints);
    const deadFiles = dead.filter(n => n.type === 'file');
    const deadFunctions = dead.filter(n => n.type === 'function');

    if (dead.length === 0) {
      console.log(chalk.green('✓ No dead code found.'));
      return;
    }

    console.log(chalk.bold(`\nDead code (unreachable from entry points):`));
    if (deadFiles.length) {
      console.log(chalk.cyan(`\n  Files (${deadFiles.length}):`));
      deadFiles.forEach(n => console.log('    ' + chalk.yellow(n.file)));
    }
    if (deadFunctions.length) {
      console.log(chalk.cyan(`\n  Functions (${deadFunctions.length}):`));
      deadFunctions.forEach(n => console.log('    ' + chalk.yellow(`${n.name} — ${n.file}:${n.line ?? '?'}`)));
    }
  });

// serve
program
  .command('serve')
  .description('Open the graph in the browser')
  .option('--port <port>', 'Port number', '2911')
  .option('--watch', 'Also watch for file changes')
  .action(async (opts) => {
    const { isInitialized } = await import('../storage/index.js');
    const { startUIServer } = await import('../ui/index.js');
    const { watchProject } = await import('../parser/index.js');
    const projectRoot = process.cwd();

    if (!isInitialized(projectRoot)) {
      console.error(chalk.red('✗ Not initialized. Run: larkx init'));
      process.exit(1);
    }

    const port = parseInt(opts.port, 10) || 2911;
    await startUIServer(projectRoot, port);

    if (opts.watch) {
      await watchProject(projectRoot);
    }
  });

// setup-agents
program
  .command('setup-agents')
  .description('Create agent instruction files (CLAUDE.md, AGENTS.md, .cursorrules, etc.)')
  .action(async () => {
    const projectRoot = process.cwd();
    const mcpEnabled = await promptMCP(projectRoot);
    const agents = await promptAgents();
    if (agents.length === 0) {
      console.log(chalk.yellow('No agents selected.'));
      return;
    }
    const silentHook = agents.includes('claude') ? await promptHookMode() : true;
    createAgentFiles(projectRoot, agents, mcpEnabled, silentHook);
  });

// context
program
  .command('context')
  .description('Print compact project index to stdout (paste into any AI agent)')
  .option('--file <filepath>', 'Show context for a single file only')
  .option('--folder <folder>', 'Restrict to files under a folder (e.g. src/auth)')
  .option('--level <n>', 'Detail level: 1=paths, 2=symbols, 3=signatures, 4=summaries', '2')
  .action(async (opts) => {
    const { isInitialized, loadIndex, loadGraph, loadSummaries } = await import('../storage/index.js');
    const { serializeIndex, serializeFile } = await import('../mcp/serializer.js');
    const projectRoot = process.cwd();

    if (!isInitialized(projectRoot)) {
      console.error(chalk.red('✗ Not initialized. Run: larkx init'));
      process.exit(1);
    }

    const graph = loadGraph(projectRoot) as any | null;
    if (!graph || !graph.nodes) {
      console.error(chalk.red('✗ No index found. Run: larkx index'));
      process.exit(1);
    }

    const summaries: Record<string, string> = (loadSummaries(projectRoot) as any) ?? {};
    const index = loadIndex(projectRoot) as any[] | null;

    if (opts.file) {
      if (!index) {
        console.error(chalk.red('✗ No index found. Run: larkx index'));
        process.exit(1);
      }
      const normalized = opts.file.replace(/\\/g, '/');
      const sym = index.find((s: any) => s.file === normalized || s.file.endsWith(normalized));
      if (!sym) {
        console.error(chalk.red(`✗ File not found in index: ${opts.file}`));
        process.exit(1);
      }
      const node = graph.nodes.find((n: any) => n.type === 'file' && n.file === sym.file);
      if (node) {
        process.stdout.write(serializeFile(node, sym, summaries[sym.file]) + '\n');
      }
    } else {
      const level = Math.max(1, Math.min(4, parseInt(opts.level, 10) || 2)) as 1 | 2 | 3 | 4;
      const folder = opts.folder ?? null;
      process.stdout.write(serializeIndex(graph.nodes, summaries, { level, folder, fileSymbols: index ?? [] }) + '\n');
    }
  });

// mcp
program
  .command('mcp')
  .description('Start the MCP server for Claude Code')
  .option('--check', 'Health check: ping MCP server and exit 0/1')
  .action(async (opts) => {
    if (opts.check) {
      const { checkMCPServer } = await import('../mcp/index.js');
      await checkMCPServer();
    } else {
      const { startMCPServer } = await import('../mcp/index.js');
      startMCPServer();
    }
  });



const LARKX_BENCH_SLASH_COMMAND = `---
description: Real before/after token benchmark — runs Claude Code twice per query (with and without larkx MCP) and reports actual tokens
argument-hint: "[\\"custom prompt\\"] | [--only=<ids>] [--model=<name>]"
---

Run the larkx real benchmark and report the results.

Usage:
- \`/larkx-bench\` — full auto-generated suite (6 queries from your project)
- \`/larkx-bench --only=overview\` — subset of the suite
- \`/larkx-bench "How does authentication work?"\` — suite **plus** your custom prompt
- \`/larkx-bench --only=overview "How does auth work?"\` — subset **plus** custom
- \`/larkx-bench --ask "Where is X defined?"\` — explicit flag form

!\`larkx bench $ARGUMENTS\`

When the command finishes, summarise:
1. Per-query token reduction (baseline vs larkx, % saved)
2. Total cost difference in USD
3. Any queries that errored or were rate-limited

The numbers come from Claude Code's own \`--output-format json\` usage block — they are real tokens billed by the API, not estimates.
`;


async function checkClaudeCLI(): Promise<boolean> {
  const { execSync } = await import('child_process');
  try {
    execSync('claude --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function saveAIConfig(projectRoot: string, ai: { provider: 'local-claude' | 'anthropic'; apiKey?: string }): void {
  const configPath = path.join(projectRoot, '.larkx', 'config.json');
  try {
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    existing.ai = ai;
    fs.writeFileSync(configPath, JSON.stringify(existing, null, 2), 'utf-8');
    const label = ai.provider === 'local-claude' ? 'Local Claude (no key needed)' : 'Anthropic API key';
    console.log(chalk.green(`  ✓ AI summaries configured (${label})`));
    console.log(chalk.dim('    Run: larkx index --ai'));
  } catch {
    console.log(chalk.yellow('  ⚠ Could not save AI config'));
  }
}

async function promptAI(projectRoot: string): Promise<void> {
  try {
    const { select, input } = await import('@inquirer/prompts');

    const provider = await select<'local-claude' | 'anthropic' | 'skip'>({
      message: 'AI summaries — how do you want to generate them?',
      choices: [
        { name: 'Skip  (recommended — summaries cost extra tokens)', value: 'skip' },
        { name: 'Local Claude  (uses your Claude subscription — no key needed)', value: 'local-claude' },
        { name: 'Anthropic API key', value: 'anthropic' },
      ],
    });

    if (provider === 'skip') return;

    if (provider === 'local-claude') {
      const available = await checkClaudeCLI();
      if (!available) {
        console.log(chalk.yellow('  ⚠ claude CLI not found in PATH.'));
        console.log(chalk.dim('    Install Claude Code: https://claude.ai/download'));
        console.log(chalk.dim('    Then re-run: larkx init'));
        return;
      }
      saveAIConfig(projectRoot, { provider: 'local-claude' });
      return;
    }

    // anthropic
    const existingKey = process.env.ANTHROPIC_API_KEY;
    if (existingKey) {
      console.log(chalk.dim('  Using ANTHROPIC_API_KEY from environment'));
      saveAIConfig(projectRoot, { provider: 'anthropic' });
    } else {
      const apiKey = await input({
        message: 'Anthropic API key (get one at https://console.anthropic.com):',
        validate: (v) => v.startsWith('sk-ant-') || v.length > 20 ? true : 'Enter a valid Anthropic API key',
      });
      saveAIConfig(projectRoot, { provider: 'anthropic', apiKey });
    }
  } catch {
    // non-TTY or prompt cancelled — skip silently
  }
}

async function promptMCP(projectRoot: string): Promise<boolean> {
  let useMCP = true;
  try {
    const { confirm } = await import('@inquirer/prompts');
    useMCP = await confirm({
      message: 'Set up MCP server for Claude Code / VS Code? (creates .mcp.json)',
      default: true,
    });
  } catch {
    const { createInterface } = await import('readline');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question(chalk.bold('Set up MCP server for Claude Code / VS Code? (creates .mcp.json) [Y/n]: '), resolve);
      rl.close();
    });
    useMCP = answer.trim().toLowerCase() !== 'n';
  }

  if (!useMCP) return false;

  const mcpPath = path.join(projectRoot, '.mcp.json');
  if (fs.existsSync(mcpPath)) {
    console.log(chalk.yellow('  ⚠ .mcp.json already exists — skipped'));
    return true;
  }

  const binPath = new URL('../../bin/larkx.js', import.meta.url)
    .pathname
    .replace(/^\/([A-Z]:)/, '$1')
    .replace(/\//g, path.sep);

  const mcpConfig = {
    mcpServers: {
      'larkx': {
        command: 'node',
        args: [binPath, 'mcp'],
      },
    },
  };

  fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2), 'utf-8');
  console.log(chalk.green('  ✓ Created .mcp.json'));
  console.log(chalk.dim('    Reload VS Code to activate: Ctrl+Shift+P → Developer: Reload Window'));
  return true;
}

async function promptHookMode(): Promise<boolean> {
  try {
    const { select } = await import('@inquirer/prompts');
    const mode = await select<'silent' | 'visible'>({
      message: 'How should the larkx hook remind Claude to use MCP tools?',
      choices: [
        {
          name: 'Silent  (inject instruction automatically, no banner shown)',
          value: 'silent',
        },
        {
          name: 'Visible (show a reminder banner on every message)',
          value: 'visible',
        },
      ],
    });
    return mode === 'silent';
  } catch {
    const { createInterface } = await import('readline');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question(chalk.bold('Silent hook? Injects instruction without showing a banner [Y/n]: '), resolve);
      rl.close();
    });
    return answer.trim().toLowerCase() !== 'n';
  }
}

async function promptAgents(): Promise<string[]> {
  try {
    const { checkbox } = await import('@inquirer/prompts');
    const choices = Object.entries(AGENT_CONFIGS).map(([value, cfg]) => ({
      name: `${cfg.label}  →  ${chalk.dim(cfg.file)}`,
      value,
    }));

    return await checkbox({
      message: 'Which AI agents do you use? (Space to select, Enter to confirm)',
      choices,
    });
  } catch {
    return promptAgentsFallback();
  }
}

async function promptAgentsFallback(): Promise<string[]> {
  const { createInterface } = await import('readline');
  const choices = Object.entries(AGENT_CONFIGS);
  console.log('\n' + chalk.bold('Which AI agents do you use? (creates instruction files)'));
  choices.forEach(([, cfg], i) => {
    console.log(`  ${chalk.cyan(i + 1)}. ${cfg.label} → ${cfg.file}`);
  });
  console.log(`  ${chalk.cyan(choices.length + 1)}. Skip`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(chalk.bold('\nEnter numbers separated by commas (e.g. 1,2): '), (answer) => {
      rl.close();
      if (!answer.trim()) { resolve([]); return; }
      const selected: string[] = [];
      for (const part of answer.split(',')) {
        const n = parseInt(part.trim(), 10) - 1;
        if (n >= 0 && n < choices.length) selected.push(choices[n][0]);
      }
      resolve(selected);
    });
  });
}

function claudeExtraSetup(projectRoot: string, mcpEnabled: boolean, silentHook: boolean): void {
  try {
    const claudeDir = path.join(projectRoot, '.claude');
    const settingsPath = path.join(claudeDir, 'settings.json');
    const instruction = getInstruction(mcpEnabled);
    const benchAllows = ['Bash(larkx bench)', 'Bash(larkx bench:*)'];
    const hookCommand = silentHook
      ? `echo '{"suppressOutput": true, "systemMessage": "${instruction.replace(/'/g, "\\'")}"}'`
      : `echo 'IMPORTANT: ${instruction}'`;
    const hook = {
      permissions: { allow: benchAllows },
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookCommand, shell: 'bash' }] }],
      },
    };
    if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });
    if (fs.existsSync(settingsPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        existing.permissions = existing.permissions ?? {};
        existing.permissions.allow = existing.permissions.allow ?? [];
        for (const rule of benchAllows) {
          if (!existing.permissions.allow.includes(rule)) existing.permissions.allow.push(rule);
        }
        if (!existing.hooks) existing.hooks = hook.hooks;
        fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2), 'utf-8');
        console.log(chalk.green('  ✓ Updated .claude/settings.json with UserPromptSubmit hook + bench allowlist'));
      } catch {
        console.log(chalk.yellow('  ⚠ Could not update .claude/settings.json'));
      }
    } else {
      fs.writeFileSync(settingsPath, JSON.stringify(hook, null, 2), 'utf-8');
      console.log(chalk.green('  ✓ Created .claude/settings.json with UserPromptSubmit hook'));
    }
  } catch (err) {
    console.log(chalk.yellow('  ⚠ Could not set up Claude Code hooks: ' + (err instanceof Error ? err.message : 'Unknown error')));
  }

  try {
    const commandsDir = path.join(projectRoot, '.claude', 'commands');
    const benchCmdPath = path.join(commandsDir, 'larkx-bench.md');
    if (!fs.existsSync(commandsDir)) fs.mkdirSync(commandsDir, { recursive: true });
    if (!fs.existsSync(benchCmdPath)) {
      fs.writeFileSync(benchCmdPath, LARKX_BENCH_SLASH_COMMAND, 'utf-8');
      console.log(chalk.green('  ✓ Created .claude/commands/larkx-bench.md (slash command)'));
    }
  } catch { /* ignore */ }
}

function createAgentFiles(projectRoot: string, agents: string[], mcpEnabled: boolean, silentHook = true): void {
  // Persist choices so `larkx index` can refresh agent files automatically
  try {
    const configPath = path.join(projectRoot, '.larkx', 'config.json');
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    existing.agents = agents;
    existing.mcpEnabled = mcpEnabled;
    fs.writeFileSync(configPath, JSON.stringify(existing, null, 2), 'utf-8');
  } catch { /* ignore */ }

  for (const key of agents) {
    const cfg = AGENT_CONFIGS[key];
    if (!cfg) continue;
    const filePath = path.join(projectRoot, cfg.file);
    if (fs.existsSync(filePath)) {
      console.log(chalk.yellow(`  ⚠ ${cfg.file} already exists — skipped`));
    } else {
      createAgentFile(projectRoot, key, mcpEnabled);
      console.log(chalk.green(`  ✓ Created ${cfg.file} (${cfg.label})`));
    }
    if (key === 'claude') claudeExtraSetup(projectRoot, mcpEnabled, silentHook);
  }
}

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds} seconds ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
  return `${Math.floor(seconds / 86400)} days ago`;
}

program.parse();
