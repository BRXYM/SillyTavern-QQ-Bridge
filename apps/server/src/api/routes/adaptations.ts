import type { Router, RequestContext } from '../router.ts';
import { json } from '../router.ts';
import type { AppContext } from '../context.ts';
import { AdaptationError, AdaptationService } from '../../services/adaptation/service.ts';

export function registerAdaptationRoutes(router: Router, app: AppContext, dataDir: string) {
    const service = new AdaptationService({ config: app.config, updateConfig: app.updateConfig, downstreams: app.downstreams, dataDir });
    const handle = (handler: (ctx: RequestContext) => unknown | Promise<unknown>) => async (ctx: RequestContext) => {
        try {
            if (ctx.req.method === 'POST' && ctx.req.headers.origin) {
                let origin: URL;
                try { origin = new URL(ctx.req.headers.origin); } catch { throw new AdaptationError('请求来源无效', 403); }
                if (!['http:', 'https:'].includes(origin.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) throw new AdaptationError('适配操作只接受本机控制台来源', 403);
            }
            await handler(ctx);
        }
        catch (error) { json(ctx.res, error instanceof AdaptationError ? error.status : 400, { ok: false, error: error instanceof Error ? error.message : String(error) }); }
    };
    router.get('/api/adaptations', handle(({ res }) => json(res, 200, { ok: true, jobs: service.list() })));
    router.post('/api/adaptations', handle(({ res, body }) => json(res, 202, { ok: true, job: service.create(body) })));
    router.get('/api/adaptations/:id', handle(({ res, params }) => json(res, 200, { ok: true, job: service.get(params.id!) })));
    router.post('/api/adaptations/:id/test', handle(async ({ res, params, body }) => {
        const result = await service.test(params.id!, body.draft, String(body.text ?? '你好'));
        json(res, 200, result);
    }));
    router.post('/api/adaptations/:id/apply', handle(async ({ res, params, body }) => {
        json(res, 200, { ok: true, ...await service.apply(params.id!, body.draft) });
    }));
    return service;
}
