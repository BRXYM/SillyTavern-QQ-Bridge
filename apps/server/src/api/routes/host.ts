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
            const known = query.get('known') ?? '';
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
        const dir = query.get('dir') ?? '';
        const activePort = Number(query.get('port') ?? 0) || null;
        const probe = probeSnowLuma(dir, activePort);
        const accounts = probe.ok ? listAccounts(probe.dataDir) : [];

        // OneBot 端口监听状态：用当前上游配置里的端口
        let onebotPort = 3001;
        try {
            onebotPort = Number(new URL(cfg().upstream.url).port || 3001);
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

            // 同步 Bridge 侧的上游连接参数
            const endpoint = result.endpoint;
            const urlChanged = cfg().upstream.url !== endpoint;
            const tokenChanged = cfg().upstream.token !== result.token;

            app.updateConfig((c) => {
                c.upstream.url = endpoint;
                c.upstream.token = result.token;
            });

            if (urlChanged || tokenChanged) {
                log('上游连接参数已由「自动配置」更新，正在重连 SnowLuma…');
                app.onebot.dispose();
                app.onebot.connect();
            }

            log(`✓ SnowLuma 配置已写入：${result.path}（${result.changed ? '已更新' : '无变化'}）`);

            json(res, 200, {
                ok: true,
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
            const dir = String(query.get('dir') ?? '').trim();
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
