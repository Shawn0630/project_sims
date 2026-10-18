import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';
import {
  applyEditOps,
  checkStructure,
  runSuite,
  runTestCase,
  validateEditOps,
  type CaseMeasured,
} from '@sds/checker';
import { COMPONENTS, componentDef } from '@sds/components';
import {
  GENERATION_CRITERIA,
  type EditOp,
  type GeneratedCase,
  type GeneratedDesign,
  type GenerationContext,
  type ParsedGeneration,
} from '@sds/driver';
import type { ProblemDef, ProblemSchema, TestCase } from '@sds/problems';
import {
  SimulationEngine,
  defaultSettings,
  type Design,
  type DesignNode,
} from '@sds/sim-core';
import { buildSchemaSummary, generateProblemContent, GenerationLlmError } from './llm';
import type { ProblemStorage } from './storage';

/**
 * The fourth system — LLM problem generation (extension mode).
 *
 * POST /api/problems/generate asks the configured LLM for NEW test cases
 * for an EXISTING problem plus a complete reference solution (design +
 * schema). The model's output is a PROPOSAL: everything flows through
 * the validation pipeline below before it may touch the problem bank,
 * and nothing is merged until the author accepts the draft in admin:
 *
 *   1. case ids uniquified against the pack (deterministic renames);
 *   2. reference design assembled + semantically validated (component
 *      types, per-type legal settings — the edit-op validator is the
 *      authority), edges checked, nodes laid out;
 *   3. liveness: traffic from a client must actually reach downstream
 *      components (a degenerate design cannot "pass" vacuously);
 *   4. the reference must pass the problem's ENTIRE existing suite —
 *      otherwise the whole generation is rejected;
 *   5. each generated case is run against the reference (a case it fails
 *      is an 无效用例， excluded from acceptance) and against the pack's
 *      weak sampleDesign (a hidden case the weak design passes is
 *      flagged 弱区分度 for the author to judge);
 *   6. checkStructure screens the reference design (reported, not fatal).
 *
 * Drafts live in data/generations/<problemId>-<ts>.json (gitignored —
 * machine-local authoring state, like the LLM call log). Accepting a
 * draft merges its valid cases into the pack and stores the reference
 * solution as the pack's admin-only `referenceSolution` field, which
 * packs.ts strips from every solver-facing response. Accepted cases are
 * ordinary TestCases in the pack: judging, case-scenario serving and
 * case-fix linking treat them exactly like built-in cases.
 */

// ------------------------------------------------------------ draft types -

export interface GenerationCaseValidation {
  caseId: string;
  name: string;
  hidden: boolean;
  /** The reference design passed this generated case. */
  referencePassed: boolean;
  referenceFailures: string[];
  referenceMeasured: CaseMeasured;
  /** The pack's weak sample design's result (null when it has no nodes). */
  baselinePassed: boolean | null;
  baselineFailures: string[];
  /** Hidden case the weak sample design passes anyway. */
  weakDiscrimination: boolean;
  /** May be merged on accept (= the reference passes it). */
  acceptable: boolean;
  verdict: '有效' | '无效用例';
}

export interface GenerationReport {
  /** Reference vs the problem's pre-existing suite (null when the
   *  reference design was too broken to run at all). */
  referenceVsExistingSuite: {
    passedCount: number;
    totalCount: number;
    scorePct: number;
    failures: { caseId: string; name: string; failures: string[] }[];
  } | null;
  referenceSolvesExisting: boolean;
  livenessOk: boolean;
  cases: GenerationCaseValidation[];
  structuralFindings: {
    ruleId: string;
    severity: 'high' | 'medium' | 'low';
    title: string;
    detail: string;
    componentIds: string[];
  }[];
  highSeverityCount: number;
  validCaseCount: number;
}

export interface GenerationDraft {
  id: string;
  problemId: string;
  createdAt: string;
  /** The model/profile that produced this draft (from the call). */
  model: string;
  profileName: string;
  viaUserChoice: boolean;
  focus?: string;
  caseCountRequested: number;
  /** rejected = the reference failed the existing suite / was degenerate;
   *  such drafts are reviewable but can never be accepted. */
  status: 'pending' | 'rejected';
  rejectReason?: string;
  /** Case id renames applied for uniqueness (from = as proposed). */
  renames: { from: string; to: string }[];
  /** Normalization notes (dropped settings/edges/nodes…). */
  notes: string[];
  cases: TestCase[];
  referenceSolution: { design: Design; schema: ProblemSchema };
  report: GenerationReport;
}

// -------------------------------------------------------- context assembly -

const SETTINGS_KEYS_PROSE =
  '合法参数：通用 replicas（整数 1–16）/ capacityScale（0.25–4）；网关 rateLimitPerSec；缓存 mutexRebuild（布尔）/ eviction（LRU|LFU|TTL）；负载均衡 lbAlgorithm（round_robin|least_connections|consistent_hashing）；关系型 DB 与 NoSQL 的 sharded（布尔）/ shardKey（字符串）/ readReplicas（整数 0–8）/ consistency（eventual|strong）。client 无可调参数。';

export function buildGenerationContext(
  problem: ProblemDef,
  opts: { caseCount: number; focus?: string },
): GenerationContext {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const scaleSummary =
    `${problem.scale.dau}；基线 ${problem.scale.baselineRps} RPS；峰值 ×${problem.scale.peakMultiplier}；` +
    `读占比 ${pct(problem.scale.readRatio)}；成本预算 $${problem.scale.budgetCostPerHour}/h；备注：${problem.scale.notes}`;
  const workloadSummary =
    `读占比 ${pct(problem.workload.readRatio)}；一致性要求：${problem.workload.consistency}\n` +
    problem.workload.patterns
      .map(
        (p) =>
          `- ${p.name}（${p.kind === 'read' ? '读' : '写'}，占 ${pct(p.share)}）：${p.description} 路径 ${p.path.join(' → ')}${p.table ? `，落表 ${p.table}` : ''}${p.terminalPerSec ? `，终端约 ${p.terminalPerSec}/s` : ''}`,
      )
      .join('\n');
  const componentCatalog =
    COMPONENTS.map(
      (def) =>
        `- ${def.type}（${def.name}，${def.behavior}）：单副本容量 ${def.defaultCapacityPerReplica} req/s · 基础延迟 ${def.baseLatencyMs}ms · 成本 $${def.costPerReplicaPerHour}/h` +
        (def.baseHitRate !== undefined ? ` · 基础命中率 ${pct(def.baseHitRate)}` : '') +
        (def.bufferSize !== undefined ? ` · 队列缓冲 ${def.bufferSize}` : ''),
    ).join('\n') + `\n${SETTINGS_KEYS_PROSE}`;
  const schemaSummary =
    buildSchemaSummary(problem.schema) +
    (problem.schema.accessPatterns.length
      ? `\n访问模式：\n${problem.schema.accessPatterns
          .map(
            (p) =>
              `- ${p.name}（${p.kind}，表 ${p.table}，按 ${p.byField}${p.needsSort ? '，需排序' : ''}，约 ${p.perSec}/s）`,
          )
          .join('\n')}`
      : '');
  return {
    problemName: problem.name,
    statement: problem.statement,
    functionalRequirements: problem.functionalRequirements,
    scaleSummary,
    workloadSummary,
    criteria: GENERATION_CRITERIA,
    existingCases: problem.testCases.map((tc) => ({
      name: tc.name,
      description: tc.description,
      hidden: tc.hidden,
    })),
    componentCatalog,
    schemaSummary,
    caseCount: opts.caseCount,
    ...(opts.focus ? { focus: opts.focus } : {}),
    baselineRps: problem.scale.baselineRps,
    defaultReadRatio: problem.scale.readRatio,
  };
}

// ------------------------------------------------------------- case id duty -

const SAFE_CASE_ID = /^[a-z0-9][a-z0-9-]*$/;

function slugifyId(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'case';
}

/**
 * Give every item an id that is unique against `taken` (and the batch
 * itself), renaming deterministically: a valid free id is kept; a missing/
 * invalid one becomes gen-<slug-of-name>; a collision gets -2, -3, …
 */
export function uniquifyIds<T extends { id: string; name: string }>(
  taken: Set<string>,
  items: readonly T[],
): { items: T[]; renames: { from: string; to: string }[] } {
  const used = new Set(taken);
  const renames: { from: string; to: string }[] = [];
  const out = items.map((item) => {
    const raw = item.id?.trim() ?? '';
    let candidate = SAFE_CASE_ID.test(raw) ? raw : `gen-${slugifyId(item.name)}`;
    if (used.has(candidate)) {
      let n = 2;
      while (used.has(`${candidate}-${n}`)) n += 1;
      candidate = `${candidate}-${n}`;
    }
    used.add(candidate);
    if (candidate !== raw) renames.push({ from: raw || '（无 id）', to: candidate });
    return candidate === item.id ? item : { ...item, id: candidate };
  });
  return { items: out, renames };
}

// ------------------------------------------------- reference design duty -

interface AssembledDesign {
  design: Design;
  notes: string[];
  /** Set when the design is too broken to be a reference at all. */
  fatal?: string;
}

/**
 * Turn the model's loose design into a real Design: node ids deduplicated,
 * settings semantically validated per node (the edit-op validator is the
 * authority — provided settings become setSetting ops against a defaults
 * design, chunked under its per-call op cap), invalid edges dropped, and
 * positions laid out in BFS layers from the traffic sources.
 */
export function assembleReferenceDesign(gen: GeneratedDesign): AssembledDesign {
  const notes: string[] = [];
  const seen = new Set<string>();
  const nodes: DesignNode[] = [];
  const survivingGen: GeneratedDesign['nodes'] = [];
  for (const n of gen.nodes) {
    if (seen.has(n.id)) {
      notes.push(`参考解节点 id 重复，已丢弃后出现的「${n.id}」`);
      continue;
    }
    seen.add(n.id);
    survivingGen.push(n);
    nodes.push({ id: n.id, type: n.type, x: 0, y: 0, settings: defaultSettings(n.type) });
  }
  const base: Design = { nodes, edges: [] };

  // Settings: validate each node's bag via setSetting ops (chunked to the
  // validator's MAX_EDIT_OPS per call — the ops are independent, so
  // chunking does not change the outcome).
  const validOps: EditOp[] = [];
  let providedSettings = 0;
  for (const n of survivingGen) {
    const entries = Object.entries(n.settings);
    providedSettings += entries.length;
    const ops: EditOp[] = entries.map(([key, value]) => ({
      op: 'setSetting',
      nodeId: n.id,
      key,
      value,
    }));
    for (let i = 0; i < ops.length; i += 3) {
      validOps.push(...validateEditOps(ops.slice(i, i + 3), base));
    }
  }
  if (providedSettings > validOps.length) {
    notes.push(
      `参考解有 ${providedSettings - validOps.length} 项参数不合法（类型不对/超出范围/该组件无此参数），已丢弃`,
    );
  }
  let design = applyEditOps(base, validOps);

  // Edges: both endpoints must survive, no self loops, no duplicates.
  const nodeIds = new Set(design.nodes.map((n) => n.id));
  const edgeKeys = new Set<string>();
  const edges: Design['edges'] = [];
  let droppedEdges = 0;
  for (const e of gen.edges) {
    const key = `${e.from}->${e.to}`;
    if (!nodeIds.has(e.from) || !nodeIds.has(e.to) || e.from === e.to || edgeKeys.has(key)) {
      droppedEdges += 1;
      continue;
    }
    edgeKeys.add(key);
    edges.push({ id: key, from: e.from, to: e.to });
  }
  if (droppedEdges) notes.push(`参考解有 ${droppedEdges} 条连线无效（端点不存在/自环/重复），已丢弃`);
  design = { nodes: design.nodes, edges };

  // Layout: BFS layers (longest path) from the traffic sources.
  const depth = new Map<string, number>();
  for (const n of design.nodes) {
    depth.set(n.id, componentDef(n.type).behavior === 'source' ? 0 : -1);
  }
  for (let iter = 0; iter < design.nodes.length; iter += 1) {
    for (const e of design.edges) {
      const du = depth.get(e.from)!;
      if (du >= 0 && depth.get(e.to)! < du + 1) depth.set(e.to, du + 1);
    }
  }
  let maxDepth = 0;
  for (const d of depth.values()) maxDepth = Math.max(maxDepth, d);
  for (const [id, d] of depth) if (d < 0) depth.set(id, maxDepth + 1);
  const layers = new Map<number, DesignNode[]>();
  for (const n of design.nodes) {
    const d = depth.get(n.id)!;
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d)!.push(n);
  }
  for (const [d, layer] of layers) {
    layer.forEach((n, i) => {
      n.x = 90 + d * 175;
      n.y = 80 + i * 105;
    });
  }

  const sources = design.nodes.filter((n) => componentDef(n.type).behavior === 'source');
  let fatal: string | undefined;
  if (design.nodes.length < 2) fatal = '参考解节点不足 2 个，构不成一个系统';
  else if (!sources.length) fatal = '参考解没有任何流量入口（client）节点';
  else if (!design.edges.length) fatal = '参考解没有任何连线';
  return { design, notes, ...(fatal ? { fatal } : {}) };
}

/**
 * A design only counts as a reference if traffic actually flows: run the
 * baseline traffic briefly and require some non-source node to receive
 * requests. (A lone client would otherwise "pass" every threshold
 * vacuously — nothing ever errors because nothing ever happens.)
 */
export function designLiveness(problem: ProblemDef, design: Design): boolean {
  const traffic = problem.testCases[0]?.traffic ?? {
    rps: problem.scale.baselineRps,
    readRatio: problem.scale.readRatio,
  };
  const engine = new SimulationEngine(design, traffic);
  for (let i = 0; i < 5; i += 1) {
    const snap = engine.step(1);
    for (const n of design.nodes) {
      if (componentDef(n.type).behavior !== 'source' && (snap.nodes[n.id]?.inQps ?? 0) > 0) {
        return true;
      }
    }
  }
  return false;
}

// ------------------------------------------------------- validation duty -

function toTestCase(gc: GeneratedCase): TestCase {
  return {
    id: gc.id,
    name: gc.name,
    description: gc.description,
    hidden: gc.hidden,
    weight: gc.weight,
    traffic: gc.traffic,
    durationTicks: gc.durationTicks,
    ...(gc.events.length ? { events: gc.events } : {}),
    ...(gc.kills.length ? { kills: gc.kills } : {}),
    thresholds: gc.thresholds,
    ...(gc.hint ? { hint: gc.hint } : {}),
    ...(gc.exposesRule ? { exposesRule: gc.exposesRule } : {}),
  };
}

/**
 * The arbiter. Runs a parsed generation against the problem and returns
 * the complete draft (normalized cases + assembled reference + the full
 * validation report). Nothing here trusts the model: see the header.
 */
export function validateGeneration(
  problem: ProblemDef,
  parsed: ParsedGeneration,
  meta: {
    id: string;
    createdAt: string;
    model: string;
    profileName: string;
    viaUserChoice: boolean;
    focus?: string;
    caseCountRequested: number;
  },
): GenerationDraft {
  const notes: string[] = [];

  // 1. Case ids: unique vs the pack and within the batch.
  const { items: idCases, renames } = uniquifyIds(
    new Set(problem.testCases.map((tc) => tc.id)),
    parsed.cases,
  );
  const cases = idCases.map(toTestCase);

  // 2. Reference design assembly + schema (parse already shape-checked).
  const assembled = assembleReferenceDesign(parsed.referenceSolution.design);
  notes.push(...assembled.notes);
  const design = assembled.design;
  const schema = parsed.referenceSolution.schema as unknown as ProblemSchema;
  const referenceSolution = { design, schema };

  const base = {
    id: meta.id,
    problemId: problem.id,
    createdAt: meta.createdAt,
    model: meta.model,
    profileName: meta.profileName,
    viaUserChoice: meta.viaUserChoice,
    ...(meta.focus ? { focus: meta.focus } : {}),
    caseCountRequested: meta.caseCountRequested,
    renames,
    notes,
    cases,
    referenceSolution,
  };

  if (assembled.fatal) {
    return {
      ...base,
      status: 'rejected',
      rejectReason: assembled.fatal,
      report: {
        referenceVsExistingSuite: null,
        referenceSolvesExisting: false,
        livenessOk: false,
        cases: [],
        structuralFindings: [],
        highSeverityCount: 0,
        validCaseCount: 0,
      },
    };
  }

  // 3. Liveness — no flow, no reference.
  const livenessOk = designLiveness(problem, design);

  // 4. Reference vs the ENTIRE existing suite.
  const suite = runSuite(problem, design);
  const referenceSolvesExisting = suite.passedCount === suite.totalCount;
  const referenceVsExistingSuite = {
    passedCount: suite.passedCount,
    totalCount: suite.totalCount,
    scorePct: suite.scorePct,
    failures: suite.results
      .filter((r) => !r.passed)
      .map((r) => ({ caseId: r.caseId, name: r.name, failures: r.failures })),
  };

  // 5. Per generated case: reference verdict + discrimination check.
  const hasBaseline = problem.sampleDesign.nodes.length > 0;
  const caseReports: GenerationCaseValidation[] = cases.map((tc) => {
    const ref = runTestCase(problem, design, tc);
    const baseline = hasBaseline ? runTestCase(problem, problem.sampleDesign, tc) : null;
    const weakDiscrimination = tc.hidden && baseline?.passed === true;
    return {
      caseId: tc.id,
      name: tc.name,
      hidden: tc.hidden,
      referencePassed: ref.passed,
      referenceFailures: ref.failures,
      referenceMeasured: ref.measured,
      baselinePassed: baseline ? baseline.passed : null,
      baselineFailures: baseline ? baseline.failures : [],
      weakDiscrimination,
      acceptable: ref.passed,
      verdict: ref.passed ? ('有效' as const) : ('无效用例' as const),
    };
  });

  // 6. Structural screen of the reference design (reported, not fatal).
  const structuralFindings = checkStructure(problem, design).map((f) => ({
    ruleId: f.ruleId,
    severity: f.severity,
    title: f.title,
    detail: f.detail,
    componentIds: f.componentIds,
  }));

  const rejected = !livenessOk || !referenceSolvesExisting;
  return {
    ...base,
    status: rejected ? 'rejected' : 'pending',
    ...(rejected
      ? {
          rejectReason: !livenessOk
            ? '参考解没有形成可达的流量路径：客户端的流量到不了任何下游组件，这样的"解"通过阈值也没有意义'
            : `参考解未通过现有套件（${suite.passedCount}/${suite.totalCount}），整份生成驳回——参考解必须先能解决已有题目`,
        }
      : {}),
    report: {
      referenceVsExistingSuite,
      referenceSolvesExisting,
      livenessOk,
      cases: caseReports,
      structuralFindings,
      highSeverityCount: structuralFindings.filter((f) => f.severity === 'high').length,
      validCaseCount: caseReports.filter((v) => v.acceptable).length,
    },
  };
}

// ------------------------------------------------------------ draft storage -

export const GENERATIONS_DIR = fileURLToPath(new URL('../data/generations/', import.meta.url));

const SAFE_DRAFT_ID = /^[a-z0-9][a-z0-9-]*$/;

export async function saveGenerationDraft(draft: GenerationDraft): Promise<void> {
  await mkdir(GENERATIONS_DIR, { recursive: true });
  await writeFile(
    path.join(GENERATIONS_DIR, `${draft.id}.json`),
    `${JSON.stringify(draft, null, 2)}\n`,
    'utf8',
  );
}

export async function getGenerationDraft(id: string): Promise<GenerationDraft | null> {
  if (!SAFE_DRAFT_ID.test(id)) return null;
  try {
    const raw = await readFile(path.join(GENERATIONS_DIR, `${id}.json`), 'utf8');
    return JSON.parse(raw) as GenerationDraft;
  } catch {
    return null;
  }
}

export async function listGenerationDrafts(problemId?: string): Promise<GenerationDraft[]> {
  let files: string[];
  try {
    files = (await readdir(GENERATIONS_DIR)).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const out: GenerationDraft[] = [];
  for (const f of files) {
    try {
      const draft = JSON.parse(await readFile(path.join(GENERATIONS_DIR, f), 'utf8')) as GenerationDraft;
      if (!problemId || draft.problemId === problemId) out.push(draft);
    } catch {
      /* skip a torn draft file */
    }
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function deleteGenerationDraft(id: string): Promise<boolean> {
  if (!SAFE_DRAFT_ID.test(id)) return false;
  try {
    await unlink(path.join(GENERATIONS_DIR, `${id}.json`));
    return true;
  } catch {
    return false;
  }
}

export interface GenerationDraftSummary {
  id: string;
  problemId: string;
  createdAt: string;
  model: string;
  profileName: string;
  status: GenerationDraft['status'];
  rejectReason?: string;
  focus?: string;
  caseCount: number;
  validCaseCount: number;
  weakCount: number;
  referenceSolvesExisting: boolean;
  highSeverityCount: number;
}

export function summarizeDraft(draft: GenerationDraft): GenerationDraftSummary {
  return {
    id: draft.id,
    problemId: draft.problemId,
    createdAt: draft.createdAt,
    model: draft.model,
    profileName: draft.profileName,
    status: draft.status,
    ...(draft.rejectReason ? { rejectReason: draft.rejectReason } : {}),
    ...(draft.focus ? { focus: draft.focus } : {}),
    caseCount: draft.cases.length,
    validCaseCount: draft.report.validCaseCount,
    weakCount: draft.report.cases.filter((v) => v.weakDiscrimination).length,
    referenceSolvesExisting: draft.report.referenceSolvesExisting,
    highSeverityCount: draft.report.highSeverityCount,
  };
}

// ------------------------------------------------------------------- routes -

const badRequest = (message: string) => ({ error: 'bad_request', message }) as const;

export function registerGenerationRoutes(app: Hono, storage: ProblemStorage): void {
  // ------------------------------------------------------------ generate -
  app.post('/api/problems/generate', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      problemId?: unknown;
      caseCount?: unknown;
      focus?: unknown;
      profileId?: unknown;
    } | null;
    if (!body || typeof body.problemId !== 'string' || !body.problemId) {
      return c.json(badRequest('需要 { problemId: string, caseCount?: number, focus?: string }'), 400);
    }
    const problem = await storage.getProblem(body.problemId);
    if (!problem) return c.json({ error: 'problem_not_found' }, 404);
    const caseCount =
      typeof body.caseCount === 'number' && Number.isFinite(body.caseCount)
        ? Math.min(8, Math.max(1, Math.round(body.caseCount)))
        : 4;
    const focus =
      typeof body.focus === 'string' && body.focus.trim()
        ? body.focus.trim().slice(0, 200)
        : undefined;
    const profileId = typeof body.profileId === 'string' ? body.profileId : undefined;

    const ctx = buildGenerationContext(problem, { caseCount, ...(focus ? { focus } : {}) });
    let outcome;
    try {
      outcome = await generateProblemContent(ctx, profileId);
    } catch (err) {
      if (err instanceof GenerationLlmError) {
        // llm_required = nothing is configured (503: the service cannot
        // fulfil this without a model); call/output failures are upstream
        // problems (502). Either way: honest error, no fabricated draft.
        return c.json(
          { error: err.code, message: err.message },
          err.code === 'llm_required' ? 503 : 502,
        );
      }
      return c.json(
        { error: 'generate_failed', message: err instanceof Error ? err.message : String(err) },
        500,
      );
    }

    const draft = validateGeneration(problem, outcome.data, {
      id: `${problem.id}-${Date.now().toString(36)}`,
      createdAt: new Date().toISOString(),
      model: outcome.model,
      profileName: outcome.profileName,
      viaUserChoice: outcome.viaUserChoice,
      ...(focus ? { focus } : {}),
      caseCountRequested: caseCount,
    });
    await saveGenerationDraft(draft);
    return c.json({ ok: true, draft }, 201);
  });

  // --------------------------------------------------------- draft review -
  app.get('/api/admin/generations', async (c) => {
    const problemId = c.req.query('problemId');
    const drafts = await listGenerationDrafts(problemId || undefined);
    return c.json(drafts.map(summarizeDraft));
  });

  app.get('/api/admin/generations/:id', async (c) => {
    const draft = await getGenerationDraft(c.req.param('id'));
    if (!draft) return c.json({ error: 'generation_not_found' }, 404);
    return c.json(draft);
  });

  app.delete('/api/admin/generations/:id', async (c) => {
    const existed = await deleteGenerationDraft(c.req.param('id'));
    if (!existed) return c.json({ error: 'generation_not_found' }, 404);
    return c.json({ ok: true, id: c.req.param('id') });
  });

  // Accept: merge the draft's VALID generated cases into the pack and
  // store its reference solution as the pack's admin-only field. The
  // reference is re-run against the CURRENT pack first — the pack may
  // have changed since generation, and a stale reference must not land.
  app.post('/api/admin/generations/:id/accept', async (c) => {
    const draft = await getGenerationDraft(c.req.param('id'));
    if (!draft) return c.json({ error: 'generation_not_found' }, 404);
    if (draft.status === 'rejected') {
      return c.json(
        { error: 'generation_rejected', message: draft.rejectReason ?? '这份生成已被驳回，不能采纳' },
        409,
      );
    }
    const validIds = new Set(
      draft.report.cases.filter((v) => v.acceptable).map((v) => v.caseId),
    );
    const validCases = draft.cases.filter((tc) => validIds.has(tc.id));
    const skippedCaseIds = draft.cases.filter((tc) => !validIds.has(tc.id)).map((tc) => tc.id);
    if (!validCases.length) {
      return c.json(
        { error: 'no_valid_cases', message: '这份生成里没有通过参考解验证的有效用例，无可采纳' },
        409,
      );
    }
    const pack = await storage.getProblem(draft.problemId);
    if (!pack) return c.json({ error: 'problem_not_found' }, 404);
    const recheck = runSuite(pack, draft.referenceSolution.design);
    if (recheck.passedCount !== recheck.totalCount) {
      return c.json(
        {
          error: 'reference_stale',
          message: `题包在生成后已变化，参考解现在只能通过现有套件 ${recheck.passedCount}/${recheck.totalCount}，不能采纳`,
          failures: recheck.results
            .filter((r) => !r.passed)
            .map((r) => ({ caseId: r.caseId, name: r.name, failures: r.failures })),
        },
        409,
      );
    }
    const { items: acceptedCases, renames } = uniquifyIds(
      new Set(pack.testCases.map((tc) => tc.id)),
      validCases,
    );
    const merged: ProblemDef = {
      ...pack,
      testCases: [...pack.testCases, ...acceptedCases],
      referenceSolution: draft.referenceSolution,
    };
    await storage.saveProblem(merged);
    await deleteGenerationDraft(draft.id);
    return c.json({
      ok: true,
      problemId: pack.id,
      addedCaseIds: acceptedCases.map((tc) => tc.id),
      skippedCaseIds,
      renamedCases: renames,
      referenceStored: true,
    });
  });
}
