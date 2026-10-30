import { request } from './client';

export interface AdaptationInput { id: string; name: string; goal: string; endpoint: string; documentation: string; sourceId: string }
export interface AdaptationJob {
    id: string;
    status: 'generating' | 'ready' | 'needs-input' | 'failed' | 'applied';
    createdAt: string; sourceId: string; input: AdaptationInput;
    summary: string; questions: string[]; draft?: Record<string, unknown>; error?: string; appliedId?: string;
}
const post = <T>(url: string, body: unknown) => request<T>(url, { method: 'POST', body: JSON.stringify(body) });
export const adaptationApi = {
    list: () => request<{ jobs: AdaptationJob[] }>('/adaptations'),
    create: (input: AdaptationInput) => post<{ job: AdaptationJob }>('/adaptations', input),
    get: (id: string) => request<{ job: AdaptationJob }>(`/adaptations/${id}`),
    test: (id: string, draft: unknown, text: string) => post<{ ok: boolean; text: string; error?: string; elapsedMs: number }>(`/adaptations/${id}/test`, { draft, text }),
    apply: (id: string, draft: unknown) => post<{ id: string; warning?: string; runtime?: { ok: boolean; error?: string } }>(`/adaptations/${id}/apply`, { draft, connectionOnly: true }),
};
