/**
 * dsh（DeepSeek Harness）下游适配器。
 *
 * 两条传输，共用同一份「最终文本」契约：
 *
 *   1. 插件链路（首选）
 *      注入到 dsh profile 的连接插件启动后连回 Bridge 的入站 WS，
 *      消息在 dsh 进程内跑完再回包。无常驻子进程开销，
 *      并能复用 web profile 的模型选择、MCP、工具。
 *      插件会通过 /api/downstreams/register 自动登记自己。
 *
 *   2. headless 兜底
 *      插件不在线时，起一次性 `dsh --profile headless "<任务>"`，
 *      读 stdout 作为回复，上下文由 Bridge 维护并落盘。
 *      实现在 dsh-service.mjs（已独立验证），这里只做编排。
 *
 * 这样「dsh 没装」「插件没连」「服务挂了」都只是降级，不会让 QQ 无人应答。
 *
 * 命名配置：同一个实例下可以有多个配置（不同人设、不同 profile 目录）。
 * 会话传来的 `settings` 已由上层合并好，适配器只管用 —— 它不认识"配置"这个概念。
 */

import { WebSocket } from 'ws';
import { log } from '../core/logger.ts';
import type { DshClient } from '../../dsh-service.mjs';
import type {
    DownstreamAdapter,
    DownstreamAsk,
    DownstreamConfig,
    DownstreamResult,
    DownstreamStatus,
    ProgressEvent,
} from './types.ts';

export interface DshSettings {
    /** 插件离线时是否回落到 headless */
    fallbackHeadless: boolean;
    /** headless 参数 */
    exePath: string;
    profile: string;
    workRoot: string;
    timeoutMs: number;
    historyTurns: number;
    persistHistory: boolean;
    concurrency: number;
    /** 失败时回给 QQ 的一句话；空 = 静默 */
    errorReply: string;

    /**
     * 从历史里提取参考片段的正则规则。
     *
     * dsh 自己按 session 保存上下文，因此默认**不发送任何历史文本**。
     * 需要引用上一轮某个片段（表情标签、某个数值等）时，在这里加规则，
     * 命中的内容会以「[参考]」形式附在本次消息前。
     */
    historyExtracts: Array<{ pattern: string; flags?: string; label?: string }>;

    /**
     * 提示词注入。
     *
     * 默认**全部关闭**：Bridge 只转发用户原话，不夹带任何自己的说明。
     * 需要时在控制台按会话/按实例显式打开，避免 AI 被隐式提示词影响。
     */
    prompt: PromptSettings;
}

/** 提示词注入开关 + 自由文本 */
export interface PromptSettings {
    /** QQ 聊天约束（简短、口语化、不要 Markdown） */
    qqBase: boolean;
    /** 会话绑定的角色人设 */
    character: boolean;
    /** 表情词表（关闭后 AI 不会产出 [表情:标签]） */
    faces: boolean;
    /** 图片回复能力说明 */
    images: boolean;
    /** 自由附加文本，总是最后拼接（仅当非空） */
    extra: string;
}

export const DEFAULT_PROMPT_SETTINGS: PromptSettings = {
    qqBase: false,
    character: false,
    faces: false,
    images: false,
    extra: '',
};

export const DEFAULT_DSH_SETTINGS: DshSettings = {
    fallbackHeadless: true,
    exePath: '',
    profile: 'headless',
    workRoot: '',
    timeoutMs: 180000,
    historyTurns: 6,
    persistHistory: true,
    concurrency: 1,
    errorReply: '',
    historyExtracts: [],
    prompt: { ...DEFAULT_PROMPT_SETTINGS },
};

/** 把宽松的 settings 收敛成 DshSettings（配置可能来自手写 JSON） */
export function normalizeDshSettings(raw: Record<string, unknown> | undefined): DshSettings {
    const s = (raw ?? {}) as Record<string, unknown>;
    const p = (s.prompt ?? {}) as Record<string, unknown>;
    return {
        fallbackHeadless: s.fallbackHeadless !== false,
        exePath: String(s.exePath ?? ''),
        profile: String(s.profile ?? DEFAULT_DSH_SETTINGS.profile),
        workRoot: String(s.workRoot ?? ''),
        timeoutMs: Number(s.timeoutMs) || DEFAULT_DSH_SETTINGS.timeoutMs,
        historyTurns: Number(s.historyTurns) || DEFAULT_DSH_SETTINGS.historyTurns,
        persistHistory: s.persistHistory !== false,
        concurrency: Number(s.concurrency) || DEFAULT_DSH_SETTINGS.concurrency,
        errorReply: String(s.errorReply ?? ''),
        historyExtracts: Array.isArray(s.historyExtracts)
            ? (s.historyExtracts as DshSettings['historyExtracts'])
            : [],
        prompt: {
            qqBase: p.qqBase === true,
            character: p.character === true,
            faces: p.faces === true,
            images: p.images === true,
            extra: typeof p.extra === 'string' ? p.extra : '',
        },
    };
}

interface Pending {
    resolve: (result: DownstreamResult) => void;
    timer: NodeJS.Timeout;
    startedAt: number;
    /** 进度回调（转发给 dispatch 决定是否发 QQ） */
    onProgress?: (event: ProgressEvent) => void;
}

export interface DshDeps {
    /** 读取某会话应使用的角色/世界书，拼进系统提示 */
    sessionDefaults: (sessionKey: string) => { character: string; world: string };
    /** 表情词表清单 */
    faceManifest: () => { vocab: Record<string, string[]>; recent: string[] };
    imageReplies: () => { enabled: boolean; instruction: boolean; baseUrl: string };
}

export class DshAdapter implements DownstreamAdapter {
    readonly kind = 'dsh-plugin' as const;
    readonly id: string;
    readonly name: string;
    private settings: DshSettings;
    private readonly deps: DshDeps;
    private readonly makeHeadless: (settings: DshSettings) => DshClient;
    private readonly clients = new Set<WebSocket>();
    private readonly pending = new Map<string, Pending>();
    private reqSeq = 0;
    /** headless 客户端缓存：按 profile 分开，避免不同配置共用同一个子进程历史 */
    private readonly headlessByProfile = new Map<string, DshClient>();
    /** 可用性变化回调（连上/断开时触发） */
    private changeListener: (() => void) | null = null;

    constructor(
        id: string,
        name: string,
        config: DownstreamConfig,
        deps: DshDeps,
        /** headless 客户端工厂；测试可注入假实现 */
        makeHeadless: (settings: DshSettings) => DshClient,
    ) {
        this.id = id;
        this.name = name;
        this.deps = deps;
        this.makeHeadless = makeHeadless;
        this.settings = normalizeDshSettings(config.settings);
    }

    async init(): Promise<void> {
        // 连接由入站 WS 服务在插件握手后注入
    }

    async dispose(): Promise<void> {
        for (const [key, record] of this.pending) {
            clearTimeout(record.timer);
            record.resolve({ ok: false, text: '', elapsedMs: 0, error: '适配器已关闭' });
            this.pending.delete(key);
        }
        for (const s of this.clients) {
            try {
                s.close();
            } catch {
                /* 忽略 */
            }
        }
        this.clients.clear();
        this.headlessByProfile.clear();
    }

    /** 配置热更新：只换参数，不停连接 */
    reconfigure(config: DownstreamConfig): void {
        this.settings = normalizeDshSettings(config.settings);
        this.headlessByProfile.clear();
    }

    status(): DownstreamStatus {
        const pluginOnline = this.onlineCount() > 0;
        const detail: Record<string, string | number | boolean> = {
            pluginConnections: this.onlineCount(),
            pending: this.pending.size,
            profile: this.settings.profile,
            timeoutMs: this.settings.timeoutMs,
        };
        const headless = [...this.headlessByProfile.values()][0];
        if (headless) {
            const st = headless.status();
            detail.installed = st.installed;
            detail.version = st.version;
        }
        return {
            id: this.id,
            kind: this.kind,
            name: this.name,
            enabled: true,
            available: pluginOnline || this.settings.fallbackHeadless,
            reason: pluginOnline
                ? undefined
                : this.settings.fallbackHeadless
                    ? '插件未连接，将回落到 headless 子进程'
                    : '插件未连接，且已禁用 headless 兜底',
            detail,
        };
    }

    /** 在线插件的连接信息（控制台展示用） */
    pluginClients(): Array<{ pid: number; profile: string; version: string; connectedAt: number | null }> {
        const out: Array<{ pid: number; profile: string; version: string; connectedAt: number | null }> = [];
        for (const s of this.clients) {
            if (s.readyState !== WebSocket.OPEN) continue;
            const meta = s as WebSocket & { dshPid?: number; dshProfile?: string; dshVersion?: string; connectedAt?: number };
            out.push({
                pid: meta.dshPid ?? 0,
                profile: meta.dshProfile ?? '',
                version: meta.dshVersion ?? '',
                connectedAt: meta.connectedAt ?? null,
            });
        }
        return out;
    }

    onlineCount(): number {
        let n = 0;
        for (const s of this.clients) {
            if (s.readyState === WebSocket.OPEN) n += 1;
        }
        return n;
    }

    /** 注册可用性变化回调 */
    onChange(listener: () => void): void {
        this.changeListener = listener;
    }

    /** 插件握手成功后由入站服务调用 */
    attach(socket: WebSocket): void {
        const before = this.onlineCount();
        this.clients.add(socket);
        log(`dsh 连接插件已接入 [${this.id}]（pid ${(socket as WebSocket & { dshPid?: number }).dshPid ?? '?'}）`);
        if (before === 0) this.changeListener?.();
    }

    detach(socket: WebSocket): void {
        if (this.clients.delete(socket)) {
            log(`dsh 连接插件已断开 [${this.id}]（剩余 ${this.onlineCount()}）→ 回落到 headless`);
            if (this.onlineCount() === 0) this.changeListener?.();
        }
    }

    /** 处理插件回包；返回 true 表示已消费 */
    handleMessage(msg: Record<string, unknown>): boolean {
        const type = String(msg.type ?? '');

        // 进度节点：不结束等待，只转发给上层
        if (type === 'downstream_progress') {
            const requestId = String(msg.requestId ?? '');
            const record = this.pending.get(requestId);
            if (!record) return false;
            record.onProgress?.({
                kind: (String(msg.kind ?? 'stage') as 'start' | 'tool' | 'stage' | 'done'),
                text: String(msg.text ?? ''),
                ...(msg.detail !== undefined ? { detail: String(msg.detail) } : {}),
                at: Date.now() - record.startedAt,
            });
            return true;
        }

        if (type !== 'downstream_reply' && type !== 'downstream_error') return false;

        const requestId = String(msg.requestId ?? '');
        const record = this.pending.get(requestId);
        if (!record) return false;

        this.pending.delete(requestId);
        clearTimeout(record.timer);

        if (type === 'downstream_error') {
            record.resolve({
                ok: false,
                text: '',
                elapsedMs: Date.now() - record.startedAt,
                error: String(msg.error ?? '插件侧处理失败'),
                via: 'plugin',
            });
            return true;
        }

        record.resolve({
            ok: true,
            text: String(msg.text ?? ''),
            elapsedMs: Number(msg.elapsedMs) || Date.now() - record.startedAt,
            via: 'plugin',
        });
        return true;
    }

    async ask(req: DownstreamAsk): Promise<DownstreamResult> {
        // 上层已经按会话选好的配置合并过 settings；缺省时退回实例设置
        const effective = req.settings
            ? normalizeDshSettings(req.settings)
            : this.settings;

        const plugin = this.pickSocket();
        if (plugin) {
            const result = await this.askViaPlugin(plugin, req, effective);
            if (result.ok) return result;
            if (!effective.fallbackHeadless) return result;
            log(`dsh 插件投递失败：${result.error}，回落到 headless`);
        }

        if (!effective.fallbackHeadless) {
            return { ok: false, text: '', elapsedMs: 0, error: '插件未连接，且已禁用 headless 兜底' };
        }

        return this.askViaHeadless(req, effective);
    }

    async resetSession(sessionKey: string, opts?: { removeWorkDir?: boolean }): Promise<boolean> {
        // 通知在线插件释放 Agent
        let sent = false;
        for (const socket of this.clients) {
            if (socket.readyState !== WebSocket.OPEN) continue;
            try {
                socket.send(JSON.stringify({
                    type: 'downstream_reset',
                    requestId: `reset_${++this.reqSeq}`,
                    sessionKey,
                    removeWorkDir: opts?.removeWorkDir === true,
                }));
                sent = true;
            } catch {
                /* 忽略 */
            }
        }
        // headless 侧的历史一并清掉，避免切回子进程时还记得
        for (const client of this.headlessByProfile.values()) {
            client.clearHistory(sessionKey, { removeWorkDir: opts?.removeWorkDir === true });
        }
        return sent;
    }

    private pickSocket(): WebSocket | null {
        let last: WebSocket | null = null;
        for (const s of this.clients) {
            if (s.readyState === WebSocket.OPEN) last = s;
        }
        return last;
    }

    private askViaPlugin(
        socket: WebSocket,
        req: DownstreamAsk,
        settings: DshSettings,
    ): Promise<DownstreamResult> {
        const requestId = `${this.id}_${++this.reqSeq}`;
        const startedAt = Date.now();
        const timeoutMs = settings.timeoutMs;

        return new Promise<DownstreamResult>((resolve) => {
            const timer = setTimeout(() => {
                if (!this.pending.delete(requestId)) return;
                resolve({
                    ok: false,
                    text: '',
                    elapsedMs: Date.now() - startedAt,
                    error: `插件 ${Math.round(timeoutMs / 1000)}s 内未回复`,
                });
            }, timeoutMs);

            this.pending.set(requestId, { resolve, timer, startedAt, onProgress: req.onProgress });

            try {
                socket.send(JSON.stringify({
                    type: 'downstream_ask',
                    requestId,
                    sessionKey: req.sessionKey,
                    text: req.text,
                    system: req.system,
                    // 告知插件是否上报进度：Bridge 侧没开就完全不必解析事件
                    progress: typeof req.onProgress === 'function',
                }));
            } catch (e) {
                this.pending.delete(requestId);
                clearTimeout(timer);
                resolve({
                    ok: false,
                    text: '',
                    elapsedMs: Date.now() - startedAt,
                    error: e instanceof Error ? e.message : String(e),
                });
            }
        });
    }

    private async askViaHeadless(req: DownstreamAsk, settings: DshSettings): Promise<DownstreamResult> {
        // 不同配置可能指向不同 dsh profile / 工作目录，缓存键要带上它
        const cacheKey = `${settings.profile}|${settings.workRoot}|${settings.exePath}`;
        let client = this.headlessByProfile.get(cacheKey);
        if (!client) {
            client = this.makeHeadless(settings);
            this.headlessByProfile.set(cacheKey, client);
        }

        const result = await client.ask({
            sessionKey: req.sessionKey,
            text: req.text,
            system: req.system,
            // 历史不整段发送，只按配置的正则提取参考片段
            historyExtracts: settings.historyExtracts ?? [],
            // 把 reasoning 摘要节点透传给上游（是否转发由 dispatch 决定）
            onProgress: req.onProgress,
        });
        return { ...result, via: result.via ?? 'headless' } as DownstreamResult;
    }

    /** 当前生效的设置（供控制台只读展示） */
    getSettings(): DshSettings {
        return { ...this.settings };
    }

    /** 段落提示词所需的会话角色/世界书 */
    describeSession(sessionKey: string): { character: string; world: string } {
        return this.deps.sessionDefaults(sessionKey);
    }

    /** 表情与图片能力（供 prompt 组装） */
    describeCapabilities(): { face: string; image: string } {
        return {
            face: renderFaceInstruction(this.deps.faceManifest()),
            image: renderImageInstruction(this.deps.imageReplies()),
        };
    }

    /**
     * 按某份设置里的提示词开关组装 system 文本。
     *
     * 默认全部关闭 → 返回空串 → 上层不发送任何提示词，只转发用户原话。
     * 每个开关独立生效，顺序固定（基础约束 → 人设 → 表情 → 图片 → 自定义）。
     *
     * `raw` 是合并后的原始 settings（可能来自会话选中的配置），
     * 这里统一走 normalizeDshSettings，避免调用方拼出半成品形状。
     */
    composeSystemPrompt(sessionKey: string, raw?: Record<string, unknown>): string {
        const settings = raw ? normalizeDshSettings(raw) : this.settings;
        const p = settings.prompt ?? DEFAULT_PROMPT_SETTINGS;
        const parts: string[] = [];

        if (p.qqBase) parts.push(QQ_BASE_PROMPT);

        if (p.character) {
            const { character, world } = this.deps.sessionDefaults(sessionKey);
            if (character) {
                const worldLine = world
                    ? `\n背景设定：${world}（不需要逐条复述，自然地体现即可）。`
                    : '';
                parts.push(
                    `【角色】你在扮演「${character}」，用第一人称以这个角色的口吻说话。${worldLine}`,
                );
            }
        }

        if (p.faces) {
            const face = renderFaceInstruction(this.deps.faceManifest());
            if (face) parts.push(face);
        }

        if (p.images) {
            const img = renderImageInstruction(this.deps.imageReplies());
            if (img) parts.push(img);
        }

        const extra = String(p.extra ?? '').trim();
        if (extra) parts.push(extra);

        return parts.join('\n\n');
    }
}

/** 表情包提示：只给词表，不给具体图片（库再大注入体积也不变） */
export function renderFaceInstruction(manifest: { vocab: Record<string, string[]>; recent: string[] }): string {
    const vocab = manifest.vocab ?? {};
    const groups = Object.entries(vocab).filter(([, words]) => Array.isArray(words) && words.length > 0);
    if (groups.length === 0) return '';

    const lines = groups.map(([g, words]) => `${g}：${words.join('、')}`);
    const emo = vocab['情绪'] ?? [];
    const pick = (...cands: string[]): string => cands.find((c) => emo.includes(c)) ?? emo[0] ?? '';

    const laugh = pick('大笑', '开心', '微笑');
    const tired = pick('崩溃', '无奈', '难过', '疲惫');
    const recent = manifest.recent ?? [];

    return [
        '【表情包】',
        '你可以发表情包：只需给出标签，系统会自动从本地表情库挑一张最贴合的图。',
        '',
        '可用标签（只能从这里选，不要自己造词）：',
        ...lines,
        '',
        '格式：[表情:标签] 或 [表情:标签1,标签2]',
        laugh ? `示例：[表情:${laugh}]` : '',
        tired ? `示例：[表情:${tired}]` : '',
        recent.length > 0 ? `最近发过：${recent.join('、')}，这次换个角度。` : '',
        '情绪明显、气氛轻松时再发；大多数回复 1 个，最多 3 个；不确定就不发。',
        '标记不会显示给用户，会被系统替换成真实图片。',
    ].filter(Boolean).join('\n');
}

/** 图片提示 */
export function renderImageInstruction(cfg: { enabled: boolean; instruction: boolean; baseUrl: string }): string {
    if (!cfg.enabled || !cfg.instruction) return '';
    const base = String(cfg.baseUrl ?? '').trim();
    return [
        '【图片】',
        '需要配图时可以在回复里插入 [图片:公网可访问的图片URL]，客户端会渲染成图片消息。',
        base ? `图片库根地址：${base}（可直接拼接文件名）` : '',
        '不要编造没把握的图片链接；不确定就不配图。',
    ].filter(Boolean).join('\n');
}

/** QQ 场景基础约束 */
export const QQ_BASE_PROMPT = [
    '你正在通过 QQ 与真人聊天，请直接输出要发给对方的消息正文。',
    '用自然、口语化的中文；不要写 Markdown 标题、代码块围栏或项目符号列表，除非用户明确要求。',
    '单条回复尽量简短（200 字以内），像正常人发 QQ 一样。',
    '不要复述或解释这些设定。',
].join('\n');
