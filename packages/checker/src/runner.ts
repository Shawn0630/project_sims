import type { ProblemDef, TestCase } from '@sds/problems';
import { SimulationEngine, type Design, type MetricsSnapshot } from '@sds/sim-core';

export interface CaseMeasured {
  errorRate: number;
  p99Ms: number;
  costPerHour: number;
  maxStorageQps: number;
  staleReadRate: number;
  hottestUtil: number;
  queueDepthMax: number;
}

export interface CaseResult {
  caseId: string;
  name: string;
  hidden: boolean;
  passed: boolean;
  measured: CaseMeasured;
  failures: string[];
  hint?: string;
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
  const measured: CaseMeasured = {
    errorRate: avg((s) => s.errorRate),
    p99Ms: avg((s) => s.p99Ms),
    costPerHour: samples[0]?.costPerHour ?? 0,
    maxStorageQps: Math.max(0, ...samples.map((s) => s.maxStorageQps)),
    staleReadRate: avg((s) => s.staleReadRate),
    hottestUtil: Math.max(0, ...samples.map((s) => s.hottestUtil)),
    queueDepthMax,
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
