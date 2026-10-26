/**
 * Ollama 全链路管理：服务探测、模型列表、加载/卸载、拉取、删除、调用测试。
 *
 * 设计边界（按需求）：
 *   - 不负责安装 Ollama，只假定它已存在于本机
 *   - 支持从配置里指定可执行文件路径，便于在服务未启动时拉起
 *   - 所有操作走 HTTP API；仅"启动服务"需要走进程
 *   - 模型名由前端填写，不做白名单限制
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const DEFAULT_BASE = 'http://127.0.0.1:11434';

/**
 * 读取 Windows 用户级持久环境变量（HKCU\Environment）。
 *
 * 为什么需要：OLLAMA_MODELS 常被写进用户级变量，
 * 但已经打开的终端不会继承，于是 Bridge 启动的 ollama 会回落到
 * %USERPROFILE%\.ollama\models，看不到 D 盘上的模型。
 * 这里直接从注册表读，不依赖父进程环境。
 */
function readWindowsUserEnv(name) {
    if (process.platform !== 'win32') return '';
    try {
        const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        // 输出形如：    OLLAMA_MODELS    REG_SZ    D:\WorkSpace\Ollama\models
        const m = out.match(/REG_(?:EXPAND_)?SZ\s+(.+)/);
        return m ? m[1].trim() : '';
    } catch {
        return '';
    }
}

/** 进程环境优先，其次用户级持久变量 */
function resolveEnv(name) {
    const fromProc = String(process.env[name] ?? '').trim();
    if (fromProc) return fromProc;
    return String(readWindowsUserEnv(name) ?? '').trim();
}


/**
 * 把底层网络错误翻译成可操作的中文提示。
 * fetch 失败时 Node 只给 "fetch failed"，对普通用户毫无指导意义。
 */
export function humanizeFetchError(e, baseUrl = '') {
    const msg = String(e?.message ?? e ?? '');
    const cause = String(e?.cause?.code ?? e?.cause?.message ?? '');
    const all = `${msg} ${cause}`;

    if (/ECONNREFUSED|Failed to fetch|fetch failed/i.test(all)) {
        return `${baseUrl || 'Ollama 服务'} 未响应，服务可能未启动`;
    }
    if (/timeout|aborted|ETIMEDOUT/i.test(all)) {
        return '请求超时，模型可能正在加载或显卡资源不足';
    }
    if (/ENOTFOUND|EAI_AGAIN/i.test(all)) {
        return `无法解析地址 ${baseUrl}，请检查服务地址是否正确`;
    }
    if (/ECONNRESET/i.test(all)) {
        return '连接被重置，服务可能刚退出';
    }
    return msg || '未知错误';
}

/** Ollama HTTP 客户端，供各处复用 */
export class OllamaClient {
    constructor({ baseUrl = DEFAULT_BASE, timeoutMs = 30000 } = {}) {
        this.baseUrl = String(baseUrl || DEFAULT_BASE).replace(/\/$/, '');
        this.timeoutMs = timeoutMs;
    }

    url(p) {
        return `${this.baseUrl}${p}`;
    }

    async #json(pathname, init = {}, timeoutMs) {
        let res;
        try {
            res = await fetch(this.url(pathname), {
                ...init,
                signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
            });
        } catch (e) {
            // 网络层失败（服务未启动 / 超时 / DNS）统一转成可读文案
            throw new Error(humanizeFetchError(e, this.baseUrl));
        }
        const text = await res.text();
        let body = null;
        try {
            body = text ? JSON.parse(text) : null;
        } catch {
            body = text;
        }
        if (!res.ok) {
            const msg =
                typeof body === 'object' && body && 'error' in body
                    ? String(body.error)
                    : `${res.status} ${res.statusText}`;
            throw new Error(msg);
        }
        return body;
    }

    /** 服务是否在线 + 版本 */
    async version() {
        try {
            const v = await this.#json('/api/version', {}, 5000);
            return { ok: true, version: String(v?.version ?? '') };
        } catch (e) {
            return { ok: false, error: humanizeFetchError(e, this.baseUrl) };
        }
    }

    /** 本地已下载模型（含能力标签） */
    async list() {
        const data = await this.#json('/api/tags', {}, 15000);
        const models = Array.isArray(data?.models) ? data.models : [];
        return models
            .map((m) => ({
                name: String(m.name ?? m.model ?? ''),
                sizeBytes: Number(m.size ?? 0),
                family: String(m.details?.family ?? ''),
                parameterSize: String(m.details?.parameter_size ?? ''),
                quantization: String(m.details?.quantization_level ?? ''),
                format: String(m.details?.format ?? ''),
                contextLength: Number(m.details?.context_length ?? 0),
                capabilities: Array.isArray(m.capabilities) ? m.capabilities : [],
                modifiedAt: m.modified_at ?? null,
            }))
            .filter((m) => m.name)
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    /** 当前已加载到内存/显存的模型 */
    async running() {
        try {
            const data = await this.#json('/api/ps', {}, 8000);
            const models = Array.isArray(data?.models) ? data.models : [];
            return models.map((m) => ({
                name: String(m.name ?? m.model ?? ''),
                sizeBytes: Number(m.size ?? 0),
                /** 实际占用显存 */
                sizeVramBytes: Number(m.size_vram ?? 0),
                expiresAt: m.expires_at ?? null,
                digest: String(m.digest ?? ''),
            }));
        } catch {
            return [];
        }
    }

    /** 模型详情（/api/show）：参数量、量化、模板、能力等 */
    async show(model) {
        const data = await this.#json(
            '/api/show',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model }),
            },
            15000,
        );
        // context_length 的键名随架构变化（如 qwen25vl.context_length），需遍历查找
        const info = data?.model_info ?? {};
        let ctxLen = 0;
        for (const [k, v] of Object.entries(info)) {
            if (k.endsWith('.context_length') && Number(v) > 0) {
                ctxLen = Number(v);
                break;
            }
        }
        return {
            name: model,
            family: String(data?.details?.family ?? ''),
            parameterSize: String(data?.details?.parameter_size ?? ''),
            quantization: String(data?.details?.quantization_level ?? ''),
            format: String(data?.details?.format ?? ''),
            contextLength: ctxLen,
            capabilities: Array.isArray(data?.capabilities) ? data.capabilities : [],
            license: String(data?.license ?? '').slice(0, 400),
            system: String(data?.system ?? '').slice(0, 400),
        };
    }

    /**
     * 加载模型到内存（预热）。
     * keep_alive：-1 常驻，0 立即卸载，正数为秒。
     */
    async load(model, { keepAlive = '30m' } = {}) {
        // 用空 prompt 触发加载，Ollama 会返回 done 而不产生文本
        await this.#json(
            '/api/generate',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model, prompt: '', keep_alive: keepAlive }),
            },
            180000,
        );
        return { ok: true };
    }

    /** 卸载（keep_alive=0 立即释放） */
    async unload(model) {
        await this.#json(
            '/api/generate',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model, keep_alive: 0 }),
            },
            30000,
        );
        return { ok: true };
    }

    /** 删除本地模型 */
    async remove(model) {
        await this.#json(
            '/api/delete',
            {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model }),
            },
            60000,
        );
        return { ok: true };
    }

    /** 拉取模型，逐行解析 NDJSON 进度 */
    async pull(model, onProgress) {
        const res = await fetch(this.url('/api/pull'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, stream: true }),
            signal: AbortSignal.timeout(3600000),
        });
        if (!res.ok) {
            const t = await res.text().catch(() => '');
            throw new Error(`拉取失败 ${res.status}: ${t.slice(0, 200)}`);
        }

        const reader = res.body?.getReader();
        if (!reader) throw new Error('响应体不可读');

        const decoder = new TextDecoder();
        let buf = '';
        let last = null;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });

            const lines = buf.split('\n');
            buf = lines.pop() ?? '';
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const obj = JSON.parse(line);
                    last = obj;
                    onProgress?.(obj);
                    if (obj.error) throw new Error(String(obj.error));
                } catch (e) {
                    if (e instanceof Error && e.message && !e.message.includes('JSON')) throw e;
                }
            }
        }
        return { ok: true, last };
    }

    /**
     * 文本对话。
     * @param {string} model
     * @param {string} prompt
     * @param {object} opts
     * @param {number} opts.timeoutMs
     * @param {string|number} [opts.keepAlive]  -1 常驻 / 0 用完卸载 / 秒数或 '5m'
     * @param {number} [opts.temperature]
     * @param {number} [opts.numPredict]
     */
    async chat(model, prompt, { timeoutMs = 120000, keepAlive, temperature = 0.2, numPredict = 200 } = {}) {
        const body = {
            model,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
            options: { temperature, num_predict: numPredict },
        };
        if (keepAlive !== undefined) body.keep_alive = keepAlive;

        const data = await this.#json(
            '/api/chat',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            },
            timeoutMs,
        );
        return String(data?.message?.content ?? '');
    }

    /**
     * 视觉对话（图片 base64 数组）。
     * @param {string} model
     * @param {string} prompt
     * @param {string[]} imagesBase64
     * @param {object} opts  同 chat
     */
    async vision(model, prompt, imagesBase64, { timeoutMs = 180000, keepAlive, temperature = 0.2, numPredict = 200 } = {}) {
        const body = {
            model,
            messages: [{ role: 'user', content: prompt, images: imagesBase64 }],
            stream: false,
            options: { temperature, num_predict: numPredict },
        };
        if (keepAlive !== undefined) body.keep_alive = keepAlive;

        const data = await this.#json(
            '/api/chat',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            },
            timeoutMs,
        );
        return String(data?.message?.content ?? '');
    }

    /** 原始 chat：完全由调用方给 messages / options，供前端调试使用 */
    async chatRaw({ model, messages, stream = false, options, keepAlive, timeoutMs }) {
        const body = { model, messages, stream };
        if (options) body.options = options;
        if (keepAlive !== undefined) body.keep_alive = keepAlive;
        const data = await this.#json(
            '/api/chat',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            },
            timeoutMs ?? this.timeoutMs,
        );
        return {
            content: String(data?.message?.content ?? ''),
            model: String(data?.model ?? model),
            totalDurationMs: Math.round(Number(data?.total_duration ?? 0) / 1e6),
            evalCount: Number(data?.eval_count ?? 0),
            promptEvalCount: Number(data?.prompt_eval_count ?? 0),
        };
    }
}

/**
 * 服务进程管理：本机 Ollama serve 的启动/停止。
 *
 * 只管理"已安装"的 Ollama：需要配置里提供可执行文件路径。
 * 不负责下载或安装。
 */
export class OllamaDaemon {
    constructor({ exePath = '', baseUrl = DEFAULT_BASE, modelsDir = '', log = () => {} } = {}) {
        this.exePath = exePath;
        this.baseUrl = baseUrl;
        this.modelsDir = modelsDir;
        this.log = log;
        this.child = null;
        this.startedByUs = false;
        this.lastError = '';
    }

    /** 可执行文件是否存在 */
    exeExists() {
        if (!this.exePath) return false;
        try {
            return fs.statSync(this.exePath).isFile();
        } catch {
            return false;
        }
    }

    /** 自动猜测可执行文件位置（仅本机已安装的情况） */
    static guessExePath() {
        const candidates = [
            'D:\\WorkSpace\\Ollama\\bin\\ollama.exe',
            path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Ollama', 'ollama.exe'),
            path.join(process.env.ProgramFiles ?? '', 'Ollama', 'ollama.exe'),
            '/usr/local/bin/ollama',
            '/usr/bin/ollama',
        ];
        for (const p of candidates) {
            if (!p) continue;
            try {
                if (fs.statSync(p).isFile()) return p;
            } catch {
                /* 继续找 */
            }
        }
        return '';
    }

    /**
     * 启动 serve 子进程。
     * 已在线时直接返回，不重复启动。
     */
    async start(client) {
        // 已在运行：直接复用
        const v = await client.version();
        if (v.ok) {
            this.startedByUs = false;
            return { ok: true, alreadyRunning: true, version: v.version };
        }

        if (!this.exeExists()) {
            const guessed = OllamaDaemon.guessExePath();
            if (guessed) this.exePath = guessed;
            else {
                throw new Error(
                    `未找到 ollama 可执行文件。请在配置中填写完整路径（例如 D:\\WorkSpace\\Ollama\\bin\\ollama.exe）`,
                );
            }
        }

        const env = { ...process.env };
        // 关键：确保 OLLAMA_MODELS 生效，否则子进程会用 C 盘的默认目录
        const modelsDir = this.modelsDir || resolveEnv('OLLAMA_MODELS');
        if (modelsDir) env.OLLAMA_MODELS = modelsDir;
        // 同理，监听地址也尊重用户级变量
        const host = resolveEnv('OLLAMA_HOST');
        if (host && !env.OLLAMA_HOST) env.OLLAMA_HOST = host;

        this.log(`Ollama：启动服务 ${this.exePath}`);
        if (modelsDir) this.log(`Ollama：模型目录 ${modelsDir}`);

        const child = spawn(this.exePath, ['serve'], {
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            detached: false,
        });
        this.child = child;
        this.startedByUs = true;
        this.lastError = '';

        child.stdout?.on('data', (d) => {
            const s = String(d).trim();
            if (s) this.log(`[ollama] ${s.slice(0, 300)}`);
        });
        child.stderr?.on('data', (d) => {
            // Ollama 把 INFO 日志也写 stderr，只有 level=ERROR 才算真正的错误，
            // 否则「启动成功」时 lastError 会充满误导性的 INFO 文本。
            const text = String(d).trim();
            if (!text) return;
            for (const line of text.split('\n')) {
                const s = line.trim();
                if (!s) continue;
                if (/level=ERROR/i.test(s) || /(^|\s)error=/i.test(s)) {
                    this.lastError = s.slice(0, 300);
                    this.log(`[ollama:err] ${s.slice(0, 300)}`);
                } else {
                    this.log(`[ollama] ${s.slice(0, 300)}`);
                }
            }
        });
        child.on('exit', (code) => {
            this.log(`Ollama：服务进程退出（code ${code}）`);
            this.child = null;
            this.startedByUs = false;
        });
        child.on('error', (e) => {
            this.lastError = e.message;
            this.log(`Ollama：启动失败 - ${e.message}`);
        });

        // 等待端口就绪，最多 30 秒
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 600));
            const probe = await client.version();
            if (probe.ok) {
                this.log(`Ollama：服务已就绪，版本 ${probe.version}`);
                return { ok: true, alreadyRunning: false, version: probe.version };
            }
        }

        throw new Error(
            this.lastError
                ? `服务启动超时：${this.lastError}`
                : '服务启动超时（30 秒内未监听端口）',
        );
    }

    /** 停止 serve 进程（只停我们自己启动的） */
    async stop(client) {
        // 优先用 API 让所有模型卸载，再杀进程
        try {
            const running = await client.running();
            for (const m of running) {
                await client.unload(m.name).catch(() => {});
            }
        } catch {
            /* 忽略 */
        }

        if (!this.child) {
            return {
                ok: false,
                error: this.startedByUs
                    ? '进程句柄已失效，请手动结束 ollama 进程'
                    : 'Bridge 未启动该 Ollama 服务，无法从此时停止。请用任务管理器结束 ollama.exe',
            };
        }

        const child = this.child;
        try {
            if (process.platform === 'win32' && child.pid) {
                spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
                    stdio: 'ignore',
                    windowsHide: true,
                });
            } else {
                child.kill('SIGTERM');
            }
        } catch (e) {
            return { ok: false, error: e.message };
        }

        this.child = null;
        this.startedByUs = false;
        this.log('Ollama：服务已停止');
        return { ok: true };
    }

    status() {
        // 未显式配置时展示自动探测到的路径，方便用户一眼确认
        const guessed = this.exePath ? '' : OllamaDaemon.guessExePath();
        return {
            exePath: this.exePath || guessed,
            /** exePath 是自动探测所得（而非用户填写） */
            exeGuessed: !this.exePath && !!guessed,
            exeExists: this.exeExists() || !!guessed,
            managed: !!this.child,
            startedByUs: this.startedByUs,
            lastError: this.lastError,
            modelsDir: this.modelsDir || resolveEnv('OLLAMA_MODELS'),
            modelsDirSource: this.modelsDir ? 'config' : (resolveEnv('OLLAMA_MODELS') ? 'env' : 'default'),
        };
    }
}

export { DEFAULT_BASE };
