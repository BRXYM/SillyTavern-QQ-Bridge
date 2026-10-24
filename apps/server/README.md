# SnowLuma-ST-Bridge v2.0

多会话事件驱动版：以 QQ 号为唯一标识的多用户桥接，含回复处理管道与 Web 控制台。

## 目录

- `snowluma-bridge.mjs` — 连接器（v2.1，含 Web 控制台）
- `SnowLuma-Bridge-extension/` — SillyTavern 前端扩展（安装到 `public/scripts/extensions/third-party/`）
- `config.example.json` — 配置模板（复制为 `config.json` 使用）
- `test-card/雪乃.json` — 测试角色卡（V2 格式，含中文回复指令与内嵌世界书）

## 快速开始

```bash
# 1. 连接器
npm install ws
copy config.example.json config.json   # 填入你的 OneBot token
node snowluma-bridge.mjs

# 2. Web 控制台
# http://127.0.0.1:9510
#   - 上游：OneBot 地址 / token / 白名单 / @限定
#   - 下游：扩展端口 / 消息模板
#   - 回复处理管道：replace / remove / strip 规则 + 实时测试

# 3. 酒馆扩展
# 将 SnowLuma-Bridge-extension 复制到 SillyTavern 的
# public/scripts/extensions/third-party/SnowLuma-Bridge
# 重启酒馆，扩展面板中确认"已连接" ws://127.0.0.1:9500
```

## 多会话模型

- 私聊：`private_<QQ号>`；群聊：`group_<群号>_<发送者QQ>`
- 连接器维护 `sessionRoutes` 精确路由，回复原路返回
- 扩展端每会话 FIFO 队列 + 单生成锁，消息排队处理不串线
- 兜底：无 sessionKey 的旧版回复路由到最近活跃会话

## 回复处理管道

`config.json → replyProcessors`，按顺序执行：

```jsonc
{ "type": "replace", "pattern": "正则", "flags": "g", "replacement": "文本" }  // 替换
{ "type": "remove",  "pattern": "正则", "flags": "g" }                         // 删除
{ "type": "strip",   "begin": "*", "end": "*", "keep": true }                  // 区域删除
```

## 与 v1 的差异

| | v1 | v2 |
|---|---|---|
| 路由 | 全局 pendingTarget 单例（串话） | sessionKey 精确路由 |
| 多用户 | 不支持 | 队列化并发支持 |
| 回复处理 | 无 | 正则管道 + 控制台实时测试 |
| 控制台 | 无 | Web :9510 热配置 |
