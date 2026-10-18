import { PROBLEMS, problemById, type ProblemSchema } from '@sds/problems';
import { reviewSchema, simulateSchema } from '@sds/checker';

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

// 1) Determinism: two runs byte-identical.
for (const p of PROBLEMS) {
  const a = JSON.stringify(simulateSchema(p, structuredClone(p.schema)));
  const b = JSON.stringify(simulateSchema(p, structuredClone(p.schema)));
  check(`${p.id}: deterministic`, a === b);
}

// 2) Agreement with the static checker: same verdict for every pattern.
for (const p of PROBLEMS) {
  const review = reviewSchema(structuredClone(p.schema));
  const sim = simulateSchema(p, structuredClone(p.schema));
  const simById = new Map(sim.perPattern.map((r) => [r.patternId, r]));
  for (const v of review.perPattern) {
    const s = simById.get(v.patternId);
    check(
      `${p.id}/${v.patternId}: verdict agrees with reviewSchema (${v.verdict})`,
      !!s && s.verdict === v.verdict && s.path === v.path,
      `sim=${s?.verdict}/${s?.path}`,
    );
  }
}

// 3) URL shortener: the unindexed per-user pattern full-scans the table.
{
  const p = problemById('url-shortener');
  const before = simulateSchema(p, structuredClone(p.schema));
  const p2 = before.perPattern.find((r) => r.patternId === 'us-p2')!;
  check('us-p2 is a full scan over all rows', p2.path === '全表扫描' && p2.rowsExaminedPerQuery === 1_000_000_000 && p2.verdict === '不通过',
    `examined=${p2.rowsExaminedPerQuery} p99=${p2.p99Ms}`);

  // Add the missing index → the same pattern's numbers must move.
  const edited: ProblemSchema = structuredClone(p.schema);
  edited.tables[0]!.fields.find((f) => f.name === 'user_id')!.indexed = true;
  const after = simulateSchema(p, edited);
  const p2a = after.perPattern.find((r) => r.patternId === 'us-p2')!;
  check('us-p2 after addIndex: indexed path, scan collapses, passes',
    p2a.path === '索引查询' && p2a.rowsExaminedPerQuery < 10_000 && p2a.verdict === '通过' && p2a.p99Ms < p2.p99Ms / 100,
    `examined=${p2a.rowsExaminedPerQuery} p99 ${p2.p99Ms}→${p2a.p99Ms}`);

  // Growth: full-scan latency ×10, indexed lookup ~unchanged.
  const g2 = before.perPatternGrown.find((r) => r.patternId === 'us-p2')!;
  const g1 = before.perPatternGrown.find((r) => r.patternId === 'us-p1')!;
  const n1 = before.perPattern.find((r) => r.patternId === 'us-p1')!;
  check('growth: full scan p99 grows ~×10', g2.p99Ms > p2.p99Ms * 9, `${p2.p99Ms}→${g2.p99Ms}`);
  check('growth: indexed lookup p99 ~unchanged', Math.abs(g1.p99Ms - n1.p99Ms) / n1.p99Ms < 0.5,
    `${n1.p99Ms}→${g1.p99Ms}`);
}

// 4) Instagram: follows patterns are sensitive to shard alignment.
{
  const p = problemById('instagram');
  const base = simulateSchema(p, structuredClone(p.schema));
  const p3base = base.perPattern.find((r) => r.patternId === 'ig-p3')!;

  const wrongKey: ProblemSchema = structuredClone(p.schema);
  wrongKey.tables.find((t) => t.name === 'follows')!.shardKey = 'followee_id';
  const wrong = simulateSchema(p, wrongKey);
  const p3wrong = wrong.perPattern.find((r) => r.patternId === 'ig-p3')!;

  const rightKey: ProblemSchema = structuredClone(p.schema);
  rightKey.tables.find((t) => t.name === 'follows')!.shardKey = 'follower_id';
  const right = simulateSchema(p, rightKey);
  const p3right = right.perPattern.find((r) => r.patternId === 'ig-p3')!;
  const followsRight = right.perTable.find((t) => t.table === 'follows')!;

  check('ig-p3 misaligned shard key costs more than aligned',
    p3wrong.p99Ms > p3right.p99Ms,
    `wrong=${p3wrong.p99Ms}ms (${p3wrong.path}) vs aligned=${p3right.p99Ms}ms (${p3right.path}) vs starter=${p3base.p99Ms}ms`);
  check('ig-p3 aligned: single-shard path', p3right.path === '分片内定位');
  check('ig-p3 misaligned: probes every shard (examined grows)',
    p3wrong.rowsExaminedPerQuery > p3base.rowsExaminedPerQuery,
    `${p3base.rowsExaminedPerQuery}→${p3wrong.rowsExaminedPerQuery}`);
  check('follows gains shards when sharded', followsRight.shardCount > 1, `shards=${followsRight.shardCount}`);

  // Monotonic shard key concentrates write load (shared model): likes
  // sharded by created_at must show a hotter shard than by photo_id.
  const mono: ProblemSchema = structuredClone(p.schema);
  mono.tables.find((t) => t.name === 'likes')!.shardKey = 'created_at';
  const even: ProblemSchema = structuredClone(p.schema);
  even.tables.find((t) => t.name === 'likes')!.shardKey = 'photo_id';
  const utilMono = simulateSchema(p, mono).perTable.find((t) => t.table === 'likes')!.hottestShardUtil;
  const utilEven = simulateSchema(p, even).perTable.find((t) => t.table === 'likes')!.hottestShardUtil;
  check('monotonic shard key → hotter shard than high-cardinality key',
    utilMono > utilEven, `created_at=${utilMono} vs photo_id=${utilEven}`);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
