// snowluma-bridge.mjs — v2.1 多会话事件驱动 + Web 控制台
//
// 架构（纯事件驱动）：
//   ① QQ消息 → SnowLuma(OneBot v11) → 本连接器 → 按 sessionKey 广播给酒馆扩展
//   ② 酒馆扩展：写入聊天上下文 → /trigger 生成（酒馆直连自己的模型）
//   ③ 扩展监听 MESSAGE_RECEIVED → 携带 sessionKey 推回
//   ④ 本连接器按 sessionKey 路由 → 【回复处理管道】→ SnowLuma → QQ
//
// Web 控制台(:9510)：
//   - 上游(SnowLuma)：OneBot 地址/token、触发白名单、@限定、私聊开关
//   - 下游(酒馆)：扩展端口、消息模板
//   - 消息处理：回复处理规则增删改（replace/remove/strip）
//   - 运行日志实时查看
//   配置热保存到 config.json（OneBot 连接参数修改后自动重连）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

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


function loadConfig() {
    try {
        return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
    } catch {
        return { ...DEFAULT_CONFIG };
    }
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

function connectOnebot() {
    const url = cfg.onebotToken
        ? `${cfg.onebotUrl}?access_token=${encodeURIComponent(cfg.onebotToken)}`
        : cfg.onebotUrl;
    log(`连接 SnowLuma: ${cfg.onebotUrl}`);
    obSocket = new WebSocket(url);

    obSocket.on('open', () => log('✓ 已连接 SnowLuma'));
    obSocket.on('message', (raw) => {
        let event;
        try { event = JSON.parse(raw.toString()); } catch { return; }
        if (event.echo && wsPending.has(event.echo)) {
            const { resolve, reject } = wsPending.get(event.echo);
            wsPending.delete(event.echo);
            event.status === 'failed' ? reject(new Error(event.message ?? 'failed')) : resolve(event);
            return;
        }
        if (event.post_type === 'meta_event' && event.meta_event_type === 'lifecycle') {
            selfId = event.self_id;
            log('机器人 QQ:', selfId);
        }
        handleMessage(event);
    });
    obSocket.on('close', () => {
        log('SnowLuma 断开，5 秒后重连…');
        setTimeout(connectOnebot, 5000);
    });
    obSocket.on('error', (e) => log('SnowLuma WS 错误:', e.message));
}

function callOnebot(action, params) {
    return new Promise((resolve, reject) => {
        if (!obSocket || obSocket.readyState !== WebSocket.OPEN) {
            return reject(new Error('OneBot WS 未连接'));
        }
        const echo = `bridge_${++echoSeq}`;
        wsPending.set(echo, { resolve, reject });
        obSocket.send(JSON.stringify({ action, params, echo }));
        setTimeout(() => {
            if (wsPending.has(echo)) {
                wsPending.delete(echo);
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
        maxLen = 120,
        minLen = 8,
        maxSegments = 4,
        hardChars = '。！？!?…',
        softChars = '，,；;',
        pairChars = ['*', '"', '\u201c\u201d'],
        splitStrings = [],
        splitOnPairs = true,      // 配对符本身是否作为分段边界
        delayMs = [300, 900],
        keepDelimiter = true,
    } = opts;

    if (!enabled) return [{ text, delayMs: 0 }];
    const trimmed = (text ?? '').trim();
    if (!trimmed) return [];

    // ---------- 步骤 1：找出所有配对符区间的片段 ----------
    // 结果是一个 token 列表：{ text, isPair, pairIndex }
    const pairs = [];
    for (const p of pairChars) {
        if (!p) continue;
        if (p.length >= 2) pairs.push([p[0], p[1]]);
        else pairs.push([p, p]);
    }

    // 统一用占位符标记配对段落
    const pairSegments = [];
    let work = trimmed;
    for (const [open, close] of pairs) {
        const esc = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(esc(open) + '[^' + esc(open) + esc(close) + ']*?' + esc(close), 'g');
        work = work.replace(re, (m) => {
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
    let result = merged;
    if (result.length > maxSegments) {
        const head = result.slice(0, maxSegments - 1);
        const tail = result.slice(maxSegments - 1).join('');
        result = [...head, tail];
    }

    // ---------- 步骤 8：长度兜底 + 随机延迟 ----------
    result = result.map((t) => (t.length > cfg.maxMessageLength
        ? t.slice(0, cfg.maxMessageLength) + '…'
        : t));

    const [dMin, dMax] = delayMs;
    return result.map((t, i) => ({
        text: t,
        delayMs: i === 0 ? 0 : dMin + Math.floor(Math.random() * Math.max(1, dMax - dMin)),
    }));
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
            const payload = buildOutgoingPayload(seg.text);
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
 * 把文本里的图片标记转成 OneBot 消息段。
 * 支持形式：
 *   [img:https://...]  [image:https://...]  [图片:https://...]
 *   <img src="...">    （从酒馆 HTML 里抓）
 */
function buildOutgoingPayload(text) {
    const imgRe = /\[(?:img|image|图片|表情)[:：]\s*([^\]\s]+)\s*\]/gi;
    const imgSrcRe = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;

    const found = [];
    let m;
    while ((m = imgRe.exec(text)) !== null) found.push({ index: m.index, url: m[1], len: m[0].length });
    while ((m = imgSrcRe.exec(text)) !== null) found.push({ index: m.index, url: m[1], len: m[0].length });

    if (!found.length) return text;   // 纯文本

    found.sort((a, b) => a.index - b.index);

    const segs = [];
    let cursor = 0;
    for (const f of found) {
        if (f.index > cursor) {
            const t = text.slice(cursor, f.index).trim();
            if (t) segs.push({ type: 'text', data: { text: t } });
        }
        segs.push({ type: 'image', data: { file: f.url } });
        cursor = f.index + f.len;
    }
    const tail = text.slice(cursor).trim();
    if (tail) segs.push({ type: 'text', data: { text: tail } });

    return segs;
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
 * 直接扫描 SillyTavern 数据目录，得到角色/世界书清单。
 * 作为扩展上报的兜底（扩展未上报或酒馆未刷新时也能用）。
 */
function scanStCatalog() {
    const stData = cfg.stDataDir || 'D:\\WorkSpace\\SillyTavern\\data\\default-user';
    const out = { characters: [], worlds: [], updatedAt: new Date().toISOString() };
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
    socket.on('pong', () => { socket.isAlive = true; });
    log(`酒馆扩展已接入（当前 ${stClients.size} 个连接）`);
    socket.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type === 'ping') {           // 扩展心跳：原样回 pong（复用 message 通道）
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

// ================= Web 控制台 =================
const PAGE = () => `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>SnowLuma-ST Bridge 控制台</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin:0; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; background:#0f1420; color:#d8dee9; }
header { padding:14px 24px; background:#161d2e; border-bottom:1px solid #2a3550; display:flex; align-items:center; gap:12px; }
header h1 { font-size:16px; margin:0; }
header .pill { font-size:12px; padding:2px 10px; border-radius:10px; background:#223; }
main { display:grid; grid-template-columns: 1fr 380px; gap:16px; padding:16px 24px; max-width:1400px; margin:0 auto; }
@media (max-width: 1000px) { main { grid-template-columns: 1fr; } }
.card { background:#161d2e; border:1px solid #2a3550; border-radius:10px; padding:16px; margin-bottom:16px; }
.card h2 { font-size:14px; margin:0 0 12px; color:#7fb2ff; }
label { display:block; font-size:12px; color:#8a94a8; margin:10px 0 4px; }
input, select { width:100%; padding:7px 10px; border-radius:6px; border:1px solid #2a3550; background:#0d1220; color:#d8dee9; font-size:13px; }
input[type=checkbox]{ width:auto; }
.row { display:flex; gap:10px; }
.row > div { flex:1; }
button { padding:7px 16px; border-radius:6px; border:1px solid #35507d; background:#22406b; color:#cfe3ff; cursor:pointer; font-size:13px; }
button:hover { background:#2c5188; }
button.danger { background:#5b2330; border-color:#7d3547; color:#ffc9d2; }
button.small { padding:3px 10px; font-size:12px; }
.rule { border:1px solid #2a3550; border-radius:8px; padding:10px; margin-bottom:8px; background:#121828; }
.rule .head { display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; }
.tag { font-size:11px; padding:1px 8px; border-radius:8px; background:#24406e; color:#9ec1ff; }
#log { height: 420px; overflow-y:auto; background:#0a0e18; border:1px solid #2a3550; border-radius:8px; padding:10px; font-family:Consolas,monospace; font-size:12px; line-height:1.5; white-space:pre-wrap; word-break:break-all; }
.stat { display:inline-block; margin: 2px 8px 2px 0; font-size:12px; color:#9aa7bd; }
.kv { display:flex; gap:8px; align-items:center; margin-bottom:6px; flex-wrap:wrap; }
.kv input { flex:1; min-width:110px; }
.hint { font-size:11px; color:#61708a; margin-top:4px; }
.toast { position:fixed; top:16px; right:16px; background:#2c5188; color:#fff; padding:8px 16px; border-radius:8px; opacity:0; transition:opacity .3s; }
.toast.show { opacity:1; }
</style>
</head>
<body>
<header>
  <h1>SnowLuma-ST Bridge</h1>
  <span class="pill" id="obStatus">上游: --</span>
  <span class="pill" id="stStatus">下游: --</span>
  <span class="pill" id="botInfo">机器人: --</span>
</header>
<main>
  <section>
    <div class="card">
      <h2>会话</h2>
      <div id="sessions"><span class="stat">暂无会话</span></div>
    </div>

    <div class="card">
      <h2>会话级配置</h2>
      <div class="hint" style="margin-bottom:8px">
        每个 QQ 号可独立设置角色、世界书、回复处理管道。<br>
        管道留空 = 继承「全局默认管道」；点了「独立配置」则只用自己的规则。
      </div>
      <div id="sessionChoices"></div>
    </div>

    <div class="card">
      <h2>运行日志（最近 500 条）</h2>
      <div id="log"></div>
    </div>
  </section>

  <aside>
    <div class="card">
      <h2>上游 · SnowLuma</h2>
      <label>OneBot WebSocket 地址</label>
      <input id="onebotUrl">
      <label>Access Token</label>
      <input id="onebotToken" type="password">
      <label>单条消息长度上限</label>
      <input id="maxMessageLength" type="number">
      <div class="row">
        <div><label>群聊仅 @ 触发</label><input id="atOnly" type="checkbox"></div>
        <div><label>私聊自动回复</label><input id="privateReply" type="checkbox"></div>
      </div>
      <label>用户白名单（逗号分隔 QQ 号，留空不限）</label>
      <input id="allowedUsers">
      <label>群白名单（逗号分隔群号，留空不限）</label>
      <input id="allowedGroups">
      <div style="margin-top:12px; display:flex; gap:8px">
        <button id="saveUpstream">保存并重连上游</button>
      </div>
      <div class="hint">上游连接参数修改后会自动断开重连 SnowLuma。</div>
    </div>

    <div class="card">
      <h2>默认角色 / 世界书</h2>
      <div class="hint" style="margin-bottom:8px">酒馆当前未选择角色时，自动使用这里的默认值。会话级选择（QQ 指令切换过）优先。</div>
      <label>默认角色</label>
      <select id="defaultCharacter"><option value="">（不自动选择）</option></select>
      <label>默认世界书</label>
      <select id="defaultWorld"><option value="">（不自动激活）</option></select>
      <div style="margin-top:12px;display:flex;gap:8px">
        <button id="saveDefaults">保存默认</button>
        <button id="refreshCatalog" class="small">刷新清单</button>
      </div>
      <div class="hint" id="catalogInfo"></div>
    </div>

    <div class="card">
      <h2>全局默认回复管道</h2>
      <div class="hint" style="margin-bottom:8px">
        所有「未单独配置管道」的会话都会使用这里的规则。按顺序执行。
      </div>
      <div id="rules"></div>
      <div class="row" style="margin-top:10px">
        <button id="addRule">+ 添加规则</button>
        <button id="testPipeline">测试管道</button>
      </div>
      <div id="testArea" style="display:none; margin-top:10px">
        <label>样例文本（AI 原始回复）</label>
        <input id="testInput" value="*她微微一笑* 你好呀！[CQ:face] 今天天气不错。">
        <label>处理结果</label>
        <input id="testOutput" readonly>
      </div>
      <div style="margin-top:12px"><button id="saveGlobalPipeline">保存全局管道</button></div>
    </div>

    <div class="card">
      <h2>回复分段</h2>
      <div class="hint" style="margin-bottom:8px">按标点把长回复拆成多条短消息，更像真人聊天。</div>
      <label class="checkbox_label"><input id="segEnabled" type="checkbox"> 启用分段发送</label>
      <div class="row">
        <div><label>单条最大字数</label><input id="segMaxLen" type="number" min="20"></div>
        <div><label>最多分几条</label><input id="segMaxSeg" type="number" min="1" max="10"></div>
      </div>
      <div class="row">
        <div><label>间隔最小(ms)</label><input id="segDelayMin" type="number" min="0"></div>
        <div><label>间隔最大(ms)</label><input id="segDelayMax" type="number" min="0"></div>
      </div>

      <label style="margin-top:12px">硬分隔符（句末标点，切分边界）</label>
      <input id="segHard" type="text" placeholder="。！？!?…">
      <label>软分隔符（逗号类，仅超长时二次切分）</label>
      <input id="segSoft" type="text" placeholder="，,；;">
      <label>配对符（成对内容保持完整，如 *动作* / "台词"）</label>
      <div class="row">
        <input id="segPair1" type="text" placeholder="*" style="max-width:70px">
        <input id="segPair2" type="text" placeholder="&quot;" style="max-width:70px">
        <input id="segPair3" type="text" placeholder="“”" style="max-width:70px">
      </div>
      <label class="checkbox_label" style="margin-top:8px">
        <input id="segSplitOnPairs" type="checkbox"> 配对符内容作为独立消息分段
      </label>
      <label>自定义分隔串（每行一个，按字面量切分，优先级最高）</label>
      <textarea id="segSplitStrings" class="text_pole" rows="3" style="width:100%;font-family:monospace"
        placeholder="留空则不用。示例：&#10;||&#10;---"></textarea>

      <div style="margin-top:12px;display:flex;gap:8px">
        <button id="saveSeg">保存分段设置</button>
        <button id="testSeg" class="small">预览切分效果</button>
      </div>
      <label id="segTestLabel" style="display:none;margin-top:10px">测试文本</label>
      <textarea id="segTestInput" class="text_pole" rows="3" style="width:100%;display:none"
        placeholder="粘贴一段 AI 回复，点击预览看会切成几条"></textarea>
      <div id="segPreview" style="margin-top:8px"></div>
    </div>

    <div class="card">
      <h2>图片 / 表情包</h2>
      <div class="hint" style="margin-bottom:8px">
        AI 用 <code>[图片:URL]</code> 标记即可发表情包。首条消息会向酒馆注入使用说明。
      </div>
      <label class="checkbox_label"><input id="imgEnabled" type="checkbox"> 启用图片回复</label>
      <label>图片库地址（可选，供 AI 引用）</label>
      <input id="imgBaseUrl" type="text" placeholder="https://example.com/emojis/">
      <div style="margin-top:12px"><button id="saveImg">保存图片设置</button></div>
    </div>

    <div class="card">
      <h2>下游 · 酒馆扩展</h2>
      <label>扩展 WS 端口</label>
      <input id="stExtPort" type="number">
      <div class="hint">酒馆扩展连接 ws://127.0.0.1:&lt;端口&gt;。修改端口后需重启连接器并在扩展设置中同步。</div>
      <div style="margin-top:12px">
        <button id="saveDownstream">保存</button>
      </div>
    </div>
  </aside>
</main>
<div class="toast" id="toast"></div>
<script>
const $ = (s) => document.querySelector(s);
const state = {};

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1600);
}
async function api(path, body) {
  const r = await fetch('/api' + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

function ruleRow(rule, i) {
  const div = document.createElement('div');
  div.className = 'rule';
  div.innerHTML = \`
    <div class="head">
      <span style="display:flex;align-items:center;gap:8px">
        <label style="margin:0;font-size:12px;flex-shrink:0">启用 <input class="r-enabled" type="checkbox" style="vertical-align:middle"></label>
        <span class="tag">#\${i + 1} <select class="r-type" style="background:#0d1220;color:#9ec1ff;border:none">
        <option value="replace">替换 replace</option>
        <option value="remove">删除 remove</option>
        <option value="strip">区域删除 strip</option>
      </select></span>
      </span>
      <button class="small danger r-del">删除</button>
    </div>
    <div class="kv r-regex"><input class="r-pattern" placeholder="正则表达式（pattern）"><input class="r-flags" placeholder="flags，如 g" style="max-width:80px"><input class="r-replacement" placeholder="替换为（留空=删除）"></div>
    <div class="kv r-strip" style="display:none"><input class="r-begin" placeholder="开始标记，如 *"><input class="r-end" placeholder="结束标记，如 *"><label style="margin:0;flex-shrink:0">保留内容 <input class="r-keep" type="checkbox"></label></div>\`;
  div.querySelector('.r-type').value = rule.type ?? 'replace';
  div.querySelector('.r-enabled').checked = rule.enabled !== false;
  div.querySelector('.r-pattern').value = rule.pattern ?? '';
  div.querySelector('.r-flags').value = rule.flags ?? 'g';
  div.querySelector('.r-replacement').value = rule.replacement ?? '';
  div.querySelector('.r-begin').value = rule.begin ?? '';
  div.querySelector('.r-end').value = rule.end ?? '';
  div.querySelector('.r-keep').checked = rule.keep === true;
  const sync = () => {
    const t = div.querySelector('.r-type').value;
    div.querySelector('.r-regex').style.display = (t === 'strip') ? 'none' : 'flex';
    div.querySelector('.r-strip').style.display = (t === 'strip') ? 'flex' : 'none';
    div.style.opacity = div.querySelector('.r-enabled').checked ? '1' : '.45';
  };
  div.querySelector('.r-type').onchange = sync;
  div.querySelector('.r-enabled').onchange = sync;
  sync();
  div.querySelector('.r-del').onclick = () => { div.remove(); collectRules(); };
  div.querySelectorAll('input,select').forEach(el => el.onchange = collectRules);
  return div;
}

function collectRules() {
  const rules = [];
  document.querySelectorAll('#rules .rule').forEach(div => {
    const t = div.querySelector('.r-type').value;
    const r = { type: t, enabled: div.querySelector('.r-enabled').checked };
    if (t === 'strip') {
      r.begin = div.querySelector('.r-begin').value;
      r.end = div.querySelector('.r-end').value;
      r.keep = div.querySelector('.r-keep').checked;
    } else {
      r.pattern = div.querySelector('.r-pattern').value;
      r.flags = div.querySelector('.r-flags').value || 'g';
      r.replacement = div.querySelector('.r-replacement').value;
    }
    rules.push(r);
  });
  state.rules = rules;
  // 规则变更自动保存（热生效）
  api('/config', { replyProcessors: rules }).then(() => {});
  return rules;
}

function renderRules(rules) {
  const box = $('#rules'); box.innerHTML = '';
  rules.forEach((r, i) => box.appendChild(ruleRow(r, i)));
  state.rules = rules;
}

$('#addRule').onclick = () => {
  const box = $('#rules');
  box.appendChild(ruleRow({ type: 'replace', pattern: '', flags: 'g', replacement: '', enabled: true }, box.children.length));
  collectRules();
};
$('#testPipeline').onclick = () => {
  const a = $('#testArea'); a.style.display = a.style.display === 'none' ? 'block' : 'none';
};
$('#testInput').oninput = async (e) => {
  const r = await api('/test-pipeline', { text: e.target.value, rules: collectRules() });
  $('#testOutput').value = r.result;
};

$('#saveUpstream').onclick = async () => {
  await api('/config', {
    onebotUrl: $('#onebotUrl').value,
    onebotToken: $('#onebotToken').value,
    maxMessageLength: Number($('#maxMessageLength').value) || 2000,
    trigger: {
      atOnly: $('#atOnly').checked,
      privateReply: $('#privateReply').checked,
      allowedUsers: $('#allowedUsers').value.split(',').map(s => s.trim()).filter(Boolean).map(Number),
      allowedGroups: $('#allowedGroups').value.split(',').map(s => s.trim()).filter(Boolean).map(Number),
    },
    replyProcessors: collectRules(),
  });
  toast('已保存并重连上游');
};
$('#saveDownstream').onclick = async () => {
  await api('/config', { stExtPort: Number($('#stExtPort').value) || 9500, replyProcessors: collectRules() });
  toast('已保存（端口修改需重启连接器生效）');
};

// ===== 默认角色/世界书 =====
function fillSelect(sel, items, currentValue) {
  const el = $(sel);
  // 优先保留用户当前选择，其次用传入的配置值
  const keep = el.value || currentValue || '';
  el.innerHTML = '<option value="">（不自动选择）</option>';
  for (const item of items) {
    const o = document.createElement('option');
    o.value = item; o.textContent = item;
    el.appendChild(o);
  }
  if (keep && items.includes(keep)) el.value = keep;
}

function applyCatalog(c) {
  if (!c) return;
  fillSelect('#defaultCharacter', c.characters ?? [], state.defaultCharacter);
  fillSelect('#defaultWorld', c.worlds ?? [], state.defaultWorld);
  $('#catalogInfo').textContent = '清单更新于 ' + (c.updatedAt ? new Date(c.updatedAt).toLocaleTimeString() : '--')
    + ' · ' + (c.characters ?? []).length + ' 角色 / ' + (c.worlds ?? []).length + ' 世界书';
}

$('#refreshCatalog').onclick = async () => {
  await api('/catalog/refresh');
  const s = await api('/status');
  applyCatalog(s.catalogs);
  toast('清单已刷新');
};

$('#saveDefaults').onclick = async () => {
  await api('/config', {
    defaults: { character: $('#defaultCharacter').value, world: $('#defaultWorld').value },
  });
  toast('默认角色/世界书已保存');
};

// ===== 全局默认管道 =====
$('#saveGlobalPipeline').onclick = async () => {
  const rules = collectRules();
  await api('/config', { replyProcessors: rules });
  toast('全局默认管道已保存（' + rules.length + ' 条规则）');
};

// ===== 分段设置 =====
function readSegConfig() {
  const pairs = [$('#segPair1').value, $('#segPair2').value, $('#segPair3').value]
    .map((v) => v ?? '')
    .filter((v) => v.length > 0);
  const splitStrings = ($('#segSplitStrings').val() ?? '')
    .split('\\n')
    .map((l) => l.trim())
    .filter(Boolean);

  return {
    enabled: $('#segEnabled').checked,
    maxLen: Number($('#segMaxLen').value) || 120,
    minLen: 8,
    maxSegments: Number($('#segMaxSeg').value) || 4,
    hardChars: $('#segHard').value || '。！？!?…',
    softChars: $('#segSoft').value || '，,；;',
    pairChars: pairs,
    splitStrings,
    splitOnPairs: $('#segSplitOnPairs').checked,
    delayMs: [
      Number($('#segDelayMin').value) || 300,
      Number($('#segDelayMax').value) || 900,
    ],
  };
}

$('#saveSeg').onclick = async () => {
  await api('/config', { segmentation: readSegConfig() });
  toast('分段设置已保存');
};

$('#testSeg').onclick = async () => {
  const show = $('#segTestInput').css('display') === 'none';
  $('#segTestInput').css('display', show ? 'block' : 'none');
  $('#segTestLabel').css('display', show ? 'block' : 'none');
  if (!show) return;

  const text = $('#segTestInput').val() || '*她抬起头。* "你来啦！" 今天天气不错。';
  const r = await api('/test-segments', { text, config: readSegConfig() });
  const box = $('#segPreview');
  if (!r.segments?.length) {
    box.innerHTML = '<div class="hint">无内容</div>';
    return;
  }
  box.innerHTML = '<div class="hint">会切成 ' + r.segments.length + ' 条：</div>'
    + r.segments.map((s2, i) =>
      '<div style="font-size:12px;padding:4px 8px;margin:3px 0;background:#121828;border-left:2px solid #35507d">'
      + '[' + (i + 1) + '] ' + escapeAttr(s2.text) + '</div>').join('');
};

// ===== 图片设置 =====
$('#saveImg').onclick = async () => {
  await api('/config', {
    imageReplies: {
      enabled: $('#imgEnabled').checked,
      instruction: true,
      baseUrl: $('#imgBaseUrl').value.trim(),
    },
  });
  toast('图片设置已保存');
};

// ===== 会话级配置面板（角色 / 世界书 / 独立管道） =====
function renderSessionChoices(s) {
  const box = $('#sessionChoices');
  if (!box) return;

  const choices = s.sessionChoices ?? {};
  const keys = Object.keys(choices);
  const chars = s.catalogs?.characters ?? [];
  const worlds = s.catalogs?.worlds ?? [];
  const dflt = s.config?.defaults ?? {};
  const globalRules = s.config?.replyProcessors ?? [];

  if (!keys.length) {
    box.innerHTML = '<span class="stat">还没有会话记录（QQ 发过消息后自动出现）</span>';
    return;
  }

  // 避免每 2 秒重绘打断用户正在操作的输入
  const focused = document.activeElement;
  if (box.contains(focused) && ['SELECT', 'INPUT'].includes(focused.tagName)) return;

  const modeOf = (c) => (Array.isArray(c.replyProcessors) ? 'custom' : 'inherit');

  box.innerHTML = keys.map((k) => {
    const c = choices[k] ?? {};
    const mode = modeOf(c);
    const charOpts = ['<option value="">（用默认）</option>']
      .concat(chars.map((n) => '<option value="' + n + '"' + (c.character === n ? ' selected' : '') + '>' + n + '</option>'))
      .join('');
    const worldOpts = ['<option value="">（用默认）</option>']
      .concat(worlds.map((n) => '<option value="' + n + '"' + (c.world === n ? ' selected' : '') + '>' + n + '</option>'))
      .join('');

    const rules = Array.isArray(c.replyProcessors) ? c.replyProcessors : [];
    const rows = [
      '<div class="rule" data-key="' + k + '">',
      '  <div class="head"><span class="tag">' + k + '</span>',
      '    <button class="small danger s-del">清除配置</button></div>',
      '  <div class="kv"><span style="font-size:12px;width:56px">角色</span><select class="s-char" style="flex:1">' + charOpts + '</select></div>',
      '  <div class="kv"><span style="font-size:12px;width:56px">世界书</span><select class="s-world" style="flex:1">' + worldOpts + '</select></div>',
      '  <div class="kv" style="margin-top:8px"><span style="font-size:12px;width:56px">管道</span>',
      '    <select class="s-mode" style="flex:1">',
      '      <option value="inherit"' + (mode === 'inherit' ? ' selected' : '') + '>继承全局（' + globalRules.length + ' 条规则）</option>',
      '      <option value="custom"' + (mode === 'custom' ? ' selected' : '') + '>独立配置</option>',
      '    </select></div>',
      '  <div class="s-rules" style="display:' + (mode === 'custom' ? 'block' : 'none') + ';margin-top:8px">',
      '    <div class="s-rule-list"></div>',
      '    <button class="small s-add-rule" style="margin-top:6px">+ 添加规则</button>',
      '  </div>',
      '  <div class="hint">默认: 角色 ' + (dflt.character || '(未设)') + ' / 世界书 ' + (dflt.world || '(未设)') + '</div>',
      '</div>',
    ];
    const html = rows.join('\\n');

    // 用占位符承载规则，渲染后由 JS 挂载规则编辑器
    return html.replace(
      '<div class="s-rule-list"></div>',
      '<div class="s-rule-list" data-rules="' + encodeURIComponent(JSON.stringify(rules)) + '"></div>',
    );
  }).join('');

  // ---- 绑定事件 ----
  box.querySelectorAll('.rule').forEach((div) => {
    const key = div.dataset.key;

    div.querySelector('.s-char').onchange = async (e) => {
      await api('/session-choice', { sessionKey: key, character: e.target.value });
      toast('已保存 ' + key + ' 的角色');
    };
    div.querySelector('.s-world').onchange = async (e) => {
      await api('/session-choice', { sessionKey: key, world: e.target.value });
      toast('已保存 ' + key + ' 的世界书');
    };
    div.querySelector('.s-del').onclick = async () => {
      await api('/session-choice', { sessionKey: key, reset: true });
      toast('已清除 ' + key + ' 的全部配置');
    };

    const modeSel = div.querySelector('.s-mode');
    const rulesBox = div.querySelector('.s-rules');
    const listEl = div.querySelector('.s-rule-list');
    let rules = [];
    try {
      rules = JSON.parse(decodeURIComponent(listEl.dataset.rules || '%5B%5D'));
    } catch { rules = []; }

    const mountRules = () => {
      listEl.innerHTML = '';
      rules.forEach((r, i) => listEl.appendChild(makeRuleEditor(r, i, () => persist())));
      if (!rules.length) {
        listEl.innerHTML = '<div class="hint" style="opacity:.6">暂无规则（空管道 = 原文直出）</div>';
      }
    };

    const persist = async () => {
      rules = [...listEl.querySelectorAll('.s-rule-item')].map(collectOneRule).filter(Boolean);
      await api('/session-choice', { sessionKey: key, replyProcessors: rules });
    };

    modeSel.onchange = async () => {
      const m = modeSel.value;
      rulesBox.style.display = m === 'custom' ? 'block' : 'none';
      if (m === 'custom') {
        if (!rules.length) rules = [];
        mountRules();
        await api('/session-choice', { sessionKey: key, replyProcessors: rules });
        toast(key + '：已切换为独立管道');
      } else {
        await api('/session-choice', { sessionKey: key, reset: 'pipeline' });
        toast(key + '：已恢复继承全局管道');
      }
    };

    div.querySelector('.s-add-rule').onclick = async () => {
      rules.push({ type: 'replace', pattern: '', flags: 'g', replacement: '', enabled: true });
      mountRules();
      await persist();
    };

    if (mode === 'custom') mountRules();
  });
}

/** 单条规则的编辑器（会话级用，紧凑版） */
function makeRuleEditor(rule, index, onChange) {
  const div = document.createElement('div');
  div.className = 'rule s-rule-item';
  div.style.marginBottom = '6px';
  div.dataset.type = rule.type ?? 'replace';

  const typeOpts = ['replace', 'remove', 'strip']
    .map((t) => '<option value="' + t + '"' + (rule.type === t ? ' selected' : '') + '>' + t + '</option>')
    .join('');

  const rows = [
    '<div class="head"><span style="display:flex;gap:6px;align-items:center">',
    '  <label style="margin:0;font-size:11px">启用 <input class="r-enabled" type="checkbox"' + (rule.enabled === false ? '' : ' checked') + ' style="vertical-align:middle"></label>',
    '  <select class="r-type" style="background:#0d1220;color:#9ec1ff;border:none">' + typeOpts + '</select>',
    '</span><button class="small danger r-del">×</button></div>',
    '<div class="kv r-regex"><input class="r-pattern" placeholder="正则" value="' + escapeAttr(rule.pattern ?? '') + '">',
    '  <input class="r-flags" placeholder="flags" value="' + escapeAttr(rule.flags ?? 'g') + '" style="max-width:60px">',
    '  <input class="r-replacement" placeholder="替换为" value="' + escapeAttr(rule.replacement ?? '') + '"></div>',
    '<div class="kv r-strip" style="display:none"><input class="r-begin" placeholder="开始" value="' + escapeAttr(rule.begin ?? '') + '">',
    '  <input class="r-end" placeholder="结束" value="' + escapeAttr(rule.end ?? '') + '">',
    '  <label style="margin:0;flex-shrink:0;font-size:11px">保留内容 <input class="r-keep" type="checkbox"' + (rule.keep === true ? ' checked' : '') + '></label></div>',
  ];
  div.innerHTML = rows.join('\\n');

  const sync = () => {
    const t = div.querySelector('.r-type').value;
    div.dataset.type = t;
    div.querySelector('.r-regex').style.display = t === 'strip' ? 'none' : 'flex';
    div.querySelector('.r-strip').style.display = t === 'strip' ? 'flex' : 'none';
    div.style.opacity = div.querySelector('.r-enabled').checked ? '1' : '.5';
  };
  div.querySelector('.r-type').onchange = () => { sync(); onChange(); };
  div.querySelector('.r-enabled').onchange = () => { sync(); onChange(); };
  div.querySelectorAll('input').forEach((el) => { el.onchange = onChange; });
  div.querySelector('.r-del').onclick = () => {
    div.remove();
    onChange();
  };
  sync();
  return div;
}

function collectOneRule(div) {
  const type = div.querySelector('.r-type').value;
  const enabled = div.querySelector('.r-enabled').checked;
  if (type === 'strip') {
    const begin = div.querySelector('.r-begin').value;
    const end = div.querySelector('.r-end').value;
    if (!begin || !end) return null;
    return { type, enabled, begin, end, keep: div.querySelector('.r-keep').checked };
  }
  const pattern = div.querySelector('.r-pattern').value;
  if (!pattern) return null;
  return {
    type,
    enabled,
    pattern,
    flags: div.querySelector('.r-flags').value || 'g',
    replacement: div.querySelector('.r-replacement').value,
  };
}

function escapeAttr(v) {
  return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

async function refresh() {  const s = await api('/status');
  $('#obStatus').textContent = '上游: ' + (s.onebotConnected ? '已连接' : '未连接');
  $('#obStatus').style.color = s.onebotConnected ? '#7fe0a0' : '#ff8a9a';
  $('#stStatus').textContent = '下游: ' + (s.stClients > 0 ? \`已接入(\${s.stClients})\` : '未接入');
  $('#stStatus').style.color = s.stClients > 0 ? '#7fe0a0' : '#ff8a9a';
  $('#botInfo').textContent = '机器人: ' + (s.selfId ?? '--');

  const sess = Object.entries(s.sessions);
  $('#sessions').innerHTML = sess.length
    ? sess.map(([k, v]) => \`<span class="stat"><b>\${k}</b> · 收 \${v.in} / 发 \${v.out} · \${new Date(v.last).toLocaleTimeString()}</span>\`).join('')
    : '<span class="stat">暂无会话</span>';

  $('#log').textContent = s.logs.join('\\n');
  $('#log').scrollTop = $('#log').scrollHeight;

  renderSessionChoices(s);

  if (!state.loaded) {
    state.loaded = true;
    $('#onebotUrl').value = s.config.onebotUrl;
    $('#onebotToken').value = s.config.onebotToken;
    $('#maxMessageLength').value = s.config.maxMessageLength;
    $('#atOnly').checked = s.config.trigger.atOnly;
    $('#privateReply').checked = s.config.trigger.privateReply;
    $('#allowedUsers').value = (s.config.trigger.allowedUsers ?? []).join(',');
    $('#allowedGroups').value = (s.config.trigger.allowedGroups ?? []).join(',');
    $('#stExtPort').value = s.config.stExtPort;
    renderRules(s.config.replyProcessors ?? []);
    state.defaultCharacter = s.config.defaults?.character ?? '';
    state.defaultWorld = s.config.defaults?.world ?? '';
    const seg = s.config.segmentation ?? {};
    $('#segEnabled').prop('checked', seg.enabled !== false);
    $('#segMaxLen').val(seg.maxLen ?? 120);
    $('#segMaxSeg').val(seg.maxSegments ?? 4);
    $('#segDelayMin').val(seg.delayMs?.[0] ?? 300);
    $('#segDelayMax').val(seg.delayMs?.[1] ?? 900);
    $('#segHard').val(seg.hardChars ?? '。！？!?…');
    $('#segSoft').val(seg.softChars ?? '，,；;');
    const pc = seg.pairChars ?? ['*', '"', '“”'];
    $('#segPair1').val(pc[0] ?? '');
    $('#segPair2').val(pc[1] ?? '');
    $('#segPair3').val(pc[2] ?? '');
    $('#segSplitOnPairs').prop('checked', seg.splitOnPairs !== false);
    $('#segSplitStrings').val((seg.splitStrings ?? []).join('\\n'));
    const img = s.config.imageReplies ?? {};
    $('#imgEnabled').prop('checked', img.enabled !== false);
    $('#imgBaseUrl').val(img.baseUrl ?? '');
  }
  // 每次刷新都同步清单（扩展上报后自动出现在下拉里，保留当前选中值）
  if (s.catalogs && (s.catalogs.characters?.length || s.catalogs.worlds?.length)) {
    applyCatalog(s.catalogs);
  }
}
refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;

const consoleServer = http.createServer((req, res) => {
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
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(PAGE());
        return;
    }
    if (req.method === 'GET' && req.url === '/api/status') {
        refreshCatalogsFromDisk();          // 每次查询都刷新（文件系统扫描，开销可忽略）
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            onebotConnected: obSocket?.readyState === WebSocket.OPEN,
            stClients: stClients.size,
            selfId,
            sessions: Object.fromEntries([...sessionStats.entries()]),
            sessionChoices: sessions,
            catalogs,
            logs: logBuffer,
            config: cfg,
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

                cfg = { ...cfg, ...patch, trigger: { ...cfg.trigger, ...(patch.trigger ?? {}) } };

                // replyProcessors 单独处理：全量替换
                if (patch.replyProcessors !== undefined) cfg.replyProcessors = patch.replyProcessors;

                saveConfig();
                if (onebotChanged) {
                    log('上游连接参数已变更，重连 SnowLuma…');
                    try { obSocket?.close(); } catch { /* 重连逻辑接管 */ }
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
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
    res.writeHead(404); res.end('not found');
});
consoleServer.listen(cfg.consolePort ?? 9510, '127.0.0.1', () =>
    log(`Web 控制台已启动: http://127.0.0.1:${cfg.consolePort ?? 9510}`));

connectOnebot();
log(`连接器 v2.1 已启动: SnowLuma=${cfg.onebotUrl} | 扩展端口=${cfg.stExtPort} | 控制台=${cfg.consolePort ?? 9510}`);
