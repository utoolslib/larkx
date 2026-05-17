import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import type { GraphNode } from '../graph/index.js';
import { loadSummaries, saveSummaries, type AiConfig } from '../storage/index.js';

const SYSTEM_PROMPT = 'You summarize code files in exactly ONE sentence. Be specific about what the file does.';

async function callLocalClaude(prompt: string): Promise<string | null> {
  const { spawn } = await import('child_process');
  return new Promise((resolve) => {
    const child = spawn('claude', ['-p', prompt], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('close', (code) => resolve(code === 0 && output.trim() ? output.trim() : null));
    child.on('error', () => resolve(null));
    // 30s timeout per file
    setTimeout(() => { child.kill(); resolve(null); }, 30000);
  });
}

async function callAnthropic(client: Anthropic, file: string, content: string): Promise<string | null> {
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 100,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `File: ${file}\n\n${content}` }],
  });
  const text = msg.content[0].type === 'text' ? msg.content[0].text.trim() : '';
  return text || null;
}

export async function generateSummaries(
  projectRoot: string,
  nodes: GraphNode[],
  aiConfig: AiConfig
): Promise<void> {
  const existing = (loadSummaries(projectRoot) as Record<string, string> | null) ?? {};
  const summaries: Record<string, string> = { ...existing };

  const fileNodes = nodes.filter(n => n.type === 'file' && !summaries[n.file]);
  if (fileNodes.length === 0) {
    console.log('✓ All files already summarized');
    return;
  }

  let client: Anthropic | null = null;
  if (aiConfig.provider === 'anthropic') {
    const apiKey = aiConfig.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.log('⚠ Anthropic API key not found. Run: larkx init');
      return;
    }
    client = new Anthropic({ apiKey });
  }

  let done = 0;
  for (const node of fileNodes) {
    const fullPath = path.join(projectRoot, node.file);
    let content: string;
    try {
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch {
      done++;
      continue;
    }

    const lines = content.split('\n');
    const truncated = lines.length > 200
      ? [...lines.slice(0, 100), '// ... (truncated) ...', ...lines.slice(-20)].join('\n')
      : content;

    try {
      let text: string | null = null;
      if (aiConfig.provider === 'local-claude') {
        text = await callLocalClaude(`${SYSTEM_PROMPT}\n\nFile: ${node.file}\n\n${truncated}`);
      } else if (client) {
        text = await callAnthropic(client, node.file, truncated);
      }
      if (text) summaries[node.file] = text;
    } catch (err: any) {
      console.warn(`⚠ Could not summarize ${node.file}: ${err.message}`);
    }

    done++;
    process.stdout.write(`Summarizing files... ${done}/${fileNodes.length}\r`);
    if (done % 5 === 0) saveSummaries(projectRoot, summaries);
  }

  saveSummaries(projectRoot, summaries);
  process.stdout.write('\n');
  console.log(`✓ Generated ${done} summaries`);
}
