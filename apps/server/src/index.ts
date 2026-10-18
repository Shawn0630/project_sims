import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import process from 'node:process';
import {
  attachCaseFixes,
  checkStructure,
  reviewSchema,
  runSuite,
  validateEditOps,
} from '@sds/checker';
import type { ExecutedScenario, StructuralFindingLike } from '@sds/driver';
import type { ProblemSchema } from '@sds/problems';
import type { Design } from '@sds/sim-core';
import {
  buildSchemaSummary,
  evaluateFollowUps,
  evaluateNextSteps,
  evaluateProbes,
  evaluateSchema,
  evaluateSubmission,
  toSchemaReviewLike,
  type EvaluateKind,
} from './llm';
import { listUserSelectableProfiles, resolveActiveProfile } from './llmconfig';
import { verifyProbes } from './probe';
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
 *   POST /api/submissions/verify-probes
 *                                 run LLM-proposed probe cases through the
 *                                 simulator and grade their predictions
 *   POST /api/submissions/case-scenario
 *                                 the executable scenario of ONE judged case
 *                                 (incl. hidden ones, on demand) — powers the
 *                                 frontend's local quick re-simulation
 *   POST /api/evaluate            ONE LLM call (or scripted fallback) →
 *                                 structured assessment / follow-ups / probes /
 *                                 next-steps (one pinned action per failed
 *                                 case, ladder-guaranteed like the rest).
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
  return c.json({ problemId: problem.id, suite, structural, schemaSignals });
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
  if (!kind || !['submission', 'schema', 'followups', 'probe', 'next-steps'].includes(kind) || !ctx) {
    return c.json(
      badRequest("需要 { kind: 'submission' | 'schema' | 'followups' | 'probe' | 'next-steps', context }"),
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
  const outcome = await evaluateSchema(
    {
      problemName: raw.problemName ?? '',
      schemaSummary:
        raw.schemaSummary ?? (raw.schema ? buildSchemaSummary(raw.schema) : ''),
      signals: signals as Parameters<typeof evaluateSchema>[0]['signals'],
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
  return c.json({ kind, ...outcome, ...(report ? { schemaSignals: report } : {}) });
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
