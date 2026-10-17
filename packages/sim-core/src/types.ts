import type { ComponentTypeId } from '@sds/components';

/** Per-node tunable settings, edited in the node panel. Meaning depends on type. */
export interface NodeSettings {
  replicas: number;
  /** Multiplier on the component's default per-replica capacity (0.25 – 4). */
  capacityScale: number;
  /** loadbalancer: balancing strategy */
  lbAlgorithm?: 'round_robin' | 'least_connections' | 'consistent_hashing';
  /** gateway: max req/s admitted; 0 = rate limiting off */
  rateLimitPerSec?: number;
  /** cache: eviction policy */
  eviction?: 'LRU' | 'LFU' | 'TTL';
  /** cache: mutex rebuild / request coalescing protects against stampede */
  mutexRebuild?: boolean;
  /** db / nosql: number of read replicas serving reads */
  readReplicas?: number;
  /** db / nosql: data is sharded */
  sharded?: boolean;
  /** db / nosql: shard key field name */
  shardKey?: string;
  /** db / nosql: read consistency */
  consistency?: 'eventual' | 'strong';
}

export interface DesignNode {
  id: string;
  type: ComponentTypeId;
  x: number;
  y: number;
  label?: string;
  settings: NodeSettings;
}

export interface DesignEdge {
  id: string;
  from: string;
  to: string;
}

export interface Design {
  nodes: DesignNode[];
  edges: DesignEdge[];
}

export interface TrafficConfig {
  /** Total requests per second entering through client nodes. */
  rps: number;
  /** Fraction of traffic that is reads, 0..1. */
  readRatio: number;
}

export type EventType =
  | 'viral_post'
  | 'cache_stampede'
  | 'hot_key'
  | 'peak'
  | 'rw_flip';

export interface ActiveEvent {
  id: string;
  type: EventType;
  /** Component type the event concentrates on, when applicable. */
  targetType?: ComponentTypeId;
  magnitude: number;
  remainingTicks: number;
  totalTicks: number;
}

export interface NodeMetrics {
  inQps: number;
  outQps: number;
  /** inQps / effective capacity, 0..>1 */
  util: number;
  latencyMs: number;
  /** Fraction of this node's inbound requests failing here, 0..1 */
  errorRate: number;
  queueDepth?: number;
  hitRate?: number;
  killed: boolean;
}

export interface MetricsSnapshot {
  tick: number;
  totalInQps: number;
  p99Ms: number;
  /** Global request error fraction, 0..1 */
  errorRate: number;
  /** Weighted cache/CDN hit rate across offload nodes, 0..1 (0 when none) */
  cacheHitRate: number;
  /** Fraction of reads served stale data because of replica lag, 0..1 */
  staleReadRate: number;
  costPerHour: number;
  /** Highest inbound QPS seen on any single storage node. */
  maxStorageQps: number;
  /** Highest utilization on any single node. */
  hottestUtil: number;
  nodes: Record<string, NodeMetrics>;
  activeEvents: ActiveEvent[];
}

export function defaultSettings(type: ComponentTypeId): NodeSettings {
  const base: NodeSettings = { replicas: 1, capacityScale: 1 };
  switch (type) {
    case 'loadbalancer':
      return { ...base, lbAlgorithm: 'round_robin' };
    case 'gateway':
      return { ...base, rateLimitPerSec: 0 };
    case 'cache':
      return { ...base, eviction: 'LRU', mutexRebuild: false };
    case 'relationaldb':
    case 'nosql':
      return { ...base, readReplicas: 0, sharded: false, shardKey: 'user_id', consistency: 'eventual' };
    default:
      return base;
  }
}

let counter = 0;
export function newId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}
