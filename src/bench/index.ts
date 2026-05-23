import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import chalk from 'chalk';

type Query = { id: string; ask: string };

type Usage = {
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  durationMs: number;
  numTurns: number;
  isError: boolean;
  errorMsg?: string;
};

type Trial = Usage & { wallMs: number };

type QueryResult = { q: Query; baselineTrials: Trial[]; larkxTrials: Trial[] };

type BenchReport = {
  projectRoot: string;
  timestamp: string;
  trials: number;
  results: QueryResult[];
};

const LARKX_SYSTEM_PROMPT = [
  'IMPORTANT: Before reading any source files, you MUST use the larkx MCP tools first.',
  '- get_project_index for an overview',
  '- search_symbol to locate a function/class',
  '- get_file_summary instead of reading a file (full content is inlined for small files)',
  '- get_impact when planning a change to a file',
  '- get_call_chain to trace callers/callees',
  '- get_dead_code to find unused code',
  'Only fall back to reading raw source files if a larkx tool returns no useful result.',
].join('\n');

export function buildQueries(projectRoot: string): Query[] {
  const indexPath = path.join(projectRoot, '.larkx', 'index.json');
  const index: any[] = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));

  const queries: Query[] = [];
  queries.push({ id: 'overview', ask: 'Give me a high-level overview of this codebase.' });

  const fileWithFns = index.find((s) => (s.functions ?? []).length > 0);
  if (fileWithFns) {
    queries.push({ id: 'file-summary', ask: `Summarise ${fileWithFns.file}` });
  }

  const allFns = index.flatMap((s) =>
    (s.functions ?? []).map((f: any) => ({ file: s.file, name: f.name }))
  );
  const named = allFns.filter((f) => f.name && f.name !== 'default' && !/^_/.test(f.name));
  const pick = named.sort((a, b) => b.name.length - a.name.length)[0];
  if (pick) {
    queries.push({ id: 'find-symbol', ask: `Where is the ${pick.name} function defined?` });
    queries.push({ id: 'call-chain', ask: `What calls ${pick.name} and what does it call?` });
  }

  const filesByFn = [...index].sort(
    (a, b) => (b.functions?.length ?? 0) - (a.functions?.length ?? 0)
  );
  const impactFile = filesByFn[0];
  if (impactFile) {
    queries.push({ id: 'impact', ask: `What depends on ${impactFile.file}?` });
  }

  queries.push({ id: 'dead-code', ask: 'Find dead or unused code in this project.' });

  return queries;
}

function summarizeUsage(json: any, errFromExit?: string): Usage {
  const u = json?.usage ?? {};
  const inTok =
    (u.input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0);
  const isErr = !!json?.is_error || !!errFromExit;
  const errMsg =
    typeof json?.result === 'string' && isErr
      ? json.result.slice(0, 200)
      : errFromExit;
  return {
    inputTokens: u.input_tokens ?? 0,
    cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    totalTokens: inTok + (u.output_tokens ?? 0),
    costUsd: json?.total_cost_usd ?? 0,
    durationMs: json?.duration_ms ?? 0,
    numTurns: json?.num_turns ?? 0,
    isError: isErr,
    errorMsg: errMsg,
  };
}

function quoteWinArg(arg: string): string {
  if (!/[\s"]/.test(arg)) return arg;
  return '"' + arg.replace(/\\(\\*)(?=")/g, '\\$1$1').replace(/"/g, '\\"') + '"';
}

function runClaude(
  prompt: string,
  mcpConfig: string,
  appendSystem: string | null,
  projectRoot: string,
  model: string | null,
  timeoutMs: number
): Promise<{ usage: Usage; wallMs: number }> {
  return new Promise((resolve) => {
    const args = [
      '-p',
      prompt,
      '--output-format',
      'json',
      '--strict-mcp-config',
      '--mcp-config',
      mcpConfig,
      '--permission-mode',
      'bypassPermissions',
    ];
    if (appendSystem) args.push('--append-system-prompt', appendSystem);
    if (model) args.push('--model', model);

    const startedAt = Date.now();
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'cmd.exe' : 'claude';
    const spawnArgs = isWin
      ? ['/d', '/s', '/c', ['claude', ...args.map(quoteWinArg)].join(' ')]
      : args;
    const child = spawn(cmd, spawnArgs, { cwd: projectRoot, windowsHide: true, windowsVerbatimArguments: isWin });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        usage: summarizeUsage(null, err.message),
        wallMs: Date.now() - startedAt,
      });
    });
    child.on('close', () => {
      clearTimeout(timer);
      const wallMs = Date.now() - startedAt;
      try {
        const json = JSON.parse(stdout.trim().split('\n').pop() || '{}');
        resolve({ usage: summarizeUsage(json), wallMs });
      } catch {
        resolve({
          usage: summarizeUsage(
            null,
            timedOut ? 'timeout' : stderr.trim().split('\n')[0] || 'no output'
          ),
          wallMs,
        });
      }
    });
  });
}

function fmtTok(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10000) return `${(n / 1000).toFixed(1)}K`;
  return `${Math.round(n / 1000)}K`;
}

function fmtSec(ms: number): string {
  return (ms / 1000).toFixed(1) + 's';
}

function pad(s: string | number, w: number): string {
  const str = String(s);
  return str.length >= w ? str : str + ' '.repeat(w - str.length);
}


function pct(baseline: number, larkx: number): number {
  if (!baseline || baseline <= 0) return 0;
  return Math.round(((baseline - larkx) / baseline) * 100);
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function aggregateTrials(trials: Trial[]): (Trial & { trials: number }) | null {
  const ok = trials.filter((t) => !t.isError);
  if (ok.length === 0) return null;
  return {
    inputTokens: Math.round(mean(ok.map((t) => t.inputTokens))),
    cacheCreationTokens: Math.round(mean(ok.map((t) => t.cacheCreationTokens))),
    cacheReadTokens: Math.round(mean(ok.map((t) => t.cacheReadTokens))),
    outputTokens: Math.round(mean(ok.map((t) => t.outputTokens))),
    totalTokens: Math.round(mean(ok.map((t) => t.totalTokens))),
    costUsd: mean(ok.map((t) => t.costUsd)),
    durationMs: Math.round(mean(ok.map((t) => t.durationMs))),
    numTurns: Math.round(mean(ok.map((t) => t.numTurns))),
    wallMs: Math.round(mean(ok.map((t) => t.wallMs))),
    isError: false,
    trials: ok.length,
  };
}

function printDetailBreakdown(results: QueryResult[]): void {
  console.log(chalk.bold('\nToken breakdown per query:'));
  const COL = [10, 10, 9, 9, 10, 10, 9];
  const hdr =
    '  ' +
    pad('query', 16) +
    pad('side', COL[0]) +
    pad('input', COL[1]) +
    pad('c-write', COL[2]) +
    pad('c-read', COL[3]) +
    pad('output', COL[4]) +
    pad('total', COL[5]) +
    pad('wall', COL[6]) +
    'turns';
  console.log(hdr);
  console.log('  ' + '-'.repeat(hdr.length - 2));

  for (const r of results) {
    const bAgg = aggregateTrials(r.baselineTrials);
    const lAgg = aggregateTrials(r.larkxTrials);
    if (!bAgg || !lAgg) {
      console.log('  ' + pad(r.q.id, 16) + chalk.dim('skipped'));
      continue;
    }

    const row = (label: string, t: Trial & { trials?: number }, color: (s: string) => string) =>
      '  ' +
      pad(label === 'baseline' ? r.q.id : '', 16) +
      color(pad(label, COL[0])) +
      pad(fmtTok(t.inputTokens), COL[1]) +
      pad(fmtTok(t.cacheCreationTokens), COL[2]) +
      pad(fmtTok(t.cacheReadTokens), COL[3]) +
      pad(fmtTok(t.outputTokens), COL[4]) +
      pad(fmtTok(t.totalTokens), COL[5]) +
      pad(fmtSec(t.wallMs), COL[6]) +
      t.numTurns;

    console.log(row('baseline', bAgg, chalk.dim));
    console.log(row('larkx', lAgg, chalk.cyan));
  }
}

function loadBenchReports(outDir: string, excludeFile?: string): Array<{ file: string; report: BenchReport }> {
  if (!fs.existsSync(outDir)) return [];
  return fs
    .readdirSync(outDir)
    .filter((f) => f.endsWith('.json') && f !== (excludeFile ? path.basename(excludeFile) : ''))
    .sort()
    .map((f) => {
      try {
        const report: BenchReport = JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf-8'));
        return { file: f, report };
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Array<{ file: string; report: BenchReport }>;
}

function reportTotals(report: BenchReport): { bTok: number; lTok: number; bCost: number; lCost: number; n: number } {
  const totals = { bTok: 0, lTok: 0, bCost: 0, lCost: 0, n: 0 };
  for (const r of report.results) {
    const bAgg = aggregateTrials(r.baselineTrials);
    const lAgg = aggregateTrials(r.larkxTrials);
    if (!bAgg || !lAgg) continue;
    totals.bTok += bAgg.totalTokens;
    totals.lTok += lAgg.totalTokens;
    totals.bCost += bAgg.costUsd;
    totals.lCost += lAgg.costUsd;
    totals.n++;
  }
  return totals;
}

function printDeltaVsPrevious(outDir: string, currentFile: string, currentReport: BenchReport): void {
  const prev = loadBenchReports(outDir, currentFile).pop();
  if (!prev) return;

  const cur = reportTotals(currentReport);
  const old = reportTotals(prev.report);
  if (cur.n === 0 || old.n === 0) return;

  const deltaTokens = old.lTok - cur.lTok;
  const deltaPct = old.lTok > 0 ? Math.round((deltaTokens / old.lTok) * 100) : 0;
  const deltaCost = old.lCost - cur.lCost;

  const prevDate = prev.report.timestamp
    ? new Date(prev.report.timestamp).toLocaleString()
    : prev.file;

  const sign = deltaTokens >= 0 ? '+' : '';
  const tokenColor = deltaTokens >= 0 ? chalk.green : chalk.red;
  const costColor = deltaCost >= 0 ? chalk.green : chalk.red;

  console.log(chalk.bold('\nDelta vs previous run') + chalk.dim(` (${prevDate}):`));
  console.log(
    '  larkx tokens : ' +
    tokenColor(`${sign}${fmtTok(Math.abs(deltaTokens))} (${sign}${deltaPct}%)`) +
    chalk.dim(` ${fmtTok(old.lTok)} → ${fmtTok(cur.lTok)}`)
  );
  console.log(
    '  larkx cost   : ' +
    costColor(`${deltaCost >= 0 ? '+' : ''}$${Math.abs(deltaCost).toFixed(4)}`) +
    chalk.dim(` $${old.lCost.toFixed(4)} → $${cur.lCost.toFixed(4)}`)
  );
  console.log(
    '  saved%       : ' +
    chalk.dim(`${pct(old.bTok, old.lTok)}% → `) +
    (pct(cur.bTok, cur.lTok) >= pct(old.bTok, old.lTok) ? chalk.green : chalk.red)(
      `${pct(cur.bTok, cur.lTok)}%`
    )
  );
}

export function showBenchHistory(projectRoot: string, n: number = 10): void {
  const outDir = path.join(projectRoot, '.larkx', 'bench');
  const entries = loadBenchReports(outDir);

  if (entries.length === 0) {
    console.log(chalk.dim('No bench history found. Run: larkx bench'));
    return;
  }

  const slice = entries.slice(-n);
  console.log(chalk.bold(`\nlarkx bench history (last ${slice.length} run${slice.length === 1 ? '' : 's'}):`));
  console.log(
    pad('date', 22) +
    pad('queries', 9) +
    pad('baseline', 10) +
    pad('larkx', 10) +
    pad('saved', 8) +
    pad('base $', 10) +
    'larkx $'
  );
  console.log('-'.repeat(80));

  for (const { report } of slice) {
    const t = reportTotals(report);
    if (t.n === 0) continue;
    const date = report.timestamp
      ? new Date(report.timestamp).toISOString().slice(0, 16).replace('T', ' ')
      : '?';
    console.log(
      pad(date, 22) +
      pad(t.n, 9) +
      pad(fmtTok(t.bTok), 10) +
      pad(fmtTok(t.lTok), 10) +
      pad(pct(t.bTok, t.lTok) + '%', 8) +
      pad('$' + t.bCost.toFixed(4), 10) +
      '$' + t.lCost.toFixed(4)
    );
  }
}

export async function runBenchmark(
  projectRoot: string,
  opts: {
    only?: string;
    ask?: string;
    model?: string | null;
    timeoutSec?: number;
    trials?: number;
    detail?: boolean;
  } = {}
): Promise<void> {
  if (!fs.existsSync(path.join(projectRoot, '.larkx'))) {
    console.error(chalk.red('✗ Not initialized. Run: larkx init && larkx index'));
    process.exit(1);
  }
  if (!fs.existsSync(path.join(projectRoot, '.larkx', 'index.json'))) {
    console.error(chalk.red('✗ No index found. Run: larkx index'));
    process.exit(1);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'larkx-bench-'));
  const mcpNone = path.join(tmpDir, 'mcp-none.json');
  const mcpLarkx = path.join(tmpDir, 'mcp-larkx.json');
  fs.writeFileSync(mcpNone, JSON.stringify({ mcpServers: {} }, null, 2));
  fs.writeFileSync(
    mcpLarkx,
    JSON.stringify({ mcpServers: { larkx: { command: 'larkx', args: ['mcp'] } } }, null, 2)
  );

  const allQueries = buildQueries(projectRoot);
  const baseQueries = opts.only
    ? allQueries.filter((q) => opts.only!.split(',').includes(q.id))
    : allQueries;
  const queries: Query[] = [...baseQueries];
  if (opts.ask && opts.ask.trim()) {
    queries.push({ id: 'custom', ask: opts.ask.trim() });
  }

  const timeoutMs = (opts.timeoutSec ?? 120) * 1000;
  const trials = Math.max(1, Math.floor(opts.trials ?? 1));

  console.log(chalk.bold('\nlarkx real benchmark (claude code, before vs after)'));
  console.log(`project : ${projectRoot}`);
  console.log(`queries : ${queries.length}`);
  console.log(`trials  : ${trials} per side`);
  if (opts.model) console.log(`model   : ${opts.model}`);
  console.log('');

  const results: QueryResult[] = [];
  let rateLimited = false;

  async function runSide(
    side: 'baseline' | 'larkx',
    q: Query,
    mcpConfig: string,
    appendSystem: string | null
  ): Promise<{ trials: Trial[]; aborted: boolean }> {
    const out: Trial[] = [];
    for (let t = 0; t < trials; t++) {
      const label = trials > 1 ? `${side} [${t + 1}/${trials}]` : side;
      process.stdout.write(`  ${pad(label, 22)} ... `);
      const r = await runClaude(q.ask, mcpConfig, appendSystem, projectRoot, opts.model ?? null, timeoutMs);
      out.push({ ...r.usage, wallMs: r.wallMs });
      if (r.usage.isError) {
        console.log(chalk.red(`ERROR — ${r.usage.errorMsg}`));
        if (/rate limit/i.test(r.usage.errorMsg ?? '')) {
          return { trials: out, aborted: true };
        }
      } else {
        console.log(
          `${fmtTok(r.usage.totalTokens)} tok · $${r.usage.costUsd.toFixed(4)} · ${r.usage.numTurns} turns · ${fmtSec(r.wallMs)}`
        );
      }
    }
    return { trials: out, aborted: false };
  }

  for (const q of queries) {
    console.log(chalk.cyan(`▸ [${q.id}] ${q.ask}`));

    if (rateLimited) {
      console.log(chalk.dim('  SKIPPED (rate-limited)'));
      results.push({ q, baselineTrials: [], larkxTrials: [] });
      continue;
    }

    const b = await runSide('baseline', q, mcpNone, null);
    if (b.aborted) {
      rateLimited = true;
      results.push({ q, baselineTrials: b.trials, larkxTrials: [] });
      continue;
    }

    const l = await runSide('larkx', q, mcpLarkx, LARKX_SYSTEM_PROMPT);
    if (l.aborted) rateLimited = true;

    results.push({ q, baselineTrials: b.trials, larkxTrials: l.trials });
  }

  // ── Summary table ──────────────────────────────────────────────────────────
  console.log('');
  const header = trials > 1
    ? `Summary (mean over ${trials} trials per side, real tokens reported by Claude Code):`
    : 'Summary (real tokens reported by Claude Code):';
  console.log(chalk.bold(header));
  console.log(
    pad('id', 18) +
    pad('baseline', 12) +
    pad('larkx', 12) +
    pad('saved', 8) +
    pad('base $', 10) +
    pad('larkx $', 10) +
    pad('time b/l', 16) +
    'turns b/l'
  );
  console.log('-'.repeat(96));

  const totals = { bTok: 0, lTok: 0, bCost: 0, lCost: 0, bWall: 0, lWall: 0, n: 0 };
  for (const r of results) {
    const bAgg = aggregateTrials(r.baselineTrials);
    const lAgg = aggregateTrials(r.larkxTrials);
    if (!bAgg || !lAgg) {
      console.log(pad(r.q.id, 18) + chalk.dim('(skipped or errored)'));
      continue;
    }
    totals.bTok += bAgg.totalTokens;
    totals.lTok += lAgg.totalTokens;
    totals.bCost += bAgg.costUsd;
    totals.lCost += lAgg.costUsd;
    totals.bWall += bAgg.wallMs;
    totals.lWall += lAgg.wallMs;
    totals.n++;

    const savedPct = pct(bAgg.totalTokens, lAgg.totalTokens);
    const savedStr = savedPct >= 0
      ? chalk.green(pad(savedPct + '%', 8))
      : chalk.red(pad(savedPct + '%', 8));

    console.log(
      pad(r.q.id, 18) +
      pad(fmtTok(bAgg.totalTokens), 12) +
      pad(fmtTok(lAgg.totalTokens), 12) +
      savedStr +
      pad('$' + bAgg.costUsd.toFixed(4), 10) +
      pad('$' + lAgg.costUsd.toFixed(4), 10) +
      pad(`${fmtSec(bAgg.wallMs)}/${fmtSec(lAgg.wallMs)}`, 16) +
      `${bAgg.numTurns}/${lAgg.numTurns}`
    );
  }
  console.log('-'.repeat(96));
  if (totals.n > 0) {
    const totalSaved = pct(totals.bTok, totals.lTok);
    const savedStr = totalSaved >= 0
      ? chalk.green(pad(totalSaved + '%', 8))
      : chalk.red(pad(totalSaved + '%', 8));
    console.log(
      pad('TOTAL', 18) +
      pad(fmtTok(totals.bTok), 12) +
      pad(fmtTok(totals.lTok), 12) +
      savedStr +
      pad('$' + totals.bCost.toFixed(4), 10) +
      pad('$' + totals.lCost.toFixed(4), 10) +
      pad(`${fmtSec(totals.bWall)}/${fmtSec(totals.lWall)}`, 16)
    );
  }

  // ── Detail breakdown (opt-in) ──────────────────────────────────────────────
  if (opts.detail) {
    printDetailBreakdown(results);
  }

  // ── Save report ───────────────────────────────────────────────────────────
  const outDir = path.join(projectRoot, '.larkx', 'bench');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `${stamp}.json`);
  const report: BenchReport = {
    projectRoot,
    timestamp: new Date().toISOString(),
    trials,
    results,
  };
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf-8');
  console.log(chalk.dim(`\nfull report → ${path.relative(projectRoot, outFile)}`));

  // ── Auto-compare vs previous run ──────────────────────────────────────────
  printDeltaVsPrevious(outDir, outFile, report);

  if (rateLimited) {
    console.log(
      chalk.yellow(
        '\n⚠ Run aborted early due to Claude rate-limit. Wait and re-run, or pass --only=<id>.'
      )
    );
  }
}
