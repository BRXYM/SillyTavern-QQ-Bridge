# 后端架构

当前后端采用模块化单体：应用装配、业务流程、传输和第三方集成各有边界，仍用一个 Node.js 进程运行。

```text
apps/server/
├── src/
│   ├── index.ts                   进程入口、信号处理、退出码
│   ├── app/
│   │   ├── application.ts         createApplication：依赖装配和启动顺序
│   │   ├── lifecycle.ts           顺序启动、逆序关闭、启动失败回收
│   │   ├── paths.ts               数据路径与源码版本
│   │   ├── sessions.ts            会话初始化、旧 key 迁移、事件绑定
│   │   ├── message-events.ts      上游事件 → 状态推送 / 消息派发
│   │   └── diagnostics.ts         运行环境诊断
│   ├── config/
│   │   ├── schema.ts              配置类型、默认值与设置合并
│   │   ├── store.ts               配置迁移、读取与原子写入
│   │   ├── runtime.ts             环境覆盖、注册 token、运行时配置
│   │   └── behavior.ts            会话行为配置解析
│   ├── core/                      会话、触发规则、派发、发送、日志与事件
│   ├── upstream/                  OneBot 客户端、多账号管理、SnowLuma hook
│   ├── downstream/
│   │   ├── types.ts               下游消息适配器契约
│   │   ├── runtime.ts             下游运行时集合契约（与 HTTP 解耦）
│   │   ├── registry.ts            类型注册与适配器工厂
│   │   ├── manager.ts             实例生命周期、命名配置、自注册
│   │   ├── inbound.ts             入站 WebSocket 协议与连接管理
│   │   ├── listener.ts            入站监听生命周期与适配器路由
│   │   ├── dsh.ts                 dsh 消息适配器
│   │   └── sillytavern.ts         酒馆消息适配器
│   ├── services/faces/
│   │   ├── runtime.ts             表情初始化、选取与近期去重
│   │   ├── faces-service.mjs      同步与打标编排
│   │   ├── faces-store.mjs        表情存储与检索
│   │   └── faces-labeler.mjs      Ollama 打标
│   ├── integrations/
│   │   ├── dsh/                   CLI 客户端、profile / 插件管理、运行时
│   │   ├── ollama/                HTTP 客户端与本机服务管理
│   │   ├── snowluma/              安装探测、OneBot 配置
│   │   └── sillytavern/           安装探测、扩展安装
│   ├── api/
│   │   ├── server.ts              HTTP 服务创建、路由注册、SSE 分流
│   │   ├── router.ts              路由匹配、请求解析和 JSON 响应
│   │   ├── context.ts             API 依赖契约
│   │   ├── events.ts              SSE 状态流
│   │   └── routes/                按业务模块组织的 API 端点
│   └── types/legacy-modules.d.ts   现有 mjs 集成模块的类型声明
├── tests/                         应用集成与生命周期回归测试
├── st-headless.mjs                独立酒馆 CLI 工具，仍从后端根目录运行
├── config.json / sessions.json    运行数据，位置兼容旧版
└── data/                          表情缓存等运行数据
```

## 依赖与职责

- `index.ts` 只处理进程。导入 `app/application.ts` 不会创建应用、连接账号或注册信号处理器。
- `createApplication()` 装配依赖、加载配置和会话，返回 `start()` / `stop()` / `context`。测试可注入 `serverRoot` 和 `env`，使用临时数据目录。
- `start()` 依次启动会话生命周期、表情、上游、下游、入站 WS、HTTP。任何一步失败都会回收当前步骤和此前已启动的资源。
- `stop()` 按相反顺序释放资源；重复或并发调用共用一次关闭流程。SSE 与 WS 连接会主动断开，某一步清理失败仍继续清理其余资源。
- `core` 保留统一业务链路；下游适配器只处理消息传输；`integrations` 处理第三方软件的具体 API、文件和进程；`services` 组合这些能力。
- HTTP 路由从 `api/server.ts` 集中注册，业务服务无需启动 HTTP 即可复用。下游集合接口归属 `downstream/runtime.ts`。

## 扩展第三方下游

1. 在 `downstream/` 实现 `DownstreamAdapter`，通过 `ask()` 返回最终文本、通过 `reset()` 清理上下文。
2. 在 `downstream/types.ts` 声明类型，并在 `registry.ts` 登记工厂和类型展示信息；需要额外依赖时扩展 `AdapterDeps`，由应用装配层注入。
3. 第三方 HTTP / CLI / 文件操作放到 `integrations/<服务名>/`。不要复制发送、分段、表情或 QQ 账号选择逻辑。
4. 主动连接 Bridge 的插件沿用入站 WS 协议及 token 校验；实例通过 `downstreamId` 区分。
5. 如果需要软件管理端点，在 `api/routes/` 添加模块并在 `api/server.ts` 注册。

此结构为新增协议和适配器提供位置；自然语言生成任意第三方服务适配器不属于本次结构重构。

## 兼容与验证

启动命令、API 路径、端口环境变量、v1/v2/v3 配置迁移、账号维度的会话 key、配置/历史文件位置保持兼容。现有 `.mjs` 集成实现搬入对应目录并更新导入，未同时改写为 TypeScript。

```bash
pnpm --filter @bridge/server typecheck
pnpm --filter @bridge/server test
pnpm test
pnpm typecheck
```

后端新增测试在临时目录运行，覆盖 HTTP 健康/状态/404、SSE 清理、WS 连接关闭、两种监听端口占用、配置覆盖和 token 持久化，以及启动失败和关闭异常的资源回收。真实 QQ 和 dsh 模型调用需在部署环境另行验证。

## 数据流

```
QQ 用户（可能多个号）
   │ OneBot v11（每号一条 WS，端口/token 各自独立）
   ▼
SnowLuma ──▶ upstream/manager.ts ──▶ 事件补上 accountId
                                        │
                                        ▼
                                  core/dispatch.ts
                                        │  选「下游实例 + 命名配置」（会话级 > 全局默认）
                                        ▼
                             downstream/<adapter>.ts
                                        │  最终文本
                                        ▼
                        core/sending.ts（选账号 → 分段 / 表情）
                                        │
                                        ▼
                          OneBot action → **同一个号** → QQ
```

**上游按账号隔离**：`upstream/manager.ts` 为每个启用的账号维护一条连接，
事件在交给业务前补上 `accountId`。回复时必须用同一个 `accountId` 选上游，
否则 A 号收到的消息会从 B 号发出去。

**下游可扩展**：新增一种后端 = 实现 `DownstreamAdapter` + 在 `registry.ts` 注册一行，
不需要改 dispatch、sending 或任何 api 文件。

## 多账号与命名配置

三层结构，越往下越具体：

```
账号（accounts[]）          qq_123 / qq_456        各自独立连接、独立会话
  └── 下游实例（downstreams[]）  dsh / tavern / ...    同类型可多个
        └── 命名配置（profiles[]） 鲸鱼娘 / 客服         只描述差异
```

会话最终绑定的是「实例 + 配置」：

| 会话字段 | 缺失时 | 说明 |
|---|---|---|
| `backendId` | `defaultDownstreamId` | 用哪个下游实例 |
| `profileId` | `defaultDownstreamProfileId` | 用该实例下的哪份配置 |

`profileId` 有两层继承判断（见 `SessionStore.resolve`）：

1. 会话没写 → 用全局默认配置
2. 但**仅当会话用的实例就是全局默认实例**时才套用 ——
   全局默认配置描述的是默认实例的差异，套到别的实例上会串味。

显式写 `profileId: ''` 表示「明确不用配置」，与「缺失（继承）」区分开。

配置合并规则（`schema.mergeSettings`）：配置只覆盖它显式给出的键，
没写的沿用实例设置；嵌套对象（如 `prompt`）逐键合并，不会因为
配置里只写一个开关就把其余抹掉。

会话 key 带账号前缀：`<accountId>:private_<uin>` / `<accountId>:group_<gid>_<uin>`。
同一用户在两个号下聊天是两个独立会话，各自有自己的下游、配置和上下文。

### 端口必须逐号分配

这是多号接入最容易踩的坑，而且**两侧日志都不明显**：

| 现象 | 真实原因 |
|---|---|
| 加了第二个号，但它永远收不到消息 | 两个号写成了同一个端口 |
| SnowLuma 日志只有一句 `network startup degraded` | 后启动的号 `listen EADDRINUSE`，WS 服务没起来 |
| 两个号的 `selfId` 显示成同一个 | 两条连接实际连的是同一个实例 |
| 同一条消息被回复两次 | 同上的后果 |

SnowLuma 每个 QQ 号都有独立的 `onebot_<uin>.json`，**各自监听自己的 wsServer**。

端口由后端统一分配，起点固定，不随前端输入漂移：

```
3001 → 3002 → 3003 → …        （第 N 个号用 3001+N-1）
```

`pickOneBotPort` 的取舍：

| 情况 | 做法 |
|---|---|
| 该号已有端口，且没被其他账号占用 | **沿用**（重复点按钮不换端口） |
| 端口被其他账号配置占用 | 跳过，继续往上 |
| 端口真被别的进程监听（NapCat / 残留进程） | 跳过，继续往上 |

第二、三条缺一不可：只比配置不看实际监听，会把端口分给一个正在被占用的号，
结果又是 EADDRINUSE；只查监听又会让自己正在正常工作的号每次都被换端口。

起点固定而不是"找最小空闲"，是为了让「第几个号在哪」可预测 —— 排查时看一眼就知道。

上游管理器还会在 `apply()` 里做一次端点去重：同一 `host:port` 只保留第一个账号，
其余跳过并记警告。这样即使配置错了，也不会出现"一条消息回两遍"。

### 改完 OneBot 配置必须重启 SnowLuma

`onebot_<uin>.json` 只在 SnowLuma **启动时**读取。写完文件后：

- 运行中的 SnowLuma 仍用旧 token / 旧端口
- Bridge 立刻用新 token 去连 → 得到 **401 rejected unauthorized WebSocket upgrade**
- 界面上表现为「配置写成功、状态就绪，但这个号连不上」

`/api/snowluma/apply` 因此返回 `restartRequired`（`changed && 端口在监听`），
前端把它显示成明确的警告，而不是绿色的"已就绪"。

## 状态推送

前端不靠固定轮询发现异常：上游断线、下游上下线、配置变更都会在**发生的那一刻**
通过 `GET /api/events`（SSE）推给前端。

```
UpstreamManager ──account-connected/disconnected/error──┐
DshAdapter      ──attach/detach───────────────────────┤
SillyTavern     ──attach/detach───────────────────────┼─▶ statusBus ─▶ SSE ─▶ 前端精确更新
SessionStore    ─changed/created/removed──────────────┤
updateConfig    ──────────────────────────────────────┘
```

设计要点：

| 点 | 做法 | 原因 |
|---|---|---|
| 载荷 | 只带 kind + 最小信息 | 不重复传整份快照，带宽与序列化成本都很低 |
| 合并 | 服务端 150ms / 客户端 100ms | 抖动时不会引发连锁刷新 |
| 空闲 | 无订阅者时直接 return | 没人看就不产生任何开销 |
| 心跳 | 25s 注释行 | 保活且不触发前端逻辑 |
| 兜底 | SSE 断了退回 3s 轮询 | 实时是优化，正确性仍由快照保证 |

前端收到事件后**不做全量刷新**：`upstream` 只改连接字段，`downstream` 只改对应实例，
只有会话/配置这类影响面大的变更才触发一次快照对齐。

`/api/status` 同时给两份上游视图：`accounts[]` 是每号明细，
`upstream` 是聚合（任一在线即为在线），旧版面因此不用改也能看。

## 关键约定

| 约定 | 原因 |
|---|---|
| 下游只返回最终文本 | 分段/表情/管道统一在 Bridge，新增后端不必重写发送链路 |
| 下游用「实例 id」而非枚举 | 同类型可配多个实例（两个 dsh 各连不同模型） |
| 配置用「命名配置」而非直接改实例 | 同一台 dsh 要服务多种人设，复用一套可执行文件路径 |
| 会话选择三层继承 | 账号 → 实例 → 配置，逐层回落 |
| 发送必须带 accountId | 多账号下用错号等于冒名发言 |
| **每个账号必须用不同的 OneBot 端口** | SnowLuma 每个号各自监听自己的 wsServer，两个号写同一端口时后启动的那个 `EADDRINUSE` 起不来 |
| 自注册必须带 token | 防止同机任意进程改下游配置 |
| 入站连接按 `downstreamId` 路由 | 否则多实例时新实例永远收不到连接 |
| `packages/core` 是唯一实现 | 分段/管道/媒体解析不再有第二份，测试即生产 |

## 迁移说明

配置分三代，启动时按 `configVersion` 自动迁移并写回：

| 版本 | 形态 |
|---|---|
| v1 | 一层平铺（`onebotUrl` / `backend` / `dshProfile` …） |
| v2 | `upstream`（单个）+ `downstreams[]` + `faces` |
| v3 | `accounts[]` + `downstreams[].profiles[]` |

v1 → v2 映射：

| 旧字段 | 新位置 |
|---|---|
| `onebotUrl` / `onebotToken` | `upstream.url` / `upstream.token` |
| `stExtPort` | `extPort` |
| `backend: 'dsh' \| 'taver'` | `defaultDownstreamId` |
| `dshProfile` / `dshTimeoutMs` … | `downstreams[id=dsh].settings.*` |
| `ollamaBaseUrl` / `ollamaVisionModel` | `faces.*` |
| `dshPluginToken` | `registrationToken`（插件握手与自注册共用） |

v2 → v3 映射：

| 旧位置 | 新位置 |
|---|---|
| `upstream` | `accounts[0].upstream`（首个账号 id 为 `main`） |
| `downstreams[]`（无 profiles） | `downstreams[].profiles: []` |

会话文件也要迁移：升级前的会话 key 没有账号前缀
（`private_123` / `group_456_123`），启动时统一挂到第一个账号下
（`SessionStore.adoptLegacyKeys`）。不迁移的话第一个号上线后
会看到一堆"新会话"，用户已有的下游/角色绑定全丢。


## dsh 下游适配助手

下游管理页的「用 dsh 适配新下游」调用管理面专用的 `services/adaptation/service.ts`。流程为：用户填写新实例 ID、目标地址、接入目标和接口资料 → dsh 分析生成 JSON 草稿 → Bridge 校验 → 用户编辑/真实测试 → 保存为 `http-json` 下游和默认命名配置 → 在会话页选择实例与配置。

- 默认选可用的默认 dsh，否则选首个可用 dsh，也可显式选择来源。来源必须为启用且可用的 dsh 实例。
- 每个任务使用独立 `_adaptation_<uuid>` 上下文，结束后请求清理；不传入 QQ 会话历史、其它连接配置或全局凭据。dsh 本身仍运行在它原有的工具和权限环境中，生成任务不是额外的执行沙箱。
- 模型只返回声明式 JSON。资料不足或不支持的协议返回 `needs-input` 与问题列表。Bridge 不执行生成的 JavaScript，不自动修改第三方软件。
- `draft.connection` 保存 url、method、headers、timeoutMs、response；`draft.conversation` 保存 systemPrompt 和 requestBody。应用到现有 v3 结构时，实例 settings 保存基线，默认 profile 保存对话设置；HTTP profile 只允许覆盖这两个对话字段。
- 新增或修改 HTTP 连接只重新加载该实例，保留 dsh 连接。保存不会覆盖同 ID 的实例，也不会切换默认下游。
- 任务持久化到 `data/adaptations/<uuid>.json`；最近 30 个任务可从页面恢复；未完成任务在重启后标记中断。数据目录已被 gitignore。

### 首版连接范围

`downstream/http-json.ts` 支持同步 GET/POST、JSON 请求体、JSON 字段提取（如 `choices.0.message.content`）和纯文本响应。模板支持 `{{input.text}}`、`{{input.system}}`、`{{input.sessionKey}}`、`{{input.sender}}`、`{{input.requestId}}`。请求头额外允许 `{{env.MY_API_KEY}}`，凭据只在实际调用时读取；例如 `Authorization: Bearer {{env.MY_API_KEY}}`。URL 查询参数会编码，JSON 模板值不会被执行成代码。

连接配置加载并不代表远端在线；页面的测试会真实发起调用。适配生成和保存本身不访问目标接口。连接不自动重试、不跟随重定向，超时最多 180 秒，响应体最多 2MB。当前不支持 SSE 流式、WS 自定义协议、stdio、自动轮询和任意脚本，需要这些协议时由 dsh 提出限制或要求补充同步接口。

### 管理 API

| API | 用途 |
|---|---|
| `GET /api/adaptations` | 最近任务 |
| `POST /api/adaptations` | 创建生成任务，返回 202 与任务 ID |
| `GET /api/adaptations/:id` | 查询进度、问题或草稿 |
| `POST /api/adaptations/:id/test` | 用提交的 draft 与 text 真实调用目标服务 |
| `POST /api/adaptations/:id/apply` | 保存提交的 draft 为新下游，重复应用幂等 |

适配器错误、资料缺失、任务生成失败、真实调用失败和运行时加载失败分别反馈，不会用配置加载成功冒充接口调用成功。集成测试使用模拟 dsh 插件和 OneBot 上游，并真实调用本地 HTTP 服务，覆盖生成、测试、保存、会话绑定与 QQ 回包；真实模型生成质量需用已连接的 dsh 验证。

## 控制台信息结构

产品定位为「多 QQ、多下游的自由控制台」。QQ 账号维护入口连接，下游连接维护服务实例，对话配置页面编辑实例下的 profiles，会话路由选择实例与配置。当前保存格式仍为 configVersion 3；配置尚未成为跨下游的独立实体。

- 总览集中展示 QQ 账号、下游连接、对话配置和会话数量，以及每条入口 / 出口的状态。
- 对话配置支持按下游选择、新建、编辑 JSON 参数、查看使用数、主动测试及删除。测试使用独立于 QQ 的会话标识，并携带合并后的配置和系统提示。
- 会话与路由优先展示真实生效关系，支持按账号、下游、关键词筛选并保存绑定。继承关系以服务端解析结果为准。
- 删除配置按实际下游归属清理会话，避免不同实例下同名配置互相影响。
- 当前继承层级为全局默认 → 会话覆盖。账号级默认路由、任意脚本执行与更多协议不属于已实现能力。
