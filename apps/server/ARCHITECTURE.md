# 后端架构

```
apps/server/
├── src/
│   ├── index.ts              装配与生命周期（唯一入口）
│   ├── config/
│   │   ├── schema.ts         配置类型 + 默认值
│   │   └── store.ts          读写、旧版迁移、原子落盘
│   ├── core/
│   │   ├── logger.ts         环形缓冲 + 多消费者
│   │   ├── events.ts         状态事件总线（合并 + 无订阅者零开销）
│   │   ├── sessions.ts       会话路由/计数/会话级选择
│   │   ├── dispatch.ts       触发规则 → 选下游 → 组装 prompt → 管道
│   │   └── sending.ts        分段/表情 → OneBot action
│   ├── upstream/
│   │   └── onebot.ts         SnowLuma / OneBot v11 客户端（唯一上行源）
│   ├── downstream/
│   │   ├── types.ts          适配器契约
│   │   ├── registry.ts       类型 → 工厂映射
│   │   ├── manager.ts        实例生命周期 + 自注册
│   │   ├── inbound.ts        下游入站 WS（酒馆 / dsh 插件）
│   │   ├── dsh.ts            dsh（插件优先 + headless 兜底）
│   │   └── sillytavern.ts    酒馆扩展
│   └── api/
│       ├── router.ts         极简路由 + JSON 包装
│       ├── events.ts         SSE 状态流 /api/events
│       ├── context.ts        依赖容器
│       └── routes/
│           ├── status.ts     状态 / 日志 / 健康
│           ├── downstreams.ts 下游增删改查 + 自注册
│           ├── sessions.ts   会话与触发规则
│           ├── config.ts     全局配置 / 预览
│           ├── dsh.ts        dsh 服务与插件注入
│           └── host.ts       SnowLuma / 酒馆本体管理
└── *.mjs                     迁移期保留：表情库、Ollama、dsh 服务管理
```

## 数据流

```
QQ 用户
   │ OneBot v11
   ▼
SnowLuma ──▶ upstream/onebot.ts ──▶ core/dispatch.ts
                                          │  选下游（会话级 > 全局默认）
                                          ▼
                              downstream/<adapter>.ts
                                          │  最终文本
                                          ▼
                              core/sending.ts（分段 / 表情）
                                          │
                                          ▼
                                    OneBot action → QQ
```

**上游唯一**：只有 `upstream/onebot.ts` 能收发 QQ 消息，下游适配器不直接碰 OneBot。

**下游可扩展**：新增一种后端 = 实现 `DownstreamAdapter` + 在 `registry.ts` 注册一行，
不需要改 dispatch、sending 或任何 api 文件。

## 状态推送

前端不靠固定轮询发现异常：上游断线、下游上下线、配置变更都会在**发生的那一刻**
通过 `GET /api/events`（SSE）推给前端。

```
OneBotClient ──connected/disconnected/error──┐
DshAdapter  ──attach/detach──────────────────┤
SillyTavern ──attach/detach──────────────────┼─▶ statusBus ─▶ SSE ─▶ 前端精确更新
SessionStore ─changed/created/removed────────┤
updateConfig ────────────────────────────────┘
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

## 关键约定

| 约定 | 原因 |
|---|---|
| 下游只返回最终文本 | 分段/表情/管道统一在 Bridge，新增后端不必重写发送链路 |
| 下游用「实例 id」而非枚举 | 同类型可配多个实例（两个 dsh 各连不同模型） |
| 会话选择三层继承 | 与角色/世界书一致：会话级 → 全局默认 |
| 自注册必须带 token | 防止同机任意进程改下游配置 |
| 入站连接按 `downstreamId` 路由 | 否则多实例时新实例永远收不到连接 |
| `packages/core` 是唯一实现 | 分段/管道/媒体解析不再有第二份，测试即生产 |

## 迁移说明

旧版 `config.json` 是一层平铺（`onebotUrl` / `backend` / `dshProfile` …），
新版拆成 `upstream` / `downstreams` / `faces` 分组。启动时自动迁移并写回
（`configVersion: 2`），映射关系：

| 旧字段 | 新位置 |
|---|---|
| `onebotUrl` / `onebotToken` | `upstream.url` / `upstream.token` |
| `stExtPort` | `extPort` |
| `backend: 'dsh' \| 'taver'` | `defaultDownstreamId` |
| `dshProfile` / `dshTimeoutMs` … | `downstreams[id=dsh].settings.*` |
| `ollamaBaseUrl` / `ollamaVisionModel` | `faces.*` |
| `dshPluginToken` | `registrationToken`（插件握手与自注册共用） |
