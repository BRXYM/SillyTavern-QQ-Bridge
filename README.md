# SnowLuma Bridge

**多 QQ、多下游的自由控制台。**

统一管理多个 QQ 账号，连接 dsh、SillyTavern 或自建 HTTP 服务，为不同会话选择下游与对话配置。面向喜欢折腾 AI 和聊天机器人的个人玩家，支持本地部署。

```text
多个 QQ 账号 → OneBot v11 → 会话路由 → 下游连接 + 对话配置
                              ↑               ↓
                         Web 控制台     回复处理 → 原账号回复
```

## 核心概念

| 对象 | 负责什么 | 示例 |
|---|---|---|
| QQ 账号 | 消息从哪里进入、用哪个账号回复 | 主号、测试号 |
| 下游连接 | 地址、协议、认证和服务状态 | 本机 dsh、酒馆、自建 HTTP 接口 |
| 对话配置 | 如何处理会话数据 | 提示词、请求模板、角色与回复行为 |
| 会话路由 | 为会话选择下游与配置 | 私聊走 dsh，群内某个成员走酒馆 |

同类型下游可以创建多个实例，每个实例可保存多份对话配置。配置目前属于具体下游，通过「下游 ID + 配置 ID」引用。

会话未指定下游时继承全局默认；默认对话配置只对默认下游生效。其他下游未选配置时使用实例设置。当前尚未提供账号级默认路由。群聊会话按「账号 + 群 + 成员」隔离，同一群内不同成员可以独立绑定。

## 已有能力与边界

- **多 QQ**：多条 OneBot v11 连接，按账号隔离会话，从收到消息的原账号回复。支持 SnowLuma，也可手动接入其他兼容 OneBot v11 的协议端。
- **多下游**：dsh 插件 / headless、SillyTavern、同步 HTTP GET/POST。HTTP 支持 JSON / 纯文本响应、请求模板、响应字段提取及环境变量凭据引用。
- **对话配置**：独立页面创建、编辑、删除、测试配置，供多个会话复用。不同下游支持的配置项不同。
- **会话路由**：按账号、下游和关键词筛选，查看实际使用的下游、配置和继承关系，再调整绑定。
- **回复处理**：统一触发与准入规则、文本处理、回复分段、发送节奏、图片表情。
- **运行状态**：账号与下游状态、日志、SSE 状态推送及错误提示。
- **dsh 适配助手**：根据目标和接口资料生成 HTTP 接入草稿，可编辑、主动测试并保存。生成配置需要可用的 dsh；已配置的 HTTP 下游直接调用目标服务。

自动适配目前不支持 WebSocket、SSE 流式响应、stdio、异步轮询和任意脚本。dsh 保留自身运行环境的权限，配置生成提示词不构成执行沙箱。上下文由具体下游维护，HTTP 会话标识需要目标服务支持。

## 快速开始

需要 Node.js >= 22、pnpm >= 11、一个 QQ OneBot v11 协议端和一个可用下游。

```bash
git clone https://github.com/BRXYM/SillyTavern-QQ-Bridge.git
cd SillyTavern-QQ-Bridge
git checkout next
pnpm install
```

`next` 是完整前后端工程；`main` 保留历史版本。首次运行（PowerShell）：

```powershell
Copy-Item apps/server/config.example.json apps/server/config.json
pnpm dev
```

打开 <http://localhost:5178>：

1. 在 **QQ 账号** 中探测 SnowLuma，或填写 OneBot 地址和 token。多账号使用不同的 OneBot 监听端口；修改 SnowLuma 配置后按提示重启。
2. 在 **下游连接** 中启用服务。默认使用 dsh；也可启用酒馆，或通过 dsh 适配助手添加 HTTP 服务。
3. 在 **对话配置** 中创建配置，主动发送测试消息。
4. 从 QQ 发消息，在 **会话与路由** 中找到会话，选择下游和对话配置。未绑定时继承全局默认。
5. 到 **总览 / 运行日志** 检查链路和回复。

### dsh

需要时安装 `npm install -g @deepseek-ai/dsh`。在下游连接中展开 dsh 实例，探测安装位置、设置 profile，并使用「一键安装插件」。源码位于 `apps/dsh-plugin`。详细操作见 [后端说明](apps/server/README.md)。

### SillyTavern

把 `apps/extension/` 复制到酒馆的 `public/scripts/extensions/third-party/SnowLuma-Bridge/`，重启酒馆，确认扩展连接 Bridge 的 WebSocket 端口（默认 9500），再启用酒馆下游。

### 自建 HTTP 服务

在下游连接打开「用 dsh 适配新下游」，提供目标、接口地址及请求 / 响应示例。检查草稿，主动测试后保存，再到对话配置页调整模板并绑定会话。凭据使用请求头中的 `{{env.变量名}}` 引用，运行后端前设置对应环境变量，不要将真实密钥粘贴进接口资料。

## 开发与部署

```bash
pnpm dev          # 前后端
pnpm dev:web      # 仅前端
pnpm dev:api      # 仅后端
pnpm build        # 构建前端
pnpm start        # 仅后端，不托管网页
pnpm test         # 自动化测试
pnpm typecheck    # 前后端类型检查
```

| 环境变量 | 默认值 | 用途 |
|---|---|---|
| WEB_PORT | 5178 | 开发控制台 |
| API_PORT | 9510 | HTTP API |
| EXT_PORT | 9500 | 下游插件 WebSocket |
| ONEBOT_URL / ONEBOT_TOKEN | 配置文件 | 覆盖第一个 QQ 账号连接 |
| ST_DATA_DIR | 自动探测 | 酒馆数据目录 |
| BRIDGE_OPEN | 关闭 | 设为 1，启动后打开浏览器 |

生产网页位于 `apps/web/dist`，需单独托管并将 `/api`（包括 SSE）代理到后端，保留下游插件 WebSocket 连接。控制台面向本机使用，尚未提供完整公网登录和权限管理。

```text
apps/web/         Vue 3 + TypeScript 控制台
apps/server/      Node.js 后端：账号、路由、下游、集成、API
apps/dsh-plugin/  dsh 连接插件
apps/extension/   SillyTavern 扩展
packages/         共享消息处理与协议实现
```

配置、会话和历史保存在 `apps/server` 本地运行文件中，表情与适配任务等保存在 `data/`；已排除出 Git，请自行备份。配置采用原子写入，旧配置会按版本迁移。详见 [后端架构](apps/server/ARCHITECTURE.md)。

## 后续方向

优先完善账号连接、配置测试、会话路由和错误诊断。账号级默认路由、更多协议、可编程流程和跨下游配置迁移作为后续扩展，尚未实现。

## 许可证

采用 [CC BY-NC 4.0](LICENSE)，使用、修改和分享时应遵守署名及非商业性使用等条款。商业授权联系：BRXYM@outlook.com。
