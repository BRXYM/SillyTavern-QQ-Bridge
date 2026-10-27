/**
 * 消息派发：QQ 事件进来之后、回复发出去之前的全部业务。
 *
 * 一条消息的完整路径：
 *   1. 过滤（请求事件 / 自身消息 / 触发规则 / 白名单）
 *   2. 解析消息段，得到纯文本与是否 @ 机器人
 *   3. 计算 sessionKey，记录路由与计数，必要时建档
 *   4. 按会话解析下游（会话级优先，否则全局默认）
 *   5. 组装系统设定（QQ 约束 + 角色 + 表情词表 + 图片能力）
 *   6. 交给下游 ask()，拿到最终文本
 *   7. 过回复处理管道 → 发送层分段/表情 → QQ
 *
 * 这里不认识任何具体下游类型，只面向 DownstreamAdapter 接口。
 */

import { applyReplyProcessors } from '@bridge/core';
import type { OneBotEvent } from '../upstream/onebot.ts';
import type { SessionStore, SessionRoute } from './sessions.ts';
import { sessionKeyOf } from './sessions.ts';
import type { DownstreamAdapter, DownstreamConfig, ProgressEvent } from '../downstream/types.ts';
import type { BridgeConfig, ProcessorRule } from '../config/schema.ts';
import { log } from './logger.ts';
import { sendReply, type SendContext } from './sending.ts';
import { QQ_BASE_PROMPT, renderFaceInstruction, renderImageInstruction } from '../downstream/dsh.ts';

export interface DispatchDeps {
    sessions: SessionStore;
    sending: SendContext;
    /** 当前配置（可变，热更新后指向新对象） */
    config: () => BridgeConfig;
    /** 按 id 取下游；取不到返回 undefined */
    adapter: (id: string) => DownstreamAdapter | undefined;
    /** 表情词表，用于 prompt */
    faceManifest: () => { vocab: Record<string, string[]>; recent: string[] };
    /** 机器人自身 QQ，用于判断是否 @ 自己 */
    selfId: () => string;
}

/** 解析后的一条入站消息 */
interface ParsedMessage {
    text: string;
    atMe: boolean;
}

/** 从 OneBot 的 message 字段解析纯文本与 @ 情况 */
export function parseMessage(message: unknown, selfId: string): ParsedMessage {
    if (typeof message === 'string') {
        return { text: message, atMe: false };
    }
    if (!Array.isArray(message)) {
        return { text: '', atMe: false };
    }

    let text = '';
    let atMe = false;
    for (const seg of message as Array<{ type?: string; data?: Record<string, unknown> }>) {
        switch (seg.type) {
            case 'text':
                text += String(seg.data?.text ?? '');
                break;
            case 'at':
                if (String(seg.data?.qq) === selfId) atMe = true;
                break;
            case 'image':
                text += '[图片]';
                break;
            case 'face':
                text += `[表情${seg.data?.id ?? ''}]`;
                break;
            default:
                break;
        }
    }
    return { text: text.trim(), atMe };
}

/**
 * 触发规则判定。
 * 返回 null 表示放行，否则返回原因（调用方记日志用）。
 */
export function checkTrigger(
    config: BridgeConfig,
    messageType: 'private' | 'group',
    groupId: number | null,
    userId: number,
    atMe: boolean,
): string | null {
    const t = config.trigger;
    // 黑白名单已迁到「会话准入」（checkSessionAccess），这里只管行为开关
    if (messageType === 'private' && t.privateReply === false) return '私聊回复已关闭';
    if (messageType === 'group' && t.atOnly && !atMe) return '群里未 @ 机器人';
    // 保留参数以兼容调用点：名单不再参与此判定
    void groupId;
    void userId;
    return null;
}

/**
 * 会话准入（在触发规则之前执行）。
 *
 * 语义：
 *   - 命中黑名单 → 拒绝
 *   - 白名单非空且未命中 → 拒绝（含"新会话"）
 *   - 两个都空 → 放行
 *
 * `unknownPolicy` 决定「既不在白名单也不在黑名单」的新会话怎么办：
 *   - 'allow'（默认）：照常处理
 *   - 'deny'：拒绝，并可按 `denyReply` 回一句自定义提示
 * 注意：白名单为空时所有会话都属于"已知"，不会触发 unknown 策略。
 */
export interface SessionAccess {
    /** 黑名单：这些 QQ/群永远拒绝（优先级最高） */
    denyUsers: number[];
    denyGroups: number[];
    /** 白名单：非空时只允许这些（用户与群分别判断） */
    allowUsers: number[];
    allowGroups: number[];
    /** 新会话（未配置且不在任何名单里）的策略 */
    unknownPolicy: 'allow' | 'deny';
    /** 拒绝时回给 QQ 的一句话；空 = 静默 */
    denyReply: string;
}

export const DEFAULT_SESSION_ACCESS: SessionAccess = {
    denyUsers: [],
    denyGroups: [],
    allowUsers: [],
    allowGroups: [],
    unknownPolicy: 'allow',
    denyReply: '',
};

export interface AccessVerdict {
    allowed: boolean;
    /** 拒绝原因，写日志用 */
    reason?: string;
    /** 回给 QQ 的提示（可能为空 = 静默） */
    reply?: string;
    /** 是否属于"新会话未配置"这一情形 */
    unknown?: boolean;
}

const sameId = (a: unknown, b: unknown): boolean => String(a) === String(b);

/**
 * 判断一条消息是否允许进入处理流程。
 *
 * @param access   会话准入配置
 * @param ids      本条消息归属的用户与群
 * @param configured 该会话是否已有配置（决定"新会话"策略是否生效）
 */
export function checkSessionAccess(
    access: SessionAccess | undefined,
    ids: { userId: number; groupId: number | null },
    configured: boolean,
): AccessVerdict {
    const a = access ?? DEFAULT_SESSION_ACCESS;

    const denyUsers = Array.isArray(a.denyUsers) ? a.denyUsers : [];
    const denyGroups = Array.isArray(a.denyGroups) ? a.denyGroups : [];
    const allowUsers = Array.isArray(a.allowUsers) ? a.allowUsers : [];
    const allowGroups = Array.isArray(a.allowGroups) ? a.allowGroups : [];

    // 黑名单优先：任一命中即拒
    if (denyUsers.some((u) => sameId(u, ids.userId))) {
        return {
            allowed: false,
            reason: `用户 ${ids.userId} 在会话黑名单里`,
            reply: String(a.denyReply ?? '').trim(),
        };
    }
    if (ids.groupId !== null && denyGroups.some((g) => sameId(g, ids.groupId))) {
        return {
            allowed: false,
            reason: `群 ${ids.groupId} 在会话黑名单里`,
            reply: String(a.denyReply ?? '').trim(),
        };
    }

    // 白名单：非空时必须命中
    const userListed = allowUsers.length > 0
        ? allowUsers.some((u) => sameId(u, ids.userId))
        : true;
    const groupListed = allowGroups.length > 0 && ids.groupId !== null
        ? allowGroups.some((g) => sameId(g, ids.groupId))
        : true;

    if (!userListed) {
        // 不在白名单：区分"新会话"和"已知但被禁"
        if (!configured) {
            if (a.unknownPolicy === 'deny') {
                return {
                    allowed: false,
                    unknown: true,
                    reason: `新会话用户 ${ids.userId} 未在白名单，且策略为拒绝`,
                    reply: String(a.denyReply ?? '').trim(),
                };
            }
            // 未配置但策略放行 → 继续
        } else {
            return {
                allowed: false,
                reason: `用户 ${ids.userId} 不在会话白名单里`,
                reply: String(a.denyReply ?? '').trim(),
            };
        }
    }

    if (!groupListed) {
        return {
            allowed: false,
            reason: `群 ${ids.groupId} 不在会话白名单里`,
            reply: String(a.denyReply ?? '').trim(),
        };
    }

    return { allowed: true };
}

/** 组装下发给下游的系统设定 */
/**
 * 组装下发给下游的 system 文本。
 *
 * 默认**返回空串**：Bridge 只转发用户原话，不夹带任何自己的说明。
 * 具体拼哪些内容由下游实例自己的 prompt 开关决定（见 PromptSettings），
 * 这样同一份配置里 dsh 与酒馆可以各自独立控制。
 */
export function buildSystemPrompt(
    config: BridgeConfig,
    sessionKey: string,
    deps: DispatchDeps,
    adapter?: DownstreamAdapter,
): string {
    // 适配器自己会拼（dsh 有完整开关）
    const composer = (adapter as unknown as { composeSystemPrompt?: (k: string) => string } | undefined)
        ?.composeSystemPrompt;
    if (typeof composer === 'function') {
        return composer.call(adapter, sessionKey);
    }

    // 其它下游（酒馆）沿用实例 settings 里的开关，默认同样不发
    const settings = (adapter && 'getSettings' in adapter)
        ? (adapter as unknown as { getSettings: () => Record<string, unknown> }).getSettings()
        : undefined;
    const prompt = (settings?.prompt ?? {}) as Record<string, unknown>;
    if (prompt.qqBase !== true && prompt.character !== true) return '';

    const parts: string[] = [];
    if (prompt.qqBase === true) parts.push(QQ_BASE_PROMPT);

    const resolved = deps.sessions.resolve(sessionKey);
    if (prompt.character === true && resolved.character) {
        const worldLine = resolved.world
            ? `\n背景设定：${resolved.world}（不需要逐条复述，自然地体现即可）。`
            : '';
        parts.push(`【角色】你在扮演「${resolved.character}」，用第一人称以这个角色的口吻说话。${worldLine}`);
    }

    const extra = String(prompt.extra ?? '').trim();
    if (extra) parts.push(extra);

    void config;
    return parts.join('\n\n');
}

/** 取该会话该用的回复处理规则（会话级优先） */
export function resolveReplyRules(
    config: BridgeConfig,
    sessions: SessionStore,
    sessionKey: string,
): { rules: ProcessorRule[]; source: 'session' | 'global' } {
    const own = sessions.get(sessionKey)?.replyProcessors;
    if (Array.isArray(own)) return { rules: own as ProcessorRule[], source: 'session' };
    return { rules: config.replyProcessors ?? [], source: 'global' };
}

/**
 * 处理一条入站事件。
 *
 * 注意：这是 async 但调用方不应 await（OneBot 事件循环不能被阻塞）。
 */
export async function dispatchEvent(deps: DispatchDeps, event: OneBotEvent): Promise<void> {
    // 好友申请 / 群邀请等请求事件：忽略
    if (event.request_type) {
        log(`忽略请求事件: ${event.request_type} from ${event.user_id}`);
        return;
    }
    if (event.post_type !== 'message' || event.sub_type === 'bot') return;

    const config = deps.config();
    const selfId = deps.selfId();
    if (String(event.user_id) === selfId) return;

    const messageType = event.message_type;
    if (messageType !== 'private' && messageType !== 'group') return;

    const groupId = event.group_id ?? null;
    const userId = Number(event.user_id);
    if (!Number.isFinite(userId)) return;

    const parsed = parseMessage(event.message, selfId);
    if (!parsed.text) return;

    const blocked = checkTrigger(config, messageType, groupId, userId, parsed.atMe);
    if (blocked) return;

    const sessionKey = sessionKeyOf(messageType, groupId, userId);
    const senderName = String(event.sender?.card || event.sender?.nickname || userId);

    // ---- 会话准入（QQ 黑白名单）----
    // 必须在建档之前判断：一旦 ensure() 建了档，"新会话"就不存在了，
    // unknownPolicy 也就永远不会生效。
    const configured = Boolean(deps.sessions.get(sessionKey));
    const verdict = checkSessionAccess(config.sessionAccess, { userId, groupId }, configured);
    if (!verdict.allowed) {
        log(`⛔ 会话 [${sessionKey}] 被拒：${verdict.reason}`);
        if (verdict.reply) {
            await sendReply(
                deps.sending,
                { messageType, groupId, userId, sessionKey },
                verdict.reply,
            );
        }
        if (verdict.unknown) {
            deps.sessions.notePending?.(sessionKey, { userId, groupId, messageType, senderName });
        }
        return;
    }

    const route: SessionRoute = { sessionKey, messageType, groupId, userId };
    deps.sessions.rememberRoute(route);
    deps.sessions.bumpIn(sessionKey);
    deps.sessions.ensure(sessionKey);

    // ---- 选下游 ----
    const resolved = deps.sessions.resolve(sessionKey);
    const adapter = deps.adapter(resolved.backendId);
    if (!adapter) {
        log(`⚠ 会话 ${sessionKey} 指向的下游 ${resolved.backendId} 不存在，消息已丢弃`);
        return;
    }

    log(
        `QQ消息 → ${adapter.name} [${sessionKey}]: [${senderName}] ${parsed.text}`
        + (resolved.inherited ? '（继承全局下游）' : '（会话级下游）'),
    );

    // ---- 进度摘要转发 ----
    const downstreamCfg = config.downstreams.find((d) => d.id === resolved.backendId);
    // 只在需要时挂回调，避免无谓的对象创建与判断
    const progressCfg = progressSettings(downstreamCfg);
    const onProgress = progressCfg.enabled
        ? makeProgressReporter({
            sending: deps.sending,
            target: { messageType, groupId, userId, sessionKey },
            cfg: progressCfg,
        })
        : undefined;

    // ---- 询问下游 ----
    const userText = messageType === 'group' ? `[群成员 ${senderName}] ${parsed.text}` : parsed.text;
    const result = await adapter.ask({
        sessionKey,
        text: userText,
        system: buildSystemPrompt(config, sessionKey, deps, adapter),
        sender: senderName,
        onProgress,
    });

    if (!result.ok) {
        log(`下游 ${adapter.name} 处理失败 [${sessionKey}]：${result.error}`);
        const fallback = errorReplyFor(config, adapter.id);
        if (fallback) {
            await sendReply(deps.sending, {
                messageType,
                groupId,
                userId,
                sessionKey,
            }, fallback);
        }
        return;
    }

    const reply = result.text.trim();
    if (!reply) {
        log(`下游 ${adapter.name} 返回空回复 [${sessionKey}]`);
        return;
    }

    log(
        `下游原始回复 [${sessionKey}]：${reply.slice(0, 80)}`
        + `（${(result.elapsedMs / 1000).toFixed(1)}s${result.via ? `，${result.via}` : ''}）`,
    );

    // ---- 处理管道 ----
    const { rules, source } = resolveReplyRules(config, deps.sessions, sessionKey);
    if (rules.length > 0) log(`处理管道来源: ${source} (${rules.length} 条规则)`);
    const processed = applyReplyProcessors(reply, rules);
    if (!processed) {
        log('回复经规则处理后为空，不发送');
        return;
    }

    // ---- 发送 ----
    await sendReply(deps.sending, { messageType, groupId, userId, sessionKey }, processed);
}

/** 从下游实例的 settings 里读失败提示（找不到返回空） */
function errorReplyFor(config: BridgeConfig, adapterId: string): string {
    const ds = config.downstreams.find((d) => d.id === adapterId);
    const val = ds?.settings?.errorReply;
    return typeof val === 'string' ? val.trim() : '';
}

/** 准入被拒时的提示文案（空 = 静默） */
function progressNotice(config: BridgeConfig, adapterId: string, kind: 'denied'): string {
    const ds = config.downstreams.find((d) => d.id === adapterId);
    const p = (ds?.settings?.progress ?? {}) as Record<string, unknown>;
    if (kind === 'denied') {
        return typeof p.deniedReply === 'string' ? p.deniedReply.trim() : '';
    }
    return '';
}

/** 进度转发的有效配置 */
interface ProgressSettings {
    enabled: boolean;
    /** 最少间隔（毫秒）：太快会刷屏 */
    minIntervalMs: number;
    /** 最长只发这么多条 */
    maxMessages: number;
    /** 只发这些类型的节点 */
    kinds: Array<'start' | 'tool' | 'stage' | 'done'>;
    /** 消息前缀，便于识别这是进度而非正式回复 */
    prefix: string;
}

const DEFAULT_PROGRESS: ProgressSettings = {
    enabled: false,
    minIntervalMs: 4000,
    maxMessages: 3,
    kinds: ['start', 'tool'],
    prefix: '⏳ ',
};

/** 读下游的进度配置（默认关闭） */
function progressSettings(cfg: DownstreamConfig | undefined): ProgressSettings {
    const raw = (cfg?.settings?.progress ?? {}) as Record<string, unknown>;
    const kinds = Array.isArray(raw.kinds)
        ? (raw.kinds.filter((k): k is ProgressSettings['kinds'][number] =>
            k === 'start' || k === 'tool' || k === 'stage' || k === 'done'))
        : DEFAULT_PROGRESS.kinds;

    return {
        enabled: raw.enabled === true,
        minIntervalMs: Math.max(0, Number(raw.minIntervalMs ?? DEFAULT_PROGRESS.minIntervalMs) || 0),
        maxMessages: Math.max(0, Number(raw.maxMessages ?? DEFAULT_PROGRESS.maxMessages) || 0),
        kinds: kinds.length > 0 ? kinds : DEFAULT_PROGRESS.kinds,
        prefix: typeof raw.prefix === 'string' ? raw.prefix : DEFAULT_PROGRESS.prefix,
    };
}

/**
 * 构造进度上报器。
 *
 * 三条限制避免刷屏：
 *   1. 类型白名单：默认只发 start / tool
 *   2. 最小间隔：距离上一条太近的直接丢弃（而不是排队）
 *   3. 数量上限：达到上限后静默
 *
 * 上报是「尽力而为」：发送失败不影响主流程，也不抛出。
 */
function makeProgressReporter(opts: {
    sending: SendContext;
    target: { messageType: 'private' | 'group'; groupId: number | null; userId: number; sessionKey: string };
    cfg: ProgressSettings;
}): (event: ProgressEvent) => void {
    const { sending, target, cfg } = opts;
    let sent = 0;
    let lastAt = 0;

    return (event) => {
        if (sent >= cfg.maxMessages) return;
        if (!cfg.kinds.includes(event.kind)) return;

        const now = Date.now();
        // 首条立即发，之后按最小间隔限流
        if (sent > 0 && now - lastAt < cfg.minIntervalMs) return;

        const text = `${cfg.prefix}${event.text}`.trim();
        if (!text) return;

        sent += 1;
        lastAt = now;

        // 不 await：进度不应阻塞主流程
        void sendReply(sending, target, text).catch((e) => {
            log(`进度发送失败：${e instanceof Error ? e.message : String(e)}`);
        });
    };
}
