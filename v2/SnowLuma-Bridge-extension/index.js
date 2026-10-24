// SnowLuma Bridge v4.0 — SillyTavern 扩展（稳妥版）
//
// 设计原则：只做已验证安全的最小操作，避免触发 ST 内部重绘风险。
//   - 不自动切角色（/go 会重载整个聊天界面，容易让页面卡死）
//   - 不自动注入开场白（addOneMessage 会触发事件链，与生成流程竞争）
//   - 不自动改 chatMetadata（写元数据可能损坏聊天状态）
//   - 发消息用 addOneMessage + generate()，绕开 slash 解析器
//
// 会话隔离：每个 QQ 号固定聊天文件名 QQ_<uin> / GROUP_<gid>_<uid>
// 指令：/help ? / /status /character list|select /word list|select
// 默认角色/世界书：只在"用户主动切换"或"指令"时应用，不自动改写每个消息

import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { world_names } from '../../../world-info.js';

const extensionName = 'SnowLuma-Bridge';
const version = '4.1.0';
const defaultSettings = {
    bridgeUrl: 'ws://127.0.0.1:9500',
    autoConnect: true,
    messageTemplate: '[{sender}]: {text}',
};

if (!extension_settings[extensionName]) extension_settings[extensionName] = {};
Object.assign(extension_settings[extensionName], defaultSettings);

let ws = null;
let reconnectTimer = null;
let pingTimer = null;
let remoteSessions = {};
let remoteDefaults = {};

const log = (...a) => {
    const text = a
        .map((x) => {
            if (typeof x === 'string') return x;
            try { return JSON.stringify(x); } catch { return String(x); }
        })
        .join(' ');
    console.log(`[${extensionName} v${version}]`, ...a);
    try {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ext_log', text: `[EXT] ${text}` }));
        }
    } catch { /* 忽略 */ }
};

/** 队列：sessionKey → 待处理消息 */
const pendingQueue = new Map();
let activeSession = null;
let busy = false;          // 处理中（防重入）
let generatingFor = null;  // 正在为哪个会话生成（只有它的事件回调有效）

function chatNameOf(key) {
    if (key.startsWith('group_')) return 'GROUP_' + key.slice('group_'.length);
    if (key.startsWith('private_')) return 'QQ_' + key.slice('private_'.length);
    return 'QQ_' + key;
}

/**
 * 诊断日志：POST 到连接器 /api/ext-log。
 * 用 text/plain + no-cors 避免 CORS 预检（服务器仍能收到内容）。
 */
function httpLog(text) {
    try {
        fetch('http://127.0.0.1:9510/api/ext-log', {
            method: 'POST',
            mode: 'no-cors',
            headers: { 'Content-Type': 'text/plain' },
            body: String(text),
        }).catch(() => {});
    } catch { /* 忽略 */ }
}

function wsSend(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
        return true;
    }
    return false;
}

// ================= 连接 =================
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
        wsSend({ type: 'hello', ext: extensionName, version });
        updateUI(true);
        let tries = 0;
        const tryReport = () => {
            tries++;
            if (reportCatalog() || tries >= 10) return;
            setTimeout(tryReport, 2000);
        };
        setTimeout(tryReport, 500);
    };

    ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch (e) {
            log('消息解析失败:', e.message);
            return;
        }

        log(`<<< 收到 WS 消息 type=${msg.type}`);   // 无条件记录每条入站消息

        try {
            if (msg.type === 'qq_message') {
                Promise.resolve()
                    .then(() => onQQMessage(msg))
                    .catch((e) => log('onQQMessage 异常(已隔离):', e.message, e.stack));
            } else if (msg.type === 'session_state') {
                remoteSessions = msg.sessions ?? {};
                remoteDefaults = msg.defaults ?? {};
            } else if (msg.type === 'sync_request') {
                reportCatalog();
            }
        } catch (e) {
            log('ws.onmessage 顶层异常:', e.message, e.stack);
        }
    };

    ws.onclose = () => { updateUI(false); scheduleReconnect(); };
    ws.onerror = () => { /* onclose 跟随 */ };

    clearInterval(pingTimer);
    pingTimer = setInterval(() => wsSend({ type: 'ping' }), 25000);
}

function scheduleReconnect() {
    if (!extension_settings[extensionName].autoConnect) return;
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 5000);
}

function reportCatalog() {
    try {
        const ctx = getContext();
        const chars = (ctx.characters ?? []).map((c) => c.name).filter(Boolean);
        const worlds = (world_names ?? []).slice();
        wsSend({ type: 'catalog', characters: chars, worlds });
        return chars.length > 0 || worlds.length > 0;
    } catch (e) {
        log('上报清单失败:', e.message);
        return false;
    }
}

// ================= 指令 =================
function helpText() {
    return [
        '📜 鲸鱼桥指令手册',
        '/help 或 ? — 显示本帮助',
        '/status — 当前会话状态',
        '/character list — 列出角色',
        '/character select <名称/编号> — 切换角色（会显示开场白）',
        '/word list — 列出世界书',
        '/word select <名称/编号> — 绑定世界书到本会话',
        '',
        '其他消息会转发给当前角色进行扮演。',
    ].join('\n');
}

function isCommand(text) {
    const t = (text ?? '').trim();
    if (/^[?？/]$/.test(t)) return true;
    return /^\/(help|character|word|status)\b/i.test(t);
}

function listCharacters() {
    return getContext().characters.map((c, i) => `${i + 1}. ${c.name}`).join('\n');
}

function listWorlds() {
    return (world_names ?? []).map((n, i) => `${i + 1}. ${n}`).join('\n');
}

function resolveEntry(input, list) {
    const n = Number(input);
    if (Number.isInteger(n) && n >= 1 && n <= list.length) return list[n - 1];
    const exact = list.find((x) => String(x).toLowerCase() === String(input).toLowerCase());
    if (exact) return exact;
    return list.find((x) => String(x).toLowerCase().includes(String(input).toLowerCase())) ?? null;
}

async function handleCommand(msg) {
    const raw = (msg.text ?? '').trim();
    const parts = raw.split(/\s+/);
    const cmd = (parts[0] ?? '').toLowerCase();
    const sub = (parts[1] ?? '').toLowerCase();
    const argRaw = raw.slice(cmd.length + sub.length + 2).trim().replace(/^["'「]|["'」]$/g, '');
    const ctx = getContext();

    if (/^[?？/]$/.test(raw) || cmd === '/help') return helpText();

    if (cmd === '/status') {
        return [
            `当前角色: ${ctx.name2 ?? '(未选择)'}`,
            `当前聊天: ${ctx.getCurrentChatId() ?? '(无)'}`,
            `聊天级世界书: ${ctx.chatMetadata?.world_info ?? '(未绑定)'}`,
            `默认角色: ${remoteDefaults.character || '(未设)'}`,
            `默认世界书: ${remoteDefaults.world || '(未设)'}`,
            `会话: ${msg.sessionKey}`,
        ].join('\n');
    }

    if (cmd === '/character') {
        if (sub === 'list') {
            const l = listCharacters();
            return l ? `🎭 角色列表：\n${l}\n\n用 /character select <名称或编号> 切换` : '角色列表为空';
        }
        if (sub === 'select') {
            if (!argRaw) return '用法: /character select <角色名称或编号>';
            const names = ctx.characters.map((c) => c.name);
            const hit = resolveEntry(argRaw, names);
            if (!hit) return `未找到角色「${argRaw}」，用 /character list 查看`;
            await ctx.executeSlashCommandsWithOptions(`/go ${JSON.stringify(hit)}`);
            await new Promise((r) => setTimeout(r, 1500));
            const ctx2 = getContext();
            wsSend({ type: 'session_selected', sessionKey: msg.sessionKey, character: hit });
            const first = ctx2.chat?.[0]?.mes ?? '(无开场白)';
            return `✅ 已切换到「${hit}」（聊天: ${ctx2.getCurrentChatId()}）\n\n—— 开场白 ——\n${first}`;
        }
        return '用法: /character list | /character select <名称/编号>';
    }

    if (cmd === '/word') {
        if (sub === 'list') {
            const l = listWorlds();
            return l ? `📖 世界书列表：\n${l}\n\n用 /word select <名称或编号> 绑定` : '世界书列表为空';
        }
        if (sub === 'select') {
            if (!argRaw) return '用法: /word select <世界书名称或编号>';
            const worlds = world_names ?? [];
            const hit = resolveEntry(argRaw, worlds);
            if (!hit) return `未找到世界书「${argRaw}」，用 /word list 查看`;
            await ctx.executeSlashCommandsWithOptions(`/world ${JSON.stringify(hit)}`);
            wsSend({ type: 'session_selected', sessionKey: msg.sessionKey, world: hit });
            return `✅ 世界书「${hit}」已激活\n注意：ST 的世界书激活是全局的，切换会话时会自动重设。`;
        }
        return '用法: /word list | /word select <名称/编号>';
    }

    return `未知指令「${cmd}」，发送 ? 查看帮助`;
}

// ================= 消息处理 =================
function onQQMessage(msg) {
    const key = msg.sessionKey ?? `private_${msg.user_id ?? 'unknown'}`;
    const text = (msg.text ?? '').trim();

    // 第一道诊断：用 HTTP 直连连接器（完全绕开 WebSocket 状态问题）
    httpLog(`onQQMessage 进入 key=${key} text=${text.slice(0, 40)}`);

    log(`收到 [${key}]: ${text.slice(0, 60)}`);

    if (isCommand(text)) {
        handleCommand({ ...msg, sessionKey: key, text })
            .then((reply) => wsSend({ type: 'command_reply', sessionKey: key, text: reply }))
            .catch((e) => {
                log('指令失败:', e.message);
                wsSend({ type: 'command_reply', sessionKey: key, text: `❌ 指令失败: ${e.message}` });
            });
        return;
    }

    if (!pendingQueue.has(key)) pendingQueue.set(key, []);
    pendingQueue.get(key).push({
        sender: msg.sender ?? 'QQ',
        text,
        sessionKey: key,
        defaultCharacter: msg.defaultCharacter,
        defaultWorld: msg.defaultWorld,
    });
    pump();
}

function pump() {
    if (busy) return;
    const key = [...pendingQueue.keys()].find((k) => pendingQueue.get(k).length > 0);
    if (!key) return;
    const item = pendingQueue.get(key).shift();
    busy = true;
    activeSession = key;
    processMessage(item)
        .catch((e) => log(`[${key}] 处理失败:`, e.message))
        .finally(() => {
            activeSession = null;
            generatingFor = null;
            busy = false;
            setTimeout(pump, 300);
        });
}

async function processMessage(item) {
    let ctx = getContext();
    log(`[${item.sessionKey}] 开始处理`);

    // ===== 未选择角色时自动选择 =====
    const noChar = ctx.characterId === null || ctx.characterId === undefined || ctx.characterId === '';
    if (noChar) {
        const desired =
            remoteSessions?.[item.sessionKey]?.character ||
            item.defaultCharacter ||
            remoteDefaults?.character ||
            '';
        log(`[${item.sessionKey}] 酒馆未选角色，默认角色配置=「${desired || '(空)'}」`);

        if (!desired) {
            throw new Error('酒馆未选择角色，且未配置默认角色。请在桥接控制台设置默认角色。');
        }

        const chars = ctx.characters ?? [];
        const names = chars.map((c) => c.name);
        const avatars = chars.map((c) => c.avatar ?? '');

        // 依次尝试：精确名 → 名包含 → avatar 文件名匹配（去扩展名）
        let idx = names.indexOf(desired);
        if (idx < 0) idx = names.findIndex((n) => n && n.includes(desired));
        if (idx < 0) {
            idx = avatars.findIndex((a) => {
                const base = String(a).replace(/\.(png|json)$/i, '');
                return base === desired;
            });
        }
        if (idx < 0) {
            const detail = chars.map((c, i) => `${i}:${c.name}(${c.avatar})`).join(' ');
            throw new Error(`默认角色「${desired}」不在角色列表。现有: ${detail}`);
        }

        log(`[${item.sessionKey}] 自动选择角色「${names[idx]}」(index=${idx})`);
        try {
            // switchMenu:false 避免切换左侧菜单导致界面重绘异常
            await ctx.selectCharacterById(idx, { switchMenu: false });
            await new Promise((r) => setTimeout(r, 1200));
            ctx = getContext();
            log(`[${item.sessionKey}] 角色已就绪: ${ctx.name2} (characterId=${ctx.characterId})`);
        } catch (e) {
            throw new Error(`自动选择角色失败: ${e.message}`);
        }

        if (ctx.characterId === null || ctx.characterId === undefined || ctx.characterId === '') {
            throw new Error('自动选择角色后 characterId 仍为空，请手动在酒馆中选一个角色');
        }
    }

    // 切到该 QQ 的专属聊天（仅当不同）
    const target = chatNameOf(item.sessionKey);
    if (ctx.getCurrentChatId() !== target) {
        log(`[${item.sessionKey}] 切换聊天 → ${target}`);
        await ctx.openCharacterChat(target);
        log(`[${item.sessionKey}] 现在聊天: ${getContext().getCurrentChatId()}`);
    }

    const c2 = getContext();
    const rendered = extension_settings[extensionName].messageTemplate
        .replace('{sender}', item.sender)
        .replace('{text}', item.text);

    // 用内部 API 写入用户消息（不经过 slash 解析器）
    const mes = {
        name: c2.name1 || 'You',
        is_user: true,
        is_system: false,
        send_date: new Date().toLocaleString(),
        mes: rendered,
        extra: {},
    };

    log(`[${item.sessionKey}] 写入消息`);
    if (typeof c2.addOneMessage === 'function') {
        c2.addOneMessage(mes);
    } else {
        c2.chat.push(mes);
        c2.printMessages?.();
    }

    await new Promise((r) => setTimeout(r, 150));

    log(`[${item.sessionKey}] 触发生成`);
    generatingFor = item.sessionKey;
    await c2.generate('normal');
    log(`[${item.sessionKey}] 生成返回`);
}

// ================= 事件 =================
function hookEvents() {
    const ctx = getContext();
    if (!ctx?.eventSource) {
        setTimeout(hookEvents, 1000);
        return;
    }
    const { eventSource, eventTypes } = ctx;

    const onMessage = () => {
        // 只处理我们主动触发的生成，且必须处于忙碌状态
        if (!generatingFor || !busy) return;
        const c = getContext();
        const last = c.chat?.[c.chat.length - 1];
        if (!last || last.is_user || last.is_system) return;
        const text = (last.mes ?? '').trim();
        if (!text) return;

        const key = generatingFor;
        generatingFor = null;   // 只发一次
        log(`[${key}] 回复就绪 (${text.length} 字)`);
        wsSend({ type: 'st_reply', sessionKey: key, text });
    };

    eventSource.on(eventTypes.MESSAGE_RECEIVED, () => {
        try { onMessage(); } catch (e) { log('MESSAGE_RECEIVED 处理异常:', e.message); }
    });
    eventSource.on(eventTypes.GENERATION_ENDED, () => {
        setTimeout(() => { try { onMessage(); } catch (e) { /* 忽略 */ } }, 200);
    });
}

// ================= UI =================
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
                <b>SnowLuma QQ 桥接 v${version}</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label for="snowluma_bridge_url">连接器地址</label>
                <input id="snowluma_bridge_url" type="text" class="text_pole" style="width:100%">
                <label for="snowluma_bridge_tpl">消息模板（{sender} / {text}）</label>
                <input id="snowluma_bridge_tpl" type="text" class="text_pole" style="width:100%">
                <label class="checkbox_label">
                    <input id="snowluma_bridge_auto" type="checkbox"> 自动重连
                </label>
                <div>状态: <span id="snowluma_bridge_status">未连接</span>
                    <a id="snowluma_bridge_connect" class="menu_button">连接</a>
                    <span id="snowluma_bridge_queue" style="margin-left:8px;opacity:.7"></span>
                </div>
                <div style="font-size:12px;opacity:.85;margin-top:6px">
                    会话隔离：每个 QQ 号固定聊天 <code>QQ_&lt;号码&gt;</code><br>
                    QQ 指令：<code>?</code> <code>/character list|select</code> <code>/word list|select</code> <code>/status</code>
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
        try { ws?.close(); } catch { /* 忽略 */ }
        setTimeout(connect, 200);
    });

    setInterval(() => {
        const depth = [...pendingQueue.values()].reduce((n, q) => n + q.length, 0);
        const el = document.getElementById('snowluma_bridge_queue');
        if (el) el.textContent = busy ? `处理中 [${activeSession}]` : (depth ? `待处理 ${depth}` : '');
    }, 1000);

    hookEvents();
    if (extension_settings[extensionName].autoConnect) connect();

    // ===== 全局调试入口（浏览器控制台可用）=====
    window.snowlumaDebug = {
        // 查看内部状态
        state: () => ({
            wsState: ws?.readyState,
            wsUrl: extension_settings[extensionName].bridgeUrl,
            busy,
            activeSession,
            generatingFor,
            queueDepth: [...pendingQueue.values()].reduce((n, q) => n + q.length, 0),
            remoteDefaults,
            remoteSessions,
        }),
        // 手动模拟收到一条 QQ 消息（绕过 WS）
        simulate: (text = '测试消息', sessionKey = 'private_debug') => {
            log(`[DEBUG] 手动模拟: ${text}`);
            onQQMessage({ type: 'qq_message', sessionKey, sender: '调试', text, user_id: 0 });
            return '已触发 onQQMessage，查看控制台和酒馆界面';
        },
        // 手动发一条指令
        cmd: (text = '?', sessionKey = 'private_debug') => {
            onQQMessage({ type: 'qq_message', sessionKey, sender: '调试', text, user_id: 0 });
            return '已发送指令: ' + text;
        },
        // 测试 HTTP 诊断通道
        httpTest: async () => {
            const r = await fetch('http://127.0.0.1:9510/api/ext-log', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: '[HTTP] 手动测试成功' }),
            });
            return await r.text();
        },
    };

    log('扩展初始化完成');
    log('调试入口已就绪：window.snowlumaDebug.state() / .simulate() / .cmd() / .httpTest()');
});

