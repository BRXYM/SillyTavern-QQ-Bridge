/**
 * 极简 HTTP 路由。
 *
 * 不引框架的理由：后端只暴露十来个 JSON 接口，Express/Fastify 的体积与
 * 依赖成本换不来等价收益。这里提供刚好够用的能力：
 *   - 方法 + 路径模式（支持 :param）
 *   - JSON body 解析（带大小上限）
 *   - 统一错误包装（handler 抛异常 → 500 + JSON）
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RequestContext {
    req: IncomingMessage;
    res: ServerResponse;
    /**
     * 路径参数，例如 /api/sessions/:key
     * 用索引签名而不是可选，避免每处都写非空断言；
     * 实际取值一定来自路由匹配成功的分组。
     */
    params: Record<string, string>;
    /** 查询参数 */
    query: URLSearchParams;
    /** 已解析的 JSON body（无 body 时为空对象） */
    body: Record<string, unknown>;
    /** 读 body 的原始函数，少数接口需要文本 */
    rawBody: () => string;
}

export type Handler = (ctx: RequestContext) => Promise<void> | void;

interface Route {
    method: string;
    /** 编译后的正则与参数名 */
    regex: RegExp;
    keys: string[];
    handler: Handler;
}

/** body 大小上限：配置里可能带较长的系统提示，给 2MB 足够 */
const MAX_BODY = 2 * 1024 * 1024;

export class Router {
    private readonly routes: Route[] = [];

    get(path: string, handler: Handler): void {
        this.add('GET', path, handler);
    }

    post(path: string, handler: Handler): void {
        this.add('POST', path, handler);
    }

    delete(path: string, handler: Handler): void {
        this.add('DELETE', path, handler);
    }

    private add(method: string, path: string, handler: Handler): void {
        const keys: string[] = [];
        const pattern = path.replace(/:[A-Za-z0-9_]+/g, (m) => {
            keys.push(m.slice(1));
            return '([^/]+)';
        });
        this.routes.push({
            method,
            regex: new RegExp(`^${pattern}$`),
            keys,
            handler,
        });
    }

    /** 在 server 的 request 回调里调用；返回 true 表示已处理 */
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const pathname = url.pathname;
        const method = (req.method ?? 'GET').toUpperCase();

        for (const route of this.routes) {
            if (route.method !== method) continue;
            const match = route.regex.exec(pathname);
            if (!match) continue;

            const params: Record<string, string> = {};
            route.keys.forEach((key, i) => {
                params[key] = decodeURIComponent(match[i + 1] ?? '');
            });

            const ctx: RequestContext = {
                req,
                res,
                params,
                query: url.searchParams,
                body: {},
                rawBody: () => '',
            };

            try {
                if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
                    const raw = await readBody(req);
                    ctx.rawBody = () => raw;
                    try {
                        ctx.body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
                    } catch {
                        json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
                        return true;
                    }
                }
                await route.handler(ctx);
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                if (!res.headersSent) json(res, 500, { ok: false, error: message });
                else res.end();
            }
            return true;
        }

        return false;
    }
}

/** 统一的 JSON 响应 */
export function json(res: ServerResponse, status: number, data: unknown): void {
    if (res.headersSent) return;
    const payload = JSON.stringify(data);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
        // 控制台是本地工具，允许同机其他端口（Vite）调用
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
    });
    res.end(payload);
}

/** 读请求体，超过上限直接报错（防止内存被打满） */
function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY) {
                reject(new Error('请求体过大'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}
