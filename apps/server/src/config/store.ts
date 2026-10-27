/**
 * 配置读写与旧版迁移。
 *
 * 旧版 config.json 是**一层平铺**的：onebotUrl / onebotToken / backend / dshProfile /
 * ollamaBaseUrl / segmentation / imageReplies …
 * 新版把它拆成 upstream / downstreams / faces 等分组。
 *
 * 迁移原则：**能映射的都映射，无法判断的保留在 raw 里**，
 * 并且迁移只发生一次（写回新结构后 settingVersion 标记为 2）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG, DEFAULT_SEGMENTATION, type BridgeConfig, type DefaultsConfig, type ProcessorRule } from './schema.ts';
import type { DownstreamConfig } from '../downstream/types.ts';

/** 当前配置结构版本 */
export const CONFIG_VERSION = 2;

export interface LoadedConfig {
    config: BridgeConfig;
    /** 迁移过程中的提示，启动时打日志用 */
    notes: string[];
    /** 配置文件原本是否存在 */
    existed: boolean;
}

type Raw = Record<string, unknown>;

const num = (v: unknown, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
};

const str = (v: unknown, fallback = ''): string =>
    typeof v === 'string' ? v : fallback;

const bool = (v: unknown, fallback: boolean): boolean =>
    typeof v === 'boolean' ? v : fallback;

const numArray = (v: unknown): number[] =>
    Array.isArray(v) ? v.map(Number).filter(Number.isFinite) : [];

/**
 * 读旧版平铺配置，转成新结构。
 * 不修改入参，返回新对象。
 */
export function migrateLegacy(raw: Raw): { config: BridgeConfig; notes: string[] } {
    const notes: string[] = [];
    const base: BridgeConfig = structuredClone(DEFAULT_CONFIG);

    // ---- 端口 ----
    base.consolePort = num(raw.consolePort, base.consolePort);
    base.extPort = num(raw.stExtPort ?? raw.extPort, base.extPort);

    // ---- 上游 ----
    base.upstream.url = str(raw.onebotUrl, base.upstream.url);
    base.upstream.token = str(raw.onebotToken, '');

    // 上游软件本体的安装位置：旧版是顶层扁平字段
    base.snowluma.dir = str(raw.snowlumaDir, '');
    base.snowluma.webuiPort = num(raw.snowlumaWebuiPort, base.snowluma.webuiPort);

    // ---- 全局设置 ----
    const trigger = (raw.trigger ?? {}) as Raw;
    base.trigger = {
        atOnly: bool(trigger.atOnly, base.trigger.atOnly),
        privateReply: bool(trigger.privateReply, base.trigger.privateReply),
        allowedUsers: numArray(trigger.allowedUsers),
        allowedGroups: numArray(trigger.allowedGroups),
    };
    base.maxMessageLength = num(raw.maxMessageLength, base.maxMessageLength);
    base.replyProcessors = Array.isArray(raw.replyProcessors)
        ? (raw.replyProcessors as ProcessorRule[])
        : [];

    const defaults = (raw.defaults ?? {}) as Raw;
    base.defaults = {
        character: str(defaults.character, ''),
        world: str(defaults.world, ''),
    };

    base.segmentation = normalizeSegmentation(raw.segmentation);
    base.stDataDir = str(raw.stDataDir, '');

    const img = (raw.imageReplies ?? {}) as Raw;
    base.imageReplies = {
        enabled: bool(img.enabled, true),
        instruction: bool(img.instruction, true),
        baseUrl: str(img.baseUrl, ''),
    };

    // ---- 表情库 / Ollama ----
    base.faces.ollamaBaseUrl = str(raw.ollamaBaseUrl, base.faces.ollamaBaseUrl);
    base.faces.ollamaVisionModel = str(raw.ollamaVisionModel, base.faces.ollamaVisionModel);
    base.faces.ollamaTextModel = str(raw.ollamaTextModel, '');
    base.faces.dataDir = str(raw.facesDataDir, '');

    // ---- 下游：把旧的 dsh* 平铺字段收进 dsh 实例 ----
    const dshSettings = base.downstreams.find((d) => d.id === 'dsh')?.settings ?? {};
    dshSettings.exePath = str(raw.dshExePath, '');
    dshSettings.profile = str(raw.dshProfile, 'headless');
    dshSettings.workRoot = str(raw.dshWorkRoot, '');
    dshSettings.timeoutMs = num(raw.dshTimeoutMs, 180000);
    dshSettings.historyTurns = num(raw.dshHistoryTurns, 6);
    /**
     * 旧版的 dshSystemPrompt 是「追加在人设之后」的自由文本。
     * 新版提示词改为按开关组装、且默认全关，因此旧文本迁移到 prompt.extra，
     * 其余开关保持关闭 —— 升级后行为是「只发这段自定义文本」，不会突然多出别的注入。
     */
    const legacySystemPrompt = str(raw.dshSystemPrompt, '');
    dshSettings.prompt = {
        qqBase: false,
        character: false,
        faces: false,
        images: false,
        extra: legacySystemPrompt,
    };
    dshSettings.errorReply = str(raw.dshErrorReply, '');
    dshSettings.persistHistory = bool(raw.dshPersistHistory, true);
    dshSettings.concurrency = num(raw.dshConcurrency, 1);
    dshSettings.serviceProfile = str(raw.dshServiceProfile, 'web');
    dshSettings.servicePort = num(raw.dshServicePort, 3080);
    dshSettings.serviceLogFile = str(raw.dshServiceLogFile, '');
    /**
     * 旧版的 dshPluginToken 同时被用于「插件握手」和「注册」。
     * 新版把两者统一成 registrationToken（握手与注册共用一个凭据）：
     * 插件连进来的 hello 和自注册请求都校验它，语义一致、配置也只剩一处。
     */
    base.registrationToken = str(raw.dshPluginToken, '');

    // 旧的全局 backend 枚举 → 选中对应实例
    const legacyBackend = str(raw.backend, 'taver');
    const tavern = base.downstreams.find((d) => d.id === 'tavern');
    if (tavern) {
        tavern.settings.stDataDir = str(raw.stDataDir, '');
    }
    if (legacyBackend === 'dsh') {
        base.defaultDownstreamId = 'dsh';
        const d = base.downstreams.find((x) => x.id === 'dsh');
        if (d) d.enabled = true;
        notes.push('旧配置 backend=dsh → 默认下游设为 dsh');
    } else if (legacyBackend === 'taver') {
        base.defaultDownstreamId = 'tavern';
        if (tavern) tavern.enabled = true;
        const d = base.downstreams.find((x) => x.id === 'dsh');
        if (d) d.enabled = true; // dsh 仍保留可用，只是不是默认
        notes.push('旧配置 backend=taver → 默认下游设为酒馆（dsh 保留为可选）');
    }

    if (raw.dshPluginEnabled === false) {
        notes.push('旧配置 dshPluginEnabled=false：插件链路已停用，headless 兜底仍可用');
    }

    // 旧版的下游端口与插件地址隐含在 stExtPort 上，这里只做记录
    notes.push(`下游入站 WS 端口沿用 ${base.extPort}`);

    return { config: base, notes };
}

/** 分段配置容错：允许旧版把 pairChars 写成 ['*', '"'] 这种简写 */
function normalizeSegmentation(raw: unknown): BridgeConfig['segmentation'] {
    const src = (raw ?? {}) as Raw;
    const out = structuredClone(DEFAULT_SEGMENTATION);

    out.enabled = bool(src.enabled, out.enabled);
    out.maxLen = num(src.maxLen, out.maxLen);
    out.minLen = num(src.minLen, out.minLen);
    out.maxSegments = num(src.maxSegments, out.maxSegments);
    out.hardChars = str(src.hardChars, out.hardChars);
    out.softChars = str(src.softChars, out.softChars);
    out.splitOnPairs = bool(src.splitOnPairs, out.splitOnPairs);
    out.pairMinLen = num(src.pairMinLen, out.pairMinLen);
    out.convertActionMarkers = bool(src.convertActionMarkers, out.convertActionMarkers);

    if (Array.isArray(src.splitStrings)) {
        out.splitStrings = src.splitStrings.filter((s): s is string => typeof s === 'string');
    }

    if (Array.isArray(src.delayMs) && src.delayMs.length === 2) {
        out.delayMs = [num(src.delayMs[0], 300), num(src.delayMs[1], 900)];
    }

    // pairChars 有两种写法：
    //   [['动作','*'], ['台词','"']]  ← 新版
    //   ['*', '"']                    ← 旧版简写
    if (Array.isArray(src.pairChars)) {
        const pairs: Array<[string, string]> = [];
        for (const item of src.pairChars) {
            if (Array.isArray(item) && item.length >= 2) {
                pairs.push([String(item[0]), String(item[1])]);
            } else if (typeof item === 'string') {
                pairs.push([item, item]);
            } else if (item && typeof item === 'object') {
                const o = item as Raw;
                const token = str(o.pair ?? o.symbol ?? '');
                if (token) pairs.push([String(o.name ?? token), token]);
            }
        }
        if (pairs.length > 0) out.pairChars = pairs;
    }

    return out;
}

/** 结构版本 2 的配置：只做缺省填充与类型收敛，不覆盖用户已有值 */
function normalizeV2(raw: Raw): { config: BridgeConfig; notes: string[] } {
    const notes: string[] = [];
    const base: BridgeConfig = structuredClone(DEFAULT_CONFIG);

    base.consolePort = num(raw.consolePort, base.consolePort);
    base.extPort = num(raw.extPort, base.extPort);
    base.maxMessageLength = num(raw.maxMessageLength, base.maxMessageLength);
    base.stDataDir = str(raw.stDataDir, '');
    base.registrationToken = str(raw.registrationToken, '');

    const up = (raw.upstream ?? {}) as Raw;
    base.upstream = {
        url: str(up.url, base.upstream.url),
        token: str(up.token, ''),
        reconnectMs: num(up.reconnectMs, base.upstream.reconnectMs),
        actionTimeoutMs: num(up.actionTimeoutMs, base.upstream.actionTimeoutMs),
    };

    const sl = (raw.snowluma ?? {}) as Raw;
    base.snowluma = {
        dir: str(sl.dir, base.snowluma.dir),
        webuiPort: num(sl.webuiPort, base.snowluma.webuiPort),
    };

    if (Array.isArray(raw.downstreams)) {
        const list: DownstreamConfig[] = [];
        for (const item of raw.downstreams) {
            if (!item || typeof item !== 'object') continue;
            const d = item as Raw;
            const id = str(d.id);
            const kind = str(d.kind);
            if (!id || !kind) {
                notes.push(`忽略缺少 id/kind 的下游项：${JSON.stringify(d).slice(0, 80)}`);
                continue;
            }
            list.push({
                id,
                kind: kind as DownstreamConfig['kind'],
                name: str(d.name, id),
                enabled: bool(d.enabled, true),
                settings: (d.settings as Record<string, unknown>) ?? {},
            });
        }
        if (list.length > 0) base.downstreams = list;
        else notes.push('downstreams 为空，已回落默认（dsh + 酒馆）');
    }

    const defId = str(raw.defaultDownstreamId, base.defaultDownstreamId);
    base.defaultDownstreamId = base.downstreams.some((d) => d.id === defId)
        ? defId
        : (base.downstreams[0]?.id ?? '');

    const t = (raw.trigger ?? {}) as Raw;
    base.trigger = {
        atOnly: bool(t.atOnly, base.trigger.atOnly),
        privateReply: bool(t.privateReply, base.trigger.privateReply),
        allowedUsers: numArray(t.allowedUsers),
        allowedGroups: numArray(t.allowedGroups),
    };

    base.replyProcessors = Array.isArray(raw.replyProcessors)
        ? (raw.replyProcessors as ProcessorRule[])
        : [];

    const d = (raw.defaults ?? {}) as Raw;
    base.defaults = { character: str(d.character, ''), world: str(d.world, '') };

    base.segmentation = normalizeSegmentation(raw.segmentation);

    const img = (raw.imageReplies ?? {}) as Raw;
    base.imageReplies = {
        enabled: bool(img.enabled, true),
        instruction: bool(img.instruction, true),
        baseUrl: str(img.baseUrl, ''),
    };

    const f = (raw.faces ?? {}) as Raw;
    base.faces = {
        dataDir: str(f.dataDir, ''),
        ollamaBaseUrl: str(f.ollamaBaseUrl, base.faces.ollamaBaseUrl),
        ollamaVisionModel: str(f.ollamaVisionModel, base.faces.ollamaVisionModel),
        ollamaTextModel: str(f.ollamaTextModel, ''),
    };

    return { config: base, notes };
}

/** 读文件并归一化；任何异常都回落到默认配置 */
export function loadConfigFile(file: string): LoadedConfig {
    let parsed: Raw | null = null;
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Raw;
    } catch {
        parsed = null;
    }

    if (!parsed) {
        return { config: structuredClone(DEFAULT_CONFIG), notes: [], existed: false };
    }

    const version = num(parsed.configVersion, 1);
    const result = version >= CONFIG_VERSION
        ? normalizeV2(parsed)
        : migrateLegacy(parsed);

    return { ...result, existed: true };
}

/** 原子写配置（临时文件 + rename，避免写一半断电留下坏文件） */
export function saveConfigFile(file: string, config: BridgeConfig): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const payload = { configVersion: CONFIG_VERSION, ...config };
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 4)}\n`, 'utf8');
    fs.renameSync(tmp, file);
}
