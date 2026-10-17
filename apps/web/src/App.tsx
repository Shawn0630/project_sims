import { useEffect, useMemo, useRef, useState } from 'react';
import { COMPONENTS, componentDef, type ComponentTypeId } from '@sds/components';
import {
  checkStructure,
  createSimulatorTools,
  runSuite,
  type SuiteResult,
} from '@sds/checker';
import {
  createDriver,
  type DriverContext,
  type DriverReview,
  type DriverSettings,
} from '@sds/driver';
import { ConsistentHashLab } from '@sds/lab-consistent-hashing';
import { PROBLEMS, problemById, type ProblemSchema, type TestCase } from '@sds/problems';
import {
  SimulationEngine,
  defaultSettings,
  newId,
  type Design,
  type MetricsSnapshot,
  type NodeSettings,
  type TrafficConfig,
} from '@sds/sim-core';
import { Canvas } from './Canvas';
import { DeepDive } from './DeepDive';
import { DriverPanel } from './DriverPanel';
import { ReportPanel } from './ReportPanel';
import { SchemaPanel } from './SchemaPanel';
import { IconGlyph } from './icons';

type Phase = 'design' | 'run' | 'report';

const SETTINGS_KEY = 'sds-driver-settings-v1';

function loadDriverSettings(): DriverSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return JSON.parse(raw) as DriverSettings;
  } catch {
    /* ignore */
  }
  return {
    kind: 'scripted',
    openai: {
      apiKey: import.meta.env.VITE_OPENAI_API_KEY ?? '',
      baseUrl: import.meta.env.VITE_OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      model: import.meta.env.VITE_OPENAI_MODEL ?? 'gpt-4o-mini',
    },
    ollama: {
      baseUrl: import.meta.env.VITE_OLLAMA_BASE_URL ?? 'http://localhost:11434',
      model: import.meta.env.VITE_OLLAMA_MODEL ?? 'qwen3:30b',
    },
  };
}

export default function App() {
  const [problemId, setProblemId] = useState('instagram');
  const problem = problemById(problemId);
  const [phase, setPhase] = useState<Phase>('design');
  const [design, setDesign] = useState<Design>(() => structuredClone(problem.sampleDesign));
  const [traffic, setTraffic] = useState<TrafficConfig>({
    rps: problem.scale.baselineRps,
    readRatio: problem.scale.readRatio,
  });
  const [snapshot, setSnapshot] = useState<MetricsSnapshot | null>(null);
  const [running, setRunning] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [connectMode, setConnectMode] = useState(false);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [highlights, setHighlights] = useState<Map<string, string>>(new Map());
  const [suite, setSuite] = useState<SuiteResult | null>(null);
  const [schemas, setSchemas] = useState<Record<string, ProblemSchema>>(() =>
    Object.fromEntries(PROBLEMS.map((p) => [p.id, structuredClone(p.schema)])),
  );
  const [driverSettings, setDriverSettings] = useState<DriverSettings>(loadDriverSettings);
  const [driverReview, setDriverReview] = useState<DriverReview | null>(null);
  const [driverBusy, setDriverBusy] = useState(false);
  const [driverError, setDriverError] = useState<string | null>(null);
  const [replayingId, setReplayingId] = useState<string | null>(null);
  const [queueHistory, setQueueHistory] = useState<number[]>([]);

  const engineRef = useRef<SimulationEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new SimulationEngine(structuredClone(problem.sampleDesign), {
      rps: problem.scale.baselineRps,
      readRatio: problem.scale.readRatio,
    });
  }
  const engine = engineRef.current;
  const designRef = useRef(design);
  designRef.current = design;
  const problemRef = useRef(problem);
  problemRef.current = problem;
  const schemasRef = useRef(schemas);
  schemasRef.current = schemas;
  const replayRef = useRef<{
    tc: TestCase;
    tick: number;
    events: NonNullable<TestCase['events']>;
    kills: NonNullable<TestCase['kills']>;
  } | null>(null);

  const structural = useMemo(() => checkStructure(problem, design), [problem, design]);
  const selectedNode = design.nodes.find((n) => n.id === selectedId) ?? null;
  const locked = phase !== 'design';

  // ------------------------------------------------------------ effects ---
  useEffect(() => {
    engine.setDesign(design);
  }, [design, engine]);

  useEffect(() => {
    engine.setTraffic(traffic);
  }, [traffic, engine]);

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(driverSettings));
    } catch {
      /* ignore */
    }
  }, [driverSettings]);

  useEffect(() => {
    if (!running) return;
    const iv = window.setInterval(() => {
      const replay = replayRef.current;
      if (replay) {
        replay.tick += 1;
        while (replay.events.length && replay.events[0]!.atTick <= replay.tick) {
          const ev = replay.events.shift()!;
          engine.injectEvent({
            type: ev.type,
            targetType: ev.targetType,
            magnitude: ev.magnitude,
            durationTicks: ev.durationTicks,
          });
        }
        while (replay.kills.length && replay.kills[0]!.atTick <= replay.tick) {
          engine.killByType(replay.kills.shift()!.componentType);
        }
        if (replay.tick >= replay.tc.durationTicks) {
          stopReplay();
          return;
        }
      }
      const snap = engine.step(1);
      setSnapshot(snap);
      setQueueHistory((h) => {
        const sel = designRef.current.nodes.find((n) => n.id === selectedId);
        const q =
          sel?.type === 'queue'
            ? snap.nodes[sel.id]?.queueDepth
            : sel?.type === 'worker'
              ? (() => {
                  const qn = designRef.current.edges
                    .filter((e) => e.to === sel.id)
                    .map((e) => designRef.current.nodes.find((n) => n.id === e.from))
                    .find((n) => n?.type === 'queue');
                  return qn ? snap.nodes[qn.id]?.queueDepth : undefined;
                })()
              : undefined;
        return q !== undefined ? [...h.slice(-39), q] : h;
      });
    }, 250);
    return () => window.clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, engine, selectedId]);

  // ------------------------------------------------------------- actions ---
  const switchProblem = (id: string) => {
    const p = problemById(id);
    setProblemId(id);
    setDesign(structuredClone(p.sampleDesign));
    setTraffic({ rps: p.scale.baselineRps, readRatio: p.scale.readRatio });
    setPhase('design');
    setRunning(false);
    setSnapshot(null);
    setSuite(null);
    setDriverReview(null);
    setHighlights(new Map());
    setSelectedId(null);
    setReplayingId(null);
    replayRef.current = null;
    engineRef.current = new SimulationEngine(structuredClone(p.sampleDesign), {
      rps: p.scale.baselineRps,
      readRatio: p.scale.readRatio,
    });
  };

  const addComponent = (type: ComponentTypeId) => {
    if (locked) return;
    const count = design.nodes.length;
    const node = {
      id: newId(type),
      type,
      x: 120 + (count % 5) * 170,
      y: 110 + Math.floor(count / 5) * 150,
      settings: defaultSettings(type),
    };
    setDesign({ ...design, nodes: [...design.nodes, node] });
    setSelectedId(node.id);
  };

  const deleteNode = (id: string) => {
    setDesign({
      nodes: design.nodes.filter((n) => n.id !== id),
      edges: design.edges.filter((e) => e.from !== id && e.to !== id),
    });
    if (selectedId === id) setSelectedId(null);
  };

  const onNodePress = (id: string) => {
    if (connectMode && !locked) {
      if (!connectFrom) {
        setConnectFrom(id);
      } else if (connectFrom !== id) {
        const exists = design.edges.some((e) => e.from === connectFrom && e.to === id);
        if (!exists) {
          setDesign({
            ...design,
            edges: [...design.edges, { id: newId('edge'), from: connectFrom, to: id }],
          });
        }
        setConnectFrom(null);
      }
      return;
    }
    setSelectedId(id);
  };

  const submitDesign = () => {
    setPhase('run');
    setRunning(true);
    engine.reviveAll();
    engine.clearEvents();
    engine.setTraffic(traffic);
    setSnapshot(engine.step(1));
  };

  const backToDesign = () => {
    setPhase('design');
    setRunning(false);
    setSnapshot(null);
    setSuite(null);
    setDriverReview(null);
    setHighlights(new Map());
    setReplayingId(null);
    replayRef.current = null;
    engine.reviveAll();
    engine.clearEvents();
  };

  const runSuiteNow = () => {
    const result = runSuite(problem, designRef.current);
    setSuite(result);
    setPhase('report');
  };

  const startReplay = (tc: TestCase) => {
    engine.reviveAll();
    engine.clearEvents();
    engine.setTraffic(tc.traffic);
    replayRef.current = {
      tc,
      tick: 0,
      events: [...(tc.events ?? [])].sort((a, b) => a.atTick - b.atTick),
      kills: [...(tc.kills ?? [])].sort((a, b) => a.atTick - b.atTick),
    };
    setReplayingId(tc.id);
    setRunning(true);
  };

  const stopReplay = () => {
    replayRef.current = null;
    setReplayingId(null);
    engine.reviveAll();
    engine.clearEvents();
    engine.setTraffic(traffic);
  };

  const injectLive = (type: 'viral_post' | 'cache_stampede' | 'hot_key' | 'rw_flip') => {
    const targetType =
      type === 'hot_key'
        ? design.nodes.find((n) => componentDef(n.type).behavior === 'storage')?.type
        : undefined;
    engine.injectEvent({ type, targetType, magnitude: 3, durationTicks: 24 });
    setSnapshot(engine.snapshot());
  };

  const killHottest = () => {
    if (!snapshot) return;
    let best: string | null = null;
    let bestUtil = -1;
    for (const n of design.nodes) {
      const u = snapshot.nodes[n.id]?.util ?? 0;
      if (u > bestUtil) {
        bestUtil = u;
        best = n.id;
      }
    }
    if (best) {
      engine.killNode(best);
      setSnapshot(engine.step(1));
    }
  };

  const runDriver = async () => {
    setDriverBusy(true);
    setDriverError(null);
    try {
      const tools = createSimulatorTools({
        engine,
        getProblem: () => problemRef.current,
        getDesign: () => designRef.current,
        getSchema: () => schemasRef.current[problemRef.current.id]!,
        onHighlight: (componentId, reason) =>
          setHighlights((prev) => new Map(prev).set(componentId, reason)),
      });
      const driver = createDriver(driverSettings);
      const designSummary =
        '组件：\n' +
        designRef.current.nodes
          .map(
            (n) =>
              `- ${componentDef(n.type).name}(${n.type}) id=${n.id} replicas=${n.settings.replicas}` +
              (n.type === 'relationaldb' || n.type === 'nosql'
                ? ` 分片=${n.settings.sharded ? n.settings.shardKey : '否'} 读副本=${n.settings.readReplicas ?? 0} 一致性=${n.settings.consistency}`
                : '') +
              (n.type === 'gateway' ? ` 限流=${n.settings.rateLimitPerSec ?? 0}` : '') +
              (n.type === 'cache' ? ` 互斥重建=${n.settings.mutexRebuild ? '开' : '关'}` : ''),
          )
          .join('\n') +
        '\n连线：' +
        designRef.current.edges.map((e) => `${e.from} → ${e.to}`).join('；');
      const ctx: DriverContext = {
        problemName: problemRef.current.name,
        problemStatement: problemRef.current.statement,
        scaleNotes: `${problemRef.current.scale.dau} · ${problemRef.current.scale.notes} · 基线 ${problemRef.current.scale.baselineRps} req/s`,
        designSummary,
        structuralFindings: checkStructure(problemRef.current, designRef.current),
        availableCases: problemRef.current.testCases.map((c) => ({
          id: c.id,
          name: c.name,
          hidden: c.hidden,
        })),
      };
      const review = await driver.review(tools, ctx);
      setDriverReview(review);
      setSnapshot(engine.snapshot());
    } catch (err) {
      setDriverError(err instanceof Error ? err.message : String(err));
    } finally {
      setDriverBusy(false);
    }
  };

  // -------------------------------------------------------------- render ---
  const categories = ['流量入口', '计算', '存储', '异步'] as const;

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <div className="logo">🏛️ 系统设计模拟器</div>
          <div className="subtitle">System Design Simulator · 系统设计版 LeetCode</div>
        </div>
        <label>
          题目
          <select value={problemId} onChange={(e) => switchProblem(e.target.value)}>
            {PROBLEMS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}（{p.difficulty}）
              </option>
            ))}
          </select>
        </label>
        <div className="phase-steps">
          <span className={phase === 'design' ? 'active' : ''}>1 设计</span> →
          <span className={phase === 'run' ? 'active' : ''}>2 提交验证</span> →
          <span className={phase === 'report' ? 'active' : ''}>3 判卷报告</span>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {phase === 'design' && (
            <button className="primary big" onClick={submitDesign}>
              📤 提交设计
            </button>
          )}
          {phase !== 'design' && (
            <>
              <button onClick={() => setRunning(!running)}>{running ? '⏸ 暂停模拟' : '▶ 继续模拟'}</button>
              <button className="primary big" onClick={runSuiteNow}>
                ⚖️ 运行全部用例
              </button>
              <button onClick={backToDesign}>↩ 返回设计</button>
            </>
          )}
        </div>
      </header>

      <div className="main-grid">
        {/* component library */}
        <aside className="panel palette">
          <h3>组件库</h3>
          {categories.map((cat) => (
            <div key={cat}>
              <div className="cat-title">{cat}</div>
              {COMPONENTS.filter((c) => c.category === cat).map((c) => (
                <button
                  key={c.type}
                  className="palette-item"
                  onClick={() => addComponent(c.type)}
                  disabled={locked}
                  title={c.blurb}
                >
                  <svg width="26" height="26" viewBox="0 0 48 48" style={{ color: c.color }}>
                    <IconGlyph icon={c.icon} size={44} />
                  </svg>
                  <span>{c.name}</span>
                </button>
              ))}
            </div>
          ))}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
            <button
              className={connectMode ? 'primary' : ''}
              onClick={() => {
                setConnectMode(!connectMode);
                setConnectFrom(null);
              }}
              disabled={locked}
            >
              {connectMode ? '连线中：点起点再点终点' : '🔗 连线模式'}
            </button>
            <button
              onClick={() => setDesign(structuredClone(problem.sampleDesign))}
              disabled={locked}
            >
              载入示例设计
            </button>
            <button onClick={() => setDesign({ nodes: [], edges: [] })} disabled={locked}>
              清空画布
            </button>
          </div>
          <p className="hint">
            {phase === 'design'
              ? '先像面试一样把设计画完，再提交。提交前流量、场景、判卷都是关的。'
              : '设计已锁定（快照）。可以在验证阶段加压、注入事件、杀节点观察现象。'}
          </p>
        </aside>

        {/* canvas + controls */}
        <section className="canvas-wrap">
          <Canvas
            design={design}
            snapshot={snapshot}
            selectedId={selectedId}
            highlighted={highlights}
            running={running && phase !== 'design'}
            connectMode={connectMode}
            connectFrom={connectFrom}
            onNodePress={onNodePress}
            onMove={(id, x, y) => {
              if (locked) return;
              setDesign({
                ...design,
                nodes: design.nodes.map((n) => (n.id === id ? { ...n, x, y } : n)),
              });
            }}
            onBackgroundPress={() => {
              setSelectedId(null);
              setConnectFrom(null);
            }}
          />

          <div className="metrics-bar">
            {[
              ['入站流量', snapshot ? `${Math.round(snapshot.totalInQps)} req/s` : '—'],
              ['P99', snapshot ? `${Math.round(snapshot.p99Ms)} ms` : '—'],
              ['错误率', snapshot ? `${(snapshot.errorRate * 100).toFixed(1)}%` : '—'],
              ['缓存命中', snapshot ? `${Math.round(snapshot.cacheHitRate * 100)}%` : '—'],
              ['读旧数据', snapshot ? `${(snapshot.staleReadRate * 100).toFixed(1)}%` : '—'],
              ['成本', snapshot ? `$${snapshot.costPerHour.toFixed(0)}/h` : '—'],
            ].map(([k, v]) => (
              <div key={k} className="metric">
                <span>{k}</span>
                <b>{v}</b>
              </div>
            ))}
            {snapshot && snapshot.activeEvents.length > 0 && (
              <div className="metric event-metric">
                <span>进行中事件</span>
                <b>{snapshot.activeEvents.map((e) => e.type).join(' · ')}</b>
              </div>
            )}
            {replayingId && (
              <div className="metric event-metric">
                <span>回放中</span>
                <b>{problem.testCases.find((c) => c.id === replayingId)?.name}</b>
              </div>
            )}
          </div>

          <div className="controls panel">
            <div className="control-group">
              <label>
                流量 {traffic.rps} req/s
                <input
                  type="range"
                  min={100}
                  max={6000}
                  step={100}
                  value={traffic.rps}
                  onChange={(e) => setTraffic({ ...traffic, rps: Number(e.target.value) })}
                />
              </label>
              <label>
                读占比 {Math.round(traffic.readRatio * 100)}%
                <input
                  type="range"
                  min={50}
                  max={99}
                  value={Math.round(traffic.readRatio * 100)}
                  onChange={(e) => setTraffic({ ...traffic, readRatio: Number(e.target.value) / 100 })}
                />
              </label>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  onClick={() =>
                    setTraffic({ rps: problem.scale.baselineRps, readRatio: problem.scale.readRatio })
                  }
                >
                  基线
                </button>
                <button
                  onClick={() =>
                    setTraffic({
                      rps: problem.scale.baselineRps * problem.scale.peakMultiplier,
                      readRatio: problem.scale.readRatio,
                    })
                  }
                >
                  晚高峰 ×{problem.scale.peakMultiplier}
                </button>
              </div>
            </div>
            <div className="control-group">
              <span className="control-label">砸场景（验证阶段）：</span>
              <button onClick={() => injectLive('viral_post')} disabled={phase === 'design'}>🔥 网红爆帖</button>
              <button onClick={() => injectLive('cache_stampede')} disabled={phase === 'design'}>❄️ 缓存雪崩</button>
              <button onClick={() => injectLive('hot_key')} disabled={phase === 'design'}>🎯 热点 key</button>
              <button onClick={() => injectLive('rw_flip')} disabled={phase === 'design'}>🔀 读写翻转</button>
              <button onClick={killHottest} disabled={phase === 'design'}>💥 杀最热节点</button>
              <button
                onClick={() => {
                  engine.reviveAll();
                  engine.clearEvents();
                  setSnapshot(engine.step(1));
                }}
                disabled={phase === 'design'}
              >
                ♻️ 全部恢复
              </button>
            </div>
          </div>
        </section>

        {/* right column: problem info / deep dive */}
        <aside className="panel side">
          {selectedNode ? (
            <DeepDive
              node={selectedNode}
              design={design}
              problem={problem}
              snapshot={snapshot}
              queueHistory={queueHistory}
              locked={locked}
              killed={engine.isKilled(selectedNode.id)}
              onUpdateSettings={(id, settings: NodeSettings) =>
                setDesign({
                  ...design,
                  nodes: design.nodes.map((n) => (n.id === id ? { ...n, settings } : n)),
                })
              }
              onDelete={deleteNode}
              onKill={(id) => {
                engine.killNode(id);
                setSnapshot(engine.step(1));
              }}
              onRevive={(id) => {
                engine.reviveNode(id);
                setSnapshot(engine.step(1));
              }}
            />
          ) : (
            <div>
              <h3 style={{ marginTop: 0 }}>{problem.name}</h3>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <span className="chip">{problem.difficulty}</span>
                {problem.tags.map((t) => (
                  <span key={t} className="chip">{t}</span>
                ))}
              </div>
              <p style={{ fontSize: 13.5, lineHeight: 1.7 }}>{problem.statement}</p>
              <b style={{ fontSize: 13 }}>功能需求</b>
              <ul style={{ fontSize: 13, paddingLeft: 18, margin: '4px 0 10px' }}>
                {problem.functionalRequirements.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              <b style={{ fontSize: 13 }}>量级</b>
              <div style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.7 }}>
                {problem.scale.dau} · 基线 {problem.scale.baselineRps} req/s · 峰值 ×
                {problem.scale.peakMultiplier} · 成本预算 ${problem.scale.budgetCostPerHour}/h
                <br />
                {problem.scale.notes}
              </div>
              <p className="hint">点画布上任意组件，进入「面试官细究」：它的实时背景、模块实验室和追问链都在里面。</p>
            </div>
          )}
        </aside>
      </div>

      <section className="panel section">
        <h2>⚖️ 判卷：测试用例与结构报告</h2>
        <ReportPanel
          problem={problem}
          phase={phase}
          suite={suite}
          structural={structural}
          replayingId={replayingId}
          onRunSuite={runSuiteNow}
          onReplay={startReplay}
          onStopReplay={stopReplay}
          onSelectNode={(id) => setSelectedId(id)}
        />
      </section>

      <section className="panel section">
        <h2>🗄️ 数据库设计 · Schema 评审</h2>
        <SchemaPanel
          schema={schemas[problem.id]!}
          snapshot={snapshot}
          onChange={(s) => setSchemas({ ...schemas, [problem.id]: s })}
        />
      </section>

      <section className="panel section">
        <h2>🤖 驾驶员（LLM 操作模拟器）</h2>
        <DriverPanel
          settings={driverSettings}
          onSettings={setDriverSettings}
          busy={driverBusy}
          review={driverReview}
          error={driverError}
          canRun={phase !== 'design'}
          onRun={runDriver}
        />
      </section>

      <section className="panel section">
        <h2>🧪 机制实验室 · 一致性哈希</h2>
        <p style={{ color: '#94a3b8', fontSize: 13, marginTop: 0 }}>
          独立教学模式。在分片 DB / NoSQL 的细究面板里，这张环会接上那个组件的实时背景。
        </p>
        <ConsistentHashLab />
      </section>

      <footer className="footer">
        System Design Simulator — 离线可运行；LLM 驾驶员为可插拔适配层（云端 API 优先 · Ollama fallback · 脚本离线）。
      </footer>
    </div>
  );
}
