import http from 'node:http';
import { registerFlowRoutes } from './routes/flows.ts';
import { registerConversationRoutes } from './routes/conversations.ts';
import { registerUpstreamConnectionRoutes } from './routes/upstream-connection.ts';
import path from 'node:path';
import { Router, json } from './router.ts';
import type { AppContext } from './context.ts';
import { handleEventStream } from './events.ts';
import type { AppPaths } from '../app/paths.ts';
import type { createDshRuntime } from '../integrations/dsh/runtime.ts';
import { registerStatusRoutes } from './routes/status.ts';
import { registerDownstreamRoutes } from './routes/downstreams.ts';
import { registerSessionRoutes } from './routes/sessions.ts';
import { registerConfigRoutes } from './routes/config.ts';
import { registerDshRoutes } from './routes/dsh.ts';
import { registerHostRoutes } from './routes/host.ts';
import { registerFacesRoutes } from './routes/faces.ts';
import { registerAdaptationRoutes } from './routes/adaptations.ts';
import { registerOllamaRoutes } from './routes/ollama.ts';

/** 路由注册和 HTTP/SSE 传输，与进程启动分离。 */
export function createApiServer(app: AppContext, paths: AppPaths,
    dsh: ReturnType<typeof createDshRuntime>, facesDataDir: string) {
    const router = new Router();
    registerStatusRoutes(router, app);
    registerDownstreamRoutes(router, app);
    registerSessionRoutes(router, app);
    registerConversationRoutes(router, app);
    registerFlowRoutes(router, app);
    registerUpstreamConnectionRoutes(router, app);
    registerConfigRoutes(router, app);

    // dsh 专属接口（服务管理 + 插件注入），复用已独立验证的实现
    registerDshRoutes(router, app, {
        serverRoot: paths.serverRoot,
        dshSettings: dsh.settings,
        makeHeadless: dsh.makeHeadless,
    });

    // 上游/下游软件本体的安装与配置管理（SnowLuma / SillyTavern）
    registerHostRoutes(router, app, {
        repoRoot: path.resolve(paths.serverRoot, '..', '..'),
        extensionSourceDir: path.resolve(paths.serverRoot, '..', 'extension'),
    });

    // 表情库（列表 / 同步 / 打标 / 导出）
    registerFacesRoutes(router, app, { dataDir: facesDataDir });

    // Ollama 管理（服务启停 / 模型 / 拉取 / 打标模型选择）
    registerOllamaRoutes(router, app);
    const adaptations = registerAdaptationRoutes(router, app, path.join(paths.serverRoot, 'data', 'adaptations'));

    const eventStreams = new Set<() => void>();
    const consoleServer = http.createServer((req, res) => {
        // SSE 长连接：不走 router，否则会被统一的 JSON 处理包住
        if (req.method === 'GET' && (req.url ?? '').split('?')[0] === '/api/events') {
            const cleanup = handleEventStream(req, res);
            eventStreams.add(cleanup);
            res.once('close', () => eventStreams.delete(cleanup));
            return;
        }

        void router.handle(req, res).then((handled) => {
            if (!handled) json(res, 404, { ok: false, error: `未知接口：${req.method} ${req.url}` });
        }).catch((e) => {
            json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
        });
    });

    return {
        server: consoleServer,
        start: () => new Promise<void>((resolve, reject) => {
            const onError = (error: Error) => reject(error);
            consoleServer.once('error', onError);
            consoleServer.listen(app.config().consolePort, '127.0.0.1', () => {
                consoleServer.off('error', onError);
                resolve();
            });
        }),
        stop: async () => {
            await adaptations.dispose();
            return new Promise<void>((resolve, reject) => {
                for (const cleanup of eventStreams) cleanup();
                eventStreams.clear();
                consoleServer.close((error) => {
                    if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
                    else resolve();
                });
                // SSE 是长连接，退出时需要主动断开才能完成 close。
                consoleServer.closeAllConnections();
            });
        },
    };
}
