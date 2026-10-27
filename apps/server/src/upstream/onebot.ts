/**
 * SnowLuma / OneBot v11 上游客户端。
 *
 * 这是整个 Bridge 的**唯一上行数据源**：所有 QQ 消息都从这里进来，
 * 所有发往 QQ 的动作也从这里出去。下游适配器不直接碰 OneBot。
 *
 * 职责边界：
 *   - 连接、重连、鉴权（access_token 拼在 URL 上，OneBot v11 规范做法）
 *   - echo ↔ 请求响应关联与超时
 *   - 把事件交给 onEvent 回调（不认识业务语义）
 *   - 统计（收包数、发包数、错误数）
 */

import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { log } from '../core/logger.ts';

export interface OneBotEvent {
    post_type?: string;
    message_type?: 'private' | 'group';
    sub_type?: string;
    self_id?: number | string;
    user_id?: number;
    group_id?: number;
    message?: unknown;
    raw_message?: string;
    sender?: { nickname?: string; card?: string };
    event?: OneBotEvent;
    meta_event_type?: string;
    request_type?: string;
    [key: string]: unknown;
}

export interface UpstreamOptions {
    url: string;
    token: string;
    reconnectMs: number;
    actionTimeoutMs: number;
}

export interface UpstreamStats {
    connected: boolean;
    connectedAt: number;
    disconnectedAt: number;
    reconnectCount: number;
    lastError: string;
    lastErrorAt: number;
    eventsIn: number;
    actionsOut: number;
    actionErrors: number;
    lastEventAt: number;
    nickname: string;
    selfId: string;
}

interface Pending {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

export class OneBotClient extends EventEmitter {
    private socket: WebSocket | null = null;
    private echoSeq = 0;
    private readonly pending = new Map<string, Pending>();
    private reconnectTimer: NodeJS.Timeout | null = null;
    private disposed = false;
    private readonly options: UpstreamOptions;

    readonly stats: UpstreamStats = {
        connected: false,
        connectedAt: 0,
        disconnectedAt: 0,
        reconnectCount: 0,
        lastError: '',
        lastErrorAt: 0,
        eventsIn: 0,
        actionsOut: 0,
        actionErrors: 0,
        lastEventAt: 0,
        nickname: '',
        selfId: '',
    };

    constructor(options: UpstreamOptions) {
        super();
        this.options = options;
    }

    /** 更新连接参数（配置热更新时调用，内部会重连） */
    reconfigure(options: Partial<UpstreamOptions>): void {
        Object.assign(this.options, options);
    }

    connect(): void {
        if (this.disposed) return;
        this.clearReconnect();

        const { url, token } = this.options;
        const target = token
            ? `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`
            : url;

        log(`连接 SnowLuma: ${url}`);
        const socket = new WebSocket(target);
        this.socket = socket;

        socket.on('open', () => {
            this.stats.connected = true;
            this.stats.connectedAt = Date.now();
            this.stats.lastError = '';
            log('✓ 已连接 SnowLuma');
            this.emit('connected');
        });

        socket.on('message', (raw) => {
            this.handleRaw(raw.toString());
        });

        socket.on('close', () => {
            this.stats.connected = false;
            this.stats.disconnectedAt = Date.now();
            this.stats.reconnectCount += 1;
            this.failAllPending('OneBot WS 已断开');
            this.socket = null;
            this.emit('disconnected');
            if (!this.disposed) {
                log(`SnowLuma 断开，${Math.round(this.options.reconnectMs / 1000)} 秒后重连…`);
                this.scheduleReconnect();
            }
        });

        socket.on('error', (e: Error) => {
            this.stats.lastError = e.message;
            this.stats.lastErrorAt = Date.now();
            log(`SnowLuma WS 错误: ${e.message}`);
        });
    }

    /** 断开并停止重连 */
    dispose(): void {
        this.disposed = true;
        this.clearReconnect();
        this.failAllPending('客户端已关闭');
        try {
            this.socket?.close();
        } catch {
            /* 忽略 */
        }
        this.socket = null;
    }

    /**
     * 调用一个 OneBot action。
     * @param action 例如 send_private_msg
     * @param params action 参数
     */
    call<T = unknown>(action: string, params: Record<string, unknown>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
                this.stats.actionErrors += 1;
                reject(new Error('OneBot WS 未连接'));
                return;
            }

            const echo = `bridge_${++this.echoSeq}`;
            const timer = setTimeout(() => {
                if (!this.pending.has(echo)) return;
                this.pending.delete(echo);
                this.stats.actionErrors += 1;
                reject(new Error(`OneBot 动作超时: ${action}`));
            }, this.options.actionTimeoutMs);

            this.pending.set(echo, {
                resolve: resolve as (value: unknown) => void,
                reject,
                timer,
            });

            this.stats.actionsOut += 1;
            try {
                this.socket.send(JSON.stringify({ action, params, echo }));
            } catch (e) {
                this.pending.delete(echo);
                clearTimeout(timer);
                this.stats.actionErrors += 1;
                reject(e instanceof Error ? e : new Error(String(e)));
            }
        });
    }

    private handleRaw(text: string): void {
        let event: OneBotEvent;
        try {
            event = JSON.parse(text) as OneBotEvent;
        } catch {
            return;
        }

        // 响应包：有 echo 且能对上挂起表
        const echo = event.echo;
        if (typeof echo === 'string' && this.pending.has(echo)) {
            const record = this.pending.get(echo)!;
            this.pending.delete(echo);
            clearTimeout(record.timer);
            if (event.status === 'failed') {
                this.stats.actionErrors += 1;
                record.reject(new Error(String(event.message ?? 'failed')));
            } else {
                record.resolve(event);
            }
            return;
        }

        this.stats.eventsIn += 1;
        this.stats.lastEventAt = Date.now();

        // 生命周期事件里拿机器人自身 QQ
        if (event.post_type === 'meta_event' && event.meta_event_type === 'lifecycle') {
            const id = String(event.self_id ?? '');
            if (id && id !== this.stats.selfId) {
                this.stats.selfId = id;
                log('机器人 QQ:', id);
            }
        }

        // 从消息事件补充昵称（只取第一次，避免刷屏）
        const nickname = event.sender?.nickname;
        if (nickname && !this.stats.nickname) {
            this.stats.nickname = String(nickname);
        }

        this.emit('event', event);
    }

    private scheduleReconnect(): void {
        this.clearReconnect();
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, this.options.reconnectMs);
    }

    private clearReconnect(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    private failAllPending(reason: string): void {
        for (const [echo, record] of this.pending) {
            clearTimeout(record.timer);
            record.reject(new Error(reason));
            this.pending.delete(echo);
        }
    }
}
