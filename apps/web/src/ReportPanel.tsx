import type {
  ProblemCaseDTO,
  ProblemPack,
  StructuralFindingDTO,
  SuiteResultDTO,
  VerifiedProbeDTO,
} from './api';

function thresholdSummary(tc: ProblemCaseDTO): string {
  const t = tc.thresholds;
  const parts: string[] = [];
  if (t.maxErrorRate !== undefined) parts.push(`错误率 < ${(t.maxErrorRate * 100).toFixed(1)}%`);
  if (t.maxP99Ms !== undefined) parts.push(`P99 < ${t.maxP99Ms}ms`);
  if (t.maxCostPerHour !== undefined) parts.push(`成本 < $${t.maxCostPerHour}/h`);
  if (t.maxStorageQps !== undefined) parts.push(`存储入站 < ${t.maxStorageQps} QPS`);
  if (t.maxStaleReadRate !== undefined) parts.push(`读旧 < ${(t.maxStaleReadRate * 100).toFixed(0)}%`);
  if (t.maxHottestUtil !== undefined) parts.push(`最热利用率 < ${Math.round(t.maxHottestUtil * 100)}%`);
  if (t.maxQueueDepth !== undefined) parts.push(`积压 < ${t.maxQueueDepth.toLocaleString()}`);
  return parts.join(' · ');
}

export function scoreColor(scorePct: number): string {
  return scorePct >= 80 ? '#4ade80' : scorePct >= 50 ? '#facc15' : '#f87171';
}

interface CaseListProps {
  problem: ProblemPack;
  suite: SuiteResultDTO | null;
  replayingId: string | null;
  onReplay: (tc: ProblemCaseDTO) => void;
  onStopReplay: () => void;
}

/**
 * The per-case rows: visible cases with thresholds up front; hidden edge
 * cases stay locked until a submission reveals them. Once judged, each row
 * shows measured-vs-threshold, failure explanations and a replay action.
 */
export function CaseList(props: CaseListProps) {
  const { problem, suite } = props;
  const resultByCase = new Map(suite?.results.map((r) => [r.caseId, r]));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {problem.testCases.map((tc) => {
        const r = resultByCase.get(tc.id);
        const revealed = !!r;
        if (tc.hidden && !revealed) {
          return (
            <div key={tc.id} className="case-row case-hidden">
              <span className="chip">🔒 隐藏用例</span>
              <b style={{ marginLeft: 6 }}>？？？</b>
              <span style={{ color: '#94a3b8', marginLeft: 6 }}>场景与阈值：提交并判卷后揭示</span>
            </div>
          );
        }
        return (
          <div key={tc.id} className={`case-row ${r ? (r.passed ? 'case-pass' : 'case-fail') : ''}`}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {r ? (
                <span className={`chip ${r.passed ? 'chip-pass' : 'chip-fail'}`}>
                  {r.passed ? '通过' : '未通过'}
                </span>
              ) : (
                <span className="chip">可见用例</span>
              )}
              {tc.hidden && <span className="chip chip-hidden-tag">隐藏 · 已揭示</span>}
              <b>{r ? r.name : tc.name}</b>
              <span style={{ color: '#94a3b8', fontSize: 12.5 }}>{thresholdSummary(tc)}</span>
              {r && !tc.locked && (
                <button
                  onClick={() =>
                    props.replayingId === tc.id ? props.onStopReplay() : props.onReplay(tc)
                  }
                  style={{ marginLeft: 'auto' }}
                >
                  {props.replayingId === tc.id ? '⏹ 结束回放' : '🎬 回放这一例'}
                </button>
              )}
            </div>
            {!tc.locked && (
              <div style={{ color: '#cbd5e1', fontSize: 13, marginTop: 4 }}>{tc.description}</div>
            )}
            {r && (
              <div style={{ fontSize: 12.5, marginTop: 4, color: '#94a3b8' }}>
                实测：错误率 {(r.measured.errorRate * 100).toFixed(1)}% · P99 {Math.round(r.measured.p99Ms)}ms ·
                成本 ${r.measured.costPerHour.toFixed(0)}/h · 存储入站 {Math.round(r.measured.maxStorageQps)} QPS ·
                最热利用率 {Math.round(r.measured.hottestUtil * 100)}%
                {r.measured.queueDepthMax > 0 && ` · 最大积压 ${Math.round(r.measured.queueDepthMax).toLocaleString()}`}
              </div>
            )}
            {r && r.failures.length > 0 && (
              <ul style={{ margin: '4px 0 0', paddingLeft: 18, color: '#fca5a5', fontSize: 13 }}>
                {r.failures.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            )}
            {r && !r.passed && r.hint && (
              <div style={{ fontSize: 12.5, color: '#facc15', marginTop: 4 }}>💡 {r.hint}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface ProbeSectionProps {
  busy: boolean;
  /** Why the probe step produced nothing (unavailable / no valid cases). */
  note: string | null;
  results: VerifiedProbeDTO[] | null;
  /** Attribution of the proposer （云端 LLM / 本地脚本）. */
  sourceLabel: string;
}

const VERDICT_META: Record<VerifiedProbeDTO['verdict'], { text: string; cls: string }> = {
  hit: { text: '预言命中', cls: 'chip-pass' },
  held: { text: '设计扛住了', cls: 'chip-held' },
  miss: { text: '未命中', cls: 'chip-fail' },
};

/**
 * LLM-proposed probe cases AFTER simulator verification: what the model
 * predicted for this design, what the engine actually measured, and the
 * graded verdict. The model proposes; the simulator is the arbiter.
 */
export function ProbeSection(props: ProbeSectionProps) {
  const { busy, note, results, sourceLabel } = props;
  return (
    <div style={{ marginTop: 14, border: '1px solid #1e293b', borderRadius: 8, padding: '10px 12px', background: '#0b1220' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <b>🔬 LLM 探测用例（已由仿真验证）</b>
        {sourceLabel && (
          <span style={{ color: '#94a3b8', fontSize: 12 }}>提案：{sourceLabel}</span>
        )}
      </div>
      {busy && (
        <div style={{ color: '#94a3b8', fontSize: 13, marginTop: 6 }}>
          探测中…（模型正在针对这份设计提出假设用例，随后由仿真逐例验证）
        </div>
      )}
      {!busy && note && !results && (
        <div style={{ color: '#94a3b8', fontSize: 13, marginTop: 6 }}>{note}</div>
      )}
      {results && results.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          {results.map((r, i) => {
            const v = VERDICT_META[r.verdict];
            return (
              <div key={i} className="case-row">
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className={`chip ${v.cls}`}>{v.text}</span>
                  <b>{r.name}</b>
                  <span style={{ color: '#94a3b8', fontSize: 12.5 }}>{r.scenarioSummary}</span>
                </div>
                <div style={{ fontSize: 13, marginTop: 4, color: '#cbd5e1' }}>
                  预测：{r.prediction.willFail ? `会失败 · 主要突破口「${r.prediction.primaryBreach}」` : '能通过'}
                  {r.prediction.rationale && <span> — {r.prediction.rationale}</span>}
                </div>
                <div style={{ fontSize: 12.5, marginTop: 3, color: '#94a3b8' }}>
                  实测：{r.passed ? '通过' : `未通过${r.actualBreach ? ` · 实际突破口「${r.actualBreach}」` : ''}`} ·
                  错误率 {(r.measured.errorRate * 100).toFixed(1)}% · P99 {Math.round(r.measured.p99Ms)}ms ·
                  成本 ${r.measured.costPerHour.toFixed(0)}/h · 存储入站 {Math.round(r.measured.maxStorageQps)} QPS ·
                  最热利用率 {Math.round(r.measured.hottestUtil * 100)}%
                  {r.measured.queueDepthMax > 0 && ` · 最大积压 ${Math.round(r.measured.queueDepthMax).toLocaleString()}`}
                </div>
                {!r.passed && r.failures.length > 0 && (
                  <div style={{ fontSize: 12.5, marginTop: 3, color: '#fca5a5' }}>{r.failures.join('；')}</div>
                )}
                {r.prediction.fixHint && (
                  <div style={{ fontSize: 12.5, marginTop: 3, color: '#facc15' }}>💡 {r.prediction.fixHint}</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface StructuralListProps {
  structural: StructuralFindingDTO[];
  onSelectNode: (id: string) => void;
}

/** Deterministic structural bug findings (no LLM involved). */
export function StructuralList(props: StructuralListProps) {
  const { structural } = props;
  if (structural.length === 0) {
    return (
      <div style={{ color: '#4ade80', fontSize: 13 }}>
        没有发现结构性缺陷。这一关过了，剩下的是容量与场景问题。
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {structural.map((f, i) => (
        <div key={i} className="finding-row">
          <span className={`chip chip-${f.severity}`}>{f.severity}</span> <b>{f.title}</b>
          <div style={{ color: '#cbd5e1', fontSize: 13, marginTop: 3 }}>{f.detail}</div>
          {f.componentIds.length > 0 && (
            <button onClick={() => props.onSelectNode(f.componentIds[0]!)} style={{ marginTop: 5 }}>
              在画布上看这个组件 →
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

interface ReportPanelProps {
  problem: ProblemPack;
  phase: 'design' | 'run' | 'report';
  suite: SuiteResultDTO | null;
  structural: StructuralFindingDTO[];
  replayingId: string | null;
  onRunSuite: () => void;
  onReplay: (tc: ProblemCaseDTO) => void;
  onStopReplay: () => void;
  onSelectNode: (id: string) => void;
}

export function ReportPanel(props: ReportPanelProps) {
  const { problem, phase, suite, structural } = props;

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        {suite ? (
          <div style={{ fontSize: 16 }}>
            本轮成绩：<b style={{ color: scoreColor(suite.scorePct) }}>{suite.scorePct} 分</b>{' '}
            （{suite.passedCount}/{suite.totalCount} 个用例通过）
          </div>
        ) : (
          <div style={{ color: '#94a3b8', fontSize: 13 }}>
            {phase === 'design'
              ? '可见用例先亮出来（像 LeetCode 的样例），隐藏 edge cases 提交后才揭示。'
              : '点右侧按钮跑全部用例判卷。'}
          </div>
        )}
        <button className="primary" onClick={props.onRunSuite} disabled={phase === 'design'} style={{ marginLeft: 'auto' }}>
          ▶ 运行全部用例
        </button>
      </div>

      <div style={{ marginTop: 12 }}>
        <CaseList
          problem={problem}
          suite={suite}
          replayingId={props.replayingId}
          onReplay={props.onReplay}
          onStopReplay={props.onStopReplay}
        />
      </div>

      <h4 style={{ margin: '18px 0 8px' }}>🧱 结构检查（确定性规则，不依赖 LLM）</h4>
      <StructuralList structural={structural} onSelectNode={props.onSelectNode} />
    </div>
  );
}
