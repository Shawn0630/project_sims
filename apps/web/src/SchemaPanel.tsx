import { useState } from 'react';
import { reviewSchema, type SchemaReviewReport } from '@sds/checker';
import type { ProblemSchema, SchemaTable } from '@sds/problems';
import type { MetricsSnapshot } from '@sds/sim-core';

const ROW_PRESETS = [100_000, 10_000_000, 1_000_000_000, 50_000_000_000];

interface SchemaPanelProps {
  schema: ProblemSchema;
  snapshot: MetricsSnapshot | null;
  onChange: (schema: ProblemSchema) => void;
}

export function SchemaPanel({ schema, snapshot, onChange }: SchemaPanelProps) {
  const [report, setReport] = useState<SchemaReviewReport | null>(null);

  const updateTable = (idx: number, table: SchemaTable) => {
    const next = structuredClone(schema);
    next.tables[idx] = table;
    onChange(next);
    setReport(null);
  };

  const runReview = () => {
    const loadFactor = snapshot ? Math.min(1.5, snapshot.hottestUtil) : 0;
    setReport(reviewSchema(schema, { loadFactor }));
  };

  return (
    <div>
      <p style={{ color: '#94a3b8', fontSize: 13, marginTop: 0 }}>
        架构之外，数据库本身也要交卷：表结构、分片键、索引决定每条核心查询走什么路径。
        点「让评审员检查」会按 <b>需求覆盖 / 延迟风险 / 扩展性</b> 三个维度出报告——延迟估算还会接入画布上
        DB 此刻的真实利用率{ snapshot ? `（当前最热利用率 ${Math.round(snapshot.hottestUtil * 100)}%）` : ''}。
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
                onChange={(e) => updateTable(ti, { ...table, engine: e.target.value as SchemaTable['engine'] })}
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
                onChange={(e) => updateTable(ti, { ...table, primaryKeyGen: e.target.value as SchemaTable['primaryKeyGen'] })}
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
                setReport(null);
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
            setReport(null);
          }}
        >
          ＋ 加一张表
        </button>
        <button className="primary" onClick={runReview}>
          🔍 让评审员检查这份设计
        </button>
      </div>

      {report && (
        <div className="review-box">
          <div style={{ display: 'flex', gap: 18, alignItems: 'baseline' }}>
            <span style={{ fontSize: 30, fontWeight: 800, color: report.score >= 80 ? '#4ade80' : report.score >= 55 ? '#facc15' : '#f87171' }}>
              {report.score} 分
            </span>
            <span>{report.coverage}</span>
          </div>
          <table className="mini-table">
            <thead>
              <tr><th>访问模式</th><th>路径</th><th>延迟估算</th><th>判定</th><th>说明</th></tr>
            </thead>
            <tbody>
              {report.perPattern.map((p) => (
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
            const items = report.findings.filter((f) => f.dimension === dim);
            if (!items.length) return null;
            return (
              <div key={dim} style={{ marginTop: 8 }}>
                <b>{dim}</b>
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
      )}
    </div>
  );
}
