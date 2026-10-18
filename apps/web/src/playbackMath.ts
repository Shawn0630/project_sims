/**
 * Latency-playback math — PURE functions (unit-checked by exercises, no
 * DOM, no timers). The honesty contract of the schema-sim playback:
 *
 *  - Every duration derives from the simulate response's own P99 numbers.
 *    The UI never invents a measurement.
 *  - One playback SET (a single run, or a 对比竞速 pair) shares ONE
 *    compression factor, so relative durations inside the set stay
 *    truthful: a 100× slower query takes 100× longer on screen.
 *  - Compression scales so the SLOWEST item in the set plays in
 *    ≈ TARGET_SLOWEST_MS, and no item is instant-invisible (floor
 *    FLOOR_MS). Playback time is LABELED with its compression wherever
 *    it is shown; only the explicit 实时模式 runs 1:1 （真实等待）.
 */

export const TARGET_SLOWEST_MS = 4500;
export const FLOOR_MS = 200;

export interface PlaybackItem {
  id: string;
  /** The sim's measured P99 for this item (ms) — the ONLY time source. */
  realMs: number;
}

export interface PlaybackPlan {
  /** Declared time compression: playback ms = real ms / compression. */
  compression: number;
  /** Playback duration per item id (wall-clock ms on screen). */
  durationsMs: Record<string, number>;
}

/** Compressed plan for one set: shared compression, floor + cap applied. */
export function planPlayback(
  items: PlaybackItem[],
  opts: { targetSlowestMs?: number; floorMs?: number } = {},
): PlaybackPlan {
  const target = opts.targetSlowestMs ?? TARGET_SLOWEST_MS;
  const floor = opts.floorMs ?? FLOOR_MS;
  const slowest = items.reduce((m, i) => Math.max(m, i.realMs), 0);
  const compression = slowest > target ? slowest / target : 1;
  const durationsMs: Record<string, number> = {};
  for (const i of items) {
    durationsMs[i.id] = Math.min(target, Math.max(floor, i.realMs / compression));
  }
  return { compression, durationsMs };
}

/** 实时模式： 1:1 — the wall clock waits the sim's actual measured ms. */
export function planRealtime(items: PlaybackItem[]): PlaybackPlan {
  const durationsMs: Record<string, number> = {};
  for (const i of items) durationsMs[i.id] = Math.max(0, i.realMs);
  return { compression: 1, durationsMs };
}

/** Rows-scanned counter at animation progress 0..1 (linear in rows). */
export function rowsAtProgress(totalRows: number, progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  return Math.floor(totalRows * p);
}

/** Simulated elapsed time shown mid-playback: progress × measured P99. */
export function simElapsedAt(realMs: number, progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  return realMs * p;
}

/** True when every item is sub-second — 实时模式 is offerable. */
export function realtimeOfferable(items: PlaybackItem[]): boolean {
  return items.length > 0 && items.every((i) => i.realMs <= 1000);
}
