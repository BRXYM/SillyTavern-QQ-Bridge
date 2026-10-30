import { randomUUID } from 'node:crypto';
import type { Router } from '../router.ts';
import { json } from '../router.ts';
import type { AppContext } from '../context.ts';
import { availableFlows, resolveFlow, parseFlow, validateFlow, mirrorFlowDefault } from '../../config/flows.ts';
import { executeFlow } from '../../core/flow-runtime.ts';
import { emptyState, parseState } from '../../core/conversation-engine.ts';
import { publishStatus } from '../events.ts';
import { buildSystemPrompt } from '../../core/dispatch.ts';
import { operatorFlow } from '../../config/operators.ts';
import { record } from '../../config/conversation-flow.ts';

export function registerFlowRoutes(router: Router, app: AppContext) {
    router.post('/api/flows/validate', ({ res, body }) => {
        try { json(res, 200, { flow: parseFlow(body) }); }
        catch (e) { json(res, 400, { error: e instanceof Error ? e.message : String(e) }); }
    });
    router.get('/api/flows', ({ res }) => {
        const cfg = app.config();
        const keys = [...new Set([...Object.keys(app.sessions.snapshot()), ...Object.keys(app.sessions.statsSnapshot())])];
        const bindings = Object.fromEntries(keys.map(key => { const value = resolveFlow(cfg, app.sessions, key); return [key, { id: value.id, inherited: value.inherited, downstreamId: value.flow?.downstreamId ?? app.sessions.get(key)?.backendId ?? '', downstreamInherited: !app.sessions.get(key)?.backendId && !app.sessions.get(key)?.flowId, missing: !value.flow }]; }));
        json(res, 200, { flows: availableFlows(cfg, app.sessions).map(flow => ({ ...operatorFlow(flow, cfg), compatibility: !flow.operators, virtual: !cfg.flows.some(f => f.id === flow.id), references: Object.values(bindings).filter(b => b.id === flow.id).length })),
            defaultId: cfg.defaultFlowId || resolveFlow(cfg, app.sessions, '__unbound_flow_defaults__').id, downstreamDefaults: cfg.downstreamFlowDefaults, bindings });
    });
    router.post('/api/flows', ({ res, body }) => {
        try {
            const value = parseFlow(body); validateFlow(value, app.config());
            const previous = availableFlows(app.config(), app.sessions).find(f => f.id === value.id);
            if (value.id.startsWith('compat_') && !previous) throw new Error('compat_ 为兼容流程保留前缀');
            if (previous && cfgOwner(app.config(), previous.id) && previous.downstreamId !== value.downstreamId) throw new Error('已保存流程的所属下游不能直接改变，请复制为新流程');
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
    router.post('/api/flow-defaults', ({ res, body }) => {
        const cfg = app.config();
        const flow = availableFlows(cfg, app.sessions).find(f => f.id === body.flowId && f.downstreamId === body.downstreamId);
        if (!flow || !flow.enabled) return json(res, 400, { error: '请选择该下游已启用的流程配置' });
        app.updateConfig(c => { if (!c.flows.some(f => f.id === flow.id)) c.flows.push(flow); c.downstreamFlowDefaults[flow.downstreamId] = flow.id; });
        publishStatus('config'); json(res, 200, { ok: true });
    });
    router.delete('/api/flows/:id', ({ res, params }) => {
        const cfg = app.config();
        if (!cfg.flows.some(f => f.id === params.id)) return json(res, 409, { error: '兼容流程由旧绑定生成，请先改为选择正式流程' });
        if (Object.values(cfg.downstreamFlowDefaults).includes(params.id ?? '') || resolveFlow(cfg, app.sessions, '__unbound_flow_defaults__').id === params.id || Object.keys(app.sessions.snapshot()).some(key => resolveFlow(cfg, app.sessions, key).id === params.id)) return json(res, 409, { error: '流程仍被默认设置或会话引用，请先更换绑定' });
        app.updateConfig(c => { c.flows = c.flows.filter(f => f.id !== params.id); });
        publishStatus('config'); json(res, 200, { ok: true });
    });
    router.get('/api/flow-runs', ({ res, query }) => json(res, 200, { runs: app.flowRuns.list(query.get('flowId') || undefined).filter(r => !query.get('sessionKey') || r.sessionKey === query.get('sessionKey')) }));
    router.post('/api/flows/preview', async ({ res, body }) => {
        try {
            const raw = body.flow;
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('流程定义无效');
            let flow = parseFlow(raw as Record<string, unknown>);
            const known = availableFlows(app.config(), app.sessions).find(f => f.id === flow.id);
            if (known) {
                const converted = operatorFlow(known, app.config());
                const comparable = (f: typeof flow) => JSON.stringify(parseFlow({ id: f.id, name: f.name, enabled: f.enabled, downstreamId: f.downstreamId, ...(f.operators ? { operators: f.operators } : { conversationId: f.conversationId, upstreamEnabled: f.upstreamEnabled, downstreamEnabled: f.downstreamEnabled }) }));
                if (comparable(flow) === comparable(known) || comparable(flow) === comparable(converted)) flow = known;
                else if (known.downstreamId === flow.downstreamId) flow.legacyProfileId = known.legacyProfileId;
            }
            const target = app.downstreams.resolve(flow.downstreamId, flow.legacyProfileId ?? '');
            const replies = body.replies ?? {};
            if (!record(replies) || Object.keys(replies).length > 128 || Object.values(replies).some(v => typeof v !== 'string' || v.length > 64000)) throw new Error('模拟回复须为操作标识到文本的映射');
            const text = String(body.text ?? ''); const reply = String(body.reply ?? '');
            if (text.length > 64000 || reply.length > 64000) throw new Error('预览文本过长');
            const result = await executeFlow({ flow, config: app.config(), store: app.flowRuns, sessionKey: '_flow_preview', mode: 'preview', text,
                state: body.state === undefined ? emptyState() : parseState(body.state),
                legacySystem: target?.adapter ? buildSystemPrompt(app.config(), '_flow_preview', { sessions: app.sessions }, target.adapter, target.settings) : '', legacyRules: app.config().replyProcessors,
                ask: async (_input, _system, request) => ({ ok: true, text: String(request ? replies[`${request.operatorId}.${request.actionId}`] ?? reply : reply), elapsedMs: 0 }) });
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
        const cleanups: Array<() => Promise<unknown>> = [];
        try {
            const result = await executeFlow({ flow, config: cfg, store: app.flowRuns, sessionKey: key, mode: 'test', text,
                legacySystem: target?.adapter ? buildSystemPrompt(cfg, key, { sessions: app.sessions }, target.adapter, target.settings) : '', legacyRules: cfg.replyProcessors,
                ask: async (input, system, request) => {
                    const selected = request ? app.downstreams.resolve(request.downstreamId, request.downstreamId === flow.downstreamId ? flow.legacyProfileId ?? '' : '') : target;
                    if (!selected?.adapter) throw new Error('下游未启用或启动失败');
                    const sessionKey = request?.sessionKey ?? key;
                    cleanups.push(async () => selected.adapter!.resetSession?.(sessionKey));
                    return selected.adapter.ask({ sessionKey, text: input, system, sender: '流程测试', settings: { ...selected.settings, systemPrompt: system }, profileId: selected.profile?.id });
                } });
            json(res, 200, result);
        } finally { for (const cleanup of cleanups) try { await cleanup(); } catch {} }
    });
}

function cfgOwner(cfg: ReturnType<AppContext['config']>, id: string) { return cfg.flows.some(f => f.id === id); }
