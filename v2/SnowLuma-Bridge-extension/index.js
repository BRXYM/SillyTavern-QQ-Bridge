// SnowLuma Bridge v3.0 — SillyTavern 扩展（按 QQ 号固定会话隔离）
//
// 会话绑定规则（确定性，永不变）：
//   私聊 sessionKey "private_2637143104" → 酒馆聊天文件 "QQ_2637143104"
//   群聊 sessionKey "group_884841875_1950318607" → 聊天文件 "GROUP_884841875_1950318607"
//
//   - 聊天文件名由 QQ 号唯一确定：同一个 QQ 永远只用同一个聊天
//   - 没有绑定表、没有重建逻辑：不会重复建聊，不会 session 重置
//   - ST 重启 / 扩展重装 / 页面刷新后绑定依然成立（名字即身份）
//   - 首次遇到某 QQ 时，openCharacterChat 打开同名聊天（不存在则首次保存时自动创建）
//
// 流程（纯事件驱动）：
//   QQ消息 → 连接器(sessionKey) → 扩展 → 确保当前聊天=该QQ的专属聊天 → /send + /trigger
//   回复完成(MESSAGE_RECEIVED) → 携带 sessionKey 推回连接器 → 路由回 QQ

import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const extensionName = 'SnowLuma-Bridge';
const version = '3.0.0';
const defaultSettings = {
    bridgeUrl: 'ws://127.0.0.1:9500',
    autoConnect: true,
    // QQ 消息在聊天中显示的格式
    messageTemplate: '[{sender}]: {text}',
};

if (!extension_settings[extensionName]) {
    extension_settings[extensionName] = {};
}
Object.assign(extension_settings[extensionName], defaultSettings);

const log = (...a) => console.log(`[${extensionName} v${version}]`, ...a);

let ws = null;
let reconnectTimer = null;

/** @type {Map<string, Array<{sender:string, text:string, sessionKey:string}>>} */
const pendingQueue = new Map();
let activeSession = null;      // 正在生成的 sessionKey
let switchingChat = false;     // 正在切换聊天

/** sessionKey → 确定性的聊天文件名（QQ 号即身份，永不变） */
function chatNameOf(sessionKey) {
    // private_2637143104      → QQ_2637143104
    // group_884841875_195...  → GROUP_884841875_195...
    if (sessionKey.startsWith('group_')) return 'GROUP_' + sessionKey.slice('group_'.length);
    if (sessionKey.startsWith('private_')) return 'QQ_' + sessionKey.slice('private_'.length);
    return 'QQ_' + sessionKey; // 兜底
}

function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    const url = extension_settings[extensionName].bridgeUrl;
    try {
        ws = new WebSocket(url);
    } catch (e) {
        log('WS 创建失败:', e.message);
        scheduleReconnect();
        return;
    }

    ws.onopen = () => {
        log('✓ 已连接连接器', url);
        ws.send(JSON.stringify({ type: 'hello', ext: extensionName, version }));
        updateUI(true);
    };

    ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.type === 'qq_message') onQQMessage(msg);
    };

    ws.onclose = () => {
        updateUI(false);
        scheduleReconnect();
    };
    ws.onerror = () => { /* onclose 跟随触发 */ };
}

function scheduleReconnect() {
    if (!extension_settings[extensionName].autoConnect) return;
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, 5000);
}

function onQQMessage(msg) {
    const key = msg.sessionKey ?? `private_${msg.user_id ?? 'unknown'}`;
    if (!pendingQueue.has(key)) pendingQueue.set(key, []);
    pendingQueue.get(key).push({
        sender: msg.sender ?? String(msg.user_id ?? 'unknown'),
        text: msg.text ?? '',
        sessionKey: key,
    });
    log(`入队 [${key}]: [${msg.sender}] ${msg.text}（队列深度 ${pendingQueue.get(key).length}）`);
    pumpQueue();
}

function pumpQueue() {
    if (activeSession || switchingChat) return;
    const nextKey = [...pendingQueue.keys()].find((k) => pendingQueue.get(k).length > 0);
    if (!nextKey) return;
    const item = pendingQueue.get(nextKey).shift();
    activeSession = nextKey;
    processMessage(item).catch((e) => {
        log(`[${nextKey}] 处理失败:`, e.message);
        releaseSession();
    });
}

/**
 * 确保当前打开的聊天是该 QQ 的专属聊天。
 * - 已在该聊天：什么都不做
 * - 不在该聊天：openCharacterChat(固定名)。聊天文件不存在时，ST 会在
 *   首条消息保存时以该名字创建 —— 因此同一 QQ 的聊天永远同名同文件。
 */
async function ensureChat(key) {
    const context = getContext();
    const target = chatNameOf(key);
    const current = context.getCurrentChatId();

    if (current === target) return;   // 已在该用户的专属聊天

    if (!context.characterId && context.characterId !== 0) {
        throw new Error('未选择角色，无法打开会话聊天');
    }

    log(`[${key}] 切换到专属聊天 → ${target}`);
    switchingChat = true;
    try {
        await context.openCharacterChat(target);
        log(`[${key}] 已进入聊天: ${context.getCurrentChatId()}`);
    } finally {
        switchingChat = false;
    }
}

async function processMessage(item) {
    await ensureChat(item.sessionKey);

    const context = getContext();
    const rendered = extension_settings[extensionName].messageTemplate
        .replace('{sender}', item.sender)
        .replace('{text}', item.text);

    log(`处理 [${item.sessionKey}] @ ${context.getCurrentChatId()}:`, rendered);
    await context.executeSlashCommandsWithOptions(`/send ${rendered} | /trigger`);
    log(`[${item.sessionKey}] 生成已触发，等待回复事件…`);
}

function releaseSession() {
    activeSession = null;
    setTimeout(pumpQueue, 300);
}

let replyBusy = false;
function hookEvents() {
    const context = getContext();
    const { eventSource, eventTypes } = context;

    eventSource.on(eventTypes.MESSAGE_RECEIVED, onAiMessage);
    eventSource.on(eventTypes.GENERATION_ENDED, () => setTimeout(onAiMessage, 200));

    function onAiMessage() {
        if (!activeSession || replyBusy || switchingChat) return;
        const ctx = getContext();
        const last = ctx.chat[ctx.chat.length - 1];
        if (!last || last.is_user || last.is_system) return;
        if (!last.mes?.trim()) return;

        replyBusy = true;
        const sessionKey = activeSession;
        log(`[${sessionKey}] AI 回复完成 → 推回连接器:`, last.mes.slice(0, 60) + '…');
        sendToBridge({ type: 'st_reply', sessionKey, text: last.mes });
        releaseSession();
        setTimeout(() => { replyBusy = false; }, 400);
    }
}

function sendToBridge(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
    } else {
        log('⚠ 连接器未连接，回复丢失!');
    }
}

function updateUI(connected) {
    const el = document.getElementById('snowluma_bridge_status');
    if (el) {
        el.textContent = connected ? '已连接' : '未连接';
        el.style.color = connected ? 'green' : 'red';
    }
}

function renderActive() {
    const el = document.getElementById('snowluma_bridge_active');
    if (!el) return;
    el.textContent = activeSession
        ? (switchingChat ? `切换聊天中… [${activeSession}]` : `生成中 [${activeSession}] → ${chatNameOf(activeSession)}`)
        : '';
}

jQuery(async () => {
    const html = `
    <div class="snowluma-bridge-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>SnowLuma QQ 桥接 v3.0</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label for="snowluma_bridge_url">连接器地址</label>
                <input id="snowluma_bridge_url" type="text" class="text_pole" style="width:100%">
                <label for="snowluma_bridge_tpl">消息显示模板（{sender} / {text}）</label>
                <input id="snowluma_bridge_tpl" type="text" class="text_pole" style="width:100%">
                <label class="checkbox_label">
                    <input id="snowluma_bridge_auto" type="checkbox"> 自动重连
                </label>
                <div>
                    状态: <span id="snowluma_bridge_status">未连接</span>
                    <a id="snowluma_bridge_connect" class="menu_button">连接</a>
                    <span id="snowluma_bridge_queue" style="margin-left:8px;opacity:.7"></span>
                </div>
                <div style="font-size:12px;opacity:.8;margin-top:6px">
                    会话隔离：每个 QQ 号固定绑定同名聊天文件（<code>QQ_&lt;号码&gt;</code> / <code>GROUP_&lt;群&gt;_&lt;人&gt;</code>），<br>
                    永不重置。当前活跃: <span id="snowluma_bridge_active"></span>
                </div>
            </div>
        </div>
    </div>`;
    $('#extensions_settings').append(html);

    $('#snowluma_bridge_url').val(extension_settings[extensionName].bridgeUrl).on('change', function () {
        extension_settings[extensionName].bridgeUrl = $(this).val();
        saveSettingsDebounced();
    });
    $('#snowluma_bridge_tpl').val(extension_settings[extensionName].messageTemplate).on('change', function () {
        extension_settings[extensionName].messageTemplate = $(this).val();
        saveSettingsDebounced();
    });
    $('#snowluma_bridge_auto').prop('checked', extension_settings[extensionName].autoConnect).on('change', function () {
        extension_settings[extensionName].autoConnect = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#snowluma_bridge_connect').on('click', () => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.close();
        setTimeout(connect, 200);
    });

    setInterval(() => {
        const depth = [...pendingQueue.values()].reduce((n, q) => n + q.length, 0);
        const el = document.getElementById('snowluma_bridge_queue');
        if (el) el.textContent = depth ? `待处理 ${depth}` : '';
        renderActive();
    }, 1000);

    hookEvents();
    if (extension_settings[extensionName].autoConnect) connect();
    log('扩展初始化完成');
});
