import { componentDef, type ComponentTypeId } from '@sds/components';
import type { BreachCategory, EditOp } from '@sds/driver';
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
 *                      types of the finding's target nodes. Rule LINKING
 *                      still claims no measured per-node signal — only
 *                      the case definition's.
 *
 * One signal beyond the linking rules IS measured: the bottleneck. When a
 * case fails and its measured hottest node (runner.ts CaseMeasured.
 * hottestNode) ran over 100% — or over the case's own hottest-util
 * threshold — a pure CAPACITY fix is synthesized for that node, sized
 * from the measurement (see synthesizeCapacityFix): the bottleneck moved
 * there, so the loop's next step is "give it headroom", whoever's rule
 * got the user here. It is appended AFTER the rule fixes (they keep
 * priority) and only when no accepted rule fix already targets that
 * node, so a case may carry up to MAX_FIXES_PER_CASE + 1 fixes in that
 * situation. A failure whose hottest node stayed ≤100% (stale reads,
 * consistency, semantics) gains NO capacity fix — capacity is not a
 * plausible remedy there, and a fake fix is worse than none.
 *
 * A finding qualifies when it has an explicit link, or a shared breach
 * category backed by type overlap or by ≥2 shared categories (a single
 * shared category on its own is too generic — nearly every overload
 * surfaces as an error-rate breach, and it would pin a generic spof fix
 * on every failing row). Its canned actions must also survive validation
 * against the design (re-validated here — a fix without applicable ops
 * is not a fix). At most MAX_FIXES_PER_CASE rule fixes are attached, best
 * signal first. Passed cases are returned untouched (no fixes field).
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
 * Headroom target for the synthesized capacity fix: size the node so the
 * same load would run at this utilization. Engine capacity is linear in
 * both replicas and capacityScale (capacity = per-replica × replicas ×
 * capacityScale, and storage's effective-capacity modifiers multiply
 * that same base), so util / target is the exact growth factor — one
 * application lands the node at ≈target under the measured load.
 */
const CAPACITY_TARGET_UTIL = 0.8;
/** Legal ceilings from the edit-op setting rules (edits.ts). */
const MAX_REPLICAS = 16;
const MAX_CAPACITY_SCALE = 4;
/** capacityScale snaps UP to this step so the offer never under-sizes. */
const CAPACITY_SCALE_STEP = 0.25;

/**
 * Synthesize the "scale the measured bottleneck" fix for one failed case,
 * or null when capacity is not the measured problem:
 *
 *   - the case's measured hottest node must have run over 100% (or over
 *     the case's own hottest-util threshold, when it declares one);
 *   - the node must still exist in the design and be a kind whose
 *     capacity a setting actually scales: queues report a backlog gauge
 *     the engine caps below 100% and no setting changes, and the client
 *     source has no capacity at all — both are skipped, never faked;
 *   - stateless service tiers (service / worker behavior) scale by
 *     replicas = ceil(current × util / target); everything else —
 *     storage included — scales by capacityScale snapped up to a legal
 *     step. Storage NEVER gets a semantic change (shard key, replicas of
 *     data, consistency) from this fix: it is purely capacity. A knob
 *     already at its legal ceiling falls back to the other knob; both
 *     maxed (or a computed no-op) means no fix.
 *
 * The single op is run through validateEditOps like every other fix.
 */
function synthesizeCapacityFix(design: Design, tc: TestCase, r: CaseResult): CaseFix | null {
  const hot = r.measured.hottestNode;
  if (!hot) return null;
  const overOwnThreshold =
    tc.thresholds.maxHottestUtil !== undefined && hot.util > tc.thresholds.maxHottestUtil;
  if (!(hot.util > 1 || overOwnThreshold)) return null;
  const node = design.nodes.find((n) => n.id === hot.nodeId);
  if (!node) return null;
  const behavior = componentDef(node.type).behavior;
  if (behavior === 'source' || behavior === 'queue') return null;

  const factor = hot.util / CAPACITY_TARGET_UTIL;
  let op: EditOp | null = null;
  const scaleOp = (): EditOp | null => {
    const cur = node.settings.capacityScale;
    const next = Math.min(
      MAX_CAPACITY_SCALE,
      Math.ceil((cur * factor) / CAPACITY_SCALE_STEP) * CAPACITY_SCALE_STEP,
    );
    // Clean float dust from the step snap (e.g. 2.7500000004).
    const snapped = Math.round(next * 100) / 100;
    return snapped > cur
      ? { op: 'setSetting', nodeId: node.id, key: 'capacityScale', value: snapped }
      : null;
  };
  if (behavior === 'service' || behavior === 'worker') {
    const cur = node.settings.replicas;
    const next = Math.min(MAX_REPLICAS, Math.ceil(cur * factor));
    op =
      next > cur
        ? { op: 'setSetting', nodeId: node.id, key: 'replicas', value: next }
        : scaleOp();
  } else {
    op = scaleOp();
  }
  if (!op) return null;
  const actions = validateEditOps([op], design);
  if (!actions.length) return null;
  return {
    findingId: `capacity#${node.id}`,
    title:
      `扩容瓶颈节点（实测最热：${componentDef(node.type).name}` +
      `${node.label ? `「${node.label}」` : ''}，利用率 ${Math.round(hot.util * 100)}%）`,
    actions,
  };
}

/** Node ids a fix's ops touch (targets, insertion endpoints, creations). */
function fixTargetNodeIds(fix: CaseFix): Set<string> {
  const ids = new Set<string>();
  for (const op of fix.actions) {
    if (op.op === 'setSetting') ids.add(op.nodeId);
    else if (op.op === 'addComponent') {
      if (op.connectFromId) ids.add(op.connectFromId);
      if (op.connectToId) ids.add(op.connectToId);
      if (op.newNodeId) ids.add(op.newNodeId);
    } else {
      ids.add(op.fromId);
      ids.add(op.toId);
    }
  }
  return ids;
}

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
    const fixes = scored.slice(0, MAX_FIXES_PER_CASE).map((s) => s.fix);
    // The measured-bottleneck capacity fix rides along AFTER the rule
    // fixes — unless an accepted rule fix already targets that node (then
    // the rule's own remedy owns the next step and capacity waits a
    // round). This is the one way a case carries MAX_FIXES_PER_CASE + 1.
    const capFix = synthesizeCapacityFix(design, tc, r);
    if (capFix) {
      const hotId = r.measured.hottestNode!.nodeId;
      const alreadyTargeted = fixes.some((f) => fixTargetNodeIds(f).has(hotId));
      if (!alreadyTargeted) fixes.push(capFix);
    }
    return { ...r, fixes };
  });
  return { ...suite, results };
}
