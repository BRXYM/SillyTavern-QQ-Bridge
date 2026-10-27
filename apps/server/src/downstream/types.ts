/**
 * 下游适配器（downstream）的公共契约。
 *
 * 设计要点：
 *   - 下游只负责「一句话进去、最终文本出来」，分段 / 管道 / 表情全部由 Bridge 承担。
 *     这样新增一个后端不必重写发送链路。
 *   - 每个下游是一个**实例**，有稳定 id。同一个类型可以配置多个实例
 *     （比如两个酒馆、两个 dsh），会话按实例 id 选择。
 *   - 适配器不持有会话路由与配置，它们由 Bridge 注入。
 */

/** 下游类型标识；新增类型时在这里扩展，并在 registry 里注册工厂 */
export type DownstreamKind = 'dsh-headless' | 'dsh-plugin' | 'sillytavern';

/** 一次问答请求 */
export interface DownstreamAsk {
    /** 会话标识，适配器据此隔离上下文 */
    sessionKey: string;
    /** 已拼好的用户消息正文 */
    text: string;
    /** 需要随消息下发的系统设定（人设 / 表情词表等） */
    system: string;
    /** 群聊里的发送者昵称，便于下游区分说话人 */
    sender?: string;
}

/** 一次问答结果 */
export interface DownstreamResult {
    ok: boolean;
    /** 最终文本；失败时为空串 */
    text: string;
    elapsedMs: number;
    /** 失败原因（ok=false 时给出） */
    error?: string;
    /** 实际处理这条消息的通道，用于日志（同一个下游可能有多种传输） */
    via?: string;
}

/** 下游运行态快照，供控制台展示 */
export interface DownstreamStatus {
    /** 实例 id */
    id: string;
    kind: DownstreamKind;
    /** 人类可读名称 */
    name: string;
    /** 是否在配置中被启用 */
    enabled: boolean;
    /** 当前是否可用（插件已连上 / 可执行文件存在 / 扩展已握手） */
    available: boolean;
    /** 不可用原因 */
    reason?: string;
    /** 补充信息：版本、PID、端点等，键值由各适配器决定 */
    detail?: Record<string, string | number | boolean>;
}

/**
 * 下游适配器接口。
 *
 * 生命周期：`init()` 一次；`dispose()` 在配置变更或退出时。
 * 适配器可以在内部维护连接，但**不得**缓存会话内容——
 * 会话上下文由下游自己或 Bridge 的会话层负责。
 */
export interface DownstreamAdapter {
    readonly id: string;
    readonly kind: DownstreamKind;
    readonly name: string;

    /**
     * 注册「可用性变化」回调。
     * 适配器在连接上线/离线、启停时调用它，让上层即时推送状态，
     * 而不是等前端下一次轮询才发现。
     */
    onChange?(listener: () => void): void;

    /** 建立连接 / 探测可用性；失败不应抛异常，用 available=false 表达 */
    init(): Promise<void>;
    /** 释放资源（关闭 WS、杀掉常驻进程等） */
    dispose(): Promise<void>;
    /** 当前状态 */
    status(): DownstreamStatus;
    /** 处理一条消息 */
    ask(req: DownstreamAsk): Promise<DownstreamResult>;
    /** 清空某会话的上下文（尽力而为，不支持时返回 false） */
    resetSession?(sessionKey: string, opts?: { removeWorkDir?: boolean }): Promise<boolean>;
}

/** 下游实例的配置形状（写入 config.json 的 downstreams 数组） */
export interface DownstreamConfig {
    id: string;
    kind: DownstreamKind;
    name: string;
    enabled: boolean;
    /** 各类型自己的参数，由适配器工厂校验 */
    settings: Record<string, unknown>;
}
