// SnowLuma Bridge — SillyTavern 扩展
// 事件驱动：QQ消息 → 写入聊天并触发回复生成；回复完成 → 推回连接器 → QQ

import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced, chat, generateQuietPrompt } from '../../../../script.js';

const extensionName = 'SnowLuma-Bridge';
const defaultSettings = {
    bridgeUrl: 'ws://127.0.0.1:9500',
    autoConnect: true,
    // 触发词前缀：QQ 消息直接作为 user 消息送入当前聊天
    senderLabel: 'QQ',
};

if (!extension_settings[extensionName]) {
    extension_settings[extensionName] = {};
}
Object.assign(extension_settings[extensionName], defaultSettings);

const log = (...a) => console.log(`[${extensionName}]`, ...a);

let ws = null;
let reconnectTimer = null;
// 标记：正在处理的回复来自 QQ 触发，监听器只在这时把回复推回 QQ
let expectingReply = false;
let lastReceivedChatLength = 0;

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
        ws.send(JSON.stringify({ type: 'hello', ext: extensionName }));
        updateUI(true);
    };

    ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.type === 'qq_message') handleQQMessage(msg);
    };

    ws.onclose = () => {
        updateUI(false);
        scheduleReconnect();
    };
    ws.onerror = () => { /* onclose 会跟着触发 */ }
}

function scheduleReconnect() {
    if (!extension_settings[extensionName].autoConnect) return;
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, 5000);
}

function handleQQMessage(msg) {
    const context = getContext();
    const text = `[${msg.sender}]: ${msg.text}`;

    log('收到 QQ 消息:', text);

    // 记录回复目标：QQ 消息来自哪个会话，回复就发回哪里
    pendingTarget = {
        message_type: msg.message_type ?? 'private',
        group_id: msg.group_id ?? null,
        user_id: msg.user_id ?? null,
    };

    // 只标记"等待回复"，不重置聊天（保留上下文，世界书/角色卡照常生效）
    expectingReply = true;
    lastReceivedChatLength = context.chat.length;

    // 把 QQ 消息作为用户消息加入聊天并触发生成。
    // sendMessageAsUser 会添加 user 消息；然后触发一次正常生成（走酒馆当前模型配置）。
    context.executeSlashCommandsWithOptions(`/send ${text} | /trigger`)
        .then(() => log('已触发酒馆生成'))
        .catch((e) => {
            log('触发生成失败:', e.message);
            expectingReply = false;
        });
}

// 监听酒馆 AI 回复完成事件 → 推回 QQ
let busy = false;
function hookEvents() {
    const context = getContext();
    const { eventSource, eventTypes } = context;

    eventSource.on(eventTypes.MESSAGE_RECEIVED, onAiMessage);
    eventSource.on(eventTypes.GENERATION_ENDED, () => {
        // 兜底：如果 MESSAGE_RECEIVED 没命中（例如静默生成），结束时检查
        setTimeout(onAiMessage, 200);
    });

    function onAiMessage() {
        if (!expectingReply || busy) return;
        const context2 = getContext();
        // 取最新一条 AI 消息
        const last = context2.chat[context2.chat.length - 1];
        if (!last || last.is_user || last.is_system) return;
        if (!last.mes?.trim()) return;

        busy = true;
        expectingReply = false;
        log('AI 回复完成 → 推回QQ:', last.mes.slice(0, 60) + '…');
        sendToBridge({
            type: 'st_reply',
            text: last.mes,
            // 记录本次会话来源，连接器用它定位回复目标
            message_type: pendingTarget.message_type,
            group_id: pendingTarget.group_id,
            user_id: pendingTarget.user_id,
        });
        setTimeout(() => { busy = false; }, 500);
    }
}

// 回复目标（最近一条 QQ 消息的来源）
let pendingTarget = { message_type: 'private', group_id: null, user_id: null };

function sendToBridge(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
    } else {
        log('连接器未连接，回复丢失!');
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
                <b>SnowLuma QQ 桥接</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label for="snowluma_bridge_url">连接器地址</label>
                <input id="snowluma_bridge_url" type="text" class="text_pole" style="width:100%">
                <label class="checkbox_label">
                    <input id="snowluma_bridge_auto" type="checkbox"> 自动重连
                </label>
                <div>
                    状态: <span id="snowluma_bridge_status">未连接</span>
                    <a id="snowluma_bridge_connect" class="menu_button">连接</a>
                </div>
            </div>
        </div>
    </div>`;
    $('#extensions_settings').append(html);

    $('#snowluma_bridge_url').val(extension_settings[extensionName].bridgeUrl).on('change', function () {
        extension_settings[extensionName].bridgeUrl = $(this).val();
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

    hookEvents();
    if (extension_settings[extensionName].autoConnect) connect();
    log('扩展初始化完成');
});
