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
// world_names 改为延迟获取（避免 world-info.js 与 SlashCommandParser 的循环依赖）
let worldNamesCache = null;

const extensionName = 'SnowLuma-Bridge';
const version = '4.5.0';
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

/**
 * 延迟获取世界书列表。
 * 不在模块顶层 import，避免 world-info.js 初始化期访问 SlashCommandParser
 * 造成的循环依赖错误（无头浏览器环境下会直接导致扩展加载失败）。
 */
function getWorldNames() {
    try {
        // ST 把世界书列表挂在全局（不同版本位置略有差异）
        if (Array.isArray(window.world_names)) return window.world_names;
        if (Array.isArray(window.worldInfo?.world_names)) return window.worldInfo.world_names;
        // 从 DOM 里的世界书下拉框读取（最可靠）
        const opts = document.querySelectorAll('#world_info option');
        if (opts.length) {
            const names = [...opts].map((o) => o.value).filter(Boolean);
            if (names.length) return names;
        }
        return worldNamesCache ?? [];
    } catch {
        return worldNamesCache ?? [];
    }
}

function chatNameOf(key) {
    if (key.startsWith('group_')) return 'GROUP_' + key.slice('group_'.length);
    if (key.startsWith('private_')) return 'QQ_' + key.slice('private_'.length);
    return 'QQ_' + key;
}

/**
 * 图片回复：向酒馆注入提示词，告知 AI 可以直接用图片标记。
 *
 * 标记会被后端 media 模块解析为 OneBot 消息段：
 *   [图片:URL] / [表情:URL] / <img src="URL">
 *
 * 注入位置为「作者注记」之后的深度 4，作用范围是当前聊天，
 * 因此切换会话时由 session_state 重新下发并覆盖即可。
 */
const IMAGE_PROMPT_KEY = 'snowluma_image_hint';

function injectImageInstruction() {
    const cfg = window.__snowlumaImageCfg;
    if (!cfg || cfg.enabled === false || cfg.instruction === false) {
        removeImageInstruction();
        return;
    }

    const ctx = getContext();
    if (typeof ctx?.setExtensionPrompt !== 'function') {
        log('当前酒馆版本不支持 setExtensionPrompt，跳过图片提示注入');
        return;
    }

    const base = String(cfg.baseUrl ?? '').trim();
    const baseHint = base
        ? `图片库根地址：${base}（可直接拼接文件名使用）`
        : '可使用任意公网可访问的图片直链';

    const instruction = [
        '【图片回复能力】',
        '你可以在回复中直接发送图片，客户端会自动渲染为图片消息。',
        '用法：在需要配图的位置插入以下任一标记（标记本身不会显示给用户）：',
        '  [图片:图片URL]',
        '  [表情:图片URL]',
        '  <img src="图片URL">',
        baseHint,
        '注意：图片标记请单独成行或紧跟在句末，不要包裹在代码块中；无合适图片时不必强行配图。',
    ].join('\n');

    try {
        // position: 1 = IN_PROMPT（并入提示词），depth: 4
        ctx.setExtensionPrompt(IMAGE_PROMPT_KEY, instruction, 1, 4, false);
        log('已注入图片回复提示');
    } catch (e) {
        log('图片提示注入失败:', e.message);
    }
}

function removeImageInstruction() {
    const ctx = getContext();
    if (typeof ctx?.setExtensionPrompt !== 'function') return;
    try {
        ctx.setExtensionPrompt(IMAGE_PROMPT_KEY, '', 1, 4, false);
    } catch {
        /* ignore */
    }
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

        // 只记录业务消息，忽略心跳 pong（避免刷屏）
        if (msg.type !== 'pong') {
            log(`<<< 收到 WS 消息 type=${msg.type}`);
        }

        try {
            if (msg.type === 'qq_message') {
                Promise.resolve()
                    .then(() => onQQMessage(msg))
                    .catch((e) => log('onQQMessage 异常(已隔离):', e.message, e.stack));
            } else if (msg.type === 'session_state') {
                remoteSessions = msg.sessions ?? {};
                remoteDefaults = msg.defaults ?? {};
                if (msg.imageReplies) {
                    window.__snowlumaImageCfg = msg.imageReplies;
                    // 提示注入依赖酒馆上下文就绪，稍作延迟
                    setTimeout(() => {
                        try {
                            injectImageInstruction();
                        } catch (e) {
                            log('图片提示注入异常(已隔离):', e.message);
                        }
                    }, 500);
                }
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
        const worlds = getWorldNames();
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
    return getWorldNames().map((n, i) => `${i + 1}. ${n}`).join('\n');
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
            const worlds = getWorldNames();
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
    processMessage(item).catch((e) => {
        log(`[${key}] 处理失败:`, e.message);
        // 只有出错时才立即释放（正常路径由回复事件释放）
        releaseBusy();
    });
}

/** 释放忙碌状态并处理队列中的下一条 */
function releaseBusy() {
    busy = false;
    generatingFor = null;
    activeSession = null;
    setTimeout(pump, 300);
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

        let idx = names.indexOf(desired);
        if (idx < 0) idx = names.findIndex((n) => n && n.includes(desired));
        if (idx < 0) {
            idx = avatars.findIndex((a) => String(a).replace(/\.(png|json)$/i, '') === desired);
        }
        if (idx < 0) {
            const detail = chars.map((c, i) => `${i}:${c.name}`).join(' ');
            throw new Error(`默认角色「${desired}」不在角色列表。现有: ${detail}`);
        }

        log(`[${item.sessionKey}] 自动选择角色「${names[idx]}」(index=${idx})`);
        await ctx.selectCharacterById(idx, { switchMenu: false });
        await new Promise((r) => setTimeout(r, 1200));
        ctx = getContext();
        log(`[${item.sessionKey}] 角色就绪: ${ctx.name2} (id=${ctx.characterId})`);
    }

    // ===== 切到该 QQ 的专属聊天 =====
    const target = chatNameOf(item.sessionKey);
    if (ctx.getCurrentChatId() !== target) {
        log(`[${item.sessionKey}] 切换聊天 → ${target}`);
        await ctx.openCharacterChat(target);
        await new Promise((r) => setTimeout(r, 600));
        ctx = getContext();
        log(`[${item.sessionKey}] 当前聊天: ${ctx.getCurrentChatId()}`);
    }

    const rendered = extension_settings[extensionName].messageTemplate
        .replace('{sender}', item.sender)
        .replace('{text}', item.text);

    // ===== 关键：走 ST 自己的发送流程 =====
    // 直接把文本写进输入框再点击发送按钮，让 ST 完整处理：
    //   - 正确区分 generate type（normal 而非 continue）
    //   - 触发 MESSAGE_SENT / MESSAGE_RECEIVED 事件链
    //   - 正确的 UI 渲染与滚动
    const $ta = $('#send_textarea');
    if (!$ta.length) {
        throw new Error('找不到 #send_textarea，酒馆界面可能未就绪');
    }

    log(`[${item.sessionKey}] 写入输入框并发送: ${rendered.slice(0, 60)}`);
    $ta.val(rendered);
    $ta[0].dispatchEvent(new Event('input', { bubbles: true }));

    generatingFor = item.sessionKey;

    // 点击发送按钮（和用户手动发消息完全一致的路径）
    const $btn = $('#send_but');
    if ($btn.length) {
        $btn.trigger('click');
    } else {
        // 兜底：直接调用 generate
        log(`[${item.sessionKey}] 未找到发送按钮，回退 generate('normal')`);
        await ctx.generate('normal');
    }

    log(`[${item.sessionKey}] 已触发发送，等待回复事件`);
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
        log(`[${key}] 回复就绪 (${text.length} 字)`);
        wsSend({ type: 'st_reply', sessionKey: key, text });
        releaseBusy();          // 释放后才能处理下一条
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




