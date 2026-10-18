import { useEffect, useRef, useState } from 'react';
import { COMPONENTS, componentDef, type ComponentTypeId } from '@sds/components';
import {
  SimulationEngine,
  defaultSettings,
  newId,
  type Design,
  type MetricsSnapshot,
  type NodeSettings,
  type TrafficConfig,
} from '@sds/sim-core';
import {
  API_URL,
  evaluateOnServer,
  fetchHealth,
  fetchProblems,
  judgeOnServer,
  verifyProbesOnServer,
  type FollowUpContextDTO,
  type FollowUpQuestionDTO,
  type HealthDTO,
  type JudgeResponseDTO,
  type ProbeCaseDTO,
  type ProblemCaseDTO,
  type ProblemPack,
  type ProblemSchemaDTO,
  type SchemaAssessmentDTO,
  type StructuralFindingDTO,
  type SubmissionAssessmentDTO,
  type SuiteResultDTO,
  type VerifiedProbeDTO,
} from './api';
import { Canvas } from './Canvas';
import { DeepDive } from './DeepDive';
import { SettingsPanel } from './SettingsPanel';
import { CaseList, ProbeSection, StructuralList, scoreColor } from './ReportPanel';
import { SchemaPanel } from './SchemaPanel';
import { IconGlyph } from './icons';

type Phase = 'design' | 'run' | 'report';
type LeftTab = 'desc' | 'cases' | 'subs';
type RightView = 'arch' | 'schema';

interface SubmissionRecord {
  problemId: string;
  at: number;
  scorePct: number;
  passed: number;
  total: number;
}

const SUBMISSIONS_KEY = 'sds-submissions-v1';

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
  { id: 'cases', label: '测试用例' },
  { id: 'subs', label: '提交记录' },
];

const RIGHT_VIEWS: { id: RightView; label: string }[] = [
  { id: 'arch', label: '架构设计' },
  { id: 'schema', label: '数据库设计' },
];

// ------------------------------------------- shared summary builders -----
// One design snapshot, several consumers: the submission assessment and the
// follow-up generator both read the same rendering of the user's design, so
// every backend evaluation sees identical facts. These builders only format
// runtime data (the user's own design/schema + the fetched pack) — they hold
// no problem logic.

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

function schemaSummaryOf(schema: ProblemSchemaDTO): string {
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

function workloadSummaryOf(problem: ProblemPack): string {
  const w = problem.workload;
  return (
    `读:写 = ${Math.round(w.readRatio * 100)}:${Math.round((1 - w.readRatio) * 100)}；一致性要求：${w.consistency}；` +
    `访问模式：${w.patterns
      .map((p) => `${p.name}（${p.kind === 'read' ? '读' : '写'}，占 ${Math.round(p.share * 100)}%）`)
      .join('、')}`
  );
}

function Simulator({ problems, llmConfigured }: { problems: ProblemPack[]; llmConfigured: boolean }) {
  const [problemId, setProblemId] = useState(
    () => problems.find((p) => p.id === 'instagram')?.id ?? problems[0]!.id,
  );
  const problem = problems.find((p) => p.id === problemId) ?? problems[0]!;
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
  const [suite, setSuite] = useState<SuiteResultDTO | null>(null);
  const [schemas, setSchemas] = useState<Record<string, ProblemSchemaDTO>>(() =>
    Object.fromEntries(problems.map((p) => [p.id, structuredClone(p.schema)])),
  );
  const [structural, setStructural] = useState<StructuralFindingDTO[]>([]);
  const [judgeError, setJudgeError] = useState<string | null>(null);
  const [replayingId, setReplayingId] = useState<string | null>(null);
  const [queueHistory, setQueueHistory] = useState<number[]>([]);
  const [activeTab, setActiveTab] = useState<LeftTab>('desc');
  const [rightView, setRightView] = useState<RightView>('arch');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [bottomOpen, setBottomOpen] = useState(true);
  const [submissions, setSubmissions] = useState<SubmissionRecord[]>(loadSubmissions);

  // --------------------------------------- qualitative assessment layer ---
  // Hard verdicts are computed by the BACKEND (code judging). EVERYTHING
  // qualitative — submission review, deep-dive follow-ups, schema
  // conclusions — comes from ONE backend evaluation call per request: the
  // server calls the configured LLM (or its scripted fallback) and returns
  // structured data; this app only assembles context and renders results.
  const [assessorLabel, setAssessorLabel] = useState('');
  const [followUps, setFollowUps] = useState<FollowUpQuestionDTO[] | null>(null);
  const [assessment, setAssessment] = useState<SubmissionAssessmentDTO | null>(null);
  const [assessmentBusy, setAssessmentBusy] = useState(false);
  const [assessmentError, setAssessmentError] = useState<string | null>(null);
  const [submitStamp, setSubmitStamp] = useState(0);

  // Probe step: after judging, the backend's model proposes failure cases
  // for THIS design from the judging criteria (it never sees the static
  // suite), the backend's simulator runs each one and grades the
  // predictions, and the qualitative review then grounds on the VERIFIED
  // probe results instead of the static per-case dump.
  const [probeResults, setProbeResults] = useState<VerifiedProbeDTO[] | null>(null);
  const [probeBusy, setProbeBusy] = useState(false);
  const [probeNote, setProbeNote] = useState<string | null>(null);
  const [probeLabel, setProbeLabel] = useState('');

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
    tc: ProblemCaseDTO;
    tick: number;
    events: NonNullable<ProblemCaseDTO['events']>;
    kills: NonNullable<ProblemCaseDTO['kills']>;
  } | null>(null);
  const structuralSeq = useRef(0);

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
      localStorage.setItem(SUBMISSIONS_KEY, JSON.stringify(submissions));
    } catch {
      /* ignore */
    }
  }, [submissions]);

  // Structural findings are computed by the backend, not here. While
  // designing, refresh them (debounced) through the judge endpoint and
  // consume only its structural slice; a real submission re-judges
  // everything and replaces both suite and structural state.
  useEffect(() => {
    if (phase !== 'design') return;
    const seq = ++structuralSeq.current;
    const t = window.setTimeout(() => {
      judgeOnServer({ problemId: problem.id, design })
        .then((jr) => {
          if (structuralSeq.current === seq) setStructural(jr.structural);
        })
        .catch(() => {
          /* backend hiccup — keep the last known findings */
        });
    }, 700);
    return () => window.clearTimeout(t);
  }, [design, problem, phase]);

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
    const p = problems.find((x) => x.id === id) ?? problems[0]!;
    setProblemId(p.id);
    setDesign(structuredClone(p.sampleDesign));
    setTraffic({ rps: p.scale.baselineRps, readRatio: p.scale.readRatio });
    setPhase('design');
    setRunning(false);
    setSnapshot(null);
    setSuite(null);
    setStructural([]);
    setJudgeError(null);
    setAssessment(null);
    setAssessmentError(null);
    setProbeResults(null);
    setProbeNote(null);
    setProbeLabel('');
    setFollowUps(null);
    setHighlights(new Map());
    setSelectedId(null);
    setReplayingId(null);
    replayRef.current = null;
    engineRef.current = new SimulationEngine(structuredClone(p.sampleDesign), {
      rps: p.scale.baselineRps,
      readRatio: p.scale.readRatio,
    });
  };

  const problemIndex = problems.findIndex((p) => p.id === problemId);
  const stepProblem = (delta: number) => {
    const next = problems[(problemIndex + delta + problems.length) % problems.length]!;
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
    setAssessmentError(null);
    setProbeResults(null);
    setProbeNote(null);
    setProbeLabel('');
    setHighlights(new Map());
    setReplayingId(null);
    replayRef.current = null;
    engine.reviveAll();
    engine.clearEvents();
  };

  /**
   * Judging happens on the backend: POST the design (and current schema
   * draft) and render what comes back — suite results, structural findings,
   * schema signals. Hidden cases are judged there, where their data lives.
   */
  const runSuiteNow = async () => {
    const p = problemRef.current;
    let jr: JudgeResponseDTO;
    try {
      jr = await judgeOnServer({
        problemId: p.id,
        design: designRef.current,
        schema: schemasRef.current[p.id]!,
        schemaLoadFactor: snapshot ? Math.min(1.5, snapshot.hottestUtil) : 0,
      });
    } catch {
      setJudgeError('判卷失败：后端不可达。请确认后端已启动（npm run dev:server）后，再点一次「提交设计」。');
      return;
    }
    setJudgeError(null);
    const result = jr.suite;
    setSuite(result);
    setStructural(jr.structural);
    setSubmitStamp((s) => s + 1);
    setAssessment(null);
    setAssessmentError(null);
    setProbeResults(null);
    setProbeNote(null);
    setProbeLabel('');
    setPhase('report');
    setSubmissions((prev) =>
      [
        {
          problemId: p.id,
          at: Date.now(),
          scorePct: result.scorePct,
          passed: result.passedCount,
          total: result.totalCount,
        },
        ...prev,
      ].slice(0, 50),
    );
    // Submission pipeline: code judging (done above, it owns the score) →
    // LLM probe (the model proposes failure cases for THIS design from the
    // criteria alone) → simulator verification of every prediction → the
    // qualitative review, grounded on the verified probe results. The
    // static suite remains the fairness baseline for the score and is no
    // longer briefed to the LLM.
    void runProbeThenAssessment(result, jr.structural);
  };

  /**
   * Probe → verify → assess. Any probe failure degrades gracefully: the
   * probe section shows itself unavailable and the review falls back to
   * grounding on the judging summary, so a submission never loses its
   * review because the probe step hiccuped.
   */
  const runProbeThenAssessment = async (
    s: SuiteResultDTO,
    structuralFindings: StructuralFindingDTO[],
  ) => {
    const p = problemRef.current;
    setProbeBusy(true);
    let verified: VerifiedProbeDTO[] = [];
    try {
      const pr = await evaluateOnServer<ProbeCaseDTO[]>('probe', {
        problemName: p.name,
        designSummary: buildDesignSummary(designRef.current),
        schemaSummary: schemaSummaryOf(schemasRef.current[p.id]!),
        workloadSummary: workloadSummaryOf(p),
        structuralFindings,
        baselineRps: p.scale.baselineRps,
        readRatio: p.scale.readRatio,
        budgetCostPerHour: p.scale.budgetCostPerHour,
        nodes: designRef.current.nodes.map((n) => ({
          id: n.id,
          type: n.type,
          name: componentDef(n.type).name,
        })),
      });
      setProbeLabel(pr.label);
      if (pr.data.length > 0) {
        const vr = await verifyProbesOnServer({
          problemId: p.id,
          design: designRef.current,
          cases: pr.data,
        });
        verified = vr.results;
        setProbeResults(verified);
        if (!verified.length) {
          setProbeNote('探测用例未通过服务端的合法性校验，本轮没有可验证的探测结果。');
        }
      } else {
        setProbeNote('本轮探测没有产出可用用例，评审改为依据判卷总览与结构缺陷。');
      }
    } catch {
      setProbeNote('探测步骤不可用（后端未返回），评审改为依据判卷总览与结构缺陷。');
    } finally {
      setProbeBusy(false);
    }
    void runAssessment(s, structuralFindings, verified);
  };

  /** Qualitative review of a judged submission — ONE backend evaluate call. */
  const runAssessment = async (
    s: SuiteResultDTO,
    structuralOverride?: StructuralFindingDTO[],
    probeOverride?: VerifiedProbeDTO[],
  ) => {
    setAssessmentBusy(true);
    setAssessmentError(null);
    try {
      const probes = probeOverride ?? probeResults ?? [];
      const r = await evaluateOnServer<SubmissionAssessmentDTO>('submission', {
        problemName: problemRef.current.name,
        designSummary: buildDesignSummary(designRef.current),
        workloadSummary: workloadSummaryOf(problemRef.current),
        scorePct: s.scorePct,
        passed: s.passedCount,
        total: s.totalCount,
        // With verified probes, the static per-case results are NOT sent:
        // the review grounds on the probe verification instead.
        cases: probes.length ? [] : s.results,
        structuralFindings: structuralOverride ?? structural,
        ...(probes.length ? { probeResults: probes } : {}),
      });
      setAssessorLabel(r.label);
      setAssessment(r.data);
    } catch {
      // The server already falls back to its scripted assessment when the
      // LLM call itself fails, so reaching here means the evaluate request
      // never completed — say so plainly instead of leaving an empty panel.
      // (A re-run keeps any previous assessment on screen.)
      setAssessmentError('评审调用失败：后端未返回评审结果，请确认后端在运行后点「重新评审」。');
    } finally {
      setAssessmentBusy(false);
    }
  };

  /** LeetCode's green Submit: lock the design, judge everything, show results. */
  const onSubmit = () => {
    if (phase === 'design') submitDesign();
    void runSuiteNow();
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

  const startReplay = (tc: ProblemCaseDTO) => {
    // Hidden cases arrive stripped (locked): their scenario data never left
    // the server, so there is nothing local to replay.
    if (tc.locked) return;
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

  // ------------------------------------- deep-dive follow-up generation ---
  // When a component is opened (or a new submission lands), ask the backend
  // for follow-ups generated from THIS design snapshot: the graph, this
  // component's settings, this problem's workload landing on it, the schema
  // choices and the judging signals. The context is assembled here from
  // runtime data; the questions themselves are produced by the backend's
  // single evaluate call. Regenerates per (problem, node, submission, graph
  // shape) — not on every settings keystroke.
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
    const ctx: FollowUpContextDTO = {
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
    evaluateOnServer<FollowUpQuestionDTO[]>('followups', ctx)
      .then((r) => {
        if (!cancelled) {
          setAssessorLabel(r.label);
          setFollowUps(r.data);
        }
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
      ? '下一步：在右侧「架构设计」画布上完成设计（表结构在右侧「数据库设计」视图里交卷），然后点「提交设计」判卷——或先点「▶ 运行」看它跑起来。'
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
            {problems.map((p) => (
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
          <button className="lc-gear-btn" onClick={() => setSettingsOpen(true)} title="设置（后端连接状态）">
            ⚙
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
                  玩法和面试一样：先在右侧「架构设计」画布把设计画完（点任意组件可进入「面试官细究」），
                  数据库表结构在右侧「数据库设计」视图里交卷，最后点右上角「提交设计」判卷。
                </p>
              </div>
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

          </div>
        </aside>

        {/* ------------------------------------------------- workspace --- */}
        <section className="lc-workspace">
          {/* right-pane view tabs: the two main work surfaces live here —
              架构设计 (canvas) and 数据库设计 (schema editor). Both stay
              mounted; switching only toggles visibility so in-progress
              work in either view is never lost. */}
          <div className="ws-view-tabs">
            {RIGHT_VIEWS.map((v) => (
              <button
                key={v.id}
                className={`ws-view-tab ${rightView === v.id ? 'active' : ''}`}
                onClick={() => setRightView(v.id)}
              >
                {v.label}
              </button>
            ))}
          </div>

          <div className="ws-view" style={{ display: rightView === 'arch' ? 'flex' : 'none' }}>
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
          </div>

          {/* -------- 数据库设计 view: the schema editor as a full
              right-pane surface. Kept mounted alongside the canvas view —
              drafts live in App state per problem, switching views loses
              nothing. Review output renders inside the panel, as before. */}
          <div
            className="ws-view ws-view-schema"
            style={{ display: rightView === 'schema' ? 'flex' : 'none' }}
          >
            <SchemaPanel
              schema={schemas[problem.id]!}
              snapshot={snapshot}
              onChange={(s) => setSchemas({ ...schemas, [problem.id]: s })}
              assessorNote={assessorLabel ? `评审：${assessorLabel}` : undefined}
              onReview={async (sch, loadFactor) => {
                const r = await evaluateOnServer<SchemaAssessmentDTO>('schema', {
                  problemName: problem.name,
                  schema: sch,
                  loadFactor,
                });
                setAssessorLabel(r.label);
                if (!r.schemaSignals) throw new Error('后端未返回 schema 信号');
                return { signals: r.schemaSignals, assessment: r.data };
              }}
            />
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
                {judgeError && (
                  <div style={{ color: '#fca5a5', fontSize: 13, marginBottom: 8 }}>
                    ⚠️ {judgeError}
                  </div>
                )}
                {suite ? (
                  <>
                    <CaseList
                      problem={problem}
                      suite={suite}
                      replayingId={replayingId}
                      onReplay={startReplay}
                      onStopReplay={stopReplay}
                    />
                    {/* Probe step: LLM-proposed cases, simulator-verified. */}
                    <ProbeSection
                      busy={probeBusy}
                      note={probeNote}
                      results={probeResults}
                      sourceLabel={probeLabel}
                    />
                    {/* Qualitative review — backend evaluate call only. */}
                    <div style={{ marginTop: 14, border: '1px solid #1e293b', borderRadius: 8, padding: '10px 12px', background: '#0b1220' }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <b>🧑‍⚖️ 评审员点评</b>
                        {assessorLabel && (
                          <span style={{ color: '#94a3b8', fontSize: 12 }}>评审：{assessorLabel}（分数本身由代码判卷）</span>
                        )}
                        <button
                          style={{ marginLeft: 'auto' }}
                          disabled={assessmentBusy || probeBusy}
                          onClick={() => suite && void runAssessment(suite)}
                        >
                          {assessmentBusy || probeBusy ? '评审生成中…' : assessment ? '重新评审' : '让评审员点评这次提交'}
                        </button>
                      </div>
                      {(assessmentBusy || probeBusy) && !assessment && (
                        <div style={{ color: '#94a3b8', fontSize: 13, marginTop: 6 }}>
                          {probeBusy
                            ? '评审流程进行中：先完成 LLM 探测与仿真验证，再生成点评…'
                            : `评审生成中…（正在联系${llmConfigured ? '云端 LLM' : '本地脚本评审'}，马上就好）`}
                        </div>
                      )}
                      {assessmentBusy && assessment && (
                        <div style={{ color: '#94a3b8', fontSize: 13, marginTop: 6 }}>重新评审中…</div>
                      )}
                      {assessmentError && (
                        <div style={{ color: '#fca5a5', fontSize: 13, marginTop: 6 }}>⚠️ {assessmentError}</div>
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

      {/* -------------------- settings: slide-over from the ⚙ gear --- */}
      {settingsOpen && (
        <>
          <div className="settings-backdrop" onClick={() => setSettingsOpen(false)} />
          <div className="settings-panel" role="dialog" aria-label="设置">
            <div className="settings-head">
              <b style={{ fontSize: 15 }}>⚙ 设置</b>
              <button onClick={() => setSettingsOpen(false)} title="关闭设置">
                ✕
              </button>
            </div>
            <SettingsPanel />
          </div>
        </>
      )}
    </div>
  );
}

// --------------------------------------------------------------- app shell ---
// Thin frontend: problem packs arrive from the backend at runtime. There is
// deliberately NO bundled fallback — without the backend there is nothing
// legitimate to show, so the app says so plainly instead of inventing data.

export default function App() {
  const [problems, setProblems] = useState<ProblemPack[] | null>(null);
  const [health, setHealth] = useState<HealthDTO | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let on = true;
    setFailed(false);
    setProblems(null);
    Promise.all([fetchProblems(), fetchHealth().catch(() => null)])
      .then(([ps, h]) => {
        if (!on) return;
        setProblems(ps);
        setHealth(h);
      })
      .catch(() => {
        if (on) setFailed(true);
      });
    return () => {
      on = false;
    };
  }, [attempt]);

  if (failed) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#020617',
          color: '#e2e8f0',
          padding: 24,
          boxSizing: 'border-box',
        }}
      >
        <div style={{ maxWidth: 540, lineHeight: 1.8 }}>
          <h1 style={{ fontSize: 20, margin: '0 0 8px' }}>需要后端</h1>
          <p style={{ color: '#94a3b8', fontSize: 14, margin: 0 }}>
            这个前端不内置任何题目：题面、测试用例（包括隐藏用例）、判卷和 AI 评审都在后端
            （当前地址 <code>{API_URL}</code>）。后端现在连不上，请先在项目根目录启动它：
          </p>
          <pre
            style={{
              background: '#0b1220',
              border: '1px solid #1e293b',
              borderRadius: 8,
              padding: '10px 14px',
              fontSize: 13,
              overflowX: 'auto',
            }}
          >
            npm run dev:server
          </pre>
          <button className="primary" onClick={() => setAttempt((a) => a + 1)}>
            重试连接
          </button>
        </div>
      </div>
    );
  }

  if (!problems) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#020617',
          color: '#94a3b8',
          fontSize: 14,
        }}
      >
        正在从后端加载题目…
      </div>
    );
  }

  return <Simulator problems={problems} llmConfigured={health?.llmConfigured ?? false} />;
}
