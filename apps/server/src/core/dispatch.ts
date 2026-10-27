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
import type { DownstreamAdapter } from '../downstream/types.ts';
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
    const allowedGroups = Array.isArray(t.allowedGroups) ? t.allowedGroups : [];
    const allowedUsers = Array.isArray(t.allowedUsers) ? t.allowedUsers : [];

    if (messageType === 'group' && allowedGroups.length > 0) {
        if (!allowedGroups.some((g) => String(g) === String(groupId))) return '群不在白名单';
    }
    if (allowedUsers.length > 0) {
        if (!allowedUsers.some((u) => String(u) === String(userId))) return '用户不在白名单';
    }
    if (messageType === 'private' && t.privateReply === false) return '私聊回复已关闭';
    if (messageType === 'group' && t.atOnly && !atMe) return '群里未 @ 机器人';
    return null;
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

    // ---- 询问下游 ----
    const userText = messageType === 'group' ? `[群成员 ${senderName}] ${parsed.text}` : parsed.text;
    const result = await adapter.ask({
        sessionKey,
        text: userText,
        system: buildSystemPrompt(config, sessionKey, deps, adapter),
        sender: senderName,
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
