import { useEffect, useMemo, useRef, useState } from 'react';
import { COMPONENTS, componentDef, type ComponentTypeId } from '@sds/components';
import {
  checkStructure,
  createSimulatorTools,
  runSuite,
  type SchemaReviewReport,
  type SuiteResult,
} from '@sds/checker';
import {
  ScriptedDriver,
  createDriver,
  type Driver,
  type DriverContext,
  type DriverReview,
  type DriverSettings,
  type FollowUpContext,
  type FollowUpQuestion,
  type SchemaReviewLike,
  type SubmissionAssessment,
} from '@sds/driver';
import { PROBLEMS, problemById, type ProblemDef, type ProblemSchema, type TestCase } from '@sds/problems';
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
import { CaseList, StructuralList, scoreColor } from './ReportPanel';
import { SchemaPanel } from './SchemaPanel';
import { IconGlyph } from './icons';

type Phase = 'design' | 'run' | 'report';
type LeftTab = 'desc' | 'schema' | 'cases' | 'subs' | 'driver';

interface SubmissionRecord {
  problemId: string;
  at: number;
  scorePct: number;
  passed: number;
  total: number;
}

const SETTINGS_KEY = 'sds-driver-settings-v1';
const SUBMISSIONS_KEY = 'sds-submissions-v1';

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

function loadSubmissions(): SubmissionRecord[] {
  try {
    const raw = localStorage.getItem(SUBMISSIONS_KEY);
    if (raw) return JSON.parse(raw) as SubmissionRecord[];
  } catch {
    /* ignore */
  }
  return [];
}

const DIFF_STYLE: Record<string, React.CSSProperties> = {
  简单: { background: '#14532d', color: '#bbf7d0', borderColor: '#166534' },
  中等: { background: '#713f12', color: '#fde68a', borderColor: '#a16207' },
  困难: { background: '#7f1d1d', color: '#fecaca', borderColor: '#991b1b' },
};

const LEFT_TABS: { id: LeftTab; label: string }[] = [
  { id: 'desc', label: '题目描述' },
  { id: 'schema', label: '数据库设计' },
  { id: 'cases', label: '测试用例' },
  { id: 'subs', label: '提交记录' },
  { id: 'driver', label: '驾驶员' },
];

// ------------------------------------------- shared summary builders -----
// One design snapshot, three consumers: the operator review, the follow-up
// generator and the submission assessor all read the same rendering of the
// user's design so every Driver sees identical facts.

function nodeSettingsLine(n: Design['nodes'][number]): string {
  return (
    `${componentDef(n.type).name}(${n.type}) id=${n.id} replicas=${n.settings.replicas}` +
    (n.type === 'relationaldb' || n.type === 'nosql'
      ? ` 分片=${n.settings.sharded ? n.settings.shardKey : '否'} 读副本=${n.settings.readReplicas ?? 0} 一致性=${n.settings.consistency}`
      : '') +
    (n.type === 'gateway' ? ` 限流=${n.settings.rateLimitPerSec ?? 0}` : '') +
    (n.type === 'cache' ? ` 互斥重建=${n.settings.mutexRebuild ? '开' : '关'}` : '')
  );
}

function buildDesignSummary(design: Design): string {
  return (
    '组件：\n' +
    design.nodes.map((n) => `- ${nodeSettingsLine(n)}`).join('\n') +
    '\n连线：' +
    design.edges.map((e) => `${e.from} → ${e.to}`).join('；')
  );
}

function schemaSummaryOf(schema: ProblemSchema): string {
  return schema.tables
    .map(
      (t) =>
        `表 ${t.name}（${t.engine === 'relational' ? '关系型' : 'NoSQL'}，${t.rows.toLocaleString()} 行）：` +
        `主键 ${t.primaryKey}（生成=${t.primaryKeyGen}），分片键 ${t.shardKey ?? '无'}，字段：` +
        t.fields
          .map((f) => `${f.name}:${f.type}${f.indexed ? '（索引）' : ''}${f.blob ? '（大字段）' : ''}`)
          .join('、'),
    )
    .join('\n');
}

function workloadSummaryOf(problem: ProblemDef): string {
  const w = problem.workload;
  return (
    `读:写 = ${Math.round(w.readRatio * 100)}:${Math.round((1 - w.readRatio) * 100)}；一致性要求：${w.consistency}；` +
    `访问模式：${w.patterns
      .map((p) => `${p.name}（${p.kind === 'read' ? '读' : '写'}，占 ${Math.round(p.share * 100)}%）`)
      .join('、')}`
  );
}

/** Checker signals → the contract shape the Driver assessment consumes. */
function toSchemaSignals(report: SchemaReviewReport): SchemaReviewLike {
  return {
    score: report.score,
    coverage: report.coverage,
    coveragePassed: report.coveragePassed,
    coverageTotal: report.coverageTotal,
    findings: report.findings,
    perPattern: report.perPattern.map((p) => ({
      pattern: p.name,
      path: p.path,
      latencyMs: p.latencyMs,
      verdict: p.verdict,
      note: p.note,
    })),
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
  const [activeTab, setActiveTab] = useState<LeftTab>('desc');
  const [bottomOpen, setBottomOpen] = useState(true);
  const [submissions, setSubmissions] = useState<SubmissionRecord[]>(loadSubmissions);

  // --------------------------------------- qualitative assessment layer ---
  // Hard verdicts come from @sds/checker (code). EVERYTHING qualitative —
  // submission review, deep-dive follow-ups, schema conclusions — comes
  // from the Driver layer via withAssessor: the configured driver (cloud
  // LLM first per the user's choice) or ScriptedDriver as offline fallback.
  const scriptedDriver = useMemo(() => new ScriptedDriver(), []);
  const activeDriver = useMemo<Driver>(() => {
    try {
      return createDriver(driverSettings);
    } catch {
      return scriptedDriver;
    }
  }, [driverSettings, scriptedDriver]);
  const [assessorLabel, setAssessorLabel] = useState('');
  const [followUps, setFollowUps] = useState<FollowUpQuestion[] | null>(null);
  const [assessment, setAssessment] = useState<SubmissionAssessment | null>(null);
  const [assessmentBusy, setAssessmentBusy] = useState(false);
  const [submitStamp, setSubmitStamp] = useState(0);

  const withAssessor = async <T,>(call: (d: Driver) => Promise<T>): Promise<T> => {
    if (activeDriver.kind !== 'scripted') {
      try {
        const v = await call(activeDriver);
        setAssessorLabel(activeDriver.label);
        return v;
      } catch {
        /* LLM unavailable or bad output — fall through to the offline driver */
      }
    }
    const v = await call(scriptedDriver);
    setAssessorLabel('脚本评审员（离线 fallback）');
    return v;
  };

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
  const mySubmissions = submissions.filter((s) => s.problemId === problemId);

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
    try {
      localStorage.setItem(SUBMISSIONS_KEY, JSON.stringify(submissions));
    } catch {
      /* ignore */
    }
  }, [submissions]);

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
    setAssessment(null);
    setFollowUps(null);
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

  const problemIndex = PROBLEMS.findIndex((p) => p.id === problemId);
  const stepProblem = (delta: number) => {
    const next = PROBLEMS[(problemIndex + delta + PROBLEMS.length) % PROBLEMS.length]!;
    switchProblem(next.id);
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
    setAssessment(null);
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
    setSubmitStamp((s) => s + 1);
    setAssessment(null);
    setPhase('report');
    // The scripted assessor is instant and offline — run its qualitative
    // review automatically. An LLM assessor stays behind the button in the
    // results panel so API calls are never a surprise.
    if (activeDriver.kind === 'scripted') {
      void runAssessment(result);
    }
    setSubmissions((prev) =>
      [
        {
          problemId: problem.id,
          at: Date.now(),
          scorePct: result.scorePct,
          passed: result.passedCount,
          total: result.totalCount,
        },
        ...prev,
      ].slice(0, 50),
    );
  };

  /** Qualitative review of a judged submission, via the Driver layer. */
  const runAssessment = async (s: SuiteResult) => {
    setAssessmentBusy(true);
    try {
      const ctx = {
        problemName: problemRef.current.name,
        designSummary: buildDesignSummary(designRef.current),
        workloadSummary: workloadSummaryOf(problemRef.current),
        scorePct: s.scorePct,
        passed: s.passedCount,
        total: s.totalCount,
        cases: s.results,
        structuralFindings: checkStructure(problemRef.current, designRef.current),
      };
      setAssessment(await withAssessor((d) => d.assessSubmission(ctx)));
    } catch {
      setAssessment(null);
    } finally {
      setAssessmentBusy(false);
    }
  };

  /** LeetCode's green Submit: lock the design, judge everything, show results. */
  const onSubmit = () => {
    if (phase === 'design') submitDesign();
    runSuiteNow();
    setBottomOpen(true);
  };

  /** LeetCode's Run: start the live simulation (or pause/resume it). */
  const onRun = () => {
    if (phase === 'design') {
      submitDesign();
    } else {
      setRunning(!running);
    }
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
      const driver = activeDriver;
      const designSummary = buildDesignSummary(designRef.current);
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

  // ------------------------------------- deep-dive follow-up generation ---
  // When a component is opened (or a new submission lands), ask the Driver
  // for follow-ups generated from THIS design snapshot: the graph, this
  // component's settings, this problem's workload landing on it, the schema
  // choices and the judging signals. Regenerates per (problem, node,
  // submission, graph shape) — not on every settings keystroke.
  const followKey = selectedNode
    ? `${problem.id}|${selectedNode.id}|${submitStamp}|${design.nodes.length}|${design.edges.length}`
    : '';
  const followKeyRef = useRef('');
  useEffect(() => {
    if (!selectedNode || !followKey) {
      followKeyRef.current = '';
      setFollowUps(null);
      return;
    }
    if (followKeyRef.current === followKey) return;
    followKeyRef.current = followKey;
    setFollowUps(null);
    const node = selectedNode;
    const d = designRef.current;
    const p = problemRef.current;
    const wPatterns = p.workload.patterns.filter((x) => x.path.includes(node.type));
    const rSum = wPatterns.filter((x) => x.kind === 'read').reduce((s, x) => s + x.share, 0);
    const wSum = wPatterns.filter((x) => x.kind === 'write').reduce((s, x) => s + x.share, 0);
    const m = snapshot?.nodes[node.id];
    const ctx: FollowUpContext = {
      problemName: p.name,
      componentType: node.type,
      componentName: componentDef(node.type).name,
      componentSettingsSummary: nodeSettingsLine(node),
      liveMetricsSummary: m
        ? `入站 ${Math.round(m.inQps)} req/s · 利用率 ${Math.round(m.util * 100)}% · 本节点延迟 ${Math.round(m.latencyMs)} ms · 错误率 ${(m.errorRate * 100).toFixed(1)}%`
        : undefined,
      upstreamTypes: d.edges
        .filter((e) => e.to === node.id)
        .map((e) => d.nodes.find((n) => n.id === e.from)?.type)
        .filter((t): t is ComponentTypeId => !!t),
      designSummary: buildDesignSummary(d),
      workload: {
        readRatio: p.workload.readRatio,
        consistency: p.workload.consistency,
        patternsHere: wPatterns.map((x) => ({
          name: x.name,
          kind: x.kind,
          share: x.share,
          description: x.description,
          consistency: x.consistency,
        })),
        readShareHere: rSum + wSum > 0 ? rSum / (rSum + wSum) : p.workload.readRatio,
      },
      schemaSummary:
        node.type === 'relationaldb' || node.type === 'nosql'
          ? schemaSummaryOf(schemasRef.current[p.id]!)
          : undefined,
      failedCases: (suite?.results ?? [])
        .filter((r) => !r.passed)
        .map((r) => ({ id: r.caseId, name: r.name, failures: r.failures })),
      structuralFindings: structural.filter((f) => f.componentIds.includes(node.id)),
    };
    let cancelled = false;
    withAssessor((drv) => drv.generateFollowUps(ctx))
      .then((qs) => {
        if (!cancelled) setFollowUps(qs);
      })
      .catch(() => {
        if (!cancelled) setFollowUps([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followKey]);

  // -------------------------------------------------------------- render ---
  const categories = ['流量入口', '计算', '存储', '异步'] as const;
  const stepIndex = phase === 'design' ? 0 : phase === 'run' ? 1 : 2;
  const nextHint =
    phase === 'design'
      ? '下一步：在画布上完成设计（数据库设计在左侧「数据库设计」页），然后点「提交设计」判卷——或先点「▶ 运行」看它跑起来。'
      : phase === 'run'
        ? '下一步：设计已锁定、模拟运行中。可以注入场景、杀节点观察现象，或点「提交设计」跑全部用例判卷。'
        : '下一步：在下方结果面板看每个用例的判定，点失败用例看缺陷说明并回放；改设计就「返回设计」后重新提交。';

  return (
    <div className="app lc-app">
      {/* ------------------------------------------------ slim top bar --- */}
      <header className="lc-topbar">
        <div className="lc-title-group">
          <span className="lc-logo" title="System Design Simulator">🏛️</span>
          <button className="lc-nav-btn" onClick={() => stepProblem(-1)} title="上一题">
            ‹
          </button>
          <button className="lc-nav-btn" onClick={() => stepProblem(1)} title="下一题">
            ›
          </button>
          <h1 className="lc-problem-title">{problem.name}</h1>
          <span className="chip" style={DIFF_STYLE[problem.difficulty]}>
            {problem.difficulty}
          </span>
          {problem.tags.map((t) => (
            <span key={t} className="chip lc-tag">
              {t}
            </span>
          ))}
          <select
            className="lc-problem-select"
            value={problemId}
            onChange={(e) => switchProblem(e.target.value)}
            title="切换题目"
          >
            {PROBLEMS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}（{p.difficulty}）
              </option>
            ))}
          </select>
        </div>
        <div className="lc-actions">
          {phase !== 'design' && (
            <button onClick={backToDesign} title="回到设计阶段（解锁画布）">
              ↩ 返回设计
            </button>
          )}
          <button className="lc-run-btn" onClick={onRun}>
            {phase !== 'design' && running ? '⏸ 暂停' : '▶ 运行'}
          </button>
          <button className="lc-submit-btn" onClick={onSubmit}>
            提交设计
          </button>
        </div>
      </header>

      {/* --------------------------------------------- 3-step progress --- */}
      <div className="lc-steps">
        {['设计', '提交', '看结果'].map((label, i) => (
          <span key={label} className={`lc-step ${i === stepIndex ? 'active' : i < stepIndex ? 'done' : ''}`}>
            {i + 1} {label}
            {i < 2 && <span className="lc-step-arrow">→</span>}
          </span>
        ))}
        <span className="lc-next-hint">{nextHint}</span>
      </div>

      <div className="lc-body">
        {/* ------------------------------------------------ left panel --- */}
        <aside className="lc-left">
          <div className="lc-tabs">
            {LEFT_TABS.map((t) => (
              <button
                key={t.id}
                className={`lc-tab ${activeTab === t.id ? 'active' : ''}`}
                onClick={() => setActiveTab(t.id)}
              >
                {t.label}
                {t.id === 'cases' && suite && (
                  <span className="lc-tab-badge">
                    {suite.passedCount}/{suite.totalCount}
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="lc-tab-body">
            {activeTab === 'desc' && (
              <div>
                <p style={{ fontSize: 13.5, lineHeight: 1.75, marginTop: 2 }}>{problem.statement}</p>
                <b style={{ fontSize: 13 }}>功能需求</b>
                <ul style={{ fontSize: 13, paddingLeft: 18, margin: '4px 0 12px', lineHeight: 1.7 }}>
                  {problem.functionalRequirements.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
                <b style={{ fontSize: 13 }}>量级估算</b>
                <div style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.75, marginTop: 4 }}>
                  {problem.scale.dau} · 基线 {problem.scale.baselineRps} req/s · 峰值 ×
                  {problem.scale.peakMultiplier} · 读占比 {Math.round(problem.scale.readRatio * 100)}% ·
                  成本预算 ${problem.scale.budgetCostPerHour}/h
                  <br />
                  {problem.scale.notes}
                </div>
                <b style={{ fontSize: 13, display: 'block', marginTop: 12 }}>核心链路</b>
                <div style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.75, marginTop: 4 }}>
                  {problem.testCases
                    .filter((c) => !c.hidden)
                    .slice(0, 3)
                    .map((c) => c.name)
                    .join(' · ')}
                  ——完整场景清单在「测试用例」页；隐藏 edge cases 提交后才揭示。
                </div>
                <p className="hint" style={{ marginTop: 14 }}>
                  玩法和面试一样：先在右侧画布把设计画完（点任意组件可进入「面试官细究」），
                  数据库表结构在「数据库设计」页交卷，最后点右上角「提交设计」判卷。
                </p>
              </div>
            )}

            {activeTab === 'schema' && (
              <SchemaPanel
                schema={schemas[problem.id]!}
                snapshot={snapshot}
                onChange={(s) => setSchemas({ ...schemas, [problem.id]: s })}
                assessorNote={assessorLabel ? `结论由 ${assessorLabel} 给出` : undefined}
                onAssess={async (sch, signals) =>
                  withAssessor((d) =>
                    d.assessSchema({
                      problemName: problem.name,
                      schemaSummary: schemaSummaryOf(sch),
                      signals: toSchemaSignals(signals),
                    }),
                  )
                }
              />
            )}

            {activeTab === 'cases' && (
              <div>
                <p className="hint" style={{ marginTop: 0 }}>
                  可见用例先亮出来（像 LeetCode 的样例），隐藏 edge cases 提交后才揭示。
                  {suite
                    ? ' 已判卷：结果同步显示在下方结果面板。'
                    : ' 点右上角「提交设计」跑全部用例。'}
                </p>
                <CaseList
                  problem={problem}
                  suite={suite}
                  replayingId={replayingId}
                  onReplay={startReplay}
                  onStopReplay={stopReplay}
                />
                <h4 style={{ margin: '18px 0 8px' }}>🧱 结构检查（确定性规则，不依赖 LLM）</h4>
                <StructuralList structural={structural} onSelectNode={(id) => setSelectedId(id)} />
              </div>
            )}

            {activeTab === 'subs' && (
              <div>
                {mySubmissions.length === 0 ? (
                  <p className="hint" style={{ marginTop: 0 }}>
                    还没有提交记录。完成设计后点右上角「提交设计」，成绩会记在这里。
                  </p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {mySubmissions.map((s, i) => (
                      <div key={i} className="case-row">
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <b style={{ color: scoreColor(s.scorePct) }}>{s.scorePct} 分</b>
                          <span style={{ fontSize: 13 }}>
                            {s.passed}/{s.total} 个用例通过
                          </span>
                          <span style={{ marginLeft: 'auto', color: '#94a3b8', fontSize: 12 }}>
                            {new Date(s.at).toLocaleString('zh-CN', { hour12: false })}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'driver' && (
              <DriverPanel
                settings={driverSettings}
                onSettings={setDriverSettings}
                busy={driverBusy}
                review={driverReview}
                error={driverError}
                canRun={phase !== 'design'}
                onRun={runDriver}
              />
            )}
          </div>
        </aside>

        {/* ------------------------------------------------- workspace --- */}
        <section className="lc-workspace">
          {/* component palette: slim strip */}
          <div className="palette-strip">
            {categories.map((cat) => (
              <div key={cat} className="palette-group">
                <span className="palette-cat">{cat}</span>
                {COMPONENTS.filter((c) => c.category === cat).map((c) => (
                  <button
                    key={c.type}
                    className="palette-chip"
                    onClick={() => addComponent(c.type)}
                    disabled={locked}
                    title={c.blurb}
                  >
                    <svg width="20" height="20" viewBox="0 0 48 48" style={{ color: c.color }}>
                      <IconGlyph icon={c.icon} size={44} />
                    </svg>
                    <span>{c.name}</span>
                  </button>
                ))}
              </div>
            ))}
            <div className="palette-tools">
              <button
                className={connectMode ? 'primary' : ''}
                onClick={() => {
                  setConnectMode(!connectMode);
                  setConnectFrom(null);
                }}
                disabled={locked}
                title="连线模式：点起点再点终点"
              >
                {connectMode ? '连线中…' : '🔗 连线'}
              </button>
              <button onClick={() => setDesign(structuredClone(problem.sampleDesign))} disabled={locked}>
                示例
              </button>
              <button onClick={() => setDesign({ nodes: [], edges: [] })} disabled={locked}>
                清空
              </button>
            </div>
          </div>

          {/* canvas: the dominant area */}
          <div className="canvas-area">
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
          </div>

          {/* compact metrics strip */}
          <div className="metrics-strip">
            {[
              ['入站流量', snapshot ? `${Math.round(snapshot.totalInQps)} req/s` : '—'],
              ['P99', snapshot ? `${Math.round(snapshot.p99Ms)} ms` : '—'],
              ['错误率', snapshot ? `${(snapshot.errorRate * 100).toFixed(1)}%` : '—'],
              ['缓存命中', snapshot ? `${Math.round(snapshot.cacheHitRate * 100)}%` : '—'],
              ['读旧数据', snapshot ? `${(snapshot.staleReadRate * 100).toFixed(1)}%` : '—'],
              ['成本', snapshot ? `$${snapshot.costPerHour.toFixed(0)}/h` : '—'],
            ].map(([k, v]) => (
              <div key={k} className="metric compact">
                <span>{k}</span>
                <b>{v}</b>
              </div>
            ))}
            {snapshot && snapshot.activeEvents.length > 0 && (
              <div className="metric compact event-metric">
                <span>进行中事件</span>
                <b>{snapshot.activeEvents.map((e) => e.type).join(' · ')}</b>
              </div>
            )}
            {replayingId && (
              <div className="metric compact event-metric">
                <span>回放中</span>
                <b>{problem.testCases.find((c) => c.id === replayingId)?.name}</b>
              </div>
            )}
            <span className="metrics-hint">
              {phase === 'design'
                ? '设计阶段：流量与判卷关闭，先把设计画完。'
                : '点任意组件打开细究面板（本题读写背景 + 模块实验室 + 针对这份设计的追问）。'}
            </span>
          </div>

          {/* traffic + scenario controls, one slim row */}
          <div className="controls-strip panel">
            <label className="ctl-slider">
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
            <label className="ctl-slider">
              读占比 {Math.round(traffic.readRatio * 100)}%
              <input
                type="range"
                min={50}
                max={99}
                value={Math.round(traffic.readRatio * 100)}
                onChange={(e) => setTraffic({ ...traffic, readRatio: Number(e.target.value) / 100 })}
              />
            </label>
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
            <span className="ctl-sep" />
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

          {/* ------------------------- bottom results panel (collapsible) --- */}
          <div className="lc-bottom panel">
            <button className="lc-bottom-head" onClick={() => setBottomOpen(!bottomOpen)}>
              <span>{bottomOpen ? '▾' : '▸'} 测试结果</span>
              {suite ? (
                <span style={{ fontSize: 13 }}>
                  本轮成绩：<b style={{ color: scoreColor(suite.scorePct) }}>{suite.scorePct} 分</b>
                  （{suite.passedCount}/{suite.totalCount} 个用例通过）
                </span>
              ) : (
                <span style={{ color: '#94a3b8', fontSize: 12.5 }}>
                  {phase === 'design'
                    ? '尚未运行——先完成设计，再点「提交设计」。'
                    : '模拟运行中——点「提交设计」跑全部用例判卷。'}
                </span>
              )}
              {suite && (
                <span
                  role="button"
                  tabIndex={0}
                  className="lc-bottom-rerun"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSubmit();
                  }}
                >
                  ⟳ 重新判卷
                </span>
              )}
            </button>
            {bottomOpen && (
              <div className="lc-bottom-body">
                {suite ? (
                  <>
                    <CaseList
                      problem={problem}
                      suite={suite}
                      replayingId={replayingId}
                      onReplay={startReplay}
                      onStopReplay={stopReplay}
                    />
                    {/* Qualitative review — Driver layer only. */}
                    <div style={{ marginTop: 14, border: '1px solid #1e293b', borderRadius: 8, padding: '10px 12px', background: '#0b1220' }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <b>🧑‍⚖️ 评审员点评</b>
                        {assessorLabel && (
                          <span style={{ color: '#94a3b8', fontSize: 12 }}>由 {assessorLabel} 给出（分数本身由代码判卷）</span>
                        )}
                        {!assessment && (
                          <button
                            style={{ marginLeft: 'auto' }}
                            disabled={assessmentBusy}
                            onClick={() => suite && void runAssessment(suite)}
                          >
                            {assessmentBusy ? '评审员思考中…' : '让评审员点评这次提交'}
                          </button>
                        )}
                      </div>
                      {assessmentBusy && !assessment && (
                        <div style={{ color: '#94a3b8', fontSize: 13, marginTop: 6 }}>正在读这份设计与判卷结果…</div>
                      )}
                      {assessment && (
                        <div style={{ fontSize: 13, lineHeight: 1.7, marginTop: 4 }}>
                          <div>{assessment.summary}</div>
                          {assessment.scoreRationale && (
                            <div style={{ color: '#cbd5e1', marginTop: 4 }}>
                              <b>分数理由：</b>
                              {assessment.scoreRationale}
                            </div>
                          )}
                          {assessment.findings.length > 0 && (
                            <ul style={{ margin: '6px 0 2px', paddingLeft: 18 }}>
                              {assessment.findings.map((f, i) => (
                                <li key={i}>
                                  <b style={{ color: f.severity === 'high' ? '#fca5a5' : f.severity === 'medium' ? '#fde68a' : '#e2e8f0' }}>
                                    {f.title}
                                  </b>
                                  <span style={{ color: '#cbd5e1' }}> — {f.detail}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                    </div>
                    <h4 style={{ margin: '16px 0 8px' }}>🧱 结构检查（确定性规则，不依赖 LLM）</h4>
                    <StructuralList structural={structural} onSelectNode={(id) => setSelectedId(id)} />
                  </>
                ) : (
                  <div className="lc-bottom-hint">
                    {phase === 'design'
                      ? '👉 下一步：在画布上完成设计，然后点右上角绿色的「提交设计」——判卷结果会出现在这里，失败用例可点开回放。'
                      : '👉 下一步：点右上角绿色的「提交设计」跑全部用例——每个用例的实测值 vs 阈值会出现在这里。'}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* -------------------- deep dive: slide-over, not a section --- */}
          {selectedNode && (
            <div className="slideover">
              <DeepDive
                node={selectedNode}
                design={design}
                problem={problem}
                snapshot={snapshot}
                queueHistory={queueHistory}
                locked={locked}
                killed={engine.isKilled(selectedNode.id)}
                followUps={followUps}
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
                onClose={() => setSelectedId(null)}
              />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
