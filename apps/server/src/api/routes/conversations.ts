import type { Router } from '../router.ts';
import { json } from '../router.ts';
import type { AppContext } from '../context.ts';
import { parseConversation, resolveConversation } from '../../config/conversations.ts';
import { publishStatus } from '../events.ts';
import { applyReplyProcessors } from '@bridge/core';

export function registerConversationRoutes(router: Router, app: AppContext) {
    router.post('/api/conversations/preview', ({ res, body }) => {
        try {
            const p = parseConversation(body.profile);
            if (String(body.text ?? '').length > 32000 || String(body.reply ?? '').length > 32000) throw new Error('预览内容过长');
            json(res, 200, { input: p.inputPrefix + applyReplyProcessors(String(body.text ?? ''), p.inputRules) + p.inputSuffix, system: p.systemPrompt, output: applyReplyProcessors(String(body.reply ?? ''), p.replyRules) });
        } catch (e) { json(res, 400, { error: e instanceof Error ? e.message : String(e) }); }
    });
    router.get('/api/conversations', ({ res }) => {
        const cfg = app.config();
        const keys = new Set([...Object.keys(app.sessions.snapshot()), ...Object.keys(app.sessions.statsSnapshot())]);
        json(res, 200, { profiles: cfg.conversationProfiles, defaultId: cfg.defaultConversationId, bindings: Object.fromEntries([...keys].map(key => [key, { id: resolveConversation(cfg, app.sessions, key)?.id ?? '', inherited: app.sessions.get(key)?.conversationId === undefined }])) });
    });
    router.post('/api/conversations', ({ res, body }) => {
        try {
            const value = parseConversation(body);
            app.updateConfig(cfg => {
                const index = cfg.conversationProfiles.findIndex(p => p.id === value.id);
                const ref = cfg.conversationProfiles[index]?.legacyRef;
                if (index >= 0) cfg.conversationProfiles[index] = { ...value, legacyRef: ref ? { downstreamId: ref.downstreamId, profileId: ref.profileId } : undefined };
                else cfg.conversationProfiles.push(value);
            });
            publishStatus('config');
            json(res, 200, { ok: true });
        } catch (e) { json(res, 400, { error: e instanceof Error ? e.message : String(e) }); }
    });
    router.delete('/api/conversations/:id', ({ res, params }) => {
        const profile = app.config().conversationProfiles.find(p => p.id === params.id);
        if (!profile) return json(res, 404, { error: '会话配置不存在' });
        const affected = Object.keys(app.sessions.snapshot()).filter(key => {
            const legacy = app.sessions.resolve(key);
            return resolveConversation(app.config(), app.sessions, key)?.id === profile.id || (!!profile.legacyRef && legacy.backendId === profile.legacyRef.downstreamId && legacy.profileId === profile.legacyRef.profileId);
        });
        app.updateConfig(cfg => {
            cfg.conversationProfiles = cfg.conversationProfiles.filter(p => p.id !== profile.id);
            if (cfg.defaultConversationId === profile.id) cfg.defaultConversationId = '';
            if (profile.legacyRef) {
                const d = cfg.downstreams.find(d => d.id === profile.legacyRef!.downstreamId);
                if (d) d.profiles = d.profiles.filter(p => p.id !== profile.legacyRef!.profileId);
                if (cfg.defaultDownstreamId === profile.legacyRef.downstreamId && cfg.defaultDownstreamProfileId === profile.legacyRef.profileId) cfg.defaultDownstreamProfileId = '';
            }
        });
        for (const key of affected) {
            if (app.sessions.get(key)?.conversationId === profile.id) app.sessions.clearField(key, 'conversationId');
            if (profile.legacyRef) app.sessions.clearField(key, 'profileId');
        }
        publishStatus('config');
        json(res, 200, { ok: true, affectedSessions: affected.length });
    });
    router.post('/api/conversation-defaults', ({ res, body }) => {
        const backendId = String(body.backendId ?? '');
        const conversationId = String(body.conversationId ?? '');
        if (!app.config().downstreams.some(d => d.id === backendId)) return json(res, 400, { error: '下游连接不存在' });
        if (conversationId && !app.config().conversationProfiles.some(p => p.id === conversationId)) return json(res, 400, { error: '会话配置不存在' });
        app.updateConfig(cfg => { cfg.defaultDownstreamId = backendId; cfg.defaultConversationId = conversationId; cfg.defaultDownstreamProfileId = ''; });
        publishStatus('config');
        json(res, 200, { ok: true });
    });
}
