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

function checkerPath() {
  return path.join(SKILL_ROOT, 'archify', 'scripts', 'check-render-output.mjs');
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

function checkerDiagnostics(checker) {
  const diagnostics = [];
  const FIXES = {
    'composition/proper-crossing': ['adjust route/via coordinates'],
    'composition/ambiguous-corridor': ['adjust route/via coordinates'],
    'composition/container-border-run': ['route through clear opening'],
    'composition/label-route-clearance': ['adjust label or route'],
    'composition/desktop-readability': ['reduce viewBox or widen nodes'],
    'composition/micro-segment': ['move route point'],
    'composition/short-interior-segment': ['move route point'],
    single_svg: ['remove extra SVG roots'],
    finite_svg: ['replace non-finite coordinates'],
    orthogonal_arrows: ['use supported routing controls'],
    legend_clearance: ['move route or enlarge viewBox'],
  };
  for (const issue of checker?.composition?.issues || []) {
    if (issue.severity !== 'error') continue;
    const { severity, code, relationship, ...evidence } = issue;
    diagnostics.push({ code, severity, message: `Failed ${code}.`, subject: relationship ? { relationship } : { check: 'composition' }, evidence, supportedFixes: FIXES[code] || [] });
  }
  for (const check of checker?.checks || []) {
    if (check.ok) continue;
    diagnostics.push({ code: `artifact/${check.name.replaceAll('_', '-')}`, message: (check.details || []).find(Boolean) || `Failed ${check.name}.`, subject: { check: check.name }, evidence: { details: check.details || [] }, supportedFixes: FIXES[check.name] || [] });
  }
  return diagnostics.length ? diagnostics : [{ code: 'artifact/check-failed', message: 'Check failed.', subject: { check: 'unknown' }, evidence: {} }];
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

  const { type, specification, quality, repoRoot, layoutJson } = body;

  if (!type || !TYPES.has(type)) {
    return response.status(400).json({ error: `Invalid type. Expected one of: ${[...TYPES].join(', ')}` });
  }
  if (!specification || typeof specification !== 'object') {
    return response.status(400).json({ error: 'Missing or invalid specification object' });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-validate-'));
  const inputPath = path.join(tmpDir, `${type}.json`);
  const outputPath = path.join(tmpDir, `${type}.html`);

  try {
    fs.writeFileSync(inputPath, JSON.stringify(specification));

    const env = {
      ...process.env,
      ...(quality ? { ARCHIFY_QUALITY_PROFILE: quality } : {}),
      ...(repoRoot ? { ARCHIFY_REPO_ROOT: repoRoot } : {}),
    };

    const rendererArgs = [rendererPath(type), inputPath, outputPath];
    if (layoutJson) rendererArgs.push('--layout-json');

    const render = spawnSync('node', rendererArgs, {
      encoding: 'utf8',
      stdio: 'pipe',
      env,
      cwd: SKILL_ROOT,
    });

    if (layoutJson) {
      if (render.status !== 0 && !render.stdout?.trim()) {
        const failure = rendererFailure(render);
        return response.status(422).json({ ok: false, error: failure.error, diagnostics: failure.diagnostics });
      }
      let receipt;
      try { receipt = JSON.parse(render.stdout); }
      catch { return response.status(500).json({ ok: false, error: 'Could not parse renderer receipt.' }); }
      return response.status(receipt.ok !== false ? 200 : 422).json(receipt);
    }

    if (render.status !== 0) {
      const failure = rendererFailure(render);
      return response.status(422).json({ ok: false, error: failure.error, diagnostics: failure.diagnostics });
    }

    const check = spawnSync('node', [checkerPath(), outputPath], {
      encoding: 'utf8',
      stdio: 'pipe',
      cwd: SKILL_ROOT,
    });

    let result;
    try { result = JSON.parse(check.stdout); }
    catch { return response.status(500).json({ ok: false, error: 'Could not parse artifact check receipt.' }); }

    if (check.status !== 0) {
      return response.status(422).json({ ok: false, diagnostics: checkerDiagnostics(result), checker: result });
    }

    return response.status(200).json({
      schemaVersion: 1,
      ok: true,
      command: 'validate',
      type,
      checks: result.checks,
      composition: result.composition,
    });
  } catch (error) {
    response.status(500).json({ ok: false, error: `Validation failed: ${error.message}` });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}
