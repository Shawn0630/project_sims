import type { AccessPattern, ProblemSchema, SchemaTable } from '@sds/problems';

export type SchemaDimension = '需求覆盖' | '延迟风险' | '扩展性';

export interface SchemaFinding {
  dimension: SchemaDimension;
  severity: 'high' | 'medium' | 'low';
  text: string;
}

export interface PatternVerdict {
  patternId: string;
  name: string;
  table: string;
  path: '主键直查' | '索引查询' | '分片内定位' | '跨分片广播' | '全表扫描';
  latencyMs: number;
  verdict: '通过' | '风险' | '不通过';
  note: string;
}

export interface SchemaReviewReport {
  score: number;
  coveragePassed: number;
  coverageTotal: number;
  coverage: string;
  perPattern: PatternVerdict[];
  findings: SchemaFinding[];
}

const MONOTONIC_KEYS = new Set(['created_at', 'timestamp', 'id', 'auto_id', 'seq']);

function evaluatePattern(
  pattern: AccessPattern,
  table: SchemaTable,
  loadFactor: number,
): PatternVerdict {
  const field = table.fields.find((f) => f.name === pattern.byField);
  const scaleLatency = (ms: number) => Math.round(ms * (1 + loadFactor) * 10) / 10;

  if (pattern.kind === 'count') {
    return {
      patternId: pattern.id,
      name: pattern.name,
      table: table.name,
      path: '索引查询',
      latencyMs: scaleLatency(15),
      verdict: '风险',
      note: '计数更新打在单个热点行/键上：高并发下行锁与热点键会成为瓶颈，建议分片计数或异步聚合。',
    };
  }
  if (pattern.byField === table.primaryKey) {
    return {
      patternId: pattern.id,
      name: pattern.name,
      table: table.name,
      path: '主键直查',
      latencyMs: scaleLatency(2),
      verdict: '通过',
      note: '按主键定位，路径最短。',
    };
  }
  if (table.shardKey && pattern.byField === table.shardKey) {
    return {
      patternId: pattern.id,
      name: pattern.name,
      table: table.name,
      path: '分片内定位',
      latencyMs: scaleLatency(5),
      verdict: '通过',
      note: '查询维度与分片键一致，单分片内完成。',
    };
  }
  if (field?.indexed) {
    const base = pattern.needsSort ? 22 : 8;
    return {
      patternId: pattern.id,
      name: pattern.name,
      table: table.name,
      path: '索引查询',
      latencyMs: scaleLatency(base),
      verdict: pattern.needsSort && table.rows > 1_000_000_000 ? '风险' : '通过',
      note: pattern.needsSort
        ? '走索引但还要额外排序；数据量越大排序成本越明显，考虑复合索引 (byField, created_at)。'
        : '有索引覆盖，路径可控。',
    };
  }
  if (table.shardKey) {
    return {
      patternId: pattern.id,
      name: pattern.name,
      table: table.name,
      path: '跨分片广播',
      latencyMs: scaleLatency(Math.min(900, 40 + table.rows / 10_000_000)),
      verdict: '不通过',
      note: `按 ${pattern.byField} 查，但分片键是 ${table.shardKey}：每个分片都要问一遍，延迟随分片数放大。`,
    };
  }
  return {
    patternId: pattern.id,
    name: pattern.name,
    table: table.name,
    path: '全表扫描',
    latencyMs: scaleLatency(Math.min(5000, (table.rows / 1_000_000) * 8)),
    verdict: table.rows > 1_000_000 ? '不通过' : '风险',
    note: `字段 ${pattern.byField} 没有索引：${table.rows.toLocaleString()} 行里全表扫描，这个查询在生产上跑不动。`,
  };
}

/**
 * Scripted schema review — the deterministic stand-in behind the
 * `review_schema` tool. Same dimensions a real LLM reviewer will use:
 * 需求覆盖 (can the access patterns run at all), 延迟风险 (what each pattern
 * costs, scaled by the live DB load factor), 扩展性 (what breaks at scale).
 */
export function reviewSchema(
  schema: ProblemSchema,
  opts?: { loadFactor?: number },
): SchemaReviewReport {
  const loadFactor = opts?.loadFactor ?? 0;
  const findings: SchemaFinding[] = [];
  const perPattern: PatternVerdict[] = [];

  for (const pattern of schema.accessPatterns) {
    const table = schema.tables.find((t) => t.name === pattern.table);
    if (!table) {
      perPattern.push({
        patternId: pattern.id,
        name: pattern.name,
        table: pattern.table,
        path: '全表扫描',
        latencyMs: 0,
        verdict: '不通过',
        note: `引用的表 ${pattern.table} 不存在。`,
      });
      continue;
    }
    const v = evaluatePattern(pattern, table, loadFactor);
    perPattern.push(v);
    if (v.verdict === '不通过') {
      findings.push({
        dimension: '需求覆盖',
        severity: 'high',
        text: `访问模式「${pattern.name}」走的是${v.path}：${v.note}`,
      });
    } else if (v.verdict === '风险') {
      findings.push({
        dimension: pattern.kind === 'count' ? '扩展性' : '延迟风险',
        severity: 'medium',
        text: `访问模式「${pattern.name}」：${v.note}`,
      });
    }
  }

  for (const table of schema.tables) {
    if (table.rows >= 100_000_000 && !table.shardKey) {
      findings.push({
        dimension: '扩展性',
        severity: 'high',
        text: `表 ${table.name} 有 ${table.rows.toLocaleString()} 行却没有分片键：单机容量与写吞吐都会到顶，要么现在定分片键，要么明确归档/冷热分离策略。`,
      });
    }
    if (table.shardKey && MONOTONIC_KEYS.has(table.shardKey)) {
      findings.push({
        dimension: '扩展性',
        severity: 'high',
        text: `表 ${table.name} 的分片键是单调字段「${table.shardKey}」：新数据永远落到同一个分片，热点分片跑满、其余分片闲置。换高基数均匀键。`,
      });
    }
    if (table.primaryKeyGen === 'auto' && table.rows >= 1_000_000_000) {
      findings.push({
        dimension: '扩展性',
        severity: 'medium',
        text: `表 ${table.name} 十亿级还用自增主键：分片后全局唯一要额外协调，且自增键本身就是热点来源。换雪花/UUID。`,
      });
    }
    const blob = table.fields.find((f) => f.blob);
    if (blob && table.engine === 'relational') {
      findings.push({
        dimension: '扩展性',
        severity: 'medium',
        text: `表 ${table.name} 把 blob 字段「${blob.name}」存进了关系型 DB：备份、复制、查询全被大字段拖慢。文件本体放对象存储，DB 只存 URL。`,
      });
    }
    const indexCount = table.fields.filter((f) => f.indexed).length;
    if (indexCount > 5) {
      findings.push({
        dimension: '延迟风险',
        severity: 'low',
        text: `表 ${table.name} 有 ${indexCount} 个索引：每个索引都是一份写放大，写入延迟会随之上升。砍掉没有访问模式用到的索引。`,
      });
    }
  }

  const coveragePassed = perPattern.filter((p) => p.verdict !== '不通过').length;
  let score = 100;
  for (const p of perPattern) {
    if (p.verdict === '不通过') score -= 12;
    else if (p.verdict === '风险') score -= 5;
  }
  for (const f of findings) {
    if (f.dimension === '需求覆盖') continue; // already counted via patterns
    score -= f.severity === 'high' ? 8 : f.severity === 'medium' ? 4 : 2;
  }
  score = Math.max(0, Math.min(100, score));

  const order = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  return {
    score,
    coveragePassed,
    coverageTotal: perPattern.length,
    coverage: `覆盖 ${coveragePassed}/${perPattern.length} 条访问模式`,
    perPattern,
    findings,
  };
}
