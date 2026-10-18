import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  kind: 'submission' | 'schema' | 'followups' | 'generate';
  /** llm = a real model call was made; scripted = deterministic fallback. */
  source: 'llm' | 'scripted';
  ok: boolean;
  /** Host of the configured endpoint (never the key). */
  baseUrlHost: string;
  model: string;
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
  error?: string;
  note?: string;
}

export const CALLS_FILE = fileURLToPath(new URL('../data/llm-calls.jsonl', import.meta.url));

let seq = 0;

/** Append one record. Fire-and-forget: logging must never break evaluation. */
export function appendCall(rec: Omit<LlmCallRecord, 'id' | 'ts'>): void {
  const full: LlmCallRecord = {
    ...rec,
    id: `call-${Date.now().toString(36)}-${(seq += 1)}`,
    ts: new Date().toISOString(),
  };
  void (async () => {
    try {
      await mkdir(path.dirname(CALLS_FILE), { recursive: true });
      await appendFile(CALLS_FILE, `${JSON.stringify(full)}\n`, 'utf8');
    } catch {
      /* local log only — swallow */
    }
  })();
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
