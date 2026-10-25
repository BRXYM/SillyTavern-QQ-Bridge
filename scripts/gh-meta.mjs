#!/usr/bin/env node
/**
 * 用 git credential 取 token，调用 GitHub API。
 * 避免 PowerShell 的引号/管道问题导致超时。
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';

function getToken() {
    const out = execSync('git credential fill', {
        input: 'protocol=https\nhost=github.com\n\n',
        encoding: 'utf8',
    });
    const m = out.match(/^password=(.+)$/m);
    return m ? m[1].trim() : null;
}

const token = getToken();
if (!token) {
    console.error('NO_TOKEN');
    process.exit(1);
}

const REPO = 'BRXYM/SillyTavern-QQ-Bridge';
const action = process.argv[2] ?? 'status';

async function api(method, path, body) {
    const res = await fetch(`https://api.github.com${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'bridge-cli',
            'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json };
}

const DATA = JSON.parse(fs.readFileSync(new URL('./repo-meta.json', import.meta.url), 'utf8'));

if (action === 'status') {
    const { status, json } = await api('GET', `/repos/${REPO}`);
    if (status !== 200) {
        console.log(`GET /repos -> ${status}`, JSON.stringify(json).slice(0, 300));
        process.exit(1);
    }
    console.log(`full_name = ${json.full_name}`);
    console.log(`private   = ${json.private}`);
    console.log(`default   = ${json.default_branch}`);
    console.log(`desc      = ${json.description}`);
    console.log(`topics    = ${(json.topics ?? []).join(', ')}`);
    console.log(`stars     = ${json.stargazers_count}`);
    console.log(`url       = ${json.html_url}`);
}

if (action === 'public') {
    const { status, json } = await api('PATCH', `/repos/${REPO}`, { private: false });
    console.log(`PATCH private=false -> ${status}`);
    if (status === 200) {
        console.log(`private   = ${json.private}`);
        console.log(`url       = ${json.html_url}`);
    } else {
        console.log(JSON.stringify(json).slice(0, 400));
    }
}

if (action === 'meta') {
    const { status, json } = await api('PATCH', `/repos/${REPO}`, {
        description: DATA.description,
        private: false,
    });
    console.log(`PATCH desc+public -> ${status}`);
    if (status === 200) {
        console.log(`desc    = ${json.description}`);
        console.log(`private = ${json.private}`);
    } else {
        console.log(JSON.stringify(json).slice(0, 400));
    }
    const t = await api('PUT', `/repos/${REPO}/topics`, { names: DATA.topics });
    console.log(`PUT topics -> ${t.status}`);
    if (t.status === 200) console.log(`topics = ${(t.json.names ?? []).join(', ')}`);
    else console.log(JSON.stringify(t.json).slice(0, 300));
}
