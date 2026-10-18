import type { MetricsSnapshot } from '@sds/sim-core';
import type {
  ProblemSchemaDTO,
  SchemaAssessmentDTO,
  SchemaOpDTO,
  SchemaSignalsDTO,
  SchemaTableDTO,
} from './api';
import { ActionSourceLabel } from './ReportPanel';

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
  onChange: (schema: ProblemSchemaDTO) => void;
}

export function SchemaPanel({ schema, snapshot, signals, onChange }: SchemaPanelProps) {
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
