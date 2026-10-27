/**
 * 状态与监控接口 —— 前端「总览」和「运行日志」两个页面的数据源。
 *
 * 组装原则：一次请求返回前端需要的全部运行时快照，
 * 前端只做展示，不再自己推断连接状态。
 */

import type { Router } from '../router.ts';
import { json } from '../router.ts';
import type { AppContext } from '../context.ts';

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
            upstream: app.onebot.stats.connected,
            downstreams: app.downstreams.list().length,
            uptimeSec: Math.floor((Date.now() - app.startedAt) / 1000),
        });
    });
}

/** 对外暴露的状态结构（前端 client.ts 与之对应） */
export interface StatusSnapshot {
    generatedAt: number;
    codeVersion: string;
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
    /** 每个会话实际生效的下游 */
    sessionBackends: Record<string, { backendId: string; inherited: boolean }>;
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
    const stats = app.onebot.stats;
    const now = Date.now();
    const mem = process.memoryUsage();
    const uptimeSec = Math.floor((Date.now() - app.startedAt) / 1000);

    const sessionStats = app.sessions.statsSnapshot();
    const statList = Object.values(sessionStats);
    const lastActiveAt = statList.reduce((m, s) => Math.max(m, s.last ?? 0), 0);

    const sessionBackends: Record<string, { backendId: string; inherited: boolean }> = {};
    const keys = new Set([...Object.keys(sessionStats), ...Object.keys(app.sessions.snapshot())]);
    for (const key of keys) {
        const r = app.sessions.resolve(key);
        sessionBackends[key] = { backendId: r.backendId, inherited: r.inherited };
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
        upstream: {
            connected: stats.connected,
            endpoint: cfg.upstream.url,
            selfId: stats.selfId,
            nickname: stats.nickname,
            connectedForSec: stats.connected && stats.connectedAt
                ? Math.floor((now - stats.connectedAt) / 1000)
                : 0,
            connectedAt: stats.connectedAt || null,
            disconnectedAt: stats.disconnectedAt || null,
            reconnectCount: stats.reconnectCount,
            eventsIn: stats.eventsIn,
            actionsOut: stats.actionsOut,
            actionErrors: stats.actionErrors,
            lastEventAt: stats.lastEventAt || null,
            lastError: stats.lastError,
            lastErrorAt: stats.lastErrorAt || null,
            stats: { ...stats } as Record<string, string | number | boolean>,
        },
        downstreams: app.downstreams.list().map((a) => a.status()),
        defaultDownstreamId: cfg.defaultDownstreamId,
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
