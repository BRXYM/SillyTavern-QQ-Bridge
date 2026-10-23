// SnowLuma Bridge v2.0 — SillyTavern 扩展（多会话）
//
// 会话模型（纯事件驱动）：
//   - 连接器把每条 QQ 消息带上 sessionKey 推过来
//   - 扩展把消息写入当前聊天的上下文（作为 user 消息）并 /trigger 生成
//   - 生成完成（MESSAGE_RECEIVED）→ 按最近活跃的 sessionKey 推回
//
// 多会话策略（前端扩展在"当前打开的聊天"里工作，这是 ST 的形态决定的）：
//   - 维护 pendingQueue：sessionKey → 未处理消息队列（FIFO）
//   - 一次生成完成只消费队头的一条，逐条处理，避免交叉
//   - sessionKey 始终随消息携带并随回复回传，连接器据此精确路由到 QQ
//   - 若扩展配置了 sessionChatMap，可为不同 sessionKey 自动切换不同聊天文件

import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const extensionName = 'SnowLuma-Bridge';
const version = '2.0.0';
const defaultSettings = {
    bridgeUrl: 'ws://127.0.0.1:9500',
    autoConnect: true,
    // QQ 消息在聊天中显示的前缀格式
    messageTemplate: '[{sender}]: {text}',
};

if (!extension_settings[extensionName]) {
    extension_settings[extensionName] = {};
}
Object.assign(extension_settings[extensionName], defaultSettings);

const log = (...a) => console.log(`[${extensionName} v${version}]`, ...a);

let ws = null;
let reconnectTimer = null;

// 会话队列：sessionKey → [ {sender, text, ...} ]；同一时刻只处理一条
/** @type {Map<string, Array<{sender:string, text:string}>>} */
const pendingQueue = new Map();
// 正在生成中的会话（同一时刻只允许一个生成，保证回复路由正确）
let activeSession = null;

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

// 队列泵：无生成任务时取出下一条处理
function pumpQueue() {
    if (activeSession) return; // 上一条还在生成，等 MESSAGE_RECEIVED 消费后再泵
    const nextKey = [...pendingQueue.keys()].find((k) => pendingQueue.get(k).length > 0);
    if (!nextKey) return;

    const item = pendingQueue.get(nextKey).shift();
    activeSession = nextKey;
    processMessage(item);
}

async function processMessage(item) {
    const context = getContext();
    const rendered = extension_settings[extensionName].messageTemplate
        .replace('{sender}', item.sender)
        .replace('{text}', item.text);

    log(`处理 [${item.sessionKey}]:`, rendered);
    try {
        await context.executeSlashCommandsWithOptions(`/send ${rendered} | /trigger`);
        log(`[${item.sessionKey}] 生成已触发，等待回复事件…`);
        // 若酒馆静默失败（没有回复产生），GENERATION_ENDED 兜底会释放会话
    } catch (e) {
        log(`[${item.sessionKey}] 触发生成失败:`, e.message);
        releaseSession();
    }
}

function releaseSession() {
    activeSession = null;
    // 微延迟后泵下一条，给 ST 一点状态落地时间
    setTimeout(pumpQueue, 300);
}

let replyBusy = false;
function hookEvents() {
    const context = getContext();
    const { eventSource, eventTypes } = context;

    eventSource.on(eventTypes.MESSAGE_RECEIVED, onAiMessage);
    eventSource.on(eventTypes.GENERATION_ENDED, () => setTimeout(onAiMessage, 200));

    function onAiMessage() {
        if (!activeSession || replyBusy) return;
        const ctx = getContext();
        const last = ctx.chat[ctx.chat.length - 1];
        if (!last || last.is_user || last.is_system) return;
        if (!last.mes?.trim()) return;

        replyBusy = true;
        const sessionKey = activeSession;
        log(`[${sessionKey}] AI 回复完成 → 推回连接器:`, last.mes.slice(0, 60) + '…');
        sendToBridge({
            type: 'st_reply',
            sessionKey,
            text: last.mes,
        });
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

jQuery(async () => {
    const html = `
    <div class="snowluma-bridge-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>SnowLuma QQ 桥接 v2.0</b>
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

    // 队列深度显示（每秒刷新）
    setInterval(() => {
        const depth = [...pendingQueue.values()].reduce((n, q) => n + q.length, 0);
        const el = document.getElementById('snowluma_bridge_queue');
        if (el) el.textContent = activeSession ? `生成中 [${activeSession}] · 待处理 ${depth}` : (depth ? `待处理 ${depth}` : '');
    }, 1000);

    hookEvents();
    if (extension_settings[extensionName].autoConnect) connect();
    log('扩展初始化完成');
});
