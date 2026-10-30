export interface LifecycleStep {
    name: string;
    start: () => void | Promise<void>;
    stop: () => void | Promise<void>;
}

/** 顺序启动、逆序关闭；启动失败也清理当前步骤和此前已启动的资源。 */
export class Lifecycle {
    private active: LifecycleStep[] = [];
    private state: 'idle' | 'starting' | 'running' | 'stopped' = 'idle';
    private starting?: Promise<void>;
    private stopping?: Promise<void>;
    private readonly steps: LifecycleStep[];

    constructor(steps: LifecycleStep[]) { this.steps = steps; }

    start(): Promise<void> {
        if (this.state === 'running') return Promise.resolve();
        if (this.state === 'stopped') return Promise.reject(new Error('应用已关闭，请创建新实例'));
        if (this.starting) return this.starting;
        this.state = 'starting';
        this.starting = this.begin();
        return this.starting;
    }

    private async begin(): Promise<void> {
        try {
            for (const step of this.steps) {
                this.active.push(step);
                await step.start();
            }
            this.state = 'running';
        } catch (error) {
            try { await this.cleanup(); }
            catch (cleanupError) { throw new AggregateError([error, cleanupError], '启动失败且资源清理失败'); }
            throw error;
        }
    }

    stop(): Promise<void> {
        this.stopping ??= (async () => {
            try { await this.starting; } catch { /* begin 已回收资源 */ }
            await this.cleanup();
        })();
        return this.stopping;
    }

    private async cleanup(): Promise<void> {
        const errors: unknown[] = [];
        while (this.active.length) {
            const step = this.active.pop()!;
            try { await step.stop(); }
            catch (error) { errors.push(new Error(`关闭 ${step.name} 失败`, { cause: error })); }
        }
        this.state = 'stopped';
        if (errors.length) throw new AggregateError(errors, '资源清理失败');
    }
}
