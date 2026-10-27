/**
 * 状态事件流客户端（SSE）。
 *
 * 职责：
 *   - 建立 /api/events 长连接
 *   - 断线自动重连（指数退避，避免后端没起来时刷屏）
 *   - 把收到的变化通知给订阅者
 *
 * 为什么要它：轮询是固定节奏，服务异常最多晚一个间隔才被发现。
 * 有了事件流，上游断线、插件上下线这类变化在发生那一刻就能反映到界面。
 *
 * 低占用设计：
 *   - 事件本身只带"变了什么"，不携带整份快照
 *   - 同类事件在本地再合并一次（100ms），避免抖动的连锁刷新
 *   - 页面不可见时暂停重连，避免后台标签继续跑
 */

export type StatusEventKind = 'upstream' | 'downstream' | 'session' | 'config' | 'metrics';

export interface StatusEvent {
    kind: StatusEventKind;
    at: number;
    payload?: Record<string, unknown>;
}

type Listener = (events: StatusEvent[]) => void;

/** 断线重连的退避区间 */
const RECONNECT_MIN = 1000;
const RECONNECT_MAX = 15000;
/** 本地合并窗口 */
const COALESCE_MS = 100;

export class StatusStream {
    private source: EventSource | null = null;
    private listeners = new Set<Listener>();
    private pending: StatusEvent[] = [];
    private flushTimer: number | null = null;
    private reconnectTimer: number | null = null;
    private reconnectDelay = RECONNECT_MIN;
    private closed = false;
    /** 连接状态，供界面显示 */
    private connected = false;
    /** 最近一次收到事件的时间 */
    private lastEventAt = 0;

    get isConnected(): boolean {
        return this.connected;
    }

    get lastEventTime(): number {
        return this.lastEventAt;
    }

    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    connect(): void {
        if (this.closed || this.source) return;

        const es = new EventSource('/api/events');
        this.source = es;

        es.onopen = () => {
            this.connected = true;
            this.reconnectDelay = RECONNECT_MIN;
        };

        es.onerror = () => {
            // EventSource 自带重连，但它会在后端完全没起来时无限快速重试，
            // 这里主动接管：断开、按退避重连。
            this.connected = false;
            es.close();
            this.source = null;
            this.scheduleReconnect();
        };

        // 后端按 kind 命名事件，逐个订阅
        for (const kind of ['upstream', 'downstream', 'session', 'config', 'metrics'] as StatusEventKind[]) {
            es.addEventListener(kind, (e) => {
                this.lastEventAt = Date.now();
                const payload = parsePayload((e as MessageEvent).data);
                this.enqueue({ kind, at: this.lastEventAt, payload });
            });
        }
    }

    /** 停止并释放（页面卸载或需要彻底断开时） */
    stop(): void {
        this.closed = true;
        if (this.reconnectTimer !== null) {
            window.clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.flushTimer !== null) {
            window.clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        this.source?.close();
        this.source = null;
        this.connected = false;
        this.listeners.clear();
    }

    private scheduleReconnect(): void {
        if (this.closed) return;
        // 后台标签页不重连，等可见时再说
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;

        if (this.reconnectTimer !== null) return;
        this.reconnectTimer = window.setTimeout(() => {
            this.reconnectTimer = null;
            this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX);
            this.connect();
        }, this.reconnectDelay);
    }

    /** 合并窗口内的事件，一次性通知（避免抖动造成连锁刷新） */
    private enqueue(event: StatusEvent): void {
        this.pending.push(event);
        if (this.flushTimer !== null) return;
        this.flushTimer = window.setTimeout(() => {
            this.flushTimer = null;
            const batch = this.pending;
            this.pending = [];
            if (batch.length === 0) return;
            for (const listener of this.listeners) {
                try {
                    listener(batch);
                } catch {
                    /* 单个订阅者出错不影响其他 */
                }
            }
        }, COALESCE_MS);
    }
}

function parsePayload(data: unknown): Record<string, unknown> | undefined {
    if (typeof data !== 'string') return undefined;
    try {
        const parsed = JSON.parse(data) as { payload?: Record<string, unknown> };
        return parsed?.payload;
    } catch {
        return undefined;
    }
}

/** 全局单例 */
export const statusStream = new StatusStream();
