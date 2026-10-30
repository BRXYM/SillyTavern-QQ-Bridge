/**
 * 表情库存储：QQ 收藏表情 + 本地图片 + 标签。
 *
 * 设计要点：
 *   - 存储格式：单个 index.json（几十到几百条量级，够用；避免引入 SQLite）
 *   - 图片缓存：data/faces/cache/<md5>.<ext>，避免依赖 QQ CDN 可用性
 *   - 标签分离：aiTags 与 userTags 两个数组，互不覆盖
 *       · aiTags   AI 生成，重新识别时整体替换
 *       · userTags 用户手工添加，永不自动删除
 *   - 幂等同步：以 md5 为唯一键，重复同步不会产生重复项
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 标签词表：AI 打标时受此约束，保证标签可检索 */
export const TAG_VOCAB = {
    情绪: [
        '开心', '大笑', '微笑', '无语', '生气', '难过', '委屈', '害羞',
        '疑惑', '震惊', '得意', '嫌弃', '期待', '疲惫',
        // 以下为实测补充：3B 模型常能识别出「害怕/崩溃」这类强情绪，
        // 但旧词表里没有，只能硬塞进「震惊」，导致标签失真。
        '害怕', '崩溃', '无奈', '尴尬', '嘲讽',
    ],
    动作: ['点赞', '摇头', '点头', '鼓掌', '挥手', '鞠躬', '擦汗', '流泪', '捂脸', '比心', '拥抱', '推门'],
    主体: ['猫', '狗', '人', '卡通', '动物', '动画角色', '表情包', '梗图'],
    风格: ['搞怪', '可爱', '沙雕', '正经', '复古', '像素'],
};

/** 扁平词表（供模型选择） */
export function flatVocab() {
    const out = [];
    for (const [group, words] of Object.entries(TAG_VOCAB)) {
        for (const w of words) out.push(w);
    }
    return out;
}

const MAX_LABEL_LEN = 24;

function isDir(p) {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

function readJson(file, fallback = null) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return fallback;
    }
}

function writeJsonAtomic(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
}

/** 从 emojiId 里提取 md5（SnowLuma 的 emojiId 形如 <uin>_0_0_0_<MD5>_0_0） */
export function md5FromEmojiId(emojiId) {
    const parts = String(emojiId).split('_');
    const hex = parts[4] ?? '';
    return hex.toLowerCase();
}

function normalizeTag(raw) {
    const t = String(raw ?? '').trim().replace(/\s+/g, '');
    if (!t) return '';
    return t.slice(0, MAX_LABEL_LEN);
}

function uniqueTags(list) {
    const seen = new Set();
    const out = [];
    for (const raw of list ?? []) {
        const t = normalizeTag(raw);
        if (!t) continue;
        const key = t.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(t);
    }
    return out;
}

export class FaceStore {
    /**
     * @param {string} dataDir 存放 index.json 与 cache/ 的目录
     */
    constructor(dataDir) {
        this.dataDir = path.resolve(dataDir);
        this.cacheDir = path.join(this.dataDir, 'cache');
        this.indexPath = path.join(this.dataDir, 'index.json');
        fs.mkdirSync(this.cacheDir, { recursive: true });
        this.data = this.#load();
    }

    #load() {
        const raw = readJson(this.indexPath, null);
        if (raw && Array.isArray(raw.faces)) {
            return {
                version: raw.version ?? 1,
                updatedAt: raw.updatedAt ?? new Date().toISOString(),
                faces: raw.faces.map((f) => this.#normalizeFace(f)),
            };
        }
        return { version: 1, updatedAt: new Date().toISOString(), faces: [] };
    }

    #normalizeFace(f) {
        return {
            md5: String(f.md5 ?? ''),
            emojiId: String(f.emojiId ?? ''),
            url: String(f.url ?? ''),
            localFile: f.localFile ?? '',
            /** AI 生成的原始描述（自由文本，便于回溯） */
            caption: f.caption ?? '',
            /** AI 生成的标签：重新识别时整体替换 */
            aiTags: uniqueTags(f.aiTags),
            /** 用户自定义标签：永不自动删除 */
            userTags: uniqueTags(f.userTags),
            source: f.source ?? 'qq-collected',
            labeledAt: f.labeledAt ?? null,
            labelModel: f.labelModel ?? '',
            labelError: f.labelError ?? '',
            createdAt: f.createdAt ?? new Date().toISOString(),
            updatedAt: f.updatedAt ?? new Date().toISOString(),
        };
    }

    save() {
        this.data.updatedAt = new Date().toISOString();
        writeJsonAtomic(this.indexPath, this.data);
    }

    list({ tag = '', keyword = '', page = 1, pageSize = 60 } = {}) {
        let items = this.data.faces.slice();

        if (tag) {
            const t = tag.toLowerCase();
            items = items.filter(
                (f) =>
                    f.aiTags.some((x) => x.toLowerCase() === t) ||
                    f.userTags.some((x) => x.toLowerCase() === t),
            );
        }

        if (keyword) {
            const k = keyword.toLowerCase();
            items = items.filter(
                (f) =>
                    f.caption.toLowerCase().includes(k) ||
                    f.aiTags.some((x) => x.toLowerCase().includes(k)) ||
                    f.userTags.some((x) => x.toLowerCase().includes(k)),
            );
        }

        // 新加入的排在前面
        items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

        const total = items.length;
        const start = Math.max(0, (page - 1) * pageSize);
        const slice = items.slice(start, start + pageSize);

        return {
            total,
            page,
            pageSize,
            items: slice.map((f) => this.toDto(f)),
        };
    }

    /** 输出给前端的结构：附带合并后的标签与本地图片地址 */
    toDto(f) {
        const allTags = uniqueTags([...f.aiTags, ...f.userTags]);
        return {
            ...f,
            tags: allTags,
            /** 有本地缓存时优先用本地路径 */
            imageUrl: f.localFile ? `/faces/cache/${path.basename(f.localFile)}` : f.url,
        };
    }

    get(md5) {
        return this.data.faces.find((f) => f.md5 === md5) ?? null;
    }

    /**
     * 同步：把远端表情列表合并进来。
     * - 新增：加入库
     * - 已存在：更新 emojiId / url（QQ 侧可能变），保留标签
     * - 远端已删除：标记 removed 但不删除记录（保留用户的标签）
     */
    sync(remoteFaces) {
        const now = new Date().toISOString();
        const byMd5 = new Map(this.data.faces.map((f) => [f.md5, f]));
        let added = 0;
        let updated = 0;

        for (const r of remoteFaces) {
            const md5 = r.md5 || md5FromEmojiId(r.emojiId);
            if (!md5) continue;

            const exist = byMd5.get(md5);
            if (exist) {
                let changed = false;
                if (exist.emojiId !== r.emojiId) {
                    exist.emojiId = r.emojiId;
                    changed = true;
                }
                if (exist.url !== r.url) {
                    exist.url = r.url;
                    changed = true;
                }
                if (changed) {
                    exist.updatedAt = now;
                    updated += 1;
                }
            } else {
                const face = this.#normalizeFace({
                    md5,
                    emojiId: r.emojiId,
                    url: r.url,
                    source: r.source ?? 'qq-collected',
                    createdAt: now,
                });
                this.data.faces.push(face);
                byMd5.set(md5, face);
                added += 1;
            }
        }

        this.save();
        return { added, updated, total: this.data.faces.length };
    }

    /** 记录本地缓存文件名 */
    setLocalFile(md5, absPath) {
        const f = this.get(md5);
        if (!f) return false;
        f.localFile = absPath;
        f.updatedAt = new Date().toISOString();
        this.save();
        return true;
    }

    /** 写入 AI 标签（整体替换 aiTags，保留 userTags） */
    setAiLabels(md5, { caption, aiTags, model, imageText }) {
        const f = this.get(md5);
        if (!f) return false;
        f.caption = String(caption ?? '').slice(0, 500);
        f.aiTags = uniqueTags(aiTags);
        f.imageText = String(imageText ?? '').slice(0, 100);
        f.labeledAt = new Date().toISOString();
        f.labelModel = model ?? '';
        f.labelError = '';
        f.updatedAt = new Date().toISOString();
        this.save();
        return true;
    }

    setLabelError(md5, message) {
        const f = this.get(md5);
        if (!f) return false;
        f.labelError = String(message ?? '').slice(0, 300);
        f.updatedAt = new Date().toISOString();
        this.save();
        return true;
    }

    /**
     * 全量替换用户标签。
     * 前端编辑时传完整数组：新标签加入、旧标签移除，符合「删除旧标签、新建自定义标签」的语义。
     */
    setUserTags(md5, tags) {
        const f = this.get(md5);
        if (!f) return false;
        f.userTags = uniqueTags(tags);
        f.updatedAt = new Date().toISOString();
        this.save();
        return true;
    }

    /** 标签统计：合并 ai 与 user，供筛选栏使用 */
    tagStats() {
        const map = new Map();
        for (const f of this.data.faces) {
            for (const t of f.aiTags) {
                const e = map.get(t) ?? { tag: t, ai: 0, user: 0, total: 0 };
                e.ai += 1;
                e.total += 1;
                map.set(t, e);
            }
            for (const t of f.userTags) {
                const e = map.get(t) ?? { tag: t, ai: 0, user: 0, total: 0 };
                e.user += 1;
                e.total += 1;
                map.set(t, e);
            }
        }
        return [...map.values()].sort((a, b) => b.total - a.total);
    }

    stats() {
        const total = this.data.faces.length;
        const labeled = this.data.faces.filter((f) => f.labeledAt && f.aiTags.length > 0).length;
        const withUserTags = this.data.faces.filter((f) => f.userTags.length > 0).length;
        const cached = this.data.faces.filter((f) => f.localFile && fs.existsSync(f.localFile)).length;
        const failed = this.data.faces.filter((f) => f.labelError).length;
        return { total, labeled, unlabeled: total - labeled, withUserTags, cached, failed };
    }

    /** 待打标列表（无 aiTags 或强制全部） */
    pendingForLabel({ all = false, limit = 0 } = {}) {
        let list = this.data.faces.filter((f) => {
            if (all) return true;
            return !f.labeledAt || f.aiTags.length === 0;
        });
        if (limit > 0) list = list.slice(0, limit);
        return list.map((f) => ({ md5: f.md5, url: f.url, localFile: f.localFile }));
    }

    /**
     * 按多个标签挑一张最合适的表情。
     *
     * 这是"AI 出标签、本地挑图"方案的核心。
     *
     * 打分规则（分高者优先）：
     *   +3  命中用户标签（人工标注更可信）
     *   +2  命中 AI 标签
     *   +1  描述文本里出现该词
     *   多个标签命中会累加，越贴合分越高
     *
     * 排除项：
     *   - recentlyUsed 里的 md5（避免连着发同一张）
     *
     * @param {string[]} tags 按贴切程度排序的标签
     * @param {object} opts
     * @param {string[]} opts.exclude 需要排除的 md5 列表
     * @returns {object|null} 表情 DTO
     */
    /**
     * 按多个标签挑一张最合适的表情，并返回完整评分明细。
     *
     * 打分规则（分高者优先）：
     *   +3  命中用户标签（人工标注更可信）
     *   +2  命中 AI 标签
     *   +1  描述文本里出现该词
     *   多标签命中累加，越靠前的标签权重越高
     *
     * @param {string[]} tags 按贴切程度排序的标签
     * @param {object} opts
     * @param {string[]} opts.exclude 需要排除的 md5
     * @param {number} opts.topN 返回前几名用于日志
     * @returns {{
     *   face: object|null,
     *   wanted: string[],
     *   excluded: number,
     *   candidates: Array<{md5:string, score:number, hitTags:string[], caption:string}>,
     *   reason: string,
     * }}
     */
    pickByTagsDetailed(tags, { exclude = [], topN = 3 } = {}) {
        const wanted = (Array.isArray(tags) ? tags : [tags])
            .map((t) => String(t ?? '').trim().toLowerCase())
            .filter(Boolean);

        const base = { wanted, excluded: 0, candidates: [], reason: '' };
        if (wanted.length === 0) return { ...base, face: null, reason: '无标签' };

        const excludeSet = new Set(exclude.map((x) => String(x).toLowerCase()));

        const scored = [];
        let excludedCount = 0;
        let noTagCount = 0;

        for (const f of this.data.faces) {
            const ai = f.aiTags.map((x) => x.toLowerCase());
            const user = f.userTags.map((x) => x.toLowerCase());
            if (ai.length === 0 && user.length === 0) {
                noTagCount += 1;
                continue;
            }
            if (excludeSet.has(f.md5.toLowerCase())) {
                excludedCount += 1;
                continue;
            }

            const caption = String(f.caption ?? '').toLowerCase();
            let score = 0;
            const hitTags = [];
            for (let i = 0; i < wanted.length; i += 1) {
                const t = wanted[i];
                const weight = wanted.length - i;
                if (user.includes(t)) {
                    score += 3 * weight;
                    hitTags.push(t + '(用户)');
                } else if (ai.includes(t)) {
                    score += 2 * weight;
                    hitTags.push(t + '(AI)');
                } else if (caption.includes(t)) {
                    score += 1 * weight;
                    hitTags.push(t + '(描述)');
                }
            }
            if (score > 0) {
                scored.push({
                    f,
                    score,
                    hitTags,
                    caption: String(f.caption ?? '').slice(0, 40),
                });
            }
        }

        scored.sort((a, b) => b.score - a.score);

        const candidates = scored.slice(0, topN).map((x) => ({
            md5: x.f.md5.slice(0, 6),
            score: x.score,
            hitTags: x.hitTags,
            caption: x.caption,
        }));

        if (scored.length === 0) {
            const reason =
                `无匹配（标签: ${wanted.join(',')}｜库内 ${this.data.faces.length} 个｜`
                + `未标注 ${noTagCount} 个｜被排除 ${excludedCount} 个）`;
            return { ...base, face: null, excluded: excludedCount, candidates, reason };
        }

        // 同分随机
        const top = scored[0].score;
        const best = scored.filter((x) => x.score === top);
        const pick = best[Math.floor(Math.random() * best.length)];

        return {
            face: this.toDto(pick.f),
            wanted,
            excluded: excludedCount,
            candidates,
            score: pick.score,
            hitTags: pick.hitTags,
            totalScored: scored.length,
            reason: '',
        };
    }

    /** 按多个标签挑一张最合适的表情（简化接口，返回 DTO 或 null） */
    pickByTags(tags, opts = {}) {
        return this.pickByTagsDetailed(tags, opts).face;
    }

    /** 按标签随机取一张（供 [表情:标签] 解析） */
    pickByTag(tag) {
        const t = String(tag).trim().toLowerCase();
        const hit = this.data.faces.filter(
            (f) =>
                f.aiTags.some((x) => x.toLowerCase() === t) ||
                f.userTags.some((x) => x.toLowerCase() === t),
        );
        if (hit.length === 0) return null;
        const f = hit[Math.floor(Math.random() * hit.length)];
        return this.toDto(f);
    }

    /**
     * 按短 ID 取表情（供 [表情:#id] 精确选择）。
     *
     * 为什么要有这个：AI 拿到每个表情的「短 ID + 标签 + 描述」后，
     * 可以精确挑出最贴合当前对话的那一张，而不是按标签随机撞。
     * 短 ID 取 md5 前 6 位，足够区分且省 token。
     *
     * @param {string} id 短 ID，可带或不带 #
     * @param {string} [keyword] 可选的标签/描述关键词，用于在多个同 ID 前缀中消歧
     */
    pickById(id, keyword = '') {
        const want = String(id ?? '').replace(/^#/, '').trim().toLowerCase();
        if (!want) return null;

        const hit = this.data.faces.filter((f) => f.md5.toLowerCase().startsWith(want));
        if (hit.length === 0) return null;

        // 多个候选（罕见）：用关键词再筛一次
        if (hit.length > 1 && keyword) {
            const k = String(keyword).trim().toLowerCase();
            const refined = hit.filter(
                (f) =>
                    f.aiTags.some((x) => x.toLowerCase().includes(k)) ||
                    f.userTags.some((x) => x.toLowerCase().includes(k)) ||
                    String(f.caption ?? '').toLowerCase().includes(k),
            );
            if (refined.length > 0) return this.toDto(refined[0]);
        }

        return this.toDto(hit[0]);
    }

    /**
     * 生成「只包含库内实际可用标签」的词表。
     *
     * 为什么不能直接把 TAG_VOCAB 全部下发：
     *   固定词表 45 个词，但库内可能只有 11 个表情，
     *   实际覆盖不到 40%。AI 说出没覆盖的词，挑图会失败并被静默丢弃。
     *   所以这里取「词表 ∩ 库内实际标签」，保证 AI 说的每个词都真能挑到图。
     *
     * 保留分组结构（情绪/主体等），方便 AI 按语义组合标签。
     *
     * @param {object} opts
     * @param {number} opts.minCount 标签至少出现几次才下发（过滤一次性噪音）
     */
    manifest({ minCount = 1 } = {}) {
        // 统计库内实际出现的标签
        const count = new Map();
        for (const f of this.data.faces) {
            for (const t of [...f.userTags, ...f.aiTags]) {
                count.set(t, (count.get(t) ?? 0) + 1);
            }
        }

        const vocab = {};
        let totalWords = 0;
        for (const [group, words] of Object.entries(TAG_VOCAB)) {
            // 只保留「词表里有 且 库里真存在」的词
            const usable = words.filter((w) => (count.get(w) ?? 0) >= minCount);
            if (usable.length > 0) {
                vocab[group] = usable;
                totalWords += usable.length;
            }
        }

        const stats = this.stats();
        return {
            vocab,
            totalWords,
            total: stats.total,
            labeled: stats.labeled,
        };
    }
}

export { uniqueTags, normalizeTag };
