import { describe, it, expect } from 'vitest';
import { segmentText, convertActionMarkers, DEFAULT_SEGMENTATION } from '../src/segmentation.js';
import type { SegmentationConfig } from '@bridge/shared';

const cfg = (patch: Partial<SegmentationConfig> = {}): SegmentationConfig => ({
    ...DEFAULT_SEGMENTATION,
    ...patch,
});

describe('convertActionMarkers', () => {
    it('把半角星号动作转成中文括号', () => {
        expect(convertActionMarkers('*她笑了*')).toBe('（她笑了）');
    });

    it('支持全角星号', () => {
        expect(convertActionMarkers('＊她笑了＊')).toBe('（她笑了）');
    });

    it('不动未成对的星号', () => {
        expect(convertActionMarkers('*未闭合')).toBe('*未闭合');
    });

    it('可以关闭', () => {
        expect(convertActionMarkers('*她笑了*', false)).toBe('*她笑了*');
    });
});

describe('segmentText', () => {
    it('关闭时原样返回', () => {
        const r = segmentText('你好。世界。', cfg({ enabled: false }));
        expect(r).toEqual([{ text: '你好。世界。', delayMs: 0 }]);
    });

    it('空字符串返回空数组', () => {
        expect(segmentText('   ', cfg())).toEqual([]);
    });

    it('按句末标点切分', () => {
        const r = segmentText('你好呀！今天怎么样？我在图书馆。', cfg());
        expect(r.length).toBeGreaterThanOrEqual(2);
        expect(r[0]!.text).toContain('你好呀');
    });

    it('配对符内部句号不切分', () => {
        const text = '*她抬起头。眼睛里闪着光。* 你好。';
        const r = segmentText(text, cfg({ convertActionMarkers: false }));
        expect(r[0]!.text).toBe('*她抬起头。眼睛里闪着光。*');
    });

    it('配对符独立成段', () => {
        const text = '*动作一*台词一*动作二*台词二';
        const r = segmentText(text, cfg({ convertActionMarkers: false, maxSegments: 10 }));
        expect(r.length).toBeGreaterThanOrEqual(4);
    });

    it('引导语与台词合并', () => {
        const text = '她说：“今天真好啊。”';
        const r = segmentText(text, cfg({ convertActionMarkers: false }));
        expect(r[0]!.text).toContain('她说：');
        expect(r[0]!.text).toContain('今天真好啊');
    });

    it('自定义分隔串生效', () => {
        const r = segmentText('段一||段二||段三', cfg({ splitStrings: ['||'], maxSegments: 10 }));
        expect(r.length).toBe(3);
    });

    it('限制条数时不破坏配对块', () => {
        const text = '*a* *b* *c* *d* 句子一。句子二。句子三。';
        const r = segmentText(text, cfg({ maxSegments: 4, convertActionMarkers: false }));
        expect(r.length).toBeLessThanOrEqual(4);
        // 至少有一个配对块完整保留
        expect(r.some((s) => s.text.startsWith('*') && s.text.endsWith('*'))).toBe(true);
    });

    it('超长片段按软标点二次切分', () => {
        const long = '一'.repeat(80) + '，' + '二'.repeat(80);
        const r = segmentText(long, cfg({ maxLen: 100, maxSegments: 10 }));
        expect(r.length).toBeGreaterThan(1);
    });

    it('第一条延迟为 0，后续非负', () => {
        const r = segmentText('甲。乙。丙。', cfg({ delayMs: [100, 200] }));
        expect(r[0]!.delayMs).toBe(0);
        r.slice(1).forEach((s) => expect(s.delayMs).toBeGreaterThanOrEqual(100));
    });

    it('动作标记转换在分段后应用', () => {
        const r = segmentText('*她笑了*你好。', cfg({ convertActionMarkers: true }));
        expect(r[0]!.text.startsWith('（')).toBe(true);
    });

    it('中文双引号配对', () => {
        const text = '“你好。”她说道。';
        const r = segmentText(text, cfg({ convertActionMarkers: false }));
        expect(r.some((s) => s.text.includes('“你好。”'))).toBe(true);
    });

    it('括号动作配对', () => {
        const text = '（她笑了笑）你好呀。';
        const r = segmentText(text, cfg({ convertActionMarkers: false }));
        expect(r[0]!.text).toBe('（她笑了笑）');
    });
});
