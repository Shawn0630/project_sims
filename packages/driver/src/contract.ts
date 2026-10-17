import type { ComponentTypeId } from '@sds/components';
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
  return {
    system:
      '你是一位资深系统设计面试官，在给候选人的提交写评审。分数已由代码判卷给出（硬阈值），你的任务是解释分数、指出最关键的缺陷与修复优先级，结论必须引用给定的实测数据，不要编造数字，不要改判分数。只输出 JSON。',
    user:
      `题目：${ctx.problemName}\n候选人设计：\n${ctx.designSummary}\n\n本题读写需求：${ctx.workloadSummary}\n\n` +
      `代码判卷结果：${ctx.passed}/${ctx.total} 通过，得分 ${ctx.scorePct}。逐例：\n` +
      ctx.cases.map((c) => `- ${c.name}：${c.passed ? '通过' : `未通过 — ${c.failures.join('；')}（实测 ${JSON.stringify(c.measured)}）`}`).join('\n') +
      `\n\n结构缺陷（确定性规则，可信）：\n${ctx.structuralFindings.map((f) => `- [${f.severity}] ${f.title}：${f.detail}`).join('\n') || '（无）'}\n\n` +
      `输出 JSON：{"summary":"2-3 句总评","scoreRationale":"为什么是这个分数：失分集中在哪、先修哪个涨分最快","findings":[{"severity":"high|medium|low","title":"…","detail":"…"}]}`,
  };
}

export function parseSubmissionAssessment(json: unknown): SubmissionAssessment {
  const o = json as { summary?: unknown; scoreRationale?: unknown; findings?: unknown };
  if (typeof o.summary !== 'string') throw new Error('submission assessment: bad shape');
  const findings: DriverFinding[] = [];
  if (Array.isArray(o.findings)) {
    for (const f of o.findings) {
      const g = f as { severity?: unknown; title?: unknown; detail?: unknown };
      if (typeof g.title !== 'string') continue;
      findings.push({
        severity: (['high', 'medium', 'low'].includes(String(g.severity)) ? String(g.severity) : 'medium') as DriverFinding['severity'],
        title: g.title,
        detail: String(g.detail ?? ''),
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
