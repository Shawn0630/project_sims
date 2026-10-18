import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import process from 'node:process';
import { checkStructure, reviewSchema, runSuite } from '@sds/checker';
import type { ProblemSchema } from '@sds/problems';
import type { Design } from '@sds/sim-core';
import {
  buildSchemaSummary,
  evaluateFollowUps,
  evaluateSchema,
  evaluateSubmission,
  llmConfig,
  toSchemaReviewLike,
  type EvaluateKind,
} from './llm';
import { toClientPack } from './packs';
import { JsonProblemStorage, type ProblemStorage } from './storage';
import { registerAdminRoutes } from './admin';

/**
 * System Design Simulator — backend.
 *
 * The frontend is THIN: it runs the simulation engine and renders. Problem
 * data, judging, rule signals and every LLM call live here:
 *
 *   GET  /api/health              liveness + LLM configuration status
 *   GET  /api/problems            problem packs (hidden cases stripped)
 *   GET  /api/problems/:id        one pack (hidden cases stripped)
 *   POST /api/submissions/judge   code judging + structural + schema signals
 *   POST /api/evaluate            ONE LLM call (or scripted fallback) →
 *                                 structured assessment / follow-ups
 *   POST /api/problems/generate   STUB — the future problem-generation system
 *   GET  /admin + /api/admin/*     author console (see admin.ts) — pack CRUD,
 *                                 component registry + overrides, LLM call log.
 *                                 LOCAL USE ONLY: no auth in this round.
 *
 * Hidden test cases exist only in storage on this server; that is what makes
 * them actually secret (in the old browser-direct build they shipped inside
 * the JS bundle for anyone to read).
 */

// Optional local env file (apps/server/.env, gitignored). Shell env wins:
// loadEnvFile does not overwrite variables that are already set.
try {
  process.loadEnvFile(new URL('../.env', import.meta.url).pathname);
} catch {
  /* no .env file — env comes from the shell */
}

const storage: ProblemStorage = new JsonProblemStorage();
const app = new Hono();
app.use('/api/*', cors());
registerAdminRoutes(app, storage);

const badRequest = (message: string) => ({ error: 'bad_request', message }) as const;

function isDesign(v: unknown): v is Design {
  const d = v as Design | null;
  return !!d && Array.isArray(d.nodes) && Array.isArray(d.edges);
}

// ------------------------------------------------------------------ health -
app.get('/api/health', async (c) => {
  const cfg = llmConfig();
  let problemCount = 0;
  try {
    problemCount = (await storage.listProblems()).length;
  } catch {
    /* storage unreadable — report 0 rather than failing liveness */
  }
  return c.json({
    status: 'ok',
    storage: 'json-files',
    problems: problemCount,
    llmConfigured: cfg.apiKey.length > 0,
    llmBaseUrl: cfg.baseUrl,
    llmModel: cfg.model,
  });
});

// ---------------------------------------------------------------- problems -
app.get('/api/problems', async (c) => {
  const packs = await storage.listProblems();
  return c.json(packs.map(toClientPack));
});

app.get('/api/problems/:id', async (c) => {
  const pack = await storage.getProblem(c.req.param('id'));
  if (!pack) return c.json({ error: 'problem_not_found' }, 404);
  return c.json(toClientPack(pack));
});

// ------------------------------------------------------------------- judge -
app.post('/api/submissions/judge', async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    problemId?: unknown;
    design?: unknown;
    schema?: unknown;
    schemaLoadFactor?: unknown;
  } | null;
  if (!body || typeof body.problemId !== 'string' || !isDesign(body.design)) {
    return c.json(badRequest('需要 { problemId: string, design: { nodes, edges } }'), 400);
  }
  const problem = await storage.getProblem(body.problemId);
  if (!problem) return c.json({ error: 'problem_not_found' }, 404);

  const suite = runSuite(problem, body.design);
  const structural = checkStructure(problem, body.design);
  const schemaSignals = body.schema
    ? reviewSchema(body.schema as ProblemSchema, {
        loadFactor:
          typeof body.schemaLoadFactor === 'number' ? body.schemaLoadFactor : 0,
      })
    : null;
  return c.json({ problemId: problem.id, suite, structural, schemaSignals });
});

// ---------------------------------------------------------------- evaluate -
app.post('/api/evaluate', async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    kind?: unknown;
    context?: Record<string, unknown>;
  } | null;
  const kind = body?.kind as EvaluateKind | undefined;
  const ctx = body?.context;
  if (!kind || !['submission', 'schema', 'followups'].includes(kind) || !ctx) {
    return c.json(
      badRequest("需要 { kind: 'submission' | 'schema' | 'followups', context }"),
      400,
    );
  }

  if (kind === 'submission') {
    const outcome = await evaluateSubmission(
      ctx as unknown as Parameters<typeof evaluateSubmission>[0],
    );
    return c.json({ kind, ...outcome });
  }
  if (kind === 'followups') {
    const outcome = await evaluateFollowUps(
      ctx as unknown as Parameters<typeof evaluateFollowUps>[0],
    );
    return c.json({ kind, ...outcome });
  }

  // kind === 'schema': the context may arrive either as the full assessment
  // context ({ problemName, schemaSummary, signals }) or as raw material
  // ({ problemName?, schema, loadFactor? }) — in the latter case the server
  // computes the deterministic signals itself, so the frontend never has to.
  const raw = ctx as {
    problemName?: string;
    schemaSummary?: string;
    signals?: unknown;
    schema?: ProblemSchema;
    loadFactor?: number;
  };
  let report: ReturnType<typeof reviewSchema> | null = null;
  if (raw.schema) {
    report = reviewSchema(raw.schema, { loadFactor: raw.loadFactor ?? 0 });
  }
  const signals = raw.signals ?? (report ? toSchemaReviewLike(report) : null);
  if (!signals) {
    return c.json(badRequest('schema 评定需要 context.signals 或 context.schema'), 400);
  }
  const outcome = await evaluateSchema({
    problemName: raw.problemName ?? '',
    schemaSummary:
      raw.schemaSummary ?? (raw.schema ? buildSchemaSummary(raw.schema) : ''),
    signals: signals as Parameters<typeof evaluateSchema>[0]['signals'],
  });
  // When the server computed the signals, return the full checker report too
  // so the client can render the per-pattern table without judging locally.
  return c.json({ kind, ...outcome, ...(report ? { schemaSignals: report } : {}) });
});

// ------------------------------------------------- problem generation stub -
app.post('/api/problems/generate', async (c) => {
  const seed = (await c.req.json().catch(() => null)) as {
    title?: unknown;
    statement?: unknown;
    scaleNotes?: unknown;
  } | null;
  if (
    !seed ||
    typeof seed.title !== 'string' ||
    !seed.title.trim() ||
    typeof seed.statement !== 'string' ||
    !seed.statement.trim()
  ) {
    return c.json(
      badRequest('需要题目种子 { title: string, statement: string, scaleNotes?: string }'),
      400,
    );
  }
  // The seam for the fourth system (LLM problem generation). The generator
  // does not exist yet; the contract it will fulfil is pinned down here so
  // the other three systems can already code against it.
  return c.json(
    {
      error: 'not_implemented',
      message:
        'LLM 生成题目系统尚未实现。这里是预留接缝：给定题目种子，生成器将产出一份完整题目包并写入 storage，前三套系统随即消费。',
      seed: {
        title: seed.title,
        statement: seed.statement,
        scaleNotes: typeof seed.scaleNotes === 'string' ? seed.scaleNotes : '',
      },
      plannedContract: {
        input: '{ title, statement, scaleNotes } — 人给的题目种子（题面、核心流程、量级）',
        output:
          '一份 ProblemPack（与 GET /api/problems/:id 相同的完整结构），经 storage.saveProblem 落盘',
        pipeline: [
          '仿真侧：LLM 生成 workload 读写画像、场景集、基线/峰值参数；题目需要新组件时，按组件契约 extend 新组件（含该品类的常见设计问题模型）',
          '答题侧：生成题面、功能需求、量级、schema 初始草稿、可见测试用例',
          'Eval 侧：生成隐藏 edge 用例与通过阈值、结构检查重点、追问/评审 rubric 上下文',
          '自检后落盘：画像 share 合计 ≈ 1、全部用例可判卷、示例设计能跑通仿真',
        ],
      },
    },
    501,
  );
});

app.notFound((c) => c.json({ error: 'not_found' }, 404));

// -------------------------------------------------------------------- boot -
const port = Number(process.env.PORT ?? 8787);
const cfg = llmConfig();
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[sds-server] listening on http://localhost:${info.port}`);
  console.log(
    cfg.apiKey
      ? `[sds-server] LLM eval: ${cfg.model} @ ${cfg.baseUrl}`
      : '[sds-server] LLM eval: no LLM_API_KEY set — scripted fallback (offline mode)',
  );
});
