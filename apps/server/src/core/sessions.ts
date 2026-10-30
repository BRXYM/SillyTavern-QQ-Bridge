/**
 * 会话状态：路由、计数、每个会话的下游与配置选择。
 *
 * 会话的身份由三部分决定：**哪个机器人账号** + 群/人 + 谁在说话。
 *
 * 为什么账号也进 key：同一个人在 A 号和 B 号私聊，是两个独立的关系 ——
 * 两个号可能扮不同角色、各自记得自己的对话。若不区分账号，两个号的
 * 上下文与下游绑定会互相覆盖，表现为"两个号说同一句话"。
 *
 * 选择的下游有两层：
 *   sessions[key].backendId 有值   → 用该实例
 *   sessions[key].backendId 缺失   → 用全局 defaultDownstreamId
 *   sessions[key].profileId 有值   → 用该实例下的这个命名配置
 *   sessions[key].profileId 缺失   → 「继承」
 */

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

/** 一次消息的投递目标 */
export interface SessionRoute {
    sessionKey: string;
    /** 收发的机器人账号 id（多账号路由与发送都要它） */
    accountId: string;
    messageType: 'private' | 'group';
    groupId: number | null;
    userId: number;
}

/** 会话级配置（持久化到 sessions.json） */
export interface SessionChoice {
    flowId?: string;
    flowDefault?: boolean;
    /** 独立会话配置：缺失继承，空字符串明确不使用。 */
    conversationId?: string;
    character?: string;
    world?: string;
    /** 下游实例 id；缺失 = 继承全局默认 */
    backendId?: string;
    /**
     * 该下游实例下的命名配置 id；缺失 = 继承全局默认配置。
     * 显式设为空串表示「明确不用任何配置」，与「缺失」不同。
     */
    profileId?: string;
    /** 回复处理管道覆盖；缺失 = 继承全局 */
    replyProcessors?: unknown[];
    createdAt?: string;
    updatedAt?: string;
}

export interface SessionStat {
    in: number;
    out: number;
    last: number;
}

export interface ResolvedSession {
    /** 实际生效的下游 id */
    backendId: string;
    /** true = 来自全局默认，false = 会话级指定 */
    inherited: boolean;
    /** 实际生效的下游配置 id；空串 = 该实例的实例级设置 */
    profileId: string;
    /** true = 该配置来自全局默认（或没指定），false = 会话级指定 */
    profileInherited: boolean;
    character: string;
    world: string;
}

/** 全局默认（由 index.ts 从配置里读，避免与 config store 循环依赖） */
export interface SessionDefaults {
    backendId: string;
    profileId: string;
    character: string;
    world: string;
}

export class SessionStore extends EventEmitter {
    /** 会话级配置 */
    private choices: Record<string, SessionChoice> = {};
    /** 被拒的新会话（不落盘主体，随 flush 一起写） */
    private pending: Record<string, {
        userId: number;
        groupId: number | null;
        messageType: string;
        senderName: string;
        lastAt: string;
    }> = {};
    /** 运行时路由（不落盘，重启后由第一条消息重建） */
    private readonly routes = new Map<string, SessionRoute>();
    /** 收发计数 */
    private readonly stats = new Map<string, SessionStat>();

    private saveTimer: NodeJS.Timeout | null = null;

    /** 会话文件路径 */
    private readonly file: string;
    /** 读取当前生效的全局默认 */
    private readonly readDefaults: () => SessionDefaults;

    constructor(file: string, readDefaults: () => SessionDefaults) {
        super();
        this.file = file;
        this.readDefaults = readDefaults;
    }

    load(): void {
        let raw: Record<string, unknown> = {};
        try {
            raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, unknown>;
        } catch {
            this.choices = {};
            return;
        }

        for (const [key, value] of Object.entries(raw)) {
            if (key === '__pending') continue;
            if (!value || typeof value !== 'object') continue;
            const legacy = value as SessionChoice & { backend?: string };
            // 兼容更早的枚举字段 backend（'taver' | 'dsh'）
            if (legacy.backendId === undefined && typeof legacy.backend === 'string') {
                legacy.backendId = legacy.backend === 'dsh' ? 'dsh' : 'tavern';
                delete legacy.backend;
            }
            this.choices[key] = legacy;
        }

        // pending 存在单独的键里，避免与会话配置混淆
        const pending = raw.__pending;
        if (pending && typeof pending === 'object') {
            this.pending = pending as typeof this.pending;
        }
    }

    /**
     * 旧会话 key 加上账号前缀。
     *
     * 升级前所有会话都属于唯一那个号，所以把它们挂到第一个账号下最稳妥 ——
     * 既不会丢配置，也不会让用户看到一堆"新会话"。
     * 只处理没有账号前缀的 key（`private_123` / `group_456_123`）。
     */
    adoptLegacyKeys(accountId: string): number {
        if (!accountId) return 0;
        const prefix = `${accountId}:`;
        let migrated = 0;

        for (const [key, value] of Object.entries(this.choices)) {
            if (key.startsWith(prefix)) continue;
            if (key.includes(':')) continue;
            if (!/^(private|group)_/.test(key)) continue;
            delete this.choices[key];
            this.choices[`${prefix}${key}`] = value;
            migrated += 1;
        }

        if (migrated > 0) {
            this.scheduleSave();
            this.emit('migrated', migrated);
        }
        return migrated;
    }

    /** 防抖落盘：500ms 内多次变更只写一次 */
    private scheduleSave(): void {
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.flush();
        }, 500);
    }

    /** 立即写盘（退出前调用） */
    flush(): void {
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            // __pending 与会话配置共存于同一文件：一个文件便于备份与迁移
            const payload = {
                ...this.choices,
                ...(Object.keys(this.pending).length > 0 ? { __pending: this.pending } : {}),
            };
            fs.writeFileSync(this.file, `${JSON.stringify(payload, null, 4)}\n`, 'utf8');
        } catch (e) {
            this.emit('error', e);
        }
    }

    // ---------------- 路由与统计 ----------------

    /** 记录一次消息的投递目标，供下游回包时找回路由 */
    rememberRoute(route: SessionRoute): void {
        this.routes.set(route.sessionKey, route);
    }

    route(sessionKey: string): SessionRoute | undefined {
        return this.routes.get(routeKey(sessionKey));
    }

    /** 最近活跃的会话 key，用于回包缺 sessionKey 时的兜底路由 */
    mostRecentSession(): string | null {
        let best: string | null = null;
        let bestAt = 0;
        for (const [key, stat] of this.stats) {
            if (stat.last > bestAt) {
                bestAt = stat.last;
                best = key;
            }
        }
        return best;
    }

    bumpIn(sessionKey: string): void {
        const stat = this.stats.get(sessionKey) ?? { in: 0, out: 0, last: 0 };
        stat.in += 1;
        stat.last = Date.now();
        this.stats.set(sessionKey, stat);
    }

    bumpOut(sessionKey: string): void {
        const stat = this.stats.get(sessionKey);
        if (stat) stat.out += 1;
    }

    statsSnapshot(): Record<string, SessionStat> {
        return Object.fromEntries(this.stats);
    }

    // ---------------- 会话级配置 ----------------

    /** 新会话建档（只记 createdAt，其余继承默认） */
    ensure(sessionKey: string): void {
        if (this.choices[sessionKey]) return;
        this.choices[sessionKey] = { createdAt: new Date().toISOString() };
        this.scheduleSave();
        this.emit('created', sessionKey);
    }

    get(sessionKey: string): SessionChoice | undefined {
        return this.choices[sessionKey];
    }

    /** 合并更新某个会话的配置 */
    patch(sessionKey: string, patch: Partial<SessionChoice>): void {
        this.choices[sessionKey] = {
            ...(this.choices[sessionKey] ?? { createdAt: new Date().toISOString() }),
            ...patch,
            updatedAt: new Date().toISOString(),
        };
        this.scheduleSave();
        this.emit('changed', sessionKey, this.choices[sessionKey]);
    }

    /** 清除某字段，回到继承状态 */
    clearField(sessionKey: string, field: keyof SessionChoice): void {
        const cur = this.choices[sessionKey];
        if (!cur || !(field in cur)) return;
        delete cur[field];
        cur.updatedAt = new Date().toISOString();
        this.scheduleSave();
        this.emit('changed', sessionKey, cur);
    }

    /** 删除整个会话配置 */
    remove(sessionKey: string): void {
        if (!(sessionKey in this.choices)) return;
        delete this.choices[sessionKey];
        this.scheduleSave();
        this.emit('removed', sessionKey);
    }

    /** 解析某会话实际生效的配置（含继承） */
    resolve(sessionKey: string): ResolvedSession {
        const own = this.choices[sessionKey] ?? {};
        const def = this.readDefaults();
        const backendId = own.backendId ?? def.backendId;

        // 配置归属：会话显式指定了实例时，不能用全局默认配置
        // （全局默认配置属于全局默认实例，套到别的实例上会串味）。
        const ownProfile = own.profileId;
        const backendMatchesDefault = backendId === def.backendId;
        const profileId = ownProfile !== undefined
            ? ownProfile
            : (backendMatchesDefault ? def.profileId : '');

        return {
            backendId,
            inherited: own.backendId === undefined,
            profileId,
            profileInherited: ownProfile === undefined,
            character: own.character || def.character,
            world: own.world || def.world,
        };
    }

    /** 会话被拒时的记录（新会话被拦下时留痕，便于控制台看到"有人在敲门"） */
    notePending(
        sessionKey: string,
        info: { userId: number; groupId: number | null; messageType: string; senderName: string },
    ): void {
        if (!this.pending) this.pending = {};
        this.pending[sessionKey] = {
            ...info,
            lastAt: new Date().toISOString(),
        };
        // 只保留最近 50 条，避免无限增长
        const keys = Object.keys(this.pending);
        if (keys.length > 50) {
            for (const k of keys.slice(0, keys.length - 50)) delete this.pending[k];
        }
        this.scheduleSave();
    }

    /** 读取被拒记录 */
    pendingSnapshot(): Record<string, { userId: number; groupId: number | null; messageType: string; senderName: string; lastAt: string }> {
        return this.pending ?? {};
    }

    /** 清除某条被拒记录（例如管理员批准后） */
    clearPending(sessionKey: string): void {
        if (!this.pending?.[sessionKey]) return;
        delete this.pending[sessionKey];
        this.scheduleSave();
    }

    /** 全部会话配置（供 /api/status） */
    snapshot(): Record<string, SessionChoice> {
        return this.choices;
    }
}

/** sessionKey 拼装：私聊按人，群聊按人（同群不同人上下文隔离） */
export function sessionKeyOf(
    messageType: 'private' | 'group',
    groupId: number | null,
    userId: number,
): string {
    return messageType === 'group' ? `group_${groupId}_${userId}` : `private_${userId}`;
}

/**
 * 带上账号维度后的完整会话 key。
 *
 * 格式 `<accountId>:<private|group>_...`。冒号作为分隔符，
 * 是为了让已有的 `startsWith(accountId + ':')` 判断和日志 grep 都简单。
 */
export function scopedSessionKey(accountId: string, baseKey: string): string {
    return accountId ? `${accountId}:${baseKey}` : baseKey;
}

/** 从完整 key 里取出账号 id（没有前缀时返回空串） */
export function accountIdOfSession(sessionKey: string): string {
    const i = String(sessionKey).indexOf(':');
    return i > 0 ? String(sessionKey).slice(0, i) : '';
}

/** 路由 Map 的 key 规范化（避免 number/string 混用） */
function routeKey(sessionKey: string): string {
    return String(sessionKey);
}
