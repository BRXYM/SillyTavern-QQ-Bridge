/**
 * 图片/表情标记解析。
 */

export interface OutgoingSegment {
    type: 'text' | 'image';
    data: { text?: string; file?: string };
}

const IMG_MARK = /\[(?:img|image|图片|表情)[:：]\s*([^\]\s]+)\s*\]/gi;
const IMG_HTML = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;

/**
 * 把文本里的图片标记转成 OneBot 消息段数组。
 * 没有图片标记时返回原字符串（纯文本更快）。
 */
export function buildOutgoingPayload(text: string): string | OutgoingSegment[] {
    const found: Array<{ index: number; url: string; len: number }> = [];

    let m: RegExpExecArray | null;
    IMG_MARK.lastIndex = 0;
    while ((m = IMG_MARK.exec(text)) !== null) {
        found.push({ index: m.index, url: m[1]!, len: m[0].length });
    }
    IMG_HTML.lastIndex = 0;
    while ((m = IMG_HTML.exec(text)) !== null) {
        found.push({ index: m.index, url: m[1]!, len: m[0].length });
    }

    if (found.length === 0) return text;

    found.sort((a, b) => a.index - b.index);

    const segs: OutgoingSegment[] = [];
    let cursor = 0;
    for (const f of found) {
        if (f.index > cursor) {
            const t = text.slice(cursor, f.index).trim();
            if (t) segs.push({ type: 'text', data: { text: t } });
        }
        segs.push({ type: 'image', data: { file: f.url } });
        cursor = f.index + f.len;
    }
    const tail = text.slice(cursor).trim();
    if (tail) segs.push({ type: 'text', data: { text: tail } });

    return segs;
}
