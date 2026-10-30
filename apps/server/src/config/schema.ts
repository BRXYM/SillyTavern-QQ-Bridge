/**
 * 统一配置模型。
 *
 * 与旧版的区别：
 *   - 触发规则、分段、管道等**全局**设置保留在顶层。
 *   - 上游从「一条连接」变成 `accounts` 数组：一个 Bridge 可以接多个 QQ 号，
 *     每个号对应 SnowLuma 的一个 OneBot 端点（端口与 token 各自独立）。
 *   - 下游从「一个全局 backend 枚举」变成 `downstreams` 实例数组，
 *     每个实例下面还可以有多个**命名配置**（profiles），
 *     会话用 `backendId` + `downstreamProfileId` 指向具体组合。
 *   - 旧配置的 `backend: 'taver' | 'dsh'` 会被 migrate 成等价的实例。
 */

import type { DownstreamConfig, DownstreamProfile } from '../downstream/types.ts';
import type { ConversationConfig } from './conversations.ts';
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
 * 会话准入（黑白名单）。
 *
 * 与 trigger 的区别：trigger 决定"要不要处理这条消息"，
 * 会话准入决定"这个对象是否有资格和机器人互动"。
 * 前者是行为开关，后者是身份门槛 —— 分开配置避免互相牵制。
 */
export interface SessionAccessConfig {
    /** 黑名单：这些 QQ 号永远拒绝（优先级最高） */
    denyUsers: number[];
    /** 黑名单：这些群永远拒绝 */
    denyGroups: number[];
    /** 白名单：非空时只允许这些 QQ 号（含新会话） */
    allowUsers: number[];
    /** 白名单：非空时只允许这些群 */
    allowGroups: number[];
    /** 新会话（无配置且不在任何名单里）的策略 */
    unknownPolicy: 'allow' | 'deny';
    /** 拒绝时回给 QQ 的一句话；空 = 静默 */
    denyReply: string;
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

/**
 * 一个上游 QQ 号（= SnowLuma 的一个 OneBot 端点）。
 *
 * 为什么不是「一个全局 upstream」：SnowLuma 每个 QQ 号有独立的
 * `onebot_<uin>.json`，WS 端口与 access token 都不同。要让 Bridge
 * 同时服务多个号，就必须按号各连一条。
 */
export interface AccountUpstreamConfig {
    /** OneBot v11 WS 地址 */
    url: string;
    /** Access token，空则不拼 */
    token: string;
    /** 断线重连初始间隔（毫秒） */
    reconnectMs: number;
    /** 单次 action 超时 */
    actionTimeoutMs: number;
}

export interface AccountConfig {
    /**
     * 稳定标识。作为会话 key 前缀，一旦使用就不应再改 ——
     * 改它等于把所有会话的下游绑定和历史切断。
     */
    id: string;
    /** QQ 号；可以留空（连上后从 lifecycle 事件补），只用于显示 */
    uin: string;
    /** 备注名，如「主号」「测试号」 */
    name: string;
    enabled: boolean;
    /** 该号对应的 SnowLuma OneBot 端点 */
    upstream: AccountUpstreamConfig;
}

export interface FacesConfig {
    dataDir: string;
    ollamaBaseUrl: string;
    ollamaVisionModel: string;
    ollamaTextModel: string;
    /**
     * Ollama 可执行文件路径。空 = 自动探测。
     * 只在「用户显式指定过」时才该有值，覆盖自动探测。
     */
    ollamaExePath: string;
    /**
     * Ollama 模型目录。空 = 自动推导。
     *
     * 这是最容易出错的一项：模型装在别处、服务看不到时，
     * 界面会显示"没有模型"，看起来像没装。
     */
    ollamaModelsDir: string;
}

/** SnowLuma（上游软件本体）的安装信息 */
export interface SnowLumaConfig {
    /** 安装目录；探测成功后会写回这里 */
    dir: string;
    /** WebUI 端口，用于判定实际生效的配置目录 */
    webuiPort: number;
}

export interface BridgeConfig {
    conversationProfiles: ConversationConfig[];
    defaultConversationId: string;
    /** 配置结构版本；用于判断要不要迁移 */
    configVersion: number;
    /** HTTP API 端口（控制台） */
    consolePort: number;
    /** 下游入站 WS 端口（酒馆扩展 / dsh 插件都连这里） */
    extPort: number;
    /** 上游 QQ 号列表；至少一个 */
    accounts: AccountConfig[];
    /** 上游软件本体的安装信息 */
    snowluma: SnowLumaConfig;
    /** 下游实例列表 */
    downstreams: DownstreamConfig[];
    /** 会话未指定时使用的下游 id；空 = 用列表里第一个启用的 */
    defaultDownstreamId: string;
    /** 会话未指定配置时，该下游使用的默认配置 id；空 = 用该下游的默认配置 */
    defaultDownstreamProfileId: string;
    trigger: TriggerConfig;
    /** 会话准入：身份门槛（黑白名单） */
    sessionAccess: SessionAccessConfig;
    maxMessageLength: number;
    replyProcessors: ProcessorRule[];
    defaults: DefaultsConfig;
    segmentation: SegmentationConfig;
    imageReplies: ImageReplyConfig;
    /** 酒馆数据目录（酒馆作为下游时才用） */
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

/** 默认上游端口：与 SnowLuma 的 onebot_<uin>.json 默认一致 */
export const DEFAULT_UPSTREAM_PORT = 3001;

export const DEFAULT_CONFIG: BridgeConfig = {
    conversationProfiles: [],
    defaultConversationId: '',
    configVersion: 3,
    consolePort: 9510,
    extPort: 9500,
    accounts: [
        {
            id: 'main',
            uin: '',
            name: '主号',
            enabled: true,
            upstream: {
                url: `ws://127.0.0.1:${DEFAULT_UPSTREAM_PORT}`,
                token: '',
                reconnectMs: 5000,
                actionTimeoutMs: 15000,
            },
        },
    ],
    snowluma: {
        dir: '',
        webuiPort: 5099,
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
                errorReply: '',
                persistHistory: true,
                concurrency: 1,
                // 历史提取：默认空，不发送任何历史文本
                historyExtracts: [],
                // 提示词注入：默认全关，只转发用户原话
                prompt: {
                    qqBase: false,
                    character: false,
                    faces: false,
                    images: false,
                    extra: '',
                },
                // 常驻服务
                serviceProfile: 'web',
                servicePort: 3080,
                serviceLogFile: '',
            },
            profiles: [],
        },
        {
            id: 'tavern',
            kind: 'sillytavern',
            name: '酒馆（SillyTavern）',
            enabled: false,
            settings: {
                stDataDir: '',
            },
            profiles: [],
        },
    ],
    defaultDownstreamId: 'dsh',
    defaultDownstreamProfileId: '',
    trigger: {
        atOnly: true,
        privateReply: true,
        allowedUsers: [],
        allowedGroups: [],
    },
    sessionAccess: {
        denyUsers: [],
        denyGroups: [],
        allowUsers: [],
        allowGroups: [],
        unknownPolicy: 'allow',
        denyReply: '',
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
        ollamaExePath: '',
        ollamaModelsDir: '',
    },
    registrationToken: '',
};

/** 下游实例的命名配置查找（找不到返回 undefined） */
export function findProfile(
    downstream: DownstreamConfig | undefined,
    profileId: string,
): DownstreamProfile | undefined {
    if (!downstream || !profileId) return undefined;
    return downstream.profiles?.find((p) => p.id === profileId);
}

/**
 * 把实例设置与选定配置合并成实际生效的设置。
 *
 * 配置只覆盖它显式给出的键：没写的键继续用实例设置，
 * 这样「实例设置」可以保存跨配置共用的部分（如 dsh 可执行文件路径），
 * 而每个配置只描述差异（如人设、对话约束）。
 */
export function mergeSettings(
    base: Record<string, unknown>,
    override: Record<string, unknown> | undefined,
): Record<string, unknown> {
    if (!override) return base;
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) {
        // 嵌套对象（如 prompt）逐键合并，避免配置只写一个开关就把其余抹掉
        if (
            value
            && typeof value === 'object'
            && !Array.isArray(value)
            && out[key]
            && typeof out[key] === 'object'
            && !Array.isArray(out[key])
        ) {
            out[key] = { ...(out[key] as Record<string, unknown>), ...(value as Record<string, unknown>) };
        } else {
            out[key] = value;
        }
    }
    return out;
}
