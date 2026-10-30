import { request } from './client';
export interface MessageRule { type: 'replace' | 'remove' | 'strip'; pattern?: string; replacement?: string; flags?: string; begin?: string; end?: string; keep?: boolean; enabled?: boolean }
export interface ExtractionRule { name: string; source: string; mode: 'regex' | 'json'; expression: string; group: number; flags: string }
export interface VariableDefinition { name: string; initialValue: string }
export interface VariableAssignment { name: string; value: string; skipEmpty?: boolean }
export interface ConversationState { vars: Record<string, string>; previous: { upstream: Record<string, string>; downstream: Record<string, string> } }
export interface ConversationPreview { input: string; system: string; output: string; extracted: ConversationState['previous']; state: ConversationState; warnings: string[] }
export interface ConversationProfile { id: string; name: string; systemPrompt: string; inputPrefix: string; inputSuffix: string; inputRules: MessageRule[]; replyRules: MessageRule[]; replyPrefix?: string; replySuffix?: string; variables?: VariableDefinition[]; upstreamExtracts?: ExtractionRule[]; downstreamExtracts?: ExtractionRule[]; upstreamAssignments?: VariableAssignment[]; downstreamAssignments?: VariableAssignment[]; legacyRef?: { downstreamId: string; profileId: string } }
export const conversationsApi = {
    list: () => request<{ profiles: ConversationProfile[]; defaultId: string; bindings: Record<string, { id: string; inherited: boolean }> }>('/conversations'),
    save: (profile: ConversationProfile) => request('/conversations', { method: 'POST', body: JSON.stringify(profile) }),
    remove: (id: string) => request(`/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    defaults: (backendId: string, conversationId: string) => request('/conversation-defaults', { method: 'POST', body: JSON.stringify({ backendId, conversationId }) }),
    preview: (profile: ConversationProfile, text: string, reply: string, state?: ConversationState) => request<ConversationPreview>('/conversations/preview', { method: 'POST', body: JSON.stringify({ profile, text, reply, state }) }),
    variables: (key: string) => request<{ state: ConversationState; revision: number }>(`/session-variables/${encodeURIComponent(key)}`),
    saveVariables: (key: string, vars: Record<string, string>, revision: number) => request<{ state: ConversationState; revision: number }>(`/session-variables/${encodeURIComponent(key)}`, { method: 'POST', body: JSON.stringify({ vars, revision }) }),
};
