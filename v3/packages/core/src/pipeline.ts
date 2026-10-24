import type { ProcessorRule } from '@bridge/shared';

/**
 * 执行回复处理管道。
 * 规则按顺序执行，单条规则出错只跳过该条（不影响其他）。
 */
export function applyReplyProcessors(
    text: string,
    processors: ProcessorRule[] = [],
): string {
    let out = String(text ?? '');

    for (const rule of processors) {
        if (rule.enabled === false) continue;
        try {
            switch (rule.type) {
                case 'replace': {
                    if (!rule.pattern) break;
                    out = out.replace(new RegExp(rule.pattern, rule.flags ?? 'g'), rule.replacement ?? '');
                    break;
                }
                case 'remove': {
                    if (!rule.pattern) break;
                    out = out.replace(new RegExp(rule.pattern, rule.flags ?? 'g'), '');
                    break;
                }
                case 'strip': {
                    if (!rule.begin || !rule.end) break;
                    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const re = new RegExp(`${esc(rule.begin)}([\\s\\S]*?)${esc(rule.end)}`, 'g');
                    out = out.replace(re, rule.keep === true ? '$1' : '');
                    break;
                }
            }
        } catch {
            // 单条规则异常不影响整体
        }
    }

    return out.trim();
}

/**
 * 三层管道解析：
 *   会话级数组（含空数组） → 使用会话级
 *   其余（undefined/null）  → 回落全局
 */
export function resolveRules(
    globalRules: ProcessorRule[],
    sessionRules: ProcessorRule[] | undefined,
): { rules: ProcessorRule[]; source: 'session' | 'global' } {
    if (Array.isArray(sessionRules)) {
        return { rules: sessionRules, source: 'session' };
    }
    return { rules: globalRules, source: 'global' };
}
