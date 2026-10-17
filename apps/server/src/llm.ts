import process from 'node:process';
import type { SchemaReviewReport } from '@sds/checker';
import {
  ScriptedDriver,
  buildFollowUpPrompt,
  buildSchemaPrompt,
  buildSubmissionPrompt,
  parseFollowUps,
  parseSchemaAssessment,
  parseSubmissionAssessment,
  type FollowUpContext,
  type FollowUpQuestion,
  type SchemaAssessment,
  type SchemaAssessmentContext,
  type SchemaReviewLike,
  type SubmissionAssessment,
  type SubmissionAssessmentContext,
} from '@sds/driver';
import type { ProblemSchema } from '@sds/problems';

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

export type EvaluateKind = 'submission' | 'schema' | 'followups';

export interface EvaluateOutcome<T> {
  source: 'llm' | 'scripted';
  /** Attribution label the UI renders next to the assessment. */
  label: string;
  data: T;
}

const scripted = new ScriptedDriver();
const LLM_LABEL = '云端 LLM';

async function chatJson(cfg: LlmConfig, system: string, user: string): Promise<unknown> {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(`LLM API ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content ?? '';
  const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(cleaned) as unknown;
}

/** Try the LLM once; on any failure return null so the caller falls back. */
async function tryLlm<T>(
  build: () => { system: string; user: string },
  parse: (json: unknown) => T,
): Promise<EvaluateOutcome<T> | null> {
  const cfg = llmConfig();
  if (!cfg.apiKey) return null;
  try {
    const p = build();
    return { source: 'llm', label: LLM_LABEL, data: parse(await chatJson(cfg, p.system, p.user)) };
  } catch {
    return null;
  }
}

export async function evaluateSubmission(
  ctx: SubmissionAssessmentContext,
): Promise<EvaluateOutcome<SubmissionAssessment>> {
  return (
    (await tryLlm(() => buildSubmissionPrompt(ctx), parseSubmissionAssessment)) ?? {
      source: 'scripted',
      label: scripted.label,
      data: await scripted.assessSubmission(ctx),
    }
  );
}

export async function evaluateFollowUps(
  ctx: FollowUpContext,
): Promise<EvaluateOutcome<FollowUpQuestion[]>> {
  return (
    (await tryLlm(() => buildFollowUpPrompt(ctx), parseFollowUps)) ?? {
      source: 'scripted',
      label: scripted.label,
      data: await scripted.generateFollowUps(ctx),
    }
  );
}

export async function evaluateSchema(
  ctx: SchemaAssessmentContext,
): Promise<EvaluateOutcome<SchemaAssessment>> {
  return (
    (await tryLlm(() => buildSchemaPrompt(ctx), parseSchemaAssessment)) ?? {
      source: 'scripted',
      label: scripted.label,
      data: await scripted.assessSchema(ctx),
    }
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
