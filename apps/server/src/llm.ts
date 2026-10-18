import type { SchemaReviewReport } from '@sds/checker';
import {
  ScriptedDriver,
  buildFollowUpPrompt,
  buildProbePrompt,
  buildSchemaPrompt,
  buildSubmissionPrompt,
  parseFollowUps,
  parseProbeCases,
  parseSchemaAssessment,
  parseSubmissionAssessment,
  type FollowUpContext,
  type FollowUpQuestion,
  type ProbeCase,
  type ProbeContext,
  type SchemaAssessment,
  type SchemaAssessmentContext,
  type SchemaReviewLike,
  type SubmissionAssessment,
  type SubmissionAssessmentContext,
} from '@sds/driver';
import type { ProblemSchema } from '@sds/problems';
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

export type EvaluateKind = 'submission' | 'schema' | 'followups' | 'probe';

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
): Promise<EvaluateOutcome<T>> {
  // Resolve the model profile fresh for THIS call: normally the server's
  // active profile; when the end user picked one of the admin-opened
  // (userSelectable) profiles, that one — for this call only. An admin
  // switch or a user pick both take effect with no restart.
  const { profile: cfg, viaUserChoice } = await resolveProfileForCall(profileId);
  let fellBackFromError: string | null = null;

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
        const data = parse(JSON.parse(cleaned) as unknown);
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
        });
        return {
          source: 'llm',
          label: `${LLM_LABEL} · ${cfg.model}`,
          data,
          model: cfg.model,
          profileName: cfg.name,
          viaUserChoice,
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
  const data = await scriptedFn();
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
  });
  return {
    source: 'scripted',
    label: scripted.label,
    data,
    model: cfg.model,
    profileName: cfg.name,
    viaUserChoice,
  };
}

export async function evaluateSubmission(
  ctx: SubmissionAssessmentContext,
  profileId?: string,
): Promise<EvaluateOutcome<SubmissionAssessment>> {
  return runLogged(
    'submission',
    ctx,
    () => buildSubmissionPrompt(ctx),
    parseSubmissionAssessment,
    () => scripted.assessSubmission(ctx),
    profileId,
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
): Promise<EvaluateOutcome<ProbeCase[]>> {
  return runLogged(
    'probe',
    ctx,
    () => buildProbePrompt(ctx),
    parseProbeCases,
    () => scripted.generateProbes(ctx),
    profileId,
  );
}

export async function evaluateSchema(
  ctx: SchemaAssessmentContext,
  profileId?: string,
): Promise<EvaluateOutcome<SchemaAssessment>> {
  return runLogged(
    'schema',
    ctx,
    () => buildSchemaPrompt(ctx),
    parseSchemaAssessment,
    () => scripted.assessSchema(ctx),
    profileId,
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
