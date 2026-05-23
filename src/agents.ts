import fs from 'fs';
import path from 'path';

export const CLI_INSTRUCTION = 'Before working on any task, read the file `.larkx/context.md` — it contains a compact map of all files, functions, classes, and imports in this project. Do not open source files until you have read it. If the file does not exist, run `larkx index` first.';
export const MCP_INSTRUCTION = 'Before working on any task, always use larkx MCP tools first: get_project_index for a full overview, search_symbol to locate functions, get_file_summary instead of reading a file (full content is inlined for small files ≤150 lines), get_impact when planning a change to a file, get_call_chain to trace logic, get_dead_code to find unused code. If MCP returns no result, read `.larkx/context.md` as a fallback overview. Only read individual source files directly if neither MCP nor context.md is available.';

export function getInstruction(mcpEnabled: boolean): string {
  return mcpEnabled ? MCP_INSTRUCTION : CLI_INSTRUCTION;
}

export type AgentConfig = {
  file: string;
  label: string;
  content: (mcpEnabled: boolean) => string;
};

export const AGENT_CONFIGS: Record<string, AgentConfig> = {
  claude: {
    file: 'CLAUDE.md',
    label: 'Claude Code',
    content: (mcpEnabled) => `# Project Intelligence\n\nThis project uses [larkx](https://github.com/utoolslib/larkx) for code indexing.\n\n${getInstruction(mcpEnabled)}\n`,
  },
  copilot: {
    file: '.github/copilot-instructions.md',
    label: 'GitHub Copilot',
    content: (mcpEnabled) => `# Copilot Instructions\n\nThis project uses [larkx](https://github.com/utoolslib/larkx) for code indexing.\n\n${getInstruction(mcpEnabled)}\n`,
  },
  cursor: {
    file: '.cursorrules',
    label: 'Cursor',
    content: (mcpEnabled) => `# Cursor Rules\n\nThis project uses larkx for code indexing.\n\n${getInstruction(mcpEnabled)}\n`,
  },
  codex: {
    file: 'AGENTS.md',
    label: 'OpenAI Codex',
    content: (mcpEnabled) => `# Agent Instructions\n\nThis project uses [larkx](https://github.com/utoolslib/larkx) for code indexing.\n\n${getInstruction(mcpEnabled)}\n`,
  },
  gemini: {
    file: 'GEMINI.md',
    label: 'Gemini CLI',
    content: (mcpEnabled) => `# Project Intelligence\n\nThis project uses [larkx](https://github.com/utoolslib/larkx) for code indexing.\n\n${getInstruction(mcpEnabled)}\n`,
  },
};

const LARKX_MARKER = '<!-- larkx-managed: do not edit this section -->';

export function refreshAgentFiles(projectRoot: string, agents: string[], mcpEnabled: boolean): void {
  for (const key of agents) {
    const cfg = AGENT_CONFIGS[key];
    if (!cfg) continue;
    const filePath = path.join(projectRoot, cfg.file);
    if (!fs.existsSync(filePath)) continue;
    const existing = fs.readFileSync(filePath, 'utf-8');
    if (!existing.includes(LARKX_MARKER)) continue;
    const updated = cfg.content(mcpEnabled) + LARKX_MARKER + '\n';
    if (existing !== updated) {
      fs.writeFileSync(filePath, updated, 'utf-8');
    }
  }
}

export function createAgentFile(projectRoot: string, key: string, mcpEnabled: boolean): void {
  const cfg = AGENT_CONFIGS[key];
  if (!cfg) return;
  const filePath = path.join(projectRoot, cfg.file);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const content = cfg.content(mcpEnabled) + LARKX_MARKER + '\n';
  fs.writeFileSync(filePath, content, 'utf-8');
}
