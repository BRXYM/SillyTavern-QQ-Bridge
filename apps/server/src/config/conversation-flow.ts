export interface ExtractionRule {
    name: string;
    source: string;
    mode: 'regex' | 'json';
    expression: string;
    group: number;
    flags: string;
}
export interface VariableDefinition { name: string; initialValue: string }
export interface VariableAssignment { name: string; value: string; skipEmpty?: boolean }
export const safeName = (name: string) => /^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(name) && !['constructor', 'prototype', '__proto__'].includes(name);
export const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function validateTemplate(text: string, upstream: boolean): void {
    for (const match of text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
        const path = match[1]!.trim();
        if (/^(message|current|previous|vars)\./.test(path)) {
            if (!/^(message\.(upstream|downstream)|(current|previous)\.(upstream|downstream)\.[A-Za-z][A-Za-z0-9_]{0,47}|vars\.[A-Za-z][A-Za-z0-9_]{0,47})$/.test(path)) throw new Error(`无效的变量引用：${path}`);
            if (upstream && /^(message\.downstream|current\.downstream\.)/.test(path)) throw new Error(`上游处理时本轮下游回复尚未产生：${path}，请引用 previous.downstream 中的上一轮提取值`);
        }
    }
}
export function parseFlow(raw: Record<string, unknown>) {
    const list = (key: string): Record<string, unknown>[] => {
        const items = raw[key] ?? [];
        if (!Array.isArray(items) || items.length > 32 || items.some(v => !record(v))) throw new Error(`${key} 须为数组，最多 32 项`);
        const names = new Set<string>();
        for (const item of items) {
            if (typeof item.name !== 'string' || !safeName(item.name) || names.has(item.name)) throw new Error(`${key} 的名称须唯一，使用字母开头的英文、数字或下划线`);
            names.add(item.name);
        }
        return items;
    };
    const text = (value: unknown, label: string, max = 16000): string => {
        if (typeof value !== 'string' || value.length > max) throw new Error(`${label} 须为文本且不超过 ${max} 字`);
        return value;
    };
    const extracts = (key: string, upstream: boolean): ExtractionRule[] => list(key).map(item => {
        const source = text(item.source ?? (upstream ? '{{message.upstream}}' : '{{message.downstream}}'), '提取来源');
        validateTemplate(source, upstream);
        const expression = text(item.expression, '提取表达式', 2000);
        const mode = item.mode;
        if (mode !== 'regex' && mode !== 'json') throw new Error('提取方式只支持正则或 JSON 路径');
        const group = item.group ?? 1;
        const flags = text(item.flags ?? '', '正则标记', 8);
        if (!Number.isInteger(group) || Number(group) < 0 || Number(group) > 32) throw new Error('捕获组须为 0–32 的整数，0 表示整个匹配');
        if (mode === 'regex') {
            if (!expression || !/^[gimsu]*$/.test(flags)) throw new Error('正则表达式或标记无效');
            new RegExp(expression, flags);
        } else if (expression && (!/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/.test(expression) || expression.split('.').some(k => ['__proto__', 'constructor', 'prototype'].includes(k)))) throw new Error('JSON 路径须为 data.name 或 items.0.name 的形式');
        return { name: item.name as string, source, mode, expression, group: Number(group), flags };
    });
    const assignments = (key: string, upstream: boolean): VariableAssignment[] => list(key).map(item => {
        const value = text(item.value, '变量赋值'); validateTemplate(value, upstream);
        if (item.skipEmpty !== undefined && typeof item.skipEmpty !== 'boolean') throw new Error('空值保留开关须为布尔值');
        return { name: item.name as string, value, skipEmpty: item.skipEmpty !== false };
    });
    for (const key of ['inputPrefix', 'inputSuffix', 'systemPrompt']) validateTemplate(text(raw[key] ?? '', key), true);
    for (const key of ['replyPrefix', 'replySuffix']) validateTemplate(text(raw[key] ?? '', key), false);
    for (const [key, upstream] of [['inputRules', true], ['replyRules', false]] as const) {
        for (const rule of (raw[key] ?? []) as Array<{ replacement?: string }>) if (rule.replacement) validateTemplate(rule.replacement, upstream);
    }
    return {
        replyPrefix: text(raw.replyPrefix ?? '', '回复前追加'), replySuffix: text(raw.replySuffix ?? '', '回复后追加'),
        variables: list('variables').map(item => ({ name: item.name as string, initialValue: text(item.initialValue ?? '', '初始值', 4000) })),
        upstreamExtracts: extracts('upstreamExtracts', true), downstreamExtracts: extracts('downstreamExtracts', false),
        upstreamAssignments: assignments('upstreamAssignments', true), downstreamAssignments: assignments('downstreamAssignments', false),
    };
}
