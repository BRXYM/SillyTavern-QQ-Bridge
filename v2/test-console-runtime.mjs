// 用 jsdom 真实执行控制台前端脚本，捕获运行时错误
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const html = fs.readFileSync('D:/WorkSpace/snowluma-st-bridge/_page.html', 'utf8');
console.log('HTML:', html.length, 'chars');

const errors = [];
const logs = [];

const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'http://127.0.0.1:9510/',
});

const w = dom.window;
w.console.error = (...a) => errors.push('ERROR: ' + a.map(String).join(' '));
w.console.warn = (...a) => logs.push('WARN: ' + a.map(String).join(' '));
w.console.log = (...a) => logs.push('LOG: ' + a.map(String).join(' '));

// 模拟 fetch
w.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/status')) {
        return {
            json: async () => ({
                onebotConnected: true,
                stClients: 1,
                selfId: '10086',
                sessions: { private_10001: { in: 5, out: 5, last: Date.now() } },
                sessionChoices: { private_10001: { character: '雪乃', world: '雪之镇设定' } },
                catalogs: {
                    characters: ['雪乃', '鲸鱼娘', 'Seraphina'],
                    worlds: ['雪之镇设定', '鲸鱼娘世界书'],
                    updatedAt: new Date().toISOString(),
                },
                logs: ['测试日志1', '测试日志2'],
                config: {
                    onebotUrl: 'ws://127.0.0.1:3001',
                    onebotToken: 'test',
                    stExtPort: 9500,
                    trigger: { atOnly: false, privateReply: true, allowedUsers: [], allowedGroups: [] },
                    maxMessageLength: 2000,
                    replyProcessors: [],
                    defaults: { character: '雪乃', world: '雪之镇设定' },
                    segmentation: {
                        enabled: true, maxLen: 100, minLen: 6, maxSegments: 8,
                        hardChars: '。！？!?…', softChars: '，,；;',
                        pairChars: [['动作', '*'], ['台词', '"'], ['中文台词', '“”']],
                        splitStrings: [], splitOnPairs: true, delayMs: [300, 900],
                    },
                    imageReplies: { enabled: true, instruction: true, baseUrl: '' },
                },
            }),
        };
    }
    return { json: async () => ({ ok: true }) };
};

// 提取并执行内联脚本（模拟浏览器）
const scripts = [...dom.window.document.querySelectorAll('script')].filter((s) => !s.src);
for (const sc of scripts) {
    try {
        w.eval(sc.textContent);
    } catch (e) {
        errors.push('SCRIPT THROW: ' + e.message);
    }
}

await new Promise((r) => setTimeout(r, 1200));

const doc = w.document;
const checks = {
    'segEnabled': doc.querySelector('#segEnabled')?.checked,
    'segMaxLen': doc.querySelector('#segMaxLen')?.value,
    'segMaxSeg': doc.querySelector('#segMaxSeg')?.value,
    'segHard': doc.querySelector('#segHard')?.value,
    'segSoft': doc.querySelector('#segSoft')?.value,
    '配对符行数': doc.querySelectorAll('#pairList .pair-item').length,
    '首个配对符预设': doc.querySelector('#pairList .p-preset')?.value,
    '会话卡片数': doc.querySelectorAll('#sessionChoices .rule').length,
    '日志长度': doc.querySelector('#log')?.textContent?.length ?? 0,
    'imgEnabled': doc.querySelector('#imgEnabled')?.checked,
};

console.log('\n=== 填充检查 ===');
for (const [k, v] of Object.entries(checks)) {
    const ok = v !== undefined && v !== null && v !== '' && v !== 0 && v !== false;
    console.log(`  ${ok ? '✓' : '✗'} ${k}: ${JSON.stringify(v)}`);
}

console.log('\n=== 运行时错误 ===');
if (errors.length === 0) {
    console.log('  无 ✓');
} else {
    errors.slice(0, 8).forEach((e) => console.log('  ' + e));
}

if (logs.length) {
    console.log('\n=== 控制台输出 ===');
    logs.slice(0, 10).forEach((l) => console.log('  ' + l));
}

w.close();
process.exit(errors.length ? 1 : 0);
