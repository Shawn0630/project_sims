import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import process from 'node:process';
import {
  attachCaseFixes,
  buildSchemaSimSummary,
  checkStructure,
  judgeSchemaCases,
  reviewSchema,
  runSuite,
  schemaSimBudgetMs,
  simulateSchema,
  validateEditOps,
  type SchemaSimResult,
} from '@sds/checker';
import type {
  ExecutedScenario,
  SchemaNextStepAnchor,
  SchemaNextStepsContext,
  SchemaProbeContext,
  StructuralFindingLike,
} from '@sds/driver';
import type { ProblemSchema } from '@sds/problems';
import type { Design } from '@sds/sim-core';
import {
  buildSchemaSummary,
  evaluateFollowUps,
  evaluateNextSteps,
  evaluateProbes,
  evaluateSchema,
  evaluateSchemaNextSteps,
  evaluateSchemaProbes,
  evaluateSubmission,
  toSchemaReviewLike,
  type EvaluateKind,
} from './llm';
import { listUserSelectableProfiles, resolveActiveProfile } from './llmconfig';
import { verifyProbes } from './probe';
import { verifySchemaProbes } from './schemaprobe';
import { toClientPack } from './packs';
import { JsonProblemStorage, type ProblemStorage } from './storage';
import { registerAdminRoutes } from './admin';
import { registerGenerationRoutes } from './generate';

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
 *                                 + the schema's own test suite (schemaSuite,
 *                                 sim-judged, scored independently)
 *   POST /api/schema/simulate     run the problem's requirement workload
 *                                 against a candidate schema (the schema
 *                                 simulator: paths, measured latencies,
 *                                 shard load, ×10 growth, real query text)
 *                                 — design-time display; submission-time
 *                                 schema judging lives in the judge route
 *   POST /api/submissions/verify-probes
 *                                 run LLM-proposed probe cases through the
 *                                 simulator and grade their predictions
 *   POST /api/submissions/verify-schema-probes
 *                                 the database mirror: re-run LLM-proposed
 *                                 data scenarios through the schema
 *                                 simulator and grade their predictions
 *   POST /api/submissions/case-scenario
 *                                 the executable scenario of ONE judged case
 *                                 (incl. hidden ones, on demand) — powers the
 *                                 frontend's local quick re-simulation
 *   POST /api/evaluate            ONE LLM call (or scripted fallback) →
 *                                 structured assessment / follow-ups / probes /
 *                                 next-steps (one pinned action per failed
 *                                 case, ladder-guaranteed like the rest) /
 *                                 schema-probe (adversarial data scenarios
 *                                 for the schema) / schema-next-steps (one
 *                                 pinned action per failed schema anchor).
 *                                 Optional body.profileId: an end user's pick
 *                                 among admin-opened (userSelectable) model
 *                                 profiles — honored for that call only
 *   GET  /api/models              the userSelectable model profiles (name +
 *                                 model only — no keys, no endpoints)
 *   POST /api/problems/generate   the fourth system (see generate.ts): the
 *                                 LLM extends an existing problem — new test
 *                                 cases + a reference solution — validated
 *                                 by the simulator and stored as an admin
 *                                 review draft (accept/discard there)
 *   POST /api/problems/generate-from-source
 *                                 whole-problem generation: the author gives
 *                                 a source (URL fetched server-side / pasted
 *                                 text / uploaded .md|.txt), the LLM authors
 *                                 an ENTIRE new problem, validated whole
 *                                 (reference vs its own cases, sample
 *                                 discrimination, pack shape) and stored as a
 *                                 kind 'new-problem' draft; accepting it in
 *                                 admin writes a new pack (409 on id clash)
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
registerGenerationRoutes(app, storage);

const badRequest = (message: string) => ({ error: 'bad_request', message }) as const;

function isDesign(v: unknown): v is Design {
  const d = v as Design | null;
  return !!d && Array.isArray(d.nodes) && Array.isArray(d.edges);
}

// ------------------------------------------------------------------ health -
app.get('/api/health', async (c) => {
  const cfg = await resolveActiveProfile();
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
    llmProfile: cfg.name,
    llmConfigSource: cfg.source,
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

// ------------------------------------------------- user-selectable models -
// End users may pick which model evaluates their work, but only among the
// profiles the admin explicitly opened (userSelectable in llm-config.json).
// This projection carries name + model + a default marker — keys and
// baseUrls never leave the server.
app.get('/api/models', async (c) => {
  return c.json(await listUserSelectableProfiles());
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

  const design: Design = body.design;
  const rawFindings = checkStructure(problem, design);
  // Failed case rows carry their own one-click fixes: the structural
  // findings that plausibly explain each failure (grounded linkage only —
  // see attachCaseFixes in @sds/checker), so the fix loop can start from
  // the failing row itself. Actions are re-validated at attach time.
  const suite = attachCaseFixes(problem, design, runSuite(problem, design), rawFindings);
  // Canned fix actions are built from this very design, but re-validate
  // before responding anyway: only ops that survive validation against
  // the submitted design may ever be offered as one-click fixes.
  const structural: StructuralFindingLike[] = rawFindings.map((f) => {
    const actions = validateEditOps(f.actions, design);
    const { actions: _canned, ...rest } = f;
    return actions.length ? { ...rest, actions } : rest;
  });
  const schemaSignals = body.schema
    ? reviewSchema(body.schema as ProblemSchema, {
        loadFactor:
          typeof body.schemaLoadFactor === 'number' ? body.schemaLoadFactor : 0,
      })
    : null;
  // The database design's OWN test suite: the schema sim judges the
  // pack's schemaTestCases deterministically. Scored independently —
  // it rides along in the response but never touches the suite score.
  const schemaSuite =
    body.schema && (problem.schemaTestCases ?? []).length > 0
      ? judgeSchemaCases(problem, body.schema as ProblemSchema)
      : null;
  return c.json({ problemId: problem.id, suite, structural, schemaSignals, schemaSuite });
});

// --------------------------------------------------------- schema simulate -
// The schema simulator: RUN the problem's requirement workload (its
// access patterns at their declared rates) against the candidate schema
// and report measured paths / latencies / rows examined / shard load at
// current scale and at ×10 data growth. One code path (@sds/checker
// simulateSchema) serves the design-time panel, the submit-time review
// evidence, the schema test-case judging (judge route) and the schema
// probe verification alike — a single arbiter for every DB-side number.
function isSchema(v: unknown): v is ProblemSchema {
  const s = v as ProblemSchema | null;
  return !!s && Array.isArray(s.tables);
}

app.post('/api/schema/simulate', async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    problemId?: unknown;
    schema?: unknown;
  } | null;
  if (!body || typeof body.problemId !== 'string' || !isSchema(body.schema)) {
    return c.json(badRequest('需要 { problemId: string, schema: { tables: [...] } }'), 400);
  }
  const problem = await storage.getProblem(body.problemId);
  if (!problem) return c.json({ error: 'problem_not_found' }, 404);
  const sim = simulateSchema(problem, body.schema);
  return c.json({ problemId: problem.id, sim });
});

// ------------------------------------------------------- probe verification -
// The LLM proposes probe cases from the judging criteria (POST /api/evaluate
// kind=probe); this endpoint is the arbiter: each proposal is re-validated,
// converted to a real test case and executed through the same checker path
// as the static suite, and its prediction is graded (hit / held / miss).
app.post('/api/submissions/verify-probes', async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    problemId?: unknown;
    design?: unknown;
    cases?: unknown;
  } | null;
  if (
    !body ||
    typeof body.problemId !== 'string' ||
    !isDesign(body.design) ||
    !Array.isArray(body.cases)
  ) {
    return c.json(
      badRequest('需要 { problemId: string, design: { nodes, edges }, cases: ProbeCase[] }'),
      400,
    );
  }
  const problem = await storage.getProblem(body.problemId);
  if (!problem) return c.json({ error: 'problem_not_found' }, 404);
  const { results, actionCoverage } = verifyProbes(problem, body.design, body.cases);
  return c.json({ problemId: problem.id, results, actionCoverage });
});

// ------------------------------------------------- schema probe verification -
// The schema-side arbiter: each proposed data scenario is re-normalized,
// re-run through the schema simulator and graded (hit / held / miss);
// fix actions are re-validated / scenario-grounded (schemaprobe.ts).
app.post('/api/submissions/verify-schema-probes', async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    problemId?: unknown;
    schema?: unknown;
    cases?: unknown;
  } | null;
  if (
    !body ||
    typeof body.problemId !== 'string' ||
    !isSchema(body.schema) ||
    !Array.isArray(body.cases)
  ) {
    return c.json(
      badRequest('需要 { problemId: string, schema: { tables: [...] }, cases: SchemaProbeCase[] }'),
      400,
    );
  }
  const problem = await storage.getProblem(body.problemId);
  if (!problem) return c.json({ error: 'problem_not_found' }, 404);
  const { results, actionCoverage } = verifySchemaProbes(
    problem,
    body.schema as ProblemSchema,
    body.cases,
  );
  return c.json({ problemId: problem.id, results, actionCoverage });
});

// ------------------------------------------------------------ case scenario -
// Quick re-simulation needs a case's executable scenario locally. Visible
// cases ship in the pack already; hidden ones do not. This endpoint serves
// ONE case's scenario on demand — the client only asks for cases a
// submission has already revealed (its row in the results panel), so the
// pack-level secrecy model is unchanged: nothing is listed or bulk-served.
app.post('/api/submissions/case-scenario', async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    problemId?: unknown;
    caseId?: unknown;
  } | null;
  if (!body || typeof body.problemId !== 'string' || typeof body.caseId !== 'string') {
    return c.json(badRequest('需要 { problemId: string, caseId: string }'), 400);
  }
  const problem = await storage.getProblem(body.problemId);
  if (!problem) return c.json({ error: 'problem_not_found' }, 404);
  const tc = problem.testCases.find((x) => x.id === body.caseId);
  if (!tc) return c.json({ error: 'case_not_found' }, 404);
  const scenario: ExecutedScenario = {
    traffic: tc.traffic,
    durationTicks: tc.durationTicks,
    events: tc.events ?? [],
    kills: tc.kills ?? [],
    thresholds: tc.thresholds,
  };
  return c.json({ problemId: problem.id, caseId: tc.id, scenario });
});

// ---------------------------------------------------------------- evaluate -
app.post('/api/evaluate', async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    kind?: unknown;
    context?: Record<string, unknown>;
    profileId?: unknown;
    design?: unknown;
    problemId?: unknown;
  } | null;
  const kind = body?.kind as EvaluateKind | undefined;
  const ctx = body?.context;
  // Optional end-user model pick: honored only for profiles the admin
  // marked userSelectable (enforced in llmconfig.resolveProfileForCall);
  // anything else silently resolves to the server default.
  const profileId = typeof body?.profileId === 'string' ? body.profileId : undefined;
  // The submitted design, when the client sends it: the action-guarantee
  // ladder validates / repairs / synthesizes fix actions against it —
  // actions that do not validate against it never reach the response.
  const design = isDesign(body?.design) ? body.design : undefined;
  // The problem the submission belongs to, when named: lets the ladder
  // measure the design's genuinely hottest node for synthesis/fallback.
  const problem =
    typeof body?.problemId === 'string' ? await storage.getProblem(body.problemId) : null;
  if (
    !kind ||
    !['submission', 'schema', 'followups', 'probe', 'next-steps', 'schema-probe', 'schema-next-steps'].includes(kind) ||
    !ctx
  ) {
    return c.json(
      badRequest(
        "需要 { kind: 'submission' | 'schema' | 'followups' | 'probe' | 'next-steps' | 'schema-probe' | 'schema-next-steps', context }",
      ),
      400,
    );
  }

  if (kind === 'probe') {
    const outcome = await evaluateProbes(
      ctx as unknown as Parameters<typeof evaluateProbes>[0],
      profileId,
      design,
      problem ?? undefined,
    );
    return c.json({ kind, ...outcome });
  }
  if (kind === 'schema-probe') {
    // Schema probes: the client sends raw material ({ problemName?,
    // problemId, schema }); the server assembles the full context from
    // its own recomputed sim + judging (the trust model of kind=schema),
    // so the prober grounds on server measurements, and the static
    // schema cases themselves are never part of its context — only
    // their revealed results summary is.
    const raw = ctx as {
      problemName?: string;
      problemId?: string;
      schema?: ProblemSchema;
    };
    if (!raw.schema || typeof raw.problemId !== 'string') {
      return c.json(badRequest('schema-probe 需要 context.problemId 与 context.schema'), 400);
    }
    const prob = await storage.getProblem(raw.problemId).catch(() => null);
    if (!prob) return c.json({ error: 'problem_not_found' }, 404);
    const sim = simulateSchema(prob, raw.schema);
    const suite = judgeSchemaCases(prob, raw.schema);
    const budgetMs = schemaSimBudgetMs(prob);
    const patterns =
      raw.schema.accessPatterns.length > 0 ? raw.schema.accessPatterns : prob.schema.accessPatterns;
    const hottest = [...sim.perPattern].sort(
      (a, b) => b.p99Ms / budgetMs - a.p99Ms / budgetMs,
    )[0];
    const hottestTable = [...sim.perTable].sort(
      (a, b) => b.hottestShardUtil - a.hottestShardUtil,
    )[0];
    const fullCtx: SchemaProbeContext = {
      problemName: raw.problemName ?? prob.name,
      schemaSummary: buildSchemaSummary(raw.schema),
      simSummary: buildSchemaSimSummary(sim),
      budgetMs,
      patterns: patterns.map((p) => ({
        id: p.id,
        name: p.name,
        table: p.table,
        kind: p.kind,
        perSec: p.perSec,
      })),
      judgingSummary:
        suite.totalCount > 0
          ? `数据库用例得分 ${suite.scorePct}（${suite.passedCount}/${suite.totalCount}）：\n` +
            suite.results
              .map((r) => `- ${r.passed ? '✓' : '✗'} ${r.name}：实测 ${r.measuredText}；要求 ${r.thresholdText}`)
              .join('\n')
          : '（本题暂无数据库测试用例）',
      ...(sim.perPatternGrown.find((p) => p.verdict === '不通过')
        ? { growthFailurePatternId: sim.perPatternGrown.find((p) => p.verdict === '不通过')!.patternId }
        : {}),
      ...(hottest ? { hottestPatternId: hottest.patternId } : {}),
      ...(hottestTable
        ? { hottestTable: { name: hottestTable.table, util: hottestTable.hottestShardUtil } }
        : {}),
    };
    const outcome = await evaluateSchemaProbes(
      fullCtx,
      profileId,
      raw.schema,
      reviewSchema(raw.schema, { loadFactor: 0 }),
    );
    return c.json({ kind, ...outcome });
  }
  if (kind === 'schema-next-steps') {
    // Schema next steps: the client sends raw material ({ problemName?,
    // problemId, schema, anchors }) where the anchors are this
    // submission's failed schema cases + verified failed probes (client-
    // held results data, like the architecture next-steps' failedCases).
    // The server assembles the grounded context (schema summary + sim
    // summary recomputed here) and the ladder validates every action
    // against the real schema — anchor text is context, never authority.
    const raw = ctx as {
      problemName?: string;
      problemId?: string;
      schema?: ProblemSchema;
      anchors?: SchemaNextStepAnchor[];
    };
    if (!raw.schema || typeof raw.problemId !== 'string' || !Array.isArray(raw.anchors)) {
      return c.json(
        badRequest('schema-next-steps 需要 context.problemId、context.schema 与 context.anchors'),
        400,
      );
    }
    const prob = await storage.getProblem(raw.problemId).catch(() => null);
    if (!prob) return c.json({ error: 'problem_not_found' }, 404);
    const anchors = raw.anchors
      .filter(
        (a) =>
          a &&
          typeof a.anchorId === 'string' &&
          (a.kind === 'case' || a.kind === 'probe') &&
          typeof a.title === 'string' &&
          Array.isArray(a.facts),
      )
      .slice(0, 12)
      .map((a) => ({
        anchorId: a.anchorId,
        kind: a.kind,
        title: a.title.slice(0, 120),
        facts: a.facts.filter((f) => typeof f === 'string').slice(0, 6),
      }));
    const sim = simulateSchema(prob, raw.schema);
    const fullCtx: SchemaNextStepsContext = {
      problemName: raw.problemName ?? prob.name,
      schemaSummary: buildSchemaSummary(raw.schema),
      simSummary: buildSchemaSimSummary(sim),
      anchors,
    };
    const outcome = await evaluateSchemaNextSteps(
      fullCtx,
      profileId,
      raw.schema,
      reviewSchema(raw.schema, { loadFactor: 0 }),
    );
    return c.json({ kind, ...outcome });
  }
  if (kind === 'submission') {
    const outcome = await evaluateSubmission(
      ctx as unknown as Parameters<typeof evaluateSubmission>[0],
      profileId,
      design,
      problem ?? undefined,
    );
    return c.json({ kind, ...outcome });
  }
  if (kind === 'next-steps') {
    // Per-case next steps: the model pins ONE applicable action on each
    // FAILED case (measured numbers in the context); the server ladder
    // validates / repairs / synthesizes so every red case ships a step.
    const outcome = await evaluateNextSteps(
      ctx as unknown as Parameters<typeof evaluateNextSteps>[0],
      profileId,
      design,
      problem ?? undefined,
    );
    return c.json({ kind, ...outcome });
  }
  if (kind === 'followups') {
    const outcome = await evaluateFollowUps(
      ctx as unknown as Parameters<typeof evaluateFollowUps>[0],
      profileId,
    );
    return c.json({ kind, ...outcome });
  }

  // kind === 'schema': the context may arrive either as the full assessment
  // context ({ problemName, schemaSummary, signals }) or as raw material
  // ({ problemName?, schema, loadFactor? }) — in the latter case the server
  // computes the deterministic signals itself, so the frontend never has to.
  const raw = ctx as {
    problemName?: string;
    problemId?: string;
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
  // Schema simulation, recomputed HERE from the submitted schema (the
  // frontend's displayed numbers are display-only; the review cites only
  // server-recomputed measurements — the same trust model as judging).
  // Needs the pack for its requirement workload: the client names it via
  // context.problemId; an unresolvable id simply skips the sim.
  let schemaSim: SchemaSimResult | null = null;
  if (raw.schema && typeof raw.problemId === 'string') {
    const problem = await storage.getProblem(raw.problemId).catch(() => null);
    if (problem) schemaSim = simulateSchema(problem, raw.schema);
  }
  const outcome = await evaluateSchema(
    {
      problemName: raw.problemName ?? '',
      schemaSummary:
        raw.schemaSummary ?? (raw.schema ? buildSchemaSummary(raw.schema) : ''),
      signals: signals as Parameters<typeof evaluateSchema>[0]['signals'],
      ...(schemaSim ? { simSummary: buildSchemaSimSummary(schemaSim) } : {}),
    },
    profileId,
    // The submitted schema + the checker's full report feed the action
    // ladder: schema-op validation, repair and synthesis all ground on
    // them. Signals-only requests (no schema) get text-only suggestions.
    raw.schema,
    report ?? undefined,
  );
  // When the server computed the signals, return the full checker report too
  // so the client can render the per-pattern table without judging locally.
  // The recomputed schema sim rides along for the 数据库评审 tab.
  return c.json({
    kind,
    ...outcome,
    ...(report ? { schemaSignals: report } : {}),
    ...(schemaSim ? { schemaSim } : {}),
  });
});

app.notFound((c) => c.json({ error: 'not_found' }, 404));

// -------------------------------------------------------------------- boot -
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[sds-server] listening on http://localhost:${info.port}`);
  void resolveActiveProfile().then((cfg) => {
    console.log(
      cfg.apiKey
        ? `[sds-server] LLM eval: ${cfg.model} @ ${cfg.baseUrl}（档案「${cfg.name}」，来源 ${cfg.source}）`
        : '[sds-server] LLM eval: active profile has no API key — scripted fallback (offline mode)',
    );
  });
});
