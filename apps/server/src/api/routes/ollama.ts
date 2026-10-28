/**
 * Ollama 管理接口。
 *
 * 定位：只调用本机**已安装**的 Ollama，不负责安装。
 * 模型名由前端填写，因此服务端不做白名单校验。
 *
 * 这组接口有两件事必须做对，否则用户会得出错误结论：
 *   1. 「服务看不到磁盘上的模型」要和「真的没装模型」区分开 ——
 *      前者是模型目录没传对，后者是库是空的。混在一起会让人去重装。
 *   2. 打标器与这个页面共用同一份地址与模型名，改完要立刻同步过去，
 *      否则页面显示已切换，实际打标还在用旧模型。
 */

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import type { Router } from '../router.ts';
import { json } from '../router.ts';
import type { AppContext } from '../context.ts';
import { countModelsIn } from '../../../ollama-service.mjs';
import { log } from '../../core/logger.ts';

/** 拉取任务的进度（同一时刻只允许一个） */
export interface PullJob {
    running: boolean;
    model: string;
    status: string;
    percent: number;
    completed: number;
    total: number;
    startedAt: string | null;
    finishedAt: string | null;
    error: string;
}

/**
 * 拉取是长任务，状态必须活在路由之外 ——
 * 不能存在 handler 的闭包里，否则每次请求都是一份新状态，前端永远看到"没在拉"。
 */
const pullJob: PullJob = {
    running: false,
    model: '',
    status: '',
    percent: 0,
    completed: 0,
    total: 0,
    startedAt: null,
    finishedAt: null,
    error: '',
};

export function registerOllamaRoutes(router: Router, app: AppContext): void {
    /** 配置变更后让客户端、守护进程、打标器立即跟上 */
    function applyConfig(): void {
        const cfg = app.config();
        const baseUrl = String(cfg.faces.ollamaBaseUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
        const { client, daemon } = app.ollama;

        client.baseUrl = baseUrl;
        daemon.baseUrl = baseUrl;
        daemon.exePath = cfg.faces.ollamaExePath ?? '';
        daemon.modelsDir = cfg.faces.ollamaModelsDir ?? '';

        // 打标器与管理页共用同一套地址/模型，否则两边会各说各话
        app.faces()?.labeler?.reconfigure({
            baseUrl,
            visionModel: cfg.faces.ollamaVisionModel || 'qwen2.5vl:3b',
            textModel: cfg.faces.ollamaTextModel || '',
        });
    }

    /** 启动时同步一次，保证进程内状态与配置一致 */
    applyConfig();

    // -------- GET /api/ollama/status   服务状态 + 环境 --------
    router.get('/api/ollama/status', async ({ res }) => {
        const cfg = app.config();
        const { client, daemon } = app.ollama;

        const v = await client.version();
        const st = daemon.status();

        let running: unknown[] = [];
        let models: unknown[] = [];
        if (v.ok) {
            running = await client.running().catch(() => []);
            models = await client.list().catch(() => []);
        }

        // 磁盘上有模型、服务却看不到 → 几乎一定是模型目录没传对。
        // 这是最容易被误判成「未安装」的情况，必须明确告诉用户。
        const diskModelCount = countModelsIn(st.modelsDir);
        const envMismatch = v.ok && models.length === 0 && diskModelCount > 0;

        // version() 是判别联合：ok 时只有 version，失败时只有 error
        const version = v.ok ? v.version : '';
        const versionError = v.ok ? '' : v.error;

        json(res, 200, {
            ok: true,
            online: v.ok,
            version,
            error: versionError,
            baseUrl: client.baseUrl,
            visionModel: cfg.faces.ollamaVisionModel ?? '',
            textModel: cfg.faces.ollamaTextModel ?? '',
            daemon: st,
            running,
            /** 服务上报的模型数量 */
            modelCount: models.length,
            /** 磁盘上实际存在的模型数量 */
            diskModelCount,
            /** 服务看不到磁盘上的模型（模型目录未生效） */
            envMismatch,
            pull: { ...pullJob },
        });
    });

    // -------- GET /api/ollama/models   本地已下载模型 --------
    router.get('/api/ollama/models', async ({ res }) => {
        const { client } = app.ollama;
        try {
            const [models, running] = await Promise.all([client.list(), client.running()]);
            const runningMap = new Map(running.map((m) => [m.name, m]));
            json(res, 200, {
                ok: true,
                baseUrl: client.baseUrl,
                models: models.map((m) => ({
                    ...m,
                    loaded: runningMap.has(m.name),
                    running: runningMap.get(m.name) ?? null,
                })),
            });
        } catch (e) {
            json(res, 503, {
                ok: false,
                error: e instanceof Error ? e.message : String(e),
                models: [],
            });
        }
    });

    // -------- GET /api/ollama/models/:name/show   模型详情 --------
    router.get('/api/ollama/models/:name/show', async ({ res, params }) => {
        const name = params.name ?? '';
        try {
            json(res, 200, { ok: true, ...(await app.ollama.client.show(name)) });
        } catch (e) {
            json(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
    });

    // -------- POST /api/ollama/start   启动本地服务 --------
    router.post('/api/ollama/start', async ({ res }) => {
        const { client, daemon } = app.ollama;
        try {
            const r = await daemon.start(client);
            log(`Ollama：服务已就绪（${r.alreadyRunning ? '复用现有进程' : '由 Bridge 启动'}）`);
            json(res, 200, { ...r, daemon: daemon.status(), ok: true });
        } catch (e) {
            json(res, 400, {
                ok: false,
                error: e instanceof Error ? e.message : String(e),
                daemon: daemon.status(),
            });
        }
    });

    // -------- POST /api/ollama/stop   停止本地服务 --------
    router.post('/api/ollama/stop', async ({ res }) => {
        const { client, daemon } = app.ollama;
        try {
            const r = await daemon.stop(client);
            json(res, r.ok ? 200 : 400, { ...r, daemon: daemon.status() });
        } catch (e) {
            json(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
    });

    // -------- POST /api/ollama/repair   修正模型目录问题 --------
    router.post('/api/ollama/repair', async ({ res }) => {
        const { client, daemon } = app.ollama;
        try {
            const st = daemon.status();

            // 把探测到的模型目录写进配置，保证以后启动一定带上
            if (st.modelsDir && !app.config().faces.ollamaModelsDir) {
                app.updateConfig((c) => {
                    c.faces.ollamaModelsDir = st.modelsDir;
                });
                applyConfig();
                log(`Ollama：已把模型目录写入配置 ${st.modelsDir}`);
            }

            // 方案 A：能停掉现有进程 → 原地重启
            const stopped = await daemon.stop(client);
            if (stopped.ok) {
                const deadline = Date.now() + 15000;
                while (Date.now() < deadline) {
                    const v = await client.version();
                    if (!v.ok) break;
                    await new Promise((r) => setTimeout(r, 400));
                }
                const started = await daemon.start(client);
                const models = await client.list().catch(() => []);
                log(`Ollama：修复完成，现在可见 ${models.length} 个模型`);
                json(res, 200, {
                    ok: true,
                    mode: 'restart',
                    version: started.version,
                    modelCount: models.length,
                    modelsDir: daemon.status().modelsDir,
                });
                return;
            }

            // 方案 B：停不掉（权限/其他账户）→ 换个端口起一个带正确目录的实例
            const altPort = await findFreePort(11500, 11600);
            if (!altPort) {
                json(res, 409, {
                    ok: false,
                    needManual: true,
                    error: stopped.error,
                    hint: '请到任务管理器结束 ollama.exe，然后点「启动服务」',
                });
                return;
            }

            const altUrl = `http://127.0.0.1:${altPort}`;
            log(`Ollama：原进程无法停止，改在 ${altPort} 启动带正确模型目录的实例`);
            client.baseUrl = altUrl;
            daemon.baseUrl = altUrl;

            const started = await daemon.start(client);
            const models = await client.list().catch(() => []);
            if (models.length === 0) {
                // 新实例也看不到模型，说明配置本身有问题，别悄悄改地址
                const original = app.config().faces.ollamaBaseUrl || 'http://127.0.0.1:11434';
                client.baseUrl = original;
                daemon.baseUrl = original;
                await daemon.stop(client).catch(() => undefined);
                json(res, 400, {
                    ok: false,
                    error: '新实例仍然看不到模型，请检查「模型目录」填写是否正确',
                    modelsDir: app.config().faces.ollamaModelsDir,
                });
                return;
            }

            // 成功：把新地址固化下来，前端与打标器都用它
            app.updateConfig((c) => {
                c.faces.ollamaBaseUrl = altUrl;
            });
            applyConfig();
            log(`Ollama：修复完成，新地址 ${altUrl}，可见 ${models.length} 个模型`);
            json(res, 200, {
                ok: true,
                mode: 'alt-port',
                version: started.version,
                baseUrl: altUrl,
                modelCount: models.length,
                modelsDir: daemon.status().modelsDir,
                note: '原进程（无法停止）仍在运行，已忽略',
            });
        } catch (e) {
            json(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
    });

    // -------- POST /api/ollama/models/:name/load|unload|delete --------
    router.post('/api/ollama/models/:name/:action', async ({ res, params }) => {
        const name = params.name ?? '';
        const action = params.action ?? '';
        const { client } = app.ollama;
        try {
            if (action === 'load') {
                const keepAlive = '30m';
                log(`Ollama：加载模型 ${name}（keep_alive=${keepAlive}）`);
                await client.load(name, { keepAlive });
                json(res, 200, { ok: true, model: name, keepAlive });
                return;
            }
            if (action === 'unload') {
                await client.unload(name);
                log(`Ollama：已卸载模型 ${name}`);
                json(res, 200, { ok: true, model: name });
                return;
            }
            if (action === 'delete') {
                await client.remove(name);
                log(`Ollama：已删除模型 ${name}`);
                json(res, 200, { ok: true, model: name });
                return;
            }
            json(res, 404, { ok: false, error: `未知操作 ${action}` });
        } catch (e) {
            json(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
    });

    // -------- POST /api/ollama/pull   拉取模型（后台任务） --------
    router.post('/api/ollama/pull', ({ res, body }) => {
        const model = String(body.model ?? '').trim();
        if (!model) {
            json(res, 400, { ok: false, error: '请填写模型名，例如 qwen2.5vl:3b' });
            return;
        }
        if (pullJob.running) {
            json(res, 409, { ok: false, error: `已在拉取 ${pullJob.model}，请等待完成` });
            return;
        }

        Object.assign(pullJob, {
            running: true,
            model,
            status: '准备中…',
            percent: 0,
            completed: 0,
            total: 0,
            startedAt: new Date().toISOString(),
            finishedAt: null,
            error: '',
        });
        log(`Ollama：开始拉取模型 ${model}`);

        // 后台执行，立刻返回，前端轮询 /pull/progress
        void (async () => {
            try {
                await app.ollama.client.pull(model, (ev) => {
                    if (ev.status) pullJob.status = String(ev.status);
                    if (typeof ev.completed === 'number') pullJob.completed = ev.completed;
                    if (typeof ev.total === 'number') pullJob.total = ev.total;
                    if (pullJob.total > 0) {
                        pullJob.percent = Math.min(
                            100,
                            Math.floor((pullJob.completed / pullJob.total) * 100),
                        );
                    }
                });
                pullJob.percent = 100;
                pullJob.status = '完成';
                log(`Ollama：模型 ${model} 拉取完成`);
            } catch (e) {
                pullJob.error = e instanceof Error ? e.message : String(e);
                log(`Ollama：拉取 ${model} 失败 - ${pullJob.error}`);
            } finally {
                pullJob.running = false;
                pullJob.finishedAt = new Date().toISOString();
            }
        })();

        json(res, 200, { ok: true, model, pull: { ...pullJob } });
    });

    // -------- GET /api/ollama/pull/progress   拉取进度 --------
    router.get('/api/ollama/pull/progress', ({ res }) => {
        json(res, 200, { ok: true, ...pullJob });
    });

    // -------- POST /api/ollama/chat   文本对话（连通性测试） --------
    router.post('/api/ollama/chat', async ({ res, body }) => {
        const cfg = app.config();
        const model = String(body.model ?? cfg.faces.ollamaVisionModel ?? '').trim();
        const prompt = String(body.prompt ?? '你好，请用一句话介绍你自己。');
        if (!model) {
            json(res, 400, { ok: false, error: '请填写模型名' });
            return;
        }

        try {
            const t0 = Date.now();
            const content = await app.ollama.client.chat(model, prompt, {
                timeoutMs: Number(body.timeoutMs ?? 120000),
                ...(typeof body.keepAlive === 'string' ? { keepAlive: body.keepAlive } : {}),
                temperature: Number(body.temperature ?? 0.2),
                numPredict: Number(body.numPredict ?? 200),
            });
            json(res, 200, { ok: true, model, content, elapsedMs: Date.now() - t0 });
        } catch (e) {
            json(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
    });

    // -------- POST /api/ollama/vision   视觉对话（图片路径或 base64） --------
    router.post('/api/ollama/vision', async ({ res, body }) => {
        const cfg = app.config();
        const model = String(body.model ?? cfg.faces.ollamaVisionModel ?? '').trim();
        const prompt = String(body.prompt ?? '用一句话描述这张图。');
        if (!model) {
            json(res, 400, { ok: false, error: '请填写模型名' });
            return;
        }

        try {
            let images: string[] = [];
            if (Array.isArray(body.images) && body.images.length > 0) {
                images = body.images.map((s) => String(s).replace(/^data:[^,]+,/, ''));
            } else if (body.imagePath) {
                const abs = path.resolve(String(body.imagePath));
                if (!fs.existsSync(abs)) throw new Error(`图片不存在：${abs}`);
                images = [fs.readFileSync(abs).toString('base64')];
            }
            if (images.length === 0) throw new Error('请提供 imagePath 或 images（base64 数组）');

            const t0 = Date.now();
            const content = await app.ollama.client.vision(model, prompt, images, {
                timeoutMs: Number(body.timeoutMs ?? 180000),
                ...(typeof body.keepAlive === 'string' ? { keepAlive: body.keepAlive } : {}),
            });
            json(res, 200, { ok: true, model, content, elapsedMs: Date.now() - t0 });
        } catch (e) {
            json(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
    });

    // -------- POST /api/ollama/select   选择打标用模型 --------
    router.post('/api/ollama/select', ({ res, body }) => {
        app.updateConfig((c) => {
            if (body.visionModel !== undefined) {
                c.faces.ollamaVisionModel = String(body.visionModel).trim();
            }
            if (body.textModel !== undefined) {
                c.faces.ollamaTextModel = String(body.textModel).trim();
            }
            if (body.baseUrl !== undefined) {
                c.faces.ollamaBaseUrl = String(body.baseUrl).trim();
            }
            // 这两项是「保存服务配置」真正要落盘的东西
            if (body.exePath !== undefined) {
                c.faces.ollamaExePath = String(body.exePath).trim();
            }
            if (body.modelsDir !== undefined) {
                c.faces.ollamaModelsDir = String(body.modelsDir).trim();
            }
        });
        applyConfig();

        const cfg = app.config();
        log(
            `Ollama：打标模型已切换为 ${cfg.faces.ollamaVisionModel}`
            + (cfg.faces.ollamaTextModel ? ` / ${cfg.faces.ollamaTextModel}` : ''),
        );
        json(res, 200, {
            ok: true,
            visionModel: cfg.faces.ollamaVisionModel,
            textModel: cfg.faces.ollamaTextModel,
            baseUrl: cfg.faces.ollamaBaseUrl,
            exePath: cfg.faces.ollamaExePath,
            modelsDir: cfg.faces.ollamaModelsDir,
        });
    });
}

/** 找一个空闲端口（用于冲突时另起一个 Ollama 实例） */
async function findFreePort(from = 11500, to = 11600): Promise<number> {
    for (let port = from; port <= to; port += 1) {
        const free = await new Promise<boolean>((resolve) => {
            const srv = net.createServer();
            srv.once('error', () => resolve(false));
            srv.once('listening', () => srv.close(() => resolve(true)));
            srv.listen(port, '127.0.0.1');
        });
        if (free) return port;
    }
    return 0;
}
