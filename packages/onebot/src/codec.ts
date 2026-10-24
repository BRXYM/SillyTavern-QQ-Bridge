import type { ParsedMessage } from './types.js';

/** 从 OneBot 消息（字符串或消息段数组）提取纯文本与 @ 状态 */
export function parseMessage(
    message: string | Array<{ type: string; data: Record<string, unknown> }>,
    selfId: string | number = '',
): ParsedMessage {
    if (typeof message === 'string') {
        return { text: message.trim(), atMe: false };
    }

    let text = '';
    let atMe = false;
    for (const seg of message) {
        switch (seg.type) {
            case 'text':
                text += (seg.data['text'] as string) ?? '';
                break;
            case 'at':
                if (String(seg.data['qq']) === String(selfId)) atMe = true;
                break;
            case 'image':
                text += '[图片]';
                break;
            case 'face':
                text += `[表情${(seg.data['id'] as string) ?? ''}]`;
                break;
            case 'reply':
                // 引用消息，忽略内容
                break;
            default:
                break;
        }
    }
    return { text: text.trim(), atMe };
}

/** CQ 码转义（发送纯文本时使用 auto_escape=true，无需手动处理） */
export function escapeCQ(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/\[/g, '&#91;')
        .replace(/\]/g, '&#93;')
        .replace(/,/g, '&#44;');
}
