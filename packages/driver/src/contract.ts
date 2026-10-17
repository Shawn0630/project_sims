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

export interface CaseResultLike {
  caseId: string;
  name: string;
  passed: boolean;
  failures: string[];
  measured: Record<string, number>;
}

export interface SchemaFindingLike {
  dimension: '需求覆盖' | '延迟风险' | '扩展性';
  severity: 'high' | 'medium' | 'low';
  text: string;
}

export interface SchemaReviewLike {
  score: number;
  coverage: string;
  findings: SchemaFindingLike[];
  perPattern: { pattern: string; path: string; latencyMs: number; verdict: string }[];
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

export interface Driver {
  readonly kind: DriverKind;
  readonly label: string;
  review(tools: SimulatorTools, ctx: DriverContext): Promise<DriverReview>;
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
