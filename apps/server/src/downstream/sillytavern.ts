/**
 * 酒馆（SillyTavern）下游适配器。
 *
 * 传输方向与其他下游相反：**酒馆扩展主动连进来**，Bridge 是 WS 服务端。
 * 所以这个适配器同时承担「入站连接管理」和「ask 投递」两件事：
 *
 *   Bridge ──WS(qq_message)──▶ 扩展 ──▶ 酒馆生成 ──WS(st_reply)──▶ Bridge
 *
 * ask() 的实现是：记下等待中的 requestId，把 qq_message 推给扩展，
 * 然后在超时内等扩展回包。多个扩展连上来时优先用最近握手的那一个。
 *
 * 命名配置：每个配置可以固定一张角色卡（+ 世界书），于是同一个酒馆
 * 实例能被不同会话当成不同角色用。配置里的 character/world 优先于
 * 会话级设置与会话默认值。
 */

import { WebSocket } from 'ws';
import { log } from '../core/logger.ts';
import type {
    DownstreamAdapter,
    DownstreamAsk,
    DownstreamConfig,
    DownstreamResult,
    DownstreamStatus,
} from './types.ts';

/** 扩展 → Bridge 的消息（统一协议） */
export interface ExtensionToBridge {
    type: string;
    requestId?: string;
    sessionKey?: string;
    text?: string;
    ext?: string;
    version?: string;
    characters?: string[];
    worlds?: string[];
    character?: string;
    world?: string;
}

export interface SillyTavernSettings {
    /** 单次等待回复的超时 */
    timeoutMs: number;
    /** 是否把会话级角色/世界书一起下发 */
    sendDefaults: boolean;
    /** 配置里固定的角色卡；空 = 用会话级/默认 */
    character: string;
    /** 配置里固定的世界书；空 = 用会话级/默认 */
    world: string;
}

export const DEFAULT_SETTINGS: SillyTavernSettings = {
    timeoutMs: 180000,
    sendDefaults: true,
    character: '',
    world: '',
};

/** 把宽松的 settings 收敛成 SillyTavernSettings */
export function normalizeSillyTavernSettings(
    raw: Record<string, unknown> | undefined,
): SillyTavernSettings {
    const s = (raw ?? {}) as Record<string, unknown>;
    return {
        timeoutMs: Number(s.timeoutMs) || DEFAULT_SETTINGS.timeoutMs,
        sendDefaults: s.sendDefaults !== false,
        character: String(s.character ?? ''),
        world: String(s.world ?? ''),
    };
}

interface Pending {
    resolve: (result: DownstreamResult) => void;
    timer: NodeJS.Timeout;
    startedAt: number;
}

export interface SillyTavernDeps {
    /** 读取某会话应使用的角色/世界书（含继承） */
    sessionDefaults: (sessionKey: string) => { character: string; world: string };
    /** 表情词表清单，随握手下发 */
    faceManifest: () => unknown;
}

export class SillyTavernAdapter implements DownstreamAdapter {
    readonly kind = 'sillytavern' as const;
    readonly id: string;
    readonly name: string;
    private settings: SillyTavernSettings;
    private readonly deps: SillyTavernDeps;
    private readonly clients = new Set<WebSocket>();
    private readonly pending = new Map<string, Pending>();
    private reqSeq = 0;
    /** 可用性变化回调 */
    private changeListener: (() => void) | null = null;

    constructor(
        id: string,
        name: string,
        config: DownstreamConfig,
        deps: SillyTavernDeps,
    ) {
        this.id = id;
        this.name = name;
        this.deps = deps;
        this.settings = normalizeSillyTavernSettings(config.settings);
    }

    async init(): Promise<void> {
        // 连接由 InboundServer 建立后调 attach() 注入，这里无需动作
    }

    async dispose(): Promise<void> {
        for (const [key, record] of this.pending) {
            clearTimeout(record.timer);
            record.resolve({ ok: false, text: '', elapsedMs: 0, error: '适配器已关闭' });
            this.pending.delete(key);
        }
        for (const socket of this.clients) {
            try {
                socket.close();
            } catch {
                /* 忽略 */
            }
        }
        this.clients.clear();
    }

    status(): DownstreamStatus {
        const online = this.onlineCount();
        return {
            id: this.id,
            kind: this.kind,
            name: this.name,
            enabled: true,
            available: online > 0,
            reason: online > 0 ? undefined : '酒馆扩展尚未连接',
            detail: {
                connections: online,
                pending: this.pending.size,
                timeoutMs: this.settings.timeoutMs,
            },
        };
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

    /** 由入站 WS 服务在握手后调用 */
    attach(socket: WebSocket): void {
        const before = this.onlineCount();
        this.clients.add(socket);
        log(`酒馆扩展已接入 [${this.id}]（当前 ${this.onlineCount()} 个连接）`);
        if (before === 0) this.changeListener?.();

        socket.send(JSON.stringify({
            type: 'session_state',
            sessions: {},
            defaults: {},
            imageReplies: {},
            faceTags: this.deps.faceManifest(),
        }));
        socket.send(JSON.stringify({ type: 'sync_request' }));
    }

    detach(socket: WebSocket): void {
        if (this.clients.delete(socket)) {
            log(`酒馆扩展已断开 [${this.id}]（剩余 ${this.onlineCount()}）`);
            if (this.onlineCount() === 0) this.changeListener?.();
        }
    }

    /** 处理扩展回包；返回 true 表示已消费 */
    handleMessage(msg: ExtensionToBridge): boolean {
        if (msg.type !== 'st_reply' && msg.type !== 'command_reply' && msg.type !== 'downstream_reply') {
            return false;
        }
        const requestId = msg.requestId;
        if (!requestId) return false;
        const record = this.pending.get(requestId);
        if (!record) return false;

        this.pending.delete(requestId);
        clearTimeout(record.timer);
        record.resolve({
            ok: true,
            text: String(msg.text ?? ''),
            elapsedMs: Date.now() - record.startedAt,
            via: 'sillytavern',
        });
        return true;
    }

    async ask(req: DownstreamAsk): Promise<DownstreamResult> {
        const socket = this.pickSocket();
        if (!socket) {
            return { ok: false, text: '', elapsedMs: 0, error: '酒馆扩展未连接' };
        }

        const requestId = `${this.id}_${++this.reqSeq}`;
        const startedAt = Date.now();

        // 上层已按会话合并好配置；缺省时退回实例设置
        const settings = req.settings
            ? normalizeSillyTavernSettings(req.settings)
            : this.settings;

        // 优先级：配置固定角色 > 会话级/默认（sendDefaults 关闭时都不用）
        const sessionDefaults = settings.sendDefaults
            ? this.deps.sessionDefaults(req.sessionKey)
            : { character: '', world: '' };
        const character = settings.character || sessionDefaults.character;
        const world = settings.world || sessionDefaults.world;

        return new Promise<DownstreamResult>((resolve) => {
            const timer = setTimeout(() => {
                if (!this.pending.delete(requestId)) return;
                resolve({
                    ok: false,
                    text: '',
                    elapsedMs: Date.now() - startedAt,
                    error: `酒馆 ${Math.round(settings.timeoutMs / 1000)}s 内未回复`,
                });
            }, settings.timeoutMs);

            this.pending.set(requestId, { resolve, timer, startedAt });

            try {
                socket.send(JSON.stringify({
                    type: 'qq_message',
                    requestId,
                    sessionKey: req.sessionKey,
                    sender: req.sender ?? 'QQ用户',
                    text: req.text,
                    defaultCharacter: character,
                    defaultWorld: world,
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

    /** 最近握手的可用连接 */
    private pickSocket(): WebSocket | null {
        let last: WebSocket | null = null;
        for (const s of this.clients) {
            if (s.readyState === WebSocket.OPEN) last = s;
        }
        return last;
    }
}
