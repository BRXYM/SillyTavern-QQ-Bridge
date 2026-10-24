import type { SegmentationConfig } from '@bridge/shared';

/** 分段结果 */
export interface Segment {
    text: string;
    /** 与上一条之间的延迟（毫秒） */
    delayMs: number;
}

export const DEFAULT_SEGMENTATION: SegmentationConfig = {
    enabled: true,
    maxLen: 100,
    minLen: 6,
    maxSegments: 8,
    hardChars: '。！？!?…',
    softChars: '，,；;',
    pairChars: [
        ['动作', '*'],
        ['台词', '"'],
        ['中文台词', '“”'],
        ['括号动作', '（）'],
    ],
    splitStrings: [],
    splitOnPairs: true,
    convertActionMarkers: true,
    delayMs: [300, 900],
};

/** 配对符归一化为 [open, close] */
function normalizePairs(pairChars: SegmentationConfig['pairChars']): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const raw of pairChars) {
        const token = Array.isArray(raw) ? raw[1] : '';
        if (typeof token !== 'string' || token.length === 0) continue;
        out.push(token.length >= 2
            ? [token[0]!, token[1]!]
            : [token, token]);
    }
    return out;
}

/** 把 *动作* 转成 （动作） */
export function convertActionMarkers(text: string, enabled = true): string {
    if (!enabled) return text;
    let out = String(text ?? '');
    out = out.replace(/\*([^*\n]{1,200}?)\*/g, '（$1）');
    out = out.replace(/＊([^＊\n]{1,200}?)＊/g, '（$1）');
    return out;
}

/**
 * 按配置把长文本切成多条 QQ 消息。
 *
 * 分隔优先级：
 *   1. splitStrings 字面量
 *   2. pairChars 配对符（内部不切分，默认独立成段）
 *   3. hardChars 句末标点
 *   4. softChars 逗号（仅超长时二次切分）
 */
export function segmentText(
    text: string,
    cfg: SegmentationConfig = DEFAULT_SEGMENTATION,
    maxMessageLength = 2000,
): Segment[] {
    const {
        enabled,
        maxLen,
        minLen,
        maxSegments,
        hardChars,
        softChars,
        pairChars,
        splitStrings,
        splitOnPairs,
        convertActionMarkers: convertMarkers,
        delayMs,
    } = cfg;

    if (!enabled) return [{ text, delayMs: 0 }];
    const trimmed = (text ?? '').trim();
    if (!trimmed) return [];

    // ---- 步骤 1：配对符占位保护 ----
    const pairs = normalizePairs(pairChars);
    const pairSegments: string[] = [];
    let work = trimmed;

    for (const [open, close] of pairs) {
        const esc = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(
            `${esc(open)}[^${esc(open)}${esc(close)}]*?${esc(close)}`,
            'g',
        );
        work = work.replace(re, (m) => {
            const idx = pairSegments.length;
            pairSegments.push(m);
            return `\u0000P${idx}\u0000`;
        });
    }

    // ---- 步骤 2：自定义字面量分隔（产生硬边界） ----
    const fixedChunks: string[] = [];
    let chunks = [work];
    if (splitStrings.length > 0) {
        for (const sep of splitStrings) {
            if (!sep) continue;
            const next: string[] = [];
            for (const c of chunks) {
                const parts = c.split(sep);
                for (let i = 0; i < parts.length; i++) {
                    const piece = parts[i]! + (i < parts.length - 1 ? sep : '');
                    if (piece) next.push(piece);
                }
            }
            chunks = next;
        }
        fixedChunks.push(...chunks);
        chunks = [];
    }

    // ---- 步骤 3：硬标点切分 ----
    const hardSet = new Set([...hardChars, '\n']);
    const hardSplit: string[] = [];
    for (const chunk of chunks) {
        let buf = '';
        for (const ch of chunk) {
            buf += ch;
            if (hardSet.has(ch)) {
                hardSplit.push(buf);
                buf = '';
            }
        }
        if (buf.trim()) hardSplit.push(buf);
    }

    // ---- 步骤 4：还原配对符并拆分 ----
    interface Piece { text: string; isPair: boolean; isFixed: boolean }
    const pieces: Piece[] = [];

    const restore = (s: string) =>
        s.replace(/\u0000P(\d+)\u0000/g, (_, i) => pairSegments[Number(i)] ?? '');

    for (const fc of fixedChunks) {
        pieces.push({ text: restore(fc), isPair: false, isFixed: true });
    }

    const pairSet = new Set(pairSegments);
    for (const piece of hardSplit) {
        if (!splitOnPairs) {
            const t = restore(piece);
            pieces.push({ text: t, isPair: false, isFixed: false });
            continue;
        }
        const re = /\u0000P(\d+)\u0000/g;
        let last = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(piece)) !== null) {
            const before = piece.slice(last, m.index).trim();
            if (before) pieces.push({ text: before, isPair: false, isFixed: false });
            const pairText = pairSegments[Number(m[1])] ?? '';
            pieces.push({ text: pairText, isPair: true, isFixed: false });
            last = m.index + m[0].length;
        }
        const after = piece.slice(last).trim();
        if (after) pieces.push({ text: after, isPair: false, isFixed: false });
    }

    // ---- 步骤 5：超长片段按软标点二次切分 ----
    const expanded: Piece[] = [];
    for (const p of pieces) {
        if (p.text.length <= maxLen) {
            expanded.push(p);
            continue;
        }
        const softSet = new Set([...softChars]);
        const subs: string[] = [];
        let buf = '';
        for (const ch of p.text) {
            buf += ch;
            if (softSet.has(ch)) {
                subs.push(buf);
                buf = '';
            }
        }
        if (buf) subs.push(buf);

        let acc = '';
        for (const sub of subs) {
            if ((acc + sub).length > maxLen && acc) {
                expanded.push({ text: acc.trim(), isPair: false, isFixed: false });
                acc = sub;
            } else {
                acc += sub;
            }
        }
        if (acc.trim()) expanded.push({ text: acc.trim(), isPair: false, isFixed: false });
    }

    // ---- 步骤 6：合并过短片段（配对/固定片段不合并） ----
    const isLeadIn = (t: string) => /[:：]\s*$/.test(t) && t.length <= 20;

    const merged: string[] = [];
    let acc = '';
    for (const item of expanded) {
        if (item.isPair || item.isFixed) {
            if (acc) {
                if (item.isPair && isLeadIn(acc)) {
                    merged.push(acc + item.text);
                    acc = '';
                    continue;
                }
                merged.push(acc);
                acc = '';
            }
            merged.push(item.text);
            continue;
        }
        if (!acc) {
            acc = item.text;
        } else if (acc.length < minLen) {
            acc += item.text;
        } else {
            merged.push(acc);
            acc = item.text;
        }
    }
    if (acc) merged.push(acc);

    // ---- 步骤 7：限制条数（配对片段优先保留） ----
    let result = merged;
    if (result.length > maxSegments) {
        const isSpecial = (t: string) => {
            if (pairSet.has(t)) return true;
            const first = t[0] ?? '';
            const last = t[t.length - 1] ?? '';
            return pairs.some(([o, c]) => first === o && last === c);
        };

        const special: string[] = [];
        const plain: string[] = [];
        for (const t of result) (isSpecial(t) ? special : plain).push(t);

        const slots = Math.max(1, maxSegments - special.length);
        const packed = plain.slice();

        if (packed.length > slots) {
            const head = packed.slice(0, slots - 1);
            const tail = packed.slice(slots - 1).join('');
            packed.length = 0;
            packed.push(...head, tail);
        }

        let keepSpecial = special;
        if (special.length > maxSegments - packed.length) {
            const allow = Math.max(1, maxSegments - packed.length);
            keepSpecial = special.slice(0, allow);
            const dropped = special.slice(allow).join('');
            if (dropped) {
                if (packed.length) packed[packed.length - 1] += dropped;
                else packed.push(dropped);
            }
        }

        const out: string[] = [];
        let qi = 0;
        for (const t of result) {
            if (isSpecial(t)) {
                if (keepSpecial.includes(t)) out.push(t);
            } else if (qi < packed.length) {
                out.push(packed[qi++]!);
            }
        }
        while (qi < packed.length) out.push(packed[qi++]!);
        result = out.filter(Boolean);
    }

    // ---- 步骤 8：标记转换 + 长度兜底 + 延迟 ----
    if (convertMarkers) {
        result = result.map((t) => convertActionMarkers(t, true));
    }
    result = result.map((t) =>
        t.length > maxMessageLength ? t.slice(0, maxMessageLength) + '…' : t,
    );

    const [dMin, dMax] = delayMs;
    return result.map((t, i) => ({
        text: t,
        delayMs: i === 0 ? 0 : dMin + Math.floor(Math.random() * Math.max(1, dMax - dMin)),
    }));
}
