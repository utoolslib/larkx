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

**larkx** is an AI codebase indexer and [MCP](https://modelcontextprotocol.io) server. Instead of reading raw source files, your AI agent queries a compact graph - same understanding, far fewer tokens.

Works with Claude Code, Cursor, GitHub Copilot, Gemini CLI, and OpenAI Codex.

## Install

```bash
npm install -g larkx
```

## Quick start

```bash
cd your-project
larkx init      # one-time setup: MCP, agent files, hooks
larkx index     # build the index
```

`larkx init` creates instruction files for each agent you use (`CLAUDE.md`, `.cursorrules`, `AGENTS.md`, `GEMINI.md`). These files are auto-updated on every `larkx index` run.

## Supported agents

| Agent | MCP | Context file |
|-------|:---:|:------------:|
| Claude Code | ✓ | ✓ |
| Cursor | ✓ | ✓ |
| GitHub Copilot | - | ✓ |
| OpenAI Codex | - | ✓ |
| Gemini CLI | - | ✓ |

## Supported languages

TypeScript · JavaScript · Python · Go · Rust · Java · C · C++ · C# · Ruby · PHP · Swift · Kotlin · Scala · Shell

## CLI reference

| Command | What it does |
|---------|-------------|
| `larkx init` | Setup wizard: MCP, agent instruction files, hooks |
| `larkx index` | Build or update the index; auto-refreshes agent files |
| `larkx index --ai` | Add AI summaries per file |
| `larkx index --watch` | Keep the index live as you edit |
| `larkx bench` | Token benchmark — measure actual savings on your project |
| `larkx stats` | Token estimates per level |
| `larkx context` | Print the index to stdout |
| `larkx search <name>` | Find a function or class by name |
| `larkx impact <file>` | List every file that imports a given file |
| `larkx deadcode` | Find unreachable files and functions |
| `larkx serve` | Open the visual graph in your browser |
| `larkx mcp --check` | Health-check the MCP server |

## Documentation

Full setup guides, MCP integration, token optimization, and FAQ at **[Documentation](https://larkx.utoolslib.com/docs)**.
