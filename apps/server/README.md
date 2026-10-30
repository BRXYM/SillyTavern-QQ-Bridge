# SnowLuma Bridge 后端

Node.js + TypeScript 后端：管理多个 OneBot / QQ 账号，将消息派发到 dsh、SillyTavern 等下游，共用触发规则、处理管道、分段和表情回复。

## 运行

在仓库根目录安装依赖并启动：

```bash
pnpm install
pnpm dev:api
# 或生产方式
pnpm start
```

首次配置可复制 `apps/server/config.example.json` 为同目录下的 `config.json`。已有配置、会话和历史文件无需搬迁；旧格式会自动迁移。

默认 HTTP API 为 `http://127.0.0.1:9510/api/status`，下游入站 WebSocket 为 `ws://127.0.0.1:9500`。前端控制台由仓库根目录的 `pnpm dev` 一并启动，默认端口 5178。

支持 `API_PORT`、`EXT_PORT`、`ONEBOT_URL`、`ONEBOT_TOKEN`、`ST_DATA_DIR`、`BRIDGE_REGISTRATION_TOKEN`、`BRIDGE_FACES_DIR` 环境变量；OneBot 覆盖作用于首个账号。

## 维护

- `src/index.ts`：进程入口。
- `src/app/application.ts`：应用装配。
- `src/core/`：桥接业务流程。
- `src/upstream/` / `src/downstream/`：账号连接与下游适配器。
- `src/services/`：应用服务。
- `src/integrations/`：第三方 HTTP / CLI / 文件和进程操作。
- `src/api/`：HTTP/SSE 传输和业务路由。
- `src/config/`：模型、迁移、运行时配置。

完整职责、生命周期和新增下游的步骤见 [ARCHITECTURE.md](ARCHITECTURE.md)。

```bash
pnpm --filter @bridge/server typecheck
pnpm --filter @bridge/server test
```

独立酒馆后台运行器仍可从后端包运行 `pnpm headless`，其配置为 `headless.json`。

## 用 dsh 适配其它服务

重启后端后，在下游管理页展开「用 dsh 适配新下游」。先启用并连接 dsh，填写新实例 ID、接入目标和接口请求/响应示例。dsh 生成草稿后可编辑 JSON、测试真实调用、保存新下游，再在会话页选择它。连接详情可编辑 HTTP 连接设置，命名配置可编辑系统提示和请求正文模板。

首版支持同步 HTTP GET/POST、JSON 或纯文本响应。接口资料不足会列出待补问题，特殊协议暂不自动实现。认证通过请求头中的环境变量引用（例如 `Bearer {{env.MY_API_KEY}}`）提供；后端启动环境需设置相应变量。

任务保存在 `data/adaptations/`。完整协议和 API 见架构文档中的「dsh 下游适配助手」。
