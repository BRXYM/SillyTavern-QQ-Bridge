/**
 * 下游入站 WS 服务。
 *
 * 酒馆扩展和 dsh 连接插件的传输方向相同：**下游主动连进来**。
 * 所以 Bridge 只需要一个 WS 服务端，按握手消息里的 kind 把连接分发给对应适配器。
 *
 * 握手协议（统一）：
 *   下游 → Bridge  { type:'hello', kind:'sillytavern'|'dsh-plugin', ext, version, token? }
 *   Bridge → 下游  { type:'hello_ack', ok:true, downstreamId }
 *
 * 之后：
 *   酒馆  ← { type:'qq_message', requestId, ... }   → { type:'downstream_reply', requestId, text }
 *   dsh   ← { type:'downstream_ask', requestId, ... } → { type:'downstream_reply', requestId, text }
 */

import { WebSocketServer, WebSocket } from 'ws';
import { log } from '../core/logger.ts';

export interface InboundServerOptions {
    port: number;
    /** 握手 token；空则不校验 */
    token: () => string;
    /**
     * 按握手消息解析目标适配器。
     *
     * 优先用下游自报的 downstreamId（插件知道自己注册成哪个实例），
     * 没有再按 kind 兜底。返回 undefined 表示没有可接收的实例。
     */
    resolveAdapter: (kind: string, downstreamId: string) => InboundAdapter | undefined;
    /** 未知 kind 时的兜底：交给所有适配器试一次 */
    allAdapters: () => Array<{ handleMessage: (msg: Record<string, unknown>) => boolean }>;
}

/** 入站服务对适配器的最小要求 */
export interface InboundAdapter {
    readonly id: string;
    attach: (socket: WebSocket) => void;
    detach: (socket: WebSocket) => void;
    handleMessage: (msg: Record<string, unknown>) => boolean;
}

interface SocketMeta {
    kind: string;
    ext: string;
    version: string;
    connectedAt: number;
    lastPingAt: number;
    adapterId: string;
}

export class InboundServer {
    private readonly wss: WebSocketServer;
    private readonly options: InboundServerOptions;
    private readonly metas = new WeakMap<WebSocket, SocketMeta>();
    private heartbeat: NodeJS.Timeout | null = null;
    private readonly readiness: Promise<void>;

    constructor(options: InboundServerOptions) {
        this.options = options;
        this.wss = new WebSocketServer({ host: '127.0.0.1', port: options.port });
        this.readiness = new Promise<void>((resolve, reject) => {
            this.wss.once('listening', resolve);
            this.wss.once('error', reject);
        });
        this.wss.on('error', (error: Error) => log(`下游监听失败：${error.message}`));

        this.wss.on('listening', () => {
            log(`下游入站 WS 服务已启动: ws://127.0.0.1:${options.port}`);
        });

        this.wss.on('connection', (socket) => this.handleConnection(socket));

        // 心跳：30 秒一轮，上一轮没回 pong 的直接断掉
        this.heartbeat = setInterval(() => this.sweep(), 30000);
    }

    /** 主动关闭服务（退出时调用） */
    ready(): Promise<void> {
        return this.readiness;
    }

    async close(): Promise<void> {
        if (this.heartbeat) {
            clearInterval(this.heartbeat);
            this.heartbeat = null;
        }
        // 客户端可能不会响应关闭握手，退出时主动释放所有连接。
        for (const socket of this.wss.clients) socket.terminate();
        await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    }

    /** 当前连接摘要（供控制台） */
    connections(): Array<{ kind: string; ext: string; version: string; connectedAt: number; adapterId: string }> {
        const out: Array<{ kind: string; ext: string; version: string; connectedAt: number; adapterId: string }> = [];
        for (const client of this.wss.clients) {
            const meta = this.metas.get(client);
            if (meta) {
                out.push({
                    kind: meta.kind,
                    ext: meta.ext,
                    version: meta.version,
                    connectedAt: meta.connectedAt,
                    adapterId: meta.adapterId,
                });
            }
        }
        return out;
    }

    private handleConnection(socket: WebSocket): void {
        // ws 库的 ping/pong 用于探活
        const alive = { value: true };
        socket.on('pong', () => {
            alive.value = true;
            const meta = this.metas.get(socket);
            if (meta) meta.lastPingAt = Date.now();
        });

        socket.on('message', (raw) => {
            let msg: Record<string, unknown>;
            try {
                msg = JSON.parse(raw.toString()) as Record<string, unknown>;
            } catch {
                return;
            }

            const type = String(msg.type ?? '');

            if (type === 'hello') {
                this.handleHello(socket, msg);
                return;
            }
            if (type === 'ping') {
                const meta = this.metas.get(socket);
                if (meta) meta.lastPingAt = Date.now();
                this.send(socket, { type: 'pong' });
                return;
            }

            // 业务消息：先按握手的 kind 找适配器，找不到再全员试一次
            const meta = this.metas.get(socket);
            if (meta) {
                const adapter = this.options.resolveAdapter(meta.kind, meta.adapterId);
                if (adapter?.handleMessage(msg)) return;
            }
            for (const adapter of this.options.allAdapters()) {
                if (adapter.handleMessage(msg)) return;
            }
        });

        socket.on('close', () => {
            const meta = this.metas.get(socket);
            if (!meta) return;
            const adapter = this.options.resolveAdapter(meta.kind, meta.adapterId);
            adapter?.detach(socket);
        });

        socket.on('error', (e: Error) => {
            log(`下游 WS 错误：${e.message}`);
        });

        // 让 sweep 能读到存活标记
        (socket as WebSocket & { __alive?: { value: boolean } }).__alive = alive;
    }

    private handleHello(socket: WebSocket, msg: Record<string, unknown>): void {
        const kind = String(msg.kind ?? msg.ext ?? 'sillytavern');
        const token = String(msg.token ?? '');
        const expected = this.options.token();

        if (expected && token !== expected) {
            log(`⚠ 下游握手被拒绝（${kind}）：token 不匹配`);
            this.send(socket, { type: 'hello_ack', ok: false, error: 'token 不匹配' });
            try {
                socket.close();
            } catch {
                /* 忽略 */
            }
            return;
        }

        const wantId = String(msg.downstreamId ?? '');
        const adapter = this.options.resolveAdapter(kind, wantId);
        if (!adapter) {
            log(`⚠ 下游握手失败：未知类型 ${kind}`);
            this.send(socket, { type: 'hello_ack', ok: false, error: `未知下游类型 ${kind}` });
            return;
        }

        const meta: SocketMeta = {
            kind,
            ext: String(msg.ext ?? kind),
            version: String(msg.version ?? ''),
            connectedAt: Date.now(),
            lastPingAt: 0,
            adapterId: adapter.id,
        };
        this.metas.set(socket, meta);

        if (typeof msg.pid === 'number') {
            const holder = socket as WebSocket & {
                dshPid?: number;
                dshProfile?: string;
                dshVersion?: string;
                connectedAt?: number;
            };
            holder.dshPid = msg.pid;
            holder.dshProfile = String(msg.profile ?? '');
            holder.dshVersion = String(msg.version ?? '');
            holder.connectedAt = Date.now();
        }

        adapter.attach(socket);
        this.send(socket, { type: 'hello_ack', ok: true, downstreamId: kind });
    }

    /** 心跳清扫 */
    private sweep(): void {
        for (const client of this.wss.clients) {
            const holder = client as WebSocket & { __alive?: { value: boolean } };
            const alive = holder.__alive;
            if (alive && !alive.value) {
                try {
                    client.terminate();
                } catch {
                    /* 忽略 */
                }
                continue;
            }
            if (alive) alive.value = false;
            try {
                client.ping();
            } catch {
                /* 忽略 */
            }
        }
    }

    private send(socket: WebSocket, obj: unknown): void {
        try {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj));
        } catch (e) {
            log(`下游发送失败：${e instanceof Error ? e.message : String(e)}`);
        }
    }
}
