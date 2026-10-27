/**
 * 极简 WebSocket 客户端。
 *
 * 优先用 profile 里的 `ws`（hoisted 依赖，功能最全），
 * 拿不到时回落到 Node / Electron 自带的全局 WebSocket。
 * 两条路径对外暴露同一套 { on(event, cb), send(obj), close() }。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export async function createSocketClient(url, { log = () => {} } = {}) {
    let Impl = null;
    let source = '';

    try {
        const mod = require('ws');
        Impl = mod.default ?? mod;
        source = 'ws';
    } catch {
        if (typeof globalThis.WebSocket === 'function') {
            Impl = globalThis.WebSocket;
            source = 'global';
        }
    }

    if (!Impl) throw new Error('当前 dsh 运行时没有可用的 WebSocket 实现（缺 ws）');

    const isGlobal = source === 'global';
    const ws = new Impl(url);
    log(`WebSocket 实现：${source}`);

    const listeners = { open: [], message: [], close: [], error: [] };
    const emit = (evt, arg) => {
        for (const cb of listeners[evt]) {
            try {
                cb(arg);
            } catch (e) {
                log(`listener 异常(${evt}): ${e.message}`);
            }
        }
    };

    if (isGlobal) {
        ws.addEventListener('open', () => emit('open'));
        ws.addEventListener('message', (e) => emit('message', typeof e.data === 'string' ? e.data : String(e.data)));
        ws.addEventListener('close', (e) => emit('close', e?.code ?? 0));
        ws.addEventListener('error', (e) => emit('error', e?.message ?? 'error'));
    } else {
        ws.on('open', () => emit('open'));
        ws.on('message', (raw) => emit('message', raw.toString()));
        ws.on('close', (code) => emit('close', code));
        ws.on('error', (e) => emit('error', e.message));
    }

    return {
        on(evt, cb) {
            (listeners[evt] ??= []).push(cb);
        },
        send(obj) {
            const text = JSON.stringify(obj);
            if (isGlobal) ws.send(text);
            else ws.send(text);
        },
        close() {
            try {
                ws.close();
            } catch {
                /* 忽略 */
            }
        },
    };
}
