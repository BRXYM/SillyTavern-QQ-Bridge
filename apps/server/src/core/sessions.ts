/**
 * 会话状态：路由、计数、每个会话的下游选择。
 *
 * 与旧版的区别：旧版把「会话选择」「路由」「统计」分散在三个 Map 和 sessions.json，
 * 且下游选择叫 backend（枚举）。现在统一成一个 SessionStore，
 * 下游选择改成 backendId（实例 id），语义与「角色/世界书」保持同一套继承规则：
 *
 *   sessions[key].backendId 有值 → 用该实例
 *   sessions[key].backendId 缺失 → 用全局 defaultDownstreamId
 */

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

/** 一次消息的投递目标 */
export interface SessionRoute {
    sessionKey: string;
    messageType: 'private' | 'group';
    groupId: number | null;
    userId: number;
}

/** 会话级配置（持久化到 sessions.json） */
export interface SessionChoice {
    character?: string;
    world?: string;
    /** 下游实例 id；缺失 = 继承全局默认 */
    backendId?: string;
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
    character: string;
    world: string;
}

export class SessionStore extends EventEmitter {
    /** 会话级配置 */
    private choices: Record<string, SessionChoice> = {};
    /** 运行时路由（不落盘，重启后由第一条消息重建） */
    private readonly routes = new Map<string, SessionRoute>();
    /** 收发计数 */
    private readonly stats = new Map<string, SessionStat>();

    private saveTimer: NodeJS.Timeout | null = null;

    /** 会话文件路径 */
    private readonly file: string;
    /** 读取当前生效的全局默认，避免与 config store 循环依赖 */
    private readonly readDefaults: () => { backendId: string; character: string; world: string };

    constructor(
        file: string,
        readDefaults: () => { backendId: string; character: string; world: string },
    ) {
        super();
        this.file = file;
        this.readDefaults = readDefaults;
    }

    load(): void {
        try {
            const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, SessionChoice>;
            // 兼容旧版字段名 backend（'taver' | 'dsh'）
            for (const [key, value] of Object.entries(raw)) {
                if (!value || typeof value !== 'object') continue;
                const legacy = value as SessionChoice & { backend?: string };
                if (legacy.backendId === undefined && typeof legacy.backend === 'string') {
                    legacy.backendId = legacy.backend === 'dsh' ? 'dsh' : 'tavern';
                    delete legacy.backend;
                }
                this.choices[key] = legacy;
            }
        } catch {
            this.choices = {};
        }
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
            fs.writeFileSync(this.file, `${JSON.stringify(this.choices, null, 4)}\n`, 'utf8');
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
        return {
            backendId,
            inherited: own.backendId === undefined,
            character: own.character || def.character,
            world: own.world || def.world,
        };
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

/** 路由 Map 的 key 规范化（避免 number/string 混用） */
function routeKey(sessionKey: string): string {
    return String(sessionKey);
}
