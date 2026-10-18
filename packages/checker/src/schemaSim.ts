import type { AccessPattern, ProblemDef, ProblemSchema, SchemaTable } from '@sds/problems';
import { shardLoadModel } from '@sds/sim-core';

/**
 * Schema simulator — the database-design counterpart of the architecture
 * engine. reviewSchema ESTIMATES each access pattern's path and latency
 * with closed-form formulas; this module RUNS the problem's requirement
 * workload against the candidate schema: every access pattern generates
 * its declared perSec traffic, each query takes the path the schema
 * forces it onto, and latency / rows-examined / shard load come out of
 * one explicit cost model. Pure arithmetic, no randomness — same inputs
 * always produce byte-identical outputs (judging-grade reproducibility).
 *
 * Agreement with the static checker is by construction: path
 * classification uses the exact precedence of reviewSchema's
 * evaluatePattern (PK → shard-aligned → indexed → cross-shard broadcast
 * → full scan, count patterns on the indexed path), and verdict floors
 * mirror its rules (full scan over >1M rows fails, broadcast fails,
 * count is always at least a risk, sort over >1B rows is a risk).
 *
 * COST MODEL (all constants below, deliberately documented):
 *  - Rows examined: PK lookup = 1. Indexed/shard-aligned equality =
 *    matched rows + B-tree depth (fanout 100). Matched-row estimate:
 *    PK → 1; a `*_id` field → rows / (rows of the users table when the
 *    schema has one, else 1e6 distinct owners); any other indexed field
 *    → 2 (near-unique). An unindexed field on a sharded table whose key
 *    routes elsewhere = broadcast: every shard scans its slice (rows
 *    total). No index and no routing = full scan (rows). A shard-key
 *    field without an index locates its shard, then scans the slice.
 *  - Latency (avg): engine base (rel 2–3ms / nosql 1.5–2.5ms) + examined
 *    rows × per-row cost (rel 0.004 / nosql 0.002 ms) for index paths;
 *    scans run at 5M rows/s (rel) / 10M rows/s (nosql) over the
 *    per-shard slice; an indexed field on a table sharded by ANOTHER
 *    key additionally pays a 1.2ms probe × shardCount (every shard is
 *    asked — the path label stays 索引查询, exactly as reviewSchema
 *    classifies it, but the sim prices the fan-out). needsSort adds a
 *    result-set sort: matched × log2(matched) × 0.002ms. Writes pay the
 *    write-amplification factor (1 + 0.35 × indexCount), a blob surcharge
 *    (+6ms relational / +2ms NoSQL when the table carries a blob field),
 *    and a PK-generation surcharge (auto +0.5ms monotonic-insert
 *    contention, uuid +0.3ms random-page splits). Count (hot-row)
 *    updates: 4ms + 0.004ms × perSec of same-pattern contention.
 *  - P99 (modeled distribution): avg × tail factor by path (PK 1.6,
 *    shard-located 1.8, indexed 2.2, broadcast 3, full scan 2.5, write
 *    2, count 3) × a queueing factor from the table's hottest-shard
 *    utilization: 1 + 1.5·util², or ×5 once util ≥ 1 (saturated).
 *  - Table load: per-shard service demand (ms of shard-time per second)
 *    summed over patterns — reads spread across shards, broadcast/scan
 *    patterns charge every shard their per-shard slice, writes land by
 *    the SHARED shard-distribution model (@sds/sim-core shardLoadModel:
 *    monotonic key → all writes on the hottest shard, high-cardinality
 *    → even), count updates hold a 0.2ms row lock on their key's shard.
 *    hottestShardUtil = demand / (1000ms × concurrency), concurrency
 *    4 (relational) / 8 (NoSQL) query streams per shard. One refinement:
 *    the per-pattern QUEUEING factor prices contention among the
 *    point/indexed/write traffic sharing the shard's query slots, so it
 *    uses utilization EXCLUDING scan/broadcast demand — a scan pattern's
 *    cost is already its own latency (it fails on that, and the table
 *    card/headline report the melt); letting it also inflate every
 *    healthy co-tenant pattern's P99 would contradict the static
 *    checker's per-pattern verdicts, which this sim must agree with.
 *  - Shard count: when a shard key is set, ceil(tableSize / 200GB),
 *    clamped to [2, 256]; otherwise 1. Table size = rows × (row bytes
 *    + one index entry per indexed field); field bytes: bigint 8, int 4,
 *    varchar 64, text 256, timestamp 8, blob 50KB, json 128, other 32.
 *  - Growth scenario: rows × 10 (GROWTH_FACTOR) at the SAME traffic —
 *    data-volume growth, labeled as such wherever it is shown.
 *  - Latency budget per pattern: the strictest maxP99Ms among the
 *    problem's test cases (the pack's stated P99 requirement; 500ms
 *    fallback when a pack states none).
 *
 * This is a design-time instrument and review evidence. It does NOT
 * feed submission scoring — no thresholds were added to judging.
 */

export const SCHEMA_SIM_GROWTH_FACTOR = 10;

export type SchemaSimPath = '主键直查' | '索引查询' | '分片内定位' | '跨分片广播' | '全表扫描';
export type SchemaSimVerdict = '通过' | '风险' | '不通过';

export interface SchemaSimPattern {
  patternId: string;
  name: string;
  table: string;
  kind: AccessPattern['kind'];
  path: SchemaSimPath;
  qps: number;
  rowsExaminedPerQuery: number;
  avgMs: number;
  p99Ms: number;
  budgetMs: number;
  verdict: SchemaSimVerdict;
  note: string;
}

export interface SchemaSimTable {
  table: string;
  engine: SchemaTable['engine'];
  rows: number;
  rowsGrown: number;
  sizeBytesNow: number;
  sizeBytesGrown: number;
  indexCount: number;
  /** Write cost multiplier from index maintenance: 1 + 0.35 × indexes. */
  writeAmpFactor: number;
  readQps: number;
  writeQps: number;
  shardCount: number;
  shardKey: string | null;
  hottestShardUtil: number;
  hottestShardUtilGrown: number;
}

export interface SchemaSimHeadline {
  /** The first pattern or table that breaks, current scale first, then grown. */
  firstBreak: {
    kind: 'pattern' | 'table';
    id: string;
    name: string;
    atScale: 'now' | 'grown';
    reason: string;
  } | null;
  /**
   * Total access-pattern QPS sustainable before the hottest table's
   * hottest shard saturates (traffic scaled uniformly, current scale).
   */
  maxSustainableQps: number;
  bottleneckTable: string | null;
  /** Largest-QPS pattern landing on the bottleneck table. */
  bottleneckPatternId: string | null;
}

export interface SchemaSimResult {
  growthFactor: number;
  budgetMs: number;
  /** The modeled assumptions, for display next to the numbers. */
  assumptions: string[];
  perPattern: SchemaSimPattern[];
  perPatternGrown: SchemaSimPattern[];
  perTable: SchemaSimTable[];
  headline: SchemaSimHeadline;
}

// ------------------------------------------------------------ constants ---

const GROWTH = SCHEMA_SIM_GROWTH_FACTOR;
const SHARD_SIZE_BYTES = 200 * 1024 * 1024 * 1024; // 200 GiB per shard
const INDEX_ENTRY_OVERHEAD_BYTES = 16;
const BTREE_FANOUT = 100;
/** A single query's shard occupancy is capped: engines kill it at 30s. */
const QUERY_CAP_MS = 30_000;

const FIELD_BYTES: Record<string, number> = {
  bigint: 8, int: 4, integer: 4, smallint: 2, tinyint: 1,
  varchar: 64, char: 32, text: 256, timestamp: 8, datetime: 8, date: 4,
  boolean: 1, float: 4, double: 8, decimal: 16, json: 128, blob: 51_200,
};
const fieldBytes = (type: string) => FIELD_BYTES[type.toLowerCase()] ?? 32;

const ENGINE = {
  relational: {
    pkBaseMs: 2, indexBaseMs: 3, rowCostMs: 0.004, scanRowsPerMs: 5_000,
    readSvcMs: 0.3, writeSvcMs: 1.0, writeBaseMs: 3, blobWriteMs: 6, concurrency: 4,
  },
  nosql: {
    pkBaseMs: 1.5, indexBaseMs: 2.5, rowCostMs: 0.002, scanRowsPerMs: 10_000,
    readSvcMs: 0.2, writeSvcMs: 0.6, writeBaseMs: 2, blobWriteMs: 2, concurrency: 8,
  },
} as const;

const TAIL_FACTOR: Record<SchemaSimPath, number> = {
  主键直查: 1.6, 分片内定位: 1.8, 索引查询: 2.2, 跨分片广播: 3, 全表扫描: 2.5,
};

const round1 = (x: number) => Math.round(x * 10) / 10;
const round3 = (x: number) => Math.round(x * 1000) / 1000;

// ------------------------------------------------------------ internals ---

function rowBytesOf(table: SchemaTable): number {
  let bytes = 0;
  for (const f of table.fields) {
    bytes += fieldBytes(f.type);
    if (f.indexed) bytes += fieldBytes(f.type) + INDEX_ENTRY_OVERHEAD_BYTES;
  }
  return bytes;
}

function shardCountOf(table: SchemaTable, rows: number): number {
  if (!table.shardKey) return 1;
  const size = rows * rowBytesOf(table);
  return Math.min(256, Math.max(2, Math.ceil(size / SHARD_SIZE_BYTES)));
}

function btreeDepth(rows: number): number {
  return Math.max(1, Math.ceil(Math.log(Math.max(2, rows)) / Math.log(BTREE_FANOUT)));
}

/**
 * Estimated rows matching an equality predicate on `field`. See the cost
 * model header: PK → 1; `*_id` → rows spread over the schema's user
 * population (or 1e6 owners when no users table exists); anything else
 * is treated as near-unique (2).
 */
function matchedRows(table: SchemaTable, fieldName: string, ownerPopulation: number): number {
  if (fieldName === table.primaryKey) return 1;
  if (fieldName.endsWith('_id')) {
    return Math.max(1, Math.round(table.rows / Math.max(1, ownerPopulation)));
  }
  return 2;
}

type PathClass = SchemaSimPath | 'count';

/**
 * Path classification — the exact precedence of reviewSchema's
 * evaluatePattern, applied to reads AND writes alike (a write is
 * located/organized by the same field a read would use; its LATENCY is
 * then priced by the write cost model, not the read one). Count
 * patterns are the one special case, again mirroring reviewSchema.
 */
function classify(pattern: AccessPattern, table: SchemaTable): PathClass {
  if (pattern.kind === 'count') return 'count';
  if (pattern.byField === table.primaryKey) return '主键直查';
  if (table.shardKey && pattern.byField === table.shardKey) return '分片内定位';
  const field = table.fields.find((f) => f.name === pattern.byField);
  if (field?.indexed) return '索引查询';
  if (table.shardKey) return '跨分片广播';
  return '全表扫描';
}

interface ScaleRun {
  patterns: SchemaSimPattern[];
  /** Hottest-shard utilization per table name at this scale (all demand). */
  utilByTable: Map<string, number>;
  /** Utilization excluding scan/broadcast demand — prices queueing. */
  queueUtilByTable: Map<string, number>;
  shardCountByTable: Map<string, number>;
}

function runScale(
  tables: SchemaTable[],
  patterns: AccessPattern[],
  budgetMs: number,
  ownerPopulation: number,
): ScaleRun {
  const tableByName = new Map(tables.map((t) => [t.name, t]));
  const shardCountByTable = new Map(tables.map((t) => [t.name, shardCountOf(t, t.rows)]));

  // Pass 1 — per-pattern base latency / examined rows, and per-table
  // service demand, so pass 2 can price queueing from table utilization.
  interface Partial {
    pattern: AccessPattern;
    table?: SchemaTable;
    cls: PathClass;
    examined: number;
    baseAvgMs: number;
  }
  const partials: Partial[] = [];
  const demandByTable = new Map<string, number>(); // shard-ms per second on the hottest shard
  const queueDemandByTable = new Map<string, number>(); // same, excluding scan/broadcast classes

  const addDemand = (table: SchemaTable, cls: PathClass, shardMsPerSec: number) => {
    demandByTable.set(table.name, (demandByTable.get(table.name) ?? 0) + shardMsPerSec);
    if (cls !== '全表扫描' && cls !== '跨分片广播') {
      queueDemandByTable.set(table.name, (queueDemandByTable.get(table.name) ?? 0) + shardMsPerSec);
    }
  };

  for (const pattern of patterns) {
    const table = tableByName.get(pattern.table);
    if (!table) {
      partials.push({ pattern, cls: '全表扫描', examined: 0, baseAvgMs: 0 });
      continue;
    }
    const eng = ENGINE[table.engine];
    const shards = shardCountByTable.get(table.name) ?? 1;
    const cls = classify(pattern, table);
    const field = table.fields.find((f) => f.name === pattern.byField);
    const matched = matchedRows(table, pattern.byField, ownerPopulation);
    const depth = btreeDepth(table.rows);
    const indexCount = table.fields.filter((f) => f.indexed).length;
    const writeAmp = 1 + 0.35 * indexCount;
    let examined = 1;
    let baseAvgMs = 0;
    let svcPerShardMs = 0; // this pattern's per-query service charge on the hottest shard

    if (pattern.kind === 'write') {
      // Path label comes from classification; the COST is the write
      // model: base × write amplification + blob + PK-generation.
      examined = 1;
      const blobMs = table.fields.some((f) => f.blob) ? eng.blobWriteMs : 0;
      const pkGenMs =
        table.primaryKeyGen === 'auto' ? 0.5 : table.primaryKeyGen === 'uuid' ? 0.3 : 0;
      baseAvgMs = eng.writeBaseMs * writeAmp + blobMs + pkGenMs;
      const model = shardLoadModel(table.shardKey, !!table.shardKey, shards);
      svcPerShardMs = eng.writeSvcMs * writeAmp * model.hottestWriteShare;
      partials.push({ pattern, table, cls, examined, baseAvgMs });
      addDemand(table, cls, pattern.perSec * svcPerShardMs);
      continue;
    }
    if (pattern.kind === 'count') {
      examined = 1;
      baseAvgMs = 4 + Math.min(24, pattern.perSec * 0.004);
      const model = shardLoadModel(table.shardKey, !!table.shardKey, shards);
      // A hot-row lock is held on the one shard owning that key.
      svcPerShardMs = 0.2 * model.hottestWriteShare;
      partials.push({ pattern, table, cls, examined, baseAvgMs });
      addDemand(table, cls, pattern.perSec * svcPerShardMs);
      continue;
    }

    switch (cls) {
      case '主键直查': {
        examined = 1;
        baseAvgMs = eng.pkBaseMs;
        svcPerShardMs = eng.readSvcMs / shards;
        break;
      }
      case '分片内定位': {
        if (field?.indexed) {
          examined = matched + depth;
          baseAvgMs = eng.indexBaseMs + examined * eng.rowCostMs;
        } else {
          // Routing finds the shard; without an index the slice is scanned.
          examined = Math.ceil(table.rows / shards);
          baseAvgMs = eng.indexBaseMs + examined / eng.scanRowsPerMs;
        }
        svcPerShardMs = eng.readSvcMs / shards;
        break;
      }
      case '索引查询': {
        examined = matched + depth;
        baseAvgMs = eng.indexBaseMs + examined * eng.rowCostMs;
        if (table.shardKey && pattern.byField !== table.shardKey) {
          // Local index, wrong routing key: every shard is probed.
          examined = matched + depth * shards;
          baseAvgMs += shards * 1.2;
          svcPerShardMs = eng.readSvcMs; // each shard works on every query
        } else {
          svcPerShardMs = eng.readSvcMs / shards;
        }
        if (pattern.needsSort && matched > 20) {
          baseAvgMs += matched * Math.log2(matched) * 0.002;
        }
        break;
      }
      case '跨分片广播': {
        examined = table.rows;
        baseAvgMs = eng.indexBaseMs + table.rows / shards / eng.scanRowsPerMs + shards * 1.2;
        svcPerShardMs = Math.min(QUERY_CAP_MS, table.rows / shards / eng.scanRowsPerMs);
        break;
      }
      case '全表扫描': {
        examined = table.rows;
        baseAvgMs = eng.pkBaseMs + table.rows / shards / eng.scanRowsPerMs;
        svcPerShardMs = Math.min(QUERY_CAP_MS, table.rows / shards / eng.scanRowsPerMs);
        break;
      }
      case 'count': {
        break; // handled above the switch (kind-based cost model)
      }
    }
    partials.push({ pattern, table, cls, examined, baseAvgMs });
    addDemand(table, cls, pattern.perSec * svcPerShardMs);
  }

  const utilByTable = new Map<string, number>();
  const queueUtilByTable = new Map<string, number>();
  for (const t of tables) {
    const denom = 1000 * ENGINE[t.engine].concurrency;
    utilByTable.set(t.name, (demandByTable.get(t.name) ?? 0) / denom);
    queueUtilByTable.set(t.name, (queueDemandByTable.get(t.name) ?? 0) / denom);
  }

  // Pass 2 — p99 (tail × queueing) and verdicts.
  const out: SchemaSimPattern[] = partials.map(({ pattern, table, cls, examined, baseAvgMs }) => {
    if (!table) {
      return {
        patternId: pattern.id, name: pattern.name, table: pattern.table, kind: pattern.kind,
        path: '全表扫描', qps: pattern.perSec, rowsExaminedPerQuery: 0,
        avgMs: 0, p99Ms: 0, budgetMs, verdict: '不通过',
        note: `引用的表 ${pattern.table} 不存在。`,
      };
    }
    const util = queueUtilByTable.get(table.name) ?? 0;
    const queueFactor = util >= 1 ? 5 : 1 + 1.5 * util * util;
    const path: SchemaSimPath = cls === 'count' ? '索引查询' : cls;
    const tail =
      pattern.kind === 'write' ? 2 : pattern.kind === 'count' ? 3 : TAIL_FACTOR[path];
    const avgMs = baseAvgMs;
    const p99Ms = avgMs * tail * queueFactor;

    let verdict: SchemaSimVerdict =
      p99Ms <= budgetMs ? '通过' : p99Ms <= 2 * budgetMs ? '风险' : '不通过';
    const floor = (v: SchemaSimVerdict) => {
      const rank = { 通过: 0, 风险: 1, 不通过: 2 } as const;
      if (rank[v] > rank[verdict]) verdict = v;
    };
    let note = '';
    if (pattern.kind === 'count') {
      floor('风险');
      note = '计数更新打在单个热点行/键上：行锁占用随并发上升，分片计数或异步聚合才能根治。';
    } else if (pattern.kind === 'write') {
      note = '写入成本含索引维护的写放大（索引越多写越贵）与主键生成方式的影响。';
    } else if (cls === '主键直查') {
      note = '按主键定位，路径最短。';
    } else if (cls === '分片内定位') {
      note = table.fields.find((f) => f.name === pattern.byField)?.indexed
        ? '查询维度与分片键一致，单分片内走索引完成。'
        : '分片键能定位到单个分片，但分片内没有索引、要扫该片的数据。给分片键字段加索引。';
    } else if (cls === '索引查询') {
      note =
        table.shardKey && pattern.byField !== table.shardKey
          ? '字段有本地索引，但分片键不一致：每次查询要探所有分片，P99 被最慢的分片拖住。'
          : pattern.needsSort
            ? '走索引取回结果集后还要排序；结果集随数据量线性变大，排序成本同步上升。'
            : '有索引覆盖，路径可控。';
    } else if (cls === '跨分片广播') {
      note = `按 ${pattern.byField} 查，但分片键是 ${table.shardKey} 且该字段无索引：每个分片都要扫一遍自己的数据。`;
    } else {
      // 全表扫描
      note = `字段 ${pattern.byField} 没有索引：${table.rows.toLocaleString()} 行全表扫描，数据越大越慢。`;
    }
    // Path floors bind every kind — reviewSchema runs writes through the
    // same classification and floors them identically.
    if (pattern.kind !== 'count') {
      if (cls === '跨分片广播') floor('不通过');
      else if (cls === '全表扫描') floor(table.rows > 1_000_000 ? '不通过' : '风险');
      else if (cls === '索引查询' && pattern.needsSort && table.rows > 1_000_000_000) floor('风险');
    }
    if (util >= 1 && pattern.kind !== 'count') {
      floor('风险');
      note += `（表 ${table.name} 最热分片已饱和，利用率 ${round3(util)}，排队会进一步放大延迟。）`;
    }
    return {
      patternId: pattern.id, name: pattern.name, table: table.name, kind: pattern.kind,
      path, qps: pattern.perSec, rowsExaminedPerQuery: Math.round(examined),
      avgMs: round1(avgMs), p99Ms: round1(p99Ms), budgetMs, verdict, note,
    };
  });

  return { patterns: out, utilByTable, queueUtilByTable, shardCountByTable };
}

// -------------------------------------------------------------- entry -----

/**
 * Run the requirement workload against a candidate schema.
 *
 * Patterns are the requirement: the submitted schema's accessPatterns
 * (the same set reviewSchema judges — the packs ship them inside the
 * schema), falling back to the problem pack's when the submission
 * carries none.
 */
export function simulateSchema(problem: ProblemDef, schema: ProblemSchema): SchemaSimResult {
  const patterns =
    schema.accessPatterns.length > 0 ? schema.accessPatterns : problem.schema.accessPatterns;
  const budgetMs = (() => {
    const budgets = problem.testCases
      .map((tc) => tc.thresholds.maxP99Ms)
      .filter((v): v is number => typeof v === 'number' && v > 0);
    return budgets.length ? Math.min(...budgets) : 500;
  })();
  const usersTable = schema.tables.find((t) => t.name === 'users') ?? problem.schema.tables.find((t) => t.name === 'users');
  const ownerPopulation = usersTable?.rows ?? 1_000_000;

  const now = runScale(schema.tables, patterns, budgetMs, ownerPopulation);
  const grownTables = schema.tables.map((t) => ({ ...t, rows: t.rows * GROWTH }));
  const grown = runScale(grownTables, patterns, budgetMs, ownerPopulation * GROWTH);

  const perTable: SchemaSimTable[] = schema.tables.map((t) => {
    const sizeNow = t.rows * rowBytesOf(t);
    const sizeGrown = t.rows * GROWTH * rowBytesOf(t);
    return {
      table: t.name,
      engine: t.engine,
      rows: t.rows,
      rowsGrown: t.rows * GROWTH,
      sizeBytesNow: sizeNow,
      sizeBytesGrown: sizeGrown,
      indexCount: t.fields.filter((f) => f.indexed).length,
      writeAmpFactor: round3(1 + 0.35 * t.fields.filter((f) => f.indexed).length),
      readQps: patterns.filter((p) => p.table === t.name && p.kind === 'read').reduce((s, p) => s + p.perSec, 0),
      writeQps: patterns.filter((p) => p.table === t.name && p.kind !== 'read').reduce((s, p) => s + p.perSec, 0),
      shardCount: now.shardCountByTable.get(t.name) ?? 1,
      shardKey: t.shardKey,
      hottestShardUtil: round3(now.utilByTable.get(t.name) ?? 0),
      hottestShardUtilGrown: round3(grown.utilByTable.get(t.name) ?? 0),
    };
  });

  // Headline: the first thing that breaks — current scale before grown,
  // patterns (worst p99 overshoot) before saturated tables.
  const totalQps = patterns.reduce((s, p) => s + p.perSec, 0);
  const worstFailing = (ps: SchemaSimPattern[]) =>
    ps.filter((p) => p.verdict === '不通过')
      .sort((a, b) => b.p99Ms / Math.max(1, b.budgetMs) - a.p99Ms / Math.max(1, a.budgetMs))[0];
  const saturated = (ts: SchemaSimTable[], grownScale: boolean) =>
    ts.filter((t) => (grownScale ? t.hottestShardUtilGrown : t.hottestShardUtil) >= 1)
      .sort((a, b) =>
        (grownScale ? b.hottestShardUtilGrown - a.hottestShardUtilGrown : b.hottestShardUtil - a.hottestShardUtil))[0];

  let firstBreak: SchemaSimHeadline['firstBreak'] = null;
  const failNow = worstFailing(now.patterns);
  const satNow = saturated(perTable, false);
  const failGrown = worstFailing(grown.patterns);
  const satGrown = saturated(perTable, true);
  if (failNow) {
    firstBreak = {
      kind: 'pattern', id: failNow.patternId, name: failNow.name, atScale: 'now',
      reason: `「${failNow.name}」走${failNow.path}，P99 ${failNow.p99Ms}ms 超过预算 ${failNow.budgetMs}ms 的 2 倍（实测判定不通过）。`,
    };
  } else if (satNow) {
    firstBreak = {
      kind: 'table', id: satNow.table, name: satNow.table, atScale: 'now',
      reason: `表 ${satNow.table} 最热分片利用率 ${satNow.hottestShardUtil} ≥ 1：当前流量下已经饱和。`,
    };
  } else if (failGrown) {
    firstBreak = {
      kind: 'pattern', id: failGrown.patternId, name: failGrown.name, atScale: 'grown',
      reason: `数据量 ×${GROWTH} 后「${failGrown.name}」走${failGrown.path}，P99 ${failGrown.p99Ms}ms 超过预算 ${failGrown.budgetMs}ms 的 2 倍。`,
    };
  } else if (satGrown) {
    firstBreak = {
      kind: 'table', id: satGrown.table, name: satGrown.table, atScale: 'grown',
      reason: `数据量 ×${GROWTH} 后表 ${satGrown.table} 最热分片利用率 ${satGrown.hottestShardUtilGrown} ≥ 1。`,
    };
  }

  const maxUtilNow = perTable.reduce((m, t) => Math.max(m, t.hottestShardUtil), 0);
  const bottleneck = perTable.find((t) => t.hottestShardUtil === maxUtilNow) ?? null;
  const maxSustainableQps = maxUtilNow > 0 ? Math.round(totalQps / maxUtilNow) : totalQps;
  const bottleneckPattern = bottleneck
    ? patterns.filter((p) => p.table === bottleneck.table).sort((a, b) => b.perSec - a.perSec)[0]
    : undefined;

  return {
    growthFactor: GROWTH,
    budgetMs,
    assumptions: [
      `增长情景：所有表行数 ×${GROWTH}，流量（各访问模式 perSec）不变——只涨数据量。`,
      `延迟预算 ${budgetMs}ms：取本题用例里最严的 P99 阈值（题目给定的要求）。`,
      'P99 为模型化分布：平均延迟 × 路径尾部系数 × 拥挤系数（由最热分片利用率推出），非实测采样。',
      '分片负载与架构仿真共用同一模型：单调分片键让写入集中到最热分片，高基数键均匀摊开。',
    ],
    perPattern: now.patterns,
    perPatternGrown: grown.patterns,
    perTable,
    headline: {
      firstBreak,
      maxSustainableQps,
      bottleneckTable: bottleneck?.table ?? null,
      bottleneckPatternId: bottleneckPattern?.id ?? null,
    },
  };
}

/** One-paragraph human summary of a schema sim, for the LLM review context. */
export function buildSchemaSimSummary(sim: SchemaSimResult): string {
  const lines: string[] = [];
  lines.push(
    `数据库模拟（服务端按题目需求流量实跑，延迟预算 P99 ≤ ${sim.budgetMs}ms）：`,
  );
  for (const p of sim.perPattern) {
    lines.push(
      `- ${p.name}（${p.table}）：${p.path}，${p.qps}/s，每查询扫描 ${p.rowsExaminedPerQuery.toLocaleString()} 行，avg ${p.avgMs}ms / P99 ${p.p99Ms}ms → ${p.verdict}`,
    );
  }
  for (const t of sim.perTable) {
    lines.push(
      `- 表 ${t.table}：写 ${t.writeQps}/s、读 ${t.readQps}/s，最热分片利用率 ${t.hottestShardUtil}（×${sim.growthFactor} 数据量后 ${t.hottestShardUtilGrown}），体积 ${(t.sizeBytesNow / 1e9).toFixed(1)}GB → ${(t.sizeBytesGrown / 1e9).toFixed(1)}GB，索引 ${t.indexCount} 个（写放大 ×${t.writeAmpFactor}）`,
    );
  }
  const g = sim.perPatternGrown.filter((p) => p.verdict === '不通过');
  if (g.length) {
    lines.push(
      `数据量 ×${sim.growthFactor} 后判定不通过的模式：${g.map((p) => `「${p.name}」P99 ${p.p99Ms}ms`).join('；')}。`,
    );
  }
  lines.push(
    sim.headline.firstBreak
      ? `最先崩的点（${sim.headline.firstBreak.atScale === 'now' ? '当前规模' : `×${sim.growthFactor} 规模`}）：${sim.headline.firstBreak.reason}`
      : `当前与 ×${sim.growthFactor} 规模下没有模式判定不通过；按当前结构，最热表 ${sim.headline.bottleneckTable ?? '—'} 先饱和，可持续总流量约 ${sim.headline.maxSustainableQps.toLocaleString()} 次/s。`,
  );
  return lines.join('\n');
}
