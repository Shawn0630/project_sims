import { PROBLEMS } from '@sds/problems';
import { simulateSchema } from '@sds/checker';

for (const p of PROBLEMS) {
  const sim = simulateSchema(p, structuredClone(p.schema));
  console.log(`\n=== ${p.id} (budget ${sim.budgetMs}ms) ===`);
  for (const r of sim.perPattern) {
    console.log(
      `  ${r.patternId} ${r.name} [${r.table}/${r.kind}] ${r.path} qps=${r.qps} examined=${r.rowsExaminedPerQuery.toLocaleString()} avg=${r.avgMs}ms p99=${r.p99Ms}ms → ${r.verdict}`,
    );
  }
  for (const t of sim.perTable) {
    console.log(
      `  TABLE ${t.table}: rows=${t.rows.toLocaleString()} size=${(t.sizeBytesNow / 1e9).toFixed(2)}GB→${(t.sizeBytesGrown / 1e9).toFixed(1)}GB shards=${t.shardCount} idx=${t.indexCount} amp=×${t.writeAmpFactor} read=${t.readQps}/s write=${t.writeQps}/s util=${t.hottestShardUtil}→grown ${t.hottestShardUtilGrown}`,
    );
  }
  console.log(
    `  HEADLINE firstBreak=${JSON.stringify(sim.headline.firstBreak)} maxSustainable=${sim.headline.maxSustainableQps} bottleneck=${sim.headline.bottleneckTable}/${sim.headline.bottleneckPatternId}`,
  );
  const g = sim.perPatternGrown.filter((r) => r.verdict !== '通过');
  for (const r of g) {
    console.log(`  GROWN ⚠ ${r.patternId} ${r.name}: ${r.path} p99=${r.p99Ms}ms → ${r.verdict}`);
  }
}
