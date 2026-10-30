import { randomBytes } from 'node:crypto';
import { loadConfigFile, saveConfigFile } from './store.ts';
import type { BridgeConfig } from './schema.ts';
import { log } from '../core/logger.ts';

/** 配置加载、迁移、环境变量覆盖与保存；仅在创建应用时执行。 */
export function createConfigRuntime(configPath: string, env: NodeJS.ProcessEnv = process.env) {
    const loaded = loadConfigFile(configPath);
    if (!loaded.existed) {
        log('⚠ 未找到 config.json，使用默认配置（code 默认下游 dsh）');
    }
    for (const note of loaded.notes) log(`ℹ 配置迁移：${note}`);

    let cfg: BridgeConfig = loaded.config;

    // 环境变量覆盖（便于多实例 / 端口冲突时切换）
    if (env.API_PORT) cfg.consolePort = Number(env.API_PORT);
    if (env.EXT_PORT) cfg.extPort = Number(env.EXT_PORT);
    if (env.ST_DATA_DIR) cfg.stDataDir = env.ST_DATA_DIR;
    if (env.BRIDGE_REGISTRATION_TOKEN) cfg.registrationToken = env.BRIDGE_REGISTRATION_TOKEN;

    /**
     * 单账号环境变量覆盖。
     *
     * 旧版只支持一条上游，环境变量叫 ONEBOT_URL / ONEBOT_TOKEN。
     * 新版把它们作用到第一个账号上，保持「不写配置文件也能临时改」的能力。
     */
    if (env.ONEBOT_URL || env.ONEBOT_TOKEN) {
        const first = cfg.accounts[0];
        if (first) {
            if (env.ONEBOT_URL) first.upstream.url = env.ONEBOT_URL;
            if (env.ONEBOT_TOKEN) first.upstream.token = env.ONEBOT_TOKEN;
            log(`ℹ 上游已由环境变量覆盖：[${first.id}] ${first.upstream.url}`);
        }
    }

    /**
     * 首次运行自动生成注册 token。
     *
     * 不生成的话自注册通道默认是关闭的，而「默认接入 dsh」要求
     * 插件装好后能自己登记进来。生成一次后落盘，之后保持不变。
     */
    if (!cfg.registrationToken) {
        cfg.registrationToken = randomBytes(24).toString('base64url');
        log('ℹ 已生成注册 token（首次运行）：dsh 插件可用它自动接入');
        try {
            saveConfigFile(configPath, cfg);
        } catch (e) {
            log(`✗ 注册 token 保存失败：${e instanceof Error ? e.message : String(e)}`);
        }
    }

    function updateConfig(mutate: (c: BridgeConfig) => void): void {
        const candidate = structuredClone(cfg);
        mutate(candidate);
        try {
            saveConfigFile(configPath, candidate);
            cfg = candidate;
            log('配置已保存到 config.json');
        } catch (e) {
            log(`✗ 配置保存失败：${e instanceof Error ? e.message : String(e)}`);
            throw e;
        }
    }

    return { config: () => cfg, updateConfig };
}
