/**
 * dsh profile / 插件注入 与 常驻服务管理。
 *
 * 设计边界（与需求对齐）：
 *   - 不管理第三方插件：只负责把 **SnowLuma 连接插件** 注入到指定 profile
 *   - 注入方式为非破坏性的「模块放置 + bundles 登记」：
 *       1. 把插件目录复制到 <DSH_HOME>/profiles/node_modules/@snowluma/dsh-bridge-connector
 *       2. 在该 profile 的 package.json → dsh.profile.bundles 追加插件名
 *       3. 在 cordis.patch.yml 写入/更新连接配置（url / token / cwdRoot）
 *     不跑 pnpm install、不改 dependencies，因此不会动到用户已有插件与锁文件。
 *   - 服务以 **分离进程** 方式启动（detached + unref）：
 *     启动后属于系统本身，Bridge 退出/重启都不影响它，下次通过端口与 PID 探测接管。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const isWin = process.platform === 'win32';

/** 插件包名（与 apps/dsh-plugin/package.json 保持一致） */
export const PLUGIN_NAME = '@snowluma/dsh-bridge-connector';
/** 插件在 profile 里使用的 loader 行 id */
export const PLUGIN_ROW_ID = 'snowluma-bridge-connector';

export function dshHome() {
    return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

export function profilesRoot(home = dshHome()) {
    return path.join(home, 'profiles');
}

export function resolveProfileDir(profile, home = dshHome()) {
    const name = String(profile || '').trim();
    if (!name || /[/\\]/.test(name) || name === '.' || name === '..') {
        throw new Error(`profile 名不合法：${JSON.stringify(profile)}`);
    }
    return path.join(profilesRoot(home), name);
}

/** 插件放置位置：profiles/node_modules（pnpm 不管这里，且能被 profile 的 createRequire 解析到） */
export function pluginTargetDir(home = dshHome()) {
    return path.join(profilesRoot(home), 'node_modules', ...PLUGIN_NAME.split('/'));
}

/** 列出所有 profile 及其 bundles */
export function listProfileBundles(home = dshHome()) {
    const root = profilesRoot(home);
    let entries = [];
    try {
        entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
        return [];
    }
    const out = [];
    for (const e of entries) {
        if (!e.isDirectory() || e.name === 'node_modules') continue;
        const manifestPath = path.join(root, e.name, 'package.json');
        if (!fs.existsSync(manifestPath)) continue;
        try {
            const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            out.push({
                profile: e.name,
                dir: path.join(root, e.name),
                bundles: Array.isArray(m?.dsh?.profile?.bundles) ? m.dsh.profile.bundles : [],
                patchReload: m?.dsh?.profile?.patchReload ?? '',
            });
        } catch {
            out.push({ profile: e.name, dir: path.join(root, e.name), bundles: [], patchReload: '', invalid: true });
        }
    }
    return out.sort((a, b) => a.profile.localeCompare(b.profile));
}

/** 读 profile 的 package.json */
function readManifest(profileDir) {
    return JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
}

/** 原子写 profile 的 package.json（2 空格 + 结尾换行，与 dsh 自己一致） */
function writeManifest(profileDir, manifest) {
    const file = path.join(profileDir, 'package.json');
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
}

/** 递归复制插件文件（跳过 node_modules 与隐藏目录） */
function copyPlugin(sourceDir, targetDir) {
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.mkdirSync(targetDir, { recursive: true });
    const queue = [''];
    while (queue.length) {
        const rel = queue.shift();
        const from = path.join(sourceDir, rel);
        for (const e of fs.readdirSync(from, { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
            const childRel = rel ? path.join(rel, e.name) : e.name;
            const src = path.join(sourceDir, childRel);
            const dst = path.join(targetDir, childRel);
            if (e.isDirectory()) {
                fs.mkdirSync(dst, { recursive: true });
                queue.push(childRel);
            } else if (e.isFile()) {
                fs.mkdirSync(path.dirname(dst), { recursive: true });
                fs.copyFileSync(src, dst);
            }
        }
    }
}

/** 极简 YAML 片段：只有我们需要的那一行（避免引 yaml 依赖） */
function renderPatchBlock({ url, token, cwdRoot, downstreamId = 'dsh', consolePort = 9510 }) {
    const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
    const lines = [
        `- id: ${PLUGIN_ROW_ID}`,
        '  config:',
        `    url: ${q(url)}`,
        `    token: ${q(token)}`,
        `    cwdRoot: ${q(cwdRoot)}`,
        // 插件用这两个自注册：连哪个实例、控制台在哪
        `    downstreamId: ${q(downstreamId)}`,
        `    consolePort: ${Number(consolePort) || 9510}`,
    ];
    return lines.join('\n');
}

const PATCH_BEGIN = `# >>> snowluma-bridge-connector（由 SnowLuma Bridge 自动维护）`;
const PATCH_END = `# <<< snowluma-bridge-connector`;

/** 把插件的 patch 行写进 profile 的 cordis.patch.yml（保留用户其它内容） */
function upsertPatchRow(profileDir, config) {
    const file = path.join(profileDir, 'cordis.patch.yml');
    let raw = '';
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch {
        raw = '';
    }
    const block = `${PATCH_BEGIN}\n${renderPatchBlock(config)}\n${PATCH_END}\n`;

    const begin = raw.indexOf(PATCH_BEGIN);
    if (begin >= 0) {
        const endIdx = raw.indexOf(PATCH_END, begin);
        const after = endIdx >= 0 ? raw.slice(endIdx + PATCH_END.length).replace(/^\r?\n/, '') : '';
        raw = raw.slice(0, begin) + block + after;
    } else {
        raw = `${raw.trimEnd()}\n\n${block}`;
    }
    fs.writeFileSync(file, raw, 'utf8');
}

/** 从 cordis.patch.yml 里摘掉插件的 patch 行 */
function removePatchRow(profileDir) {
    const file = path.join(profileDir, 'cordis.patch.yml');
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch {
        return;
    }
    const begin = raw.indexOf(PATCH_BEGIN);
    if (begin < 0) return;
    const endIdx = raw.indexOf(PATCH_END, begin);
    const after = endIdx >= 0 ? raw.slice(endIdx + PATCH_END.length).replace(/^\r?\n/, '') : '';
    fs.writeFileSync(file, `${raw.slice(0, begin).trimEnd()}\n${after}`.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n', 'utf8');
}

/** 读取 profile 里当前的插件注入状态 */
export function probeInjection({ profile, home = dshHome() } = {}) {
    const out = {
        profile: String(profile || ''),
        profileDir: '',
        profileExists: false,
        installed: false,
        inBundles: false,
        hasPatchRow: false,
        pluginDir: pluginTargetDir(home),
        version: '',
        config: null,
        error: '',
    };
    try {
        const dir = resolveProfileDir(profile, home);
        out.profileDir = dir;
        out.profileExists = fs.existsSync(path.join(dir, 'package.json'));
        if (!out.profileExists) return out;

        const manifest = readManifest(dir);
        const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [];
        out.inBundles = bundles.includes(PLUGIN_NAME);

        const pkgFile = path.join(out.pluginDir, 'package.json');
        if (fs.existsSync(pkgFile)) {
            const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
            out.installed = true;
            out.version = pkg.version ?? '';
        }

        const patchFile = path.join(dir, 'cordis.patch.yml');
        if (fs.existsSync(patchFile)) {
            const raw = fs.readFileSync(patchFile, 'utf8');
            out.hasPatchRow = raw.includes(PATCH_BEGIN);
            const urlMatch = /url:\s*'([^']*)'/.exec(raw.slice(raw.indexOf(PATCH_BEGIN)));
            const tokenMatch = /token:\s*'([^']*)'/.exec(raw.slice(raw.indexOf(PATCH_BEGIN)));
            const cwdMatch = /cwdRoot:\s*'([^']*)'/.exec(raw.slice(raw.indexOf(PATCH_BEGIN)));
            if (urlMatch || tokenMatch || cwdMatch) {
                out.config = {
                    url: urlMatch?.[1] ?? '',
                    token: tokenMatch?.[1] ?? '',
                    cwdRoot: cwdMatch?.[1] ?? '',
                };
            }
        }
        return out;
    } catch (e) {
        out.error = e.message;
        return out;
    }
}

/**
 * 注入（或更新）SnowLuma 连接插件。
 *
 * @param {object} opts
 * @param {string} opts.profile     目标 profile，例如 'web'
 * @param {string} opts.sourceDir   插件源码目录（apps/dsh-plugin）
 * @param {string} opts.url         Bridge 的 WS 地址，例如 ws://127.0.0.1:9500
 * @param {string} [opts.token]     可选握手 token
 * @param {string} [opts.cwdRoot]   会话工作目录根
 * @param {string} [opts.home]      DSH_HOME 覆盖
 */
export function injectPlugin({
    profile,
    sourceDir,
    url,
    token = '',
    cwdRoot = '',
    downstreamId = 'dsh',
    consolePort = 9510,
    home = dshHome(),
} = {}) {
    const out = { ok: false, action: '', target: '', profileDir: '', files: 0, error: '', injection: null };
    try {
        if (!sourceDir || !fs.existsSync(path.join(sourceDir, 'package.json'))) {
            throw new Error(`插件源码目录无效：${sourceDir}（缺少 package.json）`);
        }
        const dir = resolveProfileDir(profile, home);
        out.profileDir = dir;
        if (!fs.existsSync(path.join(dir, 'package.json'))) {
            throw new Error(`profile ${profile} 尚未初始化：先用 dsh --profile ${profile} 启动一次，或手动创建该 profile`);
        }

        const before = probeInjection({ profile, home });
        const target = pluginTargetDir(home);
        out.target = target;

        copyPlugin(sourceDir, target);
        out.files = fs.readdirSync(target).length;

        const manifest = readManifest(dir);
        manifest.dsh ??= {};
        manifest.dsh.profile ??= {};
        const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : [];
        if (!bundles.includes(PLUGIN_NAME)) bundles.push(PLUGIN_NAME);
        manifest.dsh.profile.bundles = bundles;
        writeManifest(dir, manifest);

        upsertPatchRow(dir, { url, token, cwdRoot, downstreamId, consolePort });

        out.ok = true;
        out.injection = probeInjection({ profile, home });
        out.action = !before.inBundles && !before.installed
            ? 'injected'
            : before.installed && before.inBundles
                ? 'updated'
                : 'repaired';
        return out;
    } catch (e) {
        out.error = e.message;
        return out;
    }
}

/** 移除注入（不影响用户其它插件） */
export function removePlugin({ profile, home = dshHome() } = {}) {
    const out = { ok: false, action: '', error: '' };
    try {
        const dir = resolveProfileDir(profile, home);
        if (fs.existsSync(path.join(dir, 'package.json'))) {
            const manifest = readManifest(dir);
            const bundles = manifest?.dsh?.profile?.bundles;
            if (Array.isArray(bundles)) {
                manifest.dsh.profile.bundles = bundles.filter((b) => b !== PLUGIN_NAME);
                writeManifest(dir, manifest);
            }
            removePatchRow(dir);
        }
        fs.rmSync(pluginTargetDir(home), { recursive: true, force: true });
        out.ok = true;
        out.action = 'removed';
        return out;
    } catch (e) {
        out.error = e.message;
        return out;
    }
}

/** 用 dsh 自己的 --dump-config 验证注入是否生效（不启动服务） */
export function verifyInjection({ exePath, profile, home = dshHome() }) {
    const exe = exePath || findDshExe();
    if (!exe) return { ok: false, error: '未找到 dsh 可执行文件' };
    try {
        const { cmd, argv, useShell } = buildSpawnArgs(exe, ['--profile', profile, '--dump-config']);
        const raw = execFileSync(cmd, argv, {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 60000,
            shell: useShell,
            env: { ...process.env, DSH_HOME: home },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const present = String(raw).includes(PLUGIN_ROW_ID);
        return {
            ok: present,
            present,
            error: present ? '' : 'profile 组合结果里没有找到插件行（检查 bundles 与 patch 配置）',
            configDumpLength: String(raw).length,
        };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

/** 找 dsh 可执行文件（与 dsh-service 的探测顺序一致，单独实现避免循环依赖） */
function findDshExe() {
    const candidates = [];
    try {
        const raw = execFileSync(isWin ? 'where' : 'which', ['dsh'], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 8000,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        candidates.push(
            ...String(raw)
                .split(/\r?\n/)
                .map((x) => x.trim())
                .filter(Boolean)
                .filter((p) => /\.(exe|cmd|bat|ps1)$/i.test(p)),
        );
    } catch {
        /* PATH 里没有 */
    }
    for (const p of candidates) {
        try {
            if (fs.statSync(p).isFile()) return p;
        } catch {
            /* 继续 */
        }
    }
    return '';
}

/** 从 dsh.cmd 反推 bin.js，绕开 shell 拿到干净输出 */
function resolveBinJs(exePath) {
    const dir = path.dirname(exePath);
    for (const c of [
        path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
        path.join(dir, '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    ]) {
        try {
            if (fs.statSync(c).isFile()) return path.resolve(c);
        } catch {
            /* 继续 */
        }
    }
    return '';
}

/** 组装 spawn 参数（Windows 下 .cmd 必须走 shell） */
export function buildSpawnArgs(exePath, args) {
    const binJs = resolveBinJs(exePath);
    if (binJs) return { cmd: process.execPath, argv: [binJs, ...args], useShell: false };
    if (isWin && /\.(cmd|bat)$/i.test(exePath)) return { cmd: exePath, argv: args, useShell: true };
    if (isWin && /\.ps1$/i.test(exePath)) {
        return { cmd: 'powershell', argv: ['-NoProfile', '-NonInteractive', '-File', exePath, ...args], useShell: false };
    }
    return { cmd: exePath, argv: args, useShell: false };
}

// ================= 常驻服务（分离进程） =================

/** 端口是否在监听 */
export function isPortOpen(port, host = '127.0.0.1', timeout = 700) {
    return import('node:net').then(
        (net) =>
            new Promise((resolve) => {
                const socket = new net.Socket();
                let done = false;
                const finish = (v) => {
                    if (done) return;
                    done = true;
                    socket.destroy();
                    resolve(v);
                };
                socket.setTimeout(timeout);
                socket.once('connect', () => finish(true));
                socket.once('timeout', () => finish(false));
                socket.once('error', () => finish(false));
                socket.connect(port, host);
            }),
    );
}

/** 查出监听某端口的 PID（Windows: netstat；*nix: lsof） */
export function pidOnPort(port) {
    try {
        if (isWin) {
            const raw = execFileSync('netstat', ['-ano'], {
                encoding: 'utf8',
                windowsHide: true,
                timeout: 10000,
                stdio: ['ignore', 'pipe', 'ignore'],
            });
            const line = String(raw)
                .split(/\r?\n/)
                .find((l) => l.includes('LISTENING') && new RegExp(`[:.]${port}\\s`).test(l));
            if (!line) return 0;
            const parts = line.trim().split(/\s+/);
            return Number(parts[parts.length - 1]) || 0;
        }
        const raw = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
            encoding: 'utf8',
            timeout: 10000,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return Number(String(raw).trim().split(/\r?\n/)[0]) || 0;
    } catch {
        return 0;
    }
}

/** 杀掉进程树 */
function killTree(pid) {
    try {
        if (isWin) {
            execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
                stdio: 'ignore',
                windowsHide: true,
                timeout: 10000,
            });
        } else {
            process.kill(pid, 'SIGTERM');
        }
        return true;
    } catch {
        return false;
    }
}

/** 等端口释放 / 就绪 */
async function waitFor(predicate, { timeoutMs = 30000, intervalMs = 500 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return true;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    return false;
}

/**
 * dsh 常驻服务管理器。
 *
 * 启动时用 detached + unref，并在 Windows 上以独立进程组运行：
 * Bridge 进程退出后 dsh 仍然活着，下次用端口/PID 探测接管。
 */
export class DshService {
    constructor({ exePath = '', profile = 'web', host = '127.0.0.1', port = 3080, logFile = '', log = () => {} } = {}) {
        this.exePath = exePath;
        this.profile = profile || 'web';
        this.host = host || '127.0.0.1';
        this.port = Number(port) || 3080;
        this.logFile = logFile || '';
        this.log = log;
        /** 仅记录「本次 Bridge 进程启动的」PID，用于日志与重启；不代表所有权 */
        this.lastPid = 0;
        this.lastError = '';
    }

    /** 运行时状态：端口是否在听、听的是哪个 PID、URL */
    status() {
        const pid = pidOnPort(this.port);
        return {
            profile: this.profile,
            host: this.host,
            port: this.port,
            url: `http://${this.host}:${this.port}`,
            running: pid > 0,
            pid,
            lastPid: this.lastPid,
            logFile: this.logFile,
            lastError: this.lastError,
        };
    }

    /** 异步状态（端口探测 + 日志尾部） */
    async inspect({ logTail = 40 } = {}) {
        const st = this.status();
        return { ...st, logTail: this.tailLog(logTail) };
    }

    /** 读日志尾（分离进程的 stdout/stderr 都写到这里） */
    tailLog(lines = 40) {
        if (!this.logFile) return [];
        try {
            const raw = fs.readFileSync(this.logFile, 'utf8');
            return raw.split(/\r?\n/).filter(Boolean).slice(-lines);
        } catch {
            return [];
        }
    }

    /** 启动（已在运行则直接返回） */
    async start({ extraArgs = [] } = {}) {
        const running = await isPortOpen(this.port, this.host);
        if (running) {
            const pid = pidOnPort(this.port);
            return { ok: true, alreadyRunning: true, pid, url: `http://${this.host}:${this.port}` };
        }

        const exe = this.exePath || findDshExe();
        if (!exe) {
            this.lastError = '未找到 dsh 可执行文件';
            return { ok: false, error: this.lastError };
        }

        const args = [
            '--profile', this.profile,
            '--no-open',
            '--port', String(this.port),
            ...extraArgs,
        ];
        const { cmd, argv, useShell } = buildSpawnArgs(exe, args);

        fs.mkdirSync(path.dirname(this.logFile || path.join(os.tmpdir(), 'x.log')), { recursive: true });
        const fd = fs.openSync(this.logFile || path.join(os.tmpdir(), 'dsh-service.log'), 'a');
        fs.writeSync(fd, `\n===== ${new Date().toISOString()} 启动 dsh --profile ${this.profile} --port ${this.port} =====\n`);

        this.log(`dsh：启动 ${exe} --profile ${this.profile} --port ${this.port}（分离进程）`);

        const child = spawn(cmd, argv, {
            cwd: os.homedir(),
            env: { ...process.env, DSH_HOME: dshHome() },
            // 关键：detached + 忽略 stdin，Bridge 退出后服务继续运行
            detached: true,
            stdio: ['ignore', fd, fd],
            windowsHide: true,
            shell: useShell,
        });
        child.unref();

        const ok = await waitFor(() => isPortOpen(this.port, this.host), { timeoutMs: 60000 });
        try {
            fs.closeSync(fd);
        } catch {
            /* 忽略 */
        }

        if (!ok) {
            this.lastError = `启动超时：60 秒内未监听 ${this.host}:${this.port}`;
            return { ok: false, error: this.lastError, logTail: this.tailLog(30) };
        }

        this.lastPid = pidOnPort(this.port);
        this.lastError = '';
        this.log(`dsh：服务已就绪 ${this.host}:${this.port}（pid ${this.lastPid}）`);
        return {
            ok: true,
            alreadyRunning: false,
            pid: this.lastPid,
            url: `http://${this.host}:${this.port}`,
            logTail: this.tailLog(20),
        };
    }

    /** 停止（按端口找 PID，跨 Bridge 重启同样有效） */
    async stop() {
        const pid = pidOnPort(this.port);
        if (!pid) return { ok: true, action: 'not-running' };
        this.log(`dsh：停止服务 pid=${pid}`);
        const killed = killTree(pid);
        const gone = await waitFor(async () => !(await isPortOpen(this.port, this.host)), { timeoutMs: 15000 });
        if (!gone) {
            return { ok: false, error: killed ? '进程已发送终止信号，但端口仍在监听' : '无法终止进程（可能权限不足）', pid };
        }
        return { ok: true, action: 'stopped', pid };
    }

    /** 重启 = 先停再起 */
    async restart() {
        const stopped = await this.stop();
        if (!stopped.ok) return { ok: false, stage: 'stop', ...stopped };
        const started = await this.start();
        return { ok: started.ok, stage: started.ok ? 'started' : 'start', stop: stopped, ...started };
    }
}
