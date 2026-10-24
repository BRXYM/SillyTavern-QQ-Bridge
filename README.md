# SnowLuma Bridge V3

把 **QQ（SnowLuma / OneBot v11）** 与 **SillyTavern** 连接起来的桥接中枢，带 Web 控制台。

前后端分离的 monorepo：Vue 3 + TypeScript + Vite 7 + Tailwind CSS v4。

> 当前状态：**后端已整合**。Web 控制台 7 个页面可用，桥接后端与酒馆扩展已并入同一仓库，`pnpm dev` 即可完整运行。核心逻辑（分段 / 管道 / 会话 / 图片）抽为独立包并覆盖 56 个单元测试。

> **分支说明**：本分支（`next`）是下一代主线，仓库根目录即完整前后端工程。v1 / v2 的历史版本仍可在 `main` 分支查看。

---

## 功能

### 已验证可用

- **Web 控制台** — 7 个页面：总览、运行日志、服务管理、会话、回复分段、图片表情、系统设置
- **多会话隔离** — 每个 QQ 号 / 群聊独立绑定角色与世界书，留空则继承全局默认
- **回复分段** — 四层分隔符（硬标点 / 软标点 / 配对符 / 自定义字符串），按字数与条数智能打包，条间随机延迟
- **配对符保护** — `*动作*`、`"台词"` 等成对内容保持完整，内部标点不切分
- **回复处理管道** — `replace` / `remove` / `strip` 三类规则，支持三层策略：全局默认 → 会话覆盖
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

### 安装

```bash
git clone -b next https://github.com/BRXYM/snowluma-st-bridge.git
cd snowluma-st-bridge
pnpm install
```

### 首次配置

```bash
cp apps/server/config.example.json apps/server/config.json
```

编辑 `config.json` 填入你的 OneBot token：

```jsonc
{
    "onebotUrl": "ws://127.0.0.1:3001",
    "onebotToken": "你的 SnowLuma Access Token",
    "stDataDir": ""   // 留空则自动探测，或填写 <SillyTavern>/data/default-user
}
```

### 启动

```bash
pnpm dev
```

一条命令同时拉起后端与前端：

```
SnowLuma Bridge V3
[dev] 模式：前后端一体
[dev] 启动后端 .../apps/server/snowluma-bridge.mjs
[api] 酒馆扩展 WS 服务已启动: ws://127.0.0.1:9500
[api] Web 控制台已启动: http://127.0.0.1:9510
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
pnpm test             # 运行单元测试（56 个）
pnpm typecheck        # 类型检查
pnpm test:console     # 用 jsdom 检查控制台运行时错误
```

### 环境变量

`scripts/dev.mjs`、`vite.config.ts` 与后端读取同一组变量，保证端口一致。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `WEB_PORT` | `5178` | 前端端口 |
| `API_PORT` | `9510` | 后端控制台 / API 端口 |
| `EXT_PORT` | `9500` | 酒馆扩展 WebSocket 端口 |
| `ONEBOT_URL` | — | 覆盖 `config.json` 的 OneBot 地址 |
| `ONEBOT_TOKEN` | — | 覆盖 `config.json` 的 OneBot token |
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

## 项目结构

```
snowluma-st-bridge/
├── apps/
│   ├── web/                  # Vue 3 控制台
│   │   └── src/
│   │       ├── views/        # 7 个页面
│   │       ├── components/
│   │       │   ├── layout/   # 侧栏 / 顶栏 / 布局
│   │       │   └── ui/       # 手写组件（Card/Button/Badge/…）+ ToastHost
│   │       ├── stores/       # Pinia：status / theme / toast
│   │       ├── api/          # 后端 API 客户端
│   │       └── style.css     # 设计 token（oklch）
│   ├── server/               # 桥接后端
│   │   ├── snowluma-bridge.mjs    # OneBot 连接 + 扩展 WS + Web API
│   │   ├── st-headless.mjs        # 酒馆无头驱动（playwright-core）
│   │   ├── config.example.json    # 配置模板
│   │   └── test-console-runtime.mjs
│   └── extension/            # 酒馆前端扩展（安装到 third-party）
│       ├── index.js
│       ├── manifest.json
│       └── style.css
├── packages/
│   ├── core/                 # 纯逻辑，无 IO，56 个测试
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
QQ 用户
   │  OneBot v11
   ▼
SnowLuma (:3001)
   │  WebSocket
   ▼
apps/server 桥接后端 (:9500 扩展 WS / :9510 控制台 API)
   │                    ▲
   │  WebSocket         │  HTTP /api
   ▼                    │
apps/extension        apps/web 控制台 (:5178)
（装在酒馆内）           │
                        └── Vite proxy → :9510
```

**数据流**：QQ 消息 → SnowLuma → 桥接后端按 `sessionKey` 广播 → 酒馆扩展触发回复 → 扩展回传 `sessionKey` → 后端分段 + 处理管道 → SnowLuma → QQ。

**会话隔离**：`sessionKey` 格式为 `private_<userId>` 或 `group_<groupId>_<userId>`，据此映射到酒馆的独立 chat 文件。

---

## 开发说明

### API 端点

前端通过 Vite proxy 访问 `apps/server` 的接口：

| 端点 | 用途 |
|---|---|
| `GET /api/status` | 连接状态、会话统计、清单、日志、配置 |
| `POST /api/config` | 更新全局配置 |
| `POST /api/session-choice` | 更新会话级角色 / 世界书 / 管道 |
| `POST /api/catalog/refresh` | 刷新角色与世界书清单 |
| `POST /api/test-segments` | 预览分段结果 |
| `POST /api/test-pipeline` | 预览管道处理结果 |

如果你没有 v2 后端，前端仍可启动，但各页面会显示「后端连接失败」，此时需要自行实现 `apps/server`。

### 轮询策略

`stores/status.ts` 统一管理轮询：请求去重、失败指数退避（3s → 6s → 12s → 24s，上限 30s）、成功后立即恢复、多页面引用计数。后端掉线 1 分钟只产生约 4 次请求。

---

## 许可证

本项目沿用仓库 [CC BY-NC 4.0](LICENSE)（署名-非商业性使用 4.0）授权。

- 可自由使用、修改、分发
- **禁止商业用途**
- 衍生作品须以同一协议开源并署名

商业授权请联系：<BRXYM@outlook.com>
