# SnowLuma-ST-Bridge

将 QQ（通过 SnowLuma / OneBot v11）与 SillyTavern 桥接的连接器。
纯事件驱动架构：无等待、无轮询、无请求-响应配对。

> **许可**：本项目以 [CC BY-NC 4.0](LICENSE)（署名-非商业性使用）授权。
> 可以自由使用、修改和分发，但**禁止商业用途**，衍生作品须以同一协议开源并署名。
> 商业授权请联系：BRXYM@outlook.com

```
QQ消息 → SnowLuma(:3001) → 连接器(:9500/9510) → 酒馆扩展 → 酒馆生成
酒馆回复 → 扩展 → 连接器 → [回复处理管道] → SnowLuma → QQ
```

## 版本历史

| 版本 | 目录 | 说明 |
|---|---|---|
| v1.0 | [`v1/`](v1/) | 单会话原型：全局 pendingTarget 路由，有串话风险 |
| v2.0 | [`v2/`](v2/) | 多会话版：sessionKey 精确路由 + 每会话队列 + 回复处理管道 + Web 控制台 |
| v3.0 | [`v3/`](v3/) | 前后端分离重构：Vue 3 + TypeScript monorepo，核心逻辑抽包 + 56 个单元测试 |

## v3 特性

- **前后端分离**：Vue 3 + Vite 7 + Tailwind CSS v4 控制台，7 个页面
- **单命令启动**：`pnpm dev` 同时拉起前后端，自动端口检测与进程树清理
- **核心逻辑抽包**：`packages/core`（分段 / 管道 / 会话 / 图片）、`packages/onebot`（WS 客户端）
- **单元测试**：56 个测试覆盖分段算法、回复管道、会话映射、消息编解码
- **差异化视觉**：紫罗兰 + 极光青双色体系、分组侧栏、玻璃顶栏、环形健康度

详见 [`v3/README.md`](v3/README.md)。

## v2 特性

- **多用户**：以 QQ 号为唯一标识（`private_<QQ号>` / `group_<群号>_<发送者>`），独立路由与队列
- **纯事件驱动**：连接器只做带 key 的广播与路由，生成由酒馆自己完成
- **回复处理管道**：正则替换 / 删除 / 区域删除（strip），支持实时测试
- **Web 控制台** `:9510`：上游(SnowLuma)/下游(酒馆)配置热更新、会话监控、运行日志

## 运行

```bash
cd v2
npm install ws
node snowluma-bridge.mjs
# 控制台 http://127.0.0.1:9510
```

依赖服务：SnowLuma（OneBot WS :3001）、SillyTavern（:8000，安装 SnowLuma-Bridge 扩展）
