import { describe, it, expect } from 'vitest';
import { parseMessage, escapeCQ } from '../src/codec.js';

describe('parseMessage', () => {
    it('字符串消息', () => {
        expect(parseMessage('你好')).toEqual({ text: '你好', atMe: false });
    });

    it('消息段数组提取文本', () => {
        const msg = [
            { type: 'text', data: { text: '你好' } },
            { type: 'text', data: { text: '世界' } },
        ];
        expect(parseMessage(msg).text).toBe('你好世界');
    });

    it('检测 @机器人', () => {
        const msg = [
            { type: 'at', data: { qq: '10086' } },
            { type: 'text', data: { text: ' 你好' } },
        ];
        expect(parseMessage(msg, '10086')).toEqual({ text: '你好', atMe: true });
    });

    it('@其他人不算', () => {
        const msg = [
            { type: 'at', data: { qq: '999' } },
            { type: 'text', data: { text: '你好' } },
        ];
        expect(parseMessage(msg, '10086').atMe).toBe(false);
    });

    it('图片转占位符', () => {
        const msg = [{ type: 'image', data: { file: 'x.png' } }];
        expect(parseMessage(msg).text).toBe('[图片]');
    });

    it('表情转占位符', () => {
        const msg = [{ type: 'face', data: { id: '178' } }];
        expect(parseMessage(msg).text).toBe('[表情178]');
    });

    it('引用消息被忽略', () => {
        const msg = [
            { type: 'reply', data: { id: '123' } },
            { type: 'text', data: { text: '回复内容' } },
        ];
        expect(parseMessage(msg).text).toBe('回复内容');
    });
});

describe('escapeCQ', () => {
    it('转义特殊字符', () => {
        expect(escapeCQ('a&b[c]d,e')).toBe('a&amp;b&#91;c&#93;d&#44;e');
    });
});
