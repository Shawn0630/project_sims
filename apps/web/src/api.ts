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

export interface CaseMeasuredDTO {
  errorRate: number;
  p99Ms: number;
  costPerHour: number;
  maxStorageQps: number;
  staleReadRate: number;
  hottestUtil: number;
  queueDepthMax: number;
}

export interface CaseResultDTO {
  caseId: string;
  name: string;
  hidden: boolean;
  passed: boolean;
  measured: CaseMeasuredDTO;
  failures: string[];
  hint?: string;
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
}

export interface SubmissionAssessmentDTO {
  summary: string;
  scoreRationale: string;
  findings: AssessmentFindingDTO[];
}

export interface SchemaAssessmentDTO {
  conclusion: string;
  dimensionNotes: { dimension: '需求覆盖' | '延迟风险' | '扩展性'; note: string }[];
  suggestions: string[];
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
}

export interface EvaluateResponseDTO<T> {
  kind: string;
  source: 'llm' | 'scripted';
  label: string;
  data: T;
  /** Present on schema evaluations where the server computed the signals. */
  schemaSignals?: SchemaSignalsDTO;
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
): Promise<EvaluateResponseDTO<T>>;
export function evaluateOnServer<T>(
  kind: 'schema',
  context: { problemName: string; schema: ProblemSchemaDTO; loadFactor?: number },
): Promise<EvaluateResponseDTO<T>>;
export function evaluateOnServer<T>(
  kind: 'submission' | 'schema' | 'followups',
  context: unknown,
): Promise<EvaluateResponseDTO<T>> {
  return request<EvaluateResponseDTO<T>>('/api/evaluate', {
    method: 'POST',
    body: JSON.stringify({ kind, context }),
  });
}
