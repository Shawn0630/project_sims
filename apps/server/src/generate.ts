import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';
import {
  applyEditOps,
  checkStructure,
  judgeSchemaCases,
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
  type GeneratedSchema,
  type GeneratedSchemaCase,
  type GenerationContext,
  type ParsedGeneration,
  type ParsedWholeProblem,
  type WholeProblemContext,
} from '@sds/driver';
import type {
  ProblemDef,
  ProblemSchema,
  SchemaTestCase,
  TestCase,
  WorkloadPattern,
} from '@sds/problems';
import {
  SimulationEngine,
  defaultSettings,
  type Design,
  type DesignNode,
} from '@sds/sim-core';
import {
  buildSchemaSummary,
  generateProblemContent,
  generateWholeProblemContent,
  GenerationLlmError,
} from './llm';
import { capSourceText, fetchSourceText, SourceFetchError } from './sourcefetch';
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
 *   7. schema cases ride the same discipline on the database side: the
 *      reference schema must pass each generated schema case (failures
 *      are 无效用例）, the pack's starter schema is the discrimination
 *      baseline, and accept re-verifies the reference schema against the
 *      ENTIRE merged schema suite before writing.
 *
 * Drafts live in data/generations/<problemId>-<ts>.json (gitignored —
 * machine-local authoring state, like the LLM call log). Accepting a
 * draft merges its valid cases (architecture + schema) into the pack and
 * stores the reference solution as the pack's admin-only
 * `referenceSolution` field, which packs.ts strips from every
 * solver-facing response. Accepted cases are ordinary TestCases /
 * SchemaTestCases in the pack: judging, case-scenario serving and
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

/** One generated SCHEMA case's validation record — the schema-side
 *  mirror of GenerationCaseValidation, judged by the schema simulator. */
export interface SchemaCaseValidation {
  caseId: string;
  name: string;
  hidden: boolean;
  /** The reference schema passed this generated schema case. */
  referencePassed: boolean;
  referenceFailures: string[];
  /** The starter schema's verdict — the discrimination baseline. */
  starterPassed: boolean;
  starterFailures: string[];
  /** Hidden schema case the starter schema passes anyway. */
  weakDiscrimination: boolean;
  /** May be merged on accept (= the reference schema passes it). */
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
  /** Generated schema cases, judged against the reference schema
   *  (pass = acceptable) and the starter schema (discrimination). */
  schemaCases: SchemaCaseValidation[];
  validSchemaCaseCount: number;
  /** Reference schema vs the pack's PRE-EXISTING schema cases — the
   *  accept gate re-runs exactly this against the merged pack. */
  referenceVsExistingSchemaCases: {
    passedCount: number;
    totalCount: number;
    failures: { caseId: string; name: string; failures: string[] }[];
  } | null;
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

/** GeneratedSchemaCase → the pack shape (structurally identical). */
export function toSchemaTestCase(gc: GeneratedSchemaCase): SchemaTestCase {
  return {
    id: gc.id,
    name: gc.name,
    description: gc.description,
    hidden: gc.hidden,
    weight: gc.weight,
    scale: gc.scale,
    assertion: gc.assertion as SchemaTestCase['assertion'],
  };
}

/**
 * Judge generated schema cases the way the whole pipeline judges
 * everything: by running the arbiter. The reference schema must pass a
 * case for it to be acceptable; the starter schema's result is the
 * discrimination baseline (a hidden case it passes is 弱区分度）.
 */
export function validateGeneratedSchemaCases(
  problem: ProblemDef,
  schemaCases: SchemaTestCase[],
  referenceSchema: ProblemSchema,
  starterSchema: ProblemSchema,
): SchemaCaseValidation[] {
  return schemaCases.map((tc) => {
    const probe = { ...problem, schemaTestCases: [tc] };
    const ref = judgeSchemaCases(probe, referenceSchema).results[0]!;
    const starter = judgeSchemaCases(probe, starterSchema).results[0]!;
    return {
      caseId: tc.id,
      name: tc.name,
      hidden: tc.hidden,
      referencePassed: ref.passed,
      referenceFailures: ref.failures,
      starterPassed: starter.passed,
      starterFailures: starter.failures,
      weakDiscrimination: tc.hidden && starter.passed,
      acceptable: ref.passed,
      verdict: ref.passed ? ('有效' as const) : ('无效用例' as const),
    };
  });
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
  /** Generated schema test cases (accept merges the acceptable ones). */
  schemaCases: SchemaTestCase[];
  referenceSolution: { design: Design; schema: ProblemSchema };
  report: GenerationReport;
}

// -------------------------------------------------------- context assembly -

const SETTINGS_KEYS_PROSE =
  '合法参数：通用 replicas（整数 1–16）/ capacityScale（0.25–4）；网关 rateLimitPerSec；缓存 mutexRebuild（布尔）/ eviction（LRU|LFU|TTL）；负载均衡 lbAlgorithm（round_robin|least_connections|consistent_hashing）；关系型 DB 与 NoSQL 的 sharded（布尔）/ shardKey（字符串）/ readReplicas（整数 0–8）/ consistency（eventual|strong）。client 无可调参数。';

/** The component catalog text both generation modes hand to the model. */
export function componentCatalogText(): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return (
    COMPONENTS.map(
      (def) =>
        `- ${def.type}（${def.name}，${def.behavior}）：单副本容量 ${def.defaultCapacityPerReplica} req/s · 基础延迟 ${def.baseLatencyMs}ms · 成本 $${def.costPerReplicaPerHour}/h` +
        (def.baseHitRate !== undefined ? ` · 基础命中率 ${pct(def.baseHitRate)}` : '') +
        (def.bufferSize !== undefined ? ` · 队列缓冲 ${def.bufferSize}` : ''),
    ).join('\n') + `\n${SETTINGS_KEYS_PROSE}`
  );
}

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
  const componentCatalog = componentCatalogText();
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

  // 1b. Schema case ids: unique vs the pack's schema cases and the batch.
  const { items: idSchemaCases, renames: schemaRenames } = uniquifyIds(
    new Set((problem.schemaTestCases ?? []).map((tc) => tc.id)),
    parsed.schemaCases,
  );
  const schemaCases = idSchemaCases.map(toSchemaTestCase);
  for (const r of schemaRenames) {
    notes.push(`数据库用例 id「${r.from}」与已有用例冲突，已改名为「${r.to}」`);
  }
  if (!parsed.schemaCases.length) {
    notes.push('本次生成没有产出数据库用例（schemaCases 为空）——采纳时不会新增数据库用例');
  }

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
    schemaCases,
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
        schemaCases: [],
        validSchemaCaseCount: 0,
        referenceVsExistingSchemaCases: null,
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

  // 7. Schema cases: the reference schema must pass each generated one;
  //    the pack's starter schema is the discrimination baseline. The
  //    reference schema is ALSO run against the pack's pre-existing
  //    schema cases (reported here; the accept gate enforces it).
  const schemaCaseReports = validateGeneratedSchemaCases(
    problem,
    schemaCases,
    schema,
    problem.schema,
  );
  const existingSchemaSuite = (problem.schemaTestCases ?? []).length
    ? judgeSchemaCases(problem, schema)
    : null;
  const referenceVsExistingSchemaCases = existingSchemaSuite
    ? {
        passedCount: existingSchemaSuite.passedCount,
        totalCount: existingSchemaSuite.totalCount,
        failures: existingSchemaSuite.results
          .filter((r) => !r.passed)
          .map((r) => ({ caseId: r.caseId, name: r.name, failures: r.failures })),
      }
    : null;

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
      schemaCases: schemaCaseReports,
      validSchemaCaseCount: schemaCaseReports.filter((v) => v.acceptable).length,
      referenceVsExistingSchemaCases,
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
    const parsed = JSON.parse(raw) as GenerationDraft & { kind?: string };
    // Whole-problem drafts share this directory but are a different shape;
    // they are served by getWholeProblemDraft below, never as extensions.
    if (parsed.kind === 'new-problem') return null;
    return parsed;
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
      const draft = JSON.parse(
        await readFile(path.join(GENERATIONS_DIR, f), 'utf8'),
      ) as GenerationDraft & { kind?: string };
      if (draft.kind === 'new-problem') continue; // whole-problem drafts live elsewhere logically
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
  kind: 'extension';
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
  schemaCaseCount: number;
  validSchemaCaseCount: number;
}

export function summarizeDraft(draft: GenerationDraft): GenerationDraftSummary {
  return {
    kind: 'extension',
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
    schemaCaseCount: draft.schemaCases.length,
    validSchemaCaseCount: draft.report.validSchemaCaseCount,
  };
}

// ============================================================ whole problem =
/**
 * Whole-problem generation — the "新建题目" pipeline.
 *
 * The author supplies a source (URL fetched server-side, pasted text, or
 * an uploaded .md/.txt); the LLM authors an ENTIRE problem from it
 * (parseWholeProblem in the driver contract), and validateWholeProblem
 * below holds the output to whole-problem standards before it becomes a
 * review draft (kind 'new-problem' in the same generations directory):
 *
 *   1. shape: the assembled pack must pass validateProblemDefShape — the
 *      SAME structural validation every stored pack is held to (and the
 *      gate accept re-runs before writing);
 *   2. the reference design is assembled/validated exactly like the
 *      extension mode's (settings via the edit-op validator, edges,
 *      layout, liveness);
 *   3. the reference must pass its OWN generated cases: a case it fails
 *      is 无效用例 (excluded on accept); a reference passing ≤ half of
 *      its own cases — or failing / lacking a visible baseline case —
 *      rejects the whole draft;
 *   4. discrimination: the generated sampleDesign (deliberately naive)
 *      runs the hidden cases — any it passes is flagged 弱区分度; a
 *      sample that fails EVERY visible baseline case earns a warning
 *      (a starting design that cannot do anything is bad teaching);
 *   5. a proposed id colliding with the existing bank is FLAGGED on the
 *      draft; accept returns 409 until the admin renames it.
 *   6. schema cases mirror the architecture side: the reference schema
 *      must pass every generated schema case (failures excluded on
 *      accept), the starter schema should fail at least one hidden one
 *      (else 弱区分度 warnings), and accept requires at least one valid
 *      schema case and re-verifies the reference schema against the
 *      shipped schema suite.
 *
 * Accepting writes data/problems/<id>.json (only the valid cases ship);
 * the reference solution rides along as the pack's admin-only field and
 * packs.ts strips it from every solver-facing response, as always.
 */

export interface WholeProblemReport {
  livenessOk: boolean;
  referencePassedCount: number;
  referenceTotalCount: number;
  /** 0..1 — the draft is rejected at ≤ 0.5. */
  referencePassRate: number;
  /** A visible, event-free steady case exists among the generated cases. */
  baselineCasePresent: boolean;
  baselineCasePassedByReference: boolean;
  cases: GenerationCaseValidation[];
  /** How the naive sampleDesign did on the visible baseline cases. */
  sampleBaselinePassedCount: number;
  sampleBaselineTotalCount: number;
  sampleAllBaselineFailed: boolean;
  /** Generated schema cases: reference-schema verdicts + starter
   *  discrimination, the database mirror of `cases`. */
  schemaCases: SchemaCaseValidation[];
  validSchemaCaseCount: number;
  /** The starter schema fails at least one HIDDEN schema case. */
  schemaDiscriminationOk: boolean;
  warnings: string[];
  structuralFindings: GenerationReport['structuralFindings'];
  highSeverityCount: number;
  validCaseCount: number;
}

export interface WholeProblemDraft {
  kind: 'new-problem';
  id: string;
  createdAt: string;
  model: string;
  profileName: string;
  viaUserChoice: boolean;
  source: {
    type: 'url' | 'text' | 'file';
    label: string;
    /** Character count of the (possibly truncated) source the model read. */
    chars: number;
    truncated: boolean;
  };
  titleHint?: string;
  status: 'pending' | 'rejected';
  rejectReason?: string;
  /** The proposed problem id already exists in the bank. */
  idConflict: boolean;
  notes: string[];
  /** The complete assembled pack (referenceSolution included, admin-only). */
  problem: ProblemDef;
  report: WholeProblemReport;
}

// ------------------------------------------------------- pack shape duty -

const COMPONENT_TYPE_ID_SET: ReadonlySet<string> = new Set(COMPONENTS.map((d) => d.type));
const EVENT_TYPE_SET: ReadonlySet<string> = new Set([
  'viral_post',
  'cache_stampede',
  'hot_key',
  'peak',
  'rw_flip',
]);
const PK_GEN_SET: ReadonlySet<string> = new Set(['auto', 'snowflake', 'uuid', 'business']);
const DIFFICULTY_SET: ReadonlySet<string> = new Set(['简单', '中等', '困难']);

/** Structural checks for one schema (tables + access patterns). */
function schemaShapeErrors(schema: ProblemSchema | undefined, label: string): string[] {
  const errs: string[] = [];
  if (!schema || !Array.isArray(schema.tables) || !schema.tables.length) {
    return [`${label}：至少需要一张表`];
  }
  const tableNames = new Set<string>();
  for (const t of schema.tables) {
    if (!t || typeof t.name !== 'string' || !t.name.trim()) {
      errs.push(`${label}：有表缺名字`);
      continue;
    }
    if (tableNames.has(t.name)) errs.push(`${label}：表名重复「${t.name}」`);
    tableNames.add(t.name);
    if (t.engine !== 'relational' && t.engine !== 'nosql') {
      errs.push(`${label}：表 ${t.name} 的 engine 不合法（${String(t.engine)}）`);
    }
    if (!Number.isFinite(t.rows) || t.rows <= 0) errs.push(`${label}：表 ${t.name} 的 rows 不合法`);
    if (!Array.isArray(t.fields) || !t.fields.length) {
      errs.push(`${label}：表 ${t.name} 没有字段`);
      continue;
    }
    const fieldNames = new Set(t.fields.map((f) => f?.name));
    if (!fieldNames.has(t.primaryKey)) {
      errs.push(`${label}：表 ${t.name} 的主键 ${String(t.primaryKey)} 不在其字段中`);
    }
    if (!PK_GEN_SET.has(t.primaryKeyGen)) {
      errs.push(`${label}：表 ${t.name} 的主键生成方式不合法（${String(t.primaryKeyGen)}）`);
    }
    if (t.shardKey !== null && t.shardKey !== undefined && !fieldNames.has(t.shardKey)) {
      errs.push(`${label}：表 ${t.name} 的分片键 ${String(t.shardKey)} 不是其字段`);
    }
  }
  for (const p of schema.accessPatterns ?? []) {
    const t = schema.tables.find((x) => x.name === p?.table);
    if (!t) {
      errs.push(`${label}：访问模式「${p?.name}」引用了不存在的表 ${String(p?.table)}`);
      continue;
    }
    if (!t.fields.some((f) => f.name === p.byField)) {
      errs.push(`${label}：访问模式「${p.name}」的字段 ${String(p.byField)} 不在表 ${t.name} 中`);
    }
    if (p.kind !== 'read' && p.kind !== 'write' && p.kind !== 'count') {
      errs.push(`${label}：访问模式「${p.name}」的 kind 不合法`);
    }
  }
  return errs;
}

function designShapeErrors(design: Design | undefined, label: string): string[] {
  const errs: string[] = [];
  if (!design || !Array.isArray(design.nodes) || !design.nodes.length) {
    return [`${label}：至少需要一个节点`];
  }
  const ids = new Set<string>();
  for (const n of design.nodes) {
    if (!COMPONENT_TYPE_ID_SET.has(n.type)) errs.push(`${label}：节点 ${n.id} 的类型不合法（${String(n.type)}）`);
    if (ids.has(n.id)) errs.push(`${label}：节点 id 重复「${n.id}」`);
    ids.add(n.id);
  }
  for (const e of design.edges ?? []) {
    if (!ids.has(e.from) || !ids.has(e.to)) {
      errs.push(`${label}：连线 ${e.from}→${e.to} 的端点不存在`);
    }
  }
  return errs;
}

/**
 * The pack shape gate — the same structural validation a stored pack is
 * held to (PUT /api/problems relies on a lighter version of it). Used on
 * the assembled draft (problems that cannot pass never become drafts
 * worth reviewing) and again at accept time before anything is written.
 * Returns human-readable problems; an empty list means the pack is
 * structurally sound.
 */
export function validateProblemDefShape(pack: unknown): string[] {
  const p = pack as ProblemDef | null;
  if (!p || typeof p !== 'object') return ['题包不是一个对象'];
  const errs: string[] = [];
  if (!SAFE_DRAFT_ID.test(p.id ?? '')) errs.push(`id「${String(p.id)}」不是合法 slug（小写字母/数字/连字符）`);
  if (typeof p.name !== 'string' || !p.name.trim()) errs.push('name 缺失');
  if (typeof p.nameEn !== 'string' || !p.nameEn.trim()) errs.push('nameEn 缺失');
  if (!DIFFICULTY_SET.has(p.difficulty)) errs.push(`difficulty 不合法（${String(p.difficulty)}）`);
  if (!Array.isArray(p.tags) || p.tags.some((t) => typeof t !== 'string')) errs.push('tags 必须是字符串数组');
  if (typeof p.statement !== 'string' || !p.statement.trim()) errs.push('statement 缺失');
  if (
    !Array.isArray(p.functionalRequirements) ||
    p.functionalRequirements.some((r) => typeof r !== 'string')
  ) {
    errs.push('functionalRequirements 必须是字符串数组');
  }
  const s = p.scale;
  if (!s || typeof s !== 'object') {
    errs.push('scale 缺失');
  } else {
    if (typeof s.dau !== 'string' || !s.dau.trim()) errs.push('scale.dau 缺失');
    if (!(s.readRatio >= 0 && s.readRatio <= 1)) errs.push('scale.readRatio 须在 0–1');
    if (!(s.peakMultiplier >= 1)) errs.push('scale.peakMultiplier 须 ≥ 1');
    if (!(s.baselineRps > 0)) errs.push('scale.baselineRps 须 > 0');
    if (!(s.budgetCostPerHour > 0)) errs.push('scale.budgetCostPerHour 须 > 0');
  }
  const f = p.flags;
  if (
    !f ||
    ['mediaHeavy', 'hasFanout', 'publicWriteApi', 'readHeavy'].some(
      (k) => typeof f[k as keyof ProblemDef['flags']] !== 'boolean',
    )
  ) {
    errs.push('flags 四个布尔标记不全');
  }
  errs.push(...schemaShapeErrors(p.schema, 'schema'));
  // workload ↔ schema consistency: pattern paths are legal component
  // types and any named table exists in the starter schema.
  const tableNames = new Set((p.schema?.tables ?? []).map((t) => t.name));
  if (!p.workload || !Array.isArray(p.workload.patterns)) {
    errs.push('workload.patterns 缺失');
  } else {
    for (const w of p.workload.patterns as WorkloadPattern[]) {
      if (!Array.isArray(w.path) || !w.path.length) {
        errs.push(`workload 模式「${w.name}」的 path 为空`);
      } else if (w.path.some((t) => !COMPONENT_TYPE_ID_SET.has(t))) {
        errs.push(`workload 模式「${w.name}」的 path 含非法组件类型`);
      }
      if (w.table && !tableNames.has(w.table)) {
        errs.push(`workload 模式「${w.name}」引用了 schema 里不存在的表 ${w.table}`);
      }
      if (!(w.share > 0 && w.share <= 1)) errs.push(`workload 模式「${w.name}」的 share 不合法`);
    }
  }
  if (!Array.isArray(p.testCases) || !p.testCases.length) {
    errs.push('testCases 至少需要一个用例');
  } else {
    const caseIds = new Set<string>();
    let visible = 0;
    for (const tc of p.testCases) {
      if (caseIds.has(tc.id)) errs.push(`用例 id 重复「${tc.id}」`);
      caseIds.add(tc.id);
      if (!tc.hidden) visible += 1;
      if (!tc.thresholds || !Object.keys(tc.thresholds).length) {
        errs.push(`用例「${tc.name}」没有任何阈值，无从判定`);
      }
      if (!(tc.traffic?.rps > 0) || !(tc.traffic.readRatio >= 0 && tc.traffic.readRatio <= 1)) {
        errs.push(`用例「${tc.name}」的 traffic 不合法`);
      }
      if (!(tc.durationTicks >= 1)) errs.push(`用例「${tc.name}」的 durationTicks 不合法`);
      for (const ev of tc.events ?? []) {
        if (!EVENT_TYPE_SET.has(ev.type)) errs.push(`用例「${tc.name}」的事件类型不合法（${String(ev.type)}）`);
      }
      for (const k of tc.kills ?? []) {
        if (!COMPONENT_TYPE_ID_SET.has(k.componentType)) {
          errs.push(`用例「${tc.name}」的击杀组件类型不合法`);
        }
      }
    }
    if (!visible) errs.push('至少需要一个可见用例');
  }
  // schemaTestCases (optional field, but when present it must be a
  // judgeable suite: unique ids, legal assertion shapes, references
  // that exist in the schema).
  if (p.schemaTestCases !== undefined) {
    if (!Array.isArray(p.schemaTestCases)) {
      errs.push('schemaTestCases 不是数组');
    } else {
      const patternIds = new Set((p.schema?.accessPatterns ?? []).map((a) => a.id));
      const scIds = new Set<string>();
      for (const sc of p.schemaTestCases) {
        if (!sc.id || scIds.has(sc.id)) errs.push(`数据库用例 id 重复或为空「${sc.id}」`);
        scIds.add(sc.id);
        const a = sc.assertion as { kind?: string; patternId?: string; table?: string } | undefined;
        if (!a || typeof a !== 'object') {
          errs.push(`数据库用例「${sc.name}」缺少断言`);
        } else if (a.kind === 'pattern' || a.kind === 'pattern-path') {
          if (!a.patternId || !patternIds.has(a.patternId)) {
            errs.push(`数据库用例「${sc.name}」引用了不存在的访问模式 ${String(a.patternId)}`);
          }
        } else if (a.kind === 'table') {
          if (!a.table || !tableNames.has(a.table)) {
            errs.push(`数据库用例「${sc.name}」引用了不存在的表 ${String(a.table)}`);
          }
        } else if (a.kind !== 'global') {
          errs.push(`数据库用例「${sc.name}」的断言类型不合法（${String(a.kind)}）`);
        }
        if (sc.scale !== 'now' && sc.scale !== 'grown') {
          errs.push(`数据库用例「${sc.name}」的 scale 不合法`);
        }
      }
    }
  }
  errs.push(...designShapeErrors(p.sampleDesign, 'sampleDesign'));
  if (p.referenceSolution) {
    errs.push(...designShapeErrors(p.referenceSolution.design, 'referenceSolution.design'));
    errs.push(...schemaShapeErrors(p.referenceSolution.schema, 'referenceSolution.schema'));
  }
  return errs;
}

// -------------------------------------------------------- context assembly -

/**
 * Existing problems described by STRUCTURE ONLY (field lists + counts) —
 * the model learns the pack format from these without ever seeing an
 * existing problem's statement text.
 */
export function existingProblemStructures(packs: ProblemDef[]): string {
  if (!packs.length) return '（题库暂无现有题目）';
  return packs
    .map((p) => {
      const visible = p.testCases.filter((t) => !t.hidden).length;
      return (
        `- 题目「${p.id}」的字段清单：id / name / nameEn / difficulty / tags[] / statement / functionalRequirements[] / ` +
        `scale{dau, readRatio, peakMultiplier, baselineRps, budgetCostPerHour, notes} / flags{mediaHeavy, hasFanout, publicWriteApi, readHeavy}（由系统推导，生成时不用给） / ` +
        `schema.tables[${p.schema.tables.map((t) => `${t.name}{name, engine, rows, primaryKey, primaryKeyGen, shardKey, fields[{name, type, indexed, blob?}]}`).join('；') || '无'}] / ` +
        `schema.accessPatterns[{id, name, table, kind, byField, needsSort?, perSec}]（${p.schema.accessPatterns.length} 条） / ` +
        `workload{readRatio, consistency, fanoutFollowers?, patterns[{id, name, kind, description, share, path[组件类型], table?, consistency, terminalPerSec?}]}（${p.workload.patterns.length} 条） / ` +
        `testCases[{id, name, description, hidden, weight, traffic{rps, readRatio}, durationTicks, events?, kills?, thresholds, hint?, exposesRule?}]（${p.testCases.length} 个：可见 ${visible} / 隐藏 ${p.testCases.length - visible}） / ` +
        `sampleDesign{nodes[{id, type, settings}], edges[{from, to}]}（${p.sampleDesign.nodes.length} 节点） / referenceSolution{design, schema}（admin-only）`
      );
    })
    .join('\n');
}

export function buildWholeProblemContext(
  source: {
    sourceType: 'url' | 'text' | 'file';
    sourceLabel: string;
    sourceText: string;
    sourceTruncated: boolean;
    titleHint?: string;
  },
  existing: ProblemDef[],
): WholeProblemContext {
  return {
    sourceType: source.sourceType,
    sourceLabel: source.sourceLabel,
    sourceText: source.sourceText,
    sourceTruncated: source.sourceTruncated,
    ...(source.titleHint ? { titleHint: source.titleHint } : {}),
    existingProblemStructures: existingProblemStructures(existing),
    componentCatalog: componentCatalogText(),
    criteria: GENERATION_CRITERIA,
  };
}

// ------------------------------------------------------- validation duty -

/** GeneratedSchema → the pack shape, with silent inconsistencies repaired + noted. */
function sanitizeGeneratedSchema(
  schema: GeneratedSchema,
  label: string,
  notes: string[],
): ProblemSchema {
  const tables = schema.tables.map((t) => {
    const fields = [...t.fields];
    if (!fields.some((f) => f.name === t.primaryKey)) {
      fields.unshift({ name: t.primaryKey, type: 'bigint', indexed: true });
      notes.push(`${label}：表 ${t.name} 的主键 ${t.primaryKey} 不在字段列表中，已补同名 indexed 字段`);
    }
    let shardKey = t.shardKey;
    if (shardKey && !fields.some((f) => f.name === shardKey)) {
      notes.push(`${label}：表 ${t.name} 的分片键 ${shardKey} 不是其字段，已置空`);
      shardKey = null;
    }
    return { ...t, fields, shardKey };
  });
  const byName = new Map(tables.map((t) => [t.name, t]));
  const accessPatterns = schema.accessPatterns.filter((p) => {
    const t = byName.get(p.table);
    if (!t) {
      notes.push(`${label}：访问模式「${p.name}」引用了不存在的表 ${p.table}，已丢弃`);
      return false;
    }
    if (!t.fields.some((f) => f.name === p.byField)) {
      notes.push(`${label}：访问模式「${p.name}」的字段 ${p.byField} 不在表 ${p.table} 中，已丢弃`);
      return false;
    }
    return true;
  });
  return { tables, accessPatterns };
}

/** ProblemDef.flags are derived, never trusted from the model. */
function deriveProblemFlags(parsed: ParsedWholeProblem): ProblemDef['flags'] {
  const hay = `${parsed.name} ${parsed.nameEn} ${parsed.statement} ${parsed.tags.join(' ')}`;
  return {
    mediaHeavy: /照片|图片|图像|视频|音频|媒体|photo|image|video|media/i.test(hay),
    hasFanout:
      parsed.workload.patterns.some(
        (p) => p.path.includes('queue') || p.path.includes('feedservice'),
      ) || /粉丝|关注|fan-?out/i.test(hay),
    publicWriteApi: parsed.workload.patterns.some((p) => p.kind === 'write'),
    readHeavy: parsed.scale.readRatio >= 0.8,
  };
}

/**
 * The whole-problem arbiter. Assembles the parsed generation into a real
 * ProblemDef and runs the full battery described in the section header.
 * Nothing here trusts the model.
 */
export function validateWholeProblem(
  parsed: ParsedWholeProblem,
  existing: ProblemDef[],
  meta: {
    id: string;
    createdAt: string;
    model: string;
    profileName: string;
    viaUserChoice: boolean;
    source: WholeProblemDraft['source'];
    titleHint?: string;
  },
): WholeProblemDraft {
  const notes: string[] = [];
  const warnings: string[] = [];

  let id = parsed.id;
  if (!SAFE_DRAFT_ID.test(id)) {
    const slug = slugifyId(parsed.nameEn || parsed.name);
    notes.push(`生成的题目 id「${id || '(空)'}」不是合法 slug，已改用 ${slug}`);
    id = slug;
  }
  const idConflict = existing.some((p) => p.id === id);
  if (idConflict) {
    notes.push(`题目 id「${id}」与现有题包冲突：草稿可审，但采纳前必须在草稿里改名，否则采纳会被拦（409）`);
  }

  const schema = sanitizeGeneratedSchema(parsed.schema, '起始 schema', notes);
  const referenceSchema = sanitizeGeneratedSchema(
    parsed.referenceSolution.schema,
    '参考 schema',
    notes,
  );
  const schemaTables = new Set(schema.tables.map((t) => t.name));
  const workloadPatterns: WorkloadPattern[] = [];
  for (const p of parsed.workload.patterns) {
    if (p.table && !schemaTables.has(p.table)) {
      notes.push(`workload 模式「${p.name}」引用的表 ${p.table} 不在起始 schema 中，已丢弃该模式`);
      continue;
    }
    workloadPatterns.push(p as WorkloadPattern);
  }

  const { items: idCases } = uniquifyIds(new Set<string>(), parsed.cases);
  const cases = idCases.map(toTestCase);

  const { items: idSchemaCases } = uniquifyIds(new Set<string>(), parsed.schemaCases);
  const schemaCases = idSchemaCases.map(toSchemaTestCase);
  if (!parsed.schemaCases.length) {
    notes.push('本次生成没有产出数据库用例（schemaCases 为空）——新题将没有数据库判卷，采纳会被拦');
  }

  const sampleAssembled = assembleReferenceDesign(parsed.sampleDesign);
  for (const n of sampleAssembled.notes) notes.push(`起始设计：${n}`);
  const refAssembled = assembleReferenceDesign(parsed.referenceSolution.design);
  notes.push(...refAssembled.notes);

  const problem: ProblemDef = {
    id,
    name: parsed.name,
    nameEn: parsed.nameEn,
    difficulty: parsed.difficulty,
    tags: parsed.tags,
    statement: parsed.statement,
    functionalRequirements: parsed.functionalRequirements,
    scale: parsed.scale,
    flags: deriveProblemFlags(parsed),
    schema,
    workload: {
      readRatio: parsed.workload.readRatio,
      consistency: parsed.workload.consistency,
      ...(parsed.workload.fanoutFollowers !== undefined
        ? { fanoutFollowers: parsed.workload.fanoutFollowers }
        : {}),
      patterns: workloadPatterns,
    },
    testCases: cases,
    schemaTestCases: schemaCases,
    sampleDesign: sampleAssembled.design,
    referenceSolution: { design: refAssembled.design, schema: referenceSchema },
  };

  const base = {
    kind: 'new-problem' as const,
    id: meta.id,
    createdAt: meta.createdAt,
    model: meta.model,
    profileName: meta.profileName,
    viaUserChoice: meta.viaUserChoice,
    source: meta.source,
    ...(meta.titleHint ? { titleHint: meta.titleHint } : {}),
    idConflict,
    notes,
    problem,
  };

  const emptyReport = (warns: string[]): WholeProblemReport => ({
    livenessOk: false,
    referencePassedCount: 0,
    referenceTotalCount: cases.length,
    referencePassRate: 0,
    baselineCasePresent: false,
    baselineCasePassedByReference: false,
    cases: [],
    sampleBaselinePassedCount: 0,
    sampleBaselineTotalCount: 0,
    sampleAllBaselineFailed: false,
    schemaCases: [],
    validSchemaCaseCount: 0,
    schemaDiscriminationOk: false,
    warnings: warns,
    structuralFindings: [],
    highSeverityCount: 0,
    validCaseCount: 0,
  });

  if (refAssembled.fatal) {
    return {
      ...base,
      status: 'rejected',
      rejectReason: `参考解不可用：${refAssembled.fatal}`,
      report: emptyReport(warnings),
    };
  }

  // Shape gate on the assembled pack (minus the reference, which is
  // validated as part of the same call when present — it is).
  const shapeErrors = validateProblemDefShape(problem);
  if (shapeErrors.length) {
    return {
      ...base,
      status: 'rejected',
      rejectReason: `生成的题包形状不合格：${shapeErrors.join('；')}`,
      report: emptyReport(warnings),
    };
  }

  const design = refAssembled.design;
  const livenessOk = designLiveness(problem, design);

  // Reference vs its own cases + sample discrimination, per case.
  const sampleUsable = !sampleAssembled.fatal && sampleAssembled.design.nodes.length > 0;
  if (!sampleUsable) {
    warnings.push(
      `起始设计（sampleDesign）不可用${sampleAssembled.fatal ? `：${sampleAssembled.fatal}` : ''}——区分度无从测起，起始设计本身需要重出`,
    );
  }
  const isBaselineCase = (tc: TestCase) =>
    !tc.hidden && !(tc.events?.length ?? 0) && !(tc.kills?.length ?? 0);
  const caseReports: GenerationCaseValidation[] = cases.map((tc) => {
    const ref = runTestCase(problem, design, tc);
    const baseline = sampleUsable ? runTestCase(problem, sampleAssembled.design, tc) : null;
    return {
      caseId: tc.id,
      name: tc.name,
      hidden: tc.hidden,
      referencePassed: ref.passed,
      referenceFailures: ref.failures,
      referenceMeasured: ref.measured,
      baselinePassed: baseline ? baseline.passed : null,
      baselineFailures: baseline ? baseline.failures : [],
      weakDiscrimination: tc.hidden && baseline?.passed === true,
      acceptable: ref.passed,
      verdict: ref.passed ? ('有效' as const) : ('无效用例' as const),
    };
  });

  const passedCount = caseReports.filter((v) => v.referencePassed).length;
  const passRate = cases.length ? passedCount / cases.length : 0;
  const baselineCases = cases.filter(isBaselineCase);
  const baselinePresent = baselineCases.length > 0;
  const baselinePassedByRef =
    baselinePresent &&
    baselineCases.every(
      (tc) => caseReports.find((v) => v.caseId === tc.id)?.referencePassed === true,
    );
  const sampleBaselineTotal = baselineCases.length;
  const sampleBaselinePassed = baselineCases.filter(
    (tc) => caseReports.find((v) => v.caseId === tc.id)?.baselinePassed === true,
  ).length;
  const sampleAllBaselineFailed =
    sampleUsable && baselinePresent && sampleBaselinePassed === 0;
  if (sampleAllBaselineFailed) {
    warnings.push(
      '起始设计连一个可见基线用例都没通过——全军覆没的起始设计是坏教学（标警告，不否决）',
    );
  }

  const structuralFindings = checkStructure(problem, design).map((f) => ({
    ruleId: f.ruleId,
    severity: f.severity,
    title: f.title,
    detail: f.detail,
    componentIds: f.componentIds,
  }));

  // Schema cases: the reference schema must pass each one; the starter
  // schema is the discrimination baseline — it should fail at least one
  // HIDDEN schema case, else every hidden schema case is weak (warning,
  // mirroring the sample-design posture; a draft with NO valid schema
  // case at all cannot be accepted — see acceptWholeProblemDraft).
  const schemaCaseReports = validateGeneratedSchemaCases(
    problem,
    schemaCases,
    referenceSchema,
    schema,
  );
  const hiddenSchemaCases = schemaCaseReports.filter((v) => v.hidden);
  const schemaDiscriminationOk = hiddenSchemaCases.some((v) => !v.starterPassed);
  if (schemaCases.length > 0 && hiddenSchemaCases.length === 0) {
    warnings.push('数据库用例全是可见用例——没有隐藏数据库用例，区分度无从谈起（标警告，不否决）');
  } else if (schemaCases.length > 0 && !schemaDiscriminationOk) {
    warnings.push(
      '起始 schema 通过了全部隐藏数据库用例——这些用例没有区分度（标警告，不否决）',
    );
  }
  if (schemaCaseReports.filter((v) => v.acceptable).length === 0) {
    warnings.push('没有一个数据库用例能被参考 schema 通过——采纳会被拦（新题必须带至少一个有效数据库用例）');
  }

  let rejectReason: string | undefined;
  if (!livenessOk) {
    rejectReason =
      '参考解没有形成可达的流量路径：客户端的流量到不了任何下游组件，这样的"解"通过阈值也没有意义';
  } else if (!baselinePresent) {
    rejectReason =
      '缺少可见基线型用例（hidden=false、无事件/击杀的稳态用例）——基线用例是答题者建立信心的起点，整题驳回';
  } else if (!baselinePassedByRef) {
    rejectReason = '参考解没有通过它自己出的可见基线用例，整题驳回';
  } else if (passRate <= 0.5) {
    rejectReason = `参考解只通过了自己出的 ${passedCount}/${cases.length} 个用例（通过率 ≤ 半数），整题驳回——参考解必须能解决自己出的题`;
  }

  return {
    ...base,
    status: rejectReason ? 'rejected' : 'pending',
    ...(rejectReason ? { rejectReason } : {}),
    report: {
      livenessOk,
      referencePassedCount: passedCount,
      referenceTotalCount: cases.length,
      referencePassRate: passRate,
      baselineCasePresent: baselinePresent,
      baselineCasePassedByReference: baselinePassedByRef,
      cases: caseReports,
      sampleBaselinePassedCount: sampleBaselinePassed,
      sampleBaselineTotalCount: sampleBaselineTotal,
      sampleAllBaselineFailed,
      schemaCases: schemaCaseReports,
      validSchemaCaseCount: schemaCaseReports.filter((v) => v.acceptable).length,
      schemaDiscriminationOk,
      warnings,
      structuralFindings,
      highSeverityCount: structuralFindings.filter((f) => f.severity === 'high').length,
      validCaseCount: passedCount,
    },
  };
}

// ------------------------------------------------------- whole draft store -

export async function saveWholeProblemDraft(draft: WholeProblemDraft): Promise<void> {
  await mkdir(GENERATIONS_DIR, { recursive: true });
  await writeFile(
    path.join(GENERATIONS_DIR, `${draft.id}.json`),
    `${JSON.stringify(draft, null, 2)}\n`,
    'utf8',
  );
}

export async function getWholeProblemDraft(id: string): Promise<WholeProblemDraft | null> {
  if (!SAFE_DRAFT_ID.test(id)) return null;
  try {
    const raw = await readFile(path.join(GENERATIONS_DIR, `${id}.json`), 'utf8');
    const parsed = JSON.parse(raw) as WholeProblemDraft;
    return parsed.kind === 'new-problem' ? parsed : null;
  } catch {
    return null;
  }
}

export async function listWholeProblemDrafts(): Promise<WholeProblemDraft[]> {
  let files: string[];
  try {
    files = (await readdir(GENERATIONS_DIR)).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const out: WholeProblemDraft[] = [];
  for (const f of files) {
    try {
      const draft = JSON.parse(
        await readFile(path.join(GENERATIONS_DIR, f), 'utf8'),
      ) as WholeProblemDraft;
      if (draft.kind === 'new-problem') out.push(draft);
    } catch {
      /* skip a torn draft file */
    }
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export interface WholeProblemDraftSummary {
  kind: 'new-problem';
  id: string;
  /** The PROPOSED problem id (what accept would write). */
  problemId: string;
  problemName: string;
  createdAt: string;
  model: string;
  profileName: string;
  status: WholeProblemDraft['status'];
  rejectReason?: string;
  sourceType: WholeProblemDraft['source']['type'];
  sourceLabel: string;
  caseCount: number;
  validCaseCount: number;
  weakCount: number;
  idConflict: boolean;
  referencePassRate: number;
  schemaCaseCount: number;
  validSchemaCaseCount: number;
}

export function summarizeWholeDraft(draft: WholeProblemDraft): WholeProblemDraftSummary {
  return {
    kind: 'new-problem',
    id: draft.id,
    problemId: draft.problem.id,
    problemName: draft.problem.name,
    createdAt: draft.createdAt,
    model: draft.model,
    profileName: draft.profileName,
    status: draft.status,
    ...(draft.rejectReason ? { rejectReason: draft.rejectReason } : {}),
    sourceType: draft.source.type,
    sourceLabel: draft.source.label,
    caseCount: draft.problem.testCases.length,
    validCaseCount: draft.report.validCaseCount,
    weakCount: draft.report.cases.filter((v) => v.weakDiscrimination).length,
    idConflict: draft.idConflict,
    referencePassRate: draft.report.referencePassRate,
    schemaCaseCount: (draft.problem.schemaTestCases ?? []).length,
    validSchemaCaseCount: draft.report.validSchemaCaseCount,
  };
}

/**
 * Accept a whole-problem draft: write the assembled pack as a NEW problem.
 * Gates, in order: not rejected → optional admin rename (body.problemId)
 * → id must be free (409 problem_id_conflict otherwise) → only valid
 * cases ship (at least one visible) → the final pack passes the SAME
 * shape validation as any stored pack → the reference still passes the
 * majority of the shipped cases and their visible baseline on a fresh
 * run. Only then is anything written.
 */
async function acceptWholeProblemDraft(
  c: { req: { json: () => Promise<unknown> }; json: (v: unknown, s?: number) => Response },
  storage: ProblemStorage,
  draft: WholeProblemDraft,
) {
  if (draft.status === 'rejected') {
    return c.json(
      { error: 'generation_rejected', message: draft.rejectReason ?? '这份生成已被驳回，不能采纳' },
      409,
    );
  }
  if (!draft.problem.referenceSolution) {
    return c.json({ error: 'no_reference', message: '草稿缺少参考解，不能采纳' }, 409);
  }
  const body = (await c.req.json().catch(() => null)) as { problemId?: unknown } | null;
  let problem = draft.problem;
  const rename = typeof body?.problemId === 'string' ? body.problemId.trim() : '';
  if (rename && rename !== problem.id) {
    if (!SAFE_DRAFT_ID.test(rename)) {
      return c.json(
        badRequest(`新 id「${rename}」不是合法 slug（小写字母/数字/连字符）`),
        400,
      );
    }
    problem = { ...problem, id: rename };
  }
  if (await storage.getProblem(problem.id)) {
    return c.json(
      {
        error: 'problem_id_conflict',
        message: `题目 id「${problem.id}」已存在于题库，采纳被拦。请在草稿里改一个新 id（采纳请求带 { problemId: "新id" }）后重试，或先删掉/改名现有题目。`,
        conflictingId: problem.id,
      },
      409,
    );
  }
  const validIds = new Set(
    draft.report.cases.filter((v) => v.acceptable).map((v) => v.caseId),
  );
  const validCases = problem.testCases.filter((tc) => validIds.has(tc.id));
  const droppedCaseIds = problem.testCases
    .filter((tc) => !validIds.has(tc.id))
    .map((tc) => tc.id);
  if (!validCases.length) {
    return c.json(
      { error: 'no_valid_cases', message: '这份生成里没有通过参考解验证的有效用例，无可采纳' },
      409,
    );
  }
  if (!validCases.some((tc) => !tc.hidden)) {
    return c.json(
      { error: 'no_visible_cases', message: '有效用例里没有可见用例，不能采纳为正式题目' },
      409,
    );
  }
  // Schema cases ship by the same rule: only the ones the reference
  // schema passes; a new problem must carry at least one valid schema
  // case (database judging is half of this product now).
  const validSchemaIds = new Set(
    draft.report.schemaCases.filter((v) => v.acceptable).map((v) => v.caseId),
  );
  const validSchemaCases = (problem.schemaTestCases ?? []).filter((tc) =>
    validSchemaIds.has(tc.id),
  );
  const droppedSchemaCaseIds = (problem.schemaTestCases ?? [])
    .filter((tc) => !validSchemaIds.has(tc.id))
    .map((tc) => tc.id);
  if (!validSchemaCases.length) {
    return c.json(
      {
        error: 'no_valid_schema_cases',
        message: '这份生成里没有通过参考 schema 验证的有效数据库用例，新题必须至少带一个',
      },
      409,
    );
  }
  const finalPack: ProblemDef = {
    ...problem,
    testCases: validCases,
    schemaTestCases: validSchemaCases,
  };
  const shapeErrors = validateProblemDefShape(finalPack);
  if (shapeErrors.length) {
    return c.json(
      {
        error: 'problem_shape_invalid',
        message: `题包形状校验未通过，拒绝写盘：${shapeErrors.join('；')}`,
        errors: shapeErrors,
      },
      422,
    );
  }
  // Fresh re-verification against the pack exactly as it would ship.
  const recheck = runSuite(finalPack, finalPack.referenceSolution!.design);
  const baselineIds = new Set(
    validCases
      .filter((tc) => !tc.hidden && !(tc.events?.length ?? 0) && !(tc.kills?.length ?? 0))
      .map((tc) => tc.id),
  );
  const baselineOk =
    baselineIds.size > 0 &&
    recheck.results.every((r) => !baselineIds.has(r.caseId) || r.passed);
  if (recheck.passedCount <= validCases.length / 2 || !baselineOk) {
    return c.json(
      {
        error: 'reference_stale',
        message: `采纳前复验未过：参考解现在通过 ${recheck.passedCount}/${validCases.length} 个将入库用例${baselineOk ? '' : '，且可见基线用例未通过'}，不能采纳`,
        failures: recheck.results
          .filter((r) => !r.passed)
          .map((r) => ({ caseId: r.caseId, name: r.name, failures: r.failures })),
      },
      409,
    );
  }
  // The reference schema must still pass every shipped schema case.
  const schemaRecheck = judgeSchemaCases(finalPack, finalPack.referenceSolution!.schema);
  if (schemaRecheck.passedCount !== schemaRecheck.totalCount) {
    return c.json(
      {
        error: 'reference_schema_stale',
        message: `采纳前复验未过：参考 schema 现在通过 ${schemaRecheck.passedCount}/${schemaRecheck.totalCount} 个将入库的数据库用例，不能采纳`,
        failures: schemaRecheck.results
          .filter((r) => !r.passed)
          .map((r) => ({ caseId: r.caseId, name: r.name, failures: r.failures })),
      },
      409,
    );
  }
  await storage.saveProblem(finalPack);
  await deleteGenerationDraft(draft.id);
  return c.json({
    ok: true,
    problemId: finalPack.id,
    ...(rename && rename !== draft.problem.id ? { renamedFrom: draft.problem.id } : {}),
    acceptedCaseIds: validCases.map((tc) => tc.id),
    droppedCaseIds,
    acceptedSchemaCaseIds: validSchemaCases.map((tc) => tc.id),
    droppedSchemaCaseIds,
    referenceStored: true,
  });
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

  // --------------------------------------------- whole-problem generation -
  // The author gives a source (URL fetched server-side / pasted text /
  // uploaded .md|.txt already read to text by the browser); the LLM
  // authors an ENTIRE new problem from it. Fetch failures are honest
  // errors (400 with an actionable message) and a missing key is the
  // usual honest llm_required (503) — nothing is fabricated either way.
  app.post('/api/problems/generate-from-source', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      sourceType?: unknown;
      url?: unknown;
      text?: unknown;
      fileName?: unknown;
      titleHint?: unknown;
      profileId?: unknown;
    } | null;
    if (!body || !['url', 'text', 'file'].includes(String(body.sourceType))) {
      return c.json(
        badRequest('需要 { sourceType: "url" | "text" | "file", url?/text?, fileName?, titleHint? }'),
        400,
      );
    }
    const sourceType = body.sourceType as 'url' | 'text' | 'file';
    let sourceText: string;
    let sourceTruncated: boolean;
    let sourceLabel: string;
    if (sourceType === 'url') {
      const url = typeof body.url === 'string' ? body.url.trim() : '';
      if (!url) return c.json(badRequest('sourceType=url 时需要 url'), 400);
      try {
        const fetched = await fetchSourceText(url);
        sourceText = fetched.text;
        sourceTruncated = fetched.truncated;
        sourceLabel = fetched.finalUrl;
      } catch (err) {
        if (err instanceof SourceFetchError) {
          return c.json({ error: 'source_fetch_failed', message: err.message }, 400);
        }
        throw err;
      }
    } else {
      const rawText = typeof body.text === 'string' ? body.text : '';
      if (!rawText.trim()) {
        return c.json(
          badRequest(sourceType === 'file' ? '文件内容为空' : '需要粘贴题面文本（text）'),
          400,
        );
      }
      if (sourceType === 'file') {
        const fileName = typeof body.fileName === 'string' ? body.fileName.trim() : '';
        if (!/\.(md|txt)$/i.test(fileName)) {
          return c.json(badRequest('只支持上传 .md / .txt 文件'), 400);
        }
        sourceLabel = fileName;
      } else {
        sourceLabel = '粘贴文本';
      }
      const capped = capSourceText(rawText.trim());
      sourceText = capped.text;
      sourceTruncated = capped.truncated;
    }
    if (sourceText.trim().length < 40) {
      return c.json(
        badRequest('来源内容太少（不足 40 字），不足以命制一道完整的题——请补全题面材料'),
        400,
      );
    }
    const titleHint =
      typeof body.titleHint === 'string' && body.titleHint.trim()
        ? body.titleHint.trim().slice(0, 120)
        : undefined;
    const profileId = typeof body.profileId === 'string' ? body.profileId : undefined;

    const existing = await storage.listProblems();
    const ctx = buildWholeProblemContext(
      {
        sourceType,
        sourceLabel,
        sourceText,
        sourceTruncated,
        ...(titleHint ? { titleHint } : {}),
      },
      existing,
    );
    let outcome;
    try {
      outcome = await generateWholeProblemContent(ctx, profileId);
    } catch (err) {
      if (err instanceof GenerationLlmError) {
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

    const draft = validateWholeProblem(outcome.data, existing, {
      id: `np${Date.now().toString(36)}`,
      createdAt: new Date().toISOString(),
      model: outcome.model,
      profileName: outcome.profileName,
      viaUserChoice: outcome.viaUserChoice,
      source: { type: sourceType, label: sourceLabel, chars: sourceText.length, truncated: sourceTruncated },
      ...(titleHint ? { titleHint } : {}),
    });
    await saveWholeProblemDraft(draft);
    return c.json({ ok: true, draft }, 201);
  });

  // --------------------------------------------------------- draft review -
  // With ?problemId= → that problem's extension drafts (as before).
  // Without → every draft awaiting review, whole-problem ones included,
  // discriminated by the summary's `kind`.
  app.get('/api/admin/generations', async (c) => {
    const problemId = c.req.query('problemId');
    if (problemId) {
      const drafts = await listGenerationDrafts(problemId);
      return c.json(drafts.map(summarizeDraft));
    }
    const [ext, whole] = await Promise.all([
      listGenerationDrafts(),
      listWholeProblemDrafts(),
    ]);
    const all = [
      ...ext.map(summarizeDraft),
      ...whole.map(summarizeWholeDraft),
    ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return c.json(all);
  });

  app.get('/api/admin/generations/:id', async (c) => {
    const draft =
      (await getGenerationDraft(c.req.param('id'))) ??
      (await getWholeProblemDraft(c.req.param('id')));
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
    if (!draft) {
      // Not an extension draft — maybe a whole-problem draft, whose
      // accept writes an entire NEW pack (see acceptWholeProblemDraft).
      const whole = await getWholeProblemDraft(c.req.param('id'));
      if (whole) return acceptWholeProblemDraft(c, storage, whole);
      return c.json({ error: 'generation_not_found' }, 404);
    }
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
    // Schema cases ride along: the draft's acceptable ones merge into
    // the pack's schemaTestCases (ids re-uniquified against the CURRENT
    // pack), and the reference schema must pass the ENTIRE merged schema
    // suite — the same accept-gate discipline as the arch recheck above.
    const validSchemaIds = new Set(
      draft.report.schemaCases.filter((v) => v.acceptable).map((v) => v.caseId),
    );
    const validSchemaCases = (draft.schemaCases ?? []).filter((tc) =>
      validSchemaIds.has(tc.id),
    );
    const skippedSchemaCaseIds = (draft.schemaCases ?? [])
      .filter((tc) => !validSchemaIds.has(tc.id))
      .map((tc) => tc.id);
    const { items: acceptedSchemaCases, renames: schemaMergeRenames } = uniquifyIds(
      new Set((pack.schemaTestCases ?? []).map((tc) => tc.id)),
      validSchemaCases,
    );
    const merged: ProblemDef = {
      ...pack,
      testCases: [...pack.testCases, ...acceptedCases],
      schemaTestCases: [...(pack.schemaTestCases ?? []), ...acceptedSchemaCases],
      referenceSolution: draft.referenceSolution,
    };
    if ((merged.schemaTestCases ?? []).length > 0) {
      const schemaRecheck = judgeSchemaCases(merged, draft.referenceSolution.schema);
      if (schemaRecheck.passedCount !== schemaRecheck.totalCount) {
        return c.json(
          {
            error: 'reference_schema_stale',
            message: `参考 schema 现在只能通过合并后的数据库用例 ${schemaRecheck.passedCount}/${schemaRecheck.totalCount}，不能采纳`,
            failures: schemaRecheck.results
              .filter((r) => !r.passed)
              .map((r) => ({ caseId: r.caseId, name: r.name, failures: r.failures })),
          },
          409,
        );
      }
    }
    await storage.saveProblem(merged);
    await deleteGenerationDraft(draft.id);
    return c.json({
      ok: true,
      problemId: pack.id,
      addedCaseIds: acceptedCases.map((tc) => tc.id),
      skippedCaseIds,
      renamedCases: renames,
      addedSchemaCaseIds: acceptedSchemaCases.map((tc) => tc.id),
      skippedSchemaCaseIds,
      renamedSchemaCases: schemaMergeRenames,
      referenceStored: true,
    });
  });
}
