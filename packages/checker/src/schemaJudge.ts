/**
 * Schema test-case judging — the database side's LeetCode suite.
 *
 * A pack's `schemaTestCases` are assertions phrased directly over the
 * schema simulator's measured output, so judging = run simulateSchema
 * once and read the numbers off. Deterministic, independent of the
 * architecture suite: the schema score lives in the 「数据库评审」 tab
 * and NEVER merges into the architecture total (the two designs are
 * judged as the two separate deliverables they are).
 *
 * Failed cases carry a GROUNDED fix: schema-ops derived from the failed
 * metric itself (a full scan on an unindexed field → addIndex on that
 * field; a broadcast → shard by the queried field; a saturated table →
 * shard by its hottest pattern's field), validated through the same
 * schema-op checker every other fix path uses. Cases whose failure has
 * no honest single op (write-amp excess, aggregate shortfalls on an
 * already-aligned table) ship no fix rather than a decorative one —
 * the AI next-steps layer owns those.
 */

import type {
  ProblemDef,
  ProblemSchema,
  SchemaTestCase,
} from '@sds/problems';
import type { SchemaOp } from '@sds/driver';
import { simulateSchema, type SchemaSimResult } from './schemaSim.js';
import { validateSchemaOps, describeSchemaOp } from './schemaOps.js';

export interface SchemaCaseFix {
  title: string;
  actions: SchemaOp[];
}

export interface SchemaCaseResult {
  caseId: string;
  name: string;
  hidden: boolean;
  passed: boolean;
  /** What the sim measured, in one human line. */
  measuredText: string;
  /** What the case demanded, in one human line. */
  thresholdText: string;
  failures: string[];
  /** Grounded fix for a failed case (validated schema-ops), when one exists. */
  fix?: SchemaCaseFix;
}

export interface SchemaSuiteResult {
  results: SchemaCaseResult[];
  passedCount: number;
  totalCount: number;
  /** Weight-based pass share 0..100, mirroring the architecture suite. */
  scorePct: number;
}

const fmtNum = (n: number) => Math.round(n).toLocaleString();

function evaluateCase(
  problem: ProblemDef,
  sim: SchemaSimResult,
  tc: SchemaTestCase,
): { passed: boolean; measuredText: string; thresholdText: string } {
  const a = tc.assertion;
  const grown = tc.scale === 'grown';
  if (a.kind === 'pattern' || a.kind === 'pattern-path') {
    const list = grown ? sim.perPatternGrown : sim.perPattern;
    const p = list.find((x) => x.patternId === a.patternId);
    if (!p) {
      return {
        passed: false,
        measuredText: `访问模式 ${a.patternId} 不存在`,
        thresholdText: '模式须存在',
      };
    }
    if (a.kind === 'pattern-path') {
      return {
        passed: !a.forbiddenPaths.includes(p.path as '全表扫描' | '跨分片广播'),
        measuredText: `路径 ${p.path}（扫描 ${fmtNum(p.rowsExaminedPerQuery)} 行）`,
        thresholdText: `不得走 ${a.forbiddenPaths.join(' / ')}`,
      };
    }
    const measured = a.metric === 'p99Ms' ? p.p99Ms : p.rowsExaminedPerQuery;
    return {
      passed: measured <= a.max,
      measuredText:
        a.metric === 'p99Ms'
          ? `P99 ${p.p99Ms}ms（${p.path}）`
          : `每查询扫描 ${fmtNum(p.rowsExaminedPerQuery)} 行（${p.path}）`,
      thresholdText: a.metric === 'p99Ms' ? `P99 ≤ ${a.max}ms` : `扫描行数 ≤ ${fmtNum(a.max)}`,
    };
  }
  if (a.kind === 'table') {
    const t = sim.perTable.find((x) => x.table === a.table);
    if (!t) {
      return { passed: false, measuredText: `表 ${a.table} 不存在`, thresholdText: '表须存在' };
    }
    const measured =
      a.metric === 'hottestShardUtil'
        ? grown
          ? t.hottestShardUtilGrown
          : t.hottestShardUtil
        : t.writeAmpFactor;
    return {
      passed: measured <= a.max,
      measuredText:
        a.metric === 'hottestShardUtil'
          ? `最热分片利用率 ${measured}`
          : `写放大 ×${t.writeAmpFactor}（${t.indexCount} 个索引）`,
      thresholdText: a.metric === 'hottestShardUtil' ? `利用率 ≤ ${a.max}` : `写放大 ≤ ×${a.max}`,
    };
  }
  // global sustainable QPS
  const totalQps = sim.perPattern.reduce((s, p) => s + p.qps, 0);
  const maxUtil = grown
    ? Math.max(0, ...sim.perTable.map((t) => t.hottestShardUtilGrown))
    : Math.max(0, ...sim.perTable.map((t) => t.hottestShardUtil));
  const sustainable = grown
    ? maxUtil > 0
      ? Math.round(totalQps / maxUtil)
      : totalQps
    : sim.headline.maxSustainableQps;
  return {
    passed: sustainable >= a.min,
    measuredText: `可持续总流量约 ${fmtNum(sustainable)} 次/s（瓶颈表 ${sim.headline.bottleneckTable ?? '—'}）`,
    thresholdText: `可持续流量 ≥ ${fmtNum(a.min)} 次/s`,
  };
}

/** Is this field a temporal / monotonic distribution (bad shard key)? */
function isMonotonicField(schema: ProblemSchema, tableName: string, fieldName: string): boolean {
  const t = schema.tables.find((x) => x.name === tableName);
  const f = t?.fields.find((x) => x.name === fieldName);
  if (!f) return false;
  return /timestamp|datetime|date/.test(f.type.toLowerCase()) || /created|time/.test(f.name);
}

/**
 * The grounded fix for one failed case, derived from the failed metric.
 * Returns validated schema-ops or null when no honest single move exists.
 */
export function schemaCaseFix(
  problem: ProblemDef,
  schema: ProblemSchema,
  sim: SchemaSimResult,
  tc: SchemaTestCase,
): SchemaCaseFix | null {
  const a = tc.assertion;
  const patterns = schema.accessPatterns.length
    ? schema.accessPatterns
    : problem.schema.accessPatterns;
  const ops: SchemaOp[] = [];

  /**
   * The honest single move for a saturated table, in priority order:
   *  1. a pattern on it is scanning/broadcasting — fix THAT pattern's
   *     route first (the scan is what saturates the table);
   *  2. otherwise spread the table by the field its heaviest non-PK
   *     pattern keys on (the distribution the load actually follows).
   */
  const tableFix = (tableName: string): SchemaOp | null => {
    const t = schema.tables.find((x) => x.name === tableName);
    if (!t) return null;
    const list = tc.scale === 'grown' ? sim.perPatternGrown : sim.perPattern;
    const onTable = patterns.filter((p) => p.table === tableName);
    for (const p of onTable) {
      const measured = list.find((x) => x.patternId === p.id);
      if (!measured) continue;
      if (measured.path === '全表扫描') {
        const f = t.fields.find((x) => x.name === p.byField);
        if (f && !f.indexed && p.kind === 'read') {
          return { op: 'addIndex', table: tableName, field: p.byField };
        }
        if (p.byField !== t.shardKey) {
          return { op: 'setShardKey', table: tableName, field: p.byField };
        }
      }
      if (measured.path === '跨分片广播' && p.byField !== t.shardKey) {
        return { op: 'setShardKey', table: tableName, field: p.byField };
      }
    }
    const byTraffic = [...onTable].sort((x, y) => y.perSec - x.perSec);
    const pick =
      byTraffic.find((p) => p.byField !== t.primaryKey)?.byField ?? byTraffic[0]?.byField;
    if (!pick || pick === t.shardKey) return null;
    if (!t.fields.some((f) => f.name === pick)) return null;
    return { op: 'setShardKey', table: tableName, field: pick };
  };

  if (a.kind === 'pattern' || a.kind === 'pattern-path') {
    const pattern = patterns.find((p) => p.id === a.patternId);
    const table = pattern ? schema.tables.find((t) => t.name === pattern.table) : undefined;
    if (!pattern || !table) return null;
    const list = tc.scale === 'grown' ? sim.perPatternGrown : sim.perPattern;
    const measured = list.find((x) => x.patternId === a.patternId);
    if (!measured) return null;
    const field = table.fields.find((f) => f.name === pattern.byField);
    if (measured.path === '全表扫描' && field && !field.indexed && pattern.kind === 'read') {
      ops.push({ op: 'addIndex', table: table.name, field: pattern.byField });
    } else if (measured.path === '跨分片广播') {
      ops.push({ op: 'setShardKey', table: table.name, field: pattern.byField });
    } else if (
      table.shardKey &&
      pattern.byField !== table.shardKey &&
      measured.path === '索引查询'
    ) {
      // Local index on every shard, wrong routing key: re-key the table
      // to the field this pattern actually queries by.
      ops.push({ op: 'setShardKey', table: table.name, field: pattern.byField });
    } else if (measured.path === '分片内定位' && field && !field.indexed) {
      ops.push({ op: 'addIndex', table: table.name, field: pattern.byField });
    } else {
      // Pure latency failure on a healthy path: only a distribution
      // move is honest — spread a saturated unsharded table, or move a
      // monotonic shard key onto the queried field.
      const util =
        sim.perTable.find((t) => t.table === table.name)?.hottestShardUtil ?? 0;
      if (util >= 0.5 && !table.shardKey) {
        ops.push({ op: 'setShardKey', table: table.name, field: pattern.byField });
      } else if (
        table.shardKey &&
        isMonotonicField(schema, table.name, table.shardKey) &&
        pattern.byField !== table.shardKey
      ) {
        ops.push({ op: 'setShardKey', table: table.name, field: pattern.byField });
      }
    }
  } else if (a.kind === 'table' && a.metric === 'hottestShardUtil') {
    const op = tableFix(a.table);
    if (op) ops.push(op);
  } else if (a.kind === 'global') {
    const worst = [...sim.perTable].sort(
      (x, y) => y.hottestShardUtil - x.hottestShardUtil,
    )[0];
    if (worst && worst.hottestShardUtil >= 0.2) {
      const op = tableFix(worst.table);
      if (op) ops.push(op);
    }
  }

  const valid = validateSchemaOps(ops, schema);
  if (!valid.length) return null;
  return { title: valid.map((op) => describeSchemaOp(op, schema)).join('；'), actions: valid };
}

/** Judge a schema against the pack's schema test cases (deterministic). */
export function judgeSchemaCases(
  problem: ProblemDef,
  schema: ProblemSchema,
): SchemaSuiteResult {
  const cases = problem.schemaTestCases ?? [];
  const sim = simulateSchema(problem, schema);
  let passedWeight = 0;
  let totalWeight = 0;
  const results: SchemaCaseResult[] = cases.map((tc) => {
    totalWeight += tc.weight;
    const ev = evaluateCase(problem, sim, tc);
    if (ev.passed) passedWeight += tc.weight;
    const fix = ev.passed ? null : schemaCaseFix(problem, schema, sim, tc);
    return {
      caseId: tc.id,
      name: tc.name,
      hidden: tc.hidden,
      passed: ev.passed,
      measuredText: ev.measuredText,
      thresholdText: ev.thresholdText,
      failures: ev.passed ? [] : [`实测 ${ev.measuredText}，未达到：${ev.thresholdText}`],
      ...(fix ? { fix } : {}),
    };
  });
  return {
    results,
    passedCount: results.filter((r) => r.passed).length,
    totalCount: results.length,
    scorePct: totalWeight > 0 ? Math.round((passedWeight / totalWeight) * 100) : 0,
  };
}
