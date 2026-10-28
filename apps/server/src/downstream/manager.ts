/**
 * 下游运行时：把配置里的下游实例变成活的对象。
 *
 * 独立成模块的原因：适配器的构建 / 重建 / 自注册都要动配置，
 * 但 dispatch 层不该知道这些。这里是对外唯一的下游入口。
 *
 * 除了「实例」，它还负责「命名配置」的解析：会话最终要用哪一份 settings，
 * 是实例设置与选中配置合并的结果。合并规则在 schema.mergeSettings 里。
 */

import { mergeSettings, type BridgeConfig } from '../config/schema.ts';
import type { DownstreamConfig, DownstreamProfile } from './types.ts';
import type { DownstreamAdapter } from './types.ts';
import { buildAdapters, collectStatus, type AdapterDeps } from './registry.ts';
import type { DownstreamRuntime } from '../api/context.ts';
import { log } from '../core/logger.ts';
import { publishStatus } from '../api/events.ts';

export interface RuntimeOptions {
    /** 读当前配置 */
    config: () => BridgeConfig;
    /** 修改并落盘配置 */
    updateConfig: (mutate: (cfg: BridgeConfig) => void) => void;
    deps: AdapterDeps;
}

/** 某次调用实际生效的下游组合 */
export interface ResolvedDownstream {
    /** 实例（一定存在） */
    config: DownstreamConfig;
    /** 适配器；实例未启用或初始化失败时为 undefined */
    adapter: DownstreamAdapter | undefined;
    /** 会话选中的命名配置（未选中时为 undefined） */
    profile: DownstreamProfile | undefined;
    /** 合并后的设置 */
    settings: Record<string, unknown>;
}

export class DownstreamManager implements DownstreamRuntime {
    private adapters = new Map<string, DownstreamAdapter>();
    private readonly options: RuntimeOptions;

    constructor(options: RuntimeOptions) {
        this.options = options;
    }

    /** 首次启动：按配置构建全部实例 */
    async start(): Promise<void> {
        const cfg = this.options.config();
        this.adapters = await buildAdapters(cfg.downstreams, this.options.deps);

        // 每个适配器可用性变化时，立即广播给前端（插件上下线不必等轮询）
        for (const adapter of this.adapters.values()) {
            adapter.onChange?.(() => {
                publishStatus('downstream', {
                    id: adapter.id,
                    available: adapter.status().available,
                });
            });
        }

        log(`下游已启动：${[...this.adapters.keys()].join(', ') || '(无)'}`);
    }

    list(): DownstreamAdapter[] {
        return [...this.adapters.values()];
    }

    get(id: string): DownstreamAdapter | undefined {
        return this.adapters.get(id);
    }

    /**
     * 解析「实例 + 配置」并算出实际生效的设置。
     *
     * `profileId` 是会话层已经算好的最终结果（含全局默认与归属判断），
     * 这里不再二次套用默认值 —— 否则「会话显式选了空配置」会被默认值覆盖。
     * 配置找不到时退回实例设置，并记日志，避免静默用错配置。
     */
    resolve(
        downstreamId: string,
        profileId: string,
    ): ResolvedDownstream | undefined {
        const cfg = this.options.config();
        const downstream = cfg.downstreams.find((d) => d.id === downstreamId);
        if (!downstream) return undefined;

        const profile = profileId
            ? downstream.profiles.find((p) => p.id === profileId)
            : undefined;
        if (profileId && !profile) {
            log(`⚠ 下游 ${downstreamId} 下找不到配置 ${profileId}，已退回实例设置`);
        }

        return {
            config: downstream,
            adapter: this.adapters.get(downstreamId),
            profile,
            settings: mergeSettings(downstream.settings, profile?.settings),
        };
    }

    /**
     * 配置变更后重建全部适配器。
     * 先全部 dispose 再重新构建——比逐个 diff 简单且不易残留状态。
     */
    async reload(): Promise<{ ok: boolean; error?: string }> {
        try {
            const old = this.adapters;
            this.adapters = new Map();
            for (const adapter of old.values()) {
                try {
                    await adapter.dispose();
                } catch (e) {
                    log(`下游 ${adapter.id} 关闭失败：${e instanceof Error ? e.message : String(e)}`);
                }
            }
            await this.start();
            publishStatus('downstream', { reloaded: true });
            return { ok: true };
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            log(`下游重建失败：${error}`);
            return { ok: false, error };
        }
    }

    /**
     * 自注册：把外部（dsh 插件）上报的实例写进配置并启用。
     *
     * 幂等：同 id 已存在时只更新 name/settings，不重复追加。
     * 不覆盖用户手工设置的 settings（避免插件把人工配置冲掉）。
     *
     * 关键：注册后必须**真正构建适配器**，否则配置里有了但运行时没有实例，
     * 消息会走不到它（表现为「注册成功但收不到消息」）。
     */
    async register(entry: {
        id: string;
        kind: string;
        name: string;
        settings?: Record<string, unknown>;
    }): Promise<{ ok: boolean; error?: string; id?: string }> {
        const cfg = this.options.config();
        const existing = cfg.downstreams.find((d) => d.id === entry.id);

        if (existing) {
            // 已存在：只确保启用，不覆盖 settings
            if (!existing.enabled) {
                this.options.updateConfig((c) => {
                    const d = c.downstreams.find((x) => x.id === entry.id);
                    if (d) d.enabled = true;
                });
                log(`下游自注册：${entry.id} 已存在但被禁用，已重新启用`);
            } else {
                log(`下游自注册：${entry.id} 已存在且已启用，忽略重复注册`);
            }
            // 运行时若缺这个实例（例如上次构建失败），补建一次
            if (!this.adapters.has(entry.id)) {
                const reload = await this.reload();
                if (!reload.ok) return { ok: false, error: reload.error };
            }
            return { ok: true, id: entry.id };
        }

        const created: DownstreamConfig = {
            id: entry.id,
            kind: entry.kind as DownstreamConfig['kind'],
            name: entry.name,
            enabled: true,
            settings: entry.settings ?? {},
            profiles: [],
        };

        this.options.updateConfig((c) => {
            c.downstreams.push(created);
            // 首个下游自动成为默认
            if (!c.defaultDownstreamId) c.defaultDownstreamId = created.id;
        });

        log(`下游自注册：已新增 ${created.id}（${created.kind}），正在加载…`);
        publishStatus('downstream', { id: created.id, registered: true });

        // 立刻构建，让注册后的实例马上可用
        const reload = await this.reload();
        if (!reload.ok) {
            return { ok: false, error: reload.error ?? '适配器加载失败' };
        }
        if (!this.adapters.has(created.id)) {
            return { ok: false, error: `下游 ${created.id} 已在配置中，但适配器未能启动` };
        }

        return { ok: true, id: created.id };
    }

    /** 退出时释放全部资源 */
    async dispose(): Promise<void> {
        for (const adapter of this.adapters.values()) {
            try {
                await adapter.dispose();
            } catch {
                /* 忽略 */
            }
        }
        this.adapters.clear();
    }
}
