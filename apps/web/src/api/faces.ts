/**
 * 表情库 API 客户端。
 */

export interface FaceTagInfo {
    tag: string;
    ai: number;
    user: number;
    total: number;
}

export interface FaceItem {
    md5: string;
    emojiId: string;
    url: string;
    /** 本地缓存路径（可能为空） */
    localFile: string;
    /** 展示用地址：优先后端缓存 */
    imageUrl: string;
    /** AI 生成的原始描述 */
    caption: string;
    /** AI 标签：重新识别时整体替换 */
    aiTags: string[];
    /** 用户自定义标签：永不自动删除 */
    userTags: string[];
    /** 合并后的标签（只读展示） */
    tags: string[];
    source: string;
    labeledAt: string | null;
    labelModel: string;
    labelError: string;
    createdAt: string;
    updatedAt: string;
}

export interface FaceListResult {
    ok: boolean;
    total: number;
    page: number;
    pageSize: number;
    items: FaceItem[];
    stats: FaceStats;
}

export interface FaceStats {
    total: number;
    labeled: number;
    unlabeled: number;
    withUserTags: number;
    cached: number;
    failed: number;
}

export interface FaceProgress {
    ok: boolean;
    running: boolean;
    total: number;
    done: number;
    failed: number;
    queued: number;
    percent: number;
    current: string;
    phase: string;
    startedAt: string | null;
    finishedAt: string | null;
    lastError: string;
    sync: {
        running: boolean;
        lastAt: string | null;
        lastError: string;
        lastResult: unknown;
    };
}

export interface FaceDiagnostics {
    ok: boolean;
    ollama: {
        baseUrl: string;
        reachable: boolean;
        error: string;
        models: string[];
        visionModel: string;
        textModel: string;
        modelReady: boolean;
    };
    store: FaceStats;
    job: FaceProgress;
    dataDir: string;
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

export const facesApi = {
    list: (opts: { tag?: string; keyword?: string; page?: number; pageSize?: number } = {}) => {
        const p = new URLSearchParams();
        if (opts.tag) p.set('tag', opts.tag);
        if (opts.keyword) p.set('keyword', opts.keyword);
        if (opts.page) p.set('page', String(opts.page));
        if (opts.pageSize) p.set('pageSize', String(opts.pageSize));
        const q = p.toString();
        return req<FaceListResult>(`/faces${q ? `?${q}` : ''}`);
    },

    tags: () =>
        req<{ ok: boolean; tags: FaceTagInfo[]; stats: FaceStats }>('/faces/tags'),

    sync: () => req<{ ok: boolean; added: number; updated: number; total: number; downloaded: number }>(
        '/faces/sync',
        { method: 'POST', body: '{}' },
    ),

    startLabel: (opts: { all?: boolean; limit?: number } = {}) =>
        req<{ ok: boolean; total: number; error?: string }>('/faces/label', {
            method: 'POST',
            body: JSON.stringify(opts),
        }),

    stopLabel: () =>
        req<{ ok: boolean; dropped: number }>('/faces/label/stop', {
            method: 'POST',
            body: '{}',
        }),

    progress: () => req<FaceProgress>('/faces/progress'),

    diagnostics: () => req<FaceDiagnostics>('/faces/diagnostics'),

    /** 全量替换用户标签 */
    setUserTags: (md5: string, tags: string[]) =>
        req<{ ok: boolean }>('/faces/tags', {
            method: 'POST',
            body: JSON.stringify({ md5, tags }),
        }),

    resolve: (tag: string) =>
        req<{ ok: boolean; face: FaceItem }>(`/faces/resolve?tag=${encodeURIComponent(tag)}`),

    /** 把表情图片保存到本地运行目录 */
    save: (payload: { md5?: string; md5s?: string[]; dir?: string }) =>
        req<{
            ok: boolean;
            dir: string;
            saved: number;
            failed: number;
            files: Array<{ md5: string; file: string }>;
            errors: Array<{ md5: string; error: string }>;
        }>('/faces/save', {
            method: 'POST',
            body: JSON.stringify(payload),
        }),
};
