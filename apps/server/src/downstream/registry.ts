/**
 * 下游适配器注册表。
 *
 * 新增一种下游 = 实现 DownstreamAdapter + 在 FACTORIES 里注册一行。
 * 这样「以后自由增加配置」不需要动 dispatch / sending / api 任何代码。
 */

import { log } from '../core/logger.ts';
import { DshAdapter, type DshDeps, type DshSettings } from './dsh.ts';
import { SillyTavernAdapter, type SillyTavernDeps } from './sillytavern.ts';
import type { DownstreamAdapter, DownstreamConfig, DownstreamKind, DownstreamStatus } from './types.ts';
import type { DshClient } from '../../dsh-service.mjs';

export interface AdapterDeps {
    dsh: DshDeps;
    sillytavern: SillyTavernDeps;
    /** headless 客户端工厂，注入以便测试替换 */
    makeHeadless: (settings: DshSettings) => DshClient;
}

type Factory = (config: DownstreamConfig, deps: AdapterDeps) => DownstreamAdapter;

const FACTORIES: Record<DownstreamKind, Factory> = {
    'dsh-plugin': (cfg, deps) =>
        new DshAdapter(cfg.id, cfg.name, cfg, deps.dsh, deps.makeHeadless),
    'dsh-headless': (cfg, deps) =>
        // 兼容显式声明为纯 headless 的实例：插件链路关掉即可
        new DshAdapter(
            cfg.id,
            cfg.name,
            { ...cfg, settings: { ...cfg.settings, fallbackHeadless: true } },
            deps.dsh,
            deps.makeHeadless,
        ),
    sillytavern: (cfg, deps) =>
        new SillyTavernAdapter(cfg.id, cfg.name, cfg, deps.sillytavern),
};

/** 已知的下游类型，供前端下拉 */
export const KNOWN_KINDS: Array<{ kind: DownstreamKind; label: string; description: string }> = [
    {
        kind: 'dsh-plugin',
        label: 'dsh（DeepSeek Harness）',
        description: '优先走连接插件，插件离线时回落到 headless 子进程',
    },
    {
        kind: 'dsh-headless',
        label: 'dsh（仅 headless）',
        description: '每条消息起一次性子进程，隔离最彻底但首字较慢',
    },
    {
        kind: 'sillytavern',
        label: '酒馆（SillyTavern）',
        description: '由酒馆扩展连回来，走角色卡与世界书',
    },
];

/**
 * 按配置构建全部下游实例。
 * 单个实例创建失败只记日志并跳过，不影响其他下游启动。
 */
export async function buildAdapters(
    configs: DownstreamConfig[],
    deps: AdapterDeps,
): Promise<Map<string, DownstreamAdapter>> {
    const out = new Map<string, DownstreamAdapter>();

    for (const config of configs) {
        if (!config.enabled) continue;

        const factory = FACTORIES[config.kind];
        if (!factory) {
            log(`⚠ 未知的下游类型 ${config.kind}（id=${config.id}），已跳过`);
            continue;
        }
        if (out.has(config.id)) {
            log(`⚠ 下游 id 重复：${config.id}，后者被忽略`);
            continue;
        }

        try {
            const adapter = factory(config, deps);
            await adapter.init();
            out.set(config.id, adapter);
        } catch (e) {
            log(`⚠ 下游 ${config.id} 初始化失败：${e instanceof Error ? e.message : String(e)}`);
        }
    }

    return out;
}

/** 汇总所有下游状态 */
export function collectStatus(
    adapters: Map<string, DownstreamAdapter>,
    configs: DownstreamConfig[],
): DownstreamStatus[] {
    const out: DownstreamStatus[] = [];
    for (const config of configs) {
        const adapter = adapters.get(config.id);
        if (adapter) {
            out.push({ ...adapter.status(), enabled: config.enabled });
        } else {
            out.push({
                id: config.id,
                kind: config.kind,
                name: config.name,
                enabled: config.enabled,
                available: false,
                reason: config.enabled ? '初始化失败或未启动' : '已在配置中禁用',
            });
        }
    }
    return out;
}

/** 按 id 找适配器，找不到抛出明确错误 */
export function requireAdapter(
    adapters: Map<string, DownstreamAdapter>,
    id: string,
): DownstreamAdapter {
    const adapter = adapters.get(id);
    if (!adapter) throw new Error(`下游 ${id} 不存在或未启用`);
    return adapter;
}
