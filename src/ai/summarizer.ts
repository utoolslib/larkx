import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import type { GraphNode } from '../graph/index.js';
import { loadSummaries, saveSummaries, type AiConfig } from '../storage/index.js';

const SYSTEM_PROMPT = 'You summarize code files in exactly ONE sentence. Be specific about what the file does.';

async function callLocalClaude(prompt: string): Promise<{ text: string | null; error?: string }> {
  const { spawn } = await import('child_process');
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'claude.cmd' : 'claude';
    const child = spawn(cmd, ['-p', prompt], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    child.on('close', (code) => {
      const out = stdout.trim();
      if (code === 0 && out && !/^API Error|^Error:/i.test(out)) {
        resolve({ text: out });
      } else {
        resolve({ text: null, error: (stderr.trim() || out || `exit ${code}`).split('\n')[0] });
      }
    });
    child.on('error', (err) => resolve({ text: null, error: err.message }));
    setTimeout(() => { child.kill(); resolve({ text: null, error: 'timeout after 30s' }); }, 30000);
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
  let succeeded = 0;
  let failed = 0;
  let firstError: string | undefined;
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

    let text: string | null = null;
    let error: string | undefined;
    try {
      if (aiConfig.provider === 'local-claude') {
        const r = await callLocalClaude(`${SYSTEM_PROMPT}\n\nFile: ${node.file}\n\n${truncated}`);
        text = r.text;
        error = r.error;
      } else if (client) {
        text = await callAnthropic(client, node.file, truncated);
      }
      if (text) {
        summaries[node.file] = text;
        succeeded++;
      } else {
        failed++;
        if (error && !firstError) firstError = error;
        if (error && /rate limit|429|too many/i.test(error)) {
          done++;
          process.stdout.write('\n');
          console.log(`⚠ Rate limit hit after ${succeeded} summaries. Stopping. Re-run later to continue.`);
          saveSummaries(projectRoot, summaries);
          return;
        }
      }
    } catch (err: any) {
      failed++;
      if (!firstError) firstError = err.message;
    }

    done++;
    process.stdout.write(`Summarizing files... ${done}/${fileNodes.length}\r`);
    if (done % 5 === 0) saveSummaries(projectRoot, summaries);
    if (aiConfig.provider === 'local-claude' && done < fileNodes.length) {
      await new Promise(r => setTimeout(r, 800));
    }
  }

  saveSummaries(projectRoot, summaries);
  process.stdout.write('\n');
  if (succeeded > 0) console.log(`✓ Generated ${succeeded} summaries`);
  if (failed > 0) {
    console.log(`⚠ ${failed} file${failed === 1 ? '' : 's'} failed${firstError ? `: ${firstError}` : ''}`);
  }
}
