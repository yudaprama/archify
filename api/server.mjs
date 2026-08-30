import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIFY_ROOT = path.join(__dirname, '..', 'archify');

const TYPES = new Set(['architecture', 'workflow', 'sequence', 'dataflow', 'lifecycle']);

function verifyToken(request) {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice(7);
  const expected = process.env.ARCHIFY_API_TOKEN;
  if (!expected || token.length !== expected.length) return false;
  let result = 0;
  for (let i = 0; i < token.length; i++) result |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  return result === 0;
}

async function handleRender(request) {
  if (!verifyToken(request)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 });

  let body;
  try { body = await request.json(); }
  catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const { type, specification, quality } = body;
  if (!type || !TYPES.has(type)) return Response.json({ error: `Invalid type. Expected one of: ${[...TYPES].join(', ')}` }, { status: 400 });
  if (!specification || typeof specification !== 'object') return Response.json({ error: 'Missing or invalid specification' }, { status: 400 });

  try {
    const { validateSchema } = await import(path.join(ARCHIFY_ROOT, 'renderers/shared/validator.mjs'));
    validateSchema(type, specification);

    if (type !== 'workflow') return Response.json({ error: `Renderer for "${type}" not yet supported` }, { status: 400 });

    const { compileWorkflow } = await import(path.join(ARCHIFY_ROOT, 'renderers/workflow/workflow-compiler.mjs'));
    const result = compileWorkflow({ workflow: specification, qualityProfile: quality || specification.meta?.quality_profile });

    if (!result.ok) return Response.json({ ok: false, error: result.error, diagnostics: result.diagnostics }, { status: 422 });

    const template = fs.readFileSync(path.join(ARCHIFY_ROOT, 'assets/template.html'), 'utf8');
    const { applyTemplate, renderCards } = await import(path.join(ARCHIFY_ROOT, 'renderers/shared/utils.mjs'));
    const html = applyTemplate(template, {
      title: specification.meta?.title || 'Untitled',
      subtitle: specification.meta?.subtitle,
      svg: result.svg,
      cards: renderCards(specification.cards),
      locale: specification.meta?.locale,
      visualPreset: specification.meta?.visual_preset || 'classic',
      guidedViews: specification.meta?.views || [],
    });

    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  } catch (error) {
    const diagnostics = error.archifyDiagnostics || [];
    if (diagnostics.length) return Response.json({ ok: false, error: error.message, diagnostics }, { status: 422 });
    return Response.json({ error: error.message || 'Render failed' }, { status: 500 });
  }
}

async function handleValidate(request) {
  if (!verifyToken(request)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 });

  let body;
  try { body = await request.json(); }
  catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const { type, specification, quality, layoutJson } = body;
  if (!type || !TYPES.has(type)) return Response.json({ error: `Invalid type. Expected one of: ${[...TYPES].join(', ')}` }, { status: 400 });
  if (!specification || typeof specification !== 'object') return Response.json({ error: 'Missing or invalid specification' }, { status: 400 });

  try {
    const { validateSchema } = await import(path.join(ARCHIFY_ROOT, 'renderers/shared/validator.mjs'));
    validateSchema(type, specification);

    if (type !== 'workflow') return Response.json({ ok: false, error: `Validate for "${type}" not yet supported` }, { status: 400 });

    const { compileWorkflow } = await import(path.join(ARCHIFY_ROOT, 'renderers/workflow/workflow-compiler.mjs'));
    const result = compileWorkflow({ workflow: specification, qualityProfile: quality || specification.meta?.quality_profile });

    if (layoutJson) return Response.json(result.receipt || { ok: result.ok, diagnostics: result.diagnostics });
    if (!result.ok) return Response.json({ ok: false, error: result.error, diagnostics: result.diagnostics }, { status: 422 });

    return Response.json({
      schemaVersion: 1,
      ok: true,
      command: 'validate',
      type,
      composition: result.receipt?.composition || { status: 'pass' },
    });
  } catch (error) {
    const diagnostics = error.archifyDiagnostics || [];
    if (diagnostics.length) return Response.json({ ok: false, error: error.message, diagnostics }, { status: 422 });
    return Response.json({ ok: false, error: error.message || 'Validation failed' }, { status: 500 });
  }
}

Bun.serve({
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/api/render') return handleRender(request);
    if (url.pathname === '/api/validate') return handleValidate(request);
    return Response.json({ error: 'Not found' }, { status: 404 });
  },
});
