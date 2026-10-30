import fs from 'node:fs';
import path from 'node:path';
import { emptyState, parseState, type ConversationState } from './conversation-engine.ts';

export interface StateSnapshot { state: ConversationState; revision: number }
/** 与账号/群/成员组成的完整 sessionKey 一起保存，不按下游或配置共享。 */
export class ConversationStateStore {
    private readonly values = new Map<string, StateSnapshot>();
    private readonly queues = new Map<string, Promise<void>>();
    private readonly depths = new Map<string, number>();
    private closed = false;
    private readonly file?: string;
    constructor(file?: string) {
        this.file = file;
        if (!file || !fs.existsSync(file)) return;
        try {
            if (fs.statSync(file).size > 16 * 1024 * 1024) throw new Error('文件过大');
            const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (saved.version !== 1 || !saved.sessions || typeof saved.sessions !== 'object' || Array.isArray(saved.sessions)) throw new Error('结构无效');
            for (const [key, raw] of Object.entries(saved.sessions)) {
                const value = raw as StateSnapshot;
                if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error('修订号无效');
                this.values.set(key, { state: parseState(value.state), revision: value.revision });
            }
        } catch (e) { throw new Error(`会话变量文件无法读取，请检查或从备份恢复 ${file}：${String(e)}`); }
    }
    read(key: string): StateSnapshot { return structuredClone(this.values.get(key) ?? { state: emptyState(), revision: 0 }); }
    commit(key: string, state: ConversationState, revision: number): StateSnapshot {
        if (this.closed) throw new Error('会话变量存储已关闭');
        if (this.read(key).revision !== revision) throw new Error('会话变量已被新消息更新，请刷新后再保存');
        const next = { state: parseState(state), revision: revision + 1 };
        const candidate = new Map(this.values); candidate.set(key, next);
        if (this.file) {
            const payload = JSON.stringify({ version: 1, sessions: Object.fromEntries(candidate) });
            if (Buffer.byteLength(payload) > 16 * 1024 * 1024) throw new Error('会话变量存储超过 16 MiB，请清理不再使用的数据');
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.writeFileSync(`${this.file}.tmp`, payload, 'utf8');
            fs.renameSync(`${this.file}.tmp`, this.file);
        }
        this.values.set(key, next);
        return structuredClone(next);
    }
    async serial<T>(key: string, work: () => Promise<T> | T): Promise<T> {
        if (this.closed) throw new Error('会话变量存储已关闭');
        const depth = this.depths.get(key) ?? 0;
        if (depth >= 64) throw new Error('该会话待处理消息过多');
        this.depths.set(key, depth + 1);
        const task = (this.queues.get(key) ?? Promise.resolve()).then(() => {
            if (this.closed) throw new Error('会话变量存储已关闭');
            return work();
        });
        const tail = task.then(() => {}, () => {});
        this.queues.set(key, tail);
        void tail.then(() => {
            this.depths.set(key, (this.depths.get(key) ?? 1) - 1);
            if (this.queues.get(key) === tail) { this.queues.delete(key); this.depths.delete(key); }
        });
        return task;
    }
    async close() { this.closed = true; await Promise.all(this.queues.values()); }
}
