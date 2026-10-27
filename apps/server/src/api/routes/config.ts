/**
 * 全局配置接口：上游连接、分段、管道、图片表情、默认角色。
 *
 * 所有写操作都通过 app.updateConfig 完成（内存 + 落盘），
 * 需要立即生效的部分在这里显式触发。
 */

import type { Router } from '../router.ts';
import { json } from '../router.ts';
import type { AppContext } from '../context.ts';
import type { BridgeConfig } from '../../config/schema.ts';
import { log } from '../../core/logger.ts';

export function registerConfigRoutes(router: Router, app: AppContext): void {
    router.get('/api/config', ({ res }) => {
        json(res, 200, { ok: true, config: app.config() });
    });

    router.post('/api/config', async ({ res, body }) => {
        const patch = body as Record<string, unknown>;
        let upstreamChanged = false;
        let inboundChanged = false;

        app.updateConfig((c) => {
            // 上游连接
            if (patch.upstream && typeof patch.upstream === 'object') {
                const up = patch.upstream as Record<string, unknown>;
                if (up.url !== undefined) {
                    c.upstream.url = String(up.url);
                    upstreamChanged = true;
                }
                if (up.token !== undefined) {
                    c.upstream.token = String(up.token);
                    upstreamChanged = true;
                }
                if (up.reconnectMs !== undefined) {
                    c.upstream.reconnectMs = Math.max(500, Number(up.reconnectMs) || c.upstream.reconnectMs);
                }
                if (up.actionTimeoutMs !== undefined) {
                    c.upstream.actionTimeoutMs = Math.max(1000, Number(up.actionTimeoutMs) || c.upstream.actionTimeoutMs);
                }
            }

            // 上游软件本体
            if (patch.snowluma && typeof patch.snowluma === 'object') {
                const sl = patch.snowluma as Record<string, unknown>;
                if (sl.dir !== undefined) c.snowluma.dir = String(sl.dir);
                if (sl.webuiPort !== undefined) {
                    const n = Number(sl.webuiPort);
                    if (Number.isFinite(n) && n > 0) c.snowluma.webuiPort = n;
                }
            }

            // 端口
            if (patch.extPort !== undefined) {
                const n = Number(patch.extPort);
                if (Number.isFinite(n) && n > 0 && n !== c.extPort) {
                    c.extPort = n;
                    inboundChanged = true;
                }
            }

            // 默认下游
            if (patch.defaultDownstreamId !== undefined) {
                const id = String(patch.defaultDownstreamId);
                if (c.downstreams.some((d) => d.id === id)) c.defaultDownstreamId = id;
            }

            // 分段
            if (patch.segmentation && typeof patch.segmentation === 'object') {
                Object.assign(c.segmentation, patch.segmentation);
            }

            // 图片表情
            if (patch.imageReplies && typeof patch.imageReplies === 'object') {
                Object.assign(c.imageReplies, patch.imageReplies);
            }

            // 回复处理管道
            if (Array.isArray(patch.replyProcessors)) {
                c.replyProcessors = patch.replyProcessors as BridgeConfig['replyProcessors'];
            }

            // 默认角色 / 世界书
            if (patch.defaults && typeof patch.defaults === 'object') {
                const d = patch.defaults as Record<string, unknown>;
                if (d.character !== undefined) c.defaults.character = String(d.character);
                if (d.world !== undefined) c.defaults.world = String(d.world);
            }

            // 消息长度上限
            if (patch.maxMessageLength !== undefined) {
                const n = Number(patch.maxMessageLength);
                if (Number.isFinite(n) && n > 0) c.maxMessageLength = n;
            }

            // 酒馆数据目录
            if (patch.stDataDir !== undefined) c.stDataDir = String(patch.stDataDir);

            // 表情库 / Ollama
            if (patch.faces && typeof patch.faces === 'object') {
                Object.assign(c.faces, patch.faces);
            }

            // 自注册 token
            if (patch.registrationToken !== undefined) {
                c.registrationToken = String(patch.registrationToken);
            }
        });

        // 上游参数改了需要重连
        if (upstreamChanged) {
            const cfg = app.config();
            app.onebot.reconfigure({
                url: cfg.upstream.url,
                token: cfg.upstream.token,
                reconnectMs: cfg.upstream.reconnectMs,
                actionTimeoutMs: cfg.upstream.actionTimeoutMs,
            });
            app.onebot.dispose();
            app.onebot.connect();
            log(`上游连接已更新：${cfg.upstream.url}`);
        }

        // 入站端口改了要重启 WS 服务
        if (inboundChanged) {
            await app.restartInbound();
        }

        json(res, 200, { ok: true, config: app.config() });
    });

    // ---------------- 分段预览 ----------------
    router.post('/api/test-segments', ({ res, body }) => {
        const text = String(body.text ?? '');
        const override = (body.config ?? {}) as Record<string, unknown>;
        const cfg = { ...app.config().segmentation, ...override };

        // 动态 import 避免顶层循环依赖
        import('@bridge/core').then(({ segmentText }) => {
            const segments = segmentText(text, cfg as never, app.config().maxMessageLength);
            json(res, 200, { ok: true, segments });
        }).catch((e) => {
            json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
        });
    });

    // ---------------- 管道预览 ----------------
    router.post('/api/test-pipeline', async ({ res, body }) => {
        const text = String(body.text ?? '');
        const rules = Array.isArray(body.rules)
            ? body.rules
            : app.config().replyProcessors;

        const { applyReplyProcessors } = await import('@bridge/core');
        json(res, 200, {
            ok: true,
            input: text,
            output: applyReplyProcessors(text, rules as never),
        });
    });
}
