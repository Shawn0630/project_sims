import type { ComponentTypeId } from '@sds/components';
import type { ActionSource, EditOp } from '@sds/driver';
import type { ProblemDef, TestCase } from '@sds/problems';
import { SimulationEngine, type Design, type MetricsSnapshot } from '@sds/sim-core';

/** The single hottest node of a run, as measured (not inferred). */
export interface HottestNode {
  nodeId: string;
  type: ComponentTypeId;
  /** Peak utilization over the measured window, 0..>1. */
  util: number;
}

export interface CaseMeasured {
  errorRate: number;
  p99Ms: number;
  costPerHour: number;
  maxStorageQps: number;
  staleReadRate: number;
  hottestUtil: number;
  queueDepthMax: number;
  /**
   * Which node was the hottest, and how hot it peaked — the measured
   * bottleneck, so fix synthesis (caseFixes.ts) can size a capacity fix
   * from evidence instead of guessing. Null when no node registered any
   * load (e.g. everything was killed before sampling).
   */
  hottestNode: HottestNode | null;
}

/**
 * A one-click improvement attached to a FAILED case: either a structural
 * finding that plausibly explains the failure (`findingId` is
 * `<ruleId>#<index>` — the finding's position in the same judge response's
 * structural array), or the synthesized bottleneck-capacity fix
 * (`findingId` is `capacity#<nodeId>`, sized from the measured hottest
 * node — see caseFixes.ts). Actions are already-validated edit ops in
 * both cases (edits.ts).
 */
export interface CaseFix {
  findingId: string;
  title: string;
  actions: EditOp[];
  /**
   * Provenance of the actions (the UI badges it next to the apply
   * button). Case-linked fixes are deterministic by construction —
   * structural rules and the measured synthesis — so this is 'rule'
   * whenever set; the field exists so every fix entry point in the UI
   * can render its badge from data instead of assuming.
   */
  actionSource?: ActionSource;
}

export interface CaseResult {
  caseId: string;
  name: string;
  hidden: boolean;
  passed: boolean;
  measured: CaseMeasured;
  failures: string[];
  hint?: string;
  /**
   * Actionable fixes linked to this failure (attachCaseFixes). Present on
   * every FAILED case — possibly an empty array when no finding plausibly
   * explains the failure; absent on passed cases.
   */
  fixes?: CaseFix[];
}

export interface SuiteResult {
  results: CaseResult[];
  passedCount: number;
  totalCount: number;
  /** Weighted pass percentage, 0..100 */
  scorePct: number;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/**
 * Run one test case headlessly against a design snapshot: a fresh engine,
 * the case's traffic, its scheduled events and node kills, then metrics are
 * averaged over the second half of the run (steady state) and compared with
 * the case's explicit thresholds.
 */
export function runTestCase(problem: ProblemDef, design: Design, tc: TestCase): CaseResult {
  void problem;
  const engine = new SimulationEngine(design, tc.traffic);
  const events = [...(tc.events ?? [])].sort((a, b) => a.atTick - b.atTick);
  const kills = [...(tc.kills ?? [])].sort((a, b) => a.atTick - b.atTick);
  const samples: MetricsSnapshot[] = [];
  let queueDepthMax = 0;

  for (let tick = 1; tick <= tc.durationTicks; tick++) {
    while (events.length && events[0]!.atTick <= tick) {
      const ev = events.shift()!;
      engine.injectEvent({
        type: ev.type,
        targetType: ev.targetType,
        magnitude: ev.magnitude,
        durationTicks: ev.durationTicks,
      });
    }
    while (kills.length && kills[0]!.atTick <= tick) {
      engine.killByType(kills.shift()!.componentType);
    }
    const snap = engine.step(1);
    for (const m of Object.values(snap.nodes)) {
      queueDepthMax = Math.max(queueDepthMax, m.queueDepth ?? 0);
    }
    if (tick > tc.durationTicks / 2) samples.push(snap);
  }

  const avg = (pick: (s: MetricsSnapshot) => number) =>
    samples.length ? samples.reduce((a, s) => a + pick(s), 0) / samples.length : 0;
  // Per-node PEAK utilization over the same measured window: the argmax
  // node's peak equals hottestUtil below (max over samples of the
  // per-snapshot max), so the pair never disagrees.
  const peakUtilByNode = new Map<string, number>();
  for (const s of samples) {
    for (const [id, m] of Object.entries(s.nodes)) {
      if (m.util > (peakUtilByNode.get(id) ?? 0)) peakUtilByNode.set(id, m.util);
    }
  }
  let hottestNode: HottestNode | null = null;
  for (const n of design.nodes) {
    const util = peakUtilByNode.get(n.id) ?? 0;
    if (util > 0 && (!hottestNode || util > hottestNode.util)) {
      hottestNode = { nodeId: n.id, type: n.type, util };
    }
  }
  const measured: CaseMeasured = {
    errorRate: avg((s) => s.errorRate),
    p99Ms: avg((s) => s.p99Ms),
    costPerHour: samples[0]?.costPerHour ?? 0,
    maxStorageQps: Math.max(0, ...samples.map((s) => s.maxStorageQps)),
    staleReadRate: avg((s) => s.staleReadRate),
    hottestUtil: Math.max(0, ...samples.map((s) => s.hottestUtil)),
    queueDepthMax,
    hottestNode,
  };

  const t = tc.thresholds;
  const failures: string[] = [];
  if (t.maxErrorRate !== undefined && measured.errorRate > t.maxErrorRate) {
    failures.push(`错误率 ${pct(measured.errorRate)} > 阈值 ${pct(t.maxErrorRate)}`);
  }
  if (t.maxP99Ms !== undefined && measured.p99Ms > t.maxP99Ms) {
    failures.push(`P99 ${Math.round(measured.p99Ms)}ms > 阈值 ${t.maxP99Ms}ms`);
  }
  if (t.maxCostPerHour !== undefined && measured.costPerHour > t.maxCostPerHour) {
    failures.push(`成本 $${measured.costPerHour.toFixed(0)}/h > 阈值 $${t.maxCostPerHour}/h`);
  }
  if (t.maxStorageQps !== undefined && measured.maxStorageQps > t.maxStorageQps) {
    failures.push(
      `存储层入站 ${Math.round(measured.maxStorageQps)} QPS > 阈值 ${t.maxStorageQps} QPS`,
    );
  }
  if (t.maxStaleReadRate !== undefined && measured.staleReadRate > t.maxStaleReadRate) {
    failures.push(`读旧数据比例 ${pct(measured.staleReadRate)} > 阈值 ${pct(t.maxStaleReadRate)}`);
  }
  if (t.maxHottestUtil !== undefined && measured.hottestUtil > t.maxHottestUtil) {
    failures.push(
      `最热组件利用率 ${(measured.hottestUtil * 100).toFixed(0)}% > 阈值 ${(t.maxHottestUtil * 100).toFixed(0)}%`,
    );
  }
  if (t.maxQueueDepth !== undefined && measured.queueDepthMax > t.maxQueueDepth) {
    failures.push(
      `队列最大积压 ${Math.round(measured.queueDepthMax).toLocaleString()} 条 > 阈值 ${t.maxQueueDepth.toLocaleString()} 条`,
    );
  }

  return {
    caseId: tc.id,
    name: tc.name,
    hidden: tc.hidden,
    passed: failures.length === 0,
    measured,
    failures,
    hint: failures.length ? tc.hint : undefined,
  };
}

export function runSuite(problem: ProblemDef, design: Design): SuiteResult {
  const results = problem.testCases.map((tc) => runTestCase(problem, design, tc));
  const totalWeight = problem.testCases.reduce((a, c) => a + c.weight, 0);
  const passedWeight = problem.testCases.reduce(
    (a, c, i) => a + (results[i]!.passed ? c.weight : 0),
    0,
  );
  return {
    results,
    passedCount: results.filter((r) => r.passed).length,
    totalCount: results.length,
    scorePct: totalWeight > 0 ? Math.round((passedWeight / totalWeight) * 100) : 0,
  };
}
