/**
 * 统一配置模型。
 *
 * 与旧版的区别：
 *   - 触发规则、分段、管道等**全局**设置保留在顶层。
 *   - 上游（SnowLuma）独立成 `upstream`。
 *   - 下游从「一个全局 backend 枚举」变成 `downstreams` 实例数组，
 *     会话用 `backendId` 指向其中一个实例。
 *   - 旧配置的 `backend: 'taver' | 'dsh'` 会被 migrate 成等价的实例。
 */

import type { DownstreamConfig } from '../downstream/types.ts';
import type { ProcessorRule, SegmentationConfig as SharedSegmentation } from '@bridge/shared';

/** 复用 @bridge/shared 的规则类型，避免两处定义漂移 */
export type { ProcessorRule };

export interface TriggerConfig {
    atOnly: boolean;
    privateReply: boolean;
    allowedUsers: number[];
    allowedGroups: number[];
}

/**
 * 分段配置：与 shared 一致，但 delayMs 用元组表达范围。
 * shared 里已声明为 [min, max]，这里直接别名。
 */
export type SegmentationConfig = SharedSegmentation;

export interface ImageReplyConfig {
    enabled: boolean;
    instruction: boolean;
    baseUrl: string;
}

/** 把本地宽松规则收敛成 @bridge/core 期望的判别联合 */
export function toCoreRules(rules: ProcessorRule[]): ProcessorRule[] {
    return rules.filter((r) => {
        if (r.type === 'strip') return Boolean(r.begin && r.end);
        return Boolean(r.pattern);
    });
}

export interface DefaultsConfig {
    character: string;
    world: string;
}

export interface UpstreamConfig {
    /** OneBot v11 WS 地址 */
    url: string;
    /** Access token，空则不拼 */
    token: string;
    /** 断线重连初始间隔（毫秒） */
    reconnectMs: number;
    /** 单次 action 超时 */
    actionTimeoutMs: number;
}

export interface FacesConfig {
    dataDir: string;
    ollamaBaseUrl: string;
    ollamaVisionModel: string;
    ollamaTextModel: string;
}

export interface BridgeConfig {
    /** HTTP API 端口（控制台） */
    consolePort: number;
    /** 下游入站 WS 端口（酒馆扩展 / dsh 插件都连这里） */
    extPort: number;
    /** 上游 OneBot */
    upstream: UpstreamConfig;
    /** 下游实例列表 */
    downstreams: DownstreamConfig[];
    /** 会话未指定时使用的下游 id；空 = 用列表里第一个启用的 */
    defaultDownstreamId: string;
    trigger: TriggerConfig;
    maxMessageLength: number;
    replyProcessors: ProcessorRule[];
    defaults: DefaultsConfig;
    segmentation: SegmentationConfig;
    imageReplies: ImageReplyConfig;
    stDataDir: string;
    faces: FacesConfig;
    /** 下游注册接口的 token；空 = 关闭自注册 */
    registrationToken: string;
}

export const DEFAULT_SEGMENTATION: SegmentationConfig = {
    enabled: true,
    maxLen: 200,
    minLen: 6,
    maxSegments: 12,
    hardChars: '。！？!?…',
    softChars: '，,；;',
    pairChars: [
        ['动作', '*'],
        ['台词', '"'],
        ['中文台词', '“”'],
        ['括号动作', '（）'],
    ],
    splitStrings: [],
    splitOnPairs: true,
    pairMinLen: 3,
    convertActionMarkers: true,
    delayMs: [300, 900],
};

export const DEFAULT_CONFIG: BridgeConfig = {
    consolePort: 9510,
    extPort: 9500,
    upstream: {
        url: 'ws://127.0.0.1:3001',
        token: '',
        reconnectMs: 5000,
        actionTimeoutMs: 15000,
    },
    // 默认接入 dsh：开箱即用，没有酒馆也能跑
    downstreams: [
        {
            id: 'dsh',
            kind: 'dsh-plugin',
            name: 'dsh（DeepSeek Harness）',
            enabled: true,
            settings: {
                // 插件未连上时回落到 headless
                fallbackHeadless: true,
                exePath: '',
                profile: 'headless',
                workRoot: '',
                timeoutMs: 180000,
                historyTurns: 6,
                systemPrompt: '',
                errorReply: '',
                persistHistory: true,
                concurrency: 1,
                // 常驻服务
                serviceProfile: 'web',
                servicePort: 3080,
                serviceLogFile: '',
            },
        },
        {
            id: 'tavern',
            kind: 'sillytavern',
            name: '酒馆（SillyTavern）',
            enabled: false,
            settings: {
                stDataDir: '',
            },
        },
    ],
    defaultDownstreamId: 'dsh',
    trigger: {
        atOnly: true,
        privateReply: true,
        allowedUsers: [],
        allowedGroups: [],
    },
    maxMessageLength: 2000,
    replyProcessors: [],
    defaults: { character: '', world: '' },
    segmentation: DEFAULT_SEGMENTATION,
    imageReplies: { enabled: true, instruction: true, baseUrl: '' },
    stDataDir: '',
    faces: {
        dataDir: '',
        ollamaBaseUrl: 'http://127.0.0.1:11434',
        ollamaVisionModel: 'qwen2.5vl:3b',
        ollamaTextModel: '',
    },
    registrationToken: '',
};
