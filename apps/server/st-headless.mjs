// st-headless.mjs — SillyTavern 后台常驻运行器
//
// 作用：用无头 Chrome 打开酒馆页面并保持运行，使 SnowLuma-Bridge 扩展
//      持续工作，即使你自己关掉了浏览器。
//
// 依赖：playwright-core（不下载浏览器，复用系统 Chrome）
// 认证：支持 HTTP Basic Auth（http://user:pass@host:port/）
//
// 用法：node st-headless.mjs
// 配置：headless.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CFG_PATH = path.join(__dirname, 'headless.json');

const DEFAULTS = {
    // 酒馆地址（不带凭据）
    stUrl: 'http://127.0.0.1:8000',
    // Basic Auth 凭据（config.yaml 的 basicAuthUser）
    basicAuth: { username: 'user', password: 'password' },
    // Chrome 可执行文件（留空自动探测）
    chromePath: '',
    // 无头模式：true=完全不可见；false=显示窗口（调试用，可看实时状态）
    headless: true,
    // 启动后等待页面就绪的时间（毫秒）
    startupWaitMs: 15000,
    // 崩溃/关闭后自动重启的间隔
    restartDelayMs: 10000,
    // 允许的最大重启次数（0 = 无限）
    maxRestarts: 0,
};

function loadConfig() {
    try {
        return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')) };
    } catch {
        return { ...DEFAULTS };
    }
}

const log = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);

/** 自动探测系统 Chrome */
function findChrome(configured) {
    if (configured && fs.existsSync(configured)) return configured;
    const candidates = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ];
    for (const c of candidates) {
        if (c && fs.existsSync(c)) return c;
    }
    return null;
}

/** 把 Basic Auth 凭据注入 URL（浏览器原生支持） */
function withAuth(url, { username, password }) {
    if (!username) return url;
    try {
        const u = new URL(url);
        u.username = encodeURIComponent(username);
        u.password = encodeURIComponent(password ?? '');
        return u.toString();
    } catch {
        return url;
    }
}

let browser = null;
let context = null;
let page = null;
let restarts = 0;
let shuttingDown = false;

async function launch(cfg) {
    const chrome = findChrome(cfg.chromePath);
    if (!chrome) {
        throw new Error('未找到 Chrome/Edge，可在 headless.json 里设置 chromePath');
    }
    log('使用浏览器:', chrome);
    log('无头模式:', cfg.headless ? '是（不可见）' : '否（可见窗口）');

    // 持久化 profile：localStorage（扩展启用状态/设置）、cookie 全部保留
    const profileDir = path.join(__dirname, '.st-profile');
    fs.mkdirSync(profileDir, { recursive: true });

    context = await chromium.launchPersistentContext(profileDir, {
        executablePath: chrome,
        headless: cfg.headless,
        viewport: { width: 1280, height: 900 },
        // 去掉自动化标记：部分前端会检测 navigator.webdriver 改变初始化行为
        ignoreDefaultArgs: ['--enable-automation'],
        args: [
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-background-timer-throttling',       // 关键：防止后台标签页定时器被节流
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-features=CalculateNativeWinOcclusion',
            '--autoplay-policy=no-user-gesture-required',
        ],
    });

    browser = context;   // 后续统一用 browser.close()
    page = context.pages()[0] ?? await context.newPage();

    // 页面日志 → 控制台（便于排查扩展问题）
    page.on('console', (msg) => {
        const text = msg.text();
        if (text.includes('SnowLuma-Bridge') || msg.type() === 'error') {
            log(`[PAGE ${msg.type()}] ${text.slice(0, 300)}`);
        }
    });
    page.on('pageerror', (err) => log('[PAGE ERROR]', err.message));
    page.on('crash', () => log('⚠ 页面崩溃'));
    page.on('close', () => log('⚠ 页面已关闭'));

    // 监听酒馆的网络请求失败（LLM 调用失败会在这里体现）
    page.on('requestfailed', (req) => {
        const u = req.url();
        if (u.includes('/api/') || u.includes('10108') || u.includes(':8000')) {
            log(`[REQ FAIL] ${req.method()} ${u.slice(0, 100)} — ${req.failure()?.errorText ?? ''}`);
        }
    });

    const target = withAuth(cfg.stUrl, cfg.basicAuth);
    log('打开:', cfg.stUrl, cfg.basicAuth.username ? '(带 Basic Auth)' : '');

    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Basic Auth 若走 URL 没生效，用 HTTP 头再兜底
    if (cfg.basicAuth.username) {
        const token = Buffer.from(
            `${cfg.basicAuth.username}:${cfg.basicAuth.password}`,
        ).toString('base64');
        await page.setExtraHTTPHeaders({ Authorization: `Basic ${token}` });
        // 重新加载以应用认证头
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    }

    log(`等待 ${cfg.startupWaitMs / 1000}s 让酒馆与扩展初始化…`);
    await new Promise((r) => setTimeout(r, cfg.startupWaitMs));

    const title = await page.title().catch(() => '');
    log('页面标题:', title || '(空)');

    // 探测扩展是否加载（酒馆把扩展挂到 window 上不一定有标记，改查 DOM）
    let hasExt = await page.evaluate(() => {
        return !!document.querySelector('#snowluma_bridge_status')
            || !!window.snowlumaDebug;
    }).catch(() => false);

    if (!hasExt) {
        // 可能页面还在加载扩展，再等一会儿并重试
        for (let i = 0; i < 6 && !hasExt; i++) {
            await new Promise((r) => setTimeout(r, 3000));
            hasExt = await page.evaluate(() => {
                return !!document.querySelector('#snowluma_bridge_status')
                    || !!window.snowlumaDebug;
            }).catch(() => false);
        }
    }

    log('扩展已加载:', hasExt ? '是 ✓' : '否');

    if (!hasExt) {
        log('尝试手动触发扩展加载…');
        const triggered = await page.evaluate(async () => {
            try {
                // ST 把扩展加载挂在全局（不同版本位置不同）
                const mod = window.__st_extensions__;
                if (mod?.activateExtensions) {
                    await mod.activateExtensions();
                    return 'called activateExtensions';
                }
                // 兜底：手动注入扩展脚本
                const script = document.createElement('script');
                script.type = 'module';
                script.src = '/scripts/extensions/third-party/SnowLuma-Bridge/index.js';
                document.head.appendChild(script);
                return 'injected script tag';
            } catch (e) {
                return 'failed: ' + e.message;
            }
        }).catch((e) => 'eval error: ' + e.message);
        log('手动触发结果:', triggered);

        await new Promise((r) => setTimeout(r, 4000));
        hasExt = await page.evaluate(() => !!window.snowlumaDebug
            || !!document.getElementById('snowluma_bridge_status')).catch(() => false);
        log('重试后扩展加载:', hasExt ? '是 ✓' : '仍然否');
    }

    // 深度诊断：扩展加载状态
    const diag = await page.evaluate(() => {
        const out = {};

        // 1. localStorage 里的扩展启用状态
        try {
            const st = JSON.parse(localStorage.getItem('SillyTavern_Settings') ?? '{}');
            out.disabledExtensions = st.extension_settings?.disabledExtensions ?? null;
            out.snowlumaSettings = st.extension_settings?.['SnowLuma-Bridge'] ?? null;
        } catch (e) { out.lsError = e.message; }

        // 2. 是否有我们的 DOM 元素
        out.hasStatusEl = !!document.getElementById('snowluma_bridge_status');
        out.hasDebugObj = !!window.snowlumaDebug;

        // 3. 扫描已加载的 script 标签（找 SnowLuma）
        out.snowlumaScripts = [...document.querySelectorAll('script[src]')]
            .map((s2) => s2.src)
            .filter((u) => u.toLowerCase().includes('snowluma'));

        // 4. 所有第三方扩展 script
        out.thirdPartyScripts = [...document.querySelectorAll('script[src]')]
            .map((s2) => s2.src)
            .filter((u) => u.includes('third-party'))
            .slice(0, 20);

        return out;
    }).catch((e) => ({ evalError: e.message }));

    log('===== 扩展诊断 =====');
    log('disabledExtensions:', JSON.stringify(diag.disabledExtensions));
    log('SnowLuma-Bridge 设置:', JSON.stringify(diag.snowlumaSettings));
    log('状态元素存在:', diag.hasStatusEl, '| snowlumaDebug:', diag.hasDebugObj);
    log('SnowLuma script 标签:', (diag.snowlumaScripts ?? []).length, '个');
    log('第三方扩展 script:', (diag.thirdPartyScripts ?? []).join(' | ') || '(无)');
    if (diag.evalError) log('诊断异常:', diag.evalError);

    if (hasExt) {
        // 定期心跳检查，确保页面一直活着
        setInterval(async () => {
            try {
                const state = await page.evaluate(() => {
                    if (!window.snowlumaDebug) return null;
                    return window.snowlumaDebug.state();
                });
                if (state) {
                    log(`[心跳] ws=${state.wsState} busy=${state.busy} 队列=${state.queueDepth}`);
                }
            } catch { /* 页面可能正在重载，忽略 */ }
        }, 60000);
    }

    log('✓ 后台运行中。你可以关闭自己的浏览器，桥接会继续工作。');
}

async function main() {
    const cfg = loadConfig();

    process.on('SIGINT', async () => {
        shuttingDown = true;
        log('收到退出信号，关闭浏览器…');
        try { await browser?.close(); } catch { /* 忽略 */ }
        process.exit(0);
    });

    const supervise = async () => {
        while (!shuttingDown) {
            try {
                await launch(cfg);
                // launch 里挂了常驻逻辑（setInterval），这里等待浏览器关闭
                await new Promise((resolve) => {
                    browser.on('disconnected', resolve);
                });
                if (shuttingDown) break;
                log('浏览器断开');
            } catch (e) {
                log('✗ 启动失败:', e.message);
            }

            if (shuttingDown) break;
            restarts++;
            if (cfg.maxRestarts > 0 && restarts > cfg.maxRestarts) {
                log(`已达最大重启次数 (${cfg.maxRestarts})，退出`);
                process.exit(1);
            }
            log(`${cfg.restartDelayMs / 1000}s 后重启（第 ${restarts} 次）…`);
            await new Promise((r) => setTimeout(r, cfg.restartDelayMs));
        }
    };

    await supervise();
}

main().catch((e) => {
    log('致命错误:', e.message);
    process.exit(1);
});
