import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import type net from 'node:net';
import { once } from 'node:events';
import { DEFAULT_CONFIG } from '../src/config/schema.ts';
import { parseConversation } from '../src/config/conversations.ts';
import { parseFlow, validateFlow, resolveFlow, availableFlows, mirrorFlowDefault, type MessageFlow } from '../src/config/flows.ts';
import { executeFlow, FlowRunStore } from '../src/core/flow-runtime.ts';
import { emptyState } from '../src/core/conversation-engine.ts';
import { SessionStore } from '../src/core/sessions.ts';
import { createApplication } from '../src/app/application.ts';
import { loadConfigFile } from '../src/config/store.ts';

function config() {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.downstreams = [{ id: 'api', name: 'API', kind: 'http-json', enabled: true, settings: { headers: { Authorization: 'private-token' } }, profiles: [] }];
    cfg.defaultDownstreamId = 'api';
    cfg.conversationProfiles = [parseConversation({ id: 'dialog', systemPrompt: '请称呼 {{vars.nickname}}', inputPrefix: 'input:', replyPrefix: 'output:', variables: [{ name: 'nickname', initialValue: 'Guest' }], downstreamAssignments: [{ name: 'nickname', value: 'Updated' }] })];
    return cfg;
}
const flow = (): MessageFlow => ({ id: 'main_flow', name: 'Main', enabled: true, downstreamId: 'api', conversationId: 'dialog', upstreamEnabled: true, downstreamEnabled: true });

test('a flow executes fixed steps, commits variables only after processing, and keeps credentials out of traces', async () => {
    const cfg = config(); const store = new FlowRunStore(); const original = emptyState();
    let committed = ''; let delivered = '';
    const result = await executeFlow({ flow: flow(), config: cfg, store, sessionKey: 'a:private_1', mode: 'live', text: 'hello', state: original,
        ask: async (text, system) => { assert.equal(text, 'input:hello'); assert.equal(system, '请称呼 Guest'); return { ok: true, text: 'answer', elapsedMs: 0 }; },
        commit: state => { committed = state.vars.nickname!; }, deliver: async text => { delivered = text; return { sent: 1, failed: 0 }; } });
    assert.equal(result.ok, true); assert.equal(committed, 'Updated'); assert.equal(delivered, 'output:answer');
    assert.deepEqual(result.run.steps.map(s => s.status), ['success', 'success', 'success', 'success']);
    assert.equal(result.run.variablesSaved, true); assert.deepEqual(original, emptyState());
    assert.equal(JSON.stringify(store.list()).includes('private-token'), false);
});

test('disabled processing passes text through and filtering skips all later side effects', async () => {
    const cfg = config(); const store = new FlowRunStore(); let calls = 0;
    const f = { ...flow(), upstreamEnabled: false, downstreamEnabled: false };
    const r = await executeFlow({ flow: f, config: cfg, store, sessionKey: 'a', mode: 'preview', text: 'hello', ask: async (text, system) => { calls++; assert.equal(text, 'hello'); assert.equal(system, ''); return { ok: true, text: 'raw', elapsedMs: 0 }; } });
    assert.equal(r.output, 'raw'); assert.equal(r.state, undefined);
    assert.deepEqual(r.run.steps.map(s => s.status), ['skipped', 'success', 'skipped', 'skipped']);
    cfg.conversationProfiles[0]!.inputPrefix = ''; cfg.conversationProfiles[0]!.inputRules = [{ type: 'remove', pattern: '.*' }];
    const filtered = await executeFlow({ flow: flow(), config: cfg, store, sessionKey: 'a', mode: 'preview', text: 'hello', ask: async () => { calls++; throw new Error('must not run'); } });
    assert.equal(filtered.run.status, 'filtered'); assert.equal(calls, 1);
});

test('downstream, persistence and QQ delivery failures are recorded at their own step without retries', async () => {
    const cfg = config(); const store = new FlowRunStore(); let calls = 0; let commits = 0;
    const base = { flow: flow(), config: cfg, store, sessionKey: 'a', mode: 'live' as const, text: 'hello' };
    const failed = await executeFlow({ ...base, ask: async () => ({ ok: false, text: '', elapsedMs: 0, error: 'HTTP 500' }), commit: () => { commits++; } });
    assert.equal(failed.run.steps[1]?.status, 'failed'); assert.equal(commits, 0);
    const disk = await executeFlow({ ...base, ask: async () => ({ ok: true, text: 'ok', elapsedMs: 0 }), commit: () => { throw new Error('disk full'); } });
    assert.equal(disk.run.steps[2]?.status, 'failed'); assert.equal(disk.run.variablesSaved, false);
    const delivery = await executeFlow({ ...base, ask: async () => { calls++; return { ok: true, text: 'ok', elapsedMs: 0 }; }, commit: () => { commits++; }, deliver: async () => ({ sent: 0, failed: 1 }) });
    assert.equal(delivery.run.status, 'failed'); assert.equal(delivery.run.steps[3]?.status, 'failed'); assert.equal(delivery.run.variablesSaved, true);
    assert.equal(calls, 1); assert.equal(commits, 1);
});

test('validation and trace retention keep unsupported graphs out and missing explicit flows fail closed', async () => {
    const cfg = config();
    assert.throws(() => parseFlow({ ...flow(), nodes: [] }));
    assert.throws(() => validateFlow({ ...flow(), conversationId: 'missing' }, cfg));
    const sessions = new SessionStore('unused', () => ({ backendId: 'api', profileId: '', character: '', world: '' }));
    assert.equal(resolveFlow(cfg, sessions, 'a').flow?.downstreamId, 'api');
    sessions.patch('a', { flowId: 'missing' });
    assert.equal(resolveFlow(cfg, sessions, 'a').flow, undefined);
    const store = new FlowRunStore();
    for (let i = 0; i < 55; i++) store.begin(flow(), String(i), 'preview');
    assert.equal(store.list().length, 50);
    const clone = store.list(); clone[0]!.flowName = 'mutated'; assert.equal(store.list()[0]?.flowName, 'Main');
    sessions.flush = () => {};
});

test('compatibility defaults preserve legacy prompt mode when materialized', () => {
    const cfg = config();
    const sessions = new SessionStore('unused', () => ({ backendId: cfg.defaultDownstreamId, profileId: '', character: '', world: '' }));
    const generated = availableFlows(cfg, sessions)[0]!;
    assert.equal(generated.legacyPreserveBehavior, true);
    cfg.flows.push(generated); mirrorFlowDefault(cfg, generated);
    assert.equal(cfg.defaultConversationId, '');
    assert.equal(resolveFlow(cfg, sessions, 'new').flow?.legacyPreserveBehavior, true);
});

test('flow APIs preview without calls, bind one flow, protect references and test with isolated state', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-flows-'));
    let calls = 0;
    const target = http.createServer(async (req, res) => { calls++; let raw = ''; for await (const chunk of req) raw += chunk; const input = JSON.parse(raw); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ answer: input.text })); });
    target.listen(0, '127.0.0.1'); await once(target, 'listening');
    const cfg = config(); cfg.consolePort = 0; cfg.extPort = 0; cfg.registrationToken = 'fixture'; cfg.accounts.forEach(a => a.enabled = false);
    cfg.downstreams[0]!.settings = { url: `http://127.0.0.1:${(target.address() as net.AddressInfo).port}`, method: 'POST', headers: {}, timeoutMs: 1000, response: { format: 'json', path: 'answer' }, requestBody: { text: '{{input.text}}', system: '{{input.system}}', session: '{{input.sessionKey}}' } };
    cfg.downstreams.push({ ...structuredClone(cfg.downstreams[0]!), id: 'other', name: 'Other' });
    await fs.writeFile(path.join(root, 'config.json'), JSON.stringify(cfg));
    const app = createApplication({ serverRoot: root, env: {} });
    try {
        await app.start(); const base = `http://127.0.0.1:${(app.httpServer.address() as net.AddressInfo).port}/api`;
        const post = (url: string, value: unknown) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
        const compat = parseFlow(availableFlows(app.context.config(), app.context.sessions)[0]! as unknown as Record<string, unknown>);
        const oldPreview = await (await post('/flows/preview', { flow: compat, text: 'old', reply: 'mock' })).json() as { ok: boolean; output: string };
        assert.equal(oldPreview.ok, true); assert.equal(oldPreview.output, 'mock'); assert.equal(calls, 0);
        assert.equal((await post('/sessions/' + encodeURIComponent('main:private_legacy'), { backendId: 'api', flowId: null })).status, 200);
        assert.equal(resolveFlow(app.context.config(), app.context.sessions, 'main:private_legacy').flow?.legacyPreserveBehavior, true);
        const changedPreview = await (await post('/flows/preview', { flow: { ...compat, name: 'edited' }, text: 'old', reply: 'mock' })).json() as { ok: boolean };
        assert.equal(changedPreview.ok, false);
        assert.equal((await post('/flows', flow())).status, 200);
        const preview = await (await post('/flows/preview', { flow: flow(), text: 'hello', reply: 'mock' })).json() as { output: string; run: { mode: string } };
        assert.equal(preview.output, 'output:mock'); assert.equal(calls, 0);
        assert.equal((await post('/flows/main_flow/default', {})).status, 200);
        const key = 'main:private_123';
        assert.equal((await post('/sessions/' + encodeURIComponent(key), { flowId: 'main_flow' })).status, 200);
        assert.equal((await post('/sessions/' + encodeURIComponent(key), { flowId: 'missing' })).status, 400);
        assert.equal((await post('/sessions/' + encodeURIComponent(key), { flowId: 'main_flow', backendId: 'missing' })).status, 400);
        assert.equal(app.context.sessions.get(key)?.flowId, 'main_flow');
        for (const route of ['/flows/main_flow', '/downstreams/api', '/conversations/dialog']) assert.equal((await fetch(base + route, { method: 'DELETE' })).status, 409);
        const tested = await (await post('/flows/main_flow/test', { text: 'actual' })).json() as { output: string; run: { variablesSaved: boolean } };
        assert.equal(tested.output, 'output:input:actual'); assert.equal(calls, 1); assert.equal(tested.run.variablesSaved, false);
        assert.deepEqual(app.context.conversationState.read(key).state, emptyState());
        const loaded = loadConfigFile(path.join(root, 'config.json')).config;
        assert.equal(loaded.defaultFlowId, 'main_flow');
        const duplicated = path.join(root, 'duplicated.json');
        await fs.writeFile(duplicated, JSON.stringify({ ...loaded, flows: [...loaded.flows, { ...loaded.flows.find(f => f.id === 'main_flow'), name: 'Duplicate' }] }));
        const deduped = loadConfigFile(duplicated);
        assert.equal(deduped.config.flows.length, loaded.flows.length); assert.equal(deduped.config.flows.find(f => f.id === 'main_flow')?.name, 'Main'); assert.ok(deduped.notes.some(n => n.includes('流程 id 重复')));
        const records = await (await fetch(base + '/flow-runs')).json() as { runs: unknown[] }; assert.equal(records.runs.length, 4);
        assert.equal((await post('/sessions/' + encodeURIComponent(key), { flowId: null })).status, 200);
        assert.equal(app.context.sessions.get(key)?.flowId, undefined);
        assert.equal(resolveFlow(app.context.config(), app.context.sessions, key).id, 'main_flow');
        const composed = { id: 'composed', name: 'Composed', downstreamId: 'api', operators: [
            { id: 'ack', name: 'Ack', actions: [{ id: 'send', type: 'reply', text: 'ack' }] },
            { id: 'work', name: 'Work', actions: [{ id: 'first', type: 'call' }, { id: 'prefix', type: 'process', prefix: 'next:' }, { id: 'second', type: 'call', downstreamId: 'other' }, { id: 'send', type: 'reply', stopAfter: true }] },
        ] };
        assert.equal((await post('/flows/validate', composed)).status, 200);
        assert.equal((await post('/flows/validate', { ...composed, operators: [{ id: 'bad', actions: [{ type: 'script' }] }] })).status, 400);
        assert.equal((await post('/flows', composed)).status, 200);
        const simulated = await (await post('/flows/preview', { flow: composed, text: 'hello', reply: 'default', replies: { 'work.first': 'first mock', 'work.second': 'second mock' } })).json() as { output: string; run: { deliveries: Array<{ text: string }> } };
        assert.equal(simulated.output, 'second mock'); assert.deepEqual(simulated.run.deliveries.map(r => r.text), ['ack', 'second mock']); assert.equal(calls, 1);
        assert.equal((await post('/flow-defaults', { downstreamId: 'api', flowId: 'composed' })).status, 200);
        assert.equal((await post('/sessions/' + encodeURIComponent(key), { backendId: 'api', flowId: null })).status, 200);
        assert.equal(resolveFlow(app.context.config(), app.context.sessions, key).id, 'composed');
        assert.equal((await post('/sessions/' + encodeURIComponent(key), { backendId: 'other', flowId: 'composed' })).status, 400);
        assert.equal((await post('/sessions/' + encodeURIComponent(key), { backendId: 'other', flowId: null })).status, 400);
        assert.equal((await fetch(base + '/downstreams/other', { method: 'DELETE' })).status, 409, 'secondary call connections are protected too');
        const actual = await (await post('/flows/composed/test', { text: 'actual' })).json() as { output: string; run: { deliveries: Array<{ simulated: boolean }>; variablesSaved: boolean } };
        assert.equal(actual.output, 'next:actual'); assert.equal(calls, 3); assert.ok(actual.run.deliveries.every(r => r.simulated)); assert.equal(actual.run.variablesSaved, false);
        assert.deepEqual(app.context.conversationState.read(key).state, emptyState());
        const restarted = loadConfigFile(path.join(root, 'config.json')).config;
        assert.equal(restarted.downstreamFlowDefaults.api, 'composed'); assert.equal(restarted.flows.find(f => f.id === 'composed')?.operators?.length, 2);

    } finally { await app.stop(); await new Promise<void>(r => target.close(() => r())); await fs.rm(root, { recursive: true, force: true }); }
});
