import { createHash } from 'node:crypto';
import type { BridgeConfig } from './schema.ts';
import type { SessionStore } from '../core/sessions.ts';
import { resolveConversation } from './conversations.ts';

export interface MessageFlow {
    id: string; name: string; enabled: boolean;
    downstreamId: string; conversationId: string;
    upstreamEnabled: boolean; downstreamEnabled: boolean;
    /** 旧绑定的协议覆盖与原行为，仅用于兼容，不能由新流程指定。 */
    legacyProfileId?: string; legacyPreserveBehavior?: boolean;
}
export function parseFlow(raw: Record<string, unknown>): MessageFlow {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('流程定义须为对象');
    if (Object.keys(raw).some(k => !['id', 'name', 'enabled', 'downstreamId', 'conversationId', 'upstreamEnabled', 'downstreamEnabled', 'legacyProfileId', 'legacyPreserveBehavior'].includes(k))) throw new Error('当前仅支持固定四步流程，不接受自定义节点或脚本');
    const id = String(raw.id ?? '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || id === '__inherit__') throw new Error('流程 ID 须为 1–64 位字母、数字、短横线或下划线，不能使用保留 ID');
    const name = raw.name ?? id;
    if (typeof name !== 'string' || name.length > 120) throw new Error('流程名称最多 120 字');
    for (const k of ['enabled', 'upstreamEnabled', 'downstreamEnabled']) if (raw[k] !== undefined && typeof raw[k] !== 'boolean') throw new Error('流程开关格式无效');
    for (const k of ['downstreamId', 'conversationId']) if (raw[k] !== undefined && typeof raw[k] !== 'string') throw new Error('流程引用须为字符串');
    const conversationId = String(raw.conversationId ?? '');
    return { id, name: name.trim() || id, enabled: raw.enabled !== false, downstreamId: String(raw.downstreamId ?? ''), conversationId,
        upstreamEnabled: raw.upstreamEnabled === undefined ? !!conversationId : raw.upstreamEnabled === true,
        downstreamEnabled: raw.downstreamEnabled === undefined ? !!conversationId : raw.downstreamEnabled === true };
}
export function validateFlow(flow: MessageFlow, cfg: BridgeConfig) {
    if (!cfg.downstreams.some(d => d.id === flow.downstreamId)) throw new Error('请选择存在的下游连接');
    if (flow.conversationId && !cfg.conversationProfiles.some(p => p.id === flow.conversationId)) throw new Error('引用的会话配置不存在');
    if (!flow.conversationId && (flow.upstreamEnabled || flow.downstreamEnabled) && !flow.legacyPreserveBehavior) throw new Error('启用消息处理前，请选择会话配置');
}
function legacyFlow(cfg: BridgeConfig, sessions: SessionStore, key: string): MessageFlow {
    const resolved = sessions.resolve(key);
    const own = sessions.get(key);
    const conversation = resolveConversation(cfg, sessions, key);
    const preserve = (!!conversation?.legacyRef?.preserveBehavior && own?.conversationId === undefined && !cfg.defaultConversationId)
        || (!conversation && own?.conversationId === undefined && !cfg.defaultConversationId);
    const signature = JSON.stringify([resolved.backendId, resolved.profileId, conversation?.id ?? '', preserve]);
    const id = `compat_${createHash('sha256').update(signature).digest('hex').slice(0, 16)}`;
    return cfg.flows.find(f => f.id === id) ?? { id, name: `兼容 · ${cfg.downstreams.find(d => d.id === resolved.backendId)?.name || resolved.backendId} / ${conversation?.name || resolved.profileId || '原处理方式'}`.slice(0, 120), enabled: true,
        downstreamId: resolved.backendId, conversationId: conversation?.id ?? '', upstreamEnabled: !!conversation || preserve, downstreamEnabled: !!conversation || preserve,
        legacyProfileId: resolved.profileId || undefined, legacyPreserveBehavior: preserve };
}
export function resolveFlow(cfg: BridgeConfig, sessions: SessionStore, key: string): { flow?: MessageFlow; inherited: boolean; id: string } {
    const own = sessions.get(key);
    if (own?.flowId !== undefined) return { flow: cfg.flows.find(f => f.id === own.flowId), id: own.flowId, inherited: false };
    if (own?.backendId !== undefined || own?.profileId !== undefined || own?.conversationId !== undefined) {
        const flow = legacyFlow(cfg, sessions, key); return { flow, id: flow.id, inherited: false };
    }
    if (cfg.defaultFlowId) return { flow: cfg.flows.find(f => f.id === cfg.defaultFlowId), id: cfg.defaultFlowId, inherited: true };
    const flow = legacyFlow(cfg, sessions, key); return { flow, id: flow.id, inherited: true };
}
export function availableFlows(cfg: BridgeConfig, sessions: SessionStore): MessageFlow[] {
    const result = new Map(cfg.flows.map(f => [f.id, f]));
    const defaultFlow = legacyFlow(cfg, sessions, '__unbound_flow_defaults__');
    if (!cfg.defaultFlowId && !result.has(defaultFlow.id)) result.set(defaultFlow.id, defaultFlow);
    for (const key of Object.keys(sessions.snapshot())) {
        const flow = resolveFlow(cfg, sessions, key).flow;
        if (flow && !result.has(flow.id)) result.set(flow.id, flow);
    }
    return [...result.values()];
}
export function mirrorFlowDefault(cfg: BridgeConfig, flow: MessageFlow) {
    cfg.defaultFlowId = flow.id; cfg.defaultDownstreamId = flow.downstreamId;
    cfg.defaultConversationId = flow.legacyPreserveBehavior ? '' : flow.conversationId; cfg.defaultDownstreamProfileId = flow.legacyProfileId ?? '';
}
