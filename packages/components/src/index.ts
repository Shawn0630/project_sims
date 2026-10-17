/**
 * Component library definitions for the System Design Simulator.
 *
 * Each definition describes a component type the user can place on the canvas:
 * how the simulation engine models it (behavior kind, per-replica capacity,
 * base latency, cost), which whiteboard icon it uses, which deep-dive lab it
 * opens, and the interviewer question chain for that module.
 */

export type BehaviorKind =
  | 'source' // generates traffic (client)
  | 'passthrough' // LB / gateway: forwards, may throttle
  | 'offload' // CDN / cache: serves a hit fraction locally, forwards misses
  | 'service' // stateless compute
  | 'queue' // buffers between producer and consumer
  | 'worker' // async consumer with limited throughput
  | 'storage'; // terminal data store

export type ComponentTypeId =
  | 'client'
  | 'cdn'
  | 'loadbalancer'
  | 'gateway'
  | 'appserver'
  | 'feedservice'
  | 'searchservice'
  | 'cache'
  | 'relationaldb'
  | 'nosql'
  | 'objectstorage'
  | 'queue'
  | 'worker';

export type LabKind =
  | 'consistent-hashing'
  | 'lb-strategy'
  | 'cache-lru'
  | 'queue-backlog'
  | 'token-bucket'
  | 'feed-push-pull'
  | 'cdn-origin'
  | 'capacity'
  | 'scale-estimate';

export interface InterviewQuestion {
  level: '基础' | '进阶' | '追问' | '故障';
  question: string;
  keyPoints: string[];
}

export interface ComponentDef {
  type: ComponentTypeId;
  name: string;
  nameEn: string;
  category: '流量入口' | '计算' | '存储' | '异步';
  behavior: BehaviorKind;
  /** Whiteboard icon id, rendered by the web app's Icon component. */
  icon: string;
  color: string;
  blurb: string;
  /** Throughput one replica handles before saturation (req/s). */
  defaultCapacityPerReplica: number;
  baseLatencyMs: number;
  costPerReplicaPerHour: number;
  /** For offload components: fraction of requests served locally. */
  baseHitRate?: number;
  /** Queue buffer size before overflow errors (queue behavior only). */
  bufferSize?: number;
  lab: LabKind;
  labTitle: string;
  questions: InterviewQuestion[];
}

const q = (
  level: InterviewQuestion['level'],
  question: string,
  keyPoints: string[],
): InterviewQuestion => ({ level, question, keyPoints });

export const COMPONENTS: ComponentDef[] = [
  {
    type: 'client',
    name: '客户端',
    nameEn: 'Client',
    category: '流量入口',
    behavior: 'source',
    icon: 'phone',
    color: '#94a3b8',
    blurb: '流量源头。按题目的读写比产生请求，是所有指标的入口。',
    defaultCapacityPerReplica: Number.POSITIVE_INFINITY,
    baseLatencyMs: 0,
    costPerReplicaPerHour: 0,
    lab: 'scale-estimate',
    labTitle: '量级估算',
    questions: [
      q('基础', '这道题的 DAU 和读写比你怎么估？峰值为什么取 ×3？', [
        '先估量级再设计：DAU × 人均请求数 / 86400 得平均 QPS，峰值再乘系数',
        '读写比决定优化方向：读多写少优先缓存与读扩展',
      ]),
      q('追问', '如果实际流量是估算的 10 倍，你的设计哪里先崩？', [
        '指出第一个饱和的组件和它的容量上限',
        '给出按顺序的扩容动作，而不是“整体扩容”',
      ]),
    ],
  },
  {
    type: 'cdn',
    name: 'CDN',
    nameEn: 'CDN',
    category: '流量入口',
    behavior: 'offload',
    icon: 'globe',
    color: '#38bdf8',
    blurb: '边缘节点缓存静态与媒体内容，回源只占未命中部分。',
    defaultCapacityPerReplica: 5000,
    baseLatencyMs: 5,
    costPerReplicaPerHour: 20,
    baseHitRate: 0.85,
    lab: 'cdn-origin',
    labTitle: '回源放大实验',
    questions: [
      q('基础', 'CDN 命中率掉了 10 个点，源站会多扛多少流量？', [
        '回源流量 = 总流量 × (1 − 命中率)，命中率越低回源放大越陡',
        '媒体类内容命中率通常可达 90%+，动态 API 则很低',
      ]),
      q('故障', '一条内容突然爆红但还没被边缘缓存，会发生什么？', [
        '大量回源同时打到源站（缓存击穿的变体）',
        '对策：回源合并（request coalescing）、热点预热、源站前加一层缓存',
      ]),
    ],
  },
  {
    type: 'loadbalancer',
    name: '负载均衡',
    nameEn: 'Load Balancer',
    category: '流量入口',
    behavior: 'passthrough',
    icon: 'split',
    color: '#a78bfa',
    blurb: '把流量分发到多个服务实例，策略决定倾斜程度。',
    defaultCapacityPerReplica: 20000,
    baseLatencyMs: 2,
    costPerReplicaPerHour: 15,
    lab: 'lb-strategy',
    labTitle: '负载均衡策略对比',
    questions: [
      q('基础', '轮询、最少连接、一致性哈希，分别适合什么场景？', [
        '轮询：实例同构、请求耗时均匀',
        '最少连接：请求耗时差异大（如长连接、慢查询）',
        '一致性哈希：需要会话亲和或本地缓存命中时',
      ]),
      q('进阶', '一个实例变慢（没宕机）时，轮询会发生什么？', [
        '轮询继续均分，慢实例队列堆积，P99 被拖高',
        '对策：最少连接 / 加权 / 主动健康检查与熔断剔除',
      ]),
      q('故障', 'LB 本身是单点吗？怎么消除？', [
        'LB 需要至少双活 + VIP 漂移或 DNS/Anycast',
        ' replicas=1 的 LB 是最常见的单点故障来源',
      ]),
    ],
  },
  {
    type: 'gateway',
    name: 'API 网关',
    nameEn: 'API Gateway',
    category: '流量入口',
    behavior: 'passthrough',
    icon: 'funnel',
    color: '#f472b6',
    blurb: '统一入口：鉴权、路由、限流。公开写接口的第一道闸。',
    defaultCapacityPerReplica: 15000,
    baseLatencyMs: 3,
    costPerReplicaPerHour: 12,
    lab: 'token-bucket',
    labTitle: '限流实验（令牌桶）',
    questions: [
      q('基础', '令牌桶、漏桶、滑动窗口限流有什么区别？', [
        '令牌桶允许突发（攒令牌），漏桶强制恒定速率',
        '滑动窗口解决固定窗口边界的双倍突发问题',
      ]),
      q('追问', '限流阈值定多少？定高了和定低了分别有什么后果？', [
        '按下游真实容量反推，而不是拍脑袋',
        '定低误伤正常用户，定高起不到保护作用；配合降级与排队',
      ]),
      q('故障', '网关无限流时，一个失控的客户端能造成什么？', [
        '单客户打满下游容量，演变为对所有人的 DoS',
        '结构性检查会把“公开写 API 无限流”判为缺陷',
      ]),
    ],
  },
  {
    type: 'appserver',
    name: '应用服务',
    nameEn: 'App Service',
    category: '计算',
    behavior: 'service',
    icon: 'rack',
    color: '#4ade80',
    blurb: '无状态业务逻辑层，水平扩容靠加实例。',
    defaultCapacityPerReplica: 800,
    baseLatencyMs: 15,
    costPerReplicaPerHour: 25,
    lab: 'capacity',
    labTitle: '容量扩容推演',
    questions: [
      q('基础', '为什么应用层要做无状态？状态放哪？', [
        '无状态才能任意扩缩容和故障替换',
        '状态外置到缓存 / DB / 对象存储',
      ]),
      q('进阶', '这个服务单实例 800 QPS 是怎么来的？瓶颈是 CPU 还是 IO？', [
        '区分 CPU-bound 与 IO-bound，扩容与优化手段不同',
        'IO-bound 先看连接池、超时与下游延迟',
      ]),
      q('故障', '一个实例假死（进程在但不响应），流量会怎样？', [
        '靠健康检查剔除 + 超时熔断；LB 的最少连接策略能缓解倾斜',
      ]),
    ],
  },
  {
    type: 'feedservice',
    name: 'Feed 服务',
    nameEn: 'Feed Service',
    category: '计算',
    behavior: 'service',
    icon: 'list',
    color: '#34d399',
    blurb: '时间线聚合：推模式（写扩散）还是拉模式（读扩散）是核心抉择。',
    defaultCapacityPerReplica: 900,
    baseLatencyMs: 20,
    costPerReplicaPerHour: 25,
    lab: 'feed-push-pull',
    labTitle: '推拉成本对比',
    questions: [
      q('基础', 'Feed 用推还是拉？各自的成本在哪？', [
        '推：写时扩散，读便宜写贵；拉：读时聚合，读贵写便宜',
        '大 V 是推模式的极端情况：一次发帖 = 上亿次写入',
      ]),
      q('追问', '大 V 发帖时怎么避免写扩散打爆系统？', [
        '混合模式：普通用户推，大 V 拉（读时合并）',
        '异步 fan-out + 队列削峰，接受秒级延迟',
      ]),
      q('故障', 'fan-out 是同步做的，会发生什么？', [
        '发帖请求被粉丝数放大为同步写风暴，DB 写 TPS 瞬间打满',
        '结构性检查会把“无队列的同步 fan-out”判为缺陷',
      ]),
    ],
  },
  {
    type: 'searchservice',
    name: '搜索服务',
    nameEn: 'Search Service',
    category: '计算',
    behavior: 'service',
    icon: 'search',
    color: '#2dd4bf',
    blurb: '倒排索引查询，与主存储异步同步。',
    defaultCapacityPerReplica: 500,
    baseLatencyMs: 25,
    costPerReplicaPerHour: 30,
    lab: 'capacity',
    labTitle: '容量扩容推演',
    questions: [
      q('基础', '为什么搜索不走主库的 LIKE 查询？', [
        '全表扫描 + 无相关性排序，量级一大必挂',
        '倒排索引把词→文档的映射预先算好',
      ]),
      q('进阶', '索引和主库数据不一致（延迟）能接受吗？', [
        '搜索通常接受秒级最终一致',
        '同步链路：binlog/CDC → 队列 → 索引服务',
      ]),
    ],
  },
  {
    type: 'cache',
    name: '缓存 Redis',
    nameEn: 'Cache (Redis)',
    category: '存储',
    behavior: 'offload',
    icon: 'lightning',
    color: '#facc15',
    blurb: '挡在 DB 前面的读加速层。命中率就是它的 KPI。',
    defaultCapacityPerReplica: 5000,
    baseLatencyMs: 2,
    costPerReplicaPerHour: 18,
    baseHitRate: 0.82,
    lab: 'cache-lru',
    labTitle: 'LRU / 命中率实验室',
    questions: [
      q('基础', '缓存淘汰策略 LRU 和 LFU 怎么选？', [
        'LRU 看最近使用，适合有明显时间局部性的访问',
        'LFU 看频率，适合热点稳定但偶有突发扫描的场景',
      ]),
      q('进阶', '缓存穿透、击穿、雪崩分别是什么？怎么防？', [
        '穿透：查不存在的 key——布隆过滤器 / 空值缓存',
        '击穿：热点 key 过期瞬间——互斥重建 / 逻辑过期',
        '雪崩：大批 key 同时过期——TTL 加随机抖动',
      ]),
      q('故障', '缓存整层挂掉，DB 会发生什么？', [
        '全部读流量瞬间回源，DB 利用率跳升数倍（缓存雪崩的极端形态）',
        '对策：缓存高可用、限流降级、DB 预留余量',
      ]),
    ],
  },
  {
    type: 'relationaldb',
    name: '关系型 DB',
    nameEn: 'Relational DB',
    category: '存储',
    behavior: 'storage',
    icon: 'cylinder',
    color: '#60a5fa',
    blurb: '强一致、事务、关系查询。写容量是它的天花板。',
    defaultCapacityPerReplica: 1200,
    baseLatencyMs: 8,
    costPerReplicaPerHour: 60,
    lab: 'consistent-hashing',
    labTitle: '一致性哈希分片环',
    questions: [
      q('基础', '什么时候必须用关系型 DB？什么时候不该？', [
        '需要事务与复杂关系查询时',
        '媒体 blob、海量简单 KV 读写不该塞进关系库',
      ]),
      q('进阶', '读写分离后，读到旧数据怎么办？', [
        '主从延迟导致 replica lag，刚写完读可能读不到',
        '对策：关键读走主库 / 会话级一致性 / 接受最终一致并做产品兜底',
      ]),
      q('追问', '分片键选 created_at 会有什么问题？', [
        '单调递增键让写入永远落在最新分片——热点分片',
        '分片键要选高基数、分布均匀、且与主要查询维度一致的字段',
      ]),
      q('故障', '主库宕机，切主期间写请求怎么办？', [
        '选主空窗期写不可用或降级排队',
        '多主 / 自动 failover 的代价是冲突处理复杂度',
      ]),
    ],
  },
  {
    type: 'nosql',
    name: 'NoSQL 存储',
    nameEn: 'NoSQL Store',
    category: '存储',
    behavior: 'storage',
    icon: 'table',
    color: '#818cf8',
    blurb: '按 key 水平扩展的存储，分片键决定分布与命运。',
    defaultCapacityPerReplica: 3000,
    baseLatencyMs: 6,
    costPerReplicaPerHour: 55,
    lab: 'consistent-hashing',
    labTitle: '一致性哈希分片环',
    questions: [
      q('基础', 'NoSQL 放弃了什么，换来了什么？', [
        '放弃 join 与强事务，换来水平扩展与高写吞吐',
        '查询模式必须在建模时先定：按查询设计表',
      ]),
      q('进阶', '一致性哈希加虚拟节点解决什么问题？', [
        '节点增减时只迁移约 1/N 的 key（vs 取模的近全量）',
        '虚拟节点让小规模集群的负载分布更均匀',
      ]),
      q('追问', '热点 key（如大 V 的计数器）怎么处理？', [
        '分片计数（counter sharding）：写随机分片，读时聚合',
        '或本地聚合 + 批量回写，牺牲实时性换吞吐',
      ]),
    ],
  },
  {
    type: 'objectstorage',
    name: '对象存储',
    nameEn: 'Object Storage',
    category: '存储',
    behavior: 'storage',
    icon: 'bucket',
    color: '#fb923c',
    blurb: '照片/视频等大对象的家，便宜、耐久、吞吐高。',
    defaultCapacityPerReplica: 10000,
    baseLatencyMs: 12,
    costPerReplicaPerHour: 8,
    lab: 'scale-estimate',
    labTitle: '量级估算',
    questions: [
      q('基础', '为什么照片不存 DB？元数据和文件本体怎么分工？', [
        'DB 存元数据（id、作者、URL、尺寸），文件本体进对象存储',
        '读路径：CDN → 对象存储，DB 不参与媒体流量',
      ]),
      q('进阶', '上传一张图到用户能看到，中间要经过哪些异步步骤？', [
        '直传对象存储 → 发事件 → Worker 转码/缩略图 → 更新元数据状态',
      ]),
    ],
  },
  {
    type: 'queue',
    name: '消息队列',
    nameEn: 'Message Queue',
    category: '异步',
    behavior: 'queue',
    icon: 'pipe',
    color: '#e879f9',
    blurb: '削峰填谷：把突发流量变成消费者能消化的恒定流。',
    defaultCapacityPerReplica: 20000,
    baseLatencyMs: 1,
    costPerReplicaPerHour: 10,
    bufferSize: 2000000,
    lab: 'queue-backlog',
    labTitle: '积压与消费延迟',
    questions: [
      q('基础', '队列什么时候帮倒忙？', [
        '消费能力长期低于生产速度时，积压只是把故障往后推',
        '积压延迟本身会变成一种故障（消息过期、顺序问题）',
      ]),
      q('进阶', '生产 3,600 条/s、消费 1,500 条/s，积压曲线会怎样？', [
        '积压以差值速率线性增长，直到缓冲上限开始丢弃/报错',
        '对策：扩消费者、降级生产端、或接受延迟并设上限',
      ]),
      q('故障', '队列满了以后新消息怎么办？', [
        '阻塞生产者（反压）、丢弃、或落盘死信——必须在设计时选好',
      ]),
    ],
  },
  {
    type: 'worker',
    name: '后台 Worker',
    nameEn: 'Worker',
    category: '异步',
    behavior: 'worker',
    icon: 'gear',
    color: '#c084fc',
    blurb: '异步任务消费者：转码、fan-out、通知、计数聚合。',
    defaultCapacityPerReplica: 400,
    baseLatencyMs: 30,
    costPerReplicaPerHour: 20,
    lab: 'queue-backlog',
    labTitle: '积压与消费延迟',
    questions: [
      q('基础', '哪些活应该从同步链路里拆到 Worker？', [
        '耗时、非关键路径、可重试的：转码、推送、fan-out、报表',
        '拆分标准：用户是否需要同步等结果',
      ]),
      q('进阶', 'Worker 怎么保证任务不丢、不重复执行？', [
        '至少一次投递 + 幂等处理是常见组合',
        '失败重试要有上限 + 死信队列',
      ]),
      q('故障', 'Worker 全部挂掉 10 分钟，恢复时要注意什么？', [
        '积压洪峰：恢复瞬间消费速率打满下游',
        '对策：限速消费、按优先级排空、过期任务直接丢弃',
      ]),
    ],
  },
];

export const COMPONENT_MAP: Record<ComponentTypeId, ComponentDef> = Object.fromEntries(
  COMPONENTS.map((c) => [c.type, c]),
) as Record<ComponentTypeId, ComponentDef>;

export function componentDef(type: ComponentTypeId): ComponentDef {
  return COMPONENT_MAP[type];
}
