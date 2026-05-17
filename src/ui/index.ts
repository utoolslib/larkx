import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { loadIndex, loadGraph, loadSummaries } from '../storage/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  if (platform === 'darwin') cmd = `open "${url}"`;
  else if (platform === 'win32') cmd = `start "${url}"`;
  else cmd = `xdg-open "${url}"`;
  exec(cmd, () => {});
}

async function tryListen(app: express.Express, port: number, maxAttempts: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => resolve(port));
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        server.close();
        if (maxAttempts <= 1) {
          reject(new Error(`Could not find an available port (tried up to ${port})`));
        } else {
          console.log(`⚠ Port ${port} in use, trying ${port + 1}...`);
          tryListen(app, port + 1, maxAttempts - 1).then(resolve).catch(reject);
        }
      } else {
        reject(err);
      }
    });
  });
}

export async function startUIServer(projectRoot: string, port: number): Promise<void> {
  const app = express();

  const publicDir = path.join(__dirname, '..', '..', 'public');

  app.get('/', (_req, res) => {
    const htmlPath = path.join(publicDir, 'graph.html');
    if (fs.existsSync(htmlPath)) {
      res.sendFile(htmlPath);
    } else {
      res.status(404).send('graph.html not found — run npm run build first');
    }
  });

  app.get('/api/graph', (_req, res) => {
    const index = loadIndex(projectRoot) as any[] | null;
    const graph = loadGraph(projectRoot) as any | null;
    res.json({
      nodes: graph?.nodes ?? [],
      edges: graph?.edges ?? [],
      files: index ?? [],
    });
  });

  app.get('/api/meta', (_req, res) => {
    const metaPath = path.join(projectRoot, '.lark', 'meta.json');
    if (fs.existsSync(metaPath)) {
      res.json(JSON.parse(fs.readFileSync(metaPath, 'utf-8')));
    } else {
      res.json({});
    }
  });

  app.get('/api/summaries', (_req, res) => {
    res.json(loadSummaries(projectRoot) ?? {});
  });

  app.get('/api/root', (_req, res) => {
    res.json({ root: projectRoot });
  });

  try {
    const actualPort = await tryListen(app, port, 5);
    const url = `http://localhost:${actualPort}`;
    console.log(`✓ UI running at ${url}`);
    // small delay so the message prints before browser opens
    setTimeout(() => openBrowser(url), 500);
  } catch (err: any) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }
}
