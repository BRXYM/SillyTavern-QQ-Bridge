/**
 * 多账号上游管理。
 *
 * 一个 Bridge 进程同时接多个 QQ 号：每个号在 SnowLuma 里是一份独立的
 * `onebot_<uin>.json`，WS 端口与 access token 都不同。所以「上游」不是
 * 一条连接，而是一组按账号 id 索引的连接。
 *
 * 这个类只做**装配与生命周期**：
 *   - 每个启用的账号各一条 OneBotClient
 *   - 事件汇总到一处，并在交给业务前先把 accountId 补进事件
 *   - 状态查询按账号返回，供控制台展示
 *
 * 它不解析事件语义、不认识下游 —— 那是 dispatch 的事。
 */

import { EventEmitter } from 'node:events';
import { OneBotClient, type OneBotEvent, type UpstreamOptions, type UpstreamStats } from './onebot.ts';
import { log } from '../core/logger.ts';

/** 上游账号的配置（与 AccountConfig 同形，避免循环依赖强绑 schema） */
export interface UpstreamAccount {
    id: string;
    uin: string;
    name: string;
    enabled: boolean;
    upstream: UpstreamOptions;
}

/** 一条上游的运行时视图 */
export interface UpstreamView {
    id: string;
    uin: string;
    name: string;
    enabled: boolean;
    stats: UpstreamStats;
}

/**
 * 带账号信息的事件。
 *
 * 下游与业务层都靠 `accountId` 判断"这条消息是哪个号收到的"，
 * 回包时也要用它选对上游 —— 否则 A 号收到的消息会用 B 号发出去。
 */
export interface AccountEvent extends OneBotEvent {
    accountId: string;
}

export class UpstreamManager extends EventEmitter {
    private readonly clients = new Map<string, OneBotClient>();
    private readonly accounts = new Map<string, UpstreamAccount>();

    /** 按当前配置重建全部连接（配置变更时调用） */
    apply(accounts: UpstreamAccount[]): { added: string[]; removed: string[]; updated: string[] } {
        const want = new Map<string, UpstreamAccount>();

        /**
         * 同一个端点只允许一个账号连。
         *
         * 两个账号指向同一 host:port 时，两条 WebSocket 连到的是**同一个**
         * SnowLuma 实例，因此两条连接收到的都是同一个号的消息 ——
         * 结果就是同一条消息被处理两次、回复两次，而且两个账号的
         * selfId 都显示成同一个号。
         *
         * SnowLuma 每个号各自监听自己的 wsServer，正确做法是每个号一个端口。
         * 这里丢弃重复项并明确记日志，比让它静默双发要好得多。
         */
        const claimed = new Map<string, string>();
        for (const acc of accounts) {
            if (!acc.enabled) continue;
            const endpoint = endpointKey(acc.upstream.url);
            const owner = claimed.get(endpoint);
            if (owner) {
                log(
                    `⚠ 账号 ${acc.id} 与 ${owner} 指向同一端点 ${acc.upstream.url}，已跳过。`
                    + '每个 QQ 号应使用不同的 OneBot 端口（或用「自动配置连接」自动分配）',
                );
                continue;
            }
            claimed.set(endpoint, acc.id);
            want.set(acc.id, acc);
        }

        const added: string[] = [];
        const removed: string[] = [];
        const updated: string[] = [];

        // 先移除不再需要的
        for (const [id, client] of this.clients) {
            if (!want.has(id)) {
                client.dispose();
                this.clients.delete(id);
                this.accounts.delete(id);
                removed.push(id);
            }
        }

        // 再新增或更新
        for (const [id, acc] of want) {
            const cur = this.clients.get(id);
            if (!cur) {
                this.createClient(acc);
                added.push(id);
                continue;
            }
            const prev = this.accounts.get(id);
            if (!prev || !sameUpstream(prev.upstream, acc.upstream)) {
                cur.reconfigure(acc.upstream);
                cur.dispose();
                // OneBotClient 的 dispose 会永久停用实例，替换成新的更安全
                this.clients.delete(id);
                this.createClient(acc);
                updated.push(id);
            } else {
                // 只改了显示用字段
                this.accounts.set(id, acc);
            }
        }

        return { added, removed, updated };
    }

    /** 建立一条连接并接好事件转发 */
    private createClient(acc: UpstreamAccount): void {
        const client = new OneBotClient(acc.upstream);
        this.clients.set(acc.id, client);
        this.accounts.set(acc.id, acc);

        client.on('connected', () => {
            log(`✓ 账号 ${acc.id} 已连接 SnowLuma`);
            this.emit('account-connected', acc.id);
        });
        client.on('disconnected', () => {
            this.emit('account-disconnected', acc.id);
        });
        client.on('upstream-error', (message: string) => {
            this.emit('account-error', acc.id, message);
        });
        client.on('event', (event: OneBotEvent) => {
            // 补上账号维度：之后所有环节都靠它区分来源
            const scoped: AccountEvent = { ...event, accountId: acc.id };
            this.emit('event', scoped);
        });

        client.connect();
    }

    /** 已建立的连接（按账号 id） */
    list(): UpstreamView[] {
        const out: UpstreamView[] = [];
        for (const [id, client] of this.clients) {
            const acc = this.accounts.get(id);
            if (!acc) continue;
            out.push({
                id,
                uin: acc.uin,
                name: acc.name,
                enabled: acc.enabled,
                stats: client.stats,
            });
        }
        return out;
    }

    /** 取某个账号的上游客户端（发送消息用） */
    client(accountId: string): OneBotClient | undefined {
        return this.clients.get(accountId);
    }

    /** 取配置（含未启用的） */
    account(accountId: string): UpstreamAccount | undefined {
        return this.accounts.get(accountId);
    }

    /** 按 uin 找账号 id（SnowLuma 的 OneBot 事件里只有 self_id） */
    accountIdByUin(uin: string): string | undefined {
        const target = String(uin ?? '').trim();
        if (!target) return undefined;
        for (const [id, acc] of this.accounts) {
            if (String(acc.uin) === target) return id;
        }
        return undefined;
    }

    /** 汇总统计（总览页用） */
    totals(): { accounts: number; connected: number; eventsIn: number; actionsOut: number; actionErrors: number } {
        let eventsIn = 0;
        let actionsOut = 0;
        let actionErrors = 0;
        let connected = 0;
        for (const view of this.list()) {
            if (view.stats.connected) connected += 1;
            eventsIn += view.stats.eventsIn;
            actionsOut += view.stats.actionsOut;
            actionErrors += view.stats.actionErrors;
        }
        return { accounts: this.clients.size, connected, eventsIn, actionsOut, actionErrors };
    }

    /** 主动重连某个账号（改完它的配置后） */
    reconnect(accountId: string): void {
        const client = this.clients.get(accountId);
        if (!client) return;
        client.dispose();
        const acc = this.accounts.get(accountId);
        if (!acc) return;
        this.clients.delete(accountId);
        this.createClient(acc);
    }

    /** 退出时释放全部连接 */
    dispose(): void {
        for (const client of this.clients.values()) {
            try {
                client.dispose();
            } catch {
                /* 忽略 */
            }
        }
        this.clients.clear();
        this.accounts.clear();
    }
}

/** 比较两套上游参数是否等价（用于判断要不要重连） */
function sameUpstream(a: UpstreamOptions, b: UpstreamOptions): boolean {
    return a.url === b.url
        && a.token === b.token
        && a.reconnectMs === b.reconnectMs
        && a.actionTimeoutMs === b.actionTimeoutMs;
}

/**
 * 端点的比较键：只看 host:port。
 *
 * path 与 token 都不参与判定 —— 指向同一端口就是同一个 SnowLuma 实例，
 * 无论路径写成什么，两条连接都会收到同一批事件。
 */
function endpointKey(url: string): string {
    try {
        const u = new URL(url);
        return `${u.hostname.toLowerCase()}:${u.port || (u.protocol === 'wss:' ? '443' : '80')}`;
    } catch {
        return String(url).trim().toLowerCase();
    }
}
