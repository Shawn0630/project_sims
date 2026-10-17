# 系统设计模拟器 · System Design Simulator

**A LeetCode for system design.** 选一道题（Design Instagram / Twitter / 短链接），
先在空白画布上用组件把系统设计出来，提交后由测试用例（包括隐藏的 edge cases）
逐个判卷，再由驾驶员（脚本或真 LLM）操作模拟器复盘——瓶颈在哪、为什么、怎么改，
全部绑定在画布证据上。

## 快速开始

```bash
npm install
npm run dev        # 打开 http://localhost:5173
```

生产构建与类型检查：

```bash
npm run build      # tsc --noEmit（全仓）+ vite build
npm run preview    # 预览构建产物
```

环境：Node ≥ 20（开发于 Node 24 / npm 10）。

## 玩法（面试流程）

1. **设计**：从左侧组件库把组件点进画布（拖拽排版），开「连线模式」连接数据流，
   点组件在右侧改参数（副本数、容量、分片键、限流、缓存策略…）。
   流量、场景、判卷在这个阶段都是关的——先交卷，再看答案。
2. **提交验证**：点「提交设计」，流量开始跑。顶部实时看入站 QPS / P99 / 错误率 /
   缓存命中 / 读旧数据 / 成本；可以手动砸场景（网红爆帖、缓存雪崩、热点 key、
   读写翻转、杀最热节点），也可以逐个回放用例。
3. **判卷报告**：「运行全部用例」逐个跑这道题的测试套件：
   - 可见用例（如基线、晚高峰、成本上限）提交前就能看到阈值；
   - **隐藏 edge cases**（大 V fan-out、缓存雪崩、热点分片、峰值宕机、主从延迟读旧数据…）
     提交后才揭示，每例有明确通过阈值（错误率 / P99 / 成本 / 存储入站 / 积压上限），
     挂掉的用例给出实测值、缺陷定位和修复提示，并可一键回放在画布上重演；
   - 同时跑**确定性结构检查**（单点故障、无缓存的读热点、同步 fan-out、blob 进 DB、
     分片键选了单调字段、网关没限流…），不依赖任何 LLM，离线就有完整 bug 报告。

**细究模式**：点画布上任意组件，右侧打开它的「面试官细究」面板——带着它此刻的
实时背景（入站 QPS 及占比、利用率、延迟、上下游），左边是接了实时数据的模块实验室
（分片 DB/NoSQL → 一致性哈希环；缓存 → LRU 命中率；LB → 策略对比；网关 → 令牌桶；
队列/Worker → 积压曲线；Feed → 推拉成本；CDN → 回源放大），右边是这个模块的
面试官追问链（基础 → 进阶 → 追问 → 故障，每题先自答再展开要点）。

**数据库设计**：每道题有一份可编辑的 schema 草稿（表、字段、索引、主键生成、
分片键、数据量级）。「让评审员检查」按需求覆盖 / 延迟风险 / 扩展性三维出报告：
逐条访问模式判路径（主键直查 / 索引 / 分片内定位 / 跨分片广播 / 全表扫描）与延迟估算，
延迟还会接入画布上 DB 的实时利用率折算。

## 驾驶员（LLM 操作模拟器）

驾驶员通过一组工具接口操作模拟器，而不是只在旁白评论：

```
set_traffic / inject_event / kill_node / revive_node /
read_metrics / highlight / run_test_case / review_schema
```

三种实现共用同一个 `Driver` contract，换驾驶员不改模拟器核心：

| 驾驶员 | 说明 |
|---|---|
| `ScriptedDriver` | 默认。离线、确定性，按「基线 → 峰值 → 爆帖 → 杀节点 → 用例 → Schema 评审」的脚本操作，也是测试套件的回归驾驶员 |
| `OpenAICompatibleDriver` | **云端 API（用户定的优先项）**。对任何 OpenAI 兼容的 `/chat/completions` 端点跑 function-calling agent 循环 |
| `OllamaDriver` | 本地 fallback。走 Ollama `/api/chat` 的工具调用，需要本地有支持工具调用的模型（如 Qwen3 家族） |

### 接云端 API

两种方式，key 都只留在本地，**不要提交进仓库**（`.env*` 已在 .gitignore 里）：

- 在页面「驾驶员」面板里选择「云端 LLM」，填 API Key / Base URL / 模型——只存浏览器 localStorage；
- 或复制 `.env.example` 为 `.env.local`，填 `VITE_OPENAI_API_KEY` 等变量作为预填值。

### 接 Ollama

```bash
ollama pull qwen3:30b   # 任意支持工具调用的模型
ollama serve            # 默认 http://localhost:11434
```

页面驾驶员面板选「Ollama 本地」即可。注意浏览器从 `localhost:5173` 调用
`localhost:11434` 时，Ollama 需要允许跨域：启动时设 `OLLAMA_ORIGINS=*`。

## 架构

npm workspaces 单仓多包，包之间只通过公开入口互相依赖，驾驶员与核心零耦合：

```
apps/web/                 React + Vite 前端（LeetCode 式布局）：左侧题目页签（描述/Schema/
                          用例/提交记录/驾驶员）、画布（SVG 标准图示图标 + 请求粒子）、
                          细究 slide-over、底部结果面板
packages/sim-core/        模拟引擎：拓扑流量传播、组件行为模型、事件、指标快照
packages/components/      13 个组件定义：容量/延迟/成本参数、白板图标、实验室映射、静态追问链
                          （仅作 ScriptedDriver 的离线 fallback 内容）
packages/problems/        3 道题：题面、量级、可编辑 schema、用例套件（可见 + 隐藏）、示例设计，
                          以及每道题自己的读写需求画像（workload：读写比、访问模式及
                          QPS 量级、路径、一致性要求）——细究层跨题通用，数字全部由此驱动
packages/checker/         只做硬判定：结构检查规则、用例判卷 runner（阈值 pass/fail）、
                          Schema 规则信号（路径/延迟/发现），以及 SimulatorTools 实现
packages/driver/          Driver contract（操作模拟器 + 全部定性评定接口）+ 三个实现：
                          脚本驾驶员（离线 fallback）/ OpenAI 兼容（云端优先）/ Ollama
labs/consistent-hashing/  一致性哈希实验室组件：只在分片 DB / NoSQL / 缓存集群的细究里出现
```

### 评定分工（代码判卷 vs LLM 评定）

- **代码判卷（`packages/checker`）**：逐用例 P99 / 错误率 / 成本阈值判定、总分、结构规则与
  Schema 路径/延迟信号。确定性、可复现，LLM 不改判。
- **LLM 评定（`packages/driver` 接口）**：提交后的综合评审与分数理由、细究追问的生成
  （输入 = 设计快照 + 组件参数 + 本题 workload + 判卷信号，针对这份设计现场生成）、
  Schema 结论与改进建议、结构 bug 的解释。所有评定类 UI 只经 Driver 接口取内容；
  无 key 时 ScriptedDriver 用同一批确定性信号离线生成同形状的结果，云端 Driver 接上后
  即由真 LLM 产出。

### 模拟模型（刻意做成可解释的近似）

引擎是确定性的解析模型（一 tick = 一模拟秒），不是包级仿真：

- 流量从 client 沿连线拓扑传播；同类型多下游均分（负载均衡），不同类型下游各得全量（一次请求真的会同时碰缓存、DB、搜索）；
- 缓存/CDN 只拦读流量，命中率决定回源量；队列按下游 Worker 总容量排空，积压单独成指标，且异步分支不计入请求路径 P99；
- 利用率 = 入站 / (副本 × 单副本容量)，延迟随利用率超线性上升，超过 1 后按比例产生错误；写入比读取更贵（负载因子随读写比变化）；
- 同类型兄弟节点宕机时流量自动改道（健康检查语义），全灭才计错误；
- 热点 key 事件给目标存储加一股绕过缓存的写洪峰，分片键的好坏决定它被摊开还是砸在单片上；
- 主从读旧数据概率随每副本写入速率与存储负载上升，强一致归零。

阈值与参数都写在 `packages/problems` 与 `packages/components` 的数据里——
加一道新题 = 写一份 problem 定义（题面 + schema + 用例），不用改引擎。

## 验证状态

- `npm install` / `npm run build`（含全仓 tsc 类型检查）通过；
- 无头验证过判卷逻辑：三道题的示例设计都是「可见用例过、隐藏 edge cases 挂」
  的教学形态；一份刻意做强的 Instagram 设计能达到 8/9；
- 脚本驾驶员可离线完整跑完一轮（读指标 → 加压 → 注入事件 → 杀节点 → 跑用例 → Schema 评审）；
- 云端 / Ollama 驾驶员实现了完整的 function-calling 循环，但需要你自己的 key / 本地模型才能实跑。
