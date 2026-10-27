// snowluma-bridge.mjs — QQ ↔ SillyTavern 桥接后端（v3）
//
// 架构（纯事件驱动）：
//   ① QQ消息 → SnowLuma(OneBot v11) → 本连接器 → 按 sessionKey 广播给酒馆扩展
//   ② 酒馆扩展：写入聊天上下文 → 触发生成（酒馆直连自己的模型）
//   ③ 扩展监听 MESSAGE_RECEIVED → 携带 sessionKey 推回
//   ④ 本连接器按 sessionKey 路由 → 【回复处理管道】→ SnowLuma → QQ
//
// HTTP API(:9510)：
//   本进程只提供 /api/* 接口，供 Vue 管理界面（apps/web）调用。
//   内置控制台网页已停用，根路径仅返回一句提示。
//
//   上游(SnowLuma)：OneBot 地址/token、目录探测与自动配置
//   下游(酒馆)：扩展端口、消息模板、角色/世界书清单
//   消息处理：回复处理管道（replace/remove/strip）、回复分段
//   运行日志：/api/status 返回环形缓冲
//   配置热保存到 config.json（OneBot 连接参数修改后自动重连）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import {
    probeSnowLuma,
    listAccounts,
    readOneBotConfig,
    ensureOneBotEndpoint,
    isPortOpen,
    discoverSnowLumaDir,
    UIN_REGEX,
} from './snowluma-service.mjs';
import {
    probeSillyTavern,
    installExtension,
    uninstallExtension,
    discoverSillyTavernDir,
    isPortOpen as isStPortOpen,
} from './sillytavern-service.mjs';
import { FaceService } from './faces-service.mjs';
import { TAG_VOCAB } from './faces-store.mjs';
import { DshClient, findDsh, listProfiles, dshHome, invalidateDshProbe } from './dsh-service.mjs';
import {
    DshService,
    PLUGIN_NAME,
    PLUGIN_ROW_ID,
    injectPlugin,
    listProfileBundles,
    pluginTargetDir,
    probeInjection,
    removePlugin,
    verifyInjection,
} from './dsh-profile-service.mjs';
import { OllamaClient, OllamaDaemon, countModelsIn } from './ollama-service.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 后端代码版本标记。
 *
 * 用途：改了代码但进程没重启时，前端能一眼看出来。
 * 之前就因为这个踩过坑 —— 修好的逻辑没生效，还以为是修复本身有问题。
 * 每次改后端逻辑时顺手更新这个值。
 */
const CODE_VERSION = '2026-10-27.3-face-log';

/** 后端入口文件的最后修改时间（秒级），用来判断进程是否落后于代码 */
const CODE_MTIME = (() => {
    try {
        const self = fileURLToPath(import.meta.url);
        return Math.floor(fs.statSync(self).mtimeMs / 1000);
    } catch {
        return 0;
    }
})();
const CONFIG_PATH = path.join(__dirname, 'config.json');
const SESSIONS_PATH = path.join(__dirname, 'sessions.json');

// ================= 配置（支持热更新） =================
const DEFAULT_CONFIG = {
    onebotUrl: 'ws://127.0.0.1:3001',
    onebotToken: '',
    stExtPort: 9500,
    consolePort: 9510,
    trigger: { atOnly: true, privateReply: true, allowedUsers: [], allowedGroups: [] },
    maxMessageLength: 2000,
    replyProcessors: [],
    // 服务集成：目录由服务管理页填写后持久化
    snowlumaDir: '',
    snowlumaWebuiPort: 5099,
    sillyTavernDir: '',
    sillyTavernPort: 8000,
    // 表情库：Ollama 视觉模型配置（走 HTTP API，便于换模型）
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    ollamaVisionModel: 'qwen2.5vl:3b',
    ollamaTextModel: '',
    // Ollama 本地服务：只管调用，不负责安装
    // exePath 用于「服务未启动时一键拉起」，留空则自动探测常见安装位置
    ollamaExePath: '',
    // 模型目录（会作为 OLLAMA_MODELS 传给子进程）；留空则沿用系统环境变量
    ollamaModelsDir: '',
    // 默认角色/世界书：酒馆当前未选择角色时自动使用
    defaults: {
        character: '',      // 角色名（留空=不自动选择）
        world: '',          // 世界书名（留空=不自动激活）
    },
    // 后端选择：'taver' 走酒馆（默认） / 'dsh' 走 DeepSeek Harness
    backend: 'taver',
    // dsh 接入参数
    dshExePath: '',                     // 留空自动探测
    dshProfile: 'headless',             // headless | web | desktop
    dshWorkRoot: '',                    // 每个会话的工作目录根，留空用系统临时目录
    dshTimeoutMs: 180000,               // 单次超时
    dshHistoryTurns: 6,                 // 保留几轮上下文（0 = 不保留）
    dshSystemPrompt: '',                // 追加到内置提示词之后的人设/约束
    dshErrorReply: '',                  // 调用失败时回给 QQ 的话；留空 = 静默
    dshPersistHistory: true,            // 上下文落盘，重启后仍能续聊
    dshConcurrency: 1,                  // 同时最多跑几个 dsh 进程（多人并发时排队）
    // dsh 常驻服务（web profile）：由 Bridge 启停，进程分离不随 Bridge 退出
    dshServiceProfile: 'web',
    dshServicePort: 3080,
    dshServiceLogFile: '',              // 留空写到系统临时目录
    // dsh 连接插件：装进 profile 后由 dsh 主动连回本 Bridge
    dshPluginEnabled: true,             // 连接插件在线时优先走插件链路
    dshPluginToken: '',                 // 插件握手 token（留空不校验）
};

/** dsh 连接插件链路：插件在线时优先使用，避免每条消息起子进程 */
const dshPluginClients = new Set();

// ================= 会话持久化（文件存储，无需数据库） =================
// 结构：{ "private_123456": { character: "雪乃", world: "雪之世界书", updatedAt: "..." } }
let sessions = {};

function loadSessions() {
    try {
        sessions = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8'));
    } catch {
        sessions = {};
    }
}

let saveSessionsTimer = null;
function saveSessions() {
    // 防抖：500ms 内多次变更只写一次
    if (saveSessionsTimer) clearTimeout(saveSessionsTimer);
    saveSessionsTimer = setTimeout(() => {
        saveSessionsTimer = null;
        try {
            fs.writeFileSync(SESSIONS_PATH, JSON.stringify(sessions, null, 4), 'utf8');
        } catch (e) {
            log('⚠ 会话持久化失败:', e.message);
        }
    }, 500);
}

/** 记录某会话的角色/世界书选择（供后续消息复用） */
function rememberSession(key, patch) {
    if (!sessions[key]) sessions[key] = {};
    Object.assign(sessions[key], patch, { updatedAt: new Date().toISOString() });
    saveSessions();
}

function sessionDefaults(key) {
    const s = sessions[key] ?? {};
    return {
        character: s.character || cfg.defaults?.character || '',
        world: s.world || cfg.defaults?.world || '',
    };
}

/**
 * 某会话实际使用的后端。
 *
 * 三层策略（与角色/世界书一致）：
 *   sessions[key].backend = 'dsh' | 'taver'  → 该会话独立使用
 *   sessions[key].backend 缺失 / 空           → 继承全局 cfg.backend
 */
function sessionBackend(key) {
    const own = sessions[key]?.backend;
    if (own === 'dsh' || own === 'taver') return { backend: own, inherited: false };
    return { backend: cfg.backend === 'dsh' ? 'dsh' : 'taver', inherited: true };
}



let configFileExisted = true;

function loadConfig() {
    let base;
    let existed = true;
    try {
        base = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
    } catch {
        base = { ...DEFAULT_CONFIG };
        existed = false;
    }
    // 环境变量覆盖（便于一个仓库内多实例 / 端口冲突时切换）
    if (process.env.API_PORT) base.consolePort = Number(process.env.API_PORT);
    if (process.env.EXT_PORT) base.stExtPort = Number(process.env.EXT_PORT);
    if (process.env.ONEBOT_URL) base.onebotUrl = process.env.ONEBOT_URL;
    if (process.env.ONEBOT_TOKEN) base.onebotToken = process.env.ONEBOT_TOKEN;
    if (process.env.ST_DATA_DIR) base.stDataDir = process.env.ST_DATA_DIR;
    configFileExisted = existed;
    if (existed && !base.stDataDir) {
        const detected = detectStDataDirQuiet();
        if (detected) base.stDataDir = detected;
    }
    return base;
}

/** 启动期探测酒馆目录（不打印警告，避免每次启动刷屏） */
function detectStDataDirQuiet() {
    const fromEnv = process.env.ST_DATA_DIR;
    if (fromEnv) return fromEnv;
    const candidates = [
        path.resolve(__dirname, '../../../SillyTavern/data/default-user'),
        path.resolve(__dirname, '../../SillyTavern/data/default-user'),
        path.resolve(process.cwd(), '../SillyTavern/data/default-user'),
        path.resolve(process.cwd(), 'SillyTavern/data/default-user'),
    ];
    for (const dir of candidates) {
        try {
            if (fs.existsSync(path.join(dir, 'characters'))) return dir;
        } catch {
            /* ignore */
        }
    }
    return null;
}
let cfg = loadConfig();
loadSessions();
function saveConfig() {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 4), 'utf8');
    log('配置已保存到 config.json');
}

const logBuffer = [];                 // 控制台日志环形缓冲
const LOG_MAX = 500;
function log(...a) {
    const line = `[${new Date().toLocaleTimeString()}] ${a.join(' ')}`;
    console.log(line);
    logBuffer.push(line);
    if (logBuffer.length > LOG_MAX) logBuffer.shift();
}

// ================= 回复处理管道 =================
function applyReplyProcessors(text, processors) {
    let out = String(text ?? '');
    for (const rule of processors) {
        if (rule.enabled === false) continue;   // 规则可禁用但不删除
        try {
            if (rule.type === 'replace' && rule.pattern) {
                out = out.replace(new RegExp(rule.pattern, rule.flags ?? 'g'), rule.replacement ?? '');
            } else if (rule.type === 'remove' && rule.pattern) {
                out = out.replace(new RegExp(rule.pattern, rule.flags ?? 'g'), '');
            } else if (rule.type === 'strip' && rule.begin && rule.end) {
                const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                out = out.replace(new RegExp(`${esc(rule.begin)}([\\s\\S]*?)${esc(rule.end)}`, 'g'),
                    rule.keep === true ? '$1' : '');
            }
        } catch (e) {
            log(`⚠ 回复处理规则错误 (${rule.type}):`, e.message);
        }
    }
    return out.trim();
}

// ================= 会话路由 =================
const sessionRoutes = new Map();      // sessionKey → {message_type, group_id, user_id}
const sessionStats = new Map();       // sessionKey → {in: n, out: n, last: ts}

function sessionKeyOf(message_type, group_id, user_id) {
    return message_type === 'group' ? `group_${group_id}_${user_id}` : `private_${user_id}`;
}

// ================= SnowLuma（上游） =================
let obSocket = null;
let echoSeq = 0;
let selfId = '';
const wsPending = new Map();

/** 上游连接指标（供总览页展示） */
const upstreamStats = {
    /** 当前是否已连接 */
    connected: false,
    /** 最近一次成功连接的时间戳 */
    connectedAt: 0,
    /** 最近一次断开的时间戳 */
    disconnectedAt: 0,
    /** 累计重连次数 */
    reconnectCount: 0,
    /** 最近一次错误信息 */
    lastError: '',
    lastErrorAt: 0,
    /** 收到的原始事件数 */
    eventsIn: 0,
    /** 发出的动作调用数 */
    actionsOut: 0,
    /** 动作失败数 */
    actionErrors: 0,
    /** 最近一次收到事件的时间戳 */
    lastEventAt: 0,
    /** 机器人昵称（若 upstream 提供） */
    nickname: '',
};

function connectOnebot() {
    const url = cfg.onebotToken
        ? `${cfg.onebotUrl}?access_token=${encodeURIComponent(cfg.onebotToken)}`
        : cfg.onebotUrl;
    log(`连接 SnowLuma: ${cfg.onebotUrl}`);
    obSocket = new WebSocket(url);

    obSocket.on('open', () => {
        upstreamStats.connected = true;
        upstreamStats.connectedAt = Date.now();
        upstreamStats.lastError = '';
        log('✓ 已连接 SnowLuma');
    });
    obSocket.on('message', (raw) => {
        let event;
        try { event = JSON.parse(raw.toString()); } catch { return; }
        if (event.echo && wsPending.has(event.echo)) {
            const { resolve, reject } = wsPending.get(event.echo);
            wsPending.delete(event.echo);
            if (event.status === 'failed') {
                upstreamStats.actionErrors += 1;
                reject(new Error(event.message ?? 'failed'));
            } else {
                resolve(event);
            }
            return;
        }
        upstreamStats.eventsIn += 1;
        upstreamStats.lastEventAt = Date.now();

        if (event.post_type === 'meta_event' && event.meta_event_type === 'lifecycle') {
            selfId = String(event.self_id ?? '');
            log('机器人 QQ:', selfId);
        }
        // 从消息事件里补充昵称（OneBot 标准字段）
        if (event.sender?.nickname && !upstreamStats.nickname) {
            upstreamStats.nickname = String(event.sender.nickname);
        }
        handleMessage(event);
    });
    obSocket.on('close', () => {
        upstreamStats.connected = false;
        upstreamStats.disconnectedAt = Date.now();
        upstreamStats.reconnectCount += 1;
        log('SnowLuma 断开，5 秒后重连…');
        setTimeout(connectOnebot, 5000);
    });
    obSocket.on('error', (e) => {
        upstreamStats.lastError = e.message;
        upstreamStats.lastErrorAt = Date.now();
        log('SnowLuma WS 错误:', e.message);
    });
}

function callOnebot(action, params) {
    return new Promise((resolve, reject) => {
        if (!obSocket || obSocket.readyState !== WebSocket.OPEN) {
            upstreamStats.actionErrors += 1;
            return reject(new Error('OneBot WS 未连接'));
        }
        const echo = `bridge_${++echoSeq}`;
        wsPending.set(echo, { resolve, reject });
        upstreamStats.actionsOut += 1;
        obSocket.send(JSON.stringify({ action, params, echo }));
        setTimeout(() => {
            if (wsPending.has(echo)) {
                wsPending.delete(echo);
                upstreamStats.actionErrors += 1;
                reject(new Error(`OneBot 动作超时: ${action}`));
            }
        }, 15000);
    });
}

/**
 * 按可配置的分隔规则切分长文本。
 *
 * 分隔层级：
 *   1. splitStrings  自定义字面量串（最高优先级，如换行、"||"）
 *   2. pairChars     配对符：*动作* / "台词" / “台词”
 *                    → 配对符本身就是分段边界（整段动作或台词成为一条消息）
 *   3. hardChars     句末标点 。！？!?…
 *   4. softChars     逗号类，仅在片段超长时二次切分
 *
 * 关键点：配对符内部的内容不会被句末标点切断，
 * 例如 *她抬起头。眼睛里闪着光。* 会保持为一个整体动作。
 */
function segmentText(text, opts = {}) {
    const {
        enabled = true,
        maxLen = 200,
        minLen = 8,
        maxSegments = 12,
        hardChars = '。！？!?…',
        softChars = '，,；;',
        pairChars = ['*', '"', '\u201c\u201d'],
        splitStrings = [],
        splitOnPairs = true,      // 配对符本身是否作为分段边界
        pairMinLen = 3,           // 配对符内容短于该长度时不独立成段（0=不限制）
        delayMs = [300, 900],
        keepDelimiter = true,
    } = opts;

    if (!enabled) return [{ text, delayMs: 0 }];
    const trimmed = (text ?? '').trim();
    if (!trimmed) return [];

    // ---------- 步骤 1：找出所有配对符区间的片段 ----------
    // 结果是一个 token 列表：{ text, isPair, pairIndex }
    // 配对符归一化：支持三种写法
    //   "**"            → [*, *]
    //   "“”"             → [“, ”]
    //   ["动作", "**"]   → [*, *]（带名称，便于界面展示）
    //   {name, pair}    → [*, *]
    const pairs = [];
    for (const raw of pairChars) {
        if (!raw) continue;
        let token = raw;
        if (Array.isArray(raw)) {
            token = raw[1] ?? raw[0];        // [名称, 符号]
        } else if (typeof raw === 'object') {
            token = raw.pair ?? raw.symbol ?? '';
        }
        if (typeof token !== 'string' || !token) continue;
        if (token.length >= 2) pairs.push([token[0], token[1]]);
        else pairs.push([token, token]);
    }

    // 统一用占位符标记配对段落
    const pairSegments = [];
    let work = trimmed;
    // 配对符「内容」的最小长度：内容过短时不独立成段。
    // 例如 AI 强调单字 `"菜"`，不应被切成单独一条消息。
    const minPairContent = Math.max(0, pairMinLen ?? 3);
    for (const [open, close] of pairs) {
        const esc = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(esc(open) + '[^' + esc(open) + esc(close) + ']*?' + esc(close), 'g');
        work = work.replace(re, (m) => {
            const contentLen = Math.max(0, m.length - open.length - close.length);
            if (minPairContent > 0 && contentLen < minPairContent) {
                // 太短：不占位保护，原样参与正常切分与合并
                return m;
            }
            const idx = pairSegments.length;
            pairSegments.push(m);
            return `\u0000P${idx}\u0000`;
        });
    }

    // ---------- 步骤 2：自定义分隔串（切出的片段即为最终边界） ----------
    const fixedChunks = [];   // 由 splitStrings 切出的不可跨越片段
    let chunks = [work];
    if (Array.isArray(splitStrings) && splitStrings.length) {
        for (const sep of splitStrings) {
            if (!sep) continue;
            const next = [];
            for (const c of chunks) {
                const parts = c.split(sep);
                for (let i = 0; i < parts.length; i++) {
                    const piece = parts[i] + (i < parts.length - 1 && keepDelimiter ? sep : '');
                    if (piece) next.push(piece);
                }
            }
            chunks = next;
        }
        // 全部标记为固定边界
        fixedChunks.push(...chunks);
        chunks = [];   // 不再参与 hardSplit 的跨段合并
    }

    // ---------- 步骤 3：按硬标点切分（占位符不受影响） ----------
    const hardSet = new Set([...hardChars, '\n']);
    const hardSplit = [];
    for (const chunk of chunks) {
        let buf = '';
        for (const ch of chunk) {
            buf += ch;
            if (hardSet.has(ch)) {
                hardSplit.push(buf);
                buf = '';
            }
        }
        if (buf.trim()) hardSplit.push(buf);
    }

    // ---------- 步骤 4：还原配对符，并可选地把它们拆成独立片段 ----------
    let pieces = [];
    // splitStrings 切出的片段直接作为独立段（不再被硬标点切分）
    for (const fc of fixedChunks) {
        pieces.push(fc.replace(/\u0000P(\d+)\u0000/g, (_, i) => pairSegments[Number(i)] ?? ''));
    }
    for (const piece of hardSplit) {
        if (!splitOnPairs) {
            pieces.push(piece.replace(/\u0000P(\d+)\u0000/g, (_, i) => pairSegments[Number(i)] ?? ''));
            continue;
        }
        // 占位符作为边界：拆成 [前文][配对][后文]
        const re = /\u0000P(\d+)\u0000/g;
        let last = 0;
        let m;
        while ((m = re.exec(piece)) !== null) {
            const before = piece.slice(last, m.index).trim();
            if (before) pieces.push(before);
            pieces.push(pairSegments[Number(m[1])] ?? '');
            last = m.index + m[0].length;
        }
        const after = piece.slice(last).trim();
        if (after) pieces.push(after);
    }

    // 标记：配对符片段 / splitStrings 片段 都不参与 minLen 合并
    const fixedSet = new Set(fixedChunks.map((c) => c.replace(/\u0000P(\d+)\u0000/g, (_, i) => pairSegments[Number(i)] ?? '').trim()));
    pieces = pieces
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => {
            const isPair = pairSegments.some((ps) => ps === p);
            const isFixed = fixedSet.has(p);
            return { text: p, isPair, isFixed };
        });

    // ---------- 步骤 5：超长片段按软标点二次切分 ----------
    const expanded = [];
    for (const piece of pieces) {
        const p = piece.text;
        if (p.length <= maxLen) {
            expanded.push(piece);
            continue;
        }
        const softSet = new Set([...softChars]);
        let buf = '';
        const subs = [];
        for (const ch of p) {
            buf += ch;
            if (softSet.has(ch)) { subs.push(buf); buf = ''; }
        }
        if (buf) subs.push(buf);

        let acc = '';
        for (const sub of subs) {
            if ((acc + sub).length > maxLen && acc) {
                expanded.push({ text: acc.trim(), isPair: false });
                acc = sub;
            } else {
                acc += sub;
            }
        }
        if (acc.trim()) expanded.push({ text: acc.trim(), isPair: false });
    }

    // ---------- 步骤 6：合并过短片段 ----------
    // 引导语模式：以冒号结尾的短文本（如 "她说："）应与后一个配对片段合并
    const isLeadIn = (t) => /[:：]\s*$/.test(t) && t.length <= 20;

    const merged = [];
    let acc = '';
    for (const item of expanded) {
        if (item.isPair) {
            if (acc && isLeadIn(acc)) {
                // 引导语 + 台词 合并成一段（更自然）
                merged.push(acc + item.text);
                acc = '';
            } else {
                if (acc) { merged.push(acc); acc = ''; }
                merged.push(item.text);
            }
            continue;
        }
        // splitStrings 切出的片段：独立成段，不合并
        if (item.isFixed) {
            if (acc) { merged.push(acc); acc = ''; }
            merged.push(item.text);
            continue;
        }
        if (!acc) {
            acc = item.text;
        } else if (acc.length < minLen) {
            acc += item.text;
        } else {
            merged.push(acc);
            acc = item.text;
        }
    }
    if (acc) merged.push(acc);

    // ---------- 步骤 7：限制条数 ----------
    // 策略：保序合并。分段结果按原顺序两两合并（相邻的合并，不重排、不丢弃），
    // 直到条数 ≤ maxSegments。优先合并纯文本对，其次才动配对片段。
    //
    // 早期实现把「超出的配对片段删掉再补到末尾」，会导致：
    //   ① 动作描写被挪到最后，与台词顺序错乱
    //   ② join('') 让相邻 * 粘成 **，QQ 里表现为星号重复
    // 现在改为就地合并，顺序与内容都保持不变。
    let result = merged;

    if (result.length > maxSegments) {
        const isSpecial = (t) => {
            if (pairSegments.includes(t)) return true;
            const p0 = t[0] ?? '';
            const p1 = t[t.length - 1] ?? '';
            return pairChars.some((pc) => {
                let token = pc;
                if (Array.isArray(pc)) token = pc[1] ?? pc[0];
                else if (typeof pc === 'object') token = pc?.pair ?? pc?.symbol ?? '';
                if (typeof token !== 'string' || !token) return false;
                const pair = token.length >= 2 ? [token[0], token[1]] : [token, token];
                return p0 === pair[0] && p1 === pair[1];
            });
        };

        // 合并相邻两项，用换行分隔，避免句首句尾粘连
        const joinTwo = (a, b) => `${a}\n${b}`;

        // 反复合并，直到条数满足要求或无法再合并
        while (result.length > maxSegments) {
            // 找第一个「两个都不是配对片段」的相邻位置优先合并
            let target = -1;
            for (let i = 0; i < result.length - 1; i++) {
                if (!isSpecial(result[i]) && !isSpecial(result[i + 1])) {
                    target = i;
                    break;
                }
            }
            // 没有纯文本对可合并时，退而求其次合并任意相邻对
            if (target < 0) {
                // 尽量选择合并后长度最小的一对，减少单条过长
                let bestLen = Infinity;
                for (let i = 0; i < result.length - 1; i++) {
                    const len = result[i].length + result[i + 1].length;
                    if (len < bestLen) {
                        bestLen = len;
                        target = i;
                    }
                }
            }
            if (target < 0) break;

            result = [
                ...result.slice(0, target),
                joinTwo(result[target], result[target + 1]),
                ...result.slice(target + 2),
            ];
        }
    }

    // ---------- 步骤 8：动作标记转换 + 长度兜底 + 随机延迟 ----------
    // 把 *动作描写* 转成 （动作描写），更符合 QQ 聊天习惯
    if (opts.convertActionMarkers !== false) {
        result = result.map((t) => convertActionMarkers(t));
    }

    result = result.map((t) => (t.length > cfg.maxMessageLength
        ? t.slice(0, cfg.maxMessageLength) + '…'
        : t));

    const [dMin, dMax] = delayMs;
    return result.map((t, i) => ({
        text: t,
        delayMs: i === 0 ? 0 : dMin + Math.floor(Math.random() * Math.max(1, dMax - dMin)),
    }));
}

/**
 * 把 *动作描写* 转成 （动作描写），更符合 QQ 聊天习惯。
 * 只转换成对出现的星号，且内容非空、不含未闭合星号。
 * 也支持中文全角星号 ＊。
 */
function convertActionMarkers(text) {
    let out = String(text ?? '');
    // 匹配 *内容*（非贪婪，内容不含星号，长度 1..200）
    out = out.replace(/\*([^*\n]{1,200}?)\*/g, '（$1）');
    out = out.replace(/＊([^＊\n]{1,200}?)＊/g, '（$1）');
    return out;
}

/** 发送一条消息（文本或消息段数组） */
async function sendOne(msg, payload) {
    const action = msg.message_type === 'group' ? 'send_group_msg' : 'send_private_msg';
    const params = msg.message_type === 'group'
        ? { group_id: msg.group_id, message: payload }
        : { user_id: msg.user_id, message: payload };
    await callOnebot(action, params);
}

async function sendQQ(msg) {
    const text = (msg.text ?? '').trim();
    if (!text) return;

    const target = msg.message_type === 'group' ? `群${msg.group_id}` : `私聊${msg.user_id}`;
    const segments = segmentText(text, cfg.segmentation ?? {});

    if (!segments.length) return;

    // 记录本轮表情决策，用于日志排查"为什么不发"
    const faceDecision = {
        hasMark: false,
        sent: 0,
        failed: 0,
        tokens: [],
    };

    try {
        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            if (seg.delayMs > 0) {
                await new Promise((r) => setTimeout(r, seg.delayMs));
            }
            // 检测消息里的图片标记，转成消息段
            // [表情:无语,委屈] → 本地库按多标签打分挑一张
            const payload = buildOutgoingPayload(seg.text, (token) => {
                try {
                    faceDecision.hasMark = true;
                    faceDecision.tokens.push(token);
                    if (!faces) return null;
                    // # 开头视为短 ID（兼容旧行为）
                    if (token.startsWith('#')) {
                        const hit = faces.store.pickById(token);
                        if (!hit) {
                            log(`  │  表情 ✗ [表情:${token}] 短 ID 不存在`);
                            faceDecision.failed += 1;
                            return null;
                        }
                        rememberFace(hit.md5.slice(0, 6));
                        log(`  │  表情 ✓ [表情:${token}] → ${hit.md5.slice(0, 6)}`);
                        faceDecision.sent += 1;
                        return hit.imageUrl ? absoluteFaceUrl(hit.imageUrl) : null;
                    }
                    // 标签：拆成数组，在本地库里挑最贴合的
                    const tags = splitFaceTags(token);
                    if (tags.length === 0) return null;

                    const r = faces.store.pickByTagsDetailed(tags, { exclude: recentMd5 });

                    if (!r.face) {
                        log(`  │  表情 ✗ ${r.reason || '无匹配'}`);
                        if (r.candidates.length > 0) {
                            for (const c of r.candidates) {
                                log(`  │    候选 ${c.md5} 分=${c.score} [${c.hitTags.join(',')}]`);
                            }
                        }
                        faceDecision.failed += 1;
                        return null;
                    }

                    rememberFace(r.face.md5.slice(0, 6));
                    recentMd5.push(r.face.md5);
                    while (recentMd5.length > 3) recentMd5.shift();
                    log(
                        `  │  表情 ✓ [表情:${token}] → ${r.face.md5.slice(0, 6)}`
                        + ` 分=${r.score} 命中=[${(r.hitTags ?? []).join(',')}]`
                        + ` 候选=${r.totalScored} 排除=${r.excluded}`,
                    );
                    if (r.candidates.length > 1) {
                        for (const c of r.candidates.slice(1)) {
                            log(`  │    次选 ${c.md5} 分=${c.score} [${c.hitTags.join(',')}]`);
                        }
                    }
                    faceDecision.sent += 1;
                    return r.face.imageUrl ? absoluteFaceUrl(r.face.imageUrl) : null;
                } catch (e) {
                    log(`  │  表情 ✗ 异常: ${e.message}`);
                    faceDecision.failed += 1;
                    return null;
                }
            });
            if (payload === '' || (Array.isArray(payload) && payload.length === 0)) {
                log(`分段 ${i + 1} 只有未命中的表情标记，跳过发送`);
                continue;
            }
            await sendOne(msg, payload);
            log(`分段 ${i + 1}/${segments.length} 已发往QQ → ${target} (${seg.text.length}字)`);
        }

        // 表情决策汇总：让"为什么没发表情"在日志里一目了然
        if (!faceDecision.hasMark) {
            log(
                `  └ 表情：本轮未发（AI 未生成表情标记）`
                + `｜库内 ${faceStatsSummary()}`,
            );
        } else if (faceDecision.sent === 0 && faceDecision.failed > 0) {
            log(
                `  └ 表情：本轮未发（${faceDecision.failed} 个标记全部未命中）`
                + `｜AI 给的标签 [${faceDecision.tokens.join(' | ')}]`,
            );
        } else {
            log(
                `  └ 表情：发出 ${faceDecision.sent} 个`
                + (faceDecision.failed ? `，失败 ${faceDecision.failed} 个` : '')
                + `｜标签 [${faceDecision.tokens.join(' | ')}]`,
            );
        }

        const st = sessionStats.get(msg.sessionKey);
        if (st) st.out++;
    } catch (e) {
        log(`QQ 发送失败(${target}):`, e.message);
    }
}

/** 表情库的一句话摘要，用于日志 */
function faceStatsSummary() {
    try {
        if (!faces) return '未初始化';
        const s = faces.stats();
        const m = faces.store.manifest();
        return `${s.total} 个 / 已标注 ${s.labeled} / 可用词 ${m.totalWords}`;
    } catch {
        return '读取失败';
    }
}

/**
 * 预演一次表情决策，不实际发送。
 *
 * 与 sendQQ 里的解析逻辑保持一致，但把过程摊开返回，
 * 便于前端/日志直接看到：命中什么、评分多少、为什么没中。
 */
function dryRunFaceDecision(text) {
    const result = {
        ok: true,
        input: text,
        hasMark: false,
        tokens: [],
        images: 0,
        details: [],
        segments: [],
        library: faceStatsSummary(),
    };

    try {
        const segs = buildOutgoingPayload(text, (token) => {
            result.hasMark = true;
            result.tokens.push(token);

            if (!faces) {
                result.details.push({ token, ok: false, reason: '表情库未初始化' });
                return null;
            }

            // 短 ID
            if (token.startsWith('#')) {
                const hit = faces.store.pickById(token);
                if (!hit) {
                    result.details.push({ token, ok: false, reason: `短 ID 不存在: ${token}` });
                    return null;
                }
                result.details.push({
                    token,
                    ok: true,
                    mode: 'id',
                    picked: hit.md5.slice(0, 6),
                    tags: [...hit.userTags, ...hit.aiTags],
                });
                return hit.imageUrl ? absoluteFaceUrl(hit.imageUrl) : null;
            }

            // 标签
            const tags = splitFaceTags(token);
            if (tags.length === 0) {
                result.details.push({ token, ok: false, reason: '标签为空' });
                return null;
            }

            const r = faces.store.pickByTagsDetailed(tags, { exclude: [] });
            if (!r.face) {
                result.details.push({
                    token,
                    ok: false,
                    mode: 'tag',
                    tags,
                    reason: r.reason || '无匹配',
                    candidates: r.candidates,
                });
                return null;
            }

            result.details.push({
                token,
                ok: true,
                mode: 'tag',
                tags,
                picked: r.face.md5.slice(0, 6),
                pickedTags: [...r.face.userTags, ...r.face.aiTags],
                score: r.score,
                hitTags: r.hitTags,
                totalScored: r.totalScored,
                excluded: r.excluded,
                candidates: r.candidates,
            });
            return r.face.imageUrl ? absoluteFaceUrl(r.face.imageUrl) : null;
        });

        if (typeof segs === 'string') {
            result.segments = [{ type: 'text', text: segs }];
        } else {
            result.segments = segs.map((s) =>
                s.type === 'text' ? { type: 'text', text: s.data.text } : { type: 'image' },
            );
            result.images = segs.filter((s) => s.type === 'image').length;
        }

        // 一句话结论，直接给日志/前端展示
        if (!result.hasMark) {
            result.verdict = `本轮未发：AI 未生成表情标记（${result.library}）`;
        } else if (result.images === 0) {
            result.verdict = `本轮未发：${result.details.length} 个标记全部未命中`;
        } else {
            result.verdict = `发出 ${result.images} 张`;
        }
    } catch (e) {
        result.ok = false;
        result.error = e.message;
    }

    return result;
}

/**
 * 最近发送过的表情（短 ID）。
 *
 * 用途：避免 AI 在连续几条消息里重复用同一张。
 * AI 自己记不住上一轮发了什么，所以由 Bridge 记录再随清单下发。
 */
const recentFaces = [];
const RECENT_FACES_MAX = 3;
/** 最近发过的表情 md5，用于挑图去重 */
const recentMd5 = [];

function rememberFace(id) {
    const v = String(id ?? '').replace(/^#/, '');
    if (!v) return;
    const i = recentFaces.indexOf(v);
    if (i >= 0) recentFaces.splice(i, 1);
    recentFaces.push(v);
    while (recentFaces.length > RECENT_FACES_MAX) recentFaces.shift();
}

/**
 * 表情库的提示词用清单。
 *
 * 关键设计：只下发「词表」，不下发「全部表情」。
 *
 *   旧方案（全量清单）：每个表情约 55 字符
 *     11 个 → 607 字符
 *     100 个 → 5518 字符   ← 已经过大
 *     1000 个 → 55182 字符 ← 完全不可用
 *
 *   新方案（动态词表）：约 750 字符，与库大小无关
 *     且词表取自「预设词表 ∩ 库内实际标签」，
 *     保证 AI 说出的每个词都真能挑到图。
 *
 * AI 只负责根据对话生成标签，例如 [表情:无语,委屈]，
 * 由 Bridge 在本地表情库里检索并挑一张。这样：
 *   - 提示词体积恒定，库再大也不怕
 *   - AI 不需要「看过」每张图，只需理解情绪
 *   - 挑选逻辑留在本地，可加打分、去重等策略
 */
function faceTagManifest() {
    try {
        if (!faces) return { vocab: {}, totalWords: 0, total: 0, labeled: 0, recent: [] };
        const m = faces.store.manifest();
        return {
            ...m,
            // 最近发过的标签，避免连续重复
            recent: [...recentFaces],
        };
    } catch {
        return { vocab: {}, totalWords: 0, total: 0, labeled: 0, recent: [] };
    }
}

/**
 * 表情图片的对外地址。
 *
 * 本地缓存的图片是相对路径（/faces/cache/xxx.jpg），
 * QQ 客户端无法访问 localhost，因此需要：有原图 URL 时优先用 QQ CDN 直链，
 * 否则才回落到本地缓存地址。
 */
function absoluteFaceUrl(faceOrUrl) {
    const item = typeof faceOrUrl === 'string' ? null : faceOrUrl;
    // 优先使用 QQ 原始 URL（公网可达，QQ 能直接下载）
    if (item?.url) return item.url;
    const rel = typeof faceOrUrl === 'string' ? faceOrUrl : item?.imageUrl;
    if (!rel) return null;
    if (/^https?:/i.test(rel)) return rel;
    // 本地缓存不可用于 QQ，返回 null 由调用方丢弃
    return null;
}

/**
 * 把文本里的图片标记转成 OneBot 消息段。
 * 支持形式：
 *   [img:https://...]  [image:https://...]  [图片:https://...]  直链
 *   [表情:开心]                                                标签，按表情库检索
 *   <img src="...">                                            （从酒馆 HTML 里抓）
 *
 * 标签解析失败时静默丢弃该标记，避免把 `[表情:开心]` 原文发给用户。
 */
function buildOutgoingPayload(text, resolveFace) {
    // 支持的写法：
    //   [表情:无语]            单标签
    //   [表情:无语,委屈]        多标签（逗号分隔，按贴切度排序）
    //   [表情:无语 委屈]        多标签（空格分隔）
    //   [表情:#abc123]          短 ID 精确选择（保留兼容）
    //   [图片:URL]              直链
    // 注意：标签里可能含中文逗号、句号，因此不能用 \S+ 粗暴截断
    const imgRe = /\[(?:img|image|图片|表情)[:：]\s*([^\]]+?)\s*\]/gi;
    const imgSrcRe = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
    const urlLike = /^(https?:|data:|file:|\/\/|\.\/|\/)/i;

    const found = [];
    let m;
    while ((m = imgRe.exec(text)) !== null) {
        const value = (m[1] ?? '').trim();
        if (!value) continue;
        found.push({
            index: m.index,
            len: m[0].length,
            value,
            kind: urlLike.test(value) ? 'url' : 'face',
        });
    }
    while ((m = imgSrcRe.exec(text)) !== null) {
        const value = (m[1] ?? '').trim();
        if (!value) continue;
        found.push({ index: m.index, len: m[0].length, value, kind: 'url' });
    }

    if (!found.length) return text;   // 纯文本

    found.sort((a, b) => a.index - b.index);

    const segs = [];
    let cursor = 0;

    for (const f of found) {
        if (f.index > cursor) {
            const t = text.slice(cursor, f.index).trim();
            if (t) segs.push({ type: 'text', data: { text: t } });
        }

        let url = null;
        if (f.kind === 'url') {
            url = f.value;
        } else if (typeof resolveFace === 'function') {
            try {
                url = resolveFace(f.value);
            } catch {
                url = null;
            }
            if (url) {
                log(`表情已解析：[表情:${f.value}] → ${String(url).slice(0, 60)}…`);
            } else {
                log(`⚠ 表情未命中，已丢弃：[表情:${f.value}]`);
            }
        }

        if (url) segs.push({ type: 'image', data: { file: url } });
        cursor = f.index + f.len;
    }

    // 一条消息里最多 3 张表情，超出的静默丢弃，避免刷屏
    const images = segs.filter((s) => s.type === 'image').length;
    if (images > 3) {
        log(`⚠ 单条消息含 ${images} 张表情，已裁剪到 3 张`);
        let kept = 0;
        for (let i = 0; i < segs.length; i += 1) {
            if (segs[i].type !== 'image') continue;
            kept += 1;
            if (kept > 3) {
                segs.splice(i, 1);
                i -= 1;
            }
        }
    }

    const tail = text.slice(cursor).trim();
    if (tail) segs.push({ type: 'text', data: { text: tail } });

    return segs.length > 0 ? segs : '';
}

/** 把 "[表情:无语,委屈]" 里的值拆成标签数组 */
function splitFaceTags(value) {
    return String(value ?? '')
        .split(/[,，、\s/|]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 4);
}

function parseMessage(message) {
    if (typeof message === 'string') return { text: message, atMe: false };
    let text = '';
    let atMe = false;
    for (const seg of message) {
        if (seg.type === 'text') text += seg.data?.text ?? '';
        if (seg.type === 'at') atMe = atMe || String(seg.data?.qq) === String(selfId);
        if (seg.type === 'image') text += '[图片]';
        if (seg.type === 'face') text += `[表情${seg.data?.id ?? ''}]`;
    }
    return { text: text.trim(), atMe };
}

function handleMessage(event) {
    // 好友申请/群邀请等请求事件：忽略（不作为聊天消息转发）
    if (event.request_type) {
        log(`忽略请求事件: ${event.request_type} from ${event.user_id}`);
        return;
    }
    if (event.post_type !== 'message' || event.sub_type === 'bot') return;
    if (String(event.user_id) === String(selfId)) return;

    const message_type = event.message_type;
    const group_id = event.group_id ?? null;
    const user_id = event.user_id;

    // 触发规则：群里仅 @ / 私聊开关 / 用户与群白名单
    // 酒馆与 dsh 两条链路共用同一套规则，避免"切了后端就绕过限制"
    const trigger = { ...DEFAULT_CONFIG.trigger, ...(cfg.trigger ?? {}) };
    const allowedGroups = Array.isArray(trigger.allowedGroups) ? trigger.allowedGroups : [];
    const allowedUsers = Array.isArray(trigger.allowedUsers) ? trigger.allowedUsers : [];
    if (
        message_type === 'group' &&
        allowedGroups.length > 0 &&
        !allowedGroups.some((g) => String(g) === String(group_id))
    ) {
        return;
    }
    if (
        allowedUsers.length > 0 &&
        !allowedUsers.some((u) => String(u) === String(user_id))
    ) {
        return;
    }
    if (message_type === 'private' && trigger.privateReply === false) return;

    const { text, atMe } = parseMessage(event.message);
    if (!text) return;
    if (message_type === 'group' && trigger.atOnly && !atMe) return;

    const key = sessionKeyOf(message_type, group_id, user_id);
    const senderName = event.sender?.card || event.sender?.nickname || String(user_id);

    sessionRoutes.set(key, { message_type, group_id, user_id, sessionKey: key });
    if (!sessionStats.has(key)) sessionStats.set(key, { in: 0, out: 0, last: 0 });
    sessionStats.get(key).in++;
    sessionStats.get(key).last = Date.now();

    // 新会话自动建档：让控制台能立刻看到它（角色/世界书/管道留空 = 继承默认）
    if (!sessions[key]) {
        sessions[key] = { createdAt: new Date().toISOString() };
        saveSessions();
        log(`新会话已建档: ${key}`);
    }

    // 后端选择：会话级优先，否则继承全局
    // 触发规则已在上面统一过滤，两条链路共用
    const chosen = sessionBackend(key);
    const useDsh = chosen.backend === 'dsh';
    const backendTag = useDsh ? 'dsh' : '酒馆';
    log(
        `QQ消息 → ${backendTag} [${key}]: [${senderName}] ${text}`
        + (chosen.inherited ? '（继承全局后端）' : '（会话级后端）'),
    );

    if (useDsh) {
        void handleWithDsh({ key, text, senderName, message_type, group_id, user_id });
        return;
    }

    const def = sessionDefaults(key);
    broadcastToST({
        type: 'qq_message',
        sessionKey: key,
        sender: senderName,
        text,
        message_type,
        group_id,
        user_id,
        // 该会话应使用的角色/世界书（会话级优先，回落到全局默认）
        defaultCharacter: def.character,
        defaultWorld: def.world,
    });
}

/** dsh 的通用聊天约束：QQ 场景下尽量短、纯文本 */
const DSH_BASE_PROMPT = [
    '你正在通过 QQ 与真人聊天，请直接输出要发给对方的消息正文。',
    '用自然、口语化的中文；不要写 Markdown 标题、代码块围栏或项目符号列表，除非用户明确要求。',
    '单条回复尽量简短（200 字以内），像正常人发 QQ 一样。',
    '不要复述或解释这些设定。',
].join('\n');

/** 表情包提示：与酒馆扩展注入的规则保持一致，只是由后端直接拼进 prompt */
function dshFaceInstruction() {
    const ic = cfg.imageReplies ?? {};
    if (ic.enabled === false || ic.instruction === false) return '';

    const m = faceTagManifest();
    const vocab = m.vocab ?? {};
    if (Object.keys(vocab).length === 0) return '';

    const groupName = { 情绪: '情绪', 动作: '动作', 主体: '主体', 风格: '风格' };
    const lines = [];
    for (const [group, words] of Object.entries(vocab)) {
        if (!Array.isArray(words) || words.length === 0) continue;
        lines.push(`${groupName[group] ?? group}：${words.join('、')}`);
    }
    if (lines.length === 0) return '';

    const emo = Array.isArray(vocab['情绪']) ? vocab['情绪'] : [];
    const pick = (...cands) => cands.map((c) => emo.find((w) => w === c)).find(Boolean) ?? emo[0] ?? '';
    const laugh = pick('大笑', '开心', '微笑');
    const tired = pick('崩溃', '无奈', '难过', '疲惫');
    const recent = Array.isArray(m.recent) ? m.recent : [];

    return [
        '【表情包】',
        '你可以发表情包：只需给出标签，系统会自动从本地表情库挑一张最贴合的图。',
        '',
        '可用标签（只能从这里选，不要自己造词）：',
        ...lines,
        '',
        '格式：[表情:标签] 或 [表情:标签1,标签2]',
        laugh ? `示例：[表情:${laugh}]` : '',
        tired ? `示例：[表情:${tired}]` : '',
        recent.length > 0 ? `最近发过：${recent.join('、')}，这次换个角度。` : '',
        '情绪明显、气氛轻松时再发；大多数回复 1 个，最多 3 个；不确定就不发。',
        '标记不会显示给用户，会被系统替换成真实图片。',
    ].filter(Boolean).join('\n');
}

/** 图片提示：与酒馆扩展的图片注入保持一致 */
function dshImageInstruction() {
    const ic = cfg.imageReplies ?? {};
    if (ic.enabled === false || ic.instruction === false) return '';
    const base = String(ic.baseUrl ?? '').trim();
    return [
        '【图片】',
        '需要配图时可以在回复里插入 [图片:公网可访问的图片URL]，客户端会渲染成图片消息。',
        base ? `图片库根地址：${base}（可直接拼接文件名）` : '',
        '不要编造没把握的图片链接；不确定就不配图。',
    ].filter(Boolean).join('\n');
}

/** 每条 QQ 消息调用 dsh 时附带的系统设定 */
function dshSystemPrompt(sessionKey) {
    const parts = [DSH_BASE_PROMPT];

    // 会话级 / 全局默认角色：给 dsh 一个身份，否则它只会用"助手"口吻
    const def = sessionKey ? sessionDefaults(sessionKey) : { character: '', world: '' };
    if (def.character) {
        parts.push(
            `【角色】你在扮演「${def.character}」，用第一人称以这个角色的口吻说话。`
            + (def.world ? `\n背景设定：${def.world}（不需要逐条复述，自然地体现即可）。` : ''),
        );
    }

    const extra = String(cfg.dshSystemPrompt ?? '').trim();
    if (extra) parts.push(`【补充设定】\n${extra}`);
    const face = dshFaceInstruction();
    if (face) parts.push(face);
    const img = dshImageInstruction();
    if (img) parts.push(img);
    return parts.join('\n\n');
}

/** 把 dsh 的最终文本走完「处理管道 → 分段/表情 → QQ」 */
async function deliverDshReply({ key, reply, route, elapsedMs, via }) {
    const text = String(reply ?? '').trim();
    if (!text) {
        log(`dsh 返回空回复 [${key}]`);
        return;
    }
    log(`dsh 原始回复 [${key}]：${text.slice(0, 80)}（${(elapsedMs / 1000).toFixed(1)}s，${via}）`);

    // 与酒馆回复保持一致：会话级管道优先，否则用全局管道
    const sessionRules = sessions[key]?.replyProcessors;
    const rules = Array.isArray(sessionRules) ? sessionRules : (cfg.replyProcessors ?? []);
    const processed = applyReplyProcessors(text, rules);
    if (!processed) {
        log('dsh 回复经规则处理后为空，不发送');
        return;
    }

    // 复用既有发送链路（分段、表情解析、图片下发、会话统计）
    await sendQQ({ ...route, text: processed, sessionKey: key });
}

/** 当前是否有 dsh 连接插件在线（插件链路优先于 headless 子进程） */
function dshPluginOnline() {
    if (cfg.dshPluginEnabled === false) return false;
    for (const s of dshPluginClients) {
        if (s.readyState === WebSocket.OPEN) return true;
    }
    return false;
}

/** 取一个在线的插件连接（多开时用第一个） */
function pickDshPlugin() {
    for (const s of dshPluginClients) {
        if (s.readyState === WebSocket.OPEN) return s;
    }
    return null;
}

/**
 * 走 dsh 处理一条 QQ 消息。
 *
 * 两种传输，回复处理完全一致：
 *   1. 连接插件在线 → 通过 WS 把消息投给 dsh 进程内的插件（常驻、无需起进程）
 *   2. 否则 → 起一次性 `dsh --profile headless` 子进程（原有行为）
 *
 * 与酒馆链路共用触发规则、会话路由、回复处理管道、表情解析与分段。
 */
async function handleWithDsh({ key, text, senderName, message_type, group_id, user_id }) {
    const route = sessionRoutes.get(key) ?? { message_type, group_id, user_id, sessionKey: key };

    // 群聊里带一句发送者，方便模型区分是谁在说话（sessionKey 本身已按人隔离）
    const userText = message_type === 'group' ? `[群成员 ${senderName}] ${text}` : text;

    // ---------- 路径 1：连接插件 ----------
    const plugin = pickDshPlugin();
    if (plugin) {
        const sent = await askDshPlugin(plugin, { sessionKey: key, text: userText });
        if (!sent.ok) {
            log(`dsh 插件投递失败 [${key}]：${sent.error}，回落到 headless`);
        } else {
            return;
        }
    }

    // ---------- 路径 2：headless 子进程 ----------
    if (!dsh) {
        log(`dsh 未初始化，无法处理 [${key}]`);
        return;
    }

    const r = await dsh.ask({ sessionKey: key, text: userText, system: dshSystemPrompt(key) });

    if (!r.ok) {
        log(`dsh 回复失败 [${key}]: ${r.error}`);
        // 可选：失败时回一句提示，避免用户干等（默认静默，只写日志）
        const fallback = String(cfg.dshErrorReply ?? '').trim();
        if (fallback) {
            await sendQQ({ ...route, text: fallback, sessionKey: key });
        }
        return;
    }

    await deliverDshReply({ key, reply: r.text, route, elapsedMs: r.elapsedMs, via: 'headless' });
}

/** 等待插件回包的挂起表：requestId → { resolve, timer } */
const dshPluginPending = new Map();
let dshPluginReqSeq = 0;

/** 通过插件连接投递一条消息，并在超时前等回复 */
function askDshPlugin(socket, { sessionKey, text }) {
    return new Promise((resolve) => {
        const requestId = `dsh_${++dshPluginReqSeq}`;
        const timeoutMs = Number(cfg.dshTimeoutMs ?? 180000);
        const timer = setTimeout(() => {
            if (!dshPluginPending.has(requestId)) return;
            dshPluginPending.delete(requestId);
            resolve({ ok: false, error: `插件 ${Math.round(timeoutMs / 1000)}s 内未回复` });
        }, timeoutMs);
        dshPluginPending.set(requestId, { resolve, timer, socket, sessionKey });
        try {
            socket.send(JSON.stringify({
                type: 'dsh_ask',
                requestId,
                sessionKey,
                text,
                // 会话级角色/世界书以系统提示形式带给插件侧 Agent
                system: dshSystemPrompt(sessionKey),
            }));
        } catch (e) {
            clearTimeout(timer);
            dshPluginPending.delete(requestId);
            resolve({ ok: false, error: e.message });
        }
    });
}

/** 处理来自 dsh 连接插件的消息 */
function handleDshPluginMessage(socket, msg) {
    if (msg.type === 'dsh_hello') {
        if (cfg.dshPluginToken && String(msg.token ?? '') !== String(cfg.dshPluginToken)) {
            log('⚠ dsh 插件握手被拒绝：token 不匹配');
            try { socket.close(); } catch { /* 忽略 */ }
            return;
        }
        socket.meta.kind = 'dsh-plugin';
        socket.meta.dshProfile = msg.profile ?? '';
        socket.meta.dshVersion = msg.version ?? '';
        socket.meta.dshPid = Number(msg.pid) || 0;
        dshPluginClients.add(socket);
        if (cfg.dshPluginEnabled === false) {
            log('⚠ dsh 插件已连接，但配置里关闭了插件链路（dshPluginEnabled=false），仍按 headless 处理');
        }
        log(
            `dsh 连接插件已接入（pid ${msg.pid ?? '?'}${msg.profile ? `，profile=${msg.profile}` : ''}，`
            + `已有会话 ${(msg.sessions ?? []).length} 个）→ dsh 消息改走插件链路`,
        );
        try {
            socket.send(JSON.stringify({ type: 'dsh_hello_ack', server: 'snowluma-bridge' }));
        } catch { /* 忽略 */ }
        return;
    }

    if (msg.type === 'pong') return;

    if (msg.type === 'dsh_reply' || msg.type === 'dsh_error') {
        const record = dshPluginPending.get(msg.requestId);
        if (!record) {
            // 没有等待者（可能超时后才有结果）：只记日志
            log(`dsh 插件回包无等待者（${msg.requestId ?? '无 requestId'}），已忽略`);
            return;
        }
        clearTimeout(record.timer);
        dshPluginPending.delete(msg.requestId);

        if (msg.type === 'dsh_error') {
            record.resolve({ ok: false, error: msg.error || '插件侧处理失败' });
            log(`dsh 插件处理失败 [${msg.sessionKey}]：${msg.error}`);
            return;
        }

        record.resolve({ ok: true, text: msg.text, elapsedMs: Number(msg.elapsedMs) || 0 });
        // 直接在这里发回 QQ，链路与 headless 完全一致
        const key = msg.sessionKey || record.sessionKey;
        const route = sessionRoutes.get(key);
        if (!route) {
            log(`⚠ dsh 插件回复无法路由（sessionKey=${key}），已丢弃`);
            return;
        }
        void deliverDshReply({
            key,
            reply: msg.text,
            route,
            elapsedMs: Number(msg.elapsedMs) || 0,
            via: 'plugin',
        });
        return;
    }

    if (msg.type === 'dsh_reset_ack') {
        log(`dsh 插件：已清空上下文 [${msg.sessionKey}]${msg.existed ? '' : '（原本为空）'}`);
    }
}

// ================= 酒馆扩展（下游） =================
/** @type {Set<WebSocket>} */
const stClients = new Set();

/** 从扩展上报的角色/世界书清单（控制台下拉用） */
const catalogs = { characters: [], worlds: [], updatedAt: null };

/**
 * 推断 SillyTavern 数据目录。
 * 优先环境变量 ST_DATA_DIR，其次在常见位置查找 data/default-user。
 * 未找到时返回 null（由调用方跳过扫描）。
 */
function detectStDataDir() {
    return detectStDataDirQuiet();
}

/**
 * 直接扫描 SillyTavern 数据目录，得到角色/世界书清单。
 * 作为扩展上报的兜底（扩展未上报或酒馆未刷新时也能用）。
 */
function scanStCatalog() {
    // 优先使用配置；未配置时尝试从环境变量 / 常见安装位置推断
    const stData = cfg.stDataDir || detectStDataDir();
    const out = { characters: [], worlds: [], updatedAt: new Date().toISOString() };
    if (!stData) {
        log('⚠ 未配置 stDataDir，跳过本地清单扫描（可在系统设置中指定酒馆数据目录）');
        return out;
    }
    try {
        const charDir = path.join(stData, 'characters');
        for (const f of fs.readdirSync(charDir)) {
            if (/\.(png|json)$/i.test(f)) {
                out.characters.push(f.replace(/\.(png|json)$/i, ''));
            }
        }
    } catch (e) {
        log('⚠ 扫描角色目录失败:', e.message);
    }
    try {
        const worldDir = path.join(stData, 'worlds');
        for (const f of fs.readdirSync(worldDir)) {
            if (/\.json$/i.test(f)) out.worlds.push(f.replace(/\.json$/i, ''));
        }
    } catch (e) {
        log('⚠ 扫描世界书目录失败:', e.message);
    }
    out.characters = [...new Set(out.characters)].sort();
    out.worlds = [...new Set(out.worlds)].sort();
    return out;
}

/** 合并磁盘扫描结果与扩展上报结果 */
function refreshCatalogsFromDisk() {
    const disk = scanStCatalog();
    // 扩展上报的更权威（有真实角色名），磁盘扫描作为补充
    const chars = new Set([...(catalogs.characters ?? []), ...disk.characters]);
    const worlds = new Set([...(catalogs.worlds ?? []), ...disk.worlds]);
    catalogs.characters = [...chars].sort();
    catalogs.worlds = [...worlds].sort();
    catalogs.updatedAt = disk.updatedAt;
}

function broadcastToST(obj) {
    const data = JSON.stringify(obj);
    for (const c of stClients) {
        if (c.readyState === WebSocket.OPEN) c.send(data);
    }
}

const wss = new WebSocketServer({ host: '127.0.0.1', port: cfg.stExtPort });
wss.on('listening', () => log(`酒馆扩展 WS 服务已启动: ws://127.0.0.1:${cfg.stExtPort}`));
wss.on('connection', (socket) => {
    stClients.add(socket);
    socket.isAlive = true;
    socket.meta = { connectedAt: Date.now(), ext: '', version: '', lastPingAt: 0 };
    socket.on('pong', () => { socket.isAlive = true; });
    log(`酒馆扩展已接入（当前 ${stClients.size} 个连接）`);
    socket.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type === 'ping') {           // 扩展心跳：原样回 pong（复用 message 通道）
            socket.meta.lastPingAt = Date.now();
            try { socket.send(JSON.stringify({ type: 'pong' })); } catch { /* 忽略 */ }
            return;
        }
        // ---------- dsh 连接插件（常驻在 dsh 进程内） ----------
        if (String(msg.type ?? '').startsWith('dsh_')) {
            handleDshPluginMessage(socket, msg);
            return;
        }
        if (msg.type === 'ext_log') {        // 扩展内部日志：写入控制台便于排查
            log(msg.text ?? '[EXT] (空)');
            return;
        }
        if (msg.type === 'st_reply') {
            let key = msg.sessionKey;
            // 兜底：扩展未携带 sessionKey（旧版本）时路由到最近活跃的会话
            if (!key || !sessionRoutes.has(key)) {
                const lastActive = [...sessionStats.entries()]
                    .sort((a, b) => b[1].last - a[1].last)[0];
                if (lastActive) {
                    log(`⚠ 回复缺少有效 sessionKey(${key ?? '缺失'})，兜底路由到最近会话 ${lastActive[0]}`);
                    key = lastActive[0];
                } else {
                    log(`⚠ 无法路由的回复（sessionKey=${key ?? '缺失'}），已丢弃`);
                    return;
                }
            }
            const route = sessionRoutes.get(key);
            // 三层策略：会话级独立配置 > 全局默认
            //   sessions[key].replyProcessors === undefined/null → 继承全局
            //   sessions[key].replyProcessors 为数组（含 []）      → 该会话独立使用
            const sessionRules = sessions[key]?.replyProcessors;
            const rules = Array.isArray(sessionRules)
                ? sessionRules
                : (cfg.replyProcessors ?? []);
            const source = Array.isArray(sessionRules) ? '会话级' : '全局';
            if (rules.length) log(`处理管道来源: ${source} (${rules.length} 条规则)`);
            const processed = applyReplyProcessors(msg.text, rules);
            if (!processed) { log('回复经规则处理后为空，不发送'); return; }
            sendQQ({ ...route, text: processed, sessionKey: key });
        } else if (msg.type === 'command_reply') {
            // / 指令结果：不经过处理管道，直接回发
            let key = msg.sessionKey;
            if (!key || !sessionRoutes.has(key)) {
                const lastActive = [...sessionStats.entries()].sort((a, b) => b[1].last - a[1].last)[0];
                if (lastActive) key = lastActive[0];
                else { log('⚠ 指令回复无法路由，丢弃'); return; }
            }
            sendQQ({ ...sessionRoutes.get(key), text: msg.text, sessionKey: key });
        } else if (msg.type === 'hello') {
            socket.meta.ext = msg.ext ?? 'unknown';
            socket.meta.version = msg.version ?? '';
            log(`酒馆扩展握手: ${msg.ext ?? 'unknown'} v${msg.version ?? '?'}`);
            // 握手时把会话持久化数据和默认配置同步给扩展（扩展据此做默认选择）
            try {
                socket.send(JSON.stringify({
                    type: 'session_state',
                    sessions,
                    defaults: cfg.defaults ?? {},
                    imageReplies: cfg.imageReplies ?? {},
                    // 表情库标签清单（供提示词注入，只有标签和数量，不含 URL）
                    faceTags: faceTagManifest(),
                }));
                // 主动索要角色/世界书清单（扩展可能还没加载完，随后会重试）
                socket.send(JSON.stringify({ type: 'sync_request' }));
            } catch { /* 忽略 */ }
        } else if (msg.type === 'session_selected') {
            // 扩展上报：某会话切换了角色/世界书 → 持久化
            const { sessionKey, character, world } = msg;
            if (sessionKey) {
                rememberSession(sessionKey, {
                    ...(character !== undefined ? { character } : {}),
                    ...(world !== undefined ? { world } : {}),
                });
                log(`会话选择已持久化 [${sessionKey}]: 角色=${character ?? '-'} 世界书=${world ?? '-'}`);
            }
        } else if (msg.type === 'catalog') {
            // 扩展上报角色/世界书清单，供控制台下拉选择
            catalogs.characters = msg.characters ?? catalogs.characters;
            catalogs.worlds = msg.worlds ?? catalogs.worlds;
            catalogs.updatedAt = new Date().toISOString();
            log(`收到清单: ${catalogs.characters.length} 个角色 / ${catalogs.worlds.length} 个世界书`);
        }
    });
    socket.on('close', () => {
        const wasPlugin = dshPluginClients.delete(socket);
        stClients.delete(socket);
        if (wasPlugin) {
            log(`dsh 连接插件已断开（剩余 ${dshPluginClients.size}）→ 无插件时自动回落到 headless`);
            return;
        }
        log(`酒馆扩展断开（剩余 ${stClients.size}）`);
    });
});

// ================= Web API =================
// 说明：内置控制台网页（旧版 PAGE 模板）已弃用并移除。
// 管理界面由 apps/web（Vue 3）提供，本服务只暴露 /api/* 接口。

// ================= 表情库 =================
// 延迟初始化：sendQQ 里可能较早引用它，用 let 占位避免暂时性死区。
// 数据目录优先用环境变量（生产建议放到 D:\WorkSpace\Ollama 同级），
// 否则回落到服务目录下的 data/faces。
const FACES_DATA_DIR = process.env.BRIDGE_FACES_DIR
    ? path.resolve(process.env.BRIDGE_FACES_DIR)
    : path.resolve(__dirname, 'data', 'faces');
let faces = null;
faces = new FaceService({
    dataDir: FACES_DATA_DIR,
    callOnebot,
    log,
    // 表情库变化（同步/打标/改标签）后，主动刷新酒馆扩展的提示词清单
    onChanged: (reason) => {
        try {
            broadcastToST({
                type: 'session_state',
                sessions,
                defaults: cfg.defaults ?? {},
                imageReplies: cfg.imageReplies ?? {},
                faceTags: faceTagManifest(),
            });
            log(`表情库已更新（${reason}），提示词清单已推送给酒馆`);
        } catch {
            /* 扩展未连接时忽略 */
        }
    },
    ollama: {
        baseUrl: cfg.ollamaBaseUrl ?? 'http://127.0.0.1:11434',
        visionModel: cfg.ollamaVisionModel ?? 'qwen2.5vl:3b',
        textModel: cfg.ollamaTextModel ?? '',
        timeoutMs: 120000,
    },
});

// ================= Ollama 管理 =================
// 只负责调用已安装的 Ollama，不负责安装。
// 服务未启动时可用配置里的 ollamaExePath 一键拉起。
const ollamaClient = new OllamaClient({
    baseUrl: cfg.ollamaBaseUrl ?? 'http://127.0.0.1:11434',
    timeoutMs: 60000,
});
const ollamaDaemon = new OllamaDaemon({
    exePath: cfg.ollamaExePath ?? '',
    baseUrl: cfg.ollamaBaseUrl ?? 'http://127.0.0.1:11434',
    modelsDir: cfg.ollamaModelsDir ?? '',
    log,
});

/** 前端改配置后，让客户端与守护进程立即跟上 */
function applyOllamaConfig() {
    ollamaClient.baseUrl = String(cfg.ollamaBaseUrl ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
    ollamaDaemon.baseUrl = ollamaClient.baseUrl;
    ollamaDaemon.exePath = cfg.ollamaExePath ?? '';
    ollamaDaemon.modelsDir = cfg.ollamaModelsDir ?? '';
    // 打标器与管理页共用同一套地址/模型
    faces.labeler.reconfigure({
        baseUrl: ollamaClient.baseUrl,
        visionModel: cfg.ollamaVisionModel ?? 'qwen2.5vl:3b',
        textModel: cfg.ollamaTextModel ?? '',
    });
}
applyOllamaConfig();

// ================= dsh（DeepSeek Harness）=================
// 延迟初始化：handleWithDsh 可能较早引用它，用 let 占位避免暂时性死区。
let dsh = null;
/** 上下文落盘位置：与 config.json 同目录，随仓库数据一起保留 */
const DSH_HISTORY_PATH = path.join(__dirname, 'dsh-history.json');
function buildDsh() {
    return new DshClient({
        exePath: cfg.dshExePath ?? '',
        profile: cfg.dshProfile ?? 'headless',
        workRoot: cfg.dshWorkRoot ?? '',
        timeoutMs: Number(cfg.dshTimeoutMs ?? 180000),
        historyTurns: Number(cfg.dshHistoryTurns ?? 6),
        historyFile: cfg.dshPersistHistory === false ? '' : DSH_HISTORY_PATH,
        concurrency: Number(cfg.dshConcurrency ?? 1),
        log,
    });
}
dsh = buildDsh();

/** dsh 常驻服务 + 连接插件注入 */
const DSH_PLUGIN_SOURCE_DIR = path.resolve(__dirname, '..', 'dsh-plugin');
const DSH_SERVICE_LOG = path.join(os.tmpdir(), 'snowluma-dsh-service.log');
let dshService = null;
function buildDshService() {
    return new DshService({
        exePath: cfg.dshExePath ?? '',
        profile: cfg.dshServiceProfile ?? 'web',
        host: '127.0.0.1',
        port: Number(cfg.dshServicePort ?? 3080),
        logFile: cfg.dshServiceLogFile || DSH_SERVICE_LOG,
        log,
    });
}
dshService = buildDshService();

/** 插件握手用的 Bridge 地址（插件跑在 dsh 进程里，连 127.0.0.1 即可） */
function dshPluginUrl() {
    return `ws://127.0.0.1:${cfg.stExtPort}`;
}

/** 重建 dsh 服务管理器（配置变更后） */
function applyDshServiceConfig() {
    dshService = buildDshService();
    log(
        `dsh 服务配置已生效（profile=${dshService.profile}，`
        + `http://${dshService.host}:${dshService.port}，日志=${dshService.logFile}）`,
    );
}

/** 连接插件的注入状态（含 profile / 插件目录 / 当前写入的连接参数） */
function dshPluginStatus() {
    const profile = cfg.dshServiceProfile ?? 'web';
    return {
        ok: true,
        sourceDir: DSH_PLUGIN_SOURCE_DIR,
        sourceExists: fs.existsSync(path.join(DSH_PLUGIN_SOURCE_DIR, 'package.json')),
        pluginName: PLUGIN_NAME,
        rowId: PLUGIN_ROW_ID,
        targetDir: pluginTargetDir(dshHome()),
        url: dshPluginUrl(),
        config: {
            url: dshPluginUrl(),
            token: cfg.dshPluginToken ?? '',
            cwdRoot: cfg.dshWorkRoot ?? '',
        },
        enabled: cfg.dshPluginEnabled !== false,
        profiles: listProfileBundles(dshHome()),
        injection: probeInjection({ profile, home: dshHome() }),
        clients: [...dshPluginClients]
            .filter((c) => c.readyState === WebSocket.OPEN)
            .map((c) => ({
                pid: c.meta?.dshPid ?? 0,
                profile: c.meta?.dshProfile ?? '',
                version: c.meta?.dshVersion ?? '',
                connectedAt: c.meta?.connectedAt ?? null,
            })),
        online: dshPluginOnline(),
    };
}

/** 配置变更后重建 dsh 客户端 */
function applyDshConfig() {
    dsh = buildDsh();
    const st = dsh.status();
    if (st.configuredMissing) {
        log(`⚠ dsh：填写的路径不存在（${cfg.dshExePath}），已回落到 ${st.exePath || '自动探测失败'}`);
    }
    log(
        `dsh 配置已生效（profile=${cfg.dshProfile ?? 'headless'}，后端=${cfg.backend ?? 'taver'}，`
        + `并发=${dsh.concurrency}，上下文=${cfg.dshPersistHistory === false ? '仅内存' : DSH_HISTORY_PATH}）`,
    );
}

/**
 * 找一个空闲的本地端口。
 * 用于「原 Ollama 进程无权停止」时，换个端口起一个能正确读到模型的实例。
 */
async function findFreePort(from = 11500, to = 11600) {
    const net = await import('node:net');
    for (let port = from; port <= to; port += 1) {
        const free = await new Promise((resolve) => {
            const srv = net.createServer();
            srv.once('error', () => resolve(false));
            srv.once('listening', () => srv.close(() => resolve(true)));
            srv.listen(port, '127.0.0.1');
        });
        if (free) return port;
    }
    return 0;
}

/** 拉取任务的进度（同一时刻只允许一个） */const ollamaPullJob = {
    running: false,
    model: '',
    status: '',
    percent: 0,
    completed: 0,
    total: 0,
    startedAt: null,
    finishedAt: null,
    error: '',
};

const consoleServer = http.createServer(async (req, res) => {
    // 允许酒馆页面（:8000）跨域调用诊断接口
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        // 内置控制台已弃用：引导到 Vue 前端，未配置时给出纯文本提示
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end([
            '<!doctype html><html lang="zh"><head><meta charset="utf-8">',
            '<title>SnowLuma Bridge API</title>',
            '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;',
            'font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;',
            'background:#0f1420;color:#d8dee9}div{max-width:520px;padding:32px;',
            'border:1px solid #2a3550;border-radius:12px;background:#161d2e}',
            'h1{font-size:16px;margin:0 0 12px}p{margin:6px 0;font-size:13px;',
            'line-height:1.7;color:#8b95a9}code{color:#7cc4ff}a{color:#7cc4ff}</style>',
            '</head><body><div>',
            '<h1>SnowLuma Bridge · API 服务</h1>',
            '<p>本地址只提供 <code>/api/*</code> 接口，内置控制台网页已停用。</p>',
            '<p>请访问 Vue 管理界面（默认 <code>http://localhost:5178</code>）。</p>',
            '</div></body></html>',
        ].join(''));
        return;
    }
    if (req.method === 'GET' && req.url === '/api/status') {
        refreshCatalogsFromDisk();          // 每次查询都刷新（文件系统扫描，开销可忽略）

        const now = Date.now();
        const mem = process.memoryUsage();
        const uptimeSec = Math.floor(process.uptime());

        // 上游（SnowLuma / OneBot）
        const upstream = {
            connected: obSocket?.readyState === WebSocket.OPEN,
            endpoint: cfg.onebotUrl,
            selfId,
            nickname: upstreamStats.nickname,
            /** 当前连接已保持的秒数（未连接则为 0） */
            connectedForSec: upstreamStats.connected && upstreamStats.connectedAt
                ? Math.floor((now - upstreamStats.connectedAt) / 1000)
                : 0,
            connectedAt: upstreamStats.connectedAt || null,
            disconnectedAt: upstreamStats.disconnectedAt || null,
            reconnectCount: upstreamStats.reconnectCount,
            eventsIn: upstreamStats.eventsIn,
            actionsOut: upstreamStats.actionsOut,
            actionErrors: upstreamStats.actionErrors,
            lastEventAt: upstreamStats.lastEventAt || null,
            lastError: upstreamStats.lastError,
            lastErrorAt: upstreamStats.lastErrorAt || null,
        };

        // 下游（酒馆扩展）
        const extensionClients = [...stClients]
            .filter((c) => c.readyState === WebSocket.OPEN)
            .map((c, i) => ({
                id: i + 1,
                ext: c.meta?.ext ?? '',
                version: c.meta?.version ?? '',
                connectedAt: c.meta?.connectedAt ?? null,
                connectedForSec: c.meta?.connectedAt
                    ? Math.floor((now - c.meta.connectedAt) / 1000)
                    : 0,
                lastPingAt: c.meta?.lastPingAt || null,
            }));

        // 会话统计聚合
        const statList = [...sessionStats.values()];
        const totalIn = statList.reduce((n, s) => n + (s.in ?? 0), 0);
        const totalOut = statList.reduce((n, s) => n + (s.out ?? 0), 0);
        const lastActiveAt = statList.reduce((m, s) => Math.max(m, s.last ?? 0), 0);

        // 每个会话实际生效的后端（会话级优先，否则继承全局）
        const backendBySession = {};
        for (const key of new Set([...sessionStats.keys(), ...Object.keys(sessions)])) {
            const r = sessionBackend(key);
            backendBySession[key] = { backend: r.backend, inherited: r.inherited };
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            // --- 兼容旧字段（前端已在用）---
            onebotConnected: obSocket?.readyState === WebSocket.OPEN,
            stClients: stClients.size,
            selfId,
            sessions: Object.fromEntries([...sessionStats.entries()]),
            sessionChoices: sessions,
            /** 每个会话实际生效的后端：{ key: { backend, inherited } } */
            sessionBackends: backendBySession,
            catalogs,
            logs: logBuffer,
            config: cfg,

            // --- 新增：详细运行时状态 ---
            generatedAt: now,
            upstream,
            extension: {
                port: cfg.stExtPort,
                clientCount: extensionClients.length,
                clients: extensionClients,
            },
            metrics: {
                sessionCount: sessionStats.size,
                totalIn,
                totalOut,
                lastActiveAt: lastActiveAt || null,
                characterCount: catalogs.characters.length,
                worldCount: catalogs.worlds.length,
            },
            process: {
                pid: process.pid,
                nodeVersion: process.version,
                platform: process.platform,
                arch: process.arch,
                uptimeSec,
                startedAt: now - uptimeSec * 1000,
                rssMb: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
                heapUsedMb: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
                heapTotalMb: Math.round((mem.heapTotal / 1024 / 1024) * 10) / 10,
                externalMb: Math.round((mem.external / 1024 / 1024) * 10) / 10,
                /** 后端源码版本：改动代码后如果这个值没变，说明进程还是旧的 */
                codeVersion: CODE_VERSION,
                /** 后端入口文件最后修改时间（用于判断是否落后于代码） */
                codeMtime: CODE_MTIME,
            },
        }));
        return;
    }
    if (req.method === 'GET' && req.url === '/api/catalog/refresh') {
        // 控制台“刷新清单”：向扩展索要最新清单 + 重扫磁盘
        broadcastToST({ type: 'sync_request' });
        refreshCatalogsFromDisk();
        setTimeout(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, catalogs }));
        }, 600);
        return;
    }
    if (req.method === 'POST' && req.url === '/api/session-choice') {
        // 手动为某会话设置角色/世界书/后端
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            try {
                const { sessionKey, character, world, replyProcessors, reset, backend } = JSON.parse(body);
                if (!sessionKey) throw new Error('sessionKey required');

                // 校验后端取值：'' = 清除会话级设置（继承全局）
                if (backend !== undefined && !['', 'taver', 'dsh'].includes(String(backend))) {
                    throw new Error("backend 只能是 'taver' / 'dsh' / ''（继承全局）");
                }

                if (reset === 'pipeline') {
                    // 只清除管道配置，恢复继承全局
                    if (sessions[sessionKey]) {
                        delete sessions[sessionKey].replyProcessors;
                        sessions[sessionKey].updatedAt = new Date().toISOString();
                        saveSessions();
                    }
                } else if (reset) {
                    delete sessions[sessionKey];
                    saveSessions();
                    // 会话被重置时，把 dsh 侧上下文一起清掉，避免"删了会话但 AI 还记得"
                    dsh?.clearHistory?.(sessionKey);
                } else {
                    // backend 为空串 = 删除键，回到继承全局
                    if (backend === '') {
                        if (sessions[sessionKey]) {
                            delete sessions[sessionKey].backend;
                            sessions[sessionKey].updatedAt = new Date().toISOString();
                        }
                    }
                    rememberSession(sessionKey, {
                        ...(character !== undefined ? { character } : {}),
                        ...(world !== undefined ? { world } : {}),
                        ...(replyProcessors !== undefined ? { replyProcessors } : {}),
                        ...(backend && backend !== '' ? { backend } : {}),
                    });
                    if (backend !== undefined) {
                        const eff = sessionBackend(sessionKey);
                        log(
                            `会话后端已更新 [${sessionKey}]：`
                            + `${eff.backend === 'dsh' ? 'dsh' : '酒馆'}`
                            + `${eff.inherited ? '（继承全局）' : '（会话级）'}`,
                        );
                        // 切到 dsh 时给个明确提示，切回酒馆时提示扩展侧会接手
                        if (eff.backend === 'dsh' && !eff.inherited && stClients.size === 0) {
                            log('  提示：该会话改走 dsh，酒馆扩展是否连接不再影响它');
                        }
                    }
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    ok: true,
                    sessions,
                    sessionBackends: Object.fromEntries(
                        Object.keys(sessions).map((k) => {
                            const r = sessionBackend(k);
                            return [k, { backend: r.backend, inherited: r.inherited }];
                        }),
                    ),
                }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }
    if (req.method === 'POST' && req.url === '/api/ext-log') {
        // 扩展端诊断日志（HTTP 直连，绕开 WS 状态）
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            // 兼容 text/plain（no-cors）与 JSON 两种格式
            let text = body;
            try {
                const parsed = JSON.parse(body);
                if (parsed && typeof parsed.text === 'string') text = parsed.text;
            } catch { /* 纯文本，直接用 */ }
            log(text || '[HTTP] (空)');
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('ok');
        });
        return;
    }
    if (req.method === 'POST' && req.url === '/api/config') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            try {
                const patch = JSON.parse(body);
                const onebotChanged =
                    (patch.onebotUrl !== undefined && patch.onebotUrl !== cfg.onebotUrl) ||
                    (patch.onebotToken !== undefined && patch.onebotToken !== cfg.onebotToken);

                cfg = {
                    ...cfg,
                    ...patch,
                    // trigger / defaults 是嵌套对象，需深度合并避免整块被覆盖丢字段
                    trigger: { ...cfg.trigger, ...(patch.trigger ?? {}) },
                    defaults: { ...(cfg.defaults ?? {}), ...(patch.defaults ?? {}) },
                };

                // replyProcessors 单独处理：全量替换
                if (patch.replyProcessors !== undefined) cfg.replyProcessors = patch.replyProcessors;

                saveConfig();
                if (onebotChanged) {
                    log('上游连接参数已变更，重连 SnowLuma…');
                    try { obSocket?.close(); } catch { /* 重连逻辑接管 */ }
                }
                // Ollama 相关配置变更后立即生效（地址 / 模型 / 可执行路径）
                if (
                    patch.ollamaBaseUrl !== undefined ||
                    patch.ollamaVisionModel !== undefined ||
                    patch.ollamaTextModel !== undefined ||
                    patch.ollamaExePath !== undefined ||
                    patch.ollamaModelsDir !== undefined
                ) {
                    applyOllamaConfig();
                }

                // dsh 相关配置变更后重建客户端
                if (
                    patch.dshExePath !== undefined ||
                    patch.dshProfile !== undefined ||
                    patch.dshWorkRoot !== undefined ||
                    patch.dshTimeoutMs !== undefined ||
                    patch.dshHistoryTurns !== undefined ||
                    patch.dshPersistHistory !== undefined ||
                    patch.dshConcurrency !== undefined
                ) {
                    applyDshConfig();
                }
                // defaults / 会话状态变更后主动同步给已连接的酒馆扩展
                if (patch.defaults !== undefined) {
                    log(`默认角色/世界书已更新：${cfg.defaults?.character || '(未设)'} / ${cfg.defaults?.world || '(未设)'}`);
                    broadcastToST({
                        type: 'session_state',
                        sessions,
                        defaults: cfg.defaults ?? {},
                        imageReplies: cfg.imageReplies ?? {},
                        faceTags: faceTagManifest(),
                    });
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, defaults: cfg.defaults ?? {} }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }
    if (req.method === 'POST' && req.url === '/api/test-segments') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            try {
                const { text, config } = JSON.parse(body);
                const segs = segmentText(text ?? '', config ?? cfg.segmentation ?? {});
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, segments: segs }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }
    if (req.method === 'POST' && req.url === '/api/test-pipeline') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            const { text, rules } = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ result: applyReplyProcessors(text, rules ?? []) }));
        });
        return;
    }

    // POST /api/faces/preview   预演表情决策（不真的发 QQ）
    // body: { text }
    // 用途：把 AI 会输出的一段文本丢进来，看表情标记会被解析成什么、
    //      命中哪张图、评分多少、没命中是什么原因。排查"为什么不发表情"专用。
    if (req.method === 'POST' && req.url === '/api/faces/preview') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            try {
                const { text } = JSON.parse(body || '{}');
                const input = String(text ?? '');
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify(dryRunFaceDecision(input)));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    // ================= SnowLuma 服务集成 =================
    // GET /api/snowluma/discover   自动发现 SnowLuma 目录
    if (req.method === 'GET' && req.url?.startsWith('/api/snowluma/discover')) {
        try {
            const u = new URL(req.url, 'http://127.0.0.1');
            const known = u.searchParams.get('known') ?? cfg.snowlumaDir ?? '';
            const result = await discoverSnowLumaDir({
                knownDir: known,
                hintDirs: [process.cwd(), path.resolve(__dirname, '..', '..')],
            });

            // 对每个候选补充版本与账号信息，便于用户选择
            const enriched = result.candidates.slice(0, 8).map((c) => {
                const probe = probeSnowLuma(c.dir);
                const accounts = probe.ok ? listAccounts(probe.dataDir) : [];
                return {
                    ...c,
                    ok: probe.ok,
                    version: probe.version,
                    mode: probe.mode,
                    accounts: accounts.map((a) => a.uin),
                };
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                found: result.found && enriched.length > 0,
                dir: result.dir,
                source: result.source,
                candidates: enriched,
                tried: result.tried,
            }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ found: false, error: e.message, candidates: [] }));
        }
        return;
    }

    // GET /api/snowluma/probe?dir=...&port=...   探测目录，返回版本/配置目录/账号清单
    if (req.method === 'GET' && req.url?.startsWith('/api/snowluma/probe')) {
        const u = new URL(req.url, 'http://127.0.0.1');
        const dir = u.searchParams.get('dir') ?? cfg.snowlumaDir ?? '';
        // activePort：SnowLuma WebUI 端口，用于判定实际生效的配置目录
        const activePort = Number(u.searchParams.get('port') ?? cfg.snowlumaWebuiPort ?? 0) || null;
        const probe = probeSnowLuma(dir, activePort);
        const accounts = probe.ok ? listAccounts(probe.dataDir) : [];
        // OneBot 端口监听状态：优先用配置里的 onebotUrl 端口
        let onebotPort = 3001;
        try {
            onebotPort = Number(new URL(cfg.onebotUrl).port || 3001);
        } catch {
            /* 用默认值 */
        }
        const running = await isPortOpen(onebotPort);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ...probe,
            accounts,
            onebotPortListening: running,
            onebotPort,
        }));
        return;
    }

    // POST /api/snowluma/apply   一键配置：确保 wsServer 与 Bridge 对齐
    if (req.method === 'POST' && req.url === '/api/snowluma/apply') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            void (async () => {
                try {
                    const input = JSON.parse(body || '{}');
                    const dir = (input.dir ?? cfg.snowlumaDir ?? '').trim();
                    const uin = String(input.uin ?? '').trim();
                    const port = Number(input.port ?? 3001);
                    const host = input.host ?? '127.0.0.1';
                    const forceToken = !!input.forceToken;
                    const webuiPort = Number(input.webuiPort ?? cfg.snowlumaWebuiPort ?? 0) || null;

                    if (!dir) throw new Error('请先填写 SnowLuma 目录');
                    if (!UIN_REGEX.test(uin)) throw new Error('请填写正确的 QQ 号（5-12 位数字）');

                    const probe = probeSnowLuma(dir, webuiPort);
                    if (!probe.ok) throw new Error(probe.error || 'SnowLuma 目录无效');

                    const result = ensureOneBotEndpoint({
                        configDir: probe.configDir,
                        uin,
                        port,
                        host,
                        forceToken,
                    });

                    // 同步 Bridge 侧的上游连接参数
                    const endpoint = result.endpoint;
                    const tokenChanged = cfg.onebotToken !== result.token;
                    const urlChanged = cfg.onebotUrl !== endpoint;

                    cfg = {
                        ...cfg,
                        snowlumaDir: dir,
                        snowlumaWebuiPort: webuiPort ?? cfg.snowlumaWebuiPort,
                        onebotUrl: endpoint,
                        onebotToken: result.token,
                    };
                    saveConfig();

                    if (urlChanged || tokenChanged) {
                        log('上游连接参数已由「自动配置」更新，重连 SnowLuma…');
                        try { obSocket?.close(); } catch { /* 重连逻辑接管 */ }
                    }

                    log(`✓ SnowLuma 配置已写入：${result.path}（${result.changed ? '已更新' : '无变化'}）`);

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        ok: true,
                        changed: result.changed,
                        created: result.created,
                        path: result.path,
                        token: result.token,
                        endpoint,
                        configDir: probe.configDir,
                        dataDir: probe.dataDir,
                        mode: probe.mode,
                        version: probe.version,
                        needRestart: result.changed,
                    }));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: e.message }));
                }
            })();
        });
        return;
    }

    // GET /api/snowluma/config?uin=...   读取指定账号的 OneBot 配置
    if (req.method === 'GET' && req.url?.startsWith('/api/snowluma/config')) {
        try {
            const u = new URL(req.url, 'http://127.0.0.1');
            const uin = u.searchParams.get('uin') ?? '';
            const dir = u.searchParams.get('dir') ?? cfg.snowlumaDir ?? '';
            const probe = probeSnowLuma(dir);
            if (!probe.ok) throw new Error(probe.error || 'SnowLuma 目录无效');
            const r = readOneBotConfig(probe.configDir, uin);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, ...r, configDir: probe.configDir }));
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
    }

    // ================= SillyTavern 服务集成 =================
    // GET /api/sillytavern/discover   自动发现酒馆目录
    if (req.method === 'GET' && req.url?.startsWith('/api/sillytavern/discover')) {
        try {
            const u = new URL(req.url, 'http://127.0.0.1');
            const known = u.searchParams.get('known') ?? cfg.sillyTavernDir ?? '';
            const result = await discoverSillyTavernDir({
                knownDir: known,
                hintDirs: [process.cwd(), path.resolve(__dirname, '..', '..')],
            });
            const enriched = result.candidates.slice(0, 8).map((c) => {
                const p = probeSillyTavern(c.dir);
                return {
                    ...c,
                    ok: p.ok,
                    installed: p.installed,
                    installedVersion: p.installedVersion,
                };
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                found: result.found && enriched.length > 0,
                dir: result.dir,
                source: result.source,
                candidates: enriched,
                tried: result.tried,
            }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ found: false, error: e.message, candidates: [] }));
        }
        return;
    }

    // GET /api/sillytavern/probe?dir=...&port=...   探测目录与安装状态
    if (req.method === 'GET' && req.url?.startsWith('/api/sillytavern/probe')) {
        try {
            const u = new URL(req.url, 'http://127.0.0.1');
            const dir = u.searchParams.get('dir') ?? cfg.sillyTavernDir ?? '';
            const port = Number(u.searchParams.get('port') ?? cfg.sillyTavernPort ?? 8000);
            const probe = probeSillyTavern(dir);
            const running = await isStPortOpen(port);
            // 扩展连接状态（来自 Bridge 侧的 WS 客户端数）
            const extConnected = [...stClients].some((c) => c.readyState === WebSocket.OPEN);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                ...probe,
                port,
                running,
                extConnected,
                extPort: cfg.stExtPort,
                endpoint: `http://127.0.0.1:${port}`,
            }));
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
    }

    // POST /api/sillytavern/install   安装/更新扩展
    if (req.method === 'POST' && req.url === '/api/sillytavern/install') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            try {
                const input = JSON.parse(body || '{}');
                const dir = (input.dir ?? cfg.sillyTavernDir ?? '').trim();
                const force = !!input.force;
                if (!dir) throw new Error('请先填写酒馆目录');

                // 扩展源码位于本仓库 apps/extension
                const sourceDir = path.resolve(__dirname, '..', 'extension');

                const r = installExtension({ stDir: dir, sourceDir, force });
                if (!r.ok) throw new Error(r.error);

                cfg = { ...cfg, sillyTavernDir: dir };
                saveConfig();

                log(
                    r.action === 'unchanged'
                        ? `酒馆扩展已是最新（v${r.version}）`
                        : `酒馆扩展已${r.action === 'updated' ? '更新' : '安装'}（v${r.version}）→ ${r.target}`,
                );

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    ok: true,
                    action: r.action,
                    target: r.target,
                    version: r.version,
                    files: r.files,
                    needRefresh: r.needRefresh,
                    sourceDir,
                }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    // POST /api/sillytavern/uninstall   卸载扩展
    if (req.method === 'POST' && req.url === '/api/sillytavern/uninstall') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            try {
                const input = JSON.parse(body || '{}');
                const dir = (input.dir ?? cfg.sillyTavernDir ?? '').trim();
                if (!dir) throw new Error('请先填写酒馆目录');
                const r = uninstallExtension(dir);
                if (!r.ok) throw new Error(r.error);
                log('酒馆扩展已卸载');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(r));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    // ================= 表情库 =================
    // GET /faces/cache/<file>   本地缓存的图片（静态资源）
    // GET /faces/cache/<file>?download=1   另存为文件（浏览器下载）
    if (req.method === 'GET' && req.url?.startsWith('/faces/cache/')) {
        const rawName = req.url.slice('/faces/cache/'.length);
        const name = decodeURIComponent(rawName.split('?')[0]);
        // 防目录穿越：只允许纯文件名
        if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) {
            res.writeHead(400);
            res.end('bad request');
            return;
        }

        const wantDownload = /[?&]download=1/.test(rawName);
        const file = path.join(faces.store.cacheDir, name);

        // 缓存丢了就按文件名里的 md5 回源下载一次，避免预览空白
        if (!fs.existsSync(file)) {
            const md5 = path.basename(name, path.extname(name));
            const face = faces.store.get(md5);
            if (face?.url) {
                try {
                    const ok = await faces.downloadToCache(face);
                    if (!ok) throw new Error('下载失败');
                } catch (e) {
                    log(`表情库：预览回源失败 ${md5.slice(0, 8)} - ${e.message}`);
                    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end('图片缓存缺失且回源失败');
                    return;
                }
            } else {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('图片不存在');
                return;
            }
        }

        // 回源后可能换了扩展名，重新定位实际文件
        let realFile = file;
        if (!fs.existsSync(realFile)) {
            const md5 = path.basename(name, path.extname(name));
            const face = faces.store.get(md5);
            if (face?.localFile && fs.existsSync(face.localFile)) realFile = face.localFile;
        }
        if (!fs.existsSync(realFile)) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('图片不存在');
            return;
        }

        const ext = path.extname(realFile).toLowerCase();
        const type =
            ext === '.png' ? 'image/png'
                : ext === '.gif' ? 'image/gif'
                    : ext === '.webp' ? 'image/webp'
                        : 'image/jpeg';
        const headers = {
            'Content-Type': type,
            // 缓存时间短一些：万一之前缓存了错误响应，能尽快自愈
            'Cache-Control': 'public, max-age=600',
            'Content-Length': String(fs.statSync(realFile).size),
        };
        if (wantDownload) {
            const md5 = path.basename(realFile, ext);
            headers['Content-Disposition'] = `attachment; filename="${md5}${ext}"`;
        }
        res.writeHead(200, headers);
        fs.createReadStream(realFile).pipe(res);
        return;
    }

    // GET /api/faces?tag=&keyword=&page=&pageSize=   表情列表
    if (req.method === 'GET' && req.url?.startsWith('/api/faces')) {
        const u = new URL(req.url, 'http://127.0.0.1');
        // /api/faces/tags 单独处理
        if (u.pathname === '/api/faces/tags') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                ok: true,
                tags: faces.tagStats(),
                stats: faces.stats(),
            }));
            return;
        }
        if (u.pathname === '/api/faces/diagnostics') {
            const d = await faces.diagnostics();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, ...d }));
            return;
        }
        if (u.pathname === '/api/faces/progress') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, ...faces.progress(), sync: faces.syncState }));
            return;
        }

        const r = faces.list({
            tag: u.searchParams.get('tag') ?? '',
            keyword: u.searchParams.get('keyword') ?? '',
            page: Number(u.searchParams.get('page') ?? 1),
            pageSize: Number(u.searchParams.get('pageSize') ?? 60),
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ok: true,
            ...r,
            stats: faces.stats(),
        }));
        return;
    }

    // POST /api/faces/sync   从 QQ 同步收藏表情
    if (req.method === 'POST' && req.url === '/api/faces/sync') {
        try {
            const r = await faces.syncFromQQ({ downloadImages: true });
            res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(r));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
    }

    // POST /api/faces/label   启动后台打标
    if (req.method === 'POST' && req.url === '/api/faces/label') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            try {
                const input = JSON.parse(body || '{}');
                const r = faces.startLabeling({
                    all: !!input.all,
                    limit: Number(input.limit ?? 0),
                });
                res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(r));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    // POST /api/faces/label/stop   停止打标
    if (req.method === 'POST' && req.url === '/api/faces/label/stop') {
        const r = faces.stopLabeling();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r));
        return;
    }

    // POST /api/faces/tags   修改用户标签
    if (req.method === 'POST' && req.url === '/api/faces/tags') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            try {
                const input = JSON.parse(body || '{}');
                const md5 = String(input.md5 ?? '').trim();
                if (!md5) throw new Error('缺少 md5');
                if (!Array.isArray(input.tags)) throw new Error('tags 必须是数组');
                const ok = faces.setUserTags(md5, input.tags);
                res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    // POST /api/faces/save   把表情保存到本地运行目录
    // body: { md5 } 或 { md5s: [...] }，可选 dir 覆盖目标目录
    if (req.method === 'POST' && req.url === '/api/faces/save') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', async () => {
            try {
                const input = JSON.parse(body || '{}');
                const md5s = Array.isArray(input.md5s)
                    ? input.md5s.map((x) => String(x))
                    : input.md5
                      ? [String(input.md5)]
                      : [];
                if (md5s.length === 0) throw new Error('请提供 md5 或 md5s');

                // 默认存到项目运行目录下的 exports/faces/<日期>/
                const dir = input.dir
                    ? path.resolve(String(input.dir))
                    : path.resolve(
                          FACES_DATA_DIR,
                          '..',
                          '..',
                          'exports',
                          'faces',
                          new Date().toISOString().slice(0, 10),
                      );

                const r = await faces.saveToDir(md5s, dir);
                res.writeHead(r.ok ? 200 : 400, {
                    'Content-Type': 'application/json; charset=utf-8',
                });
                res.end(JSON.stringify(r));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    // GET /api/faces/resolve?tag=开心   按标签取一张（调试/预览用）
    if (req.method === 'GET' && req.url?.startsWith('/api/faces/resolve')) {
        const u = new URL(req.url, 'http://127.0.0.1');
        const tag = u.searchParams.get('tag') ?? '';
        const hit = faces.pickByTag(tag);
        res.writeHead(hit ? 200 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(hit ? { ok: true, face: hit } : { ok: false, error: '未找到匹配标签' }));
        return;
    }

    // ================= Ollama 管理 =================
    // 定位：只调用本机已安装的 Ollama，不负责安装。
    // 所有模型名由前端填写，因此不做白名单校验。
    if (req.url?.startsWith('/api/ollama')) {
        const u = new URL(req.url, 'http://127.0.0.1');
        const p = u.pathname;
        const json = (code, data) => {
            res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(data));
        };
        const readBody = () =>
            new Promise((resolve) => {
                let body = '';
                req.on('data', (c) => (body += c));
                req.on('end', () => {
                    try {
                        resolve(JSON.parse(body || '{}'));
                    } catch {
                        resolve({});
                    }
                });
            });

        // -------- GET /api/ollama/status   服务状态 + 环境 --------
        if (req.method === 'GET' && p === '/api/ollama/status') {
            const v = await ollamaClient.version();
            const daemon = ollamaDaemon.status();
            let running = [];
            let models = [];
            if (v.ok) {
                running = await ollamaClient.running();
                models = await ollamaClient.list().catch(() => []);
            }
            // 磁盘上有模型、服务却看不到 → 几乎一定是模型目录没传对。
            // 这是最容易被误判成「未安装」的情况，必须明确告诉用户。
            const diskModelCount = countModelsIn(daemon.modelsDir);
            const envMismatch = v.ok && models.length === 0 && diskModelCount > 0;
            json(200, {
                ok: true,
                online: v.ok,
                version: v.version ?? '',
                error: v.error ?? '',
                baseUrl: ollamaClient.baseUrl,
                visionModel: cfg.ollamaVisionModel ?? '',
                textModel: cfg.ollamaTextModel ?? '',
                daemon,
                running,
                /** 服务上报的模型数量 */
                modelCount: models.length,
                /** 磁盘上实际存在的模型数量 */
                diskModelCount,
                /** 服务看不到磁盘上的模型（模型目录未生效） */
                envMismatch,
                pull: { ...ollamaPullJob },
            });
            return;
        }

        // -------- GET /api/ollama/models   本地已下载模型 --------
        if (req.method === 'GET' && p === '/api/ollama/models') {
            try {
                const [models, running] = await Promise.all([
                    ollamaClient.list(),
                    ollamaClient.running(),
                ]);
                const runningMap = new Map(running.map((m) => [m.name, m]));
                json(200, {
                    ok: true,
                    baseUrl: ollamaClient.baseUrl,
                    models: models.map((m) => ({
                        ...m,
                        loaded: runningMap.has(m.name),
                        running: runningMap.get(m.name) ?? null,
                    })),
                });
            } catch (e) {
                json(503, { ok: false, error: e.message, models: [] });
            }
            return;
        }

        // -------- POST /api/ollama/start   启动本地服务 --------
        if (req.method === 'POST' && p === '/api/ollama/start') {
            try {
                const r = await ollamaDaemon.start(ollamaClient);
                log(`Ollama：服务已就绪（${r.alreadyRunning ? '复用现有进程' : '由 Bridge 启动'}）`);
                json(200, { ok: true, ...r, daemon: ollamaDaemon.status() });
            } catch (e) {
                json(400, { ok: false, error: e.message, daemon: ollamaDaemon.status() });
            }
            return;
        }

        // -------- POST /api/ollama/repair   修正模型目录问题 --------
        if (req.method === 'POST' && p === '/api/ollama/repair') {
            try {
                const st = ollamaDaemon.status();
                // 把探测到的模型目录写进配置，保证以后启动一定带上
                if (st.modelsDir && !cfg.ollamaModelsDir) {
                    cfg.ollamaModelsDir = st.modelsDir;
                    saveConfig();
                    applyOllamaConfig();
                    log(`Ollama：已把模型目录写入配置 ${cfg.ollamaModelsDir}`);
                }

                // 方案 A：能停掉现有进程 → 原地重启
                const stopped = await ollamaDaemon.stop(ollamaClient);
                if (stopped.ok) {
                    const deadline = Date.now() + 15000;
                    while (Date.now() < deadline) {
                        const v = await ollamaClient.version();
                        if (!v.ok) break;
                        await new Promise((r) => setTimeout(r, 400));
                    }
                    const started = await ollamaDaemon.start(ollamaClient);
                    const models = await ollamaClient.list().catch(() => []);
                    log(`Ollama：修复完成，现在可见 ${models.length} 个模型`);
                    json(200, {
                        ok: true,
                        mode: 'restart',
                        version: started.version,
                        modelCount: models.length,
                        modelsDir: ollamaDaemon.status().modelsDir,
                    });
                    return;
                }

                // 方案 B：停不掉（权限/其他账户）→ 换个端口起一个带正确目录的实例
                const altPort = await findFreePort(11500, 11600);
                if (!altPort) {
                    json(409, {
                        ok: false,
                        needManual: true,
                        error: stopped.error,
                        hint: '请到任务管理器结束 ollama.exe，然后点「启动服务」',
                    });
                    return;
                }

                const altUrl = `http://127.0.0.1:${altPort}`;
                log(`Ollama：原进程无法停止，改在 ${altPort} 启动带正确模型目录的实例`);
                ollamaClient.baseUrl = altUrl;
                ollamaDaemon.baseUrl = altUrl;

                const started = await ollamaDaemon.start(ollamaClient);
                const models = await ollamaClient.list().catch(() => []);
                if (models.length === 0) {
                    // 新实例也看不到模型，说明配置本身有问题，别悄悄改地址
                    ollamaClient.baseUrl = cfg.ollamaBaseUrl ?? 'http://127.0.0.1:11434';
                    ollamaDaemon.baseUrl = ollamaClient.baseUrl;
                    await ollamaDaemon.stop(ollamaClient).catch(() => {});
                    json(400, {
                        ok: false,
                        error: '新实例仍然看不到模型，请检查「模型目录」填写是否正确',
                        modelsDir: cfg.ollamaModelsDir,
                    });
                    return;
                }

                // 成功：把新地址固化下来，前端与打标器都用它
                cfg.ollamaBaseUrl = altUrl;
                saveConfig();
                applyOllamaConfig();
                log(`Ollama：修复完成，新地址 ${altUrl}，可见 ${models.length} 个模型`);
                json(200, {
                    ok: true,
                    mode: 'alt-port',
                    version: started.version,
                    baseUrl: altUrl,
                    modelCount: models.length,
                    modelsDir: ollamaDaemon.status().modelsDir,
                    note: `原进程（PID 无法停止）仍在 ${st.exePath ? '旧端口' : '运行'}，已忽略`,
                });
            } catch (e) {
                json(400, { ok: false, error: e.message });
            }
            return;
        }

        // -------- POST /api/ollama/stop   停止本地服务 --------
        if (req.method === 'POST' && p === '/api/ollama/stop') {
            try {
                const r = await ollamaDaemon.stop(ollamaClient);
                json(r.ok ? 200 : 400, { ...r, daemon: ollamaDaemon.status() });
            } catch (e) {
                json(400, { ok: false, error: e.message });
            }
            return;
        }

        // -------- POST /api/ollama/models/:name/load|unload|delete --------
        const mMatch = p.match(/^\/api\/ollama\/models\/(.+)\/(load|unload|delete)$/);
        if (req.method === 'POST' && mMatch) {
            const name = decodeURIComponent(mMatch[1]);
            const action = mMatch[2];
            try {
                if (action === 'load') {
                    const body = await readBody();
                    const keepAlive = body.keepAlive ?? '30m';
                    log(`Ollama：加载模型 ${name}（keep_alive=${keepAlive}）`);
                    await ollamaClient.load(name, { keepAlive });
                    json(200, { ok: true, model: name, keepAlive });
                } else if (action === 'unload') {
                    await ollamaClient.unload(name);
                    log(`Ollama：已卸载模型 ${name}`);
                    json(200, { ok: true, model: name });
                } else {
                    await ollamaClient.remove(name);
                    log(`Ollama：已删除模型 ${name}`);
                    json(200, { ok: true, model: name });
                }
            } catch (e) {
                json(400, { ok: false, error: e.message });
            }
            return;
        }

        // -------- POST /api/ollama/models/:name/show   模型详情 --------
        const showMatch = p.match(/^\/api\/ollama\/models\/(.+)\/show$/);
        if (req.method === 'GET' && showMatch) {
            const name = decodeURIComponent(showMatch[1]);
            try {
                json(200, { ok: true, ...(await ollamaClient.show(name)) });
            } catch (e) {
                json(400, { ok: false, error: e.message });
            }
            return;
        }

        // -------- POST /api/ollama/pull   拉取模型（后台任务） --------
        if (req.method === 'POST' && p === '/api/ollama/pull') {
            const body = await readBody();
            const model = String(body.model ?? '').trim();
            if (!model) {
                json(400, { ok: false, error: '请填写模型名，例如 qwen2.5vl:3b' });
                return;
            }
            if (ollamaPullJob.running) {
                json(409, { ok: false, error: `已在拉取 ${ollamaPullJob.model}，请等待完成` });
                return;
            }
            Object.assign(ollamaPullJob, {
                running: true,
                model,
                status: '准备中…',
                percent: 0,
                completed: 0,
                total: 0,
                startedAt: new Date().toISOString(),
                finishedAt: null,
                error: '',
            });
            log(`Ollama：开始拉取模型 ${model}`);
            // 后台执行，立刻返回，前端轮询 /progress
            void (async () => {
                try {
                    await ollamaClient.pull(model, (ev) => {
                        if (ev.status) ollamaPullJob.status = String(ev.status);
                        if (typeof ev.completed === 'number') ollamaPullJob.completed = ev.completed;
                        if (typeof ev.total === 'number') ollamaPullJob.total = ev.total;
                        if (ollamaPullJob.total > 0) {
                            ollamaPullJob.percent = Math.min(
                                100,
                                Math.floor((ollamaPullJob.completed / ollamaPullJob.total) * 100),
                            );
                        }
                    });
                    ollamaPullJob.percent = 100;
                    ollamaPullJob.status = '完成';
                    log(`Ollama：模型 ${model} 拉取完成`);
                } catch (e) {
                    ollamaPullJob.error = e.message;
                    log(`Ollama：拉取 ${model} 失败 - ${e.message}`);
                } finally {
                    ollamaPullJob.running = false;
                    ollamaPullJob.finishedAt = new Date().toISOString();
                }
            })();
            json(200, { ok: true, model, pull: { ...ollamaPullJob } });
            return;
        }

        // -------- GET /api/ollama/pull/progress   拉取进度 --------
        if (req.method === 'GET' && p === '/api/ollama/pull/progress') {
            json(200, { ok: true, ...ollamaPullJob });
            return;
        }

        // -------- POST /api/ollama/chat   文本对话（连通性测试） --------
        if (req.method === 'POST' && p === '/api/ollama/chat') {
            const body = await readBody();
            const model = String(body.model ?? cfg.ollamaVisionModel ?? '').trim();
            const prompt = String(body.prompt ?? '你好，请用一句话介绍你自己。');
            if (!model) {
                json(400, { ok: false, error: '请填写模型名' });
                return;
            }
            try {
                const t0 = Date.now();
                const content = await ollamaClient.chat(model, prompt, {
                    timeoutMs: Number(body.timeoutMs ?? 120000),
                    keepAlive: body.keepAlive,
                    temperature: Number(body.temperature ?? 0.2),
                    numPredict: Number(body.numPredict ?? 200),
                });
                json(200, { ok: true, model, content, elapsedMs: Date.now() - t0 });
            } catch (e) {
                json(400, { ok: false, error: e.message });
            }
            return;
        }

        // -------- POST /api/ollama/vision   视觉对话（图片路径或 base64） --------
        if (req.method === 'POST' && p === '/api/ollama/vision') {
            const body = await readBody();
            const model = String(body.model ?? cfg.ollamaVisionModel ?? '').trim();
            const prompt = String(body.prompt ?? '用一句话描述这张图。');
            if (!model) {
                json(400, { ok: false, error: '请填写模型名' });
                return;
            }
            try {
                let images = [];
                if (Array.isArray(body.images) && body.images.length) {
                    images = body.images.map((s) => String(s).replace(/^data:[^,]+,/, ''));
                } else if (body.imagePath) {
                    const abs = path.resolve(String(body.imagePath));
                    if (!fs.existsSync(abs)) throw new Error(`图片不存在：${abs}`);
                    images = [fs.readFileSync(abs).toString('base64')];
                }
                if (!images.length) throw new Error('请提供 imagePath 或 images（base64 数组）');
                const t0 = Date.now();
                const content = await ollamaClient.vision(model, prompt, images, {
                    timeoutMs: Number(body.timeoutMs ?? 180000),
                    keepAlive: body.keepAlive,
                });
                json(200, { ok: true, model, content, elapsedMs: Date.now() - t0 });
            } catch (e) {
                json(400, { ok: false, error: e.message });
            }
            return;
        }

        // -------- POST /api/ollama/select   选择打标用模型 --------
        if (req.method === 'POST' && p === '/api/ollama/select') {
            const body = await readBody();
            if (body.visionModel !== undefined) cfg.ollamaVisionModel = String(body.visionModel).trim();
            if (body.textModel !== undefined) cfg.ollamaTextModel = String(body.textModel).trim();
            if (body.baseUrl !== undefined) cfg.ollamaBaseUrl = String(body.baseUrl).trim();
            saveConfig();
            applyOllamaConfig();
            log(
                `Ollama：打标模型已切换为 ${cfg.ollamaVisionModel}`
                + (cfg.ollamaTextModel ? ` / ${cfg.ollamaTextModel}` : ''),
            );
            json(200, {
                ok: true,
                visionModel: cfg.ollamaVisionModel,
                textModel: cfg.ollamaTextModel,
                baseUrl: cfg.ollamaBaseUrl,
            });
            return;
        }

        json(404, { ok: false, error: `未知的 Ollama 接口：${req.method} ${p}` });
        return;
    }

    // ================= dsh（DeepSeek Harness）=================
    if (req.url?.startsWith('/api/dsh')) {
        const u = new URL(req.url, 'http://127.0.0.1');
        const p = u.pathname;
        const json = (code, data) => {
            res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(data));
        };
        const readBody = () =>
            new Promise((resolve) => {
                let body = '';
                req.on('data', (c) => (body += c));
                req.on('end', () => {
                    try {
                        resolve(JSON.parse(body || '{}'));
                    } catch {
                        resolve({});
                    }
                });
            });

        // GET /api/dsh/status   探测安装与当前配置
        if (req.method === 'GET' && p === '/api/dsh/status') {
            // 手动「重新探测」时跳过 60s 缓存
            if (u.searchParams.get('fresh') === '1') invalidateDshProbe();
            const found = findDsh(cfg.dshExePath ?? '');
            json(200, {
                ok: true,
                installed: !!found.path,
                exePath: found.path,
                /** 用户手动填写的路径（可能为空，也可能与探测结果不同） */
                configuredExePath: cfg.dshExePath ?? '',
                source: found.source,
                version: found.version,
                home: dshHome(),
                profiles: listProfiles(),
                backend: cfg.backend ?? 'taver',
                config: {
                    profile: cfg.dshProfile ?? 'headless',
                    workRoot: cfg.dshWorkRoot ?? '',
                    timeoutMs: Number(cfg.dshTimeoutMs ?? 180000),
                    historyTurns: Number(cfg.dshHistoryTurns ?? 6),
                    systemPrompt: cfg.dshSystemPrompt ?? '',
                    errorReply: cfg.dshErrorReply ?? '',
                    persistHistory: cfg.dshPersistHistory !== false,
                    concurrency: Number(cfg.dshConcurrency ?? 1),
                    serviceProfile: cfg.dshServiceProfile ?? 'web',
                    servicePort: Number(cfg.dshServicePort ?? 3080),
                    serviceLogFile: cfg.dshServiceLogFile ?? '',
                    pluginToken: cfg.dshPluginToken ?? '',
                    pluginEnabled: cfg.dshPluginEnabled !== false,
                },
                runtime: dsh?.status?.() ?? null,
                load: dsh?.load?.() ?? null,
                sessions: dsh?.listSessions?.() ?? [],
                service: await dshService.inspect({ logTail: 25 }),
                plugin: dshPluginStatus(),
            });
            return;
        }

        // POST /api/dsh/test   发一句话测试连通性（不影响真实会话）
        if (req.method === 'POST' && p === '/api/dsh/test') {
            const body = await readBody();
            const text = String(body.text ?? '只回复两个字：正常').trim();
            const rawKey = String(body.sessionKey ?? 'default').trim() || 'default';
            // 测试会话统一加 `_test` 前缀，避免和真实 private_/group_ 会话串上下文
            const sessionKey = rawKey.startsWith('_test') ? rawKey : `_test_${rawKey}`;
            if (!dsh) {
                json(500, { ok: false, error: 'dsh 未初始化' });
                return;
            }
            const r = await dsh.ask({
                sessionKey,
                text,
                system: dshSystemPrompt(),
                useHistory: body.useHistory !== false,
            });
            json(r.ok ? 200 : 400, { ...r, sessionKey });
            return;
        }

        // POST /api/dsh/backend   切换后端（taver / dsh）
        if (req.method === 'POST' && p === '/api/dsh/backend') {
            const body = await readBody();
            const want = String(body.backend ?? '').trim();
            if (!['taver', 'dsh'].includes(want)) {
                json(400, { ok: false, error: "backend 只能是 'taver' 或 'dsh'" });
                return;
            }
            cfg.backend = want;
            saveConfig();
            log(`后端已切换为：${want === 'dsh' ? 'dsh（DeepSeek Harness）' : '酒馆（SillyTavern）'}`);
            json(200, { ok: true, backend: cfg.backend });
            return;
        }

        // POST /api/dsh/config   更新 dsh 参数
        if (req.method === 'POST' && p === '/api/dsh/config') {
            const body = await readBody();
            let rebuild = false;
            const touch = (name) => {
                if (body[name] !== undefined) rebuild = true;
            };
            if (body.exePath !== undefined) cfg.dshExePath = String(body.exePath).trim();
            if (body.profile !== undefined) cfg.dshProfile = String(body.profile).trim() || 'headless';
            if (body.workRoot !== undefined) cfg.dshWorkRoot = String(body.workRoot).trim();
            if (body.timeoutMs !== undefined) cfg.dshTimeoutMs = Number(body.timeoutMs) || 180000;
            if (body.historyTurns !== undefined) {
                cfg.dshHistoryTurns = Math.max(0, Number(body.historyTurns) || 0);
            }
            ['exePath', 'profile', 'workRoot', 'timeoutMs', 'historyTurns'].forEach(touch);
            if (body.systemPrompt !== undefined) cfg.dshSystemPrompt = String(body.systemPrompt);
            if (body.errorReply !== undefined) cfg.dshErrorReply = String(body.errorReply);
            if (body.concurrency !== undefined) {
                cfg.dshConcurrency = Math.max(1, Math.min(8, Number(body.concurrency) || 1));
                rebuild = true;
            }
            if (body.persistHistory !== undefined) {
                cfg.dshPersistHistory = body.persistHistory !== false;
                rebuild = true;
            }
            if (body.exePath !== undefined) invalidateDshProbe();

            // 常驻服务参数
            let serviceChanged = false;
            if (body.serviceProfile !== undefined) {
                cfg.dshServiceProfile = String(body.serviceProfile).trim() || 'web';
                serviceChanged = true;
            }
            if (body.servicePort !== undefined) {
                cfg.dshServicePort = Math.max(1, Math.min(65535, Number(body.servicePort) || 3080));
                serviceChanged = true;
            }
            if (body.serviceLogFile !== undefined) {
                cfg.dshServiceLogFile = String(body.serviceLogFile).trim();
                serviceChanged = true;
            }
            // 连接插件参数
            if (body.pluginToken !== undefined) cfg.dshPluginToken = String(body.pluginToken).trim();
            if (body.pluginEnabled !== undefined) cfg.dshPluginEnabled = body.pluginEnabled !== false;

            saveConfig();
            if (rebuild) applyDshConfig();
            if (serviceChanged) applyDshServiceConfig();
            json(200, {
                ok: true,
                config: {
                    exePath: cfg.dshExePath,
                    profile: cfg.dshProfile,
                    workRoot: cfg.dshWorkRoot,
                    timeoutMs: cfg.dshTimeoutMs,
                    historyTurns: cfg.dshHistoryTurns,
                    systemPrompt: cfg.dshSystemPrompt ?? '',
                    errorReply: cfg.dshErrorReply ?? '',
                    persistHistory: cfg.dshPersistHistory !== false,
                    concurrency: Number(cfg.dshConcurrency ?? 1),
                    serviceProfile: cfg.dshServiceProfile ?? 'web',
                    servicePort: Number(cfg.dshServicePort ?? 3080),
                    serviceLogFile: cfg.dshServiceLogFile ?? '',
                    pluginToken: cfg.dshPluginToken ?? '',
                    pluginEnabled: cfg.dshPluginEnabled !== false,
                },
            });
            return;
        }

        // POST /api/dsh/reset   清空会话上下文（留空 sessionKey 则清空全部）
        if (req.method === 'POST' && p === '/api/dsh/reset') {
            const body = await readBody();
            const key = String(body.sessionKey ?? '').trim();
            const removeWorkDir = body.removeWorkDir === true;
            if (!key) {
                if (body.all !== true) {
                    json(400, { ok: false, error: '缺少 sessionKey（或传 all: true 清空全部）' });
                    return;
                }
                const cleared = dsh?.clearAllHistory?.() ?? 0;
                log(`dsh：已清空全部会话上下文（${cleared} 个）`);
                json(200, { ok: true, cleared, sessions: dsh?.listSessions?.() ?? [] });
                return;
            }
            const existed = dsh?.clearHistory(key, { removeWorkDir }) ?? false;
            log(`dsh：已清空会话上下文 [${key}]${removeWorkDir ? '（含工作目录）' : ''}`);
            json(200, {
                ok: true,
                sessionKey: key,
                existed,
                sessions: dsh?.listSessions?.() ?? [],
            });
            return;
        }

        // ================= dsh 常驻服务 =================
        // GET /api/dsh/service    服务状态（端口 / PID / 日志尾巴）
        if (req.method === 'GET' && p === '/api/dsh/service') {
            const st = await dshService.inspect({ logTail: 40 });
            json(200, { ok: true, ...st });
            return;
        }

        // POST /api/dsh/service/start | stop | restart
        const svcMatch = p.match(/^\/api\/dsh\/service\/(start|stop|restart)$/);
        if (req.method === 'POST' && svcMatch) {
            const action = svcMatch[1];
            if (!dshService) {
                json(500, { ok: false, error: 'dsh 服务未初始化' });
                return;
            }
            try {
                let r;
                if (action === 'start') r = await dshService.start();
                else if (action === 'stop') r = await dshService.stop();
                else r = await dshService.restart();
                const st = await dshService.inspect({ logTail: 20 });
                json(r.ok ? 200 : 400, { ok: r.ok, action, result: r, ...st });
            } catch (e) {
                json(400, { ok: false, error: e.message });
            }
            return;
        }

        // ================= dsh 连接插件 =================
        // GET /api/dsh/plugin    注入状态 + 在线连接
        if (req.method === 'GET' && p === '/api/dsh/plugin') {
            json(200, dshPluginStatus());
            return;
        }

        // POST /api/dsh/plugin/inject   把插件装进 profile（可选顺带重启）
        if (req.method === 'POST' && p === '/api/dsh/plugin/inject') {
            const body = await readBody();
            const profile = String(body.profile ?? cfg.dshServiceProfile ?? 'web').trim();
            const inject = injectPlugin({
                profile,
                sourceDir: DSH_PLUGIN_SOURCE_DIR,
                url: dshPluginUrl(),
                token: String(body.token ?? cfg.dshPluginToken ?? ''),
                cwdRoot: String(body.cwdRoot ?? cfg.dshWorkRoot ?? ''),
                home: dshHome(),
            });
            if (!inject.ok) {
                json(400, { ok: false, error: inject.error, inject });
                return;
            }
            log(
                `dsh：连接插件已${inject.action === 'injected' ? '注入' : '更新'}到 profile ${profile}`
                + `（${inject.target}）`,
            );

            // 记下本次注入的 profile/token，保持与配置一致
            if (body.profile !== undefined) {
                cfg.dshServiceProfile = profile;
                applyDshServiceConfig();
            }
            if (body.token !== undefined) cfg.dshPluginToken = String(body.token).trim();
            saveConfig();

            let verified = null;
            if (body.verify !== false) {
                verified = verifyInjection({ exePath: cfg.dshExePath ?? '', profile, home: dshHome() });
                log(verified.ok
                    ? 'dsh：插件已出现在 profile 组合结果中'
                    : `dsh：插件校验未通过 —— ${verified.error}`);
            }

            let restart = null;
            if (body.restart === true) {
                restart = await dshService.restart();
                log(restart.ok
                    ? `dsh：已重启服务（${dshService.host}:${dshService.port}）`
                    : `dsh：重启失败 —— ${restart.error ?? '未知错误'}`);
            }

            json(200, {
                ok: true,
                inject,
                verified,
                restart,
                plugin: dshPluginStatus(),
                service: await dshService.inspect({ logTail: 15 }),
            });
            return;
        }

        // POST /api/dsh/plugin/remove   移除注入
        if (req.method === 'POST' && p === '/api/dsh/plugin/remove') {
            const body = await readBody();
            const profile = String(body.profile ?? cfg.dshServiceProfile ?? 'web').trim();
            const r = removePlugin({ profile, home: dshHome() });
            if (!r.ok) {
                json(400, { ok: false, error: r.error });
                return;
            }
            log(`dsh：已从 profile ${profile} 移除连接插件`);
            let restart = null;
            if (body.restart === true) {
                restart = await dshService.restart();
            }
            json(200, { ok: true, remove: r, restart, plugin: dshPluginStatus() });
            return;
        }

        // POST /api/dsh/plugin/reset   让插件释放某会话（或全部）的 Agent
        if (req.method === 'POST' && p === '/api/dsh/plugin/reset') {
            const body = await readBody();
            const soc = pickDshPlugin();
            if (!soc) {
                json(400, { ok: false, error: '没有在线的 dsh 连接插件' });
                return;
            }
            const key = String(body.sessionKey ?? '').trim();
            const keys = key ? [key] : Object.keys(sessions);
            let sent = 0;
            for (const k of keys) {
                try {
                    soc.send(JSON.stringify({
                        type: 'dsh_reset',
                        requestId: `reset_${++dshPluginReqSeq}`,
                        sessionKey: k,
                        removeWorkDir: body.removeWorkDir === true,
                    }));
                    sent += 1;
                } catch {
                    /* 忽略 */
                }
            }
            // 本地 headless 侧的历史也一并清掉，避免切回子进程时"还记得"
            for (const k of keys) dsh?.clearHistory?.(k, { removeWorkDir: body.removeWorkDir === true });
            log(`dsh 插件：已请求释放 ${sent} 个会话的上下文`);
            json(200, { ok: true, sent, sessions: keys });
            return;
        }

        json(404, { ok: false, error: `未知的 dsh 接口：${req.method} ${p}` });
        return;
    }

    res.writeHead(404); res.end('not found');
});
consoleServer.listen(cfg.consolePort ?? 9510, '127.0.0.1', () =>
    log(`API 服务已启动: http://127.0.0.1:${cfg.consolePort ?? 9510}/api/status`));

connectOnebot();
log(`连接器 v3 已启动: SnowLuma=${cfg.onebotUrl} | 扩展端口=${cfg.stExtPort} | 控制台=${cfg.consolePort ?? 9510}`);

// ===== 启动检查：把「静默失败」变成明确提示 =====
if (!configFileExisted) {
    if (cfg.onebotToken) {
        log('ℹ 未找到 config.json，当前使用默认配置 + 环境变量提供的 token');
    } else {
        log('─'.repeat(64));
        log('⚠ 未找到 config.json，当前使用默认配置（OneBot token 为空）');
        log(`   请执行：cp config.example.json config.json`);
        log(`   路径应为：${CONFIG_PATH}`);
        log('   若 SnowLuma 开启了 Access Token，连接会一直返回 401。');
        log('─'.repeat(64));
    }
} else if (!cfg.onebotToken) {
    log('⚠ config.json 中 onebotToken 为空；若 SnowLuma 开启了 Access Token，将返回 401');
}
if (!cfg.stDataDir) {
    log('⚠ 未能定位酒馆数据目录（stDataDir），角色/世界书清单将仅依赖扩展上报');
    log('   可在系统设置中填写，或设置环境变量 ST_DATA_DIR');
}

// ===== 启动提示：当前回复后端与 dsh 可用性 =====
if (cfg.backend === 'dsh') {
    const st = dsh?.status?.() ?? null;
    if (st?.installed) {
        log(`ℹ 回复后端：dsh（${st.version || '版本未知'}，profile=${st.profile}）→ QQ 消息不再经过酒馆`);
    } else {
        log('─'.repeat(64));
        log('⚠ 回复后端配置为 dsh，但未找到可执行文件，QQ 消息将无人应答');
        log('   请安装：npm i -g @deepseek-ai/dsh，或在「dsh 接入」页填写路径 / 切回酒馆');
        log(`   探测路径：${st?.exePath || '(空)'}`);
        log('─'.repeat(64));
    }
} else {
    log('ℹ 回复后端：酒馆（SillyTavern）');
}

