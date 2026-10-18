import { useState } from 'react';
import type { MetricsSnapshot } from '@sds/sim-core';
import type {
  ActionCoverageDTO,
  ProblemSchemaDTO,
  SchemaAssessmentDTO,
  SchemaOpDTO,
  SchemaSignalsDTO,
  SchemaSimDTO,
  SchemaSuiteDTO,
  SchemaTableDTO,
  VerifiedSchemaProbeDTO,
} from './api';
import { ActionSourceLabel, CoverageLine } from './ReportPanel';
import { QueryPlaybackPanel, type PlaybackLane } from './QueryPlayback';

export function formatBytes(n: number): string {
  if (n >= 1e15) return `${(n / 1e15).toFixed(1)} PB`;
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)} TB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.round(n).toLocaleString()} B`;
}

const verdictColor = (v: string) =>
  v === '通过' ? '#4ade80' : v === '风险' ? '#facc15' : '#f87171';

function fmtMs(ms: number): string {
  if (ms >= 60_000) return `${(ms / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 })}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function fmtUtil(u: number): string {
  return u >= 10 ? `${Math.round(u)}（饱和）` : u.toFixed(2);
}

/**
 * The schema simulator's measurements, rendered as tables/cards (the
 * server RAN the problem's requirement workload against the schema —
 * these are run measurements from one explicit cost model, shown with
 * its assumptions, not the static checker's formula estimates).
 * `compact` keeps only the headline + per-table load lines, for the
 * results page's 「数据库评审」 tab next to the deterministic signals.
 */
export function SchemaSimView({
  sim,
  compact,
  prevSim,
}: {
  sim: SchemaSimDTO;
  compact?: boolean;
  /** Previous run for a DIFFERENT schema of the same problem — enables
   *  the per-pattern 对比竞速 (old vs new under ONE shared compression). */
  prevSim?: SchemaSimDTO | null;
}) {
  const grownById = new Map(sim.perPatternGrown.map((p) => [p.patternId, p]));
  const fb = sim.headline.firstBreak;
  const [playback, setPlayback] = useState<{ patternId: string; race: boolean } | null>(null);
  const prevById = new Map((prevSim?.perPattern ?? []).map((p) => [p.patternId, p]));
  const raceable = (p: SchemaSimDTO['perPattern'][number]): boolean => {
    const prev = prevById.get(p.patternId);
    return (
      !!prev &&
      (prev.p99Ms !== p.p99Ms || prev.rowsExaminedPerQuery !== p.rowsExaminedPerQuery || prev.path !== p.path)
    );
  };
  const playbackLanes = (): { title: string; lanes: PlaybackLane[] } | null => {
    if (!playback) return null;
    const cur = sim.perPattern.find((p) => p.patternId === playback.patternId);
    if (!cur) return null;
    if (playback.race) {
      const prev = prevById.get(cur.patternId);
      if (!prev) return null;
      return {
        title: `对比竞速：${cur.name}`,
        lanes: [
          { id: 'old', label: '旧 schema（上一次运行）', pattern: prev },
          { id: 'new', label: '新 schema（本次运行）', pattern: cur },
        ],
      };
    }
    return { title: `试运行：${cur.name}`, lanes: [{ id: 'run', label: cur.name, pattern: cur }] };
  };
  const pb = playbackLanes();
  return (
    <div className="review-box">
      <div
        style={{
          border: `1px solid ${fb ? '#7f1d1d' : '#14532d'}`,
          background: fb ? '#1c0f0f' : '#0c1a12',
          borderRadius: 8,
          padding: '8px 12px',
          marginBottom: 10,
          fontSize: 13,
          lineHeight: 1.6,
        }}
      >
        {fb ? (
          <>
            <b style={{ color: '#fca5a5' }}>
              ⚠️ 最先崩的点（{fb.atScale === 'now' ? '当前规模' : `数据量 ×${sim.growthFactor} 后`}）
            </b>
            <div>{fb.reason}</div>
          </>
        ) : (
          <b style={{ color: '#86efac' }}>
            ✅ 当前与 ×{sim.growthFactor} 规模下没有访问模式判定不通过
          </b>
        )}
        <div style={{ color: '#cbd5e1' }}>
          按当前结构，总流量约 <b>{sim.headline.maxSustainableQps.toLocaleString()} 次/s</b> 时
          最热的表{sim.headline.bottleneckTable ? `（${sim.headline.bottleneckTable}）` : ''}
          先饱和。延迟预算 P99 ≤ {sim.budgetMs}ms（题目用例里最严的阈值）。
        </div>
      </div>

      {!compact && (
        <table className="mini-table">
          <thead>
            <tr>
              <th>访问模式</th><th>路径</th><th>流量</th><th>扫描行数/次</th>
              <th>平均</th><th>P99</th><th>×{sim.growthFactor} 后 P99</th><th>判定</th><th>说明</th><th>回放</th>
            </tr>
          </thead>
          <tbody>
            {sim.perPattern.map((p) => {
              const g = grownById.get(p.patternId);
              return (
                <tr key={p.patternId}>
                  <td>{p.name}<span style={{ color: '#64748b' }}>（{p.table}）</span></td>
                  <td>{p.path}</td>
                  <td>{p.qps.toLocaleString()}/s</td>
                  <td>{p.rowsExaminedPerQuery.toLocaleString()}</td>
                  <td>{fmtMs(p.avgMs)}</td>
                  <td>{fmtMs(p.p99Ms)}</td>
                  <td style={{ color: g ? verdictColor(g.verdict) : undefined }}>
                    {g ? fmtMs(g.p99Ms) : '—'}
                  </td>
                  <td style={{ color: verdictColor(p.verdict) }}>{p.verdict}</td>
                  <td style={{ color: '#94a3b8' }}>{p.note}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button
                      onClick={() =>
                        setPlayback(
                          playback?.patternId === p.patternId && !playback.race
                            ? null
                            : { patternId: p.patternId, race: false },
                        )
                      }
                      title="用真实语句试运行这条查询，动画回放它的扫描行数与 P99（带压缩标注）"
                    >
                      {playback?.patternId === p.patternId && !playback.race ? '⏹ 收起' : '▶ 试运行'}
                    </button>
                    {raceable(p) && (
                      <button
                        onClick={() =>
                          setPlayback(
                            playback?.patternId === p.patternId && playback.race
                              ? null
                              : { patternId: p.patternId, race: true },
                          )
                        }
                        title="和上一次不同 schema 的运行结果并排竞速：同一压缩倍数下看旧 vs 新"
                        style={{ marginLeft: 4 }}
                      >
                        {playback?.patternId === p.patternId && playback.race ? '⏹ 收起' : '⏱ 竞速 vs 上一版'}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {!compact && pb && (
        <QueryPlaybackPanel title={pb.title} lanes={pb.lanes} onClose={() => setPlayback(null)} />
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: compact ? 0 : 10 }}>
        {sim.perTable.map((t) => (
          <div
            key={t.table}
            style={{
              border: '1px solid #1e293b', borderRadius: 8, padding: '8px 10px',
              background: '#0b1220', fontSize: 12.5, lineHeight: 1.7, minWidth: 230, flex: '1 1 230px',
            }}
          >
            <b>🗄️ {t.table}</b>
            <span style={{ color: '#64748b' }}>（{t.engine === 'relational' ? '关系型' : 'NoSQL'}）</span>
            <div>
              读 {t.readQps.toLocaleString()}/s · 写 {t.writeQps.toLocaleString()}/s · 索引 {t.indexCount} 个（写放大 ×{t.writeAmpFactor}）
            </div>
            <div>
              最热分片利用率{' '}
              <b style={{ color: t.hottestShardUtil >= 1 ? '#f87171' : t.hottestShardUtil >= 0.7 ? '#facc15' : '#4ade80' }}>
                {fmtUtil(t.hottestShardUtil)}
              </b>
              {' → ×'}{sim.growthFactor} 后{' '}
              <b style={{ color: t.hottestShardUtilGrown >= 1 ? '#f87171' : t.hottestShardUtilGrown >= 0.7 ? '#facc15' : '#4ade80' }}>
                {fmtUtil(t.hottestShardUtilGrown)}
              </b>
              {t.shardKey ? `（${t.shardCount} 个分片，分片键 ${t.shardKey}）` : '（未分片）'}
            </div>
            <div style={{ color: '#94a3b8' }}>
              体积 {formatBytes(t.sizeBytesNow)}（{t.rows.toLocaleString()} 行）
              {' → '}{formatBytes(t.sizeBytesGrown)}（{t.rowsGrown.toLocaleString()} 行）
            </div>
          </div>
        ))}
      </div>

      {!compact && (
        <ul style={{ margin: '8px 0 0', paddingLeft: 18, color: '#64748b', fontSize: 12 }}>
          {sim.assumptions.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

const ROW_PRESETS = [100_000, 10_000_000, 1_000_000_000, 50_000_000_000];

/**
 * The deterministic schema checker display: score, requirement coverage,
 * per-access-pattern path/latency verdicts and the rule findings grouped
 * by dimension. Pure rendering of backend-computed signals — used both as
 * design-time feedback inside the 数据库设计 view and as the evidence block
 * of the results page's 「数据库评审」 tab.
 */
export function SchemaSignalsView({ signals }: { signals: SchemaSignalsDTO }) {
  return (
    <div className="review-box">
      <div style={{ display: 'flex', gap: 18, alignItems: 'baseline' }}>
        <span style={{ fontSize: 30, fontWeight: 800, color: signals.score >= 80 ? '#4ade80' : signals.score >= 55 ? '#facc15' : '#f87171' }}>
          {signals.score} 分
        </span>
        <span>{signals.coverage}</span>
      </div>
      <table className="mini-table">
        <thead>
          <tr><th>访问模式</th><th>路径</th><th>延迟估算</th><th>判定</th><th>说明</th></tr>
        </thead>
        <tbody>
          {signals.perPattern.map((p) => (
            <tr key={p.patternId}>
              <td>{p.name}</td>
              <td>{p.path}</td>
              <td>≈{p.latencyMs}ms</td>
              <td style={{ color: p.verdict === '通过' ? '#4ade80' : p.verdict === '风险' ? '#facc15' : '#f87171' }}>
                {p.verdict}
              </td>
              <td style={{ color: '#94a3b8' }}>{p.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {(['需求覆盖', '延迟风险', '扩展性'] as const).map((dim) => {
        const items = signals.findings.filter((f) => f.dimension === dim);
        if (!items.length) return null;
        return (
          <div key={dim} style={{ marginTop: 8 }}>
            <b>{dim} · 规则信号</b>
            <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
              {items.map((f, i) => (
                <li key={i} style={{ color: f.severity === 'high' ? '#fca5a5' : '#e2e8f0' }}>
                  {f.text}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The qualitative schema conclusions — produced by the backend's unified
 * submit (one evaluate call), rendered ONLY in the results page's
 * 「数据库评审」 tab. This panel holds no review logic of its own.
 * Suggestions carry server-validated schema-ops (the action guarantee):
 * when `onApplySuggestion` is given, each suggestion with actions gets a
 * ✨ button that enters the schema fix preview (confirm/undo discipline
 * lives in App, exactly like the architecture fix loop).
 */
/**
 * The schema test-case suite results — the database design's own
 * LeetCode score, judged deterministically by the schema simulator at
 * submit time. Independent of the architecture score by design. Failed
 * rows carry the grounded fix derived from the failed metric itself
 * （规则·实测）: preview → confirm applies it to the schema draft.
 */
export function SchemaSuiteView({
  suite,
  onApplyFix,
}: {
  suite: SchemaSuiteDTO;
  onApplyFix?: (title: string, actions: SchemaOpDTO[]) => void;
}) {
  return (
    <div style={{ border: '1px solid #1e293b', borderRadius: 8, padding: '10px 12px', background: '#0b1220', marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 26, fontWeight: 800, color: suite.scorePct >= 80 ? '#4ade80' : suite.scorePct >= 50 ? '#facc15' : '#f87171' }}>
          {suite.scorePct} 分
        </span>
        <b>🗄️ 数据库用例判卷</b>
        <span style={{ color: '#94a3b8', fontSize: 12.5 }}>
          通过 {suite.passedCount}/{suite.totalCount} · 由数据库模拟实测判定 · 与架构总分独立
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
        {suite.results.map((r) => (
          <div key={r.caseId} className="case-row">
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className={`chip ${r.passed ? 'chip-pass' : 'chip-fail'}`}>{r.passed ? '通过' : '未通过'}</span>
              <b>{r.name}</b>
              {r.hidden && <span className="chip chip-neutral">隐藏用例</span>}
            </div>
            <div style={{ fontSize: 12.5, marginTop: 3, color: '#94a3b8' }}>
              实测：{r.measuredText} · 要求：{r.thresholdText}
            </div>
            {!r.passed && r.failures.length > 0 && (
              <div style={{ fontSize: 12.5, marginTop: 3, color: '#fca5a5' }}>{r.failures.join('；')}</div>
            )}
            {!r.passed && r.fix && onApplyFix && (
              <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <button onClick={() => onApplyFix(r.fix!.title, r.fix!.actions)} title="预览这条修复，确认后才应用到数据库设计草稿">
                  ✨ 应用修复
                </button>
                <ActionSourceLabel source="rule" />
                <span style={{ color: '#94a3b8', fontSize: 12 }}>{r.fix.title}</span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const SCHEMA_PROBE_VERDICT_META: Record<
  VerifiedSchemaProbeDTO['verdict'],
  { text: string; cls: string }
> = {
  hit: { text: '预言命中', cls: 'chip-pass' },
  held: { text: '设计扛住了', cls: 'chip-held' },
  miss: { text: '未命中', cls: 'chip-fail' },
};

/**
 * AI schema probes AFTER simulator verification — the database mirror of
 * the architecture probe section. The model proposed adversarial data
 * scenarios （倾斜/增长/热点/结构翻转） from the criteria and sim
 * measurements alone; the schema simulator re-ran each scenario and
 * graded the prediction. Fixes ride the same provenance badges.
 */
export function SchemaProbeSection(props: {
  busy: boolean;
  note: string | null;
  results: VerifiedSchemaProbeDTO[] | null;
  sourceLabel: string;
  coverage?: ActionCoverageDTO | null;
  onApplyFix: (title: string, actions: SchemaOpDTO[]) => void;
}) {
  const { busy, note, results, sourceLabel } = props;
  return (
    <div style={{ border: '1px solid #1e293b', borderRadius: 8, padding: '10px 12px', background: '#0b1220', marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <b>🔬 AI 探测（已由仿真验证）</b>
        {sourceLabel && (
          <span style={{ color: '#94a3b8', fontSize: 12 }}>提案：{sourceLabel}</span>
        )}
      </div>
      {props.coverage && results && results.length > 0 && <CoverageLine coverage={props.coverage} />}
      {busy && (
        <div style={{ color: '#94a3b8', fontSize: 13, marginTop: 6 }}>
          探测中…（模型正在针对这份 schema 提出对抗性数据场景，随后由数据库模拟逐个重跑验证）
        </div>
      )}
      {!busy && note && !results && (
        <div style={{ color: '#94a3b8', fontSize: 13, marginTop: 6 }}>{note}</div>
      )}
      {results && results.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          {results.map((r, i) => {
            const v = SCHEMA_PROBE_VERDICT_META[r.verdict];
            return (
              <div key={i} className="case-row">
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className={`chip ${v.cls}`}>{v.text}</span>
                  <b>{r.name}</b>
                  <span style={{ color: '#94a3b8', fontSize: 12.5 }}>{r.scenarioSummary}</span>
                </div>
                <div style={{ fontSize: 13, marginTop: 4, color: '#cbd5e1' }}>
                  预测：{r.prediction.willFail
                    ? `会先爆 · 「${r.prediction.firstBreakId}」${r.prediction.metric ? `（${r.prediction.metric}）` : ''}`
                    : '能扛住'}
                  {r.prediction.rationale && <span> — {r.prediction.rationale}</span>}
                </div>
                <div style={{ fontSize: 12.5, marginTop: 3, color: '#94a3b8' }}>
                  实测：{r.passed
                    ? '扛住了'
                    : `先爆 ${r.actualFirstBreak ?? '—'}`} ·
                  最慢模式{r.measured.worstPatternName ? `「${r.measured.worstPatternName}」` : ''} P99 {Math.round(r.measured.worstP99Ms)}ms ·
                  最高表利用率 {r.measured.maxTableUtil} ·
                  可持续约 {r.measured.maxSustainableQps.toLocaleString()} 次/s
                </div>
                {!r.passed && r.failures.length > 0 && (
                  <div style={{ fontSize: 12.5, marginTop: 3, color: '#fca5a5' }}>{r.failures.join('；')}</div>
                )}
                {r.prediction.fixHint && (
                  <div style={{ fontSize: 12.5, marginTop: 3, color: '#facc15' }}>💡 {r.prediction.fixHint}</div>
                )}
                {r.prediction.fixActions && r.prediction.fixActions.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    <button onClick={() => props.onApplyFix(r.name, r.prediction.fixActions!)}>
                      ✨ 应用此改进
                    </button>
                    {r.prediction.actionSource && (
                      <ActionSourceLabel source={r.prediction.actionSource} />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function SchemaAssessmentView({
  assessment,
  label,
  onApplySuggestion,
}: {
  assessment: SchemaAssessmentDTO;
  /** Source attribution （评审：云端 LLM · <model>), when available. */
  label?: string;
  /** Enter the fix preview for one suggestion's validated schema-ops. */
  onApplySuggestion?: (title: string, actions: SchemaOpDTO[]) => void;
}) {
  return (
    <div style={{ border: '1px solid #1e293b', borderRadius: 8, padding: '10px 12px', background: '#0b1220' }}>
      <b>🧑‍⚖️ 评审员结论</b>
      {label && (
        <span style={{ color: '#94a3b8', fontSize: 12, marginLeft: 8 }}>评审：{label}</span>
      )}
      <div style={{ fontSize: 13, lineHeight: 1.7, marginTop: 4 }}>
        <div>{assessment.conclusion}</div>
        {assessment.dimensionNotes.map((d) => (
          <div key={d.dimension} style={{ marginTop: 6 }}>
            <b>{d.dimension}</b>
            <div style={{ color: '#cbd5e1' }}>{d.note}</div>
          </div>
        ))}
        {assessment.suggestions.length > 0 && (
          <>
            <b style={{ display: 'block', marginTop: 8 }}>改进建议（按优先级）</b>
            <ul style={{ margin: '4px 0', paddingLeft: 18, color: '#cbd5e1' }}>
              {assessment.suggestions.map((s, i) => (
                <li key={i}>
                  {s.text}
                  {onApplySuggestion && s.actions && s.actions.length > 0 && (
                    <>
                      <button
                        style={{ marginLeft: 8 }}
                        onClick={() => onApplySuggestion(s.text, s.actions!)}
                        title="预览这条建议对右侧数据库设计草稿的改动，确认后才生效"
                      >
                        ✨ 应用到数据库设计
                      </button>
                      {s.actionSource && <ActionSourceLabel source={s.actionSource} />}
                    </>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

interface SchemaPanelProps {
  schema: ProblemSchemaDTO;
  snapshot: MetricsSnapshot | null;
  /**
   * Deterministic checker signals for the CURRENT draft, computed by the
   * backend (they ride along with every judge response) and refreshed as
   * the user designs. Design-time feedback only — the AI assessment is
   * NOT produced here anymore: it is part of the unified submit and lives
   * in the results page's 「数据库评审」 tab.
   */
  signals: SchemaSignalsDTO | null;
  /** Latest schema-simulation run for THIS problem's draft (App state). */
  sim: SchemaSimDTO | null;
  /** Previous run for a different draft of the same problem （对比竞速）. */
  prevSim?: SchemaSimDTO | null;
  simBusy: boolean;
  simError: string | null;
  /** The draft changed after the shown sim run — results are the last run's. */
  simStale: boolean;
  onRunSim: () => void;
  onChange: (schema: ProblemSchemaDTO) => void;
}

export function SchemaPanel({ schema, snapshot, signals, sim, prevSim, simBusy, simError, simStale, onRunSim, onChange }: SchemaPanelProps) {
  const updateTable = (idx: number, table: SchemaTableDTO) => {
    const next = structuredClone(schema);
    next.tables[idx] = table;
    onChange(next);
  };

  return (
    <div>
      <p style={{ color: '#94a3b8', fontSize: 13, marginTop: 0 }}>
        架构之外，数据库本身也要交卷：表结构、分片键、索引决定每条核心查询走什么路径。
        下方的覆盖 / 路径 / 延迟 / 规则信号由后端判卷实时计算，改表结构后自动刷新——
        延迟估算还会接入画布上 DB 此刻的真实利用率{ snapshot ? `（当前最热利用率 ${Math.round(snapshot.hottestUtil * 100)}%）` : ''}。
        数据库的 AI 评审不在这里单独触发：点右上角「提交设计」后，结论会出现在结果页的
        「数据库评审」页签里，和其他评审放在一起。
      </p>

      {schema.tables.map((table, ti) => (
        <div key={ti} className="schema-table-card">
          <div className="form-row" style={{ alignItems: 'end' }}>
            <label>
              表名
              <input
                value={table.name}
                onChange={(e) => updateTable(ti, { ...table, name: e.target.value })}
              />
            </label>
            <label>
              存储引擎
              <select
                value={table.engine}
                onChange={(e) => updateTable(ti, { ...table, engine: e.target.value as SchemaTableDTO['engine'] })}
              >
                <option value="relational">关系型</option>
                <option value="nosql">NoSQL</option>
              </select>
            </label>
            <label>
              数据量级
              <select
                value={table.rows}
                onChange={(e) => updateTable(ti, { ...table, rows: Number(e.target.value) })}
              >
                {ROW_PRESETS.map((r) => (
                  <option key={r} value={r}>{r.toLocaleString()} 行</option>
                ))}
              </select>
            </label>
            <label>
              主键生成
              <select
                value={table.primaryKeyGen}
                onChange={(e) => updateTable(ti, { ...table, primaryKeyGen: e.target.value as SchemaTableDTO['primaryKeyGen'] })}
              >
                <option value="auto">自增</option>
                <option value="snowflake">雪花</option>
                <option value="uuid">UUID</option>
                <option value="business">业务键</option>
              </select>
            </label>
            <label>
              主键
              <select
                value={table.primaryKey}
                onChange={(e) => updateTable(ti, { ...table, primaryKey: e.target.value })}
              >
                {table.fields.map((f) => (
                  <option key={f.name} value={f.name}>{f.name}</option>
                ))}
              </select>
            </label>
            <label>
              分片键
              <select
                value={table.shardKey ?? ''}
                onChange={(e) => updateTable(ti, { ...table, shardKey: e.target.value || null })}
              >
                <option value="">（不分片）</option>
                {table.fields.map((f) => (
                  <option key={f.name} value={f.name}>{f.name}</option>
                ))}
              </select>
            </label>
            <button
              onClick={() => {
                const next = structuredClone(schema);
                next.tables.splice(ti, 1);
                onChange(next);
              }}
            >
              删表
            </button>
          </div>

          <table className="mini-table">
            <thead>
              <tr><th>字段</th><th>类型</th><th>索引</th><th>大字段</th><th /></tr>
            </thead>
            <tbody>
              {table.fields.map((f, fi) => (
                <tr key={fi}>
                  <td>
                    <input
                      value={f.name}
                      onChange={(e) => {
                        const fields = table.fields.map((x, i) => (i === fi ? { ...x, name: e.target.value } : x));
                        updateTable(ti, { ...table, fields });
                      }}
                    />
                  </td>
                  <td>
                    <input
                      value={f.type}
                      style={{ width: 90 }}
                      onChange={(e) => {
                        const fields = table.fields.map((x, i) => (i === fi ? { ...x, type: e.target.value } : x));
                        updateTable(ti, { ...table, fields });
                      }}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={f.indexed}
                      onChange={(e) => {
                        const fields = table.fields.map((x, i) => (i === fi ? { ...x, indexed: e.target.checked } : x));
                        updateTable(ti, { ...table, fields });
                      }}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={!!f.blob}
                      onChange={(e) => {
                        const fields = table.fields.map((x, i) => (i === fi ? { ...x, blob: e.target.checked } : x));
                        updateTable(ti, { ...table, fields });
                      }}
                    />
                  </td>
                  <td>
                    <button
                      onClick={() => {
                        const fields = table.fields.filter((_, i) => i !== fi);
                        updateTable(ti, { ...table, fields });
                      }}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            onClick={() =>
              updateTable(ti, {
                ...table,
                fields: [...table.fields, { name: `field_${table.fields.length + 1}`, type: 'varchar', indexed: false }],
              })
            }
          >
            ＋ 加字段
          </button>
        </div>
      ))}

      <div style={{ display: 'flex', gap: 8, margin: '10px 0' }}>
        <button
          onClick={() => {
            const next = structuredClone(schema);
            next.tables.push({
              name: `table_${next.tables.length + 1}`,
              engine: 'relational',
              rows: 10_000_000,
              primaryKey: 'id',
              primaryKeyGen: 'snowflake',
              shardKey: null,
              fields: [{ name: 'id', type: 'bigint', indexed: true }],
            });
            onChange(next);
          }}
        >
          ＋ 加一张表
        </button>
      </div>

      {/* -------- 数据库模拟：按题目需求把访问模式真跑一遍 -------- */}
      <div style={{ margin: '14px 0 10px' }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button className="primary" onClick={onRunSim} disabled={simBusy}>
            {simBusy ? '模拟运行中…' : '▶ 运行数据库模拟'}
          </button>
          <span style={{ color: '#94a3b8', fontSize: 12.5 }}>
            后端按本题的访问模式与流量跑这份 schema：每条查询实际走的路径、扫描行数、
            P99、最热分片负载，并推演数据量 ×10 之后先崩哪。
          </span>
        </div>
        {simError && (
          <div style={{ color: '#fca5a5', fontSize: 13, marginTop: 8 }}>⚠️ {simError}</div>
        )}
        {simStale && sim && (
          <div style={{ color: '#facc15', fontSize: 12.5, marginTop: 8 }}>
            草稿已修改，下面是上次运行的结果——重新运行可刷新。
          </div>
        )}
        {sim && (
          <div style={{ marginTop: 10 }}>
            <SchemaSimView sim={sim} prevSim={prevSim} />
          </div>
        )}
      </div>

      {signals ? (
        <SchemaSignalsView signals={signals} />
      ) : (
        <p className="hint">
          规则信号由后端判卷计算——稍等片刻自动出现；连不上后端时这里为空，但表结构草稿照常保存。
        </p>
      )}
    </div>
  );
}
