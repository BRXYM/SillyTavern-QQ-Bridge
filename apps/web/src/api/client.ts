/**
 * API 客户端。
 *
 * 与后端的契约以 apps/server/src/api/routes/*.ts 为准。
 * 状态由后端组装好，这里只做类型声明，不推断业务。
 */

export interface SessionStat {
    in: number;
    out: number;
    last: number;
}

export interface UpstreamStatus {
    connected: boolean;
    endpoint: string;
    selfId: string;
    nickname: string;
    connectedForSec: number;
    connectedAt: number | null;
    disconnectedAt: number | null;
    reconnectCount: number;
    eventsIn: number;
    actionsOut: number;
    actionErrors: number;
    lastEventAt: number | null;
    lastError: string;
    lastErrorAt: number | null;
}

/** 下游实例运行态 */
export interface DownstreamStatusDto {
    id: string;
    kind: string;
    name: string;
    enabled: boolean;
    available: boolean;
    reason?: string;
    detail?: Record<string, string | number | boolean>;
}

export interface SessionChoiceDto {
    character?: string;
    world?: string;
    replyProcessors?: unknown[];
    /** 会话级下游实例 id；缺失 = 继承全局 defaultDownstreamId */
    backendId?: string;
    createdAt?: string;
    updatedAt?: string;
}

/** 会话实际生效的下游实例 id */
export type SessionBackendDto = string;

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
    /** 每个会话实际生效的下游：{ key: { backendId, inherited } } */
    sessionBackends?: Record<string, { backendId: SessionBackendDto; inherited: boolean }>;
    /** 下游实例与状态 */
    downstreams?: DownstreamStatusDto[];
    defaultDownstreamId?: string;
    catalogs: CatalogDto;
    config: Record<string, unknown>;
    generatedAt?: number;
    upstream?: UpstreamStatus;
    metrics?: {
        sessionCount: number;
        totalIn: number;
        totalOut: number;
        lastActiveAt: number | null;
    };
    process?: {
        pid: number;
        nodeVersion: string;
        platform: string;
        arch: string;
        uptimeSec: number;
        startedAt: number;
        rssMb: number;
        heapUsedMb: number;
        heapTotalMb: number;
        externalMb?: number;
        codeVersion?: string;
    };
    /** 酒馆扩展连接摘要 */
    extension?: {
        port: number;
        clientCount: number;
        clients: Array<{
            id: number;
            ext: string;
            version: string;
            connectedAt: number | null;
            connectedForSec: number;
            lastPingAt: number | null;
        }>;
    };
    logs?: string[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`/api${path}`, {
        headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
        ...init,
    });
    const text = await res.text();
    let body: unknown;
    try {
        body = JSON.parse(text);
    } catch {
        body = text;
    }
    if (!res.ok) {
        const msg =
            typeof body === 'object' && body && 'error' in body
                ? String((body as { error: unknown }).error)
                : `${res.status} ${res.statusText}`;
        throw new Error(msg);
    }
    return body as T;
}


// ---------------- SnowLuma（上游本体管理） ----------------
export interface SnowLumaProbe {
    ok: boolean;
    dir: string;
    configDir: string;
    dataDir: string;
    mode: 'release' | 'source' | 'flat' | '';
    reason: string;
    version: string;
    hasConfig: boolean;
    error: string;
    accounts: Array<{ uin: string; hasIdentityDb: boolean; updatedAt: string | null }>;
    /** 同目录下的其他可用配置（旧版前端用到，保留兼容） */
    alternatives?: Array<{
        configDir: string;
        dataDir: string;
        mode: string;
        version: string;
    }>;
    onebotPortListening: boolean;
    onebotPort: number;
}

export interface SnowLumaDiscoverResult {
    found: boolean;
    dir: string;
    source: string;
    candidates: Array<{
        dir: string;
        source: string;
        ok?: boolean;
        version?: string;
        mode?: string;
        accounts?: string[];
    }>;
    tried: string[];
    error?: string;
}

export interface SnowLumaApplyResult {
    ok: boolean;
    changed: boolean;
    created: boolean;
    path: string;
    token: string;
    endpoint: string;
    configDir: string;
    dataDir: string;
    mode: string;
    version: string;
    needRestart: boolean;
    error?: string;
}

// ---------------- SillyTavern（酒馆本体管理） ----------------
export interface SillyTavernProbe {
    ok: boolean;
    dir: string;
    extDir: string;
    installed: boolean;
    installedVersion: string;
    version: string;
    files: string[];
    error: string;
    port: number;
    endpoint: string;
    running: boolean;
    extConnected: boolean;
    extPort: number;
}

export interface SillyTavernDiscoverResult {
    found: boolean;
    dir: string;
    source: string;
    candidates: Array<{
        dir: string;
        source: string;
        ok?: boolean;
        version?: string;
        mode?: string;
        installed?: boolean;
        installedVersion?: string;
        extDir?: string;
    }>;
    tried: string[];
    error?: string;
}

export interface ExtensionInstallResult {
    ok: boolean;
    action: string;
    target: string;
    version: string;
    files: string[];
    needRefresh: boolean;
    error: string;
}

export const api = {
    status: () => request<StatusDto>('/status'),

    logs: (limit = 200) => request<{ ok: boolean; logs: string[] }>(`/logs?limit=${limit}`),

    updateConfig: (patch: Record<string, unknown>) =>
        request<{ ok: boolean; config: Record<string, unknown> }>('/config', {
            method: 'POST',
            body: JSON.stringify(patch),
        }),

    // ---------------- 会话 ----------------
    sessions: () =>
        request<{
            ok: boolean;
            sessions: Array<{
                sessionKey: string;
                choice: SessionChoiceDto | null;
                stat: SessionStat;
                resolved: { backendId: string; inherited: boolean; character: string; world: string };
            }>;
        }>('/sessions'),

    updateSession: (payload: {
        sessionKey: string;
        character?: string;
        world?: string;
        replyProcessors?: unknown[];
        /** 下游实例 id；'' = 清除会话级设置，继承全局 */
        backendId?: SessionBackendDto | '';
        reset?: boolean;
    }) =>
        request<{ ok: boolean; sessionKey: string; resolved?: { backendId: string; inherited: boolean } }>(
            `/sessions/${encodeURIComponent(payload.sessionKey)}`,
            { method: 'POST', body: JSON.stringify(payload) },
        ),

    // ---------------- 触发规则 ----------------
    trigger: () => request<{ ok: boolean; trigger: Record<string, unknown>; maxMessageLength: number }>('/trigger'),

    updateTrigger: (payload: { trigger?: Record<string, unknown>; maxMessageLength?: number }) =>
        request<{ ok: boolean; trigger: Record<string, unknown> }>('/trigger', {
            method: 'POST',
            body: JSON.stringify(payload),
        }),

    // ---------------- 下游 ----------------
    downstreams: () =>
        request<{
            ok: boolean;
            defaultDownstreamId: string;
            registered: Array<{ id: string; kind: string; name: string; enabled: boolean; settings: Record<string, unknown> }>;
            status: DownstreamStatusDto[];
            kinds: Array<{ kind: string; label: string; description: string }>;
        }>('/downstreams'),

    saveDownstream: (payload: {
        id: string;
        kind: string;
        name?: string;
        enabled?: boolean;
        settings?: Record<string, unknown>;
        /** 准入名单：控制哪些 QQ 可用 */
        access?: { allow: number[]; deny: number[] };
    }) =>
        request<{ ok: boolean; error?: string; downstream: unknown; status: DownstreamStatusDto[] }>('/downstreams', {
            method: 'POST',
            body: JSON.stringify(payload),
        }),

    deleteDownstream: (id: string) =>
        request<{ ok: boolean; error?: string }>(`/downstreams/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    setDefaultDownstream: (id: string) =>
        request<{ ok: boolean; defaultDownstreamId: string }>('/downstreams/default', {
            method: 'POST',
            body: JSON.stringify({ id }),
        }),

    testDownstream: (id: string, payload: { text?: string; sessionKey?: string } = {}) =>
        request<{ ok: boolean; text: string; elapsedMs: number; error?: string; sessionKey: string }>(
            `/downstreams/${encodeURIComponent(id)}/test`,
            { method: 'POST', body: JSON.stringify(payload) },
        ),

    resetDownstream: (id: string, payload: { sessionKey?: string; all?: boolean; removeWorkDir?: boolean } = {}) =>
        request<{ ok: boolean; cleared?: number; existed?: boolean }>(
            `/downstreams/${encodeURIComponent(id)}/reset`,
            { method: 'POST', body: JSON.stringify(payload) },
        ),

    // ---------------- 预览 ----------------
    testSegmentation: (text: string, config: Record<string, unknown>) =>
        request<{ ok: boolean; segments: Array<{ text: string; delayMs: number }> }>('/test-segments', {
            method: 'POST',
            body: JSON.stringify({ text, config }),
        }),

    testPipeline: (text: string, rules: unknown[]) =>
        request<{ ok: boolean; input: string; output: string }>('/test-pipeline', {
            method: 'POST',
            body: JSON.stringify({ text, rules }),
        }),
    // ---------------- 上游本体管理 ----------------
    discoverSnowLuma: (known?: string) =>
        request<SnowLumaDiscoverResult>(
            '/snowluma/discover' + (known ? '?known=' + encodeURIComponent(known) : ''),
        ),

    probeSnowLuma: (dir: string, webuiPort?: number) =>
        request<SnowLumaProbe>(
            '/snowluma/probe?dir=' + encodeURIComponent(dir) + (webuiPort ? '&port=' + webuiPort : ''),
        ),

    applySnowLuma: (payload: {
        dir: string;
        uin: string;
        port?: number;
        webuiPort?: number;
        host?: string;
        forceToken?: boolean;
    }) =>
        request<SnowLumaApplyResult>('/snowluma/apply', {
            method: 'POST',
            body: JSON.stringify(payload),
        }),

    readSnowLumaConfig: (uin: string, dir?: string) =>
        request<{ ok: boolean; exists: boolean; path: string; config: unknown }>(
            '/snowluma/config?uin=' + encodeURIComponent(uin) + (dir ? '&dir=' + encodeURIComponent(dir) : ''),
        ),

    // ---------------- 下游本体管理 ----------------
    discoverSillyTavern: (known?: string) =>
        request<SillyTavernDiscoverResult>(
            '/sillytavern/discover' + (known ? '?known=' + encodeURIComponent(known) : ''),
        ),

    probeSillyTavern: (dir: string, port?: number) =>
        request<SillyTavernProbe>(
            '/sillytavern/probe?dir=' + encodeURIComponent(dir) + (port ? '&port=' + port : ''),
        ),

    installSillyTavernExtension: (payload: { dir: string; force?: boolean }) =>
        request<ExtensionInstallResult>('/sillytavern/install', {
            method: 'POST',
            body: JSON.stringify(payload),
        }),

    uninstallSillyTavernExtension: (dir: string) =>
        request<ExtensionInstallResult>('/sillytavern/uninstall', {
            method: 'POST',
            body: JSON.stringify({ dir }),
        }),

    refreshCatalog: () =>
        request<{ ok: boolean; catalogs: CatalogDto }>('/catalog/refresh'),
};
