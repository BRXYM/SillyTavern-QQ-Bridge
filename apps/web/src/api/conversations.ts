import { request } from './client';
export interface MessageRule { type: 'replace' | 'remove' | 'strip'; pattern?: string; replacement?: string; flags?: string; begin?: string; end?: string; keep?: boolean; enabled?: boolean }
export interface ConversationProfile { id: string; name: string; systemPrompt: string; inputPrefix: string; inputSuffix: string; inputRules: MessageRule[]; replyRules: MessageRule[]; legacyRef?: { downstreamId: string; profileId: string } }
export const conversationsApi = {
    list: () => request<{ profiles: ConversationProfile[]; defaultId: string; bindings: Record<string, { id: string; inherited: boolean }> }>('/conversations'),
    save: (profile: ConversationProfile) => request('/conversations', { method: 'POST', body: JSON.stringify(profile) }),
    remove: (id: string) => request(`/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    defaults: (backendId: string, conversationId: string) => request('/conversation-defaults', { method: 'POST', body: JSON.stringify({ backendId, conversationId }) }),
    preview: (profile: ConversationProfile, text: string, reply: string) => request<{ input: string; system: string; output: string }>('/conversations/preview', { method: 'POST', body: JSON.stringify({ profile, text, reply }) }),
};
