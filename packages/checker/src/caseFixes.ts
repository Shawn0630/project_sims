import type { ComponentTypeId } from '@sds/components';
import type { BreachCategory } from '@sds/driver';
import type { ProblemDef, TestCase } from '@sds/problems';
import type { Design } from '@sds/sim-core';
import { validateEditOps } from './edits';
import type { CaseFix, CaseMeasured, CaseResult, SuiteResult } from './runner';
import type { StructuralFinding } from './structural';

/**
 * Case → fix linking: give every FAILED test case the one-click fixes that
 * plausibly explain THAT failure, so the fix loop starts from the row the
 * user is actually looking at (not only from the findings list below it).
 *
 * Only grounded signals are used — nothing is inferred beyond them, and a
 * failed case with no matching signal gets an empty fixes array rather
 * than a made-up fix:
 *
 *   explicit linkage — the problem data itself ties the pair together:
 *                      TestCase.exposesRule === finding.ruleId (the same
 *                      link a finding's `exposedBy` is derived from).
 *   breach category  — the categories the case actually breached
 *                      (measured vs its own thresholds, the same
 *                      vocabulary as the probe pipeline) intersect the
 *                      categories the finding's rule plausibly produces.
 *   type overlap     — the case puts the finding's own layer under stress:
 *                      its declared kills / event target types, plus the
 *                      engine's per-event target semantics (a cache
 *                      stampede collapses CACHE hit rates; a viral post
 *                      multiplies FEED-service writes), hit the component
 *                      types of the finding's target nodes. CaseResult
 *                      carries no per-node measured data, so no measured
 *                      node signal is claimed — only the case definition's.
 *
 * A finding qualifies when it has an explicit link, or a shared breach
 * category backed by type overlap or by ≥2 shared categories (a single
 * shared category on its own is too generic — nearly every overload
 * surfaces as an error-rate breach, and it would pin a generic spof fix
 * on every failing row). Its canned actions must also survive validation
 * against the design (re-validated here — a fix without applicable ops
 * is not a fix). At most MAX_FIXES_PER_CASE are attached, best signal
 * first. Passed cases are returned untouched (no fixes field at all).
 */

const MAX_FIXES_PER_CASE = 2;

/**
 * Breach categories each structural rule plausibly produces, per the
 * rule's own detail text (structural.ts). Rules absent here can still
 * attach via an explicit exposesRule link, never via category match.
 */
const RULE_BREACH_CATEGORIES: Record<string, readonly BreachCategory[]> = {
  // The single node dies → its layer's traffic errors out.
  spof: ['错误率超标'],
  // Every read lands on storage: it saturates, becomes the hottest
  // component, and read latency follows.
  'hot-read-no-cache': ['存储过载', '热点过载', 'P99 超标'],
  // Blobs through the relational DB: storage load + latency.
  'blob-in-db': ['存储过载', 'P99 超标'],
  // All media reads fall back to the origin.
  'no-cdn': ['存储过载', 'P99 超标'],
  // One write amplified into thousands of synchronous storage writes.
  'sync-fanout': ['存储过载', '热点过载'],
  // Bursts hit the worker directly instead of queueing: errors + heat.
  'missing-queue': ['错误率超标', '热点过载'],
  // Messages enter and nobody drains them.
  'queue-no-consumer': ['队列积压'],
  // Peak writes past a single store's ceiling.
  'db-scale': ['存储过载', '热点过载', 'P99 超标'],
  // A monotonic shard key concentrates writes on one shard.
  'bad-shard-key': ['热点过载', '存储过载'],
  // Unthrottled public writes saturate whatever sits downstream.
  'no-rate-limit': ['错误率超标', '热点过载'],
};

/** Every breach category a case result actually breached (not just the primary). */
function breachCategoriesOf(tc: TestCase, m: CaseMeasured): BreachCategory[] {
  const t = tc.thresholds;
  const cats: BreachCategory[] = [];
  if (t.maxErrorRate !== undefined && m.errorRate > t.maxErrorRate) cats.push('错误率超标');
  if (t.maxP99Ms !== undefined && m.p99Ms > t.maxP99Ms) cats.push('P99 超标');
  if (t.maxCostPerHour !== undefined && m.costPerHour > t.maxCostPerHour) cats.push('成本超标');
  if (t.maxStorageQps !== undefined && m.maxStorageQps > t.maxStorageQps) cats.push('存储过载');
  if (t.maxHottestUtil !== undefined && m.hottestUtil > t.maxHottestUtil) cats.push('热点过载');
  if (t.maxStaleReadRate !== undefined && m.staleReadRate > t.maxStaleReadRate) cats.push('读到旧数据');
  if (t.maxQueueDepth !== undefined && m.queueDepthMax > t.maxQueueDepth) cats.push('队列积压');
  return cats;
}

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 } as const;

/**
 * Return a copy of the suite whose failed results carry `fixes` (possibly
 * empty). Inputs are never mutated.
 */
export function attachCaseFixes(
  problem: ProblemDef,
  design: Design,
  suite: SuiteResult,
  findings: readonly StructuralFinding[],
): SuiteResult {
  // Pre-validate each finding's canned actions once: only findings with at
  // least one surviving op can ever be offered as a one-click fix.
  const candidates = findings
    .map((f, i) => ({
      finding: f,
      findingId: `${f.ruleId}#${i}`,
      index: i,
      actions: validateEditOps(f.actions, design),
    }))
    .filter((c) => c.actions.length > 0);
  if (!candidates.length) {
    return {
      ...suite,
      results: suite.results.map((r) => (r.passed ? r : { ...r, fixes: [] })),
    };
  }

  const caseById = new Map(problem.testCases.map((tc) => [tc.id, tc]));
  const nodeTypeById = new Map(design.nodes.map((n) => [n.id, n.type]));

  const results: CaseResult[] = suite.results.map((r) => {
    if (r.passed) return r;
    const tc = caseById.get(r.caseId);
    if (!tc) return { ...r, fixes: [] };

    const caseCats = breachCategoriesOf(tc, r.measured);
    // Component types the case itself puts under stress: its declared node
    // kills and event targets, plus the engine's per-event semantics —
    // cache_stampede collapses cache hit rates (offload behavior in
    // sim-core), viral_post multiplies feed-service writes.
    const stressedTypes = new Set<ComponentTypeId>();
    for (const k of tc.kills ?? []) stressedTypes.add(k.componentType);
    for (const e of tc.events ?? []) {
      if (e.targetType) stressedTypes.add(e.targetType);
      if (e.type === 'cache_stampede') stressedTypes.add('cache');
      if (e.type === 'viral_post') stressedTypes.add('feedservice');
    }

    const scored: { fix: CaseFix; score: number; sev: number; index: number }[] = [];
    for (const c of candidates) {
      const explicit = tc.exposesRule === c.finding.ruleId || c.finding.exposedBy === tc.id;
      const ruleCats = RULE_BREACH_CATEGORIES[c.finding.ruleId] ?? [];
      const overlap = ruleCats.reduce((n, cat) => n + (caseCats.includes(cat) ? 1 : 0), 0);
      const typeOverlap = c.finding.componentIds.some((id) =>
        stressedTypes.has(nodeTypeById.get(id) as ComponentTypeId),
      );
      // Category agreement alone must be corroborated (see header note).
      if (!explicit && (overlap === 0 || (!typeOverlap && overlap < 2))) continue;
      scored.push({
        fix: { findingId: c.findingId, title: c.finding.title, actions: c.actions },
        // Explicit problem-data linkage dominates; then the case stressing
        // the finding's own layer; then breadth of category agreement.
        score: (explicit ? 100 : 0) + (typeOverlap ? 10 : 0) + overlap,
        sev: SEVERITY_RANK[c.finding.severity],
        index: c.index,
      });
    }
    scored.sort((a, b) => b.score - a.score || a.sev - b.sev || a.index - b.index);
    return { ...r, fixes: scored.slice(0, MAX_FIXES_PER_CASE).map((s) => s.fix) };
  });
  return { ...suite, results };
}
