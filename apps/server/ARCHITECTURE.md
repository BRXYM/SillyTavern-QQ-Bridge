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
│   │   ├── behavior.ts            会话行为配置解析
│   │   ├── conversations.ts       旧会话配置兼容与处理参数校验
│   │   └── flows.ts               流程模型、校验、解析与兼容流程
│   │       operators.ts           算子/操作模型与旧配置展开
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
                                        │  选消息流程（会话级 > 全局默认）
                                        ▼
                           core/flow-runtime.ts → operator-runtime.ts
                                        │  有序算子 → 操作列表 → 按需调用/处理/投递
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

## 算子流程、资源与会话

主要模型为 `accounts[]` 上游账号、`downstreams[]` 连接、`flows[]` 流程配置，以及 `sessions.json` 的会话绑定。`conversationProfiles` 和原命名配置字段仅在旧数据兼容边界读取。

每份流程配置包含 `id/name/enabled/downstreamId/operators`。`downstreamId` 是所属下游；`operators[]` 是有序列表，每项具有稳定 `id/name/enabled/actions`。算子内的 `actions[]` 可自由混合：

| type | 参数与行为 |
|---|---|
| input | source 模板成为当前文本 |
| process | source、prefix/suffix、可选 system、rules、extracts、assignments、variables、stopIfEmpty |
| call | 可选 downstreamId（省略用所属下游）、input/system 模板 |
| reply | text 模板、stopAfter；原账号返回，可继续执行 |
| stop | 结束剩余操作，不隐式返回 |

没有固定四个阶段，也没有默认调用或默认回复。一个算子内可以先返回，再调用，再处理，再次返回；多个调用可以指向同一个或不同连接。最多 32 个算子、每算子 16 个操作、总计 128 个操作。参数严格校验，不接受脚本。当前不支持条件分支、循环、并行与分布式调度。

`config/operators.ts` 校验操作参数、模板、提取、变量和稳定标识。`operatorFlow()` 将旧对话字段复制为可编辑算子，编辑器从此不再依赖会话配置。旧版固定流程在未保存前保留原执行器和绑定行为；保存新定义后由通用算子运行时执行。旧协议覆盖、方向引用和服务上下文通过兼容字段保留。旧 `/profiles` 页面重定向到流程页，历史 API 为兼容调用保留。

### 连接与配置绑定

会话显式绑定 `{ backendId, flowId }`，服务器要求流程属于所选下游。`{ backendId, flowId: null }` 表示使用该下游默认配置，存储为 `flowDefault: true`；`{ backendId: null, flowId: null }` 清除显式组合，继承全局默认。

`defaultFlowId/defaultDownstreamId` 是全局默认组合；`downstreamFlowDefaults[downstreamId]` 是各下游默认配置。旧绑定仍在迁移边界解析，显式旧覆盖不会被新默认暗中覆盖。绑定不存在或不匹配时停止执行，不改走其他服务。

删除流程会检查全局默认、下游默认和所有会话引用。删除连接会检查流程所属关系与所有 call 操作的额外连接引用。已保存配置不能直接改变所属下游，需要复制为新配置，避免既有会话突然交叉绑定。

### 执行器与检查点

`core/flow-runtime.ts` 是运行入口和追踪存储。新流程进入 `operator-runtime.ts`，按算子和操作列表顺序执行。`dispatch.ts` 保留原触发/准入、账号定位与同会话队列，并提供 ask/commit/deliver 回调。多次提交会更新 revision，避免第二次返回发生版本冲突。

当前文本、提示词、原始 QQ 消息、最近服务回复、本次各算子记录和私有变量副本构成执行上下文。模板支持 text/system、message、extracted、operators、history 和 vars。缺失数据按空文本处理并产生诊断，未来操作结果不会倒流。插入的数据不递归解释；替换规则中的数据会转义美元符号。每次提取后同时计算本操作的赋值，再处理文本。

每次真实返回前保存此前变量和历史，流程正常完成时保存最终状态。后续调用失败不撤销已发回复、服务调用或已保存检查点；未提交变更丢弃。持久化失败阻止当次返回。QQ 投递失败不自动重发，不触发额外兜底回复。追踪中标出每个变量是否已保存及此前外部效果。

新 call 操作的服务 sessionKey 为 `flow_<SHA256 前40位>`，摘要输入为完整会话、流程、算子、操作 ID 的 JSON 数组，长度小于 dsh 工作目录名的 60 字截断上限。稳定 ID 使排序不改变上下文，不同调用相互隔离；旧迁移调用可保留原 sessionKey。变量仍按原始完整 QQ 会话 key 保存，切换流程不会清空同名变量。

### 调试与存储

模拟执行不访问服务、不投递 QQ、不持久化真实状态；`replies` 映射按 `算子ID.操作ID` 指定不同调用的回复。真实测试执行所有服务调用，以 `_flow_test_<uuid>` 和各操作 ID 生成隔离服务标识，记录所有返回但不发送 QQ；结束后逐个清理使用过的适配器测试上下文。

`FlowRunStore` 在内存保留最近 50 次。追踪含动态算子、操作状态、输入输出、提示词、耗时、错误、变量变更和每次返回，正文每项截断至 4096 字。不记录连接认证与请求头。流程页可见时每 3 秒刷新，其他状态保持 SSE。

`ConversationState` 保留旧 vars/previous，并新增可选 operators 映射，存储上次检查点的 input/output/extracted。历史输入输出各截断 4000 字；变量和提取每映射最多 32 项，每值 4000 字；每会话最多 512000 字，总文件最多 16 MiB。状态原子写入，坏文件报错而不静默清空。读取历史使用 `history.<算子ID>`，本次数据使用 `operators.<算子ID>`。

| API | 用途 |
|---|---|
| `GET /api/flows` | 下游流程配置、展开的旧定义、各默认值与绑定 |
| `POST /api/flows` | 校验并保存流程配置 |
| `POST /api/flows/validate` | 只校验与规范化 JSON，供导入使用 |
| `POST /api/flows/:id/default` | 设置全局默认组合与该下游默认配置 |
| `POST /api/flow-defaults` | 设置 downstreamId 对应的 flowId 默认值 |
| `DELETE /api/flows/:id` | 删除未引用配置 |
| `POST /api/flows/preview` | flow/text/reply/replies/state 模拟执行 |
| `POST /api/flows/:id/test` | 多调用隔离测试，不投递 QQ |
| `GET /api/flow-runs` | 追踪，可按 flowId/sessionKey 筛选 |
| `POST /api/sessions/:key` | backendId + flowId 组合绑定/继承 |
| `GET/POST /api/session-variables/:key` | 读取或带 revision 编辑会话变量 |

### QQ 端点

每个 QQ 使用独立 OneBot WebSocket 端口。控制台读取 SnowLuma 已有配置后连接，不分配或修改端口、不自动注入。账号记录存在但未注入时显示对应诊断；诊断不足时显示未知。上游管理器还会去重相同端点，避免同一条消息被多个配置重复接收。

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
| 连接与算子流程分离 | 同一连接使用多份流程配置，参数保存在算子中 |
| 会话选择下游 + 流程配置 | 所属关系校验，支持下游默认与全局默认 |
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

下游管理页的「用 dsh 适配新下游」调用管理面专用的 `services/adaptation/service.ts`。流程为：用户填写新实例 ID、目标地址、接入目标和接口资料 → dsh 分析生成 JSON 草稿 → Bridge 校验 → 用户编辑/真实测试 → 保存为 `http-json` 连接 → 在消息流程中引用。

- 默认选可用的默认 dsh，否则选首个可用 dsh，也可显式选择来源。来源必须为启用且可用的 dsh 实例。
- 每个任务使用独立 `_adaptation_<uuid>` 上下文，结束后请求清理；不传入 QQ 会话历史、其它连接配置或全局凭据。dsh 本身仍运行在它原有的工具和权限环境中，生成任务不是额外的执行沙箱。
- 模型只返回声明式 JSON。资料不足或不支持的协议返回 `needs-input` 与问题列表。Bridge 不执行生成的 JavaScript，不自动修改第三方软件。
- 连接模式只保存地址、认证、请求体模板与响应映射，不创建会话配置。旧适配草稿与命名配置 API 保留兼容；前置提示词和消息处理直接在算子中编辑。
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

## SnowLuma 核心连接

GET /api/snowluma/connection 读取现有账号、OneBot 端点和注入诊断。POST /api/snowluma/connect 只将现有连接信息保存到 Bridge 并发起连接，不写入 SnowLuma 配置。POST /api/accounts/:id/connect 重新连接已保存账号。

注入诊断优先读取本机 WebUI /api/processes 中明确的 injected 状态；Windows 下可只读枚举 QQ 主进程与 mojo.<pid>.control 管道作补充。管道检测无法确认账号归属时只提示 PID。无权限、接口不兼容、未登录或不可访问时保留未知，不能由 OneBot 断线推断未注入。

原 POST /api/snowluma/hook 与 hook/restore 返回 410，不再更改注入开关。旧 apply API 保留兼容，但上游页面不再调用；页面只提供检测、连接、断开与手动参数。


## 状态生命周期

会话队列按完整账号/群/成员 key 串行，变量管理与消息处理共用相同队列。手动变量编辑携带 revision，过期返回 409，不覆盖消息新结果。应用关闭后拒绝新的排队工作，等待既有队列清理。变量状态文件保持 version=1，旧文件缺少 operators 仍可读取。

测试在临时目录和模拟 OneBot 中验证算子混合操作、前置回复、多次调用、多次返回、检查点、真实 HTTP 串联、账号隔离、下游/流程匹配、历史兼容及失败不重试。真实 QQ 与模型质量需在可连接部署环境验证。
