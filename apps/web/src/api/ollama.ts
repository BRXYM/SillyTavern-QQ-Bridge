/**
 * Ollama 管理 API 客户端。
 *
 * 定位：只管调用本机已安装的 Ollama，不负责安装。
 * 模型名由前端填写，因此后端不做白名单校验。
 */

export interface OllamaRunningModel {
    name: string;
    sizeBytes: number;
    /** 实际占用显存 */
    sizeVramBytes: number;
    expiresAt: string | null;
    digest: string;
}

export interface OllamaModel {
    name: string;
    sizeBytes: number;
    family: string;
    parameterSize: string;
    quantization: string;
    format: string;
    contextLength: number;
    capabilities: string[];
    modifiedAt: string | null;
    /** 是否已加载到内存/显存 */
    loaded: boolean;
    running: OllamaRunningModel | null;
}

export interface OllamaDaemonStatus {
    exePath: string;
    /** exePath 由自动探测得到（而非用户填写） */
    exeGuessed: boolean;
    exeExists: boolean;
    /** Bridge 是否持有该进程句柄 */
    managed: boolean;
    /** 是否由 Bridge 启动 */
    startedByUs: boolean;
    lastError: string;
    modelsDir: string;
    /** 模型目录来源：config 配置 / env 环境变量 / default 默认 */
    modelsDirSource?: 'config' | 'env' | 'default';
}

export interface OllamaPullJob {
    running: boolean;
    model: string;
    status: string;
    percent: number;
    completed: number;
    total: number;
    startedAt: string | null;
    finishedAt: string | null;
    error: string;
}

export interface OllamaStatus {
    ok: boolean;
    online: boolean;
    version: string;
    error: string;
    baseUrl: string;
    visionModel: string;
    textModel: string;
    daemon: OllamaDaemonStatus;
    running: OllamaRunningModel[];
    /** 服务上报的模型数量 */
    modelCount?: number;
    /** 磁盘上实际存在的模型数量 */
    diskModelCount?: number;
    /** 服务看不到磁盘上的模型（模型目录未生效） */
    envMismatch?: boolean;
    pull: OllamaPullJob;
}

export interface OllamaModelDetail {
    ok: boolean;
    name: string;
    family: string;
    parameterSize: string;
    quantization: string;
    format: string;
    contextLength: number;
    capabilities: string[];
    license: string;
    system: string;
}

export interface OllamaChatResult {
    ok: boolean;
    model: string;
    content: string;
    elapsedMs: number;
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

export const ollamaApi = {
    status: () => req<OllamaStatus>('/ollama/status'),

    models: () =>
        req<{ ok: boolean; baseUrl: string; models: OllamaModel[] }>('/ollama/models'),

    show: (name: string) =>
        req<OllamaModelDetail>(`/ollama/models/${encodeURIComponent(name)}/show`),

    start: () =>
        req<{ ok: boolean; alreadyRunning: boolean; version: string; daemon: OllamaDaemonStatus }>(
            '/ollama/start',
            { method: 'POST', body: '{}' },
        ),

    repair: () =>
        req<{
            ok: boolean;
            version?: string;
            modelCount?: number;
            modelsDir?: string;
            needManual?: boolean;
            error?: string;
            hint?: string;
        }>('/ollama/repair', { method: 'POST', body: '{}' }),

    stop: () =>
        req<{ ok: boolean; error?: string; daemon: OllamaDaemonStatus }>('/ollama/stop', {
            method: 'POST',
            body: '{}',
        }),

    load: (name: string, keepAlive: string | number = '30m') =>
        req<{ ok: boolean; model: string; keepAlive: string | number }>(
            `/ollama/models/${encodeURIComponent(name)}/load`,
            { method: 'POST', body: JSON.stringify({ keepAlive }) },
        ),

    unload: (name: string) =>
        req<{ ok: boolean; model: string }>(`/ollama/models/${encodeURIComponent(name)}/unload`, {
            method: 'POST',
            body: '{}',
        }),

    remove: (name: string) =>
        req<{ ok: boolean; model: string }>(`/ollama/models/${encodeURIComponent(name)}/delete`, {
            method: 'POST',
            body: '{}',
        }),

    pull: (model: string) =>
        req<{ ok: boolean; model: string; pull: OllamaPullJob }>('/ollama/pull', {
            method: 'POST',
            body: JSON.stringify({ model }),
        }),

    pullProgress: () => req<OllamaPullJob & { ok: boolean }>('/ollama/pull/progress'),

    chat: (payload: {
        model: string;
        prompt: string;
        keepAlive?: string | number;
        timeoutMs?: number;
        temperature?: number;
        numPredict?: number;
    }) =>
        req<OllamaChatResult>('/ollama/chat', {
            method: 'POST',
            body: JSON.stringify(payload),
        }),

    vision: (payload: {
        model: string;
        prompt: string;
        imagePath?: string;
        images?: string[];
        keepAlive?: string | number;
        timeoutMs?: number;
    }) =>
        req<OllamaChatResult>('/ollama/vision', {
            method: 'POST',
            body: JSON.stringify(payload),
        }),

    /**
     * 选择打标用模型 / 服务参数。
     *
     * 会持久化到配置并**立即热更新**打标器与守护进程 ——
     * 页面显示改成功了但打标还在用旧模型，是最难察觉的一类 bug。
     */
    select: (payload: {
        visionModel?: string;
        textModel?: string;
        baseUrl?: string;
        exePath?: string;
        modelsDir?: string;
    }) =>
        req<{
            ok: boolean;
            visionModel: string;
            textModel: string;
            baseUrl: string;
            exePath: string;
            modelsDir: string;
        }>(
            '/ollama/select',
            { method: 'POST', body: JSON.stringify(payload) },
        ),
};

/** 字节数转可读体积 */
export function formatBytes(bytes: number): string {
    if (!bytes || bytes < 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = bytes;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i += 1;
    }
    return `${v.toFixed(v >= 100 || i === 0 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}
