/**
 * SnowLuma Bridge 后端入口。
 *
 * 装配顺序（有依赖关系，不要随意调整）：
 *   1. 配置      —— 一切的基础
 *   2. 日志      —— 之后所有步骤都可能打日志
 *   3. 会话存储  —— 需要读配置里的默认下游
 *   4. 表情库    —— 发送层与 prompt 都要用
 *   5. 上游      —— 每个账号一条连接，事件进 dispatch
 *   6. 下游      —— 需要上游的 call 能力（发送）
 *   7. 入站 WS   —— 下游连进来
 *   8. HTTP API  —— 最后，保证前端一连上就能拿到完整状态
 *
 * 目录职责见各子目录的 index/说明；本文件只做装配与生命周期。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { logger, log } from './core/logger.ts';
import { handleEventStream, publishStatus } from './api/events.ts';
import { SessionStore } from './core/sessions.ts';
import { UpstreamManager, type AccountEvent } from './upstream/manager.ts';
import { DownstreamManager } from './downstream/manager.ts';
import { InboundServer, type InboundAdapter } from './downstream/inbound.ts';
import { dispatchEvent, buildSystemPrompt, type DispatchDeps } from './core/dispatch.ts';
import { sendReply, type SendContext } from './core/sending.ts';
import { buildAdapters } from './downstream/registry.ts';
import { Router, json } from './api/router.ts';
import type { AppContext } from './api/context.ts';
import { registerStatusRoutes } from './api/routes/status.ts';
import { registerDownstreamRoutes } from './api/routes/downstreams.ts';
import { registerSessionRoutes } from './api/routes/sessions.ts';
import { registerConfigRoutes, toUpstreamAccounts } from './api/routes/config.ts';
import { registerDshRoutes } from './api/routes/dsh.ts';
import { registerHostRoutes } from './api/routes/host.ts';
import { loadConfigFile, saveConfigFile } from './config/store.ts';
import type { BridgeConfig } from './config/schema.ts';
import type { DshSettings } from './downstream/dsh.ts';
import { DshAdapter } from './downstream/dsh.ts';
import { DshClient } from '../dsh-service.mjs';
import { DshService, dshHome, detectHomeMismatch } from '../dsh-profile-service.mjs';
import { FaceService } from '../faces-service.mjs';
import { OllamaClient, OllamaDaemon } from '../ollama-service.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 数据目录：配置与会话文件都在 apps/server 下，与旧版一致 */
const SERVER_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(SERVER_ROOT, 'config.json');
const SESSIONS_PATH = path.join(SERVER_ROOT, 'sessions.json');

/** 源码版本：改动后若这个值没变，说明跑的还是旧进程 */
const CODE_VERSION = (() => {
    try {
        return `v${Math.floor(fs.statSync(fileURLToPath(import.meta.url)).mtimeMs / 1000)}`;
    } catch {
        return 'v0';
    }
})();

const startedAt = Date.now();

// ================= 1. 配置 =================
const loaded = loadConfigFile(CONFIG_PATH);
if (!loaded.existed) {
    log('⚠ 未找到 config.json，使用默认配置（code 默认下游 dsh）');
}
for (const note of loaded.notes) log(`ℹ 配置迁移：${note}`);

let cfg: BridgeConfig = loaded.config;

// 环境变量覆盖（便于多实例 / 端口冲突时切换）
if (process.env.API_PORT) cfg.consolePort = Number(process.env.API_PORT);
if (process.env.EXT_PORT) cfg.extPort = Number(process.env.EXT_PORT);
if (process.env.ST_DATA_DIR) cfg.stDataDir = process.env.ST_DATA_DIR;
if (process.env.BRIDGE_REGISTRATION_TOKEN) cfg.registrationToken = process.env.BRIDGE_REGISTRATION_TOKEN;

/**
 * 单账号环境变量覆盖。
 *
 * 旧版只支持一条上游，环境变量叫 ONEBOT_URL / ONEBOT_TOKEN。
 * 新版把它们作用到第一个账号上，保持「不写配置文件也能临时改」的能力。
 */
if (process.env.ONEBOT_URL || process.env.ONEBOT_TOKEN) {
    const first = cfg.accounts[0];
    if (first) {
        if (process.env.ONEBOT_URL) first.upstream.url = process.env.ONEBOT_URL;
        if (process.env.ONEBOT_TOKEN) first.upstream.token = process.env.ONEBOT_TOKEN;
        log(`ℹ 上游已由环境变量覆盖：[${first.id}] ${first.upstream.url}`);
    }
}

/**
 * 首次运行自动生成注册 token。
 *
 * 不生成的话自注册通道默认是关闭的，而「默认接入 dsh」要求
 * 插件装好后能自己登记进来。生成一次后落盘，之后保持不变。
 */
if (!cfg.registrationToken) {
    cfg.registrationToken = randomBytes(24).toString('base64url');
    log('ℹ 已生成注册 token（首次运行）：dsh 插件可用它自动接入');
    try {
        saveConfigFile(CONFIG_PATH, cfg);
    } catch (e) {
        log(`✗ 注册 token 保存失败：${e instanceof Error ? e.message : String(e)}`);
    }
}

function updateConfig(mutate: (c: BridgeConfig) => void): void {
    mutate(cfg);
    try {
        saveConfigFile(CONFIG_PATH, cfg);
        log('配置已保存到 config.json');
    } catch (e) {
        log(`✗ 配置保存失败：${e instanceof Error ? e.message : String(e)}`);
    }
}

// ================= 2. 会话 =================
const sessions = new SessionStore(SESSIONS_PATH, () => ({
    backendId: cfg.defaultDownstreamId || cfg.downstreams[0]?.id || '',
    profileId: cfg.defaultDownstreamProfileId,
    character: cfg.defaults.character,
    world: cfg.defaults.world,
}));
sessions.load();

/**
 * 旧会话（无账号前缀）统一挂到第一个账号下。
 *
 * 升级前只有一个号，所以这些配置本来就属于它；不改的话，
 * 第一个号上线后会看到一堆"新会话"，用户的下游/角色绑定全丢。
 */
const legacyAdopted = sessions.adoptLegacyKeys(cfg.accounts[0]?.id ?? '');
if (legacyAdopted > 0) {
    log(`ℹ 会话迁移：${legacyAdopted} 个旧会话已归属账号 ${cfg.accounts[0]?.id}`);
}

sessions.on('error', (e: unknown) => log(`✗ 会话持久化失败：${String(e)}`));
sessions.on('changed', (key: string) => publishStatus('session', { sessionKey: key }));
sessions.on('created', (key: string) => publishStatus('session', { sessionKey: key }));
sessions.on('removed', (key: string) => publishStatus('session', { sessionKey: key }));

// ================= 3. 上游（多账号） =================
const upstreams = new UpstreamManager();

// ================= 4. 表情库 =================
const FACES_DATA_DIR = process.env.BRIDGE_FACES_DIR
    ? path.resolve(process.env.BRIDGE_FACES_DIR)
    : cfg.faces.dataDir
        ? path.resolve(cfg.faces.dataDir)
        : path.resolve(SERVER_ROOT, 'data', 'faces');

let faces: FaceService | null = null;
/** 最近发过的表情短 ID，用于避免连续重复 */
const recentFaces: string[] = [];
const RECENT_FACES_MAX = 6;

function faceManifest(): { vocab: Record<string, string[]>; recent: string[] } {
    try {
        const m = faces?.store.manifest();
        return {
            vocab: (m?.vocab as Record<string, string[]>) ?? {},
            recent: [...recentFaces],
        };
    } catch {
        return { vocab: {}, recent: [] };
    }
}

function faceSummary(): string {
    try {
        if (!faces) return '未初始化';
        const s = faces.stats();
        const m = faces.store.manifest();
        return `${s.total} 个 / 已标注 ${s.labeled} / 可用词 ${m.totalWords}`;
    } catch {
        return '读取失败';
    }
}

/** 表情图片的对外地址：优先 QQ CDN 直链，本地缓存 QQ 访问不到 */
function absoluteFaceUrl(item: { url?: string; imageUrl?: string } | string): string | null {
    if (typeof item === 'string') {
        return /^https?:/i.test(item) ? item : null;
    }
    if (item.url) return item.url;
    const rel = item.imageUrl ?? '';
    return /^https?:/i.test(rel) ? rel : null;
}

/** 把 token 解析成可发送的图片 URL */
function resolveFaceToken(token: string, tags: string[]): string | null {
    if (!faces) return null;
    try {
        if (token.startsWith('#')) {
            const hit = faces.store.pickById(token);
            if (!hit) {
                log(`  │  表情 ✗ [表情:${token}] 短 ID 不存在`);
                return null;
            }
            rememberFace(hit.md5.slice(0, 6));
            return absoluteFaceUrl(hit);
        }

        const r = faces.store.pickByTagsDetailed(tags, { exclude: recentFaces });
        if (!r.face) {
            log(`  │  表情 ✗ ${r.reason || '无匹配'} [${tags.join(',')}]`);
            return null;
        }
        rememberFace(r.face.md5.slice(0, 6));
        log(`  │  表情 ✓ [表情:${token}] → ${r.face.md5.slice(0, 6)} 分=${r.score}`);
        return absoluteFaceUrl(r.face);
    } catch (e) {
        log(`  │  表情 ✗ 异常: ${e instanceof Error ? e.message : String(e)}`);
        return null;
    }
}

function rememberFace(id: string): void {
    const i = recentFaces.indexOf(id);
    if (i >= 0) recentFaces.splice(i, 1);
    recentFaces.push(id);
    while (recentFaces.length > RECENT_FACES_MAX) recentFaces.shift();
}

// ================= 5. Ollama（表情打标） =================
const ollamaClient = new OllamaClient({
    baseUrl: cfg.faces.ollamaBaseUrl,
    timeoutMs: 60000,
});
const ollamaDaemon = new OllamaDaemon({
    exePath: '',
    baseUrl: cfg.faces.ollamaBaseUrl,
    modelsDir: '',
    log,
});

// ================= 6. dsh 常驻服务 =================
/** 从下游配置里读 dsh 实例的 settings（取第一个 dsh 实例作为服务基准） */
function dshSettings(): DshSettings & {
    serviceProfile: string;
    servicePort: number;
    serviceLogFile: string;
    /** 目标下游实例 id：插件注册与消息路由都用它 */
    downstreamId: string;
} {
    const ds = cfg.downstreams.find((d) => d.kind === 'dsh-plugin' || d.kind === 'dsh-headless');
    const s = (ds?.settings ?? {}) as Record<string, unknown>;
    return {
        downstreamId: ds?.id ?? 'dsh',
        fallbackHeadless: s.fallbackHeadless !== false,
        exePath: String(s.exePath ?? ''),
        profile: String(s.profile ?? 'headless'),
        workRoot: String(s.workRoot ?? ''),
        timeoutMs: Number(s.timeoutMs ?? 180000),
        historyTurns: Number(s.historyTurns ?? 6),
        persistHistory: s.persistHistory !== false,
        concurrency: Number(s.concurrency ?? 1),
        errorReply: String(s.errorReply ?? ''),
        // 提示词开关：默认全关，前端按实例配置
        prompt: normalizePrompt(s.prompt),
        // 历史提取规则：默认空（不发送任何历史文本）
        historyExtracts: normalizeExtracts(s.historyExtracts),
        serviceProfile: String(s.serviceProfile ?? 'web'),
        servicePort: Number(s.servicePort ?? 3080),
        serviceLogFile: String(s.serviceLogFile ?? ''),
    };
}

/** 历史提取规则：只保留 pattern 非空、flags 合法的项 */
function normalizeExtracts(raw: unknown): Array<{ pattern: string; flags?: string; label?: string }> {
    if (!Array.isArray(raw)) return [];
    const out: Array<{ pattern: string; flags?: string; label?: string }> = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const r = item as Record<string, unknown>;
        const pattern = String(r.pattern ?? '').trim();
        if (!pattern) continue;
        out.push({
            pattern,
            ...(typeof r.flags === 'string' && r.flags ? { flags: r.flags } : {}),
            ...(typeof r.label === 'string' && r.label ? { label: r.label } : {}),
        });
    }
    return out;
}

/** 把配置里的 prompt 字段收敛成固定形状，缺省一律关闭 */
function normalizePrompt(raw: unknown): DshSettings['prompt'] {
    const p = (raw ?? {}) as Record<string, unknown>;
    return {
        qqBase: p.qqBase === true,
        character: p.character === true,
        faces: p.faces === true,
        images: p.images === true,
        extra: typeof p.extra === 'string' ? p.extra : '',
    };
}

const dshService = new DshService({
    exePath: dshSettings().exePath,
    profile: dshSettings().serviceProfile,
    host: '127.0.0.1',
    port: dshSettings().servicePort,
    logFile: dshSettings().serviceLogFile || path.join(os.tmpdir(), 'snowluma-dsh-service.log'),
    log,
});

/**
 * headless 客户端工厂（下游适配器按需创建）。
 *
 * 历史文件按 profile 分开：两个配置指向不同 dsh profile 时，
 * 共用一个 history.json 会让它们互相看到对方的对话。
 */
function makeHeadless(settings: DshSettings): DshClient {
    const suffix = settings.profile && settings.profile !== 'headless'
        ? `-${settings.profile.replace(/[^\w-]/g, '_')}`
        : '';
    return new DshClient({
        exePath: settings.exePath,
        profile: settings.profile,
        workRoot: settings.workRoot,
        timeoutMs: settings.timeoutMs,
        historyTurns: settings.historyTurns,
        historyFile: settings.persistHistory
            ? path.join(SERVER_ROOT, `dsh-history${suffix}.json`)
            : '',
        concurrency: settings.concurrency,
        log,
    });
}

// ================= 7. 下游运行时 =================
const adapterDeps = {
    dsh: {
        sessionDefaults: (sessionKey: string) => {
            const r = sessions.resolve(sessionKey);
            return { character: r.character, world: r.world };
        },
        faceManifest,
        imageReplies: () => cfg.imageReplies,
    },
    sillytavern: {
        sessionDefaults: (sessionKey: string) => {
            const r = sessions.resolve(sessionKey);
            return { character: r.character, world: r.world };
        },
        faceManifest,
    },
    makeHeadless,
};

const downstreams = new DownstreamManager({
    config: () => cfg,
    updateConfig,
    deps: adapterDeps,
});

// ================= 8. 发送与派发 =================
const sending: SendContext = {
    upstreams,
    sessions,
    segmentation: () => cfg.segmentation,
    maxMessageLength: () => cfg.maxMessageLength,
    resolveFace: resolveFaceToken,
    faceSummary,
};

const dispatchDeps: DispatchDeps = {
    sessions,
    sending,
    config: () => cfg,
    resolveDownstream: (id, profileId) => downstreams.resolve(id, profileId),
    faceManifest,
    selfId: (accountId: string) => upstreams.client(accountId)?.stats.selfId ?? '',
};

// 上游状态变化：连上/断开/重连/报错都立即推给前端，不等下一次轮询
upstreams.on('account-connected', (accountId: string) => {
    publishStatus('upstream', { connected: true, accountId });
});
upstreams.on('account-disconnected', (accountId: string) => {
    publishStatus('upstream', { connected: false, accountId });
});
upstreams.on('account-error', (accountId: string, error: string) => {
    publishStatus('upstream', { connected: false, accountId, error });
});

upstreams.on('event', (event: AccountEvent) => {
    void dispatchEvent(dispatchDeps, event).catch((e) => {
        log(`✗ 派发异常 [${event.accountId}]：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    });
});

// ================= 9. 入站 WS =================
let inbound: InboundServer | null = null;

function startInbound(): void {
    inbound = new InboundServer({
        port: cfg.extPort,
        token: () => cfg.registrationToken,
        resolveAdapter: (kind, downstreamId) => {
            // 1) 下游自报的实例 id 优先（插件知道自己注册成哪个实例）
            if (downstreamId) {
                const exact = downstreams.get(downstreamId);
                if (exact) return exact as unknown as InboundAdapter;
            }
            // 2) 按类型兜底：取该类型下连接数最少的，避免总是落到同一个
            const candidates = downstreams.list().filter((a) => a.kind === kind);
            if (candidates.length === 0) return undefined;
            if (candidates.length === 1) return candidates[0] as unknown as InboundAdapter;

            const scored = candidates
                .map((a) => ({
                    adapter: a,
                    online: (a as unknown as { onlineCount?: () => number }).onlineCount?.() ?? 0,
                }))
                .sort((x, y) => x.online - y.online);
            const picked = scored[0]!.adapter;
            log(`入站连接按类型 ${kind} 分发给 ${picked.id}（该类型有 ${candidates.length} 个实例）`);
            return picked as unknown as InboundAdapter;
        },
        allAdapters: () => downstreams.list() as unknown as Array<{
            handleMessage: (m: Record<string, unknown>) => boolean;
        }>,
    });
}

async function restartInbound(): Promise<void> {
    if (inbound) await inbound.close();
    inbound = null;
    startInbound();
}

// ================= 10. HTTP API =================
const app: AppContext = {
    logger,
    config: () => cfg,
    updateConfig,
    sessions,
    upstreams,
    downstreams,
    faces: () => faces,
    ollama: { client: ollamaClient, daemon: ollamaDaemon },
    dshService: () => dshService,
    faceSummary,
    restartInbound,
    startedAt,
    codeVersion: CODE_VERSION,
};

const router = new Router();
registerStatusRoutes(router, app);
registerDownstreamRoutes(router, app);
registerSessionRoutes(router, app);
registerConfigRoutes(router, app);

// dsh 专属接口（服务管理 + 插件注入），复用已独立验证的实现
registerDshRoutes(router, app, {
    serverRoot: SERVER_ROOT,
    dshSettings,
    makeHeadless,
});

// 上游/下游软件本体的安装与配置管理（SnowLuma / SillyTavern）
registerHostRoutes(router, app, {
    repoRoot: path.resolve(SERVER_ROOT, '..', '..'),
    extensionSourceDir: path.resolve(SERVER_ROOT, '..', 'extension'),
});

const consoleServer = http.createServer((req, res) => {
    // SSE 长连接：不走 router，否则会被统一的 JSON 处理包住
    if (req.method === 'GET' && (req.url ?? '').split('?')[0] === '/api/events') {
        handleEventStream(req, res);
        return;
    }

    void router.handle(req, res).then((handled) => {
        if (!handled) json(res, 404, { ok: false, error: `未知接口：${req.method} ${req.url}` });
    }).catch((e) => {
        json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
    });
});

// ================= 启动 =================
async function bootstrap(): Promise<void> {
    // 表情库
    try {
        faces = new FaceService({
            dataDir: FACES_DATA_DIR,
            // 表情下载走第一个在线账号；没有账号时给个明确失败
            callOnebot: async (action: string, params: Record<string, unknown>) => {
                const client = activeUpstream();
                if (!client) throw new Error('没有在线的上游账号，无法下载表情');
                return client.call(action, params);
            },
            log,
            onChanged: (reason: string) => log(`表情库已更新（${reason}）`),
            ollama: {
                baseUrl: cfg.faces.ollamaBaseUrl,
                visionModel: cfg.faces.ollamaVisionModel,
                textModel: cfg.faces.ollamaTextModel,
                timeoutMs: 120000,
            },
        });
    } catch (e) {
        log(`⚠ 表情库初始化失败：${e instanceof Error ? e.message : String(e)}`);
        faces = null;
    }

    // 上游：按账号列表建立连接
    upstreams.apply(toUpstreamAccounts(cfg));

    // 下游
    await downstreams.start();

    // 入站
    startInbound();

    // API
    const port = cfg.consolePort;
    await new Promise<void>((resolve) => {
        consoleServer.listen(port, '127.0.0.1', () => {
            log(`API 服务已启动: http://127.0.0.1:${port}/api/status`);
            resolve();
        });
    });

    const accSummary = cfg.accounts
        .map((a) => `${a.id}${a.enabled ? '' : '(停用)'}`)
        .join(', ');
    log(
        `连接器已启动: 账号=[${accSummary}] | 入站=${cfg.extPort} | 控制台=${port}`,
        `| 默认下游=${cfg.defaultDownstreamId}${cfg.defaultDownstreamProfileId ? `/${cfg.defaultDownstreamProfileId}` : ''}`,
    );

    // 启动自检：把「静默失败」变成明确提示
    if (!cfg.registrationToken) {
        log('ℹ 未设置 registrationToken：dsh 插件自注册通道关闭（如需自动接入请设置）');
    }
    const noToken = cfg.accounts.filter((a) => a.enabled && !a.upstream.token);
    if (noToken.length > 0) {
        log(
            `⚠ 账号 ${noToken.map((a) => a.id).join(', ')} 的 token 为空；`
            + '若 SnowLuma 开了 Access Token 会返回 401',
        );
    }

    logEnvironment();
}

/**
 * 取一个在线的上游客户端（表情下载这类与账号无关的操作用）。
 *
 * 优先按配置顺序取第一个在线账号，保证行为稳定、不随连接抖动乱跳。
 */
function activeUpstream() {
    for (const acc of cfg.accounts) {
        if (!acc.enabled) continue;
        const client = upstreams.client(acc.id);
        if (client?.stats.connected) return client;
    }
    // 都断着的时候宁可返回第一个，让调用方拿到"未连接"的真实错误
    const first = cfg.accounts.find((a) => a.enabled);
    return first ? upstreams.client(first.id) : undefined;
}

/**
 * 打印运行时环境，专门用于在进程管理器（MCSManager / nssm / systemd）
 * 下排查「看起来启动成功，但行为不对」的问题。
 *
 * 典型症状：进程被托管在 Session 0，HOME 指向系统账户，
 * 于是 dsh 插件被装进一个空目录，而用户自己的 dsh 毫无变化。
 * 这些信息在托管面板的日志里一眼可见，比事后猜路径高效得多。
 */
function logEnvironment(): void {
    const parts: string[] = [];
    parts.push(`cwd=${process.cwd()}`);
    parts.push(`home=${os.homedir()}`);
    parts.push(`DSH_HOME=${process.env.DSH_HOME || '(未设置)'}`);

    // 配置与会话落盘位置：不依赖 cwd，明确告知以便核对
    parts.push(`config=${CONFIG_PATH}`);
    log(`环境: ${parts.join(' | ')}`);

    // HOME 是否被系统账户接管
    const mismatch = detectHomeMismatch();
    if (mismatch) {
        log(`⚠ ${mismatch.reason}`);
        log(`   dsh 实际目录: ${mismatch.home}`);
        log(`   ${mismatch.hint}`);
    } else {
        log(`dsh home: ${dshHome()}`);
    }
}

// ================= 优雅退出 =================
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`收到 ${signal}，正在关闭…`);
    try {
        sessions.flush();
        upstreams.dispose();
        await downstreams.dispose();
        await inbound?.close();
        await new Promise<void>((resolve) => consoleServer.close(() => resolve()));
    } catch (e) {
        log(`关闭时出错：${e instanceof Error ? e.message : String(e)}`);
    }
    log('已退出');
    process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

void bootstrap().catch((e) => {
    log(`✗ 启动失败：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    process.exit(1);
});
