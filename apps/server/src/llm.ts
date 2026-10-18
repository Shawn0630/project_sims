import { type SchemaReviewReport } from '@sds/checker';
import type { Design } from '@sds/sim-core';
import {
  ScriptedDriver,
  buildFollowUpPrompt,
  buildGenerationPrompt,
  buildNextStepsPrompt,
  buildProbePrompt,
  buildSchemaPrompt,
  buildSubmissionPrompt,
  buildWholeProblemPrompt,
  parseFollowUps,
  parseGeneration,
  parseNextSteps,
  parseProbeCases,
  parseSchemaAssessment,
  parseSubmissionAssessment,
  parseWholeProblem,
  type ActionCoverage,
  type FollowUpContext,
  type FollowUpQuestion,
  type GenerationContext,
  type NextStep,
  type NextStepsContext,
  type ParsedGeneration,
  type ParsedWholeProblem,
  type ProbeCase,
  type ProbeContext,
  type SchemaAssessment,
  type SchemaAssessmentContext,
  type SchemaReviewLike,
  type SubmissionAssessment,
  type SubmissionAssessmentContext,
  type WholeProblemContext,
} from '@sds/driver';
import type { ProblemDef, ProblemSchema } from '@sds/problems';
import {
  guaranteeFindingActions,
  guaranteeNextStepActions,
  guaranteePredictionActions,
  guaranteeSchemaActions,
  type RepairCall,
} from './actions';
import { appendCall } from './calllog';
import { resolveProfileForCall } from './llmconfig';

/**
 * The LLM eval system's server half.
 *
 * Qualitative assessment is exactly ONE OpenAI-compatible chat completion
 * per request: the prompt is assembled by the SAME builders the driver
 * contract defines (@sds/driver), the reply is parsed by the contract's
 * defensive parsers, and the structured result goes back to the frontend,
 * which only renders it. Configuration comes from model PROFILES
 * (llmconfig.ts — admin-editable, resolved per call); the browser never
 * holds an LLM key:
 *
 *   data/llm-config.json   switchable profiles; the active one is the default
 *   (no file)              env LLM_BASE_URL / LLM_API_KEY / LLM_MODEL,
 *                          exactly the original behavior
 *
 * An evaluation may carry a `profileId` picked by the END USER in the
 * solver app: it is honored for that call only, and only when the admin
 * marked that profile userSelectable (resolveProfileForCall). The global
 * active profile is never changed by a user's pick.
 *
 * Any LLM failure (no key, network, bad JSON) falls back to ScriptedDriver,
 * which produces the same shapes from the deterministic judging signals.
 * One exception: TRANSIENT upstream failures — HTTP 429, any 5xx, and
 * network fetch errors — are retried (up to 2 extra attempts, ~1.5s then
 * ~4s backoff) before falling back, since providers like Gemini answer
 * load spikes with temporary 503s. Non-transient failures (other 4xx, a
 * 200 whose body does not parse) never retry. Every attempt is reflected
 * in the call's log record (attempt count + per-attempt errors).
 *
 * EVERY evaluation is recorded in the call log (calllog.ts): the real model
 * call with its full request/response, and the scripted fallback with the
 * context it consumed — the admin console's 「LLM 调用」 view reads them back.
 */

/** The three fields the call path consumes — a resolved profile fits. */
export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export type EvaluateKind = 'submission' | 'schema' | 'followups' | 'probe' | 'next-steps';

export interface EvaluateOutcome<T> {
  source: 'llm' | 'scripted';
  /** Attribution label the UI renders next to the assessment. */
  label: string;
  data: T;
  /** The model the effective profile names — what actually judged (or
   *  would have judged, on the scripted fallback path). */
  model: string;
  /** Name of the profile this call resolved to. */
  profileName: string;
  /** True when the end user picked this profile for this call. */
  viaUserChoice: boolean;
  /**
   * Action-guarantee accounting for this evaluation (submission / probe /
   * schema / next-steps kinds): how many assessed items ship ≥1
   * validated action, broken down by provenance. Absent on kinds
   * without actions (followups).
   */
  actionCoverage?: ActionCoverage;
}

const scripted = new ScriptedDriver();
const LLM_LABEL = '云端 LLM';

interface ChatResult {
  /** Raw message content exactly as the model returned it. */
  content: string;
  usage?: unknown;
}

/** The upstream answered with a non-2xx HTTP status. */
class LlmHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The upstream answered 200 but the body was not parseable JSON. */
class LlmResponseError extends Error {}

/**
 * Is repeating the identical call after a short wait plausibly useful?
 * 429 and 5xx are the provider saying "busy / broken right now", and a
 * fetch-level throw (DNS, connection reset, the 60s timeout) never got an
 * answer at all — all transient. Other 4xx are the request's own fault,
 * and a 200 with an unparseable body will not heal by resending.
 */
function classifyCallError(err: unknown): { message: string; transient: boolean } {
  if (err instanceof LlmHttpError) {
    return { message: err.message, transient: err.status === 429 || err.status >= 500 };
  }
  if (err instanceof LlmResponseError) {
    return { message: err.message, transient: false };
  }
  return { message: err instanceof Error ? err.message : String(err), transient: true };
}

async function chatCompletion(
  cfg: LlmConfig,
  requestBody: Record<string, unknown>,
): Promise<ChatResult> {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new LlmHttpError(res.status, `LLM API ${res.status}: ${await res.text()}`);
  }
  let data: { choices?: { message?: { content?: string } }[]; usage?: unknown };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    throw new LlmResponseError('LLM API returned HTTP 200 with a non-JSON body');
  }
  return { content: data.choices?.[0]?.message?.content ?? '', usage: data.usage };
}

/** Waits before retry attempts 2 and 3 — transient errors only. */
const RETRY_DELAYS_MS = [1_500, 4_000];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface ChatOutcome {
  /** The successful completion, or null when every attempt failed. */
  result: ChatResult | null;
  /** One entry per attempt made, in order; `error` set for failed attempts. */
  attempts: { error?: string }[];
}

/**
 * One logical model call with bounded retries on transient failures.
 * Non-transient failures return after the first attempt.
 */
async function chatWithRetry(
  cfg: LlmConfig,
  requestBody: Record<string, unknown>,
): Promise<ChatOutcome> {
  const attempts: { error?: string }[] = [];
  for (let i = 0; ; i += 1) {
    try {
      const result = await chatCompletion(cfg, requestBody);
      attempts.push({});
      return { result, attempts };
    } catch (err) {
      const { message, transient } = classifyCallError(err);
      attempts.push({ error: message });
      if (!transient || i >= RETRY_DELAYS_MS.length) {
        return { result: null, attempts };
      }
      await sleep(RETRY_DELAYS_MS[i] + Math.floor(Math.random() * 300));
    }
  }
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/**
 * Post-processing hook for the action-guarantee ladder (actions.ts). It
 * runs INSIDE runLogged — before the call-log record is appended — so the
 * logged responseParsed is the ENRICHED data (actions attached, sources
 * tagged) and the record itself carries the coverage accounting. On the
 * LLM path it receives a repair caller bound to the same resolved
 * profile; on the scripted path repairCall is null (there is no model
 * output to repair — synthesis/fallback still run).
 */
type EnrichFn<T> = (
  data: T,
  repairCall: RepairCall | null,
  source: 'llm' | 'scripted',
) => Promise<{ data: T; coverage?: ActionCoverage }>;

/**
 * The single logged evaluation path. With a key configured: assemble the
 * prompt, make ONE model call, log the full request + raw response + parsed
 * result (or the failure), and return the parsed outcome. Without a key —
 * or after any failure — run the ScriptedDriver and log that too, marked
 * source=scripted with the assembled context as its recorded input.
 */
async function runLogged<T>(
  kind: EvaluateKind,
  ctx: unknown,
  build: () => { system: string; user: string },
  parse: (json: unknown) => T,
  scriptedFn: () => Promise<T>,
  profileId?: string,
  enrich?: EnrichFn<T>,
): Promise<EvaluateOutcome<T>> {
  // Resolve the model profile fresh for THIS call: normally the server's
  // active profile; when the end user picked one of the admin-opened
  // (userSelectable) profiles, that one — for this call only. An admin
  // switch or a user pick both take effect with no restart.
  const { profile: cfg, viaUserChoice } = await resolveProfileForCall(profileId);
  let fellBackFromError: string | null = null;

  /**
   * Ladder step 2's call: ONE bounded action-repair re-prompt on the SAME
   * profile, logged like every other call (same kind; the note marks it
   * as the repair pass). Returns the parsed JSON, or null when the call
   * failed / did not parse — the ladder then degrades to rule synthesis.
   */
  const repairCall: RepairCall = async (prompt) => {
    if (!cfg.apiKey) return null;
    const requestBody = {
      model: cfg.model,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      response_format: { type: 'json_object' },
    };
    const t0 = Date.now();
    const { result, attempts } = await chatWithRetry(cfg, requestBody);
    const attemptErrors = attempts.flatMap((a) => (a.error ? [a.error] : []));
    const note = '动作修复轮（action-repair pass）：为缺少合法动作的条目补一键修复动作，与主调用同一档案';
    if (!result) {
      appendCall({
        kind,
        source: 'llm',
        ok: false,
        baseUrlHost: hostOf(cfg.baseUrl),
        model: cfg.model,
        profileName: cfg.name,
        viaUserChoice,
        durationMs: Date.now() - t0,
        request: requestBody,
        error: attemptErrors[attemptErrors.length - 1] ?? 'LLM call failed',
        attempts: attempts.length,
        attemptErrors,
        note,
      });
      return null;
    }
    const raw = result.content;
    try {
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      const parsed = JSON.parse(cleaned) as unknown;
      appendCall({
        kind,
        source: 'llm',
        ok: true,
        baseUrlHost: hostOf(cfg.baseUrl),
        model: cfg.model,
        profileName: cfg.name,
        viaUserChoice,
        durationMs: Date.now() - t0,
        usage: result.usage,
        request: requestBody,
        responseRaw: raw,
        responseParsed: parsed,
        attempts: attempts.length,
        ...(attemptErrors.length ? { attemptErrors } : {}),
        note,
      });
      return parsed;
    } catch (err) {
      appendCall({
        kind,
        source: 'llm',
        ok: false,
        baseUrlHost: hostOf(cfg.baseUrl),
        model: cfg.model,
        profileName: cfg.name,
        viaUserChoice,
        durationMs: Date.now() - t0,
        request: requestBody,
        responseRaw: raw,
        error: err instanceof Error ? err.message : String(err),
        attempts: attempts.length,
        ...(attemptErrors.length ? { attemptErrors } : {}),
        note,
      });
      return null;
    }
  };

  if (cfg.apiKey) {
    const prompt = build();
    const requestBody = {
      model: cfg.model,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      response_format: { type: 'json_object' },
    };
    const t0 = Date.now();
    // One logical call; transient upstream failures (429 / 5xx / network)
    // retry inside chatWithRetry before we give up and fall back.
    const { result, attempts } = await chatWithRetry(cfg, requestBody);
    const attemptErrors = attempts.flatMap((a) => (a.error ? [a.error] : []));
    const retrySummary =
      attempts.length > 1
        ? `共尝试 ${attempts.length} 次${result ? '，重试后成功' : '，全部失败'}；失败尝试：${attemptErrors.join('；')}`
        : undefined;
    if (result) {
      const raw = result.content;
      try {
        const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
        let data = parse(JSON.parse(cleaned) as unknown);
        // Action-guarantee ladder (validation → repair → synthesis →
        // fallback) runs BEFORE the log record: what is logged and what
        // is returned is the enriched result, sources tagged.
        let actionCoverage: ActionCoverage | undefined;
        if (enrich) {
          const enriched = await enrich(data, repairCall, 'llm');
          data = enriched.data;
          actionCoverage = enriched.coverage;
        }
        appendCall({
          kind,
          source: 'llm',
          ok: true,
          baseUrlHost: hostOf(cfg.baseUrl),
          model: cfg.model,
          profileName: cfg.name,
          viaUserChoice,
          durationMs: Date.now() - t0,
          usage: result.usage,
          request: requestBody,
          responseRaw: raw,
          responseParsed: data,
          attempts: attempts.length,
          ...(attemptErrors.length ? { attemptErrors } : {}),
          ...(retrySummary ? { note: retrySummary } : {}),
          ...(actionCoverage ? { actionCoverage } : {}),
        });
        return {
          source: 'llm',
          label: `${LLM_LABEL} · ${cfg.model}`,
          data,
          model: cfg.model,
          profileName: cfg.name,
          viaUserChoice,
          ...(actionCoverage ? { actionCoverage } : {}),
        };
      } catch (err) {
        // The call succeeded but its content did not parse — resending the
        // identical request is not the fix, so no retry happened for this.
        fellBackFromError = err instanceof Error ? err.message : String(err);
        appendCall({
          kind,
          source: 'llm',
          ok: false,
          baseUrlHost: hostOf(cfg.baseUrl),
          model: cfg.model,
          profileName: cfg.name,
          viaUserChoice,
          durationMs: Date.now() - t0,
          request: requestBody,
          responseRaw: raw,
          error: fellBackFromError,
          attempts: attempts.length,
          ...(attemptErrors.length ? { attemptErrors } : {}),
          ...(retrySummary ? { note: retrySummary } : {}),
        });
      }
    } else {
      fellBackFromError = attemptErrors[attemptErrors.length - 1] ?? 'LLM call failed';
      appendCall({
        kind,
        source: 'llm',
        ok: false,
        baseUrlHost: hostOf(cfg.baseUrl),
        model: cfg.model,
        profileName: cfg.name,
        viaUserChoice,
        durationMs: Date.now() - t0,
        request: requestBody,
        error: fellBackFromError,
        attempts: attempts.length,
        attemptErrors,
        ...(retrySummary ? { note: retrySummary } : {}),
      });
    }
  }

  const t0 = Date.now();
  let data = await scriptedFn();
  // The ladder applies to scripted output too — minus the repair call
  // (there is no model output to repair): findings' rule-derived actions
  // are validated/tagged and anything missing is synthesized or falls
  // back, so scripted coverage is full as well.
  let actionCoverage: ActionCoverage | undefined;
  if (enrich) {
    const enriched = await enrich(data as T, null, 'scripted');
    data = enriched.data as Awaited<T>;
    actionCoverage = enriched.coverage;
  }
  appendCall({
    kind,
    source: 'scripted',
    ok: true,
    baseUrlHost: hostOf(cfg.baseUrl),
    model: cfg.model,
    profileName: cfg.name,
    viaUserChoice,
    durationMs: Date.now() - t0,
    request: { context: ctx },
    responseParsed: data,
    note: fellBackFromError
      ? `LLM 调用失败后的回落（错误见上一条记录）：${fellBackFromError}`
      : '未配置 LLM_API_KEY，离线脚本评审',
    ...(actionCoverage ? { actionCoverage } : {}),
  });
  return {
    source: 'scripted',
    label: scripted.label,
    data,
    model: cfg.model,
    profileName: cfg.name,
    viaUserChoice,
    ...(actionCoverage ? { actionCoverage } : {}),
  };
}

/**
 * The no-design degenerate path of the guarantee: without the submitted
 * design there is nothing to validate or synthesize against, so actions
 * are stripped entirely (unvalidated ops never reach the frontend) and
 * the coverage honestly reports zero. The real app always sends the
 * design; this exists so a bare API caller cannot smuggle raw ops out.
 */
function zeroCoverage(count: number): ActionCoverage {
  return {
    findings: count,
    withActions: 0,
    bySource: { llm: 0, repaired: 0, rule: 0, fallback: 0 },
    nonMechanical: 0,
  };
}

export async function evaluateSubmission(
  ctx: SubmissionAssessmentContext,
  profileId?: string,
  design?: Design,
  problem?: ProblemDef,
): Promise<EvaluateOutcome<SubmissionAssessment>> {
  return runLogged(
    'submission',
    ctx,
    () => buildSubmissionPrompt(ctx),
    parseSubmissionAssessment,
    () => scripted.assessSubmission(ctx),
    profileId,
    async (data, repairCall, source) => {
      if (!design) {
        const findings = data.findings.map((f) => {
          const next = { ...f };
          delete next.actions;
          delete next.actionSource;
          return next;
        });
        return { data: { ...data, findings }, coverage: zeroCoverage(findings.length) };
      }
      const r = await guaranteeFindingActions(data.findings, design, {
        baseSource: source === 'llm' ? 'llm' : 'rule',
        repairCall,
        ...(problem ? { problem } : {}),
        problemName: ctx.problemName,
        designSummary: ctx.designSummary,
      });
      return { data: { ...data, findings: r.findings }, coverage: r.coverage };
    },
  );
}

export async function evaluateFollowUps(
  ctx: FollowUpContext,
  profileId?: string,
): Promise<EvaluateOutcome<FollowUpQuestion[]>> {
  return runLogged(
    'followups',
    ctx,
    () => buildFollowUpPrompt(ctx),
    parseFollowUps,
    () => scripted.generateFollowUps(ctx),
    profileId,
  );
}

/**
 * The probe step: the model proposes failure cases for this design from
 * the judging criteria alone (it never sees the static suite). The
 * returned cases are normalized/clamped by the contract parser; the host
 * then runs them through the simulator (probe.ts) and grades predictions.
 */
export async function evaluateProbes(
  ctx: ProbeContext,
  profileId?: string,
  design?: Design,
  problem?: ProblemDef,
): Promise<EvaluateOutcome<ProbeCase[]>> {
  return runLogged(
    'probe',
    ctx,
    () => buildProbePrompt(ctx),
    parseProbeCases,
    () => scripted.generateProbes(ctx),
    profileId,
    async (data, repairCall, source) => {
      if (!design) {
        const cases = data.map((pc) => {
          const prediction = { ...pc.prediction };
          delete prediction.actions;
          delete prediction.actionSource;
          return { ...pc, prediction };
        });
        return {
          data: cases,
          coverage: zeroCoverage(cases.filter((pc) => pc.prediction.willFail).length),
        };
      }
      // Predictions' fix actions run the ladder against this design now,
      // and AGAIN inside verify-probes after the cases round-trip the
      // client (ensureVerifiedActions) — nothing untrusted ships.
      const r = await guaranteePredictionActions(data, design, {
        baseSource: source === 'llm' ? 'llm' : 'rule',
        repairCall,
        ...(problem ? { problem } : {}),
        problemName: ctx.problemName,
        designSummary: ctx.designSummary,
      });
      return { data: r.cases, coverage: r.coverage };
    },
  );
}

/**
 * The per-case next steps: ONE pinned, applicable action per FAILED
 * case, proposed by the model against the case's measured numbers
 * (division of labour: the submission review is broad commentary; this
 * is the single move to make next, per red case).
 *
 * The scripted path needs no ScriptedDriver method: its "script" IS the
 * ladder's deterministic synthesis (measured capacity first), which
 * lives server-side because it needs the checker — so scriptedFn
 * returns nothing and the enrich step constructs every step, honestly
 * sourced 'rule'/'fallback'. The same degradation serves an LLM
 * failure: runLogged falls back, the ladder still ships steps.
 */
export async function evaluateNextSteps(
  ctx: NextStepsContext,
  profileId?: string,
  design?: Design,
  problem?: ProblemDef,
): Promise<EvaluateOutcome<NextStep[]>> {
  const failedIds = new Set(ctx.failedCases.map((c) => c.caseId));
  return runLogged(
    'next-steps',
    ctx,
    () => buildNextStepsPrompt(ctx),
    (json) => parseNextSteps(json, failedIds),
    async () => [],
    profileId,
    async (data, repairCall, source) => {
      if (!design) {
        // No design to validate against: unvalidated ops never ship.
        const steps = data.map((s) => {
          const next = { ...s };
          delete next.actions;
          delete next.actionSource;
          return next;
        });
        return { data: steps, coverage: zeroCoverage(ctx.failedCases.length) };
      }
      const r = await guaranteeNextStepActions(data, ctx.failedCases, design, {
        baseSource: source === 'llm' ? 'llm' : 'rule',
        repairCall,
        ...(problem ? { problem } : {}),
        problemName: ctx.problemName,
        designSummary: ctx.designSummary,
      });
      return { data: r.steps, coverage: r.coverage };
    },
  );
}

export async function evaluateSchema(
  ctx: SchemaAssessmentContext,
  profileId?: string,
  schema?: ProblemSchema,
  report?: SchemaReviewReport,
): Promise<EvaluateOutcome<SchemaAssessment>> {
  return runLogged(
    'schema',
    ctx,
    () => buildSchemaPrompt(ctx),
    parseSchemaAssessment,
    () => scripted.assessSchema(ctx),
    profileId,
    async (data, repairCall, source) => {
      const r = await guaranteeSchemaActions(data.suggestions, schema, {
        baseSource: source === 'llm' ? 'llm' : 'rule',
        repairCall,
        problemName: ctx.problemName,
        ...(report ? { report } : {}),
        schemaSummary: ctx.schemaSummary,
      });
      return { data: { ...data, suggestions: r.suggestions }, coverage: r.coverage };
    },
  );
}

// ------------------------------------------------------- problem generation -

/**
 * Generation failures are HONEST errors, never a scripted fallback: there
 * is no deterministic way to invent good test cases + a reference
 * solution, and fabricating them would poison the problem bank. The code
 * distinguishes "no LLM configured" (the author must set up a profile)
 * from an upstream failure and from unparsable model output.
 */
export class GenerationLlmError extends Error {
  constructor(
    readonly code: 'llm_required' | 'llm_call_failed' | 'llm_bad_output',
    message: string,
  ) {
    super(message);
  }
}

export interface GenerationOutcome {
  data: ParsedGeneration;
  model: string;
  profileName: string;
  viaUserChoice: boolean;
}

export interface WholeProblemOutcome {
  data: ParsedWholeProblem;
  model: string;
  profileName: string;
  viaUserChoice: boolean;
}

interface GenerationCallOutcome<T> {
  data: T;
  model: string;
  profileName: string;
  viaUserChoice: boolean;
}

/**
 * The generator's ONE model call, shared by both generation modes
 * (extension + whole-problem), through the same logged, profile-resolved,
 * retrying path as every evaluation (kind 'generate' in the call log).
 * Unlike evaluations it never falls back to the scripted driver —
 * failures throw GenerationLlmError with the cause. `note` is recorded
 * on the log record so the mode (and, for whole-problem, the source
 * type) is visible in the admin call log.
 */
async function runGenerationCall<T>(
  build: () => { system: string; user: string },
  parse: (json: unknown) => T,
  profileId: string | undefined,
  note?: string,
): Promise<GenerationCallOutcome<T>> {
  const { profile: cfg, viaUserChoice } = await resolveProfileForCall(profileId);
  if (!cfg.apiKey) {
    throw new GenerationLlmError(
      'llm_required',
      `生成题目需要可用的 LLM 档案：当前档案「${cfg.name}」没有配置 API key。脚本模式不会伪造题目——请在 admin「模型配置」里给档案填上 key，或切换到已配置的档案后重试。`,
    );
  }
  const prompt = build();
  const requestBody = {
    model: cfg.model,
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
    response_format: { type: 'json_object' },
  };
  const t0 = Date.now();
  const { result, attempts } = await chatWithRetry(cfg, requestBody);
  const attemptErrors = attempts.flatMap((a) => (a.error ? [a.error] : []));
  const retrySummary =
    attempts.length > 1
      ? `共尝试 ${attempts.length} 次${result ? '，重试后成功' : '，全部失败'}；失败尝试：${attemptErrors.join('；')}`
      : undefined;
  const logNote = [note, retrySummary].filter(Boolean).join('；') || undefined;
  if (!result) {
    const error = attemptErrors[attemptErrors.length - 1] ?? 'LLM call failed';
    appendCall({
      kind: 'generate',
      source: 'llm',
      ok: false,
      baseUrlHost: hostOf(cfg.baseUrl),
      model: cfg.model,
      profileName: cfg.name,
      viaUserChoice,
      durationMs: Date.now() - t0,
      request: requestBody,
      error,
      attempts: attempts.length,
      attemptErrors,
      ...(logNote ? { note: logNote } : {}),
    });
    throw new GenerationLlmError('llm_call_failed', `生成调用失败：${error}`);
  }
  const raw = result.content;
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const data = parse(JSON.parse(cleaned) as unknown);
    appendCall({
      kind: 'generate',
      source: 'llm',
      ok: true,
      baseUrlHost: hostOf(cfg.baseUrl),
      model: cfg.model,
      profileName: cfg.name,
      viaUserChoice,
      durationMs: Date.now() - t0,
      usage: result.usage,
      request: requestBody,
      responseRaw: raw,
      responseParsed: data,
      attempts: attempts.length,
      ...(attemptErrors.length ? { attemptErrors } : {}),
      ...(logNote ? { note: logNote } : {}),
    });
    return { data, model: cfg.model, profileName: cfg.name, viaUserChoice };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendCall({
      kind: 'generate',
      source: 'llm',
      ok: false,
      baseUrlHost: hostOf(cfg.baseUrl),
      model: cfg.model,
      profileName: cfg.name,
      viaUserChoice,
      durationMs: Date.now() - t0,
      request: requestBody,
      responseRaw: raw,
      error: message,
      attempts: attempts.length,
      ...(attemptErrors.length ? { attemptErrors } : {}),
      ...(logNote ? { note: logNote } : {}),
    });
    throw new GenerationLlmError('llm_bad_output', `生成结果不可用：${message}`);
  }
}

/** Extension mode: new cases + a reference solution for an EXISTING problem. */
export async function generateProblemContent(
  ctx: GenerationContext,
  profileId?: string,
): Promise<GenerationOutcome> {
  return runGenerationCall(
    () => buildGenerationPrompt(ctx),
    (json) =>
      parseGeneration(json, {
        baselineRps: ctx.baselineRps,
        defaultReadRatio: ctx.defaultReadRatio,
      }),
    profileId,
    `扩充生成：为已有题目「${ctx.problemName}」生成 ${ctx.caseCount} 个新用例 + 参考解`,
  );
}

/**
 * Whole-problem mode: an ENTIRE new problem from the author's source
 * material (URL / pasted text / uploaded doc). Same honest-failure
 * contract — no key, no draft; nothing is ever fabricated.
 */
export async function generateWholeProblemContent(
  ctx: WholeProblemContext,
  profileId?: string,
): Promise<WholeProblemOutcome> {
  return runGenerationCall(
    () => buildWholeProblemPrompt(ctx),
    parseWholeProblem,
    profileId,
    `整题生成：来源=${ctx.sourceType}（${ctx.sourceLabel}）${ctx.sourceTruncated ? '，来源已截断' : ''}`,
  );
}

// ------------------------------------------------- schema context assembly -

/** Checker report → the contract shape the assessment layer consumes. */
export function toSchemaReviewLike(report: SchemaReviewReport): SchemaReviewLike {
  return {
    score: report.score,
    coverage: report.coverage,
    coveragePassed: report.coveragePassed,
    coverageTotal: report.coverageTotal,
    findings: report.findings,
    perPattern: report.perPattern.map((p) => ({
      pattern: p.name,
      path: p.path,
      latencyMs: p.latencyMs,
      verdict: p.verdict,
      note: p.note,
    })),
  };
}

/** Human-readable schema rendering for the LLM context (server-side). */
export function buildSchemaSummary(schema: ProblemSchema): string {
  return schema.tables
    .map(
      (t) =>
        `表 ${t.name}（${t.engine === 'relational' ? '关系型' : 'NoSQL'}，${t.rows.toLocaleString()} 行）：` +
        `主键 ${t.primaryKey}（生成=${t.primaryKeyGen}），分片键 ${t.shardKey ?? '无'}，字段：` +
        t.fields
          .map((f) => `${f.name}:${f.type}${f.indexed ? '（索引）' : ''}${f.blob ? '（大字段）' : ''}`)
          .join('、'),
    )
    .join('\n');
}
