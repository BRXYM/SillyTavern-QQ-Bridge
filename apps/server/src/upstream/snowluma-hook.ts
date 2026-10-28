/**
 * SnowLuma 进程自动注入管理。
 *
 * 背景：SnowLuma 要把一个 DLL 注入 QQ 进程才能接管收发消息。
 * 默认需要在它的 WebUI 里手动点「注入」，每次 QQ 重启都要点一遍。
 *
 * 好在 SnowLuma 自带开关：`config/runtime.json` 里的 `hookAutoLoad`。
 * 置为 true 后，它会在发现 QQ 进程时自动注入 —— 不需要密码、
 * 不需要调它的 HTTP API，也不用碰它的数据库。
 *
 * 本模块负责：
 *   1. 定位 SnowLuma 的**运行目录**（config 实际生效的那份）
 *   2. 读/写 runtime.json 的 hookAutoLoad
 *   3. 读 webuiPort（用于前端显示"去哪儿看注入状态"）
 *   4. 备份原文件，保证可回滚
 *
 * 重要边界：本模块**不**自己注入进程。注入需要 SnowLuma 的 native addon
 * 与 QQ 版本匹配，只有 SnowLuma 自己能做对；Bridge 只负责把开关打开。
 */

import fs from 'node:fs';
import path from 'node:path';

/** SnowLuma 运行时配置的候选相对路径（发行版 / 源码模式） */
const RUNTIME_CONFIG_CANDIDATES = [
    // 发行版：<SnowLuma>/dist/config/runtime.json
    path.join('dist', 'config', 'runtime.json'),
    // 源码模式：<SnowLuma>/packages/core/config/runtime.json
    path.join('packages', 'core', 'config', 'runtime.json'),
    // 扁平模式：<SnowLuma>/config/runtime.json
    path.join('config', 'runtime.json'),
];

export interface SnowLumaRuntimeInfo {
    /** 实际生效的 runtime.json 路径 */
    runtimePath: string;
    /** 同目录下 webui.json 是否存在（用于判断这确实是 SnowLuma 目录） */
    hasWebuiConfig: boolean;
    /** WebUI 端口 */
    webuiPort: number;
    /** 是否已开启自动注入 */
    hookAutoLoad: boolean;
    /** 整个 runtime.json 内容（脱敏后给前端参考，不含密码） */
    runtime: Record<string, unknown>;
}

/**
 * 在给定目录下定位实际生效的 runtime.json。
 *
 * 优先选「目录里有 webui.json」的那份：SnowLuma 的密码就存在同目录，
 * 有它才说明这是真正在用的配置，而不是残留的旧拷贝。
 */
export function resolveRuntimeConfig(dir: string): string | null {
    const root = String(dir ?? '').trim();
    if (!root) return null;

    const found: Array<{ file: string; hasWebui: boolean }> = [];
    for (const rel of RUNTIME_CONFIG_CANDIDATES) {
        const file = path.join(root, rel);
        try {
            if (!fs.statSync(file).isFile()) continue;
        } catch {
            continue;
        }
        const hasWebui = fs.existsSync(path.join(path.dirname(file), 'webui.json'));
        found.push({ file, hasWebui });
    }

    if (found.length === 0) return null;
    // 有 webui.json 的优先；同为真或同为假时取列表靠前的（发行版优先）
    const withWebui = found.find((f) => f.hasWebui);
    return (withWebui ?? found[0])!.file;
}

/** 读取 SnowLuma 的运行配置 */
export function readSnowLumaRuntime(dir: string): SnowLumaRuntimeInfo | null {
    const runtimePath = resolveRuntimeConfig(dir);
    if (!runtimePath) return null;

    let raw: Record<string, unknown> = {};
    try {
        raw = JSON.parse(fs.readFileSync(runtimePath, 'utf8')) as Record<string, unknown>;
    } catch {
        return null;
    }

    return {
        runtimePath,
        hasWebuiConfig: fs.existsSync(path.join(path.dirname(runtimePath), 'webui.json')),
        webuiPort: Number(raw.webuiPort ?? 5099) || 5099,
        hookAutoLoad: raw.hookAutoLoad === true,
        runtime: raw,
    };
}

/**
 * 设置 hookAutoLoad，返回写入前后的状态。
 *
 * 写入前先备份成 `runtime.json.bak-snowluma-bridge`，
 * 方便用户不满意时一键还原。
 */
export function setHookAutoLoad(
    dir: string,
    enabled: boolean,
): {
    ok: boolean;
    error?: string;
    runtimePath?: string;
    before?: boolean;
    after?: boolean;
    backup?: string;
} {
    const runtimePath = resolveRuntimeConfig(dir);
    if (!runtimePath) {
        return { ok: false, error: '未找到 SnowLuma 的 runtime.json，请检查目录是否正确' };
    }

    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(fs.readFileSync(runtimePath, 'utf8')) as Record<string, unknown>;
    } catch (e) {
        return {
            ok: false,
            error: `runtime.json 解析失败：${e instanceof Error ? e.message : String(e)}`,
        };
    }

    const before = parsed.hookAutoLoad === true;
    if (before === enabled) {
        return { ok: true, runtimePath, before, after: before };
    }

    // 备份一次（覆盖旧备份，保持只有一个"原始版本"）
    const backup = `${runtimePath}.bak-snowluma-bridge`;
    try {
        fs.copyFileSync(runtimePath, backup);
    } catch (e) {
        return {
            ok: false,
            error: `备份失败（可能是权限不足）：${e instanceof Error ? e.message : String(e)}`,
        };
    }

    parsed.hookAutoLoad = enabled;
    try {
        // 原子写：先写临时文件再改名，避免写一半留下坏配置
        const tmp = `${runtimePath}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
        fs.renameSync(tmp, runtimePath);
    } catch (e) {
        return {
            ok: false,
            error: `写入失败（可能是权限不足）：${e instanceof Error ? e.message : String(e)}`,
            backup,
        };
    }

    return { ok: true, runtimePath, before, after: enabled, backup };
}

/** 从备份还原 */
export function restoreRuntimeConfig(dir: string): { ok: boolean; error?: string; runtimePath?: string } {
    const runtimePath = resolveRuntimeConfig(dir);
    if (!runtimePath) return { ok: false, error: '未找到 runtime.json' };

    const backup = `${runtimePath}.bak-snowluma-bridge`;
    if (!fs.existsSync(backup)) return { ok: false, error: '没有可用的备份' };

    try {
        fs.copyFileSync(backup, runtimePath);
        return { ok: true, runtimePath };
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}

/**
 * 判断自动注入是否已生效（需要重启 SnowLuma）。
 *
 * runtime.json 是启动时读的，所以改完必须重启才生效 ——
 * 这一点要在界面上说清楚，否则用户会以为没成功。
 */
export function autoLoadNeedsRestart(dir: string, desired: boolean): boolean {
    const info = readSnowLumaRuntime(dir);
    if (!info) return false;
    return info.hookAutoLoad !== desired;
}
