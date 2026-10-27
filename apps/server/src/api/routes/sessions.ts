/**
 * 会话管理接口：触发规则、会话级下游与角色绑定。
 *
 * 前端「会话」页面对应这里。规则与会话配置都落 sessions/config，
 * 前端只提交变更，不做本地状态推断。
 */

import type { Router } from '../router.ts';
import { json } from '../router.ts';
import type { AppContext } from '../context.ts';
import type { SessionChoice } from '../../core/sessions.ts';
import { log } from '../../core/logger.ts';

export function registerSessionRoutes(router: Router, app: AppContext): void {
    // ---------------- 列表 ----------------
    router.get('/api/sessions', ({ res }) => {
        const choices = app.sessions.snapshot();
        const stats = app.sessions.statsSnapshot();
        const keys = [...new Set([...Object.keys(choices), ...Object.keys(stats)])].sort();

        json(res, 200, {
            ok: true,
            sessions: keys.map((key) => {
                const resolved = app.sessions.resolve(key);
                return {
                    sessionKey: key,
                    choice: choices[key] ?? null,
                    stat: stats[key] ?? { in: 0, out: 0, last: 0 },
                    resolved,
                };
            }),
        });
    });

    // ---------------- 更新单个会话 ----------------
    router.post('/api/sessions/:key', async ({ res, params, body }) => {
        const key = params.key ?? '';
        if (!key) {
            json(res, 400, { ok: false, error: '缺少 sessionKey' });
            return;
        }

        // 校验 backendId 必须存在（除非传空串表示继承）
        if (body.backendId !== undefined) {
            const id = String(body.backendId);
            if (id !== '' && !app.config().downstreams.some((d) => d.id === id)) {
                json(res, 400, { ok: false, error: `下游 ${id} 不存在` });
                return;
            }
        }

        if (body.reset === true) {
            app.sessions.remove(key);
            log(`会话配置已清除：${key}`);
            await resetAllDownstreams(app, key);
            json(res, 200, { ok: true, sessionKey: key, reset: true });
            return;
        }

        const patch: Partial<SessionChoice> = {};
        if (body.character !== undefined) patch.character = String(body.character);
        if (body.world !== undefined) patch.world = String(body.world);
        if (body.replyProcessors !== undefined) {
            patch.replyProcessors = body.replyProcessors as unknown[];
        }
        // backendId 传空串 = 清除会话级设置，回到继承
        if (body.backendId !== undefined) {
            if (String(body.backendId) === '') app.sessions.clearField(key, 'backendId');
            else patch.backendId = String(body.backendId);
        }

        if (Object.keys(patch).length > 0) app.sessions.patch(key, patch);

        const resolved = app.sessions.resolve(key);
        if (body.backendId !== undefined) {
            log(`会话下游已更新 [${key}]：${resolved.backendId}${resolved.inherited ? '（继承）' : '（会话级）'}`);
        }
        json(res, 200, { ok: true, sessionKey: key, resolved });
    });

    // ---------------- 触发规则 ----------------
    router.get('/api/trigger', ({ res }) => {
        json(res, 200, { ok: true, trigger: app.config().trigger, maxMessageLength: app.config().maxMessageLength });
    });

    router.post('/api/trigger', ({ res, body }) => {
        app.updateConfig((c) => {
            const t = body.trigger as Record<string, unknown> | undefined;
            if (t) {
                if (t.atOnly !== undefined) c.trigger.atOnly = t.atOnly === true;
                if (t.privateReply !== undefined) c.trigger.privateReply = t.privateReply !== false;
                if (Array.isArray(t.allowedUsers)) {
                    c.trigger.allowedUsers = t.allowedUsers.map(Number).filter(Number.isFinite);
                }
                if (Array.isArray(t.allowedGroups)) {
                    c.trigger.allowedGroups = t.allowedGroups.map(Number).filter(Number.isFinite);
                }
            }
            if (body.maxMessageLength !== undefined) {
                const n = Number(body.maxMessageLength);
                if (Number.isFinite(n) && n > 0) c.maxMessageLength = n;
            }
        });
        log('触发规则已更新');
        json(res, 200, { ok: true, trigger: app.config().trigger });
    });
}

/** 会话重置时，通知所有下游释放该会话的上下文 */
async function resetAllDownstreams(app: AppContext, sessionKey: string): Promise<void> {
    for (const adapter of app.downstreams.list()) {
        try {
            await adapter.resetSession?.(sessionKey);
        } catch (e) {
            log(`下游 ${adapter.id} 释放会话失败：${e instanceof Error ? e.message : String(e)}`);
        }
    }
}
