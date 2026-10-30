import type { DownstreamAdapter } from './types.ts';
import type { ResolvedDownstream } from './manager.ts';

/** 下游运行时集合 + 配置写回能力 */
export interface DownstreamRuntime {
    list: () => DownstreamAdapter[];
    get: (id: string) => DownstreamAdapter | undefined;
    /** 解析「实例 + 命名配置」，返回合并后的设置 */
    resolve: (downstreamId: string, profileId: string) => ResolvedDownstream | undefined;
    /** 重新按配置构建（启停实例） */
    reload: () => Promise<{ ok: boolean; error?: string }>;
    /** 只更新一个实例，保留其它下游的连接与进行中的请求。 */
    reloadOne?: (id: string) => Promise<{ ok: boolean; error?: string }>;
    /** 记录一次自注册（返回写入后的配置项） */
    register: (entry: {
        id: string;
        kind: string;
        name: string;
        settings?: Record<string, unknown>;
    }) => Promise<{ ok: boolean; error?: string; id?: string }>;
}
