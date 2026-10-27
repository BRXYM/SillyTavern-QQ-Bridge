/**
 * 消息发送层：把最终文本变成 QQ 消息。
 *
 * 这是 Bridge 的**唯一出口**，上游 OneBot 客户端只被它调用。
 * 职责：分段 → 动作标记转换 → 表情/图片解析 → 逐条发送（带延迟）。
 *
 * 分段与媒体解析全部来自 @bridge/core，不再自建实现。
 */

import {
    segmentText,
    buildOutgoingPayload,
    splitMediaTags,
    convertActionMarkers,
} from '@bridge/core';
import type { SegmentationConfig } from '@bridge/shared';
import type { OneBotClient } from '../upstream/onebot.ts';
import type { SessionStore, SessionRoute } from '../core/sessions.ts';
import { log } from '../core/logger.ts';

export interface SendOptions {
    messageType: 'private' | 'group';
    groupId: number | null;
    userId: number;
    /** 用于计数（可选） */
    sessionKey?: string;
}

export interface SendContext {
    onebot: OneBotClient;
    sessions: SessionStore;
    segmentation: () => SegmentationConfig;
    maxMessageLength: () => number;
    /**
     * 把 `[表情:无语,委屈]` 解析成图片 URL。
     * 返回 null 表示未命中，该标记会被丢弃（不把标签原文发出去）。
     */
    resolveFace: (token: string, tags: string[]) => string | null;
    /** 表情库摘要，用于"本轮未发"的日志 */
    faceSummary: () => string;
}

/**
 * 发送一条（可能被拆成多条）QQ 消息。
 * 失败只记日志不抛异常——发送失败不应该让调用方的流程中断。
 */
export async function sendReply(ctx: SendContext, target: SendOptions, text: string): Promise<void> {
    const body = String(text ?? '').trim();
    if (!body) return;

    const segments = segmentText(body, ctx.segmentation(), ctx.maxMessageLength());
    if (segments.length === 0) return;

    const label = target.messageType === 'group' ? `群${target.groupId}` : `私聊${target.userId}`;
    const decision = { hasMark: false, sent: 0, failed: 0, tokens: [] as string[] };

    for (let i = 0; i < segments.length; i += 1) {
        const seg = segments[i]!;
        if (seg.delayMs > 0) {
            await new Promise((r) => setTimeout(r, seg.delayMs));
        }

        const payload = buildOutgoingPayload(seg.text, (token) => {
            decision.hasMark = true;
            decision.tokens.push(token);
            try {
                const tags = token.startsWith('#') ? [token] : splitMediaTags(token);
                if (tags.length === 0) {
                    decision.failed += 1;
                    return null;
                }
                const url = ctx.resolveFace(token, tags);
                if (url) {
                    decision.sent += 1;
                    return url;
                }
                decision.failed += 1;
                return null;
            } catch (e) {
                log(`表情解析异常：${e instanceof Error ? e.message : String(e)}`);
                decision.failed += 1;
                return null;
            }
        });

        if (payload === '' || (Array.isArray(payload) && payload.length === 0)) {
            log(`分段 ${i + 1} 只有未命中的表情标记，跳过发送`);
            continue;
        }

        try {
            await sendOne(ctx.onebot, target, payload);
            log(`分段 ${i + 1}/${segments.length} 已发往QQ → ${label} (${seg.text.length}字)`);
        } catch (e) {
            log(`QQ 发送失败(${label})：${e instanceof Error ? e.message : String(e)}`);
        }
    }

    logFaceDecision(decision, ctx.faceSummary());

    if (target.sessionKey) ctx.sessions.bumpOut(target.sessionKey);
}

/** 发送单条消息（文本或消息段数组） */
async function sendOne(
    onebot: OneBotClient,
    target: SendOptions,
    payload: string | Array<{ type: string; data: unknown }>,
): Promise<void> {
    const action = target.messageType === 'group' ? 'send_group_msg' : 'send_private_msg';
    const params = target.messageType === 'group'
        ? { group_id: target.groupId, message: payload }
        : { user_id: target.userId, message: payload };
    await onebot.call(action, params);
}

/** 表情决策汇总：让"为什么没发表情"在日志里一目了然 */
function logFaceDecision(
    d: { hasMark: boolean; sent: number; failed: number; tokens: string[] },
    library: string,
): void {
    if (!d.hasMark) {
        log(`  └ 表情：本轮未发（AI 未生成表情标记）｜库内 ${library}`);
        return;
    }
    if (d.sent === 0 && d.failed > 0) {
        log(`  └ 表情：本轮未发（${d.failed} 个标记全部未命中）｜AI 给的标签 [${d.tokens.join(' | ')}]`);
        return;
    }
    log(
        `  └ 表情：发出 ${d.sent} 个`
        + (d.failed ? `，失败 ${d.failed} 个` : '')
        + `｜标签 [${d.tokens.join(' | ')}]`,
    );
}

/** 从路由信息构造发送目标 */
export function targetFromRoute(route: SessionRoute): SendOptions {
    return {
        messageType: route.messageType,
        groupId: route.groupId,
        userId: route.userId,
        sessionKey: route.sessionKey,
    };
}

export { convertActionMarkers };
