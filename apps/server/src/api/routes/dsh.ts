/**
 * dsh 专属管理接口：常驻服务 + 连接插件注入。
 *
 * 这是「下游适配器」之外的能力：适配器负责收发消息，
 * 这里负责把 dsh 这个进程本身管起来（启动/停止/注入插件）。
 *
 * 复用 dsh-profile-service.mjs（已独立验证过），只做 HTTP 包装。
 */

import path from 'node:path';
import fs from 'node:fs';
import type { Router } from '../router.ts';
import { json } from '../router.ts';
import type { AppContext } from '../context.ts';
import type { DshSettings } from '../../downstream/dsh.ts';
import {
    PLUGIN_NAME,
    PLUGIN_ROW_ID,
    injectPlugin,
    isExternallyManagedProfile,
    listProfileBundles,
    pluginTargetDir,
    probeInjection,
    removePlugin,
    verifyInjection,
    dshHome,
    detectHomeMismatch,
} from '../../integrations/dsh/dsh-profile-service.mjs';
import { findDsh, listProfiles, invalidateDshProbe } from '../../integrations/dsh/dsh-service.mjs';
import { log } from '../../core/logger.ts';

export interface DshRouteDeps {
    serverRoot: string;
    dshSettings: () => DshSettings & {
        serviceProfile: string;
        servicePort: number;
        serviceLogFile: string;
        downstreamId: string;
    };
    makeHeadless: (settings: DshSettings) => unknown;
}

export function registerDshRoutes(router: Router, app: AppContext, deps: DshRouteDeps): void {
    const pluginSourceDir = path.resolve(deps.serverRoot, '..', 'dsh-plugin');

    /** 插件应连回来的地址（入站 WS） */
    const pluginUrl = (): string => `ws://127.0.0.1:${app.config().extPort}`;

    // ---------------- 环境探测 ----------------
    router.get('/api/dsh/status', ({ res, query }) => {
        if (query.get('fresh') === '1') invalidateDshProbe();
        const settings = deps.dshSettings();
        const found = findDsh(settings.exePath);

        json(res, 200, {
            ok: true,
            installed: !!found.path,
            exePath: found.path,
            configuredExePath: settings.exePath,
            source: found.source,
            version: found.version,
            home: dshHome(),
            profiles: listProfiles(),
            settings,
            /** 本机所有可用安装（桌面版优先），供控制台展示与切换 */
            installations: found.all ?? [{ path: found.path, source: found.source, version: found.version }],
            /** 目录自检：正常时为 null */
            homeCheck: detectHomeMismatch(dshHome()),
            // 兼作 dsh 自身的健康信息
            service: app.dshService().status(),
        });
    });

    // ---------------- 常驻服务 ----------------
    router.get('/api/dsh/service', async ({ res }) => {
        const st = await app.dshService().inspect({ logTail: 40 });
        json(res, 200, { ok: true, ...st });
    });

    /**
     * POST /api/dsh/config   更新 dsh 实例的调用参数。
     *
     * 参数存在下游实例的 settings 里（而不是全局扁平字段），
     * 所以写回配置后必须触发下游重建，否则运行时用的还是旧值。
     */
    router.post('/api/dsh/config', async ({ res, body }) => {
        const cfg = app.config();
        const target = cfg.downstreams.find((d) => d.kind === 'dsh-plugin' || d.kind === 'dsh-headless');
        if (!target) {
            json(res, 404, { ok: false, error: '没有 dsh 下游实例' });
            return;
        }

        // 只接受白名单字段，避免把无关键写进 settings
        const allowed = [
            'exePath', 'profile', 'workRoot', 'timeoutMs', 'historyTurns',
            'persistHistory', 'concurrency', 'systemPrompt', 'errorReply',
            'fallbackHeadless', 'serviceProfile', 'servicePort', 'serviceLogFile',
        ] as const;

        app.updateConfig((c) => {
            const ds = c.downstreams.find((d) => d.id === target.id);
            if (!ds) return;
            for (const key of allowed) {
                if (body[key] !== undefined) ds.settings[key] = body[key];
            }
        });

        const reload = await app.downstreams.reload();
        json(res, reload.ok ? 200 : 400, {
            ok: reload.ok,
            error: reload.error,
            settings: app.config().downstreams.find((d) => d.id === target.id)?.settings ?? {},
        });
    });

    for (const action of ['start', 'stop', 'restart'] as const) {
        router.post(`/api/dsh/service/${action}`, async ({ res }) => {
            const svc = app.dshService();
            try {
                const result = action === 'start'
                    ? await svc.start()
                    : action === 'stop'
                        ? await svc.stop()
                        : await svc.restart();
                const st = await svc.inspect({ logTail: 20 });
                json(res, result.ok ? 200 : 400, { ok: result.ok, action, result, ...st });
            } catch (e) {
                json(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
            }
        });
    }

    // ---------------- 插件注入 ----------------
    router.get('/api/dsh/plugin', ({ res }) => {
        const settings = deps.dshSettings();
        const profile = settings.serviceProfile;
        json(res, 200, {
            ok: true,
            sourceDir: pluginSourceDir,
            sourceExists: fs.existsSync(path.join(pluginSourceDir, 'package.json')),
            pluginName: PLUGIN_NAME,
            rowId: PLUGIN_ROW_ID,
            targetDir: pluginTargetDir(dshHome()),
            url: pluginUrl(),
            profile,
            config: {
                url: pluginUrl(),
                token: app.config().registrationToken,
                cwdRoot: settings.workRoot,
                downstreamId: settings.downstreamId ?? 'dsh',
                consolePort: app.config().consolePort,
            },
            profiles: listProfileBundles(dshHome()),
            injection: probeInjection({ profile, home: dshHome() }),
            // 在线插件连接：从下游适配器实时读，而不是单独维护一份
            clients: (() => {
                const adapter = app.downstreams.get(settings.downstreamId ?? 'dsh') as unknown as {
                    pluginClients?: () => Array<{ pid: number; profile: string; version: string; connectedAt: number | null }>;
                    onlineCount?: () => number;
                } | undefined;
                return adapter?.pluginClients?.() ?? [];
            })(),
            online: ((app.downstreams.get(settings.downstreamId ?? 'dsh') as unknown as { onlineCount?: () => number } | undefined)?.onlineCount?.() ?? 0) > 0,
        });
    });

    router.post('/api/dsh/plugin/inject', async ({ res, body }) => {
        const settings = deps.dshSettings();
        const profile = String(body.profile ?? settings.serviceProfile).trim();

        // ---- 1) 前置检查：插件源码在不在 ----
        if (!fs.existsSync(path.join(pluginSourceDir, 'package.json'))) {
            json(res, 400, {
                ok: false,
                error: `插件源码缺失：${pluginSourceDir}（发行包里应自带 apps/dsh-plugin）`,
                stage: 'precheck',
            });
            return;
        }

        // ---- 2) 注册 token 必须有，否则插件连上也登记不进来 ----
        const token = String(body.token ?? app.config().registrationToken ?? '').trim();
        if (!token) {
            json(res, 400, {
                ok: false,
                error: '缺少 registrationToken：重启 Bridge 会自动生成，或在配置里手动设置',
                stage: 'precheck',
            });
            return;
        }

        // ---- 2.5) HOME 自检 ----
        // dshHome() 已能在 Session 0 下自动定位真实用户目录；
        // 这里只在「自动纠正也失败」时拦截，避免把插件装进空目录。
        const mismatch = detectHomeMismatch(dshHome());
        if (mismatch) {
            json(res, 400, {
                ok: false,
                stage: 'precheck',
                error: `dsh 目录异常：${mismatch.reason}`,
                homeCheck: mismatch,
                message: `${mismatch.hint}（当前：${mismatch.home}）`,
            });
            return;
        }

        // ---- 3) 注入（复制文件 + 写 bundles + 写 patch 配置）----
        const inject = injectPlugin({
            profile,
            sourceDir: pluginSourceDir,
            url: pluginUrl(),
            token,
            cwdRoot: String(body.cwdRoot ?? settings.workRoot ?? ''),
            // 让插件知道连哪个实例 + 控制台端口，用于自注册
            downstreamId: settings.downstreamId ?? 'dsh',
            consolePort: app.config().consolePort,
            home: dshHome(),
        });

        if (!inject.ok) {
            json(res, 400, { ok: false, error: inject.error, stage: 'inject', inject });
            return;
        }
        log(`dsh：连接插件已${inject.action === 'injected' ? '安装' : '更新'}到 profile ${profile}`);

        // ---- 4) 校验组合结果（--dump-config 里必须出现插件行）----
        // 校验不通过说明 patch/bundles 写坏了，此时**绝不能重启**——
        // 否则会把本来在跑的服务打成起不来（真实踩过的坑）。
        let verified: {
            ok: boolean;
            error: string;
            unrelated?: boolean;
            unrelatedReason?: string;
        } | null = null;

        /**
         * 外部应用（Electron 桌面版）独占管理的 profile：
         * CLI 会直接拒绝 `--dump-config`，但文件本身可以被写入并由应用**热加载**。
         *
         * 所以这里不能校验、也不该回滚 —— 回滚会把插件从共享目录里删掉，
         * 顺带把别的 profile（比如 web）也弄坏，这是已经踩过的一次。
         * 正确做法：保留注入，提示用户重启该应用。
         */
        const external = isExternallyManagedProfile(profile, settings.exePath, dshHome());
        if (external) {
            log(`dsh：profile ${profile} 由外部应用管理，跳过 CLI 校验（文件已写入，应用会热加载）`);

            const online = ((app.downstreams.get(settings.downstreamId ?? 'dsh') as unknown as {
                onlineCount?: () => number;
            } | undefined)?.onlineCount?.() ?? 0) > 0;

            json(res, 200, {
                ok: true,
                stage: 'external-managed',
                verified: null,
                inject,
                rolledBack: false,
                restart: null,
                online,
                message: online
                    ? `插件已写入 profile ${profile}，且已连上 Bridge。`
                    : `插件已写入 profile ${profile}。该 profile 由 dsh 桌面版管理，`
                        + 'CLI 无法校验；桌面版会热加载配置，稍等几秒或重启它即可生效。',
            });
            return;
        }

        if (body.verify !== false) {
            const v = verifyInjection({ exePath: settings.exePath, profile, home: dshHome() });
            verified = v;
            log(v.ok ? 'dsh：插件已进入 profile 组合结果' : `dsh：插件校验未通过 —— ${v.error}`);

            /**
             * 与本次注入无关的失败（profile 里别的插件缺依赖）：
             * 我们的写入本身是对的，回滚反而有害（用户再修一次还是同样报错）。
             * 这种情况保留注入、不重启，明确告诉用户问题出在别处。
             */
            if (!v.ok && v.unrelated) {
                json(res, 200, {
                    ok: true,
                    stage: 'installed-warning',
                    error: v.error,
                    verified,
                    inject,
                    rolledBack: false,
                    restart: null,
                    online: false,
                    message: `插件已写入 ${profile}，但该 profile 本身另有问题：`
                        + `${v.unrelatedReason || '存在无法解析的插件'}。`
                        + '本次改动已保留，尚未重启服务。',
                });
                return;
            }

            if (!v.ok) {
                // 确属我们写坏了：回滚，让 profile 回到可用状态
                const rollback = removePlugin({ profile, home: dshHome() });
                log(rollback.ok
                    ? `dsh：已回滚插件注入（profile ${profile}）`
                    : `dsh：回滚失败 —— ${rollback.error}`);

                json(res, 400, {
                    ok: false,
                    stage: 'verify',
                    error: `插件校验失败，已回滚：${v.error}`,
                    verified,
                    inject,
                    rolledBack: rollback.ok,
                    restart: null,
                    online: false,
                    message: '配置写入后 dsh 无法解析，已撤回改动；服务未重启。',
                });
                return;
            }
        }

        // ---- 5) 重启服务让插件生效（仅在校验通过时）----
        let restart: { ok: boolean; error?: string; pid?: number } | null = null;
        if (body.restart !== false) {
            const r = await app.dshService().restart();
            restart = { ok: r.ok, error: r.error };
            log(r.ok ? 'dsh：服务已重启，等待插件上线' : `dsh：重启失败 —— ${r.error ?? '未知'}`);
        }

        // ---- 6) 等插件真的连上来（最多 20 秒）----
        let online = false;
        if (body.waitOnline !== false && restart?.ok) {
            const deadline = Date.now() + 20000;
            while (Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 600));
                const adapter = app.downstreams.get(settings.downstreamId) ?? app.downstreams.get('dsh');
                const st = adapter?.status();
                if (st?.available && (st.detail?.pluginConnections as number) > 0) {
                    online = true;
                    break;
                }
            }
            log(online ? 'dsh：插件已上线，消息将走插件链路' : 'dsh：插件未在 20 秒内上线（可查看服务日志）');
        }

        json(res, 200, {
            ok: true,
            stage: online ? 'online' : (restart?.ok === false ? 'restart-failed' : 'installed'),
            inject,
            verified,
            restart,
            online,
            // 给前端直接可展示的结论
            message: online
                ? '安装完成，插件已连接，消息将直接进入 dsh'
                : restart?.ok === false
                    ? `已安装但服务重启失败：${restart.error ?? '未知'}`
                    : '已安装并重启，插件尚未上线（见服务日志）',
        });
    });

    router.post('/api/dsh/plugin/remove', async ({ res, body }) => {
        const settings = deps.dshSettings();
        const profile = String(body.profile ?? settings.serviceProfile).trim();
        const r = removePlugin({ profile, home: dshHome() });
        if (!r.ok) {
            json(res, 400, { ok: false, error: r.error });
            return;
        }
        log(`dsh：已从 profile ${profile} 移除连接插件`);
        let restart: { ok: boolean; error?: string } | null = null;
        if (body.restart === true) {
            const rr = await app.dshService().restart();
            restart = { ok: rr.ok, error: rr.error };
        }
        json(res, 200, { ok: true, remove: r, restart });
    });
}
