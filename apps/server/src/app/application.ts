import { logger, log } from '../core/logger.ts';
import { createConfigRuntime } from '../config/runtime.ts';
import { createSessions } from './sessions.ts';
import { UpstreamManager } from '../upstream/manager.ts';
import { DownstreamManager } from '../downstream/manager.ts';
import type { SendContext } from '../core/sending.ts';
import type { DispatchDeps } from '../core/dispatch.ts';
import { bindMessageEvents } from './message-events.ts';
import { createFaceRuntime } from '../services/faces/runtime.ts';
import { createDshRuntime } from '../integrations/dsh/runtime.ts';
import { OllamaClient, OllamaDaemon } from '../integrations/ollama/ollama-service.mjs';
import { createInboundListener } from '../downstream/listener.ts';
import { createApiServer } from '../api/server.ts';
import { toUpstreamAccounts } from '../api/routes/config.ts';
import type { AppContext } from '../api/context.ts';
import { createAppPaths, codeVersion } from './paths.ts';
import { logEnvironment } from './diagnostics.ts';
import { Lifecycle } from './lifecycle.ts';
import path from 'node:path';
import { ConversationStateStore } from '../core/conversation-state.ts';

export interface ApplicationOptions {
    /** 可注入独立数据目录，测试无需接触真实账号配置。 */
    serverRoot?: string;
    env?: NodeJS.ProcessEnv;
}

/** 唯一装配点；导入本模块不会启动网络监听或安装进程信号处理器。 */
export function createApplication(options: ApplicationOptions = {}) {
    const startedAt = Date.now();
    const paths = createAppPaths(options.serverRoot);
    const env = options.env ?? process.env;
    const { config, updateConfig } = createConfigRuntime(paths.config, env);
    const sessions = createSessions(paths.sessions, config);
    const conversationState = new ConversationStateStore(path.join(paths.serverRoot, 'data', 'conversation-state.json'));
    const upstreams = new UpstreamManager();
    const activeUpstream = () => {
        const accounts = config().accounts.filter((account) => account.enabled);
        for (const account of accounts) {
            const client = upstreams.client(account.id);
            if (client?.stats.connected) return client;
        }
        return accounts[0] ? upstreams.client(accounts[0].id) : undefined;
    };
    const faces = createFaceRuntime(config, paths.serverRoot, activeUpstream, env);
    const dsh = createDshRuntime(config, paths.serverRoot);
    const ollama = {
        client: new OllamaClient({ baseUrl: config().faces.ollamaBaseUrl, timeoutMs: 60000 }),
        daemon: new OllamaDaemon({ exePath: '', baseUrl: config().faces.ollamaBaseUrl, modelsDir: '', log }),
    };
    const adapterDeps = {
        dsh: {
            sessionDefaults: (sessionKey: string) => {
                const r = sessions.resolve(sessionKey);
                return { character: r.character, world: r.world };
            },
            faceManifest: faces.manifest,
            imageReplies: () => config().imageReplies,
        },
        sillytavern: {
            sessionDefaults: (sessionKey: string) => {
                const r = sessions.resolve(sessionKey);
                return { character: r.character, world: r.world };
            },
            faceManifest: faces.manifest,
        },
        makeHeadless: dsh.makeHeadless,
    };

    const downstreams = new DownstreamManager({
        config,
        updateConfig,
        deps: adapterDeps,
    });

    // 所有下游共用同一套发送与消息派发链路。
    const sending: SendContext = {
        upstreams,
        sessions,
        segmentation: () => config().segmentation,
        maxMessageLength: () => config().maxMessageLength,
        resolveFace: faces.resolve,
        faceSummary: faces.summary,
    };

    const dispatchDeps: DispatchDeps = {
        conversationState,
        sessions,
        sending,
        config,
        resolveDownstream: (id, profileId) => downstreams.resolve(id, profileId),
        faceManifest: faces.manifest,
        selfId: (accountId: string) => upstreams.client(accountId)?.stats.selfId ?? '',
    };

    bindMessageEvents(upstreams, dispatchDeps);
    const inbound = createInboundListener(config, downstreams);
    const context: AppContext = {
        conversationState,
        logger, config, updateConfig, sessions, upstreams, downstreams,
        faces: faces.service, ollama, dshService: () => dsh.service,
        faceSummary: faces.summary, restartInbound: inbound.restart,
        startedAt, codeVersion: codeVersion(),
    };
    const api = createApiServer(context, paths, dsh, faces.dataDir);
    const lifecycle = new Lifecycle([
        { name: 'sessions', start: () => {}, stop: () => { sessions.flush(); } },
        { name: 'conversation-state', start: () => {}, stop: () => conversationState.close() },
        { name: 'faces', start: faces.start, stop: faces.stop },
        { name: 'upstreams', start: () => upstreams.apply(toUpstreamAccounts(config())), stop: () => upstreams.dispose() },
        { name: 'downstreams', start: () => downstreams.start(), stop: () => downstreams.dispose() },
        { name: 'inbound', start: inbound.start, stop: inbound.stop },
        { name: 'api', start: api.start, stop: api.stop },
    ]);
    return {
        context,
        httpServer: api.server,
        start: async () => {
            await lifecycle.start();
            const cfg = config();
            log(`API 服务已启动: http://127.0.0.1:${cfg.consolePort}/api/status`);
            log(`连接器已启动: 账号=[${cfg.accounts.map((a) => a.id).join(', ')}] | 入站=${cfg.extPort} | 默认下游=${cfg.defaultDownstreamId}`);
            const noToken = cfg.accounts.filter((a) => a.enabled && !a.upstream.token);
            if (noToken.length) log(`⚠ 账号 ${noToken.map((a) => a.id).join(', ')} 的 token 为空；若 SnowLuma 开了 Access Token 会返回 401`);
            logEnvironment(paths);
        },
        stop: () => lifecycle.stop(),
    };
}
