/**
 * SSE 状态流。
 *
 * GET /api/events
 *
 * 只推「发生了什么」，不推整份快照：
 *   { kind: 'upstream', at, payload }
 *   { kind: 'downstream', ... }
 * 前端收到后按需刷新对应区块（或直接拉一次 /api/status）。
 *
 * 与轮询的关系：SSE 是主通道，轮询退化为兜底（断线重连、SSE 不可用时）。
 * 这样服务异常能在事件发生的那一刻被发现，而不是等下一个轮询周期。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { statusBus, type StatusEvent, type StatusEventKind } from '../core/events.ts';
import { logger } from '../core/logger.ts';

/** 心跳间隔：保持连接活着的代价极小，同时能让前端及时发现断流 */
const HEARTBEAT_MS = 25000;

export function handleEventStream(req: IncomingMessage, res: ServerResponse): () => void {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        // 关闭代理缓冲，否则事件会被攒着一起发
        'X-Accel-Buffering': 'no',
    });

    // 建连后先发一条注释，让前端 onopen 立刻触发
    res.write(': connected\n\n');

    const detach = statusBus.attach();

    const onEvents = (batch: StatusEvent[]) => {
        for (const event of batch) {
            writeEvent(res, event.kind, event);
        }
    };

    statusBus.on('events', onEvents);

    const heartbeat = setInterval(() => {
        try {
            // 注释行既保活又不触发前端逻辑
            res.write(`: ping ${Date.now()}\n\n`);
        } catch {
            /* 连接已断，close 会处理 */
        }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    const cleanup = () => {
        clearInterval(heartbeat);
        statusBus.off('events', onEvents);
        detach();
    };

    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
    return cleanup;
}

function writeEvent(res: ServerResponse, event: string, data: unknown): void {
    try {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
        /* 写入失败说明连接已断，交给 close 事件收尾 */
    }
}

/**
 * 便捷发布函数：各处调用，统一在这里兜住异常。
 * 事件总线出问题不应该影响主流程。
 */
export function publishStatus(kind: StatusEventKind, payload?: Record<string, unknown>): void {
    try {
        statusBus.publish(kind, payload);
    } catch (e) {
        logger.warn(`状态事件发布失败：${e instanceof Error ? e.message : String(e)}`);
    }
}
