import { componentDef } from '@sds/components';
import type {
  Driver,
  DriverContext,
  DriverFinding,
  DriverReview,
  FollowUpContext,
  FollowUpQuestion,
  SchemaAssessment,
  SchemaAssessmentContext,
  SimulatorTools,
  SubmissionAssessment,
  SubmissionAssessmentContext,
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
  readonly label = '本地脚本';

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
      `本地脚本完成一轮完整模拟：基线 → 峰值 ×3 → 爆帖 → 杀节点 → ${caseResults.length} 个用例（${passed} 个通过）→ Schema 评审 ${schema.score} 分。` +
      (findings.length
        ? `共 ${findings.length} 条发现，按严重程度排序见下。`
        : '未发现明显问题：容量、冗余与结构都过关。');

    return { summary, findings, transcript };
  }

  // ------------------------------------------- qualitative assessment ---
  // The three methods below are the offline fallback for the assessment
  // layer. They compose narrative ONLY from deterministic signals (code
  // judging + rule findings) — the same inputs an LLM driver receives —
  // so the UI renders identical shapes regardless of which driver is on.

  async assessSubmission(ctx: SubmissionAssessmentContext): Promise<SubmissionAssessment> {
    const failed = ctx.cases.filter((c) => !c.passed);
    const findings: DriverFinding[] = [];
    for (const f of ctx.structuralFindings) {
      findings.push({
        severity: f.severity,
        title: `结构性 bug：${f.title}`,
        detail: f.detail,
        componentId: f.componentIds[0],
      });
    }
    for (const c of failed) {
      findings.push({
        severity: 'medium',
        title: `用例挂了：${c.name}`,
        detail: c.failures.join('；'),
      });
    }
    const summary =
      `本轮代码判卷 ${ctx.passed}/${ctx.total} 通过，得分 ${ctx.scorePct}。` +
      (ctx.structuralFindings.length
        ? `结构层面有 ${ctx.structuralFindings.length} 处确定性缺陷（见下），这类问题不随流量变化，先修结构再谈扩容。`
        : '结构层面没有确定性缺陷，失分主要来自容量与场景。') +
      (failed.length
        ? `挂掉的用例：${failed.map((c) => c.name).join('、')}。`
        : '全部用例通过。');
    const scoreRationale =
      `分数由代码判卷按用例权重算出（P99 / 错误率 / 成本等硬阈值，LLM 不改判）。` +
      (failed.length
        ? `失分集中在 ${failed.map((c) => `「${c.name}」`).join('、')}：先看每个用例的实测值与阈值的差距，差距最大的就是这份设计当前最短的板。` +
          (ctx.structuralFindings.length
            ? '注意：结构缺陷会同时拖垮多个用例，修掉一条结构问题往往比逐例调参涨分更快。'
            : '')
        : '没有失分用例；想继续压榨就去挑战隐藏用例的余量与成本项。');
    return { summary, scoreRationale, findings };
  }

  async generateFollowUps(ctx: FollowUpContext): Promise<FollowUpQuestion[]> {
    const out: FollowUpQuestion[] = [];
    const seen = new Set<string>();
    const push = (level: FollowUpQuestion['level'], question: string, keyPoints: string[]) => {
      if (seen.has(question) || out.length >= 6) return;
      seen.add(question);
      out.push({ level, question, keyPoints });
    };
    const failedIds = new Set(ctx.failedCases.map((c) => c.id));
    const hasFailed = (frag: string) => [...failedIds].some((id) => id.includes(frag));
    const rules = new Set(ctx.structuralFindings.map((f) => f.ruleId));
    const failedHere = (frag: string) => ctx.failedCases.find((c) => c.id.includes(frag));
    const isStorage = ctx.componentType === 'relationaldb' || ctx.componentType === 'nosql';
    const patternNames = ctx.workload.patternsHere.map((p) => `「${p.name}」`).join('、');
    const readPatternNames =
      ctx.workload.patternsHere.filter((p) => p.kind === 'read').map((p) => `「${p.name}」`).join('、') || patternNames;
    const readPct = Math.round(ctx.workload.readShareHere * 100);

    // --- contextual questions, generated from THIS design's signals ---
    if (isStorage && !ctx.upstreamTypes.includes('cache') && ctx.workload.readShareHere > 0.6) {
      push('追问',
        `本题打到这个存储的流量里约 ${readPct}% 是读（${readPatternNames || '读模式'}），而你的设计里它前面没有缓存——读热点全量回源时，这个组件先被打满还是先变慢？你打算把缓存放哪一层？`,
        ['读热点回源是存储层最常见的死法：先算热点读的 QPS 与单机容量比', '缓存位置决定命中率与一致性代价：放在读路径前一层、按 key 亲和', '别忘了缓存挂掉时的回源保护（限流/降级），否则缓存层本身就是雪崩源']);
    }
    if (isStorage && (hasFailed('hotshard') || rules.has('bad-shard-key'))) {
      push('追问',
        `热点分片的信号已经出现了（${failedHere('hotshard')?.name ?? '分片键规则'}）。结合你现在的分片键选择：大 V / 热点 key 的流量会落到哪个分片？那个分片先到顶时你怎么办？`,
        ['热点分片的本质是 key 分布与流量分布不一致：均匀的 key ≠ 均匀的流量', '对策：热点 key 单独拆分（分片计数、热点复制多读副本）、或换分片键牺牲局部性', '先量化：最热分片 QPS vs 单分片容量，差几倍决定用哪种对策']);
    }
    if (ctx.componentType === 'feedservice' && (hasFailed('fanout') || rules.has('sync-fanout'))) {
      push('追问',
        `fan-out 用例在你的设计上挂了。结合本题的粉丝量级（${ctx.workload.patternsHere.find((p) => p.kind === 'write')?.name ?? '发帖写'}）：纯推模式写放大是多少？换成推拉混合，大 V 的阈值划在哪？`,
        ['写放大 = 发帖速率 × 平均粉丝数，先把这个数算出来再谈方案', '工业界答案是混合：普通用户推、大 V 拉，阈值按粉丝数与发帖频率双维度', '拉模式的代价转移到读路径：聚合关注列表的延迟要算进 Feed 的 P99']);
    }
    if (ctx.componentType === 'gateway' && /限流=(0|关闭)|限流阈值 0/.test(ctx.componentSettingsSummary)) {
      push('故障',
        '你这个网关的限流是关着的。峰值或下游变慢时，没有限流的入口会发生什么？阈值应该按什么来定？',
        ['无限流时下游过载会以排队→超时→重试风暴的形式放大成全站雪崩', '阈值按下游真实容量反推，留 failover 余量，不是拍脑袋数字', '限流要分级：全局兜底 + 按用户/接口配额，超限返回明确错误而不是排队']);
    }
    if (ctx.componentType === 'cache' && hasFailed('stampede')) {
      push('故障',
        `缓存雪崩用例挂了。本题这个缓存承接的是 ${patternNames || '热点读'}——整点过期那一刻，回源流量会跳到多少倍？你的 TTL 与重建策略防得住吗？`,
        ['雪崩 = 大批 key 同时过期 + 回源无保护，先估回源倍数（≈ 命中率的倒数）', 'TTL 加随机抖动、互斥重建、逻辑过期三件套，按命中率代价选', '这一题的读占比决定雪崩杀伤力：读越重，回源放大越狠']);
    }
    if ((ctx.componentType === 'queue' || ctx.componentType === 'worker')) {
      const backlogCase = ctx.failedCases.find((c) => c.failures.some((f) => f.includes('积压')));
      if (backlogCase) {
        push('追问',
          `用例「${backlogCase.name}」里队列积压超标了。生产速率和消费速率现在各是多少？积压涨起来时你先扩消费者，还是先削生产端？`,
          ['积压 = (生产 − 消费) × 时间，先定位是哪边的问题再动手', '扩消费者要看下游（存储）能不能吃下更高的写入速率', '削生产端 = 降级/采样/延迟非核心写入，要事先定义哪些写可以丢']);
      }
    }
    if (isStorage && hasFailed('stale')) {
      push('进阶',
        '主从延迟读旧数据的用例挂了。这份设计里哪些读走了副本？哪条访问模式是绝对不能读旧的（结合本题一致性要求）？',
        ['读旧的根源是 replica lag：写后立刻读、强一致读必须走主库或会话一致', '按访问模式分级：不是所有读都要强一致，逐条对照本题的一致性要求', '折中方案：版本号/时间戳校验、读主库只给写后读的那一小撮流量']);
    }
    if (hasFailed('nodefail') || rules.has('spof')) {
      const spof = ctx.structuralFindings.find((f) => f.ruleId === 'spof');
      if (spof || ctx.componentType) {
        push('故障',
          '峰值期节点宕机的场景是这份设计的软肋之一。这个组件如果现在挂掉，流量改道到哪？改道后的余量够不够？',
          ['冗余不是「有两个节点」就行：常态利用率必须留出 failover 余量（N+1）', '改道机制本身要验证：LB 健康检查、连接排空、缓存预热都会影响切换瞬间', '先量化单点故障时的错误率与恢复时间，再谈要不要多花钱']);
      }
    }

    // --- fallback: this component's static interview chain (offline pool) ---
    const def = componentDef(ctx.componentType);
    for (const q of def.questions) {
      push(q.level, q.question, q.keyPoints);
    }
    return out;
  }

  async assessSchema(ctx: SchemaAssessmentContext): Promise<SchemaAssessment> {
    const s = ctx.signals;
    const byDim = (d: '需求覆盖' | '延迟风险' | '扩展性') => s.findings.filter((f) => f.dimension === d);
    const worst = s.findings[0];
    const conclusion =
      `Schema 评审（信号来自代码规则，结论为脚本评审员整理）：${s.score} 分，${s.coverage}。` +
      (worst
        ? `最要命的一条在「${worst.dimension}」：${worst.text}`
        : '三个维度都没有发现问题：访问模式都有可用路径，分片与主键选择也没有踩到扩展性雷区。');
    const dimensionNotes = (['需求覆盖', '延迟风险', '扩展性'] as const).map((d) => {
      const fs = byDim(d);
      return {
        dimension: d,
        note: fs.length
          ? fs.slice(0, 2).map((f) => f.text).join(' ')
          : d === '需求覆盖'
            ? '全部访问模式都有可用路径（主键直查 / 索引 / 分片内定位），没有全表扫描或跨分片广播。'
            : d === '延迟风险'
              ? '没有显著的延迟风险点；延迟估算已按当前画布 DB 利用率折算。'
              : '没有发现扩展性雷区：分片键、主键生成与索引数量都在安全区。',
      };
    });
    const suggestions = s.findings.slice(0, 5).map((f) => `「${f.dimension}」${f.text}`);
    if (!suggestions.length) {
      suggestions.push('保持当前 schema；下一步可以去挑战更大的数据量级档位，看哪条访问模式先变风险。');
    }
    return { conclusion, dimensionNotes, suggestions };
  }
}
