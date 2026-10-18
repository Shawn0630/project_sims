import process from 'node:process';
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

/**
 * The LLM eval system's server half.
 *
 * Qualitative assessment is exactly ONE OpenAI-compatible chat completion
 * per request: the prompt is assembled by the SAME builders the driver
 * contract defines (@sds/driver), the reply is parsed by the contract's
 * defensive parsers, and the structured result goes back to the frontend,
 * which only renders it. Configuration comes from server env — the browser
 * never holds an LLM key:
 *
 *   LLM_BASE_URL  (default https://api.openai.com/v1)
 *   LLM_API_KEY   (unset → scripted fallback, server still fully works)
 *   LLM_MODEL     (default gpt-4o-mini)
 *
 * Any LLM failure (no key, network, bad JSON) falls back to ScriptedDriver,
 * which produces the same shapes from the deterministic judging signals.
 *
 * EVERY evaluation is recorded in the call log (calllog.ts): the real model
 * call with its full request/response, and the scripted fallback with the
 * context it consumed — the admin console's 「LLM 调用」 view reads them back.
 */

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function llmConfig(
  env: Record<string, string | undefined> = process.env,
): LlmConfig {
  return {
    baseUrl: (env.LLM_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, ''),
    apiKey: env.LLM_API_KEY ?? '',
    model: env.LLM_MODEL ?? 'gpt-4o-mini',
  };
}

export type EvaluateKind = 'submission' | 'schema' | 'followups' | 'probe';

export interface EvaluateOutcome<T> {
  source: 'llm' | 'scripted';
  /** Attribution label the UI renders next to the assessment. */
  label: string;
  data: T;
}

const scripted = new ScriptedDriver();
const LLM_LABEL = '云端 LLM';

interface ChatResult {
  /** Raw message content exactly as the model returned it. */
  content: string;
  usage?: unknown;
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
    throw new Error(`LLM API ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: unknown;
  };
  return { content: data.choices?.[0]?.message?.content ?? '', usage: data.usage };
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
): Promise<EvaluateOutcome<T>> {
  const cfg = llmConfig();
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
    let raw = '';
    try {
      const r = await chatCompletion(cfg, requestBody);
      raw = r.content;
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      const data = parse(JSON.parse(cleaned) as unknown);
      appendCall({
        kind,
        source: 'llm',
        ok: true,
        baseUrlHost: hostOf(cfg.baseUrl),
        model: cfg.model,
        durationMs: Date.now() - t0,
        usage: r.usage,
        request: requestBody,
        responseRaw: raw,
        responseParsed: data,
      });
      return { source: 'llm', label: LLM_LABEL, data };
    } catch (err) {
      fellBackFromError = err instanceof Error ? err.message : String(err);
      appendCall({
        kind,
        source: 'llm',
        ok: false,
        baseUrlHost: hostOf(cfg.baseUrl),
        model: cfg.model,
        durationMs: Date.now() - t0,
        request: requestBody,
        ...(raw ? { responseRaw: raw } : {}),
        error: fellBackFromError,
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
    durationMs: Date.now() - t0,
    request: { context: ctx },
    responseParsed: data,
    note: fellBackFromError
      ? `LLM 调用失败后的回落（错误见上一条记录）：${fellBackFromError}`
      : '未配置 LLM_API_KEY，离线脚本评审',
  });
  return { source: 'scripted', label: scripted.label, data };
}

export async function evaluateSubmission(
  ctx: SubmissionAssessmentContext,
): Promise<EvaluateOutcome<SubmissionAssessment>> {
  return runLogged(
    'submission',
    ctx,
    () => buildSubmissionPrompt(ctx),
    parseSubmissionAssessment,
    () => scripted.assessSubmission(ctx),
  );
}

export async function evaluateFollowUps(
  ctx: FollowUpContext,
): Promise<EvaluateOutcome<FollowUpQuestion[]>> {
  return runLogged(
    'followups',
    ctx,
    () => buildFollowUpPrompt(ctx),
    parseFollowUps,
    () => scripted.generateFollowUps(ctx),
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
): Promise<EvaluateOutcome<ProbeCase[]>> {
  return runLogged(
    'probe',
    ctx,
    () => buildProbePrompt(ctx),
    parseProbeCases,
    () => scripted.generateProbes(ctx),
  );
}

export async function evaluateSchema(
  ctx: SchemaAssessmentContext,
): Promise<EvaluateOutcome<SchemaAssessment>> {
  return runLogged(
    'schema',
    ctx,
    () => buildSchemaPrompt(ctx),
    parseSchemaAssessment,
    () => scripted.assessSchema(ctx),
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
