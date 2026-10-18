import { componentDef, type ComponentTypeId } from '@sds/components';
import type { EditOp } from '@sds/driver';
import type { ProblemDef } from '@sds/problems';
import type { Design, DesignNode } from '@sds/sim-core';

export interface StructuralFinding {
  ruleId: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  componentIds: string[];
  /** Test case id that will typically expose this defect. */
  exposedBy?: string;
  /**
   * Canned one-click fix in the edit-op vocabulary — attached ONLY where
   * the rule implies one unambiguous edit (see the per-rule notes in
   * checkStructure). Findings without a safe canned fix stay text-only.
   */
  actions?: EditOp[];
}

const LOAD_BEARING: ComponentTypeId[] = [
  'loadbalancer',
  'gateway',
  'appserver',
  'feedservice',
  'searchservice',
  'cache',
  'relationaldb',
  'nosql',
  'queue',
  'worker',
];

function connected(design: Design, node: DesignNode): boolean {
  return design.edges.some((e) => e.from === node.id || e.to === node.id);
}

function ofType(design: Design, type: ComponentTypeId): DesignNode[] {
  return design.nodes.filter((n) => n.type === type);
}

/**
 * Deterministic structural checker — the "design bugs" layer.
 *
 * These rules inspect the submitted graph only (no traffic, no LLM), so a
 * useful bug report exists even fully offline. Each finding names what is
 * wrong, why it breaks, and which test case will expose it.
 */
export function checkStructure(problem: ProblemDef, design: Design): StructuralFinding[] {
  const findings: StructuralFinding[] = [];
  const push = (f: StructuralFinding) => findings.push(f);

  // --- Single point of failure -------------------------------------------
  for (const node of design.nodes) {
    if (!LOAD_BEARING.includes(node.type)) continue;
    if (!connected(design, node)) continue;
    if (node.settings.replicas !== 1) continue;
    const critical = ['loadbalancer', 'gateway', 'relationaldb', 'nosql'].includes(node.type);
    push({
      ruleId: 'spof',
      severity: critical ? 'high' : 'medium',
      title: `单点故障：${componentDef(node.type).name} 只有一个节点`,
      detail: `${componentDef(node.type).name}「${node.label ?? node.id}」replicas=1 且是唯一节点。它宕机时这一层整体消失，流量无处改道。改法：同类型至少再加一个节点（只加 replicas 不算跨节点冗余）。`,
      componentIds: [node.id],
      exposedBy: problem.testCases.find((c) => c.exposesRule === 'spof')?.id,
      // Canned fix: bump this node's replicas to 2 (one-click capacity
      // redundancy; full cross-node redundancy stays a manual design move).
      actions: [{ op: 'setSetting', nodeId: node.id, key: 'replicas', value: 2 }],
    });
  }

  // --- Hot read path with no cache ----------------------------------------
  const storage = design.nodes.filter(
    (n) => componentDef(n.type).behavior === 'storage' && n.type !== 'objectstorage',
  );
  if (problem.flags.readHeavy && storage.length > 0 && ofType(design, 'cache').length === 0) {
    // Canned fix: insert a cache between a service feeding the first
    // reachable storage node and that storage node itself.
    let cacheActions: EditOp[] | undefined;
    for (const s of storage) {
      const upstreams = design.edges
        .filter((e) => e.to === s.id)
        .map((e) => design.nodes.find((n) => n.id === e.from))
        .filter((n): n is DesignNode => !!n);
      const svc =
        upstreams.find((u) => ['appserver', 'feedservice', 'searchservice'].includes(u.type)) ??
        upstreams[0];
      if (svc) {
        cacheActions = [
          { op: 'addComponent', componentType: 'cache', connectFromId: svc.id, connectToId: s.id },
        ];
        break;
      }
    }
    push({
      ruleId: 'hot-read-no-cache',
      severity: 'high',
      title: '读热点路径上没有缓存层',
      detail: `本题读占比 ${Math.round(problem.scale.readRatio * 100)}%，但设计中没有任何缓存节点，所有读请求都直达存储。读流量一涨，DB 就是第一个瓶颈。在存储前加一层 Redis 缓存。`,
      componentIds: storage.map((s) => s.id),
      exposedBy: problem.testCases.find((c) => c.exposesRule === 'hot-read-no-cache')?.id,
      ...(cacheActions ? { actions: cacheActions } : {}),
    });
  }

  // --- Blobs routed to relational DB ---------------------------------------
  if (problem.flags.mediaHeavy) {
    const obj = ofType(design, 'objectstorage');
    const rel = ofType(design, 'relationaldb');
    if (obj.length === 0 && rel.length > 0) {
      push({
        ruleId: 'blob-in-db',
        severity: 'high',
        title: '媒体内容没有对象存储，流量压在关系型 DB 上',
        detail: '照片/视频这类大对象不该走关系型 DB：贵、慢、还挤占元数据查询的容量。加对象存储存文件本体，DB 只存元数据，前面再用 CDN 分发。',
        componentIds: rel.map((r) => r.id),
      });
    } else if (obj.length > 0 && !obj.some((o) => connected(design, o))) {
      push({
        ruleId: 'blob-in-db',
        severity: 'medium',
        title: '对象存储放了但没有连线使用',
        detail: '对象存储节点不在任何数据路径上，媒体流量仍然无处可去。把上传/下载链路接到它上面。',
        componentIds: obj.map((o) => o.id),
      });
    }
    if (ofType(design, 'cdn').length === 0) {
      push({
        ruleId: 'no-cdn',
        severity: 'medium',
        title: '媒体读路径没有 CDN',
        detail: '读多且是媒体内容时，没有 CDN 意味着全部读流量回源。加 CDN 后源站通常只承受 10–15% 的流量。',
        componentIds: [],
      });
    }
  }

  // --- Synchronous fan-out --------------------------------------------------
  if (problem.flags.hasFanout) {
    const services = [...ofType(design, 'feedservice'), ...ofType(design, 'appserver')];
    const fanoutStorage = design.nodes.filter(
      (n) => componentDef(n.type).behavior === 'storage' && n.type !== 'objectstorage',
    );
    const queues = ofType(design, 'queue');
    const workers = ofType(design, 'worker');
    const hasEdge = (from: string, to: string) =>
      design.edges.some((e) => e.from === from && e.to === to);
    // Classify each fan-out write path out of a service: a DIRECT edge
    // into storage (the synchronous path), or a queue the service feeds
    // that itself writes to storage. A path is 'ready' only when a
    // worker already drains its queue into the storage; 'buffered' when
    // a queue sits on the path but nobody consumes it toward storage.
    interface FanoutPath {
      svc: DesignNode;
      store: DesignNode;
      queue?: DesignNode;
      state: 'sync' | 'buffered' | 'ready';
    }
    const paths: FanoutPath[] = [];
    for (const svc of services) {
      for (const store of fanoutStorage) {
        const queue = queues.find((q) => hasEdge(svc.id, q.id));
        const workerDrains =
          !!queue && workers.some((w) => hasEdge(queue.id, w.id) && hasEdge(w.id, store.id));
        if (hasEdge(svc.id, store.id)) {
          paths.push({
            svc,
            store,
            ...(queue ? { queue } : {}),
            state: workerDrains ? 'ready' : 'sync',
          });
        } else if (queue && hasEdge(queue.id, store.id) && !workerDrains) {
          paths.push({ svc, store, queue, state: 'buffered' });
        }
      }
    }
    // The finding fires while fan-out still writes synchronously: some
    // path is not 'ready' — or (the legacy condition) the design has no
    // queue anywhere at all.
    if (paths.some((p) => p.state !== 'ready') || (queues.length === 0 && services.length > 0)) {
      // Canned fix, when the remedy is mechanically expressible on one of
      // the sync paths: build service → queue → worker → storage. The
      // queue insert declares newNodeId so the worker insert chains onto
      // the node it creates. When queue + worker already serve the path
      // the remaining sync edge can't be removed with this vocabulary
      // (no delete ops), so the finding stays text-only there.
      let actions: EditOp[] | undefined;
      let anchor: FanoutPath | undefined;
      for (const p of paths) {
        if (p.state === 'ready') continue;
        if (p.queue) {
          // A queue already buffers this path but nobody consumes it
          // toward storage — the worker insert alone completes the chain.
          actions = [
            {
              op: 'addComponent',
              componentType: 'worker',
              connectFromId: p.queue.id,
              connectToId: p.store.id,
            },
          ];
        } else {
          actions = [
            {
              op: 'addComponent',
              componentType: 'queue',
              connectFromId: p.svc.id,
              connectToId: p.store.id,
              newNodeId: 'fix-fanout-queue',
            },
            {
              op: 'addComponent',
              componentType: 'worker',
              connectFromId: 'fix-fanout-queue',
              connectToId: p.store.id,
            },
          ];
        }
        anchor = p;
        break;
      }
      const componentIds = new Set(services.map((s) => s.id));
      if (anchor) {
        componentIds.add(anchor.store.id);
        if (anchor.queue) componentIds.add(anchor.queue.id);
      }
      push({
        ruleId: 'sync-fanout',
        severity: 'high',
        title: 'fan-out 是同步的：发帖直写存储，没有队列削峰',
        detail: '大 V 发帖时，一次写会被放大成成千上万次时间线写入。同步做，这些写会瞬间打满存储；异步做（队列 + Worker），同样的总量可以摊到几十秒内消化。',
        componentIds: [...componentIds],
        exposedBy: problem.testCases.find((c) => c.exposesRule === 'sync-fanout')?.id,
        ...(actions ? { actions } : {}),
      });
    }
  }

  // --- Queue / worker pairing ----------------------------------------------
  const queues = ofType(design, 'queue');
  const workers = ofType(design, 'worker');
  for (const w of workers) {
    const hasQueueUpstream = design.edges.some(
      (e) => e.to === w.id && design.nodes.find((n) => n.id === e.from)?.type === 'queue',
    );
    if (!hasQueueUpstream) {
      // Canned fix: insert a queue directly in front of this worker, wired
      // from whichever producer currently feeds it (when it has one).
      const producer = design.edges.find((e) => e.to === w.id)?.from;
      push({
        ruleId: 'missing-queue',
        severity: 'medium',
        title: 'Worker 前面没有队列缓冲',
        detail: '突发流量会直接砸到 Worker 上，慢消费者被打爆而不是排队等待。在生产者与 Worker 之间加消息队列。',
        componentIds: [w.id],
        ...(producer
          ? {
              actions: [
                {
                  op: 'addComponent',
                  componentType: 'queue',
                  connectFromId: producer,
                  connectToId: w.id,
                } as EditOp,
              ],
            }
          : {}),
      });
    }
  }
  for (const qNode of queues) {
    const hasConsumer = design.edges.some((e) => e.from === qNode.id);
    if (!hasConsumer) {
      push({
        ruleId: 'queue-no-consumer',
        severity: 'low',
        title: '队列没有下游消费者',
        detail: '消息进了队列却没人消费，只会无限积压。给队列接上 Worker 或存储。',
        componentIds: [qNode.id],
      });
    }
  }

  // --- DB scale plan ----------------------------------------------------------
  const peakWriteTps =
    problem.scale.baselineRps * problem.scale.peakMultiplier * (1 - problem.scale.readRatio);
  const relDbs = ofType(design, 'relationaldb');
  for (const db of relDbs) {
    const singleCap = componentDef('relationaldb').defaultCapacityPerReplica;
    if (
      peakWriteTps > singleCap &&
      !db.settings.sharded &&
      (db.settings.readReplicas ?? 0) === 0
    ) {
      push({
        ruleId: 'db-scale',
        severity: 'high',
        title: 'DB 没有扩展计划，但峰值写量已超单机上限',
        detail: `本题峰值写约 ${Math.round(peakWriteTps)} TPS，超过单机关系库约 ${singleCap} 的处理上限，且该 DB 既没开分片也没有读副本。改法：开分片（选好分片键）、加读副本分担读、或把热点数据迁到 NoSQL。`,
        componentIds: [db.id],
        exposedBy: problem.testCases.find((c) => c.exposesRule === 'db-scale')?.id,
        // Canned fix: turn sharding on for this store (its shard key is
        // already the default user_id unless the bad-shard-key rule fired).
        actions: [{ op: 'setSetting', nodeId: db.id, key: 'sharded', value: true }],
      });
    }
    if (db.settings.sharded && ['created_at', 'timestamp', 'id'].includes(db.settings.shardKey ?? '')) {
      push({
        ruleId: 'bad-shard-key',
        severity: 'high',
        title: `分片键选了单调字段「${db.settings.shardKey}」`,
        detail: '单调递增的分片键会让新写入永远落在同一个分片上，形成热点分片，分了等于没分。换成高基数、分布均匀的键（如 user_id）。',
        componentIds: [db.id],
        exposedBy: problem.testCases.find((c) => c.exposesRule === 'db-scale')?.id,
        actions: [{ op: 'setSetting', nodeId: db.id, key: 'shardKey', value: 'user_id' }],
      });
    }
  }
  for (const store of ofType(design, 'nosql')) {
    if (store.settings.sharded && ['created_at', 'timestamp', 'id'].includes(store.settings.shardKey ?? '')) {
      push({
        ruleId: 'bad-shard-key',
        severity: 'high',
        title: `NoSQL 分片键选了单调字段「${store.settings.shardKey}」`,
        detail: '单调键让写入集中在单个分片（热点分片）。换成 user_id 这类高基数均匀分布的键。',
        componentIds: [store.id],
        exposedBy: problem.testCases.find((c) => c.exposesRule === 'db-scale')?.id,
        actions: [{ op: 'setSetting', nodeId: store.id, key: 'shardKey', value: 'user_id' }],
      });
    }
  }

  // --- Rate limiting on public write API --------------------------------------
  if (problem.flags.publicWriteApi) {
    const gateways = ofType(design, 'gateway');
    if (gateways.length === 0) {
      push({
        ruleId: 'no-rate-limit',
        severity: 'medium',
        title: '公开写接口没有网关限流',
        detail: '没有 API 网关，写接口直接暴露：一个失控客户端就能打满下游。加网关并开启限流（令牌桶）。',
        componentIds: [],
      });
    } else if (gateways.every((g) => (g.settings.rateLimitPerSec ?? 0) === 0)) {
      // Canned fix: enable rate limiting on the first gateway, sized from
      // the problem's peak demand (baseline × peak multiplier).
      const limit = Math.max(
        100,
        Math.round(problem.scale.baselineRps * problem.scale.peakMultiplier),
      );
      push({
        ruleId: 'no-rate-limit',
        severity: 'medium',
        title: '网关在，但限流没开',
        detail: '网关的限流阈值是 0（关闭）。按下游真实容量反推一个阈值并开启，否则突发与滥用流量会长驱直入。',
        componentIds: gateways.map((g) => g.id),
        actions: [
          { op: 'setSetting', nodeId: gateways[0]!.id, key: 'rateLimitPerSec', value: limit },
        ],
      });
    }
  }

  const order = { high: 0, medium: 1, low: 2 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity]);
}
