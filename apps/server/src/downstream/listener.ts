import type { BridgeConfig } from '../config/schema.ts';
import type { DownstreamRuntime } from './runtime.ts';
import { InboundServer, type InboundAdapter } from './inbound.ts';
import type { DownstreamAdapter } from './types.ts';
import { log } from '../core/logger.ts';

export function createInboundListener(config: () => BridgeConfig, downstreams: DownstreamRuntime) {
    let inbound: InboundServer | null = null;

    async function startInbound(): Promise<void> {
        inbound = new InboundServer({
            port: config().extPort,
            token: () => config().registrationToken,
            resolveAdapter: (kind, downstreamId) => {
                // 1) 下游自报的实例 id 优先（插件知道自己注册成哪个实例）
                if (downstreamId) {
                    const exact = downstreams.get(downstreamId);
                    if (exact && acceptsInbound(exact)) return exact;
                }
                // 2) 按类型兜底：取该类型下连接数最少的，避免总是落到同一个
                const candidates = downstreams.list().filter((a) => a.kind === kind && acceptsInbound(a));
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
            allAdapters: () => downstreams.list().filter(acceptsInbound),
        });
        await inbound.ready();
    }

    async function restartInbound(): Promise<void> {
        if (inbound) await inbound.close();
        inbound = null;
        await startInbound();
    }

    return { start: startInbound, restart: restartInbound, stop: async () => {
        await inbound?.close();
        inbound = null;
    } };
}

/** HTTP 等主动请求型适配器不参与插件入站握手和消息分发。 */
function acceptsInbound(adapter: DownstreamAdapter): adapter is DownstreamAdapter & InboundAdapter {
    const candidate = adapter as unknown as Partial<InboundAdapter>;
    return typeof candidate.attach === 'function' && typeof candidate.detach === 'function' && typeof candidate.handleMessage === 'function';
}
