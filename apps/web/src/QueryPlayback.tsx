import { useEffect, useMemo, useRef, useState } from 'react';
import type { SchemaSimPatternDTO } from './api';
import {
  planPlayback,
  planRealtime,
  rowsAtProgress,
  simElapsedAt,
  realtimeOfferable,
  type PlaybackPlan,
} from './playbackMath';

export interface PlaybackLane {
  id: string;
  /** Lane label — the pattern name, or 旧/新 schema in a 对比竞速. */
  label: string;
  pattern: SchemaSimPatternDTO;
}

/** Human latency: 805052ms → "805.1s", 25.2ms → "25ms". */
export function fmtLatency(ms: number): string {
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms >= 100) return `${Math.round(ms)}ms`;
  return `${Math.round(ms * 10) / 10}ms`;
}

function fmtCompression(c: number): string {
  if (c >= 100) return `×${Math.round(c)}`;
  if (c >= 10) return `×${c.toFixed(1)}`;
  return `×${c.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}`;
}

interface Props {
  title: string;
  lanes: PlaybackLane[];
  onClose: () => void;
}

/**
 * Console-style latency playback for one pattern (or a two-lane
 * 对比竞速 of the same pattern across two schema versions). Every
 * number on screen comes from the simulate response: the statement, the
 * EXPLAIN line, the rows examined, the P99. The wall-clock animation is
 * a PROJECTION of those numbers under ONE declared compression shared
 * by all lanes — labeled in the header — or, in 实时模式， a literal
 * 1:1 wait. Nothing here measures anything.
 */
export function QueryPlaybackPanel(props: Props) {
  const { lanes } = props;
  const items = useMemo(
    () => lanes.map((l) => ({ id: l.id, realMs: l.pattern.p99Ms })),
    [lanes],
  );
  const canRealtime = realtimeOfferable(items);
  const [mode, setMode] = useState<'compressed' | 'realtime'>('compressed');
  const plan: PlaybackPlan = useMemo(
    () => (mode === 'realtime' ? planRealtime(items) : planPlayback(items)),
    [mode, items],
  );
  const [runId, setRunId] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [stopped, setStopped] = useState(false);
  const rafRef = useRef<number>(0);

  const maxDuration = Math.max(0, ...Object.values(plan.durationsMs));
  const allDone = lanes.every((l) => elapsed >= (plan.durationsMs[l.id] ?? 0));

  useEffect(() => {
    setElapsed(0);
    setStopped(false);
    const t0 = performance.now();
    const tick = () => {
      const e = performance.now() - t0;
      setElapsed(e);
      if (e < maxDuration) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, runId]);

  const stop = () => {
    cancelAnimationFrame(rafRef.current);
    setStopped(true);
  };

  return (
    <div
      style={{
        marginTop: 10, border: '1px solid #334155', borderRadius: 8,
        background: '#020617', padding: '10px 12px', fontFamily: 'ui-monospace, Menlo, monospace',
      }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontFamily: 'inherit' }}>
        <b style={{ fontSize: 13 }}>▶ {props.title}</b>
        {mode === 'realtime' ? (
          <span className="chip chip-held">实时模式 · 1:1 真实等待</span>
        ) : (
          <span className="chip chip-neutral" title="回放时长 = 模拟 P99 ÷ 压缩倍数；同一组回放共用一个倍数，相对快慢真实">
            回放压缩 {fmtCompression(plan.compression)}（非真实耗时）
          </span>
        )}
        {canRealtime && (
          <button
            onClick={() => {
              setMode(mode === 'realtime' ? 'compressed' : 'realtime');
              setRunId((x) => x + 1);
            }}
            title="这组查询的 P99 都在 1 秒内，可以按真实时长等待一遍"
          >
            {mode === 'realtime' ? '切回压缩回放' : '⏱ 实时模式'}
          </button>
        )}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {!allDone && !stopped && <button onClick={stop}>⏹ 停止</button>}
          {(allDone || stopped) && (
            <button onClick={() => setRunId((x) => x + 1)}>↻ 重新播放</button>
          )}
          <button onClick={props.onClose}>关闭</button>
        </span>
      </div>
      {lanes.map((lane) => {
        const p = lane.pattern;
        const dur = plan.durationsMs[lane.id] ?? 0;
        const progress = dur > 0 ? Math.min(1, elapsed / dur) : 1;
        const done = progress >= 1;
        const scanned = rowsAtProgress(p.rowsExaminedPerQuery, progress);
        const simElapsed = simElapsedAt(p.p99Ms, progress);
        return (
          <div key={lane.id} style={{ marginTop: 10, borderTop: '1px dashed #1e293b', paddingTop: 8 }}>
            {lanes.length > 1 && (
              <div style={{ fontSize: 12.5, color: '#facc15', marginBottom: 4 }}>{lane.label}</div>
            )}
            <div style={{ whiteSpace: 'pre-wrap', fontSize: 12.5, color: '#e2e8f0' }}>
              <span style={{ color: '#38bdf8' }}>&gt; </span>{p.query.text}
            </div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>{p.query.explain}</div>
            <div style={{ fontSize: 12.5, marginTop: 6, color: done ? '#4ade80' : '#cbd5e1' }}>
              ▸ 已扫描 {scanned.toLocaleString()} / {p.rowsExaminedPerQuery.toLocaleString()} 行 · 模拟耗时 {fmtLatency(simElapsed)}
              {stopped && !done && <span style={{ color: '#fca5a5' }}> · 已停止</span>}
            </div>
            <div style={{ height: 6, background: '#1e293b', borderRadius: 3, marginTop: 4, overflow: 'hidden' }}>
              <div
                style={{
                  width: `${Math.round(progress * 100)}%`, height: '100%',
                  background: done ? '#22c55e' : '#38bdf8',
                  transition: 'width 60ms linear',
                }}
              />
            </div>
            {done && (
              <>
                <div style={{ fontSize: 12.5, marginTop: 6, color: '#4ade80' }}>
                  ✓ 返回 {p.query.resultRows.toLocaleString()} 行 · P99 {fmtLatency(p.p99Ms)}
                  {mode === 'compressed' && (
                    <span style={{ color: '#94a3b8' }}>
                      {' '}· 回放用时 {(dur / 1000).toFixed(1)}s（压缩 {fmtCompression(plan.compression)}）
                    </span>
                  )}
                </div>
                {p.query.sampleRows.length > 0 && (
                  <div style={{ fontSize: 12, marginTop: 4, color: '#94a3b8' }}>
                    <div>样例数据（示意，非真实记录）:</div>
                    {p.query.sampleRows.map((r, i) => (
                      <div key={i} style={{ whiteSpace: 'pre-wrap', color: '#a5b4fc' }}>
                        {'  '}{JSON.stringify(r)}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
