// SnowLuma Bridge v3.1 — SillyTavern 扩展（/ 指令 + 按 QQ 号固定会话隔离）
//
// 会话绑定规则（确定性，永不变）：
//   私聊 sessionKey "private_2637143104" → 酒馆聊天文件 "QQ_2637143104"
//   群聊 sessionKey "group_884841875_1950318607" → 聊天文件 "GROUP_884841875_1950318607"
//
// / 指令（v3.1 新增，QQ 中直接发送）：
//   /help                     → 指令帮助（连接器本地回复）
//   /character list           → 列出当前系统中的角色（扩展查询后回传）
//   /word list                → 列出当前系统中的世界书
//   /character select <名称/编号> → 切换当前对话的角色，并把新聊天的开场白发回 QQ
//   /word select <名称/编号>      → 为当前对话选择/激活世界书
//
// 流程（纯事件驱动）：
//   QQ消息 → 连接器(sessionKey) → 扩展 → 确保当前聊天=该QQ的专属聊天 → /send + /trigger
//   回复完成(MESSAGE_RECEIVED) → 携带 sessionKey 推回连接器 → 路由回 QQ

import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { world_names } from '../../../world-info.js';

const extensionName = 'SnowLuma-Bridge';
const version = '3.1.0';
const defaultSettings = {
    bridgeUrl: 'ws://127.0.0.1:9500',
    autoConnect: true,
    messageTemplate: '[{sender}]: {text}',
};

if (!extension_settings[extensionName]) {
    extension_settings[extensionName] = {};
}
Object.assign(extension_settings[extensionName], defaultSettings);

const log = (...a) => console.log(`[${extensionName} v${version}]`, ...a);

let ws = null;
let reconnectTimer = null;
let pingTimer = null;

/** @type {Map<string, Array<{sender:string, text:string, sessionKey:string}>>} */
const pendingQueue = new Map();
let activeSession = null;
let switchingChat = false;

function chatNameOf(sessionKey) {
    if (sessionKey.startsWith('group_')) return 'GROUP_' + sessionKey.slice('group_'.length);
    if (sessionKey.startsWith('private_')) return 'QQ_' + sessionKey.slice('private_'.length);
    return 'QQ_' + sessionKey;
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
        if (msg.type === 'qq_message') {
            // 隔离异常：任何错误都不能杀死 WS 连接
            Promise.resolve()
                .then(() => onQQMessage(msg))
                .catch((e) => log('onQQMessage 异常(已隔离):', e.message, e.stack));
        }
    };

    // 心跳保活：每 25 秒 ping，防止代理/浏览器闲置断连
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
        }
    }, 25000);

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

function sendToBridge(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
    } else {
        log('⚠ 连接器未连接，消息丢失!');
    }
}

// ================= / 指令系统 =================
// 指令结果直接回发 QQ（不走酒馆生成），type=command_reply

function listCharacters() {
    const context = getContext();
    return context.characters.map((c, i) => `${i + 1}. ${c.name} (${c.chat?.length ?? 0} 个聊天)`).join('\n');
}

function listWorlds() {
    return (world_names ?? []).map((n, i) => `${i + 1}. ${n}`).join('\n');
}

/** 按名称或 1 起始编号解析列表项，返回 { item, index } 或 null */
function resolveEntry(input, list) {
    const asNum = Number(input);
    if (Number.isInteger(asNum) && asNum >= 1 && asNum <= list.length) {
        return { item: list[asNum - 1], index: asNum - 1 };
    }
    const idx = list.findIndex((n) => n.toLowerCase() === String(input).toLowerCase());
    if (idx >= 0) return { item: list[idx], index: idx };
    // 模糊匹配（包含）
    const fuzzy = list.findIndex((n) => String(n).toLowerCase().includes(String(input).toLowerCase()));
    if (fuzzy >= 0) return { item: list[fuzzy], index: fuzzy };
    return null;
}

async function handleCommand(msg) {
    const raw = (msg.text ?? '').trim();
    const parts = raw.split(/\s+/);            // e.g. ['/character', 'select', '雪乃']（可能带引号）
    const cmd = (parts[0] ?? '').toLowerCase();
    const sub = (parts[1] ?? '').toLowerCase();
    const argRaw = raw.slice(cmd.length + sub.length + 2).trim().replace(/^["'「"]|["'」"]$/g, '');
    const context = getContext();

    if (cmd === '/help') {
        return helpText();
    }

    if (cmd === '/status') {
        const chatId = context.getCurrentChatId();
        const charName = context.name2 ?? '(无角色)';
        const world = context.chatMetadata?.world ?? '(未绑定)';
        return `当前角色: ${charName}\n当前聊天: ${chatId}\n世界书: ${world}\n你的会话: ${msg.sessionKey}`;
    }

    if (cmd === '/character') {
        if (sub === 'list') {
            const list = listCharacters();
            return list ? `🎭 角色列表：\n${list}\n\n用 /character select <名称或编号> 切换` : '角色列表为空';
        }
        if (sub === 'select') {
            if (!argRaw) return '用法: /character select <角色名称或编号>';
            const chars = context.characters.map((c) => c.name);
            const hit = resolveEntry(argRaw, chars);
            if (!hit) return `未找到角色「${argRaw}」。用 /character list 查看列表`;
            const charName = hit.item;

            // /go 切换角色 → 新角色默认聊天打开
            await context.executeSlashCommandsWithOptions(`/go ${JSON.stringify(charName)}`);
            await new Promise((r) => setTimeout(r, 1500)); // 等 ST 完成加载

            const ctx2 = getContext();
            const firstMes = ctx2.chat?.[0]?.mes ?? '(无开场白)';
            return `✅ 已切换到角色「${charName}」（聊天: ${ctx2.getCurrentChatId()}）\n\n—— 开场白 ——\n${firstMes}`;
        }
        return '用法: /character list | /character select <名称/编号>';
    }

    if (cmd === '/word') {
        if (sub === 'list') {
            const list = listWorlds();
            return list ? `📖 世界书列表：\n${list}\n\n用 /word select <名称或编号> 激活` : '世界书列表为空';
        }
        if (sub === 'select') {
            if (!argRaw) return '用法: /word select <世界书名称或编号>';
            const worlds = world_names ?? [];
            const hit = resolveEntry(argRaw, worlds);
            if (!hit) return `未找到世界书「${argRaw}」。用 /word list 查看列表`;
            // /world <名称> 激活全局世界书（state 默认 on）
            await context.executeSlashCommandsWithOptions(`/world ${JSON.stringify(hit.item)}`);
            return `✅ 世界书「${hit.item}」已激活（对当前对话生效）`;
        }
        return '用法: /word list | /word select <名称/编号>';
    }

    return `未知指令「${cmd}」。发送 /help 查看帮助`;
}

// 触发词：/指令 或 ？/?（中英文问号）→ 触发指令手册
function isCommand(text) {
    const t = (text ?? '').trim();
    if (/^\/(help|character|word|status)\b/i.test(t)) return true;
    if (/^[?？]$/.test(t)) return true;                    // 单独的 ? / ？
    return false;
}

// 指令手册（/ 与 ? 共用）
function helpText() {
    return [
        '📜 鲸鱼桥指令手册',
        '/help 或 ? — 显示本帮助',
        '/character list — 列出角色',
        '/character select <名称/编号> — 切换角色（发送新开场白）',
        '/word list — 列出世界书',
        '/word select <名称/编号> — 切换世界书',
        '/status — 当前会话状态',
        '',
        '其他消息会转发给当前角色进行扮演。',
    ].join('\n');
}

async function onQQMessage(msg) {
    const key = msg.sessionKey ?? `private_${msg.user_id ?? 'unknown'}`;
    const text = (msg.text ?? '').trim();

    log(`[${key}] onQQMessage 收到: "${text}" (type=${msg.type})`);

    // / 指令 与 ? 触发：直接处理并回发，不进聊天、不触发生成
    if (isCommand(text)) {
        log(`[${key}] 指令命中: ${text}`);
        let reply;
        try {
            const t = text.trim();
            if (/^[?？]$/.test(t)) {
                reply = helpText();
            } else {
                reply = await handleCommand({ ...msg, sessionKey: key, text });
            }
        } catch (e) {
            log(`[${key}] 指令执行失败:`, e.message, e.stack);
            reply = `❌ 指令执行失败: ${e.message}`;
        }
        log(`[${key}] 指令回复长度: ${reply?.length ?? 0}`);
        sendToBridge({ type: 'command_reply', sessionKey: key, text: reply });
        return;
    }

    if (!pendingQueue.has(key)) pendingQueue.set(key, []);
    pendingQueue.get(key).push({
        sender: msg.sender ?? String(msg.user_id ?? 'unknown'),
        text,
        sessionKey: key,
    });
    log(`入队 [${key}]: [${msg.sender}] ${text}（队列深度 ${pendingQueue.get(key).length}）`);
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

async function ensureChat(key) {
    const context = getContext();
    const target = chatNameOf(key);
    const current = context.getCurrentChatId();

    if (current === target) return;

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
                <b>SnowLuma QQ 桥接 v3.1</b>
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
                    会话隔离：每个 QQ 号固定绑定同名聊天文件（<code>QQ_&lt;号码&gt;</code>）。<br>
                    QQ 指令：<code>/help</code> <code>/character list|select</code> <code>/word list|select</code> <code>/status</code><br>
                    当前活跃: <span id="snowluma_bridge_active"></span>
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
