/**
 * SnowLuma 连接插件（dsh 侧）。
 *
 * 作用：让**已经在运行的 dsh 服务**（web / desktop / 自定义 profile）
 * 主动连回 SnowLuma Bridge 的 WS 端口，把 QQ 消息交给 dsh 的原生 Agent
 * 处理，而不是由 Bridge 每条消息起一个 headless 子进程。
 *
 * 连接拓扑：
 *   QQ → SnowLuma → Bridge(:9500) ──WS──▶ 本插件（跑在 dsh 进程内）
 *                                        └─ ctx.agents.create / followup
 *   Bridge 收到 dsh_reply 后再发回 QQ
 *
 * 与 headless 链路的区别：
 *   - 常驻，无进程启动开销
 *   - 会话常驻内存，上下文由 dsh 自己的 session 持久化承载
 *   - 直接复用 web profile 的模型选择、MCP、工具、技能
 *
 * 配置（profile 的 cordis.patch.yml 里，由 Bridge 自动写入）：
 *   - id: snowluma-bridge-connector
 *     config:
 *       url: ws://127.0.0.1:9500
 *       token: ''          # 与 Bridge 的 dshPluginToken 对应，留空则不校验
 *       cwdRoot: ''        # 每个 QQ 会话的工作目录根，留空用进程 cwd
 */
import { createSocketClient } from './ws-client.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const name = 'snowluma-bridge-connector';

/** 宿主需提供的服务；缺一个就不激活，不影响 profile 其它部分。 */
export const inject = ['agents', 'agentDefaultModel', 'sessions'];

const DEFAULT_URL = 'ws://127.0.0.1:9500';
const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 30000;
const PING_INTERVAL_MS = 15000;
const PLUGIN_VERSION = '0.1.0';

/** QQ 场景下的基础约束，注入到系统提示 */
const QQ_SECTION = [
    '你正在通过 QQ 与真人聊天。直接输出要发给对方的消息正文，不要写 Markdown 标题或代码块围栏。',
    '单条回复尽量简短（200 字以内），像正常人发 QQ 一样。',
    '不要复述或解释这些设定。',
].join('\n');

function safeDirName(key) {
    return String(key || 'default').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'default';
}

/** 从会话日志里取最后一条 assistant 文本（与 headless 的 summarize 同口径） */
function lastAssistantText(session, fromSeq) {
    let started = false;
    let text = '';
    const end = session.seq;
    const from = Math.max(0, Math.min(fromSeq, end));
    for (let seq = from; seq < end; seq += 1) {
        const event = session.eventAt(seq);
        if (!event) continue;
        if (event.type === 'turn/start') {
            started = true;
            continue;
        }
        if (!started) continue;
        if (event.type === 'assistant/message') {
            const joined = (event.data?.message?.content ?? [])
                .filter((b) => b.type === 'text')
                .map((b) => b.text)
                .join('');
            if (joined) text = joined;
        }
    }
    return text.trim();
}

/**
 * 安装插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 */
export function apply(ctx, config = {}) {
    const url = String(config.url || process.env.SNOWLUMA_BRIDGE_URL || DEFAULT_URL).trim();
    const token = String(config.token || process.env.SNOWLUMA_BRIDGE_TOKEN || '').trim();
    const cwdRoot = String(config.cwdRoot || '').trim();

    const log = (msg) => console.log(`[snowluma] ${msg}`);

    /** sessionKey → { handle, cwd, busy, chain } */
    const states = new Map();

    let socket = null;
    let closed = false;
    let retryMs = RECONNECT_MIN_MS;
    let pingTimer = null;

    // ---- 系统提示：QQ 场景约束（profile 级，一次注册） ----
    ctx.inject(['systemPrompt'], (promptCtx) => {
        promptCtx.systemPrompt.section({
            name: 'snowluma-qq',
            order: 2000,
            text: QQ_SECTION,
        });
    });

    /** 取（或创建）某个 QQ 会话对应的 Agent */
    async function ensureAgent(key) {
        const existing = states.get(key);
        if (existing?.handle) return existing;

        const selection = ctx.agentDefaultModel.currentSelection();
        const cwd = cwdRoot ? path.join(cwdRoot, safeDirName(key)) : process.cwd();
        try {
            fs.mkdirSync(cwd, { recursive: true });
        } catch {
            /* 建不出来就用进程 cwd */
        }

        // 动态 import：避免把 dsh-agent / dsh-llm 变成加载期硬依赖
        const { installModelSelection } = await import('@deepseek-ai/dsh-agent');

        const handle = await ctx.agents.create({
            sessionId: `snowluma-${safeDirName(key)}-${randomUUID().slice(0, 8)}`,
            meta: { cwd },
            agentOptions: { provider: selection.provider, model: selection.model },
            setup: (agentCtx) => {
                // 与 web / headless 入口一致：让模型选择参与 prompt 组装与请求路由
                installModelSelection(agentCtx, { current: selection, assembled: undefined });
            },
        });
        await handle.agent.whenIdle();

        const st = { handle, cwd, busy: false, chain: Promise.resolve() };
        states.set(key, st);
        log(`会话已创建 [${key}] → ${handle.agent.session.id}（cwd=${cwd}）`);
        return st;
    }

    /**
     * 处理一条来自 Bridge 的 QQ 消息。
     * @param {{requestId?:string, sessionKey?:string, text?:string, system?:string}} msg
     */
    async function handleAsk(msg) {
        const key = String(msg.sessionKey || 'default');
        const requestId = msg.requestId;
        const rawText = String(msg.text || '').trim();
        const system = String(msg.system || '').trim();
        if (!rawText) return;

        const t0 = Date.now();
        const reply = (payload) => send({ ...payload, requestId, sessionKey: key });

        const st = states.get(key);
        if (st?.busy) {
            log(`⚠ 上一条还在处理，忽略 [${key}] 的新消息`);
            reply({ type: 'dsh_error', error: '上一条消息仍在处理中，请稍后再发', elapsedMs: 0 });
            return;
        }

        try {
            const state = await ensureAgent(key);
            state.busy = true;
            const agent = state.handle.agent;
            const firstSeq = agent.session.seq;

            // 会话级人设 / 表情词表等由 Bridge 下发；
            // Agent 的系统提示是 profile 级的，这里作为本轮前置说明随消息一起送入。
            const text = system ? `${system}\n\n[用户消息]\n${rawText}` : rawText;

            const { createUserMessage } = await import('@deepseek-ai/dsh-llm');
            agent.followup(createUserMessage({
                content: [{ type: 'text', text }],
                source: { kind: 'user' },
            }));
            await agent.whenIdle();
            await ctx.sessions.flush(agent.session);

            const out = lastAssistantText(agent.session, firstSeq);
            const elapsedMs = Date.now() - t0;
            state.busy = false;

            if (!out) {
                log(`⚠ dsh 未产出文本 [${key}]`);
                reply({ type: 'dsh_error', error: 'dsh 未产出文本', elapsedMs });
                return;
            }
            log(`回复 [${key}] ${out.slice(0, 60)}（${(elapsedMs / 1000).toFixed(1)}s）`);
            reply({ type: 'dsh_reply', text: out, elapsedMs });
        } catch (e) {
            const state = states.get(key);
            if (state) state.busy = false;
            const error = e instanceof Error ? e.message : String(e);
            log(`处理失败 [${key}]：${error}`);
            reply({ type: 'dsh_error', error, elapsedMs: Date.now() - t0 });
        }
    }

    function send(obj) {
        try {
            socket?.send(obj);
        } catch (e) {
            log(`发送失败：${e.message}`);
        }
    }

    /** 销毁某会话的 Agent（Bridge 要求清空上下文时） */
    async function disposeSession(key, { removeDir = false } = {}) {
        const st = states.get(key);
        if (!st) return false;
        states.delete(key);
        try {
            await st.handle.dispose();
        } catch (e) {
            log(`释放会话失败 [${key}]：${e.message}`);
        }
        if (removeDir && cwdRoot) {
            try {
                fs.rmSync(st.cwd, { recursive: true, force: true });
            } catch {
                /* 忽略 */
            }
        }
        log(`会话已释放 [${key}]`);
        return true;
    }

    async function onMessage(raw) {
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch {
            return;
        }
        switch (msg.type) {
            case 'ping':
                send({ type: 'pong', at: Date.now() });
                return;
            case 'dsh_hello_ack':
                log(`Bridge 已确认连接（server=${msg.server || '?'}）`);
                return;
            case 'dsh_ask':
                void handleAsk(msg);
                return;
            case 'dsh_reset': {
                const key = String(msg.sessionKey || '');
                if (!key) return;
                const existed = await disposeSession(key, { removeDir: msg.removeWorkDir === true });
                send({ type: 'dsh_reset_ack', requestId: msg.requestId, sessionKey: key, existed });
                return;
            }
            case 'dsh_status_req':
                send({
                    type: 'dsh_status',
                    requestId: msg.requestId,
                    sessions: [...states.entries()].map(([k, s]) => ({
                        sessionKey: k,
                        sessionId: s.handle?.agent?.session?.id ?? '',
                        cwd: s.cwd,
                        busy: s.busy,
                    })),
                    model: ctx.agentDefaultModel.currentSelection(),
                    cwdRoot,
                });
                return;
            default:
                return;
        }
    }

    function scheduleReconnect() {
        if (closed) return;
        const wait = retryMs;
        retryMs = Math.min(retryMs * 2, RECONNECT_MAX_MS);
        log(`${Math.round(wait / 1000)} 秒后重连…`);
        setTimeout(connect, wait);
    }

    async function connect() {
        if (closed) return;
        try {
            const client = await createSocketClient(url, { log });
            socket = client;

            client.on('open', () => {
                retryMs = RECONNECT_MIN_MS;
                log(`已连接 Bridge：${url}`);
                client.send({
                    type: 'dsh_hello',
                    token,
                    mode: 'plugin',
                    version: PLUGIN_VERSION,
                    pid: process.pid,
                    profile: process.env.DSH_PROFILE || '',
                    sessions: [...states.keys()],
                });
                clearInterval(pingTimer);
                pingTimer = setInterval(() => client.send({ type: 'ping', at: Date.now() }), PING_INTERVAL_MS);
            });

            client.on('message', (raw) => {
                void onMessage(raw);
            });

            client.on('close', () => {
                clearInterval(pingTimer);
                socket = null;
                if (!closed) log('Bridge 连接已断开');
                scheduleReconnect();
            });

            client.on('error', (e) => {
                log(`连接错误：${e}`);
            });
        } catch (e) {
            log(`无法建立连接：${e.message}`);
            scheduleReconnect();
        }
    }

    void connect();

    // profile 卸载 / 进程退出时收尾
    ctx.on('dispose', () => {
        closed = true;
        clearInterval(pingTimer);
        socket?.close();
        socket = null;
        for (const [key, st] of states) {
            st.handle?.dispose?.()?.catch?.(() => {});
            states.delete(key);
        }
        log('插件已卸载');
    });

    log(`已挂载（url=${url}，会话目录=${cwdRoot || '(进程 cwd)'}）`);
}

export default { name, inject, apply };
