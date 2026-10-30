import path from 'node:path';
import type { BridgeConfig } from '../../config/schema.ts';
import { FaceService } from './faces-service.mjs';
import { log } from '../../core/logger.ts';

export function createFaceRuntime(
    config: () => BridgeConfig,
    serverRoot: string,
    activeUpstream: () => { call: (action: string, params: Record<string, unknown>) => Promise<unknown> } | undefined,
    env: NodeJS.ProcessEnv = process.env,
) {
    const FACES_DATA_DIR = env.BRIDGE_FACES_DIR
        ? path.resolve(env.BRIDGE_FACES_DIR)
        : config().faces.dataDir
            ? path.resolve(config().faces.dataDir)
            : path.resolve(serverRoot, 'data', 'faces');

    let faces: FaceService | null = null;
    /** 最近发过的表情短 ID，用于避免连续重复 */
    const recentFaces: string[] = [];
    const RECENT_FACES_MAX = 6;

    function faceManifest(): { vocab: Record<string, string[]>; recent: string[] } {
        try {
            const m = faces?.store.manifest();
            return {
                vocab: (m?.vocab as Record<string, string[]>) ?? {},
                recent: [...recentFaces],
            };
        } catch {
            return { vocab: {}, recent: [] };
        }
    }

    function faceSummary(): string {
        try {
            if (!faces) return '未初始化';
            const s = faces.stats();
            const m = faces.store.manifest();
            return `${s.total} 个 / 已标注 ${s.labeled} / 可用词 ${m.totalWords}`;
        } catch {
            return '读取失败';
        }
    }

    /** 表情图片的对外地址：优先 QQ CDN 直链，本地缓存 QQ 访问不到 */
    function absoluteFaceUrl(item: { url?: string; imageUrl?: string } | string): string | null {
        if (typeof item === 'string') {
            return /^https?:/i.test(item) ? item : null;
        }
        if (item.url) return item.url;
        const rel = item.imageUrl ?? '';
        return /^https?:/i.test(rel) ? rel : null;
    }

    /** 把 token 解析成可发送的图片 URL */
    function resolveFaceToken(token: string, tags: string[]): string | null {
        if (!faces) return null;
        try {
            if (token.startsWith('#')) {
                const hit = faces.store.pickById(token);
                if (!hit) {
                    log(`  │  表情 ✗ [表情:${token}] 短 ID 不存在`);
                    return null;
                }
                rememberFace(hit.md5.slice(0, 6));
                return absoluteFaceUrl(hit);
            }

            const r = faces.store.pickByTagsDetailed(tags, { exclude: recentFaces });
            if (!r.face) {
                log(`  │  表情 ✗ ${r.reason || '无匹配'} [${tags.join(',')}]`);
                return null;
            }
            rememberFace(r.face.md5.slice(0, 6));
            log(`  │  表情 ✓ [表情:${token}] → ${r.face.md5.slice(0, 6)} 分=${r.score}`);
            return absoluteFaceUrl(r.face);
        } catch (e) {
            log(`  │  表情 ✗ 异常: ${e instanceof Error ? e.message : String(e)}`);
            return null;
        }
    }

    function rememberFace(id: string): void {
        const i = recentFaces.indexOf(id);
        if (i >= 0) recentFaces.splice(i, 1);
        recentFaces.push(id);
        while (recentFaces.length > RECENT_FACES_MAX) recentFaces.shift();
    }

    function start(): void {
        // 表情库
        try {
            faces = new FaceService({
                dataDir: FACES_DATA_DIR,
                // 表情下载走第一个在线账号；没有账号时给个明确失败
                callOnebot: async (action: string, params: Record<string, unknown>) => {
                    const client = activeUpstream();
                    if (!client) throw new Error('没有在线的上游账号，无法下载表情');
                    return client.call(action, params);
                },
                log,
                onChanged: (reason: string) => log(`表情库已更新（${reason}）`),
                ollama: {
                    baseUrl: config().faces.ollamaBaseUrl,
                    visionModel: config().faces.ollamaVisionModel,
                    textModel: config().faces.ollamaTextModel,
                    timeoutMs: 120000,
                },
            });
        } catch (e) {
            log(`⚠ 表情库初始化失败：${e instanceof Error ? e.message : String(e)}`);
            faces = null;
        }

    }
    return {
        dataDir: FACES_DATA_DIR,
        service: () => faces,
        manifest: faceManifest,
        summary: faceSummary,
        resolve: resolveFaceToken,
        start,
        stop: () => { faces?.stopLabeling(); },
    };
}
