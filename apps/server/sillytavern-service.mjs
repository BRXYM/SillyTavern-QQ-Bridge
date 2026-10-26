/**
 * SillyTavern 服务编排：目录探测、扩展安装、连接状态检查。
 *
 * 设计原则：
 *   - 扩展源码来自本仓库 apps/extension，安装即复制到酒馆的 third-party 目录
 *   - 只做文件复制与状态检查，不启动/停止酒馆进程
 *   - 安装后酒馆需要刷新页面才能加载扩展，必须明确提示用户
 */
import fs from 'node:fs';
import path from 'node:path';

/** 酒馆扩展安装的相对路径 */
const EXT_REL = path.join('public', 'scripts', 'extensions', 'third-party');

/** 候选的常见安装位置（用于自动发现） */
const COMMON_ROOTS = [
    'SillyTavern',
    'sillytavern',
    'SillyTavern-release',
    'SillyTavern-1.12.0',
];

/** 判定目录是否为酒馆根目录 */
export function looksLikeSillyTavern(dir) {
    try {
        if (!fs.existsSync(dir)) return false;
        const st = (p) => fs.existsSync(path.join(dir, p));
        // 至少命中三个特征
        const marks = [
            st('public/scripts/extensions'),
            st('server.js') || st('server.mjs'),
            st('package.json'),
            st('public/index.html'),
            st('data/default-user'),
        ];
        return marks.filter(Boolean).length >= 3;
    } catch {
        return false;
    }
}

/** 探测酒馆安装信息 */
export function probeSillyTavern(rootDir) {
    const result = {
        ok: false,
        dir: '',
        extDir: '',
        installed: false,
        installedVersion: '',
        sourceVersion: '',
        files: [],
        error: '',
    };

    if (!rootDir || typeof rootDir !== 'string') {
        result.error = '未提供酒馆目录';
        return result;
    }

    const root = path.resolve(rootDir.trim());
    result.dir = root;

    if (!fs.existsSync(root)) {
        result.error = `目录不存在：${root}`;
        return result;
    }
    if (!looksLikeSillyTavern(root)) {
        result.error = '该目录不像是 SillyTavern 安装目录（未找到 public/scripts/extensions）';
        return result;
    }

    const extDir = path.join(root, EXT_REL);
    result.extDir = extDir;

    // 查看是否已安装
    const target = path.join(extDir, 'SnowLuma-Bridge');
    if (fs.existsSync(target)) {
        result.installed = true;
        try {
            const mf = JSON.parse(
                fs.readFileSync(path.join(target, 'manifest.json'), 'utf8'),
            );
            result.installedVersion = String(mf.version ?? '');
        } catch {
            result.installedVersion = '';
        }
        try {
            result.files = fs.readdirSync(target).filter((f) => !f.startsWith('.'));
        } catch {
            result.files = [];
        }
    }

    result.ok = true;
    return result;
}

/** 读取本仓库待安装的扩展版本 */
export function readSourceExtension(sourceDir) {
    const out = { ok: false, dir: sourceDir, version: '', files: [], error: '' };
    try {
        if (!fs.existsSync(sourceDir)) {
            out.error = `扩展源码目录不存在：${sourceDir}`;
            return out;
        }
        const need = ['index.js', 'manifest.json'];
        for (const f of need) {
            if (!fs.existsSync(path.join(sourceDir, f))) {
                out.error = `扩展源码缺少 ${f}`;
                return out;
            }
        }
        const mf = JSON.parse(fs.readFileSync(path.join(sourceDir, 'manifest.json'), 'utf8'));
        out.version = String(mf.version ?? '');
        out.files = fs.readdirSync(sourceDir).filter((f) => !f.startsWith('.'));
        out.ok = true;
        return out;
    } catch (e) {
        out.error = `读取扩展源码失败：${e.message}`;
        return out;
    }
}

/**
 * 安装/更新扩展到酒馆。
 * 返回 { ok, action, target, version, files, needRefresh, error }
 * action: 'installed' | 'updated' | 'unchanged' | 'reinstalled'
 */
export function installExtension({ stDir, sourceDir, force = false }) {
    const out = {
        ok: false,
        action: '',
        target: '',
        version: '',
        files: [],
        needRefresh: true,
        error: '',
    };

    const probe = probeSillyTavern(stDir);
    if (!probe.ok) {
        out.error = probe.error;
        return out;
    }

    const src = readSourceExtension(sourceDir);
    if (!src.ok) {
        out.error = src.error;
        return out;
    }

    out.target = path.join(probe.extDir, 'SnowLuma-Bridge');
    out.version = src.version;

    // 已安装且版本一致，且不是强制重装
    if (probe.installed && probe.installedVersion === src.version && !force) {
        out.ok = true;
        out.action = 'unchanged';
        out.files = probe.files;
        out.needRefresh = false;
        return out;
    }

    const existed = probe.installed;

    try {
        fs.mkdirSync(out.target, { recursive: true });
        for (const f of src.files) {
            const from = path.join(sourceDir, f);
            const to = path.join(out.target, f);
            const stat = fs.statSync(from);
            if (stat.isFile()) {
                fs.copyFileSync(from, to);
            }
        }
        out.ok = true;
        out.action = existed ? 'updated' : 'installed';
        out.files = src.files;
        out.needRefresh = true;
        return out;
    } catch (e) {
        out.error = `复制扩展文件失败：${e.message}`;
        return out;
    }
}

/** 卸载扩展 */
export function uninstallExtension(stDir) {
    const probe = probeSillyTavern(stDir);
    if (!probe.ok) return { ok: false, error: probe.error };
    if (!probe.installed) return { ok: true, action: 'not-installed', needRefresh: false };

    const target = path.join(probe.extDir, 'SnowLuma-Bridge');
    try {
        fs.rmSync(target, { recursive: true, force: true });
        return { ok: true, action: 'removed', needRefresh: true };
    } catch (e) {
        return { ok: false, error: `删除失败：${e.message}` };
    }
}

/** 端口是否在监听 */
export async function isPortOpen(port, host = '127.0.0.1', timeout = 800) {
    const net = await import('node:net');
    return new Promise((resolve) => {
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
    });
}

/**
 * 自动发现酒馆目录。
 * 与 SnowLuma 类似的多策略：环境变量 → 已保存 → cwd 回溯 → 常见位置 → 进程反查
 */
export async function discoverSillyTavernDir({ knownDir = '', hintDirs = [] } = {}) {
    const tried = [];
    const candidates = [];

    const record = (dir, source) => {
        if (!dir) return;
        const resolved = path.resolve(dir);
        if (candidates.some((c) => c.dir === resolved)) return;
        const base = path.basename(resolved).toLowerCase();
        if (/^_|backup|archive|归档|\.bak/.test(base)) return;
        if (!looksLikeSillyTavern(resolved)) return;
        candidates.push({ dir: resolved, source });
    };

    // 1. 环境变量
    tried.push('env:SILLYTAVERN_DIR');
    if (process.env.SILLYTAVERN_DIR) record(process.env.SILLYTAVERN_DIR, '环境变量');

    // 2. 已保存
    tried.push('knownDir');
    if (knownDir) record(knownDir, '上次保存的路径');

    // 3. cwd 及相邻目录向上回溯
    tried.push('cwd-siblings');
    const tryUpward = (start, depth = 3) => {
        let cur = path.resolve(start);
        for (let i = 0; i <= depth; i++) {
            record(cur, '相邻目录');
            const parent = path.dirname(cur);
            if (parent === cur) break;
            cur = parent;
        }
    };
    tryUpward(process.cwd());
    for (const h of hintDirs) if (h) tryUpward(h, 2);

    // 4. 常见位置扫描
    tried.push('common-locations');
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const drives = ['C:', 'D:', 'E:'];
    const roots = [
        ...drives.map((d) => `${d}\\`),
        ...drives.map((d) => `${d}\\WorkSpace`),
        ...drives.map((d) => `${d}\\Projects`),
        home ? path.join(home, 'Desktop') : '',
        home ? path.join(home, 'Documents') : '',
    ].filter(Boolean);

    for (const r of roots) {
        let entries = [];
        try {
            entries = fs.readdirSync(r, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            if (!e.isDirectory()) continue;
            const name = e.name.toLowerCase();
            if (name.includes('sillytavern') || name === 'sillytavern') {
                record(path.join(r, e.name), '目录名匹配');
            }
        }
    }

    // 5. 通过监听端口反查进程路径
    tried.push('port-to-process');
    if (process.platform === 'win32') {
        try {
            const { execFileSync } = await import('node:child_process');
            const ports = [8000, 8001, 8002];
            const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], {
                encoding: 'utf8',
                timeout: 5000,
                windowsHide: true,
            });
            const pids = new Set();
            for (const line of out.split(/\r?\n/)) {
                const m = line.match(/[:.](\d+)\s+\S+\s+LISTENING\s+(\d+)/);
                if (m && ports.includes(Number(m[1]))) pids.add(m[2]);
            }
            for (const pid of pids) {
                try {
                    const ps = execFileSync(
                        'powershell',
                        [
                            '-NoProfile',
                            '-NonInteractive',
                            '-Command',
                            `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").ExecutablePath`,
                        ],
                        { encoding: 'utf8', timeout: 6000, windowsHide: true },
                    ).trim();
                    if (ps) {
                        let cur = path.dirname(ps);
                        for (let i = 0; i < 5; i++) {
                            if (looksLikeSillyTavern(cur)) {
                                record(cur, `运行中的进程 (PID ${pid})`);
                                break;
                            }
                            const parent = path.dirname(cur);
                            if (parent === cur) break;
                            cur = parent;
                        }
                    }
                } catch {
                    /* ignore */
                }
            }
        } catch {
            /* ignore */
        }
    }

    const best = candidates[0] ?? null;
    return {
        found: !!best,
        dir: best?.dir ?? '',
        source: best?.source ?? '',
        candidates,
        tried,
    };
}

export { EXT_REL, COMMON_ROOTS };
