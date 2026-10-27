/**
 * dsh（DeepSeek Harness）接入 API 客户端。
 *
 * 用途：让 QQ ↔ dsh 直连，作为酒馆之外的另一条后端链路。
 * 两条链路共用触发规则（群聊 @、私聊开关、白名单）与回复处理管道。
 */

/** 一个有上下文的 dsh 会话 */
export interface DshSession {
    sessionKey: string;
    messages: number;
    turns: number;
    updatedAt: string | null;
}

export interface DshConfig {
    profile: string;
    workRoot: string;
    timeoutMs: number;
    historyTurns: number;
    /** 追加到内置提示词之后的人设 / 约束 */
    systemPrompt: string;
    /** 调用失败时回给 QQ 的提示；空字符串 = 静默 */
    errorReply: string;
    /** 上下文是否落盘（重启后仍能续聊） */
    persistHistory: boolean;
    /** 同时最多跑几个 dsh 进程 */
    concurrency: number;
    /** 常驻服务的 profile（web / desktop / 自定义） */
    serviceProfile: string;
    /** 常驻服务的 HTTP 端口 */
    servicePort: number;
    /** 常驻服务日志路径（留空 = 系统临时目录） */
    serviceLogFile: string;
    /** 连接插件握手 token（留空不校验） */
    pluginToken: string;
    /** 是否允许插件链路（关闭后一律走 headless） */
    pluginEnabled: boolean;
}

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

/** profile 及其已登记的 bundle 列表 */
export interface DshProfileInfo {
    profile: string;
    dir: string;
    bundles: string[];
    patchReload: string;
}

/** 连接插件注入状态 */
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
    config: { url: string; token: string; cwdRoot: string };
    enabled: boolean;
    profiles: DshProfileInfo[];
    injection: DshPluginInjection;
    clients: Array<{ pid: number; profile: string; version: string; connectedAt: number | null }>;
    online: boolean;
    error?: string;
}

export interface DshStatus {
    ok: boolean;
    installed: boolean;
    /** 实际使用的可执行文件（探测 / 配置合并后的结果） */
    exePath: string;
    /** 用户手动填写的路径，空 = 自动探测 */
    configuredExePath: string;
    source: string;
    version: string;
    home: string;
    profiles: string[];
    /** 当前后端：taver=酒馆 / dsh=DeepSeek Harness */
    backend: 'taver' | 'dsh';
    config: DshConfig;
    runtime: {
        installed: boolean;
        exePath: string;
        /** 手填路径不存在时 true（已回落到自动探测结果） */
        configuredMissing: boolean;
        profile: string;
        workRoot: string;
        home: string;
        profiles: string[];
        version: string;
        historyFile: string;
        sessionCount: number;
    } | null;
    /** 运行中的 dsh 进程与排队情况 */
    load: {
        running: number;
        waiting: number;
        concurrency: number;
        maxQueue: number;
    } | null;
    /** 当前有上下文的会话（按最近活跃排序） */
    sessions: DshSession[];
    /** 常驻服务状态 */
    service?: DshServiceStatus;
    /** 连接插件状态 */
    plugin?: DshPluginStatus;
}

export interface DshAskResult {
    ok: boolean;
    text: string;
    elapsedMs: number;
    error?: string;
    sessionKey?: string;
}

export interface DshServiceActionResult {
    ok: boolean;
    action: string;
    result?: {
        ok: boolean;
        alreadyRunning?: boolean;
        pid?: number;
        url?: string;
        action?: string;
        stage?: string;
        error?: string;
        logTail?: string[];
    };
    error?: string;
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
    /** 探测安装与配置；fresh=true 跳过后端 60s 缓存 */
    status: (fresh = false) => req<DshStatus>(`/dsh/status${fresh ? '?fresh=1' : ''}`),

    /** 发一句话测试连通性与耗时（走独立的 _test 会话） */
    test: (payload: { text?: string; sessionKey?: string; useHistory?: boolean } = {}) =>
        req<DshAskResult>('/dsh/test', { method: 'POST', body: JSON.stringify(payload) }),

    /** 切换后端 */
    setBackend: (backend: 'taver' | 'dsh') =>
        req<{ ok: boolean; backend: string }>('/dsh/backend', {
            method: 'POST',
            body: JSON.stringify({ backend }),
        }),

    /** 更新 dsh 参数（含常驻服务与插件参数） */
    setConfig: (payload: {
        exePath?: string;
        profile?: string;
        workRoot?: string;
        timeoutMs?: number;
        historyTurns?: number;
        systemPrompt?: string;
        errorReply?: string;
        persistHistory?: boolean;
        concurrency?: number;
        serviceProfile?: string;
        servicePort?: number;
        serviceLogFile?: string;
        pluginToken?: string;
        pluginEnabled?: boolean;
    }) =>
        req<{ ok: boolean; config: DshConfig }>('/dsh/config', {
            method: 'POST',
            body: JSON.stringify(payload),
        }),

    /** 清空某会话上下文；不传 sessionKey 时传 all=true 清空全部 */
    reset: (payload: { sessionKey?: string; removeWorkDir?: boolean; all?: boolean }) =>
        req<{ ok: boolean; sessionKey?: string; existed?: boolean; cleared?: number; sessions: DshSession[] }>(
            '/dsh/reset',
            { method: 'POST', body: JSON.stringify(payload) },
        ),

    // ---------------- 常驻服务 ----------------
    service: () => req<DshServiceStatus & { ok: boolean }>('/dsh/service'),

    serviceAction: (action: 'start' | 'stop' | 'restart') =>
        req<DshServiceActionResult & DshServiceStatus>(`/dsh/service/${action}`, {
            method: 'POST',
            body: JSON.stringify({}),
        }),

    // ---------------- 连接插件 ----------------
    plugin: () => req<DshPluginStatus>('/dsh/plugin'),

    /** 把连接插件注入到 profile（可选校验 + 顺带重启服务） */
    pluginInject: (payload: {
        profile?: string;
        token?: string;
        cwdRoot?: string;
        verify?: boolean;
        restart?: boolean;
    } = {}) =>
        req<{
            ok: boolean;
            inject: {
                ok: boolean;
                action: string;
                target: string;
                profileDir: string;
                files: number;
                error: string;
                injection: DshPluginInjection;
            };
            verified: { ok: boolean; present?: boolean; error: string } | null;
            restart: { ok: boolean; error?: string; stage?: string } | null;
            plugin: DshPluginStatus;
            service: DshServiceStatus;
        }>('/dsh/plugin/inject', { method: 'POST', body: JSON.stringify(payload) }),

    pluginRemove: (payload: { profile?: string; restart?: boolean } = {}) =>
        req<{
            ok: boolean;
            remove: { ok: boolean; action: string; error: string };
            restart: { ok: boolean; error?: string } | null;
            plugin: DshPluginStatus;
        }>('/dsh/plugin/remove', { method: 'POST', body: JSON.stringify(payload) }),

    /** 让插件释放会话（不传 sessionKey = 全部） */
    pluginReset: (payload: { sessionKey?: string; removeWorkDir?: boolean } = {}) =>
        req<{ ok: boolean; sent: number; sessions: string[] }>('/dsh/plugin/reset', {
            method: 'POST',
            body: JSON.stringify(payload),
        }),
};
