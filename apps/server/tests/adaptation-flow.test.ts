import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { createApplication } from '../src/app/application.ts';
import { DEFAULT_CONFIG } from '../src/config/schema.ts';
import { loadConfigFile } from '../src/config/store.ts';
import type { AdaptationJob } from '../src/services/adaptation/service.ts';
import { createConfigRuntime } from '../src/config/runtime.ts';

async function waitFor<T>(get: () => Promise<T> | T, done: (value: T) => boolean): Promise<T> {
    for (let i = 0; i < 300; i++) { const value = await get(); if (done(value)) return value; await delay(10); }
    throw new Error('timed out');
}

test('dsh plugin → generated HTTP draft → test → save → QQ reply works end to end', { timeout: 15000 }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-adapt-flow-'));
    const target = http.createServer(async (req, res) => {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ answer: 'Reply: ' + body.message }));
    });
    target.listen(0, '127.0.0.1'); await once(target, 'listening');
    const endpoint = `http://127.0.0.1:${(target.address() as net.AddressInfo).port}/chat`;
    const upstream = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(upstream, 'listening');
    let upstreamSocket: WebSocket | undefined;
    let sent: { action: string; params: { user_id: number; message: unknown } } | undefined;
    upstream.on('connection', (socket) => {
        upstreamSocket = socket;
        socket.on('message', (raw) => {
            const msg = JSON.parse(String(raw));
            socket.send(JSON.stringify({ echo: msg.echo, status: 'ok', data: { message_id: 1 } }));
            if (msg.action === 'send_private_msg') sent = msg;
        });
    });
    const reserve = net.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
    const extPort = (reserve.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => reserve.close(() => resolve()));
    const config = structuredClone(DEFAULT_CONFIG);
    config.consolePort = 0; config.extPort = extPort; config.registrationToken = 'test';
    config.accounts[0]!.upstream.url = `ws://127.0.0.1:${(upstream.address() as net.AddressInfo).port}`;
    config.sessionAccess.unknownPolicy = 'allow'; config.trigger.privateReply = true; config.segmentation.enabled = false;
    config.downstreams = [config.downstreams[0]!]; config.downstreams[0]!.settings.fallbackHeadless = false;
    await fs.writeFile(path.join(root, 'config.json'), JSON.stringify(config));
    const app = createApplication({ serverRoot: root, env: {} });
    let plugin: WebSocket | undefined;
    try {
        await app.start();
        const apiUrl = `http://127.0.0.1:${(app.httpServer.address() as net.AddressInfo).port}/api`;
        const post = async (url: string, body: unknown) => fetch(apiUrl + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        plugin = new WebSocket(`ws://127.0.0.1:${extPort}`);
        plugin.on('message', (raw) => {
            const msg = JSON.parse(String(raw));
            if (msg.type === 'downstream_ask') {
                assert.match(msg.sessionKey, /^_adaptation_/);
                const input = JSON.parse(msg.text);
                const draft = { id: input.id, name: input.name,
                    connection: { url: endpoint, method: 'POST', headers: {}, timeoutMs: 1000, response: { format: 'json', path: 'answer' } },
                    conversation: { systemPrompt: '', requestBody: { message: '{{input.text}}', session_id: '{{input.sessionKey}}' } } };
                plugin!.send(JSON.stringify({ type: 'downstream_reply', requestId: msg.requestId,
                    text: JSON.stringify({ status: 'ready', summary: 'echo API', questions: [], draft }) }));
            }
        });
        await once(plugin, 'open');
        plugin.send(JSON.stringify({ type: 'hello', kind: 'dsh-plugin', downstreamId: 'dsh', token: 'test' }));
        await waitFor(() => app.context.downstreams.get('dsh')?.status().available, Boolean);
        const foreign = await fetch(apiUrl + '/adaptations', { method: 'POST', headers: { Origin: 'https://unrelated.example', 'Content-Type': 'application/json' }, body: '{}' });
        assert.equal(foreign.status, 403);
        const sourceBefore = app.context.downstreams.get('dsh');
        const created = await post('/adaptations', { id: 'echo-api', name: 'Echo API', goal: '接入 echo', endpoint, documentation: 'POST message, JSON answer' });
        assert.equal(created.status, 202);
        const { job } = await created.json() as { job: { id: string } };
        const complete = await waitFor(async () => ((await (await fetch(apiUrl + '/adaptations/' + job.id)).json()) as { job: AdaptationJob }).job, (value) => value.status !== 'generating');
        assert.equal(complete.status, 'ready');
        const tested = await (await post(`/adaptations/${job.id}/test`, { draft: complete.draft, text: 'test' })).json() as { text: string };
        assert.equal(tested.text, 'Reply: test');
        const saved = await post(`/adaptations/${job.id}/apply`, { draft: complete.draft });
        assert.equal(saved.status, 200);
        assert.equal(app.context.config().defaultDownstreamId, 'dsh');
        assert.ok(app.context.downstreams.get('echo-api'));
        assert.equal(app.context.downstreams.get('dsh'), sourceBefore);
        assert.equal(sourceBefore?.status().available, true);
        const invalidProfile = await post('/downstreams/echo-api/profiles', { id: 'bad', settings: { url: 'http://unexpected.example' } });
        assert.equal(invalidProfile.status, 400);
        const bound = await post('/sessions/' + encodeURIComponent('main:private_123'), { backendId: 'echo-api', profileId: 'default' });
        assert.equal(bound.status, 200);
        await waitFor(() => upstreamSocket?.readyState === WebSocket.OPEN, Boolean);
        upstreamSocket!.send(JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 123, self_id: 999,
            message: [{ type: 'text', data: { text: 'hello' } }], sender: { nickname: 'Test' } }));
        await waitFor(() => sent, Boolean);
        assert.equal(sent!.params.user_id, 123);
        assert.match(JSON.stringify(sent!.params.message), /Reply: hello/);
        const reloaded = loadConfigFile(path.join(root, 'config.json')).config;
        assert.equal(reloaded.downstreams.find((d) => d.id === 'echo-api')?.kind, 'http-json');
        // HTTP adapters must never be treated as inbound plugin adapters.
        const other = new WebSocket(`ws://127.0.0.1:${extPort}`);
        await once(other, 'open');
        const rejected = once(other, 'message');
        other.send(JSON.stringify({ type: 'hello', kind: 'http-json', downstreamId: 'echo-api', token: 'test' }));
        assert.equal(JSON.parse(String((await rejected)[0])).ok, false);
        other.terminate();
    } finally {
        plugin?.terminate(); await app.stop();
        for (const client of upstream.clients) client.terminate();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
        await new Promise<void>((resolve) => { target.close(() => resolve()); target.closeAllConnections(); });
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('configuration save failure leaves live configuration unchanged', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-config-failure-'));
    const file = path.join(root, 'config.json');
    await fs.writeFile(file, JSON.stringify({ ...DEFAULT_CONFIG, registrationToken: 'test' }));
    try {
        const runtime = createConfigRuntime(file, {});
        const before = structuredClone(runtime.config());
        await fs.mkdir(file + '.tmp');
        assert.throws(() => runtime.updateConfig((config) => { config.defaultDownstreamId = 'changed'; }));
        assert.deepEqual(runtime.config(), before);
        assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).defaultDownstreamId, before.defaultDownstreamId);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
