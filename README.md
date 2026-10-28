# SillyTavern QQ Bridge

**[SillyTavern (酒馆)](https://github.com/SillyTavern/SillyTavern) ↔ QQ 双向桥接** —— 让酒馆里的 AI 角色直接在 QQ 上和真人聊天。

支持 **SnowLuma / NapCat / Lagrange / go-cqhttp** 等所有 **OneBot v11** 协议端，自带 Web 控制台。

> **关键词**：SillyTavern 酒馆 QQ 机器人 · OneBot v11 · SnowLuma · NapCat · Lagrange · QQ Bot · AI 角色扮演 · 多会话隔离 · 回复分段 · 表情包

前后端分离的 monorepo：Vue 3 + TypeScript + Vite 7 + Tailwind CSS v4。

> 当前状态：**后端已整合**。Web 控制台 8 个页面可用，桥接后端与酒馆扩展已并入同一仓库，`pnpm dev` 即可完整运行。核心逻辑（分段 / 管道 / 会话 / 图片）抽为独立包并覆盖 66 个单元测试。

> **分支说明**：本分支（`next`）是下一代主线，仓库根目录即完整前后端工程。v1 / v2 的历史版本仍可在 `main` 分支查看。

---

## 功能

### 已验证可用

- **Web 控制台** — 8 个页面：总览、运行日志、SnowLuma 接入、下游管理、会话、回复分段、图片表情、系统设置
- **多会话隔离** — 每个 QQ 号 / 群聊独立绑定角色与世界书，留空则继承全局默认
- **回复分段** — 四层分隔符（硬标点 / 软标点 / 配对符 / 自定义字符串），按字数与条数智能打包，条间随机延迟
- **配对符保护** — `*动作*`、`"台词"` 等成对内容保持完整，内部标点不切分
- **回复处理管道** — `replace` / `remove` / `strip` 三类规则，支持三层策略：全局默认 → 会话覆盖
- **dsh 直连** — QQ ↔ DeepSeek Harness（dsh）第二条后端链路：共用触发规则、处理管道、分段与表情包；按会话隔离上下文并落盘续聊
- **会话级后端** — 每个 QQ 号 / 群成员可单独选择走 dsh 还是酒馆角色对话，未设置的继承全局默认
- **图片 / 表情回复** — 识别 `[图片:URL]`、`<img src>`、`[表情:]` 并转为 OneBot 消息段
- **通知弹窗** — 右上角堆叠、进度条推进、3 秒自动消失、悬停暂停
- **亮 / 暗双主题** — 跟随系统，可手动切换并持久化

### 规划中

- **Fastify 后端** — 逐步替代现有 v2 后端，SSE 推送替代轮询
- **酒馆扩展 TypeScript 化** — 当前为 ES 模块 JS
- **服务编排器** — SnowLuma / SillyTavern 的下载、启停、健康检查
- **SQLite 持久化** — 替代 `config.json` / `sessions.json`

---

## 快速开始

### 环境要求

- Node.js >= 22
- pnpm >= 11
- （可选）DeepSeek Harness：`npm i -g @deepseek-ai/dsh`

### 安装

```bash
git clone https://github.com/BRXYM/SillyTavern-QQ-Bridge.git
cd SillyTavern-QQ-Bridge
pnpm install
```

### 首次配置

```bash
cp apps/server/config.example.json apps/server/config.json
```

编辑 `config.json` 填入你的 OneBot token：

```jsonc
{
    "configVersion": 3,
    "accounts": [
        {
            "id": "main",
            "uin": "",
            "name": "主号",
            "enabled": true,
            "upstream": {
                "url": "ws://127.0.0.1:3001",
                "token": "你的 SnowLuma Access Token"
            }
        }
    ],
    "downstreams": [
        { "id": "dsh", "kind": "dsh-plugin", "enabled": true, "settings": {}, "profiles": [] },
        { "id": "tavern", "kind": "sillytavern", "enabled": false, "settings": {}, "profiles": [] }
    ],
    "defaultDownstreamId": "dsh",
    "defaultDownstreamProfileId": ""
}
```

想同时接多个 QQ 号，就往 `accounts` 里再加一项
（每个号的 OneBot 端口与 token 在 SnowLuma 里是独立的）：

```jsonc
"accounts": [
    { "id": "main",  "uin": "1417434860", "enabled": true, "upstream": { "url": "ws://127.0.0.1:3001", "token": "..." } },
    { "id": "qq_2",  "uin": "1234567890", "enabled": true, "upstream": { "url": "ws://127.0.0.1:3002", "token": "..." } }
]
```

> 从旧版升级不必手改：旧配置会在启动时自动迁移
> （v1 平铺 → v2 分组 → v3 多账号）。旧会话也会自动归属到第一个账号下。
> `registrationToken` 首次运行自动生成，供 dsh 插件自注册使用。

### 启动

```bash
pnpm dev
```

一条命令同时拉起后端与前端：

```
SillyTavern QQ Bridge
[dev] 模式：前后端一体
[dev] 启动后端 .../apps/server/src/index.ts
[api] 下游入站 WS 服务已启动: ws://127.0.0.1:9500
[api] API 服务已启动: http://127.0.0.1:9510/api/status
[dev] 后端就绪 → http://127.0.0.1:9510
[web] VITE v7.3.7  ready in 790 ms
  ➜  控制台   http://localhost:5178
  ➜  后端 API  http://127.0.0.1:9510/api/status
```

打开 <http://localhost:5178> 即可。

### 安装酒馆扩展

把 `apps/extension/` 整个目录复制到酒馆的第三方扩展目录：

```bash
# 目标位置
<SillyTavern>/public/scripts/extensions/third-party/SnowLuma-Bridge/
```

然后重启酒馆，在扩展面板确认「已连接 ws://127.0.0.1:9500」。

打开 <http://localhost:5178> 即可。

### 其他命令

```bash
pnpm dev:web          # 只启动前端（后端需已在运行）
pnpm dev:api          # 只启动后端
pnpm start            # 只启动后端（生产）
pnpm build            # 构建前端
pnpm test             # 运行单元测试（74 个）
pnpm typecheck        # 类型检查
```

### 环境变量

`scripts/dev.mjs`、`vite.config.ts` 与后端读取同一组变量，保证端口一致。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `WEB_PORT` | `5178` | 前端端口 |
| `API_PORT` | `9510` | 后端 API 端口（仅 `/api/*`，无网页） |
| `EXT_PORT` | `9500` | 酒馆扩展 WebSocket 端口 |
| `ONEBOT_URL` | — | 覆盖第一个账号的 OneBot 地址 |
| `ONEBOT_TOKEN` | — | 覆盖第一个账号的 OneBot token |
| `ST_DATA_DIR` | 自动探测 | 酒馆数据目录 |
| `BRIDGE_OPEN` | — | 设为 `1` 启动后自动开浏览器 |

```powershell
$env:WEB_PORT = 5180; pnpm dev
```

端口冲突时可整体换一套：

```powershell
$env:WEB_PORT='5180'; $env:API_PORT='9520'; $env:EXT_PORT='9521'; pnpm dev
```

---

## 接入 DeepSeek Harness（dsh）

除了酒馆，还可以让 QQ 消息直接交给本机的 **dsh**（DeepSeek Harness）处理。两条链路**共用同一套触发规则**，切换后端不会绕过限制。

### 使用步骤

1. 安装 dsh：`npm i -g @deepseek-ai/dsh`
2. 控制台进入 **下游管理** 页，展开 dsh 实例，点「重新探测」确认版本与路径
3. 按需填写 profile（默认 `headless`）、工作目录根、超时、上下文轮数
4. 点「保存参数」，再点「dsh DeepSeek Harness」切换全局默认后端
5. 发一条 QQ 消息验证；运行日志里会看到 `QQ消息 → dsh [...]`

### 一键安装连接插件

「下游管理」页展开任意 dsh 实例，点 **一键安装插件** 即可。后端会依次完成：

1. 检查插件源码（发行包自带 `apps/dsh-plugin`）
2. 复制插件到 `~/.dsh/profiles/node_modules/@snowluma/dsh-bridge-connector`
3. 把 `@snowluma/dsh-bridge-connector` 追加到该 profile 的 `dsh.profile.bundles`
4. 在 `cordis.patch.yml` 写入带标记的连接配置块（url / token / cwdRoot / downstreamId / consolePort），重复安装只更新这一块
5. 用 `dsh --dump-config` 校验插件确实进了组合结果
6. **重启 dsh 服务**
7. 最多等 20 秒确认插件连上来，返回 `stage=online`

> 全程不动用户的其它插件、不跑 `pnpm install`、不改 `dependencies`，所以可以反复安装与移除。

安装完成后：

- QQ 消息在 dsh 进程内处理（复用模型选择、MCP、工具），不再每条起子进程
- 插件启动时会调 `POST /api/downstreams/register` 自注册，Bridge 侧无需手工新增实例
- 插件离线时自动回落到 headless，服务挂了也不会没人回消息

### 插件协议

插件与 Bridge 用一套统一的下游协议：

| 方向 | 消息 |
|---|---|
| 插件 → Bridge | `hello`（带 `kind`/`downstreamId`/`token`）、`downstream_reply`、`downstream_error`、`ping` |
| Bridge → 插件 | `hello_ack`、`downstream_ask`、`downstream_reset`、`pong` |

### 会话级切换（dsh / 酒馆角色对话）

全局后端只是默认值。想按人区分时，到 **会话** 页，每个 QQ 会话都有一条「回复后端」下拉：

| 选项 | 行为 |
|---|---|
| 继承全局 | 跟随「下游管理」页的默认下游（默认） |
| 酒馆（角色对话） | 该会话交给酒馆，使用下方所选角色 / 世界书 |
| dsh（DeepSeek Harness） | 该会话交给 dsh 直答，不加载角色卡与世界书全文 |

- 两者可以同时在线：例如全局走 dsh，只让常聊的某人继续用酒馆角色
- 会话级选择保存在 `sessions.json` 的 `backend` 字段，缺失即继承
- 卡片的徽标会显示该会话当前生效的后端以及是否继承
- 触发规则（群聊 @、私聊开关、白名单）、处理管道、分段与表情两条链路完全一致
- 「清除配置」会连同会话级后端一起清掉，恢复继承全局

### 行为说明

- **触发规则**：群聊仅 @ 机器人时响应、私聊自动回复开关、用户 / 群白名单，与酒馆完全一致（在「会话 → 触发规则」中配置）
- **回复处理管道**：dsh 的回复同样经过会话级 / 全局 `replyProcessors`，再做分段、动作标记转换、表情包解析
- **上下文隔离**：每个 `sessionKey` 一个独立工作目录；`headless` 本身不记忆会话，由 Bridge 维护最近 N 轮并拼进 prompt
- **上下文落盘**：默认写入 `apps/server/dsh-history.json`（已 gitignore），重启后仍能续聊；可在页面关闭
- **表情包**：后端会把表情词表、图片能力和自定义人设拼进 system 提示词，因此 dsh 也能输出 `[表情:开心]`

### 相关配置

| 键 | 默认值 | 说明 |
|---|---|---|
| `backend` | `taver` | `taver` = 酒馆 / `dsh` = DeepSeek Harness |
| `dshExePath` | 空 | 留空自动从 PATH / npm 全局探测 |
| `dshProfile` | `headless` | dsh profile 名 |
| `dshWorkRoot` | 空 | 会话工作目录根，留空用系统临时目录 |
| `dshTimeoutMs` | `180000` | 单次调用超时 |
| `dshHistoryTurns` | `6` | 保留几轮上下文，`0` = 不带上下文 |
| `dshSystemPrompt` | 空 | 追加的人设 / 规则 |
| `dshErrorReply` | 空 | 调用失败时回给 QQ 的话，留空只写日志 |
| `dshPersistHistory` | `true` | 上下文是否落盘 |
| `dshConcurrency` | `1` | 同时最多几个 dsh 进程，超出排队（1–8） |

> ⚠ dsh 具备本机文件与命令能力，请只在受信任的私聊 / 群聊启用，并给工作目录根设置专用目录。

---

## 项目结构

```
SillyTavern-QQ-Bridge/
├── apps/
│   ├── web/                  # Vue 3 控制台
│   │   └── src/
│   │       ├── views/        # 8 个页面（含 SnowLuma 接入与下游管理）
│   │       ├── components/
│   │       │   ├── layout/   # 侧栏 / 顶栏 / 布局
│   │       │   └── ui/       # 手写组件（Card/Button/Badge/…）+ ToastHost
│   │       ├── stores/       # Pinia：status / theme / toast
│   │       ├── api/          # 后端 API 客户端
│   │       └── style.css     # 设计 token（oklch）
│   ├── server/               # 桥接后端（TypeScript，分层）
│   │   ├── src/
│   │   │   ├── index.ts           # 装配与生命周期
│   │   │   ├── config/            # 配置模型 + 旧版迁移
│   │   │   ├── core/              # 日志 / 会话 / 派发 / 发送
│   │   │   ├── upstream/          # OneBot v11 客户端 + 多账号连接池
│   │   │   ├── downstream/        # 下游适配器（dsh / 酒馆）+ 入站 WS
│   │   │   └── api/routes/        # 状态 / 下游 / 会话 / 配置 / dsh / 本体
│   │   ├── dsh-service.mjs        # dsh headless 调用与上下文
│   │   ├── dsh-profile-service.mjs # profile 插件注入 + 常驻服务
│   │   ├── ARCHITECTURE.md        # 分层说明与数据流
│   │   └── config.example.json    # 配置模板
│   └── dsh-plugin/           # dsh 连接插件（注入到 dsh profile）
│   └── extension/            # 酒馆前端扩展（安装到 third-party）
│       ├── index.js
│       ├── manifest.json
│       └── style.css
├── packages/
│   ├── core/                 # 纯逻辑，无 IO，73 个测试（后端唯一实现）
│   │   ├── segmentation.ts   # 回复分段算法
│   │   ├── pipeline.ts       # 回复处理管道 + 三层策略
│   │   ├── session.ts        # sessionKey ↔ chatName 映射
│   │   ├── media.ts          # 图片标记解析
│   │   └── schemas.ts        # Zod 校验
│   ├── onebot/               # OneBot v11 客户端
│   │   ├── client.ts         # WebSocket 连接 / 重连 / echo 动作
│   │   └── codec.ts          # 消息解析 / CQ 码转义
│   └── shared/               # 跨包类型
└── scripts/
    └── dev.mjs               # 一体化启动器
```

---

## 技术栈

| 层 | 选型 |
|---|---|
| 构建 | pnpm workspace、Vite 7 |
| 前端 | Vue 3.5（`<script setup>`）、TypeScript 5.9 |
| 状态 | Pinia（setup store 风格） |
| 路由 | Vue Router 4（hash 模式） |
| 样式 | Tailwind CSS v4（CSS-first，无 config 文件） |
| 图标 | lucide-vue-next |
| 校验 | Zod |
| 测试 | Vitest |

### 设计系统

配色刻意区别于 SnowLuma 原版，采用**紫罗兰 + 极光青**双色体系：

```css
--primary: oklch(58% 0.19 288);   /* 紫罗兰 */
--aurora:  oklch(72% 0.13 195);   /* 极光青 */
--radius:  0.875rem;              /* 圆角基准，全局推导 */
```

差异化设计元素：

- 分组式侧栏（监控 / 服务 / 消息 / 系统），激活项为渐变小方块图标
- 玻璃拟态顶栏 + 自绘状态胶囊
- 主画布双色径向光晕背景
- 总览页 Hero 渐变卡 + SVG 环形健康度

---

## 架构

```
                     ┌──────────────┐
   QQ 用户 ──OneBot v11─▶│   SnowLuma   │ :3001 / :3002 …（每个号一个端点）
                     └──────┬───────┘
                            │ 每号一条 WebSocket
                            ▼
                  ┌────────────────────────┐
                  │  apps/server 后端       │
                  │  upstream/manager.ts   │  多账号连接池
                  │         │              │
                  │  core/dispatch.ts      │  触发规则 / 选下游+配置 / 组装 prompt
                  │         │              │
                  │  downstream/*.ts       │  dsh / 酒馆（可多实例 × 多配置）
                  │         │              │
                  │  core/sending.ts       │  选账号 / 分段 / 表情 / 管道
                  └──────┬──────────┬──────┘
                         │          │ HTTP /api
            WS 入站 :9500│          ▼
                         │     apps/web 控制台 :5178
                  ┌──────┴───────┐
                  │  下游（连入） │
                  │ dsh 插件      │
                  │ 酒馆扩展      │
                  └──────────────┘
```

**核心约束**：上游按账号隔离（`upstream/manager.ts` 每号一条连接，回复必须用同一个号），下游可扩展（新增一种后端 = 实现一个接口 + 注册一行）。

**数据流**：QQ 消息 → SnowLuma → 触发规则过滤 → 按会话选「下游 + 配置」→ 下游返回最终文本 → 回复处理管道 → 分段 / 表情解析 → SnowLuma → QQ。

**三层配置**：

| 层 | 例子 | 作用 |
|---|---|---|
| 账号 | `main` / `qq_123` | 每个 QQ 号一条连接，会话按号隔离 |
| 下游实例 | `dsh` / `tavern` | 谁来回消息；同类型可配多个 |
| 命名配置 | `鲸鱼娘` / `客服` | 同一实例下的不同人设、对话约束、角色卡 |

会话绑定「实例 + 配置」，未指定时逐层继承全局默认。
命名配置只写与实例设置的**差异**，改共享部分（如 dsh 可执行文件路径）不用逐个配置改。

**下游两种传输**：
- **dsh**：插件在线时在 dsh 进程内跑（复用模型选择 / MCP / 工具），离线回落到 `dsh --profile headless` 子进程
- **酒馆**：扩展主动连回 Bridge，走角色卡与世界书

**会话隔离**：`sessionKey` 为 `private_<userId>` 或 `group_<groupId>_<userId>`，每个会话独立选择下游、角色、世界书。

分层的完整说明见 [apps/server/ARCHITECTURE.md](apps/server/ARCHITECTURE.md)。

---

## 开发说明

### API 端点

前端通过 Vite proxy 访问 `apps/server` 的接口：

| 端点 | 用途 |
|---|---|
| `GET /api/status` | 连接状态、下游状态、会话统计、日志、配置 |
| `GET /api/logs` | 只取日志（轮询更轻） |
| `GET /api/health` | 健康检查 |
| `POST /api/config` | 更新全局配置（分段 / 管道 / 图片表情 / 默认角色） |
| `GET /api/accounts` | 上游账号列表（含每号连接状态） |
| `POST /api/accounts` | 新增或更新一个 QQ 号 |
| `DELETE /api/accounts/:id` | 删除账号（连带其会话配置） |
| `GET /api/downstreams` | 下游实例列表 + 运行态 + 可选类型 |
| `POST /api/downstreams` | 新增或更新下游实例 |
| `DELETE /api/downstreams/:id` | 删除下游实例 |
| `POST /api/downstreams/default` | 设置全局默认下游 / 默认配置 |
| `POST /api/downstreams/:id/test` | 用一句话验证某下游连通性 |
| `POST /api/downstreams/:id/reset` | 清空某下游的会话上下文 |
| `GET /api/downstreams/:id/profiles` | 某实例的命名配置列表 |
| `POST /api/downstreams/:id/profiles` | 新增或更新一份命名配置 |
| `DELETE /api/downstreams/:id/profiles/:pid` | 删除命名配置 |
| `POST /api/downstreams/register` | **插件自注册**（需 token，仅本机） |
| `GET /api/sessions` | 会话列表（含实际生效的下游与配置） |
| `POST /api/sessions/:key` | 更新会话级下游 / 配置 / 角色 / 世界书 |
| `POST /api/trigger` | 更新触发规则与消息长度上限 |
| `GET /api/faces` | 表情库列表（支持标签 / 关键词 / 分页） |
| `GET /api/faces/tags` | 标签统计与总量 |
| `GET /api/faces/progress` | 同步与打标进度 |
| `GET /api/faces/diagnostics` | 表情库自检（目录 / Ollama / 标注率） |
| `POST /api/faces/sync` | 从 QQ 同步收藏表情 |
| `POST /api/faces/label` | 启动后台打标 |
| `POST /api/faces/label/stop` | 停止打标 |
| `POST /api/faces/tags` | 修改某张表情的用户标签 |
| `POST /api/faces/save` | 把表情导出到本地目录 |
| `GET /api/ollama/status` | Ollama 服务状态 + 环境（含模型目录诊断） |
| `GET /api/ollama/models` | 本地已下载模型 |
| `GET /api/ollama/models/:name/show` | 模型详情 |
| `POST /api/ollama/{start,stop,repair}` | 启动 / 停止 / 修复模型目录 |
| `POST /api/ollama/models/:name/{load,unload,delete}` | 加载 / 卸载 / 删除模型 |
| `POST /api/ollama/pull` | 拉取模型（后台任务） |
| `GET /api/ollama/pull/progress` | 拉取进度 |
| `POST /api/ollama/{chat,vision}` | 文本 / 视觉连通性测试 |
| `POST /api/ollama/select` | 选择打标模型与服务参数 |
| `GET /api/dsh/status` | dsh 安装探测与配置 |
| `POST /api/dsh/service/{start,stop,restart}` | dsh 常驻服务管理 |
| `POST /api/dsh/plugin/inject` | 把连接插件注入 dsh profile |
| `GET /api/snowluma/discover` | 探测 SnowLuma 安装目录 |
| `POST /api/snowluma/apply` | 一键对齐 SnowLuma 的 OneBot 配置 |
| `POST /api/sillytavern/install` | 安装酒馆扩展 |
| `POST /api/test-segments` | 预览分段结果 |
| `POST /api/test-pipeline` | 预览管道处理结果 |

如果你没有 v2 后端，前端仍可启动，但各页面会显示「后端连接失败」，此时需要自行实现 `apps/server`。

### 状态同步

状态获取分三层，按「快 → 省 → 稳」排序：

| 层 | 机制 | 作用 |
|---|---|---|
| **SSE 事件** | `GET /api/events` | 主通道。上游断线、插件上下线、配置变更**发生即推送** |
| **HTTP 快照** | `GET /api/status` | 兜底。SSE 在线时 15s 对齐一次，断开时退回 3s 轮询 |
| **localStorage** | 上次成功快照 | 首屏秒开，避免每次刷新闪空白 |

低占用设计：

- 事件只带「变了什么」和最小载荷，不重复传整份快照
- 同类事件在服务端 150ms、客户端 100ms 各合并一次，抖动不会刷屏
- 没有订阅者时服务端跳过全部合并与序列化
- 请求失败**不清空**已有状态，只标记 `reachable=false`，界面保留最后一次已知状态
- 页面不可见时暂停轮询，切回前台立即补一次
- 事件流是「按变化类型」分发的，上游/下游变化精确命中字段，不触发全量拉取

实测：插件连上后 **170ms** 内推送 `downstream` 事件，断开后 **157ms** 推送离线事件（原轮询最坏要等 3 秒）。

实测对比（原方案 vs 现在）：

| 场景 | 之前 | 现在 |
|---|---|---|
| 上游断线 | 最多 3s | 即时 |
| 插件上线/离线 | 最多 3s | ≈170ms |
| 切到非总览页 | 完全不再刷新 | 全局持续同步 |

### 配置持久化

所有写操作都经 `updateConfig` → 内存 + 原子落盘（临时文件 + rename），并广播 `config` 事件。

- SnowLuma 安装目录在「SnowLuma 接入」页探测成功后**写回配置**，下次启动直接复用
- dsh 调用参数存在下游实例的 `settings` 里，不再是顶层扁平字段
- 下游增删改后立即重建适配器，无需重启

---

## 许可证

本项目沿用仓库 [CC BY-NC 4.0](LICENSE)（署名-非商业性使用 4.0）授权。

- 可自由使用、修改、分发
- **禁止商业用途**
- 衍生作品须以同一协议开源并署名

商业授权请联系：<BRXYM@outlook.com>
