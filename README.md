<div align="center">
  <a href="https://larkx.utoolslib.com/">
    <img src="https://larkx.utoolslib.com/open-graph-larkx-npm.png" alt="larkx - AI codebase indexer and MCP server for Claude Code, Cursor, and Copilot" width="600" />
  </a>
  <p><strong>Give your AI agent a map of your codebase, not a flood of raw files.</strong></p>

  [![License: MIT](https://img.shields.io/badge/license-MIT-yellow?style=flat-square)](LICENSE)
  [![Node.js 18+](https://img.shields.io/badge/node-18%2B-brightgreen?style=flat-square)](https://nodejs.org)
  [![MCP compatible](https://img.shields.io/badge/MCP-compatible-7c3aed?style=flat-square)](https://modelcontextprotocol.io)

  <p>
    <a href="https://larkx.utoolslib.com/docs">Documentation</a> ·
    <a href="https://larkx.utoolslib.com/docs/cli/bench/">Benchmark</a> ·
    <a href="https://larkx.utoolslib.com/docs/faq/">FAQ</a>
  </p>
</div>

## What is larkx?

**larkx** is an AI codebase indexer and [MCP](https://modelcontextprotocol.io) server. Instead of reading raw source files, your AI agent queries a compact graph — same understanding, far fewer tokens.

Works with Claude Code, Cursor, GitHub Copilot, Gemini CLI, OpenAI Codex, Continue, Zed, Windsurf, and any MCP-compatible agent.

## Install

```bash
npm install -g larkx
```

## Get started

```bash
cd your-project
larkx init      # one-time wizard: sets up MCP, agent files, and hooks
larkx index     # parse all files and build the index
larkx stats     # see token estimates per level for your project
```

After `larkx index`, a `.larkx/context.md` file is written to your project root. Every AI agent can read it with no extra setup.

## How your AI agent uses larkx

### MCP server (Claude Code, Cursor, Continue, Zed, Windsurf)

6 targeted query tools instead of raw file access:

| Tool | What it answers | Cost |
|------|----------------|------|
| `get_project_index` | "What files and functions exist?" | ~8–250 tok/file |
| `search_symbol` | "Where is `validateUser` defined?" | ~30 tokens |
| `get_file_summary` | "What does `auth/login.ts` do?" | ~100 tokens |
| `get_impact` | "What breaks if I change this file?" | ~100 tokens |
| `get_call_chain` | "What calls `processPayment`?" | ~100 tokens |
| `get_dead_code` | "What code is never used?" | ~200 tokens |

```bash
claude mcp add larkx -- larkx mcp   # global setup (terminal Claude Code)
# larkx init creates .mcp.json for per-project VS Code setup
```

### Context file (Copilot, Codex, Gemini, any file-reading agent)

Every `larkx index` run writes `.larkx/context.md` — a plain-text snapshot at ~80 tokens/file. `larkx init` creates `CLAUDE.md`, `.cursorrules`, `AGENTS.md`, and `GEMINI.md` that tell each agent to read it first.

### CLI output

```bash
larkx context                        # full index to stdout
larkx context --level 1              # file paths only (~8 tok/file)
larkx context --folder src/payments  # scope to a subtree
```

## Supported agents

| Agent | MCP | Context file |
|-------|:---:|:------------:|
| Claude Code | ✓ | ✓ |
| Cursor | ✓ | ✓ |
| Continue | ✓ | ✓ |
| Zed / Windsurf | ✓ | ✓ |
| GitHub Copilot | - | ✓ |
| OpenAI Codex | - | ✓ |
| Gemini CLI | - | ✓ |

## Supported languages

TypeScript · JavaScript · Python · Go · Rust · Java · C · C++ · C# · Ruby · PHP · Swift · Kotlin · Scala · Shell

## CLI reference

| Command | What it does |
|---------|-------------|
| `larkx init` | Setup wizard: MCP, AI summaries, agent instruction files |
| `larkx index` | Build or update the index |
| `larkx index --ai` | Add one-sentence AI summaries per file |
| `larkx index --watch` | Keep the index live as you edit |
| `larkx bench` | Real-time token benchmark — measure actual savings on your project |
| `larkx stats` | Token estimates per level |
| `larkx context` | Print the index to stdout |
| `larkx search <name>` | Find a function or class by name |
| `larkx impact <file>` | List every file that imports a given file |
| `larkx deadcode` | Find unreachable files and functions |
| `larkx serve` | Open the visual graph in your browser |
| `larkx mcp --check` | Health-check the MCP server |

## Measure real savings

`larkx bench` runs Claude Code with and without larkx and reports actual token usage. See the [bench docs](https://larkx.utoolslib.com/docs/cli/bench/) for usage and examples.

## Documentation

Full setup guides, MCP integration, token optimization, troubleshooting, and FAQ at **[larkx.utoolslib.com/docs](https://larkx.utoolslib.com/docs)**.
