import { describe, it, expect } from 'vitest';
import { parseConfig, safeParseConfig, segmentationSchema } from '../src/schemas.js';

describe('segmentationSchema', () => {
    it('空对象填充默认值', () => {
        const s = segmentationSchema.parse({});
        expect(s.maxLen).toBe(100);
        expect(s.maxSegments).toBe(8);
        expect(s.pairChars.length).toBe(4);
    });

    it('校验数值范围', () => {
        expect(() => segmentationSchema.parse({ maxLen: 5 })).toThrow();
        expect(() => segmentationSchema.parse({ maxSegments: 999 })).toThrow();
    });

    it('配对符必须是二元组', () => {
        expect(() => segmentationSchema.parse({ pairChars: [['only-one']] })).toThrow();
        expect(segmentationSchema.parse({ pairChars: [['动作', '*']] }).pairChars)
            .toEqual([['动作', '*']]);
    });
});

describe('parseConfig', () => {
    it('空对象得到完整默认配置', () => {
        const c = parseConfig({});
        expect(c.server.port).toBe(9510);
        expect(c.extension.wsPort).toBe(9500);
        expect(c.onebot.url).toBe('ws://127.0.0.1:3001');
        expect(c.trigger.atOnly).toBe(false);
        expect(c.segmentation.enabled).toBe(true);
    });

    it('非法配置抛错', () => {
        expect(() => parseConfig({ server: { port: 'abc' } })).toThrow();
    });
});

describe('safeParseConfig', () => {
    it('合法配置无错误', () => {
        const r = safeParseConfig({ server: { port: 8080 } });
        expect(r.errors).toEqual([]);
        expect(r.config.server.port).toBe(8080);
    });

    it('非法配置返回默认值 + 错误', () => {
        const r = safeParseConfig({ segmentation: { maxLen: 1 } });
        expect(r.errors.length).toBeGreaterThan(0);
        expect(r.errors[0]).toContain('segmentation');
        expect(r.config.segmentation.maxLen).toBe(100); // 默认
    });
});
