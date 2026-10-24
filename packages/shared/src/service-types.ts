/**
 * 服务编排相关的共享类型（前后端通用）。
 */

export type ServiceName = 'snowluma' | 'sillytavern';

/** 服务运行模式 */
export type ServiceMode =
    | { kind: 'external'; endpoint: string; token?: string }
    | { kind: 'managed'; installDir: string }
    | { kind: 'disabled' };

/** 服务运行态 */
export type ServiceState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export interface ServiceStatus {
    name: ServiceName;
    mode: ServiceMode;
    state: ServiceState;
    /** 托管模式下的进程 PID */
    pid?: number;
    /** 实际监听端口（探测得到） */
    port?: number;
    /** 版本（托管模式从 version.json 读） */
    version?: string;
    /** 最近一次错误 */
    error?: string;
    /** 启动时间 */
    startedAt?: string;
    /** 是否检测到外部已有实例在跑 */
    externalDetected?: boolean;
}

/** 下载/安装任务进度 */
export interface InstallProgress {
    service: ServiceName;
    phase: 'checking' | 'downloading' | 'extracting' | 'installing' | 'done' | 'error';
    /** 0..100 */
    percent: number;
    /** 已下载字节 / 总字节 */
    receivedBytes?: number;
    totalBytes?: number;
    message?: string;
    error?: string;
}

/** SSE 推送事件 */
export type StreamEvent =
    | { type: 'log'; level: 'info' | 'warn' | 'error' | 'debug'; source: string; text: string; at: string }
    | { type: 'service-status'; status: ServiceStatus }
    | { type: 'install-progress'; progress: InstallProgress }
    | { type: 'session-update'; sessionKey: string }
    | { type: 'catalog'; characters: string[]; worlds: string[] };

/** 桥接整体配置 */
export interface BridgeConfig {
    server: {
        port: number;
        host: string;
    };
    extension: {
        wsPort: number;
    };
    onebot: {
        url: string;
        token: string;
    };
    trigger: {
        atOnly: boolean;
        privateReply: boolean;
        allowedUsers: number[];
        allowedGroups: number[];
    };
    limits: {
        maxMessageLength: number;
    };
    defaults: {
        character: string;
        world: string;
    };
    segmentation: unknown; // SegmentationConfig，避免循环依赖
    imageReplies: {
        enabled: boolean;
        instruction: boolean;
        baseUrl: string;
    };
    replyProcessors: unknown[]; // ProcessorRule[]
    stDataDir: string;
}
