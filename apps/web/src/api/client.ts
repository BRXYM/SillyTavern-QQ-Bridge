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

/**
 * 下游的一个命名配置。
 *
 * 同一台 dsh 可以有多份（不同人设/不同 profile），
 * 同一个酒馆可以有多份（不同角色卡）。会话选中其中之一。
 */
export interface DownstreamProfileDto {
    id: string;
    name: string;
    /** 只写与实例设置的差异；未出现的键沿用实例设置 */
    settings: Record<string, unknown>;
}

/**
 * 下游的行为设置（提示词 / 历史引用 / 进度转发）。
 *
 * 这些描述「下游怎么说话」，与「怎么连上它」分开：
 * 连接属于实例（下游管理页），行为属于配置（会话页）。
 */
export interface BehaviorDto {
    prompt: {
        qqBase: boolean;
        character: boolean;
        faces: boolean;
        images: boolean;
        extra: string;
    };
    historyExtracts: Array<{ pattern: string; flags?: string; label?: string }>;
    progress: {
        enabled: boolean;
        minIntervalMs: number;
        maxMessages: number;
        kinds?: string[];
        prefix: string;
    };
}

export interface SessionChoiceDto {
    conversationId?: string;
    character?: string;
    world?: string;
    replyProcessors?: unknown[];
    /** 会话级下游实例 id；缺失 = 继承全局 defaultDownstreamId */
    backendId?: string;
    /** 会话级下游配置 id；缺失 = 继承全局默认配置 */
    profileId?: string;
    createdAt?: string;
    updatedAt?: string;
}

/** 会话实际生效的下游实例 id */
export type SessionBackendDto = string;

/** 单个账号的运行时状态 */
export interface AccountStatusDto {
    id: string;
    uin: string;
    name: string;
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

/** 一个上游账号的配置 */
export interface AccountConfigDto {
    id: string;
    uin: string;
    name: string;
    enabled: boolean;
    upstream: {
        url: string;
        token: string;
        reconnectMs: number;
        actionTimeoutMs: number;
    };
}

export interface CatalogDto {
    characters: string[];
    worlds: string[];
    updatedAt: string | null;
}

export interface StatusDto {
    /** 聚合视图：任一账号在线即为在线 */
    onebotConnected: boolean;
    stClients: number;
    selfId: string;
    sessions: Record<string, SessionStat>;
    sessionChoices: Record<string, SessionChoiceDto>;
    /** 每个会话实际生效的下游：{ key: { backendId, inherited, profileId } } */
    sessionBackends?: Record<
        string,
        { backendId: SessionBackendDto; inherited: boolean; profileId?: string }
    >;
    /** 下游实例与状态 */
    downstreams?: DownstreamStatusDto[];
    defaultDownstreamId?: string;
    defaultDownstreamProfileId?: string;
    /** 每个上游账号的明细 */
    accounts?: AccountStatusDto[];
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

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
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
    /** 每个账号的 OneBot 端口与监听状态（多号时用这个） */
    accountPorts?: Array<{
        id: string;
        uin: string;
        port: number;
        listening: boolean;
        enabled: boolean;
    }>;
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
    /** 写入的账号 id */
    accountId?: string;
    createdAccount?: boolean;
    changed: boolean;
    created: boolean;
    path: string;
    token: string;
    endpoint: string;
    /** 本次分配的 OneBot 端口 */
    port?: number;
    /** 与该号撞了同一端点的其他账号（正常应为空） */
    conflicts?: string[];
    /** true = 配置已写入但 SnowLuma 仍在跑旧配置，必须重启才生效 */
    restartRequired?: boolean;
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
                resolved: {
                    backendId: string;
                    inherited: boolean;
                    profileId: string;
                    profileInherited: boolean;
                    character: string;
                    world: string;
                };
            }>;
        }>('/sessions'),

    updateSession: (payload: {
        conversationId?: string | null;
        sessionKey: string;
        character?: string;
        world?: string;
        replyProcessors?: unknown[];
        /** 下游实例 id；'' = 清除会话级设置，继承全局 */
        backendId?: SessionBackendDto | '';
        /** 下游配置 id；'' = 清除会话级配置，继承默认配置 */
        profileId?: string;
        reset?: boolean;
    }) =>
        request<{
            ok: boolean;
            sessionKey: string;
            resolved?: {
                backendId: string;
                inherited: boolean;
                profileId: string;
                profileInherited: boolean;
            };
        }>(
            `/sessions/${encodeURIComponent(payload.sessionKey)}`,
            { method: 'POST', body: JSON.stringify(payload) },
        ),

    // ---------------- 会话准入（黑白名单） ----------------
    sessionAccess: () =>
        request<{
            ok: boolean;
            access: {
                denyUsers: number[];
                denyGroups: number[];
                allowUsers: number[];
                allowGroups: number[];
                unknownPolicy: 'allow' | 'deny';
                denyReply: string;
            };
            /** 被拒的新会话记录 */
            pending: Record<string, {
                userId: number;
                groupId: number | null;
                messageType: string;
                senderName: string;
                lastAt: string;
            }>;
        }>('/session-access'),

    updateSessionAccess: (payload: {
        access: {
            denyUsers?: number[];
            denyGroups?: number[];
            allowUsers?: number[];
            allowGroups?: number[];
            unknownPolicy?: 'allow' | 'deny';
            denyReply?: string;
        };
    }) =>
        request<{ ok: boolean; access: Record<string, unknown> }>('/session-access', {
            method: 'POST',
            body: JSON.stringify(payload),
        }),

    // ---------------- 触发规则 ----------------
    trigger: () => request<{ ok: boolean; trigger: Record<string, unknown>; maxMessageLength: number }>('/trigger'),

    updateTrigger: (payload: { trigger?: Record<string, unknown>; maxMessageLength?: number }) =>
        request<{ ok: boolean; trigger: Record<string, unknown> }>('/trigger', {
            method: 'POST',
            body: JSON.stringify(payload),
        }),

    // ---------------- 上游账号 ----------------
    accounts: () =>
        request<{
            ok: boolean;
            accounts: Array<AccountConfigDto & {
                running: boolean;
                connected: boolean;
                selfId: string;
                nickname: string;
                lastError: string;
            }>;
        }>('/accounts'),

    saveAccount: (payload: AccountConfigDto) =>
        request<{ ok: boolean; account: AccountConfigDto }>('/accounts', {
            method: 'POST',
            body: JSON.stringify(payload),
        }),

    deleteAccount: (id: string) =>
        request<{ ok: boolean; removedSessions: number }>(
            `/accounts/${encodeURIComponent(id)}`,
            { method: 'DELETE' },
        ),

    // ---------------- 下游 ----------------
    downstreams: () =>
        request<{
            ok: boolean;
            defaultDownstreamId: string;
            defaultDownstreamProfileId: string;
            registered: Array<{
                id: string;
                kind: string;
                name: string;
                enabled: boolean;
                settings: Record<string, unknown>;
                profiles?: DownstreamProfileDto[];
            }>;
            status: DownstreamStatusDto[];
            kinds: Array<{ kind: string; label: string; description: string }>;
        }>('/downstreams'),

    saveDownstream: (payload: {
        id: string;
        kind: string;
        name?: string;
        enabled?: boolean;
        settings?: Record<string, unknown>;
        profiles?: DownstreamProfileDto[];
    }) =>
        request<{ ok: boolean; error?: string; downstream: unknown; status: DownstreamStatusDto[] }>('/downstreams', {
            method: 'POST',
            body: JSON.stringify(payload),
        }),

    deleteDownstream: (id: string) =>
        request<{ ok: boolean; error?: string; affectedSessions?: number }>(
            `/downstreams/${encodeURIComponent(id)}`,
            { method: 'DELETE' },
        ),

    setDefaultDownstream: (id: string, profileId?: string) =>
        request<{ ok: boolean; defaultDownstreamId: string; defaultDownstreamProfileId?: string }>(
            '/downstreams/default',
            {
                method: 'POST',
                body: JSON.stringify(profileId === undefined ? { id } : { id, profileId }),
            },
        ),

    // ---------------- 下游命名配置 ----------------
    downstreamProfiles: (id: string) =>
        request<{
            ok: boolean;
            downstreamId: string;
            kind?: string;
            profiles: DownstreamProfileDto[];
            /** 实例自身设置，作为配置表单的基线 */
            settings: Record<string, unknown>;
            /**
             * 每份配置**实际生效**的行为设置（实例 + 配置合并后）。
             * 前端直接用它渲染表单，不再自己算一遍合并。
             */
            behaviors?: Record<string, BehaviorDto>;
            /** 不选配置时（纯实例设置）的行为 */
            defaultBehavior?: BehaviorDto;
        }>(`/downstreams/${encodeURIComponent(id)}/profiles`),

    saveDownstreamProfile: (
        id: string,
        payload: { id: string; name?: string; settings?: Record<string, unknown> },
    ) =>
        request<{ ok: boolean; profile: DownstreamProfileDto; created: boolean }>(
            `/downstreams/${encodeURIComponent(id)}/profiles`,
            { method: 'POST', body: JSON.stringify(payload) },
        ),

    deleteDownstreamProfile: (id: string, profileId: string) =>
        request<{ ok: boolean; affectedSessions?: number }>(
            `/downstreams/${encodeURIComponent(id)}/profiles/${encodeURIComponent(profileId)}`,
            { method: 'DELETE' },
        ),

    testDownstream: (id: string, payload: { text?: string; sessionKey?: string; profileId?: string } = {}) =>
        request<{
            ok: boolean;
            text: string;
            elapsedMs: number;
            error?: string;
            sessionKey: string;
            profileId?: string;
        }>(
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

    // ---------------- QQ 进程自动注入 ----------------
    /** 读取 SnowLuma 的自动注入状态 */
    snowlumaHook: () =>
        request<{
            ok: boolean;
            configured: boolean;
            found?: boolean;
            dir?: string;
            runtimePath?: string;
            hasWebuiConfig?: boolean;
            webuiPort?: number;
            hookAutoLoad?: boolean;
            error?: string;
        }>('/snowluma/hook'),

    /** 开启 / 关闭自动注入（需重启 SnowLuma 生效） */
    setSnowlumaHook: (enabled: boolean) =>
        request<{
            ok: boolean;
            runtimePath?: string;
            before?: boolean;
            after?: boolean;
            backup?: string;
            needsRestart?: boolean;
        }>('/snowluma/hook', {
            method: 'POST',
            body: JSON.stringify({ enabled }),
        }),

    /** 从备份还原 runtime.json */
    restoreSnowlumaHook: () =>
        request<{ ok: boolean; runtimePath?: string; needsRestart?: boolean }>('/snowluma/hook/restore', {
            method: 'POST',
            body: '{}',
        }),

    refreshCatalog: () =>
        request<{ ok: boolean; catalogs: CatalogDto }>('/catalog/refresh'),
};
