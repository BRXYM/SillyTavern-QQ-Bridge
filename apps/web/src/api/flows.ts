import { request } from './client';
import type { ConversationState, MessageRule, ExtractionRule, VariableAssignment, VariableDefinition } from './conversations';
export type OperatorAction = { id: string } & (
    | { type: 'input'; source: string }
    | { type: 'process'; source?: string; prefix: string; suffix: string; system?: string; rules: MessageRule[]; extracts: ExtractionRule[]; assignments: VariableAssignment[]; variables: VariableDefinition[]; stopIfEmpty: boolean; legacyStage?: 'upstream' | 'downstream'; legacySystem?: boolean; legacyRules?: boolean }
    | { type: 'call'; downstreamId?: string; input: string; system: string; legacySession?: boolean }
    | { type: 'reply'; text: string; stopAfter: boolean }
    | { type: 'stop' }
);
export interface FlowOperator { id: string; name: string; enabled: boolean; actions: OperatorAction[] }
export interface MessageFlow { id: string; name: string; enabled: boolean; downstreamId: string; operators: FlowOperator[]; compatibility?: boolean; virtual?: boolean; references?: number; legacyProfileId?: string; legacyPreserveBehavior?: boolean }
export type StepStatus = 'pending' | 'running' | 'success' | 'skipped' | 'failed';
export interface FlowActionRun { id: string; type: OperatorAction['type']; status: StepStatus; input?: string; output?: string; system?: string; error?: string; elapsedMs?: number; downstreamId?: string }
export interface FlowStep { actions?: FlowActionRun[]; id: string; name: string; status: StepStatus; input?: string; output?: string; system?: string; error?: string; elapsedMs?: number }
export interface FlowRun { id: string; flowId: string; flowName: string; sessionKey: string; mode: 'live' | 'preview' | 'test'; createdAt: string; status: 'running' | 'success' | 'failed' | 'filtered'; steps: FlowStep[]; elapsedMs: number; error?: string; variablesSaved: boolean; variables: Array<{ name: string; before: string; after: string; saved?: boolean }>; warnings: string[]; deliveries?: Array<{ operatorId: string; actionId: string; text: string; simulated: boolean; sent: number; failed: number }>; partialEffects?: boolean }
export interface FlowList { flows: MessageFlow[]; defaultId: string; downstreamDefaults: Record<string, string>; bindings: Record<string, { id: string; inherited: boolean; downstreamId: string; downstreamInherited: boolean; missing: boolean }> }
export interface FlowResult { ok: boolean; output: string; state?: ConversationState; run: FlowRun; error?: string }
export const actionNames: Record<OperatorAction['type'], string> = { input: '读取数据', process: '处理内容', call: '调用服务', reply: '返回 QQ', stop: '结束流程' };
export function newAction(type: OperatorAction['type']): OperatorAction {
    const id = 'a_' + crypto.randomUUID().replaceAll('-', '').slice(0, 10);
    switch (type) {
        case 'input': return { id, type, source: '{{message.upstream}}' };
        case 'process': return { id, type, prefix: '', suffix: '', rules: [], extracts: [], assignments: [], variables: [], stopIfEmpty: false };
        case 'call': return { id, type, input: '{{text}}', system: '{{system}}' };
        case 'reply': return { id, type, text: '{{text}}', stopAfter: false };
        case 'stop': return { id, type };
    }
}
export function newOperator(type: OperatorAction['type']): FlowOperator { return { id: 'op_' + crypto.randomUUID().replaceAll('-', '').slice(0, 10), name: actionNames[type], enabled: true, actions: [newAction(type)] }; }
export const flowsApi = {
    list: () => request<FlowList>('/flows'),
    validate: (flow: unknown) => request<{ flow: MessageFlow }>('/flows/validate', { method: 'POST', body: JSON.stringify(flow) }),
    save: (flow: MessageFlow) => request<{ ok: boolean; flow: MessageFlow }>('/flows', { method: 'POST', body: JSON.stringify(flow) }),
    setDefault: (id: string) => request(`/flows/${encodeURIComponent(id)}/default`, { method: 'POST', body: '{}' }),
    setDownstreamDefault: (downstreamId: string, flowId: string) => request('/flow-defaults', { method: 'POST', body: JSON.stringify({ downstreamId, flowId }) }),
    remove: (id: string) => request(`/flows/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    preview: (flow: MessageFlow, text: string, reply: string, state?: ConversationState, replies?: Record<string, string>) => request<FlowResult>('/flows/preview', { method: 'POST', body: JSON.stringify({ flow, text, reply, state, replies }) }),
    test: (id: string, text: string) => request<FlowResult>(`/flows/${encodeURIComponent(id)}/test`, { method: 'POST', body: JSON.stringify({ text }) }),
    runs: () => request<{ runs: FlowRun[] }>('/flow-runs'),
};
