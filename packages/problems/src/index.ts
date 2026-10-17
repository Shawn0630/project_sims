import type { ComponentTypeId } from '@sds/components';
import {
  defaultSettings,
  type Design,
  type DesignEdge,
  type DesignNode,
  type EventType,
  type NodeSettings,
  type TrafficConfig,
} from '@sds/sim-core';

// ------------------------------------------------------------- test cases ---

export interface TestCaseEvent {
  atTick: number;
  type: EventType;
  targetType?: ComponentTypeId;
  magnitude?: number;
  durationTicks?: number;
}

export interface TestCaseKill {
  componentType: ComponentTypeId;
  atTick: number;
}

export interface CaseThresholds {
  maxErrorRate?: number;
  maxP99Ms?: number;
  maxCostPerHour?: number;
  maxStorageQps?: number;
  maxStaleReadRate?: number;
  maxHottestUtil?: number;
  maxQueueDepth?: number;
}

export interface TestCase {
  id: string;
  name: string;
  description: string;
  hidden: boolean;
  weight: number;
  traffic: TrafficConfig;
  durationTicks: number;
  events?: TestCaseEvent[];
  kills?: TestCaseKill[];
  thresholds: CaseThresholds;
  /** Structural rule id this case tends to expose. */
  exposesRule?: string;
  /** Shown after a failure: the intended fix direction. */
  hint?: string;
}

// ----------------------------------------------------------------- schema ---

export interface SchemaField {
  name: string;
  type: string;
  indexed: boolean;
  blob?: boolean;
}

export interface SchemaTable {
  name: string;
  engine: 'relational' | 'nosql';
  rows: number;
  primaryKey: string;
  primaryKeyGen: 'auto' | 'snowflake' | 'uuid' | 'business';
  shardKey: string | null;
  fields: SchemaField[];
}

export interface AccessPattern {
  id: string;
  name: string;
  table: string;
  kind: 'read' | 'write' | 'count';
  byField: string;
  needsSort?: boolean;
  perSec: number;
}

export interface ProblemSchema {
  tables: SchemaTable[];
  accessPatterns: AccessPattern[];
}

// ---------------------------------------------------------------- problem ---

export interface ProblemScale {
  dau: string;
  readRatio: number;
  peakMultiplier: number;
  baselineRps: number;
  budgetCostPerHour: number;
  notes: string;
}

export interface ProblemDef {
  id: string;
  name: string;
  nameEn: string;
  difficulty: '简单' | '中等' | '困难';
  tags: string[];
  statement: string;
  functionalRequirements: string[];
  scale: ProblemScale;
  flags: {
    mediaHeavy: boolean;
    hasFanout: boolean;
    publicWriteApi: boolean;
    readHeavy: boolean;
  };
  schema: ProblemSchema;
  testCases: TestCase[];
  /** A decent-but-flawed starting design (the interview "sample answer"). */
  sampleDesign: Design;
}

// ---------------------------------------------------------------- helpers ---

function n(
  id: string,
  type: ComponentTypeId,
  x: number,
  y: number,
  settings?: Partial<NodeSettings>,
): DesignNode {
  return { id, type, x, y, settings: { ...defaultSettings(type), ...(settings ?? {}) } };
}

function e(from: string, to: string): DesignEdge {
  return { id: `${from}->${to}`, from, to };
}

// -------------------------------------------------------------- Instagram ---

export const INSTAGRAM: ProblemDef = {
  id: 'instagram',
  name: 'Design Instagram',
  nameEn: 'Design Instagram',
  difficulty: '中等',
  tags: ['Feed 流', '缓存', 'fan-out', '媒体存储'],
  statement:
    '设计一个照片分享应用：用户可以上传照片、关注他人、在首页刷到关注者的照片流，并点赞评论。',
  functionalRequirements: [
    '上传照片，生成多种尺寸',
    '关注 / 取关用户',
    '首页 Feed：按时间倒序拉取关注者的照片',
    '点赞，点赞数实时可见',
  ],
  scale: {
    dau: '5 亿 DAU',
    readRatio: 0.9,
    peakMultiplier: 3,
    baselineRps: 1200,
    budgetCostPerHour: 900,
    notes: '读:写 ≈ 10:1，晚高峰 ×3，大 V 粉丝量可达 1 亿',
  },
  flags: { mediaHeavy: true, hasFanout: true, publicWriteApi: true, readHeavy: true },
  schema: {
    tables: [
      {
        name: 'users',
        engine: 'relational',
        rows: 500_000_000,
        primaryKey: 'user_id',
        primaryKeyGen: 'snowflake',
        shardKey: null,
        fields: [
          { name: 'user_id', type: 'bigint', indexed: true },
          { name: 'username', type: 'varchar', indexed: true },
          { name: 'email', type: 'varchar', indexed: true },
          { name: 'avatar_blob', type: 'blob', indexed: false, blob: true },
          { name: 'bio', type: 'text', indexed: false },
        ],
      },
      {
        name: 'photos',
        engine: 'relational',
        rows: 5_000_000_000,
        primaryKey: 'photo_id',
        primaryKeyGen: 'auto',
        shardKey: null,
        fields: [
          { name: 'photo_id', type: 'bigint', indexed: true },
          { name: 'user_id', type: 'bigint', indexed: true },
          { name: 'url', type: 'varchar', indexed: false },
          { name: 'created_at', type: 'timestamp', indexed: true },
        ],
      },
      {
        name: 'follows',
        engine: 'relational',
        rows: 10_000_000_000,
        primaryKey: 'id',
        primaryKeyGen: 'auto',
        shardKey: null,
        fields: [
          { name: 'id', type: 'bigint', indexed: true },
          { name: 'follower_id', type: 'bigint', indexed: true },
          { name: 'followee_id', type: 'bigint', indexed: true },
        ],
      },
      {
        name: 'likes',
        engine: 'relational',
        rows: 10_000_000_000,
        primaryKey: 'id',
        primaryKeyGen: 'auto',
        shardKey: null,
        fields: [
          { name: 'id', type: 'bigint', indexed: true },
          { name: 'photo_id', type: 'bigint', indexed: true },
          { name: 'user_id', type: 'bigint', indexed: true },
          { name: 'created_at', type: 'timestamp', indexed: false },
        ],
      },
    ],
    accessPatterns: [
      { id: 'ig-p1', name: '查用户资料', table: 'users', kind: 'read', byField: 'user_id', perSec: 800 },
      { id: 'ig-p2', name: '按作者查照片（时间倒序）', table: 'photos', kind: 'read', byField: 'user_id', needsSort: true, perSec: 3000 },
      { id: 'ig-p3', name: 'Feed 拉取：查关注列表', table: 'follows', kind: 'read', byField: 'follower_id', perSec: 5000 },
      { id: 'ig-p4', name: '点赞计数更新', table: 'likes', kind: 'count', byField: 'photo_id', perSec: 2000 },
      { id: 'ig-p5', name: '按邮箱查用户', table: 'users', kind: 'read', byField: 'email', perSec: 50 },
      { id: 'ig-p6', name: '写入照片元数据', table: 'photos', kind: 'write', byField: 'user_id', perSec: 400 },
      { id: 'ig-p7', name: '查某照片的点赞者', table: 'likes', kind: 'read', byField: 'photo_id', perSec: 600 },
    ],
  },
  testCases: [
    {
      id: 'ig-baseline',
      name: '基线负载',
      description: '日常稳态 1,200 req/s，读:写 = 10:1，持续 30 秒。',
      hidden: false,
      weight: 1,
      traffic: { rps: 1200, readRatio: 0.9 },
      durationTicks: 30,
      thresholds: { maxErrorRate: 0.001, maxP99Ms: 500, maxHottestUtil: 0.95 },
      hint: '基线都过不了，说明某一层容量明显不足，先看利用率最高的组件。',
    },
    {
      id: 'ig-peak',
      name: '晚高峰 ×3',
      description: '晚高峰流量翻 3 倍，持续 40 秒。',
      hidden: false,
      weight: 1,
      traffic: { rps: 3600, readRatio: 0.9 },
      durationTicks: 40,
      thresholds: { maxErrorRate: 0.01, maxP99Ms: 1000 },
      hint: '峰值挂掉通常是最热的那一层先饱和，按利用率从高到低扩。',
    },
    {
      id: 'ig-cost',
      name: '成本上限',
      description: '在基线负载下，估算成本不得超过题目预算 $900/h。',
      hidden: false,
      weight: 1,
      traffic: { rps: 1200, readRatio: 0.9 },
      durationTicks: 15,
      thresholds: { maxCostPerHour: 900 },
      hint: '成本超标多半是贵组件（DB）副本堆太多，或该放缓存/对象存储的流量放错了层。',
    },
    {
      id: 'ig-fanout',
      name: '大 V 发帖 fan-out',
      description: '隐藏用例：一位 1 亿粉丝的大 V 突然发帖，海量粉丝在 1 分钟内涌入拉取。',
      hidden: true,
      weight: 2,
      traffic: { rps: 1500, readRatio: 0.9 },
      durationTicks: 45,
      events: [{ atTick: 3, type: 'viral_post', magnitude: 4, durationTicks: 40 }],
      thresholds: { maxErrorRate: 0.02, maxStorageQps: 6000, maxQueueDepth: 500000 },
      exposesRule: 'sync-fanout',
      hint: '同步 fan-out 会把一次发帖放大成写风暴直砸存储。改异步：发帖先进队列，Worker 慢慢扩散（或大 V 改拉模式）。',
    },
    {
      id: 'ig-stampede',
      name: '缓存整点雪崩',
      description: '隐藏用例：高峰期大批热点 key 在同一时刻过期，回源流量瞬间放大。',
      hidden: true,
      weight: 2,
      traffic: { rps: 3600, readRatio: 0.9 },
      durationTicks: 40,
      events: [{ atTick: 3, type: 'cache_stampede', magnitude: 1, durationTicks: 30 }],
      thresholds: { maxErrorRate: 0.01, maxP99Ms: 1000 },
      exposesRule: 'hot-read-no-cache',
      hint: '雪崩时命中率从 80%+ 跌到 15%，下游要能扛住回源：缓存开互斥重建、应用层留余量、或给 DB 前再加一层保护。',
    },
    {
      id: 'ig-hotshard',
      name: '热点分片',
      description: '隐藏用例：写入集中砸向单个 key 区间（热点话题下的照片与点赞）。',
      hidden: true,
      weight: 2,
      traffic: { rps: 3000, readRatio: 0.9 },
      durationTicks: 40,
      events: [
        { atTick: 3, type: 'hot_key', targetType: 'relationaldb', magnitude: 4, durationTicks: 30 },
      ],
      thresholds: { maxErrorRate: 0.02, maxHottestUtil: 1.0 },
      exposesRule: 'db-scale',
      hint: '未分片的单库扛不住绕过缓存的热点写。按 user_id 分片把热点摊开，或把这类数据迁到 NoSQL。',
    },
    {
      id: 'ig-rwflip',
      name: '读写比翻转',
      description: '隐藏用例：一场直播活动让写流量暴涨，读写比从 10:1 翻转为 1:9。',
      hidden: true,
      weight: 1,
      traffic: { rps: 2000, readRatio: 0.9 },
      durationTicks: 40,
      events: [{ atTick: 3, type: 'rw_flip', magnitude: 1, durationTicks: 30 }],
      thresholds: { maxErrorRate: 0.02, maxP99Ms: 1000 },
      hint: '为读优化的设计在写洪峰下会原形毕露：写路径的容量、队列缓冲和 DB 写能力要单独核算。',
    },
    {
      id: 'ig-nodefail',
      name: '峰值期节点宕机',
      description: '隐藏用例：高峰期一个应用服务节点突然宕机。',
      hidden: true,
      weight: 2,
      traffic: { rps: 3000, readRatio: 0.9 },
      durationTicks: 40,
      kills: [{ componentType: 'appserver', atTick: 5 }],
      thresholds: { maxErrorRate: 0.02 },
      exposesRule: 'spof',
      hint: '只有一个应用节点（或同层无余量）时，一次宕机就是全站错误。同层至少两个节点并留 failover 余量。',
    },
    {
      id: 'ig-stale',
      name: '主从延迟读旧数据',
      description: '隐藏用例：高并发写入下，从库延迟放大，用户刷到旧数据/丢赞。',
      hidden: true,
      weight: 1,
      traffic: { rps: 2500, readRatio: 0.9 },
      durationTicks: 35,
      thresholds: { maxStaleReadRate: 0.02, maxErrorRate: 0.01 },
      hint: '读副本 + 最终一致在高写入下会读到旧数据。关键读改强一致（走主库），或减少副本延迟来源。',
    },
  ],
  sampleDesign: {
    nodes: [
      n('ig-client', 'client', 60, 300),
      n('ig-cdn', 'cdn', 200, 150),
      n('ig-gateway', 'gateway', 200, 440),
      n('ig-lb', 'loadbalancer', 340, 300),
      n('ig-app', 'appserver', 490, 300, { replicas: 3 }),
      n('ig-cache', 'cache', 640, 170),
      n('ig-db', 'relationaldb', 810, 170, { readReplicas: 2 }),
      n('ig-feed', 'feedservice', 640, 330, { replicas: 2 }),
      n('ig-nosql', 'nosql', 810, 330, { sharded: true, shardKey: 'created_at' }),
      n('ig-obj', 'objectstorage', 640, 480),
    ],
    edges: [
      e('ig-client', 'ig-cdn'),
      e('ig-cdn', 'ig-gateway'),
      e('ig-gateway', 'ig-lb'),
      e('ig-lb', 'ig-app'),
      e('ig-app', 'ig-cache'),
      e('ig-cache', 'ig-db'),
      e('ig-app', 'ig-feed'),
      e('ig-feed', 'ig-nosql'),
      e('ig-app', 'ig-obj'),
    ],
  },
};

// ---------------------------------------------------------------- Twitter ---

export const TWITTER: ProblemDef = {
  id: 'twitter',
  name: 'Design Twitter',
  nameEn: 'Design Twitter',
  difficulty: '困难',
  tags: ['Feed 流', 'fan-out', '热点', '时间线'],
  statement:
    '设计一个微博类应用：用户发推、关注他人、刷首页时间线。大 V 的一条推要在分钟级内出现在上亿粉丝的时间线里。',
  functionalRequirements: [
    '发推（文本 + 媒体链接）',
    '关注 / 取关',
    '首页时间线：关注者推文按时间倒序聚合',
    '点赞与转发计数',
  ],
  scale: {
    dau: '3 亿 DAU',
    readRatio: 0.8,
    peakMultiplier: 3,
    baselineRps: 1500,
    budgetCostPerHour: 480,
    notes: '读:写 ≈ 4:1，时间线读取极重，头部用户粉丝过亿',
  },
  flags: { mediaHeavy: false, hasFanout: true, publicWriteApi: true, readHeavy: true },
  schema: {
    tables: [
      {
        name: 'users',
        engine: 'relational',
        rows: 300_000_000,
        primaryKey: 'user_id',
        primaryKeyGen: 'snowflake',
        shardKey: null,
        fields: [
          { name: 'user_id', type: 'bigint', indexed: true },
          { name: 'handle', type: 'varchar', indexed: true },
          { name: 'created_at', type: 'timestamp', indexed: false },
        ],
      },
      {
        name: 'tweets',
        engine: 'nosql',
        rows: 50_000_000_000,
        primaryKey: 'tweet_id',
        primaryKeyGen: 'snowflake',
        shardKey: null,
        fields: [
          { name: 'tweet_id', type: 'bigint', indexed: true },
          { name: 'author_id', type: 'bigint', indexed: true },
          { name: 'content', type: 'text', indexed: false },
          { name: 'like_count', type: 'bigint', indexed: false },
          { name: 'created_at', type: 'timestamp', indexed: true },
        ],
      },
      {
        name: 'follows',
        engine: 'nosql',
        rows: 20_000_000_000,
        primaryKey: 'id',
        primaryKeyGen: 'snowflake',
        shardKey: 'follower_id',
        fields: [
          { name: 'id', type: 'bigint', indexed: true },
          { name: 'follower_id', type: 'bigint', indexed: true },
          { name: 'followee_id', type: 'bigint', indexed: true },
        ],
      },
    ],
    accessPatterns: [
      { id: 'tw-p1', name: '查用户资料', table: 'users', kind: 'read', byField: 'user_id', perSec: 1000 },
      { id: 'tw-p2', name: '按作者查推文（时间倒序）', table: 'tweets', kind: 'read', byField: 'author_id', needsSort: true, perSec: 4000 },
      { id: 'tw-p3', name: '时间线：查关注列表', table: 'follows', kind: 'read', byField: 'follower_id', perSec: 6000 },
      { id: 'tw-p4', name: '点赞计数更新', table: 'tweets', kind: 'count', byField: 'tweet_id', perSec: 3000 },
      { id: 'tw-p5', name: '发推写入', table: 'tweets', kind: 'write', byField: 'author_id', perSec: 800 },
    ],
  },
  testCases: [
    {
      id: 'tw-baseline',
      name: '基线负载',
      description: '日常稳态 1,500 req/s，读:写 = 4:1。',
      hidden: false,
      weight: 1,
      traffic: { rps: 1500, readRatio: 0.8 },
      durationTicks: 30,
      thresholds: { maxErrorRate: 0.001, maxP99Ms: 500, maxHottestUtil: 0.95 },
      hint: '基线都过不了说明某层容量明显不足。',
    },
    {
      id: 'tw-peak',
      name: '晚高峰 ×3',
      description: '晚高峰 4,500 req/s。',
      hidden: false,
      weight: 1,
      traffic: { rps: 4500, readRatio: 0.8 },
      durationTicks: 40,
      thresholds: { maxErrorRate: 0.01, maxP99Ms: 1000 },
      hint: '先扩利用率最高的一层。',
    },
    {
      id: 'tw-cost',
      name: '成本上限',
      description: '基线下成本不超过 $480/h。',
      hidden: false,
      weight: 1,
      traffic: { rps: 1500, readRatio: 0.8 },
      durationTicks: 15,
      thresholds: { maxCostPerHour: 480 },
      hint: '成本大头通常在 DB 与计算副本数。',
    },
    {
      id: 'tw-fanout',
      name: '大 V 发推 fan-out',
      description: '隐藏用例：头部大 V 发推，粉丝时间线写入瞬间放大。',
      hidden: true,
      weight: 2,
      traffic: { rps: 2000, readRatio: 0.8 },
      durationTicks: 45,
      events: [{ atTick: 3, type: 'viral_post', magnitude: 5, durationTicks: 40 }],
      thresholds: { maxErrorRate: 0.02, maxStorageQps: 8000, maxQueueDepth: 800000 },
      exposesRule: 'sync-fanout',
      hint: '推特的经典解：普通用户推模式 + 大 V 拉模式；无论哪种，fan-out 必须异步过队列。',
    },
    {
      id: 'tw-stampede',
      name: '热点推文缓存雪崩',
      description: '隐藏用例：热门推文的缓存批量过期，读取回源放大。',
      hidden: true,
      weight: 2,
      traffic: { rps: 4500, readRatio: 0.8 },
      durationTicks: 40,
      events: [{ atTick: 3, type: 'cache_stampede', magnitude: 1, durationTicks: 30 }],
      thresholds: { maxErrorRate: 0.01, maxP99Ms: 1000 },
      hint: '缓存层要开互斥重建，应用层要留回源余量。',
    },
    {
      id: 'tw-hotshard',
      name: '热点分片',
      description: '隐藏用例：某话题爆了，写入集中砸向单个 key 区间。',
      hidden: true,
      weight: 2,
      traffic: { rps: 3500, readRatio: 0.8 },
      durationTicks: 40,
      events: [{ atTick: 3, type: 'hot_key', targetType: 'nosql', magnitude: 4, durationTicks: 30 }],
      thresholds: { maxErrorRate: 0.02, maxHottestUtil: 1.0 },
      exposesRule: 'db-scale',
      hint: '分片键要高基数且分布均匀；单调键（时间）会把写打到同一片。',
    },
    {
      id: 'tw-nodefail',
      name: '峰值期节点宕机',
      description: '隐藏用例：高峰期一个应用节点宕机。',
      hidden: true,
      weight: 2,
      traffic: { rps: 3500, readRatio: 0.8 },
      durationTicks: 40,
      kills: [{ componentType: 'appserver', atTick: 5 }],
      thresholds: { maxErrorRate: 0.02 },
      exposesRule: 'spof',
      hint: '同层多节点 + 余量才是冗余，只加副本数在同节点上不算。',
    },
    {
      id: 'tw-rwflip',
      name: '读写比翻转',
      description: '隐藏用例：突发事件让发推量暴涨，读写比短暂翻转。',
      hidden: true,
      weight: 1,
      traffic: { rps: 2500, readRatio: 0.8 },
      durationTicks: 40,
      events: [{ atTick: 3, type: 'rw_flip', magnitude: 1, durationTicks: 30 }],
      thresholds: { maxErrorRate: 0.02, maxP99Ms: 1000 },
      hint: '写路径单独核算容量，别只按读优化。',
    },
  ],
  sampleDesign: {
    nodes: [
      n('tw-client', 'client', 60, 300),
      n('tw-gateway', 'gateway', 200, 300),
      n('tw-lb', 'loadbalancer', 330, 300),
      n('tw-app', 'appserver', 470, 300, { replicas: 6 }),
      n('tw-cache', 'cache', 620, 160),
      n('tw-nosql', 'nosql', 790, 160, { sharded: true, shardKey: 'user_id', capacityScale: 3 }),
      n('tw-feed', 'feedservice', 620, 320, { replicas: 3, capacityScale: 2 }),
      n('tw-db', 'relationaldb', 790, 460),
      n('tw-queue', 'queue', 620, 480),
      n('tw-worker', 'worker', 790, 560, { replicas: 4 }),
    ],
    edges: [
      e('tw-client', 'tw-gateway'),
      e('tw-gateway', 'tw-lb'),
      e('tw-lb', 'tw-app'),
      e('tw-app', 'tw-cache'),
      e('tw-cache', 'tw-nosql'),
      e('tw-cache', 'tw-db'),
      e('tw-app', 'tw-feed'),
      e('tw-feed', 'tw-nosql'),
      e('tw-app', 'tw-queue'),
      e('tw-queue', 'tw-worker'),
      e('tw-worker', 'tw-nosql'),
    ],
  },
};

// ----------------------------------------------------------- URL shortener ---

export const URL_SHORTENER: ProblemDef = {
  id: 'url-shortener',
  name: 'Design 短链接',
  nameEn: 'Design URL Shortener',
  difficulty: '简单',
  tags: ['缓存', 'KV', '重定向'],
  statement:
    '设计一个短链接服务：把长 URL 压缩成短码，访问短码时 302 跳转到原地址，并统计点击量。',
  functionalRequirements: [
    '生成短链接（同一长链可复用）',
    '短码跳转，延迟要低',
    '点击计数与简单统计',
  ],
  scale: {
    dau: '1 亿次/日跳转',
    readRatio: 0.97,
    peakMultiplier: 3,
    baselineRps: 800,
    budgetCostPerHour: 200,
    notes: '读:写 ≈ 30:1，跳转是绝对热点路径，P99 要求 < 400ms',
  },
  flags: { mediaHeavy: false, hasFanout: false, publicWriteApi: true, readHeavy: true },
  schema: {
    tables: [
      {
        name: 'urls',
        engine: 'relational',
        rows: 1_000_000_000,
        primaryKey: 'id',
        primaryKeyGen: 'auto',
        shardKey: null,
        fields: [
          { name: 'id', type: 'bigint', indexed: true },
          { name: 'short_code', type: 'varchar', indexed: true },
          { name: 'long_url', type: 'text', indexed: false },
          { name: 'user_id', type: 'bigint', indexed: false },
          { name: 'click_count', type: 'bigint', indexed: false },
          { name: 'created_at', type: 'timestamp', indexed: false },
        ],
      },
    ],
    accessPatterns: [
      { id: 'us-p1', name: '按短码跳转', table: 'urls', kind: 'read', byField: 'short_code', perSec: 5000 },
      { id: 'us-p2', name: '按用户查我的链接', table: 'urls', kind: 'read', byField: 'user_id', perSec: 100 },
      { id: 'us-p3', name: '点击计数更新', table: 'urls', kind: 'count', byField: 'short_code', perSec: 5000 },
      { id: 'us-p4', name: '新建短链接', table: 'urls', kind: 'write', byField: 'short_code', perSec: 30 },
    ],
  },
  testCases: [
    {
      id: 'us-baseline',
      name: '基线负载',
      description: '日常 800 req/s 跳转流量，P99 要求 < 400ms。',
      hidden: false,
      weight: 1,
      traffic: { rps: 800, readRatio: 0.97 },
      durationTicks: 30,
      thresholds: { maxErrorRate: 0.001, maxP99Ms: 400, maxHottestUtil: 0.95 },
      hint: '跳转路径要短：多一层就多一份延迟。',
    },
    {
      id: 'us-peak',
      name: '晚高峰 ×3',
      description: '高峰 2,400 req/s。',
      hidden: false,
      weight: 1,
      traffic: { rps: 2400, readRatio: 0.97 },
      durationTicks: 40,
      thresholds: { maxErrorRate: 0.01, maxP99Ms: 400 },
      hint: '读多写少的题，扩容重点在读路径与缓存。',
    },
    {
      id: 'us-cost',
      name: '成本上限',
      description: '基线下成本不超过 $200/h。',
      hidden: false,
      weight: 1,
      traffic: { rps: 800, readRatio: 0.97 },
      durationTicks: 15,
      thresholds: { maxCostPerHour: 200 },
      hint: '短链接是小题，别堆大炮：贵 DB 副本最容易超支。',
    },
    {
      id: 'us-virallink',
      name: '一条链接病毒传播',
      description: '隐藏用例：一条短链被大 V 转发，跳转与计数瞬间集中到单个 key。',
      hidden: true,
      weight: 2,
      traffic: { rps: 2500, readRatio: 0.97 },
      durationTicks: 40,
      events: [
        { atTick: 3, type: 'hot_key', targetType: 'relationaldb', magnitude: 3, durationTicks: 30 },
      ],
      thresholds: { maxErrorRate: 0.02, maxHottestUtil: 1.0 },
      exposesRule: 'db-scale',
      hint: '热点 key 的读应该被缓存完全吸收；计数写要异步聚合，别同步打 DB 行锁。',
    },
    {
      id: 'us-stampede',
      name: '热点链接缓存过期',
      description: '隐藏用例：最热链接的缓存恰在高峰过期。',
      hidden: true,
      weight: 2,
      traffic: { rps: 2400, readRatio: 0.97 },
      durationTicks: 40,
      events: [{ atTick: 3, type: 'cache_stampede', magnitude: 1, durationTicks: 30 }],
      thresholds: { maxErrorRate: 0.01, maxP99Ms: 400 },
      hint: '缓存开互斥重建，热点 key 可永不过期 + 主动刷新。',
    },
    {
      id: 'us-nodefail',
      name: '峰值期节点宕机',
      description: '隐藏用例：高峰期一个应用节点宕机。',
      hidden: true,
      weight: 2,
      traffic: { rps: 2000, readRatio: 0.97 },
      durationTicks: 40,
      kills: [{ componentType: 'appserver', atTick: 5 }],
      thresholds: { maxErrorRate: 0.02 },
      exposesRule: 'spof',
      hint: '应用层至少两个节点。',
    },
  ],
  sampleDesign: {
    nodes: [
      n('us-client', 'client', 60, 300),
      n('us-cdn', 'cdn', 210, 300),
      n('us-lb', 'loadbalancer', 360, 300),
      n('us-app', 'appserver', 510, 300, { replicas: 2 }),
      n('us-cache', 'cache', 660, 220),
      n('us-db', 'relationaldb', 810, 220, { readReplicas: 1 }),
    ],
    edges: [
      e('us-client', 'us-cdn'),
      e('us-cdn', 'us-lb'),
      e('us-lb', 'us-app'),
      e('us-app', 'us-cache'),
      e('us-cache', 'us-db'),
    ],
  },
};

export const PROBLEMS: ProblemDef[] = [INSTAGRAM, TWITTER, URL_SHORTENER];

export function problemById(id: string): ProblemDef {
  const p = PROBLEMS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown problem: ${id}`);
  return p;
}
