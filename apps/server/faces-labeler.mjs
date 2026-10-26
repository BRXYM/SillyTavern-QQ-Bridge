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
            numPredict: 120,
        });

        return String(caption).replace(/\s+/g, ' ').trim().slice(0, 300);
    }

    /**
     * 阶段 2：把描述收敛到受控词表。
     * @param {string} caption 阶段 1 的描述
     * @returns {Promise<string[]>}
     */
    async toTags(caption) {
        const vocab = flatVocab();
        const model = this.textModel || this.visionModel;

        const prompt = [
            '你是一个表情包标签分类器。',
            `可用标签（只能从中选择）：${vocab.join('、')}`,
            `表情描述：${caption}`,
            '任务：从可用标签中选出 2 到 4 个最贴切的。',
            '注意：',
            '- 必须包含情绪类标签（如开心、生气、无语）',
            '- 如果描述里提到动物或卡通形象，加上主体标签',
            '- 只输出标签本身，用中文逗号分隔',
            '- 不要解释、不要编号、不要引号、不要句号',
            '正确示例：生气，卡通，皱眉',
            '错误示例：1. 生气 2. 卡通（不要编号）',
        ].join('\n');

        const raw = await this.client.chat(model, prompt, {
            timeoutMs: this.timeoutMs,
            temperature: 0,
            numPredict: 60,
        });

        let tags = parseTags(raw, vocab);

        // 模型只给 1 个标签时，补充主体标签提升可检索性
        if (tags.length === 1) {
            const extra = matchVocab(caption).filter((t) => !tags.includes(t));
            tags = [...tags, ...extra].slice(0, 4);
        }

        return tags;
    }

    /**
     * 完整打标：描述 + 标签。
     * @param {string} imagePath
     */
    async label(imagePath) {
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

        return {
            caption,
            tags,
            model: this.visionModel,
            tagError,
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
