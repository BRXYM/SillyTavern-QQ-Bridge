/**
 * 应用级依赖容器。
 *
 * 所有路由与适配器都通过它拿依赖，避免全局单例散落各处。
 * 这也是以后写集成测试时唯一需要构造的对象。
 */

import type { BridgeConfig } from '../config/schema.ts';
import type { SessionStore } from '../core/sessions.ts';
import type { OneBotClient } from '../upstream/onebot.ts';
import type { DownstreamAdapter } from '../downstream/types.ts';
import type { Logger } from '../core/logger.ts';
import type { FaceService } from '../../faces-service.mjs';
import type { OllamaClient, OllamaDaemon } from '../../ollama-service.mjs';
import type { DshService } from '../../dsh-profile-service.mjs';

/** 下游运行时集合 + 配置写回能力 */
export interface DownstreamRuntime {
    list: () => DownstreamAdapter[];
    get: (id: string) => DownstreamAdapter | undefined;
    /** 重新按配置构建（启停实例） */
    reload: () => Promise<{ ok: boolean; error?: string }>;
    /** 记录一次自注册（返回写入后的配置项） */
    register: (entry: {
        id: string;
        kind: string;
        name: string;
        settings?: Record<string, unknown>;
    }) => Promise<{ ok: boolean; error?: string; id?: string }>;
}

export interface AppContext {
    logger: Logger;
    config: () => BridgeConfig;
    /** 修改配置并落盘；可选立即生效的回调由调用方触发 */
    updateConfig: (mutate: (cfg: BridgeConfig) => void) => void;
    sessions: SessionStore;
    onebot: OneBotClient;
    downstreams: DownstreamRuntime;
    faces: () => FaceService | null;
    ollama: { client: OllamaClient; daemon: OllamaDaemon };
    dshService: () => DshService;
    /** 表情库摘要 */
    faceSummary: () => string;
    /** 重启入站服务（改端口时用） */
    restartInbound: () => Promise<void>;
    /** 进程启动时间 */
    startedAt: number;
    /** 源码版本（用于判断进程是否旧） */
    codeVersion: string;
}
