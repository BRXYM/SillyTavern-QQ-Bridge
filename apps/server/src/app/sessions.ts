import type { BridgeConfig } from '../config/schema.ts';
import { SessionStore } from '../core/sessions.ts';
import { publishStatus } from '../api/events.ts';
import { log } from '../core/logger.ts';

export function createSessions(sessionsPath: string, config: () => BridgeConfig) {
    const sessions = new SessionStore(sessionsPath, () => ({
        backendId: config().defaultDownstreamId || config().downstreams[0]?.id || '',
        profileId: config().defaultDownstreamProfileId,
        character: config().defaults.character,
        world: config().defaults.world,
    }));
    sessions.load();

    /**
     * 旧会话（无账号前缀）统一挂到第一个账号下。
     *
     * 升级前只有一个号，所以这些配置本来就属于它；不改的话，
     * 第一个号上线后会看到一堆"新会话"，用户的下游/角色绑定全丢。
     */
    const legacyAdopted = sessions.adoptLegacyKeys(config().accounts[0]?.id ?? '');
    if (legacyAdopted > 0) {
        log(`ℹ 会话迁移：${legacyAdopted} 个旧会话已归属账号 ${config().accounts[0]?.id}`);
    }

    sessions.on('error', (e: unknown) => log(`✗ 会话持久化失败：${String(e)}`));
    sessions.on('changed', (key: string) => publishStatus('session', { sessionKey: key }));
    sessions.on('created', (key: string) => publishStatus('session', { sessionKey: key }));
    sessions.on('removed', (key: string) => publishStatus('session', { sessionKey: key }));

    return sessions;
}
