/**
 * 下游管理接口。
 *
 * 满足「可配置模式 / 未来自由增加」与「dsh 可自行注册接入」两条需求：
 *
 *   GET    /api/downstreams                       列表 + 状态 + 已知类型
 *   POST   /api/downstreams                       新增或整体替换一个实例
 *   DELETE /api/downstreams/:id                   删除实例
 *   POST   /api/downstreams/:id/test              用一句话验证连通性
 *   POST   /api/downstreams/:id/reset             清空某会话（或全部）上下文
 *   POST   /api/downstreams/default               设置全局默认下游
 *   POST   /api/downstreams/register              **自注册通道**（需 token）
 *
 * 命名配置（每个实例下多份）：
 *   GET    /api/downstreams/:id/profiles          列出某实例的配置
 *   POST   /api/downstreams/:id/profiles          新增或更新一份配置
 *   DELETE /api/downstreams/:id/profiles/:pid     删除一份配置
 *
 * 配置里的 `settings` 只写与实例设置的差异，未出现的键沿用实例设置。
 */

import type { Router } from '../router.ts';
import { json } from '../router.ts';
import type { AppContext } from '../context.ts';
import { KNOWN_KINDS } from '../../downstream/registry.ts';
import type { DownstreamConfig, DownstreamKind, DownstreamProfile } from '../../downstream/types.ts';
import { mergeSettings } from '../../config/schema.ts';
import {
    normalizeHistoryExtracts,
    normalizeProgress,
    normalizePrompt,
} from '../../config/behavior.ts';
import { parseHttpConnection, validateRequestBody } from '../../downstream/http-json.ts';
import { log } from '../../core/logger.ts';

const VALID_KINDS = new Set<string>(KNOWN_KINDS.map((k) => k.kind));

export function registerDownstreamRoutes(router: Router, app: AppContext): void {
    // ---------------- 列表 ----------------
    router.get('/api/downstreams', ({ res }) => {
        const cfg = app.config();
        json(res, 200, {
            ok: true,
            defaultDownstreamId: cfg.defaultDownstreamId,
            defaultDownstreamProfileId: cfg.defaultDownstreamProfileId,
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
        const existing = cfg.downstreams.find((d) => d.id === parsed.value.id);

        app.updateConfig((c) => {
            const index = c.downstreams.findIndex((d) => d.id === parsed.value.id);
            if (index >= 0) {
                // 保留已有配置：前端整体提交实例时不该顺手清掉它的命名配置
                const keep = c.downstreams[index]!;
                c.downstreams[index] = {
                    ...parsed.value,
                    profiles: Array.isArray(body.profiles)
                        ? parsed.value.profiles
                        : keep.profiles,
                };
            } else {
                c.downstreams.push(parsed.value);
            }
        });

        const reload = parsed.value.kind === 'http-json' && app.downstreams.reloadOne
            ? await app.downstreams.reloadOne(parsed.value.id)
            : await app.downstreams.reload();
        log(`下游已${existing ? '更新' : '新增'}：${parsed.value.id}（${parsed.value.kind}）`);

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
        if (app.config().flows.some(f => f.downstreamId === id || f.operators?.some(op => op.actions.some(a => a.type === 'call' && a.downstreamId === id)))) return json(res, 409, { error: '连接仍被流程引用，请先修改对应流程' });
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

        // 该实例名下的会话绑定一起清掉，否则会指向一个不存在的下游
        const affected = Object.entries(app.sessions.snapshot())
            .filter(([, v]) => v.backendId === id)
            .map(([k]) => k);
        for (const key of affected) {
            app.sessions.clearField(key, 'backendId');
            app.sessions.clearField(key, 'profileId');
        }

        app.updateConfig((c) => {
            c.downstreams = c.downstreams.filter((d) => d.id !== id);
            // 默认下游被删时回落到第一个
            if (c.defaultDownstreamId === id) {
                c.defaultDownstreamId = c.downstreams[0]?.id ?? '';
                c.defaultDownstreamProfileId = '';
            }
        });

        const reload = await app.downstreams.reload();
        log(`下游已删除：${id}（${affected.length} 个会话回落默认）`);
        json(res, 200, { ok: reload.ok, error: reload.error, affectedSessions: affected.length });
    });

    // ---------------- 设默认 ----------------
    router.post('/api/downstreams/default', ({ res, body }) => {
        const id = String(body.id ?? '').trim();
        const profileId = body.profileId === undefined ? undefined : String(body.profileId ?? '');
        const cfg = app.config();
        if (!cfg.downstreams.some((d) => d.id === id)) {
            json(res, 404, { ok: false, error: `下游 ${id} 不存在` });
            return;
        }

        // 指定了配置就顺带校验它属于这个实例
        if (profileId) {
            const target = cfg.downstreams.find((d) => d.id === id);
            if (!target?.profiles.some((p) => p.id === profileId)) {
                json(res, 400, { ok: false, error: `下游 ${id} 下没有配置 ${profileId}` });
                return;
            }
        }

        app.updateConfig((c) => {
            c.defaultDownstreamId = id;
            c.defaultFlowId = '';
            if (profileId !== undefined) c.defaultDownstreamProfileId = profileId;
            // 换了实例且没指定新配置时，旧默认配置不再适用
            else {
                const target = c.downstreams.find((d) => d.id === id);
                if (!target?.profiles.some((p) => p.id === c.defaultDownstreamProfileId)) {
                    c.defaultDownstreamProfileId = '';
                }
            }
        });

        log(`默认下游已设为：${id}${profileId ? ` / ${profileId}` : ''}`);
        json(res, 200, {
            ok: true,
            defaultDownstreamId: id,
            defaultDownstreamProfileId: app.config().defaultDownstreamProfileId,
        });
    });

    // ---------------- 命名配置 ----------------
    // GET /api/downstreams/:id/profiles
    router.get('/api/downstreams/:id/profiles', ({ res, params }) => {
        const id = params.id ?? '';
        const downstream = app.config().downstreams.find((d) => d.id === id);
        if (!downstream) {
            json(res, 404, { ok: false, error: `下游 ${id} 不存在` });
            return;
        }
        json(res, 200, {
            ok: true,
            downstreamId: id,
            kind: downstream.kind,
            profiles: downstream.profiles,
            /** 实例自身设置，作为表单的基线 */
            settings: downstream.settings,
            /**
             * 每份配置**实际生效**的行为设置（实例 + 配置合并后）。
             *
             * 前端要按值渲染表单，而不是自己再算一遍合并 ——
             * 两处各算一套迟早会不一致，行为设置尤其容易漏掉嵌套的 prompt。
             */
            behaviors: Object.fromEntries(
                downstream.profiles.map((p) => {
                    const merged = mergeSettings(downstream.settings, p.settings);
                    return [p.id, {
                        prompt: normalizePrompt(merged.prompt),
                        historyExtracts: normalizeHistoryExtracts(merged.historyExtracts),
                        progress: normalizeProgress(merged.progress),
                    }];
                }),
            ),
            /** 不选配置时（用实例设置）的行为 */
            defaultBehavior: {
                prompt: normalizePrompt(downstream.settings.prompt),
                historyExtracts: normalizeHistoryExtracts(downstream.settings.historyExtracts),
                progress: normalizeProgress(downstream.settings.progress),
            },
        });
    });

    // POST /api/downstreams/:id/profiles   新增或更新一份配置
    router.post('/api/downstreams/:id/profiles', ({ res, params, body }) => {
        const id = params.id ?? '';
        const cfg = app.config();
        if (!cfg.downstreams.some((d) => d.id === id)) {
            json(res, 404, { ok: false, error: `下游 ${id} 不存在` });
            return;
        }

        const parsed = parseProfileBody(body);
        if ('error' in parsed) {
            json(res, 400, { ok: false, error: parsed.error });
            return;
        }

        if (cfg.downstreams.find((d) => d.id === id)?.kind === 'http-json') {
            try {
                const settings = parsed.value.settings;
                if (Object.keys(settings).some((key) => !['systemPrompt', 'requestBody'].includes(key))) throw new Error('HTTP 对话配置仅覆盖 systemPrompt / requestBody，连接参数请在实例中修改');
                if (settings.systemPrompt !== undefined && typeof settings.systemPrompt !== 'string') throw new Error('systemPrompt 必须是文本');
                validateRequestBody(settings.requestBody);
            } catch (e) { json(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) }); return; }
        }

        let created = false;
        app.updateConfig((c) => {
            const target = c.downstreams.find((d) => d.id === id);
            if (!target) return;
            const index = target.profiles.findIndex((p) => p.id === parsed.value.id);
            if (index >= 0) target.profiles[index] = parsed.value;
            else {
                target.profiles.push(parsed.value);
                created = true;
            }
        });

        log(`下游 ${id} 的配置已${created ? '新增' : '更新'}：${parsed.value.id}（${parsed.value.name}）`);
        json(res, 200, { ok: true, profile: parsed.value, created });
    });

    // DELETE /api/downstreams/:id/profiles/:pid
    router.delete('/api/downstreams/:id/profiles/:pid', ({ res, params }) => {
        const id = params.id ?? '';
        const pid = params.pid ?? '';
        if (app.config().flows.some(f => f.downstreamId === id && f.legacyProfileId === pid)) return json(res, 409, { error: '旧配置仍被兼容流程引用，请先修改对应流程' });
        const cfg = app.config();
        const target = cfg.downstreams.find((d) => d.id === id);
        if (!target) {
            json(res, 404, { ok: false, error: `下游 ${id} 不存在` });
            return;
        }
        if (!target.profiles.some((p) => p.id === pid)) {
            json(res, 404, { ok: false, error: `下游 ${id} 下没有配置 ${pid}` });
            return;
        }

        // 用到这份配置的会话回落「继承」，否则它们会指向不存在的配置
        const affected = Object.entries(app.sessions.snapshot())
            .filter(([key, v]) => v.profileId === pid && app.sessions.resolve(key).backendId === id)
            .map(([k]) => k);

        app.updateConfig((c) => {
            const d = c.downstreams.find((x) => x.id === id);
            if (d) d.profiles = d.profiles.filter((p) => p.id !== pid);
            // 被删的正好是全局默认配置时清空，避免指向不存在的项
            if (c.defaultDownstreamProfileId === pid && c.defaultDownstreamId === id) {
                c.defaultDownstreamProfileId = '';
            }
        });
        for (const key of affected) app.sessions.clearField(key, 'profileId');

        log(`下游 ${id} 的配置已删除：${pid}（${affected.length} 个会话回落继承）`);
        json(res, 200, { ok: true, affectedSessions: affected.length });
    });

    // ---------------- 连通性测试 ----------------
    router.post('/api/downstreams/:id/test', async ({ res, params, body }) => {
        const id = params.id ?? '';
        const profileId = String(body.profileId ?? '');
        const resolved = app.downstreams.resolve(id, profileId);
        if (!resolved) {
            json(res, 404, { ok: false, error: `下游 ${id} 不存在` });
            return;
        }
        const adapter = resolved.adapter;
        if (!adapter) {
            json(res, 404, { ok: false, error: `下游 ${id} 未启用或启动失败` });
            return;
        }

        const text = String(body.text ?? '只回复两个字：正常').trim();
        const sessionKey = `_test_${String(body.sessionKey ?? 'default').trim() || 'default'}`;

        const result = await adapter.ask({
            sessionKey,
            text,
            system: adapter.composeSystemPrompt?.(sessionKey, resolved.settings)
                ?? String(resolved.settings.systemPrompt ?? normalizePrompt(resolved.settings.prompt).extra ?? ''),
            sender: 'test',
            // 用选定配置测试，而不是实例设置 —— 否则测不出配置里的问题
            settings: resolved.settings,
            profileId: resolved.profile?.id,
        });

        json(res, result.ok ? 200 : 400, {
            ...result,
            sessionKey,
            downstreamId: id,
            profileId: resolved.profile?.id ?? '',
        });
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

    if (kind === 'http-json') {
        try {
            const s = settings as Record<string, unknown>;
            parseHttpConnection(Object.fromEntries(['url', 'method', 'headers', 'timeoutMs', 'response'].map((k) => [k, s?.[k]])));
            validateRequestBody(s?.requestBody);
        } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
    }

    // 只有显式传了 profiles 才覆盖（见调用处的保留逻辑）
    const profiles = Array.isArray(body.profiles)
        ? parseProfiles(body.profiles)
        : [];

    return {
        value: {
            id,
            kind: kind as DownstreamKind,
            name: String(body.name ?? id).trim() || id,
            enabled: body.enabled === undefined ? true : body.enabled !== false,
            settings: (settings as Record<string, unknown>) ?? {},
            profiles,
        },
    };
}

/** 批量规范化配置数组（整体提交实例时用） */
function parseProfiles(raw: unknown[]): DownstreamProfile[] {
    const out: DownstreamProfile[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const parsed = parseProfileBody(item as Record<string, unknown>);
        if ('error' in parsed) continue;
        if (seen.has(parsed.value.id)) continue;
        seen.add(parsed.value.id);
        out.push(parsed.value);
    }
    return out;
}

/** 校验并规范化一份命名配置 */
function parseProfileBody(
    body: Record<string, unknown>,
): { value: DownstreamProfile } | { error: string } {
    const id = String(body.id ?? '').trim();
    if (!id) return { error: '缺少配置 id' };
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
        return { error: '配置 id 只能包含字母、数字、下划线和短横线（1-32 位）' };
    }

    const settings = body.settings;
    if (settings !== undefined && (typeof settings !== 'object' || settings === null || Array.isArray(settings))) {
        return { error: 'settings 必须是对象' };
    }

    return {
        value: {
            id,
            name: String(body.name ?? id).trim() || id,
            settings: (settings as Record<string, unknown>) ?? {},
        },
    };
}
