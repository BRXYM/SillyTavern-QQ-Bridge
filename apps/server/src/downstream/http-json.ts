import { randomUUID } from 'node:crypto';
import type { DownstreamAdapter, DownstreamAsk, DownstreamConfig, DownstreamResult, DownstreamStatus } from './types.ts';

export interface HttpConnection {
    url: string;
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    timeoutMs: number;
    response: { format: 'json' | 'text'; path: string };
}
export function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 仅声明式 JSON 映射，不解释模型返回的 JavaScript。 */
export function parseHttpConnection(raw: unknown): HttpConnection {
    if (!object(raw)) throw new Error('connection 必须是对象');
    const allowed = new Set(['url', 'method', 'headers', 'timeoutMs', 'response']);
    for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`未知连接字段：${key}`);
    if (typeof raw.url !== 'string' || raw.url.length > 4096) throw new Error('缺少有效的 HTTP URL');
    let url: URL;
    try { url = new URL(raw.url.replace(/\{\{input\.(text|sessionKey|system|sender|requestId)\}\}/g, 'value')); }
    catch { throw new Error('HTTP URL 无效'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
        throw new Error('仅支持无内嵌认证信息和片段的 HTTP/HTTPS 地址');
    }
    const authority = raw.url.match(/^https?:\/\/([^/?#]+)/i)?.[1] ?? '';
    if (authority.includes('{{')) throw new Error('URL 的协议和主机不能使用变量');
    const method = raw.method ?? 'POST';
    if (method !== 'GET' && method !== 'POST') throw new Error('首版支持 GET / POST 请求');
    if (raw.headers !== undefined && !object(raw.headers)) throw new Error('headers 必须是对象');
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.headers ?? {})) {
        if (!/^[\w!#$%&'*+.^`|~-]+$/.test(key) || typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error('请求头格式无效');
        if (['host', 'content-length', 'connection', 'transfer-encoding'].includes(key.toLowerCase())) throw new Error(`不支持覆盖请求头 ${key}`);
        headers[key] = value;
    }
    const timeoutMs = raw.timeoutMs ?? 30000;
    if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 180000) throw new Error('timeoutMs 必须在 100–180000 之间');
    if (!object(raw.response) || !['json', 'text'].includes(String(raw.response.format))) throw new Error('response.format 必须为 json 或 text');
    const path = raw.response.path ?? '';
    if (typeof path !== 'string' || path.length > 512 || (path && !/^[\w-]+(?:\.[\w-]+)*$/.test(path))) throw new Error('响应路径使用 answer 或 choices.0.message.content 形式');
    if (raw.response.format === 'text' && path) throw new Error('文本响应不支持字段路径');
    const result = { url: raw.url, method, headers, timeoutMs, response: { format: raw.response.format, path } } as HttpConnection;
    // 配置阶段检查变量拼写；凭据直到真实调用才读取。
    renderString(result.url, {}, {}, 'url', true);
    for (const value of Object.values(headers)) renderString(value, {}, {}, 'header', true);
    return result;
}

const INPUT_FIELDS = new Set(['text', 'sessionKey', 'system', 'sender', 'requestId']);
function renderString(template: string, input: Record<string, string>, env: NodeJS.ProcessEnv,
    mode: 'body' | 'url' | 'header', validateOnly = false): string {
    const rendered = template.replace(/\{\{([^{}]+)\}\}/g, (_, name: string) => {
        const [scope, field, ...rest] = name.trim().split('.');
        if (rest.length || !field) throw new Error(`未知模板变量：${name}`);
        let value: string;
        if (scope === 'input' && INPUT_FIELDS.has(field)) value = input[field] ?? '';
        else if (scope === 'env' && mode === 'header' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) {
            if (!validateOnly && env[field] === undefined) throw new Error(`缺少环境凭据：${field}`);
            value = env[field] ?? '';
        } else throw new Error(`未知或不允许的模板变量：${name}`);
        return mode === 'url' ? encodeURIComponent(value) : value;
    });
    // 检查模板本身，不检查用户消息里合法存在的 {{ 文本。
    if (template.replace(/\{\{[^{}]+\}\}/g, '').includes('{{')) throw new Error('模板括号不完整');
    return rendered;
}
function mapBody(value: unknown, input: Record<string, string>, validateOnly = false, depth = 0): unknown {
    if (depth > 32) throw new Error('请求模板嵌套过深');
    if (typeof value === 'string') return renderString(value, input, {}, 'body', validateOnly);
    if (Array.isArray(value)) return value.map((v) => mapBody(v, input, validateOnly, depth + 1));
    if (object(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapBody(v, input, validateOnly, depth + 1)]));
    return value;
}
export function validateRequestBody(value: unknown): void {
    if (JSON.stringify(value)?.length > 65536) throw new Error('请求模板超过 64KB');
    mapBody(value, {}, true);
}
function selectPath(value: unknown, path: string): unknown {
    for (const key of path ? path.split('.') : []) {
        if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new Error(`响应中找不到字段 ${path}`);
        value = (value as Record<string, unknown>)[key];
    }
    return value;
}
async function readLimited(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > 2 * 1024 * 1024) throw new Error('下游响应超过 2MB');
            chunks.push(value);
        }
    } finally { await reader.cancel().catch(() => {}); }
    return Buffer.concat(chunks).toString('utf8');
}

export class HttpJsonAdapter implements DownstreamAdapter {
    readonly id: string;
    readonly kind = 'http-json' as const;
    readonly name: string;
    private readonly config: DownstreamConfig;
    private readonly env: NodeJS.ProcessEnv;
    private readonly pending = new Set<AbortController>();
    private disposed = false;
    private error = '';

    constructor(config: DownstreamConfig, env: NodeJS.ProcessEnv = process.env) {
        this.config = config; this.env = env; this.id = config.id; this.name = config.name;
    }
    async init(): Promise<void> {
        parseHttpConnection(this.connectionSettings(this.config.settings));
        validateRequestBody(this.config.settings.requestBody);
    }
    private connectionSettings(settings: Record<string, unknown>) {
        return Object.fromEntries(['url', 'method', 'headers', 'timeoutMs', 'response'].map((k) => [k, settings[k]]));
    }
    status(): DownstreamStatus {
        return { id: this.id, kind: this.kind, name: this.name, enabled: this.config.enabled,
            available: !this.disposed, reason: this.disposed ? '已关闭' : (this.error || '配置已加载；尚不能据此确认远端服务在线') };
    }
    async dispose(): Promise<void> {
        this.disposed = true;
        for (const pending of this.pending) pending.abort();
        this.pending.clear();
    }
    async ask(req: DownstreamAsk): Promise<DownstreamResult> {
        const started = Date.now();
        const controller = new AbortController();
        let timer: NodeJS.Timeout | undefined;
        try {
            if (this.disposed) throw new Error('HTTP 连接已关闭');
            const settings = req.settings ?? this.config.settings;
            const connection = parseHttpConnection(this.connectionSettings(settings));
            const input = { text: req.text, sessionKey: req.sessionKey, system: req.system || String(settings.systemPrompt ?? ''), sender: req.sender ?? '', requestId: randomUUID() };
            const headers = Object.fromEntries(Object.entries(connection.headers).map(([k, v]) => [k, renderString(v, input, this.env, 'header')]));
            if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
            const body = settings.requestBody ?? { text: '{{input.text}}', sessionId: '{{input.sessionKey}}' };
            validateRequestBody(body);
            this.pending.add(controller);
            timer = setTimeout(() => controller.abort(), connection.timeoutMs);
            const response = await fetch(renderString(connection.url, input, this.env, 'url'), {
                method: connection.method, headers,
                ...(connection.method === 'POST' ? { body: JSON.stringify(mapBody(body, input)) } : {}),
                signal: controller.signal, redirect: 'error',
            });
            if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
            const raw = await readLimited(response);
            const value = connection.response.format === 'json' ? selectPath(JSON.parse(raw), connection.response.path) : raw;
            if (typeof value !== 'string') throw new Error('响应字段不是文本，请调整 response.path');
            if (!value.trim()) throw new Error('下游返回空文本');
            this.error = '';
            return { ok: true, text: value, elapsedMs: Date.now() - started, via: 'http-json' };
        } catch (error) {
            this.error = controller.signal.aborted ? '请求超时或已取消' : (error instanceof Error ? error.message : String(error));
            return { ok: false, text: '', error: this.error, elapsedMs: Date.now() - started, via: 'http-json' };
        } finally {
            if (timer) clearTimeout(timer);
            this.pending.delete(controller);
        }
    }
}
