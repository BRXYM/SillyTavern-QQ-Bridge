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
│   │   ├── conversations.ts       独立会话配置校验与兼容导入
│   │   └── flows.ts               流程模型、校验、解析与兼容流程
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
                           core/flow-runtime.ts（固定四步）
                                        │  上游处理 → 调用 → 下游处理 → 投递
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

## 流程、资源与会话

五类对象独立保存：`accounts[]` 上游账号、`downstreams[]` 连接、`conversationProfiles[]` 会话配置、`flows[]` 消息流程，以及 `sessions.json` 会话绑定。

```json
{
  "flows": [{
    "id": "daily_chat",
    "name": "日常聊天",
    "enabled": true,
    "downstreamId": "dsh",
    "conversationId": "assistant",
    "upstreamEnabled": true,
    "downstreamEnabled": true
  }],
  "defaultFlowId": "daily_chat"
}
```

示例引用的连接和会话配置须已存在。流程固定为上游处理、调用下游、下游处理、回复 QQ；配置只被引用，不复制到流程中。两侧处理开关分别控制对应区域，均关闭时直接透传。API 拒绝任意节点、脚本等不支持的字段。

会话使用 `flowId`，缺失时继承 `defaultFlowId`；绑定 API 传 `null` 表示恢复继承，同时清除旧的下游/配置覆盖。显式绑定或默认流程不存在时停止执行并报错，不暗中改走其他服务。已引用的流程、连接和会话配置禁止删除，需先解除引用。

旧会话仍可保留 `backendId/profileId/conversationId`。`config/flows.ts` 将原组合解析为稳定 ID 的兼容流程，未编辑时沿用原提示词与回复处理；显式旧覆盖仍优先于新的全局默认。选择流程后会清理旧字段。保存兼容流程采用新处理定义，但连接未变化时保留旧 profile 的协议覆盖。只读 `legacyProfileId/legacyPreserveBehavior` 来自服务端，不接受客户端注入。

旧版下游命名配置仅作兼容。`SessionStore.resolve()` 和 `mergeSettings()` 保留旧协议合并职责；新入口通过 `resolveFlow()` 选择流程，不再将其用作新的会话路由模型。

会话 key 为 `<accountId>:private_<uin>` / `<accountId>:group_<gid>_<uin>`。变量与处理队列按完整 key 隔离。会话切换流程不会重置已有变量；不同账号不会共享同一用户的状态。

### 执行与调试

`core/flow-runtime.ts` 提供同一个 `executeFlow()` 供真实消息、模拟预览、真实调用测试使用。`dispatch.ts` 负责原触发/准入检查、账号与路由定位，再提供下游调用、状态提交和 QQ 投递回调。

- 上游处理：提取 → 变量赋值 → 文本规则 → 前后追加与提示词展开。
- 调用下游：调用现有适配器一次，不自动重试。
- 下游处理：处理服务原始回复，成功后原子保存变量与提取历史。持久化失败停止投递。
- 回复 QQ：沿用原账号、分段、节奏和媒体发送。记录成功/失败段数；投递失败不撤销已完成的下游结果与状态，也不自动重发。

上游处理后为空时跳过后续步骤；回复处理后为空时不投递。调用或处理失败不推进会话变量。模拟预览不访问下游，使用模拟回复与独立模拟状态；真实调用测试使用 `_flow_test_<uuid>`，结束后请求适配器清理，不提交真实状态、不投递 QQ。兼容流程未修改的模拟预览恢复服务端旧行为，修改后按编辑定义校验。

`FlowRunStore` 仅在内存保留最近 50 次执行，重启清空；记录各步骤状态、输入输出、前置提示词、耗时、错误，以及变量变动和是否保存。单段正文截断至 4096 字，不采集连接认证或请求头。正文自身可能包含用户敏感内容。流程页可见时每 3 秒刷新执行记录，连接和配置状态继续使用 SSE。

| API | 用途 |
|---|---|
| `GET /api/flows` | 已保存与兼容流程、默认值、引用数与会话绑定 |
| `POST /api/flows` | 新建/更新固定流程，校验资源引用 |
| `POST /api/flows/:id/default` | 设为全局默认，必要时物化兼容定义 |
| `DELETE /api/flows/:id` | 删除未引用的已保存流程 |
| `POST /api/flows/preview` | 提交 flow/text/reply/state，模拟执行 |
| `POST /api/flows/:id/test` | 使用独立测试会话真实调用，返回步骤记录 |
| `GET /api/flow-runs` | 最近执行，可按 flowId/sessionKey 筛选 |
| `POST /api/sessions/:key` | `{ "flowId": "daily_chat" }` 绑定；null 继承 |

首版只支持固定四步；没有分支、循环、并行、多下游串联或分布式恢复。

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
| 连接、会话配置和流程分离 | 多个流程复用服务与处理规则 |
| 会话只选择流程 | 显式流程优先，否则继承全局默认 |
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
- 连接模式只保存地址、认证、请求体模板与响应映射，不创建会话配置。旧适配草稿与命名配置 API 保留兼容；前置提示词和消息处理在独立会话配置中编辑。
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

## 控制台职责与独立会话配置

- 下游连接：只维护服务实例、地址、认证与协议映射。HTTP requestBody 是协议字段映射，输入用 input.text，前置提示词用 input.system。
- 会话配置：顶层 conversationProfiles，包含 id/name/systemPrompt/inputPrefix/inputSuffix/inputRules/replyRules；不包含地址、认证或下游 ID。API 严格拒绝连接字段。
- 消息流程：组合连接、会话配置与两侧处理开关。会话管理只维护 flowId、默认流程与单会话变量。旧默认和绑定字段仅供兼容 API 使用。
- 消息链路：输入规则 → 前后缀 → 下游（携带 system）→ 回复规则 → 原账号发送。默认配置可跨下游复用；明确不使用配置时不套用旧提示词和规则。
- 兼容：旧 profiles 保留在运行文件中，导入独立配置带只读 legacyRef。尚未编辑且仍沿用旧绑定的会话走原处理链；编辑保存后解除 preserveBehavior 标记。原连接覆盖与协议参数不被导入到新会话配置。
- 被流程引用的配置禁止删除；未被流程引用的旧配置删除时清理其旧绑定。

新增 API：GET/POST /api/conversations、DELETE /api/conversations/:id、POST /api/conversations/preview（纯文本预览）、POST /api/conversation-defaults。原下游命名配置 API 仅保留兼容，核心界面不再调用。

## SnowLuma 核心连接

GET /api/snowluma/connection 读取现有账号、OneBot 端点和注入诊断。POST /api/snowluma/connect 只将现有连接信息保存到 Bridge 并发起连接，不写入 SnowLuma 配置。POST /api/accounts/:id/connect 重新连接已保存账号。

注入诊断优先读取本机 WebUI /api/processes 中明确的 injected 状态；Windows 下可只读枚举 QQ 主进程与 mojo.<pid>.control 管道作补充。管道检测无法确认账号归属时只提示 PID。无权限、接口不兼容、未登录或不可访问时保留未知，不能由 OneBot 断线推断未注入。

原 POST /api/snowluma/hook 与 hook/restore 返回 410，不再更改注入开关。旧 apply API 保留兼容，但上游页面不再调用；页面只提供检测、连接、断开与手动参数。


## 双向处理运行时

config/conversation-flow.ts 校验提取、初始化、赋值与模板依赖；core/conversation-engine.ts 在私有工作副本中执行上游和下游两个阶段；core/conversation-state.ts 按完整 sessionKey 排队并原子保存状态。引擎不执行脚本，不访问网络或任意文件。

上游完成提取及变量赋值后，才渲染系统提示和输入消息；下游拿到最终文本后可引用本轮两端提取值。previous 仅保存上一轮成功处理的提取映射，不存整段对话。赋值默认跳过空值；所有赋值基于同阶段提取完成后的同一个快照同时计算。

只有成功调用下游的轮次提交状态；失败或上游被过滤时丢弃工作副本。持久化失败时不替换内存状态。配置切换不重置同会话变量。未启用处理的旧会话仍保持原逻辑，不更新此状态。

GET /api/session-variables/:key 返回 state 与 revision；POST 接受 vars 与 revision，在同一会话队列中保存，修订不一致返回 409。POST /api/conversations/preview 使用请求内的独立 state，返回 input/system/output、extracted、下一轮 state 和 warnings，从不访问真实会话状态。

应用关闭时先释放下游，再关闭会话队列。新消息与排队任务在关闭后拒绝执行。变量状态文件格式为 version=1 + sessions 映射，加载校验失败会显式报错，防止覆盖损坏文件造成静默丢失。
