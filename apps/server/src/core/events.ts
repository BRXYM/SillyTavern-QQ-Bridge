/**
 * 状态事件中心。
 *
 * 为什么需要它：轮询是「固定节奏地全量拉」，服务在两次轮询之间异常时，
 * 界面最多要晚一个间隔才发现。事件推送把「发生了变化」这件事在源头发出来，
 * 前端收到就立即更新，异常感知从「最多 3 秒」降到「即时」。
 *
 * 低占用的做法：
 *   - 事件只带**变化的类型与最小载荷**，不带整份快照
 *   - 高频变化（如日志）不进事件流，仍由前端按需拉取
 *   - 同类事件在 150ms 窗口内合并，避免抖动时刷屏
 *   - 没有订阅者时不做任何合并/序列化工作
 */

import { EventEmitter } from 'node:events';

/** 事件类型：前端据此决定要不要刷新对应区块 */
export type StatusEventKind =
    | 'upstream'      // 上游连接状态变化（连上/断开/重连）
    | 'downstream'    // 下游可用性变化（插件上线/离线/启停）
    | 'session'       // 会话增删改
    | 'config'        // 全局配置变更
    | 'metrics';      // 计数类（收发、会话数）低频汇总

export interface StatusEvent {
    kind: StatusEventKind;
    at: number;
    /** 事件附带的最小信息，供前端做局部判断 */
    payload?: Record<string, unknown>;
}

/** 同类事件合并窗口 */
const COALESCE_MS = 150;

export class StatusBus extends EventEmitter {
    /** 每个 kind 的待发送事件（合并用） */
    private readonly pending = new Map<StatusEventKind, StatusEvent>();
    private flushTimer: NodeJS.Timeout | null = null;
    /** 订阅者数量；为 0 时跳过所有处理 */
    private subscribers = 0;

    /** 有人订阅时返回订阅 id，供 SSE 使用 */
    attach(): () => void {
        this.subscribers += 1;
        let detached = false;
        return () => {
            if (detached) return;
            detached = true;
            this.subscribers = Math.max(0, this.subscribers - 1);
        };
    }

    get hasSubscribers(): boolean {
        return this.subscribers > 0;
    }

    /**
     * 发一个变化事件。
     * 同类事件在合并窗口内只保留最后一次（附带最新载荷）。
     */
    publish(kind: StatusEventKind, payload?: Record<string, unknown>): void {
        if (this.subscribers === 0) return;

        this.pending.set(kind, { kind, at: Date.now(), payload });
        if (this.flushTimer) return;

        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            const batch = [...this.pending.values()];
            this.pending.clear();
            if (batch.length > 0) this.emit('events', batch);
        }, COALESCE_MS);
        // 定时器不应阻止进程退出
        this.flushTimer.unref?.();
    }

    /** 立即冲刷（测试或退出前用） */
    flushNow(): void {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        const batch = [...this.pending.values()];
        this.pending.clear();
        if (batch.length > 0) this.emit('events', batch);
    }
}

/** 全局单例：上游、下游、会话都往这里发 */
export const statusBus = new StatusBus();
