import type { ProblemDef, TestCase } from '@sds/problems';

/**
 * Client-safe projection of a problem pack.
 *
 * The pack served to the browser is RENDERING data: statement, scale,
 * workload profile, schema draft, sample design, and the VISIBLE test cases
 * in full. Hidden edge cases are reduced to { id, name, hidden, weight,
 * locked: true } with neutral placeholder fields — their traffic, events,
 * kills, thresholds and hints are the eval system's secrets and never leave
 * the server. They are revealed only as judge RESULTS (POST
 * /api/submissions/judge), after a submission exists.
 */
export type ClientTestCase = TestCase & { locked: boolean };

export type ClientProblemPack = Omit<ProblemDef, 'testCases' | 'referenceSolution'> & {
  testCases: ClientTestCase[];
};

export function toClientCase(tc: TestCase): ClientTestCase {
  if (!tc.hidden) return { ...tc, locked: false };
  return {
    id: tc.id,
    name: tc.name,
    description: '隐藏用例：场景与阈值在提交判卷后揭示。',
    hidden: true,
    weight: tc.weight,
    // Neutral placeholders so the shape stays a valid TestCase for the UI.
    // locked=true tells the client this row carries no real scenario data
    // (in particular: it cannot be replayed locally).
    traffic: { rps: 0, readRatio: 0.5 },
    durationTicks: 1,
    thresholds: {},
    locked: true,
  };
}

export function toClientPack(pack: ProblemDef): ClientProblemPack {
  // referenceSolution is the admin-only model answer: it must NEVER reach
  // the solver app, so it is dropped here — the single projection every
  // solver-facing pack response flows through.
  const { referenceSolution: _referenceSolution, ...rest } = pack;
  return { ...rest, testCases: pack.testCases.map(toClientCase) };
}
