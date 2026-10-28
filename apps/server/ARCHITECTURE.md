# 后端架构

```
apps/server/
├── src/
│   ├── index.ts              装配与生命周期（唯一入口）
│   ├── config/
│   │   ├── schema.ts         配置类型 + 默认值 + mergeSettings
│   │   └── store.ts          读写、v1→v2→v3 迁移、原子落盘
│   ├── core/
│   │   ├── logger.ts         环形缓冲 + 多消费者
│   │   ├── events.ts         状态事件总线（合并 + 无订阅者零开销）
│   │   ├── sessions.ts       会话路由/计数/会话级选择（含账号维度）
│   │   ├── dispatch.ts       触发规则 → 选下游+配置 → 组装 prompt → 管道
│   │   └── sending.ts        选账号 → 分段/表情 → OneBot action
│   ├── upstream/
│   │   ├── onebot.ts         单个 OneBot v11 客户端
│   │   └── manager.ts        多账号上游集合（每号一条连接）
│   ├── downstream/
│   │   ├── types.ts          适配器契约 + 命名配置
│   │   ├── registry.ts       类型 → 工厂映射
│   │   ├── manager.ts        实例生命周期 + 配置解析 + 自注册
│   │   ├── inbound.ts        下游入站 WS（酒馆 / dsh 插件）
│   │   ├── dsh.ts            dsh（插件优先 + headless 兜底）
│   │   └── sillytavern.ts    酒馆扩展
│   └── api/
│       ├── router.ts         极简路由 + JSON 包装
│       ├── events.ts         SSE 状态流 /api/events
│       ├── context.ts        依赖容器
│       └── routes/
│           ├── status.ts     状态 / 日志 / 健康
│           ├── downstreams.ts 下游增删改查 + 命名配置 + 自注册
│           ├── sessions.ts   会话与触发规则
│           ├── config.ts     全局配置 + 账号
│           ├── dsh.ts        dsh 服务与插件注入
│           └── host.ts       SnowLuma / 酒馆本体管理
└── *.mjs                     迁移期保留：表情库、Ollama、dsh 服务管理
```

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

