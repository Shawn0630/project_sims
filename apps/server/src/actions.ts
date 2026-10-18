import { COMPONENT_MAP, componentDef } from '@sds/components';
import {
  settingRuleFor,
  validateEditOps,
  validateSchemaOps,
  type SchemaReviewReport,
} from '@sds/checker';
import {
  buildActionRepairPrompt,
  parseActionRepair,
  type ActionCoverage,
  type ActionRepairItem,
  type ActionSource,
  type DriverFinding,
  type EditOp,
  type NonMechanicalReason,
  type ParsedRepair,
  type ProbeCase,
  type SchemaOp,
  type SchemaSuggestion,
  type VerifiedProbeResult,
} from '@sds/driver';
import type { ProblemDef, ProblemSchema } from '@sds/problems';
import { SimulationEngine, type Design, type DesignNode } from '@sds/sim-core';

/**
 * The action-guarantee ladder — server-side post-processing that makes
 * "every evaluation finding ships with ≥1 validated, applicable action"
 * true BY CONSTRUCTION, for architecture findings, probe-case fixes and
 * schema suggestions alike. Steps, in order:
 *
 *   0. First-pass actions are validated (validateEditOps /
 *      validateSchemaOps). Survivors keep their provenance: 'llm' when
 *      the model proposed them, 'rule' on the scripted path (scripted
 *      findings derive from deterministic rules).
 *   1. REPAIR — everything still lacking goes into ONE bounded follow-up
 *      call (same profile/logging plumbing, llm.ts owns the call): the
 *      validation errors verbatim + the legal vocabularies. Whatever
 *      validates this time attaches as 'repaired'. Skipped on the
 *      scripted path (no model output to repair).
 *   2. RULE SYNTHESIS — deterministic category → remedy mappings, the
 *      same spirit as the checker's canned fixes. Tagged 'rule'.
 *   3. UNIVERSAL FALLBACK — the always-constructible action: one
 *      capacity step on the most-implicated node (architecture) or an
 *      index/gen change on the first table (schema). Tagged 'fallback'.
 *
 * The ONLY items allowed to ship actionless are (a) findings whose
 * non-mechanical declaration SURVIVES — a declared reason from the small
 * enum AND no load/correctness signal in the text (pure tradeoff
 * commentary); those are excluded from the coverage denominator and
 * counted separately — and (b) items for which no action is constructible
 * at all: an empty design (no nodes), an empty schema (no tables), or a
 * signals-only schema request that carried no schema to validate
 * against. Everything else is covered by construction.
 */

/** The low-level repair call llm.ts provides: one logged model call that
 *  returns the parsed JSON (or null when the call failed). */
export type RepairCall = (prompt: { system: string; user: string }) => Promise<unknown | null>;

// ------------------------------------------------------------ shared bits -

/**
 * Hard load/correctness signals. A finding whose text carries one of
 * these can NEVER hide behind a non-mechanical declaration — the ladder
 * runs on it in full. (Kept deliberately narrow: soft words like 延迟 or
 * 索引 alone do not force an action onto pure commentary; the failure
 * phrasings the reviewers actually use do.)
 */
const LOAD_OR_CORRECTNESS =
  /错误率|P99|超标|过载|单点|积压|旧数据|未通过|没通过|挂了|失败|宕机|故障|雪崩|打满|打爆|瓶颈|全表扫描|跨分片广播|热点分片|读旧|不可用|无响应/;

export function hasLoadOrCorrectnessSignal(text: string): boolean {
  return LOAD_OR_CORRECTNESS.test(text);
}

function emptyCoverage(): ActionCoverage {
  return {
    findings: 0,
    withActions: 0,
    bySource: { llm: 0, repaired: 0, rule: 0, fallback: 0 },
    nonMechanical: 0,
  };
}

function tally(
  coverage: ActionCoverage,
  items: { actions?: unknown[]; actionSource?: ActionSource; escaped: boolean }[],
): ActionCoverage {
  for (const it of items) {
    if (it.escaped) {
      coverage.nonMechanical += 1;
      continue;
    }
    coverage.findings += 1;
    if (it.actions?.length && it.actionSource) {
      coverage.withActions += 1;
      coverage.bySource[it.actionSource] += 1;
    }
  }
  return coverage;
}

const CAPACITY_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4];

function capacityStepUp(node: DesignNode): EditOp | null {
  const cur = typeof node.settings.capacityScale === 'number' ? node.settings.capacityScale : 1;
  const next = CAPACITY_STEPS.find((s) => s > cur + 1e-9);
  return next !== undefined
    ? { op: 'setSetting', nodeId: node.id, key: 'capacityScale', value: next }
    : null;
}

function capacityStepDown(node: DesignNode): EditOp | null {
  const cur = typeof node.settings.capacityScale === 'number' ? node.settings.capacityScale : 1;
  const prev = [...CAPACITY_STEPS].reverse().find((s) => s < cur - 1e-9);
  return prev !== undefined
    ? { op: 'setSetting', nodeId: node.id, key: 'capacityScale', value: prev }
    : null;
}

function replicasStep(node: DesignNode, delta: 1 | -1): EditOp | null {
  const cur = typeof node.settings.replicas === 'number' ? node.settings.replicas : 1;
  const next = cur + delta;
  if (next < 1 || next > 16) return null;
  return { op: 'setSetting', nodeId: node.id, key: 'replicas', value: next };
}

const isStorage = (n: DesignNode) =>
  n.type === 'relationaldb' || n.type === 'nosql' || n.type === 'objectstorage';
const isShardableStorage = (n: DesignNode) => n.type === 'relationaldb' || n.type === 'nosql';

/**
 * The most-implicated node, genuinely measured: run the problem's
 * baseline traffic briefly and take the non-source node with the highest
 * observed utilization. Null when the design cannot be simulated (no
 * nodes / no source) — callers fall back to graph heuristics.
 */
export function measureHottestNodeId(problem: ProblemDef, design: Design): string | null {
  if (!design.nodes.length) return null;
  const traffic = problem.testCases[0]?.traffic ?? {
    rps: problem.scale.baselineRps,
    readRatio: problem.scale.readRatio,
  };
  try {
    const engine = new SimulationEngine(design, traffic);
    const peak = new Map<string, number>();
    for (let tick = 0; tick < 12; tick += 1) {
      const snap = engine.step(1);
      if (tick < 6) continue; // steady state only
      for (const n of design.nodes) {
        if (componentDef(n.type).behavior === 'source') continue;
        const util = snap.nodes[n.id]?.util ?? 0;
        if (util > (peak.get(n.id) ?? 0)) peak.set(n.id, util);
      }
    }
    let best: string | null = null;
    let bestUtil = -1;
    for (const [id, util] of peak) {
      if (util > bestUtil) {
        bestUtil = util;
        best = id;
      }
    }
    return best;
  } catch {
    return null;
  }
}

/** Deterministic stand-in when no problem is at hand: highest-degree
 *  non-client node, storage preferred on ties. */
export function heuristicHottestNodeId(design: Design): string | null {
  const degree = new Map<string, number>();
  for (const e of design.edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const candidates = design.nodes.filter((n) => n.type !== 'client');
  candidates.sort((a, b) => {
    const byStorage = Number(isStorage(b)) - Number(isStorage(a));
    if (byStorage !== 0) return byStorage;
    return (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0);
  });
  return candidates[0]?.id ?? null;
}

// ------------------------------------------------- diagnostics & vocabularies -

/**
 * Why a batch of proposed edit-ops did not survive validation, in the
 * reviewer's own vocabulary (ghost node, illegal key, out-of-range
 * value…). Fed verbatim into the repair prompt so the model can fix its
 * own mistakes instead of guessing.
 */
export function diagnoseEditOps(ops: readonly EditOp[] | undefined, design: Design): string[] {
  if (!ops?.length) return ['没有给出 actions（动作保证要求每条发现都带合法动作）'];
  const valid = validateEditOps(ops, design);
  if (valid.length >= ops.length) return [];
  const validKeys = valid.map((v) => JSON.stringify(v));
  const createdIds = new Set(
    ops.flatMap((o) => (o.op === 'addComponent' && o.newNodeId ? [o.newNodeId] : [])),
  );
  const nodeById = new Map(design.nodes.map((n) => [n.id, n]));
  const errors: string[] = [];
  for (const op of ops) {
    // An op validateEditOps stamped (e.g. an assigned newNodeId) differs
    // textually from the proposal; match loosely by kind + target.
    const survived = validKeys.some((k) => {
      const v = JSON.parse(k) as EditOp;
      if (v.op !== op.op) return false;
      if (op.op === 'setSetting') return (v as typeof op).nodeId === op.nodeId && (v as typeof op).key === op.key;
      if (op.op === 'addEdge') return (v as typeof op).fromId === op.fromId && (v as typeof op).toId === op.toId;
      return true; // addComponent: any surviving insert counts
    });
    if (survived) continue;
    if (op.op === 'setSetting') {
      const node = nodeById.get(op.nodeId);
      if (!node && !createdIds.has(op.nodeId)) {
        errors.push(`节点「${op.nodeId}」不存在（幻影节点：nodeId 必须抄设计里真实出现的 id）`);
      } else if (node && !settingRuleFor(node.type, op.key)) {
        errors.push(`参数「${op.key}」对组件类型 ${node.type} 不合法`);
      } else {
        errors.push(`参数「${op.key}」的值 ${JSON.stringify(op.value)} 类型不对或超出合法范围`);
      }
    } else if (op.op === 'addComponent') {
      const missing = [op.connectFromId, op.connectToId].filter(
        (id) => id && !nodeById.has(id) && !createdIds.has(id),
      );
      if (missing.length) errors.push(`addComponent 的连接端点「${missing.join('、')}」不存在`);
      else if (!op.connectFromId && !op.connectToId) errors.push('addComponent 缺少连接端点');
      else if (op.newNodeId && nodeById.has(op.newNodeId)) {
        errors.push(`newNodeId「${op.newNodeId}」与已有节点 id 冲突`);
      } else errors.push('addComponent 未通过校验（端点组合不合法）');
    } else {
      const missing = [op.fromId, op.toId].filter((id) => !nodeById.has(id) && !createdIds.has(id));
      if (missing.length) errors.push(`addEdge 的端点「${missing.join('、')}」不存在`);
      else errors.push('addEdge 未通过校验（自环或连线已存在）');
    }
  }
  return errors.length ? errors : ['动作未通过服务端校验'];
}

/** The legal architecture vocabulary, rendered for the repair prompt. */
export function legalArchVocab(design: Design): string {
  const extras: Partial<Record<string, string[]>> = {
    loadbalancer: ['lbAlgorithm'],
    gateway: ['rateLimitPerSec'],
    cache: ['eviction', 'mutexRebuild'],
    relationaldb: ['sharded', 'shardKey', 'readReplicas', 'consistency'],
    nosql: ['sharded', 'shardKey', 'readReplicas', 'consistency'],
  };
  const lines = design.nodes.map((n) => {
    const keys = ['replicas', 'capacityScale', ...(extras[n.type] ?? [])];
    const cur = keys
      .map((k) => `${k}=${JSON.stringify((n.settings as unknown as Record<string, unknown>)[k] ?? null)}`)
      .join('，');
    return `- 节点 ${n.id}（${n.type}）：可调参数 ${cur}`;
  });
  lines.push(`- 可插入的组件类型：${Object.keys(COMPONENT_MAP).join('、')}`);
  return lines.join('\n');
}

/** The legal schema vocabulary, rendered for the repair prompt. */
export function legalSchemaVocab(schema: ProblemSchema): string {
  return schema.tables
    .map(
      (t) =>
        `- 表 ${t.name}（${t.engine}，主键 ${t.primaryKey}/${t.primaryKeyGen}，分片键 ${t.shardKey ?? '无'}）：字段 ${t.fields
          .map((f) => `${f.name}${f.indexed ? '（已索引）' : ''}`)
          .join('、') || '（无字段）'}`,
    )
    .join('\n');
}

// ------------------------------------------------------- arch synthesis -

function inferCategory(text: string): string | undefined {
  if (/旧数据|读到旧|stale|一致性|副本延迟/.test(text)) return '读到旧数据';
  if (/积压|队列|backlog|消费跟不上/.test(text)) return '队列积压';
  if (/成本|费用|预算|烧钱|太贵/.test(text)) return '成本超标';
  if (/存储|数据库|入站|分片/.test(text)) return '存储过载';
  if (/热点|hot.?key|倾斜/.test(text)) return '热点过载';
  if (/P99|延迟|响应时间|尾延迟/.test(text)) return 'P99 超标';
  if (/单点|故障|宕机|冗余|可用性|错误率|错误/.test(text)) return '错误率超标';
  return undefined;
}

/**
 * Deterministic category → remedy synthesis (ladder step 3). Candidates
 * are conservative one-step changes on the implicated node; the caller
 * validates and falls through to the universal fallback when nothing
 * survives.
 */
function synthesizeArchByCategory(
  category: string | undefined,
  text: string,
  design: Design,
  implicatedIds: string[],
  hottestId: string | null,
): EditOp[] {
  const nodeById = new Map(design.nodes.map((n) => [n.id, n]));
  const implicated = implicatedIds
    .map((id) => nodeById.get(id))
    .filter((n): n is DesignNode => !!n);
  const hottest = hottestId ? nodeById.get(hottestId) : undefined;
  const firstNonClient = design.nodes.find((n) => n.type !== 'client');
  const storageTarget =
    implicated.find(isShardableStorage) ??
    design.nodes.find(isShardableStorage) ??
    implicated.find(isStorage);
  const candidates: (EditOp | null)[] = [];

  switch (category) {
    case '存储过载': {
      const t = storageTarget ?? hottest ?? firstNonClient;
      if (t && isShardableStorage(t)) {
        if (t.settings.sharded !== true) {
          candidates.push({ op: 'setSetting', nodeId: t.id, key: 'sharded', value: true });
        }
        const rr = typeof t.settings.readReplicas === 'number' ? t.settings.readReplicas : 0;
        if (rr < 8) candidates.push({ op: 'setSetting', nodeId: t.id, key: 'readReplicas', value: rr + 1 });
      }
      if (t) candidates.push(capacityStepUp(t));
      break;
    }
    case '读到旧数据': {
      const t = storageTarget ?? hottest;
      if (t && isShardableStorage(t) && t.settings.consistency !== 'strong') {
        candidates.push({ op: 'setSetting', nodeId: t.id, key: 'consistency', value: 'strong' });
      }
      if (t) candidates.push(capacityStepUp(t));
      break;
    }
    case '队列积压': {
      const worker = implicated.find((n) => n.type === 'worker') ?? design.nodes.find((n) => n.type === 'worker');
      const queue = implicated.find((n) => n.type === 'queue') ?? design.nodes.find((n) => n.type === 'queue');
      if (worker) candidates.push(replicasStep(worker, 1), capacityStepUp(worker));
      if (queue) candidates.push(capacityStepUp(queue));
      break;
    }
    case '成本超标': {
      const t = hottest ?? implicated[0];
      if (t) candidates.push(replicasStep(t, -1), capacityStepDown(t));
      break;
    }
    case '热点过载':
    case 'P99 超标': {
      const t = hottest ?? implicated[0] ?? firstNonClient;
      if (t) candidates.push(capacityStepUp(t), replicasStep(t, 1));
      break;
    }
    case '错误率超标': {
      const spofIsh = /单点|故障|宕机|冗余|可用性/.test(text);
      const t = implicated[0] ?? hottest ?? firstNonClient;
      if (t && spofIsh) candidates.push(replicasStep(t, 1), capacityStepUp(t));
      else if (t) candidates.push(capacityStepUp(t), replicasStep(t, 1));
      break;
    }
    default: {
      const t = hottest ?? implicated[0] ?? firstNonClient;
      if (t) candidates.push(capacityStepUp(t), replicasStep(t, 1));
      break;
    }
  }
  for (const cand of candidates) {
    if (!cand) continue;
    const valid = validateEditOps([cand], design);
    if (valid.length) return valid;
  }
  return [];
}

/**
 * Ladder step 4 (architecture): the always-constructible remedy. One
 * capacity step (or replica step) on the most-implicated node; for a
 * design whose only node is the client — which has NO tunable settings —
 * an addComponent behind the client, which is constructible whenever
 * the design has ≥1 node at all. Empty designs get nothing (there is
 * literally nothing to act on) and are reported as such.
 */
export function universalArchFallback(design: Design, hottestId: string | null): EditOp[] {
  if (!design.nodes.length) return [];
  const nodeById = new Map(design.nodes.map((n) => [n.id, n]));
  const degree = new Map<string, number>();
  for (const e of design.edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const ordered: DesignNode[] = [];
  const hot = hottestId ? nodeById.get(hottestId) : undefined;
  if (hot && hot.type !== 'client') ordered.push(hot);
  const rest = design.nodes
    .filter((n) => n.type !== 'client' && n.id !== hot?.id)
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0));
  ordered.push(...rest);
  for (const node of ordered) {
    for (const cand of [capacityStepUp(node), replicasStep(node, 1)]) {
      if (!cand) continue;
      const valid = validateEditOps([cand], design);
      if (valid.length) return valid;
    }
  }
  // Degenerate designs (client only, or every knob maxed): inserting a
  // service node behind an existing node is always constructible.
  const anchor = design.nodes.find((n) => componentDef(n.type).behavior === 'source') ?? design.nodes[0]!;
  const insert: EditOp = {
    op: 'addComponent',
    componentType: 'appserver',
    connectFromId: anchor.id,
    newNodeId: 'fix-fallback-app',
  };
  return validateEditOps([insert], design);
}

// ---------------------------------------------------------- arch ladder -

interface ArchWork {
  kind: 'finding' | 'probe';
  title: string;
  detail: string;
  category?: string;
  componentIds: string[];
  rawActions?: EditOp[];
  rawSource?: ActionSource;
  nonMechanicalReason?: NonMechanicalReason;
  actions?: EditOp[];
  actionSource?: ActionSource;
  escaped: boolean;
}

interface ArchLadderOpts {
  /** Provenance of surviving first-pass actions ('llm' | 'rule'). */
  baseSource: ActionSource;
  repairCall?: RepairCall | null;
  problem?: ProblemDef;
  problemName: string;
  designSummary?: string;
}

async function runArchLadder(
  work: ArchWork[],
  design: Design,
  opts: ArchLadderOpts,
): Promise<ActionCoverage> {
  const coverage = emptyCoverage();
  const hottestId = opts.problem
    ? (measureHottestNodeId(opts.problem, design) ?? heuristicHottestNodeId(design))
    : heuristicHottestNodeId(design);

  let lacking: ArchWork[] = [];
  for (const w of work) {
    const valid = validateEditOps(w.rawActions, design);
    if (valid.length) {
      w.actions = valid;
      w.actionSource = w.rawSource ?? opts.baseSource;
      continue;
    }
    if (w.nonMechanicalReason && !hasLoadOrCorrectnessSignal(`${w.title} ${w.detail}`)) {
      w.escaped = true;
      continue;
    }
    lacking.push(w);
  }

  // Step 2 — one bounded repair call for everything still lacking.
  if (opts.repairCall && lacking.length) {
    const items: ActionRepairItem[] = lacking.map((w, i) => ({
      index: i,
      kind: w.kind,
      title: w.title,
      detail: w.detail,
      errors: diagnoseEditOps(w.rawActions, design),
    }));
    let repairs: Map<number, ParsedRepair> = new Map();
    try {
      const json = await opts.repairCall(
        buildActionRepairPrompt({
          problemName: opts.problemName,
          items,
          legalArch: legalArchVocab(design),
          ...(opts.designSummary ? { designSummary: opts.designSummary } : {}),
        }),
      );
      if (json) repairs = parseActionRepair(json);
    } catch {
      repairs = new Map(); // a failed repair call degrades to synthesis
    }
    const still: ArchWork[] = [];
    lacking.forEach((w, i) => {
      const r = repairs.get(i);
      const valid = r?.archActions ? validateEditOps(r.archActions, design) : [];
      if (valid.length) {
        w.actions = valid;
        w.actionSource = 'repaired';
      } else {
        still.push(w);
      }
    });
    lacking = still;
  }

  // Steps 3 + 4 — deterministic synthesis, then the universal fallback.
  for (const w of lacking) {
    const text = `${w.title} ${w.detail}`;
    const synth = synthesizeArchByCategory(
      w.category ?? inferCategory(text),
      text,
      design,
      w.componentIds,
      hottestId,
    );
    if (synth.length) {
      w.actions = synth;
      w.actionSource = 'rule';
      continue;
    }
    const fb = universalArchFallback(design, hottestId);
    if (fb.length) {
      w.actions = fb;
      w.actionSource = 'fallback';
    }
  }

  return tally(coverage, work);
}

/** Guarantee actions on submission-assessment findings (mutates copies). */
export async function guaranteeFindingActions(
  findings: DriverFinding[],
  design: Design,
  opts: ArchLadderOpts,
): Promise<{ findings: DriverFinding[]; coverage: ActionCoverage }> {
  const work: ArchWork[] = findings.map((f) => ({
    kind: 'finding',
    title: f.title,
    detail: f.detail,
    componentIds: f.componentId ? [f.componentId] : [],
    rawActions: f.actions,
    ...(f.actionSource ? { rawSource: f.actionSource } : {}),
    ...(f.nonMechanicalReason ? { nonMechanicalReason: f.nonMechanicalReason } : {}),
    escaped: false,
  }));
  const coverage = await runArchLadder(work, design, opts);
  const out = findings.map((f, i) => {
    const w = work[i]!;
    const next: DriverFinding = { ...f };
    if (w.actions?.length) {
      next.actions = w.actions;
      next.actionSource = w.actionSource;
    } else {
      delete next.actions;
      delete next.actionSource;
    }
    return next;
  });
  return { findings: out, coverage };
}

/**
 * Guarantee actions on probe predictions. Only willFail predictions are
 * assessed — a prediction of a pass needs no fix, and forcing a fallback
 * remedy onto a passing probe would be nonsense.
 */
export async function guaranteePredictionActions(
  cases: ProbeCase[],
  design: Design,
  opts: ArchLadderOpts,
): Promise<{ cases: ProbeCase[]; coverage: ActionCoverage }> {
  const work: ArchWork[] = [];
  const workIndexByCase: number[] = [];
  cases.forEach((pc, ci) => {
    if (!pc.prediction.willFail) return;
    const implicated = design.nodes
      .filter(
        (n) =>
          pc.scenario.kills.includes(n.type) ||
          pc.scenario.events.some((e) => e.targetType === n.type),
      )
      .map((n) => n.id);
    workIndexByCase[ci] = work.length;
    work.push({
      kind: 'probe',
      title: pc.name,
      detail: `${pc.prediction.rationale} ${pc.prediction.fixHint}`.trim(),
      category: pc.prediction.primaryBreach,
      componentIds: implicated,
      rawActions: pc.prediction.actions,
      ...(pc.prediction.actionSource ? { rawSource: pc.prediction.actionSource } : {}),
      escaped: false,
    });
  });
  const coverage = await runArchLadder(work, design, opts);
  const out = cases.map((pc, ci) => {
    const wi = workIndexByCase[ci];
    if (wi === undefined) return pc;
    const w = work[wi]!;
    const prediction = { ...pc.prediction };
    if (w.actions?.length) {
      prediction.actions = w.actions;
      prediction.actionSource = w.actionSource;
    } else {
      delete prediction.actions;
      delete prediction.actionSource;
    }
    return { ...pc, prediction };
  });
  return { cases: out, coverage };
}

/**
 * The verify-probes end of the guarantee: predictions round-tripped
 * through the client, so their actions are re-validated here; willFail
 * predictions whose actions did not survive get rule synthesis, then
 * the universal fallback (no repair call — verification stays a pure
 * simulation step; the repair pass already ran at propose time).
 */
export function ensureVerifiedActions(
  results: VerifiedProbeResult[],
  problem: ProblemDef,
  design: Design,
): { results: VerifiedProbeResult[]; coverage: ActionCoverage } {
  const coverage = emptyCoverage();
  const hottestId =
    measureHottestNodeId(problem, design) ?? heuristicHottestNodeId(design);
  const tallied: { actions?: EditOp[]; actionSource?: ActionSource; escaped: boolean }[] = [];
  const out = results.map((r) => {
    const pred = r.prediction;
    if (!pred.willFail) return r;
    const valid = validateEditOps(pred.actions, design);
    if (valid.length) {
      tallied.push({ actions: valid, actionSource: pred.actionSource ?? 'llm', escaped: false });
      return { ...r, prediction: { ...pred, actions: valid } };
    }
    const implicated = design.nodes
      .filter(
        (n) =>
          (r.scenario?.kills ?? []).some((k) => k.componentType === n.type) ||
          (r.scenario?.events ?? []).some((e) => e.targetType === n.type),
      )
      .map((n) => n.id);
    const text = `${r.name} ${pred.rationale} ${pred.fixHint}`;
    let actions = synthesizeArchByCategory(pred.primaryBreach, text, design, implicated, hottestId);
    let source: ActionSource = 'rule';
    if (!actions.length) {
      actions = universalArchFallback(design, hottestId);
      source = 'fallback';
    }
    tallied.push({
      ...(actions.length ? { actions, actionSource: source } : {}),
      escaped: false,
    });
    if (!actions.length) return r;
    return { ...r, prediction: { ...pred, actions, actionSource: source } };
  });
  tally(coverage, tallied);
  return { results: out, coverage };
}

// -------------------------------------------------------- schema ladder -

const MONOTONIC_KEYS = new Set(['id', 'created_at', 'timestamp', 'auto_id', 'seq']);

/** Shard-field choice for synthesis: the PK when it is a real,
 *  non-monotonic field; else the most "key-like" indexed field; else PK. */
function chooseShardField(table: ProblemSchema['tables'][number]): string | null {
  const fieldNames = new Set(table.fields.map((f) => f.name));
  if (fieldNames.has(table.primaryKey) && !MONOTONIC_KEYS.has(table.primaryKey)) {
    return table.primaryKey;
  }
  const indexed = table.fields.find((f) => f.indexed && !MONOTONIC_KEYS.has(f.name));
  if (indexed) return indexed.name;
  return fieldNames.has(table.primaryKey) ? table.primaryKey : (table.fields[0]?.name ?? null);
}

/**
 * Deterministic schema synthesis: dimension/category signals in the
 * suggestion text + the checker's per-pattern verdicts (full scans,
 * cross-shard broadcasts) mapped to the standard remedy on the
 * implicated table. Conservative choices only.
 */
function synthesizeSchemaActions(
  text: string,
  schema: ProblemSchema,
  report?: SchemaReviewReport,
): SchemaOp[] {
  const candidates: SchemaOp[] = [];
  const mentioned = schema.tables.filter((t) => text.includes(t.name));
  const firstTable = mentioned[0] ?? schema.tables[0];

  // Per-pattern remedies from the checker's deterministic verdicts.
  if (report) {
    for (const p of report.perPattern) {
      if (p.verdict === '通过') continue;
      const pattern = schema.accessPatterns.find((a) => a.id === p.patternId);
      const table = schema.tables.find((t) => t.name === p.table);
      if (!pattern || !table) continue;
      const relevant =
        mentioned.includes(table) || text.includes(p.name) || /全表扫描|跨分片|索引|分片/.test(text);
      if (!relevant) continue;
      if (p.path === '全表扫描') {
        candidates.push({ op: 'addIndex', table: table.name, field: pattern.byField });
      } else if (p.path === '跨分片广播') {
        candidates.push({ op: 'setShardKey', table: table.name, field: pattern.byField });
      }
    }
  }

  // Scalability: a huge unsharded table gets a shard key.
  if (/扩展|分片|单机|规模/.test(text)) {
    for (const t of mentioned.length ? mentioned : schema.tables) {
      if (t.rows >= 100_000_000 && !t.shardKey) {
        const field = chooseShardField(t);
        if (field) candidates.push({ op: 'setShardKey', table: t.name, field });
      }
      if (t.shardKey && MONOTONIC_KEYS.has(t.shardKey)) {
        const field = chooseShardField(t);
        if (field && field !== t.shardKey) {
          candidates.push({ op: 'setShardKey', table: t.name, field });
        }
      }
      if (t.primaryKeyGen === 'auto' && t.rows >= 1_000_000_000) {
        candidates.push({ op: 'setPrimaryKeyGen', table: t.name, gen: 'snowflake' });
      }
    }
  }

  // Latency: a full-scan phrasing without per-pattern data — index the
  // field the text names, on the implicated table.
  if (!candidates.length && /全表扫描|没有索引|无索引|加索引/.test(text) && firstTable) {
    const field = firstTable.fields.find((f) => text.includes(f.name) && !f.indexed);
    if (field) candidates.push({ op: 'addIndex', table: firstTable.name, field: field.name });
  }

  for (const cand of candidates) {
    const valid = validateSchemaOps([cand], schema);
    if (valid.length) return valid;
  }
  // A combination may validate where singles were no-ops in sequence.
  return candidates.length ? validateSchemaOps(candidates, schema) : [];
}

/**
 * Ladder step 4 (schema): always constructible for any schema with ≥1
 * table — index the first table's primary key; failing that its first
 * unindexed field; failing that change its PK generation (a table's gen
 * always differs from at least one legal value); failing that flip its
 * engine. An empty schema (no tables) is the only dead end.
 */
export function universalSchemaFallback(schema: ProblemSchema): SchemaOp[] {
  const table = schema.tables[0];
  if (!table) return [];
  const attempts: SchemaOp[] = [
    { op: 'addIndex', table: table.name, field: table.primaryKey },
    ...table.fields.map(
      (f): SchemaOp => ({ op: 'addIndex', table: table.name, field: f.name }),
    ),
    {
      op: 'setPrimaryKeyGen',
      table: table.name,
      gen: table.primaryKeyGen === 'snowflake' ? 'uuid' : 'snowflake',
    },
    { op: 'setEngine', table: table.name, engine: table.engine === 'relational' ? 'nosql' : 'relational' },
  ];
  for (const cand of attempts) {
    const valid = validateSchemaOps([cand], schema);
    if (valid.length) return valid;
  }
  return [];
}

interface SchemaLadderOpts {
  baseSource: ActionSource;
  repairCall?: RepairCall | null;
  problemName: string;
  /** The checker's full schema report, when the server computed it. */
  report?: SchemaReviewReport;
  schemaSummary?: string;
}

/** Why a batch of proposed schema-ops did not survive validation. */
export function diagnoseSchemaOps(
  ops: readonly SchemaOp[] | undefined,
  schema: ProblemSchema,
): string[] {
  if (!ops?.length) return ['没有给出 actions（动作保证要求每条建议都带合法 schema 动作）'];
  const valid = validateSchemaOps(ops, schema);
  if (valid.length >= ops.length) return [];
  const errors: string[] = [];
  for (const op of ops) {
    if (valid.some((v) => JSON.stringify(v) === JSON.stringify(op))) continue;
    const table = schema.tables.find((t) => t.name === op.table);
    if (!table) {
      errors.push(`表「${op.table}」不存在（表名必须抄 schema 里真实出现的）`);
    } else if (op.op === 'addIndex') {
      const field = table.fields.find((f) => f.name === op.field);
      errors.push(
        !field
          ? `表 ${op.table} 没有字段「${op.field}」`
          : `字段「${op.field}」已经有索引了（重复加索引是无效动作）`,
      );
    } else if (op.op === 'setShardKey') {
      errors.push(
        op.field !== null && !table.fields.some((f) => f.name === op.field)
          ? `表 ${op.table} 没有字段「${op.field}」，不能作分片键`
          : `分片键已经是 ${op.field ?? '无'}（重复设置是无效动作）`,
      );
    } else if (op.op === 'setPrimaryKeyGen') {
      errors.push(`主键生成已经是 ${op.gen}（重复设置是无效动作）`);
    } else {
      errors.push(`存储引擎已经是 ${op.engine}（重复设置是无效动作）`);
    }
  }
  return errors.length ? errors : ['schema 动作未通过服务端校验'];
}

/**
 * Guarantee actions on schema-assessment suggestions. When no schema was
 * submitted there is nothing to validate or synthesize against — actions
 * are stripped and the coverage honestly reports zero (the real app
 * always submits its schema; signals-only callers get text only).
 */
export async function guaranteeSchemaActions(
  suggestions: SchemaSuggestion[],
  schema: ProblemSchema | undefined,
  opts: SchemaLadderOpts,
): Promise<{ suggestions: SchemaSuggestion[]; coverage: ActionCoverage }> {
  const coverage = emptyCoverage();
  if (!schema) {
    const out = suggestions.map((s) => {
      const next = { ...s };
      delete next.actions;
      delete next.actionSource;
      return next;
    });
    coverage.findings = suggestions.length;
    return { suggestions: out, coverage };
  }

  interface Work {
    text: string;
    rawActions?: SchemaOp[];
    nonMechanicalReason?: NonMechanicalReason;
    actions?: SchemaOp[];
    actionSource?: ActionSource;
    escaped: boolean;
  }
  const work: Work[] = suggestions.map((s) => ({
    text: s.text,
    rawActions: s.actions,
    ...(s.nonMechanicalReason ? { nonMechanicalReason: s.nonMechanicalReason } : {}),
    escaped: false,
  }));

  let lacking: Work[] = [];
  for (const w of work) {
    const valid = validateSchemaOps(w.rawActions, schema);
    if (valid.length) {
      w.actions = valid;
      w.actionSource = opts.baseSource;
      continue;
    }
    if (w.nonMechanicalReason && !hasLoadOrCorrectnessSignal(w.text)) {
      w.escaped = true;
      continue;
    }
    lacking.push(w);
  }

  if (opts.repairCall && lacking.length) {
    const items: ActionRepairItem[] = lacking.map((w, i) => ({
      index: i,
      kind: 'schema',
      title: w.text.slice(0, 80),
      detail: w.text,
      errors: diagnoseSchemaOps(w.rawActions, schema),
    }));
    let repairs: Map<number, ParsedRepair> = new Map();
    try {
      const json = await opts.repairCall(
        buildActionRepairPrompt({
          problemName: opts.problemName,
          items,
          legalSchema: legalSchemaVocab(schema),
          ...(opts.schemaSummary ? { schemaSummary: opts.schemaSummary } : {}),
        }),
      );
      if (json) repairs = parseActionRepair(json);
    } catch {
      repairs = new Map();
    }
    const still: Work[] = [];
    lacking.forEach((w, i) => {
      const r = repairs.get(i);
      const valid = r?.schemaActions ? validateSchemaOps(r.schemaActions, schema) : [];
      if (valid.length) {
        w.actions = valid;
        w.actionSource = 'repaired';
      } else {
        still.push(w);
      }
    });
    lacking = still;
  }

  for (const w of lacking) {
    const synth = synthesizeSchemaActions(w.text, schema, opts.report);
    if (synth.length) {
      w.actions = synth;
      w.actionSource = 'rule';
      continue;
    }
    const fb = universalSchemaFallback(schema);
    if (fb.length) {
      w.actions = fb;
      w.actionSource = 'fallback';
    }
  }

  tally(coverage, work);
  const out = suggestions.map((s, i) => {
    const w = work[i]!;
    const next: SchemaSuggestion = { ...s };
    if (w.actions?.length) {
      next.actions = w.actions;
      next.actionSource = w.actionSource;
    } else {
      delete next.actions;
      delete next.actionSource;
    }
    return next;
  });
  return { suggestions: out, coverage };
}
