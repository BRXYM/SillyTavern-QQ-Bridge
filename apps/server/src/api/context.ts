/**
 * 应用级依赖容器。
 *
 * 所有路由与适配器都通过它拿依赖，避免全局单例散落各处。
 * 这也是以后写集成测试时唯一需要构造的对象。
 */

import type { BridgeConfig } from '../config/schema.ts';
import type { SessionStore } from '../core/sessions.ts';
import type { ConversationStateStore } from '../core/conversation-state.ts';
import type { FlowRunStore } from '../core/flow-runtime.ts';
import type { UpstreamManager } from '../upstream/manager.ts';
import type { Logger } from '../core/logger.ts';
import type { FaceService } from '../services/faces/faces-service.mjs';
import type { OllamaClient, OllamaDaemon } from '../integrations/ollama/ollama-service.mjs';
import type { DshService } from '../integrations/dsh/dsh-profile-service.mjs';

export type { DownstreamRuntime } from '../downstream/runtime.ts';
import type { DownstreamRuntime } from '../downstream/runtime.ts';

export interface AppContext {
    flowRuns: FlowRunStore;
    conversationState: ConversationStateStore;
    logger: Logger;
    config: () => BridgeConfig;
    /** 修改配置并落盘；可选立即生效的回调由调用方触发 */
    updateConfig: (mutate: (cfg: BridgeConfig) => void) => void;
    sessions: SessionStore;
    /** 多账号上游集合 */
    upstreams: UpstreamManager;
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
