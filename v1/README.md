# SnowLuma-ST-Bridge v1 归档

归档时间：2026-10-23
架构：事件驱动 v1（单会话）

## 内容

- `snowluma-bridge.mjs` — v1 连接器：OneBot WS 客户端 + 酒馆扩展 WS 服务端(:9500)
  - QQ消息 → 广播给酒馆扩展
  - 酒馆回复(`st_reply`) → 发回 QQ
  - 来源缺失时用 `lastTarget` 兜底
- `SnowLuma-Bridge-extension-v1/` — v1 酒馆前端扩展
  - `/send 消息 | /trigger` 触发生成
  - 监听 `MESSAGE_RECEIVED` / `GENERATION_ENDED` 推回回复
  - `pendingTarget` 全局单例（v1 的多用户限制根源）
- `config.json` — v1 配置
- `test-card/雪乃.json` — 测试角色卡（含中文回复指令）
- `workbuddy-bridge-token.txt` — workbuddy-connect 桥接密钥

## v1 已知限制（2.0 待解决）

1. `pendingTarget` 全局单例 → 多用户并发串话
2. 所有 QQ 会话挤进同一个酒馆聊天 → 上下文污染
3. 必须保持酒馆网页前台打开（扩展跑在浏览器）
4. 无回复后处理（正则替换/删除等）

## v1 环境信息（备忘）

- SnowLuma：`node D:\WorkSpace\SnowLuma\dist\index.mjs`（工作目录必须在 dist）
  - WebUI :5099（dist/config/runtime.json 无 webuiPort 时回落默认）
  - OneBot WS :3001（token 见 dist/config/onebot_<uin>.json）
  - OneBot HTTP :3000
- SillyTavern：`node server.js`（:8000，Basic 认证 user/password）
- workbuddy-connect 模型：http://127.0.0.1:10108/cn/v1（Bearer 密钥见 txt）
- 测试 QQ：机器人 1417434860，测试用户 2637143104（本人想养喵）
