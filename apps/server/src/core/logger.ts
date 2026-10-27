/**
 * 日志：控制台输出 + 环形缓冲（供前端 /api/status 拉取）。
 *
 * 用 EventEmitter 而不是直接推给 WS，原因：
 *   日志会被多个消费者读取（内存缓冲、未来 SSE、调试导出），
 *   发布订阅比在每个写日志的地方手动 fan-out 更不容易漏。
 */
import { EventEmitter } from 'node:events';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
    at: number;
    /** 已格式化好的整行，前端直接展示 */
    line: string;
    level: LogLevel;
}

const MAX_ENTRIES = 500;

export class Logger extends EventEmitter {
    private readonly buffer: LogEntry[] = [];

    /** 写一行日志；多参数用空格拼接，与 console.log 行为一致 */
    write(...args: unknown[]): void {
        const text = args
            .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
            .join(' ');
        const level = detectLevel(text);
        const line = `[${new Date().toLocaleTimeString()}] ${text}`;

        // eslint-disable-next-line no-console
        console.log(line);

        const entry: LogEntry = { at: Date.now(), line, level };
        this.buffer.push(entry);
        if (this.buffer.length > MAX_ENTRIES) this.buffer.shift();
        this.emit('entry', entry);
    }

    info(...args: unknown[]): void {
        this.write(...args);
    }

    warn(...args: unknown[]): void {
        this.write('⚠', ...args);
    }

    error(...args: unknown[]): void {
        this.write('✗', ...args);
    }

    /** 最近的日志（按时间正序） */
    recent(limit = MAX_ENTRIES): LogEntry[] {
        return this.buffer.slice(-limit);
    }

    /** 只要行文本，兼容旧前端 */
    lines(limit = MAX_ENTRIES): string[] {
        return this.recent(limit).map((e) => e.line);
    }
}

function detectLevel(text: string): LogLevel {
    if (text.startsWith('✗') || /失败|错误|error/i.test(text.slice(0, 40))) return 'error';
    if (text.startsWith('⚠') || /警告|warn/i.test(text.slice(0, 40))) return 'warn';
    return 'info';
}

function safeStringify(v: unknown): string {
    if (v instanceof Error) return v.stack ?? v.message;
    try {
        return JSON.stringify(v);
    } catch {
        return String(v);
    }
}

/** 全局单例；模块间共享同一个 ring buffer */
export const logger = new Logger();

/** 便捷入口，保持旧代码 `log(...)` 的书写习惯 */
export const log = (...args: unknown[]): void => logger.write(...args);
