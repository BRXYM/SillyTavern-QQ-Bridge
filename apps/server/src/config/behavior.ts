/**
 * 下游「行为设置」的默认值与归一化。
 *
 * 这些设置描述「下游怎么说话」（提示词、历史引用、进度转发），
 * 与「怎么连上它」（路径、服务、插件）分开管理：
 * 连接属于实例，行为属于配置。
 *
 * 为什么需要归一化：配置可能来自手写 JSON、旧版本迁移或前端草稿，
 * 字段缺失、类型不对都可能发生。读取时收敛成固定形状，
 * 下游组装 prompt / 进度上报就不用到处判空。
 */

/** 提示词注入开关 */
export interface PromptSettings {
    /** QQ 聊天约束（简短、口语化、不要 Markdown） */
    qqBase: boolean;
    /** 会话绑定的角色人设 */
    character: boolean;
    /** 表情词表 */
    faces: boolean;
    /** 图片回复能力说明 */
    images: boolean;
    /** 自由附加文本，总是最后拼接 */
    extra: string;
}

/** 从历史里提取参考片段的规则 */
export interface HistoryExtract {
    pattern: string;
    flags?: string;
    label?: string;
}

/** 进度转发的限流参数 */
export interface ProgressSettings {
    enabled: boolean;
    /** 最少间隔（毫秒），太快会刷屏 */
    minIntervalMs: number;
    /** 最多发几条 */
    maxMessages: number;
    /** 只发这些类型的节点 */
    kinds: string[];
    /** 消息前缀 */
    prefix: string;
}

/**
 * 默认值：全部关闭。
 *
 * 这是刻意的 —— Bridge 只转发用户原话，不夹带任何自己的说明。
 * 需要时由用户在某个配置里显式打开。
 */
export const DEFAULT_PROMPT: PromptSettings = {
    qqBase: false,
    character: false,
    faces: false,
    images: false,
    extra: '',
};

export const DEFAULT_PROGRESS: ProgressSettings = {
    enabled: false,
    minIntervalMs: 4000,
    maxMessages: 3,
    kinds: ['start', 'tool'],
    prefix: '⏳ ',
};

const PROGRESS_KINDS = new Set(['start', 'tool', 'stage', 'done']);

/** 把任意来源的 prompt 收敛成固定形状，缺省一律关闭 */
export function normalizePrompt(raw: unknown): PromptSettings {
    const p = (raw ?? {}) as Record<string, unknown>;
    return {
        qqBase: p.qqBase === true,
        character: p.character === true,
        faces: p.faces === true,
        images: p.images === true,
        extra: typeof p.extra === 'string' ? p.extra : '',
    };
}

/** 历史提取规则：只保留 pattern 非空的项 */
export function normalizeHistoryExtracts(raw: unknown): HistoryExtract[] {
    if (!Array.isArray(raw)) return [];
    const out: HistoryExtract[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const r = item as Record<string, unknown>;
        const pattern = String(r.pattern ?? '').trim();
        if (!pattern) continue;
        out.push({
            pattern,
            ...(typeof r.flags === 'string' && r.flags ? { flags: r.flags } : {}),
            ...(typeof r.label === 'string' && r.label ? { label: r.label } : {}),
        });
    }
    return out;
}

/** 进度设置：默认关闭；kinds 只保留合法值 */
export function normalizeProgress(raw: unknown): ProgressSettings {
    const p = (raw ?? {}) as Record<string, unknown>;

    const kinds = Array.isArray(p.kinds)
        ? p.kinds.map(String).filter((k) => PROGRESS_KINDS.has(k))
        : DEFAULT_PROGRESS.kinds;

    return {
        enabled: p.enabled === true,
        minIntervalMs: Math.max(0, Number(p.minIntervalMs ?? DEFAULT_PROGRESS.minIntervalMs) || 0),
        maxMessages: Math.max(0, Number(p.maxMessages ?? DEFAULT_PROGRESS.maxMessages) || 0),
        kinds: kinds.length > 0 ? kinds : DEFAULT_PROGRESS.kinds,
        prefix: typeof p.prefix === 'string' ? p.prefix : DEFAULT_PROGRESS.prefix,
    };
}
