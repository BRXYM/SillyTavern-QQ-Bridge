import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AdaptationService, parseGeneration, parseDraft, draftToDownstream, type AdaptationInput } from '../src/services/adaptation/service.ts';
import { DEFAULT_CONFIG } from '../src/config/schema.ts';
import type { DownstreamAdapter, DownstreamAsk } from '../src/downstream/types.ts';
import type { DownstreamRuntime } from '../src/downstream/runtime.ts';

const input: AdaptationInput = { id: 'new-api', name: 'New API', goal: '接入客服', endpoint: 'http://127.0.0.1:8000/chat', documentation: 'POST /chat returns answer', sourceId: '' };
const draft = { id: input.id, name: input.name, connection: { url: input.endpoint, method: 'POST', headers: {}, timeoutMs: 1000, response: { format: 'json', path: 'answer' } }, conversation: { systemPrompt: 'test', requestBody: { message: '{{input.text}}' } } };
const generated = JSON.stringify({ status: 'ready', summary: '同步接口', questions: [], draft });
async function settled(service: AdaptationService, id: string) {
    for (let i = 0; i < 100; i++) { if (service.get(id).status !== 'generating') return service.get(id); await delay(5); }
    throw new Error('generation did not finish');
}
function fixture(ask: (req: DownstreamAsk) => Promise<{ ok: boolean; text: string; elapsedMs: number }> = async () => ({ ok: true, text: generated, elapsedMs: 1 })) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-adapt-'));
    let cfg = structuredClone(DEFAULT_CONFIG);
    const resets: string[] = [];
    let reloads = 0;
    const adapter: DownstreamAdapter = { id: 'dsh', name: 'dsh', kind: 'dsh-plugin', init: async () => {}, dispose: async () => {},
        status: () => ({ id: 'dsh', kind: 'dsh-plugin', name: 'dsh', enabled: true, available: true }), ask,
        resetSession: async (key) => { resets.push(key); return true; } };
    const downstreams: DownstreamRuntime = { list: () => [adapter], get: (id) => id === 'dsh' ? adapter : undefined,
        resolve: () => undefined, reload: async () => { reloads++; return { ok: true }; }, register: async () => ({ ok: true }) };
    const deps = { config: () => cfg, updateConfig: (mutate: (c: typeof cfg) => void) => { const copy = structuredClone(cfg); mutate(copy); cfg = copy; }, downstreams, dataDir };
    const service = new AdaptationService(deps);
    return { service, deps, resets, reloads: () => reloads,
        cleanup: async () => { await service.dispose(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

test('only structured supported drafts are accepted; missing facts become questions', () => {
    assert.equal(parseGeneration('```json\n' + generated + '\n```', input).status, 'ready');
    assert.equal(parseGeneration(JSON.stringify({ status: 'needs-input', questions: ['需要响应示例'] }), input).status, 'needs-input');
    assert.throws(() => parseGeneration('just run this code', input));
    assert.throws(() => parseDraft({ ...draft, connection: { ...draft.connection, url: 'https://unexpected.example/run' } }, input));
    assert.throws(() => parseDraft({ ...draft, id: 'different' }, input));
    assert.throws(() => parseDraft({ ...draft, connection: { ...draft.connection, script: 'arbitrary()' } }, input));
    const target = draftToDownstream(parseDraft(draft));
    assert.equal(target.kind, 'http-json'); assert.equal(target.profiles[0]?.settings.systemPrompt, 'test');
    assert.equal(target.profiles[0]?.settings.url, undefined);
});

test('generation uses an isolated dsh request, persists it, applies without changing default, and is idempotent', async () => {
    let received!: DownstreamAsk;
    const f = fixture(async (request) => { received = request; return { ok: true, text: generated, elapsedMs: 1 }; });
    try {
        const job = f.service.create({ ...input });
        assert.equal(job.status, 'generating');
        const result = await settled(f.service, job.id);
        assert.equal(result.status, 'ready');
        assert.match(received.sessionKey, /^_adaptation_/);
        assert.deepEqual(JSON.parse(received.text), { ...input, sourceId: 'dsh' });
        assert.ok(!received.text.includes('registrationToken'));
        await delay(5); assert.deepEqual(f.resets, [received.sessionKey]);
        assert.equal(fs.existsSync(path.join(f.deps.dataDir, job.id + '.json')), true);
        const restored = new AdaptationService(f.deps);
        try { assert.equal(restored.get(job.id).status, 'ready'); } finally { await restored.dispose(); }
        const saved = await f.service.apply(job.id, draft);
        assert.equal(saved.id, input.id); assert.equal(f.deps.config().defaultDownstreamId, 'dsh');
        assert.equal(f.deps.config().downstreams.at(-1)?.profiles.length, 1);
        await f.service.apply(job.id, draft);
        assert.equal(f.deps.config().downstreams.filter((d) => d.id === input.id).length, 1);
        assert.equal(f.reloads(), 1);
    } finally { await f.cleanup(); }
});

test('missing dsh, concurrent generation and existing IDs report actionable errors', async () => {
    let finish!: (value: { ok: boolean; text: string; elapsedMs: number }) => void;
    const f = fixture(() => new Promise((resolve) => { finish = resolve; }));
    try {
        assert.throws(() => f.service.create({ ...input, id: 'dsh' }), /已存在/);
        assert.throws(() => f.service.create({ ...input, sourceId: 'unknown' }), /没有可用/);
        const job = f.service.create({ ...input });
        assert.throws(() => f.service.create({ ...input, id: 'other' }), /正在生成/);
        finish({ ok: true, text: JSON.stringify({ status: 'needs-input', questions: ['需要接口正文'] }), elapsedMs: 1 });
        assert.equal((await settled(f.service, job.id)).status, 'needs-input');
        await assert.rejects(f.service.apply(job.id, draft), /尚未生成/);
    } finally { await f.cleanup(); }
});

test('model failures and unsupported manifests never write live downstream config', async () => {
    const f = fixture(async () => ({ ok: true, text: '{"status":"ready","draft":{"script":"bad"}}', elapsedMs: 1 }));
    try {
        const before = structuredClone(f.deps.config());
        const job = f.service.create({ ...input });
        assert.equal((await settled(f.service, job.id)).status, 'failed');
        assert.deepEqual(f.deps.config(), before);
    } finally { await f.cleanup(); }
});

test('shutdown and restart report interrupted generation instead of leaving a running job', async () => {
    let finish!: (value: { ok: boolean; text: string; elapsedMs: number }) => void;
    const f = fixture(() => new Promise((resolve) => { finish = resolve; }));
    try {
        const job = f.service.create({ ...input });
        await f.service.dispose();
        const restored = new AdaptationService(f.deps);
        try { assert.equal(restored.get(job.id).status, 'failed'); } finally { await restored.dispose(); }
        finish({ ok: true, text: generated, elapsedMs: 1 });
        await delay(5);
        assert.equal(f.service.get(job.id).status, 'failed');
    } finally { await f.cleanup(); }
});

test('a task-record write error does not pretend that an already saved downstream was lost', async () => {
    const f = fixture();
    try {
        const job = f.service.create({ ...input });
        await settled(f.service, job.id); await delay(5);
        fs.rmSync(f.deps.dataDir, { recursive: true, force: true });
        fs.writeFileSync(f.deps.dataDir, 'block task-record directory');
        const saved = await f.service.apply(job.id, draft);
        assert.match(saved.warning!, /下游配置已保存/);
        assert.equal(f.reloads(), 1);
        assert.ok(f.deps.config().downstreams.some((entry) => entry.id === input.id));
    } finally { await f.cleanup(); }
});
