import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { HttpJsonAdapter, parseHttpConnection, validateRequestBody } from '../src/downstream/http-json.ts';

async function server(handler: http.RequestListener) {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }) };
}
function adapter(url: string, settings: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = {}) {
    return new HttpJsonAdapter({ id: 'api', kind: 'http-json', name: 'API', enabled: true, profiles: [], settings: {
        url, method: 'POST', headers: {}, timeoutMs: 1000, response: { format: 'json', path: 'answer' }, requestBody: { message: '{{input.text}}', session: '{{input.sessionKey}}' }, ...settings,
    } }, env);
}
const input = { sessionKey: 'qq:private_1', text: 'hello " \n {{ untouched }}', system: '', sender: 'A' };

test('HTTP mapping preserves JSON strings, per-call profiles and environment credentials', async () => {
    let received: unknown;
    const s = await server(async (req, res) => {
        assert.equal(req.headers.authorization, 'Bearer test-only');
        let raw = ''; for await (const chunk of req) raw += chunk;
        received = JSON.parse(raw);
        res.end(JSON.stringify({ choices: [{ message: { content: 'mapped reply' } }] }));
    });
    const a = adapter(s.url, { headers: { Authorization: 'Bearer {{env.TEST_KEY}}' }, response: { format: 'json', path: 'choices.0.message.content' }, requestBody: { message: '{{input.text}}', system: '{{input.system}}' }, systemPrompt: 'custom prompt' }, { TEST_KEY: 'test-only' });
    try {
        await a.init();
        const result = await a.ask(input);
        assert.equal(result.ok, true); assert.equal(result.text, 'mapped reply');
        assert.deepEqual(received, { message: input.text, system: 'custom prompt' });
    } finally { await a.dispose(); await s.close(); }
});

test('GET templates URL-encode input and support plain text responses', async () => {
    const s = await server((req, res) => { assert.equal(new URL(req.url!, 'http://localhost').searchParams.get('q'), 'a&b ?你好'); res.end('plain'); });
    const a = adapter(`${s.url}/?q={{input.text}}`, { method: 'GET', response: { format: 'text', path: '' } });
    try { assert.equal((await a.ask({ ...input, text: 'a&b ?你好' })).text, 'plain'); }
    finally { await a.dispose(); await s.close(); }
});

test('invalid protocols, template variables, paths and oversized templates are rejected', () => {
    const good = { url: 'http://localhost/chat', response: { format: 'json', path: 'answer' } };
    for (const url of ['file:///tmp/test', 'http://user:password@localhost', 'http://{{input.text}}/chat']) assert.throws(() => parseHttpConnection({ ...good, url }));
    assert.throws(() => parseHttpConnection({ ...good, url: 'http://localhost/?q={{input.secret}}' }));
    assert.throws(() => parseHttpConnection({ ...good, response: { format: 'json', path: 'answer[0]' } }));
    assert.throws(() => validateRequestBody({ script: '{{process.env}}' }));
    assert.throws(() => validateRequestBody('a'.repeat(65537)));
});

test('missing credentials fail before network access; redirects are not followed', async () => {
    let calls = 0;
    const s = await server((_req, res) => { calls++; res.writeHead(302, { Location: '/other' }); res.end(); });
    const a = adapter(s.url, { headers: { Authorization: '{{env.MISSING}}' } });
    const b = adapter(s.url);
    try {
        assert.match((await a.ask(input)).error!, /MISSING/); assert.equal(calls, 0);
        assert.equal((await b.ask(input)).ok, false); assert.equal(calls, 1);
    } finally { await a.dispose(); await b.dispose(); await s.close(); }
});

test('timeout, wrong response fields, non-text replies and HTTP failures produce structured errors', async () => {
    const s = await server((req, res) => {
        if (req.url === '/timeout') return;
        if (req.url === '/error') { res.writeHead(500); res.end('private server details'); return; }
        res.end(JSON.stringify({ answer: req.url === '/object' ? { value: 'x' } : 'ok' }));
    });
    try {
        for (const [url, settings, pattern] of [
            ['/timeout', { timeoutMs: 100 }, /超时/], ['/error', {}, /HTTP 500/],
            ['/object', {}, /不是文本/], ['/missing', { response: { format: 'json', path: 'other' } }, /找不到字段/],
        ] as const) {
            const a = adapter(s.url + url, settings);
            try { assert.match((await a.ask(input)).error!, pattern); } finally { await a.dispose(); }
        }
    } finally { await s.close(); }
});
