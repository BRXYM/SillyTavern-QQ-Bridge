/**
 * 全局配置接口：账号、分段、管道、图片表情、默认角色。
 *
 * 所有写操作都通过 app.updateConfig 完成（内存 + 落盘），
 * 需要立即生效的部分在这里显式触发。
 *
 * 账号是这里最特殊的一块：改地址 / token 要重连，改 id 要迁移会话，
 * 所以它不在别处顺手改，而是集中在这个文件里处理。
 */

import type { Router } from '../router.ts';
import { json } from '../router.ts';
import type { AppContext } from '../context.ts';
import type { BridgeConfig } from '../../config/schema.ts';
import { DEFAULT_UPSTREAM_PORT } from '../../config/schema.ts';
import { log } from '../../core/logger.ts';

export function registerConfigRoutes(router: Router, app: AppContext): void {
    router.get('/api/config', ({ res }) => {
        json(res, 200, { ok: true, config: app.config() });
    });

    router.post('/api/config', async ({ res, body }) => {
        const patch = body as Record<string, unknown>;
        let inboundChanged = false;

        app.updateConfig((c) => {
            // 端口
            if (patch.extPort !== undefined) {
                const n = Number(patch.extPort);
                if (Number.isFinite(n) && n > 0 && n !== c.extPort) {
                    c.extPort = n;
                    inboundChanged = true;
                }
            }

            // 默认下游 + 默认配置
            if (patch.defaultDownstreamId !== undefined) {
                const id = String(patch.defaultDownstreamId);
                if (c.downstreams.some((d) => d.id === id)) {
                    c.defaultDownstreamId = id;
                    // 默认下游换了，旧默认配置大概率不属于新实例，先清空
                    const target = c.downstreams.find((d) => d.id === id);
                    if (!target?.profiles.some((p) => p.id === c.defaultDownstreamProfileId)) {
                        c.defaultDownstreamProfileId = '';
                    }
                }
            }
            if (patch.defaultDownstreamProfileId !== undefined) {
                const pid = String(patch.defaultDownstreamProfileId);
                if (pid === '') c.defaultDownstreamProfileId = '';
                else {
                    const target = c.downstreams.find((d) => d.id === c.defaultDownstreamId);
                    if (target?.profiles.some((p) => p.id === pid)) c.defaultDownstreamProfileId = pid;
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

        // 账号改动（地址/token/启停）需要重连对应上游
        if (Array.isArray(patch.accounts)) {
            app.upstreams.apply(toUpstreamAccounts(app.config()));
        }

        // 入站端口改了要重启 WS 服务
        if (inboundChanged) {
            await app.restartInbound();
        }

        json(res, 200, { ok: true, config: app.config() });
    });

    // ================= 账号 =================
    // 与「SnowLuma 接入」页联动：这里只管连接参数与启停，
    // 目录探测、OneBot 端点写入仍在 host.ts。

    // GET /api/accounts   列表（含运行时状态）
    router.get('/api/accounts', ({ res }) => {
        const cfg = app.config();
        const live = new Map(app.upstreams.list().map((v) => [v.id, v]));
        json(res, 200, {
            ok: true,
            accounts: cfg.accounts.map((acc) => {
                const view = live.get(acc.id);
                return {
                    ...acc,
                    running: Boolean(view),
                    connected: view?.stats.connected === true,
                    selfId: view?.stats.selfId ?? '',
                    nickname: view?.stats.nickname ?? '',
                    lastError: view?.stats.lastError ?? '',
                };
            }),
        });
    });

    // POST /api/accounts   新增或更新一个账号
    router.post('/api/accounts', async ({ res, body }) => {
        const parsed = parseAccountBody(body);
        if ('error' in parsed) {
            json(res, 400, { ok: false, error: parsed.error });
            return;
        }
        const next = parsed.value;
        const cfg = app.config();
        const index = cfg.accounts.findIndex((a) => a.id === next.id);

        // id 唯一性：新增时必须不冲突
        if (index < 0 && cfg.accounts.some((a) => a.id === next.id)) {
            json(res, 400, { ok: false, error: `账号 id ${next.id} 已存在` });
            return;
        }

        app.updateConfig((c) => {
            if (index >= 0) {
                // 保留 id，其余覆盖
                c.accounts[index] = { ...c.accounts[index]!, ...next, id: c.accounts[index]!.id };
            } else {
                c.accounts.push(next);
            }
        });

        app.upstreams.apply(toUpstreamAccounts(app.config()));
        log(`账号已${index >= 0 ? '更新' : '新增'}：${next.id}（${next.name}）`);
        json(res, 200, { ok: true, account: next });
    });

    // DELETE /api/accounts/:id   删除账号（连带该账号的会话配置）
    router.delete('/api/accounts/:id', async ({ res, params }) => {
        const id = params.id ?? '';
        const cfg = app.config();
        if (!cfg.accounts.some((a) => a.id === id)) {
            json(res, 404, { ok: false, error: `账号 ${id} 不存在` });
            return;
        }
        if (cfg.accounts.length <= 1) {
            json(res, 400, { ok: false, error: '至少要保留一个账号' });
            return;
        }

        // 该账号名下的会话一起清掉，否则会留下永远匹配不上的孤儿记录
        const prefix = `${id}:`;
        const sessionKeys = Object.keys(app.sessions.snapshot()).filter((k) => k.startsWith(prefix));
        for (const key of sessionKeys) app.sessions.remove(key);

        app.updateConfig((c) => {
            c.accounts = c.accounts.filter((a) => a.id !== id);
        });
        app.upstreams.apply(toUpstreamAccounts(app.config()));

        log(`账号已删除：${id}（连带 ${sessionKeys.length} 个会话配置）`);
        json(res, 200, { ok: true, removedSessions: sessionKeys.length });
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
}

/** 配置里的账号 → 上游管理器需要的形状 */
export function toUpstreamAccounts(cfg: BridgeConfig) {
    return cfg.accounts.map((a) => ({
        id: a.id,
        uin: a.uin,
        name: a.name,
        enabled: a.enabled,
        upstream: a.upstream,
    }));
}

/** 校验并规范化账号请求体 */
function parseAccountBody(
    body: Record<string, unknown>,
): { value: BridgeConfig['accounts'][number] } | { error: string } {
    const id = String(body.id ?? '').trim();
    if (!id) return { error: '缺少账号 id' };
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
        return { error: 'id 只能包含字母、数字、下划线和短横线（1-32 位）' };
    }

    const uin = String(body.uin ?? '').trim();
    if (uin && !/^[0-9]{5,12}$/.test(uin)) {
        return { error: 'QQ 号应为 5-12 位数字（可留空，连上后自动识别）' };
    }

    const up = (body.upstream ?? {}) as Record<string, unknown>;
    const url = String(up.url ?? '').trim();
    if (!url) return { error: '缺少 OneBot 地址' };
    if (!/^wss?:\/\//i.test(url)) {
        return { error: 'OneBot 地址必须以 ws:// 或 wss:// 开头' };
    }

    const port = Number(new URL(url).port || DEFAULT_UPSTREAM_PORT);
    void port;

    return {
        value: {
            id,
            uin,
            name: String(body.name ?? '').trim() || (uin || id),
            enabled: body.enabled === undefined ? true : body.enabled !== false,
            upstream: {
                url,
                token: String(up.token ?? ''),
                reconnectMs: Math.max(500, Number(up.reconnectMs) || 5000),
                actionTimeoutMs: Math.max(1000, Number(up.actionTimeoutMs) || 15000),
            },
        },
    };
}
