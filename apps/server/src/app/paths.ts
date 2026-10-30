import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 源码搬迁不改变已有配置、会话和历史文件的位置。 */
export function createAppPaths(serverRoot = fileURLToPath(new URL('../../', import.meta.url))) {
    return {
        serverRoot: path.resolve(serverRoot),
        config: path.resolve(serverRoot, 'config.json'),
        sessions: path.resolve(serverRoot, 'sessions.json'),
    };
}
export type AppPaths = ReturnType<typeof createAppPaths>;

/** 使用全部后端源码的最新修改时间，拆分模块后仍可识别旧进程。 */
export function codeVersion(): string {
    const root = fileURLToPath(new URL('../', import.meta.url));
    let latest = 0;
    for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
        if (entry.isFile() && /\.(ts|mjs)$/.test(entry.name)) {
            latest = Math.max(latest, fs.statSync(path.join(entry.parentPath, entry.name)).mtimeMs);
        }
    }
    return `v${Math.floor(latest / 1000)}`;
}
