import { MAX_SCHEMA_OPS, type SchemaOp } from '@sds/driver';
import type { ProblemSchema } from '@sds/problems';

/**
 * Schema-op semantics — the schema half of the action guarantee.
 *
 * A schema suggestion (LLM-written, repair-pass, rule-synthesized or the
 * universal fallback) may carry structured schema operations in the small
 * vocabulary defined by the driver contract (setShardKey / addIndex /
 * setPrimaryKeyGen / setEngine). Those proposals are UNTRUSTED:
 *
 *   validateSchemaOps — semantic check against the concrete schema the
 *                       suggestion was generated for: the table exists,
 *                       the field exists, enum values are legal — and the
 *                       op is not a NO-OP (an index that already exists,
 *                       a shard key already set to that field, the gen /
 *                       engine already current). A no-op "fix" would be a
 *                       lie of an apply button, so it drops like an
 *                       invalid op. Invalid ops drop individually; at
 *                       most MAX_SCHEMA_OPS survive.
 *   applySchemaOps    — pure application (input never mutated): the web
 *                       app mirrors this for its preview; semantics here
 *                       are the reference.
 *   describeSchemaOp  — plain-language rendering (table / field /
 *                       old → new) for the preview list.
 */

const PK_GENS: readonly string[] = ['auto', 'snowflake', 'uuid', 'business'];
const ENGINES: readonly string[] = ['relational', 'nosql'];

export function validateSchemaOps(
  ops: readonly SchemaOp[] | undefined,
  schema: ProblemSchema,
): SchemaOp[] {
  if (!ops || !ops.length) return [];
  // Validate against a working copy so sequential ops see each other's
  // effects (e.g. addIndex then setShardKey on the same field is fine;
  // addIndex twice on the same field drops the second as a no-op).
  const working = structuredClone(schema);
  const tableOf = (name: string) => working.tables.find((t) => t.name === name);
  const out: SchemaOp[] = [];
  for (const op of ops) {
    if (out.length >= MAX_SCHEMA_OPS) break;
    const table = tableOf(op.table);
    if (!table) continue;
    if (op.op === 'setShardKey') {
      if (op.field !== null) {
        if (!table.fields.some((f) => f.name === op.field)) continue;
        if (table.shardKey === op.field) continue; // already the shard key
      } else if (table.shardKey === null) {
        continue; // already unsharded
      }
      out.push(op);
      table.shardKey = op.field;
    } else if (op.op === 'addIndex') {
      const field = table.fields.find((f) => f.name === op.field);
      if (!field || field.indexed) continue; // missing, or already indexed (no-op)
      out.push(op);
      field.indexed = true;
    } else if (op.op === 'setPrimaryKeyGen') {
      if (!PK_GENS.includes(op.gen) || table.primaryKeyGen === op.gen) continue;
      out.push(op);
      table.primaryKeyGen = op.gen;
    } else if (op.op === 'setEngine') {
      if (!ENGINES.includes(op.engine) || table.engine === op.engine) continue;
      out.push(op);
      table.engine = op.engine;
    }
  }
  return out;
}

/**
 * Apply validated schema ops to a schema draft, returning a NEW schema
 * (the input is never mutated — the frontend's preview relies on the
 * same guarantee). Ops whose target vanished are skipped silently; the
 * caller re-validates first, so this is belt-and-braces.
 */
export function applySchemaOps(schema: ProblemSchema, ops: readonly SchemaOp[]): ProblemSchema {
  const next: ProblemSchema = structuredClone(schema);
  for (const op of ops) {
    const table = next.tables.find((t) => t.name === op.table);
    if (!table) continue;
    if (op.op === 'setShardKey') {
      table.shardKey = op.field;
    } else if (op.op === 'addIndex') {
      const field = table.fields.find((f) => f.name === op.field);
      if (field) field.indexed = true;
    } else if (op.op === 'setPrimaryKeyGen') {
      table.primaryKeyGen = op.gen;
    } else if (op.op === 'setEngine') {
      table.engine = op.engine;
    }
  }
  return next;
}

const GEN_LABELS: Record<string, string> = {
  auto: '自增',
  snowflake: '雪花',
  uuid: 'UUID',
  business: '业务键',
};
const ENGINE_LABELS: Record<string, string> = { relational: '关系型', nosql: 'NoSQL' };

/** Plain-language rendering of one op against the pre-apply schema. */
export function describeSchemaOp(op: SchemaOp, schema: ProblemSchema): string {
  const table = schema.tables.find((t) => t.name === op.table);
  if (op.op === 'setShardKey') {
    return `表 ${op.table}：分片键 ${table?.shardKey ?? '无'} → ${op.field ?? '无（不分片）'}`;
  }
  if (op.op === 'addIndex') {
    return `表 ${op.table}：给字段 ${op.field} 加索引（当前未索引 → 已索引）`;
  }
  if (op.op === 'setPrimaryKeyGen') {
    return `表 ${op.table}：主键生成 ${GEN_LABELS[table?.primaryKeyGen ?? ''] ?? table?.primaryKeyGen ?? '？'} → ${GEN_LABELS[op.gen] ?? op.gen}`;
  }
  return `表 ${op.table}：存储引擎 ${ENGINE_LABELS[table?.engine ?? ''] ?? table?.engine ?? '？'} → ${ENGINE_LABELS[op.engine] ?? op.engine}`;
}
