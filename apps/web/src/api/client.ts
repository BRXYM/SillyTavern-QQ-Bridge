/**
 * 后端 API 客户端。
 * 开发时通过 Vite 代理访问 :9510；生产时同源。
 */

export interface SessionStat {
    in: number;
    out: number;
    last: number;
}

/** 上游（SnowLuma / OneBot）连接详情 */
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

/** 下游（酒馆扩展）连接详情 */
export interface ExtensionClient {
    id: number;
    ext: string;
    version: string;
    connectedAt: number | null;
    connectedForSec: number;
    lastPingAt: number | null;
}

export interface ExtensionStatus {
    port: number;
    clientCount: number;
    clients: ExtensionClient[];
}

export interface RuntimeMetrics {
    sessionCount: number;
    totalIn: number;
    totalOut: number;
    lastActiveAt: number | null;
    characterCount: number;
    worldCount: number;
}

export interface ProcessInfo {
    pid: number;
    nodeVersion: string;
    platform: string;
    arch: string;
    uptimeSec: number;
    startedAt: number;
    rssMb: number;
    heapUsedMb: number;
    heapTotalMb: number;
    externalMb: number;
    /** 后端源码版本：改动代码后如果这个值没变，说明进程还是旧的 */
    codeVersion?: string;
    /** 后端入口文件最后修改时间（秒级） */
    codeMtime?: number;
}

export interface SessionChoiceDto {
    character?: string;
    world?: string;
    replyProcessors?: unknown[];
    /** 会话级后端；缺失 = 继承全局 cfg.backend */
    backend?: 'taver' | 'dsh';
    createdAt?: string;
    updatedAt?: string;
}

/** 会话实际生效的后端（含继承信息） */
export type SessionBackendDto = 'taver' | 'dsh';

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
    /** 每个会话实际生效的后端：{ key: { backend, inherited } } */
    sessionBackends?: Record<string, { backend: SessionBackendDto; inherited: boolean }>;
    catalogs: CatalogDto;
    config: Record<string, unknown>;
    // 新增详细状态（后端可能先于前端升级，故设为可选）
    generatedAt?: number;
    upstream?: UpstreamStatus;
    extension?: ExtensionStatus;
    metrics?: RuntimeMetrics;
    process?: ProcessInfo;
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
        /** 'taver' / 'dsh' = 会话级；'' = 清除会话级设置，继承全局 */
        backend?: SessionBackendDto | '';
        reset?: boolean | 'pipeline';
    }) =>
        request<{
            ok: boolean;
            sessions: Record<string, SessionChoiceDto>;
            sessionBackends?: Record<string, { backend: SessionBackendDto; inherited: boolean }>;
        }>('/session-choice', {
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

    // ---- SnowLuma 服务集成 ----
    discoverSnowLuma: (known?: string) =>
        request<SnowLumaDiscoverResult>(
            '/snowluma/discover' + (known ? '?known=' + encodeURIComponent(known) : ''),
        ),

    probeSnowLuma: (dir: string, webuiPort?: number) =>
        request<SnowLumaProbe>(
            '/snowluma/probe?dir=' + encodeURIComponent(dir) +
                (webuiPort ? '&port=' + webuiPort : ''),
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
            '/snowluma/config?uin=' + encodeURIComponent(uin) +
                (dir ? '&dir=' + encodeURIComponent(dir) : ''),
        ),

    // ---- SillyTavern 服务集成 ----
    discoverSillyTavern: (known?: string) =>
        request<SillyTavernDiscoverResult>(
            '/sillytavern/discover' + (known ? '?known=' + encodeURIComponent(known) : ''),
        ),

    probeSillyTavern: (dir: string, port?: number) =>
        request<SillyTavernProbe>(
            '/sillytavern/probe?dir=' + encodeURIComponent(dir) +
                (port ? '&port=' + port : ''),
        ),

    installSillyTavernExtension: (payload: { dir: string; force?: boolean }) =>
        request<{
            ok: boolean;
            action: 'installed' | 'updated' | 'unchanged';
            target: string;
            version: string;
            files: string[];
            needRefresh: boolean;
            sourceDir: string;
            error?: string;
        }>('/sillytavern/install', {
            method: 'POST',
            body: JSON.stringify(payload),
        }),

    uninstallSillyTavernExtension: (dir: string) =>
        request<{ ok: boolean; action: string; needRefresh: boolean; error?: string }>(
            '/sillytavern/uninstall',
            { method: 'POST', body: JSON.stringify({ dir }) },
        ),
};

/** 自动发现结果 */
export interface SnowLumaDiscoverResult {
    found: boolean;
    dir: string;
    source: string;
    candidates: Array<{
        dir: string;
        source: string;
        ok: boolean;
        version: string;
        mode: string;
        accounts: string[];
    }>;
    tried: string[];
    error?: string;
}

/** SnowLuma 目录探测结果 */
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
    onebotPortListening: boolean;
    onebotPort: number;
    alternatives: Array<{
        mode: string;
        configDir: string;
        dataDir: string;
        onebotFiles: number;
        accounts: number;
    }>;
}

/** 一键配置结果 */
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

/** 酒馆自动发现结果 */
export interface SillyTavernDiscoverResult {
    found: boolean;
    dir: string;
    source: string;
    candidates: Array<{
        dir: string;
        source: string;
        ok: boolean;
        installed: boolean;
        installedVersion: string;
    }>;
    tried: string[];
    error?: string;
}

/** 酒馆探测结果 */
export interface SillyTavernProbe {
    ok: boolean;
    dir: string;
    extDir: string;
    installed: boolean;
    installedVersion: string;
    /** 酒馆主程序版本 */
    version: string;
    files: string[];
    error: string;
    port: number;
    endpoint: string;
    running: boolean;
    extConnected: boolean;
    extPort: number;
}
