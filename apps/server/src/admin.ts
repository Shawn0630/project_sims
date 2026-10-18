import { readFileSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';
import type { ProblemDef } from '@sds/problems';
import type { ProblemStorage } from './storage';

/**
 * Author admin — the problem-bank console (and the future home of the LLM
 * problem-generation system). LOCAL / INTRANET USE ONLY: there is no auth
 * in this round by design; the write endpoints below (PUT/DELETE on packs)
 * must never be exposed to the public internet as-is.
 *
 *   GET    /admin                      the console page (admin.html)
 *   GET    /api/admin/problems         pack summaries (incl. hidden counts + draft flag)
 *   GET    /api/admin/problems/:id     the FULL stored pack (hidden cases included —
 *                                      unlike the client projection in packs.ts)
 *   PUT    /api/problems/:id           replace a pack (validated, then storage.save)
 *   DELETE /api/problems/:id           remove a pack (storage.delete)
 *   POST   /api/problems/draft         persist a seed as a minimal draft pack
 *
 * Draft bookkeeping lives in a sidecar file (data/drafts.json, a list of
 * pack ids) so packs themselves stay plain ProblemDef — no shape change.
 */

const DATA_DIR = fileURLToPath(new URL('../data/', import.meta.url));
const DRAFTS_FILE = path.join(DATA_DIR, 'drafts.json');
const ADMIN_HTML = readFileSync(new URL('./admin.html', import.meta.url), 'utf8');

const badRequest = (message: string) => ({ error: 'bad_request', message }) as const;

// ------------------------------------------------------------ draft sidecar -
async function readDraftIds(): Promise<Set<string>> {
  try {
    const raw = await readFile(DRAFTS_FILE, 'utf8');
    const arr = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

async function writeDraftIds(ids: Set<string>): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(DRAFTS_FILE, `${JSON.stringify([...ids].sort(), null, 2)}\n`, 'utf8');
}

// ------------------------------------------------------------------ helpers -
function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || `problem-${Date.now().toString(36)}`;
}

/** Minimal well-formed pack for a fresh seed: author fills the rest in the JSON editor. */
function draftPack(id: string, title: string, statement: string, scaleNotes: string): ProblemDef {
  return {
    id,
    name: title,
    nameEn: title,
    difficulty: '中等',
    tags: ['草稿'],
    statement,
    functionalRequirements: [],
    scale: {
      dau: scaleNotes || '（待补充）',
      readRatio: 0.9,
      peakMultiplier: 1,
      baselineRps: 100,
      budgetCostPerHour: 100,
      notes: scaleNotes,
    },
    flags: { mediaHeavy: false, hasFanout: false, publicWriteApi: false, readHeavy: false },
    schema: { tables: [], accessPatterns: [] },
    workload: { readRatio: 0.9, consistency: '（待补充）', patterns: [] },
    testCases: [],
    sampleDesign: { nodes: [], edges: [] },
  };
}

function isPackLike(v: unknown): v is ProblemDef {
  const p = v as ProblemDef | null;
  return (
    !!p &&
    typeof p === 'object' &&
    typeof p.id === 'string' &&
    typeof p.name === 'string' &&
    typeof p.statement === 'string' &&
    Array.isArray(p.testCases) &&
    !!p.schema &&
    Array.isArray(p.schema.tables) &&
    !!p.sampleDesign &&
    Array.isArray(p.sampleDesign.nodes) &&
    Array.isArray(p.sampleDesign.edges)
  );
}

// ------------------------------------------------------------------- routes -
export function registerAdminRoutes(app: Hono, storage: ProblemStorage): void {
  app.get('/admin', (c) => c.html(ADMIN_HTML));

  app.get('/api/admin/problems', async (c) => {
    const [packs, drafts] = await Promise.all([storage.listProblems(), readDraftIds()]);
    return c.json(
      packs.map((p) => ({
        id: p.id,
        name: p.name,
        difficulty: p.difficulty,
        tags: p.tags,
        draft: drafts.has(p.id),
        visibleCases: p.testCases.filter((t) => !t.hidden).length,
        hiddenCases: p.testCases.filter((t) => t.hidden).length,
        tables: p.schema.tables.length,
      })),
    );
  });

  app.get('/api/admin/problems/:id', async (c) => {
    const pack = await storage.getProblem(c.req.param('id'));
    if (!pack) return c.json({ error: 'problem_not_found' }, 404);
    const drafts = await readDraftIds();
    return c.json({ ...pack, draft: drafts.has(pack.id) });
  });

  // Authoring write API — LOCAL USE ONLY (no auth in this round).
  app.put('/api/problems/:id', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => null)) as ProblemDef | null;
    if (!body || !isPackLike(body)) {
      return c.json(
        badRequest('需要一份完整题目包 JSON（id / name / statement / schema.tables / testCases / sampleDesign）'),
        400,
      );
    }
    if (body.id !== id) {
      return c.json(badRequest(`pack.id（${body.id}）与路径 id（${id}）不一致`), 400);
    }
    // The admin-only `draft` marker rides along on GET responses; it is not
    // part of the pack shape — strip it before persisting.
    const { draft: _draft, ...pack } = body as ProblemDef & { draft?: boolean };
    await storage.saveProblem(pack as ProblemDef);
    return c.json({ ok: true, id });
  });

  app.delete('/api/problems/:id', async (c) => {
    const id = c.req.param('id');
    const existed = await storage.deleteProblem(id);
    if (!existed) return c.json({ error: 'problem_not_found' }, 404);
    const drafts = await readDraftIds();
    if (drafts.delete(id)) await writeDraftIds(drafts);
    return c.json({ ok: true, id });
  });

  // Seed → draft pack. The LLM generator (POST /api/problems/generate) is
  // still a 501 stub; this is the manual path that keeps the author flow
  // working end to end today.
  app.post('/api/problems/draft', async (c) => {
    const seed = (await c.req.json().catch(() => null)) as {
      title?: unknown;
      statement?: unknown;
      scaleNotes?: unknown;
    } | null;
    if (
      !seed ||
      typeof seed.title !== 'string' ||
      !seed.title.trim() ||
      typeof seed.statement !== 'string' ||
      !seed.statement.trim()
    ) {
      return c.json(badRequest('需要题目种子 { title: string, statement: string, scaleNotes?: string }'), 400);
    }
    const base = slugify(seed.title.trim());
    let id = base;
    for (let n = 2; await storage.getProblem(id); n += 1) id = `${base}-${n}`;
    const pack = draftPack(
      id,
      seed.title.trim(),
      seed.statement.trim(),
      typeof seed.scaleNotes === 'string' ? seed.scaleNotes.trim() : '',
    );
    await storage.saveProblem(pack);
    const drafts = await readDraftIds();
    drafts.add(id);
    await writeDraftIds(drafts);
    return c.json({ ok: true, id, draft: true, pack }, 201);
  });
}
