import {
  runSchemaScenario,
  schemaSimBudgetMs,
  validateSchemaOps,
} from '@sds/checker';
import {
  normalizeSchemaProbeCase,
  type ActionCoverage,
  type SchemaOp,
  type SchemaProbeCase,
  type SchemaProbeScenarioSpec,
  type VerifiedSchemaProbeResult,
} from '@sds/driver';
import type { ProblemDef, ProblemSchema } from '@sds/problems';

/**
 * Schema probe verification — the schema simulator as arbiter, mirroring
 * probe.ts on the architecture side.
 *
 * The LLM proposes adversarial DATA scenarios (growth / surge / skew /
 * traffic-structure flip) with a falsifiable prediction: what breaks
 * first. This module re-runs the schema simulator under each scenario
 * and grades with the same 口径 as architecture probes:
 *
 *   hit  — predicted a failure and the measured first break IS the
 *          predicted pattern/table, or predicted a pass and it held;
 *   held — predicted a failure but the schema held anyway （设计扛住了）;
 *   miss — anything else (predicted a pass but it broke, wrong first
 *          break).
 *
 * A run "breaks" when any pattern's P99 exceeds the problem's latency
 * budget or any table's hottest-shard utilization exceeds 1 — the same
 * thresholds the schema judging standards state. Cases arriving here
 * round-tripped through the client, so each is re-normalized first.
 *
 * Fix actions: predictions' fixActions are re-validated against the
 * submitted schema; a failed prediction left without surviving actions
 * gets a rule synthesis GROUNDED IN THE SCENARIO RUN (the pattern/table
 * that actually broke), tagged 'rule' — the action guarantee holds on
 * verified results too, with scenario-measured provenance.
 */

export function schemaScenarioSummaryOf(
  problem: ProblemDef,
  scenario: SchemaProbeScenarioSpec,
): string {
  const nameOf = (id: string) =>
    problem.schema.accessPatterns.find((p) => p.id === id)?.name ?? id;
  const parts: string[] = [];
  if (scenario.growthFactor) parts.push(`数据量 ×${scenario.growthFactor}`);
  if (scenario.trafficMultiplier) parts.push(`全局流量 ×${scenario.trafficMultiplier}`);
  for (const [id, m] of Object.entries(scenario.patternTraffic ?? {})) {
    parts.push(`「${nameOf(id)}」流量 ×${m}`);
  }
  if (scenario.skew) {
    parts.push(
      `「${nameOf(scenario.skew.patternId)}」${Math.round(scenario.skew.concentration * 100)}% 流量集中到单一取值`,
    );
  }
  return parts.join(' · ') || '基线场景';
}

interface FirstBreak {
  kind: 'pattern' | 'table';
  id: string;
  text: string;
  ratio: number;
}

function firstBreakOf(
  run: ReturnType<typeof runSchemaScenario>,
  budgetMs: number,
): { firstBreak: FirstBreak | null; failures: string[] } {
  const failures: string[] = [];
  const candidates: FirstBreak[] = [];
  for (const p of run.perPattern) {
    if (p.p99Ms > budgetMs) {
      failures.push(`「${p.name}」P99 ${p.p99Ms}ms 超过预算 ${budgetMs}ms（${p.path}）`);
      candidates.push({
        kind: 'pattern',
        id: p.patternId,
        text: `「${p.name}」P99 ${p.p99Ms}ms（预算 ${budgetMs}ms）`,
        ratio: p.p99Ms / budgetMs,
      });
    }
  }
  for (const t of run.perTable) {
    if (t.hottestShardUtil > 1) {
      failures.push(`表 ${t.table} 最热分片利用率 ${t.hottestShardUtil} > 1（饱和）`);
      candidates.push({
        kind: 'table',
        id: t.table,
        text: `表 ${t.table} 最热分片利用率 ${t.hottestShardUtil}`,
        ratio: t.hottestShardUtil,
      });
    }
  }
  candidates.sort((a, b) => b.ratio - a.ratio);
  return { firstBreak: candidates[0] ?? null, failures };
}

/**
 * Rule synthesis grounded in the SCENARIO run: the move that addresses
 * the thing that actually broke. Mirrors the schema judge's grounded
 * fixes, but reads the scenario's measured paths instead of the base
 * run's. Returns validated ops or [].
 */
function synthesizeScenarioFix(
  problem: ProblemDef,
  schema: ProblemSchema,
  run: ReturnType<typeof runSchemaScenario>,
  firstBreak: FirstBreak,
): SchemaOp[] {
  const patterns = schema.accessPatterns.length
    ? schema.accessPatterns
    : problem.schema.accessPatterns;
  const ops: SchemaOp[] = [];
  if (firstBreak.kind === 'pattern') {
    const pattern = patterns.find((p) => p.id === firstBreak.id);
    const table = pattern ? schema.tables.find((t) => t.name === pattern.table) : undefined;
    const measured = run.perPattern.find((p) => p.patternId === firstBreak.id);
    if (pattern && table && measured) {
      const field = table.fields.find((f) => f.name === pattern.byField);
      if (measured.path === '全表扫描' && field && !field.indexed && pattern.kind === 'read') {
        ops.push({ op: 'addIndex', table: table.name, field: pattern.byField });
      } else if (measured.path === '跨分片广播' || (table.shardKey && pattern.byField !== table.shardKey)) {
        if (pattern.byField !== table.shardKey) {
          ops.push({ op: 'setShardKey', table: table.name, field: pattern.byField });
        }
      } else if (field && !field.indexed) {
        ops.push({ op: 'addIndex', table: table.name, field: pattern.byField });
      } else if (!table.shardKey) {
        ops.push({ op: 'setShardKey', table: table.name, field: pattern.byField });
      }
    }
  } else {
    const table = schema.tables.find((t) => t.name === firstBreak.id);
    if (table && !table.shardKey) {
      const onTable = patterns
        .filter((p) => p.table === table.name)
        .sort((x, y) => y.perSec - x.perSec);
      const pick =
        onTable.find((p) => p.byField !== table.primaryKey)?.byField ?? onTable[0]?.byField;
      if (pick && table.fields.some((f) => f.name === pick)) {
        ops.push({ op: 'setShardKey', table: table.name, field: pick });
      }
    }
  }
  return validateSchemaOps(ops, schema);
}

export function verifySchemaProbes(
  problem: ProblemDef,
  schema: ProblemSchema,
  rawCases: unknown[],
): { results: VerifiedSchemaProbeResult[]; actionCoverage: ActionCoverage } {
  const budgetMs = schemaSimBudgetMs(problem);
  const validPatternIds = new Set(
    (schema.accessPatterns.length ? schema.accessPatterns : problem.schema.accessPatterns).map(
      (p) => p.id,
    ),
  );
  const tableNames = new Set(schema.tables.map((t) => t.name));
  const coverage: ActionCoverage = {
    findings: 0,
    withActions: 0,
    bySource: { llm: 0, repaired: 0, rule: 0, fallback: 0 },
    nonMechanical: 0,
  };
  const results: VerifiedSchemaProbeResult[] = [];

  for (const input of rawCases.slice(0, 3)) {
    const pc: SchemaProbeCase | null = normalizeSchemaProbeCase(input, validPatternIds, tableNames);
    if (!pc) continue;
    const run = runSchemaScenario(problem, schema, pc.scenario);
    const { firstBreak, failures } = firstBreakOf(run, budgetMs);
    const passed = firstBreak === null;
    let verdict: VerifiedSchemaProbeResult['verdict'];
    if (passed) verdict = pc.prediction.willFail ? 'held' : 'hit';
    else if (pc.prediction.willFail && firstBreak.id === pc.prediction.firstBreakId) verdict = 'hit';
    else verdict = 'miss';

    const worst = [...run.perPattern].sort((a, b) => b.p99Ms - a.p99Ms)[0];
    const prediction = { ...pc.prediction };
    if (!passed && pc.prediction.willFail) {
      coverage.findings += 1;
      const surviving = validateSchemaOps(prediction.fixActions ?? [], schema);
      if (surviving.length) {
        prediction.fixActions = surviving;
        const src = prediction.actionSource ?? 'llm';
        prediction.actionSource = src;
        coverage.withActions += 1;
        coverage.bySource[src] += 1;
      } else {
        const synth = synthesizeScenarioFix(problem, schema, run, firstBreak);
        if (synth.length) {
          prediction.fixActions = synth;
          prediction.actionSource = 'rule';
          coverage.withActions += 1;
          coverage.bySource.rule += 1;
        } else {
          delete prediction.fixActions;
          delete prediction.actionSource;
        }
      }
    } else {
      delete prediction.fixActions;
      delete prediction.actionSource;
    }

    results.push({
      name: pc.name,
      scenarioSummary: schemaScenarioSummaryOf(problem, pc.scenario),
      scenario: pc.scenario,
      prediction,
      verdict,
      passed,
      actualFirstBreak: firstBreak ? firstBreak.text : null,
      measured: {
        worstPatternId: worst?.patternId ?? null,
        worstPatternName: worst?.name ?? null,
        worstP99Ms: worst?.p99Ms ?? 0,
        maxTableUtil: run.perTable.reduce((m, t) => Math.max(m, t.hottestShardUtil), 0),
        maxSustainableQps: run.maxSustainableQps,
      },
      failures,
    });
  }
  return { results, actionCoverage: coverage };
}
