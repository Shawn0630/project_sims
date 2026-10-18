import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ActionCoverage } from '@sds/driver';

/**
 * LLM call log — every evaluation that flows through /api/evaluate (and,
 * later, the problem generator) leaves one record here: when, which kind,
 * which model, the FULL request that was sent, the FULL response that came
 * back, how long it took, and whether the answer came from the LLM or the
 * scripted fallback.
 *
 * Storage is a JSONL file on the server (data/llm-calls.jsonl). Records can
 * contain user design data, so the file is LOCAL ONLY: it is gitignored
 * and never leaves this machine.
 */

export interface LlmCallRecord {
  id: string;
  /** ISO timestamp. */
  ts: string;
  kind:
    | 'submission'
    | 'schema'
    | 'followups'
    | 'probe'
    | 'generate'
    | 'next-steps'
    | 'schema-probe'
    | 'schema-next-steps';
  /** llm = a real model call was made; scripted = deterministic fallback. */
  source: 'llm' | 'scripted';
  ok: boolean;
  /** Host of the configured endpoint (never the key). */
  baseUrlHost: string;
  model: string;
  /** Name of the model profile this call resolved to (admin-given label). */
  profileName?: string;
  /**
   * True when an end user picked this profile for this one call via
   * /api/evaluate's profileId (only admin-opened, userSelectable profiles
   * can be picked); false/absent = the server's active default was used.
   */
  viaUserChoice?: boolean;
  durationMs: number;
  /** Token usage exactly as the upstream returned it, when it returned any. */
  usage?: unknown;
  /**
   * For llm calls: the exact request body sent ({ model, messages, ... }).
   * For scripted calls: the assembled evaluation context that was consumed.
   */
  request: unknown;
  /** Raw text the model returned (llm calls only). */
  responseRaw?: string;
  /** The structured result after defensive parsing / scripted generation. */
  responseParsed?: unknown;
  /**
   * Action-guarantee accounting (submission / probe / schema calls): how
   * many assessed findings shipped ≥1 validated action, by provenance.
   * The logged responseParsed is the ENRICHED result (ladder already run).
   */
  actionCoverage?: ActionCoverage;
  /**
   * How many HTTP attempts this logical call took (llm calls only).
   * > 1 means transient upstream failures were retried before the outcome.
   */
  attempts?: number;
  /** Error message of each failed attempt, in order (llm calls only). */
  attemptErrors?: string[];
  error?: string;
  note?: string;
}

export const CALLS_FILE = fileURLToPath(new URL('../data/llm-calls.jsonl', import.meta.url));

let seq = 0;
let appendChain: Promise<void> = Promise.resolve();

/** Append one record. Fire-and-forget: logging must never break evaluation. */
export function appendCall(rec: Omit<LlmCallRecord, 'id' | 'ts'>): void {
  const full: LlmCallRecord = {
    ...rec,
    id: `call-${Date.now().toString(36)}-${(seq += 1)}`,
    ts: new Date().toISOString(),
  };
  // Serialize appends through a chain so records land in call order — a
  // fallback entry that says "see the previous record" must actually have
  // that record above it in the file.
  appendChain = appendChain.then(async () => {
    try {
      await mkdir(path.dirname(CALLS_FILE), { recursive: true });
      await appendFile(CALLS_FILE, `${JSON.stringify(full)}\n`, 'utf8');
    } catch {
      /* local log only — swallow */
    }
  });
}

/** Most recent N records, newest first. */
export async function listCalls(limit = 50): Promise<LlmCallRecord[]> {
  const n = Math.max(1, Math.min(500, Math.floor(limit) || 50));
  let raw: string;
  try {
    raw = await readFile(CALLS_FILE, 'utf8');
  } catch {
    return [];
  }
  const out: LlmCallRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LlmCallRecord);
    } catch {
      /* skip a torn line */
    }
  }
  return out.slice(-n).reverse();
}
