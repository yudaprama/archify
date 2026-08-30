import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(__dirname, '..');

const TYPES = new Set(['architecture', 'workflow', 'sequence', 'dataflow', 'lifecycle']);

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    request.on('error', reject);
  });
}

function verifyToken(request) {
  const header = request.headers.authorization || request.headers.Authorization || '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice(7);
  const expected = process.env.ARCHIFY_API_TOKEN;
  if (!expected || token.length !== expected.length) return false;
  let result = 0;
  for (let i = 0; i < token.length; i++) result |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  return result === 0;
}

function rendererPath(type) {
  return path.join(SKILL_ROOT, 'archify', 'renderers', type, `render-${type}.mjs`);
}

function rendererFailure(result) {
  if (result.error) return { error: `Renderer process could not start: ${result.error.message}`, diagnostics: [] };
  try {
    const payload = JSON.parse((result.stderr || '').trim());
    if (payload?.ok === false && Array.isArray(payload.diagnostics) && payload.diagnostics.length) {
      return { error: payload.error || payload.diagnostics[0].message, diagnostics: payload.diagnostics };
    }
  } catch {}
  return {
    error: 'Renderer failed before emitting a structured diagnostic.',
    diagnostics: [{ code: 'internal/unclassified', message: 'Renderer failed.', evidence: { exitCode: result.status ?? 1 } }],
  };
}

export default async function handler(request, response) {
  if (!verifyToken(request)) {
    return response.status(401).json({ error: 'Unauthorized' });
  }

  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method not allowed' });
  }

  let body;
  try {
    body = await readBody(request);
  } catch {
    return response.status(400).json({ error: 'Invalid JSON body' });
  }

  const { type, specification, quality, repoRoot } = body;

  if (!type || !TYPES.has(type)) {
    return response.status(400).json({ error: `Invalid type. Expected one of: ${[...TYPES].join(', ')}` });
  }
  if (!specification || typeof specification !== 'object') {
    return response.status(400).json({ error: 'Missing or invalid specification object' });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-render-'));
  const inputPath = path.join(tmpDir, `${type}.json`);
  const outputPath = path.join(tmpDir, `${type}.html`);

  try {
    fs.writeFileSync(inputPath, JSON.stringify(specification));

    const env = {
      ...process.env,
      ...(quality ? { ARCHIFY_QUALITY_PROFILE: quality } : {}),
      ...(repoRoot ? { ARCHIFY_REPO_ROOT: repoRoot } : {}),
    };

    const result = spawnSync('node', [rendererPath(type), inputPath, outputPath], {
      encoding: 'utf8',
      stdio: 'pipe',
      env,
      cwd: SKILL_ROOT,
    });

    if (result.status !== 0) {
      const failure = rendererFailure(result);
      return response.status(422).json({ error: failure.error, diagnostics: failure.diagnostics });
    }

    const html = fs.readFileSync(outputPath, 'utf8');
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.send(html);
  } catch (error) {
    response.status(500).json({ error: `Render failed: ${error.message}` });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}
