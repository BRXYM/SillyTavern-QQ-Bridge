/**
 * dsh（DeepSeek Harness）管理 API 客户端。
 *
 * 只覆盖「dsh 进程本身」的管理：环境探测、常驻服务、连接插件。
 * 消息该怎么走由「下游管理」负责（apps/web/src/api/client.ts 的 downstreams）。
 */

/** dsh 常驻服务状态 */
export interface DshServiceStatus {
    profile: string;
    host: string;
    port: number;
    url: string;
    running: boolean;
    pid: number;
    lastPid: number;
    logFile: string;
    lastError: string;
    logTail: string[];
}

export interface DshPluginInjection {
    profile: string;
    profileDir: string;
    profileExists: boolean;
    installed: boolean;
    inBundles: boolean;
    hasPatchRow: boolean;
    pluginDir: string;
    version: string;
    config: { url: string; token: string; cwdRoot: string } | null;
    error: string;
}

export interface DshPluginStatus {
    ok: boolean;
    sourceDir: string;
    sourceExists: boolean;
    pluginName: string;
    rowId: string;
    targetDir: string;
    url: string;
    profile: string;
    config: {
        url: string;
        token: string;
        cwdRoot: string;
        downstreamId?: string;
        consolePort?: number;
    };
    profiles: Array<{ profile: string; dir: string; bundles: string[]; patchReload: string }>;
    injection: DshPluginInjection;
    /** 在线插件连接 */
    clients: Array<{ pid: number; profile: string; version: string; connectedAt: number | null }>;
    online: boolean;
}

export interface DshStatus {
    ok: boolean;
    installed: boolean;
    exePath: string;
    configuredExePath: string;
    source: string;
    version: string;
    home: string;
    profiles: string[];
    settings: Record<string, unknown>;
    service: DshServiceStatus;
    plugin?: DshPluginStatus;
    /** 本机所有可用安装（桌面版优先） */
    installations?: Array<{ path: string; source: string; version: string }>;
    /** 目录自检；正常为 null */
    homeCheck?: { home: string; reason: string; hint: string } | null;
}

/** 一键安装的返回：带阶段与可直接展示的结论 */
export interface DshInstallResult {
    ok: boolean;
    /** precheck / inject / restart-failed / installed / online */
    stage?: 'precheck' | 'inject' | 'restart-failed' | 'installed' | 'online';
    error?: string;
    message?: string;
    online?: boolean;
    inject?: {
        ok: boolean;
        action: string;
        target: string;
        profileDir: string;
        files: number;
        error: string;
        injection: DshPluginInjection;
    };
    verified?: { ok: boolean; present?: boolean; error: string } | null;
    restart?: { ok: boolean; error?: string } | null;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
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

export const dshApi = {
    /** 环境探测；fresh=true 跳过后端 60s 缓存 */
    status: (fresh = false) => req<DshStatus>(`/dsh/status${fresh ? '?fresh=1' : ''}`),

    // ---------------- 常驻服务 ----------------
    service: () => req<DshServiceStatus & { ok: boolean }>('/dsh/service'),

    serviceAction: (action: 'start' | 'stop' | 'restart') =>
        req<DshServiceStatus & { ok: boolean; action: string; error?: string }>(
            `/dsh/service/${action}`,
            { method: 'POST', body: '{}' },
        ),

    // ---------------- 连接插件 ----------------
    plugin: () => req<DshPluginStatus>('/dsh/plugin'),

    /**
     * 一键安装连接插件。
     *
     * 服务端会依次做：检查源码 → 复制插件 → 写 bundles 与 patch →
     * 用 --dump-config 校验 → 重启 dsh → 等待插件连上来。
     */
    installPlugin: (payload: {
        profile?: string;
        token?: string;
        cwdRoot?: string;
        verify?: boolean;
        restart?: boolean;
        waitOnline?: boolean;
    } = {}) =>
        req<DshInstallResult>('/dsh/plugin/inject', {
            method: 'POST',
            body: JSON.stringify(payload),
        }),

    removePlugin: (payload: { profile?: string; restart?: boolean } = {}) =>
        req<{
            ok: boolean;
            remove: { ok: boolean; action: string; error: string };
            restart: { ok: boolean; error?: string } | null;
        }>('/dsh/plugin/remove', { method: 'POST', body: JSON.stringify(payload) }),
};
