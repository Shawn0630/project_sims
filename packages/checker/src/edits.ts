import { COMPONENT_MAP, componentDef, type ComponentTypeId } from '@sds/components';
import { MAX_EDIT_OPS, type EditOp } from '@sds/driver';
import {
  defaultSettings,
  newId,
  type Design,
  type DesignNode,
  type NodeSettings,
} from '@sds/sim-core';

/**
 * Edit-op semantics — the fix loop's safety layer.
 *
 * LLM findings and rule findings may carry structured fix actions in the
 * small vocabulary defined by the driver contract (setSetting /
 * addComponent / addEdge). Those proposals are UNTRUSTED: this module is
 * where they earn the right to be applied.
 *
 *   validateEditOps — semantic check against the concrete design the
 *                     finding was generated for: target node exists,
 *                     setting key is legal for that component type, value
 *                     type-checked and range-clamped, inserted component
 *                     type is real, endpoints exist, no duplicate edges.
 *                     Invalid ops drop individually; at most MAX_EDIT_OPS
 *                     survive.
 *   applyEditOps    — pure application (input never mutated). addComponent
 *                     inserts BETWEEN its two endpoints: the new edges
 *                     from→new and new→to are added, and a direct from→to
 *                     edge, when present, is removed so traffic actually
 *                     flows through the inserted component.
 *   describeEditOp  — plain-language rendering of one op against a design.
 *
 * The web app mirrors apply/describe for its local preview (it cannot
 * import this package — that would drag problem data into the bundle);
 * the semantics here are the reference.
 */

type SettingRule =
  | { kind: 'int'; min: number; max: number }
  | { kind: 'number'; min: number; max: number }
  | { kind: 'boolean' }
  | { kind: 'string'; maxLen: number }
  | { kind: 'enum'; values: readonly string[] };

const COMMON_RULES: Record<string, SettingRule> = {
  replicas: { kind: 'int', min: 1, max: 16 },
  capacityScale: { kind: 'number', min: 0.25, max: 4 },
};

const STORAGE_RULES: Record<string, SettingRule> = {
  readReplicas: { kind: 'int', min: 0, max: 8 },
  sharded: { kind: 'boolean' },
  shardKey: { kind: 'string', maxLen: 40 },
  consistency: { kind: 'enum', values: ['eventual', 'strong'] },
};

const BY_TYPE_RULES: Partial<Record<ComponentTypeId, Record<string, SettingRule>>> = {
  loadbalancer: {
    lbAlgorithm: { kind: 'enum', values: ['round_robin', 'least_connections', 'consistent_hashing'] },
  },
  gateway: { rateLimitPerSec: { kind: 'int', min: 0, max: 200_000 } },
  cache: {
    eviction: { kind: 'enum', values: ['LRU', 'LFU', 'TTL'] },
    mutexRebuild: { kind: 'boolean' },
  },
  relationaldb: STORAGE_RULES,
  nosql: STORAGE_RULES,
};

/** The setting rule for (component type, key), or undefined when illegal. */
export function settingRuleFor(type: ComponentTypeId, key: string): SettingRule | undefined {
  // The client is the traffic source; it has no tunable settings.
  if (type === 'client') return undefined;
  return BY_TYPE_RULES[type]?.[key] ?? COMMON_RULES[key];
}

function coerceValue(
  rule: SettingRule,
  value: string | number | boolean,
): string | number | boolean | undefined {
  switch (rule.kind) {
    case 'int': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
      return Math.min(rule.max, Math.max(rule.min, Math.round(value)));
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
      return Math.min(rule.max, Math.max(rule.min, value));
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined;
    case 'string': {
      if (typeof value !== 'string') return undefined;
      const s = value.trim();
      return s.length >= 1 && s.length <= rule.maxLen ? s : undefined;
    }
    case 'enum':
      return typeof value === 'string' && rule.values.includes(value) ? value : undefined;
  }
}

/**
 * Validate proposed ops against a design. Returns the surviving ops
 * (values coerced/clamped), in order, capped at MAX_EDIT_OPS.
 */
export function validateEditOps(
  ops: readonly EditOp[] | undefined,
  design: Design,
): EditOp[] {
  if (!ops || !ops.length) return [];
  const nodeById = new Map(design.nodes.map((n) => [n.id, n]));
  const plannedEdges = new Set(design.edges.map((e) => `${e.from}→${e.to}`));
  const out: EditOp[] = [];
  for (const op of ops) {
    if (out.length >= MAX_EDIT_OPS) break;
    if (op.op === 'setSetting') {
      const node = nodeById.get(op.nodeId);
      if (!node) continue;
      const rule = settingRuleFor(node.type, op.key);
      if (!rule) continue;
      const value = coerceValue(rule, op.value);
      if (value === undefined) continue;
      out.push({ op: 'setSetting', nodeId: op.nodeId, key: op.key, value });
    } else if (op.op === 'addComponent') {
      if (!(op.componentType in COMPONENT_MAP)) continue;
      const from = op.connectFromId;
      const to = op.connectToId;
      if (from && !nodeById.has(from)) continue;
      if (to && !nodeById.has(to)) continue;
      if (!from && !to) continue;
      if (from && to && from === to) continue;
      out.push({
        op: 'addComponent',
        componentType: op.componentType,
        ...(from ? { connectFromId: from } : {}),
        ...(to ? { connectToId: to } : {}),
      });
    } else if (op.op === 'addEdge') {
      if (!nodeById.has(op.fromId) || !nodeById.has(op.toId)) continue;
      if (op.fromId === op.toId) continue;
      const key = `${op.fromId}→${op.toId}`;
      if (plannedEdges.has(key)) continue;
      plannedEdges.add(key);
      out.push({ op: 'addEdge', fromId: op.fromId, toId: op.toId });
    }
  }
  return out;
}

/**
 * Apply validated ops to a design, returning a NEW design (the input is
 * never mutated — the frontend's preview relies on the same guarantee).
 */
export function applyEditOps(design: Design, ops: readonly EditOp[]): Design {
  const next: Design = structuredClone(design);
  const nodeById = new Map(next.nodes.map((n) => [n.id, n]));
  for (const op of ops) {
    if (op.op === 'setSetting') {
      const node = nodeById.get(op.nodeId);
      if (!node) continue;
      node.settings = { ...node.settings, [op.key]: op.value } as NodeSettings;
    } else if (op.op === 'addComponent') {
      const from = op.connectFromId ? nodeById.get(op.connectFromId) : undefined;
      const to = op.connectToId ? nodeById.get(op.connectToId) : undefined;
      const id = newId(op.componentType);
      let x = 480;
      let y = 300;
      if (from && to) {
        x = (from.x + to.x) / 2;
        y = (from.y + to.y) / 2 + 64;
      } else if (from) {
        x = from.x + 150;
        y = from.y + 64;
      } else if (to) {
        x = to.x - 150;
        y = to.y + 64;
      }
      const node: DesignNode = {
        id,
        type: op.componentType,
        x: Math.max(60, Math.min(900, x)),
        y: Math.max(40, Math.min(560, y)),
        settings: defaultSettings(op.componentType),
      };
      next.nodes.push(node);
      nodeById.set(id, node);
      if (from && to) {
        // Insertion replaces the direct hop so flow goes through the node.
        next.edges = next.edges.filter((e) => !(e.from === from.id && e.to === to.id));
      }
      if (from) next.edges.push({ id: newId('edge'), from: from.id, to: id });
      if (to) next.edges.push({ id: newId('edge'), from: id, to: to.id });
    } else if (op.op === 'addEdge') {
      if (!next.edges.some((e) => e.from === op.fromId && e.to === op.toId)) {
        next.edges.push({ id: newId('edge'), from: op.fromId, to: op.toId });
      }
    }
  }
  return next;
}

const KEY_LABELS: Record<string, string> = {
  replicas: '副本数',
  capacityScale: '容量倍率',
  rateLimitPerSec: '限流',
  mutexRebuild: '互斥重建',
  eviction: '淘汰策略',
  lbAlgorithm: '均衡策略',
  readReplicas: '读副本',
  sharded: '分片',
  shardKey: '分片键',
  consistency: '一致性',
};

function nodeName(design: Design, id: string): string {
  const n = design.nodes.find((x) => x.id === id);
  return n ? `${componentDef(n.type).name}「${n.label ?? n.id}」` : `节点「${id}」`;
}

function fmtValue(key: string, value: string | number | boolean | undefined): string {
  if (value === undefined) return '（未设置）';
  if (typeof value === 'boolean') return value ? '开' : '关';
  if (key === 'rateLimitPerSec') return Number(value) === 0 ? '关闭' : `${value}/秒`;
  return String(value);
}

/** Plain-language rendering of one op against the pre-apply design. */
export function describeEditOp(op: EditOp, design: Design): string {
  if (op.op === 'setSetting') {
    const node = design.nodes.find((n) => n.id === op.nodeId);
    const old = node ? (node.settings as unknown as Record<string, unknown>)[op.key] : undefined;
    return `${nodeName(design, op.nodeId)}：${KEY_LABELS[op.key] ?? op.key} ${fmtValue(op.key, old as never)} → ${fmtValue(op.key, op.value)}`;
  }
  if (op.op === 'addComponent') {
    const name = componentDef(op.componentType).name;
    if (op.connectFromId && op.connectToId) {
      return `新增${name}节点，接入 ${nodeName(design, op.connectFromId)} → ${nodeName(design, op.connectToId)} 之间`;
    }
    if (op.connectFromId) return `新增${name}节点，接在 ${nodeName(design, op.connectFromId)} 之后`;
    return `新增${name}节点，接入 ${nodeName(design, op.connectToId!)} 之前`;
  }
  return `新增连线：${nodeName(design, op.fromId)} → ${nodeName(design, op.toId)}`;
}
