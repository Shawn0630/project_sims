import { runTestCase, type CaseMeasured } from '@sds/checker';
import {
  normalizeProbeCase,
  type ActionCoverage,
  type BreachCategory,
  type ProbeCase,
  type ProbePrediction,
  type ProbeVerdict,
  type VerifiedProbeResult,
} from '@sds/driver';
import type { ProblemDef, TestCase } from '@sds/problems';
import type { Design } from '@sds/sim-core';
import { ensureVerifiedActions } from './actions';

/**
 * Probe verification — the simulator as arbiter.
 *
 * The LLM proposes probe cases in a friendly relative shape (traffic
 * multiplier over the problem's baseline, duration in ticks, events and
 * kills by type, thresholds in mixed units). This module converts each
 * proposal into a real TestCase and runs it through the EXACT execution
 * path the static suite uses (@sds/checker runTestCase against sim-core),
 * then grades the LLM's prediction against the measured outcome:
 *
 *   hit  — predicted a failure and the actual primary breach matches, or
 *          predicted a pass and the case passed;
 *   held — predicted a failure but the design passed anyway （设计扛住了）;
 *   miss — anything else (predicted pass but failed, wrong breach category).
 *
 * Cases arriving here round-tripped through the client, so every one is
 * re-normalized (validated + clamped) before it is executed.
 */

const EVENT_LABEL: Record<string, string> = {
  viral_post: '网红爆帖',
  cache_stampede: '缓存雪崩',
  hot_key: '热点 key',
  peak: '流量峰值',
  rw_flip: '读写比翻转',
};

/** Friendly probe case → executable TestCase (ids are local to the run). */
export function probeToTestCase(problem: ProblemDef, pc: ProbeCase, index: number): TestCase {
  const s = pc.scenario;
  const t = pc.thresholds;
  return {
    id: `probe-${index}`,
    name: pc.name,
    description: 'LLM 探测用例（仿真验证）',
    hidden: true,
    weight: 0,
    traffic: {
      rps: Math.max(1, Math.round(problem.scale.baselineRps * s.trafficMultiplier)),
      readRatio: s.readRatio ?? problem.scale.readRatio,
    },
    durationTicks: s.durationSec,
    events: s.events.map((ev) => ({
      atTick: Math.min(3, Math.max(1, s.durationSec - 1)),
      type: ev.type,
      targetType: ev.targetType,
      magnitude: ev.magnitude ?? 3,
      durationTicks: Math.min(20, Math.max(1, s.durationSec - 3)),
    })),
    kills: s.kills.map((componentType) => ({
      componentType,
      atTick: Math.min(5, Math.max(1, Math.floor(s.durationSec / 2))),
    })),
    thresholds: {
      ...(t.maxErrorRatePct !== undefined ? { maxErrorRate: t.maxErrorRatePct / 100 } : {}),
      ...(t.p99Ms !== undefined ? { maxP99Ms: t.p99Ms } : {}),
      ...(t.maxCostPerHour !== undefined ? { maxCostPerHour: t.maxCostPerHour } : {}),
      ...(t.maxStorageQps !== undefined ? { maxStorageQps: t.maxStorageQps } : {}),
      ...(t.maxHottestUtilPct !== undefined ? { maxHottestUtil: t.maxHottestUtilPct / 100 } : {}),
      ...(t.maxStaleReadPct !== undefined ? { maxStaleReadRate: t.maxStaleReadPct / 100 } : {}),
      ...(t.maxQueueDepth !== undefined ? { maxQueueDepth: t.maxQueueDepth } : {}),
    },
  };
}

/**
 * The breach category that actually dominated: among the case's own
 * thresholds, the one with the largest overshoot ratio. Null when passed.
 */
export function actualBreachOf(tc: TestCase, measured: CaseMeasured): BreachCategory | null {
  const t = tc.thresholds;
  const candidates: { cat: BreachCategory; ratio: number }[] = [];
  const add = (cat: BreachCategory, value: number, limit?: number) => {
    if (limit !== undefined && limit > 0 && value > limit) {
      candidates.push({ cat, ratio: value / limit });
    }
  };
  add('错误率超标', measured.errorRate, t.maxErrorRate);
  add('P99 超标', measured.p99Ms, t.maxP99Ms);
  add('成本超标', measured.costPerHour, t.maxCostPerHour);
  add('存储过载', measured.maxStorageQps, t.maxStorageQps);
  add('热点过载', measured.hottestUtil, t.maxHottestUtil);
  add('读到旧数据', measured.staleReadRate, t.maxStaleReadRate);
  add('队列积压', measured.queueDepthMax, t.maxQueueDepth);
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.ratio - a.ratio);
  return candidates[0]!.cat;
}

export function verdictOf(pc: ProbeCase, passed: boolean, actualBreach: BreachCategory | null): ProbeVerdict {
  if (passed) return pc.prediction.willFail ? 'held' : 'hit';
  if (pc.prediction.willFail && actualBreach === pc.prediction.primaryBreach) return 'hit';
  return 'miss';
}

export function scenarioSummaryOf(problem: ProblemDef, pc: ProbeCase): string {
  const s = pc.scenario;
  const parts = [
    `流量 ×${s.trafficMultiplier}（${Math.round(problem.scale.baselineRps * s.trafficMultiplier)} RPS）`,
    `${s.durationSec} tick`,
  ];
  if (s.readRatio !== undefined) parts.push(`读占比 ${Math.round(s.readRatio * 100)}%`);
  for (const ev of s.events) parts.push(`事件：${EVENT_LABEL[ev.type] ?? ev.type}${ev.magnitude ? ` ×${ev.magnitude}` : ''}`);
  for (const k of s.kills) parts.push(`杀 ${k}`);
  return parts.join(' · ');
}

/**
 * Run a batch of raw (untrusted) proposed cases against a design and grade
 * every prediction. Malformed cases are dropped before execution.
 *
 * Fix actions: the cases round-tripped through the client, so nothing is
 * trusted — each willFail prediction's actions are re-validated against
 * THIS design, and any that do not survive are replaced by rule synthesis
 * / the universal fallback (ensureVerifiedActions, actions.ts), keeping
 * the action guarantee true on the verified results too. Verification
 * itself (scenarios, verdicts, measured values) is untouched by this.
 */
export function verifyProbes(
  problem: ProblemDef,
  design: Design,
  rawCases: unknown[],
): { results: VerifiedProbeResult[]; actionCoverage: ActionCoverage } {
  const raw: VerifiedProbeResult[] = [];
  rawCases.slice(0, 4).forEach((input, i) => {
    const pc = normalizeProbeCase(input);
    if (!pc) return;
    const tc = probeToTestCase(problem, pc, i);
    const r = runTestCase(problem, design, tc);
    const actualBreach = r.passed ? null : actualBreachOf(tc, r.measured);
    raw.push({
      name: pc.name,
      scenarioSummary: scenarioSummaryOf(problem, pc),
      prediction: pc.prediction,
      passed: r.passed,
      measured: r.measured,
      failures: r.failures,
      actualBreach,
      verdict: verdictOf(pc, r.passed, actualBreach),
      // The scenario exactly as executed, so the frontend can re-run it
      // locally for visualization (preview only — never a re-judge).
      scenario: {
        traffic: tc.traffic,
        durationTicks: tc.durationTicks,
        events: tc.events ?? [],
        kills: tc.kills ?? [],
        thresholds: tc.thresholds,
      },
    });
  });
  const { results, coverage } = ensureVerifiedActions(raw, problem, design);
  return { results, actionCoverage: coverage };
}
