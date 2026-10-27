/**
 * 下游管理接口。
 *
 * 满足「可配置模式 / 未来自由增加」与「dsh 可自行注册接入」两条需求：
 *
 *   GET    /api/downstreams                 列表 + 状态 + 已知类型
 *   POST   /api/downstreams                 新增或整体替换一个实例
 *   DELETE /api/downstreams/:id             删除实例
 *   POST   /api/downstreams/:id/test        用一句话验证连通性
 *   POST   /api/downstreams/:id/reset       清空某会话（或全部）上下文
 *   POST   /api/downstreams/default         设置全局默认下游
 *   POST   /api/downstreams/register        **自注册通道**（需 token）
 */

import type { Router } from '../router.ts';
import { json } from '../router.ts';
import type { AppContext } from '../context.ts';
import { KNOWN_KINDS } from '../../downstream/registry.ts';
import type { DownstreamConfig, DownstreamKind } from '../../downstream/types.ts';
import { log } from '../../core/logger.ts';

const VALID_KINDS = new Set<string>(KNOWN_KINDS.map((k) => k.kind));

export function registerDownstreamRoutes(router: Router, app: AppContext): void {
    // ---------------- 列表 ----------------
    router.get('/api/downstreams', ({ res }) => {
        const cfg = app.config();
        json(res, 200, {
            ok: true,
            defaultDownstreamId: cfg.defaultDownstreamId,
            registered: cfg.downstreams,
            status: app.downstreams.list().map((a) => a.status()),
            kinds: KNOWN_KINDS,
        });
    });

    // ---------------- 新增 / 更新 ----------------
    router.post('/api/downstreams', async ({ res, body }) => {
        const parsed = parseDownstreamBody(body);
        if ('error' in parsed) {
            json(res, 400, { ok: false, error: parsed.error });
            return;
        }

        const cfg = app.config();
        const existingIndex = cfg.downstreams.findIndex((d) => d.id === parsed.value.id);

        app.updateConfig((c) => {
            if (existingIndex >= 0) {
                c.downstreams[existingIndex] = parsed.value;
            } else {
                c.downstreams.push(parsed.value);
            }
        });

        const reload = await app.downstreams.reload();
        log(`下游已${existingIndex >= 0 ? '更新' : '新增'}：${parsed.value.id}（${parsed.value.kind}）`);

        json(res, 200, {
            ok: reload.ok,
            error: reload.error,
            downstream: parsed.value,
            status: app.downstreams.list().map((a) => a.status()),
        });
    });

    // ---------------- 删除 ----------------
    router.delete('/api/downstreams/:id', async ({ res, params }) => {
        const id = params.id ?? '';
        if (!id) {
            json(res, 400, { ok: false, error: '缺少下游 id' });
            return;
        }
        const cfg = app.config();
        if (!cfg.downstreams.some((d) => d.id === id)) {
            json(res, 404, { ok: false, error: `下游 ${id} 不存在` });
            return;
        }
        if (cfg.downstreams.length <= 1) {
            json(res, 400, { ok: false, error: '至少要保留一个下游实例' });
            return;
        }

        app.updateConfig((c) => {
            c.downstreams = c.downstreams.filter((d) => d.id !== id);
            // 默认下游被删时回落到第一个
            if (c.defaultDownstreamId === id) {
                c.defaultDownstreamId = c.downstreams[0]?.id ?? '';
            }
        });

        const reload = await app.downstreams.reload();
        log(`下游已删除：${id}`);
        json(res, 200, { ok: reload.ok, error: reload.error });
    });

    // ---------------- 设默认 ----------------
    router.post('/api/downstreams/default', ({ res, body }) => {
        const id = String(body.id ?? '').trim();
        const cfg = app.config();
        if (!cfg.downstreams.some((d) => d.id === id)) {
            json(res, 404, { ok: false, error: `下游 ${id} 不存在` });
            return;
        }
        app.updateConfig((c) => {
            c.defaultDownstreamId = id;
        });
        log(`默认下游已设为：${id}`);
        json(res, 200, { ok: true, defaultDownstreamId: id });
    });

    // ---------------- 连通性测试 ----------------
    router.post('/api/downstreams/:id/test', async ({ res, params, body }) => {
        const id = params.id ?? '';
        const adapter = app.downstreams.get(id);
        if (!adapter) {
            json(res, 404, { ok: false, error: `下游 ${id} 不存在或未启用` });
            return;
        }

        const text = String(body.text ?? '只回复两个字：正常').trim();
        const sessionKey = `_test_${String(body.sessionKey ?? 'default').trim() || 'default'}`;

        const result = await adapter.ask({
            sessionKey,
            text,
            system: '',
            sender: 'test',
        });

        json(res, result.ok ? 200 : 400, { ...result, sessionKey, downstreamId: id });
    });

    // ---------------- 清空上下文 ----------------
    router.post('/api/downstreams/:id/reset', async ({ res, params, body }) => {
        const id = params.id ?? '';
        const adapter = app.downstreams.get(id);
        if (!adapter) {
            json(res, 404, { ok: false, error: `下游 ${id} 不存在或未启用` });
            return;
        }

        const sessionKey = String(body.sessionKey ?? '').trim();
        const removeWorkDir = body.removeWorkDir === true;

        if (!sessionKey) {
            if (body.all !== true) {
                json(res, 400, { ok: false, error: '缺少 sessionKey（或传 all: true 清空全部）' });
                return;
            }
            const keys = Object.keys(app.sessions.snapshot());
            let cleared = 0;
            for (const key of keys) {
                if (await adapter.resetSession?.(key, { removeWorkDir })) cleared += 1;
            }
            log(`下游 ${id}：已请求清空 ${cleared} 个会话上下文`);
            json(res, 200, { ok: true, cleared });
            return;
        }

        if (!adapter.resetSession) {
            json(res, 400, { ok: false, error: `下游 ${id} 不支持清空上下文` });
            return;
        }
        const existed = await adapter.resetSession(sessionKey, { removeWorkDir });
        log(`下游 ${id}：已清空会话上下文 [${sessionKey}]`);
        json(res, 200, { ok: true, sessionKey, existed });
    });

    // ---------------- 自注册（dsh 用） ----------------
    router.post('/api/downstreams/register', async ({ res, body, req }) => {
        const cfg = app.config();
        const expected = cfg.registrationToken;

        if (!expected) {
            json(res, 403, {
                ok: false,
                error: '未配置 registrationToken，自注册通道已关闭（请先在配置里设置）',
            });
            return;
        }

        // 只接受本机回环，避免局域网任意主机改配置
        const remote = req.socket.remoteAddress ?? '';
        const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
        if (!isLoopback) {
            json(res, 403, { ok: false, error: '自注册通道只接受本机连接' });
            return;
        }

        const token = String(body.token ?? '');
        if (token !== expected) {
            json(res, 401, { ok: false, error: 'token 不匹配' });
            return;
        }

        const parsed = parseDownstreamBody({
            id: body.id ?? 'dsh',
            kind: body.kind ?? 'dsh-plugin',
            name: body.name ?? 'dsh（自注册）',
            settings: body.settings ?? {},
        });
        if ('error' in parsed) {
            json(res, 400, { ok: false, error: parsed.error });
            return;
        }

        const result = await app.downstreams.register({
            id: parsed.value.id,
            kind: parsed.value.kind,
            name: parsed.value.name,
            settings: parsed.value.settings,
        });
        if (!result.ok) {
            json(res, 400, { ok: false, error: result.error });
            return;
        }

        log(`下游自注册成功：${result.id}（来自 ${remote}）`);
        json(res, 200, { ok: true, id: result.id });
    });
}

/** 校验并规范化请求体 */
function parseDownstreamBody(
    body: Record<string, unknown>,
): { value: DownstreamConfig } | { error: string } {
    const id = String(body.id ?? '').trim();
    const kind = String(body.kind ?? '').trim();

    if (!id) return { error: '缺少 id' };
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
        return { error: 'id 只能包含字母、数字、下划线和短横线（1-32 位）' };
    }
    if (!kind) return { error: '缺少 kind' };
    if (!VALID_KINDS.has(kind)) {
        return { error: `未知的下游类型 ${kind}，可选：${[...VALID_KINDS].join(', ')}` };
    }

    const settings = body.settings;
    if (settings !== undefined && (typeof settings !== 'object' || settings === null)) {
        return { error: 'settings 必须是对象' };
    }

    return {
        value: {
            id,
            kind: kind as DownstreamKind,
            name: String(body.name ?? id).trim() || id,
            enabled: body.enabled === undefined ? true : body.enabled !== false,
            settings: (settings as Record<string, unknown>) ?? {},
        },
    };
}

