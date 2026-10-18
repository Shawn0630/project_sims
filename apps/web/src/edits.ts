import { COMPONENT_MAP, componentDef, type ComponentTypeId } from '@sds/components';
import { defaultSettings, newId, type Design } from '@sds/sim-core';
import type { EditOpDTO } from './api';

/**
 * Local mirror of the fix-action semantics (@sds/checker edits.ts is the
 * reference implementation). The web app cannot import the checker package
 * (that would drag problem data into the bundle), so the two small pieces
 * the preview needs live here:
 *
 *   recheckActions — before a preview is offered, re-check the (already
 *     server-validated) actions against the CURRENT design: if the user
 *     edited the graph since the finding was generated, ops pointing at
 *     vanished nodes are dropped; if nothing survives, applying is
 *     refused gracefully.
 *   applyActions   — PURE: returns the would-be design plus plain-language
 *     change descriptions and highlight marks. The committed design state
 *     is only replaced when the user confirms the preview.
 */

export interface PreviewMarks {
  addedNodeIds: Set<string>;
  addedEdgeIds: Set<string>;
  modifiedNodeIds: Set<string>;
}

export interface PreviewPlan {
  design: Design;
  descriptions: string[];
  marks: PreviewMarks;
}

/** Setting keys the client considers plausible per component type — a
 *  mirror of the server's table, used only for the existence re-check. */
const LEGAL_KEYS: Partial<Record<ComponentTypeId, string[]>> = {
  loadbalancer: ['replicas', 'capacityScale', 'lbAlgorithm'],
  gateway: ['replicas', 'capacityScale', 'rateLimitPerSec'],
  cache: ['replicas', 'capacityScale', 'eviction', 'mutexRebuild'],
  relationaldb: ['replicas', 'capacityScale', 'readReplicas', 'sharded', 'shardKey', 'consistency'],
  nosql: ['replicas', 'capacityScale', 'readReplicas', 'sharded', 'shardKey', 'consistency'],
};

export function recheckActions(actions: EditOpDTO[], design: Design): EditOpDTO[] {
  const ids = new Set(design.nodes.map((n) => n.id));
  const edges = new Set(design.edges.map((e) => `${e.from}→${e.to}`));
  return actions.filter((op) => {
    if (op.op === 'setSetting') {
      const node = design.nodes.find((n) => n.id === op.nodeId);
      if (!node || node.type === 'client') return false;
      return (LEGAL_KEYS[node.type] ?? ['replicas', 'capacityScale']).includes(op.key);
    }
    if (op.op === 'addComponent') {
      if (!(op.componentType in COMPONENT_MAP)) return false;
      if (op.connectFromId && !ids.has(op.connectFromId)) return false;
      if (op.connectToId && !ids.has(op.connectToId)) return false;
      return !!(op.connectFromId || op.connectToId);
    }
    return (
      ids.has(op.fromId) && ids.has(op.toId) && op.fromId !== op.toId && !edges.has(`${op.fromId}→${op.toId}`)
    );
  });
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

export function describeAction(op: EditOpDTO, design: Design): string {
  if (op.op === 'setSetting') {
    const node = design.nodes.find((n) => n.id === op.nodeId);
    const old = node
      ? (node.settings as unknown as Record<string, unknown>)[op.key]
      : undefined;
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

/**
 * Compute the preview: a NEW design with the ops applied (same semantics
 * as the server's applyEditOps — insertion replaces the direct hop), the
 * plain-language change list, and the highlight marks. Pure: the input
 * design is never mutated.
 */
export function applyActions(design: Design, ops: EditOpDTO[]): PreviewPlan {
  const descriptions = ops.map((op) => describeAction(op, design));
  const marks: PreviewMarks = {
    addedNodeIds: new Set(),
    addedEdgeIds: new Set(),
    modifiedNodeIds: new Set(),
  };
  const next: Design = structuredClone(design);
  const nodeById = new Map(next.nodes.map((n) => [n.id, n]));
  for (const op of ops) {
    if (op.op === 'setSetting') {
      const node = nodeById.get(op.nodeId);
      if (!node) continue;
      node.settings = { ...node.settings, [op.key]: op.value };
      marks.modifiedNodeIds.add(node.id);
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
      const node = {
        id,
        type: op.componentType,
        x: Math.max(60, Math.min(900, x)),
        y: Math.max(40, Math.min(560, y)),
        settings: defaultSettings(op.componentType),
      };
      next.nodes.push(node);
      nodeById.set(id, node);
      marks.addedNodeIds.add(id);
      if (from && to) {
        next.edges = next.edges.filter((e) => !(e.from === from.id && e.to === to.id));
      }
      if (from) {
        const e = { id: newId('edge'), from: from.id, to: id };
        next.edges.push(e);
        marks.addedEdgeIds.add(e.id);
      }
      if (to) {
        const e = { id: newId('edge'), from: id, to: to.id };
        next.edges.push(e);
        marks.addedEdgeIds.add(e.id);
      }
    } else if (op.op === 'addEdge') {
      if (!next.edges.some((e) => e.from === op.fromId && e.to === op.toId)) {
        const e = { id: newId('edge'), from: op.fromId, to: op.toId };
        next.edges.push(e);
        marks.addedEdgeIds.add(e.id);
      }
    }
  }
  return { design: next, descriptions, marks };
}
