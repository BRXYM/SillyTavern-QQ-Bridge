import { randomUUID } from 'node:crypto';
import { applyReplyProcessors } from '@bridge/core';
import type { BridgeConfig, ProcessorRule } from '../config/schema.ts';
import { validateFlow, type MessageFlow } from '../config/flows.ts';
import { ConversationTurn, emptyState, type ConversationState } from './conversation-engine.ts';
import type { DownstreamResult } from '../downstream/types.ts';

export type StepStatus = 'pending' | 'running' | 'success' | 'skipped' | 'failed';
export interface FlowStep { id: 'upstream' | 'call' | 'downstream' | 'reply'; name: string; status: StepStatus; input?: string; output?: string; system?: string; error?: string; elapsedMs?: number }
export interface FlowRun {
    id: string; flowId: string; flowName: string; sessionKey: string; mode: 'live' | 'preview' | 'test';
    createdAt: string; status: 'running' | 'success' | 'failed' | 'filtered'; steps: FlowStep[]; elapsedMs: number;
    error?: string; variablesSaved: boolean; variables: Array<{ name: string; before: string; after: string }>; warnings: string[];
}
const clip = (value: string) => value.length > 4096 ? value.slice(0, 4096) + '\n…（记录已截断）' : value;
/** 只保留本次进程最近 50 次执行，不保存请求头或连接凭据。 */
export class FlowRunStore {
    private runs: FlowRun[] = [];
    begin(flow: MessageFlow, key: string, mode: FlowRun['mode']) {
        const run: FlowRun = { id: randomUUID(), flowId: flow.id, flowName: flow.name, sessionKey: key, mode, createdAt: new Date().toISOString(), status: 'running', elapsedMs: 0, variablesSaved: false, variables: [], warnings: [], steps: [
            { id: 'upstream', name: '上游处理', status: 'pending' }, { id: 'call', name: '调用下游', status: 'pending' },
            { id: 'downstream', name: '下游处理', status: 'pending' }, { id: 'reply', name: '回复 QQ', status: 'pending' },
        ] };
        this.runs.unshift(run); this.runs = this.runs.slice(0, 50); return run;
    }
    list(flowId?: string) { return structuredClone(this.runs.filter(r => !flowId || r.flowId === flowId)); }
}

export interface FlowExecution {
    flow: MessageFlow; config: BridgeConfig; store: FlowRunStore; sessionKey: string; mode: FlowRun['mode']; text: string;
    state?: ConversationState; legacySystem?: string; legacyRules?: ProcessorRule[];
    decorateInput?: (text: string) => string;
    ask: (text: string, system: string) => Promise<DownstreamResult>;
    commit?: (state: ConversationState) => void;
    deliver?: (text: string) => Promise<{ sent: number; failed: number }>;
}
/** 固定顺序执行，同一引擎用于真实消息、模拟和测试。 */
export async function executeFlow(options: FlowExecution) {
    const { flow, config } = options;
    const run = options.store.begin(flow, options.sessionKey, options.mode);
    const started = Date.now();
    let current = run.steps[0]!; let stepStarted = Date.now();
    let output = ''; let state: ConversationState | undefined;
    const begin = (index: number, input: string) => { current = run.steps[index]!; current.status = 'running'; current.input = clip(input); stepStarted = Date.now(); };
    const finish = (text: string, skipped = false) => { current.status = skipped ? 'skipped' : 'success'; current.output = clip(text); current.elapsedMs = Date.now() - stepStarted; };
    try {
        begin(0, options.text);
        if (!flow.enabled) throw new Error('流程已停用');
        validateFlow(flow, config);
        const profile = config.conversationProfiles.find(p => p.id === flow.conversationId);
        const legacy = flow.legacyPreserveBehavior === true;
        const selected = profile && !legacy && (flow.upstreamEnabled || flow.downstreamEnabled) ? structuredClone(profile) : undefined;
        if (selected && !flow.upstreamEnabled) Object.assign(selected, { inputPrefix: '', inputSuffix: '', systemPrompt: '', inputRules: [], upstreamExtracts: [], upstreamAssignments: [] });
        if (selected && !flow.downstreamEnabled) Object.assign(selected, { replyPrefix: '', replySuffix: '', replyRules: [], downstreamExtracts: [], downstreamAssignments: [] });
        const before = options.state ?? emptyState();
        const turn = selected ? new ConversationTurn(selected, before) : undefined;
        const prepared = turn?.upstream(options.text) ?? { input: options.text, system: legacy && flow.upstreamEnabled ? options.legacySystem ?? '' : '' };
        current.system = clip(prepared.system);
        finish(prepared.input, !flow.upstreamEnabled);
        if (!prepared.input.trim()) { run.status = 'filtered'; return { ok: true, output, state, run }; }
        const input = options.decorateInput?.(prepared.input) ?? prepared.input;
        begin(1, input); current.system = clip(prepared.system);
        const result = await options.ask(input, prepared.system);
        if (!result.ok) throw new Error(result.error || '下游调用失败');
        finish(result.text);
        begin(2, result.text);
        const processed = turn?.downstream(result.text);
        output = processed?.output ?? (legacy && flow.downstreamEnabled ? applyReplyProcessors(result.text, options.legacyRules ?? []) : result.text);
        if (processed) {
            state = processed.state; run.warnings = processed.warnings;
            run.variables = [...new Set([...Object.keys(before.vars), ...Object.keys(state.vars)])].filter(name => before.vars[name] !== state!.vars[name]).map(name => ({ name, before: clip(before.vars[name] ?? ''), after: clip(state!.vars[name] ?? '') }));
            if (options.commit) { options.commit(state); run.variablesSaved = true; }
        }
        finish(output, !flow.downstreamEnabled);
        begin(3, output);
        if (!output.trim()) { finish('消息处理后为空，未发送', true); run.status = 'filtered'; }
        else if (!options.deliver) { finish(options.mode === 'preview' ? '模拟预览，不发送 QQ' : '真实调用测试，不发送 QQ', true); run.status = 'success'; }
        else {
            const sent = await options.deliver(output);
            if (sent.failed) throw new Error(`QQ 投递部分或全部失败：已发 ${sent.sent} 段，失败 ${sent.failed} 段`);
            finish(`已发送 ${sent.sent} 段`, sent.sent === 0); run.status = sent.sent ? 'success' : 'filtered';
        }
        return { ok: true, output, state, run };
    } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        current.status = 'failed'; current.error = clip(error); current.elapsedMs = Date.now() - stepStarted;
        run.status = 'failed'; run.error = clip(error);
        return { ok: false, error, output, state, run };
    } finally {
        for (const step of run.steps) if (step.status === 'pending') { step.status = 'skipped'; step.output = '前序步骤未完成'; }
        run.elapsedMs = Date.now() - started;
    }
}
