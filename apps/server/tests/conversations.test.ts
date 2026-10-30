import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type net from 'node:net';
import { once } from 'node:events';
import { parseConversation, resolveConversation } from '../src/config/conversations.ts';
import { loadConfigFile, saveConfigFile } from '../src/config/store.ts';
import { DEFAULT_CONFIG } from '../src/config/schema.ts';
import { createApplication } from '../src/app/application.ts';
import { readHookProcesses, parseHookProcesses, readEndpoint, localHookProcesses } from '../src/integrations/snowluma/connection.ts';
import { probeSnowLuma } from '../src/integrations/snowluma/snowluma-service.mjs';
import { WebSocket, WebSocketServer } from 'ws';
import { SillyTavernAdapter } from '../src/downstream/sillytavern.ts';

const profile = { id: 'short', name: '简洁', systemPrompt: '简短回答', inputPrefix: '问题：', inputSuffix: '', inputRules: [{ type: 'remove', pattern: '^@助手 ', flags: 'g' }], replyRules: [{ type: 'strip', begin: '<think>', end: '</think>' }] };

test('SillyTavern transport includes per-request conversation system prompt', async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(server, 'listening');
    const connected = once(server, 'connection');
    const client = new WebSocket(`ws://127.0.0.1:${(server.address() as net.AddressInfo).port}`);
    await once(client, 'open');
    const [peer] = await connected;
    const adapter = new SillyTavernAdapter('st', 'ST', { id: 'st', name: 'ST', kind: 'sillytavern', enabled: true, settings: {}, profiles: [] }, { sessionDefaults: () => ({ character: '', world: '' }), faceManifest: () => ({}) });
    let received: { system: string } | undefined;
    client.on('message', raw => { const msg = JSON.parse(String(raw)); if (msg.type === 'qq_message') { received = msg; client.send(JSON.stringify({ type: 'st_reply', requestId: msg.requestId, text: 'ok' })); } });
    peer.on('message', (raw: unknown) => adapter.handleMessage(JSON.parse(String(raw))));
    try {
        await adapter.init(); adapter.attach(peer);
        const result = await adapter.ask({ sessionKey: 'main:private_1', text: 'hello', system: 'A unique prompt' });
        assert.equal(result.text, 'ok');
        assert.equal(received?.system, 'A unique prompt');
    } finally { client.terminate(); await adapter.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
async function fixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-conversation-'));
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.consolePort = 0; cfg.extPort = 0; cfg.registrationToken = 'fixture';
    cfg.accounts.forEach(a => a.enabled = false);
    cfg.downstreams = ['a', 'b'].map(id => ({ id, name: id, kind: 'dsh-plugin', enabled: false, settings: {}, profiles: [] }));
    cfg.defaultDownstreamId = 'a';
    await fs.writeFile(path.join(root, 'config.json'), JSON.stringify(cfg));
    const app = createApplication({ serverRoot: root, env: {} });
    await app.start();
    const base = `http://127.0.0.1:${(app.httpServer.address() as net.AddressInfo).port}/api`;
    const post = (route: string, data: unknown) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return { root, app, base, post, close: async () => { await app.stop(); await fs.rm(root, { recursive: true, force: true }); } };
}

test('conversation configuration rejects connection fields and previews input/prompt/reply without a downstream', async () => {
    assert.throws(() => parseConversation({ ...profile, url: 'http://example.test' }));
    assert.throws(() => parseConversation({ ...profile, inputRules: [{ type: 'replace', pattern: '[' }] }));
    const f = await fixture();
    try {
        const r = await f.post('/conversations/preview', { profile, text: '@助手 你好', reply: '<think>私有推理</think>你好' });
        assert.equal(r.status, 200);
        const preview = await r.json() as { input: string; system: string; output: string; state: unknown };
        assert.equal(preview.input, '问题：你好'); assert.equal(preview.system, '简短回答'); assert.equal(preview.output, '你好');
        assert.deepEqual(preview.state, { vars: {}, previous: { upstream: {}, downstream: {} } });
        assert.equal(f.app.context.config().conversationProfiles.length, 0);
        assert.equal((await f.post('/conversations', profile)).status, 200);
        const disk = loadConfigFile(path.join(f.root, 'config.json')).config;
        assert.equal(disk.conversationProfiles[0]?.systemPrompt, '简短回答');
        assert.equal(disk.downstreams[0]?.profiles.length, 0);
    } finally { await f.close(); }
});

test('default conversation is independent of downstream, explicit opt-out and deletion preserve valid bindings', async () => {
    const f = await fixture();
    try {
        await f.post('/conversations', profile);
        await f.post('/conversation-defaults', { backendId: 'a', conversationId: 'short' });
        const key = 'main:private_1';
        const route = '/sessions/' + encodeURIComponent(key);
        assert.equal((await f.post(route, { backendId: 'b', conversationId: null })).status, 200);
        assert.equal(resolveConversation(f.app.context.config(), f.app.context.sessions, key)?.id, 'short');
        await f.post(route, { conversationId: '' });
        assert.equal(resolveConversation(f.app.context.config(), f.app.context.sessions, key), undefined);
        await f.post(route, { conversationId: 'short' });
        assert.equal((await f.post(route, { backendId: '', conversationId: 'missing' })).status, 400);
        assert.equal(f.app.context.sessions.resolve(key).backendId, 'b');
        await fetch(f.base + '/conversations/short', { method: 'DELETE' });
        assert.equal(f.app.context.config().defaultConversationId, '');
        assert.equal(f.app.context.sessions.get(key)?.conversationId, undefined);
        assert.equal(f.app.context.sessions.resolve(key).backendId, 'b');
    } finally { await f.close(); }
});

test('legacy dialogue fields import with stable IDs while connection overrides stay untouched', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-legacy-conversation-'));
    try {
        const file = path.join(root, 'config.json');
        const cfg = structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>;
        delete cfg.conversationProfiles;
        cfg.downstreams = [{ id: 'a', kind: 'dsh-plugin', settings: { exePath: 'custom' }, profiles: [{ id: 'old', name: 'Old', settings: { profile: 'work', prompt: { extra: '旧提示词' } } }] }];
        await fs.writeFile(file, JSON.stringify(cfg));
        const a = loadConfigFile(file).config;
        const b = loadConfigFile(file).config;
        assert.equal(a.conversationProfiles[0]?.id, b.conversationProfiles[0]?.id);
        assert.equal(a.conversationProfiles[0]?.systemPrompt, '旧提示词');
        assert.deepEqual(a.conversationProfiles[0]?.legacyRef, { downstreamId: 'a', profileId: 'old', preserveBehavior: true });
        assert.equal(a.downstreams[0]?.profiles[0]?.settings.profile, 'work');
        saveConfigFile(file, a);
        assert.deepEqual(loadConfigFile(file).config.conversationProfiles, a.conversationProfiles);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('session variable API isolates accounts, rejects stale edits and preview never changes real state', async () => {
    const f = await fixture();
    try {
        const key = 'a:private_123';
        const other = 'b:private_123';
        await f.post('/sessions/' + encodeURIComponent(key), { backendId: 'a' });
        await f.post('/sessions/' + encodeURIComponent(other), { backendId: 'a' });
        const route = '/session-variables/' + encodeURIComponent(key);
        assert.equal((await f.post(route, { vars: { nickname: 'Alice' }, revision: 0 })).status, 200);
        assert.equal((await f.post(route, { vars: { nickname: 'stale' }, revision: 0 })).status, 409);
        const real = f.app.context.conversationState.read(key);
        const p = { ...profile, systemPrompt: '{{vars.nickname}}', downstreamAssignments: [{ name: 'nickname', value: 'Preview only' }] };
        const preview = await f.post('/conversations/preview', { profile: p, text: 'hi', reply: 'hello', state: real.state });
        assert.equal(preview.status, 200);
        const result = await preview.json() as { system: string; state: { vars: { nickname: string } } };
        assert.equal(result.system, 'Alice');
        assert.equal(result.state.vars.nickname, 'Preview only');
        assert.equal(f.app.context.conversationState.read(key).state.vars.nickname, 'Alice');
        assert.deepEqual(f.app.context.conversationState.read(other).state.vars, {});
        assert.equal((await fetch(f.base + '/session-variables/missing')).status, 404);
        assert.equal((await f.post(route, { vars: { constructor: 'bad' }, revision: 1 })).status, 400);
    } finally { await f.close(); }
});

test('SnowLuma injection inspection distinguishes not injected from unavailable or incompatible diagnostics', async () => {
    assert.deepEqual(localHookProcesses([12, 13], ['mojo.12.control']), [{ pid: 12, uin: '', injected: true, connected: false }, { pid: 13, uin: '', injected: false, connected: false }]);
    let mode = 'ready';
    const server = http.createServer((req, res) => {
        if (mode === 'auth') { res.writeHead(401); res.end(); return; }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(mode === 'bad' ? {} : { list: [{ pid: 123, uin: '12345', injected: false, connected: false }] }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
        const port = (server.address() as net.AddressInfo).port;
        assert.equal((await readHookProcesses(port)).processes[0]?.injected, false);
        mode = 'auth'; assert.equal((await readHookProcesses(port)).known, false);
        mode = 'bad'; assert.equal((await readHookProcesses(port)).known, false);
        assert.throws(() => parseHookProcesses({}));
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('SnowLuma core connection reads existing OneBot settings, connects and never writes injection or endpoint files', async () => {
    const f = await fixture();
    const upstream = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(upstream, 'listening');
    const snow = path.join(f.root, 'snow');
    try {
        await fs.mkdir(snow);
        await fs.writeFile(path.join(snow, 'package.json'), JSON.stringify({ name: 'snowluma' }));
        const probe = probeSnowLuma(snow);
        assert.equal(probe.ok, true);
        await fs.mkdir(probe.configDir, { recursive: true });
        await fs.mkdir(path.join(probe.dataDir, '12345'), { recursive: true });
        const file = path.join(probe.configDir, 'onebot_12345.json');
        const original = JSON.stringify({ networks: { wsServers: [{ host: '0.0.0.0', port: (upstream.address() as net.AddressInfo).port, path: '/', accessToken: 'fixture-token' }] } });
        await fs.writeFile(file, original);
        assert.equal(readEndpoint(probe.configDir, '12345')?.token, 'fixture-token');
        const accepted = once(upstream, 'connection');
        const response = await f.post('/snowluma/connect', { dir: snow, uin: '12345', port: 5099 });
        assert.equal(response.status, 202);
        const [socket] = await accepted;
        socket.terminate();
        assert.equal(await fs.readFile(file, 'utf8'), original);
        assert.equal(f.app.context.config().accounts.find(a => a.uin === '12345')?.upstream.token, 'fixture-token');
        assert.equal((await f.post('/snowluma/connect', { dir: snow, uin: '67890' })).status, 400);
        assert.equal((await f.post('/snowluma/hook', { enabled: true })).status, 410);
        assert.equal((await f.post('/snowluma/hook/restore', {})).status, 410);
        await assert.rejects(fs.access(path.join(probe.configDir, 'runtime.json')));
    } finally { await f.close(); for (const socket of upstream.clients) socket.terminate(); await new Promise<void>(r => upstream.close(() => r())); }
});
