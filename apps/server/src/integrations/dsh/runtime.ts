import path from 'node:path';
import os from 'node:os';
import type { BridgeConfig } from '../../config/schema.ts';
import type { DshSettings } from '../../downstream/dsh.ts';
import { DshClient } from './dsh-service.mjs';
import { DshService } from './dsh-profile-service.mjs';
import { log } from '../../core/logger.ts';

export function createDshRuntime(config: () => BridgeConfig, serverRoot: string) {
    /** 从下游配置里读 dsh 实例的 settings（取第一个 dsh 实例作为服务基准） */
    function dshSettings(): DshSettings & {
        serviceProfile: string;
        servicePort: number;
        serviceLogFile: string;
        /** 目标下游实例 id：插件注册与消息路由都用它 */
        downstreamId: string;
    } {
        const ds = config().downstreams.find((d) => d.kind === 'dsh-plugin' || d.kind === 'dsh-headless');
        const s = (ds?.settings ?? {}) as Record<string, unknown>;
        return {
            downstreamId: ds?.id ?? 'dsh',
            fallbackHeadless: s.fallbackHeadless !== false,
            exePath: String(s.exePath ?? ''),
            profile: String(s.profile ?? 'headless'),
            workRoot: String(s.workRoot ?? ''),
            timeoutMs: Number(s.timeoutMs ?? 180000),
            historyTurns: Number(s.historyTurns ?? 6),
            persistHistory: s.persistHistory !== false,
            concurrency: Number(s.concurrency ?? 1),
            errorReply: String(s.errorReply ?? ''),
            // 提示词开关：默认全关，前端按实例配置
            prompt: normalizePrompt(s.prompt),
            // 历史提取规则：默认空（不发送任何历史文本）
            historyExtracts: normalizeExtracts(s.historyExtracts),
            serviceProfile: String(s.serviceProfile ?? 'web'),
            servicePort: Number(s.servicePort ?? 3080),
            serviceLogFile: String(s.serviceLogFile ?? ''),
        };
    }

    /** 历史提取规则：只保留 pattern 非空、flags 合法的项 */
    function normalizeExtracts(raw: unknown): Array<{ pattern: string; flags?: string; label?: string }> {
        if (!Array.isArray(raw)) return [];
        const out: Array<{ pattern: string; flags?: string; label?: string }> = [];
        for (const item of raw) {
            if (!item || typeof item !== 'object') continue;
            const r = item as Record<string, unknown>;
            const pattern = String(r.pattern ?? '').trim();
            if (!pattern) continue;
            out.push({
                pattern,
                ...(typeof r.flags === 'string' && r.flags ? { flags: r.flags } : {}),
                ...(typeof r.label === 'string' && r.label ? { label: r.label } : {}),
            });
        }
        return out;
    }

    /** 把配置里的 prompt 字段收敛成固定形状，缺省一律关闭 */
    function normalizePrompt(raw: unknown): DshSettings['prompt'] {
        const p = (raw ?? {}) as Record<string, unknown>;
        return {
            qqBase: p.qqBase === true,
            character: p.character === true,
            faces: p.faces === true,
            images: p.images === true,
            extra: typeof p.extra === 'string' ? p.extra : '',
        };
    }

    const dshService = new DshService({
        exePath: dshSettings().exePath,
        profile: dshSettings().serviceProfile,
        host: '127.0.0.1',
        port: dshSettings().servicePort,
        logFile: dshSettings().serviceLogFile || path.join(os.tmpdir(), 'snowluma-dsh-service.log'),
        log,
    });

    /**
     * headless 客户端工厂（下游适配器按需创建）。
     *
     * 历史文件按 profile 分开：两个配置指向不同 dsh profile 时，
     * 共用一个 history.json 会让它们互相看到对方的对话。
     */
    function makeHeadless(settings: DshSettings): DshClient {
        const suffix = settings.profile && settings.profile !== 'headless'
            ? `-${settings.profile.replace(/[^\w-]/g, '_')}`
            : '';
        return new DshClient({
            exePath: settings.exePath,
            profile: settings.profile,
            workRoot: settings.workRoot,
            timeoutMs: settings.timeoutMs,
            historyTurns: settings.historyTurns,
            historyFile: settings.persistHistory
                ? path.join(serverRoot, `dsh-history${suffix}.json`)
                : '',
            concurrency: settings.concurrency,
            log,
        });
    }

    return { service: dshService, settings: dshSettings, makeHeadless };
}
