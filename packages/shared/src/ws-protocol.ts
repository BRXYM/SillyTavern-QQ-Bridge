/**
 * 扩展 <-> 连接器 WebSocket 协议。
 * 所有消息都是 JSON，带 type 判别字段。
 */

/** 连接器 -> 扩展 */
export type ServerToExtension =
    | { type: 'qq_message'; sessionKey: string; sender: string; text: string; messageType: 'private' | 'group'; groupId: number | null; userId: number; defaultCharacter?: string; defaultWorld?: string }
    | { type: 'session_state'; sessions: Record<string, SessionChoice>; defaults: DefaultsChoice; imageReplies?: ImageReplyConfig }
    | { type: 'sync_request' }
    | { type: 'pong' };

/** 扩展 -> 连接器 */
export type ExtensionToServer =
    | { type: 'hello'; ext: string; version: string }
    | { type: 'st_reply'; sessionKey: string; text: string }
    | { type: 'command_reply'; sessionKey: string; text: string }
    | { type: 'catalog'; characters: string[]; worlds: string[] }
    | { type: 'session_selected'; sessionKey: string; character?: string; world?: string }
    | { type: 'ext_log'; text: string }
    | { type: 'ping' };

export interface SessionChoice {
    character?: string;
    world?: string;
    /** 未设置 = 继承全局 */
    replyProcessors?: ProcessorRule[];
    createdAt?: string;
    updatedAt?: string;
}

export interface DefaultsChoice {
    character: string;
    world: string;
}

export interface ImageReplyConfig {
    enabled: boolean;
    instruction: boolean;
    baseUrl: string;
}

/** 回复处理规则 */
export type ProcessorRule =
    | { type: 'replace'; pattern: string; flags?: string; replacement?: string; enabled?: boolean }
    | { type: 'remove'; pattern: string; flags?: string; enabled?: boolean }
    | { type: 'strip'; begin: string; end: string; keep?: boolean; enabled?: boolean };

/** 配对符定义：[名称, 符号] */
export type PairDelimiter = [name: string, token: string];

/** 分段配置 */
export interface SegmentationConfig {
    enabled: boolean;
    maxLen: number;
    minLen: number;
    maxSegments: number;
    hardChars: string;
    softChars: string;
    pairChars: PairDelimiter[];
    splitStrings: string[];
    splitOnPairs: boolean;
    convertActionMarkers: boolean;
    delayMs: [min: number, max: number];
}
