/**
 * 状态与监控接口 —— 前端「总览」和「运行日志」两个页面的数据源。
 *
 * 组装原则：一次请求返回前端需要的全部运行时快照，
 * 前端只做展示，不再自己推断连接状态。
 *
 * 多账号：`accounts` 是每号一份的明细，`upstream` 是聚合视图
 * （任一账号连上就算上游在线），这样旧版面不用改也能看。
 */

import type { Router } from '../router.ts';
import { json } from '../router.ts';
import type { AppContext } from '../context.ts';
import { collectStatus } from '../../downstream/registry.ts';
import { resolveFlow } from '../../config/flows.ts';

export function registerStatusRoutes(router: Router, app: AppContext): void {
    router.get('/api/status', ({ res }) => {
        json(res, 200, buildStatus(app));
    });

    /** 只要日志，轮询更轻 */
    router.get('/api/logs', ({ res, query }) => {
        const limit = Math.max(1, Math.min(500, Number(query.get('limit')) || 200));
        json(res, 200, { ok: true, logs: app.logger.lines(limit) });
    });

    /** 健康检查：给外部探活用 */
    router.get('/api/health', ({ res }) => {
        json(res, 200, {
            ok: true,
            upstream: app.upstreams.totals().connected > 0,
            accounts: app.upstreams.totals(),
            downstreams: app.downstreams.list().length,
            uptimeSec: Math.floor((Date.now() - app.startedAt) / 1000),
        });
    });
}

/** 单个账号的运行时视图 */
export interface AccountStatus {
    id: string;
    uin: string;
    name: string;
    connected: boolean;
    endpoint: string;
    selfId: string;
    nickname: string;
    connectedForSec: number;
    connectedAt: number | null;
    disconnectedAt: number | null;
    reconnectCount: number;
    eventsIn: number;
    actionsOut: number;
    actionErrors: number;
    lastEventAt: number | null;
    lastError: string;
    lastErrorAt: number | null;
}

/** 对外暴露的状态结构（前端 client.ts 与之对应） */
export interface StatusSnapshot {
    generatedAt: number;
    codeVersion: string;
    /** 每个账号一条 */
    accounts: AccountStatus[];
    /** 聚合视图：任一账号在线即为在线（旧版面沿用） */
    upstream: {
        connected: boolean;
        endpoint: string;
        selfId: string;
        nickname: string;
        connectedForSec: number;
        connectedAt: number | null;
        disconnectedAt: number | null;
        reconnectCount: number;
        eventsIn: number;
        actionsOut: number;
        actionErrors: number;
        lastEventAt: number | null;
        lastError: string;
        lastErrorAt: number | null;
        stats: Record<string, string | number | boolean>;
    };
    downstreams: Array<{
        id: string;
        kind: string;
        name: string;
        enabled: boolean;
        available: boolean;
        reason?: string;
        detail?: Record<string, string | number | boolean>;
    }>;
    defaultDownstreamId: string;
    defaultDownstreamProfileId: string;
    /** 每个会话实际生效的下游与配置 */
    sessionBackends: Record<string, { backendId: string; inherited: boolean; profileId: string }>;
    sessions: Record<string, { in: number; out: number; last: number }>;
    sessionChoices: Record<string, unknown>;
    catalogs: { characters: string[]; worlds: string[]; updatedAt: string | null };
    config: Record<string, unknown>;
    logs: string[];
    metrics: {
        sessionCount: number;
        totalIn: number;
        totalOut: number;
        lastActiveAt: number | null;
    };
    process: {
        pid: number;
        nodeVersion: string;
        platform: string;
        arch: string;
        uptimeSec: number;
        startedAt: number;
        rssMb: number;
        heapUsedMb: number;
        heapTotalMb: number;
        externalMb: number;
    };
    /** 酒馆扩展连接摘要（旧总览页仍在使用） */
    extension: {
        port: number;
        clientCount: number;
        clients: Array<{
            id: number;
            ext: string;
            version: string;
            connectedAt: number | null;
            connectedForSec: number;
            lastPingAt: number | null;
        }>;
    };
    inbound: {
        port: number;
        connections: Array<{ kind: string; ext: string; version: string; connectedAt: number }>;
    };
    faces: { total: number; labeled: number; summary: string } | null;
}

function buildStatus(app: AppContext): StatusSnapshot {
    const cfg = app.config();
    const now = Date.now();
    const mem = process.memoryUsage();
    const uptimeSec = Math.floor((Date.now() - app.startedAt) / 1000);

    // ---- 账号明细 ----
    const accounts: AccountStatus[] = app.upstreams.list().map((view) => {
        const s = view.stats;
        const acc = app.upstreams.account(view.id);
        return {
            id: view.id,
            uin: view.uin || s.selfId,
            name: view.name,
            connected: s.connected,
            endpoint: acc?.upstream.url ?? '',
            selfId: s.selfId,
            nickname: s.nickname,
            connectedForSec: s.connected && s.connectedAt
                ? Math.floor((now - s.connectedAt) / 1000)
                : 0,
            connectedAt: s.connectedAt || null,
            disconnectedAt: s.disconnectedAt || null,
            reconnectCount: s.reconnectCount,
            eventsIn: s.eventsIn,
            actionsOut: s.actionsOut,
            actionErrors: s.actionErrors,
            lastEventAt: s.lastEventAt || null,
            lastError: s.lastError,
            lastErrorAt: s.lastErrorAt || null,
        };
    });

    // 聚合视图：把各账号的计数相加，连接时间取最早的那个在线账号
    const online = accounts.filter((a) => a.connected);
    const primary = online[0] ?? accounts[0];
    const aggregate = {
        connected: online.length > 0,
        endpoint: primary?.endpoint ?? '',
        selfId: primary?.selfId ?? '',
        nickname: primary?.nickname ?? '',
        connectedForSec: online.length > 0
            ? Math.min(...online.map((a) => a.connectedForSec))
            : 0,
        connectedAt: online.length > 0
            ? Math.min(...online.map((a) => a.connectedAt ?? now))
            : (primary?.connectedAt ?? null),
        disconnectedAt: accounts.reduce<number | null>(
            (m, a) => Math.max(m ?? 0, a.disconnectedAt ?? 0) || null,
            null,
        ),
        reconnectCount: accounts.reduce((n, a) => n + a.reconnectCount, 0),
        eventsIn: accounts.reduce((n, a) => n + a.eventsIn, 0),
        actionsOut: accounts.reduce((n, a) => n + a.actionsOut, 0),
        actionErrors: accounts.reduce((n, a) => n + a.actionErrors, 0),
        lastEventAt: accounts.reduce<number | null>(
            (m, a) => Math.max(m ?? 0, a.lastEventAt ?? 0) || null,
            null,
        ),
        lastError: accounts.map((a) => a.lastError).filter(Boolean).join(' | '),
        lastErrorAt: accounts.reduce<number | null>(
            (m, a) => Math.max(m ?? 0, a.lastErrorAt ?? 0) || null,
            null,
        ),
        stats: {
            onlineAccounts: online.length,
            totalAccounts: accounts.length,
        } as Record<string, string | number | boolean>,
    };

    const sessionStats = app.sessions.statsSnapshot();
    const statList = Object.values(sessionStats);
    const lastActiveAt = statList.reduce((m, s) => Math.max(m, s.last ?? 0), 0);

    const sessionBackends: Record<string, { backendId: string; inherited: boolean; profileId: string }> = {};
    const keys = new Set([...Object.keys(sessionStats), ...Object.keys(app.sessions.snapshot())]);
    for (const key of keys) {
        const binding = resolveFlow(cfg, app.sessions, key);
        sessionBackends[key] = {
            backendId: binding.flow?.downstreamId ?? '',
            inherited: binding.inherited,
            profileId: binding.flow?.legacyProfileId ?? '',
        };
    }

    // 酒馆扩展连接：从下游适配器里取（不再单独维护 stClients 集合）
    const stAdapter = app.downstreams.list().find((a) => a.kind === 'sillytavern') as unknown as {
        connections?: () => Array<{ ext: string; version: string; connectedAt: number }>;
        onlineCount?: () => number;
    } | undefined;
    const rawConns = stAdapter?.connections?.() ?? [];
    const extensionClients = rawConns.map((c, i) => ({
        id: i + 1,
        ext: c.ext,
        version: c.version,
        connectedAt: c.connectedAt || null,
        connectedForSec: c.connectedAt ? Math.floor((now - c.connectedAt) / 1000) : 0,
        lastPingAt: null,
    }));

    const facesSvc = app.faces();
    let facesInfo: StatusSnapshot['faces'] = null;
    if (facesSvc) {
        try {
            const s = facesSvc.stats();
            facesInfo = { total: s.total, labeled: s.labeled, summary: app.faceSummary() };
        } catch {
            facesInfo = null;
        }
    }

    return {
        generatedAt: now,
        codeVersion: app.codeVersion,
        accounts,
        upstream: aggregate,
        downstreams: collectStatus(new Map(app.downstreams.list().map(a => [a.id, a])), cfg.downstreams),
        defaultDownstreamId: cfg.defaultDownstreamId,
        defaultDownstreamProfileId: cfg.defaultDownstreamProfileId,
        sessionBackends,
        sessions: sessionStats,
        sessionChoices: app.sessions.snapshot(),
        catalogs: { characters: [], worlds: [], updatedAt: null },
        config: cfg as unknown as Record<string, unknown>,
        logs: app.logger.lines(200),
        metrics: {
            sessionCount: keys.size,
            totalIn: statList.reduce((n, s) => n + (s.in ?? 0), 0),
            totalOut: statList.reduce((n, s) => n + (s.out ?? 0), 0),
            lastActiveAt: lastActiveAt || null,
        },
        process: {
            pid: process.pid,
            nodeVersion: process.version,
            platform: process.platform,
            arch: process.arch,
            uptimeSec,
            startedAt: app.startedAt,
            rssMb: round1(mem.rss / 1024 / 1024),
            heapUsedMb: round1(mem.heapUsed / 1024 / 1024),
            heapTotalMb: round1(mem.heapTotal / 1024 / 1024),
            externalMb: round1(mem.external / 1024 / 1024),
        },
        extension: {
            port: cfg.extPort,
            clientCount: extensionClients.length,
            clients: extensionClients,
        },
        inbound: {
            port: cfg.extPort,
            connections: extensionClients.map((c) => ({
                kind: c.ext || 'sillytavern',
                ext: c.ext,
                version: c.version,
                connectedAt: c.connectedAt ?? 0,
            })),
        },
        faces: facesInfo,
    };
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
