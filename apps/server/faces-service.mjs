/**
 * 表情服务：同步 QQ 收藏表情、下载图片、后台批量打标。
 *
 * 关键约束（来自需求）：
 *   1. 打标必须在后台串行执行，不能阻塞桥接主线程
 *   2. 一次只处理一张，避免显存/内存峰值
 *   3. 打标进度可查询，前端轮询展示
 *   4. 模型调用走 Ollama HTTP API，便于后续换更好的模型
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { FaceStore, md5FromEmojiId } from './faces-store.mjs';
import { OllamaLabeler } from './faces-labeler.mjs';

/** 图片格式探测（用于决定缓存扩展名） */
function detectExt(buf) {
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
    if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
    if (buf[0] === 0x47 && buf[1] === 0x49) return 'gif';
    if (buf[0] === 0x52 && buf[1] === 0x49) return 'webp';
    return 'bin';
}

/**
 * 从上游响应里挖出表情数组。
 *
 * 不同实现/版本的返回形状不一样，这里统统兼容：
 *   [...]
 *   { data: [...] }
 *   { data: { list: [...] } }
 *   { data: { data: [...] } }
 *   { list: [...] }
 *
 * 返回 null 表示「拿到的响应根本不是列表」，便于上层区分
 * 「真的没有表情」和「返回格式看不懂」——后者必须报错，不能静默成 0。
 */
export function extractFaceArray(resp) {
    if (Array.isArray(resp)) return resp;
    if (!resp || typeof resp !== 'object') return null;

    const tryList = (v) => (Array.isArray(v) ? v : null);
    const keys = ['data', 'list', 'faces', 'items'];

    for (const k of keys) {
        const hit = tryList(resp[k]);
        if (hit) return hit;
    }
    // 再往下钻一层
    for (const k of keys) {
        const inner = resp[k];
        if (inner && typeof inner === 'object') {
            for (const k2 of keys) {
                const hit = tryList(inner[k2]);
                if (hit) return hit;
            }
        }
    }
    return null;
}

/** 把看不懂的响应压成一行日志，便于排查 */
function describeRaw(resp) {
    try {
        const s = JSON.stringify(resp);
        return s.length > 300 ? `${s.slice(0, 300)}…` : s;
    } catch {
        return String(resp);
    }
}

export class FaceService {
    /**
     * @param {object} opts
     * @param {string} opts.dataDir     表情库目录
     * @param {Function} opts.callOnebot 调用 OneBot action 的函数
     * @param {Function} opts.log        日志函数
     * @param {object} opts.ollama       Ollama 配置
     */
    constructor(opts) {
        this.store = new FaceStore(opts.dataDir);
        this.callOnebot = opts.callOnebot;
        this.log = opts.log ?? (() => {});
        this.labeler = new OllamaLabeler(opts.ollama ?? {});
        /** 表情库发生变化时的回调（用于刷新提示词清单） */
        this.onChanged = opts.onChanged ?? null;

        /** 打标任务状态 */
        this.job = {
            running: false,
            total: 0,
            done: 0,
            failed: 0,
            current: '',
            startedAt: null,
            finishedAt: null,
            lastError: '',
            /** 阶段：describe（看图）/ tags（收敛标签） */
            phase: '',
        };

        /** 同步状态 */
        this.syncState = {
            running: false,
            lastAt: null,
            lastResult: null,
            lastError: '',
        };

        this.#queue = [];
        this.#worker = null;
    }

    #queue = [];
    #worker = null;
    /** 图片下载去重：同一张图并发只下一次 */
    #downloadLocks = new Map();

    /** 通知外部：标签清单需要刷新 */
    #notifyChanged(reason) {
        if (!this.onChanged) return;
        try {
            this.onChanged(reason);
        } catch (e) {
            this.log(`表情库：变更通知失败 - ${e.message}`);
        }
    }

    // ---------------------------------------------------------------- 同步

    /**
     * 从 QQ 拉取收藏表情并写入库。
     * 同步后自动下载图片到本地缓存（避免依赖 QQ CDN）。
     */
    async syncFromQQ({ downloadImages = true } = {}) {
        if (this.syncState.running) {
            return { ok: false, error: '同步正在进行中' };
        }
        this.syncState.running = true;
        this.syncState.lastError = '';

        try {
            this.log('表情库：开始从 QQ 同步收藏表情…');

            // 注意：callOnebot 返回的是完整 OneBot 响应体
            //   { status: 'ok', retcode: 0, data: [...], echo: '...' }
            // 表情数组在 .data 里，不是返回值本身。
            const all = [];
            let raw = null;
            const seen = new Set();
            const maxPages = 20; // 上限 1000 条，足够

            for (let page = 0; page < maxPages; page++) {
                const resp = await this.callOnebot('fetch_custom_face_detail', {
                    count: 50,
                });
                if (page === 0) raw = resp;

                const batch = extractFaceArray(resp);
                if (!batch) {
                    // 拿不到数组时，把原始返回记进日志，避免"静默 0 条"
                    this.syncState.lastError = batch === null
                        ? `上游返回格式异常：${describeRaw(resp)}`
                        : '';
                    if (this.syncState.lastError) {
                        this.log(`表情库：${this.syncState.lastError}`);
                        return { ok: false, error: this.syncState.lastError };
                    }
                    break;
                }
                if (batch.length === 0) break;

                let newCount = 0;
                for (const it of batch) {
                    const md5 = it.md5 || md5FromEmojiId(it.emoji_id ?? it.emojiId ?? it.resId);
                    if (!md5) continue;
                    if (seen.has(md5)) continue;
                    seen.add(md5);
                    all.push({
                        md5,
                        emojiId: it.emoji_id ?? it.emojiId ?? it.resId ?? '',
                        url: it.url ?? '',
                        desc: it.desc ?? '',
                    });
                    newCount += 1;
                }

                // 这一页没有新数据，说明已经拉完（接口不支持分页时会一直重复第一页）
                if (newCount === 0) break;
                if (batch.length < 50) break;
            }

            if (all.length === 0) {
                this.syncState.lastResult = {
                    added: 0,
                    updated: 0,
                    total: this.store.data.faces.length,
                };
                this.syncState.lastAt = new Date().toISOString();
                this.log('表情库：QQ 中暂无收藏表情');
                return { ok: true, ...this.syncState.lastResult, downloaded: 0 };
            }

            const result = this.store.sync(all);
            this.log(
                `表情库：同步完成，新增 ${result.added}，更新 ${result.updated}，共 ${result.total} 个`,
            );

            let downloaded = 0;
            if (downloadImages) {
                downloaded = await this.#downloadMissing();
            }

            this.syncState.lastResult = { ...result, downloaded };
            this.syncState.lastAt = new Date().toISOString();
            this.#notifyChanged('sync');
            return { ok: true, ...result, downloaded };
        } catch (e) {
            this.syncState.lastError = e.message;
            this.log(`表情库：同步失败 - ${e.message}`);
            return { ok: false, error: e.message };
        } finally {
            this.syncState.running = false;
        }
    }

    /** 下载尚未缓存的图片 */
    async #downloadMissing() {
        let n = 0;
        for (const f of this.store.data.faces) {
            if (f.localFile && fs.existsSync(f.localFile)) continue;
            try {
                const ok = await this.#downloadOne(f);
                if (ok) n += 1;
            } catch (e) {
                this.log(`表情库：缓存图片失败 ${f.md5.slice(0, 8)} - ${e.message}`);
            }
        }
        return n;
    }

    /**
     * 把单张表情下载到本地缓存（供预览接口回源使用）。
     * @returns {Promise<boolean>}
     */
    async downloadToCache(face) {
        // 同一张图并发请求时只下载一次
        const key = face.md5;
        if (this.#downloadLocks.has(key)) return this.#downloadLocks.get(key);
        const task = this.#downloadOne(face)
            .then((r) => !!r?.ok)
            .catch((e) => {
                throw e;
            })
            .finally(() => this.#downloadLocks.delete(key));
        this.#downloadLocks.set(key, task);
        return task;
    }

    async #downloadOne(face) {
        const res = await fetch(face.url, { signal: AbortSignal.timeout(20000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0) throw new Error('空响应');

        // 校验 md5 是否与远端一致（QQ 的 md5 是内容摘要）
        const actual = crypto.createHash('md5').update(buf).digest('hex');
        const ext = detectExt(buf);
        const file = path.join(this.store.cacheDir, `${face.md5}.${ext}`);
        fs.writeFileSync(file, buf);
        this.store.setLocalFile(face.md5, file);

        return {
            ok: true,
            bytes: buf.length,
            ext,
            /** 与 QQ 记录的 md5 是否一致；不一致说明 CDN 返回了别的图 */
            md5Match: actual === face.md5,
        };
    }

    // ---------------------------------------------------------------- 打标

    /**
     * 启动后台打标。
     * @param {object} opts
     * @param {boolean} opts.all      true = 全部重新打标；false = 只处理未打标的
     * @param {number}  opts.limit    限制数量（0 = 不限）
     */
    startLabeling({ all = false, limit = 0 } = {}) {
        if (this.job.running) {
            return { ok: false, error: '打标任务已在运行中' };
        }

        const pending = this.store.pendingForLabel({ all, limit });
        if (pending.length === 0) {
            return { ok: false, error: all ? '库中没有表情' : '没有待打标的表情' };
        }

        this.job = {
            running: true,
            total: pending.length,
            done: 0,
            failed: 0,
            current: '',
            startedAt: new Date().toISOString(),
            finishedAt: null,
            lastError: '',
            phase: 'starting',
        };

        this.#queue = pending.slice();
        this.log(`表情库：开始打标 ${pending.length} 个（${all ? '全部重新识别' : '仅未打标'}）`);

        // 后台串行跑，不 await，避免阻塞调用方
        void this.#runWorker();

        return { ok: true, total: pending.length };
    }

    /** 后台 worker：串行处理，一次一张 */
    async #runWorker() {
        if (this.#worker) return;
        this.#worker = (async () => {
            try {
                // 先确认模型可用
                const ping = await this.labeler.ping();
                if (!ping.ok) {
                    throw new Error(
                        `Ollama 不可用（${ping.error}）。请先在「AI 模型」页启动服务或填写正确地址`,
                    );
                }
                const hasModel = await this.labeler.hasModel(this.labeler.visionModel);
                if (!hasModel) {
                    const local = (ping.models ?? []).join('、') || '（无）';
                    throw new Error(
                        `模型 ${this.labeler.visionModel} 未安装。本地已有：${local}。`
                        + '请到「AI 模型」页拉取，或在打标模型里改选已有模型',
                    );
                }

                while (this.#queue.length > 0) {
                    const item = this.#queue.shift();

                    this.job.current = item.md5.slice(0, 8);
                    this.job.phase = 'describe';

                    try {
                        // 优先用本地缓存，没有则先下载
                        let imgPath = item.localFile;
                        if (!imgPath || !fs.existsSync(imgPath)) {
                            const face = this.store.get(item.md5);
                            if (!face) throw new Error('记录不存在');
                            await this.#downloadOne(face);
                            imgPath = this.store.get(item.md5)?.localFile;
                        }
                        if (!imgPath || !fs.existsSync(imgPath)) {
                            throw new Error('图片不可用');
                        }

                        const r = await this.labeler.label(imgPath);

                        this.job.phase = 'tags';
                        this.store.setAiLabels(item.md5, {
                            caption: r.caption,
                            aiTags: r.tags,
                            model: r.model,
                        });

                        if (r.tagError) {
                            this.log(`表情库：标签阶段降级 ${item.md5.slice(0, 8)} - ${r.tagError}`);
                        }

                        this.job.done += 1;
                        this.log(
                            `表情库：${item.md5.slice(0, 8)} → ${r.tags.join('、') || '(无标签)'}`,
                        );
                    } catch (e) {
                        this.job.failed += 1;
                        this.job.lastError = e.message;
                        this.store.setLabelError(item.md5, e.message);
                        this.log(`表情库：打标失败 ${item.md5.slice(0, 8)} - ${e.message}`);
                    }
                }
            } catch (e) {
                // 整体失败（模型未就绪等）：终止任务并记录
                this.job.lastError = e.message;
                this.job.failed += this.#queue.length;
                this.job.phase = 'aborted';
                this.log(`表情库：打标任务中止 - ${e.message}`);
                this.#queue = [];
            } finally {
                this.job.running = false;
                this.job.current = '';
                this.job.finishedAt = new Date().toISOString();
                this.#worker = null;

                // 任务完成后卸载模型，释放显存给酒馆
                void this.labeler.unload();

                this.log(
                    `表情库：打标结束，成功 ${this.job.done}，失败 ${this.job.failed}`,
                );

                // 标签变化了，通知外部刷新提示词清单
                if (this.job.done > 0) this.#notifyChanged('label');
            }
        })();

        return this.#worker;
    }

    /** 打标进度 */
    progress() {
        return {
            ...this.job,
            queued: this.#queue.length,
            percent: this.job.total > 0 ? Math.round((this.job.done / this.job.total) * 100) : 0,
        };
    }

    /** 停止打标（当前这张跑完后停止） */
    stopLabeling() {
        const dropped = this.#queue.length;
        this.#queue = [];
        return { ok: true, dropped };
    }

    // ---------------------------------------------------------------- 查询

    list(opts) {
        return this.store.list(opts);
    }

    tagStats() {
        return this.store.tagStats();
    }

    stats() {
        return this.store.stats();
    }

    setUserTags(md5, tags) {
        const ok = this.store.setUserTags(md5, tags);
        if (ok) this.#notifyChanged('user-tags');
        return ok;
    }

    /** 按标签取一张（供 [表情:x] 解析） */
    pickByTag(tag) {
        return this.store.pickByTag(tag);
    }

    /**
     * 把表情图片另存到指定目录。
     *
     * 用途：用户想把表情导出到本地文件系统时使用。
     * 文件名用「标签_序号.扩展名」，便于在资源管理器里直接认出来；
     * 没有标签就退回 md5 前 8 位。
     */
    async saveToDir(md5s, dir) {
        const fsMod = fs;
        try {
            fsMod.mkdirSync(dir, { recursive: true });
        } catch (e) {
            return { ok: false, error: `无法创建目录：${e.message}` };
        }

        const saved = [];
        const failed = [];
        let seq = 0;

        for (const md5 of md5s) {
            const face = this.store.get(md5);
            if (!face) {
                failed.push({ md5, error: '表情不存在' });
                continue;
            }

            // 确保有本地缓存
            let src = face.localFile;
            if (!src || !fsMod.existsSync(src)) {
                try {
                    await this.downloadToCache(face);
                } catch (e) {
                    failed.push({ md5, error: `下载失败：${e.message}` });
                    continue;
                }
                src = this.store.get(md5)?.localFile;
            }
            if (!src || !fsMod.existsSync(src)) {
                failed.push({ md5, error: '缓存缺失' });
                continue;
            }

            const ext = path.extname(src) || '.jpg';
            const tags = [...(face.aiTags ?? []), ...(face.userTags ?? [])];
            const base = tags.length > 0
                ? `${tags.slice(0, 3).join('_')}_${String(++seq).padStart(3, '0')}`
                : md5.slice(0, 8);

            // 去掉文件名非法字符
            const safe = base.replace(/[\\/:*?"<>|]/g, '').slice(0, 60) || md5.slice(0, 8);
            let target = path.join(dir, `${safe}${ext}`);
            // 重名时加序号
            let n = 1;
            while (fsMod.existsSync(target)) {
                target = path.join(dir, `${safe}_${n}${ext}`);
                n += 1;
            }

            try {
                fsMod.copyFileSync(src, target);
                saved.push({ md5, file: target });
            } catch (e) {
                failed.push({ md5, error: e.message });
            }
        }

        if (saved.length > 0) {
            this.log(`表情库：已导出 ${saved.length} 个表情到 ${dir}`);
        }
        return {
            ok: saved.length > 0,
            dir,
            saved: saved.length,
            failed: failed.length,
            files: saved,
            errors: failed,
        };
    }

    /** Ollama 与环境自检 */
    async diagnostics() {
        const ping = await this.labeler.ping();
        const hasModel = ping.ok ? await this.labeler.hasModel(this.labeler.visionModel) : false;
        return {
            ollama: {
                baseUrl: this.labeler.baseUrl,
                reachable: ping.ok,
                error: ping.error ?? '',
                models: ping.models ?? [],
                visionModel: this.labeler.visionModel,
                textModel: this.labeler.textModel || this.labeler.visionModel,
                modelReady: hasModel,
            },
            store: this.store.stats(),
            job: this.progress(),
            sync: this.syncState,
            dataDir: this.store.dataDir,
        };
    }
}

export { detectExt };
