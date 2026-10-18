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
import {
  ENV_PROFILE_ID,
  envProfile,
  maskKey,
  maskedEnvProfile,
  maskedProfile,
  readConfigFile,
  resolveActiveProfile,
  resolveProfileById,
  writeConfigFile,
  type LlmConfigFile,
  type LlmProfile,
} from './llmconfig';

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
 *   GET    /api/admin/llm-config       model profiles (keys MASKED) + active id
 *   PUT    /api/admin/llm-config       save the whole profile table + active id
 *   POST   /api/admin/llm-models       list a provider's models (GET /models)
 *   POST   /api/admin/llm-test         one tiny chat completion to prove a
 *                                      profile can actually be called
 *
 * Model profiles live in data/llm-config.json (gitignored — it holds API
 * keys). Evaluation resolves the ACTIVE profile per call, so a switch in
 * this console takes effect on the next /api/evaluate with no restart.
 * Keys are only ever returned to the browser masked (last 4 chars).
 * The profile list ALWAYS starts with the built-in 「.env 配置」 entry:
 * synthesized live from the server's .env, READ-ONLY (the PUT below
 * refuses to store/modify/delete a record with its reserved id; only its
 * activation and its userSelectable opt-in persist), so the author keeps
 * an uncorruptible fallback next to the editable profiles.
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

  // ------------------------------------------------- LLM 配置（模型档案）-
  /**
   * The admin console's view of the LLM configuration: the built-in env
   * entry FIRST (live values, masked, readonly — it is synthesized from
   * .env and can never be edited or deleted here), then the stored file
   * profiles. `source`/`activeProfileId` mirror the real resolution, so
   * an active env entry reports source 'env' even when a file exists.
   */
  async function llmConfigView() {
    const file = await readConfigFile();
    const resolved = await resolveActiveProfile();
    return {
      source: resolved.source,
      activeProfileId: resolved.id,
      envProfileUserSelectable: file?.envProfileUserSelectable === true,
      profiles: [
        maskedEnvProfile(file),
        ...(file?.profiles ?? []).map((p) => maskedProfile(p)),
      ],
    };
  }

  app.get('/api/admin/llm-config', async (c) => {
    return c.json(await llmConfigView());
  });

  app.put('/api/admin/llm-config', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      profiles?: unknown;
      activeProfileId?: unknown;
      envProfileUserSelectable?: unknown;
    } | null;
    if (!body || !Array.isArray(body.profiles)) {
      return c.json(badRequest('需要 { profiles: [...], activeProfileId }'), 400);
    }
    const existing = await readConfigFile();
    const existingById = new Map((existing?.profiles ?? []).map((p) => [p.id, p]));
    const profiles: LlmProfile[] = [];
    for (let i = 0; i < body.profiles.length; i += 1) {
      const p = body.profiles[i] as Partial<LlmProfile> | null;
      // The built-in env profile is READ-ONLY: it is synthesized from
      // .env at read time and never persisted. An entry carrying the
      // reserved id is dropped — UNLESS it tries to substantively change
      // the env values (different endpoint/model, or a foreign key),
      // which is rejected outright so the attempt is never silent.
      if (p && p.id === ENV_PROFILE_ID) {
        const env = envProfile();
        const foreignKey =
          typeof p.apiKey === 'string' &&
          p.apiKey !== '' &&
          p.apiKey !== env.apiKey &&
          p.apiKey !== maskKey(env.apiKey);
        const changedTarget =
          (typeof p.baseUrl === 'string' && p.baseUrl.replace(/\/$/, '') !== env.baseUrl) ||
          (typeof p.model === 'string' && p.model !== env.model);
        if (foreignKey || changedTarget) {
          return c.json(
            badRequest(
              '内置「.env 配置」档案只读：它直接读取服务端 .env，不能通过 admin 修改或覆盖；如需改值请编辑 apps/server/.env 后重启',
            ),
            400,
          );
        }
        continue;
      }
      if (
        !p ||
        typeof p.name !== 'string' ||
        !p.name.trim() ||
        typeof p.baseUrl !== 'string' ||
        !p.baseUrl.trim() ||
        typeof p.model !== 'string' ||
        !p.model.trim()
      ) {
        return c.json(badRequest(`profiles[${i}] 需要 name / baseUrl / model 非空字符串`), 400);
      }
      let baseUrl: string;
      try {
        baseUrl = new URL(p.baseUrl.trim()).toString().replace(/\/$/, '');
      } catch {
        return c.json(badRequest(`profiles[${i}].baseUrl 不是合法 URL`), 400);
      }
      const id =
        typeof p.id === 'string' && p.id ? p.id : `profile-${Date.now().toString(36)}-${i}`;
      const prev = existingById.get(id);
      // Key preservation: an incoming key is adopted only when it is a real
      // new value. Empty (form left blank) or the stored mask itself keeps
      // the stored key — a masked round-trip can never clobber a real key.
      let apiKey = prev?.apiKey ?? '';
      if (
        typeof p.apiKey === 'string' &&
        p.apiKey !== '' &&
        (!prev || p.apiKey !== maskKey(prev.apiKey))
      ) {
        apiKey = p.apiKey;
      }
      profiles.push({
        id,
        name: p.name.trim(),
        baseUrl,
        apiKey,
        model: p.model.trim(),
        // Admin opt-in only: end users of the solver app may pick profiles
        // carrying this flag (GET /api/models). Absent/false = server-only.
        ...(p.userSelectable === true ? { userSelectable: true } : {}),
      });
    }
    const ids = new Set(profiles.map((p) => p.id));
    if (ids.size !== profiles.length) {
      return c.json(badRequest('profiles 里有重复 id'), 400);
    }
    // 'env-default' is a legal active id: the built-in env entry is
    // activatable even though it is never stored as a profile record.
    const activeProfileId =
      body.activeProfileId === ENV_PROFILE_ID
        ? ENV_PROFILE_ID
        : typeof body.activeProfileId === 'string' && ids.has(body.activeProfileId)
          ? body.activeProfileId
          : (profiles[0]?.id ?? null);
    // The env profile's only mutable bit — preserved when the body omits it.
    const envProfileUserSelectable =
      typeof body.envProfileUserSelectable === 'boolean'
        ? body.envProfileUserSelectable
        : existing?.envProfileUserSelectable === true;
    const file: LlmConfigFile = {
      profiles,
      activeProfileId,
      ...(envProfileUserSelectable ? { envProfileUserSelectable: true } : {}),
    };
    await writeConfigFile(file);
    return c.json({ ok: true, ...(await llmConfigView()) });
  });

  // -------------------------------------------- 模型发现 / 连接测试（探针）-
  interface ProbeBody {
    baseUrl?: unknown;
    apiKey?: unknown;
    model?: unknown;
    profileId?: unknown;
  }

  /**
   * Resolve which endpoint/key/model a probe call targets: explicit body
   * values win; gaps are filled from a stored profile (profileId first,
   * else the active profile) so the console can probe an already-saved
   * profile without the browser ever seeing its real key.
   */
  async function resolveProbeTarget(body: ProbeBody) {
    const prof = await resolveProfileById(
      typeof body.profileId === 'string' ? body.profileId : undefined,
    );
    return {
      baseUrl: (typeof body.baseUrl === 'string' && body.baseUrl.trim()
        ? body.baseUrl.trim()
        : prof.baseUrl
      ).replace(/\/$/, ''),
      apiKey:
        typeof body.apiKey === 'string' && body.apiKey !== '' ? body.apiKey : prof.apiKey,
      model:
        typeof body.model === 'string' && body.model.trim() ? body.model.trim() : prof.model,
    };
  }

  app.post('/api/admin/llm-models', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as ProbeBody;
    const { baseUrl, apiKey } = await resolveProbeTarget(body);
    const t0 = Date.now();
    try {
      const res = await fetch(`${baseUrl}/models`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      const text = await res.text();
      if (!res.ok) {
        // Upstream status + body go back verbatim — a 401/404 must be seen.
        return c.json({ ok: false, upstreamStatus: res.status, message: text.slice(0, 2000) });
      }
      let ids: string[] = [];
      try {
        const data = JSON.parse(text) as {
          data?: { id?: unknown }[];
          models?: { id?: unknown }[];
        };
        const arr = Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data?.models)
            ? data.models
            : [];
        ids = arr
          .map((m) => (m && typeof m.id === 'string' ? m.id : ''))
          .filter((s) => s !== '');
      } catch {
        /* unparseable body → empty list */
      }
      return c.json({
        ok: true,
        baseUrl,
        models: [...new Set(ids)].sort(),
        latencyMs: Date.now() - t0,
      });
    } catch (err) {
      return c.json({ ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/admin/llm-test', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as ProbeBody;
    const { baseUrl, apiKey, model } = await resolveProbeTarget(body);
    if (!model) {
      return c.json(badRequest('需要 model（请求里给，或档案里已配置）'), 400);
    }
    const t0 = Date.now();
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
          max_tokens: 16,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();
      const latencyMs = Date.now() - t0;
      if (!res.ok) {
        return c.json({ ok: false, upstreamStatus: res.status, latencyMs, message: text.slice(0, 2000) });
      }
      let sample = '';
      try {
        const data = JSON.parse(text) as {
          choices?: { message?: { content?: string } }[];
        };
        sample = data.choices?.[0]?.message?.content ?? '';
      } catch {
        /* leave the sample empty — ok + latency still prove reachability */
      }
      return c.json({ ok: true, latencyMs, sample: sample.slice(0, 200) });
    } catch (err) {
      return c.json({
        ok: false,
        latencyMs: Date.now() - t0,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
