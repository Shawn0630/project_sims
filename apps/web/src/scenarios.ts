import type { ComponentTypeId } from '@sds/components';
import type { TrafficConfig } from '@sds/sim-core';
import type {
  CaseThresholdsDTO,
  ExecutedScenarioDTO,
  ProblemCaseDTO,
  ProblemPack,
  VerifiedProbeDTO,
} from './api';

/**
 * Quick scenarios for the scenario bar above the canvas.
 *
 * A quick scenario is a concrete, executable simulation spec (traffic,
 * timed events, timed kills, duration — plus the thresholds it is judged
 * against, when it comes from a judged case). Running one is a LOCAL
 * VISUAL preview on the current design: the animated flow + a live
 * measured-vs-threshold readout. It never re-judges and never changes
 * the score — only a fresh 「提交设计」 does that.
 *
 * Sources:
 *  - built-ins: generic operator presets (viral post, traffic peak, node
 *    failure, read/write flip), computed from the pack's scale facts;
 *  - suite cases: visible ones from the pack, hidden ones fetched
 *    one-at-a-time from the backend AFTER a submission revealed them;
 *  - verified probes: the scenario the backend actually executed.
 *
 * Pinned scenarios persist per problem in localStorage.
 */
export interface QuickScenario {
  id: string;
  label: string;
  icon: string;
  traffic: TrafficConfig;
  durationTicks: number;
  events: ExecutedScenarioDTO['events'];
  kills: ExecutedScenarioDTO['kills'];
  thresholds?: CaseThresholdsDTO;
}

export function scenarioFromExecuted(
  id: string,
  label: string,
  icon: string,
  sc: ExecutedScenarioDTO,
): QuickScenario {
  return {
    id,
    label,
    icon,
    traffic: sc.traffic,
    durationTicks: sc.durationTicks,
    events: sc.events ?? [],
    kills: sc.kills ?? [],
    thresholds: sc.thresholds,
  };
}

export function scenarioFromCase(tc: ProblemCaseDTO): QuickScenario {
  return scenarioFromExecuted(`case:${tc.id}`, tc.name, '🧪', {
    traffic: tc.traffic,
    durationTicks: tc.durationTicks,
    events: tc.events ?? [],
    kills: tc.kills ?? [],
    thresholds: tc.thresholds,
  });
}

export function scenarioFromProbe(r: VerifiedProbeDTO): QuickScenario | null {
  if (!r.scenario) return null;
  return scenarioFromExecuted(`probe:${r.name}`, `探测 · ${r.name}`, '🔬', r.scenario);
}

/**
 * The built-in quick scenarios. The node-failure one kills the given node
 * type — the caller picks the BUSIEST type (live utilization when a
 * snapshot exists, else the design's first app-tier node).
 */
export function builtinScenarios(
  problem: ProblemPack,
  killType: ComponentTypeId,
): QuickScenario[] {
  const base = problem.scale.baselineRps;
  const rr = problem.scale.readRatio;
  return [
    {
      id: 'builtin:viral',
      label: '网红暴帖',
      icon: '🔥',
      traffic: { rps: Math.round(base * 1.5), readRatio: rr },
      durationTicks: 40,
      events: [{ atTick: 2, type: 'viral_post', magnitude: 4, durationTicks: 34 }],
      kills: [],
    },
    {
      id: 'builtin:peak',
      label: '流量洪峰',
      icon: '🌊',
      traffic: { rps: base, readRatio: rr },
      durationTicks: 36,
      events: [
        { atTick: 2, type: 'peak', magnitude: problem.scale.peakMultiplier, durationTicks: 30 },
      ],
      kills: [],
    },
    {
      id: 'builtin:kill',
      label: '节点故障',
      icon: '💥',
      traffic: { rps: Math.round(base * problem.scale.peakMultiplier * 0.85), readRatio: rr },
      durationTicks: 36,
      events: [],
      kills: [{ componentType: killType, atTick: 3 }],
    },
    {
      id: 'builtin:rwflip',
      label: '读写比翻转',
      icon: '🔀',
      traffic: { rps: Math.round(base * 1.7), readRatio: rr },
      durationTicks: 36,
      events: [{ atTick: 2, type: 'rw_flip', magnitude: 1, durationTicks: 30 }],
      kills: [],
    },
  ];
}

// ------------------------------------------------------------- pin store ---

const PINS_KEY = 'sds-pinned-scenarios-v1';
export const MAX_PINS_PER_PROBLEM = 8;

export function loadPins(): Record<string, QuickScenario[]> {
  try {
    const raw = localStorage.getItem(PINS_KEY);
    if (raw) return JSON.parse(raw) as Record<string, QuickScenario[]>;
  } catch {
    /* ignore */
  }
  return {};
}

export function savePins(pins: Record<string, QuickScenario[]>): void {
  try {
    localStorage.setItem(PINS_KEY, JSON.stringify(pins));
  } catch {
    /* ignore */
  }
}
