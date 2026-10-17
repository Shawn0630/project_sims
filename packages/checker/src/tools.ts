import type { ComponentTypeId } from '@sds/components';
import { componentDef } from '@sds/components';
import type { SimulatorTools } from '@sds/driver';
import type { ProblemDef, ProblemSchema } from '@sds/problems';
import type { Design, SimulationEngine } from '@sds/sim-core';
import { runTestCase } from './runner';
import { reviewSchema } from './schemaReview';

export interface ToolsDeps {
  engine: SimulationEngine;
  getProblem: () => ProblemDef;
  getDesign: () => Design;
  getSchema: () => ProblemSchema;
  onHighlight: (componentId: string, reason: string) => void;
}

const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * The concrete SimulatorTools implementation every driver drives.
 *
 * Action tools advance the simulation a few ticks after acting, so a
 * following read_metrics observes the effect (like a real operator watching
 * the dashboard settle). run_test_case runs headlessly on a snapshot and
 * never disturbs the live engine.
 */
export function createSimulatorTools(deps: ToolsDeps): SimulatorTools {
  const { engine } = deps;

  const summary = () => {
    const s = engine.snapshot();
    return (
      `QPS ${Math.round(s.totalInQps)} · P99 ${Math.round(s.p99Ms)}ms · 错误率 ${round(s.errorRate)} · ` +
      `命中率 ${round(s.cacheHitRate)} · 读旧 ${round(s.staleReadRate)} · $${s.costPerHour.toFixed(0)}/h`
    );
  };

  const hottest = () => {
    const s = engine.snapshot();
    const design = deps.getDesign();
    let best: { id: string; type: string; util: number } = { id: '', type: '', util: 0 };
    for (const node of design.nodes) {
      const m = s.nodes[node.id];
      if (m && m.util > best.util) best = { id: node.id, type: node.type, util: m.util };
    }
    return best;
  };

  return {
    async setTraffic(patch) {
      engine.setTraffic({
        rps: patch.rps,
        readRatio: patch.readRatio,
      });
      engine.step(5);
      return `traffic set → ${summary()}`;
    },

    async injectEvent(e) {
      const id = engine.injectEvent(e);
      engine.step(5);
      return `event ${e.type} injected (${id}) → ${summary()}`;
    },

    async killNode(a) {
      let target: string | null = a.componentId ?? null;
      if (!target && a.componentType) target = engine.killByType(a.componentType);
      else if (target) engine.killNode(target);
      engine.step(3);
      return target ? `killed ${target} → ${summary()}` : 'no matching alive node to kill';
    },

    async reviveNode(a) {
      const design = deps.getDesign();
      const killed = engine.killedIds();
      let target: string | undefined = a.componentId;
      if (!target && a.componentType) {
        target = killed.find((id) => design.nodes.find((n) => n.id === id)?.type === a.componentType);
      }
      if (target) engine.reviveNode(target);
      engine.step(3);
      return target ? `revived ${target} → ${summary()}` : 'no matching killed node';
    },

    async readMetrics(a) {
      engine.step(1);
      const s = engine.snapshot();
      if (a?.componentId) {
        const node = deps.getDesign().nodes.find((n) => n.id === a.componentId);
        const m = s.nodes[a.componentId];
        if (!node || !m) return { error: `unknown component ${a.componentId}` };
        return {
          componentId: node.id,
          type: node.type,
          inQps: Math.round(m.inQps),
          outQps: Math.round(m.outQps),
          util: round(m.util),
          latencyMs: Math.round(m.latencyMs),
          errorRate: round(m.errorRate),
          queueDepth: m.queueDepth,
          hitRate: m.hitRate !== undefined ? round(m.hitRate) : undefined,
          replicas: node.settings.replicas,
          killed: m.killed,
        };
      }
      const hot = hottest();
      return {
        totalInQps: Math.round(s.totalInQps),
        p99Ms: Math.round(s.p99Ms),
        errorRate: round(s.errorRate),
        cacheHitRate: round(s.cacheHitRate),
        staleReadRate: round(s.staleReadRate),
        costPerHour: Math.round(s.costPerHour),
        maxStorageQps: Math.round(s.maxStorageQps),
        hottestUtil: round(s.hottestUtil),
        hottestComponentId: hot.id,
        hottestComponentType: hot.type,
        activeEvents: s.activeEvents.map((e) => e.type),
      };
    },

    async highlight(a) {
      deps.onHighlight(a.componentId, a.reason);
      const node = deps.getDesign().nodes.find((n) => n.id === a.componentId);
      return `highlighted ${node ? componentDef(node.type).name : a.componentId}: ${a.reason}`;
    },

    async runTestCase(a) {
      const problem = deps.getProblem();
      const tc = problem.testCases.find((c) => c.id === a.caseId);
      if (!tc) {
        return {
          caseId: a.caseId,
          name: a.caseId,
          passed: false,
          failures: [`unknown case ${a.caseId}`],
          measured: {} as Record<string, number>,
        };
      }
      const r = runTestCase(problem, deps.getDesign(), tc);
      return {
        caseId: r.caseId,
        name: r.name,
        passed: r.passed,
        failures: r.failures,
        measured: {
          errorRate: round(r.measured.errorRate),
          p99Ms: Math.round(r.measured.p99Ms),
          costPerHour: Math.round(r.measured.costPerHour),
          maxStorageQps: Math.round(r.measured.maxStorageQps),
          staleReadRate: round(r.measured.staleReadRate),
          hottestUtil: round(r.measured.hottestUtil),
          queueDepthMax: Math.round(r.measured.queueDepthMax),
        },
      };
    },

    async reviewSchema() {
      const s = engine.snapshot();
      const report = reviewSchema(deps.getSchema(), { loadFactor: Math.min(1.5, s.hottestUtil) });
      return {
        score: report.score,
        coverage: report.coverage,
        findings: report.findings.map((f) => ({
          dimension: f.dimension,
          severity: f.severity,
          text: f.text,
        })),
        perPattern: report.perPattern.map((p) => ({
          pattern: p.name,
          path: p.path,
          latencyMs: p.latencyMs,
          verdict: p.verdict,
        })),
      };
    },
  };
}
