/**
 * SnowLuma（上游本体）与 SillyTavern（酒馆本体）的安装/配置管理。
 *
 * 注意这与「下游适配器」不是一回事：
 *   - 下游适配器：Bridge 把消息发给谁（dsh / 酒馆）
 *   - 本文件：**被连接的上游/下游软件本身**怎么装、装在哪、配置怎么写
 *
 * 这些能力属于「后端承担全部连接操作」的一部分：前端只发命令，
 * 真正的目录探测、配置写入、扩展安装都在这里完成。
 */

import path from 'node:path';
import fs from 'node:fs';
import type { Router } from '../router.ts';
import { json } from '../router.ts';
import type { AppContext } from '../context.ts';
import {
    probeSnowLuma,
    listAccounts,
    readOneBotConfig,
    ensureOneBotEndpoint,
    isPortOpen,
    discoverSnowLumaDir,
    UIN_REGEX,
} from '../../integrations/snowluma/snowluma-service.mjs';
import {
    probeSillyTavern,
    installExtension,
    uninstallExtension,
    discoverSillyTavernDir,
    isPortOpen as isStPortOpen,
} from '../../integrations/sillytavern/sillytavern-service.mjs';
import { log } from '../../core/logger.ts';
import {
    readSnowLumaRuntime,
    restoreRuntimeConfig,
    setHookAutoLoad,
} from '../../upstream/snowluma-hook.ts';
import { toUpstreamAccounts } from './config.ts';

export interface HostRoutesDeps {
    /** 仓库根目录，用于扩展安装源与目录探测提示 */
    repoRoot: string;
    /** 扩展源码目录 */
    extensionSourceDir: string;
}

export function registerHostRoutes(router: Router, app: AppContext, deps: HostRoutesDeps): void {
    /** 读取本机上已保存的目录（配置里没有时给空串） */
    const cfg = () => app.config();

    /**
     * OneBot 端口的固定起点。
     *
     * 全部号都从这里往上分配：第一个号 3001，第二个 3002，以此类推。
     * 起点固定而不是让它漂移，是为了让「第几个号用哪个端口」可预测 ——
     * 排查时看一眼账号 id 顺序就知道大概在哪个端口。
     */
    const ONEBOT_PORT_BASE = 3001;
    /** 最多往后找多少个端口，避免配置异常时死循环 */
    const ONEBOT_PORT_SPAN = 100;

    /**
     * 为某个 QQ 号挑一个 OneBot 端口。
     *
     * 为什么需要这个：SnowLuma 每个号都**各自监听**自己的 wsServer。
     * 如果把两个号都写成 3001，先启动的那个会占住端口，后启动的
     * 直接 `EADDRINUSE` 起不来 —— 表现就是「加了第二个号但收不到消息」，
     * 而两侧日志都不明显（SnowLuma 只 WARN 一句 network startup degraded）。
     *
     * 规则：
     *   1. 该号已有端口且不与他人冲突 → 沿用（重复点按钮不该换端口）
     *   2. 否则从 3001 开始往上找第一个**既不与其他账号重复、
     *      也没被其他进程占用**的端口
     *
     * 第 2 条里"被其他进程占用"是必要的：用户可能同时跑着 NapCat、
     * 别的机器人，或者上一个 SnowLuma 还没退干净。只比配置不看实际监听，
     * 会把端口分给一个正在被占用的号，结果又是一次 EADDRINUSE。
     */
    async function pickOneBotPort(uin: string): Promise<number> {
        const accounts = cfg().accounts;
        const self = accounts.find((a) => a.uin === uin || a.id === `qq_${uin}`);

        const portOf = (a: typeof accounts[number]): number => {
            try {
                return Number(new URL(a.upstream.url).port) || 0;
            } catch {
                return 0;
            }
        };

        // 其他账号（排除自己）已在配置里占用的端口
        const taken = new Set(
            accounts
                .filter((a) => a !== self)
                .map(portOf)
                .filter((p) => p > 0),
        );

        // 1) 自己已有端口，且没被别的账号占用 → 沿用
        //
        // 这一条必须放在"检查端口是否被监听"之前：该号自己的 SnowLuma
        // wsServer 正在监听这个端口是**正常状态**，若用"端口在监听就换"
        // 来判，每次点自动配置都会给它换一个新端口。
        const own = self ? portOf(self) : 0;
        if (own > 0 && !taken.has(own)) {
            return own;
        }

        // 2) 从固定起点往上找：跳过其他账号已配置的，也跳过真被占用的
        for (let p = ONEBOT_PORT_BASE; p < ONEBOT_PORT_BASE + ONEBOT_PORT_SPAN; p += 1) {
            if (taken.has(p)) continue;
            if (await portListening(p)) continue;
            return p;
        }

        // 全被占满时退回起点，让 SnowLuma 自己报 EADDRINUSE，别静默乱选
        return ONEBOT_PORT_BASE;
    }

    /** 该端口是否已被同机其他进程监听（SnowLuma 是否已经跑起来了） */
    const portListening = (port: number): Promise<boolean> => isPortOpen(port);

    // ================= SnowLuma =================

    // GET /api/snowluma/discover   自动发现安装目录
    router.get('/api/snowluma/discover', async ({ res, query }) => {
        try {
            const known = query.get('known') ?? cfg().snowluma.dir ?? '';
            const result = await discoverSnowLumaDir({
                knownDir: known,
                hintDirs: [process.cwd(), deps.repoRoot, path.dirname(deps.repoRoot)],
            });

            const enriched = result.candidates.slice(0, 8).map((c) => {
                const probe = probeSnowLuma(c.dir);
                const accounts = probe.ok ? listAccounts(probe.dataDir) : [];
                return {
                    ...c,
                    ok: probe.ok,
                    version: probe.version,
                    mode: probe.mode,
                    accounts: accounts.map((a) => a.uin),
                };
            });

            json(res, 200, {
                found: result.found && enriched.length > 0,
                dir: result.dir,
                source: result.source,
                candidates: enriched,
                tried: result.tried,
            });
        } catch (e) {
            json(res, 500, {
                found: false,
                error: e instanceof Error ? e.message : String(e),
                candidates: [],
            });
        }
    });

    // GET /api/snowluma/probe?dir=...&port=...   探测版本/配置目录/账号
    router.get('/api/snowluma/probe', async ({ res, query }) => {
        const dir = query.get('dir') ?? cfg().snowluma.dir ?? '';
        const activePort = Number(query.get('port') ?? cfg().snowluma.webuiPort ?? 0) || null;
        const probe = probeSnowLuma(dir, activePort);
        const accounts = probe.ok ? listAccounts(probe.dataDir) : [];

        /**
         * 每个账号的 OneBot 端口与监听状态。
         *
         * 多号时只看第一个号是不够的：用户真正想知道的是"我这些号
         * 是不是都在正常监听"，所以逐个报出来，谁没起来一眼可见。
         */
        const accountPorts = await Promise.all(
            cfg().accounts.map(async (a) => {
                let port = 0;
                try {
                    port = Number(new URL(a.upstream.url).port) || 0;
                } catch {
                    /* 地址非法，保持 0 */
                }
                const listening = port > 0 ? await portListening(port) : false;
                return {
                    id: a.id,
                    uin: a.uin,
                    port,
                    listening,
                    enabled: a.enabled,
                };
            }),
        );

        // 兼容旧字段：取第一个账号
        const first = accountPorts[0];

        json(res, 200, {
            ...probe,
            accounts,
            onebotPortListening: first?.listening ?? false,
            onebotPort: first?.port ?? ONEBOT_PORT_BASE,
            /** 每个账号的端口与监听状态 */
            accountPorts,
        });
    });

    // POST /api/snowluma/apply   一键把 wsServer 与 Bridge 对齐
    router.post('/api/snowluma/apply', async ({ res, body }) => {
        try {
            const dir = String(body.dir ?? '').trim();
            const uin = String(body.uin ?? '').trim();
            const host = String(body.host ?? '127.0.0.1');
            const forceToken = body.forceToken === true;
            const webuiPort = Number(body.webuiPort ?? 0) || null;

            if (!dir) throw new Error('请先填写 SnowLuma 目录');
            if (!UIN_REGEX.test(uin)) throw new Error('请填写正确的 QQ 号（5-12 位数字）');

            const probe = probeSnowLuma(dir, webuiPort);
            if (!probe.ok) throw new Error(probe.error || 'SnowLuma 目录无效');

            /**
             * 端口由后端统一分配，前端不再指定。
             *
             * 起点固定 3001，逐个号往上排（3001、3002、3003…），
             * 遇到已被账号占用或真被别的进程占着的就继续往后找。
             * 这样「第几个号在哪个端口」是可预测的，也不会出现
             * 把 3001 写进每个号导致 EADDRINUSE 的情况。
             */
            const port = await pickOneBotPort(uin);

            const result = ensureOneBotEndpoint({
                configDir: probe.configDir,
                uin,
                port,
                host,
                forceToken,
            });

            /**
             * 写到哪个账号上？
             *
             * 优先找已经填了这个 uin 的账号（重复执行幂等）；
             * 其次找 id 里带这个号的（`qq_<uin>`）；
             * 都没有就新建一个 —— 这正是「加一个号」的主路径。
             */
            const endpoint = result.endpoint;
            const existing = cfg().accounts.find(
                (a) => a.uin === uin || a.id === `qq_${uin}`,
            );
            const accountId = existing?.id ?? `qq_${uin}`;

            app.updateConfig((c) => {
                const acc = c.accounts.find((a) => a.id === accountId);
                if (acc) {
                    acc.uin = uin;
                    acc.upstream.url = endpoint;
                    acc.upstream.token = result.token;
                    if (!acc.enabled) acc.enabled = true;
                } else {
                    c.accounts.push({
                        id: accountId,
                        uin,
                        name: `QQ ${uin}`,
                        enabled: true,
                        upstream: {
                            url: endpoint,
                            token: result.token,
                            reconnectMs: 5000,
                            actionTimeoutMs: 15000,
                        },
                    });
                }
                // 记住安装位置，下次探测/刷新直接用，不必再手动指定
                c.snowluma.dir = dir;
                if (webuiPort) c.snowluma.webuiPort = webuiPort;
            });

            // 让上游按新配置重建连接
            app.upstreams.apply(toUpstreamAccounts(cfg()));
            log(`上游连接参数已由「自动配置」更新（账号 ${accountId}）：${endpoint}`);

            log(`✓ SnowLuma 配置已写入：${result.path}（${result.changed ? '已更新' : '无变化'}）`);

            /**
             * 检查是否与其他账号撞端口。
             *
             * 单看这次写入是成功的，撞的是别的号 —— 那会导致那个号
             * 在 SnowLuma 侧起不来 OneBot 服务，而这里看不出任何异常。
             * 所以必须把冲突明确回报，让用户知道要重启并核对。
             */
            const conflicts = cfg().accounts
                .filter((a) => a.id !== accountId && sameEndpoint(a.upstream.url, endpoint))
                .map((a) => a.id);

            /**
             * Token 变了但 SnowLuma 还在跑 → 我们的连接会被 401 拒绝。
             *
             * 这是「配置写成功、界面显示就绪、但实际连不上」的典型陷阱：
             * OneBot 的 wsServer 在 SnowLuma 启动时读配置，改文件不影响运行中的实例。
             * 必须明确告诉用户"要重启 SnowLuma"，否则他会以为配置坏了。
             */
            const tokenRotated = result.changed && (await portListening(port));
            if (tokenRotated) {
                log(`⚠ 账号 ${accountId} 的 OneBot 配置已变，但 SnowLuma 仍在运行旧配置 → 需重启 SnowLuma`);
            }

            json(res, 200, {
                ok: true,
                accountId,
                createdAccount: !existing,
                changed: result.changed,
                created: result.created,
                path: result.path,
                token: result.token,
                endpoint,
                port,
                /** 与该号撞了同一端点的其他账号 id（应为空） */
                conflicts,
                /** true = 配置已改但 SnowLuma 仍在跑旧配置，必须重启才生效 */
                restartRequired: tokenRotated || result.changed,
                configDir: probe.configDir,
                dataDir: probe.dataDir,
                mode: probe.mode,
                version: probe.version,
                needRestart: result.changed,
            });
        } catch (e) {
            json(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
    });

    // GET /api/snowluma/config?uin=...&dir=...   读某账号的 OneBot 配置
    router.get('/api/snowluma/config', ({ res, query }) => {
        try {
            const uin = String(query.get('uin') ?? '').trim();
            const dir = String(query.get('dir') ?? cfg().snowluma.dir ?? '').trim();
            if (!dir) throw new Error('缺少 SnowLuma 目录');
            const probe = probeSnowLuma(dir);
            if (!probe.ok) throw new Error(probe.error || 'SnowLuma 目录无效');
            const result = readOneBotConfig(probe.configDir, uin);
            json(res, 200, { ok: true, ...result });
        } catch (e) {
            json(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
    });

    // ================= SillyTavern =================

    router.get('/api/sillytavern/discover', async ({ res, query }) => {
        try {
            const known = query.get('known') ?? cfg().stDataDir ?? '';
            const result = await discoverSillyTavernDir({
                knownDir: known,
                hintDirs: [process.cwd(), deps.repoRoot, path.dirname(deps.repoRoot)],
            });
            json(res, 200, {
                ...result,
                candidates: result.candidates.slice(0, 8),
            });
        } catch (e) {
            json(res, 500, {
                found: false,
                error: e instanceof Error ? e.message : String(e),
                candidates: [],
            });
        }
    });

    router.get('/api/sillytavern/probe', async ({ res, query }) => {
        const dir = query.get('dir') ?? cfg().stDataDir ?? '';
        const port = Number(query.get('port') ?? 8000);
        const probe = probeSillyTavern(dir);
        const running = await isStPortOpen(port);

        // 扩展连接数由下游适配器提供
        const adapter = app.downstreams.list().find((a) => a.kind === 'sillytavern');
        const extCount = adapter
            ? (adapter as unknown as { onlineCount?: () => number }).onlineCount?.() ?? 0
            : 0;

        json(res, 200, {
            ...probe,
            port,
            endpoint: `http://127.0.0.1:${port}`,
            running,
            extConnected: extCount > 0,
            extPort: cfg().extPort,
        });
    });

    router.post('/api/sillytavern/install', async ({ res, body }) => {
        const dir = String(body.dir ?? cfg().stDataDir ?? '').trim();
        const force = body.force === true;
        const result = installExtension({
            stDir: dir,
            sourceDir: deps.extensionSourceDir,
            force,
        });
        if (result.ok) {
            log(`酒馆扩展已${result.action === 'installed' ? '安装' : result.action === 'updated' ? '更新' : '确认'}：${result.target}`);
        }
        json(res, result.ok ? 200 : 400, result);
    });

    router.post('/api/sillytavern/uninstall', ({ res, body }) => {
        const dir = String(body.dir ?? cfg().stDataDir ?? '').trim();
        const result = uninstallExtension(dir);
        if (result.ok) log('酒馆扩展已卸载');
        json(res, result.ok ? 200 : 400, result);
    });

    // ================= 角色 / 世界书清单 =================

    // ================= SnowLuma 自动注入 =================
    // SnowLuma 的 hookAutoLoad 开关：打开后它自己会把 DLL 注入每个
    // 发现的 QQ 进程，Bridge 不需要密码、不需要调它的鉴权 API。

    // GET /api/snowluma/hook   读取当前自动注入状态
    router.get('/api/snowluma/hook', ({ res }) => {
        const dir = cfg().snowluma.dir;
        if (!dir) {
            json(res, 200, {
                ok: true,
                configured: false,
                error: '尚未配置 SnowLuma 目录',
            });
            return;
        }

        const info = readSnowLumaRuntime(dir);
        if (!info) {
            json(res, 200, {
                ok: true,
                configured: true,
                found: false,
                dir,
                error: '在该目录下没找到 config/runtime.json',
            });
            return;
        }

        json(res, 200, {
            ok: true,
            configured: true,
            found: true,
            dir,
            runtimePath: info.runtimePath,
            hasWebuiConfig: info.hasWebuiConfig,
            webuiPort: info.webuiPort,
            hookAutoLoad: info.hookAutoLoad,
            /** 改完需要重启 SnowLuma 才生效 */
            needsRestart: false,
        });
    });

    // POST /api/snowluma/hook   开启 / 关闭自动注入
    router.post('/api/snowluma/hook', ({ res, body }) => {
        const dir = cfg().snowluma.dir;
        if (!dir) {
            json(res, 400, { ok: false, error: '请先在页面上填写并保存 SnowLuma 目录' });
            return;
        }

        const enabled = body.enabled === true;
        const r = setHookAutoLoad(dir, enabled);
        if (!r.ok) {
            log(`SnowLuma 自动注入设置失败：${r.error}`);
            json(res, 400, { ok: false, error: r.error, backup: r.backup });
            return;
        }

        log(
            `SnowLuma 自动注入已${enabled ? '开启' : '关闭'}（${r.runtimePath}）`
            + '；需重启 SnowLuma 生效',
        );

        json(res, 200, {
            ok: true,
            runtimePath: r.runtimePath,
            before: r.before,
            after: r.after,
            backup: r.backup,
            /** 提示前端：必须重启 SnowLuma */
            needsRestart: true,
        });
    });

    // POST /api/snowluma/hook/restore   从备份还原 runtime.json
    router.post('/api/snowluma/hook/restore', ({ res }) => {
        const dir = cfg().snowluma.dir;
        if (!dir) {
            json(res, 400, { ok: false, error: '请先配置 SnowLuma 目录' });
            return;
        }
        const r = restoreRuntimeConfig(dir);
        if (!r.ok) {
            json(res, 400, { ok: false, error: r.error });
            return;
        }
        log(`SnowLuma runtime.json 已从备份还原（${r.runtimePath}）`);
        json(res, 200, { ok: true, runtimePath: r.runtimePath, needsRestart: true });
    });

    // ================= 角色 / 世界书清单 =================

    router.get('/api/catalog/refresh', ({ res }) => {
        const stData = cfg().stDataDir;
        const out: { characters: string[]; worlds: string[]; updatedAt: string } = {
            characters: [],
            worlds: [],
            updatedAt: new Date().toISOString(),
        };

        if (stData) {
            try {
                for (const f of fs.readdirSync(path.join(stData, 'characters'))) {
                    if (/\.(png|json)$/i.test(f)) out.characters.push(f.replace(/\.(png|json)$/i, ''));
                }
            } catch {
                /* 目录不存在时忽略 */
            }
            try {
                for (const f of fs.readdirSync(path.join(stData, 'worlds'))) {
                    if (/\.json$/i.test(f)) out.worlds.push(f.replace(/\.json$/i, ''));
                }
            } catch {
                /* 目录不存在时忽略 */
            }
        }

        out.characters = [...new Set(out.characters)].sort();
        out.worlds = [...new Set(out.worlds)].sort();

        json(res, 200, {
            ok: true,
            catalogs: out,
        });
    });
}

/**
 * 两个 OneBot 地址是否指向同一个端点。
 *
 * 只比较 host:port：path 不同在 SnowLuma 里仍是同一个监听端口，
 * 端口冲突的判定与 path 无关。
 */
function sameEndpoint(a: string, b: string): boolean {
    const key = (url: string): string => {
        try {
            const u = new URL(url);
            return `${u.hostname.toLowerCase()}:${u.port || (u.protocol === 'wss:' ? '443' : '80')}`;
        } catch {
            return url.trim().toLowerCase();
        }
    };
    return key(a) === key(b);
}
