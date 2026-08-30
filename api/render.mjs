import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(__dirname, '..');

const TYPES = new Set(['architecture', 'workflow', 'sequence', 'dataflow', 'lifecycle']);

function verifyToken(request) {
  const header = request.headers.get('Authorization');
  if (!header || !header.startsWith('Bearer ')) return false;
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
  if (result.error) {
    return { error: `Renderer process could not start: ${result.error.message}`, diagnostics: [] };
  }
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

export default async function handler(request) {
  if (!verifyToken(request)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { type, specification, quality, repoRoot } = body;

  if (!type || !TYPES.has(type)) {
    return new Response(JSON.stringify({ error: `Invalid type. Expected one of: ${[...TYPES].join(', ')}` }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!specification || typeof specification !== 'object') {
    return new Response(JSON.stringify({ error: 'Missing or invalid specification object' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
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

    const result = spawnSync(process.execPath, [rendererPath(type), inputPath, outputPath], {
      encoding: 'utf8',
      stdio: 'pipe',
      env,
      cwd: SKILL_ROOT,
    });

    if (result.status !== 0) {
      const failure = rendererFailure(result);
      return new Response(JSON.stringify({ error: failure.error, diagnostics: failure.diagnostics }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const html = fs.readFileSync(outputPath, 'utf8');
    return new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: `Render failed: ${error.message}` }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

export const config = {
  runtime: 'bun',
};
