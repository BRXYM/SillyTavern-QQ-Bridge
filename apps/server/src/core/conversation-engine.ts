import { applyReplyProcessors } from '@bridge/core';
import type { ConversationConfig } from '../config/conversations.ts';
import type { ProcessorRule } from '../config/schema.ts';
import type { ExtractionRule, VariableAssignment } from '../config/conversation-flow.ts';
import { record, safeName } from '../config/conversation-flow.ts';

export interface ConversationState {
    vars: Record<string, string>;
    previous: { upstream: Record<string, string>; downstream: Record<string, string> };
}
export const emptyState = (): ConversationState => ({ vars: {}, previous: { upstream: {}, downstream: {} } });
export function parseValues(raw: unknown): Record<string, string> {
    if (!record(raw) || Object.keys(raw).length > 32) throw new Error('每个会话最多保存 32 个变量或提取值');
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
        if (!safeName(key) || typeof value !== 'string' || value.length > 4000) throw new Error('变量名无效或值超过 4000 字');
        out[key] = value;
    }
    return out;
}
export function parseState(raw: unknown): ConversationState {
    if (!record(raw)) throw new Error('会话变量状态无效');
    const previous = record(raw.previous) ? raw.previous : {};
    return { vars: parseValues(raw.vars ?? {}), previous: { upstream: parseValues(previous.upstream ?? {}), downstream: parseValues(previous.downstream ?? {}) } };
}

/** 一轮调用的私有工作副本，失败时直接丢弃，只有下游成功后才提交。 */
export class ConversationTurn {
    readonly state: ConversationState;
    readonly extracted = { upstream: {} as Record<string, string>, downstream: {} as Record<string, string> };
    readonly warnings: string[] = [];
    private readonly message = { upstream: '', downstream: '' };
    private input = '';
    private system = '';
    private readonly config: ConversationConfig;
    constructor(config: ConversationConfig, state: ConversationState = emptyState()) {
        this.config = config;
        this.state = parseState(state);
        for (const variable of config.variables ?? []) if (!Object.hasOwn(this.state.vars, variable.name)) this.state.vars[variable.name] = variable.initialValue;
        parseValues(this.state.vars);
    }
    private warn(text: string) { if (this.warnings.length < 32 && !this.warnings.includes(text)) this.warnings.push(text); }
    render(template: string, replacement = false): string {
        const value = template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (literal, token: string) => {
            const parts = token.trim().split('.');
            if (!['message', 'current', 'previous', 'vars'].includes(parts[0]!)) return literal;
            let value: unknown = { message: this.message, current: this.extracted, previous: this.state.previous, vars: this.state.vars };
            for (const part of parts) {
                if (!record(value) || !Object.hasOwn(value, part)) { this.warn(`引用 ${token.trim()} 尚无数据，按空文本处理`); return ''; }
                value = value[part];
            }
            return typeof value === 'string' ? replacement ? value.replace(/\$/g, '$$$$') : value : '';
        });
        if (value.length > 128000) throw new Error('模板展开后的内容超过 128000 字');
        return value;
    }
    private extract(stage: 'upstream' | 'downstream', rules: ExtractionRule[]) {
        for (const rule of rules) {
            const source = this.render(rule.source);
            let value: unknown;
            try {
                if (rule.mode === 'regex') value = new RegExp(rule.expression, rule.flags).exec(source)?.[rule.group];
                else {
                    value = JSON.parse(source);
                    for (const key of rule.expression ? rule.expression.split('.') : []) {
                        if ((!record(value) && !Array.isArray(value)) || !Object.hasOwn(value, key)) { value = undefined; break; }
                        value = (value as Record<string, unknown>)[key];
                    }
                }
            } catch { this.warn(`提取 ${rule.name} 未获得有效数据`); }
            const text = value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
            if (text.length > 4000) throw new Error(`提取值 ${rule.name} 超过 4000 字`);
            if (value === undefined || value === null) this.warn(`提取 ${rule.name} 未匹配，值为空`);
            this.extracted[stage][rule.name] = text;
        }
    }
    private assign(assignments: VariableAssignment[]) {
        // 同一阶段的赋值同时生效，避免行顺序让结果难以预测。
        const values = Object.fromEntries(assignments.flatMap(a => { const value = this.render(a.value); return a.skipEmpty !== false && value === '' ? [] : [[a.name, value]]; }));
        this.state.vars = parseValues({ ...this.state.vars, ...values });
    }
    private process(text: string, rules: ProcessorRule[]): string {
        return applyReplyProcessors(text, rules.map(rule => rule.type === 'replace' ? { ...rule, replacement: this.render(rule.replacement ?? '', true) } : rule));
    }
    upstream(text: string) {
        if (text.length > 64000) throw new Error('上游消息超过 64000 字');
        this.message.upstream = text;
        this.extract('upstream', this.config.upstreamExtracts ?? []);
        this.assign(this.config.upstreamAssignments ?? []);
        this.input = this.render(this.config.inputPrefix) + this.process(text, this.config.inputRules) + this.render(this.config.inputSuffix);
        if (this.input.length > 128000) throw new Error('上游处理结果过长');
        this.system = this.render(this.config.systemPrompt);
        return { input: this.input, system: this.system };
    }
    downstream(text: string) {
        if (text.length > 64000) throw new Error('下游回复超过 64000 字');
        this.message.downstream = text;
        this.extract('downstream', this.config.downstreamExtracts ?? []);
        this.assign(this.config.downstreamAssignments ?? []);
        const output = this.render(this.config.replyPrefix ?? '') + this.process(text, this.config.replyRules) + this.render(this.config.replySuffix ?? '');
        if (output.length > 128000) throw new Error('下游处理结果过长');
        const state = parseState({ vars: this.state.vars, previous: this.extracted });
        return { input: this.input, system: this.system, output, extracted: structuredClone(this.extracted), state, warnings: [...this.warnings] };
    }
}
