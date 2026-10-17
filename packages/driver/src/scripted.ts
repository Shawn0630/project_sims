import type {
  Driver,
  DriverContext,
  DriverFinding,
  DriverReview,
  SimulatorTools,
} from './contract';

/**
 * ScriptedDriver — the deterministic offline operator.
 *
 * Runs a fixed interview script through the same SimulatorTools interface an
 * LLM driver uses: baseline → peak → viral event → kill the hottest tier →
 * test cases → schema review. Findings come from measured metrics plus the
 * deterministic structural findings, never from invented numbers. Works with
 * no network and no API key, and doubles as the regression-test driver.
 */
export class ScriptedDriver implements Driver {
  readonly kind = 'scripted' as const;
  readonly label = '脚本驾驶员（离线）';

  async review(tools: SimulatorTools, ctx: DriverContext): Promise<DriverReview> {
    const transcript: string[] = [];
    const findings: DriverFinding[] = [];
    const log = (s: string) => transcript.push(s);
    const fmt = (m: Record<string, unknown>) =>
      `QPS ${m.totalInQps ?? '?'} · P99 ${m.p99Ms ?? '?'}ms · 错误率 ${m.errorRate ?? '?'} · 命中率 ${m.cacheHitRate ?? '?'} · $${m.costPerHour ?? '?'}/h`;

    // 1. Baseline
    const base = await tools.readMetrics();
    log(`① 读取基线指标：${fmt(base)}`);
    const hottest = String(base.hottestComponentId ?? '');
    const hottestType = String(base.hottestComponentType ?? '');
    if (hottest) {
      log(`   当前最热组件：${hottestType}（利用率 ${base.hottestUtil}）`);
      await tools.highlight({ componentId: hottest, reason: '基线下利用率最高的组件' });
    }

    // 2. Peak traffic
    const baseRps = Number(base.totalInQps ?? 1000);
    await tools.setTraffic({ rps: Math.round(baseRps * 3) });
    const peak = await tools.readMetrics();
    log(`② 流量拉到峰值 ×3：${fmt(peak)}`);
    if (Number(peak.errorRate ?? 0) > 0.01) {
      findings.push({
        severity: 'high',
        title: '峰值流量下错误率超标',
        detail: `峰值时错误率 ${peak.errorRate}，最热组件 ${peak.hottestComponentType} 利用率 ${peak.hottestUtil}。先扩这一层，而不是整体扩容。`,
        componentId: String(peak.hottestComponentId ?? '') || undefined,
      });
      await tools.highlight({
        componentId: String(peak.hottestComponentId ?? ''),
        reason: '峰值下最先饱和',
      });
    } else {
      log('   峰值下错误率仍在 1% 内，容量余量合格。');
    }

    // 3. Viral event
    await tools.injectEvent({ type: 'viral_post', magnitude: 3, durationTicks: 20 });
    const viral = await tools.readMetrics();
    log(`③ 注入网红爆帖事件：${fmt(viral)}`);
    if (Number(viral.errorRate ?? 0) > 0.02) {
      findings.push({
        severity: 'high',
        title: '爆帖场景下错误率飙升',
        detail: `爆帖期间错误率 ${viral.errorRate}，存储层入站 ${viral.maxStorageQps} QPS。若 fan-out 是同步直写存储，这正是写扩散打爆的典型形态——改异步队列 + Worker 扩散。`,
      });
    }

    // 4. Kill the hottest tier and watch failover
    if (hottestType) {
      await tools.killNode({ componentType: hottestType as never });
      const killed = await tools.readMetrics();
      log(`④ 杀掉一个 ${hottestType} 节点：${fmt(killed)}`);
      if (Number(killed.errorRate ?? 0) > 0.02) {
        findings.push({
          severity: 'high',
          title: '单节点故障导致明显错误',
          detail: `杀掉 ${hottestType} 后错误率 ${killed.errorRate}。说明该层没有冗余或余量不足：同类型至少两个节点，且常态利用率要留出 failover 余量。`,
        });
      } else {
        log('   故障下错误率可控，冗余有效。');
      }
      await tools.reviveNode({ componentType: hottestType as never });
      log('   已恢复该节点。');
    }
    await tools.setTraffic({ rps: baseRps });

    // 5. Test cases
    const caseResults = [];
    for (const c of ctx.availableCases.slice(0, 4)) {
      const r = await tools.runTestCase({ caseId: c.id });
      caseResults.push(r);
      log(`⑤ 用例「${r.name}」：${r.passed ? '通过' : `未通过 — ${r.failures.join('；')}`}`);
      if (!r.passed) {
        findings.push({
          severity: 'medium',
          title: `测试用例未通过：${r.name}`,
          detail: r.failures.join('；'),
        });
      }
    }

    // 6. Schema review
    const schema = await tools.reviewSchema();
    log(`⑥ 数据库设计评审：${schema.score} 分（${schema.coverage}）`);
    for (const f of schema.findings.slice(0, 3)) {
      findings.push({ severity: f.severity, title: `Schema · ${f.dimension}`, detail: f.text });
    }

    // Structural findings are verified ground truth — surface them all.
    for (const f of ctx.structuralFindings) {
      findings.push({
        severity: f.severity,
        title: `结构缺陷：${f.title}`,
        detail: f.detail,
        componentId: f.componentIds[0],
      });
      if (f.componentIds[0]) {
        await tools.highlight({ componentId: f.componentIds[0], reason: f.title });
      }
    }

    const passed = caseResults.filter((r) => r.passed).length;
    const summary =
      `脚本驾驶员完成一轮完整面试模拟：基线 → 峰值 ×3 → 爆帖 → 杀节点 → ${caseResults.length} 个用例（${passed} 个通过）→ Schema 评审 ${schema.score} 分。` +
      (findings.length
        ? `共 ${findings.length} 条发现，按严重程度排序见下。`
        : '未发现明显问题：容量、冗余与结构都过关。');

    return { summary, findings, transcript };
  }
}
