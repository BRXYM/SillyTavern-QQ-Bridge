/**
 * 表情库接口。
 *
 * 这是「表情库」页的数据源：列表、标签统计、从 QQ 同步、打标、导出。
 *
 * 为什么单独一个文件：表情库有自己的一套状态（同步进度、打标进度、
 * Ollama 打标器），与下游/上游都无关，混在别的路由里会越写越乱。
 *
 * 注意 faces 服务可能为 null（初始化失败时），所有接口都要处理这种情形，
 * 而不是让上层抛 TypeError —— 界面会因此整页报错，比"表情库不可用"更难懂。
 */

import path from 'node:path';
import type { Router } from '../router.ts';
import { json } from '../router.ts';
import type { AppContext } from '../context.ts';
import { log } from '../../core/logger.ts';

export function registerFacesRoutes(router: Router, app: AppContext, opts: { dataDir: string }): void {
    /** 取表情库；未初始化时直接回错误，避免各处判空 */
    const svc = () => app.faces();

    const unavailable = (res: Parameters<typeof json>[0]): void => {
        json(res, 503, {
            ok: false,
            error: '表情库未初始化（启动时加载失败，见日志）',
        });
    };

    // GET /api/faces?tag=&keyword=&page=&pageSize=   列表
    router.get('/api/faces', ({ res, query }) => {
        const faces = svc();
        if (!faces) return unavailable(res);

        const r = faces.list({
            tag: query.get('tag') ?? '',
            keyword: query.get('keyword') ?? '',
            page: Number(query.get('page') ?? 1),
            pageSize: Number(query.get('pageSize') ?? 60),
        });
        json(res, 200, { ok: true, ...r, stats: faces.stats() });
    });

    // GET /api/faces/tags   标签统计 + 总量
    router.get('/api/faces/tags', ({ res }) => {
        const faces = svc();
        if (!faces) return unavailable(res);
        json(res, 200, { ok: true, tags: faces.tagStats(), stats: faces.stats() });
    });

    // GET /api/faces/diagnostics   自检（目录、Ollama、标注覆盖率）
    router.get('/api/faces/diagnostics', async ({ res }) => {
        const faces = svc();
        if (!faces) return unavailable(res);
        try {
            const d = await faces.diagnostics();
            json(res, 200, { ok: true, ...d });
        } catch (e) {
            json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
    });

    // GET /api/faces/progress   同步与打标进度
    router.get('/api/faces/progress', ({ res }) => {
        const faces = svc();
        if (!faces) return unavailable(res);
        // ok 放最后：progress() 自身也返回 ok，展开在上会把它盖掉
        json(res, 200, { ...faces.progress(), sync: faces.syncState, ok: true });
    });

    // POST /api/faces/sync   从 QQ 同步收藏表情
    router.post('/api/faces/sync', async ({ res }) => {
        const faces = svc();
        if (!faces) return unavailable(res);
        try {
            const r = await faces.syncFromQQ({ downloadImages: true });
            if (r.ok) log(`表情库已同步：新增 ${r.added ?? 0}，更新 ${r.updated ?? 0}`);
            json(res, r.ok ? 200 : 400, r);
        } catch (e) {
            json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
    });

    // POST /api/faces/label   启动后台打标
    router.post('/api/faces/label', ({ res, body }) => {
        const faces = svc();
        if (!faces) return unavailable(res);
        try {
            const r = faces.startLabeling({
                all: body.all === true,
                limit: Number(body.limit ?? 0),
            });
            if (r.ok) log('表情库：已启动打标');
            json(res, r.ok ? 200 : 400, r);
        } catch (e) {
            json(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
    });

    // POST /api/faces/label/stop   停止打标
    router.post('/api/faces/label/stop', ({ res }) => {
        const faces = svc();
        if (!faces) return unavailable(res);
        const r = faces.stopLabeling();
        log('表情库：已停止打标');
        json(res, 200, r);
    });

    // POST /api/faces/tags   修改某个表情的用户标签
    router.post('/api/faces/tags', ({ res, body }) => {
        const faces = svc();
        if (!faces) return unavailable(res);

        const md5 = String(body.md5 ?? '').trim();
        if (!md5) {
            json(res, 400, { ok: false, error: '缺少 md5' });
            return;
        }
        if (!Array.isArray(body.tags)) {
            json(res, 400, { ok: false, error: 'tags 必须是数组' });
            return;
        }

        const ok = faces.setUserTags(md5, body.tags.map((t) => String(t)));
        json(res, ok ? 200 : 404, { ok });
    });

    /**
     * POST /api/faces/save   把表情保存到本地
     * body: { md5 } 或 { md5s: [...] }，可选 dir 覆盖目标目录
     *
     * 默认目录刻意放在数据目录之外（exports/faces/<日期>）：
     * 这是"导出一份给人看"，不是缓存，混进缓存目录会被清理逻辑带走。
     */
    router.post('/api/faces/save', async ({ res, body }) => {
        const faces = svc();
        if (!faces) return unavailable(res);

        const md5s = Array.isArray(body.md5s)
            ? body.md5s.map((x) => String(x))
            : body.md5
                ? [String(body.md5)]
                : [];
        if (md5s.length === 0) {
            json(res, 400, { ok: false, error: '请提供 md5 或 md5s' });
            return;
        }

        const dir = body.dir
            ? path.resolve(String(body.dir))
            : path.resolve(
                opts.dataDir,
                '..',
                '..',
                'exports',
                'faces',
                new Date().toISOString().slice(0, 10),
            );

        try {
            const r = await faces.saveToDir(md5s, dir);
            if (r.ok) log(`表情库：已导出 ${md5s.length} 个到 ${dir}`);
            json(res, r.ok ? 200 : 400, r);
        } catch (e) {
            json(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
    });

    // GET /api/faces/resolve?tag=开心   按标签取一张（调试/预览用）
    router.get('/api/faces/resolve', ({ res, query }) => {
        const faces = svc();
        if (!faces) return unavailable(res);

        const tag = query.get('tag') ?? '';
        const hit = faces.store.pickByTag(tag);
        json(res, hit ? 200 : 404, hit
            ? { ok: true, face: hit }
            : { ok: false, error: '未找到匹配标签' });
    });
}
