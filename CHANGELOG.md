# Changelog

All notable changes to larkx will be documented here.

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
