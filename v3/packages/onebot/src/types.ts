import type { EventEmitter } from 'node:events';

/** OneBot v11 消息事件（只声明用到的字段） */
export interface OneBotMessageEvent {
    post_type: 'message';
    message_type: 'private' | 'group';
    sub_type?: string;
    message_id: number;
    user_id: number;
    group_id?: number;
    message: string | Array<{ type: string; data: Record<string, unknown> }>;
    raw_message?: string;
    sender?: { user_id?: number; nickname?: string; card?: string };
    self_id: number;
}

export interface OneBotLifecycleEvent {
    post_type: 'meta_event';
    meta_event_type: 'lifecycle';
    self_id: number;
}

export interface OneBotRequestEvent {
    post_type: 'request';
    request_type: string;
    user_id: number;
    comment?: string;
}

export type OneBotEvent = OneBotMessageEvent | OneBotLifecycleEvent | OneBotRequestEvent | Record<string, unknown>;

export interface OneBotResponse {
    status: 'ok' | 'failed';
    retcode?: number;
    data?: unknown;
    message?: string;
    echo?: string;
}

/** 解析后的消息内容 */
export interface ParsedMessage {
    text: string;
    atMe: boolean;
}

/** 发送目标 */
export type SendTarget =
    | { kind: 'private'; userId: number }
    | { kind: 'group'; groupId: number };

export interface OneBotClientOptions {
    url: string;
    token?: string;
    /** 动作超时（毫秒） */
    actionTimeoutMs?: number;
    /** 重连延迟（毫秒） */
    reconnectDelayMs?: number;
    onEvent?: (event: OneBotEvent) => void;
    onConnect?: () => void;
    onDisconnect?: (reason: string) => void;
    onLog?: (level: 'info' | 'warn' | 'error' | 'debug', text: string) => void;
}

export type { EventEmitter };
