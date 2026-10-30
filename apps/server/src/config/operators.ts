import type { ProcessorRule, BridgeConfig } from './schema.ts';
import type { ExtractionRule, VariableAssignment, VariableDefinition } from './conversation-flow.ts';
import { safeName, record } from './conversation-flow.ts';
import { parseConversation } from './conversations.ts';
import type { MessageFlow } from './flows.ts';

export type OperatorAction = { id: string } & (
    | { type: 'input'; source: string }
    | { type: 'process'; source?: string; prefix: string; suffix: string; system?: string; rules: ProcessorRule[]; extracts: ExtractionRule[]; assignments: VariableAssignment[]; variables: VariableDefinition[]; stopIfEmpty: boolean; legacyStage?: 'upstream' | 'downstream'; legacySystem?: boolean; legacyRules?: boolean }
    | { type: 'call'; downstreamId?: string; input: string; system: string; legacySession?: boolean }
    | { type: 'reply'; text: string; stopAfter: boolean }
    | { type: 'stop' }
);
export interface FlowOperator { id: string; name: string; enabled: boolean; actions: OperatorAction[] }
export const boundedText = (raw: unknown, label: string, fallback = '', max = 16000): string => {
    const value = raw ?? fallback;
    if (typeof value !== 'string' || value.length > max) throw new Error(`${label} 须为文本，最多 ${max} 字`);
    return value;
};
function flag(raw: unknown, label: string, fallback: boolean) {
    if (raw !== undefined && typeof raw !== 'boolean') throw new Error(`${label} 须为开关`);
    return raw === undefined ? fallback : raw as boolean;
}
function keys(raw: Record<string, unknown>, allowed: string[]) {
    if (Object.keys(raw).some(k => !allowed.includes(k))) throw new Error('操作中包含不支持的字段');
}
export function validateOperatorTemplate(text: string) {
    for (const match of text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
        const token = match[1]!.trim();
        if (/^(text|system|vars|message|operators|history|extracted|current|previous)(?:\.|$)/.test(token) && !/^(text|system|message\.(upstream|downstream)|vars\.[A-Za-z][A-Za-z0-9_]{0,47}|extracted\.[A-Za-z][A-Za-z0-9_]{0,47}|(current|previous)\.(upstream|downstream)\.[A-Za-z][A-Za-z0-9_]{0,47}|(operators|history)\.[A-Za-z][A-Za-z0-9_]{0,47}\.(input|output|extracted\.[A-Za-z][A-Za-z0-9_]{0,47}))$/.test(token)) throw new Error(`引用格式无效：${token}`);
        if (token.split('.').some(part => ['__proto__', 'constructor', 'prototype'].includes(part))) throw new Error('不允许访问原型字段');
    }
}
export function parseOperators(raw: unknown): FlowOperator[] {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 32) throw new Error('流程须包含 1–32 个算子');
    const ids = new Set<string>(); let count = 0;
    return raw.map((item, index) => {
        if (!record(item)) throw new Error('算子定义须为对象');
        keys(item, ['id', 'name', 'enabled', 'actions']);
        const id = boundedText(item.id, '算子 ID');
        if (!safeName(id) || ids.has(id)) throw new Error('算子 ID 须唯一，以字母开头，最多 48 位英文、数字或下划线');
        ids.add(id);
        if (!Array.isArray(item.actions) || !item.actions.length || item.actions.length > 16 || (count += item.actions.length) > 128) throw new Error('每个算子须有 1–16 个操作，流程最多 128 个操作');
        const actionIds = new Set<string>();
        const actions = item.actions.map((a, ai): OperatorAction => {
            if (!record(a)) throw new Error('操作定义须为对象');
            const actionId = boundedText(a.id, '操作 ID', `action_${ai + 1}`);
            if (!safeName(actionId) || actionIds.has(actionId)) throw new Error('同一算子内操作 ID 须唯一且合法');
            actionIds.add(actionId);
            const common = { id: actionId };
            const text = (k: string, fallback = '') => { const value = boundedText(a[k], k, fallback); validateOperatorTemplate(value); return value; };
            switch (a.type) {
                case 'input': keys(a, ['id', 'type', 'source']); return { ...common, type: 'input', source: text('source', '{{message.upstream}}') };
                case 'call': keys(a, ['id', 'type', 'downstreamId', 'input', 'system', 'legacySession']); return { ...common, type: 'call', downstreamId: a.downstreamId === undefined ? undefined : boundedText(a.downstreamId, '服务连接'), input: text('input', '{{text}}'), system: text('system', '{{system}}'), legacySession: flag(a.legacySession, '旧上下文', false) };
                case 'reply': keys(a, ['id', 'type', 'text', 'stopAfter']); return { ...common, type: 'reply', text: text('text', '{{text}}'), stopAfter: flag(a.stopAfter, '回复后结束', false) };
                case 'stop': keys(a, ['id', 'type']); return { ...common, type: 'stop' };
                case 'process': {
                    keys(a, ['id', 'type', 'source', 'prefix', 'suffix', 'system', 'rules', 'extracts', 'assignments', 'variables', 'stopIfEmpty', 'legacyStage', 'legacySystem', 'legacyRules']);
                    const extracts = Array.isArray(a.extracts) ? a.extracts.map(r => record(r) ? { ...r, source: r.source ?? '{{text}}' } : r) : a.extracts;
                    const cfg = parseConversation({ id: 'operator', replyPrefix: text('prefix'), replySuffix: text('suffix'), replyRules: a.rules ?? [], variables: a.variables ?? [], downstreamExtracts: extracts ?? [], downstreamAssignments: a.assignments ?? [] });
                    const stage = a.legacyStage;
                    if (stage !== undefined && stage !== 'upstream' && stage !== 'downstream') throw new Error('兼容方向无效');
                    const action: OperatorAction = { ...common, type: 'process', prefix: cfg.replyPrefix!, suffix: cfg.replySuffix!, rules: cfg.replyRules, extracts: cfg.downstreamExtracts!, assignments: cfg.downstreamAssignments!, variables: cfg.variables!, stopIfEmpty: flag(a.stopIfEmpty, '空消息停止', false), legacyStage: stage, legacySystem: flag(a.legacySystem, '兼容提示词', false), legacyRules: flag(a.legacyRules, '兼容规则', false) };
                    if (a.source !== undefined) action.source = text('source');
                    if (a.system !== undefined) action.system = text('system');
                    for (const rule of action.extracts) validateOperatorTemplate(rule.source);
                    for (const assign of action.assignments) validateOperatorTemplate(assign.value);
                    for (const rule of action.rules) if (rule.type === 'replace') validateOperatorTemplate(rule.replacement ?? '');
                    return action;
                }
                default: throw new Error('操作仅支持读取、处理、调用、回复和结束');
            }
        });
        return { id, name: boundedText(item.name, '算子名称', `算子 ${index + 1}`, 120).trim() || id, enabled: flag(item.enabled, '算子启用', true), actions };
    });
}
/** 旧配置只在迁移边界读取；编辑器拿到的是独立算子参数，不再引用会话配置。 */
export function operatorFlow(flow: MessageFlow, cfg: BridgeConfig): MessageFlow & { operators: FlowOperator[] } {
    if (flow.operators) return flow as MessageFlow & { operators: FlowOperator[] };
    const p = cfg.conversationProfiles.find(p => p.id === flow.conversationId);
    const process = (stage: 'upstream' | 'downstream'): OperatorAction => ({ id: 'process', type: 'process', prefix: stage === 'upstream' ? p?.inputPrefix ?? '' : p?.replyPrefix ?? '', suffix: stage === 'upstream' ? p?.inputSuffix ?? '' : p?.replySuffix ?? '', system: stage === 'upstream' ? p?.systemPrompt ?? '' : undefined, rules: (stage === 'upstream' ? p?.inputRules : p?.replyRules) ?? [], extracts: (stage === 'upstream' ? p?.upstreamExtracts : p?.downstreamExtracts) ?? [], assignments: (stage === 'upstream' ? p?.upstreamAssignments : p?.downstreamAssignments) ?? [], variables: stage === 'upstream' || !flow.upstreamEnabled ? p?.variables ?? [] : [], stopIfEmpty: stage === 'upstream', legacyStage: stage });
    const upstream = process('upstream'); const downstream = process('downstream');
    if (flow.legacyPreserveBehavior && upstream.type === 'process' && downstream.type === 'process') {
        Object.assign(upstream, { prefix: '', suffix: '', system: undefined, rules: [], extracts: [], assignments: [], variables: [], legacySystem: true });
        Object.assign(downstream, { prefix: '', suffix: '', rules: [], extracts: [], assignments: [], variables: [], legacyRules: true });
    }
    return { ...flow, operators: [
        { id: 'upstream', name: '消息处理', enabled: !!flow.upstreamEnabled, actions: [upstream] },
        { id: 'call', name: '调用服务', enabled: true, actions: [{ id: 'request', type: 'call', input: '{{text}}', system: '{{system}}', legacySession: true }] },
        { id: 'downstream', name: '回复处理', enabled: !!flow.downstreamEnabled, actions: [downstream] },
        { id: 'reply', name: '返回 QQ', enabled: true, actions: [{ id: 'send', type: 'reply', text: '{{text}}', stopAfter: false }] },
    ] };
}
