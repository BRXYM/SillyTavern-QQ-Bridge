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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
    // 默认角色/世界书：酒馆当前未选择角色时自动使用
    defaults: {
        character: '',      // 角色名（留空=不自动选择）
        world: '',          // 世界书名（留空=不自动激活）
    },
};

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

    try {
        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            if (seg.delayMs > 0) {
                await new Promise((r) => setTimeout(r, seg.delayMs));
            }
            // 检测消息里的图片标记，转成消息段
            // [表情:标签] 会按表情库检索出真实图片地址
            const payload = buildOutgoingPayload(seg.text, (tag) => {
                try {
                    const hit = faces?.pickByTag(tag);
                    return hit?.imageUrl ? absoluteFaceUrl(hit.imageUrl) : null;
                } catch {
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
        const st = sessionStats.get(msg.sessionKey);
        if (st) st.out++;
    } catch (e) {
        log(`QQ 发送失败(${target}):`, e.message);
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
function buildOutgoingPayload(text, resolveTag) {
    const imgRe = /\[(?:img|image|图片|表情)[:：]\s*([^\]\s]+)\s*\]/gi;
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
            kind: urlLike.test(value) ? 'url' : 'tag',
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
        } else if (typeof resolveTag === 'function') {
            try {
                url = resolveTag(f.value);
            } catch {
                url = null;
            }
            if (url) {
                log(`表情标签已解析：[表情:${f.value}] → ${String(url).slice(0, 60)}…`);
            } else {
                log(`⚠ 表情标签未命中，已丢弃：[表情:${f.value}]`);
            }
        }

        if (url) segs.push({ type: 'image', data: { file: url } });
        cursor = f.index + f.len;
    }
    const tail = text.slice(cursor).trim();
    if (tail) segs.push({ type: 'text', data: { text: tail } });

    return segs.length > 0 ? segs : '';
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

    if (message_type === 'group' && cfg.trigger.allowedGroups.length && !cfg.trigger.allowedGroups.includes(group_id)) return;
    if (cfg.trigger.allowedUsers.length && !cfg.trigger.allowedUsers.includes(user_id)) return;

    const { text, atMe } = parseMessage(event.message);
    if (!text) return;
    if (message_type === 'group' && cfg.trigger.atOnly && !atMe) return;

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

    log(`QQ消息 → 酒馆 [${key}]: [${senderName}] ${text}`);
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
        stClients.delete(socket);
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
    ollama: {
        baseUrl: cfg.ollamaBaseUrl ?? 'http://127.0.0.1:11434',
        visionModel: cfg.ollamaVisionModel ?? 'qwen2.5vl:3b',
        textModel: cfg.ollamaTextModel ?? '',
        timeoutMs: 120000,
    },
});

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

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            // --- 兼容旧字段（前端已在用）---
            onebotConnected: obSocket?.readyState === WebSocket.OPEN,
            stClients: stClients.size,
            selfId,
            sessions: Object.fromEntries([...sessionStats.entries()]),
            sessionChoices: sessions,
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
        // 手动为某会话设置角色/世界书
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            try {
                const { sessionKey, character, world, replyProcessors, reset } = JSON.parse(body);
                if (!sessionKey) throw new Error('sessionKey required');
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
                } else {
                    rememberSession(sessionKey, {
                        ...(character !== undefined ? { character } : {}),
                        ...(world !== undefined ? { world } : {}),
                        ...(replyProcessors !== undefined ? { replyProcessors } : {}),
                    });
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, sessions }));
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
                // defaults / 会话状态变更后主动同步给已连接的酒馆扩展
                if (patch.defaults !== undefined) {
                    log(`默认角色/世界书已更新：${cfg.defaults?.character || '(未设)'} / ${cfg.defaults?.world || '(未设)'}`);
                    broadcastToST({
                        type: 'session_state',
                        sessions,
                        defaults: cfg.defaults ?? {},
                        imageReplies: cfg.imageReplies ?? {},
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
    if (req.method === 'GET' && req.url?.startsWith('/faces/cache/')) {
        const name = decodeURIComponent(req.url.slice('/faces/cache/'.length).split('?')[0]);
        // 防目录穿越：只允许纯文件名
        if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) {
            res.writeHead(400);
            res.end('bad request');
            return;
        }
        const file = path.join(faces.store.cacheDir, name);
        if (!fs.existsSync(file)) {
            res.writeHead(404);
            res.end('not found');
            return;
        }
        const ext = path.extname(file).toLowerCase();
        const type =
            ext === '.png' ? 'image/png'
                : ext === '.gif' ? 'image/gif'
                    : ext === '.webp' ? 'image/webp'
                        : 'image/jpeg';
        res.writeHead(200, {
            'Content-Type': type,
            'Cache-Control': 'public, max-age=86400',
        });
        fs.createReadStream(file).pipe(res);
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

    // GET /api/faces/resolve?tag=开心   按标签取一张（调试/预览用）
    if (req.method === 'GET' && req.url?.startsWith('/api/faces/resolve')) {
        const u = new URL(req.url, 'http://127.0.0.1');
        const tag = u.searchParams.get('tag') ?? '';
        const hit = faces.pickByTag(tag);
        res.writeHead(hit ? 200 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(hit ? { ok: true, face: hit } : { ok: false, error: '未找到匹配标签' }));
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

