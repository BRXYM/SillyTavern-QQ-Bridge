import { randomUUID } from 'node:crypto';
import type { Router } from '../router.ts';
import { json } from '../router.ts';
import type { AppContext } from '../context.ts';
import { availableFlows, resolveFlow, parseFlow, validateFlow, mirrorFlowDefault } from '../../config/flows.ts';
import { executeFlow } from '../../core/flow-runtime.ts';
import { emptyState, parseState } from '../../core/conversation-engine.ts';
import { publishStatus } from '../events.ts';
import { buildSystemPrompt } from '../../core/dispatch.ts';

export function registerFlowRoutes(router: Router, app: AppContext) {
    router.get('/api/flows', ({ res }) => {
        const cfg = app.config();
        const keys = [...new Set([...Object.keys(app.sessions.snapshot()), ...Object.keys(app.sessions.statsSnapshot())])];
        const bindings = Object.fromEntries(keys.map(key => { const value = resolveFlow(cfg, app.sessions, key); return [key, { id: value.id, inherited: value.inherited, missing: !value.flow }]; }));
        json(res, 200, { flows: availableFlows(cfg, app.sessions).map(flow => ({ ...flow, compatibility: !cfg.flows.some(f => f.id === flow.id), references: Object.values(bindings).filter(b => b.id === flow.id).length })),
            defaultId: cfg.defaultFlowId || resolveFlow(cfg, app.sessions, '__unbound_flow_defaults__').id, bindings });
    });
    router.post('/api/flows', ({ res, body }) => {
        try {
            const value = parseFlow(body); validateFlow(value, app.config());
            const previous = availableFlows(app.config(), app.sessions).find(f => f.id === value.id);
            if (value.id.startsWith('compat_') && !previous) throw new Error('compat_ 为兼容流程保留前缀');
            if (previous?.downstreamId === value.downstreamId && previous.legacyProfileId) value.legacyProfileId = previous.legacyProfileId;
            app.updateConfig(cfg => {
                const index = cfg.flows.findIndex(f => f.id === value.id);
                if (index >= 0) cfg.flows[index] = value; else cfg.flows.push(value);
                if (cfg.defaultFlowId === value.id) mirrorFlowDefault(cfg, value);
            });
            publishStatus('config'); json(res, 200, { ok: true, flow: value });
        } catch (e) { json(res, 400, { error: e instanceof Error ? e.message : String(e) }); }
    });
    router.post('/api/flows/:id/default', ({ res, params }) => {
        const flow = availableFlows(app.config(), app.sessions).find(f => f.id === params.id);
        if (!flow) return json(res, 404, { error: '流程不存在' });
        if (!flow.enabled) return json(res, 400, { error: '已停用的流程不能设为默认' });
        app.updateConfig(cfg => { if (!cfg.flows.some(f => f.id === flow.id)) cfg.flows.push(flow); mirrorFlowDefault(cfg, flow); });
        publishStatus('config'); json(res, 200, { ok: true });
    });
    router.delete('/api/flows/:id', ({ res, params }) => {
        const cfg = app.config();
        if (!cfg.flows.some(f => f.id === params.id)) return json(res, 409, { error: '兼容流程由旧绑定生成，请先改为选择正式流程' });
        if (resolveFlow(cfg, app.sessions, '__unbound_flow_defaults__').id === params.id || Object.keys(app.sessions.snapshot()).some(key => resolveFlow(cfg, app.sessions, key).id === params.id)) return json(res, 409, { error: '流程仍被默认设置或会话引用，请先更换绑定' });
        app.updateConfig(c => { c.flows = c.flows.filter(f => f.id !== params.id); });
        publishStatus('config'); json(res, 200, { ok: true });
    });
    router.get('/api/flow-runs', ({ res, query }) => json(res, 200, { runs: app.flowRuns.list(query.get('flowId') || undefined).filter(r => !query.get('sessionKey') || r.sessionKey === query.get('sessionKey')) }));
    router.post('/api/flows/preview', async ({ res, body }) => {
        try {
            const raw = body.flow;
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('流程定义无效');
            const flow = parseFlow(raw as Record<string, unknown>);
            // 仅原样预览已有定义时恢复服务端兼容信息，不接受客户端指定旧行为。
            const known = availableFlows(app.config(), app.sessions).find(f => f.id === flow.id);
            if (known && Object.entries(flow).every(([key, value]) => known[key as keyof typeof known] === value)) {
                flow.legacyPreserveBehavior = known.legacyPreserveBehavior;
                flow.legacyProfileId = known.legacyProfileId;
            }
            const target = flow.legacyPreserveBehavior ? app.downstreams.resolve(flow.downstreamId, flow.legacyProfileId ?? '') : undefined;
            const text = String(body.text ?? ''); const reply = String(body.reply ?? '');
            if (text.length > 64000 || reply.length > 64000) throw new Error('预览文本过长');
            const result = await executeFlow({ flow, config: app.config(), store: app.flowRuns, sessionKey: '_flow_preview', mode: 'preview', text,
                state: body.state === undefined ? emptyState() : parseState(body.state),
                legacySystem: target?.adapter ? buildSystemPrompt(app.config(), '_flow_preview', { sessions: app.sessions }, target.adapter, target.settings) : '', legacyRules: app.config().replyProcessors,
                ask: async () => ({ ok: true, text: reply, elapsedMs: 0 }) });
            json(res, 200, result);
        } catch (e) { json(res, 400, { error: e instanceof Error ? e.message : String(e) }); }
    });
    router.post('/api/flows/:id/test', async ({ res, params, body }) => {
        const cfg = app.config();
        const flow = availableFlows(cfg, app.sessions).find(f => f.id === params.id);
        if (!flow) return json(res, 404, { error: '流程不存在' });
        const text = String(body.text ?? '').trim();
        if (!text || text.length > 64000) return json(res, 400, { error: '请输入不超过 64000 字的测试消息' });
        const target = app.downstreams.resolve(flow.downstreamId, flow.legacyProfileId ?? '');
        const key = `_flow_test_${randomUUID()}`;
        try {
            const result = await executeFlow({ flow, config: cfg, store: app.flowRuns, sessionKey: key, mode: 'test', text,
                legacySystem: target?.adapter ? buildSystemPrompt(cfg, key, { sessions: app.sessions }, target.adapter, target.settings) : '', legacyRules: cfg.replyProcessors,
                ask: async (input, system) => {
                    if (!target?.adapter) throw new Error('下游未启用或启动失败');
                    return target.adapter.ask({ sessionKey: key, text: input, system, sender: '流程测试', settings: { ...target.settings, systemPrompt: system }, profileId: target.profile?.id });
                } });
            json(res, 200, result);
        } finally { await target?.adapter?.resetSession?.(key).catch(() => {}); }
    });
}
