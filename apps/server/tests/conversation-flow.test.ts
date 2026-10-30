import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseConversation } from '../src/config/conversations.ts';
import { ConversationTurn, emptyState } from '../src/core/conversation-engine.ts';
import { ConversationStateStore } from '../src/core/conversation-state.ts';

const config = () => parseConversation({ id: 'flow', name: 'Flow', systemPrompt: '称呼 {{vars.nickname}}，上次编号 {{previous.downstream.ticket}}',
    inputPrefix: '{{vars.nickname}}: ', inputSuffix: '', inputRules: [], replyRules: [{ type: 'replace', pattern: '^[\\s\\S]*$', replacement: '{{current.upstream.nickname}}|{{current.downstream.ticket}}|{{vars.nickname}}' }],
    replyPrefix: '回复 ', replySuffix: '。', variables: [{ name: 'nickname', initialValue: '访客' }],
    upstreamExtracts: [{ name: 'nickname', mode: 'regex', expression: '我叫(.+)', group: 1, flags: '' }],
    downstreamExtracts: [{ name: 'ticket', mode: 'json', expression: 'data.ticket' }],
    upstreamAssignments: [{ name: 'nickname', value: '{{current.upstream.nickname}}' }], downstreamAssignments: [{ name: 'lastTicket', value: '{{current.downstream.ticket}}' }],
});

test('both stages share extracted data, previous values and per-session persistent variables', () => {
    const first = new ConversationTurn(config());
    const prepared = first.upstream('我叫小明');
    assert.equal(prepared.input, '小明: 我叫小明');
    assert.equal(prepared.system, '称呼 小明，上次编号 ');
    const done = first.downstream('{"data":{"ticket":"T42"}}');
    assert.equal(done.output, '回复 小明|T42|小明。');
    assert.equal(done.system, prepared.system);
    assert.deepEqual(done.state.vars, { nickname: '小明', lastTicket: 'T42' });
    const next = new ConversationTurn(config(), done.state);
    assert.equal(next.upstream('你好').system, '称呼 小明，上次编号 T42');
    const second = next.downstream('{"data":{"ticket":"T43"}}');
    assert.equal(second.state.vars.nickname, '小明', 'unmatched empty extraction does not erase a durable variable');
    assert.equal(second.state.previous.upstream.nickname, '', 'current misses never silently reuse stale extraction');
    assert.equal(new ConversationTurn(config()).upstream('你好').input, '访客: 你好', 'another session starts from its own initial value');
    assert.deepEqual(done.state.vars, { nickname: '小明', lastTicket: 'T42' }, 'working copies never mutate earlier snapshots');
});

test('data-source templates and JSON array paths work without recursively interpreting message content', () => {
    const p = parseConversation({ id: 'json', upstreamExtracts: [{ name: 'value', mode: 'json', expression: 'items.0.value' }], downstreamExtracts: [{ name: 'copied', source: '{{current.upstream.value}}', mode: 'regex', expression: '(.*)', group: 1 }], variables: [{ name: 'secret', initialValue: 'private' }], inputPrefix: '{{current.upstream.value}}' });
    const t = new ConversationTurn(p);
    t.upstream('{"items":[{"value":"{{vars.secret}}"}]}');
    const done = t.downstream('ok');
    assert.equal(done.extracted.downstream.copied, '{{vars.secret}}');
    assert.ok(done.input.startsWith('{{vars.secret}}'), 'user data does not execute nested templates');
    const bad = new ConversationTurn(p); bad.upstream('not-json');
    assert.ok(bad.downstream('').warnings.length > 0);
});

test('configuration rejects future dependencies, invalid captures, prototype paths and invalid variable names', () => {
    assert.throws(() => parseConversation({ id: 'bad', inputPrefix: '{{current.downstream.answer}}' }), /上一轮/);
    assert.throws(() => parseConversation({ id: 'bad', upstreamAssignments: [{ name: 'x', value: '{{message.downstream}}' }] }));
    assert.throws(() => parseConversation({ id: 'bad', downstreamExtracts: [{ name: 'x', mode: 'json', expression: '__proto__.x' }] }));
    assert.throws(() => parseConversation({ id: 'bad', variables: [{ name: 'constructor', initialValue: '' }] }));
    assert.throws(() => parseConversation({ id: 'bad', upstreamExtracts: [{ name: 'x', mode: 'regex', expression: '[', group: 1 }] }));
    const t = new ConversationTurn(parseConversation({ id: 'literal', inputPrefix: '{{char}}' }));
    assert.equal(t.upstream('hi').input, '{{char}}hi', 'unrelated existing macros remain literal');
});

test('replacement templates treat extracted dollar signs as data and explicit empty assignment can clear a value', () => {
    const p = parseConversation({ id: 'dollar', variables: [{ name: 'value', initialValue: '$&' }], replyRules: [{ type: 'replace', pattern: '^.*$', replacement: '{{vars.value}}' }] });
    const turn = new ConversationTurn(p); turn.upstream('hi');
    assert.equal(turn.downstream('original').output, '$&');
    p.upstreamAssignments = [{ name: 'value', value: '', skipEmpty: false }];
    const next = new ConversationTurn(p); next.upstream('hi');
    assert.equal(next.downstream('original').state.vars.value, '');
});

test('durable variables and extraction history survive restart and are isolated by complete session key', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-vars-'));
    const file = path.join(root, 'state.json');
    try {
        const store = new ConversationStateStore(file);
        const first = new ConversationTurn(config()); first.upstream('我叫小明');
        store.commit('a:private_1', first.downstream('{"data":{"ticket":7}}').state, 0);
        assert.deepEqual(store.read('b:private_1').state, emptyState());
        assert.deepEqual(store.read('a:group_1_2').state, emptyState());
        const reloaded = new ConversationStateStore(file);
        assert.equal(reloaded.read('a:private_1').state.vars.nickname, '小明');
        assert.equal(reloaded.read('a:private_1').state.previous.downstream.ticket, '7');
        assert.throws(() => reloaded.commit('a:private_1', emptyState(), 0), /刷新/);
        const failed = new ConversationTurn(config(), store.read('a:private_1').state);
        failed.upstream('我叫新名字');
        assert.equal(store.read('a:private_1').state.vars.nickname, '小明', 'failed downstream calls can discard a turn without advancing history');
        await store.close(); await reloaded.close();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('disk write failures leave live state unchanged and corrupt files do not silently erase variables', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-vars-atomic-'));
    const file = path.join(root, 'state.json');
    try {
        const store = new ConversationStateStore(file);
        store.commit('a', { ...emptyState(), vars: { nickname: 'old' } }, 0);
        fs.mkdirSync(file + '.tmp');
        assert.throws(() => store.commit('a', { ...emptyState(), vars: { nickname: 'new' } }, 1));
        assert.equal(store.read('a').state.vars.nickname, 'old');
        assert.equal(new ConversationStateStore(file).read('a').state.vars.nickname, 'old');
        fs.writeFileSync(file, 'broken');
        assert.throws(() => new ConversationStateStore(file), /备份恢复/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('same-session turns serialize while different sessions continue independently; a failure does not poison the queue', async () => {
    const store = new ConversationStateStore();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => release = resolve);
    const first = store.serial('a', async () => { events.push('a1'); await gate; throw new Error('downstream failed'); });
    const rejection = assert.rejects(first, /downstream failed/);
    const second = store.serial('a', () => { events.push('a2'); });
    await store.serial('b', () => { events.push('b'); });
    assert.deepEqual(events, ['a1', 'b']);
    release(); await rejection; await second;
    assert.deepEqual(events, ['a1', 'b', 'a2']); await store.close();
});
