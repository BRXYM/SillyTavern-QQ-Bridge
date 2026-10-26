import { describe, it, expect } from 'vitest';
import { sessionKeyOf, chatNameOf, parseSessionKey } from '../src/session.js';
import { buildOutgoingPayload, findMediaMarks } from '../src/media.js';

describe('sessionKeyOf', () => {
    it('私聊', () => {
        expect(sessionKeyOf('private', null, 10001)).toBe('private_10001');
    });

    it('群聊带发送者', () => {
        expect(sessionKeyOf('group', 20001, 30001)).toBe('group_20001_30001');
    });
});

describe('chatNameOf', () => {
    it('私聊聊天名', () => {
        expect(chatNameOf('private_10001')).toBe('QQ_10001');
    });

    it('群聊聊天名', () => {
        expect(chatNameOf('group_20001_30001')).toBe('GROUP_20001_30001');
    });

    it('未知前缀兜底', () => {
        expect(chatNameOf('weird')).toBe('QQ_weird');
    });
});

describe('parseSessionKey', () => {
    it('解析私聊', () => {
        expect(parseSessionKey('private_123')).toEqual({
            messageType: 'private', groupId: null, userId: 123,
        });
    });

    it('解析群聊', () => {
        expect(parseSessionKey('group_456_789')).toEqual({
            messageType: 'group', groupId: 456, userId: 789,
        });
    });

    it('非法格式返回 null', () => {
        expect(parseSessionKey('nope')).toBeNull();
    });
});

describe('buildOutgoingPayload', () => {
    it('纯文本原样返回', () => {
        expect(buildOutgoingPayload('你好')).toBe('你好');
    });

    it('解析 [图片:url]', () => {
        const r = buildOutgoingPayload('看这个[图片:https://a.com/x.png]可爱吧');
        expect(Array.isArray(r)).toBe(true);
        if (Array.isArray(r)) {
            expect(r[0]).toEqual({ type: 'text', data: { text: '看这个' } });
            expect(r[1]).toEqual({ type: 'image', data: { file: 'https://a.com/x.png' } });
            expect(r[2]).toEqual({ type: 'text', data: { text: '可爱吧' } });
        }
    });

    it('解析 <img src>', () => {
        const r = buildOutgoingPayload('<img src="https://a.com/y.png">');
        expect(Array.isArray(r)).toBe(true);
        if (Array.isArray(r)) {
            expect(r[0]).toEqual({ type: 'image', data: { file: 'https://a.com/y.png' } });
        }
    });

    it('多张图片', () => {
        const r = buildOutgoingPayload('[图片:https://a.com/1.png][图片:https://a.com/2.png]');
        expect(Array.isArray(r)).toBe(true);
        if (Array.isArray(r)) expect(r.length).toBe(2);
    });

    it('支持 [表情:] 别名', () => {
        const r = buildOutgoingPayload('[表情:https://a.com/e.gif]');
        expect(Array.isArray(r)).toBe(true);
    });
});

describe('表情标签解析（[表情:标签]）', () => {
    it('识别为标签而非 URL', () => {
        const marks = findMediaMarks('哈哈[表情:开心]');
        expect(marks).toHaveLength(1);
        expect(marks[0]!.kind).toBe('tag');
        expect(marks[0]!.value).toBe('开心');
    });

    it('URL 仍识别为 url', () => {
        const marks = findMediaMarks('[图片:https://a.com/x.png]');
        expect(marks[0]!.kind).toBe('url');
    });

    it('标签会被解析成图片', () => {
        const r = buildOutgoingPayload('太好了[表情:开心]', () => 'https://cdn/x.jpg');
        expect(Array.isArray(r)).toBe(true);
        if (Array.isArray(r)) {
            expect(r).toEqual([
                { type: 'text', data: { text: '太好了' } },
                { type: 'image', data: { file: 'https://cdn/x.jpg' } },
            ]);
        }
    });

    it('标签解析失败时静默丢弃该标记', () => {
        const r = buildOutgoingPayload('太好了[表情:不存在]', () => null);
        expect(Array.isArray(r)).toBe(true);
        if (Array.isArray(r)) {
            // 只剩文本，标签被丢弃
            expect(r).toEqual([{ type: 'text', data: { text: '太好了' } }]);
        }
    });

    it('整段只有未命中的标签时返回空', () => {
        const r = buildOutgoingPayload('[表情:不存在]', () => null);
        expect(r).toBe('');
    });

    it('未提供解析器时丢弃标签而不是原样发送', () => {
        const r = buildOutgoingPayload('hi[表情:开心]');
        expect(Array.isArray(r)).toBe(true);
        if (Array.isArray(r)) {
            expect(r.some((s) => s.type === 'text' && s.data.text?.includes('表情'))).toBe(false);
        }
    });

    it('标签与 URL 混合时按顺序处理', () => {
        const r = buildOutgoingPayload(
            'A[表情:开心]B[图片:https://a.com/x.png]C',
            (tag) => (tag === '开心' ? 'https://cdn/ok.jpg' : null),
        );
        expect(Array.isArray(r)).toBe(true);
        if (Array.isArray(r)) {
            expect(r).toHaveLength(5);
            expect(r[1]).toEqual({ type: 'image', data: { file: 'https://cdn/ok.jpg' } });
            expect(r[3]).toEqual({ type: 'image', data: { file: 'https://a.com/x.png' } });
        }
    });
});
