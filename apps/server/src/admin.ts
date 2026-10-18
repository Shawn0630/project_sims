import { readFileSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';
import type { ProblemDef } from '@sds/problems';
import { COMPONENTS, componentDef, type ComponentDef } from '@sds/components';
import { defaultSettings } from '@sds/sim-core';
import type { ProblemStorage } from './storage';
import { listCalls } from './calllog';

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
 *   GET    /api/components             component registry (defs + merged overrides)
 *   PUT    /api/components/:type/overrides   replace a component's numeric overrides
 *   DELETE /api/components/:type/overrides   clear them (or one, via ?key=)
 *   GET    /api/admin/llm-calls        recent LLM call log records (?limit=)
 *
 * Component definitions themselves are code (@sds/components) — the console
 * never edits code. The ONLY writable layer is numeric default-parameter
 * overrides, stored server-side in data/component-overrides.json. HONEST
 * BOUNDARY: nothing consumes those overrides yet — the answering frontend's
 * simulation runs on the component definitions bundled in its own build —
 * so overrides are a server-side record awaiting runtime wiring, and both
 * this API and the console page say so.
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

// ------------------------------------------------------- component registry -
const OVERRIDES_FILE = path.join(DATA_DIR, 'component-overrides.json');

type OverrideMap = Record<string, Record<string, number>>;

async function readOverrides(): Promise<OverrideMap> {
  try {
    const raw = await readFile(OVERRIDES_FILE, 'utf8');
    const parsed = JSON.parse(raw) as OverrideMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeOverrides(map: OverrideMap): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(OVERRIDES_FILE, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
}

interface NumericParam {
  key: string;
  /** 'model' = component definition numbers; 'instance' = per-node settings defaults. */
  group: 'model' | 'instance';
  default: number;
}

/** Every numeric default a component carries — the only keys overrides may touch. */
function numericParamsOf(def: ComponentDef): NumericParam[] {
  const out: NumericParam[] = [];
  const model: [string, number | undefined][] = [
    ['defaultCapacityPerReplica', def.defaultCapacityPerReplica],
    ['baseLatencyMs', def.baseLatencyMs],
    ['costPerReplicaPerHour', def.costPerReplicaPerHour],
    ['baseHitRate', def.baseHitRate],
    ['bufferSize', def.bufferSize],
  ];
  for (const [key, v] of model) if (typeof v === 'number') out.push({ key, group: 'model', default: v });
  for (const [key, v] of Object.entries(defaultSettings(def.type))) {
    if (typeof v === 'number') out.push({ key, group: 'instance', default: v });
  }
  return out;
}

async function componentRegistry(storage: ProblemStorage, overrides: OverrideMap) {
  const packs = await storage.listProblems();
  return COMPONENTS.map((def) => {
    const mine = overrides[def.type] ?? {};
    const referencedByDetail = packs
      .map((p) => {
        const via: string[] = [];
        if (p.sampleDesign.nodes.some((n) => n.type === def.type)) via.push('示例设计');
        if (p.workload.patterns.some((pt) => pt.path.includes(def.type))) via.push('workload 路径');
        return via.length ? { problemId: p.id, via } : null;
      })
      .filter((x): x is { problemId: string; via: string[] } => !!x);
    return {
      type: def.type,
      name: def.name,
      nameEn: def.nameEn,
      category: def.category,
      behavior: def.behavior,
      icon: def.icon,
      color: def.color,
      blurb: def.blurb,
      lab: def.lab,
      labTitle: def.labTitle,
      model: {
        defaultCapacityPerReplica: def.defaultCapacityPerReplica,
        baseLatencyMs: def.baseLatencyMs,
        costPerReplicaPerHour: def.costPerReplicaPerHour,
        ...(def.baseHitRate !== undefined ? { baseHitRate: def.baseHitRate } : {}),
        ...(def.bufferSize !== undefined ? { bufferSize: def.bufferSize } : {}),
      },
      // The component's built-in common design problems, as encoded in its
      // interviewer question chain (the same content ScriptedDriver falls
      // back to and deep dives are built around).
      questions: def.questions,
      params: numericParamsOf(def).map((p) => ({
        ...p,
        value: mine[p.key] ?? p.default,
        overridden: mine[p.key] !== undefined,
      })),
      referencedBy: referencedByDetail.map((r) => r.problemId),
      referencedByDetail,
      overridesWired: false, // see the header comment: record-only for now
    };
  });
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

  // ------------------------------------------------------- components admin -
  app.get('/api/components', async (c) => {
    return c.json(await componentRegistry(storage, await readOverrides()));
  });

  // Replace semantics: the body IS the component's complete override set
  // ({ key: number }); keys must be that component's known numeric params.
  app.put('/api/components/:type/overrides', async (c) => {
    const type = c.req.param('type');
    let def: ComponentDef;
    try {
      def = componentDef(type as ComponentDef['type']);
    } catch {
      return c.json({ error: 'component_not_found' }, 404);
    }
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json(badRequest('需要 { 参数名: 数值 } 形式的覆盖对象'), 400);
    }
    const allowed = new Map(numericParamsOf(def).map((p) => [p.key, p.default]));
    const clean: Record<string, number> = {};
    for (const [key, v] of Object.entries(body)) {
      if (!allowed.has(key)) return c.json(badRequest(`参数 ${key} 不是 ${type} 的数值型默认参数`), 400);
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        return c.json(badRequest(`参数 ${key} 的覆盖值必须是有限数值`), 400);
      }
      // A value equal to the code default is not an override — drop it.
      if (v !== allowed.get(key)) clean[key] = v;
    }
    const all = await readOverrides();
    if (Object.keys(clean).length) all[type] = clean;
    else delete all[type];
    await writeOverrides(all);
    const entry = (await componentRegistry(storage, all)).find((e) => e.type === type);
    return c.json({ ok: true, type, overrides: clean, entry });
  });

  app.delete('/api/components/:type/overrides', async (c) => {
    const type = c.req.param('type');
    try {
      componentDef(type as ComponentDef['type']);
    } catch {
      return c.json({ error: 'component_not_found' }, 404);
    }
    const all = await readOverrides();
    const key = c.req.query('key');
    if (key && all[type]) {
      delete all[type][key];
      if (!Object.keys(all[type]).length) delete all[type];
    } else {
      delete all[type];
    }
    await writeOverrides(all);
    return c.json({ ok: true, type, overrides: all[type] ?? {} });
  });

  // ------------------------------------------------------------ call log -
  app.get('/api/admin/llm-calls', async (c) => {
    const limit = Number(c.req.query('limit') ?? 50);
    return c.json(await listCalls(Number.isFinite(limit) ? limit : 50));
  });
}
