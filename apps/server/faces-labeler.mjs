/**
 * 表情标签识别：通过 Ollama HTTP API 调用视觉模型。
 *
 * 为什么走 HTTP API 而不是 ollama CLI：
 *   - 便于后续切换模型（改配置即可，不用改代码）
 *   - 便于替换为云端 API（同一套接口形状）
 *   - 可精确控制超时 / 并发 / 模型卸载
 *
 * 网络层复用 ollama-service.mjs 的 OllamaClient，
 * 保证「模型管理页」与「打标任务」使用同一套地址与超时策略。
 *
 * 两阶段识别：
 *   阶段 1  视觉模型看图，产出自由描述
 *   阶段 2  文本模型把描述收敛到受控词表
 * 分开做的原因：视觉模型直接输出标签容易发散（同义不同词），无法检索。
 */
import fs from 'node:fs';
import { TAG_VOCAB, flatVocab } from './faces-store.mjs';
import { OllamaClient, DEFAULT_BASE } from './ollama-service.mjs';

export class OllamaLabeler {
    /**
     * @param {object} opts
     * @param {string} opts.baseUrl       Ollama 服务地址
     * @param {string} opts.visionModel   视觉模型名，如 qwen2.5vl:3b
     * @param {string} opts.textModel     文本模型名，如 qwen2.5:1.5b（留空则复用视觉模型）
     * @param {number} opts.timeoutMs     单次请求超时
     */
    constructor(opts = {}) {
        this.visionModel = opts.visionModel ?? 'qwen2.5vl:3b';
        this.textModel = opts.textModel ?? '';
        this.timeoutMs = opts.timeoutMs ?? 120000;
        this.client = new OllamaClient({
            baseUrl: opts.baseUrl ?? DEFAULT_BASE,
            timeoutMs: this.timeoutMs,
        });
    }

    /** 供外部读取（诊断接口用） */
    get baseUrl() {
        return this.client.baseUrl;
    }

    /**
     * 运行时更新配置：前端改了地址或模型后立刻生效，无需重启 Bridge。
     */
    reconfigure({ baseUrl, visionModel, textModel, timeoutMs } = {}) {
        if (baseUrl) this.client.baseUrl = String(baseUrl).replace(/\/$/, '');
        if (visionModel) this.visionModel = visionModel;
        if (textModel !== undefined) this.textModel = textModel;
        if (timeoutMs) {
            this.timeoutMs = timeoutMs;
            this.client.timeoutMs = timeoutMs;
        }
        return this.describeConfig();
    }

    describeConfig() {
        return {
            baseUrl: this.client.baseUrl,
            visionModel: this.visionModel,
            textModel: this.textModel || this.visionModel,
        };
    }

    /** 服务是否可用 */
    async ping() {
        const v = await this.client.version();
        if (!v.ok) return { ok: false, error: v.error };
        try {
            const models = await this.client.list();
            return { ok: true, version: v.version, models: models.map((m) => m.name) };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    }

    /** 模型是否已拉取 */
    async hasModel(name) {
        const r = await this.ping();
        if (!r.ok) return false;
        // ollama 返回的名字可能带 :latest 后缀
        return r.models.some((m) => m === name || m === `${name}:latest` || m.startsWith(`${name}:`));
    }

    /**
     * 阶段 1：看图描述。
     *
     * 提示词设计依据（实测出来的）：
     *   - 让模型"顺便说情绪"会让它偷懒，同一张图反复给"愤怒/惊讶"
     *   - 改成只描述画面（主体 + 脸部状态），把情绪判断交给阶段 2，
     *     准确度反而更高，因为阶段 1 专心想"看到了什么"
     *   - temperature=0：同一张图每次结果一致，可复现
     *
     * @param {string} imagePath 本地图片绝对路径
     */
    async describe(imagePath) {
        const buf = fs.readFileSync(imagePath);
        const b64 = buf.toString('base64');

        const prompt = [
            '用不超过 40 个字描述这张表情包。',
            '依次说明：画面主体是什么、主体的表情或动作、传达的情绪。',
            '只输出描述，不要解释、不要评价、不要加序号。',
            '如果图中有文字，一并说明文字内容。',
        ].join('');

        const caption = await this.client.vision(this.visionModel, prompt, [b64], {
            timeoutMs: this.timeoutMs,
            // 关键：temperature=0 保证同一张图每次结果一致。
            // 之前用默认 0.2，同一张图三次能给出"愤怒/惊讶/无语"三种答案。
            temperature: 0,
            numPredict: 120,
        });

        return String(caption).replace(/\s+/g, ' ').trim().slice(0, 300);
    }

    /**
     * 阶段 0：读图内文字。
     *
     * 为什么单独做：表情包里的文字往往是最强的语义线索
     * ——「害怕」「危」「嘶」「梆」这类字直接决定情绪。
     * 实测 3B 模型在正常描述时经常漏掉这些字，单独问却读得出来
     * （5 张带字的图里能正确读出 3 张）。
     * 读到的文字直接匹配词表，命中就当作高置信标签。
     *
     * @param {string} imagePath
     * @returns {Promise<{ text: string, tags: string[] }>}
     */
    async readText(imagePath) {
        const buf = fs.readFileSync(imagePath);
        const b64 = buf.toString('base64');

        const raw = await this.client
            .vision(
                this.visionModel,
                '这张图里有什么文字？把看到的字原样写出来；没有任何文字就只回答"无"。只输出文字内容，不要解释。',
                [b64],
                { timeoutMs: this.timeoutMs, temperature: 0, numPredict: 40 },
            )
            .catch(() => '');

        const text = String(raw).replace(/\s+/g, ' ').trim().slice(0, 100);

        // 文字里出现词表中的词，直接当标签用
        let tags = [];
        if (text && text !== '无' && !/^无/.test(text)) {
            tags = flatVocab().filter((v) => text.includes(v));
        }
        return { text, tags };
    }

    /**
     * 阶段 2：把描述收敛到受控词表。
     *
     * 为什么分两次问（实测结论）：
     *   把 36 个词一次性丢给 3B 模型，它会塌缩到固定几个词
     *   —— 4 张完全不同的图，3 张都回"无语，委屈"。
     *   拆成"情绪"和"主体"两问，命中率更高。
     *
     * @param {string} caption 阶段 1 的描述
     * @returns {Promise<string[]>}
     */
    async toTags(caption) {
        const model = this.textModel || this.visionModel;
        const tags = [];

        // 情绪：只给情绪词，避免模型用主体词顶替
        const emoRaw = await this.client.chat(
            model,
            [
                '从下面情绪词里选 2 个最符合这张表情包的，按贴切程度排序。',
                `情绪词：${TAG_VOCAB.情绪.join('、')}`,
                `画面：${caption}`,
                '只输出情绪词本身，用中文逗号分隔，不要解释。',
            ].join('\n'),
            { timeoutMs: this.timeoutMs, temperature: 0, numPredict: 24 },
        ).catch(() => '');

        tags.push(...parseTags(emoRaw, TAG_VOCAB.情绪));

        // 主体：从描述文本里匹配，不再单独问模型。
        // 单独问会让 3B 模型瞎编（图中是笑脸，却给出"猫/人"）。
        // 描述里提到了才算数，这样至少不会凭空捏造。
        tags.push(...matchVocab(caption));

        // 去重
        const uniq = [];
        const seen = new Set();
        for (const t of tags) {
            if (seen.has(t)) continue;
            seen.add(t);
            uniq.push(t);
            if (uniq.length >= 4) break;
        }

        // 模型什么都没给时，退化为从描述里直接匹配词表
        if (uniq.length === 0) return matchVocab(caption);

        // 只有主体词、没有情绪词时，用描述兜底补情绪
        const hasEmotion = uniq.some((t) => TAG_VOCAB.情绪.includes(t));
        if (!hasEmotion) {
            const guess = matchVocab(caption).filter(
                (t) => TAG_VOCAB.情绪.includes(t) && !seen.has(t),
            );
            return [...guess, ...uniq].slice(0, 4);
        }

        return uniq;
    }

    /**
     * 完整打标：读字 + 描述 + 标签。
     * @param {string} imagePath
     */
    async label(imagePath) {
        // 阶段 0：图内文字（高置信线索，先拿到手）
        const ocr = await this.readText(imagePath).catch(() => ({ text: '', tags: [] }));

        const caption = await this.describe(imagePath);
        let tags = [];
        let tagError = '';

        try {
            tags = await this.toTags(caption);
        } catch (e) {
            tagError = e.message;
        }

        // 阶段 2 失败时退化为从描述里直接匹配词表
        if (tags.length === 0) {
            tags = matchVocab(caption);
        }

        // 图内文字命中词表的标签优先（「害怕」「危」这类字几乎不会错）
        if (ocr.tags.length > 0) {
            const merged = [];
            const seen = new Set();
            for (const t of [...ocr.tags, ...tags]) {
                if (seen.has(t)) continue;
                seen.add(t);
                merged.push(t);
                if (merged.length >= 4) break;
            }
            tags = merged;
        }

        return {
            caption,
            tags,
            model: this.visionModel,
            tagError,
            /** 图内识别到的文字，便于前端核对 */
            imageText: ocr.text,
        };
    }

    /** 让 Ollama 立即卸载模型，释放显存 */
    async unload() {
        for (const model of [this.visionModel, this.textModel].filter(Boolean)) {
            try {
                await this.client.unload(model);
            } catch {
                /* 忽略：卸载失败不影响主流程 */
            }
        }
    }
}

/**
 * 从模型输出里解析标签，并过滤掉不在词表中的词。
 * 容错处理：模型可能加引号、编号、换行、句号。
 */
export function parseTags(raw, vocab) {
    const allowed = new Set(vocab.map((v) => v.toLowerCase()));
    const text = String(raw ?? '')
        .replace(/[「」【】"'“”‘’]/g, '')
        .replace(/^\s*\d+[.、)]\s*/gm, '')
        .replace(/[。.]/g, '');

    const parts = text
        .split(/[,，、\s\n/|]+/)
        .map((s) => s.trim())
        .filter(Boolean);

    const out = [];
    const seen = new Set();
    for (const p of parts) {
        const key = p.toLowerCase();
        if (!allowed.has(key)) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(p);
        if (out.length >= 4) break;
    }
    return out;
}

/** 从自由文本里匹配词表（阶段 2 不可用时的兜底） */
export function matchVocab(text) {
    const out = [];
    const lower = String(text ?? '').toLowerCase();
    for (const [group, words] of Object.entries(TAG_VOCAB)) {
        for (const w of words) {
            if (lower.includes(w.toLowerCase())) {
                out.push(w);
                if (out.length >= 4) return out;
            }
        }
    }
    return out;
}

export { DEFAULT_BASE };
