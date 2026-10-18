import { COMPONENT_MAP, type ComponentTypeId } from '@sds/components';
import type { EventType, TrafficConfig } from '@sds/sim-core';

/**
 * The Driver contract.
 *
 * A Driver is whoever "operates" the simulator: it observes metrics through
 * the SimulatorTools interface, acts on the design (traffic, events, kills),
 * and finishes with a review. The simulator core never knows which driver is
 * attached — ScriptedDriver (offline, deterministic), OpenAICompatibleDriver
 * (cloud API, the user's chosen default) and OllamaDriver (local fallback)
 * all implement the exact same contract.
 */

export interface CaseMeasuredLike {
  errorRate: number;
  p99Ms: number;
  costPerHour: number;
  maxStorageQps: number;
  staleReadRate: number;
  hottestUtil: number;
  queueDepthMax: number;
}

export interface CaseResultLike {
  caseId: string;
  name: string;
  passed: boolean;
  failures: string[];
  measured: CaseMeasuredLike;
}

export interface SchemaFindingLike {
  dimension: '需求覆盖' | '延迟风险' | '扩展性';
  severity: 'high' | 'medium' | 'low';
  text: string;
}

export interface SchemaReviewLike {
  score: number;
  coverage: string;
  coveragePassed?: number;
  coverageTotal?: number;
  findings: SchemaFindingLike[];
  perPattern: { pattern: string; path: string; latencyMs: number; verdict: string; note?: string }[];
}

/** The tool surface every driver drives. Implemented in @sds/checker. */
export interface SimulatorTools {
  setTraffic(patch: Partial<TrafficConfig>): Promise<string>;
  injectEvent(e: {
    type: EventType;
    targetType?: ComponentTypeId;
    magnitude?: number;
    durationTicks?: number;
  }): Promise<string>;
  killNode(a: { componentId?: string; componentType?: ComponentTypeId }): Promise<string>;
  reviveNode(a: { componentId?: string; componentType?: ComponentTypeId }): Promise<string>;
  /** Global snapshot, or one node's metrics when componentId is given. */
  readMetrics(a?: { componentId?: string }): Promise<Record<string, unknown>>;
  highlight(a: { componentId: string; reason: string }): Promise<string>;
  runTestCase(a: { caseId: string }): Promise<CaseResultLike>;
  reviewSchema(): Promise<SchemaReviewLike>;
}

export type ToolName = keyof SimulatorTools;

export interface StructuralFindingLike {
  ruleId: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  componentIds: string[];
  /** Canned fix, when the rule implies one unambiguously (validated ops). */
  actions?: EditOp[];
}

// ------------------------------------------------------- edit operations ---
//
// The fix loop's vocabulary. A finding (LLM-written or rule-generated) may
// carry a small list of STRUCTURED edits the user can apply to the design
// in one click — after a highlighted preview and an explicit confirm. The
// vocabulary is deliberately tiny and safe: tweak a setting, insert a
// component between two existing nodes, or add one edge. No deletes.
//
// Two layers of defense:
//  - sanitizeEditOps (here) checks SHAPE only — op kinds, field types.
//  - validateEditOps (@sds/checker) checks SEMANTICS against the concrete
//    design the finding was generated for — node existence, which setting
//    keys are legal for that component type, value ranges — and drops
//    invalid ops individually. Only validated ops ever reach the frontend
//    as applicable actions.

export type EditOp =
  | { op: 'setSetting'; nodeId: string; key: string; value: string | number | boolean }
  | {
      op: 'addComponent';
      componentType: ComponentTypeId;
      /** Wire the new node after this existing node (optional). */
      connectFromId?: string;
      /** Wire the new node before this existing node (optional). When BOTH
       *  endpoints are given and a direct edge between them exists, that
       *  edge is replaced by the two hops through the new node. */
      connectToId?: string;
      /**
       * The id the created node will carry. Declaring it lets a LATER op
       * in the same list reference the new node — chained inserts, e.g.
       * insert a queue (newNodeId "q1") and then the worker consuming it
       * (connectFromId "q1"). Validation adopts a legal, collision-free
       * declared id or assigns one itself; either way the validated op
       * carries the id and apply honors it verbatim, so a chain is wired
       * exactly as validated.
       */
      newNodeId?: string;
    }
  | { op: 'addEdge'; fromId: string; toId: string };

export const MAX_EDIT_OPS = 3;

// ------------------------------------------------- action guarantee -------
//
// The action-guarantee ladder (server-side, apps/server actions.ts): EVERY
// finding / probe fix / schema suggestion that reaches the UI must carry
// at least one server-validated, applicable action. Actions are tagged
// with their provenance so the UI can show the user where a fix came from:
//
//   llm      — proposed by the model in its first pass, validated as-is;
//   repaired — produced by the ONE bounded action-repair re-prompt after
//              the first pass's actions were missing or failed validation;
//   rule     — synthesized deterministically from the finding's category
//              (the same spirit as the checker's canned fixes; scripted-
//              mode findings also land here — they derive from rules);
//   fallback — the universal, always-constructible remedy (one capacity
//              step on the most-implicated node / first table's key).

export type ActionSource = 'llm' | 'repaired' | 'rule' | 'fallback';

export const ACTION_SOURCES: readonly ActionSource[] = ['llm', 'repaired', 'rule', 'fallback'];

/**
 * Per-evaluation action accounting, carried on evaluate responses and in
 * the call log. `findings` counts the items that were assessed (probe
 * predictions count only when they predict failure — a passing prediction
 * needs no fix); `withActions` how many of them ship ≥1 validated action;
 * `bySource` breaks the covered ones down by provenance (sums to
 * withActions); `nonMechanical` counts the narrow escape below — items
 * the model explicitly declared non-mechanical whose declaration SURVIVED
 * (pure tradeoff/explanation commentary with no load/correctness signal).
 * Those are excluded from `findings`, so findings === withActions is the
 * guarantee for everything that remains.
 */
export interface ActionCoverage {
  findings: number;
  withActions: number;
  bySource: { llm: number; repaired: number; rule: number; fallback: number };
  nonMechanical: number;
}

/**
 * The non-mechanical escape hatch — deliberately narrow. A finding may
 * declare itself non-mechanical ONLY with one of these reasons, and the
 * declaration survives only when the finding carries no load/correctness
 * signal (the ladder's synthesis runs first for anything recognizable;
 * see actions.ts). Everything else receives an action by construction.
 */
export const NON_MECHANICAL_REASONS = ['tradeoff', 'explanation', 'process'] as const;
export type NonMechanicalReason = (typeof NON_MECHANICAL_REASONS)[number];

// ------------------------------------------------------- schema operations -
//
// The schema-side sibling of the edit-op vocabulary: the small set of
// mutations a schema suggestion may propose against the submitted schema
// draft. Same two-layer defense as edit-ops: sanitizeSchemaOps (here)
// checks SHAPE; validateSchemaOps (@sds/checker) checks SEMANTICS against
// the concrete schema (table/field existence, legal enums, no-op drops).

export type SchemaOp =
  | { op: 'setShardKey'; table: string; field: string | null }
  | { op: 'addIndex'; table: string; field: string }
  | { op: 'setPrimaryKeyGen'; table: string; gen: 'auto' | 'snowflake' | 'uuid' | 'business' }
  | { op: 'setEngine'; table: string; engine: 'relational' | 'nosql' };

export const MAX_SCHEMA_OPS = 3;

const SCHEMA_PK_GENS: readonly string[] = ['auto', 'snowflake', 'uuid', 'business'];
const SCHEMA_ENGINES: readonly string[] = ['relational', 'nosql'];

/** Shape-level sanitation of a raw schema-actions array. */
export function sanitizeSchemaOps(raw: unknown): SchemaOp[] {
  if (!Array.isArray(raw)) return [];
  const out: SchemaOp[] = [];
  for (const item of raw) {
    if (out.length >= MAX_SCHEMA_OPS) break;
    const o = item as Record<string, unknown> | null;
    if (!o || typeof o !== 'object' || typeof o.table !== 'string' || !o.table.trim()) continue;
    const table = o.table.trim();
    if (o.op === 'setShardKey') {
      if (o.field === null) out.push({ op: 'setShardKey', table, field: null });
      else if (typeof o.field === 'string' && o.field.trim()) {
        out.push({ op: 'setShardKey', table, field: o.field.trim() });
      }
    } else if (o.op === 'addIndex') {
      if (typeof o.field === 'string' && o.field.trim()) {
        out.push({ op: 'addIndex', table, field: o.field.trim() });
      }
    } else if (o.op === 'setPrimaryKeyGen') {
      if (SCHEMA_PK_GENS.includes(String(o.gen))) {
        out.push({ op: 'setPrimaryKeyGen', table, gen: String(o.gen) as SchemaOp extends { gen: infer G } ? G : never });
      }
    } else if (o.op === 'setEngine') {
      if (SCHEMA_ENGINES.includes(String(o.engine))) {
        out.push({ op: 'setEngine', table, engine: String(o.engine) as 'relational' | 'nosql' });
      }
    }
  }
  return out;
}

const isId = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** Shape-level sanitation of a raw actions array (see the note above). */
export function sanitizeEditOps(raw: unknown): EditOp[] {
  if (!Array.isArray(raw)) return [];
  const out: EditOp[] = [];
  for (const item of raw) {
    if (out.length >= MAX_EDIT_OPS) break;
    const o = item as Record<string, unknown> | null;
    if (!o || typeof o !== 'object') continue;
    if (o.op === 'setSetting') {
      const v = o.value;
      if (
        isId(o.nodeId) &&
        isId(o.key) &&
        (typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))
      ) {
        out.push({ op: 'setSetting', nodeId: String(o.nodeId), key: String(o.key), value: v as string | number | boolean });
      }
    } else if (o.op === 'addComponent') {
      if (!(COMPONENT_TYPE_IDS as readonly string[]).includes(String(o.componentType))) continue;
      const from = isId(o.connectFromId) ? String(o.connectFromId) : undefined;
      const to = isId(o.connectToId) ? String(o.connectToId) : undefined;
      if (!from && !to) continue;
      if (from && to && from === to) continue;
      const newNodeId = isId(o.newNodeId) ? String(o.newNodeId) : undefined;
      out.push({
        op: 'addComponent',
        componentType: String(o.componentType) as ComponentTypeId,
        ...(from ? { connectFromId: from } : {}),
        ...(to ? { connectToId: to } : {}),
        ...(newNodeId ? { newNodeId } : {}),
      });
    } else if (o.op === 'addEdge') {
      if (isId(o.fromId) && isId(o.toId) && o.fromId !== o.toId) {
        out.push({ op: 'addEdge', fromId: String(o.fromId), toId: String(o.toId) });
      }
    }
  }
  return out;
}

export interface DriverContext {
  problemName: string;
  problemStatement: string;
  scaleNotes: string;
  /** Human-readable summary of the submitted design graph. */
  designSummary: string;
  structuralFindings: StructuralFindingLike[];
  availableCases: { id: string; name: string; hidden: boolean }[];
}

export interface DriverFinding {
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  componentId?: string;
  /**
   * One-click fix in the edit-op vocabulary. Under the action guarantee
   * (see the ladder note at ActionSource) a finding ships with ≥1 action
   * whenever one is constructible at all: the model is REQUIRED to
   * propose actions, and the server repairs / synthesizes / falls back
   * until one validates against the submitted design.
   */
  actions?: EditOp[];
  /** Provenance of `actions` (the UI renders it next to the apply button). */
  actionSource?: ActionSource;
  /**
   * The model's non-mechanical declaration, when it made one and the
   * declaration survived the ladder (see NON_MECHANICAL_REASONS).
   */
  nonMechanicalReason?: NonMechanicalReason;
}

export interface DriverReview {
  summary: string;
  findings: DriverFinding[];
  /** Step-by-step log of what the driver did (tool calls + observations). */
  transcript: string[];
}

export type DriverKind = 'scripted' | 'openai' | 'ollama';

// ------------------------------------------------------ assessment layer ---
//
// Division of labour (settled architecture):
//  - HARD verdicts stay in code (@sds/checker): per-case pass/fail against
//    P99 / error-rate / cost thresholds, suite score, deterministic rule
//    signals (structural findings, schema path/latency verdicts). Fair and
//    reproducible; no LLM involved.
//  - QUALITATIVE assessment goes through this Driver layer and is produced
//    by an LLM when one is attached: the post-submission review and score
//    rationale, deep-dive follow-up questions generated from THIS design,
//    schema conclusions and improvement suggestions, explanations of the
//    structural bugs. ScriptedDriver is the offline fallback implementing
//    the exact same interface from the deterministic signals, so the UI
//    never contains scripted review copy of its own — it only renders what
//    a Driver returns.

export type FollowUpLevel = '基础' | '进阶' | '追问' | '故障';

export interface FollowUpQuestion {
  level: FollowUpLevel;
  question: string;
  /** 考点 / reference points, revealed after the user thinks first. */
  keyPoints: string[];
}

/**
 * Everything a follow-up generator may look at. The questions must be about
 * THIS candidate's design, not a generic question bank: the design graph
 * (components, wiring, per-component settings), the DB schema choices, this
 * problem's read/write workload landing on the component, and the judging
 * signals (which cases failed, which structural rules fired).
 */
export interface FollowUpContext {
  problemName: string;
  componentType: ComponentTypeId;
  componentName: string;
  /** Human-readable settings of this component instance (replicas, shard key, rate limit…). */
  componentSettingsSummary: string;
  /** Live metrics line for this component, when the simulation is running. */
  liveMetricsSummary?: string;
  /** Component types directly upstream of this node in the user's design. */
  upstreamTypes: ComponentTypeId[];
  /** Whole-design summary (components + edges). */
  designSummary: string;
  workload: {
    readRatio: number;
    consistency: string;
    /** This problem's patterns whose path includes this component type. */
    patternsHere: {
      name: string;
      kind: 'read' | 'write';
      share: number;
      description: string;
      consistency: 'strong' | 'eventual';
    }[];
    /** Fraction (0..1) of the patternsHere traffic that is reads. */
    readShareHere: number;
  };
  /** Schema facts (tables, shard keys, PK generation) for storage components. */
  schemaSummary?: string;
  /** Judging signals: failed cases (all, most relevant first)… */
  failedCases: { id: string; name: string; failures: string[] }[];
  /** …and structural findings touching this component. */
  structuralFindings: StructuralFindingLike[];
}

export interface SubmissionAssessmentContext {
  problemName: string;
  designSummary: string;
  workloadSummary: string;
  /** Code-judged results — ground truth the rationale must explain, not change. */
  scorePct: number;
  passed: number;
  total: number;
  cases: CaseResultLike[];
  structuralFindings: StructuralFindingLike[];
  /**
   * Verified probe results (LLM-proposed cases, run through the simulator).
   * When present and non-empty, the assessment grounds on THESE instead of
   * the static per-case dump: the static cases are the fairness baseline
   * for the score, but they are no longer briefed to the LLM.
   */
  probeResults?: VerifiedProbeResult[];
}

// ------------------------------------------------------------- probing ---
//
// The probe step inverts the old data flow. Instead of briefing the LLM
// with the static suite's results and asking it to explain them, the LLM
// is given the judging CRITERIA and this design, and must PROPOSE its own
// failure cases — each with a falsifiable prediction. The simulator then
// runs every proposed case and grades the prediction. The LLM proposes
// hypotheses; simulation is the arbiter.

/** The failure-category vocabulary of the judging standards. */
export const BREACH_CATEGORIES = [
  '错误率超标',
  'P99 超标',
  '成本超标',
  '存储过载',
  '热点过载',
  '读到旧数据',
  '队列积压',
] as const;
export type BreachCategory = (typeof BREACH_CATEGORIES)[number];
/** A prediction's primary breach: a category, or '无' when predicting a pass. */
export type PrimaryBreach = BreachCategory | '无';

/**
 * The judging standards handed to the prober (NOT the test cases). This is
 * the house rubric: category vocabulary, what thresholds conventionally
 * mean, and what the simulation engine can actually execute.
 */
export const PROBE_CRITERIA = `评判标准（本系统的口径，提用例与做预测都按这套来）：
- 失败类别词表（primaryBreach 只能取其一，或预测通过时取「无」）：错误率超标（错误率高于阈值）/ P99 超标（P99 延迟高于阈值）/ 成本超标（每小时成本高于阈值）/ 存储过载（存储层入站 QPS 高于阈值）/ 热点过载（最热组件利用率高于阈值）/ 读到旧数据（读到旧数据比例高于阈值）/ 队列积压（队列最大积压高于阈值）。
- 阈值口径：基线场景错误率应 <0.1%、P99 <500ms；峰值/事件场景错误率 <1%、P99 <1000ms 算合格；成本红线取题目预算；最热组件利用率红线 98%；读旧比例红线 5%。你给每个用例设的阈值就是判卷线，偏离口径要有理由。
- 场景能力（超出范围会被系统截断）：流量倍数 trafficMultiplier 0.2–10（相对题目基线 RPS）；时长 durationSec 10–120（1 tick ≈ 1 秒）；readRatio 可选（0–1，改读写比）；events 可选，类型只能取 viral_post（网红爆帖，写扩散）/ cache_stampede（缓存雪崩）/ hot_key（热点 key）/ peak（流量峰值）/ rw_flip（读写比翻转），可带 targetType（组件类型）与 magnitude（1–10）；kills 可选，按组件类型杀节点测故障转移。
- 预测必须可证伪：willFail 与 primaryBreach 要与 rationale 一致，rationale 必须指向这份设计里的具体结构（哪一层缺什么、为什么这个场景会先打爆它），不许泛泛而谈。`;

export interface ProbeScenarioSpec {
  /** Multiplier over the problem's baseline RPS, 0.2–10. */
  trafficMultiplier: number;
  /** Run length in ticks (≈ seconds), 10–120. */
  durationSec: number;
  readRatio?: number;
  events: { type: EventType; targetType?: ComponentTypeId; magnitude?: number }[];
  /** Component TYPES to kill mid-run (fault-injection by type). */
  kills: ComponentTypeId[];
}

export interface ProbeThresholds {
  p99Ms?: number;
  /** Percent (1 = 1%), unlike CaseThresholds' fraction. */
  maxErrorRatePct?: number;
  maxCostPerHour?: number;
  maxStorageQps?: number;
  /** Percent (98 = 98%). */
  maxHottestUtilPct?: number;
  /** Percent (5 = 5%). */
  maxStaleReadPct?: number;
  maxQueueDepth?: number;
}

export interface ProbePrediction {
  willFail: boolean;
  primaryBreach: PrimaryBreach;
  rationale: string;
  fixHint: string;
  /**
   * Structured form of fixHint, in the edit-op vocabulary. Required by
   * the action guarantee whenever willFail is true: the server validates
   * these against the submitted design (at propose time AND again when
   * the probe is verified), and repairs / synthesizes / falls back until
   * a failing prediction carries ≥1 applicable action. Predictions of a
   * pass carry no fix and are excluded from the coverage accounting.
   */
  actions?: EditOp[];
  /** Provenance of `actions` (the UI renders it next to the apply button). */
  actionSource?: ActionSource;
}

/** One LLM-proposed probe case, in the friendly (relative) wire shape. */
export interface ProbeCase {
  name: string;
  scenario: ProbeScenarioSpec;
  thresholds: ProbeThresholds;
  prediction: ProbePrediction;
}

/** Everything the prober may look at — note: NO static cases, NO results. */
export interface ProbeContext {
  problemName: string;
  designSummary: string;
  schemaSummary?: string;
  workloadSummary: string;
  structuralFindings: StructuralFindingLike[];
  /** Problem scale facts the scenarios are relative to. */
  baselineRps: number;
  readRatio: number;
  budgetCostPerHour: number;
  /** The design's nodes, so kills/settings can be targeted by type. */
  nodes: { id: string; type: ComponentTypeId; name: string }[];
}

export type ProbeVerdict = 'hit' | 'held' | 'miss';

/** Thresholds in checker units (fractions), as executed by the simulator. */
export interface ExecutedScenarioThresholds {
  maxErrorRate?: number;
  maxP99Ms?: number;
  maxCostPerHour?: number;
  maxStorageQps?: number;
  maxStaleReadRate?: number;
  maxHottestUtil?: number;
  maxQueueDepth?: number;
}

/**
 * A concrete, executable scenario in checker units — what the simulator
 * actually ran for a probe case, or the full scenario of a judged suite
 * case. The frontend uses it for one-click local re-simulation (visual
 * preview only, never a re-judge).
 */
export interface ExecutedScenario {
  traffic: TrafficConfig;
  durationTicks: number;
  events: {
    atTick: number;
    type: EventType;
    targetType?: ComponentTypeId;
    magnitude?: number;
    durationTicks?: number;
  }[];
  kills: { componentType: ComponentTypeId; atTick: number }[];
  thresholds: ExecutedScenarioThresholds;
}

/** A proposed case after the simulator ran it: prediction vs measured truth. */
export interface VerifiedProbeResult {
  name: string;
  /** Human-readable rendering of the executed scenario. */
  scenarioSummary: string;
  prediction: ProbePrediction;
  passed: boolean;
  measured: CaseMeasuredLike;
  failures: string[];
  /** The breach category that actually dominated, null when the case passed. */
  actualBreach: BreachCategory | null;
  /**
   * hit  = predicted fail with the right category, or predicted pass and passed;
   * held = predicted fail but the design passed anyway （设计扛住了）;
   * miss = anything else (predicted pass but failed, or wrong category).
   */
  verdict: ProbeVerdict;
  /** The scenario exactly as executed — powers local quick re-simulation. */
  scenario?: ExecutedScenario;
}

export interface SubmissionAssessment {
  summary: string;
  /** Why this score: which cases cost the most and what to fix first. */
  scoreRationale: string;
  findings: DriverFinding[];
}

export interface SchemaAssessmentContext {
  problemName: string;
  /** Human-readable schema: tables, keys, indexes, row counts. */
  schemaSummary: string;
  /** Deterministic signals from @sds/checker (paths, latencies, findings). */
  signals: SchemaReviewLike;
  /**
   * Measured summary from the schema SIMULATOR (@sds/checker
   * simulateSchema), recomputed server-side from the submitted schema —
   * never trusted from the client. When present it is the review's
   * primary numeric evidence: the workload actually ran, at current
   * scale and at ×10 data growth.
   */
  simSummary?: string;
}

/** One schema improvement suggestion, with its (guaranteed) schema-ops. */
export interface SchemaSuggestion {
  text: string;
  /**
   * The suggestion's executable form, in the schema-op vocabulary. Under
   * the action guarantee every suggestion ships with ≥1 action validated
   * against the submitted schema whenever one is constructible at all.
   */
  actions?: SchemaOp[];
  /** Provenance of `actions` (the UI renders it next to the apply button). */
  actionSource?: ActionSource;
  /** Surviving non-mechanical declaration, when the ladder allowed one. */
  nonMechanicalReason?: NonMechanicalReason;
}

export interface SchemaAssessment {
  conclusion: string;
  dimensionNotes: { dimension: '需求覆盖' | '延迟风险' | '扩展性'; note: string }[];
  suggestions: SchemaSuggestion[];
}

export interface Driver {
  readonly kind: DriverKind;
  readonly label: string;
  /** Operate the simulator through tools and review what happened. */
  review(tools: SimulatorTools, ctx: DriverContext): Promise<DriverReview>;
  /** Qualitative review of a judged submission (score itself is code-judged). */
  assessSubmission(ctx: SubmissionAssessmentContext): Promise<SubmissionAssessment>;
  /** Follow-up questions generated from this specific design snapshot. */
  generateFollowUps(ctx: FollowUpContext): Promise<FollowUpQuestion[]>;
  /** Qualitative schema conclusions on top of checker's deterministic signals. */
  assessSchema(ctx: SchemaAssessmentContext): Promise<SchemaAssessment>;
  /**
   * Propose probe cases for THIS design from the judging criteria alone
   * (no static cases are shown). The host runs them through the simulator
   * and grades the predictions.
   */
  generateProbes(ctx: ProbeContext): Promise<ProbeCase[]>;
}

/** OpenAI-style function schemas for the tool interface (LLM drivers). */
export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'set_traffic',
      description: 'Set the simulated traffic load entering the system.',
      parameters: {
        type: 'object',
        properties: {
          rps: { type: 'number', description: 'Total requests per second' },
          read_write_ratio: { type: 'number', description: 'Read fraction 0..1' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'inject_event',
      description:
        'Inject a realistic scenario event: traffic peak, viral post, cache stampede, hot key, or read/write ratio flip.',
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['peak', 'viral_post', 'cache_stampede', 'hot_key', 'rw_flip'],
          },
          target_type: { type: 'string', description: 'Component type to concentrate on (optional)' },
          magnitude: { type: 'number', description: 'Intensity multiplier, e.g. 3' },
          duration_s: { type: 'number', description: 'Duration in simulated seconds' },
        },
        required: ['type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'kill_node',
      description: 'Take a component (by id or by type) offline to test failure behavior.',
      parameters: {
        type: 'object',
        properties: {
          component_id: { type: 'string' },
          component_type: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'revive_node',
      description: 'Bring a previously killed component back online.',
      parameters: {
        type: 'object',
        properties: {
          component_id: { type: 'string' },
          component_type: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_metrics',
      description:
        'Read current metrics: global (total QPS, P99, error rate, cache hit rate, cost) or per component (inbound QPS, utilization, latency, queue depth).',
      parameters: {
        type: 'object',
        properties: { component_id: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'highlight',
      description: 'Highlight a component on the canvas and bind a review comment to it as evidence.',
      parameters: {
        type: 'object',
        properties: {
          component_id: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['component_id', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_test_case',
      description: 'Run one test case from the problem suite against the submitted design and get its verdict.',
      parameters: {
        type: 'object',
        properties: { case_id: { type: 'string' } },
        required: ['case_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'review_schema',
      description:
        'Review the database schema design: requirement coverage, latency risks and scalability problems.',
      parameters: { type: 'object', properties: {} },
    },
  },
] as const;

/** Map an LLM tool name + args onto the SimulatorTools surface. */
export async function executeToolCall(
  tools: SimulatorTools,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case 'set_traffic':
      return tools.setTraffic({
        rps: typeof args.rps === 'number' ? args.rps : undefined,
        readRatio: typeof args.read_write_ratio === 'number' ? args.read_write_ratio : undefined,
      });
    case 'inject_event':
      return tools.injectEvent({
        type: String(args.type) as EventType,
        targetType: args.target_type ? (String(args.target_type) as ComponentTypeId) : undefined,
        magnitude: typeof args.magnitude === 'number' ? args.magnitude : undefined,
        durationTicks: typeof args.duration_s === 'number' ? args.duration_s : undefined,
      });
    case 'kill_node':
      return tools.killNode({
        componentId: args.component_id ? String(args.component_id) : undefined,
        componentType: args.component_type
          ? (String(args.component_type) as ComponentTypeId)
          : undefined,
      });
    case 'revive_node':
      return tools.reviveNode({
        componentId: args.component_id ? String(args.component_id) : undefined,
        componentType: args.component_type
          ? (String(args.component_type) as ComponentTypeId)
          : undefined,
      });
    case 'read_metrics':
      return tools.readMetrics(
        args.component_id ? { componentId: String(args.component_id) } : undefined,
      );
    case 'highlight':
      return tools.highlight({
        componentId: String(args.component_id ?? ''),
        reason: String(args.reason ?? ''),
      });
    case 'run_test_case':
      return tools.runTestCase({ caseId: String(args.case_id ?? '') });
    case 'review_schema':
      return tools.reviewSchema();
    default:
      return `unknown tool: ${name}`;
  }
}

export const DRIVER_SYSTEM_PROMPT = `You are the operator and reviewer of a system-design simulator — like a senior interviewer running a mock system design interview.

You control the simulator ONLY through the provided tools. Your job:
1. Read baseline metrics first.
2. Stress the design the way reality would: raise traffic to peak, inject a viral post / cache stampede / hot key, kill a component and watch failover. Probe the design's weakest points, not random ones.
3. Read metrics after every action — never claim a bottleneck you did not measure.
4. Run at least one test case and review the database schema.
5. Finish with a review: for every problem, state WHERE the bottleneck is, WHY it happens (cite the metric you observed), and HOW to fix it. Use highlight() to bind each major finding to its component on the canvas.

Be concrete and numeric. Do not invent metrics. If the design handles a scenario well, say so.`;

// -------------------------------------------- assessment prompt builders ---
// Shared by the LLM drivers so OpenAI-compatible and Ollama produce the
// same shapes. Each returns {system, user}; parsers validate defensively
// and throw on unusable output (the host app then falls back to
// ScriptedDriver rather than rendering garbage).

export function buildFollowUpPrompt(ctx: FollowUpContext): { system: string; user: string } {
  return {
    system:
      '你是一位资深系统设计面试官，正在对候选人的设计做模块细究（follow-up）。问题必须针对这份具体设计的选择发问——他用了什么组件、怎么连线、参数怎么设、schema 怎么选、哪些用例挂了——不要问与这份设计无关的通用题。只输出 JSON，不要输出其它文字。',
    user:
      `题目：${ctx.problemName}\n` +
      `正在细究的组件：${ctx.componentName}（${ctx.componentType}），参数：${ctx.componentSettingsSummary}\n` +
      (ctx.liveMetricsSummary ? `该组件当前实时指标：${ctx.liveMetricsSummary}\n` : '') +
      `上游组件：${ctx.upstreamTypes.join('、') || '（无）'}\n\n` +
      `候选人的完整设计：\n${ctx.designSummary}\n\n` +
      `本题读写需求（总量读占比 ${Math.round(ctx.workload.readRatio * 100)}%，一致性要求：${ctx.workload.consistency}）：\n` +
      `打到这个组件的访问模式：\n${ctx.workload.patternsHere.map((p) => `- ${p.name}（${p.kind === 'read' ? '读' : '写'} · 占总流量 ${Math.round(p.share * 100)}% · ${p.consistency === 'strong' ? '强一致' : '最终一致'}）：${p.description}`).join('\n') || '（无）'}\n\n` +
      (ctx.schemaSummary ? `数据库 schema：\n${ctx.schemaSummary}\n\n` : '') +
      `判卷信号——挂掉的用例：\n${ctx.failedCases.map((c) => `- ${c.name}：${c.failures.join('；')}`).join('\n') || '（无）'}\n` +
      `与这个组件相关的结构缺陷：\n${ctx.structuralFindings.map((f) => `- [${f.severity}] ${f.title}：${f.detail}`).join('\n') || '（无）'}\n\n` +
      `生成 4-6 个 follow-up 问题，按 基础 → 进阶 → 追问 → 故障 组织，至少一半要直接引用上面这份设计的事实（参数值、挂掉的用例、schema 选择）。每题给 2-4 条考点要点（供候选人自答后对照）。\n` +
      `输出 JSON：{"questions":[{"level":"基础|进阶|追问|故障","question":"…","keyPoints":["…"]}]}`,
  };
}

export function parseFollowUps(json: unknown): FollowUpQuestion[] {
  const qs = (json as { questions?: unknown })?.questions;
  if (!Array.isArray(qs)) throw new Error('follow-ups: bad shape');
  const levels = ['基础', '进阶', '追问', '故障'];
  const out: FollowUpQuestion[] = [];
  for (const q of qs) {
    const o = q as { level?: unknown; question?: unknown; keyPoints?: unknown };
    if (typeof o.question !== 'string' || !o.question) continue;
    out.push({
      level: (levels.includes(String(o.level)) ? String(o.level) : '追问') as FollowUpQuestion['level'],
      question: o.question,
      keyPoints: Array.isArray(o.keyPoints) ? o.keyPoints.map(String).slice(0, 5) : [],
    });
  }
  if (!out.length) throw new Error('follow-ups: empty');
  return out.slice(0, 6);
}

export function buildSubmissionPrompt(ctx: SubmissionAssessmentContext): { system: string; user: string } {
  const probes = ctx.probeResults ?? [];
  const verdictText = (v: ProbeVerdict) =>
    v === 'hit' ? '预言命中' : v === 'held' ? '设计扛住了（预测会失败，实测却通过）' : '预言未命中';
  // When verified probe results exist, the review grounds on THEM: the
  // static suite stays the score's fairness baseline but its per-case
  // results are deliberately NOT briefed to the LLM anymore. Only when the
  // probe step produced nothing do we fall back to the per-case dump.
  const evidence = probes.length
    ? `\n\n探测验证结果（评审前由模型针对这份设计提出假设用例、再由仿真引擎逐例实测，可信）：\n` +
      probes
        .map(
          (p) =>
            `- 「${p.name}」（${p.scenarioSummary}）：预测 ${p.prediction.willFail ? `会失败，主要突破口=${p.prediction.primaryBreach}` : '能通过'}——${p.prediction.rationale} → 实测 ${p.passed ? '通过' : `未通过 — ${p.failures.join('；')}`}，判定：${verdictText(p.verdict)}`,
        )
        .join('\n')
    : `。逐例：\n` +
      ctx.cases.map((c) => `- ${c.name}：${c.passed ? '通过' : `未通过 — ${c.failures.join('；')}（实测 ${JSON.stringify(c.measured)}）`}`).join('\n');
  return {
    system:
      '你是一位资深系统设计面试官，在给候选人的提交写评审。分数已由代码判卷给出（硬阈值），你的任务是解释分数、指出最关键的缺陷与修复优先级，结论必须引用给定的实测数据，不要编造数字，不要改判分数。只输出 JSON。',
    user:
      `题目：${ctx.problemName}\n候选人设计：\n${ctx.designSummary}\n\n本题读写需求：${ctx.workloadSummary}\n\n` +
      `代码判卷结果：${ctx.passed}/${ctx.total} 通过，得分 ${ctx.scorePct}` +
      evidence +
      `\n\n结构缺陷（确定性规则，可信）：\n${ctx.structuralFindings.map((f) => `- [${f.severity}] ${f.title}：${f.detail}`).join('\n') || '（无）'}\n\n` +
      `【动作保证 · 硬性要求】每条 finding 都必须附带 actions：一键可应用的结构化改法（用户预览确认后由系统执行），只能用这三种操作，且 nodeId 必须引用上面设计摘要里出现的 id：\n` +
      `- {"op":"setSetting","nodeId":"节点id","key":"参数名","value":值}：参数名只能是该组件类型合法的参数——通用 replicas（整数）/ capacityScale；网关 rateLimitPerSec；缓存 mutexRebuild（布尔）/ eviction；负载均衡 lbAlgorithm；关系型 DB 与 NoSQL 的 sharded（布尔）/ shardKey（字符串）/ readReplicas（整数）/ consistency。\n` +
      `- {"op":"addComponent","componentType":"cache","connectFromId":"上游节点id","connectToId":"下游节点id"}：在两个已有节点之间插入一个新组件（两端 id 至少给一个）。要把两个新组件串成链（例如先插队列、再插消费它的 Worker），给第一个 addComponent 写 "newNodeId":"自取的id"，后续操作用这个 id 引用新节点。\n` +
      `- {"op":"addEdge","fromId":"节点id","toId":"节点id"}：新增一条连线。\n` +
      `没有 actions 的 finding 会被系统判为不合格并触发修复轮（把校验错误回传给你重写），所以第一次就给对：id 抄准、参数名用合法的、值落在范围内；每条 finding 最多 3 个操作。唯一的例外：纯权衡/解释类评论（不涉及负载、容量、正确性、故障）可以不给 actions，但必须显式声明 "nonMechanical":"tradeoff|explanation|process" 说明理由——涉及错误率/P99/成本/过载/单点/一致性/积压的问题一律不许用这个声明逃避，系统也不会接受。\n\n` +
      `输出 JSON：{"summary":"2-3 句总评","scoreRationale":"为什么是这个分数：失分集中在哪、先修哪个涨分最快","findings":[{"severity":"high|medium|low","title":"…","detail":"…","actions":[{"op":"setSetting","nodeId":"…","key":"replicas","value":2}]}]}`,
  };
}

export function parseSubmissionAssessment(json: unknown): SubmissionAssessment {
  const o = json as { summary?: unknown; scoreRationale?: unknown; findings?: unknown };
  if (typeof o.summary !== 'string') throw new Error('submission assessment: bad shape');
  const findings: DriverFinding[] = [];
  if (Array.isArray(o.findings)) {
    for (const f of o.findings) {
      const g = f as {
        severity?: unknown;
        title?: unknown;
        detail?: unknown;
        actions?: unknown;
        componentId?: unknown;
        nonMechanical?: unknown;
      };
      if (typeof g.title !== 'string') continue;
      const actions = sanitizeEditOps(g.actions);
      findings.push({
        severity: (['high', 'medium', 'low'].includes(String(g.severity)) ? String(g.severity) : 'medium') as DriverFinding['severity'],
        title: g.title,
        detail: String(g.detail ?? ''),
        ...(typeof g.componentId === 'string' && g.componentId ? { componentId: g.componentId } : {}),
        ...(actions.length ? { actions } : {}),
        ...((NON_MECHANICAL_REASONS as readonly string[]).includes(String(g.nonMechanical))
          ? { nonMechanicalReason: String(g.nonMechanical) as NonMechanicalReason }
          : {}),
      });
    }
  }
  return {
    summary: o.summary,
    scoreRationale: typeof o.scoreRationale === 'string' ? o.scoreRationale : '',
    findings,
  };
}

export function buildSchemaPrompt(ctx: SchemaAssessmentContext): { system: string; user: string } {
  return {
    system:
      '你是一位资深系统设计面试官，在评审候选人的数据库设计。代码规则已经给出每条访问模式的路径与延迟估算（可信信号），你的任务是给出结论与改进建议：能否满足需求、延迟从哪来、怎么 scale。引用信号里的具体数字，不要编造。只输出 JSON。',
    user:
      `题目：${ctx.problemName}\n候选人的 schema：\n${ctx.schemaSummary}\n\n` +
      (ctx.simSummary
        ? `数据库模拟实测（服务端按题目需求把访问模式真跑了一遍，比公式估算更可信，引用数字优先用这组）：\n${ctx.simSummary}\n\n`
        : '') +
      `代码规则信号：得分 ${ctx.signals.score}，${ctx.signals.coverage}\n逐条访问模式：\n` +
      ctx.signals.perPattern.map((p) => `- ${p.pattern}：${p.path} · 约 ${p.latencyMs}ms · ${p.verdict}${p.note ? `（${p.note}）` : ''}`).join('\n') +
      `\n规则发现：\n${ctx.signals.findings.map((f) => `- [${f.dimension}/${f.severity}] ${f.text}`).join('\n') || '（无）'}\n\n` +
      `【动作保证 · 硬性要求】每条 suggestion 必须是一个对象 {"text":"…","actions":[…]}，actions 是这条建议的结构化形式（用户一键应用到 schema 草稿），只能用这四种 schema 操作，table 必须是上面 schema 里真实存在的表名，field 必须是该表真实存在的字段：\n` +
      `- {"op":"setShardKey","table":"表名","field":"字段名或 null"}：设定（或清除）分片键。\n` +
      `- {"op":"addIndex","table":"表名","field":"字段名"}：给字段加索引（已索引的字段不要重复给）。\n` +
      `- {"op":"setPrimaryKeyGen","table":"表名","gen":"auto|snowflake|uuid|business"}：换主键生成方式。\n` +
      `- {"op":"setEngine","table":"表名","engine":"relational|nosql"}：换存储引擎。\n` +
      `没有 actions 的建议会被判不合格并触发修复轮。每条最多 3 个操作。唯一的例外：纯权衡/解释类建议（不涉及延迟、覆盖、扩展性问题本身）可以只给 text 并声明 "nonMechanical":"tradeoff|explanation|process"。\n\n` +
      `输出 JSON：{"conclusion":"2-3 句总评","dimensionNotes":[{"dimension":"需求覆盖|延迟风险|扩展性","note":"…"}],"suggestions":[{"text":"具体可执行的改进，按优先级","actions":[{"op":"addIndex","table":"…","field":"…"}]}]}`,
  };
}

export function parseSchemaAssessment(json: unknown): SchemaAssessment {
  const o = json as { conclusion?: unknown; dimensionNotes?: unknown; suggestions?: unknown };
  if (typeof o.conclusion !== 'string') throw new Error('schema assessment: bad shape');
  const dims = ['需求覆盖', '延迟风险', '扩展性'];
  const dimensionNotes: SchemaAssessment['dimensionNotes'] = [];
  if (Array.isArray(o.dimensionNotes)) {
    for (const d of o.dimensionNotes) {
      const g = d as { dimension?: unknown; note?: unknown };
      if (dims.includes(String(g.dimension)) && typeof g.note === 'string') {
        dimensionNotes.push({
          dimension: String(g.dimension) as SchemaAssessment['dimensionNotes'][number]['dimension'],
          note: g.note,
        });
      }
    }
  }
  // Suggestions are structured { text, actions? } under the action
  // guarantee; plain strings from older/other emitters are accepted and
  // normalized to { text } (the server ladder then synthesizes actions).
  const suggestions: SchemaSuggestion[] = [];
  if (Array.isArray(o.suggestions)) {
    for (const s of o.suggestions.slice(0, 6)) {
      if (typeof s === 'string') {
        if (s.trim()) suggestions.push({ text: s });
        continue;
      }
      const g = s as { text?: unknown; actions?: unknown; nonMechanical?: unknown } | null;
      if (!g || typeof g.text !== 'string' || !g.text.trim()) continue;
      const actions = sanitizeSchemaOps(g.actions);
      suggestions.push({
        text: g.text,
        ...(actions.length ? { actions } : {}),
        ...((NON_MECHANICAL_REASONS as readonly string[]).includes(String(g.nonMechanical))
          ? { nonMechanicalReason: String(g.nonMechanical) as NonMechanicalReason }
          : {}),
      });
    }
  }
  return { conclusion: o.conclusion, dimensionNotes, suggestions };
}

// ------------------------------------------------------ probe prompts ---
// The prober never sees the static suite. It gets the design, the schema,
// the workload, the structural signals and the CRITERIA — and must commit
// to falsifiable predictions the simulator will grade.

export function buildProbePrompt(ctx: ProbeContext): { system: string; user: string } {
  const killableTypes = [...new Set(ctx.nodes.map((n) => n.type))].join('、');
  return {
    system:
      '你是一位资深系统设计面试官，正在评审前对候选人的设计做"探测"。你看不到题目的测试用例，也不知道判卷结果。你的任务：基于给定的评判标准，针对这份设计最可能翻车的地方，提出最多 4 个仿真用例，并对每个用例给出明确、可证伪的预测。随后系统会把你的用例在仿真引擎里真跑一遍，逐条核对你的预测——预测对了说明你真看懂了这份设计，错了会被如实记录。所以：挑这份设计真正的软肋，不要凑数；阈值按标准口径设；rationale 必须指向具体结构。只输出 JSON，不要输出其它文字。',
    user:
      `题目：${ctx.problemName}\n候选人设计：\n${ctx.designSummary}\n\n` +
      (ctx.schemaSummary ? `数据库 schema：\n${ctx.schemaSummary}\n\n` : '') +
      `本题读写需求：${ctx.workloadSummary}\n\n` +
      `题目量级：基线 ${ctx.baselineRps} RPS，读占比 ${Math.round(ctx.readRatio * 100)}%，成本预算 $${ctx.budgetCostPerHour}/h。\n` +
      `本设计里可被杀的组件类型：${killableTypes || '（无）'}\n\n` +
      `结构缺陷（确定性规则，可信，可作为你选软肋的线索）：\n${ctx.structuralFindings.map((f) => `- [${f.severity}] ${f.title}：${f.detail}`).join('\n') || '（无）'}\n\n` +
      `${PROBE_CRITERIA}\n\n` +
      `输出 JSON：{"cases":[{"name":"用例名（点明场景）","scenario":{"trafficMultiplier":3,"durationSec":40,"readRatio":0.9,"events":[{"type":"viral_post","targetType":"feedservice","magnitude":3}],"kills":["appserver"]},"thresholds":{"p99Ms":1000,"maxErrorRatePct":1,"maxCostPerHour":900},"prediction":{"willFail":true,"primaryBreach":"错误率超标","rationale":"为什么这个场景会先打爆这一层","fixHint":"候选人该怎么改","actions":[{"op":"addComponent","componentType":"queue","connectFromId":"发帖节点id","connectToId":"存储节点id"}]}}]}\n` +
      `scenario 的 events/kills 可省略或为空数组；thresholds 至少给一项（可选项：p99Ms / maxErrorRatePct / maxCostPerHour / maxStorageQps / maxHottestUtilPct / maxStaleReadPct / maxQueueDepth）；prediction.willFail=false 时 primaryBreach 必须为「无」。\n` +
      `prediction.actions 是 fixHint 的结构化版本：【动作保证 · 硬性要求】willFail=true 的预测必须给 actions（用户一键应用）：只能用 setSetting / addComponent / addEdge 三种操作，nodeId 只能引用设计摘要里出现的 id，setSetting 的 key 只能是该组件类型合法的参数（replicas / capacityScale / rateLimitPerSec / mutexRebuild / eviction / lbAlgorithm / sharded / shardKey / readReplicas / consistency）。需要串联两个新组件时，给第一个 addComponent 写 newNodeId 并在后续操作中引用它。没有合法 actions 的失败预测会被判不合格并触发修复轮；willFail=false 的预测不要给 actions。每条最多 3 个操作。`,
  };
}

const PROBE_EVENT_TYPES: readonly string[] = ['viral_post', 'cache_stampede', 'hot_key', 'peak', 'rw_flip'];
const COMPONENT_TYPE_IDS: readonly string[] = Object.keys(COMPONENT_MAP);

const clampNum = (v: unknown, lo: number, hi: number): number | undefined => {
  const n = typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.min(hi, Math.max(lo, n));
};

/**
 * Validate + clamp ONE proposed probe case to what the engine can execute.
 * Malformed cases return null (rejected individually; siblings survive).
 * Used both for LLM output (via parseProbeCases) and for cases that round-
 * trip back to the server for verification — the server never trusts the
 * client's copy.
 */
export function normalizeProbeCase(raw: unknown): ProbeCase | null {
  const o = raw as {
    name?: unknown;
    scenario?: Record<string, unknown>;
    thresholds?: Record<string, unknown>;
    prediction?: Record<string, unknown>;
  } | null;
  if (!o || typeof o.name !== 'string' || !o.name.trim() || !o.scenario || typeof o.scenario !== 'object') {
    return null;
  }
  const s = o.scenario;
  const scenario: ProbeScenarioSpec = {
    trafficMultiplier: clampNum(s.trafficMultiplier, 0.2, 10) ?? 1,
    durationSec: Math.round(clampNum(s.durationSec, 10, 120) ?? 40),
    events: [],
    kills: [],
  };
  const rr = clampNum(s.readRatio, 0, 1);
  if (rr !== undefined) scenario.readRatio = rr;
  if (Array.isArray(s.events)) {
    for (const e of s.events.slice(0, 3)) {
      const ev = e as { type?: unknown; targetType?: unknown; magnitude?: unknown };
      if (!PROBE_EVENT_TYPES.includes(String(ev.type))) continue;
      scenario.events.push({
        type: String(ev.type) as EventType,
        ...(COMPONENT_TYPE_IDS.includes(String(ev.targetType))
          ? { targetType: String(ev.targetType) as ComponentTypeId }
          : {}),
        magnitude: clampNum(ev.magnitude, 1, 10) ?? 3,
      });
    }
  }
  if (Array.isArray(s.kills)) {
    for (const k of s.kills) {
      const t = String(k);
      if (COMPONENT_TYPE_IDS.includes(t) && !scenario.kills.includes(t as ComponentTypeId)) {
        scenario.kills.push(t as ComponentTypeId);
      }
      if (scenario.kills.length >= 3) break;
    }
  }

  const t = (o.thresholds ?? {}) as Record<string, unknown>;
  const thresholds: ProbeThresholds = {};
  const p99 = clampNum(t.p99Ms, 50, 10_000);
  if (p99 !== undefined) thresholds.p99Ms = p99;
  const err = clampNum(t.maxErrorRatePct, 0.01, 50);
  if (err !== undefined) thresholds.maxErrorRatePct = err;
  const cost = clampNum(t.maxCostPerHour, 1, 100_000);
  if (cost !== undefined) thresholds.maxCostPerHour = cost;
  const sqps = clampNum(t.maxStorageQps, 10, 1_000_000);
  if (sqps !== undefined) thresholds.maxStorageQps = sqps;
  const hot = clampNum(t.maxHottestUtilPct, 50, 100);
  if (hot !== undefined) thresholds.maxHottestUtilPct = hot;
  const stale = clampNum(t.maxStaleReadPct, 0.1, 100);
  if (stale !== undefined) thresholds.maxStaleReadPct = stale;
  const qd = clampNum(t.maxQueueDepth, 10, 10_000_000);
  if (qd !== undefined) thresholds.maxQueueDepth = qd;
  if (Object.keys(thresholds).length === 0) return null; // nothing to verify against

  const p = o.prediction;
  if (!p || typeof p !== 'object') return null;
  const willFail = p.willFail === true;
  let primaryBreach: PrimaryBreach = '无';
  if (willFail) {
    if (!(BREACH_CATEGORIES as readonly string[]).includes(String(p.primaryBreach))) return null;
    primaryBreach = String(p.primaryBreach) as BreachCategory;
  }
  const predActions = sanitizeEditOps((p as { actions?: unknown }).actions);
  const predSource = (p as { actionSource?: unknown }).actionSource;
  return {
    name: o.name.trim().slice(0, 60),
    scenario,
    thresholds,
    prediction: {
      willFail,
      primaryBreach,
      rationale: typeof p.rationale === 'string' ? p.rationale.slice(0, 400) : '',
      fixHint: typeof p.fixHint === 'string' ? p.fixHint.slice(0, 300) : '',
      ...(predActions.length ? { actions: predActions } : {}),
      // Provenance must survive the client round-trip (propose → client
      // → verify-probes) so the verified card can label its fix's source.
      ...(predActions.length && (ACTION_SOURCES as readonly string[]).includes(String(predSource))
        ? { actionSource: String(predSource) as ActionSource }
        : {}),
    },
  };
}

/**
 * Parse the prober's reply: {"cases":[ ... ]}. Throws only when the reply
 * is unusable as a whole; individual malformed cases are dropped, and an
 * all-invalid reply yields [] (the host degrades to the no-probe path).
 */
export function parseProbeCases(json: unknown): ProbeCase[] {
  const arr = Array.isArray(json)
    ? json
    : (json as { cases?: unknown })?.cases;
  if (!Array.isArray(arr)) throw new Error('probe: bad shape');
  const out: ProbeCase[] = [];
  for (const raw of arr) {
    const pc = normalizeProbeCase(raw);
    if (pc) out.push(pc);
    if (out.length >= 4) break;
  }
  return out;
}

// ---------------------------------------------------- schema probing ----
// The database-side mirror of the probe pipeline. The prober reads the
// judging criteria, the schema, the sim's measured summary and the
// schema judging results — never the static schema test cases — and
// proposes adversarial DATA scenarios: data growth, traffic surges, a
// hot key / skewed value, a flip in which patterns dominate. The server
// re-runs the schema simulator under each scenario and grades the
// prediction (hit / held / miss, same 口径 as architecture probes).

export const SCHEMA_PROBE_CRITERIA = `数据库判卷标准（本系统的口径，提场景与做预测都按这套来）：
- 每条访问模式在场景下的 P99 延迟不得超过本题延迟预算（见上下文给出的预算 ms）；
- 任何表在场景下的最热分片利用率不得超过 1（超过 = 该表饱和，排队会把所有打到它的查询一起拖慢）；
- 访问模式的执行路径不得退化为全表扫描或跨分片广播（在当前规模已经如此的模式不算"被场景打坏"，要挑场景真正会改变结论的软肋）；
- 分片键选错（与主查询字段不对齐、单调递增键）在数据增长或流量倾斜下会先爆：查询逐分片探测、写入全压一个分片。`;

/** One adversarial data scenario, in the schema simulator's own knobs. */
export interface SchemaProbeScenarioSpec {
  /** Data rows multiplier (1 = current size). */
  growthFactor?: number;
  /** Global traffic multiplier over every pattern's declared rate. */
  trafficMultiplier?: number;
  /** Per-pattern traffic multipliers by pattern id (0 = 该模式消失，
   *  用它表达"流量结构翻转"，如读模式暴涨而写模式归零）。 */
  patternTraffic?: Record<string, number>;
  /** Skew: this pattern's traffic concentrates on ONE byField value. */
  skew?: { patternId: string; concentration: number };
}

export interface SchemaProbePrediction {
  willFail: boolean;
  /** What breaks first: a pattern id or a table name; '无' when passing. */
  firstBreakKind: 'pattern' | 'table' | '无';
  firstBreakId: string;
  /** The metric expected to breach （自由文本，如「P99 延迟」「最热分片利用率」). */
  metric: string;
  rationale: string;
  fixHint: string;
  /** Structured fix (schema-ops) for a willFail prediction. */
  fixActions?: SchemaOp[];
  actionSource?: ActionSource;
}

export interface SchemaProbeCase {
  name: string;
  scenario: SchemaProbeScenarioSpec;
  prediction: SchemaProbePrediction;
}

export interface SchemaProbeContext {
  problemName: string;
  /** The submitted schema (tables, fields, indexes, shard keys). */
  schemaSummary: string;
  /** The schema sim's measured summary of the submitted schema. */
  simSummary: string;
  /** The problem's per-pattern P99 budget (ms). */
  budgetMs: number;
  /** The pack's access patterns — the only legal pattern ids. */
  patterns: { id: string; name: string; table: string; kind: string; perSec: number }[];
  /** Schema judging outcome of this submission (revealed results only). */
  judgingSummary: string;
  /** Server-measured hints (also what the scripted fallback builds on):
   *  the first pattern the sim's ×growth run already fails, the pattern
   *  closest to the budget now, and the most-loaded table. */
  growthFailurePatternId?: string;
  hottestPatternId?: string;
  hottestTable?: { name: string; util: number };
}

export type SchemaProbeVerdict = 'hit' | 'held' | 'miss';

export interface VerifiedSchemaProbeResult {
  name: string;
  /** Deterministic one-line description of the scenario as executed. */
  scenarioSummary: string;
  scenario: SchemaProbeScenarioSpec;
  prediction: SchemaProbePrediction;
  verdict: SchemaProbeVerdict;
  /** True when the schema held under the scenario. */
  passed: boolean;
  /** What actually broke first (human line), null when it held. */
  actualFirstBreak: string | null;
  measured: {
    worstPatternId: string | null;
    worstPatternName: string | null;
    worstP99Ms: number;
    maxTableUtil: number;
    maxSustainableQps: number;
  };
  failures: string[];
}

export function buildSchemaProbePrompt(ctx: SchemaProbeContext): { system: string; user: string } {
  return {
    system:
      '你是一位资深系统设计面试官，正在对候选人的数据库设计做"探测"。你看不到题目的数据库测试用例。你的任务：基于给定的判卷标准、这份 schema 的结构与模拟实测，提出最多 3 个对抗性数据场景（数据倾斜、突发增长、热点行、流量结构翻转等），并对每个场景给出明确、可证伪的预测——哪个访问模式或哪张表会先爆、爆在哪个指标上。随后系统会用数据库模拟器在该场景下真跑一遍，逐条核对你的预测。挑真正的软肋，不要凑数；rationale 必须指向具体结构与数字。只输出 JSON，不要输出其它文字。',
    user:
      `题目：${ctx.problemName}\n候选人数据库 schema：\n${ctx.schemaSummary}\n\n` +
      `数据库模拟实测（当前规模与 ×10 数据量）：\n${ctx.simSummary}\n\n` +
      `本次提交的数据库判卷结果（确定性用例的已揭示部分）：\n${ctx.judgingSummary}\n\n` +
      `本题延迟预算：每条访问模式 P99 ≤ ${ctx.budgetMs}ms。\n` +
      `访问模式目录（scenario 与 firstBreakId 只能引用这里的 id / 表名）：\n${ctx.patterns.map((p) => `- ${p.id}：${p.name}（表 ${p.table}，${p.kind}，约 ${p.perSec}/s）`).join('\n')}\n\n` +
      `${SCHEMA_PROBE_CRITERIA}\n\n` +
      `输出 JSON：{"cases":[{"name":"场景名（点明对抗手法）","scenario":{"growthFactor":5,"trafficMultiplier":2,"patternTraffic":{"<模式id>":6},"skew":{"patternId":"<模式id>","concentration":0.9}},"prediction":{"willFail":true,"firstBreakKind":"pattern","firstBreakId":"<模式id 或 表名>","metric":"P99 延迟","rationale":"为什么这个场景会先打爆它（引用实测数字）","fixHint":"该怎么改","fixActions":[{"op":"setShardKey","table":"<表名>","field":"<字段名>"}]}}]}\n` +
      `scenario 的键都可省略，但至少要给一个有效旋钮（全省略 = 原样重跑，没有意义，会被丢弃）。growthFactor 1–20（数据量倍数）；trafficMultiplier 0.2–10（全局流量倍数）；patternTraffic 是按模式 id 的倍数（可为 0），覆盖全局倍数；skew.concentration 0.5–1（该模式流量集中到单一取值上的比例）。\n` +
      `prediction.willFail=false 时 firstBreakKind 必须为「无」、firstBreakId 为空字符串。\n` +
      `prediction.fixActions 是 fixHint 的结构化版本：【动作保证 · 硬性要求】willFail=true 的预测必须给 fixActions（用户一键应用到 schema 草稿）：只能用 setShardKey / addIndex / setPrimaryKeyGen / setEngine 四种操作，table 与 field 必须真实存在于上面的 schema 摘要里，setShardKey 的 field 可为 null（取消分片）。没有合法 fixActions 的失败预测会被判不合格并触发修复轮；willFail=false 的预测不要给 fixActions。每条最多 3 个操作。`,
  };
}

/**
 * Validate + clamp ONE proposed schema probe case. Pattern ids and
 * table names are checked against the pack's real vocabulary; a case
 * with no effective scenario knob is rejected (it would just re-run the
 * base sim). Used for LLM output and for cases round-tripping back to
 * the server for verification — the server never trusts the client copy.
 */
export function normalizeSchemaProbeCase(
  raw: unknown,
  validPatternIds: ReadonlySet<string>,
  tableNames: ReadonlySet<string>,
): SchemaProbeCase | null {
  const o = raw as {
    name?: unknown;
    scenario?: Record<string, unknown>;
    prediction?: Record<string, unknown>;
  } | null;
  if (!o || typeof o.name !== 'string' || !o.name.trim() || !o.scenario || typeof o.scenario !== 'object') {
    return null;
  }
  const s = o.scenario;
  const scenario: SchemaProbeScenarioSpec = {};
  const growth = clampNum(s.growthFactor, 1, 20);
  if (growth !== undefined && growth !== 1) scenario.growthFactor = growth;
  const traffic = clampNum(s.trafficMultiplier, 0.2, 10);
  if (traffic !== undefined && traffic !== 1) scenario.trafficMultiplier = traffic;
  if (s.patternTraffic && typeof s.patternTraffic === 'object') {
    const pt: Record<string, number> = {};
    for (const [k, v] of Object.entries(s.patternTraffic as Record<string, unknown>)) {
      if (!validPatternIds.has(k)) continue;
      const m = clampNum(v, 0, 20);
      if (m !== undefined && m !== 1) pt[k] = m;
    }
    if (Object.keys(pt).length) scenario.patternTraffic = pt;
  }
  const skewRaw = s.skew as { patternId?: unknown; concentration?: unknown } | undefined;
  if (skewRaw && validPatternIds.has(String(skewRaw.patternId))) {
    const concentration = clampNum(skewRaw.concentration, 0.5, 1) ?? 0.9;
    scenario.skew = { patternId: String(skewRaw.patternId), concentration };
  }
  if (Object.keys(scenario).length === 0) return null; // no effective knob

  const p = o.prediction;
  if (!p || typeof p !== 'object') return null;
  const willFail = p.willFail === true;
  let firstBreakKind: SchemaProbePrediction['firstBreakKind'] = '无';
  let firstBreakId = '';
  if (willFail) {
    const kind = String(p.firstBreakKind);
    const id = String(p.firstBreakId ?? '');
    if (kind === 'pattern' && validPatternIds.has(id)) {
      firstBreakKind = 'pattern';
      firstBreakId = id;
    } else if (kind === 'table' && tableNames.has(id)) {
      firstBreakKind = 'table';
      firstBreakId = id;
    } else {
      return null; // a failure prediction must name a real first break
    }
  }
  const fixActions = sanitizeSchemaOps((p as { fixActions?: unknown }).fixActions);
  const fixSource = (p as { actionSource?: unknown }).actionSource;
  return {
    name: o.name.trim().slice(0, 60),
    scenario,
    prediction: {
      willFail,
      firstBreakKind,
      firstBreakId,
      metric: typeof p.metric === 'string' ? p.metric.slice(0, 40) : '',
      rationale: typeof p.rationale === 'string' ? p.rationale.slice(0, 400) : '',
      fixHint: typeof p.fixHint === 'string' ? p.fixHint.slice(0, 300) : '',
      ...(fixActions.length ? { fixActions } : {}),
      ...(fixActions.length && (ACTION_SOURCES as readonly string[]).includes(String(fixSource))
        ? { actionSource: String(fixSource) as ActionSource }
        : {}),
    },
  };
}

/** Parse the schema prober's reply: {"cases":[ ... ]} (cap 3). */
export function parseSchemaProbes(
  json: unknown,
  validPatternIds: ReadonlySet<string>,
  tableNames: ReadonlySet<string>,
): SchemaProbeCase[] {
  const arr = Array.isArray(json)
    ? json
    : (json as { cases?: unknown })?.cases;
  if (!Array.isArray(arr)) throw new Error('schema-probe: bad shape');
  const out: SchemaProbeCase[] = [];
  for (const raw of arr) {
    const pc = normalizeSchemaProbeCase(raw, validPatternIds, tableNames);
    if (pc) out.push(pc);
    if (out.length >= 3) break;
  }
  return out;
}

// ------------------------------------------------ schema next steps -----
// The database mirror of the per-case next steps: ONE pinned action per
// anchor, where the anchors are this submission's FAILED schema cases
// plus its VERIFIED failed schema probes. Steps carry schema-op actions
// through the same action-guarantee ladder as every other LLM result;
// applying one goes through the schema-op preview/confirm into the
// schema draft, and judging refreshes only on re-submit (stale semantics
// identical to the architecture side).

export interface SchemaNextStepAnchor {
  /** 'case:<caseId>' for a failed schema case, 'probe:<name>' for a probe. */
  anchorId: string;
  kind: 'case' | 'probe';
  /** The failed case's / probe's display name. */
  title: string;
  /** Measured facts, verbatim: failure lines, measured vs threshold. */
  facts: string[];
}

export interface SchemaNextStepsContext {
  problemName: string;
  schemaSummary: string;
  /** The schema sim's measured summary of the submitted schema. */
  simSummary: string;
  anchors: SchemaNextStepAnchor[];
}

export interface SchemaNextStep {
  anchorId: string;
  /** The action in one line. */
  title: string;
  /** Why — cites the anchor's measured numbers. */
  rationale: string;
  actions?: SchemaOp[];
  actionSource?: ActionSource;
}

export function buildSchemaNextStepsPrompt(
  ctx: SchemaNextStepsContext,
): { system: string; user: string } {
  return {
    system:
      '你是一位资深系统设计面试官。候选人刚提交了数据库设计：有些数据库用例没过，有些 AI 探测场景把这份 schema 打爆了。你的任务：给每个锚点钉住"下一步只做这一件事"——杠杆最高的那一个动作。title 一句话说清动作；rationale 必须引用锚点给出的实测数字，不许泛泛而谈；actions 给出该动作的结构化形式（schema 操作，用户会一键应用）。每个锚点恰好一条，不要多给、不要漏。只输出 JSON，不要输出其它文字。',
    user:
      `题目：${ctx.problemName}\n候选人数据库 schema：\n${ctx.schemaSummary}\n\n` +
      `数据库模拟实测：\n${ctx.simSummary}\n\n` +
      `锚点（每个都要恰好一条下一步）：\n${ctx.anchors.map((a) => `- [${a.anchorId}] ${a.kind === 'case' ? '未过用例' : '已验证探测'}「${a.title}」：${a.facts.join('；')}`).join('\n')}\n\n` +
      `输出 JSON：{"steps":[{"anchorId":"<锚点 id，原样抄>","title":"一句话动作","rationale":"为什么先做这一步（引用实测数字）","actions":[{"op":"addIndex","table":"<表名>","field":"<字段名>"}]}]}\n` +
      `actions【动作保证 · 硬性要求】：只能用 setShardKey / addIndex / setPrimaryKeyGen / setEngine 四种操作，table 与 field 必须真实存在于上面的 schema 摘要里；每条 1–3 个操作。没有合法 actions 的一步会被判不合格并触发修复轮。`,
  };
}

/**
 * Parse the schema next-steps reply: keep exactly the steps whose
 * anchorId names a real anchor of this submission (unknown/duplicate
 * ids dropped — the server ladder constructs the missing ones).
 */
export function parseSchemaNextSteps(
  json: unknown,
  anchorIds: ReadonlySet<string>,
): SchemaNextStep[] {
  const arr = Array.isArray(json)
    ? json
    : (json as { steps?: unknown })?.steps;
  if (!Array.isArray(arr)) throw new Error('schema-next-steps: bad shape');
  const out: SchemaNextStep[] = [];
  const seen = new Set<string>();
  for (const raw of arr) {
    const s = raw as {
      anchorId?: unknown;
      title?: unknown;
      rationale?: unknown;
      actions?: unknown;
    } | null;
    if (!s || typeof s.anchorId !== 'string' || !anchorIds.has(s.anchorId)) continue;
    if (seen.has(s.anchorId)) continue;
    seen.add(s.anchorId);
    const actions = sanitizeSchemaOps(s.actions);
    out.push({
      anchorId: s.anchorId,
      title: typeof s.title === 'string' ? s.title.slice(0, 120) : '',
      rationale: typeof s.rationale === 'string' ? s.rationale.slice(0, 400) : '',
      ...(actions.length ? { actions } : {}),
    });
  }
  return out;
}

// --------------------------------------------------------- next steps ---
//
// The per-case counterpart of the submission review. The review (AI 评审)
// is BROAD qualitative commentary over the whole submission; a next step
// is ONE pinned action per FAILED case — the single highest-leverage move
// for that case, stated against its measured numbers, carrying validated
// actions the user can apply and immediately re-judge. The model sees
// ONLY the failed cases (with their measured-vs-threshold deltas and the
// measured hottest node of each run), never the passed ones.

/** One failed case, briefed for next-step generation. */
export interface NextStepFailedCase {
  caseId: string;
  name: string;
  /** Judge-produced failure lines — measured vs threshold, verbatim. */
  failures: string[];
  measured: CaseMeasuredLike;
  /**
   * The measured bottleneck of this case's run: which node peaked
   * hottest, and how hot (0..>1). Null when no node registered load.
   */
  hottestNode?: { nodeId: string; type: ComponentTypeId; util: number } | null;
  /** The case's thresholds (checker units), when the caller has them. */
  thresholds?: ExecutedScenarioThresholds;
}

export interface NextStepsContext {
  problemName: string;
  /** Human-readable summary of the submitted design graph. */
  designSummary: string;
  schemaSummary?: string;
  workloadSummary: string;
  /** Deterministic structural findings — only their titles are briefed. */
  structuralFindings: StructuralFindingLike[];
  failedCases: NextStepFailedCase[];
}

/** One pinned next action for one failed case. */
export interface NextStep {
  caseId: string;
  /** The action in one line, e.g. 「把发帖链路改异步：先入队列再扩散」. */
  title: string;
  /** Why this step, for this case — must cite its measured numbers. */
  rationale: string;
  /**
   * The step's executable form, in the edit-op vocabulary. Under the
   * action guarantee every step ships with ≥1 action validated against
   * the submitted design whenever one is constructible at all (the
   * server ladder: first-pass validation → ONE repair re-prompt →
   * measured/rule synthesis → universal fallback).
   */
  actions?: EditOp[];
  /** Provenance of `actions` (the UI renders it next to the apply button). */
  actionSource?: ActionSource;
}

export function buildNextStepsPrompt(ctx: NextStepsContext): { system: string; user: string } {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const caseBlock = (c: NextStepFailedCase) => {
    const m = c.measured;
    const t = c.thresholds;
    const lines = [
      `- 用例「${c.name}」（caseId: ${c.caseId}）未通过：`,
      `  判卷失败项：${c.failures.join('；') || '（未给出）'}`,
      `  实测：错误率 ${pct(m.errorRate)}${t?.maxErrorRate !== undefined ? `（阈值 ${pct(t.maxErrorRate)}）` : ''} · P99 ${Math.round(m.p99Ms)}ms${t?.maxP99Ms !== undefined ? `（阈值 ${t.maxP99Ms}ms）` : ''} · 成本 $${m.costPerHour.toFixed(0)}/h${t?.maxCostPerHour !== undefined ? `（阈值 $${t.maxCostPerHour}/h）` : ''} · 存储入站 ${Math.round(m.maxStorageQps)} QPS${t?.maxStorageQps !== undefined ? `（阈值 ${t.maxStorageQps}）` : ''} · 最热利用率 ${pct(m.hottestUtil)}${t?.maxHottestUtil !== undefined ? `（阈值 ${pct(t.maxHottestUtil)}）` : ''} · 读旧 ${pct(m.staleReadRate)}${t?.maxStaleReadRate !== undefined ? `（阈值 ${pct(t.maxStaleReadRate)}）` : ''}${m.queueDepthMax > 0 ? ` · 最大积压 ${Math.round(m.queueDepthMax).toLocaleString()} 条${t?.maxQueueDepth !== undefined ? `（阈值 ${t.maxQueueDepth.toLocaleString()}）` : ''}` : ''}`,
    ];
    if (c.hottestNode) {
      lines.push(
        `  实测最热节点：${c.hottestNode.nodeId}（类型 ${c.hottestNode.type}），峰值利用率 ${pct(c.hottestNode.util)}——这条用例的瓶颈在这里（除非你能指出更上游的成因）。`,
      );
    }
    return lines.join('\n');
  };
  return {
    system:
      '你是一位资深系统设计面试官，正在给候选人指"下一步"。判卷刚结束：分数已由代码给出，你不改判。你的任务只有一个：对每一个未通过的用例，给出恰好一条下一步——杠杆最高的那一个动作，应用之后值得立刻重新提交验证。不要写全面点评（那是评审环节的事），不要给一个用例列一串清单。只输出 JSON，不要输出其它文字。',
    user:
      `题目：${ctx.problemName}\n候选人设计：\n${ctx.designSummary}\n\n` +
      (ctx.schemaSummary ? `数据库 schema：\n${ctx.schemaSummary}\n\n` : '') +
      `本题读写需求：${ctx.workloadSummary}\n\n` +
      `结构缺陷（确定性规则，仅供参考，不要逐条复述）：\n${ctx.structuralFindings.map((f) => `- ${f.title}`).join('\n') || '（无）'}\n\n` +
      `未通过的用例（共 ${ctx.failedCases.length} 个，逐个给下一步）：\n${ctx.failedCases.map(caseBlock).join('\n')}\n\n` +
      `【硬性要求】\n` +
      `- 每个未通过用例恰好一条 step，caseId 必须逐字抄上面给出的 caseId；多给、漏给、编造 caseId 的 step 会被系统丢弃。\n` +
      `- title 是一句话动作（做什么、对哪个组件），不是问题描述；rationale 必须引用该用例的实测数字（差阈值多少、最热节点利用率多少），说明为什么这一步是这一例的最高杠杆。\n` +
      `- 每条 step 必须附带 actions：一键可应用的结构化改法（用户预览确认后由系统执行），只能用这三种操作，且 nodeId 必须引用上面设计摘要里出现的 id：\n` +
      `  - {"op":"setSetting","nodeId":"节点id","key":"参数名","value":值}：参数名只能是该组件类型合法的参数——通用 replicas（整数）/ capacityScale；网关 rateLimitPerSec；缓存 mutexRebuild（布尔）/ eviction；负载均衡 lbAlgorithm；关系型 DB 与 NoSQL 的 sharded（布尔）/ shardKey（字符串）/ readReplicas（整数）/ consistency。\n` +
      `  - {"op":"addComponent","componentType":"cache","connectFromId":"上游节点id","connectToId":"下游节点id"}：在两个已有节点之间插入一个新组件（两端 id 至少给一个）。要把两个新组件串成链（例如先插队列、再插消费它的 Worker），给第一个 addComponent 写 "newNodeId":"自取的id"，后续操作用这个 id 引用新节点。\n` +
      `  - {"op":"addEdge","fromId":"节点id","toId":"节点id"}：新增一条连线。\n` +
      `- 没有合法 actions 的 step 会被系统判为不合格（先触发修复轮，还不行就由规则合成替换），所以第一次就给对：id 抄准、参数合法、每条最多 3 个操作。扩容要一步到位：按实测利用率把目标节点的容量/副本提到能把利用率压到 80% 以下，不要只加一点点。\n\n` +
      `输出 JSON：{"steps":[{"caseId":"…","title":"一句话动作","rationale":"引用实测数字的理由","actions":[{"op":"setSetting","nodeId":"…","key":"replicas","value":3}]}]}`,
  };
}

/**
 * Parse the next-steps reply: {"steps":[ ... ]}. Defensive like every
 * parser here: steps naming a caseId that is not one of THIS submission's
 * failed cases are dropped (the model does not get to invent work), a
 * second step for the same case is dropped (exactly one per case), and
 * actions are shape-sanitized (semantic validation is the server
 * ladder's job). Throws only when the reply is unusable as a whole; an
 * empty-but-well-formed reply yields [] and the ladder synthesizes the
 * steps deterministically.
 */
export function parseNextSteps(json: unknown, failedCaseIds: ReadonlySet<string>): NextStep[] {
  const arr = Array.isArray(json) ? json : (json as { steps?: unknown })?.steps;
  if (!Array.isArray(arr)) throw new Error('next-steps: bad shape');
  const out: NextStep[] = [];
  const seen = new Set<string>();
  for (const raw of arr) {
    const o = raw as { caseId?: unknown; title?: unknown; rationale?: unknown; actions?: unknown } | null;
    if (!o || typeof o.caseId !== 'string' || typeof o.title !== 'string' || !o.title.trim()) continue;
    if (!failedCaseIds.has(o.caseId) || seen.has(o.caseId)) continue;
    seen.add(o.caseId);
    const actions = sanitizeEditOps(o.actions);
    out.push({
      caseId: o.caseId,
      title: o.title.trim(),
      rationale: typeof o.rationale === 'string' ? o.rationale : '',
      ...(actions.length ? { actions } : {}),
    });
  }
  return out;
}

// ------------------------------------------------------ action repair ---
//
// Ladder step 2. When a first-pass evaluation ships findings whose actions
// are missing or fail server-side validation, the lacking items go into
// ONE bounded follow-up call: the same model profile, the same logging
// plumbing, the validation errors quoted verbatim, and the legal vocab
// spelled out again. Whatever validates this time attaches with
// actionSource 'repaired'; the rest fall through to deterministic rule
// synthesis and the universal fallback (server-side, no more calls).

export interface ActionRepairItem {
  /** Index of the item within its batch — the reply refers back by it. */
  index: number;
  kind: 'finding' | 'probe' | 'schema' | 'step';
  title: string;
  detail: string;
  /** Why the first pass's actions did not survive (verbatim-ish). */
  errors: string[];
}

export interface ActionRepairContext {
  problemName: string;
  items: ActionRepairItem[];
  /** Legal architecture vocabulary, rendered (nodes + per-type settings). */
  legalArch?: string;
  /** Legal schema vocabulary, rendered (tables + fields + current keys). */
  legalSchema?: string;
  designSummary?: string;
  schemaSummary?: string;
}

export function buildActionRepairPrompt(ctx: ActionRepairContext): { system: string; user: string } {
  const archItems = ctx.items.filter((i) => i.kind !== 'schema');
  const schemaItems = ctx.items.filter((i) => i.kind === 'schema');
  const itemLine = (i: ActionRepairItem) =>
    `- [${i.index}] ${i.kind === 'schema' ? 'schema 建议' : i.kind === 'probe' ? '探测用例的修复' : i.kind === 'step' ? '下一步建议' : '评审发现'}「${i.title}」：${i.detail}\n  上一轮动作的问题：${i.errors.join('；') || '（没有给 actions）'}`;
  return {
    system:
      '你是一位资深系统设计面试官，正在执行【动作修复轮】。上一轮评审里有几条发现没有给出合法的一键修复动作（或给的动作没通过服务端校验）。你的唯一任务：为列出的每一条补出合法的结构化动作。不要改写发现的文字，不要新增发现，不要解释——只输出 JSON。',
    user:
      `题目：${ctx.problemName}\n` +
      (ctx.designSummary ? `\n候选人设计：\n${ctx.designSummary}\n` : '') +
      (ctx.schemaSummary ? `\n候选人 schema：\n${ctx.schemaSummary}\n` : '') +
      (archItems.length && ctx.legalArch ? `\n架构侧合法词表（nodeId 与参数只能取这里列出的）：\n${ctx.legalArch}\n` : '') +
      (schemaItems.length && ctx.legalSchema ? `\nSchema 侧合法词表（表名/字段名只能取这里列出的）：\n${ctx.legalSchema}\n` : '') +
      `\n需要补动作的条目：\n${ctx.items.map(itemLine).join('\n')}\n\n` +
      `架构动作（finding/probe 条目）只能用三种操作：{"op":"setSetting","nodeId":"合法节点id","key":"该类型合法参数","value":值} / {"op":"addComponent","componentType":"组件类型","connectFromId":"合法节点id","connectToId":"合法节点id","newNodeId":"串联时给第一个新节点取的id"} / {"op":"addEdge","fromId":"合法节点id","toId":"合法节点id"}。\n` +
      `Schema 动作（schema 条目）只能用四种操作：{"op":"setShardKey","table":"表名","field":"字段名或 null"} / {"op":"addIndex","table":"表名","field":"字段名"} / {"op":"setPrimaryKeyGen","table":"表名","gen":"auto|snowflake|uuid|business"} / {"op":"setEngine","table":"表名","engine":"relational|nosql"}。\n` +
      `每条最多 3 个操作；动作要对症这条发现说的问题，不要给无关的通用扩容。\n\n` +
      `输出 JSON：{"repairs":[{"index":0,"actions":[{"op":"setSetting","nodeId":"…","key":"replicas","value":2}]},{"index":2,"schemaActions":[{"op":"addIndex","table":"…","field":"…"}]}]}（finding/probe/step 条目用 actions，schema 条目用 schemaActions）`,
  };
}

export interface ParsedRepair {
  archActions?: EditOp[];
  schemaActions?: SchemaOp[];
}

/** Parse the repair reply into a per-index map (shape-sanitized only;
 *  semantic validation happens server-side, exactly like the first pass). */
export function parseActionRepair(json: unknown): Map<number, ParsedRepair> {
  const out = new Map<number, ParsedRepair>();
  const arr = (json as { repairs?: unknown })?.repairs;
  if (!Array.isArray(arr)) return out;
  for (const r of arr) {
    const o = r as { index?: unknown; actions?: unknown; schemaActions?: unknown } | null;
    if (!o || typeof o.index !== 'number' || !Number.isInteger(o.index)) continue;
    const arch = sanitizeEditOps(o.actions);
    const schema = sanitizeSchemaOps(o.schemaActions);
    if (!arch.length && !schema.length) continue;
    out.set(o.index, {
      ...(arch.length ? { archActions: arch } : {}),
      ...(schema.length ? { schemaActions: schema } : {}),
    });
  }
  return out;
}

// ------------------------------------------------------- problem generation ---
//
// The fourth system: LLM problem generation. Where the prober proposes
// cases for ONE design and the simulator grades the predictions, the
// generator proposes content for the PROBLEM BANK: new test cases for an
// existing problem PLUS a complete reference solution (design + schema)
// meant to pass the problem's whole suite. The same philosophy applies —
// the LLM proposes, the simulator arbitrates: the server runs the
// reference against the existing suite, the generated cases and the weak
// sample design before anything may be merged (see apps/server generate
// pipeline). Nothing the model emits is trusted at face value.
//
// The shapes below mirror @sds/problems' TestCase / ProblemSchema and
// @sds/sim-core's Design (structurally — the contract package stays free
// of a problems dependency, like the *Like shapes above). Node positions
// (x/y) are NOT part of the model's output; the server lays the design
// out when it assembles the real Design.

/**
 * The house standards handed to the generator: threshold conventions in
 * CHECKER units (fractions, absolute RPS), what the engine can execute,
 * and the two contracts its output will be held to — the reference must
 * solve everything, and the new cases must discriminate.
 */
export const GENERATION_CRITERIA = `出题标准（本系统的口径，生成的用例与参考解都按这套来判）：
- 用例形状：traffic.rps 是绝对值（相对题目基线 RPS 的 0.2–10 倍之间取值）；traffic.readRatio 0–1；durationTicks 10–120（1 tick ≈ 1 秒）；events 至多 3 个，类型只能取 viral_post（网红爆帖）/ cache_stampede（缓存雪崩）/ hot_key（热点 key）/ peak（流量峰值）/ rw_flip（读写比翻转），可带 targetType（组件类型）、magnitude（1–10）、atTick、durationTicks；kills 至多 3 个，按组件类型在 atTick 杀节点。
- 阈值口径（checker 单位：错误率/利用率是 0–1 的小数，不是百分数）：基线场景 maxErrorRate 0.001、maxP99Ms 按题面延迟要求（一般 400–500）、maxHottestUtil 0.95；峰值/事件场景 maxErrorRate 0.01–0.02、maxP99Ms 1000 以内；成本红线 maxCostPerHour 不超过题目预算；maxStaleReadRate 红线 0.05；maxStorageQps 按存储层可承受入站设；每个用例至少给一项阈值。
- 区分度（新用例的价值所在）：隐藏用例要能让"凑合的示例级设计"翻车、又让一份认真的参考解通过——阈值严到参考解也过不了的用例是无效用例（会被系统剔除），松到弱设计也能过的隐藏用例会被标记弱区分度。优先攻击题目已有的考点维度（热点、雪崩、单点、成本、一致性），但不要克隆现有用例的场景。
- 参考解契约：referenceSolution 必须能通过这道题的【全部现有用例 + 你新生成的全部用例】——系统会拿它逐例真跑，挂任何一例，整份生成作废。设计只能用组件目录里的类型与合法参数；schema 要覆盖题目的访问模式（主键/索引/分片键选型要经得起推敲），行数规模与题面量级一致。
- 数据库用例（schemaCases，与架构用例并行的一套判卷）：断言只能用四种形状——{"kind":"pattern","patternId":"<模式id>","metric":"p99Ms"|"rowsExamined","max":数}（某模式在某规模下的 P99/扫描行数上限）；{"kind":"pattern-path","patternId":"<模式id>","forbiddenPaths":["全表扫描"|"跨分片广播"]}（某模式不得走灾难路径）；{"kind":"table","table":"<表名>","metric":"hottestShardUtil"|"writeAmp","max":数}（某表最热分片利用率/写放大上限）；{"kind":"global","metric":"sustainableQps","min":数}（整体可持续流量下限）。每条带 scale："now"|"grown"（当前规模/数据量 ×10)。口径同架构用例：referenceSolution.schema 必须通过你出的【全部】数据库用例（挂掉的会被剔除）；起始 schema（整题模式是 schema 字段、扩充模式是题目自带草稿）至少要挂掉一个隐藏数据库用例，全都能过的隐藏用例会被标弱区分度。阈值按数据库模拟的实测量级设：全表扫描的行数是表行数级（百万起），索引查询是千级以内；利用率红线一般 0.1–1；别拍脑袋给参考 schema 也过不了的数。`;

/** Everything the generator may look at for ONE existing problem. */
export interface GenerationContext {
  problemName: string;
  statement: string;
  functionalRequirements: string[];
  /** Scale facts rendered for the prompt （量级/基线/峰值/预算/读写比/备注）. */
  scaleSummary: string;
  /** This problem's read/write workload profile, rendered. */
  workloadSummary: string;
  /** The judging standards (GENERATION_CRITERIA). */
  criteria: string;
  /**
   * Existing cases by NAME + one-line description only — enough to avoid
   * cloning a scenario, deliberately without their traffic/thresholds.
   */
  existingCases: { name: string; description: string; hidden: boolean }[];
  /** Component catalog: types, behavior, capacities, costs, legal settings. */
  componentCatalog: string;
  /** The pack's starter schema, rendered (tables + access patterns). */
  schemaSummary: string;
  /** How many NEW cases to generate. */
  caseCount: number;
  /** Author steer, when given (e.g. 「多出一致性方面的用例」). */
  focus?: string;
  /** Numeric anchors for the parser's clamps. */
  baselineRps: number;
  defaultReadRatio: number;
}

export interface GeneratedCaseEvent {
  atTick: number;
  type: EventType;
  targetType?: ComponentTypeId;
  magnitude?: number;
  durationTicks?: number;
}

export interface GeneratedCaseKill {
  componentType: ComponentTypeId;
  atTick: number;
}

/** Thresholds in checker units (fractions) — the real TestCase shape. */
export interface GeneratedCaseThresholds {
  maxErrorRate?: number;
  maxP99Ms?: number;
  maxCostPerHour?: number;
  maxStorageQps?: number;
  maxStaleReadRate?: number;
  maxHottestUtil?: number;
  maxQueueDepth?: number;
}

/** One generated test case, in the real TestCase shape (post-clamp). */
export interface GeneratedCase {
  /** As proposed (may be empty/invalid/duplicated) — the server uniquifies. */
  id: string;
  name: string;
  description: string;
  hidden: boolean;
  weight: number;
  traffic: { rps: number; readRatio: number };
  durationTicks: number;
  events: GeneratedCaseEvent[];
  kills: GeneratedCaseKill[];
  thresholds: GeneratedCaseThresholds;
  hint: string;
  exposesRule?: string;
}

export interface GeneratedDesignNode {
  id: string;
  type: ComponentTypeId;
  /** Raw settings bag (scalar values only) — semantically validated server-side. */
  settings: Record<string, string | number | boolean>;
}

export interface GeneratedDesign {
  nodes: GeneratedDesignNode[];
  edges: { from: string; to: string }[];
}

export interface GeneratedSchemaField {
  name: string;
  type: string;
  indexed: boolean;
  blob?: boolean;
}

export interface GeneratedSchemaTable {
  name: string;
  engine: 'relational' | 'nosql';
  rows: number;
  primaryKey: string;
  primaryKeyGen: 'auto' | 'snowflake' | 'uuid' | 'business';
  shardKey: string | null;
  fields: GeneratedSchemaField[];
}

export interface GeneratedAccessPattern {
  id: string;
  name: string;
  table: string;
  kind: 'read' | 'write' | 'count';
  byField: string;
  needsSort?: boolean;
  perSec: number;
}

export interface GeneratedSchema {
  tables: GeneratedSchemaTable[];
  accessPatterns: GeneratedAccessPattern[];
}

/**
 * One generated SCHEMA test case — the structural mirror of
 * @sds/problems SchemaTestCase (the driver contract stays free of a
 * problems dependency; the server converts 1:1). Assertions are phrased
 * over the schema simulator's measured output, exactly like the native
 * suites: the reference schema must pass every one of them, and the
 * starter schema should fail at least one hidden one (discrimination).
 */
export type GeneratedSchemaAssertion =
  | { kind: 'pattern'; patternId: string; metric: 'p99Ms' | 'rowsExamined'; max: number }
  | { kind: 'pattern-path'; patternId: string; forbiddenPaths: Array<'全表扫描' | '跨分片广播'> }
  | { kind: 'table'; table: string; metric: 'hottestShardUtil' | 'writeAmp'; max: number }
  | { kind: 'global'; metric: 'sustainableQps'; min: number };

export interface GeneratedSchemaCase {
  /** As proposed (may be empty/duplicated) — the server uniquifies. */
  id: string;
  name: string;
  description: string;
  hidden: boolean;
  weight: number;
  scale: 'now' | 'grown';
  assertion: GeneratedSchemaAssertion;
}

const SCHEMA_CASE_PATHS: readonly string[] = ['全表扫描', '跨分片广播'];

/** Validate + clamp ONE generated schema case; malformed → null. */
export function normalizeGeneratedSchemaCase(raw: unknown): GeneratedSchemaCase | null {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || typeof o.name !== 'string' || !o.name.trim()) return null;
  const a = (o.assertion ?? {}) as Record<string, unknown>;
  let assertion: GeneratedSchemaAssertion | null = null;
  if (a.kind === 'pattern' && typeof a.patternId === 'string' && a.patternId) {
    const max = clampNum(a.max, 0.001, 1e12);
    if (max !== undefined && (a.metric === 'p99Ms' || a.metric === 'rowsExamined')) {
      assertion = { kind: 'pattern', patternId: a.patternId, metric: a.metric, max };
    }
  } else if (a.kind === 'pattern-path' && typeof a.patternId === 'string' && a.patternId) {
    const paths = Array.isArray(a.forbiddenPaths)
      ? a.forbiddenPaths.map(String).filter((p) => SCHEMA_CASE_PATHS.includes(p))
      : [];
    if (paths.length) {
      assertion = {
        kind: 'pattern-path',
        patternId: a.patternId,
        forbiddenPaths: [...new Set(paths)] as Array<'全表扫描' | '跨分片广播'>,
      };
    }
  } else if (a.kind === 'table' && typeof a.table === 'string' && a.table) {
    const max = clampNum(a.max, 0.001, 1000);
    if (max !== undefined && (a.metric === 'hottestShardUtil' || a.metric === 'writeAmp')) {
      assertion = { kind: 'table', table: a.table, metric: a.metric, max };
    }
  } else if (a.kind === 'global') {
    const min = clampNum(a.min, 0, 1e12);
    if (min !== undefined) assertion = { kind: 'global', metric: 'sustainableQps', min };
  }
  if (!assertion) return null;
  return {
    id: typeof o.id === 'string' ? o.id.trim().slice(0, 60) : '',
    name: o.name.trim().slice(0, 80),
    description: typeof o.description === 'string' ? o.description.trim().slice(0, 300) : '',
    hidden: o.hidden !== false,
    weight: Math.round(clampNum(o.weight, 1, 5) ?? 1),
    scale: o.scale === 'grown' ? 'grown' : 'now',
    assertion,
  };
}

/** The `schemaCases` field of a generation reply (cap 8, malformed dropped). */
export function parseGeneratedSchemaCases(raw: unknown): GeneratedSchemaCase[] {
  if (!Array.isArray(raw)) return [];
  const out: GeneratedSchemaCase[] = [];
  for (const item of raw) {
    const gc = normalizeGeneratedSchemaCase(item);
    if (gc) out.push(gc);
    if (out.length >= 8) break;
  }
  return out;
}

export interface ParsedGeneration {
  cases: GeneratedCase[];
  /** Schema test cases for the problem (possibly empty in a bad reply —
   *  the validation pipeline reports that honestly rather than the
   *  parser throwing away an otherwise good generation). */
  schemaCases: GeneratedSchemaCase[];
  referenceSolution: { design: GeneratedDesign; schema: GeneratedSchema };
}

export function buildGenerationPrompt(ctx: GenerationContext): { system: string; user: string } {
  return {
    system:
      '你是一位资深系统设计面试题出题人，正在为一道已有题目扩充题库。你要产出两样东西：一批新的测试用例，和一份完整的参考解（架构设计 + 数据库 schema）。参考解不是样子货——系统会拿它跑遍这道题的全部现有用例和你新出的全部用例，挂掉任何一例，整份生成都会被驳回。所以先想清楚一份真正能过关的设计长什么样，再围绕这道题的考点出能区分强弱设计的新用例。只输出 JSON，不要输出其它文字。',
    user:
      `题目：${ctx.problemName}\n题面：${ctx.statement}\n` +
      `功能需求：\n${ctx.functionalRequirements.map((r) => `- ${r}`).join('\n') || '（无）'}\n\n` +
      `量级：${ctx.scaleSummary}\n\n` +
      `本题读写需求：${ctx.workloadSummary}\n\n` +
      `现有用例（只给名称与一句话说明，供你避开重复场景；参数不要猜、更不要克隆）：\n` +
      `${ctx.existingCases.map((c) => `- ${c.hidden ? '🔒' : '👁'} ${c.name}：${c.description}`).join('\n') || '（无）'}\n\n` +
      `组件目录（参考解只能使用这些组件类型与合法参数）：\n${ctx.componentCatalog}\n\n` +
      `题目自带的 schema 草稿（参考解的 schema 可以在此基础上改进，但要覆盖同样的访问模式）：\n${ctx.schemaSummary}\n\n` +
      `${ctx.criteria}\n\n` +
      `本次生成 ${ctx.caseCount} 个新用例${ctx.focus ? `，作者指定的侧重：${ctx.focus}` : ''}。可见/隐藏搭配：多数设为隐藏（hidden=true），可留 0–1 个可见基线型。\n` +
      `同时生成 2–4 个数据库用例（schemaCases）：针对这道题 schema 的真实弱点出题，至少 1 个隐藏硬例要能让题目自带的 schema 草稿挂掉，参考解的 schema 必须全过。\n\n` +
      `输出 JSON：{"cases":[{"id":"小写连字符 id","name":"用例名（点明场景）","description":"一句话说明","hidden":true,"weight":2,"traffic":{"rps":2500,"readRatio":0.97},"durationTicks":40,"events":[{"atTick":3,"type":"hot_key","targetType":"relationaldb","magnitude":3,"durationTicks":30}],"kills":[{"componentType":"appserver","atTick":5}],"thresholds":{"maxErrorRate":0.02,"maxP99Ms":1000},"hint":"挂了之后给候选人看的修复方向","exposesRule":"spof"}],"schemaCases":[{"id":"sc1","name":"数据库用例名","description":"一句话说明","hidden":true,"weight":2,"scale":"grown","assertion":{"kind":"pattern","patternId":"p1","metric":"rowsExamined","max":10000}}],"referenceSolution":{"design":{"nodes":[{"id":"节点id","type":"cache","settings":{"replicas":2,"mutexRebuild":true}}],"edges":[{"from":"上游节点id","to":"下游节点id"}]},"schema":{"tables":[{"name":"urls","engine":"relational","rows":1000000000,"primaryKey":"id","primaryKeyGen":"snowflake","shardKey":"short_code","fields":[{"name":"id","type":"bigint","indexed":true}]}],"accessPatterns":[{"id":"p1","name":"按短码跳转","table":"urls","kind":"read","byField":"short_code","perSec":5000}]}}}\n` +
      `events/kills 没有就给空数组；thresholds 至少一项；settings 只给与默认不同的参数即可（replicas/capacityScale 通用；网关 rateLimitPerSec；缓存 mutexRebuild/eviction；负载均衡 lbAlgorithm；关系型 DB 与 NoSQL 的 sharded/shardKey/readReplicas/consistency）；design 的每个节点都要有至少一条连线，流量从 client 出发要能走到存储层。`,
  };
}

const GEN_EVENT_TYPES: readonly string[] = ['viral_post', 'cache_stampede', 'hot_key', 'peak', 'rw_flip'];
const PK_GENS: readonly string[] = ['auto', 'snowflake', 'uuid', 'business'];
const PATTERN_KINDS: readonly string[] = ['read', 'write', 'count'];

function normalizeGeneratedCase(
  raw: unknown,
  opts: { baselineRps: number; defaultReadRatio: number },
): GeneratedCase | null {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || typeof o.name !== 'string' || !o.name.trim()) return null;
  const durationTicks = Math.round(clampNum(o.durationTicks, 10, 120) ?? 40);
  const t = (o.traffic ?? {}) as Record<string, unknown>;
  const rps = clampNum(t.rps, 10, Math.max(100, opts.baselineRps * 10)) ?? opts.baselineRps;
  const readRatio = clampNum(t.readRatio, 0, 1) ?? opts.defaultReadRatio;

  const events: GeneratedCaseEvent[] = [];
  if (Array.isArray(o.events)) {
    for (const e of o.events.slice(0, 3)) {
      const ev = e as Record<string, unknown>;
      if (!ev || !GEN_EVENT_TYPES.includes(String(ev.type))) continue;
      events.push({
        atTick: Math.round(clampNum(ev.atTick, 1, durationTicks) ?? 3),
        type: String(ev.type) as EventType,
        ...(COMPONENT_TYPE_IDS.includes(String(ev.targetType))
          ? { targetType: String(ev.targetType) as ComponentTypeId }
          : {}),
        magnitude: clampNum(ev.magnitude, 1, 10) ?? 3,
        durationTicks: Math.round(clampNum(ev.durationTicks, 1, 60) ?? 20),
      });
    }
  }
  const kills: GeneratedCaseKill[] = [];
  if (Array.isArray(o.kills)) {
    for (const k of o.kills.slice(0, 3)) {
      const kk = k as Record<string, unknown>;
      const type = String(kk?.componentType ?? '');
      if (!COMPONENT_TYPE_IDS.includes(type)) continue;
      if (kills.some((x) => x.componentType === type)) continue;
      kills.push({
        componentType: type as ComponentTypeId,
        atTick: Math.round(clampNum(kk.atTick, 1, durationTicks) ?? 5),
      });
    }
  }

  const th = (o.thresholds ?? {}) as Record<string, unknown>;
  const thresholds: GeneratedCaseThresholds = {};
  const err = clampNum(th.maxErrorRate, 0.0005, 0.5);
  if (err !== undefined) thresholds.maxErrorRate = err;
  const p99 = clampNum(th.maxP99Ms, 50, 10_000);
  if (p99 !== undefined) thresholds.maxP99Ms = p99;
  const cost = clampNum(th.maxCostPerHour, 1, 100_000);
  if (cost !== undefined) thresholds.maxCostPerHour = cost;
  const sqps = clampNum(th.maxStorageQps, 10, 1_000_000);
  if (sqps !== undefined) thresholds.maxStorageQps = sqps;
  const stale = clampNum(th.maxStaleReadRate, 0.001, 1);
  if (stale !== undefined) thresholds.maxStaleReadRate = stale;
  const hot = clampNum(th.maxHottestUtil, 0.5, 1);
  if (hot !== undefined) thresholds.maxHottestUtil = hot;
  const qd = clampNum(th.maxQueueDepth, 10, 10_000_000);
  if (qd !== undefined) thresholds.maxQueueDepth = qd;
  if (Object.keys(thresholds).length === 0) return null; // nothing to judge against

  const exposesRaw = typeof o.exposesRule === 'string' ? o.exposesRule.trim() : '';
  return {
    id: typeof o.id === 'string' ? o.id.trim().slice(0, 64) : '',
    name: o.name.trim().slice(0, 60),
    description: typeof o.description === 'string' ? o.description.trim().slice(0, 300) : '',
    hidden: o.hidden !== false,
    weight: clampNum(o.weight, 0.5, 3) ?? 1,
    traffic: { rps: Math.round(rps), readRatio },
    durationTicks,
    events,
    kills,
    thresholds,
    hint: typeof o.hint === 'string' ? o.hint.trim().slice(0, 300) : '',
    ...(/^[a-z0-9-]{1,40}$/.test(exposesRaw) ? { exposesRule: exposesRaw } : {}),
  };
}

function normalizeGeneratedSchema(raw: unknown): GeneratedSchema | null {
  const o = raw as { tables?: unknown; accessPatterns?: unknown } | null;
  if (!o || !Array.isArray(o.tables)) return null;
  const tables: GeneratedSchemaTable[] = [];
  const seen = new Set<string>();
  for (const t of o.tables.slice(0, 12)) {
    const tb = t as Record<string, unknown> | null;
    if (!tb || typeof tb.name !== 'string' || !tb.name.trim()) continue;
    const name = tb.name.trim().slice(0, 60);
    if (seen.has(name) || typeof tb.primaryKey !== 'string' || !tb.primaryKey.trim()) continue;
    seen.add(name);
    const fields: GeneratedSchemaField[] = [];
    if (Array.isArray(tb.fields)) {
      for (const f of tb.fields.slice(0, 24)) {
        const fd = f as Record<string, unknown> | null;
        if (!fd || typeof fd.name !== 'string' || !fd.name.trim() || typeof fd.type !== 'string') {
          continue;
        }
        fields.push({
          name: fd.name.trim().slice(0, 60),
          type: fd.type.slice(0, 40),
          indexed: fd.indexed === true,
          ...(fd.blob === true ? { blob: true } : {}),
        });
      }
    }
    tables.push({
      name,
      engine: tb.engine === 'nosql' ? 'nosql' : 'relational',
      rows: Math.round(clampNum(tb.rows, 1, 1_000_000_000_000) ?? 1_000_000),
      primaryKey: tb.primaryKey.trim().slice(0, 60),
      primaryKeyGen: (PK_GENS.includes(String(tb.primaryKeyGen))
        ? String(tb.primaryKeyGen)
        : 'snowflake') as GeneratedSchemaTable['primaryKeyGen'],
      shardKey:
        typeof tb.shardKey === 'string' && tb.shardKey.trim()
          ? tb.shardKey.trim().slice(0, 60)
          : null,
      fields,
    });
  }
  if (!tables.length) return null;
  const accessPatterns: GeneratedAccessPattern[] = [];
  if (Array.isArray(o.accessPatterns)) {
    for (const p of o.accessPatterns.slice(0, 16)) {
      const ap = p as Record<string, unknown> | null;
      if (
        !ap ||
        typeof ap.name !== 'string' ||
        !ap.name.trim() ||
        typeof ap.table !== 'string' ||
        !seen.has(ap.table) ||
        typeof ap.byField !== 'string' ||
        !ap.byField.trim() ||
        !PATTERN_KINDS.includes(String(ap.kind))
      ) {
        continue;
      }
      accessPatterns.push({
        id: typeof ap.id === 'string' && ap.id.trim() ? ap.id.trim().slice(0, 40) : `gp-${accessPatterns.length + 1}`,
        name: ap.name.trim().slice(0, 60),
        table: ap.table,
        kind: String(ap.kind) as GeneratedAccessPattern['kind'],
        byField: ap.byField.trim().slice(0, 60),
        ...(ap.needsSort === true ? { needsSort: true } : {}),
        perSec: Math.round(clampNum(ap.perSec, 0, 1_000_000) ?? 0),
      });
    }
  }
  return { tables, accessPatterns };
}

function normalizeGeneratedDesign(raw: unknown): GeneratedDesign | null {
  const o = raw as { nodes?: unknown; edges?: unknown } | null;
  if (!o || !Array.isArray(o.nodes)) return null;
  const nodes: GeneratedDesignNode[] = [];
  for (const n of o.nodes.slice(0, 24)) {
    const nd = n as Record<string, unknown> | null;
    if (!nd || typeof nd.id !== 'string' || !nd.id.trim()) continue;
    if (!COMPONENT_TYPE_IDS.includes(String(nd.type))) continue;
    const settings: Record<string, string | number | boolean> = {};
    if (nd.settings && typeof nd.settings === 'object') {
      for (const [k, v] of Object.entries(nd.settings as Record<string, unknown>)) {
        if (typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) {
          settings[k] = v;
        }
      }
    }
    nodes.push({ id: nd.id.trim().slice(0, 60), type: String(nd.type) as ComponentTypeId, settings });
  }
  if (!nodes.length) return null;
  const edges: { from: string; to: string }[] = [];
  if (Array.isArray(o.edges)) {
    for (const e of o.edges.slice(0, 40)) {
      const ed = e as { from?: unknown; to?: unknown } | null;
      if (ed && typeof ed.from === 'string' && typeof ed.to === 'string' && ed.from !== ed.to) {
        edges.push({ from: ed.from, to: ed.to });
      }
    }
  }
  return { nodes, edges };
}

/**
 * Parse the generator's reply. Throws only when the reply is unusable as a
 * whole (no cases survive, no design, no schema) — the host then reports
 * the generation as failed rather than storing a hollow draft. Individual
 * malformed cases are dropped, like the probe parser.
 */
export function parseGeneration(
  json: unknown,
  opts: { baselineRps: number; defaultReadRatio: number },
): ParsedGeneration {
  const o = json as { cases?: unknown; schemaCases?: unknown; referenceSolution?: unknown } | null;
  if (!o || typeof o !== 'object') throw new Error('generation: bad shape');
  const cases: GeneratedCase[] = [];
  if (Array.isArray(o.cases)) {
    for (const raw of o.cases) {
      const gc = normalizeGeneratedCase(raw, opts);
      if (gc) cases.push(gc);
      if (cases.length >= 8) break;
    }
  }
  if (!cases.length) throw new Error('generation: no usable cases');
  const ref = (o.referenceSolution ?? {}) as { design?: unknown; schema?: unknown };
  const design = normalizeGeneratedDesign(ref.design);
  if (!design) throw new Error('generation: reference design unusable');
  const schema = normalizeGeneratedSchema(ref.schema);
  if (!schema) throw new Error('generation: reference schema unusable');
  return {
    cases,
    schemaCases: parseGeneratedSchemaCases(o.schemaCases),
    referenceSolution: { design, schema },
  };
}

// ------------------------------------------------- whole-problem generation -
// The generation system's other mode: instead of EXTENDING an existing
// problem, the model authors an ENTIRE new problem from a source document
// the author supplies (a URL the server fetched, pasted text, or an
// uploaded .md/.txt). The output is a complete ProblemDef — statement,
// scale, workload profile, STARTER schema, visible + hidden cases, a
// deliberately naive sampleDesign, and a referenceSolution — and it flows
// through the whole-problem validation pipeline server-side (generate.ts)
// before an admin may accept it into the problem bank. The shapes mirror
// @sds/problems structurally, like the extension-mode shapes above.

/** Everything the whole-problem generator may look at. */
export interface WholeProblemContext {
  /** Where the source material came from. */
  sourceType: 'url' | 'text' | 'file';
  /** Human label for the source (the URL, the file name, or 「粘贴文本」). */
  sourceLabel: string;
  /** The source document itself, server-capped (≈30k chars). */
  sourceText: string;
  /** True when the source was truncated to the cap. */
  sourceTruncated: boolean;
  /** Optional author-supplied title steer. */
  titleHint?: string;
  /**
   * Existing problems described by STRUCTURE ONLY — field lists and shape
   * notes, never their statement text — so the model imitates the pack
   * format without copying an existing problem's content.
   */
  existingProblemStructures: string;
  /** Component catalog: types, behavior, capacities, costs, legal settings. */
  componentCatalog: string;
  /** The judging standards (GENERATION_CRITERIA). */
  criteria: string;
}

/** One workload pattern of a generated problem (@sds/problems WorkloadPattern). */
export interface GeneratedWorkloadPattern {
  id: string;
  name: string;
  kind: 'read' | 'write';
  description: string;
  share: number;
  path: ComponentTypeId[];
  table?: string;
  consistency: 'strong' | 'eventual';
  terminalPerSec?: number;
}

/** A complete generated problem, post-normalization (see parseWholeProblem). */
export interface ParsedWholeProblem {
  /** As proposed — the server flags conflicts with the existing bank. */
  id: string;
  name: string;
  nameEn: string;
  difficulty: '简单' | '中等' | '困难';
  tags: string[];
  statement: string;
  functionalRequirements: string[];
  scale: {
    dau: string;
    readRatio: number;
    peakMultiplier: number;
    baselineRps: number;
    budgetCostPerHour: number;
    notes: string;
  };
  workload: {
    readRatio: number;
    consistency: string;
    fanoutFollowers?: number;
    patterns: GeneratedWorkloadPattern[];
  };
  /** The STARTER schema handed to solvers (not the reference schema). */
  schema: GeneratedSchema;
  cases: GeneratedCase[];
  /** Schema test cases for the new problem (validated against the
   *  reference schema + starter discrimination, like `cases`). */
  schemaCases: GeneratedSchemaCase[];
  /** Deliberately naive starting design — the discrimination baseline. */
  sampleDesign: GeneratedDesign;
  referenceSolution: { design: GeneratedDesign; schema: GeneratedSchema };
}

export function buildWholeProblemPrompt(ctx: WholeProblemContext): { system: string; user: string } {
  return {
    system:
      '你是一位资深系统设计面试题出题人。作者给你一份题目来源材料，你要据此命制一道【完整的新题】：题面、量级、读写需求、起始数据库 schema、一套可见+隐藏测试用例、一个故意朴素的起始设计（sampleDesign），以及一份参考解（referenceSolution：架构 + schema）。参考解不是样子货——系统会拿它逐例真跑你出的全部用例，挂掉任何一例该用例即作废，参考解通过率过半数以下整题驳回；起始设计则应至少能通过可见的基线用例、但要栽在隐藏用例上（栽不了的隐藏用例会被标弱区分度）。只输出 JSON，不要输出其它文字。',
    user:
      `【题目来源】类型：${ctx.sourceType === 'url' ? '链接抓取' : ctx.sourceType === 'file' ? '上传文件' : '粘贴文本'}（${ctx.sourceLabel}）${ctx.sourceTruncated ? '；来源较长，已被截断到上限，以现有内容为准' : ''}${ctx.titleHint ? `\n作者给的标题提示：${ctx.titleHint}` : ''}\n` +
      `----- 来源全文开始 -----\n${ctx.sourceText}\n----- 来源全文结束 -----\n\n` +
      `【现有题目的结构】（只有字段清单与形状说明，没有题面全文——照这个结构命题，不要克隆任何一道现有题的内容）：\n${ctx.existingProblemStructures}\n\n` +
      `【组件目录】设计（sampleDesign 与 referenceSolution.design）只能使用这些组件类型与合法参数：\n${ctx.componentCatalog}\n\n` +
      `${ctx.criteria}\n\n` +
      `整题的额外口径：\n` +
      `- id 用英文小写连字符 slug（如 like-system），name 给中文题名（如「Design 点赞系统」），nameEn 给英文题名，difficulty 取 简单|中等|困难，tags 2–5 个。\n` +
      `- statement 与 functionalRequirements 忠实来源材料：来源讲什么就出什么，不要发明来源里没有的核心功能。\n` +
      `- workload.patterns 必须与 schema 自洽：pattern 的 table 只能是 schema 里的表；path 是组件类型数组，从 client 出发到存储层；share 合计约 1。\n` +
      `- schema 是给答题者的【起始版】，可以朴素（比如该分片没分片、该加的索引没加），留出改进空间；referenceSolution.schema 是参考答案版（分片/索引/主键生成都经得起推敲）。两者的表集合应一致（同一批表，参数不同）。\n` +
      `- testCases 4–7 个：至少 1 个可见基线型（hidden=false，无 events/kills，稳态流量），其余多数隐藏，覆盖来源暗示的考点（热点、雪崩、单点、成本、一致性…）。每个用例至少一项阈值。\n` +
      `- schemaCases 2–4 个（数据库用例，形状见出题标准）：起始 schema 至少要挂掉其中一个隐藏用例，referenceSolution.schema 必须全过。\n` +
      `- sampleDesign 故意朴素：单链路、无缓存/无队列、副本少——能过基线、过不了峰值与隐藏用例是理想状态。\n` +
      `- referenceSolution 必须通过你出的【全部】用例（架构 + 数据库）；设计里每个节点都要有连线，流量从 client 出发能走到存储层。\n\n` +
      `输出 JSON：{"id":"like-system","name":"Design 点赞系统","nameEn":"Design a Like System","difficulty":"中等","tags":["计数","热点","缓存"],"statement":"题面…","functionalRequirements":["点赞/取消点赞","…"],"scale":{"dau":"1 亿 DAU","readRatio":0.95,"peakMultiplier":3,"baselineRps":2000,"budgetCostPerHour":300,"notes":"…"},"workload":{"readRatio":0.95,"consistency":"计数可最终一致…","patterns":[{"id":"w1","name":"查点赞数","kind":"read","description":"…","share":0.8,"path":["client","loadbalancer","appserver","cache","nosql"],"table":"likes","consistency":"eventual","terminalPerSec":5000}]},"schema":{"tables":[{"name":"likes","engine":"nosql","rows":10000000000,"primaryKey":"id","primaryKeyGen":"snowflake","shardKey":null,"fields":[{"name":"id","type":"bigint","indexed":true},{"name":"target_id","type":"bigint","indexed":true}]}],"accessPatterns":[{"id":"p1","name":"按对象查点赞数","table":"likes","kind":"count","byField":"target_id","perSec":5000}]},"cases":[{"id":"baseline","name":"基线负载","description":"…","hidden":false,"weight":1,"traffic":{"rps":2000,"readRatio":0.95},"durationTicks":30,"events":[],"kills":[],"thresholds":{"maxErrorRate":0.001,"maxP99Ms":500},"hint":"…"}],"schemaCases":[{"id":"sc1","name":"点赞数查询不能全表扫描","description":"…","hidden":true,"weight":2,"scale":"now","assertion":{"kind":"pattern-path","patternId":"p1","forbiddenPaths":["全表扫描"]}}],"sampleDesign":{"nodes":[{"id":"app","type":"appserver","settings":{}}],"edges":[]},"referenceSolution":{"design":{"nodes":[{"id":"c","type":"client","settings":{}}],"edges":[]},"schema":{"tables":[],"accessPatterns":[]}}}`,
  };
}

const DIFFICULTIES: readonly string[] = ['简单', '中等', '困难'];

function normalizeGeneratedWorkload(
  raw: unknown,
  tableNames: ReadonlySet<string>,
  fallbackReadRatio: number,
): ParsedWholeProblem['workload'] {
  const o = (raw ?? {}) as Record<string, unknown>;
  const patterns: GeneratedWorkloadPattern[] = [];
  if (Array.isArray(o.patterns)) {
    for (const p of o.patterns.slice(0, 10)) {
      const ap = p as Record<string, unknown> | null;
      if (!ap || typeof ap.name !== 'string' || !ap.name.trim()) continue;
      if (ap.kind !== 'read' && ap.kind !== 'write') continue;
      const path = Array.isArray(ap.path)
        ? ap.path
            .map((x) => String(x))
            .filter((x) => COMPONENT_TYPE_IDS.includes(x)) as ComponentTypeId[]
        : [];
      if (!path.length) continue;
      const table =
        typeof ap.table === 'string' && tableNames.has(ap.table) ? ap.table : undefined;
      patterns.push({
        id:
          typeof ap.id === 'string' && ap.id.trim()
            ? ap.id.trim().slice(0, 40)
            : `w-${patterns.length + 1}`,
        name: ap.name.trim().slice(0, 60),
        kind: ap.kind,
        description: typeof ap.description === 'string' ? ap.description.trim().slice(0, 300) : '',
        share: clampNum(ap.share, 0.01, 1) ?? 0.1,
        path,
        ...(table ? { table } : {}),
        consistency: ap.consistency === 'strong' ? 'strong' : 'eventual',
        ...(clampNum(ap.terminalPerSec, 0, 1_000_000) !== undefined
          ? { terminalPerSec: Math.round(clampNum(ap.terminalPerSec, 0, 1_000_000)!) }
          : {}),
      });
    }
  }
  return {
    readRatio: clampNum(o.readRatio, 0, 1) ?? fallbackReadRatio,
    consistency:
      typeof o.consistency === 'string' && o.consistency.trim()
        ? o.consistency.trim().slice(0, 500)
        : '（生成未给一致性说明）',
    ...(clampNum(o.fanoutFollowers, 1, 1_000_000_000) !== undefined
      ? { fanoutFollowers: Math.round(clampNum(o.fanoutFollowers, 1, 1_000_000_000)!) }
      : {}),
    patterns,
  };
}

/**
 * Parse the whole-problem generator's reply. Throws when the reply is
 * unusable as a whole (no statement, no tables, no cases, no designs) —
 * the host then reports an honest generation failure instead of storing a
 * hollow draft. Individual malformed pieces are dropped or defaulted,
 * mirroring parseGeneration's posture.
 */
export function parseWholeProblem(json: unknown): ParsedWholeProblem {
  const o = json as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') throw new Error('whole-problem: bad shape');
  const name = typeof o.name === 'string' ? o.name.trim().slice(0, 80) : '';
  const statement = typeof o.statement === 'string' ? o.statement.trim().slice(0, 4000) : '';
  if (!name || !statement) throw new Error('whole-problem: missing name/statement');

  const sc = (o.scale ?? {}) as Record<string, unknown>;
  const baselineRps = Math.round(clampNum(sc.baselineRps, 10, 1_000_000) ?? 500);
  const scaleReadRatio = clampNum(sc.readRatio, 0, 1) ?? 0.9;
  const scale: ParsedWholeProblem['scale'] = {
    dau: typeof sc.dau === 'string' && sc.dau.trim() ? sc.dau.trim().slice(0, 120) : '（生成未给量级）',
    readRatio: scaleReadRatio,
    peakMultiplier: clampNum(sc.peakMultiplier, 1, 100) ?? 3,
    baselineRps,
    budgetCostPerHour: Math.round(clampNum(sc.budgetCostPerHour, 1, 1_000_000) ?? 200),
    notes: typeof sc.notes === 'string' ? sc.notes.trim().slice(0, 500) : '',
  };

  const schema = normalizeGeneratedSchema(o.schema);
  if (!schema) throw new Error('whole-problem: starter schema unusable');
  const ref = (o.referenceSolution ?? {}) as { design?: unknown; schema?: unknown };
  const refSchema = normalizeGeneratedSchema(ref.schema);
  if (!refSchema) throw new Error('whole-problem: reference schema unusable');
  const tableNames = new Set([
    ...schema.tables.map((t) => t.name),
    ...refSchema.tables.map((t) => t.name),
  ]);

  const cases: GeneratedCase[] = [];
  if (Array.isArray(o.cases)) {
    for (const raw of o.cases) {
      const gc = normalizeGeneratedCase(raw, {
        baselineRps,
        defaultReadRatio: scaleReadRatio,
      });
      if (gc) cases.push(gc);
      if (cases.length >= 8) break;
    }
  }
  if (!cases.length) throw new Error('whole-problem: no usable cases');

  const sampleDesign = normalizeGeneratedDesign(o.sampleDesign);
  if (!sampleDesign) throw new Error('whole-problem: sample design unusable');
  const refDesign = normalizeGeneratedDesign(ref.design);
  if (!refDesign) throw new Error('whole-problem: reference design unusable');

  const idRaw = typeof o.id === 'string' ? o.id.trim().toLowerCase() : '';
  return {
    id: /^[a-z0-9][a-z0-9-]*$/.test(idRaw)
      ? idRaw.slice(0, 64)
      : idRaw
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 64),
    name,
    nameEn:
      typeof o.nameEn === 'string' && o.nameEn.trim() ? o.nameEn.trim().slice(0, 80) : name,
    difficulty: (DIFFICULTIES.includes(String(o.difficulty))
      ? String(o.difficulty)
      : '中等') as ParsedWholeProblem['difficulty'],
    tags: Array.isArray(o.tags)
      ? o.tags
          .filter((t): t is string => typeof t === 'string' && !!t.trim())
          .map((t) => t.trim().slice(0, 20))
          .slice(0, 6)
      : [],
    statement,
    functionalRequirements: Array.isArray(o.functionalRequirements)
      ? o.functionalRequirements
          .filter((r): r is string => typeof r === 'string' && !!r.trim())
          .map((r) => r.trim().slice(0, 200))
          .slice(0, 12)
      : [],
    scale,
    workload: normalizeGeneratedWorkload(o.workload, tableNames, scaleReadRatio),
    schema,
    cases,
    schemaCases: parseGeneratedSchemaCases(o.schemaCases),
    sampleDesign,
    referenceSolution: { design: refDesign, schema: refSchema },
  };
}
