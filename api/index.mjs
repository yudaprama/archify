import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIFY_ROOT = path.join(__dirname, '..', 'archify');

const TYPES = new Set(['architecture', 'workflow', 'sequence', 'dataflow', 'lifecycle']);

const app = new Hono();

// --- Auth middleware ---
app.use('*', async (c, next) => {
  const header = c.req.header('Authorization') || '';
  if (!header.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const token = header.slice(7);
  const expected = process.env.ARCHIFY_API_TOKEN;
  if (!expected || token.length !== expected.length) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  let result = 0;
  for (let i = 0; i < token.length; i++) result |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  if (result !== 0) return c.json({ error: 'Unauthorized' }, 401);
  await next();
});

// --- POST /api/render ---
app.post('/api/render', async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { type, specification, quality } = body;

  if (!type || !TYPES.has(type)) {
    return c.json({ error: `Invalid type. Expected one of: ${[...TYPES].join(', ')}` }, 400);
  }
  if (!specification || typeof specification !== 'object') {
    return c.json({ error: 'Missing or invalid specification object' }, 400);
  }

  try {
    const { validateSchema } = await import(path.join(ARCHIFY_ROOT, 'renderers/shared/validator.mjs'));
    validateSchema(type, specification);

    if (type !== 'workflow') {
      return c.json({ error: `Renderer for "${type}" not yet supported via API` }, 400);
    }

    const { compileWorkflow } = await import(path.join(ARCHIFY_ROOT, 'renderers/workflow/workflow-compiler.mjs'));
    const result = compileWorkflow({
      workflow: specification,
      qualityProfile: quality || specification.meta?.quality_profile,
    });

    if (!result.ok) {
      return c.json({ ok: false, error: result.error, diagnostics: result.diagnostics }, 422);
    }

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

    return c.html(html);
  } catch (error) {
    const diagnostics = error.archifyDiagnostics || [];
    if (diagnostics.length) {
      return c.json({ ok: false, error: error.message, diagnostics }, 422);
    }
    return c.json({ error: error.message || 'Render failed' }, 500);
  }
});

// --- POST /api/validate ---
app.post('/api/validate', async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { type, specification, quality, layoutJson } = body;

  if (!type || !TYPES.has(type)) {
    return c.json({ error: `Invalid type. Expected one of: ${[...TYPES].join(', ')}` }, 400);
  }
  if (!specification || typeof specification !== 'object') {
    return c.json({ error: 'Missing or invalid specification object' }, 400);
  }

  try {
    const { validateSchema } = await import(path.join(ARCHIFY_ROOT, 'renderers/shared/validator.mjs'));
    validateSchema(type, specification);

    if (type !== 'workflow') {
      return c.json({ ok: false, error: `Validate for "${type}" not yet supported via API` }, 400);
    }

    const { compileWorkflow } = await import(path.join(ARCHIFY_ROOT, 'renderers/workflow/workflow-compiler.mjs'));
    const result = compileWorkflow({
      workflow: specification,
      qualityProfile: quality || specification.meta?.quality_profile,
    });

    if (layoutJson) {
      return c.json(result.receipt || { ok: result.ok, diagnostics: result.diagnostics });
    }

    if (!result.ok) {
      return c.json({ ok: false, error: result.error, diagnostics: result.diagnostics }, 422);
    }

    return c.json({
      schemaVersion: 1,
      ok: true,
      command: 'validate',
      type,
      composition: result.receipt?.composition || { status: 'pass' },
    });
  } catch (error) {
    const diagnostics = error.archifyDiagnostics || [];
    if (diagnostics.length) {
      return c.json({ ok: false, error: error.message, diagnostics }, 422);
    }
    return c.json({ ok: false, error: error.message || 'Validation failed' }, 500);
  }
});

export default app;
