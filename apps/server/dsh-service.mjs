/**
 * dsh（DeepSeek Harness）接入：探测本地安装、调用 headless 回答、按会话隔离工作目录。
 *
 * 设计边界：
 *   - 只调用已安装的 dsh，不负责安装
 *   - 用 `dsh --profile headless "<任务>"` 一次性问答，读 stdout 作为回复
 *   - dsh 的会话按「工作目录」归档，所以给每个 QQ 会话分配独立目录即可天然隔离上下文
 *   - reasoning 走 stderr，这里直接丢弃，只取最终回复
 *
 * 为什么不用 web profile：
 *   web 需要常驻服务 + 浏览器 UI + 鉴权网关，对"QQ 消息往返"这种一问一答过重。
 *   headless 是官方支持的用途，启动即用，无需占用端口。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const isWin = process.platform === 'win32';

/** 把 sessionKey 变成安全的目录名 */
function safeDirName(sessionKey) {
    const safe = String(sessionKey || 'default')
        .replace(/[^\w.-]+/g, '_')
        .slice(0, 60);
    return safe || 'default';
}

/** 单条历史文本的字符上限，避免某条超长消息把持久化文件撑爆 */
const HISTORY_TEXT_MAX = 4000;
/** 拼出来的 prompt 字符上限，超出时从最旧的对话开始丢弃 */
const PROMPT_MAX_CHARS = 16000;
/** dsh 探测结果缓存（where + --version 都会起子进程，不能每次都跑） */
const PROBE_TTL_MS = 60_000;
let probeCache = { key: '', at: 0, value: null };
const versionCache = new Map();

/**
 * 从 dsh.cmd / dsh.ps1 反推 bin.js 路径。
 *
 * 好处：直接 `node bin.js` 绕开 shell，stdout 干净、参数不用拼接，
 * 也不会触发 DEP0190（spawn + shell + args 的告警）。
 */
function resolveBinJs(exePath) {
    if (!exePath) return '';
    const dir = path.dirname(exePath);
    const candidates = [
        path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
        path.join(dir, '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    ];
    for (const c of candidates) {
        try {
            if (fs.statSync(c).isFile()) return path.resolve(c);
        } catch {
            /* 继续找 */
        }
    }
    return '';
}

/**
 * 探测本机 dsh 可执行文件。
 *
 * 顺序：
 *   1. 配置里显式填写
 *   2. PATH（where / which）
 *   3. npm 全局目录常见位置
 *
 * 结果缓存 60 秒：每次探测都要起子进程（where + --version），
 * 而状态接口会被前端频繁轮询，不能每次都真跑。
 */
export function findDsh(configured = '', { fresh = false } = {}) {
    const key = String(configured || '');
    if (!fresh && probeCache.value && probeCache.key === key && Date.now() - probeCache.at < PROBE_TTL_MS) {
        return probeCache.value;
    }
    const value = probeDsh(key);
    probeCache = { key, at: Date.now(), value };
    return value;
}

/** 清空探测缓存（控制台点「重新探测」时用） */
export function invalidateDshProbe() {
    probeCache = { key: '', at: 0, value: null };
    versionCache.clear();
}

function probeDsh(configured) {
    const candidates = [];

    if (configured) {
        candidates.push({ path: configured, source: 'config' });
    }

    // PATH 探测：Windows 上 `where dsh` 会同时返回 dsh / dsh.cmd / dsh.ps1，
    // 其中无扩展名的 dsh 是给 shell 用的，spawn 直接调会 ENOENT。
    // 因此这里优先挑 .cmd / .exe，最后才考虑无扩展名。
    try {
        const cmd = isWin ? 'where' : 'which';
        const raw = execFileSync(cmd, ['dsh'], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 8000,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        const lines = String(raw)
            .split(/\r?\n/)
            .map((x) => x.trim())
            .filter(Boolean);
        const score = (p) =>
            /\.(exe)$/i.test(p) ? 0 : /\.(cmd|bat)$/i.test(p) ? 1 : /\.ps1$/i.test(p) ? 2 : 3;
        lines.sort((a, b) => score(a) - score(b));
        for (const p of lines) candidates.push({ path: p, source: 'PATH' });
    } catch {
        /* PATH 里没有 */
    }

    // npm 全局（按可执行性排序）
    // 注意：这里只放跨机器通用的位置。用户自定义的 npm prefix（例如装在 D:\NODE\npm_global）
    // 不会自动出现，请用 dshExePath 或 PATH 指定，避免把本地路径写进代码。
    const appData = process.env.APPDATA ?? '';
    const npmGlobal = [
        path.join(appData, 'npm', 'dsh.cmd'),
        path.join(appData, 'npm', 'dsh.exe'),
        path.join(appData, 'npm', 'dsh.ps1'),
        '/usr/local/bin/dsh',
        '/usr/bin/dsh',
        '/opt/homebrew/bin/dsh',
    ];
    for (const p of npmGlobal) {
        if (p) candidates.push({ path: p, source: 'npm-global' });
    }

    for (const c of candidates) {
        try {
            if (!c.path || !fs.statSync(c.path).isFile()) continue;
            return {
                ...c,
                version: readDshVersion(c.path),
                binJs: resolveBinJs(c.path),
            };
        } catch {
            /* 继续找 */
        }
    }
    return { path: '', source: 'none', version: '', binJs: '' };
}

/** 读版本（失败返回空，不阻塞） */
function readDshVersion(exePath) {
    if (versionCache.has(exePath)) return versionCache.get(exePath);
    let version = '';
    try {
        // .cmd/.ps1 直接 execFile 在 Windows 上跑不起来，优先走 node + bin.js
        const binJs = resolveBinJs(exePath);
        const shell = !binJs && isWin && /\.(cmd|bat)$/i.test(exePath);
        const cmd = binJs ? process.execPath : exePath;
        const args = binJs ? [binJs, '--version'] : ['--version'];
        const raw = execFileSync(cmd, args, {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 12000,
            stdio: ['ignore', 'pipe', 'ignore'],
            shell,
        });
        version = String(raw).trim().split(/\r?\n/).pop() ?? '';
    } catch {
        version = '';
    }
    versionCache.set(exePath, version);
    return version;
}

/** dsh 的 home 目录（用于列出可用 profile） */
export function dshHome() {
    return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** 列出已安装的 profile 目录名 */
export function listProfiles() {
    const dir = path.join(dshHome(), 'profiles');
    try {
        return fs
            .readdirSync(dir, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name)
            .filter((n) => n !== 'node_modules');
    } catch {
        return [];
    }
}

/**
 * dsh 调用器。
 *
 * 每个 QQ 会话（sessionKey）分配一个独立工作目录，
 * 这样 dsh 自己的会话归档就天然按人隔离，不会串话。
 */
export class DshClient {
    constructor({
        exePath = '',
        profile = 'headless',
        workRoot = '',
        timeoutMs = 180000,
        log = () => {},
        historyTurns = 6,
        historyFile = '',
        systemPrompt = '',
        concurrency = 1,
    } = {}) {
        this.exePath = exePath;
        this.profile = profile || 'headless';
        this.workRoot = workRoot || path.join(os.tmpdir(), 'snowluma-dsh');
        this.timeoutMs = timeoutMs;
        this.log = log;
        /** 保留多少轮对话（一问一答算一轮；0 = 不带上下文也不持久化） */
        this.historyTurns = Math.max(0, Math.floor(Number(historyTurns) || 0));
        /** 上下文持久化文件；留空则只保存在内存里 */
        this.historyFile = historyFile ? path.resolve(historyFile) : '';
        /** 每次调用都附加的默认系统设定 */
        this.systemPrompt = String(systemPrompt ?? '');
        /**
         * 全局并发上限：每次调用都会起一个 dsh 进程，
         * 不限的话多人同时发消息会瞬间拉起一堆 node，内存和 CPU 都会被打满。
         */
        this.concurrency = Math.max(1, Math.floor(Number(concurrency) || 1));
        /**
         * 排队上限：超过就直接告知"太忙"，避免消息无限堆积后回一句几十分钟前的答案。
         * 默认按并发数的 3 倍。
         */
        this.maxQueue = Math.max(this.concurrency, this.concurrency * 3);
        /** 每个会话的并发锁，避免同一人连发导致多个 dsh 抢同一目录 */
        this.#locks = new Map();
        /** 每个会话的对话历史：sessionKey -> [{role, text, at}] */
        this.#history = new Map();
        this.#loadHistory();
    }

    #locks;
    /** 全局排队：等待中的任务数 + 正在运行数 */
    #running = 0;
    #waiters = [];
    /** 缓存的 bin.js 路径 */
    #binJs = '';
    /** 会话历史：sessionKey -> [{role:'user'|'assistant', text, at}] */
    #history;

    /**
     * 运行时检查：exe 存在、profile 可用。
     */
    status() {
        const found = findDsh(this.exePath).path;
        const exists = !!found && fs.existsSync(found);
        const profiles = listProfiles();
        // headless 是内置 profile，不出现在 profiles 目录里，因此不做强制校验
        return {
            installed: exists,
            exePath: found,
            /** 手填路径不存在时为 true（此时已回落到自动探测结果） */
            configuredMissing: !!this.exePath && !fs.existsSync(this.exePath),
            profile: this.profile,
            workRoot: this.workRoot,
            home: dshHome(),
            profiles,
            version: exists ? readDshVersion(found) : '',
            historyFile: this.historyFile,
            sessionCount: this.#history.size,
        };
    }

    /** 会话对应的 dsh 工作目录（用 sessionKey 生成稳定目录名） */
    workDirFor(sessionKey) {
        const dir = path.join(this.workRoot, safeDirName(sessionKey));
        fs.mkdirSync(dir, { recursive: true });
        return dir;
    }

    /**
     * 问 dsh 一句话，返回纯文本回复。
     *
     * headless 不支持 --resume（每次都是新会话），
     * 所以这里自己维护每个 sessionKey 的历史，每次拼进 prompt 传入。
     * 这样同一 QQ 好友能连续对话，不同好友互不影响。
     *
     * @param {object} opts
     * @param {string} opts.sessionKey 会话标识（决定上下文隔离）
     * @param {string} opts.text       要问的内容
     * @param {string} [opts.system]   本次调用的系统设定（缺省用实例配置）
     * @param {boolean} [opts.useHistory] 是否携带历史（默认 true）
     * @returns {Promise<{ok:boolean, text:string, elapsedMs:number, error?:string, sessionKey:string}>}
     */
    async ask({ sessionKey, text, useHistory = true, system }) {
        const key = String(sessionKey || 'default').trim() || 'default';
        const exe = findDsh(this.exePath).path;
        if (!exe || !fs.existsSync(exe)) {
            return { ok: false, text: '', elapsedMs: 0, error: '未找到 dsh 可执行文件', sessionKey: key };
        }

        const raw = String(text ?? '').trim();
        if (!raw) {
            return { ok: false, text: '', elapsedMs: 0, error: '内容为空', sessionKey: key };
        }

        const dir = this.workDirFor(key);
        const sys = String(system ?? this.systemPrompt ?? '').trim();
        const prompt = useHistory ? this.#composePrompt(key, raw, sys) : raw;

        // 同一会话串行，避免两个进程抢同一目录的会话文件。
        // 注意排队句柄要保存「链上的那个 Promise」，否则永远删不掉，长跑必然泄漏。
        const prev = this.#locks.get(key) ?? Promise.resolve();
        let release;
        const gate = new Promise((r) => {
            release = r;
        });
        const queued = prev.then(() => gate);
        this.#locks.set(key, queued);

        await prev;

        const t0 = Date.now();
        try {
            const got = await this.#acquireSlot();
            if (!got) {
                return {
                    ok: false,
                    text: '',
                    elapsedMs: 0,
                    error: `dsh 排队已满（并发 ${this.concurrency}，队列 ${this.#waiters.length}），本次已跳过`,
                    sessionKey: key,
                };
            }
            let r;
            try {
                r = await this.#runOnce(exe, prompt, dir, t0);
            } finally {
                this.#releaseSlot();
            }
            // 只有成功才记入历史，失败不污染上下文
            if (r.ok && r.text) {
                this.#appendHistory(key, raw, r.text);
            }
            return { ...r, sessionKey: key };
        } finally {
            release();
            if (this.#locks.get(key) === queued) this.#locks.delete(key);
        }
    }

    /** 当前排队与运行中的数量（控制台展示） */
    load() {
        return {
            running: this.#running,
            waiting: this.#waiters.length,
            concurrency: this.concurrency,
            maxQueue: this.maxQueue,
        };
    }

    /** 抢占一个全局执行槽；超上限就排队，队列也满了返回 false */
    #acquireSlot() {
        if (this.#running < this.concurrency) {
            this.#running += 1;
            return Promise.resolve(true);
        }
        if (this.#waiters.length >= this.maxQueue) {
            return Promise.resolve(false);
        }
        return new Promise((resolve) => this.#waiters.push(resolve));
    }

    #releaseSlot() {
        const next = this.#waiters.shift();
        if (next) {
            // 名额直接转交给下一个排队者，保持 running 计数不变
            next(true);
            return;
        }
        this.#running = Math.max(0, this.#running - 1);
    }

    /** 取某会话的历史条数（调试用） */
    historySize(sessionKey) {
        return this.#history.get(sessionKey)?.length ?? 0;
    }

    /** 列出有上下文的会话（控制台展示 / 清理用） */
    listSessions() {
        return [...this.#history.entries()]
            .map(([sessionKey, entries]) => ({
                sessionKey,
                messages: entries.length,
                turns: Math.floor(entries.length / 2),
                updatedAt: entries[entries.length - 1]?.at ?? null,
            }))
            .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
    }

    /**
     * 清空某会话上下文。
     * @param {string} sessionKey
     * @param {{removeWorkDir?: boolean}} [opts] 是否顺手删掉该会话的工作目录
     */
    clearHistory(sessionKey, { removeWorkDir = false } = {}) {
        const key = String(sessionKey || '').trim();
        if (!key) return false;
        const existed = this.#history.delete(key);
        this.#saveHistory();
        if (removeWorkDir) {
            try {
                fs.rmSync(path.join(this.workRoot, safeDirName(key)), { recursive: true, force: true });
            } catch (e) {
                this.log(`⚠ 删除 dsh 工作目录失败：${e.message}`);
            }
        }
        return existed;
    }

    /** 清空所有会话上下文 */
    clearAllHistory() {
        const n = this.#history.size;
        this.#history.clear();
        this.#saveHistory();
        return n;
    }

    /**
     * 把历史 + 新消息拼成最终 prompt。
     *
     * 格式用最朴素的分隔，避免模型误以为是 system 指令：
     *   [之前的对话]
     *   用户：xxx
     *   你：yyy
     *   [现在]
     *   用户：<新消息>
     *   （请直接回复这一条）
     */
    #composePrompt(sessionKey, newText, system = '') {
        const sys = String(system ?? '').trim();
        let hist = this.historyTurns > 0 ? [...(this.#history.get(sessionKey) ?? [])] : [];

        const build = () => {
            const sections = [];
            if (sys) sections.push(`[系统设定]\n${sys}`);
            if (hist.length > 0) {
                const lines = ['[之前的对话]'];
                for (const h of hist) {
                    lines.push(`${h.role === 'user' ? '用户' : '你'}：${h.text}`);
                }
                lines.push('[现在]');
                lines.push(`用户：${newText}`);
                lines.push('（请只回复“用户”这一条，不要复述历史）');
                sections.push(lines.join('\n'));
            } else if (sys) {
                sections.push(`[当前消息]\n用户：${newText}`);
            } else {
                return newText;
            }
            return sections.join('\n\n');
        };

        let prompt = build();
        // 超长保护：从最旧的整轮开始丢，直到塞得下
        while (prompt.length > PROMPT_MAX_CHARS && hist.length > 0) {
            hist = hist.slice(2);
            prompt = build();
        }
        return prompt.length > PROMPT_MAX_CHARS ? prompt.slice(0, PROMPT_MAX_CHARS) : prompt;
    }

    #appendHistory(sessionKey, userText, replyText) {
        if (this.historyTurns <= 0) return;
        const arr = this.#history.get(sessionKey) ?? [];
        const at = new Date().toISOString();
        arr.push({ role: 'user', text: userText.slice(0, HISTORY_TEXT_MAX), at });
        arr.push({ role: 'assistant', text: replyText.slice(0, HISTORY_TEXT_MAX), at });
        this.#history.set(sessionKey, this.#trimHistory(arr));
        this.#saveHistory();
    }

    /** 按「轮数」裁剪历史，保留最近的若干轮 */
    #trimHistory(entries) {
        const max = this.historyTurns * 2;
        if (max <= 0) return [];
        return entries.slice(-max);
    }

    /** 启动时从磁盘恢复上下文（没有文件就跳过） */
    #loadHistory() {
        if (!this.historyFile) return;
        let raw;
        try {
            // 防止误把超大文件当上下文读进来
            if (fs.statSync(this.historyFile).size > 5 * 1024 * 1024) {
                this.log('⚠ dsh 上下文文件超过 5MB，已跳过加载');
                return;
            }
            raw = JSON.parse(fs.readFileSync(this.historyFile, 'utf8'));
        } catch {
            return;
        }
        const src = raw && typeof raw === 'object' && raw.sessions && typeof raw.sessions === 'object'
            ? raw.sessions
            : raw;
        if (!src || typeof src !== 'object') return;
        for (const [key, entries] of Object.entries(src)) {
            if (!Array.isArray(entries)) continue;
            const clean = entries
                .filter(
                    (e) =>
                        e &&
                        (e.role === 'user' || e.role === 'assistant') &&
                        typeof e.text === 'string',
                )
                .map((e) => ({
                    role: e.role,
                    text: e.text.slice(0, HISTORY_TEXT_MAX),
                    at: typeof e.at === 'string' ? e.at : '',
                }));
            const kept = this.#trimHistory(clean);
            if (kept.length > 0) this.#history.set(key, kept);
        }
        if (this.#history.size > 0) {
            this.log(`dsh：已恢复 ${this.#history.size} 个会话的上下文（${this.historyFile}）`);
        }
    }

    /** 原子写入上下文文件；失败只记日志，不影响回复 */
    #saveHistory() {
        if (!this.historyFile) return;
        try {
            const sessions = {};
            for (const [key, entries] of this.#history) {
                if (entries.length > 0) sessions[key] = entries;
            }
            const tmp = `${this.historyFile}.tmp`;
            fs.mkdirSync(path.dirname(this.historyFile), { recursive: true });
            fs.writeFileSync(
                tmp,
                JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), sessions }, null, 2),
                'utf8',
            );
            fs.renameSync(tmp, this.historyFile);
        } catch (e) {
            this.log(`⚠ dsh 上下文持久化失败：${e.message}`);
        }
    }

    #runOnce(exe, prompt, cwd, t0) {
        return new Promise((resolve) => {
            const args = ['--profile', this.profile, prompt];

            // 优先用 node + bin.js 直接调用：
            //   - 绕开 .cmd 必须经 shell 的问题（避免 DEP0190 警告与参数拼接风险）
            //   - stdout 更干净，不会混入 cmd 的标题栏/提示
            const binJs = this.#binJs || resolveBinJs(exe);
            let cmd;
            let argv;
            let useShell = false;

            if (binJs) {
                this.#binJs = binJs;
                cmd = process.execPath;
                argv = [binJs, ...args];
            } else if (isWin && /\.(cmd|bat)$/i.test(exe)) {
                cmd = exe;
                argv = args;
                useShell = true;
            } else if (isWin && /\.ps1$/i.test(exe)) {
                cmd = 'powershell';
                argv = ['-NoProfile', '-NonInteractive', '-File', exe, ...args];
            } else {
                cmd = exe;
                argv = args;
            }

            const child = spawn(cmd, argv, {
                cwd,
                // stdout=回复 / stderr=reasoning
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
                shell: useShell,
            });

            let out = '';
            let err = '';
            let done = false;

            const finish = (r) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve(r);
            };

            const timer = setTimeout(() => {
                try {
                    if (isWin) {
                        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
                            stdio: 'ignore',
                            windowsHide: true,
                        });
                    } else {
                        child.kill('SIGKILL');
                    }
                } catch {
                    /* 忽略 */
                }
                finish({
                    ok: false,
                    text: '',
                    elapsedMs: Date.now() - t0,
                    error: `超时（${Math.round(this.timeoutMs / 1000)}s）`,
                });
            }, this.timeoutMs);

            child.stdout?.on('data', (d) => {
                out += String(d);
                // 防止无限增长
                if (out.length > 200000) out = out.slice(-100000);
            });
            child.stderr?.on('data', (d) => {
                err += String(d);
                if (err.length > 20000) err = err.slice(-10000);
            });

            child.on('error', (e) => {
                finish({ ok: false, text: '', elapsedMs: Date.now() - t0, error: e.message });
            });

            child.on('close', (code) => {
                const text = cleanOutput(out);
                if (code !== 0 && !text) {
                    const hint = cleanOutput(err).slice(0, 200);
                    finish({
                        ok: false,
                        text: '',
                        elapsedMs: Date.now() - t0,
                        error: `dsh 退出码 ${code}${hint ? `：${hint}` : ''}`,
                    });
                    return;
                }
                finish({ ok: true, text, elapsedMs: Date.now() - t0 });
            });
        });
    }
}

/**
 * 清洗 dsh 的 stdout。
 *
 * headless 的输出版本间不一致，实测见过两种：
 *   A) 只打印最终回复            → 直接用
 *   B) 先打印 "dsh: reasoning:"  + 推理过程，再打印回复
 *
 * 所以这里要识别并剥掉 reasoning 段。
 */
export function cleanOutput(raw) {
    let s = String(raw ?? '');

    // 去 ANSI 颜色码
    s = s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

    // 去 npm/pnpm 噪音行
    s = s
        .split(/\r?\n/)
        .filter((line) => {
            const t = line.trim();
            if (!t) return true;
            if (/^npm (WARN|notice)/i.test(t)) return false;
            if (/^pnpm /i.test(t)) return false;
            if (/^> /.test(t)) return false;
            return true;
        })
        .join('\n');

    // 剥离 reasoning 段：形如 "dsh: reasoning:" 开头，到空行或明显的回复开始处
    // 常见格式：dsh: reasoning:\n<推理>\n\n<最终回复>
    const rIdx = s.search(/^dsh:\s*reasoning:/im);
    if (rIdx >= 0) {
        const before = s.slice(0, rIdx).trim();
        const afterHeader = s.slice(rIdx).replace(/^dsh:\s*reasoning:\s*/im, '');
        // 推理段与最终回复通常以空行分隔，取最后一个空行块
        const blocks = afterHeader.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
        // 最后一块通常是最终回复；若只有一块则整体当作回复
        const reply = blocks.length > 1 ? blocks[blocks.length - 1] : blocks[0] ?? '';
        s = [before, reply].filter(Boolean).join('\n');
    }

    return s.replace(/\n{3,}/g, '\n\n').trim();
}
