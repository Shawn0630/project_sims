import type { ComponentTypeId } from '@sds/components';
import type { Design, EventType, TrafficConfig } from '@sds/sim-core';

/**
 * The thin-frontend API layer.
 *
 * The web app holds NO problem logic: no problem data, no test cases, no
 * judging or review code. Everything problem-shaped arrives at runtime from
 * the backend (apps/server) as rendering data, and every verdict — suite
 * judging, structural signals, schema signals, LLM assessments, follow-up
 * questions — is computed by the backend and only RENDERED here.
 *
 * The interfaces below are the client's view of the wire format (DTOs).
 * They intentionally live here, not in the problem/checker/driver packages:
 * the frontend's contract is the HTTP API, nothing else.
 *
 * Backend address: VITE_API_URL at build time, default http://localhost:8787.
 * There is deliberately NO local fallback — if the backend is unreachable,
 * the app shows a "backend required" screen instead of inventing problems.
 */

export const API_URL = (
  (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8787'
).replace(/\/$/, '');

// ------------------------------------------------------------ problem DTOs -

export interface CaseThresholdsDTO {
  maxErrorRate?: number;
  maxP99Ms?: number;
  maxCostPerHour?: number;
  maxStorageQps?: number;
  maxStaleReadRate?: number;
  maxHottestUtil?: number;
  maxQueueDepth?: number;
}

export interface ProblemCaseDTO {
  id: string;
  name: string;
  description: string;
  hidden: boolean;
  weight: number;
  traffic: TrafficConfig;
  durationTicks: number;
  events?: {
    atTick: number;
    type: EventType;
    targetType?: ComponentTypeId;
    magnitude?: number;
    durationTicks?: number;
  }[];
  kills?: { componentType: ComponentTypeId; atTick: number }[];
  thresholds: CaseThresholdsDTO;
  exposesRule?: string;
  hint?: string;
  /** True for hidden cases in a fetched pack: scenario data is stripped. */
  locked?: boolean;
}

export interface SchemaFieldDTO {
  name: string;
  type: string;
  indexed: boolean;
  blob?: boolean;
}

export interface SchemaTableDTO {
  name: string;
  engine: 'relational' | 'nosql';
  rows: number;
  primaryKey: string;
  primaryKeyGen: 'auto' | 'snowflake' | 'uuid' | 'business';
  shardKey: string | null;
  fields: SchemaFieldDTO[];
}

export interface AccessPatternDTO {
  id: string;
  name: string;
  table: string;
  kind: 'read' | 'write' | 'count';
  byField: string;
  needsSort?: boolean;
  perSec: number;
}

export interface ProblemSchemaDTO {
  tables: SchemaTableDTO[];
  accessPatterns: AccessPatternDTO[];
}

export interface WorkloadPatternDTO {
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

export interface WorkloadProfileDTO {
  readRatio: number;
  consistency: string;
  fanoutFollowers?: number;
  patterns: WorkloadPatternDTO[];
}

export interface ProblemScaleDTO {
  dau: string;
  readRatio: number;
  peakMultiplier: number;
  baselineRps: number;
  budgetCostPerHour: number;
  notes: string;
}

/** A problem pack as served by GET /api/problems[/:id] — rendering data. */
export interface ProblemPack {
  id: string;
  name: string;
  nameEn: string;
  difficulty: '简单' | '中等' | '困难';
  tags: string[];
  statement: string;
  functionalRequirements: string[];
  scale: ProblemScaleDTO;
  flags: {
    mediaHeavy: boolean;
    hasFanout: boolean;
    publicWriteApi: boolean;
    readHeavy: boolean;
  };
  schema: ProblemSchemaDTO;
  workload: WorkloadProfileDTO;
  testCases: ProblemCaseDTO[];
  sampleDesign: Design;
}

// ------------------------------------------------------------ judging DTOs -

/**
 * One structured fix action, in the edit-op vocabulary the backend
 * validates (driver contract). Actions arrive ALREADY validated against
 * the design snapshot they were generated for; the UI offers them as
 * one-click fixes behind a highlighted preview + explicit confirm.
 */
export type EditOpDTO =
  | { op: 'setSetting'; nodeId: string; key: string; value: string | number | boolean }
  | {
      op: 'addComponent';
      componentType: ComponentTypeId;
      connectFromId?: string;
      connectToId?: string;
      /** Id the created node will carry — lets later ops in the same
       *  list chain onto it (queue insert, then its worker). Server
       *  validation stamps it; apply honors it verbatim. */
      newNodeId?: string;
    }
  | { op: 'addEdge'; fromId: string; toId: string };

export interface CaseMeasuredDTO {
  errorRate: number;
  p99Ms: number;
  costPerHour: number;
  maxStorageQps: number;
  staleReadRate: number;
  hottestUtil: number;
  queueDepthMax: number;
  /** The measured bottleneck: which node peaked hottest this run. */
  hottestNode: { nodeId: string; type: ComponentTypeId; util: number } | null;
}

/** A one-click fix linked to a failed case (validated ops, preview + confirm). */
export interface CaseFixDTO {
  /**
   * `<ruleId>#<index>` — a structural finding's slot in the judge
   * response's structural array; or `capacity#<nodeId>` — the synthesized
   * bottleneck-capacity fix sized from the measured hottest node.
   */
  findingId: string;
  title: string;
  actions: EditOpDTO[];
  /** Provenance of the actions — deterministic fixes are 'rule'. */
  actionSource?: ActionSourceDTO;
}

export interface CaseResultDTO {
  caseId: string;
  name: string;
  hidden: boolean;
  passed: boolean;
  measured: CaseMeasuredDTO;
  failures: string[];
  hint?: string;
  /** Fixes linked to this failure; present (maybe empty) on failed cases only. */
  fixes?: CaseFixDTO[];
}

export interface SuiteResultDTO {
  results: CaseResultDTO[];
  passedCount: number;
  totalCount: number;
  scorePct: number;
}

export interface StructuralFindingDTO {
  ruleId: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  componentIds: string[];
  exposedBy?: string;
  /** Canned one-click fix (server-validated), when the rule implies one. */
  actions?: EditOpDTO[];
}

export interface SchemaFindingDTO {
  dimension: '需求覆盖' | '延迟风险' | '扩展性';
  severity: 'high' | 'medium' | 'low';
  text: string;
}

export interface PatternVerdictDTO {
  patternId: string;
  name: string;
  table: string;
  path: string;
  latencyMs: number;
  verdict: string;
  note: string;
}

/** Deterministic schema signals (paths / latencies / findings) from the server. */
export interface SchemaSignalsDTO {
  score: number;
  coveragePassed: number;
  coverageTotal: number;
  coverage: string;
  perPattern: PatternVerdictDTO[];
  findings: SchemaFindingDTO[];
}

export interface JudgeResponseDTO {
  problemId: string;
  suite: SuiteResultDTO;
  structural: StructuralFindingDTO[];
  schemaSignals: SchemaSignalsDTO | null;
}

// ---------------------------------------------------------- assessment DTOs -

export interface FollowUpQuestionDTO {
  level: '基础' | '进阶' | '追问' | '故障';
  question: string;
  keyPoints: string[];
}

export interface AssessmentFindingDTO {
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  componentId?: string;
  /** One-click fix actions (server-validated against the submitted design). */
  actions?: EditOpDTO[];
  /** Provenance of the actions: llm / repaired / rule / fallback. */
  actionSource?: ActionSourceDTO;
}

// ------------------------------------------------------- action guarantee -
// Every evaluation finding ships with ≥1 server-validated action (the
// server ladder: first-pass validation → ONE repair re-prompt → rule
// synthesis → universal fallback). The response carries the accounting;
// each item carries its actions' provenance, rendered next to its apply
// button so the user can see the fix's pedigree at a glance.

/** Where an item's actions came from. */
export type ActionSourceDTO = 'llm' | 'repaired' | 'rule' | 'fallback';

export interface ActionCoverageDTO {
  /** Assessed items (probe predictions count only when they predict failure). */
  findings: number;
  /** Of those, how many ship ≥1 validated action. */
  withActions: number;
  bySource: { llm: number; repaired: number; rule: number; fallback: number };
  /** Declared non-mechanical items the ladder let ship actionless. */
  nonMechanical: number;
}

/**
 * One schema mutation, in the schema-op vocabulary the backend validates
 * against the submitted schema (table/field must exist, enums legal,
 * no-ops dropped). Applied to the schema DRAFT behind a preview +
 * confirm, mirroring the architecture fix loop.
 */
export type SchemaOpDTO =
  | { op: 'setShardKey'; table: string; field: string | null }
  | { op: 'addIndex'; table: string; field: string }
  | { op: 'setPrimaryKeyGen'; table: string; gen: 'auto' | 'snowflake' | 'uuid' | 'business' }
  | { op: 'setEngine'; table: string; engine: 'relational' | 'nosql' };

export interface SchemaSuggestionDTO {
  text: string;
  /** Executable form of the suggestion (server-validated schema-ops). */
  actions?: SchemaOpDTO[];
  actionSource?: ActionSourceDTO;
}

export interface SubmissionAssessmentDTO {
  summary: string;
  scoreRationale: string;
  findings: AssessmentFindingDTO[];
}

export interface SchemaAssessmentDTO {
  conclusion: string;
  dimensionNotes: { dimension: '需求覆盖' | '延迟风险' | '扩展性'; note: string }[];
  suggestions: SchemaSuggestionDTO[];
}

/** Context for follow-up generation — assembled from runtime data only. */
export interface FollowUpContextDTO {
  problemName: string;
  componentType: ComponentTypeId;
  componentName: string;
  componentSettingsSummary: string;
  liveMetricsSummary?: string;
  upstreamTypes: ComponentTypeId[];
  designSummary: string;
  workload: {
    readRatio: number;
    consistency: string;
    patternsHere: {
      name: string;
      kind: 'read' | 'write';
      share: number;
      description: string;
      consistency: 'strong' | 'eventual';
    }[];
    readShareHere: number;
  };
  schemaSummary?: string;
  failedCases: { id: string; name: string; failures: string[] }[];
  structuralFindings: StructuralFindingDTO[];
}

/**
 * One pinned next action for one FAILED case — the per-case counterpart
 * of the broad AI review. The server ladder guarantees every failed case
 * ships a step with ≥1 validated action; `actionSource` says where the
 * actions came from (AI 生成 / AI·已修复 / 规则·实测 / 兜底）.
 */
export interface NextStepDTO {
  caseId: string;
  /** The action in one line. */
  title: string;
  /** Why — cites the case's measured numbers. */
  rationale: string;
  actions?: EditOpDTO[];
  actionSource?: ActionSourceDTO;
}

/** Context for next-step generation — the submission's FAILED cases only. */
export interface NextStepsContextDTO {
  problemName: string;
  designSummary: string;
  schemaSummary?: string;
  workloadSummary: string;
  structuralFindings: StructuralFindingDTO[];
  failedCases: {
    caseId: string;
    name: string;
    /** Judge failure lines — measured vs threshold, verbatim. */
    failures: string[];
    measured: CaseMeasuredDTO;
    /** The measured bottleneck of this case's run. */
    hottestNode?: { nodeId: string; type: ComponentTypeId; util: number } | null;
    /** The case's thresholds, when the pack exposes them (visible cases). */
    thresholds?: CaseThresholdsDTO;
  }[];
}

/** Context for the post-submission qualitative review. */
export interface SubmissionAssessmentContextDTO {
  problemName: string;
  designSummary: string;
  workloadSummary: string;
  scorePct: number;
  passed: number;
  total: number;
  cases: {
    caseId: string;
    name: string;
    passed: boolean;
    failures: string[];
    measured: CaseMeasuredDTO;
  }[];
  structuralFindings: StructuralFindingDTO[];
  /** Verified probe results — when present, the review grounds on these
   *  and the static per-case list above is sent empty on purpose. */
  probeResults?: VerifiedProbeDTO[];
}

// ------------------------------------------------------------- probe DTOs -
// The LLM proposes probe cases from the judging criteria alone (it never
// sees the static suite); the backend converts each proposal into a real
// test case, runs it through the simulator and grades the prediction.

export interface ProbeCaseDTO {
  name: string;
  scenario: {
    trafficMultiplier: number;
    durationSec: number;
    readRatio?: number;
    events: { type: EventType; targetType?: ComponentTypeId; magnitude?: number }[];
    kills: ComponentTypeId[];
  };
  thresholds: {
    p99Ms?: number;
    maxErrorRatePct?: number;
    maxCostPerHour?: number;
    maxStorageQps?: number;
    maxHottestUtilPct?: number;
    maxStaleReadPct?: number;
    maxQueueDepth?: number;
  };
  prediction: {
    willFail: boolean;
    primaryBreach: string;
    rationale: string;
    fixHint: string;
    actions?: EditOpDTO[];
    /** Provenance of the fix actions: llm / repaired / rule / fallback. */
    actionSource?: ActionSourceDTO;
  };
}

/** Context for probe generation — design + criteria inputs, NO cases. */
export interface ProbeContextDTO {
  problemName: string;
  designSummary: string;
  schemaSummary?: string;
  workloadSummary: string;
  structuralFindings: StructuralFindingDTO[];
  baselineRps: number;
  readRatio: number;
  budgetCostPerHour: number;
  nodes: { id: string; type: ComponentTypeId; name: string }[];
}

/**
 * A concrete executable scenario in checker units — what the simulator
 * ran for a probe, or a judged suite case's full scenario. Powers the
 * local quick re-simulation (visual preview only, never a re-judge).
 */
export interface ExecutedScenarioDTO {
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
  thresholds: CaseThresholdsDTO;
}

export interface VerifiedProbeDTO {
  name: string;
  scenarioSummary: string;
  prediction: ProbeCaseDTO['prediction'];
  passed: boolean;
  measured: CaseMeasuredDTO;
  failures: string[];
  actualBreach: string | null;
  verdict: 'hit' | 'held' | 'miss';
  /** The scenario exactly as executed — for local quick re-simulation. */
  scenario?: ExecutedScenarioDTO;
}

export interface EvaluateResponseDTO<T> {
  kind: string;
  source: 'llm' | 'scripted';
  label: string;
  data: T;
  /** The model the server's effective profile used for this call. */
  model?: string;
  /** Name of the profile the call resolved to (server-side label). */
  profileName?: string;
  /** True when the call ran on the profile the user picked below. */
  viaUserChoice?: boolean;
  /** Action-guarantee accounting for this evaluation, when applicable. */
  actionCoverage?: ActionCoverageDTO;
  /** Present on schema evaluations where the server computed the signals. */
  schemaSignals?: SchemaSignalsDTO;
}

// ------------------------------------------------------- user model choice -
// The admin may open some model profiles to end users (their userSelectable
// flag, set in the backend admin). GET /api/models lists ONLY those, with
// name + model — keys and endpoints never reach the browser. The user's
// pick is a bare profile id in localStorage; the server re-validates it on
// every call and silently falls back to its default when it is not (or no
// longer) selectable.

/** localStorage key holding the user-chosen evaluation profile id. */
export const EVAL_PROFILE_KEY = 'sds-eval-profile-id';

export interface UserModelDTO {
  profileId: string;
  name: string;
  model: string;
  /** True when this profile is also the server's active default. */
  isDefault: boolean;
}

export interface HealthDTO {
  status: string;
  storage: string;
  problems: number;
  llmConfigured: boolean;
  llmBaseUrl: string;
  llmModel: string;
}

// ------------------------------------------------------------------ client -

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    throw new Error(`API ${path} → ${res.status}`);
  }
  return (await res.json()) as T;
}

export function fetchHealth(): Promise<HealthDTO> {
  return request<HealthDTO>('/api/health');
}

/** Model profiles the admin opened to end users (empty when none are). */
export function fetchUserModels(): Promise<UserModelDTO[]> {
  return request<UserModelDTO[]>('/api/models');
}

/** The profile id the user picked in ⚙ 设置 ('' = follow the server default). */
export function chosenEvalProfileId(): string {
  try {
    return localStorage.getItem(EVAL_PROFILE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function fetchProblems(): Promise<ProblemPack[]> {
  return request<ProblemPack[]>('/api/problems');
}

/** Code judging on the server: suite + structural findings + schema signals. */
export function judgeOnServer(body: {
  problemId: string;
  design: Design;
  schema?: ProblemSchemaDTO;
  schemaLoadFactor?: number;
}): Promise<JudgeResponseDTO> {
  return request<JudgeResponseDTO>('/api/submissions/judge', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * One qualitative-evaluation call. The server makes the single LLM call (or
 * the scripted fallback) and returns structured data; the UI only renders.
 */
export function evaluateOnServer<T>(
  kind: 'submission' | 'followups',
  context: SubmissionAssessmentContextDTO | FollowUpContextDTO,
  design?: Design,
  problemId?: string,
): Promise<EvaluateResponseDTO<T>>;
export function evaluateOnServer<T>(
  kind: 'probe',
  context: ProbeContextDTO,
  design?: Design,
  problemId?: string,
): Promise<EvaluateResponseDTO<T>>;
export function evaluateOnServer<T>(
  kind: 'next-steps',
  context: NextStepsContextDTO,
  design?: Design,
  problemId?: string,
): Promise<EvaluateResponseDTO<T>>;
export function evaluateOnServer<T>(
  kind: 'schema',
  context: { problemName: string; schema: ProblemSchemaDTO; loadFactor?: number },
): Promise<EvaluateResponseDTO<T>>;
export function evaluateOnServer<T>(
  kind: 'submission' | 'schema' | 'followups' | 'probe' | 'next-steps',
  context: unknown,
  design?: Design,
  problemId?: string,
): Promise<EvaluateResponseDTO<T>> {
  // The user's model pick rides along as a bare profile id; the server
  // honors it only if the admin opened that profile to end users.
  const profileId = chosenEvalProfileId();
  return request<EvaluateResponseDTO<T>>('/api/evaluate', {
    method: 'POST',
    body: JSON.stringify({
      kind,
      context,
      ...(profileId ? { profileId } : {}),
      // The design snapshot the assessment is about: the server's action
      // ladder validates / repairs / synthesizes fix actions against it.
      ...(design ? { design } : {}),
      // Lets the ladder measure the design's genuinely hottest node.
      ...(problemId ? { problemId } : {}),
    }),
  });
}

/**
 * The simulator as arbiter: the backend executes each proposed probe case
 * against the submitted design and grades the LLM's prediction.
 */
export function verifyProbesOnServer(body: {
  problemId: string;
  design: Design;
  cases: ProbeCaseDTO[];
}): Promise<{ problemId: string; results: VerifiedProbeDTO[]; actionCoverage?: ActionCoverageDTO }> {
  return request<{ problemId: string; results: VerifiedProbeDTO[]; actionCoverage?: ActionCoverageDTO }>(
    '/api/submissions/verify-probes',
    { method: 'POST', body: JSON.stringify(body) },
  );
}

/**
 * One judged case's executable scenario, fetched on demand. Visible cases
 * already carry theirs in the pack; hidden cases are served one at a time
 * here — only for cases a submission has revealed — so the local quick
 * re-simulation can run them.
 */
export function fetchCaseScenario(
  problemId: string,
  caseId: string,
): Promise<{ problemId: string; caseId: string; scenario: ExecutedScenarioDTO }> {
  return request('/api/submissions/case-scenario', {
    method: 'POST',
    body: JSON.stringify({ problemId, caseId }),
  });
}
