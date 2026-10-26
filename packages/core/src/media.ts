/**
 * 图片/表情标记解析。
 */

export interface OutgoingSegment {
    type: 'text' | 'image';
    data: { text?: string; file?: string };
}

const IMG_MARK = /\[(?:img|image|图片|表情)[:：]\s*([^\]\s]+)\s*\]/gi;
const IMG_HTML = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;

/** 作为值出现时，判定为「标签」而非 URL 的前缀 */
const URL_LIKE = /^(https?:|data:|file:|\/\/|\.\/|\/)/i;

/**
 * 是否为 URL（而不是标签名）。
 * `[表情:开心]` 里的「开心」是标签，`[图片:https://...]` 是直链。
 */
export function isUrlLike(value: string): boolean {
    return URL_LIKE.test(String(value ?? '').trim());
}

/**
 * 收集文本中的图片/表情标记。
 * 返回值区分 url 与 tag：
 *   - url：`[图片:https://...]`、`<img src>`
 *   - tag：`[表情:开心]`，需要外部按标签检索出真实 URL
 */
export interface MediaMark {
    index: number;
    len: number;
    /** 原始匹配文本 */
    raw: string;
    /** 解析出的值 */
    value: string;
    /** url = 直链；tag = 标签名 */
    kind: 'url' | 'tag';
}

export function findMediaMarks(text: string): MediaMark[] {
    const out: MediaMark[] = [];
    let m: RegExpExecArray | null;

    IMG_MARK.lastIndex = 0;
    while ((m = IMG_MARK.exec(text)) !== null) {
        const value = (m[1] ?? '').trim();
        if (!value) continue;
        out.push({
            index: m.index,
            len: m[0].length,
            raw: m[0],
            value,
            kind: isUrlLike(value) ? 'url' : 'tag',
        });
    }

    IMG_HTML.lastIndex = 0;
    while ((m = IMG_HTML.exec(text)) !== null) {
        const value = (m[1] ?? '').trim();
        if (!value) continue;
        out.push({
            index: m.index,
            len: m[0].length,
            raw: m[0],
            value,
            kind: 'url',
        });
    }

    out.sort((a, b) => a.index - b.index);
    return out;
}

/** 把标签解析为 URL 的回调 */
export type TagResolver = (tag: string) => string | null;

/**
 * 把文本里的图片标记转成 OneBot 消息段数组。
 * 没有图片标记时返回原字符串（纯文本更快）。
 *
 * @param text      回复正文
 * @param resolveTag 可选：把 `[表情:开心]` 这类标签解析成图片 URL。
 *                   未提供或解析失败时，该标记会被移除（避免把标签原文发给用户）。
 */
export function buildOutgoingPayload(
    text: string,
    resolveTag?: TagResolver,
): string | OutgoingSegment[] {
    const marks = findMediaMarks(text);
    if (marks.length === 0) return text;

    const segs: OutgoingSegment[] = [];
    let cursor = 0;

    for (const f of marks) {
        if (f.index > cursor) {
            const t = text.slice(cursor, f.index).trim();
            if (t) segs.push({ type: 'text', data: { text: t } });
        }

        let url: string | null = null;
        if (f.kind === 'url') {
            url = f.value;
        } else if (resolveTag) {
            url = resolveTag(f.value);
        }

        if (url) {
            segs.push({ type: 'image', data: { file: url } });
        }
        // 标签解析失败：静默丢弃该标记，不把 `[表情:开心]` 原样发出

        cursor = f.index + f.len;
    }

    const tail = text.slice(cursor).trim();
    if (tail) segs.push({ type: 'text', data: { text: tail } });

    return segs.length > 0 ? segs : '';
}
