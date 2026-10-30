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
| 会话配置 | 如何处理对话内容 | 前置提示词、输入前后缀、输入与回复处理规则 |
| 会话路由 | 为会话选择下游与配置 | 私聊走 dsh，群内某个成员走酒馆 |

同类型下游可以创建多个实例。下游只管理连接、认证和协议字段映射；会话配置独立保存，可供多个下游复用。会话管理将「下游连接 + 会话配置」组合起来。

下游和会话配置各自继承全局默认，也可逐会话覆盖，或明确不使用会话配置。当前尚未提供账号级默认路由。群聊按「账号 + 群 + 成员」隔离，同一群内不同成员可以独立绑定。

## 已有能力与边界

- **多 QQ**：多条 OneBot v11 连接，按账号隔离会话，从收到消息的原账号回复。支持 SnowLuma，也可手动接入其他兼容 OneBot v11 的协议端。
- **多下游**：dsh 插件 / headless、SillyTavern、同步 HTTP GET/POST。HTTP 支持 JSON / 纯文本响应、请求模板、响应字段提取及环境变量凭据引用。
- **会话配置**：只编辑前置提示词、输入前后缀、发送前处理与回复后处理。提供纯文本预览，不调用下游；支持替换、删除、去除标记内容。
- **会话管理**：只维护默认下游、默认会话配置，以及每个会话的绑定；支持按账号、下游和关键词筛选。
- **回复处理**：统一触发与准入规则、文本处理、回复分段、发送节奏、图片表情。
- **运行状态**：账号与下游状态、日志、SSE 状态推送及错误提示。
- **上游连接**：读取 SnowLuma 已有的 OneBot 端点后主动连接，也可手动填写地址和 token。明确区分账号记录、注入状态与 OneBot 连接状态。

HTTP 目前支持同步 GET/POST 与 JSON / 文本响应，不支持 SSE、异步轮询和任意脚本。上下文由具体下游维护，HTTP 会话标识和前置提示词需要通过协议模板映射到目标接口支持的字段。下游页保留折叠的 AI 辅助连接入口，使用 dsh 生成连接参数与协议映射；保存时不创建会话配置。

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

1. 在 **上游连接** 中检测 SnowLuma，选择已读取的 QQ，点击「连接此 QQ」。QQ 须先在 SnowLuma 中手动注入，并启用 OneBot WebSocket 服务。控制台只读取已有端点，不修改 SnowLuma 文件；也可手动添加 OneBot 连接。
2. 在 **下游连接** 中添加或启用服务，填写地址、认证与协议映射。默认使用 dsh，也可连接酒馆或 HTTP 服务。
3. 在 **会话配置** 中创建前置提示词、输入内容和消息处理规则，使用示例文本预览效果。
4. 在 **会话管理** 中设置全局默认下游和默认会话配置；QQ 收到消息后，可逐会话覆盖绑定。
5. 到 **总览 / 运行日志** 检查链路。消息触发开关位于 **系统设置**。

注入诊断优先读取 SnowLuma 的进程接口；Windows 可补充检查 QQ 主进程与 SnowLuma 注入管道。无法读取、需要 WebUI 登录或无法对应账号时，显示“未知”，不会把连接失败直接当作“未注入”。控制台不执行自动注入，也不修改自动注入开关。

### dsh

需要时安装 `npm install -g @deepseek-ai/dsh`。在下游连接中展开 dsh 实例，探测安装位置、设置 profile，并使用「一键安装插件」。源码位于 `apps/dsh-plugin`。详细操作见 [后端说明](apps/server/README.md)。

### SillyTavern

把 `apps/extension/` 复制到酒馆的 `public/scripts/extensions/third-party/SnowLuma-Bridge/`，重启酒馆，确认扩展连接 Bridge 的 WebSocket 端口（默认 9500），再启用酒馆下游。

### 自建 HTTP 服务

在下游连接中新增 HTTP 类型，配置 URL、method、headers、timeoutMs、response 和 requestBody。requestBody 属于接口协议映射，例如：

```json
{
  "message": "{{input.text}}",
  "system": "{{input.system}}",
  "session_id": "{{input.sessionKey}}"
}
```

前置提示词与文本处理在会话配置中定义；认证使用请求头中的 `{{env.变量名}}` 引用。不要将真实密钥提交到仓库。

### 旧配置兼容

旧版下游的命名配置会以稳定 ID 导入独立会话配置，只提取对话字段。旧连接、协议模板和会话绑定保留，未编辑的旧会话继续采用原行为；保存新会话配置后使用新的处理链。运行文件保留旧字段用于兼容，无需手工修改 sessions.json。酒馆使用新前置提示词时需更新仓库内的连接扩展。

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

优先完善账号连接、配置测试、会话路由和错误诊断。账号级默认路由、更多协议与可编程流程作为后续扩展，尚未实现。

## 许可证

采用 [CC BY-NC 4.0](LICENSE)，使用、修改和分享时应遵守署名及非商业性使用等条款。商业授权联系：BRXYM@outlook.com。
