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
    }
  | { op: 'addEdge'; fromId: string; toId: string };

export const MAX_EDIT_OPS = 3;

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
      out.push({
        op: 'addComponent',
        componentType: String(o.componentType) as ComponentTypeId,
        ...(from ? { connectFromId: from } : {}),
        ...(to ? { connectToId: to } : {}),
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
   * Optional one-click fix in the edit-op vocabulary. Present only after
   * server-side validation against the submitted design (see EditOp).
   */
  actions?: EditOp[];
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
   * Optional structured form of fixHint, in the edit-op vocabulary. The
   * server validates these against the submitted design when the probe is
   * verified; only surviving ops are offered as a one-click fix.
   */
  actions?: EditOp[];
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
}

export interface SchemaAssessment {
  conclusion: string;
  dimensionNotes: { dimension: '需求覆盖' | '延迟风险' | '扩展性'; note: string }[];
  suggestions: string[];
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
      `每条 finding 可选附带 actions：一键可应用的结构化改法（用户预览确认后由系统执行），只能用这三种操作，且 nodeId 必须引用上面设计摘要里出现的 id：\n` +
      `- {"op":"setSetting","nodeId":"节点id","key":"参数名","value":值}：参数名只能是该组件类型合法的参数——通用 replicas（整数）/ capacityScale；网关 rateLimitPerSec；缓存 mutexRebuild（布尔）/ eviction；负载均衡 lbAlgorithm；关系型 DB 与 NoSQL 的 sharded（布尔）/ shardKey（字符串）/ readReplicas（整数）/ consistency。\n` +
      `- {"op":"addComponent","componentType":"cache","connectFromId":"上游节点id","connectToId":"下游节点id"}：在两个已有节点之间插入一个新组件（两端 id 至少给一个）。\n` +
      `- {"op":"addEdge","fromId":"节点id","toId":"节点id"}：新增一条连线。\n` +
      `修法无法用这三种操作准确表达时，省略 actions，不要硬凑；每条 finding 最多 3 个操作。\n\n` +
      `输出 JSON：{"summary":"2-3 句总评","scoreRationale":"为什么是这个分数：失分集中在哪、先修哪个涨分最快","findings":[{"severity":"high|medium|low","title":"…","detail":"…","actions":[{"op":"setSetting","nodeId":"…","key":"replicas","value":2}]}]}`,
  };
}

export function parseSubmissionAssessment(json: unknown): SubmissionAssessment {
  const o = json as { summary?: unknown; scoreRationale?: unknown; findings?: unknown };
  if (typeof o.summary !== 'string') throw new Error('submission assessment: bad shape');
  const findings: DriverFinding[] = [];
  if (Array.isArray(o.findings)) {
    for (const f of o.findings) {
      const g = f as { severity?: unknown; title?: unknown; detail?: unknown; actions?: unknown };
      if (typeof g.title !== 'string') continue;
      const actions = sanitizeEditOps(g.actions);
      findings.push({
        severity: (['high', 'medium', 'low'].includes(String(g.severity)) ? String(g.severity) : 'medium') as DriverFinding['severity'],
        title: g.title,
        detail: String(g.detail ?? ''),
        ...(actions.length ? { actions } : {}),
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
      `代码规则信号：得分 ${ctx.signals.score}，${ctx.signals.coverage}\n逐条访问模式：\n` +
      ctx.signals.perPattern.map((p) => `- ${p.pattern}：${p.path} · 约 ${p.latencyMs}ms · ${p.verdict}${p.note ? `（${p.note}）` : ''}`).join('\n') +
      `\n规则发现：\n${ctx.signals.findings.map((f) => `- [${f.dimension}/${f.severity}] ${f.text}`).join('\n') || '（无）'}\n\n` +
      `输出 JSON：{"conclusion":"2-3 句总评","dimensionNotes":[{"dimension":"需求覆盖|延迟风险|扩展性","note":"…"}],"suggestions":["具体可执行的改进，按优先级"]}`,
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
  return {
    conclusion: o.conclusion,
    dimensionNotes,
    suggestions: Array.isArray(o.suggestions) ? o.suggestions.map(String).slice(0, 6) : [],
  };
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
      `prediction.actions 是 fixHint 的结构化版本（可选，用户一键应用）：只能用 setSetting / addComponent / addEdge 三种操作，nodeId 只能引用设计摘要里出现的 id，setSetting 的 key 只能是该组件类型合法的参数（replicas / capacityScale / rateLimitPerSec / mutexRebuild / eviction / lbAlgorithm / sharded / shardKey / readReplicas / consistency）。表达不了就省略，不要硬凑；每条最多 3 个操作。`,
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
