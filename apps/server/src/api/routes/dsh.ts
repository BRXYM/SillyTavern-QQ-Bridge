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
    listProfileBundles,
    pluginTargetDir,
    probeInjection,
    removePlugin,
    verifyInjection,
    dshHome,
} from '../../../dsh-profile-service.mjs';
import { findDsh, listProfiles, invalidateDshProbe } from '../../../dsh-service.mjs';
import { log } from '../../core/logger.ts';

export interface DshRouteDeps {
    serverRoot: string;
    dshSettings: () => DshSettings & { serviceProfile: string; servicePort: number; serviceLogFile: string };
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
            // 兼作 dsh 自身的健康信息
            service: app.dshService().status(),
        });
    });

    // ---------------- 常驻服务 ----------------
    router.get('/api/dsh/service', async ({ res }) => {
        const st = await app.dshService().inspect({ logTail: 40 });
        json(res, 200, { ok: true, ...st });
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
            },
            profiles: listProfileBundles(dshHome()),
            injection: probeInjection({ profile, home: dshHome() }),
        });
    });

    router.post('/api/dsh/plugin/inject', async ({ res, body }) => {
        const settings = deps.dshSettings();
        const profile = String(body.profile ?? settings.serviceProfile).trim();

        const inject = injectPlugin({
            profile,
            sourceDir: pluginSourceDir,
            url: pluginUrl(),
            token: String(body.token ?? app.config().registrationToken ?? ''),
            cwdRoot: String(body.cwdRoot ?? settings.workRoot ?? ''),
            home: dshHome(),
        });

        if (!inject.ok) {
            json(res, 400, { ok: false, error: inject.error, inject });
            return;
        }
        log(`dsh：连接插件已${inject.action === 'injected' ? '注入' : '更新'}到 profile ${profile}`);

        let verified: { ok: boolean; error: string } | null = null;
        if (body.verify !== false) {
            const v = verifyInjection({ exePath: settings.exePath, profile, home: dshHome() });
            verified = v;
            log(v.ok ? 'dsh：插件已进入 profile 组合结果' : `dsh：插件校验未通过 —— ${v.error}`);
        }

        let restart: { ok: boolean; error?: string } | null = null;
        if (body.restart === true) {
            const r = await app.dshService().restart();
            restart = { ok: r.ok, error: r.error };
            log(r.ok ? 'dsh：服务已重启' : `dsh：重启失败 —— ${r.error ?? '未知'}`);
        }

        json(res, 200, { ok: true, inject, verified, restart });
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
