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
  fetchCaseScenario,
  fetchHealth,
  fetchProblems,
  judgeOnServer,
  simulateSchemaOnServer,
  verifyProbesOnServer,
  type ActionCoverageDTO,
  type EditOpDTO,
  type FollowUpContextDTO,
  type FollowUpQuestionDTO,
  type HealthDTO,
  type JudgeResponseDTO,
  type ProbeCaseDTO,
  type ProblemCaseDTO,
  type ProblemPack,
  type ProblemSchemaDTO,
  type NextStepDTO,
  type SchemaAssessmentDTO,
  type SchemaOpDTO,
  type SchemaSignalsDTO,
  type SchemaSimDTO,
  type StructuralFindingDTO,
  type SubmissionAssessmentDTO,
  type SuiteResultDTO,
  type VerifiedProbeDTO,
} from './api';
import {
  applyActions,
  applySchemaOpsPreview,
  recheckActions,
  recheckSchemaOps,
  type PreviewPlan,
  type SchemaPreviewPlan,
} from './edits';
import {
  MAX_PINS_PER_PROBLEM,
  builtinScenarios,
  loadPins,
  savePins,
  scenarioFromCase,
  scenarioFromExecuted,
  scenarioFromProbe,
  type QuickScenario,
} from './scenarios';
import { Canvas } from './Canvas';
import { DeepDive } from './DeepDive';
import { SettingsPanel } from './SettingsPanel';
import {
  ActionSourceLabel,
  CaseList,
  CoverageLine,
  NextStepsSection,
  ProbeSection,
  StructuralList,
  scoreColor,
} from './ReportPanel';
import { SchemaPanel, SchemaAssessmentView, SchemaSignalsView, SchemaSimView } from './SchemaPanel';
import { IconGlyph } from './icons';

type Phase = 'design' | 'run' | 'report';
type LeftTab = 'desc' | 'cases' | 'subs';
type RightView = 'arch' | 'schema';
/** Top-level screens: design workspace vs the post-submit results page. */
type AppView = 'design' | 'results';
/** The results page's left column, one tab per evaluation section. */
type ResultsTab = 'judge' | 'review' | 'probe' | 'schema';

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

const RESULTS_TABS: { id: ResultsTab; label: string }[] = [
  { id: 'judge', label: '判卷结果' },
  { id: 'review', label: 'AI 评审' },
  { id: 'probe', label: '探测用例' },
  { id: 'schema', label: '数据库评审' },
];

/** Live measured-vs-threshold rows for the quick-sim readout strip. */
function readoutRows(
  sc: QuickScenario,
  snap: MetricsSnapshot,
  queueDepthMax: number,
): { label: string; text: string; ok?: boolean }[] {
  const t = sc.thresholds;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const rows: { label: string; text: string; ok?: boolean }[] = [];
  const add = (
    label: string,
    value: number,
    limit: number | undefined,
    fmt: (x: number) => string,
    lowerIsBetter = true,
  ) => {
    rows.push({
      label,
      text: limit !== undefined ? `${fmt(value)} / 阈值 ${fmt(limit)}` : fmt(value),
      ok: limit !== undefined ? (lowerIsBetter ? value <= limit : value >= limit) : undefined,
    });
  };
  add('错误率', snap.errorRate, t?.maxErrorRate, pct);
  add('P99', snap.p99Ms, t?.maxP99Ms, (x) => `${Math.round(x)}ms`);
  add('成本', snap.costPerHour, t?.maxCostPerHour, (x) => `$${x.toFixed(0)}/h`);
  add('存储入站', snap.maxStorageQps, t?.maxStorageQps, (x) => `${Math.round(x)} QPS`);
  add('读旧', snap.staleReadRate, t?.maxStaleReadRate, pct);
  add('最热利用率', snap.hottestUtil, t?.maxHottestUtil, pct);
  add('队列积压', queueDepthMax, t?.maxQueueDepth, (x) => `${Math.round(x).toLocaleString()} 条`);
  return rows;
}

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
  const [queueHistory, setQueueHistory] = useState<number[]>([]);
  const [activeTab, setActiveTab] = useState<LeftTab>('desc');
  const [rightView, setRightView] = useState<RightView>('arch');
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Top-level screen. The right workspace (canvas + schema editor) is a
  // single shared subtree that stays mounted in BOTH screens — only the
  // left column swaps between the problem panel and the results tabs.
  const [view, setView] = useState<AppView>('design');
  const [resultsTab, setResultsTab] = useState<ResultsTab>('judge');
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
  // Action-guarantee accounting per evaluation section (from the server
  // ladder): how many findings ship an applicable action, by provenance.
  const [assessmentCoverage, setAssessmentCoverage] = useState<ActionCoverageDTO | null>(null);
  const [probeCoverage, setProbeCoverage] = useState<ActionCoverageDTO | null>(null);
  const [schemaCoverage, setSchemaCoverage] = useState<ActionCoverageDTO | null>(null);

  // Next steps: ONE pinned action per FAILED case, generated with the
  // submit (its own evaluate kind) and rendered at the top of the 判卷结果
  // tab. Like every other result here it belongs to the submitted
  // snapshot — the stale banner covers it once the design diverges.
  const [nextSteps, setNextSteps] = useState<NextStepDTO[] | null>(null);
  const [nextStepsBusy, setNextStepsBusy] = useState(false);
  const [nextStepsError, setNextStepsError] = useState<string | null>(null);
  const [nextStepsNote, setNextStepsNote] = useState<string | null>(null);
  const [nextStepsLabel, setNextStepsLabel] = useState('');
  const [nextStepsCoverage, setNextStepsCoverage] = useState<ActionCoverageDTO | null>(null);

  // --------------------------------------------- schema evaluation layer -
  // There is NO standalone schema review anymore: the AI assessment is
  // produced by the unified submit (one evaluate call for the submitted
  // schema) and rendered only in the results page's 「数据库评审」 tab.
  // The deterministic signals travel separately (they ride every judge
  // response) and also feed the schema view's design-time checker display.
  const [schemaSignals, setSchemaSignals] = useState<SchemaSignalsDTO | null>(null);
  // Schema simulation runs, kept per problem alongside the schema draft
  // (same lifecycle): the sim that ran + the exact draft fingerprint it
  // ran on, so a later edit can mark the shown results as the last run's.
  const [schemaSims, setSchemaSims] = useState<
    Record<string, { sim: SchemaSimDTO; fingerprint: string }>
  >({});
  const [schemaSimBusy, setSchemaSimBusy] = useState(false);
  const [schemaSimError, setSchemaSimError] = useState<string | null>(null);
  // The sim the server recomputed for the SUBMITTED schema (rides the
  // schema evaluate response) — shown in the results page's 数据库评审 tab.
  const [submittedSchemaSim, setSubmittedSchemaSim] = useState<SchemaSimDTO | null>(null);
  const [schemaAssessment, setSchemaAssessment] = useState<SchemaAssessmentDTO | null>(null);
  const [schemaLabel, setSchemaLabel] = useState('');
  const [schemaBusy, setSchemaBusy] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  // Schema fix loop: a suggestion's schema-ops previewed against the
  // CURRENT schema draft (pure computation) → confirm commits the draft
  // + one-step undo — the same discipline as the architecture fix loop.
  const [schemaPreview, setSchemaPreview] = useState<{ title: string; plan: SchemaPreviewPlan } | null>(null);
  const [undoSchemaFix, setUndoSchemaFix] = useState<{ schema: ProblemSchemaDTO; title: string } | null>(null);
  // The exact design + schema the on-screen results belong to. Editing
  // either beside the results marks them stale until the next submit.
  const [submittedSnapshot, setSubmittedSnapshot] = useState<{
    design: string;
    schema: string;
  } | null>(null);

  // ---------------------------------------------------------- fix loop ---
  // Findings may carry server-validated fix actions. Applying one is a
  // three-step dance: preview (pure computation — the committed design is
  // NOT touched, the canvas shows the would-be design with every change
  // highlighted) → confirm (commit + one-step undo) or abandon (Esc).
  const [preview, setPreview] = useState<{ title: string; plan: PreviewPlan } | null>(null);
  const [undoFix, setUndoFix] = useState<{ design: Design; title: string } | null>(null);
  const [fixNotice, setFixNotice] = useState<string | null>(null);

  // ------------------------------------------------------ quick scenarios -
  // The scenario bar: built-in presets + scenarios pinned from judged
  // case rows / verified probe cards. A quick run is a LOCAL visual
  // preview on the current design (animated flow + live readout against
  // the case's thresholds) — it never re-judges and never changes the
  // score; only a fresh submission does.
  const [activeSim, setActiveSim] = useState<QuickScenario | null>(null);
  const [simReadout, setSimReadout] = useState<{
    sc: QuickScenario;
    snap: MetricsSnapshot;
    queueDepthMax: number;
    done: boolean;
  } | null>(null);
  const [pins, setPins] = useState<Record<string, QuickScenario[]>>(loadPins);

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
  const simRef = useRef<{
    sc: QuickScenario;
    tick: number;
    events: QuickScenario['events'];
    kills: QuickScenario['kills'];
  } | null>(null);
  const queueMaxRef = useRef(0);
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

  useEffect(() => {
    savePins(pins);
  }, [pins]);

  // Esc abandons a fix preview without touching the design / schema draft.
  useEffect(() => {
    if (!preview && !schemaPreview) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPreview(null);
        setSchemaPreview(null);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [preview, schemaPreview]);

  // Structural findings and schema signals are computed by the backend,
  // not here. While designing, refresh them (debounced) through the judge
  // endpoint and consume only those two slices; a real submission
  // re-judges everything and replaces suite, structural and signals.
  useEffect(() => {
    if (phase !== 'design') return;
    const seq = ++structuralSeq.current;
    const t = window.setTimeout(() => {
      judgeOnServer({
        problemId: problem.id,
        design,
        schema: schemasRef.current[problem.id]!,
        schemaLoadFactor: snapshot ? Math.min(1.5, snapshot.hottestUtil) : 0,
      })
        .then((jr) => {
          if (structuralSeq.current !== seq) return;
          setStructural(jr.structural);
          setSchemaSignals(jr.schemaSignals);
        })
        .catch(() => {
          /* backend hiccup — keep the last known findings */
        });
    }, 700);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [design, schemas, problem, phase]);

  useEffect(() => {
    if (!running) return;
    const iv = window.setInterval(() => {
      const sim = simRef.current;
      if (sim) {
        sim.tick += 1;
        while (sim.events.length && sim.events[0]!.atTick <= sim.tick) {
          const ev = sim.events.shift()!;
          engine.injectEvent({
            type: ev.type,
            targetType: ev.targetType,
            magnitude: ev.magnitude,
            durationTicks: ev.durationTicks,
          });
        }
        while (sim.kills.length && sim.kills[0]!.atTick <= sim.tick) {
          engine.killByType(sim.kills.shift()!.componentType);
        }
      }
      const snap = engine.step(1);
      setSnapshot(snap);
      if (sim) {
        const q = Math.max(
          queueMaxRef.current,
          ...Object.values(snap.nodes).map((m) => m.queueDepth ?? 0),
        );
        queueMaxRef.current = q;
        const done = sim.tick >= sim.sc.durationTicks;
        setSimReadout({ sc: sim.sc, snap, queueDepthMax: q, done });
        if (done) finishQuickSim();
      }
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
    setView('design');
    setSchemaAssessment(null);
    setSchemaLabel('');
    setSchemaError(null);
    setSchemaSignals(null);
    setSubmittedSnapshot(null);
    setAssessment(null);
    setAssessmentError(null);
    setProbeResults(null);
    setProbeNote(null);
    setProbeLabel('');
    setFollowUps(null);
    setHighlights(new Map());
    setSelectedId(null);
    setActiveSim(null);
    setSimReadout(null);
    setPreview(null);
    setUndoFix(null);
    setFixNotice(null);
    simRef.current = null;
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
    if (locked || preview) return;
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
    // While a fix preview is up, canvas interaction is paused entirely.
    if (preview) return;
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
    simRef.current = null;
    setActiveSim(null);
    setPhase('run');
    setRunning(true);
    engine.reviveAll();
    engine.clearEvents();
    engine.setTraffic(traffic);
    setSnapshot(engine.step(1));
  };

  const backToDesign = () => {
    setPhase('design');
    setView('design');
    setRunning(false);
    setSnapshot(null);
    setSuite(null);
    setAssessment(null);
    setAssessmentError(null);
    setSchemaAssessment(null);
    setSchemaLabel('');
    setSchemaError(null);
    setSubmittedSnapshot(null);
    setProbeResults(null);
    setProbeNote(null);
    setProbeLabel('');
    setNextSteps(null);
    setNextStepsError(null);
    setNextStepsNote(null);
    setNextStepsLabel('');
    setNextStepsCoverage(null);
    setHighlights(new Map());
    setActiveSim(null);
    setSimReadout(null);
    setPreview(null);
    setUndoFix(null);
    simRef.current = null;
    engine.reviveAll();
    engine.clearEvents();
  };

  /**
   * Unlock the design for fixing WITHOUT discarding the results: used on
   * the results page, where the user reads the verdicts on the left and
   * repairs the design on the right. The results stay on screen (marked
   * stale once the design actually diverges) until the next submit.
   */
  const unlockForFix = () => {
    setPreview(null);
    finishQuickSim();
    setSimReadout(null);
    setPhase('design');
    setRunning(false);
    setSnapshot(null);
    simRef.current = null;
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
    const loadFactor = snapshot ? Math.min(1.5, snapshot.hottestUtil) : 0;
    let jr: JudgeResponseDTO;
    try {
      jr = await judgeOnServer({
        problemId: p.id,
        design: designRef.current,
        schema: schemasRef.current[p.id]!,
        schemaLoadFactor: loadFactor,
      });
    } catch {
      setJudgeError('判卷失败：后端不可达。请确认后端已启动（npm run dev:server）后，再点一次「提交设计」。');
      return;
    }
    setJudgeError(null);
    const result = jr.suite;
    setSuite(result);
    setStructural(jr.structural);
    setSchemaSignals(jr.schemaSignals);
    setSubmittedSnapshot({
      design: JSON.stringify(designRef.current),
      schema: JSON.stringify(schemasRef.current[p.id]!),
    });
    setSubmitStamp((s) => s + 1);
    setAssessment(null);
    setAssessmentError(null);
    setSchemaAssessment(null);
    setSchemaError(null);
    setSchemaLabel('');
    setProbeResults(null);
    setProbeNote(null);
    setProbeLabel('');
    setNextSteps(null);
    setNextStepsError(null);
    setNextStepsNote(null);
    setNextStepsLabel('');
    setNextStepsCoverage(null);
    setAssessmentCoverage(null);
    setProbeCoverage(null);
    setSchemaCoverage(null);
    setSchemaPreview(null);
    setUndoSchemaFix(null);
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
    // Judging is done (it owns the score) — land on the results page. The
    // qualitative sections fill in there, each behind its own busy state.
    setResultsTab('judge');
    setView('results');
    // Submission pipeline: code judging (done above) → LLM probe (the
    // model proposes failure cases for THIS design from the criteria
    // alone) → simulator verification of every prediction → the
    // qualitative review, grounded on the verified probe results. The
    // static suite remains the fairness baseline for the score and is no
    // longer briefed to the LLM.
    void runProbeThenAssessment(result, jr.structural);
    // The schema AI assessment rides the SAME unified submit — there is
    // no separate schema-review trigger anymore. Its conclusions render
    // only in the results page's 「数据库评审」 tab.
    void runSchemaAssessment(loadFactor);
    // And the per-case next steps (their own evaluate kind), rendered at
    // the top of the 判卷结果 tab: one pinned action per failed case.
    void runNextSteps(result, jr.structural);
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
      const pr = await evaluateOnServer<ProbeCaseDTO[]>(
        'probe',
        {
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
        },
        designRef.current,
        p.id,
      );
      setProbeLabel(pr.label);
      if (pr.data.length > 0) {
        const vr = await verifyProbesOnServer({
          problemId: p.id,
          design: designRef.current,
          cases: pr.data,
        });
        verified = vr.results;
        setProbeResults(verified);
        // Coverage of the VERIFIED fixes wins (that is what is on screen);
        // the propose step's own accounting is the fallback.
        setProbeCoverage(vr.actionCoverage ?? pr.actionCoverage ?? null);
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

  /**
   * Design-time schema simulation: the server runs the problem's
   * requirement workload against the CURRENT draft. Results are kept
   * per problem next to the draft; editing afterwards marks them stale
   * (the panel says so) rather than silently re-running.
   */
  const runSchemaSim = async () => {
    const p = problemRef.current;
    const draft = schemasRef.current[p.id]!;
    setSchemaSimBusy(true);
    setSchemaSimError(null);
    try {
      const r = await simulateSchemaOnServer({ problemId: p.id, schema: draft });
      setSchemaSims((prev) => ({
        ...prev,
        [p.id]: { sim: r.sim, fingerprint: JSON.stringify(draft) },
      }));
    } catch {
      setSchemaSimError('数据库模拟调用失败：请确认后端在运行（npm run dev:server）后重试。');
    } finally {
      setSchemaSimBusy(false);
    }
  };

  /**
   * The schema half of the unified submit: ONE backend evaluate call for
   * the submitted schema draft. The deterministic signals already came
   * back with the judge response; this call adds the qualitative
   * conclusions shown in the results page's 「数据库评审」 tab.
   */
  const runSchemaAssessment = async (loadFactor: number) => {
    const p = problemRef.current;
    setSchemaBusy(true);
    setSchemaError(null);
    try {
      const r = await evaluateOnServer<SchemaAssessmentDTO>('schema', {
        problemName: p.name,
        problemId: p.id,
        schema: schemasRef.current[p.id]!,
        loadFactor,
      });
      setSchemaLabel(r.label);
      setSchemaAssessment(r.data);
      setSchemaCoverage(r.actionCoverage ?? null);
      if (r.schemaSignals) setSchemaSignals(r.schemaSignals);
      // The server recomputed the schema sim for the submitted schema;
      // its measurements join the deterministic signals in the tab.
      setSubmittedSchemaSim(r.schemaSim ?? null);
    } catch {
      // Same honesty rule as the submission review: the evaluate request
      // itself never completed — say so instead of an empty tab.
      setSchemaError('数据库评审调用失败：后端未返回结论，请确认后端在运行后重新提交。');
    } finally {
      setSchemaBusy(false);
    }
  };

  /**
   * Per-case next steps — ONE backend evaluate call for THIS submission's
   * failed cases. The server ladder guarantees a step with a validated
   * action per red case; when the AI part is unavailable the response is
   * scripted-sourced and the section says so (the steps shown are then
   * the rule / measured synthesis). A failed REQUEST gets an honest
   * error line — the deterministic case-row fixes below still work.
   */
  const runNextSteps = async (s: SuiteResultDTO, structuralFindings: StructuralFindingDTO[]) => {
    const p = problemRef.current;
    const failed = s.results.filter((r) => !r.passed);
    if (!failed.length) {
      setNextSteps([]);
      return;
    }
    setNextStepsBusy(true);
    setNextStepsError(null);
    setNextStepsNote(null);
    try {
      const caseById = new Map(p.testCases.map((tc) => [tc.id, tc]));
      const r = await evaluateOnServer<NextStepDTO[]>(
        'next-steps',
        {
          problemName: p.name,
          designSummary: buildDesignSummary(designRef.current),
          schemaSummary: schemaSummaryOf(schemasRef.current[p.id]!),
          workloadSummary: workloadSummaryOf(p),
          structuralFindings,
          failedCases: failed.map((fc) => {
            const tc = caseById.get(fc.caseId);
            return {
              caseId: fc.caseId,
              name: fc.name,
              failures: fc.failures,
              measured: fc.measured,
              hottestNode: fc.measured.hottestNode,
              ...(tc && !tc.locked ? { thresholds: tc.thresholds } : {}),
            };
          }),
        },
        designRef.current,
        p.id,
      );
      setNextStepsLabel(r.label);
      setNextSteps(r.data);
      setNextStepsCoverage(r.actionCoverage ?? null);
      if (r.source === 'scripted') {
        setNextStepsNote(
          llmConfigured
            ? 'AI 下一步不可用（本次调用失败），以下为规则·实测合成的下一步。'
            : '未配置 LLM，AI 下一步不可用——以下为规则·实测合成的下一步。',
        );
      }
    } catch {
      setNextStepsError(
        '下一步生成失败：后端未返回，请确认后端在运行后重新提交。用例行里的规则修复仍然可用。',
      );
    } finally {
      setNextStepsBusy(false);
    }
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
      const r = await evaluateOnServer<SubmissionAssessmentDTO>(
        'submission',
        {
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
        },
        designRef.current,
        problemRef.current.id,
      );
      setAssessorLabel(r.label);
      setAssessment(r.data);
      setAssessmentCoverage(r.actionCoverage ?? null);
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
    if (preview) return; // a preview must be confirmed or abandoned first
    setUndoFix(null);
    if (phase === 'design') submitDesign();
    void runSuiteNow();
  };

  /** LeetCode's Run: start the live simulation (or pause/resume it). */
  const onRun = () => {
    if (preview) return;
    if (phase === 'design') {
      submitDesign();
    } else {
      setRunning(!running);
    }
  };

  // ------------------------------------------------------- quick sim ---
  /** Start a quick scenario on the CURRENT design: local visual preview. */
  const startQuickSim = (sc: QuickScenario) => {
    setPreview(null);
    engine.reviveAll();
    engine.clearEvents();
    engine.setTraffic(sc.traffic);
    simRef.current = {
      sc,
      tick: 0,
      events: [...sc.events].sort((a, b) => a.atTick - b.atTick),
      kills: [...sc.kills].sort((a, b) => a.atTick - b.atTick),
    };
    queueMaxRef.current = 0;
    setActiveSim(sc);
    setSimReadout(null);
    if (phase === 'design') setPhase('run');
    setRunning(true);
  };

  /** Wind a quick sim down: restore the user's traffic, revive everything. */
  const finishQuickSim = () => {
    simRef.current = null;
    setActiveSim(null);
    engine.reviveAll();
    engine.clearEvents();
    engine.setTraffic(traffic);
  };

  const stopQuickSim = () => {
    finishQuickSim();
    setSimReadout((r) => (r ? { ...r, done: true } : r));
  };

  /** The scenario behind a judged case row (hidden ones fetched on demand). */
  const scenarioForCase = async (tc: ProblemCaseDTO): Promise<QuickScenario> => {
    if (!tc.locked) return scenarioFromCase(tc);
    const name = suite?.results.find((r) => r.caseId === tc.id)?.name ?? tc.name;
    const { scenario } = await fetchCaseScenario(problemRef.current.id, tc.id);
    return scenarioFromExecuted(`case:${tc.id}`, name, '🧪', scenario);
  };

  const quickSimCase = async (tc: ProblemCaseDTO) => {
    try {
      startQuickSim(await scenarioForCase(tc));
    } catch {
      setFixNotice('快速模拟启动失败：后端未返回该用例的场景数据，请确认后端在运行。');
    }
  };

  const quickSimProbe = (r: VerifiedProbeDTO) => {
    const sc = scenarioFromProbe(r);
    if (sc) startQuickSim(sc);
  };

  // ------------------------------------------------------------- pins ----
  const pinnedList = pins[problemId] ?? [];
  const pinnedIds = new Set(pinnedList.map((p) => p.id));

  const togglePin = (sc: QuickScenario) => {
    setPins((prev) => {
      const list = prev[problemId] ?? [];
      const exists = list.some((p) => p.id === sc.id);
      const next = exists
        ? list.filter((p) => p.id !== sc.id)
        : [...list, sc].slice(-MAX_PINS_PER_PROBLEM);
      return { ...prev, [problemId]: next };
    });
  };

  const pinCase = async (tc: ProblemCaseDTO) => {
    if (pinnedIds.has(`case:${tc.id}`)) {
      togglePin(scenarioFromCase(tc)); // id is what matters for unpinning
      return;
    }
    try {
      togglePin(await scenarioForCase(tc));
    } catch {
      setFixNotice('固定失败：后端未返回该用例的场景数据。');
    }
  };

  const pinProbe = (r: VerifiedProbeDTO) => {
    const sc = scenarioFromProbe(r);
    if (sc) togglePin(sc);
  };

  // ---------------------------------------------------------- fix loop ---
  /**
   * Enter preview mode for one finding's actions. The actions were
   * validated server-side against the design snapshot they were generated
   * for; re-check them against the CURRENT design first — if the user has
   * since deleted a referenced node, refuse gracefully instead of
   * applying a stale fix.
   */
  const enterPreview = (title: string, actions: EditOpDTO[]) => {
    const valid = recheckActions(actions, designRef.current);
    if (!valid.length) {
      setFixNotice('这条改进引用的组件在当前设计里已不存在（设计已被改动），无法应用。');
      return;
    }
    stopQuickSim();
    setFixNotice(null);
    setPreview({ title, plan: applyActions(designRef.current, valid) });
    setSelectedId(null);
    setConnectMode(false);
    setConnectFrom(null);
    setRightView('arch');
  };

  const cancelPreview = () => setPreview(null);

  /**
   * Commit the previewed design. The score does NOT move: suite results
   * on screen stay the last submission's until a re-submit re-judges.
   * Applying from the report phase returns to the design phase with the
   * results kept visible (now labelled stale by the notice).
   */
  const confirmApply = () => {
    if (!preview) return;
    setUndoFix({ design: designRef.current, title: preview.title });
    setDesign(preview.plan.design);
    setPreview(null);
    if (phase !== 'design') {
      setPhase('design');
      setRunning(false);
      setSnapshot(null);
      setActiveSim(null);
      simRef.current = null;
      engine.reviveAll();
      engine.clearEvents();
    }
    setFixNotice(
      `已应用改进「${preview.title}」。分数不会自动变化——当前成绩仍是上次提交的结果，重新提交后才重新判卷；想先看效果，点上方场景快捷栏试跑。`,
    );
  };

  const undoApply = () => {
    if (!undoFix) return;
    setDesign(undoFix.design);
    setUndoFix(null);
    setFixNotice('已撤销刚才应用的改进，设计已恢复。');
  };

  // ------------------------------------------------------ schema fix loop -
  /**
   * Enter preview mode for one schema suggestion's ops. The ops were
   * validated server-side against the SUBMITTED schema; re-check them
   * against the CURRENT draft first — if the user has since renamed or
   * dropped the target table/field, refuse gracefully. The preview is
   * pure computation; confirming swaps the draft and offers one-step
   * undo. Applying switches the right workspace to 数据库设计 so the
   * user sees the change list where the draft lives.
   */
  const enterSchemaPreview = (title: string, actions: SchemaOpDTO[]) => {
    const draft = schemasRef.current[problemRef.current.id]!;
    const valid = recheckSchemaOps(actions, draft);
    if (!valid.length) {
      setFixNotice('这条建议引用的表/字段在当前数据库草稿里已不存在或已是目标状态（草稿已被改动），无法应用。');
      setRightView('schema');
      return;
    }
    setFixNotice(null);
    setSchemaPreview({ title, plan: applySchemaOpsPreview(draft, valid) });
    setRightView('schema');
  };

  const confirmSchemaApply = () => {
    if (!schemaPreview) return;
    const pid = problemRef.current.id;
    setUndoSchemaFix({ schema: schemasRef.current[pid]!, title: schemaPreview.title });
    setSchemas({ ...schemasRef.current, [pid]: schemaPreview.plan.schema });
    setSchemaPreview(null);
    setFixNotice(
      `已应用数据库改进「${schemaPreview.title}」。这只改了数据库设计草稿——评审结论仍是上次提交的，重新提交后才会重新评审。`,
    );
  };

  const undoSchemaApply = () => {
    if (!undoSchemaFix) return;
    const pid = problemRef.current.id;
    setSchemas({ ...schemasRef.current, [pid]: undoSchemaFix.schema });
    setUndoSchemaFix(null);
    setFixNotice('已撤销刚才应用的数据库改进，草稿已恢复。');
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
  // The built-in node-failure scenario kills the busiest node type: by
  // live utilization when the sim has run, else the first app-tier node.
  const busiestType: ComponentTypeId = (() => {
    if (snapshot) {
      let best: ComponentTypeId | undefined;
      let bestUtil = -1;
      for (const n of design.nodes) {
        if (n.type === 'client') continue;
        const u = snapshot.nodes[n.id]?.util ?? 0;
        if (u > bestUtil) {
          bestUtil = u;
          best = n.type;
        }
      }
      if (best) return best;
    }
    return (
      design.nodes.find((n) => ['appserver', 'feedservice', 'searchservice'].includes(n.type))
        ?.type ??
      design.nodes.find((n) => n.type !== 'client')?.type ??
      'appserver'
    );
  })();
  const builtins = builtinScenarios(problem, busiestType);
  // During a fix preview the canvas renders the WOULD-BE design; the
  // committed design state (and the engine) stay untouched until confirm.
  const displayDesign = preview ? preview.plan.design : design;
  // The results page owns step 3; within the design screen the sim phase
  // drives the indicator as before.
  const stepIndex = view === 'results' ? 2 : phase === 'design' ? 0 : 1;
  // The on-screen results belong to submittedSnapshot; any later edit of
  // the design or the schema (possible right here on the results page)
  // makes them stale until the next submit re-judges.
  const resultsStale =
    !!suite &&
    !!submittedSnapshot &&
    (submittedSnapshot.design !== JSON.stringify(design) ||
      submittedSnapshot.schema !== JSON.stringify(schemas[problemId] ?? problem.schema));
  const nextHint =
    view === 'results'
      ? '下一步：在左侧按页签看判卷结果、AI 点评、探测用例与数据库评审；想改设计，点左侧「✏️ 解锁修改」或直接应用某条改进，改完重新提交。'
      : phase === 'design'
        ? '下一步：在右侧「架构设计」画布上完成设计（表结构在右侧「数据库设计」视图里交卷），然后点「提交设计」判卷——或先点「▶ 运行」看它跑起来。'
        : phase === 'run'
          ? '下一步：设计已锁定、模拟运行中。可以注入场景、杀节点观察现象，或点「提交设计」跑全部用例判卷。'
          : '下一步：本轮结果还在——点上方「📊 查看结果」回结果页，或点「↩ 返回设计」解锁画布重做一轮。';

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
          <button className="lc-run-btn" onClick={onRun} disabled={!!preview} title={preview ? '先确认或放弃改进预览' : undefined}>
            {phase !== 'design' && running ? '⏸ 暂停' : '▶ 运行'}
          </button>
          <button className="lc-submit-btn" onClick={onSubmit} disabled={!!preview} title={preview ? '先确认或放弃改进预览' : undefined}>
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
          <span
            key={label}
            className={`lc-step ${i === stepIndex ? 'active' : i < stepIndex ? 'done' : ''} ${i < 2 || suite ? 'clickable' : ''}`}
            onClick={() => {
              if (i < 2) setView('design');
              else if (suite) setView('results');
            }}
            title={i < 2 ? '回设计页' : suite ? '看本轮结果' : '提交后可看'}
          >
            {i + 1} {label}
            {i < 2 && <span className="lc-step-arrow">→</span>}
          </span>
        ))}
        {suite && view === 'design' && (
          <button className="lc-goto-results" onClick={() => setView('results')}>
            📊 查看结果 →
          </button>
        )}
        {view === 'results' && (
          <button className="lc-goto-results" onClick={() => setView('design')}>
            ← 返回设计
          </button>
        )}
        <span className="lc-next-hint">{nextHint}</span>
      </div>

      <div className="lc-body">
        {/* ------------------------- left column: problem (design view) --- */}
        {view === 'design' ? (
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
                    ? ' 已判卷：点上方「📊 查看结果」到结果页逐例看判定。'
                    : ' 点右上角「提交设计」跑全部用例。'}
                </p>
                <CaseList
                  problem={problem}
                  suite={suite}
                  quickSimId={activeSim?.id ?? null}
                  pinnedIds={pinnedIds}
                  onQuickSim={(tc) => void quickSimCase(tc)}
                  onStopSim={stopQuickSim}
                  onPinToggle={(tc) => void pinCase(tc)}
                  onApplyFix={enterPreview}
                />
                <h4 style={{ margin: '18px 0 8px' }}>🧱 结构检查（确定性规则，不依赖 LLM）</h4>
                <StructuralList
                  structural={structural}
                  onSelectNode={(id) => setSelectedId(id)}
                  onApplyFix={enterPreview}
                />
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
                      <div
                        key={i}
                        className="case-row sub-clickable"
                        onClick={() => {
                          setResultsTab('judge');
                          setView('results');
                        }}
                        title="打开结果页（展示最近一次提交的完整结果）"
                      >
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
                    <p className="hint" style={{ margin: 0 }}>
                      点任意一条打开结果页（记录只存分数，页面展示最近一次提交的完整结果）。
                    </p>
                  </div>
                )}
              </div>
            )}

          </div>
        </aside>
        ) : (
        /* ------------------------- left column: results (results view) -- */
        <aside className="lc-left lc-left-results">
          <div className="res-head">
            <button onClick={() => setView('design')}>← 返回设计</button>
            <b>📊 提交结果</b>
            {suite && (
              <span style={{ marginLeft: 'auto', fontSize: 13 }}>
                <b style={{ color: scoreColor(suite.scorePct), fontSize: 15 }}>{suite.scorePct} 分</b>
                <span style={{ color: '#94a3b8' }}>
                  （{suite.passedCount}/{suite.totalCount}）
                </span>
              </span>
            )}
          </div>
          {(probeBusy || assessmentBusy || schemaBusy || nextStepsBusy) && (
            <div className="res-progress">
              ⏳ 评审流程进行中：
              {[
                probeBusy && '探测用例生成 + 仿真验证',
                assessmentBusy && '提交点评',
                schemaBusy && '数据库评审',
                nextStepsBusy && '下一步建议',
              ]
                .filter(Boolean)
                .join(' · ')}
              …
            </div>
          )}
          {resultsStale && (
            <div className="res-stale">
              ⚠️ 设计已修改，下方结果为上次提交的——重新提交后才会刷新。
            </div>
          )}
          {suite && phase !== 'design' && (
            <button className="res-unlock" onClick={unlockForFix}>
              ✏️ 解锁右侧设计来修改（结果保留在左侧，改完重新提交）
            </button>
          )}
          <div className="lc-tabs">
            {RESULTS_TABS.map((t) => (
              <button
                key={t.id}
                className={`lc-tab ${resultsTab === t.id ? 'active' : ''}`}
                onClick={() => setResultsTab(t.id)}
              >
                {t.label}
                {t.id === 'judge' && suite && (
                  <span className="lc-tab-badge">
                    {suite.passedCount}/{suite.totalCount}
                  </span>
                )}
                {t.id === 'probe' && probeResults && (
                  <span className="lc-tab-badge">{probeResults.length}</span>
                )}
              </button>
            ))}
          </div>

          <div className="lc-tab-body">
            {resultsTab === 'judge' && (
              <div>
                {suite ? (
                  <>
                    <div className="res-score-strip">
                      <span>
                        本轮成绩：
                        <b style={{ color: scoreColor(suite.scorePct) }}>{suite.scorePct} 分</b>
                        （{suite.passedCount}/{suite.totalCount} 个用例通过）
                      </span>
                      <button onClick={onSubmit}>⟳ 重新判卷</button>
                    </div>
                    <NextStepsSection
                      busy={nextStepsBusy}
                      error={nextStepsError}
                      note={nextStepsNote}
                      steps={nextSteps}
                      caseNames={Object.fromEntries(suite.results.map((r) => [r.caseId, r.name]))}
                      sourceLabel={nextStepsLabel}
                      coverage={nextStepsCoverage}
                      onApplyFix={enterPreview}
                    />
                    <CaseList
                      problem={problem}
                      suite={suite}
                      quickSimId={activeSim?.id ?? null}
                      pinnedIds={pinnedIds}
                      onQuickSim={(tc) => void quickSimCase(tc)}
                      onStopSim={stopQuickSim}
                      onPinToggle={(tc) => void pinCase(tc)}
                      onApplyFix={enterPreview}
                    />
                    {/* Structural checks are computed by the judge call
                        alongside the scores — deterministic results live
                        with the judging tab, NOT under the AI review. */}
                    <h4 style={{ margin: '18px 0 8px' }}>🧱 结构检查（确定性规则，不依赖 LLM）</h4>
                    <StructuralList
                      structural={structural}
                      onSelectNode={(id) => setSelectedId(id)}
                      onApplyFix={enterPreview}
                    />
                  </>
                ) : (
                  <p className="hint" style={{ marginTop: 0 }}>
                    尚未提交。回设计页完成设计后点「提交设计」，逐例判卷结果会出现在这里。
                  </p>
                )}
              </div>
            )}

            {resultsTab === 'review' && (
              <div>
                {/* Qualitative review — backend evaluate call only. */}
                <div style={{ border: '1px solid #1e293b', borderRadius: 8, padding: '10px 12px', background: '#0b1220' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <b>🧑‍⚖️ 评审员点评</b>
                    {assessorLabel && (
                      <span style={{ color: '#94a3b8', fontSize: 12 }}>评审：{assessorLabel}（分数本身由代码判卷）</span>
                    )}
                    <button
                      style={{ marginLeft: 'auto' }}
                      disabled={!suite || assessmentBusy || probeBusy}
                      onClick={() => suite && void runAssessment(suite)}
                    >
                      {assessmentBusy || probeBusy ? '评审生成中…' : assessment ? '重新评审' : '让评审员点评这次提交'}
                    </button>
                  </div>
                  {!suite && (
                    <div style={{ color: '#94a3b8', fontSize: 13, marginTop: 6 }}>
                      尚未提交——提交后，评审员点评会出现在这里。
                    </div>
                  )}
                  {(assessmentBusy || probeBusy) && !assessment && suite && (
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
                              {f.actions && f.actions.length > 0 && (
                                <>
                                  <button
                                    style={{ marginLeft: 8 }}
                                    onClick={() => enterPreview(f.title, f.actions!)}
                                  >
                                    ✨ 应用此改进
                                  </button>
                                  {f.actionSource && <ActionSourceLabel source={f.actionSource} />}
                                </>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                      {assessmentCoverage && <CoverageLine coverage={assessmentCoverage} />}
                    </div>
                  )}
                </div>
              </div>
            )}

            {resultsTab === 'probe' && (
              <ProbeSection
                busy={probeBusy}
                note={
                  suite
                    ? probeNote
                    : '尚未提交——提交后，LLM 针对这份设计提出的探测用例会在这里经仿真验证后呈现。'
                }
                results={probeResults}
                sourceLabel={probeLabel}
                coverage={probeCoverage}
                quickSimId={activeSim?.id ?? null}
                pinnedIds={pinnedIds}
                onQuickSim={quickSimProbe}
                onStopSim={stopQuickSim}
                onPinToggle={pinProbe}
                onApplyFix={enterPreview}
              />
            )}

            {resultsTab === 'schema' && (
              <div>
                {schemaBusy && (
                  <div style={{ color: '#94a3b8', fontSize: 13, marginBottom: 8 }}>
                    数据库评审生成中…（和提交是同一次评审，稍等）
                  </div>
                )}
                {schemaError && (
                  <div style={{ color: '#fca5a5', fontSize: 13, marginBottom: 8 }}>⚠️ {schemaError}</div>
                )}
                {schemaAssessment ? (
                  <>
                    <SchemaAssessmentView
                      assessment={schemaAssessment}
                      label={schemaLabel || undefined}
                      onApplySuggestion={enterSchemaPreview}
                    />
                    {schemaCoverage && <CoverageLine coverage={schemaCoverage} />}
                  </>
                ) : (
                  !schemaBusy && (
                    <p className="hint" style={{ marginTop: 0 }}>
                      {suite
                        ? '本轮没有产出数据库评审结论——下方确定性信号仍然有效。'
                        : '尚未提交——提交后，数据库的 AI 评审结论会出现在这里，和其他评审放在一起。'}
                    </p>
                  )
                )}
                {schemaSignals && (
                  <>
                    <h4 style={{ margin: '16px 0 8px' }}>🧮 确定性信号（代码规则，不依赖 LLM）</h4>
                    <SchemaSignalsView signals={schemaSignals} />
                  </>
                )}
                {submittedSchemaSim && (
                  <>
                    <h4 style={{ margin: '16px 0 8px' }}>🧪 数据库模拟实测（服务端按需求流量重跑）</h4>
                    <SchemaSimView sim={submittedSchemaSim} compact />
                  </>
                )}
              </div>
            )}
          </div>
        </aside>
        )}

        {/* ------------------------------------------------- workspace --- */}
        <section className="lc-workspace">
          {judgeError && <div className="judge-error-strip">⚠️ {judgeError}</div>}
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
                    disabled={locked || !!preview}
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
                disabled={locked || !!preview}
                title="连线模式：点起点再点终点"
              >
                {connectMode ? '连线中…' : '🔗 连线'}
              </button>
              <button onClick={() => setDesign(structuredClone(problem.sampleDesign))} disabled={locked || !!preview}>
                示例
              </button>
              <button onClick={() => setDesign({ nodes: [], edges: [] })} disabled={locked || !!preview}>
                清空
              </button>
            </div>
          </div>

          {/* scenario bar: one-click quick simulations on the current
              design — built-in presets + scenarios pinned from judged
              case rows / verified probe cards. Local preview only. */}
          <div className="scenario-bar">
            <span className="scenario-label">⚡ 场景快捷</span>
            {builtins.map((sc) => (
              <button
                key={sc.id}
                className={activeSim?.id === sc.id ? 'scenario-active' : ''}
                onClick={() => (activeSim?.id === sc.id ? stopQuickSim() : startQuickSim(sc))}
                title="在当前设计上本地试跑这个场景（只看现象，不判卷）"
              >
                {sc.icon} {sc.label}
              </button>
            ))}
            {pinnedList.map((sc) => (
              <span key={sc.id} className="scenario-pin">
                <button
                  className={activeSim?.id === sc.id ? 'scenario-active' : ''}
                  onClick={() => (activeSim?.id === sc.id ? stopQuickSim() : startQuickSim(sc))}
                  title="已固定的用例场景：在当前设计上本地试跑（只看现象，不判卷）"
                >
                  📌 {sc.label}
                </button>
                <button className="scenario-unpin" onClick={() => togglePin(sc)} title="取消固定">
                  ✕
                </button>
              </span>
            ))}
            {activeSim && <button onClick={stopQuickSim}>⏹ 停止</button>}
            <span className="scenario-note">本地预览 · 不判卷不改分</span>
          </div>

          {/* one-step undo for the last applied fix */}
          {undoFix && !preview && (
            <div className="undo-bar">
              <span>已应用改进「{undoFix.title}」</span>
              <button onClick={undoApply}>↩ 撤销</button>
              <button onClick={() => setUndoFix(null)}>忽略</button>
            </div>
          )}

          {/* fix preview: what will change, highlighted on the canvas */}
          {preview && (
            <div className="preview-bar">
              <div className="preview-head">
                <b>👀 改进预览：{preview.title}</b>
                <span>尚未应用——画布上发光的是新增、带「改」徽章的是参数变更，确认后才真正生效。</span>
              </div>
              <ul className="preview-changes">
                {preview.plan.descriptions.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
              <div className="preview-actions">
                <button className="primary" onClick={confirmApply}>
                  ✔ 确认应用
                </button>
                <button onClick={cancelPreview}>放弃（Esc）</button>
                <span className="preview-note">
                  应用不改分：成绩仍是上次提交的结果，重新提交后才重新判卷。
                </span>
              </div>
            </div>
          )}

          {/* quick-sim live readout: measured vs the case's thresholds */}
          {simReadout && (
            <div className="sim-readout">
              <span className="sim-readout-title">
                {simReadout.sc.icon} {simReadout.sc.label} · 本地快速模拟
                {simReadout.done ? '（已结束）' : '进行中'} — 只看现象，不判卷不改分
              </span>
              {readoutRows(simReadout.sc, simReadout.snap, simReadout.queueDepthMax).map((r) => (
                <span
                  key={r.label}
                  className={`sim-readout-item ${r.ok === undefined ? '' : r.ok ? 'ok' : 'over'}`}
                >
                  {r.label} <b>{r.text}</b>
                </span>
              ))}
              <button className="sim-readout-close" onClick={() => setSimReadout(null)} title="关闭读数">
                ✕
              </button>
            </div>
          )}

          {/* canvas: the dominant area */}
          <div className="canvas-area">
            <Canvas
              design={displayDesign}
              snapshot={snapshot}
              selectedId={selectedId}
              highlighted={highlights}
              running={running && phase !== 'design'}
              connectMode={connectMode}
              connectFrom={connectFrom}
              marks={preview?.plan.marks ?? null}
              onNodePress={onNodePress}
              onMove={(id, x, y) => {
                if (locked || preview) return;
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
            {activeSim && (
              <div className="metric compact event-metric">
                <span>快速模拟中</span>
                <b>{activeSim.icon} {activeSim.label}</b>
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
              nothing. The panel shows the editor + deterministic checker
              signals only; the AI schema review lives in the results
              page's 「数据库评审」 tab. */}
          <div
            className="ws-view ws-view-schema"
            style={{ display: rightView === 'schema' ? 'flex' : 'none' }}
          >
            {/* schema fix preview: what the suggestion will change in the
                draft (table / field / old → new), confirm before it lands */}
            {schemaPreview && (
              <div className="preview-bar">
                <div className="preview-head">
                  <b>👀 数据库改进预览：{schemaPreview.title}</b>
                  <span>尚未应用——下面是这条建议对数据库设计草稿的全部改动，确认后才真正生效。</span>
                </div>
                <ul className="preview-changes">
                  {schemaPreview.plan.descriptions.map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
                <div className="preview-actions">
                  <button className="primary" onClick={confirmSchemaApply}>
                    ✔ 确认应用
                  </button>
                  <button onClick={() => setSchemaPreview(null)}>放弃（Esc）</button>
                  <span className="preview-note">
                    只改草稿：评审结论仍是上次提交的，重新提交后才重新评审。
                  </span>
                </div>
              </div>
            )}
            {/* one-step undo for the last applied schema fix */}
            {undoSchemaFix && !schemaPreview && (
              <div className="undo-bar">
                <span>已应用数据库改进「{undoSchemaFix.title}」</span>
                <button onClick={undoSchemaApply}>↩ 撤销</button>
                <button onClick={() => setUndoSchemaFix(null)}>忽略</button>
              </div>
            )}
            <SchemaPanel
              schema={schemas[problem.id]!}
              snapshot={snapshot}
              signals={schemaSignals}
              sim={schemaSims[problem.id]?.sim ?? null}
              simBusy={schemaSimBusy}
              simError={schemaSimError}
              simStale={
                !!schemaSims[problem.id] &&
                schemaSims[problem.id]!.fingerprint !== JSON.stringify(schemas[problem.id]!)
              }
              onRunSim={() => void runSchemaSim()}
              onChange={(s) => setSchemas({ ...schemas, [problem.id]: s })}
            />
          </div>

          {/* fix-loop notice (applied / refused / undone) */}
          {fixNotice && (
            <div className="fix-notice">
              <span>ℹ️ {fixNotice}</span>
              <button onClick={() => setFixNotice(null)} title="关闭">
                ✕
              </button>
            </div>
          )}


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
