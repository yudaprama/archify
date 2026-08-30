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

function checkerPath() {
  return path.join(SKILL_ROOT, 'archify', 'scripts', 'check-render-output.mjs');
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

function diagnostic({ code, message, subject = {}, evidence = {}, supportedFixes = [], severity = 'error' }) {
  return { code, severity, message, subject, evidence, supportedFixes };
}

function checkerDiagnostics(checker) {
  const diagnostics = [];
  const COMPOSITION_FIXES = {
    'composition/proper-crossing': ['adjust route/via or channel coordinates'],
    'composition/ambiguous-corridor': ['adjust route/via or channel coordinates'],
    'composition/container-border-run': ['route across the frame perpendicularly'],
    'composition/label-route-clearance': ['adjust labelAt, labelDx, labelDy, or route'],
    'composition/desktop-readability': ['reduce viewBox width or widen nodes'],
    'composition/micro-segment': ['move route/channel/via point'],
    'composition/short-interior-segment': ['move route/channel/via point'],
  };
  const CHECK_FIXES = {
    single_svg: ['remove additional SVG roots'],
    finite_svg: ['replace non-finite coordinates'],
    orthogonal_arrows: ['use renderer-supported routing controls'],
    legend_clearance: ['move the route or enlarge the viewBox'],
  };

  for (const issue of checker?.composition?.issues || []) {
    if (issue.severity !== 'error') continue;
    const { severity, code, relationship, ...evidence } = issue;
    diagnostics.push(diagnostic({ code, severity, message: `Failed ${code}.`, subject: relationship ? { relationship } : { check: 'composition' }, evidence, supportedFixes: COMPOSITION_FIXES[code] || [] }));
  }
  for (const check of checker?.checks || []) {
    if (check.ok) continue;
    diagnostics.push(diagnostic({ code: `artifact/${check.name.replaceAll('_', '-')}`, message: (check.details || []).find(Boolean) || `Failed ${check.name}.`, subject: { check: check.name }, evidence: { details: check.details || [] }, supportedFixes: CHECK_FIXES[check.name] || [] }));
  }
  return diagnostics.length ? diagnostics : [diagnostic({ code: 'artifact/check-failed', message: 'Check failed without classified diagnostic.', subject: { check: 'unknown' }, evidence: {} })];
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

  const { type, specification, quality, repoRoot, layoutJson } = body;

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

    const render = spawnSync(process.execPath, rendererArgs, {
      encoding: 'utf8',
      stdio: 'pipe',
      env,
      cwd: SKILL_ROOT,
    });

    if (layoutJson) {
      if (render.status !== 0 && !render.stdout?.trim()) {
        const failure = rendererFailure(render);
        return new Response(JSON.stringify({ ok: false, error: failure.error, diagnostics: failure.diagnostics }), {
          status: 422,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      let receipt;
      try {
        receipt = JSON.parse(render.stdout);
      } catch {
        return new Response(JSON.stringify({ ok: false, error: 'Could not parse renderer receipt.', stdout: render.stdout }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(receipt), {
        status: receipt.ok !== false ? 200 : 422,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (render.status !== 0) {
      const failure = rendererFailure(render);
      return new Response(JSON.stringify({ ok: false, error: failure.error, diagnostics: failure.diagnostics }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const check = spawnSync(process.execPath, [checkerPath(), outputPath], {
      encoding: 'utf8',
      stdio: 'pipe',
      cwd: SKILL_ROOT,
    });

    let result;
    try {
      result = JSON.parse(check.stdout);
    } catch {
      return new Response(JSON.stringify({ ok: false, error: 'Could not parse artifact check receipt.' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (check.status !== 0) {
      const diagnostics = checkerDiagnostics(result);
      return new Response(JSON.stringify({ ok: false, diagnostics, checker: result }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const receipt = {
      schemaVersion: 1,
      ok: true,
      command: 'validate',
      type,
      checks: result.checks,
      composition: result.composition,
    };

    return new Response(JSON.stringify(receipt), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: `Validation failed: ${error.message}` }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}
