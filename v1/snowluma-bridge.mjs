// snowluma-bridge.mjs — 事件驱动版
//
// 流程（全程事件驱动，无任何等待/轮询）：
//   ① QQ消息 → SnowLuma(OneBot v11) → 本连接器 → WS 广播给酒馆扩展
//   ② 酒馆扩展把消息写入聊天并触发生成（酒馆用自己的模型配置直接生成）
//   ③ 酒馆扩展监听 MESSAGE_RECEIVED 事件 → 把回复推回本连接器
//   ④ 本连接器 → SnowLuma → QQ
//
// 本脚本 = OneBot 客户端(连 SnowLuma:3001) + WS 服务端(:9500，供酒馆扩展接入)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const {
    onebotUrl = 'ws://127.0.0.1:3001',
    onebotToken = '',
    stExtPort = 9500,           // 酒馆扩展连接的 WS 服务端口
    trigger: {
        atOnly = true,
        privateReply = true,
        allowedUsers = [],
        allowedGroups = [],
    } = {},
    maxMessageLength = 2000,
} = cfg;

const log = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);

// 最近一次 QQ 消息的来源（作为 st_reply 缺失来源时的兜底）
let lastTarget = { message_type: 'private', group_id: null, user_id: null };

// ---------- 酒馆扩展 WS 服务端 ----------
/** @type {Set<WebSocket>} */
const stClients = new Set();

function broadcastToST(obj) {
    const data = JSON.stringify(obj);
    for (const c of stClients) {
        if (c.readyState === WebSocket.OPEN) c.send(data);
    }
}

const wss = new WebSocketServer({ host: '127.0.0.1', port: stExtPort });
wss.on('listening', () => log(`酒馆扩展 WS 服务已启动: ws://127.0.0.1:${stExtPort}`));
wss.on('connection', (socket) => {
    stClients.add(socket);
    log(`酒馆扩展已接入（当前 ${stClients.size} 个连接）`);
    socket.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type === 'st_reply') {
            // 来源缺失时用最近一条 QQ 消息的来源兜底
            if (!msg.user_id && !msg.group_id) {
                Object.assign(msg, lastTarget);
            }
            sendQQ(msg);            // 酒馆回复 → QQ
        } else if (msg.type === 'hello') {
            log(`酒馆扩展握手: ${msg.ext ?? 'unknown'}`);
        }
    });
    socket.on('close', () => {
        stClients.delete(socket);
        log(`酒馆扩展断开（剩余 ${stClients.size}）`);
    });
});

// ---------- OneBot（SnowLuma） ----------
let obSocket = null;
let echoSeq = 0;
let selfId = '';

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
const wsPending = new Map();

async function sendQQ(msg) {
    const text = (msg.text ?? '').trim();
    if (!text) return;
    const trimmed = text.length > maxMessageLength ? text.slice(0, maxMessageLength) + '…' : text;
    const params = msg.message_type === 'group'
        ? { group_id: msg.group_id, message: trimmed }
        : { user_id: msg.user_id, message: trimmed };
    try {
        await callOnebot(
            msg.message_type === 'group' ? 'send_group_msg' : 'send_private_msg',
            params,
        );
        log(`回复已发往QQ → ${msg.message_type === 'group' ? '群' + msg.group_id : '私聊' + msg.user_id}`);
    } catch (e) {
        log('QQ 发送失败:', e.message);
    }
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
    if (event.post_type !== 'message' || event.sub_type === 'bot') return;
    if (String(event.user_id) === String(selfId)) return;

    const detail = {
        message_type: event.message_type,
        group_id: event.group_id,
        user_id: event.user_id,
    };

    if (detail.message_type === 'group' && allowedGroups.length && !allowedGroups.includes(detail.group_id)) return;
    if (allowedUsers.length && !allowedUsers.includes(detail.user_id)) return;

    const { text, atMe } = parseMessage(event.message);
    if (!text) return;
    if (detail.message_type === 'group' && atOnly && !atMe) return;

    const senderName = event.sender?.card || event.sender?.nickname || String(event.user_id);
    log(`QQ消息 → 酒馆: [${senderName}] ${text}`);
    lastTarget = {
        message_type: detail.message_type,
        group_id: detail.group_id ?? null,
        user_id: detail.user_id,
    };
    broadcastToST({
        type: 'qq_message',
        sender: senderName,
        text,
        message_type: detail.message_type,
        group_id: detail.group_id ?? null,
        user_id: detail.user_id,
    });
}

function connectOnebot() {
    const url = onebotToken
        ? `${onebotUrl}?access_token=${encodeURIComponent(onebotToken)}`
        : onebotUrl;
    log(`连接 SnowLuma: ${onebotUrl}`);
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
    obSocket.on('error', (e) => log('WS 错误:', e.message));
}

connectOnebot();
log(`连接器已启动（事件驱动模式）: SnowLuma=${onebotUrl} | 酒馆扩展端口=${stExtPort}`);
