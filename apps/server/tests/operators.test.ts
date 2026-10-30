import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_CONFIG } from '../src/config/schema.ts';
import { parseFlow, resolveFlow } from '../src/config/flows.ts';
import { operatorFlow } from '../src/config/operators.ts';
import { parseConversation } from '../src/config/conversations.ts';
import { executeFlow, FlowRunStore } from '../src/core/flow-runtime.ts';
import { emptyState } from '../src/core/conversation-engine.ts';
import { ConversationStateStore } from '../src/core/conversation-state.ts';
import { SessionStore } from '../src/core/sessions.ts';
import { operatorSessionKey, operatorSessionKeys } from '../src/core/operator-sessions.ts';
const process = (extra = {}) => ({ id: 'process', type: 'process', ...extra });
const call = (extra = {}) => ({ id: 'call', type: 'call', ...extra });
const reply = (extra = {}) => ({ id: 'reply', type: 'reply', ...extra });
const op = (id: string, actions: unknown[], enabled = true) => ({ id, name: id, enabled, actions });
const flow = (operators: unknown[]) => parseFlow({ id: 'custom', name: 'Custom', downstreamId: 'a', operators });
function config() {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.downstreams = ['a', 'b'].map(id => ({ id, name: id, kind: 'http-json', enabled: true, settings: {}, profiles: [] }));
    cfg.defaultDownstreamId = 'a'; return cfg;
}

test('operators freely compose reads, processing, calls and multiple replies, including a reply before any service call', async () => {
    const cfg = config(); const store = new FlowRunStore(); const state = new ConversationStateStore(); const delivered: string[] = []; const called: string[] = [];
    const f = flow([
        op('first', [{ id: 'read', type: 'input', source: '{{message.upstream}}' }, process({ extracts: [{ name: 'nick', mode: 'regex', expression: 'name:(.+)', group: 1 }], assignments: [{ name: 'nick', value: '{{extracted.nick}}' }], prefix: 'Hi {{vars.nick}}: ' }), reply({ text: '收到 {{vars.nick}}' })]),
        op('chain', [call(), process({ prefix: '{{operators.first.extracted.nick}} / ' }), call({ id: 'second', downstreamId: 'b' }), reply()]),
        op('done', [process({ prefix: 'Final: ' }), reply({ stopAfter: true }), call({ id: 'never' })]),
        op('never', [call()]),
    ]);
    let rev = 0;
    const r = await executeFlow({ flow: f, config: cfg, store, sessionKey: 'qq:private_1', mode: 'live', text: 'name:Alice', state: state.read('qq:private_1').state,
        ask: async (input, _system, target) => { called.push(target!.downstreamId); assert.match(target!.sessionKey, /^flow_[a-f0-9]{40}$/); return { ok: true, text: `${target!.downstreamId}(${input})`, elapsedMs: 0 }; },
        commit: next => { rev = state.commit('qq:private_1', next, rev).revision; }, deliver: async text => { delivered.push(text); return { sent: 1, failed: 0 }; } });
    assert.equal(r.ok, true); assert.deepEqual(called, ['a', 'b']); assert.equal(delivered[0], '收到 Alice'); assert.equal(delivered.length, 3);
    assert.equal(delivered[2], 'Final: b(Alice / a(Hi Alice: name:Alice))');
    assert.equal(r.run.steps.length, 4); assert.equal(r.run.steps[0]?.actions?.length, 3); assert.equal(r.run.steps[2]?.actions?.[2]?.status, 'skipped'); assert.equal(r.run.steps[3]?.status, 'skipped');
    assert.equal(state.read('qq:private_1').state.vars.nick, 'Alice'); assert.equal(state.read('qq:private_1').state.operators?.first?.extracted.nick, 'Alice'); assert.equal(state.read('other:private_1').state.vars.nick, undefined);
    assert.equal(r.run.deliveries?.length, 3); assert.ok(rev >= 2);
    const long = 'qq:private_' + '9'.repeat(80);
    const firstKey = operatorSessionKey(long, f.id, 'chain', 'call');
    const secondKey = operatorSessionKey(long, f.id, 'chain', 'second');
    assert.ok(firstKey.length < 60); assert.notEqual(firstKey, secondKey);
    assert.ok(operatorSessionKeys([f], long, 'a').includes(firstKey)); assert.ok(operatorSessionKeys([f], long, 'b').includes(secondKey));
});

test('failure after an intermediate reply keeps its checkpoint and exposes unsaved later assignments without retrying', async () => {
    const cfg = config(); const state = new ConversationStateStore(); let rev = 0; let sends = 0; let calls = 0;
    const f = flow([op('ack', [process({ assignments: [{ name: 'phase', value: 'ack' }] }), reply({ text: 'ack' })]), op('failure', [process({ assignments: [{ name: 'phase', value: 'pending' }] }), call(), reply()])]);
    const r = await executeFlow({ flow: f, config: cfg, store: new FlowRunStore(), sessionKey: 'qq:private_1', mode: 'live', text: 'hello',
        ask: async () => { calls++; return { ok: false, error: 'offline', text: '', elapsedMs: 0 }; }, commit: next => { rev = state.commit('qq:private_1', next, rev).revision; }, deliver: async () => { sends++; return { sent: 1, failed: 0 }; } });
    assert.equal(r.ok, false); assert.equal(sends, 1); assert.equal(calls, 1); assert.equal(r.run.partialEffects, true); assert.equal(r.run.variablesSaved, true);
    assert.equal(state.read('qq:private_1').state.vars.phase, 'ack'); assert.equal(r.run.variables[0]?.after, 'pending'); assert.equal(r.run.variables[0]?.saved, false);
    assert.equal(r.run.steps[1]?.actions?.[1]?.status, 'failed'); assert.equal(r.run.steps[1]?.actions?.[2]?.status, 'skipped');
});

test('operator history and variables are available on the next turn and preview replies never deliver or persist', async () => {
    const cfg = config(); const f = flow([op('memo', [process({ assignments: [{ name: 'last', value: '{{text}}' }], prefix: '{{history.memo.output}}|' }), reply()])]);
    const store = new FlowRunStore(); const base = { flow: f, config: cfg, store, sessionKey: '_preview', mode: 'preview' as const, ask: async () => { throw new Error('no calls'); } };
    const first = await executeFlow({ ...base, text: 'one' });
    assert.equal(first.output, '|one'); assert.equal(first.run.variablesSaved, false); assert.equal(first.run.deliveries?.[0]?.simulated, true);
    const second = await executeFlow({ ...base, text: 'two', state: first.state });
    assert.equal(second.output, '|one|two'); assert.equal(second.state?.vars.last, 'two'); assert.equal(first.state?.vars.last, 'one');
});

test('any operator can return and terminate without a downstream call; failed delivery stops subsequent actions', async () => {
    const cfg = config(); let calls = 0;
    const f = flow([op('returnEarly', [reply({ text: 'OK', stopAfter: true }), call()])]);
    const r = await executeFlow({ flow: f, config: cfg, store: new FlowRunStore(), sessionKey: 'a', mode: 'live', text: 'hello', ask: async () => { calls++; throw new Error('no'); }, deliver: async () => ({ sent: 0, failed: 1 }) });
    assert.equal(r.ok, false); assert.equal(calls, 0); assert.equal(r.run.steps[0]?.actions?.[0]?.status, 'failed'); assert.equal(r.run.steps[0]?.actions?.[1]?.status, 'skipped');
});

test('operator parsing rejects invalid graphs, prototypes, duplicate identities and malformed rules; template data stays literal', async () => {
    assert.throws(() => flow([op('same', [call()]), op('same', [reply()])]));
    assert.throws(() => flow([op('bad', [{ type: 'script', code: 'run()' }])]));
    assert.throws(() => flow([op('bad', [process({ extracts: [{ name: 'value', source: '{{text}}', mode: 'json', expression: '__proto__.x' }] })])]));
    assert.throws(() => flow([op('bad', [reply({ text: '{{vars.__proto__}}' })])]));
    const cfg = config(); const r = await executeFlow({ flow: flow([op('safe', [process({ source: 'x', extracts: [{ name: 'value', source: '{{message.upstream}}', mode: 'regex', expression: '^x[|](.+)$', group: 1 }], assignments: [{ name: 'value', value: '{{extracted.value}}' }], rules: [{ type: 'replace', pattern: 'x', replacement: '{{vars.value}}' }] })])]), config: cfg, store: new FlowRunStore(), sessionKey: 'a', mode: 'preview', text: 'x|$&{{vars.secret}}', ask: async () => { throw new Error('no'); } });
    assert.equal(r.output, '$&{{vars.secret}}');
});

test('old conversation settings are copied into editable operators, and downstream/config pairs never cross-bind', () => {
    const cfg = config(); cfg.conversationProfiles = [parseConversation({ id: 'old', systemPrompt: 'system', inputPrefix: 'prefix', replyPrefix: 'reply' })];
    const old = parseFlow({ id: 'oldFlow', downstreamId: 'a', conversationId: 'old' }); const converted = operatorFlow(old, cfg);
    assert.equal(converted.operators[0]?.actions[0]?.type, 'process');
    cfg.conversationProfiles[0]!.inputPrefix = 'changed';
    assert.equal(converted.operators[0]?.actions[0]?.type === 'process' && converted.operators[0]?.actions[0]?.prefix, 'prefix');
    cfg.flows = [flow([op('return', [reply()])])]; cfg.defaultFlowId = 'custom'; cfg.downstreamFlowDefaults.a = 'custom';
    const sessions = new SessionStore('unused', () => ({ backendId: 'a', profileId: '', character: '', world: '' }));
    sessions.patch('pair', { backendId: 'b', flowId: 'custom' }); assert.equal(resolveFlow(cfg, sessions, 'pair').flow, undefined);
    sessions.patch('pair', { backendId: 'a', flowId: undefined, flowDefault: true }); assert.equal(resolveFlow(cfg, sessions, 'pair').id, 'custom'); sessions.flush = () => {};
});


test('operator checkpoints survive restart and a storage failure prevents the next reply', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-operators-'));
    try {
        const file = path.join(root, 'state.json'); const state = new ConversationStateStore(file); let revision = 0;
        const f = flow([op('memory', [process({ assignments: [{ name: 'nick', value: '{{text}}' }] }), reply()])]);
        const base = { flow: f, config: config(), store: new FlowRunStore(), sessionKey: 'qq:private_1', mode: 'live' as const, ask: async () => { throw new Error('no calls'); } };
        const first = await executeFlow({ ...base, text: 'Alice', commit: value => { revision = state.commit(base.sessionKey, value, revision).revision; }, deliver: async () => ({ sent: 1, failed: 0 }) });
        assert.equal(first.ok, true);
        const restarted = new ConversationStateStore(file); const saved = restarted.read(base.sessionKey);
        assert.equal(saved.state.vars.nick, 'Alice'); assert.equal(saved.state.operators?.memory?.output, 'Alice');
        let sends = 0;
        const failed = await executeFlow({ ...base, state: saved.state, text: 'Bob', commit: () => { throw new Error('disk unavailable'); }, deliver: async () => { sends++; return { sent: 1, failed: 0 }; } });
        assert.equal(failed.ok, false); assert.equal(sends, 0); assert.equal(failed.run.variablesSaved, false); assert.equal(restarted.read(base.sessionKey).state.vars.nick, 'Alice');
        await state.close(); await restarted.close();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
