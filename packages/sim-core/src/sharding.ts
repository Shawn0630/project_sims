/**
 * The ONE shard-distribution model, shared by every simulator in the repo.
 *
 * Commit 91d3360 made shard-key distribution a standing effect in the
 * architecture engine: a monotonic shard key (created_at / timestamp /
 * auto-increment id…) sends every new write to the newest shard while the
 * rest idle; a high-cardinality key (user_id…) spreads writes evenly.
 * The schema simulator (@sds/checker schemaSim) prices table/shard load
 * with THIS module too — importing it, never re-declaring it — so the two
 * engines can never drift into disagreeing about what a shard key does.
 */

/** Shard keys whose values grow monotonically with insertion order. */
export const MONOTONIC_SHARD_KEYS: ReadonlySet<string> = new Set([
  'created_at',
  'timestamp',
  'id',
  'auto_id',
  'seq',
]);

export function isMonotonicShardKey(key: string | null | undefined): boolean {
  return !!key && MONOTONIC_SHARD_KEYS.has(key);
}

/**
 * With a monotonic key the write stream is charged against ONE shard's
 * share of the store. 0.3 is the engine's calibrated share (≈ 1 of ~3.3
 * shards' worth of capacity) — the same factor the architecture engine
 * has used since 91d3360; both engines read it from here.
 */
export const MONOTONIC_SHARD_CAPACITY_SHARE = 0.3;

export interface ShardLoadModel {
  /** The routing key grows monotonically → writes pile onto one shard. */
  monotonic: boolean;
  /**
   * Fraction of the table's write traffic that lands on the hottest
   * shard: 1 when unsharded (one node takes everything) or when the key
   * is monotonic (every new write goes to the newest shard); spread
   * evenly (1 / shardCount) for a high-cardinality key.
   */
  hottestWriteShare: number;
  /**
   * The store-capacity share the write stream is effectively charged
   * against, in the architecture engine's terms: 0.3 for a monotonic
   * sharded store, 1 otherwise.
   */
  writeCapacityShare: number;
}

export function shardLoadModel(
  shardKey: string | null | undefined,
  sharded: boolean,
  shardCount = 1,
): ShardLoadModel {
  if (!sharded) {
    return { monotonic: false, hottestWriteShare: 1, writeCapacityShare: 1 };
  }
  if (isMonotonicShardKey(shardKey)) {
    return {
      monotonic: true,
      hottestWriteShare: 1,
      writeCapacityShare: MONOTONIC_SHARD_CAPACITY_SHARE,
    };
  }
  const n = Math.max(1, Math.floor(shardCount) || 1);
  return { monotonic: false, hottestWriteShare: 1 / n, writeCapacityShare: 1 };
}
