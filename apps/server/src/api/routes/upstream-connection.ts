import type { Router } from '../router.ts';
import { json } from '../router.ts';
import type { AppContext } from '../context.ts';
import { inspectSnowLuma, readEndpoint } from '../../integrations/snowluma/connection.ts';
import { probeSnowLuma, UIN_REGEX } from '../../integrations/snowluma/snowluma-service.mjs';
import { toUpstreamAccounts } from './config.ts';

export function registerUpstreamConnectionRoutes(router: Router, app: AppContext) {
    router.get('/api/snowluma/connection', async ({ res, query }) => {
        try {
            const dir = query.get('dir') || app.config().snowluma.dir;
            const port = Number(query.get('port') || app.config().snowluma.webuiPort);
            const result = await inspectSnowLuma(dir, port);
            json(res, 200, { dir: result.probe.dir, ...result });
        } catch (e) { json(res, 400, { error: e instanceof Error ? e.message : String(e) }); }
    });
    router.post('/api/snowluma/connect', ({ res, body }) => {
        try {
            const dir = String(body.dir || app.config().snowluma.dir);
            const uin = String(body.uin ?? '');
            const port = Number(body.port || app.config().snowluma.webuiPort);
            if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WebUI 端口须为 1–65535');
            if (!UIN_REGEX.test(uin)) throw new Error('QQ 号格式无效');
            const probe = probeSnowLuma(dir, port);
            if (!probe.ok) throw new Error(probe.error || 'SnowLuma 目录无效');
            const endpoint = readEndpoint(probe.configDir, uin);
            if (!endpoint) throw new Error('该账号还没有启用 OneBot WebSocket 服务，请先在 SnowLuma 中启用后重试');
            const existing = app.config().accounts.find(a => a.uin === uin);
            const duplicate = app.config().accounts.find(a => a.id !== existing?.id && a.upstream.url.replace(/\/$/, '') === endpoint.url.replace(/\/$/, ''));
            if (duplicate) throw new Error(`该端点已被账号 ${duplicate.name || duplicate.id} 使用，请检查 SnowLuma 的多账号端口`);
            const id = existing?.id ?? `qq_${uin}`;
            app.updateConfig(cfg => {
                cfg.snowluma = { dir: probe.dir, webuiPort: port };
                const value = { id, uin, name: existing?.name || uin, enabled: true, upstream: { ...endpoint, reconnectMs: 5000, actionTimeoutMs: 15000 } };
                const index = cfg.accounts.findIndex(a => a.id === id);
                if (index >= 0) cfg.accounts[index] = value; else cfg.accounts.push(value);
            });
            app.upstreams.apply(toUpstreamAccounts(app.config()));
            if (existing) app.upstreams.reconnect(id);
            json(res, 202, { ok: true, id, message: '正在连接，实际状态以账号卡片为准' });
        } catch (e) { json(res, 400, { error: e instanceof Error ? e.message : String(e) }); }
    });
    router.post('/api/accounts/:id/connect', ({ res, params }) => {
        const account = app.config().accounts.find(a => a.id === params.id);
        if (!account) return json(res, 404, { error: '账号不存在' });
        const wasEnabled = account.enabled;
        app.updateConfig(cfg => { cfg.accounts.find(a => a.id === account.id)!.enabled = true; });
        app.upstreams.apply(toUpstreamAccounts(app.config()));
        if (wasEnabled) app.upstreams.reconnect(account.id);
        json(res, 202, { ok: true });
    });
}
