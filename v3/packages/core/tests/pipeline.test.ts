import { describe, it, expect } from 'vitest';
import { applyReplyProcessors, resolveRules } from '../src/pipeline.js';
import type { ProcessorRule } from '@bridge/shared';

describe('applyReplyProcessors', () => {
    it('replace 替换', () => {
        const rules: ProcessorRule[] = [
            { type: 'replace', pattern: '\\[CQ:[^\\]]+\\]', flags: 'g', replacement: '' },
        ];
        expect(applyReplyProcessors('你好[CQ:face]世界', rules)).toBe('你好世界');
    });

    it('remove 删除', () => {
        const rules: ProcessorRule[] = [
            { type: 'remove', pattern: '\\*\\*', flags: 'g' },
        ];
        expect(applyReplyProcessors('a**b', rules)).toBe('ab');
    });

    it('strip 整段删除', () => {
        const rules: ProcessorRule[] = [
            { type: 'strip', begin: '（', end: '）', keep: false },
        ];
        expect(applyReplyProcessors('（动作）台词', rules)).toBe('台词');
    });

    it('strip keep 只删标记', () => {
        const rules: ProcessorRule[] = [
            { type: 'strip', begin: '（', end: '）', keep: true },
        ];
        expect(applyReplyProcessors('（动作）台词', rules)).toBe('动作台词');
    });

    it('禁用的规则不执行', () => {
        const rules: ProcessorRule[] = [
            { type: 'remove', pattern: 'a', flags: 'g', enabled: false },
        ];
        expect(applyReplyProcessors('abc', rules)).toBe('abc');
    });

    it('非法正则被跳过，不影响后续规则', () => {
        const rules: ProcessorRule[] = [
            { type: 'remove', pattern: '[', flags: 'g' },
            { type: 'remove', pattern: 'b', flags: 'g' },
        ];
        expect(applyReplyProcessors('abc', rules)).toBe('ac');
    });

    it('规则按顺序执行', () => {
        const rules: ProcessorRule[] = [
            { type: 'replace', pattern: 'a', flags: 'g', replacement: 'b' },
            { type: 'replace', pattern: 'b', flags: 'g', replacement: 'c' },
        ];
        expect(applyReplyProcessors('a', rules)).toBe('c');
    });

    it('结果去首尾空白', () => {
        expect(applyReplyProcessors('  文本  ', [])).toBe('文本');
    });
});

describe('resolveRules', () => {
    const global: ProcessorRule[] = [{ type: 'remove', pattern: 'x', flags: 'g' }];
    const session: ProcessorRule[] = [{ type: 'remove', pattern: 'y', flags: 'g' }];

    it('会话级数组优先', () => {
        const r = resolveRules(global, session);
        expect(r.source).toBe('session');
        expect(r.rules).toBe(session);
    });

    it('会话级空数组也是独立配置', () => {
        const r = resolveRules(global, []);
        expect(r.source).toBe('session');
        expect(r.rules).toEqual([]);
    });

    it('undefined 回落全局', () => {
        const r = resolveRules(global, undefined);
        expect(r.source).toBe('global');
        expect(r.rules).toBe(global);
    });
});
