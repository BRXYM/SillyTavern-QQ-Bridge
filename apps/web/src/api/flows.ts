import { request } from './client';
import type { ConversationState } from './conversations';
export interface MessageFlow { id: string; name: string; enabled: boolean; downstreamId: string; conversationId: string; upstreamEnabled: boolean; downstreamEnabled: boolean; compatibility?: boolean; references?: number; legacyProfileId?: string; legacyPreserveBehavior?: boolean }
export interface FlowStep { id: string; name: string; status: 'pending' | 'running' | 'success' | 'skipped' | 'failed'; input?: string; output?: string; system?: string; error?: string; elapsedMs?: number }
export interface FlowRun { id: string; flowId: string; flowName: string; sessionKey: string; mode: 'live' | 'preview' | 'test'; createdAt: string; status: 'running' | 'success' | 'failed' | 'filtered'; steps: FlowStep[]; elapsedMs: number; error?: string; variablesSaved: boolean; variables: Array<{ name: string; before: string; after: string }>; warnings: string[] }
export interface FlowList { flows: MessageFlow[]; defaultId: string; bindings: Record<string, { id: string; inherited: boolean; missing: boolean }> }
export interface FlowResult { ok: boolean; output: string; state?: ConversationState; run: FlowRun; error?: string }
export const flowsApi = {
    list: () => request<FlowList>('/flows'),
    save: (flow: MessageFlow) => request<{ ok: boolean; flow: MessageFlow }>('/flows', { method: 'POST', body: JSON.stringify(flow) }),
    setDefault: (id: string) => request(`/flows/${encodeURIComponent(id)}/default`, { method: 'POST', body: '{}' }),
    remove: (id: string) => request(`/flows/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    preview: (flow: MessageFlow, text: string, reply: string, state?: ConversationState) => request<FlowResult>('/flows/preview', { method: 'POST', body: JSON.stringify({ flow, text, reply, state }) }),
    test: (id: string, text: string) => request<FlowResult>(`/flows/${encodeURIComponent(id)}/test`, { method: 'POST', body: JSON.stringify({ text }) }),
    runs: () => request<{ runs: FlowRun[] }>('/flow-runs'),
};
