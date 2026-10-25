/**
 * SnowLuma 服务编排：目录探测、OneBot 配置读写、账号清单。
 *
 * 设计原则：
 *   - 只读写 SnowLuma 自己的配置文件，不启动/停止外部进程（由 mcmanager 管）
 *   - 配置路径 = <snowlumaDir>/config/onebot_<uin>.json（SnowLuma 的约定）
 *   - 目录探测兼容源码模式（packages/core/config）与发行包模式（dist/config）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 候选的配置目录相对位置（按优先级） */
const CONFIG_DIR_CANDIDATES = [
    'dist/config',          // 发行包 / pnpm start 模式
    'config',               // 直接从 dist 内部启动
    'packages/core/config', // 源码 dev 模式
];

/** 候选的数据目录（按优先级：紧跟运行时实际使用的位置） */
const DATA_DIR_CANDIDATES = [
    'dist/data',
    'packages/core/data',
    'data',
];

const UIN_REGEX = /^[1-9]\d{4,11}$/;

/**
 * 判断某个目录是否像 SnowLuma 根目录。
 *
 * 必须命中 SnowLuma 的强特征，避免把本项目（snowluma-st-bridge）误判：
 *   - dist/index.mjs + dist/release.json（发行包布局）
 *   - packages/onebot + packages/protocol（源码布局，两者同时存在才足以区分）
 *   - package.json 的 name 为 snowluma 或 @snowluma/core
 */
function looksLikeSnowLumaRoot(dir) {
    try {
        if (!isDir(dir)) return false;

        // 发行包布局
        if (
            fs.existsSync(path.join(dir, 'dist', 'index.mjs')) &&
            fs.existsSync(path.join(dir, 'dist', 'release.json'))
        ) {
            return true;
        }

        // 源码布局：SnowLuma 独有 packages/protocol + packages/proton
        if (
            isDir(path.join(dir, 'packages', 'onebot')) &&
            (isDir(path.join(dir, 'packages', 'protocol')) ||
                isDir(path.join(dir, 'packages', 'proton')))
        ) {
            return true;
        }

        // package.json 名称判定
        const pkg = readJson(path.join(dir, 'package.json'));
        if (pkg?.name && /^(@snowluma\/|snowluma$)/i.test(String(pkg.name))) {
            return true;
        }

        return false;
    } catch {
        return false;
    }
}

/** 从某目录向上回溯，找到最近的 SnowLuma 根目录 */
function findRootUpward(startDir, maxDepth = 4) {
    let cur = path.resolve(startDir);
    for (let i = 0; i <= maxDepth; i++) {
        if (looksLikeSnowLumaRoot(cur)) return cur;
        const parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
    }
    return null;
}

/**
 * 自动发现 SnowLuma 目录。
 *
 * 按可靠性依次尝试：
 *   1. 环境变量 SNOWLUMA_DIR
 *   2. 本进程自己的 cwd 向上回溯（若 Bridge 与 SnowLuma 同仓）
 *   3. 已知配置里保存过且仍有效
 *   4. 从 config.json 里的各路径向上回溯
 *   5. 常见位置扫描（工作盘根目录、用户目录、同级兄弟目录）
 *   6. 正在监听的 WebUI 端口反查进程（Windows）
 *
 * 返回 { found, dir, source, candidates }
 */
export async function discoverSnowLumaDir({ knownDir = '', hintDirs = [] } = {}) {
    const tried = [];
    const candidates = [];

    const record = (dir, source) => {
        if (!dir) return;
        const resolved = path.resolve(dir);
        if (candidates.some((c) => c.dir === resolved)) return;
        // 排除明显是备份 / 归档的目录
        const base = path.basename(resolved).toLowerCase();
        if (/^_|backup|归档|archive|old|\.bak/.test(base)) return;
        candidates.push({ dir: resolved, source });
    };

    // 1. 环境变量
    const envDir = process.env.SNOWLUMA_DIR;
    tried.push('env:SNOWLUMA_DIR');
    if (envDir && looksLikeSnowLumaRoot(envDir)) {
        record(envDir, '环境变量 SNOWLUMA_DIR');
    }

    // 2. 已知配置中保存的目录
    tried.push('knownDir');
    if (knownDir && looksLikeSnowLumaRoot(knownDir)) {
        record(knownDir, '上次保存的路径');
    }

    // 3. 当前工作目录向上回溯
    tried.push('cwd-upward');
    const fromCwd = findRootUpward(process.cwd());
    if (fromCwd) record(fromCwd, '当前工作目录');

    // 4. 从提示目录向上回溯（如 Bridge 所在目录）
    tried.push('hint-upward');
    for (const hint of hintDirs) {
        if (!hint) continue;
        const found = findRootUpward(hint, 3);
        if (found) record(found, '相邻目录');
    }

    // 5. 常见位置扫描（受限深度，避免全盘遍历）
    tried.push('common-locations');
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const drives = ['C:', 'D:', 'E:'];
    const scanRoots = [
        home ? path.join(home, 'Desktop') : '',
        home ? path.join(home, 'Downloads') : '',
        home ? path.join(home, 'Documents') : '',
        ...drives.map((d) => `${d}\\`),
        ...drives.map((d) => `${d}\\WorkSpace`),
        ...drives.map((d) => `${d}\\Projects`),
        ...drives.map((d) => `${d}\\Code`),
        ...drives.map((d) => `${d}\\Tools`),
    ].filter(Boolean);

    const seen = new Set();
    for (const root of scanRoots) {
        if (!isDir(root)) continue;
        let entries = [];
        try {
            entries = fs.readdirSync(root, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            if (!e.isDirectory()) continue;
            // 名字里带 snowluma 的直接命中
            const lower = e.name.toLowerCase();
            if (lower.includes('snowluma')) {
                const p = path.join(root, e.name);
                if (looksLikeSnowLumaRoot(p) && !seen.has(p)) {
                    seen.add(p);
                    record(p, '目录名匹配');
                }
            }
        }
        // 只在盘根 / 工作目录这类地方做二级浅扫
        if (root.endsWith('\\') || /Workspace|Projects|Code|Tools/.test(root)) {
            for (const e of entries) {
                if (!e.isDirectory()) continue;
                const p = path.join(root, e.name);
                if (seen.has(p)) continue;
                if (looksLikeSnowLumaRoot(p) && !seen.has(p)) {
                    seen.add(p);
                    record(p, '扫描发现');
                }
            }
        }
    }

    // 6. 通过正在监听的 WebUI 端口反查进程工作目录（仅 Windows）
    tried.push('port-to-process');
    if (process.platform === 'win32') {
        try {
            const { execFileSync } = await import('node:child_process');
            // 常见 WebUI 端口
            const ports = [5099, 8080, 8000];
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
                        const found = findRootUpward(path.dirname(ps), 5);
                        if (found) record(found, `运行中的进程 (PID ${pid})`);
                    }
                } catch {
                    /* 单个 PID 失败不影响整体 */
                }
            }
        } catch {
            /* netstat/powershell 不可用时跳过 */
        }
    }

    // 去重并按可信度排序（record 已有顺序，此处保持）
    const best = candidates[0] ?? null;
    return {
        found: !!best,
        dir: best?.dir ?? '',
        source: best?.source ?? '',
        candidates,
        tried,
    };
}


function isDir(p) {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

/** 原子写：先写临时文件再 rename，避免 SnowLuma 读到半个文件 */
function writeJsonAtomic(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 4), 'utf8');
    fs.renameSync(tmp, file);
}

/**
 * 探测 SnowLuma 的目录布局。
 *
 * SnowLuma 支持两种运行形态，配置与数据目录必须成套使用：
 *   - 发行包 / pnpm start：dist/config + dist/data
 *   - 源码 dev          ：packages/core/config + packages/core/data
 *
 * 判定依据（按可靠性排序）：
 *   1. 哪个 config 目录下有 onebot*.json（说明实际在用）
 *   2. 哪个 config/runtime.json 的 webuiPort 与正在监听的端口一致
 *   3. 目录是否同时存在 config 与 data
 *   4. 回退到发行包布局
 */
function detectLayout(root, activePort = null) {
    const layouts = [
        { mode: 'release', config: 'dist/config', data: 'dist/data' },
        { mode: 'source', config: 'packages/core/config', data: 'packages/core/data' },
        { mode: 'flat', config: 'config', data: 'data' },
    ];

    const info = layouts.map((l) => {
        const c = path.join(root, l.config);
        const d = path.join(root, l.data);
        const hasConfig = isDir(c);
        const hasData = isDir(d);
        /** onebot_*.json 数量：真正被使用的最强信号 */
        let onebotFiles = 0;
        if (hasConfig) {
            try {
                onebotFiles = fs
                    .readdirSync(c)
                    .filter((f) => /^onebot.*\.json$/.test(f)).length;
            } catch {
                /* ignore */
            }
        }
        /** runtime.json 的端口是否与运行实例一致 */
        let portMatch = false;
        if (hasConfig && activePort) {
            const rt = readJson(path.join(c, 'runtime.json'));
            if (rt && Number(rt.webuiPort) === Number(activePort)) portMatch = true;
        }
        /** 账号目录数量 */
        let accounts = 0;
        if (hasData) {
            try {
                accounts = fs
                    .readdirSync(d, { withFileTypes: true })
                    .filter((e) => e.isDirectory() && UIN_REGEX.test(e.name)).length;
            } catch {
                /* ignore */
            }
        }
        return { ...l, configDir: c, dataDir: d, hasConfig, hasData, onebotFiles, portMatch, accounts };
    });

    const score = (x) =>
        (x.onebotFiles > 0 ? 100 : 0) +
        (x.portMatch ? 50 : 0) +
        (x.accounts > 0 ? 20 : 0) +
        (x.hasConfig && x.hasData ? 10 : 0) +
        (x.hasConfig ? 5 : 0);

    const ranked = [...info].sort((a, b) => score(b) - score(a));

    if (ranked.length > 0 && score(ranked[0]) > 0) {
        const best = ranked[0];

        // 配置目录与数据目录可能不同步（例如配置在 dist/config，但账号数据
        // 仍在 packages/core/data）。数据目录单独按「有账号」优先选取。
        let dataDir = best.dataDir;
        const withAccounts = info.filter((x) => x.accounts > 0);
        if (best.accounts === 0 && withAccounts.length > 0) {
            withAccounts.sort((a, b) => b.accounts - a.accounts);
            dataDir = withAccounts[0].dataDir;
        }

        return {
            configDir: best.configDir,
            dataDir,
            mode: best.mode,
            reason: best.onebotFiles > 0
                ? `检测到 ${best.onebotFiles} 个 OneBot 配置`
                : best.portMatch
                  ? `runtime.json 端口与运行实例一致`
                  : best.accounts > 0
                    ? `检测到 ${best.accounts} 个已登录账号`
                    : '目录存在',
            dataDirFallback: dataDir !== best.dataDir,
            alternatives: ranked.slice(1).filter((x) => x.hasConfig).map((x) => ({
                mode: x.mode,
                configDir: x.configDir,
                dataDir: x.dataDir,
                onebotFiles: x.onebotFiles,
                accounts: x.accounts,
            })),
        };
    }

    return {
        configDir: path.join(root, 'dist/config'),
        dataDir: path.join(root, 'dist/data'),
        mode: 'release',
        reason: '未找到现有配置，按发行包布局准备',
        alternatives: [],
    };
}

/**
 * 探测 SnowLuma 安装目录。
 * activePort：SnowLuma WebUI 正在监听的端口，用于判定实际生效的配置目录。
 * 返回 { ok, dir, configDir, dataDir, mode, reason, version, hasConfig, error }
 */
export function probeSnowLuma(rootDir, activePort = null) {
    const result = {
        ok: false,
        dir: '',
        configDir: '',
        dataDir: '',
        mode: '',
        reason: '',
        version: '',
        hasConfig: false,
        error: '',
        alternatives: [],
    };

    if (!rootDir || typeof rootDir !== 'string') {
        result.error = '未提供 SnowLuma 目录';
        return result;
    }

    const root = path.resolve(rootDir.trim());
    result.dir = root;

    if (!isDir(root)) {
        result.error = `目录不存在：${root}`;
        return result;
    }

    const layout = detectLayout(root, activePort);
    result.configDir = layout.configDir;
    result.dataDir = layout.dataDir;
    result.mode = layout.mode;
    result.reason = layout.reason ?? '';
    result.alternatives = layout.alternatives ?? [];
    result.hasConfig = isDir(layout.configDir);

    // 读版本：优先 dist/release.json，其次 package.json
    const release = readJson(path.join(root, 'dist', 'release.json'));
    if (release?.version) {
        result.version = String(release.version);
    } else {
        const pkg = readJson(path.join(root, 'package.json'));
        if (pkg?.version) result.version = String(pkg.version);
    }

    // 判定是不是 SnowLuma
    const looksLikeSnowLuma = looksLikeSnowLumaRoot(root);

    if (!looksLikeSnowLuma) {
        result.error = '该目录不像是 SnowLuma（未找到 dist/release.json 或 packages/protocol）';
        return result;
    }

    result.ok = true;
    return result;
}

/** 列出已登录的 QQ 账号（扫描数据目录下的 uin 文件夹） */
export function listAccounts(dataDir) {
    const out = [];
    if (!dataDir || !isDir(dataDir)) return out;

    let entries = [];
    try {
        entries = fs.readdirSync(dataDir, { withFileTypes: true });
    } catch {
        return out;
    }

    for (const e of entries) {
        if (!e.isDirectory() || !UIN_REGEX.test(e.name)) continue;
        const dir = path.join(dataDir, e.name);
        const identity = path.join(dir, 'snowluma_identity.db');
        out.push({
            uin: e.name,
            hasIdentityDb: fs.existsSync(identity),
            updatedAt: fs.existsSync(identity)
                ? fs.statSync(identity).mtime.toISOString()
                : null,
        });
    }

    out.sort((a, b) => Number(a.uin) - Number(b.uin));
    return out;
}

/** 默认 OneBot 配置（对齐 SnowLuma v2.x 的 makeDefaultOneBotConfig） */
export function makeDefaultOneBotConfig({ port = 3001, host = '127.0.0.1', token = '' } = {}) {
    const accessToken = token || crypto.randomBytes(24).toString('base64url');
    return {
        networks: {
            httpServers: [],
            httpClients: [],
            wsServers: [
                {
                    name: 'ws-default',
                    host,
                    port,
                    path: '/',
                    role: 'Universal',
                    accessToken,
                    messageFormat: 'array',
                    reportSelfMessage: false,
                },
            ],
            wsClients: [],
        },
        statusCommand: {
            enabled: true,
            swallow: false,
            cooldownSeconds: 5,
            trigger: '#sl',
        },
        historySync: { enabled: false },
        notifications: { channelIds: [] },
    };
}

/** 读取某账号的 OneBot 配置 */
export function readOneBotConfig(configDir, uin) {
    if (!UIN_REGEX.test(String(uin))) {
        throw new Error(`QQ 号格式不正确：${uin}`);
    }
    const file = path.join(configDir, `onebot_${uin}.json`);
    const raw = readJson(file);
    return {
        exists: raw !== null,
        path: file,
        config: raw,
    };
}

/**
 * 写入 OneBot 配置。
 * mode: 'merge'（保留其余字段，只改 ws）| 'replace'（整份覆盖）
 */
export function writeOneBotConfig(configDir, uin, nextConfig, mode = 'merge') {
    if (!UIN_REGEX.test(String(uin))) {
        throw new Error(`QQ 号格式不正确：${uin}`);
    }
    const file = path.join(configDir, `onebot_${uin}.json`);

    let target;
    if (mode === 'replace') {
        target = nextConfig;
    } else {
        const existing = readJson(file);
        target = existing && typeof existing === 'object'
            ? { ...existing, ...nextConfig }
            : nextConfig;
        // networks 需要逐项合并，避免把已有 httpServers 冲掉
        if (existing?.networks && nextConfig?.networks) {
            target.networks = { ...existing.networks, ...nextConfig.networks };
        }
    }

    writeJsonAtomic(file, target);
    return { ok: true, path: file, config: target };
}

/**
 * 一键配置：确保 SnowLuma 的 wsServer 指向本 Bridge 能连上的地址。
 *
 * 返回 { changed, config, path, token, endpoint }
 */
export function ensureOneBotEndpoint({
    configDir,
    uin,
    port = 3001,
    host = '127.0.0.1',
    forceToken = false,
}) {
    const existing = readOneBotConfig(configDir, uin);
    const cfg = existing.config ?? makeDefaultOneBotConfig({ port, host });

    const networks = cfg.networks ?? {};
    const servers = Array.isArray(networks.wsServers) ? [...networks.wsServers] : [];

    // 找现有的 wsServer（优先同名，其次第一个）
    let idx = servers.findIndex((s) => s?.name === 'ws-default');
    if (idx < 0) idx = servers.length > 0 ? 0 : -1;

    let token = '';
    let changed = false;

    if (idx < 0) {
        const created = makeDefaultOneBotConfig({ port, host });
        servers.push(created.networks.wsServers[0]);
        token = created.networks.wsServers[0].accessToken;
        changed = true;
    } else {
        const cur = servers[idx] ?? {};
        token = forceToken || !cur.accessToken
            ? crypto.randomBytes(24).toString('base64url')
            : cur.accessToken;

        const want = {
            ...cur,
            name: cur.name ?? 'ws-default',
            host,
            port,
            path: cur.path ?? '/',
            role: cur.role ?? 'Universal',
            accessToken: token,
            messageFormat: cur.messageFormat ?? 'array',
            reportSelfMessage: cur.reportSelfMessage ?? false,
        };

        if (
            cur.host !== want.host ||
            cur.port !== want.port ||
            cur.accessToken !== want.accessToken ||
            cur.path !== want.path
        ) {
            changed = true;
        }
        servers[idx] = want;
    }

    const next = {
        ...cfg,
        networks: { ...networks, wsServers: servers },
    };

    if (changed || !existing.exists) {
        writeOneBotConfig(configDir, uin, next, 'replace');
    }

    return {
        changed,
        created: !existing.exists,
        path: path.join(configDir, `onebot_${uin}.json`),
        config: next,
        token,
        endpoint: `ws://${host}:${port}`,
    };
}

/** 探测端口是否被占用（用于提示 SnowLuma 是否已启动） */
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

export { UIN_REGEX, CONFIG_DIR_CANDIDATES, DATA_DIR_CANDIDATES };
