import WebSocket from 'ws';
import type {
    OneBotClientOptions,
    OneBotEvent,
    OneBotResponse,
    SendTarget,
} from './types.js';
import type { OutgoingSegment } from '@bridge/core';

type Pending = {
    resolve: (r: OneBotResponse) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
};

/**
 * OneBot v11 正向 WebSocket 客户端。
 * 自动重连、动作超时、echo 匹配。
 */
export class OneBotClient {
    private ws: WebSocket | null = null;
    private pending = new Map<string, Pending>();
    private echoSeq = 0;
    private closed = false;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private readonly opts: Required<Pick<OneBotClientOptions, 'actionTimeoutMs' | 'reconnectDelayMs'>> & OneBotClientOptions;

    selfId = '';

    constructor(options: OneBotClientOptions) {
        this.opts = {
            actionTimeoutMs: 15000,
            reconnectDelayMs: 5000,
            ...options,
        };
    }

    get connected(): boolean {
        return this.ws?.readyState === WebSocket.OPEN;
    }

    connect(): void {
        if (this.closed) return;
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            return;
        }

        const url = this.opts.token
            ? `${this.opts.url}?access_token=${encodeURIComponent(this.opts.token)}`
            : this.opts.url;

        this.log('info', `连接 OneBot: ${this.opts.url}`);
        const ws = new WebSocket(url);
        this.ws = ws;

        ws.on('open', () => {
            this.log('info', 'OneBot 已连接');
            this.opts.onConnect?.();
        });

        ws.on('message', (raw) => {
            let event: OneBotEvent | OneBotResponse;
            try {
                event = JSON.parse(raw.toString());
            } catch {
                return;
            }

            const resp = event as OneBotResponse;
            if (resp.echo && this.pending.has(resp.echo)) {
                const p = this.pending.get(resp.echo)!;
                this.pending.delete(resp.echo);
                clearTimeout(p.timer);
                if (resp.status === 'failed') {
                    p.reject(new Error(resp.message ?? 'OneBot action failed'));
                } else {
                    p.resolve(resp);
                }
                return;
            }

            const ev = event as OneBotEvent & { self_id?: number; meta_event_type?: string };
            if (ev.self_id && ev.post_type === 'meta_event' && ev.meta_event_type === 'lifecycle') {
                this.selfId = String(ev.self_id);
                this.log('info', `机器人 QQ: ${this.selfId}`);
            }

            this.opts.onEvent?.(ev);
        });

        ws.on('close', () => {
            this.log('warn', 'OneBot 连接断开');
            this.opts.onDisconnect?.('closed');
            this.scheduleReconnect();
        });

        ws.on('error', (err) => {
            this.log('error', `OneBot WS 错误: ${err.message}`);
        });
    }

    private scheduleReconnect(): void {
        if (this.closed || this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, this.opts.reconnectDelayMs);
    }

    /** 调用 OneBot 动作 */
    private call<T = unknown>(action: string, params: Record<string, unknown>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                reject(new Error('OneBot 未连接'));
                return;
            }

            const echo = `b_${++this.echoSeq}`;
            const timer = setTimeout(() => {
                this.pending.delete(echo);
                reject(new Error(`OneBot 动作超时: ${action}`));
            }, this.opts.actionTimeoutMs);

            this.pending.set(echo, {
                resolve: (r) => resolve(r.data as T),
                reject,
                timer,
            });

            this.ws.send(JSON.stringify({ action, params, echo }));
        });
    }

    /** 发送消息（文本或消息段） */
    async send(target: SendTarget, message: string | OutgoingSegment[]): Promise<void> {
        const action = target.kind === 'group' ? 'send_group_msg' : 'send_private_msg';
        const params = target.kind === 'group'
            ? { group_id: target.groupId, message }
            : { user_id: target.userId, message };
        await this.call(action, params);
    }

    /** 主动关闭（不再重连） */
    disconnect(): void {
        this.closed = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        try {
            this.ws?.close();
        } catch {
            /* 忽略 */
        }
        this.ws = null;
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new Error('客户端已关闭'));
        }
        this.pending.clear();
    }

    private log(level: 'info' | 'warn' | 'error' | 'debug', text: string): void {
        this.opts.onLog?.(level, text);
    }
}
