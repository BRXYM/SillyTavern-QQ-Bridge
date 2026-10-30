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

    // 用户显式配置的最高优先级：配了就只用它，不再猜测
    if (configured) {
        try {
            if (fs.statSync(configured).isFile()) {
                return {
                    path: configured,
                    source: 'config',
                    version: readDshVersion(configured),
                    binJs: resolveBinJs(configured),
                };
            }
        } catch {
            /* 配的路径无效，继续自动探测 */
        }
    }

    // ---- 收集候选（含来源），最后统一按「桌面版优先 + 版本新优先」排序 ----
    for (const p of desktopInstallCandidates()) {
        candidates.push({ path: p, source: 'desktop' });
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

    // npm 全局
    const appData = process.env.APPDATA ?? '';
    const npmPrefix = process.env.NPM_CONFIG_PREFIX ?? '';
    const npmGlobal = [
        path.join(appData, 'npm', 'dsh.cmd'),
        path.join(appData, 'npm', 'dsh.exe'),
        path.join(appData, 'npm', 'dsh.ps1'),
        // 常见的自定义 npm prefix（不硬编码盘符，只拼相对结构）
        npmPrefix ? path.join(npmPrefix, 'dsh.cmd') : '',
        npmPrefix ? path.join(npmPrefix, 'dsh.exe') : '',
        '/usr/local/bin/dsh',
        '/usr/bin/dsh',
        '/opt/homebrew/bin/dsh',
    ];
    for (const p of npmGlobal) {
        if (p) candidates.push({ path: p, source: 'npm-global' });
    }

    // ---- 逐个校验 + 打分 ----
    const probed = [];
    const seen = new Set();
    for (const c of candidates) {
        if (!c.path) continue;
        const key = path.resolve(c.path).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        try {
            if (!fs.statSync(c.path).isFile()) continue;
        } catch {
            continue;
        }

        probed.push({
            path: c.path,
            source: c.source,
            version: readDshVersion(c.path),
            binJs: resolveBinJs(c.path),
            score: scoreCandidate({ path: c.path, source: c.source }),
        });
    }

    if (probed.length === 0) {
        return { path: '', source: 'none', version: '', binJs: '' };
    }

    probed.sort((a, b) => b.score - a.score);
    const best = probed[0];

    return {
        path: best.path,
        source: best.source,
        version: best.version,
        binJs: best.binJs,
        /** 所有可用安装，供控制台展示与用户手动切换 */
        all: probed.map(({ score, ...rest }) => rest),
    };
}

/**
 * 桌面版（Electron 独立软件）的 CLI 候选路径。
 *
 * 桌面版把 CLI 挂在 resources/runtime/cli/bin 下，并通过内置 Electron
 * 以 ELECTRON_RUN_AS_NODE 方式运行，功能与 npm 版一致但版本通常更新
 * （实测 0.2.1 vs npm 的 0.1.2），因此优先探测。
 *
 * 不硬编码安装盘符：从注册表、常见安装位置、运行中的进程三处找。
 */
function desktopInstallCandidates() {
    const out = [];

    // 1) 常见安装位置（含默认安装路径）
    const roots = [
        'C:\\Program Files\\DeepSeek Harness',
        'C:\\Program Files (x86)\\DeepSeek Harness',
        path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness'),
        path.join(process.env.LOCALAPPDATA ?? '', 'DeepSeek Harness'),
        path.join(process.env.ProgramFiles ?? '', 'DeepSeek Harness'),
    ];
    for (const root of roots) {
        if (!root) continue;
        out.push(path.join(root, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'));
    }

    // 2) 从运行中的桌面版进程反查安装目录（绿色版没有注册表项，这是最可靠的一手信息）
    if (isWin) {
        try {
            const raw = execFileSync('wmic', ['process', 'where', "name='DeepSeek Harness.exe'", 'get', 'ExecutablePath'], {
                encoding: 'utf8',
                windowsHide: true,
                timeout: 6000,
                stdio: ['ignore', 'pipe', 'ignore'],
            });
            for (const line of String(raw).split(/\r?\n/)) {
                const exe = line.trim();
                if (!exe || !/\.exe$/i.test(exe)) continue;
                // <安装目录>\DeepSeek Harness.exe
                const root = path.dirname(exe);
                out.push(path.join(root, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'));
            }
        } catch {
            /* wmic 不可用（较新系统已移除），跳过 */
        }
    }

    // 3) 各盘符根下的常见目录名（覆盖装在 D:\ 这类非默认位置的情况）
    if (isWin) {
        for (const drive of listFixedDrives()) {
            for (const name of ['DeepSeekHarness', 'DeepSeek Harness', 'deepseek-harness']) {
                out.push(path.join(`${drive}\\`, name, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'));
            }
        }
    }

    // 4) 注册表里的安装位置（安装版才有）
    if (isWin) {
        for (const hive of ['HKLM', 'HKCU']) {
            for (const key of [
                'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\DeepSeek Harness',
                'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\deepseek-harness',
            ]) {
                try {
                    const raw = execFileSync('reg', ['query', `${hive}\\${key}`, '/v', 'InstallLocation'], {
                        encoding: 'utf8',
                        windowsHide: true,
                        timeout: 5000,
                        stdio: ['ignore', 'pipe', 'ignore'],
                    });
                    const m = /REG_SZ\s+(.+?)\s*$/m.exec(String(raw));
                    if (m && m[1]) {
                        out.push(path.join(m[1].trim(), 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'));
                    }
                } catch {
                    /* 该键不存在 */
                }
            }
        }
    }

    return out;
}

/** 列出本机固定磁盘（A/B 软驱除外），用于扫描非默认安装位置 */
function listFixedDrives() {
    if (!isWin) return [];
    try {
        const raw = execFileSync('wmic', ['logicaldisk', 'get', 'name'], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return String(raw)
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => /^[C-Z]:$/.test(l));
    } catch {
        // wmic 不可用时退回常见盘符
        return ['C:', 'D:', 'E:'];
    }
}

/**
 * 候选打分：来源权重 + 版本号。
 *
 * 规则（明确可预测，不依赖遍历顺序）：
 *   1. desktop  +200   —— 用户要求优先软件版
 *   2. config   +300   —— 显式配置最高（实际上配了就直接返回了）
 *   3. version  +0..99 —— 同来源下取版本更新的
 * 用 semver 里第一段数值做粗排序即可，精确比较交给 displayed version。
 */
function scoreCandidate({ path: p, source }) {
    let score = 0;
    if (source === 'config') score += 300;
    else if (source === 'desktop') score += 200;
    else if (source === 'PATH') score += 100;
    else score += 50;

    const v = versionWeight(readDshVersion(p));
    return score + v;
}

/** 把 0.2.1-rc.2 这类版本折算成 0..99 的小数，仅用于同来源内排序 */
function versionWeight(version) {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ''));
    if (!m) return 0;
    const major = Number(m[1]) || 0;
    const minor = Number(m[2]) || 0;
    const patch = Number(m[3]) || 0;
    // 主要看 major/minor，patch 权重很小
    return Math.min(99, major * 10 + minor + patch / 100);
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
        historyExtractsMax = 5,
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
        /** 每条提取规则最多取几条历史命中 */
        this.historyExtractsMax = Math.max(1, Math.floor(Number(historyExtractsMax) || 5));
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
     * @param {Array<{pattern:string,flags?:string,label?:string}>} [opts.historyExtracts]
     *        从历史里提取参考片段的正则规则（默认空 = 不发送任何历史内容）
     * @returns {Promise<{ok:boolean, text:string, elapsedMs:number, error?:string, sessionKey:string}>}
     */
    async ask({ sessionKey, text, system, historyExtracts = [], onProgress }) {
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
        // 历史不再整段拼接（dsh 自己存 session），只按规则提取参考片段
        const prompt = this.#composePrompt(key, raw, sys, historyExtracts);

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
                r = await this.#runOnce(exe, prompt, dir, t0, onProgress);
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
     * 组装最终 prompt。
     *
     * 设计变更（重要）：
     * dsh 自己按工作目录归档 session，会保留完整上下文。
     * 因此这里**不再拼接历史对话**——那等于把同样的内容喂两遍，
     * 既浪费 token 又容易让模型混淆"哪句是新的"。
     *
     * 但仍支持一种例外：用户可能想从历史里提取特定片段
     * （比如上一轮发过的表情标签、某个数值），作为本次的参考。
     * 这由 `historyExtract` 正则显式开启，默认关闭。
     *
     * @param {string} sessionKey
     * @param {string} newText
     * @param {string} system        系统设定（默认为空，见 PromptSettings）
     * @param {Array<{pattern:string,flags?:string,label?:string}>} extracts 历史提取规则
     */
    #composePrompt(sessionKey, newText, system = '', extracts = []) {
        const sys = String(system ?? '').trim();
        const sections = [];

        if (sys) sections.push(`[系统设定]\n${sys}`);

        // 历史提取：只取命中的片段，不发送整段对话
        const refs = this.#extractFromHistory(sessionKey, extracts);
        if (refs.length > 0) {
            sections.push(`[参考]\n${refs.join('\n')}`);
        }

        // 没有任何附加内容时，原样发送用户消息
        if (sections.length === 0) return newText;

        sections.push(newText);
        return sections.join('\n\n');
    }

    /**
     * 按用户给定的正则从历史里提取参考片段。
     *
     * 每条规则独立执行，最多取最近 `historyExtractsMax` 条命中；
     * 规则写错（非法正则）只跳过该条并记日志，不影响本次对话。
     */
    #extractFromHistory(sessionKey, extracts) {
        if (!Array.isArray(extracts) || extracts.length === 0) return [];

        const hist = this.#history.get(sessionKey) ?? [];
        if (hist.length === 0) return [];

        const out = [];
        for (const rule of extracts) {
            const pattern = String(rule?.pattern ?? '').trim();
            if (!pattern) continue;

            let re;
            try {
                // 只取第一个捕获组（若有），否则取整个匹配
                re = new RegExp(pattern, String(rule.flags ?? 'g'));
            } catch (e) {
                this.log(`⚠ 历史提取规则无效，已跳过：${pattern}（${e.message}）`);
                continue;
            }

            const hits = [];
            for (const h of hist) {
                if (hits.length >= this.historyExtractsMax) break;
                let m;
                re.lastIndex = 0;
                while ((m = re.exec(h.text)) !== null) {
                    const value = (m[1] ?? m[0] ?? '').trim();
                    if (value) hits.push(value);
                    if (m.index === re.lastIndex) re.lastIndex += 1; // 防零宽死循环
                    if (hits.length >= this.historyExtractsMax) break;
                }
            }

            if (hits.length > 0) {
                const label = String(rule.label ?? '').trim();
                out.push(label ? `${label}：${hits.join('、')}` : hits.join('、'));
            }
        }
        return out;
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

    #runOnce(exe, prompt, cwd, t0, onProgress) {
        return new Promise((resolve) => {
            /** 进度提取状态：避免重复上报同类动作 */
            const progressState = { started: false, tools: new Set() };
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
                const chunk = String(d);
                err += chunk;
                if (err.length > 20000) err = err.slice(-10000);

                // reasoning 流里提取摘要节点，交给上层决定是否转发
                if (typeof onProgress === 'function') {
                    try {
                        for (const ev of extractProgress(chunk, progressState, t0)) {
                            onProgress(ev);
                        }
                    } catch {
                        /* 进度解析失败不影响主流程 */
                    }
                }
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
 * 从 dsh 的 stderr（reasoning 流）提取摘要节点。
 *
 * 为什么不直接转发原文：reasoning 是逐 token 输出的，全发会变成几十条
 * QQ 消息。这里只识别「有意义的转折点」：
 *   - 首次出现 reasoning        → start
 *   - 提到工具/命令/搜索/读取等 → tool（带简短描述）
 *   - 其余内容                  → 忽略
 *
 * @param {string} chunk 本次新增的 stderr 文本
 * @param {object} state 跨 chunk 的状态（避免重复发同一条）
 * @returns {Array<{kind:string,text:string,detail?:string,at:number}>}
 */
export function extractProgress(chunk, state, startedAt = Date.now()) {
    const out = [];
    const text = String(chunk ?? '');
    if (!text) return out;

    const at = Date.now() - startedAt;

    // 首次收到 reasoning → 报「开始分析」
    if (!state.started && /reasoning/i.test(text)) {
        state.started = true;
        out.push({ kind: 'start', text: '正在处理…', at });
    }

    /**
     * 工具/动作识别。
     * 这些词是 dsh reasoning 里表达"我要去做某事"的高频线索，
     * 只在同一类动作未上报过时发，避免"读文件×10"刷屏。
     */
    const patterns = [
        { key: 'read', re: /读取|读取文件|read(ing)?\s+(the\s+)?file|扫描/i, label: '读取文件' },
        { key: 'search', re: /搜索|检索|查找|search|grep|find/i, label: '搜索' },
        { key: 'exec', re: /执行|运行命令|run(ning)?\s+(the\s+)?command|powershell|bash/i, label: '执行命令' },
        { key: 'web', re: /联网|网页|web\s+(search|fetch)|http/i, label: '联网查询' },
        { key: 'write', re: /写入|修改文件|编辑|write|edit(ing)?\s+(the\s+)?file/i, label: '写入文件' },
        { key: 'think', re: /分析|思考|推理|整理|总结/i, label: '分析' },
    ];

    for (const p of patterns) {
        if (state.tools.has(p.key)) continue;
        if (!p.re.test(text)) continue;
        state.tools.add(p.key);
        out.push({ kind: 'tool', text: `${p.label}…`, detail: p.key, at });
    }

    return out;
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
