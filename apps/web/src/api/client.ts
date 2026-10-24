/**
 * 后端 API 客户端。
 * 开发时通过 Vite 代理访问 :9510；生产时同源。
 */

export interface SessionStat {
    in: number;
    out: number;
    last: number;
}

export interface SessionChoiceDto {
    character?: string;
    world?: string;
    replyProcessors?: unknown[];
    createdAt?: string;
    updatedAt?: string;
}

export interface CatalogDto {
    characters: string[];
    worlds: string[];
    updatedAt: string | null;
}

export interface StatusDto {
    onebotConnected: boolean;
    stClients: number;
    selfId: string;
    sessions: Record<string, SessionStat>;
    sessionChoices: Record<string, SessionChoiceDto>;
    catalogs: CatalogDto;
    config: Record<string, unknown>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`/api${path}`, {
        headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
        ...init,
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${res.status} ${res.statusText}${text ? `: ${text}` : ''}`);
    }
    const ct = res.headers.get('content-type') ?? '';
    return ct.includes('application/json')
        ? ((await res.json()) as T)
        : ((await res.text()) as unknown as T);
}

export const api = {
    status: () => request<StatusDto>('/status'),

    updateConfig: (patch: Record<string, unknown>) =>
        request<{ ok: boolean }>('/config', {
            method: 'POST',
            body: JSON.stringify(patch),
        }),

    updateSession: (payload: {
        sessionKey: string;
        character?: string;
        world?: string;
        replyProcessors?: unknown[];
        reset?: boolean | 'pipeline';
    }) =>
        request<{ ok: boolean }>('/session-choice', {
            method: 'POST',
            body: JSON.stringify(payload),
        }),

    refreshCatalog: () => request<{ ok: boolean; catalogs: CatalogDto }>('/catalog/refresh'),

    testSegmentation: (text: string, config: Record<string, unknown>) =>
        request<{ ok: boolean; segments: Array<{ text: string; delayMs: number }> }>(
            '/test-segments',
            { method: 'POST', body: JSON.stringify({ text, config }) },
        ),

    testPipeline: (text: string, rules: unknown[]) =>
        request<{ result: string }>('/test-pipeline', {
            method: 'POST',
            body: JSON.stringify({ text, rules }),
        }),
};
