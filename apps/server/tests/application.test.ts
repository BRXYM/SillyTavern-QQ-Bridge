import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createApplication } from '../src/app/application.ts';
import { DEFAULT_CONFIG } from '../src/config/schema.ts';
import { createAppPaths } from '../src/app/paths.ts';
import { createConfigRuntime } from '../src/config/runtime.ts';
import { statusBus } from '../src/core/events.ts';

async function fixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-refactor-'));
    const config = { ...structuredClone(DEFAULT_CONFIG),
        accounts: DEFAULT_CONFIG.accounts.map((account) => ({ ...account, enabled: false })),
        downstreams: DEFAULT_CONFIG.downstreams.map((downstream) => ({ ...downstream, enabled: false })),
        consolePort: 0, extPort: 0, registrationToken: 'integration-test' };
    await fs.writeFile(path.join(root, 'config.json'), JSON.stringify(config));
    const app = createApplication({ serverRoot: root, env: {} });
    return { root, app, cleanup: async () => { await app.stop(); await fs.rm(root, { recursive: true, force: true }); } };
}

async function occupy() {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as net.AddressInfo).port;
    return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test('default data paths still point to apps/server', () => {
    const paths = createAppPaths();
    assert.equal(path.basename(paths.serverRoot), 'server');
    assert.equal(paths.config, path.join(paths.serverRoot, 'config.json'));
});

test('HTTP APIs and SSE work with isolated data and release open streams at shutdown', async () => {
    const f = await fixture();
    try {
        assert.equal(f.app.httpServer.listening, false);
        await f.app.start();
        const port = (f.app.httpServer.address() as net.AddressInfo).port;
        const url = `http://127.0.0.1:${port}`;
        const health = await (await fetch(`${url}/api/health`)).json() as { ok: boolean };
        assert.equal(health.ok, true);
        const status = await (await fetch(`${url}/api/status`)).json() as { accounts: unknown[] };
        assert.equal(status.accounts.length, 0);
        assert.equal((await fetch(`${url}/api/unknown`)).status, 404);
        const listeners = statusBus.listenerCount('events');
        const stream = await fetch(`${url}/api/events`);
        const reader = stream.body!.getReader();
        assert.match(new TextDecoder().decode((await reader.read()).value), /connected/);
        await f.app.stop();
        await reader.cancel().catch(() => {});
        assert.equal(f.app.httpServer.listening, false);
        // close 事件在连接释放后的下一个事件循环执行。
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(statusBus.listenerCount('events'), listeners);
    } finally { await f.cleanup(); }
});

test('session routing validates profiles against the inherited default and clears stale profile bindings', async () => {
    const f = await fixture();
    try {
        f.app.context.updateConfig(config => {
            config.downstreams = [
                { id: 'primary', kind: 'dsh-plugin', name: 'Primary', enabled: false, settings: {}, profiles: [{ id: 'assistant', name: 'Assistant', settings: {} }] },
                { id: 'other', kind: 'dsh-plugin', name: 'Other', enabled: false, settings: {}, profiles: [] },
            ];
            config.defaultDownstreamId = 'primary';
            config.defaultDownstreamProfileId = '';
        });
        await f.app.start();
        const url = `http://127.0.0.1:${(f.app.httpServer.address() as net.AddressInfo).port}/api/sessions`;
        const sessionKey = 'main:private_123';
        const update = (body: object) => fetch(`${url}/${encodeURIComponent(sessionKey)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const response = await update({ sessionKey, backendId: '', profileId: 'assistant' });
        assert.equal(response.status, 200);
        assert.equal(f.app.context.sessions.resolve(sessionKey).backendId, 'primary');
        assert.equal(f.app.context.sessions.resolve(sessionKey).profileId, 'assistant');
        assert.equal(f.app.context.sessions.resolve(sessionKey).inherited, true);
        assert.equal((await update({ sessionKey, backendId: 'other', profileId: 'assistant' })).status, 400);
        assert.equal(f.app.context.sessions.resolve(sessionKey).profileId, 'assistant');
        assert.equal((await update({ sessionKey, backendId: 'other' })).status, 200);
        assert.equal(f.app.context.sessions.resolve(sessionKey).profileId, '');
    } finally { await f.cleanup(); }
});

test('HTTP and WS bind errors reject startup and release previously started resources', async () => {
    for (const field of ['consolePort', 'extPort'] as const) {
        const occupied = await occupy();
        const f = await fixture();
        try {
            f.app.context.updateConfig((config) => { config[field] = occupied.port; });
            await assert.rejects(f.app.start(), (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE');
            assert.equal(f.app.httpServer.listening, false);
            assert.deepEqual(f.app.context.downstreams.list(), []);
        } finally { await f.cleanup(); await occupied.close(); }
    }
});

test('deleting a profile only clears sessions resolved to that downstream, including inherited routes', async () => {
    const f = await fixture();
    try {
        f.app.context.updateConfig(config => {
            config.downstreams = ['primary', 'other'].map(id => ({ id, kind: 'dsh-plugin', name: id, enabled: false, settings: {}, profiles: [{ id: 'shared', name: 'Shared', settings: {} }] }));
            config.defaultDownstreamId = 'primary';
            config.defaultDownstreamProfileId = '';
        });
        f.app.context.sessions.patch('first:private_123', { profileId: 'shared' });
        f.app.context.sessions.patch('second:private_123', { backendId: 'other', profileId: 'shared' });
        await f.app.start();
        const url = `http://127.0.0.1:${(f.app.httpServer.address() as net.AddressInfo).port}`;
        const deleted = await fetch(`${url}/api/downstreams/other/profiles/shared`, { method: 'DELETE' });
        assert.equal(deleted.status, 200);
        assert.equal(f.app.context.sessions.resolve('first:private_123').profileId, 'shared');
        assert.equal(f.app.context.sessions.resolve('second:private_123').profileId, '');
        assert.equal(f.app.context.config().downstreams.find(d => d.id === 'primary')?.profiles.length, 1);
        const next = await fetch(`${url}/api/downstreams/primary/profiles/shared`, { method: 'DELETE' });
        assert.equal(next.status, 200);
        assert.equal(f.app.context.sessions.resolve('first:private_123').profileId, '');
    } finally { await f.cleanup(); }
});

test('inbound shutdown closes an existing WebSocket client', async () => {
    const available = await occupy();
    const port = available.port;
    await available.close();
    const f = await fixture();
    try {
        f.app.context.updateConfig((config) => { config.extPort = port; });
        await f.app.start();
        const socket = new WebSocket(`ws://127.0.0.1:${port}`);
        await once(socket, 'open');
        const closed = once(socket, 'close');
        await f.app.stop();
        await closed;
        assert.equal(socket.readyState, WebSocket.CLOSED);
    } finally { await f.cleanup(); }
});

test('environment overrides and generated registration token persist across runtime recreation', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-config-'));
    try {
        const configPath = path.join(root, 'config.json');
        const first = createConfigRuntime(configPath, { API_PORT: '19210', EXT_PORT: '19211', ONEBOT_URL: 'ws://127.0.0.1:19212' });
        assert.equal(first.config().consolePort, 19210);
        assert.equal(first.config().extPort, 19211);
        assert.equal(first.config().accounts[0]?.upstream.url, 'ws://127.0.0.1:19212');
        assert.ok(first.config().registrationToken);
        const second = createConfigRuntime(configPath, {});
        assert.equal(second.config().registrationToken, first.config().registrationToken);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
