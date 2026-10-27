#!/usr/bin/env node
/**
 * 一条命令启动 SnowLuma Bridge（前后端）。
 *
 *   pnpm dev              # 后端(:9510) + 前端(:5178)
 *   pnpm dev --web-only   # 只启动前端
 *   pnpm dev --api-only   # 只启动后端
 *
 * 可用环境变量覆盖：
 *   WEB_PORT            前端端口，默认 5178
 *   API_PORT            后端端口，默认 9510
 *   BRIDGE_OPEN         设为 1 时启动后自动打开浏览器
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const WEB_PORT = Number(process.env.WEB_PORT ?? 5178);
const API_PORT = Number(process.env.API_PORT ?? 9510);
/** 后端与前端同属一个 monorepo，无需外部路径 */
const SERVER_DIR = path.join(ROOT, 'apps', 'server');
const SERVER_ENTRY = path.join(SERVER_DIR, 'src', 'index.ts');
const WEB_DIR = path.join(ROOT, 'apps', 'web');
const VITE_BIN = path.join(WEB_DIR, 'node_modules', 'vite', 'bin', 'vite.js');

const flags = new Set(process.argv.slice(2));
const WEB_ONLY = flags.has('--web-only');
const API_ONLY = flags.has('--api-only');

// ---------------------------------------------------------------- 输出样式
const useColor = process.stdout.isTTY;
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = c('2');
const bold = c('1');
const red = c('31');
const green = c('32');
const yellow = c('33');
const blue = c('34');
const magenta = c('35');
const cyan = c('36');

const apiTag = magenta('[api]');
const webTag = cyan('[web]');
const sysTag = dim('[dev]');

function line(tag, text) {
    for (const l of String(text).split(/\r?\n/)) {
        if (l.trim() === '') continue;
        process.stdout.write(`${tag} ${l}\n`);
    }
}

function banner(title) {
    process.stdout.write(`\n${bold(title)}\n`);
}

// ---------------------------------------------------------------- 端口探测
function isPortOpen(port, host = '127.0.0.1', timeout = 700) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let done = false;
        const finish = (v) => {
            if (done) return;
            done = true;
            socket.destroy();
            resolve(v);
        };
        socket.setTimeout(timeout);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
        socket.connect(port, host);
    });
}

async function waitForPort(port, timeoutMs, signal) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (signal.stopped) return false;
        if (await isPortOpen(port)) return true;
        await new Promise((r) => setTimeout(r, 300));
    }
    return false;
}

// ---------------------------------------------------------------- 进程管理
const children = [];
let shuttingDown = false;
const state = { stopped: false };

function run(name, command, args, options) {
    const child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...(options.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });

    child.stdout.on('data', (d) => line(options.tag, d.toString()));
    child.stderr.on('data', (d) => line(options.tag, d.toString()));

    child.on('error', (err) => {
        line(options.tag, red(`启动失败：${err.message}`));
    });

    child.on('exit', (code, sig) => {
        if (shuttingDown) return;
        const reason = sig ? `signal ${sig}` : `code ${code}`;
        line(options.tag, red(`进程已退出（${reason}）`));
        if (!options.optional) {
            shutdown(1);
        }
    });

    children.push(child);
    return child;
}

function killTree(child) {
    if (!child || child.exitCode !== null) return;
    try {
        if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
                stdio: 'ignore',
                windowsHide: true,
            });
        } else {
            child.kill('SIGTERM');
        }
    } catch {
        /* ignore */
    }
}

function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    state.stopped = true;
    line(sysTag, dim('正在停止服务…'));
    for (const child of children) killTree(child);
    setTimeout(() => process.exit(code), 600);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('SIGHUP', () => shutdown(0));

// ---------------------------------------------------------------- 启动流程
async function startApi() {
    if (WEB_ONLY) return null;

    if (await isPortOpen(API_PORT)) {
        line(sysTag, dim(`后端 :${API_PORT} 已在运行，直接复用`));
        return null;
    }

    if (!fs.existsSync(SERVER_ENTRY)) {
        line(sysTag, red(`未找到后端入口：${SERVER_ENTRY}`));
        return null;
    }

    line(sysTag, `启动后端 ${dim(SERVER_ENTRY)}`);
    const child = run('api', process.execPath, [SERVER_ENTRY], {
        cwd: SERVER_DIR,
        tag: apiTag,
        env: {
            // 让后端使用与 dev.mjs 一致的端口，避免 config.json 里的旧值造成冲突
            API_PORT: String(API_PORT),
            EXT_PORT: String(Number(process.env.EXT_PORT ?? 9500)),
        },
    });

    const ok = await waitForPort(API_PORT, 20000, state);
    if (!ok) {
        line(sysTag, red(`后端在 20 秒内未监听 :${API_PORT}`));
        return child;
    }
    line(sysTag, green(`后端就绪 → http://127.0.0.1:${API_PORT}`));
    return child;
}

async function startWeb() {
    if (API_ONLY) return null;

    if (await isPortOpen(WEB_PORT)) {
        line(sysTag, red(`端口 ${WEB_PORT} 已被占用，无法启动前端`));
        line(sysTag, dim(`  排查：netstat -ano | findstr :${WEB_PORT}`));
        line(sysTag, dim(`  或换端口：WEB_PORT=5180 pnpm dev`));
        shutdown(1);
        return null;
    }

    if (!fs.existsSync(VITE_BIN)) {
        line(sysTag, red('未找到 vite，请先运行 pnpm install'));
        shutdown(1);
        return null;
    }

    line(sysTag, `启动前端 ${dim(WEB_DIR)}`);
    const child = run('web', process.execPath, [VITE_BIN], {
        cwd: WEB_DIR,
        tag: webTag,
        env: { FORCE_COLOR: '1' },
    });

    const ok = await waitForPort(WEB_PORT, 30000, state);
    if (!ok) {
        line(sysTag, red(`前端在 30 秒内未监听 :${WEB_PORT}`));
        return child;
    }

    printReady();
    if (process.env.BRIDGE_OPEN === '1') openBrowser();
    return child;
}

function printReady() {
    const url = `http://localhost:${WEB_PORT}`;
    process.stdout.write('\n');
    process.stdout.write(`  ${green('➜')}  ${bold('控制台')}   ${cyan(url)}\n`);
    if (!WEB_ONLY) {
        process.stdout.write(`  ${green('➜')}  ${bold('后端 API')}  ${dim(`http://127.0.0.1:${API_PORT}/api/status`)}\n`);
    }
    process.stdout.write(`  ${dim('按 Ctrl+C 停止全部服务')}\n\n`);
}

function openBrowser() {
    const url = `http://localhost:${WEB_PORT}`;
    try {
        const args =
            process.platform === 'win32'
                ? ['cmd', ['/c', 'start', '', url]]
                : process.platform === 'darwin'
                  ? ['open', [url]]
                  : ['xdg-open', [url]];
        spawn(args[0], args[1], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
    } catch {
        /* ignore */
    }
}

async function main() {
    banner('SillyTavern QQ Bridge');
    if (WEB_ONLY) line(sysTag, dim('模式：仅前端'));
    else if (API_ONLY) line(sysTag, dim('模式：仅后端'));
    else line(sysTag, dim('模式：前后端一体'));

    await startApi();
    await startWeb();
}

main().catch((err) => {
    line(sysTag, red(err?.stack ?? String(err)));
    shutdown(1);
});
