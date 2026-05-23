# Changelog

All notable changes to larkx will be documented here.

## [0.2.2] - 2026-05-23

### Added
- Agent instruction files (`CLAUDE.md`, `.cursorrules`, `AGENTS.md`, `GEMINI.md`) are now auto-refreshed on every `larkx index` run — no manual updates needed when larkx updates its instructions.
- `src/agents.ts` — shared module for all agent configs and instructions; single source of truth used by both `larkx init` and `larkx index`.
- `agents` and `mcpEnabled` persisted to `.larkx/config.json` on `larkx init` so subsequent index runs know which files to refresh.
- Files without the `<!-- larkx-managed -->` marker are never overwritten — user-edited agent files are safe.

### Changed
- README trimmed to essentials only: install, quick start, agents table, languages, CLI reference, docs link.

## [0.2.1] - 2026-05-21

### Changed
- README trimmed to essential info only; benchmark output removed in favour of a link to the docs page
- npm package now includes only `public/graph.html` instead of the full `public/` folder, reducing package size from 1.7 MB to 42 KB

## [0.2.0] - 2026-05-20

### Added
- `larkx bench` — real-time token benchmark. Runs Claude Code twice per query (once without MCP, once with larkx MCP) and reports actual token usage from Claude's `--output-format json` — not estimates.
- Auto-generated benchmark suite (`overview`, `file-summary`, `find-symbol`, `call-chain`, `impact`, `dead-code`) derived from each user's own index, so it works on any project.
- Custom prompt support: `larkx bench "your question"` or `larkx bench --ask "..."` runs your prompt alongside the default suite.
- Saved reports at `.larkx/bench/<timestamp>.json` with raw `usage` blocks from both runs.
- `/larkx-bench` slash command for Claude Code, plus auto-allowlisted `Bash(larkx bench)` and `Bash(larkx bench:*)` entries in `.claude/settings.json` on `larkx init`.
- `--trials <n>` flag on `larkx bench` to average over multiple runs per side (smooths out Claude's ±10–20% per-run variance).

### Changed
- `larkx index --ai` now auto-configures `local-claude` when the Claude CLI is installed but no AI provider is saved.
- `larkx index --ai` no longer asks a redundant confirm prompt — the flag already opted in.
- AI summarizer captures stderr, treats `API Error:` responses as failures, and reports per-file error counts instead of silently claiming success.
- AI summarizer throttles between `claude -p` calls (800ms) and aborts on rate-limit instead of burning the rest of the queue.
- README claims anchored in measured numbers from `larkx bench` instead of formula-based estimates.

### Fixed
- Windows `EINVAL` when spawning `claude.cmd` from Node 18.20.2+ — bench now routes through `cmd.exe /d /s /c` with proper arg quoting on win32.

### Removed
- `benchmarks/` folder (old calculated/estimated scripts: `token-compare.mjs`, `transcript-tokens.mjs`, `real-claude-bench.mjs`). Replaced by `larkx bench`.
- `npm run benchmark`, `npm run benchmark:real`, `npm run benchmark:transcript` scripts from `package.json`.

## [0.1.0] - 2026-05-16

First public release.

### Added
- `larkx init` setup wizard — configures MCP, AI summaries, and agent instruction files in one step
- `larkx index` — parse your entire codebase and write `.larkx/context.md` (incremental, SHA-256 per file)
- `larkx index --force` — re-parse everything, bypassing the hash cache
- `larkx index --ai` — add one-sentence AI summaries per file via Claude Haiku
- `larkx index --watch` — keep the index live as you edit
- `larkx stats` — token estimates per level for your project
- `larkx context` — print the index to stdout, with `--level` (1-4) and `--folder` scoping
- `larkx search` — find any function or class by name
- `larkx impact` — list every file that imports a given file
- `larkx deadcode` — find files and functions nothing else references
- `larkx serve` — open the visual dependency graph in your browser (D3.js, dark theme, search, filter)
- `larkx mcp` — start the MCP server (stdio transport)
- `larkx mcp --check` — health check for CI (exits 0 = OK, exits 1 = not responding)
- MCP server with 6 query tools: `get_project_index`, `get_file_summary`, `search_symbol`, `get_impact`, `get_call_chain`, `get_dead_code`
- Tree-sitter parser with regex fallback — 15 languages supported (TS, JS, Python, Go, Rust, Java, C, C++, C#, Ruby, PHP, Swift, Kotlin, Scala, Shell)
- `.larkx/context.md` written on every index run — any agent reads it with no extra setup
- Agent instruction files on init: `CLAUDE.md`, `.cursorrules`, `AGENTS.md`, `GEMINI.md`
- AI summaries cached per file — only re-summarizes files that changed
- Port conflict auto-increment for `larkx serve` (tries up to 5 ports)
