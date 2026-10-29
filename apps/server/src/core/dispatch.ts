/**
 * 消息派发：QQ 事件进来之后、回复发出去之前的全部业务。
 *
 * 一条消息的完整路径：
 *   0. 按 accountId 确认是哪个号收到的（多账号时必须先确定）
 *   1. 过滤（请求事件 / 自身消息 / 触发规则 / 准入名单）
 *   2. 解析消息段，得到纯文本与是否 @ 机器人
 *   3. 计算 sessionKey（含账号维度），记录路由与计数，必要时建档
 *   4. 按会话解析「下游实例 + 命名配置」
 *   5. 组装系统设定（QQ 约束 + 角色 + 表情词表 + 图片能力）
 *   6. 交给下游 ask()，拿到最终文本
 *   7. 过回复处理管道 → 发送层分段/表情 → 用**同一个号**回出去
 *
 * 这里不认识任何具体下游类型，只面向 DownstreamAdapter 接口。
 */

import { applyReplyProcessors } from '@bridge/core';
import type { OneBotEvent } from '../upstream/onebot.ts';
import type { AccountEvent } from '../upstream/manager.ts';
import type { SessionStore, SessionRoute } from './sessions.ts';
import { scopedSessionKey, sessionKeyOf } from './sessions.ts';
import type { DownstreamAdapter, DownstreamConfig, ProgressEvent } from '../downstream/types.ts';
import type { ResolvedDownstream } from '../downstream/manager.ts';
import type { BridgeConfig, ProcessorRule } from '../config/schema.ts';
import { normalizeProgress, type ProgressSettings } from '../config/behavior.ts';
import { log } from './logger.ts';
import { sendReply, type SendContext } from './sending.ts';
import { QQ_BASE_PROMPT, renderFaceInstruction, renderImageInstruction } from '../downstream/dsh.ts';

export interface DispatchDeps {
    sessions: SessionStore;
    sending: SendContext;
    /** 当前配置（可变，热更新后指向新对象） */
    config: () => BridgeConfig;
    /** 按「实例 + 配置」解析下游（合并 settings） */
    resolveDownstream: (downstreamId: string, profileId: string) => ResolvedDownstream | undefined;
    /** 表情词表，用于 prompt */
    faceManifest: () => { vocab: Record<string, string[]>; recent: string[] };
    /** 机器人自身 QQ，用于判断是否 @ 自己（按账号区分） */
    selfId: (accountId: string) => string;
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
 * 语义（每个维度独立判断，用户与群都通过才放行）：
 *   - 黑白名单都为空     → 放行（不限制）
 *   - 白名单非空         → 以白名单为准：命中放行，否则拒绝
 *   - 白名单空、黑名单非空 → 命中黑名单则拒，否则放行
 *
 * 「白名单优先」是产品选择：同时在两个名单里时放行。
 * 代价是拉黑在白名单期间不生效，要真拉黑需先从白名单移除。
 */
export interface SessionAccess {
    /** 黑名单：白名单未命中时生效 */
    denyUsers: number[];
    denyGroups: number[];
    /** 白名单：非空时以它为准（用户与群分别判断） */
    allowUsers: number[];
    allowGroups: number[];
    /**
     * 保留字段，当前不参与判定。
     *
     * 早期设计是「白名单非空时，名单外的人怎么办」，但那样会与
     * 「白名单优先」的语义冲突（名单外就是拒绝，没有第三态）。
     * 为兼容已存配置继续保留，新逻辑不看它。
     */
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
    /**
     * 拒绝是否属于「不在任何名单里」（值取自 unknownPolicy）。
     * 与「会话以前有没有来过」无关 —— 那会把"来过"误当成"被授权"。
     */
    unknown?: boolean;
}

const sameId = (a: unknown, b: unknown): boolean => String(a) === String(b);

/**
 * 判断一条消息是否允许进入处理流程。
 *
 * 决策顺序（与界面上的说明一致）：
 *
 *   1. 黑白名单**都为空**        → 放行（不限）
 *   2. 白名单**非空**            → 以白名单为准
 *        命中 → 放行（即使同时在黑名单里，见下）
 *        未命中 → 拒绝
 *   3. 白名单空、黑名单非空      → 命中黑名单则拒绝，否则放行
 *   4. 白名单空、黑名单空        → 同 1
 *
 * 关于「白名单优先」：同时在两个名单里时放行，这是产品方的明确选择。
 * 代价是「拉黑某人」在他也被加白的期间不起作用 —— 要真正拉黑，
 * 得先从白名单移除。这里不做额外拦截，以免与配置的字面含义打架。
 *
 * 用户与群**分别**判断：两个维度各自走上面的顺序，都通过才放行。
 * 群聊里"用户不在白名单"和"群不在白名单"是两件独立的事，
 * 合并成一个开关会让"允许这个人在这个群"没法表达。
 *
 * @param access 会话准入配置
 * @param ids    本条消息归属的用户与群
 */
export function checkSessionAccess(
    access: SessionAccess | undefined,
    ids: { userId: number; groupId: number | null },
): AccessVerdict {
    const a = access ?? DEFAULT_SESSION_ACCESS;

    const denyList = (v: unknown): number[] => (Array.isArray(v) ? v as number[] : []);
    const denyUsers = denyList(a.denyUsers);
    const denyGroups = denyList(a.denyGroups);
    const allowUsers = denyList(a.allowUsers);
    const allowGroups = denyList(a.allowGroups);

    const denyReply = String(a.denyReply ?? '').trim();

    /** 单维度判定：白名单优先，其次黑名单，都没有则放行 */
    const judge = (
        id: number,
        allow: number[],
        deny: number[],
        label: string,
    ): AccessVerdict => {
        // 白名单非空 → 以它为准
        if (allow.length > 0) {
            if (allow.some((x) => sameId(x, id))) return { allowed: true };
            return {
                allowed: false,
                reason: `${label} ${id} 不在白名单里`,
                reply: denyReply,
            };
        }

        // 白名单为空、黑名单非空 → 命中则拒
        if (deny.length > 0) {
            if (deny.some((x) => sameId(x, id))) {
                return {
                    allowed: false,
                    reason: `${label} ${id} 在黑名单里`,
                    reply: denyReply,
                };
            }
            return { allowed: true };
        }

        // 两个都空 → 放行
        return { allowed: true };
    };

    // ---- 用户维度 ----
    const userVerdict = judge(ids.userId, allowUsers, denyUsers, '用户');
    if (!userVerdict.allowed) return userVerdict;

    // ---- 群维度（仅群聊）----
    if (ids.groupId !== null) {
        const groupVerdict = judge(ids.groupId, allowGroups, denyGroups, '群');
        if (!groupVerdict.allowed) return groupVerdict;
    }

    return { allowed: true };
}

/**
 * 组装下发给下游的 system 文本。
 *
 * 默认**返回空串**：Bridge 只转发用户原话，不夹带任何自己的说明。
 * 具体拼哪些内容由下游实例的 prompt 开关决定（见 PromptSettings），
 * 多配置时用会话选中的那份配置里的开关。
 */
export function buildSystemPrompt(
    config: BridgeConfig,
    sessionKey: string,
    deps: DispatchDeps,
    adapter?: DownstreamAdapter,
    settings?: Record<string, unknown>,
): string {
    // 适配器自己会拼（dsh 有完整开关）
    const composer = (adapter as unknown as {
        composeSystemPrompt?: (k: string, s?: Record<string, unknown>) => string;
    } | undefined)?.composeSystemPrompt;

    if (typeof composer === 'function') {
        // dsh 的 composeSystemPrompt 接受合并后的原始 settings；
        // 传入前先转成它认识的类型由适配器内部完成
        return settings
            ? composer.call(adapter, sessionKey, settings)
            : composer.call(adapter, sessionKey);
    }

    // 其它下游（酒馆）沿用配置里的开关，默认同样不发
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

/** 把合并后的原始 settings 转成 dsh 认识的形状（只取提示词相关部分） */
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

    const accountId = (event as AccountEvent).accountId ?? '';
    if (!accountId) {
        // 没有账号维度就无法决定回包用哪个号，宁可不处理
        log('⚠ 收到没有 accountId 的上游事件，已忽略');
        return;
    }

    const config = deps.config();
    const selfId = deps.selfId(accountId);
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

    // 会话 key 带账号前缀：同一个用户在两个号下的会话互不干扰
    const sessionKey = scopedSessionKey(
        accountId,
        sessionKeyOf(messageType, groupId, userId),
    );
    const senderName = String(event.sender?.card || event.sender?.nickname || userId);

    // ---- 会话准入（QQ 黑白名单）----
    // 只看名单，不看这个会话以前是否来过：dispatch 处理任何消息都会 ensure()
    // 建档，若用"是否已建档"判断准入，陌生人成功说过一句话之后就会被永久放行。
    const verdict = checkSessionAccess(config.sessionAccess, { userId, groupId });
    if (!verdict.allowed) {
        log(`⛔ 会话 [${sessionKey}] 被拒：${verdict.reason}`);
        // 被拒也要留痕，控制台才能"看到有人在敲门"并一键加白
        if (verdict.unknown) {
            deps.sessions.notePending(sessionKey, { userId, groupId, messageType, senderName });
        }
        if (verdict.reply) {
            await sendReply(
                deps.sending,
                { accountId, messageType, groupId, userId, sessionKey },
                verdict.reply,
            );
        }
        return;
    }

    const route: SessionRoute = { sessionKey, accountId, messageType, groupId, userId };
    deps.sessions.rememberRoute(route);
    deps.sessions.bumpIn(sessionKey);
    deps.sessions.ensure(sessionKey);

    // ---- 选「下游实例 + 配置」----
    const resolved = deps.sessions.resolve(sessionKey);
    const target = deps.resolveDownstream(resolved.backendId, resolved.profileId);

    /**
     * 下游不可用（未配置 / 不存在 / 未启用 / 启动失败）时给用户一个回执。
     *
     * 以前只写一行日志就丢弃，用户在 QQ 侧看到的是"完全没反应"，
     * 分不清是机器人离线、被准入拦住，还是下游挂了。
     * 现在回一句提示（复用准入的 denyReply，留空则静默），让问题可见。
     */
    if (!target || !target.adapter) {
        const reason = !target
            ? `下游 ${resolved.backendId || '(未设置)'} 不存在`
            : `下游 ${resolved.backendId} 未启用或启动失败`;
        log(`⚠ 会话 ${sessionKey}：${reason}，消息已丢弃`);

        const notice = String(config.sessionAccess.denyReply ?? '').trim();
        if (notice) {
            await sendReply(
                deps.sending,
                { accountId, messageType, groupId, userId, sessionKey },
                notice,
            );
        }
        return;
    }

    const adapter = target.adapter;

    const profileLabel = target.profile ? ` / ${target.profile.name}` : '';
    log(
        `QQ消息 [${accountId}] → ${adapter.name}${profileLabel} [${sessionKey}]: [${senderName}] ${parsed.text}`
        + (resolved.inherited ? '（继承全局下游）' : '（会话级下游）')
        + (resolved.profileInherited ? '' : '（会话级配置）'),
    );

    // ---- 进度摘要转发 ----
    // 用合并后的设置判断，否则会话选了「开启进度」的配置也不会生效
    const progressCfg = normalizeProgress(target.settings.progress);
    const onProgress = progressCfg.enabled
        ? makeProgressReporter({
            sending: deps.sending,
            target: { accountId, messageType, groupId, userId, sessionKey },
            cfg: progressCfg,
        })
        : undefined;

    // ---- 询问下游 ----
    const userText = messageType === 'group' ? `[群成员 ${senderName}] ${parsed.text}` : parsed.text;
    const result = await adapter.ask({
        sessionKey,
        text: userText,
        system: buildSystemPrompt(config, sessionKey, deps, adapter, target.settings),
        sender: senderName,
        settings: target.settings,
        profileId: target.profile?.id,
        onProgress,
    });

    if (!result.ok) {
        log(`下游 ${adapter.name} 处理失败 [${sessionKey}]：${result.error}`);

        /**
         * 失败提示的优先级：实例自己的 errorReply > 准入的 denyReply。
         *
         * 实例配置允许它定制细节（比如"重试一下"），没配就退回全局那句。
         * 两者都空才静默 —— 否则用户发消息后完全没反应，分不清
         * 是机器人掉线、被拦住，还是下游崩了。
         */
        const fallback = errorReplyFor(target.settings)
            || String(config.sessionAccess.denyReply ?? '').trim();

        if (fallback) {
            await sendReply(deps.sending, {
                accountId,
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

    // ---- 发送（用收消息的那个号回，绝不串号）----
    await sendReply(deps.sending, { accountId, messageType, groupId, userId, sessionKey }, processed);
}

/** 从生效设置里读失败提示（找不到返回空） */
function errorReplyFor(settings: Record<string, unknown>): string {
    const val = settings.errorReply;
    return typeof val === 'string' ? val.trim() : '';
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
    target: {
        accountId: string;
        messageType: 'private' | 'group';
        groupId: number | null;
        userId: number;
        sessionKey: string;
    };
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
