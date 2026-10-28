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
} from '../../../snowluma-service.mjs';
import {
    probeSillyTavern,
    installExtension,
    uninstallExtension,
    discoverSillyTavernDir,
    isPortOpen as isStPortOpen,
} from '../../../sillytavern-service.mjs';
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

        // OneBot 端口监听状态：用第一个账号的上游配置里的端口
        let onebotPort = 3001;
        try {
            onebotPort = Number(new URL(cfg().accounts[0]?.upstream.url ?? '').port || 3001);
        } catch {
            /* 用默认值 */
        }
        const running = await isPortOpen(onebotPort);

        json(res, 200, {
            ...probe,
            accounts,
            onebotPortListening: running,
            onebotPort,
        });
    });

    // POST /api/snowluma/apply   一键把 wsServer 与 Bridge 对齐
    router.post('/api/snowluma/apply', async ({ res, body }) => {
        try {
            const dir = String(body.dir ?? '').trim();
            const uin = String(body.uin ?? '').trim();
            const port = Number(body.port ?? 3001);
            const host = String(body.host ?? '127.0.0.1');
            const forceToken = body.forceToken === true;
            const webuiPort = Number(body.webuiPort ?? 0) || null;

            if (!dir) throw new Error('请先填写 SnowLuma 目录');
            if (!UIN_REGEX.test(uin)) throw new Error('请填写正确的 QQ 号（5-12 位数字）');

            const probe = probeSnowLuma(dir, webuiPort);
            if (!probe.ok) throw new Error(probe.error || 'SnowLuma 目录无效');

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
            log(`上游连接参数已由「自动配置」更新（账号 ${accountId}），正在重连 SnowLuma…`);

            log(`✓ SnowLuma 配置已写入：${result.path}（${result.changed ? '已更新' : '无变化'}）`);

            json(res, 200, {
                ok: true,
                accountId,
                createdAccount: !existing,
                changed: result.changed,
                created: result.created,
                path: result.path,
                token: result.token,
                endpoint,
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
