# 系统设计模拟器 · System Design Simulator

**A LeetCode for system design.** 选一道题（Design Instagram / Twitter / 短链接），
先在空白画布上用组件把系统设计出来，提交后由测试用例（包括隐藏的 edge cases）
逐个判卷，再由驾驶员（脚本或真 LLM）操作模拟器复盘——瓶颈在哪、为什么、怎么改，
全部绑定在画布证据上。

## 快速开始

前端是「瘦前端」：题目、判卷和 AI 评审都在后端，所以要开两个终端：

```bash
npm install
npm run dev:server   # 后端 API → http://localhost:8787（题目/判卷/评审）
npm run dev          # 前端 → http://localhost:5173
```

只开前端会看到「需要后端」页面——前端不内置任何题目数据，这是刻意的（见下方「后端」一节）。
后端不配 LLM key 也能全功能运行（评审走脚本回落，离线可用）。

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

### 接云端 API / Ollama

评审模型由**后端**配置（环境变量 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`，
见下方「后端」一节），浏览器里不再填 key。Ollama 作为后端可达的
OpenAI 兼容端点接入：把 `LLM_BASE_URL` 指向 `http://localhost:11434/v1`、
`LLM_MODEL` 设为本地模型名即可（key 随便填一个非空值）。

## 后端（Backend）

四套系统（仿真 / 答题 / LLM eval / LLM 生成题目）里，后端是 eval 与题目的家：

**瘦前端原则**：`apps/web` 不存任何题目逻辑——不 import `@sds/problems` /
`@sds/checker` / `@sds/driver`，bundle 里没有题目数据、测试用例、读写画像、
判卷或评审代码。前端只剩仿真系统本身（sim-core 引擎、组件定义、画布、实验室渲染）
加渲染职责：题面、规模、可见用例、workload 画像都作为运行时数据从 API 拉取；
细究需要的 workload 随题目从 API 来。后端不可达时前端显示明确的「需要后端」
状态，不回退到任何内置题目。

```bash
npm run dev:server   # 或 npm run start -w @sds/server；tsx 直接跑 TS 源码
```

环境变量（shell 导出，或复制 `apps/server/.env.example` 为 `apps/server/.env`）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | API 监听端口 |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | 任意 OpenAI 兼容端点 |
| `LLM_API_KEY` | （空） | 不设 = 脚本回落，服务照常工作，启动不要求 key |
| `LLM_MODEL` | `gpt-4o-mini` | 评审模型名 |
| `VITE_API_URL` | `http://localhost:8787` | 前端构建时变量，后端地址 |

接口：

| 接口 | 说明 |
|---|---|
| `GET /api/health` | 存活 + 题目数 + LLM 是否已配置 |
| `GET /api/problems` / `GET /api/problems/:id` | 题目包（渲染数据）；隐藏用例只保留 id/名称/权重并标 `locked`，场景、阈值、提示一律剥离 |
| `POST /api/submissions/judge` | `{ problemId, design, schema?, schemaLoadFactor? }` → 在服务端跑既有 checker 判卷，返回逐例结果 + 结构检查 + Schema 信号 |
| `POST /api/evaluate` | `{ kind: submission \| schema \| followups, context }` → 后端组装 prompt、做**一次** LLM 调用、防御性解析结构化 JSON 返回；无 key 或调用失败回落 ScriptedDriver 同形状结果。`kind=schema` 可直接传 `{ problemName, schema, loadFactor }`，信号由服务端计算并随响应返回 |
| `POST /api/problems/generate` | **桩**：校验题目种子 `{ title, statement, scaleNotes? }` 后返回 501 与计划中的题目包生成契约——这是第四套系统（LLM 生成题目）的接缝 |
| `GET /admin` | 作者控制台（见下方「作者控制台」） |
| `PUT /api/problems/:id` / `DELETE /api/problems/:id` | 作者写接口：整包替换 / 删除题目包（经 `ProblemStorage` 落盘）。**仅限本地/内网作者使用，本轮无登录鉴权，不要暴露公网** |

### 作者控制台（Admin）

`GET /admin` 是后端自带的单页控制台（原生 JS，无前端构建，页面直接调上面的 API），
是题库作者的工作台，也是将来 LLM 生成题目系统的入口。它分三区：

- **题库**：题目包列表（标题 / id / 难度 / 可见·隐藏用例数 / 草稿标记）；点开看整包概要，
  可在 JSON 文本域里编辑整包（校验合法性后 `PUT` 保存）、删除（confirm 后 `DELETE`）。
  「新建题目」是种子表单：调生成器会如实返回 501「生成器待接入」；也可以
  **把种子存为草稿 pack**（`POST /api/problems/draft`：id 由标题 slug 化、难度默认「中等」、
  空用例集的最小合法包，草稿标记存在服务端 `data/drafts.json` 旁车文件里），作者流程先跑通。
- **组件**：`@sds/components` 注册表的只读展示（模型参数 / 实验室 / 内建追问链 / 被哪些题引用），
  外加一层**数值默认参数覆盖**（存 `data/component-overrides.json`）。⚠️ 覆盖层目前只是
  服务端记录：答题前端仿真用的是它 bundle 内的组件定义，**覆盖值尚未接入运行时**（待接线）。
- **LLM 调用**：每一次经 `/api/evaluate` 的模型调用（及脚本回落）都落盘一条记录到
  `apps/server/data/llm-calls.jsonl`（时间 / kind / 模型 / 完整 input / 完整 output / 耗时 /
  usage / 成败），admin 里可逐条展开看原文。日志可能含用户设计数据，**只留本地、不进 repo**
  （已 gitignore）。

⚠️ **安全口径**：admin 与 PUT/DELETE 接口本轮不加登录鉴权，**仅限本地/内网使用，不要直接暴露公网**。

**隐藏用例为什么必须在服务端**：早期浏览器直连形态下，隐藏 edge cases 的场景与
阈值就在前端 bundle 里，打开 DevTools 就能看光——那不叫隐藏。现在它们只存在于
服务端 storage，客户端在提交前只能看到「🔒 隐藏用例」，判卷后才以结果形式揭示。

**存储**：`apps/server/src/storage.ts` 定义 `ProblemStorage` 接口
（listProblems / getProblem / saveProblem），唯一实现是 JSON 文件
（`apps/server/data/problems/<id>.json`，由 `npm run seed -w @sds/server`
从 `@sds/problems` 导出种子）。以后换 Postgres 只是再写一个实现，路由与判卷不动。

**个人/离线使用**：本地起后端、不配 key 即全功能离线运行（评审为脚本回落）——
这是原来「浏览器直连」形态的替代：key 只存在于后端 env，判卷公正性也不再依赖
前端自觉。

## 架构

npm workspaces 单仓多包，包之间只通过公开入口互相依赖，驾驶员与核心零耦合：

```
apps/web/                 React + Vite 瘦前端（LeetCode 式布局）：运行时从 API 拉题目包渲染，
                          左侧题目页签（描述/Schema/用例/提交记录）、画布（SVG 标准图示图标 +
                          请求粒子）、细究 slide-over、底部结果面板；只含仿真 + 渲染
apps/server/              Hono 后端：题目存储（JSON 包）、服务端判卷、LLM 评审调用、
                          题目生成桩——见上方「后端」一节
packages/sim-core/        模拟引擎：拓扑流量传播、组件行为模型、事件、指标快照
packages/components/      13 个组件定义：容量/延迟/成本参数、白板图标、实验室映射、静态追问链
                          （仅作 ScriptedDriver 的离线 fallback 内容）
packages/problems/        题目作者格式：3 道题（题面、量级、可编辑 schema、用例套件、
                          示例设计、每题的读写需求画像 workload）——经 seed 导出为
                          服务端 storage 的 JSON 包后由 API 下发，运行时前端不打包它
packages/checker/         只做硬判定：结构检查规则、用例判卷 runner（阈值 pass/fail）、
                          Schema 规则信号（路径/延迟/发现），以及 SimulatorTools 实现；
                          现在由服务端判卷接口调用
packages/driver/          Driver contract（操作模拟器 + 全部定性评定接口）+ 三个实现：
                          脚本驾驶员（离线 fallback）/ OpenAI 兼容（云端优先）/ Ollama；
                          评定接口在服务端被 /api/evaluate 消费
labs/consistent-hashing/  一致性哈希实验室组件：只在分片 DB / NoSQL / 缓存集群的细究里出现
```

### 评定分工（代码判卷 vs LLM 评定）

- **代码判卷（`packages/checker`）**：逐用例 P99 / 错误率 / 成本阈值判定、总分、结构规则与
  Schema 路径/延迟信号。确定性、可复现，LLM 不改判。
- **LLM 评定（`packages/driver` 接口，经后端 `POST /api/evaluate` 消费）**：提交后的综合评审与分数理由、细究追问的生成
  （输入 = 设计快照 + 组件参数 + 本题 workload + 判卷信号，针对这份设计现场生成）、
  Schema 结论与改进建议、结构 bug 的解释。前端只组装上下文并发起调用、渲染返回的
  结构化结果；服务端的单次 LLM 调用失败或没配 key 时，ScriptedDriver 在服务端用同一批
  确定性信号回落生成同形状的结果。

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

- `npm install` / `npm run build`（含全仓 tsc 类型检查）通过；前端 bundle 已核查：
  不含任何题目数据（用例名、workload、DAU 等字符串零命中）；
- 后端实测：`/api/health`、题目包下发（隐藏用例剥离验证无泄漏）、
  `POST /api/submissions/judge`（Instagram 示例设计 3/9、结构发现与 Schema 信号齐全）、
  `POST /api/evaluate` 三种 kind 在无 key 模式下走脚本回落并返回设计相关的追问/评审、
  `POST /api/problems/generate` 对合法种子返回 501 契约、非法入参 400；
- 无头验证过判卷逻辑：三道题的示例设计都是「可见用例过、隐藏 edge cases 挂」
  的教学形态；一份刻意做强的 Instagram 设计能达到 8/9；
- 脚本驾驶员可离线完整跑完一轮（读指标 → 加压 → 注入事件 → 杀节点 → 跑用例 → Schema 评审）；
- 云端 / Ollama 驾驶员实现了完整的 function-calling 循环，但需要你自己的 key / 本地模型才能实跑。
