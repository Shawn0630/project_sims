import { componentDef, type ComponentTypeId } from '@sds/components';
import type {
  ActiveEvent,
  Design,
  DesignNode,
  EventType,
  MetricsSnapshot,
  NodeMetrics,
  TrafficConfig,
} from './types';
import { newId } from './types';

/**
 * SimulationEngine — a deterministic, analytic (not packet-level) model of
 * request flow through a design graph. One tick = one simulated second.
 *
 * Flow model (deliberately simple and explainable):
 *  - Traffic enters through `client` nodes and propagates in topological order.
 *  - A node with several downstream edges of the SAME component type splits
 *    flow evenly across them (load-balancing case); downstream edges of
 *    DIFFERENT types each receive the full flow (one request really does
 *    touch cache + DB + search).
 *  - offload nodes (CDN/cache) serve `hitRate` of inbound locally and forward
 *    only misses; queue nodes drain at the total capacity of their downstream
 *    workers and accumulate the rest as queue depth.
 *  - util = inQps / (replicas × per-replica capacity). Latency grows
 *    super-linearly with util; above util 1 an increasing share of requests
 *    fail at that node. Flow into a killed node is lost and counted as error.
 *
 * The model is deterministic so test-case verdicts are reproducible.
 */

const BAD_SHARD_KEYS = new Set(['created_at', 'timestamp', 'id', 'auto_id', 'seq']);

interface NodeState {
  queueDepth: number;
}

export class SimulationEngine {
  private design: Design;
  private traffic: TrafficConfig;
  private events: ActiveEvent[] = [];
  private killed = new Set<string>();
  private state = new Map<string, NodeState>();
  private tickCount = 0;
  private last: MetricsSnapshot;

  constructor(design: Design, traffic: TrafficConfig) {
    this.design = structuredClone(design);
    this.traffic = { ...traffic };
    this.last = this.computeSnapshot(0);
  }

  // ------------------------------------------------------------- design ---
  getDesign(): Design {
    return structuredClone(this.design);
  }

  setDesign(design: Design): void {
    this.design = structuredClone(design);
    for (const id of [...this.killed]) {
      if (!this.design.nodes.some((n) => n.id === id)) this.killed.delete(id);
    }
    this.last = this.computeSnapshot(this.tickCount);
  }

  updateNode(nodeId: string, patch: Partial<DesignNode>): void {
    const node = this.design.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    Object.assign(node, patch);
    if (patch.settings) node.settings = { ...patch.settings };
  }

  // ------------------------------------------------------------ traffic ---
  getTraffic(): TrafficConfig {
    return { ...this.traffic };
  }

  setTraffic(patch: Partial<TrafficConfig>): void {
    // Ignore undefined fields: callers pass sparse patches (e.g. only rps),
    // and Object.assign would overwrite real values with undefined.
    if (patch.rps !== undefined) this.traffic.rps = patch.rps;
    if (patch.readRatio !== undefined) this.traffic.readRatio = patch.readRatio;
  }

  // ------------------------------------------------------------- events ---
  injectEvent(e: {
    type: EventType;
    targetType?: ComponentTypeId;
    magnitude?: number;
    durationTicks?: number;
  }): string {
    const id = newId('evt');
    const duration = e.durationTicks ?? 30;
    this.events.push({
      id,
      type: e.type,
      targetType: e.targetType,
      magnitude: e.magnitude ?? 3,
      remainingTicks: duration,
      totalTicks: duration,
    });
    return id;
  }

  activeEvents(): ActiveEvent[] {
    return this.events.map((e) => ({ ...e }));
  }

  clearEvents(): void {
    this.events = [];
  }

  // -------------------------------------------------------------- nodes ---
  killNode(nodeId: string): boolean {
    if (!this.design.nodes.some((n) => n.id === nodeId)) return false;
    this.killed.add(nodeId);
    return true;
  }

  reviveNode(nodeId: string): void {
    this.killed.delete(nodeId);
  }

  /** Kill the first alive node of a type. Returns its id, or null. */
  killByType(type: ComponentTypeId): string | null {
    const node = this.design.nodes.find((n) => n.type === type && !this.killed.has(n.id));
    if (!node) return null;
    this.killed.add(node.id);
    return node.id;
  }

  isKilled(nodeId: string): boolean {
    return this.killed.has(nodeId);
  }

  killedIds(): string[] {
    return [...this.killed];
  }

  reviveAll(): void {
    this.killed.clear();
  }

  // --------------------------------------------------------------- step ---
  step(ticks = 1): MetricsSnapshot {
    for (let i = 0; i < ticks; i++) {
      this.tickCount += 1;
      this.last = this.computeSnapshot(this.tickCount);
      for (const e of this.events) e.remainingTicks -= 1;
      this.events = this.events.filter((e) => e.remainingTicks > 0);
    }
    return this.snapshot();
  }

  snapshot(): MetricsSnapshot {
    return structuredClone(this.last);
  }

  get tick(): number {
    return this.tickCount;
  }

  // ------------------------------------------------------------ internals ---
  private effectiveTraffic(): TrafficConfig {
    let rps = this.traffic.rps;
    let readRatio = this.traffic.readRatio;
    for (const e of this.events) {
      if (e.type === 'peak') rps *= e.magnitude;
      if (e.type === 'viral_post') {
        rps *= 1 + 0.5 * (e.magnitude - 1);
        // A viral post is write-heavy: the read share drops while it runs.
        readRatio = Math.max(0.2, readRatio * (1 - 0.12 * (e.magnitude - 1)));
      }
      if (e.type === 'rw_flip') readRatio = 1 - readRatio;
    }
    return { rps, readRatio };
  }

  private hasQueueInDesign(): boolean {
    return this.design.nodes.some((n) => n.type === 'queue' && !this.killed.has(n.id));
  }

  private computeSnapshot(tick: number): MetricsSnapshot {
    const { nodes, edges } = this.design;
    const traffic = this.effectiveTraffic();
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const downstream = new Map<string, string[]>();
    const upstream = new Map<string, string[]>();
    for (const n of nodes) {
      downstream.set(n.id, []);
      upstream.set(n.id, []);
    }
    for (const e of edges) {
      downstream.get(e.from)?.push(e.to);
      upstream.get(e.to)?.push(e.from);
    }

    // Topological order (Kahn); leftovers appended in declaration order so a
    // stray cycle degrades gracefully instead of hanging the sim.
    const indeg = new Map(nodes.map((n) => [n.id, upstream.get(n.id)!.length]));
    const order: string[] = [];
    const ready = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
    while (ready.length) {
      const id = ready.shift()!;
      order.push(id);
      for (const to of downstream.get(id)!) {
        indeg.set(to, indeg.get(to)! - 1);
        if (indeg.get(to) === 0) ready.push(to);
      }
    }
    for (const n of nodes) if (!order.includes(n.id)) order.push(n.id);

    const stampede = this.events.some((e) => e.type === 'cache_stampede');
    const viral = this.events.find((e) => e.type === 'viral_post');
    const hotKey = this.events.find((e) => e.type === 'hot_key');
    const queuePresent = this.hasQueueInDesign();

    const inflow = new Map<string, number>();
    const metrics = new Map<string, NodeMetrics>();
    let weightedErrors = 0; // errors per second, weighted at entry scale
    let hitWeighted = 0;
    let hitTotal = 0;
    let staleWeighted = 0;
    let staleTotal = 0;

    const sources = nodes.filter((n) => componentDef(n.type).behavior === 'source');
    const entryTotal = traffic.rps;
    const perSource = sources.length > 0 ? entryTotal / sources.length : 0;

    for (const id of order) {
      const node = byId.get(id)!;
      const def = componentDef(node.type);
      const killed = this.killed.has(id);
      let inQps = inflow.get(id) ?? 0;
      if (def.behavior === 'source') inQps += perSource;

      const st = this.state.get(id) ?? { queueDepth: 0 };
      this.state.set(id, st);

      if (killed) {
        // Everything routed into a dead node is lost.
        weightedErrors += inQps;
        metrics.set(id, {
          inQps, outQps: 0, util: 0, latencyMs: 0, errorRate: 1, killed: true,
          queueDepth: def.behavior === 'queue' ? st.queueDepth : undefined,
        });
        continue;
      }

      const capacity =
        def.defaultCapacityPerReplica * node.settings.replicas * node.settings.capacityScale;
      let outQps = inQps;
      let util = capacity > 0 ? inQps / capacity : 0;
      let latency = def.baseLatencyMs;
      let errorRate = 0;
      let hitRate: number | undefined;
      let queueDepth: number | undefined;

      switch (def.behavior) {
        case 'source':
          util = 0;
          latency = 0;
          break;
        case 'passthrough': {
          const limit = node.settings.rateLimitPerSec ?? 0;
          if (node.type === 'gateway' && limit > 0 && inQps > limit) {
            errorRate = (inQps - limit) / inQps;
            outQps = limit;
          }
          break;
        }
        case 'offload': {
          hitRate = def.baseHitRate ?? 0.8;
          if (stampede) {
            hitRate = node.type === 'cache' && node.settings.mutexRebuild ? 0.6 : 0.15;
          }
          // Only reads can hit a cache/CDN; writes always pass through.
          outQps = inQps * (1 - hitRate * traffic.readRatio);
          hitWeighted += inQps * traffic.readRatio * hitRate;
          hitTotal += inQps * traffic.readRatio;
          break;
        }
        case 'queue': {
          queueDepth = st.queueDepth;
          const drainCap = (downstream.get(id) ?? []).reduce((sum, toId) => {
            const to = byId.get(toId);
            if (!to || this.killed.has(toId)) return sum;
            const d = componentDef(to.type);
            return sum + d.defaultCapacityPerReplica * to.settings.replicas * to.settings.capacityScale;
          }, 0);
          const available = st.queueDepth + inQps;
          const drained = drainCap > 0 ? Math.min(available, drainCap) : inQps;
          st.queueDepth = Math.max(0, available - drained);
          queueDepth = st.queueDepth;
          outQps = drained;
          const buffer = def.bufferSize ?? 20000;
          if (st.queueDepth > buffer) {
            const overflow = (st.queueDepth - buffer) / Math.max(1, inQps);
            errorRate = Math.min(0.9, overflow);
            st.queueDepth = buffer;
            queueDepth = st.queueDepth;
          }
          // A queue's health is its backlog trend, not a throughput ratio:
          // util stays low while the buffer absorbs, rising as depth grows.
          util = Math.min(
            0.99,
            (st.queueDepth / (def.bufferSize ?? 2000000)) * 2 +
              (drainCap > 0 && inQps > drainCap ? 0.15 : 0),
          );
          latency = def.baseLatencyMs + (queueDepth / Math.max(1, drainCap || 1)) * 1000;
          break;
        }
        case 'worker':
        case 'service': {
          if (util > 1) {
            errorRate = Math.min(0.95, (util - 1) * 0.8);
            outQps = inQps * (1 - errorRate);
          }
          // Viral fan-out: a feed service multiplies writes while a post goes
          // viral (one write becomes one write per follower timeline).
          if (viral && node.type === 'feedservice') {
            outQps *= 1 + 0.8 * (viral.magnitude - 1);
          }
          break;
        }
        case 'storage': {
          // A hot key adds a write storm that bypasses every cache layer and
          // lands directly on the targeted storage type.
          if (hotKey && (hotKey.targetType === undefined || hotKey.targetType === node.type)) {
            inQps += entryTotal * 0.15 * hotKey.magnitude;
          }
          let effectiveCapacity = capacity;
          // Replica reads add read headroom.
          const rr = node.settings.readReplicas ?? 0;
          if (rr > 0) {
            effectiveCapacity = capacity * (1 + rr * traffic.readRatio * 0.7);
          }
          if (hotKey && (hotKey.targetType === undefined || hotKey.targetType === node.type)) {
            const key = node.settings.shardKey ?? '';
            if (node.settings.sharded && BAD_SHARD_KEYS.has(key)) effectiveCapacity *= 0.3;
            else if (node.settings.sharded) effectiveCapacity *= 0.75;
            else effectiveCapacity *= 0.5;
          }
          if (viral && !queuePresent) {
            // Synchronous fan-out: a viral write storm lands directly on storage.
            effectiveCapacity *= 0.55;
          }
          // Writes are more expensive than reads; replica headroom (below)
          // only helps the read share.
          const loadFactor = 0.8 * traffic.readRatio + 1.8 * (1 - traffic.readRatio);
          util = effectiveCapacity > 0 ? (inQps * loadFactor) / effectiveCapacity : 0;
          if (util > 1) {
            errorRate = Math.min(0.95, (util - 1) * 0.8);
            outQps = inQps * (1 - errorRate);
          } else {
            outQps = inQps;
          }
          // Replica-lag stale reads: grows with write rate per read replica
          // and with how loaded the store is; strong consistency eliminates
          // it (at latency cost elsewhere).
          if (rr > 0 && node.settings.consistency !== 'strong') {
            const writeTps = inQps * (1 - traffic.readRatio);
            const stale = Math.min(
              0.3,
              (writeTps / (rr * 40 + 1)) * (0.4 + Math.min(1, util)),
            );
            staleWeighted += inQps * traffic.readRatio * stale;
            staleTotal += inQps * traffic.readRatio;
          }
          break;
        }
      }

      if (def.behavior !== 'queue' && def.behavior !== 'source') {
        latency = def.baseLatencyMs * (1 + 6 * Math.pow(Math.min(util, 1.5), 2.5));
        if (def.behavior === 'offload' && hitRate !== undefined) {
          latency = def.baseLatencyMs * (1 + 2 * Math.pow(Math.min(util, 1.5), 2));
        }
      }
      if (def.behavior !== 'storage' && def.behavior !== 'queue') {
        if (util > 1 && def.behavior !== 'passthrough') {
          errorRate = Math.max(errorRate, Math.min(0.95, (util - 1) * 0.8));
          outQps = inQps * (1 - errorRate);
        }
      }

      weightedErrors += inQps * errorRate * (def.behavior === 'source' ? 0 : 1);

      metrics.set(id, {
        inQps,
        outQps,
        util,
        latencyMs: latency,
        errorRate,
        queueDepth,
        hitRate,
        killed: false,
      });

      // Propagate downstream: same-type targets split, different types fan out.
      // If some same-type targets are killed, their share reroutes to the
      // alive siblings (health-check behavior); only when every sibling is
      // down does the flow land on dead nodes and count as errors.
      const targets = downstream.get(id) ?? [];
      const byType = new Map<string, string[]>();
      for (const t of targets) {
        const tt = byId.get(t)!.type;
        byType.set(tt, [...(byType.get(tt) ?? []), t]);
      }
      for (const group of byType.values()) {
        const alive = group.filter((t) => !this.killed.has(t));
        const effective = alive.length > 0 ? alive : group;
        const share = outQps / effective.length;
        for (const t of effective) inflow.set(t, (inflow.get(t) ?? 0) + share);
      }
    }

    // P99 estimate: latency sum along the heaviest SYNCHRONOUS path, times a
    // tail factor. Edges into a queue are an async boundary — work behind a
    // queue does not add to request-path latency.
    const longest = new Map<string, number>();
    for (const id of order) {
      const m = metrics.get(id);
      if (!m || m.killed) continue;
      if (componentDef(byId.get(id)!.type).behavior === 'queue') continue;
      const fromUpstream = Math.max(
        0,
        ...(upstream.get(id) ?? [])
          .filter((u) => componentDef(byId.get(u)!.type).behavior !== 'queue')
          .map((u) => longest.get(u) ?? 0),
      );
      longest.set(id, fromUpstream + m.latencyMs);
    }
    const pathLatency = Math.max(0, ...longest.values());
    const p99Ms = entryTotal > 0 ? 20 + pathLatency * 1.6 : 0;

    let cost = 0;
    let maxStorageQps = 0;
    let hottestUtil = 0;
    for (const n of nodes) {
      if (this.killed.has(n.id)) continue;
      cost += componentDef(n.type).costPerReplicaPerHour * n.settings.replicas;
      const m = metrics.get(n.id);
      if (!m) continue;
      if (componentDef(n.type).behavior === 'storage') {
        maxStorageQps = Math.max(maxStorageQps, m.inQps);
      }
      hottestUtil = Math.max(hottestUtil, m.util);
    }

    return {
      tick,
      totalInQps: entryTotal,
      p99Ms,
      errorRate: entryTotal > 0 ? Math.min(1, weightedErrors / entryTotal) : 0,
      cacheHitRate: hitTotal > 0 ? hitWeighted / hitTotal : 0,
      staleReadRate: staleTotal > 0 ? staleWeighted / staleTotal : 0,
      costPerHour: cost,
      maxStorageQps,
      hottestUtil,
      nodes: Object.fromEntries(metrics),
      activeEvents: this.events.map((e) => ({ ...e })),
    };
  }
}
