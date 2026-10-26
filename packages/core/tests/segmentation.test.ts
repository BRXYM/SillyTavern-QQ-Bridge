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
        // 用内容足够长的配对块（≥ pairMinLen），确保它们被独立保留
        const text =
            '*她轻轻抬起头看向窗外。*句子一。句子二。' +
            '*她叹了口气放下手中的书。*句子三。';
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

describe('pairMinLen（配对符忽略长度）', () => {
    it('单字引用不被拆成独立段', () => {
        const text = '你真"菜"。我可不这么认为。';
        const r = segmentText(text, cfg({ convertActionMarkers: false, pairMinLen: 3 }));
        // "菜" 内容仅 1 字 < 3，应与前后文粘在一起，而不是单独一条
        expect(r.some((s) => s.text.trim() === '"菜"')).toBe(false);
        expect(r.some((s) => s.text.includes('你真"菜"'))).toBe(true);
    });

    it('两字引用同样不独立成段', () => {
        const text = '他说"不行"。然后就走了。';
        const r = segmentText(text, cfg({ convertActionMarkers: false, pairMinLen: 3 }));
        expect(r.some((s) => s.text.trim() === '"不行"')).toBe(false);
    });

    it('达到阈值的配对符仍独立成段', () => {
        const text = '*她抬起头。*你好呀。';
        const r = segmentText(text, cfg({ convertActionMarkers: false, pairMinLen: 3 }));
        // 内容 "她抬起头。" 共 5 字 ≥ 3，保持独立
        expect(r.some((s) => s.text.includes('她抬起头'))).toBe(true);
    });

    it('pairMinLen=0 时关闭限制，单字也会独立成段', () => {
        const text = '你真"菜"。我可不这么认为。';
        const r = segmentText(text, cfg({ convertActionMarkers: false, pairMinLen: 0 }));
        expect(r.some((s) => s.text.trim() === '"菜"')).toBe(true);
    });

    it('星号单字动作不独立成段', () => {
        const text = '*笑* 你好呀。';
        const r = segmentText(text, cfg({ convertActionMarkers: false, pairMinLen: 3 }));
        expect(r.some((s) => s.text.trim() === '*笑*')).toBe(false);
    });

    it('中文引号单字同样受保护', () => {
        const text = '他喊了一声“滚”。现场安静了。';
        const r = segmentText(text, cfg({ convertActionMarkers: false, pairMinLen: 3 }));
        expect(r.some((s) => s.text.trim() === '“滚”')).toBe(false);
    });

    it('默认配置的 pairMinLen 为 3', () => {
        expect(DEFAULT_SEGMENTATION.pairMinLen).toBe(3);
    });
});

describe('maxSegments 超限时不得产生粘连', () => {
    /**
     * 回归测试：maxSegments 很小时，被挤出的配对片段若直接 join('')，
     * 相邻的 *动作* 会粘成 **，表现为 QQ 消息里出现重复的星号组合。
     */
    const text = [
        '*她抬头看了看钟楼，眉头微微皱起*',
        '这钟停了有些年头了。',
        '*她伸手摸了摸钟面的铁锈*',
        '镇上的人说是锈蚀。',
        '*她把手在围裙上擦了擦*',
        '可我觉得不对劲。',
        '*她压低声音，凑近了些*',
        '你听，里面还有声音。',
    ].join('\n\n');

    it('不出现 ** 连续星号', () => {
        const r = segmentText(text, cfg({ maxSegments: 4, convertActionMarkers: false }));
        for (const s of r) {
            expect(s.text).not.toContain('**');
        }
    });

    it('不出现两个动作片段紧贴（无分隔符）', () => {
        const r = segmentText(text, cfg({ maxSegments: 4, convertActionMarkers: false }));
        for (const s of r) {
            // 形如 …*动作a**动作b* 的紧贴形式
            expect(/\*[^*\n]*\*\*[^*\n]*\*/.test(s.text)).toBe(false);
        }
    });

    it('内容字符不丢失', () => {
        const r = segmentText(text, cfg({ maxSegments: 4, convertActionMarkers: false }));
        const strip = (s: string) => s.replace(/[\s*]/g, '');
        const before = strip(text);
        const after = strip(r.map((s) => s.text).join(''));
        expect(after).toBe(before);
    });

    it('maxSegments=12 时每个动作独立成段', () => {
        const r = segmentText(text, cfg({ maxSegments: 12, convertActionMarkers: false }));
        expect(r.length).toBeGreaterThanOrEqual(4);
        expect(r.some((s) => s.text.includes('她抬头看了看钟楼'))).toBe(true);
    });
});
