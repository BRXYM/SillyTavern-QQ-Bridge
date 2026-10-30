/**
 * 配置读写与旧版迁移。
 *
 * 旧版 config.json 是**一层平铺**的：onebotUrl / onebotToken / backend / dshProfile /
 * ollamaBaseUrl / segmentation / imageReplies …
 * 之后又把上游收成了单个 `upstream`、下游收成了 `downstreams` 数组。
 *
 * 现在上游也要能放多个号，所以 `upstream` → `accounts[]`。迁移分两步：
 *   1. v1（平铺）    → v2（upstream / downstreams / faces 分组）
 *   2. v2（单上游）  → v3（accounts[] + downstreams[].profiles[]）
 *
 * 迁移原则：**能映射的都映射，无法判断的保留在 raw 里**，
 * 并且迁移只发生一次（写回新结构后 configVersion 标记为当前版本）。
 */

import fs from 'node:fs';
import { importLegacyConversations, parseConversation } from './conversations.ts';
import path from 'node:path';
import {
    DEFAULT_CONFIG,
    DEFAULT_SEGMENTATION,
    DEFAULT_UPSTREAM_PORT,
    type AccountConfig,
    type BridgeConfig,
    type DefaultsConfig,
    type ProcessorRule,
} from './schema.ts';
import type { DownstreamConfig, DownstreamProfile } from '../downstream/types.ts';

/** 当前配置结构版本 */
export const CONFIG_VERSION = 3;

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
 * 生成一个不会被下一次迁移改掉的稳定账号 id。
 *
 * 用 uin 优先：它天然唯一且可读（`qq_1417434860`），排查时一眼能对上。
 * 没有 uin 时退回 `main`，因为是首个账号。
 */
function accountIdFor(uin: string, index: number): string {
    const clean = String(uin ?? '').trim();
    if (clean && /^[0-9]+$/.test(clean)) return `qq_${clean}`;
    return index === 0 ? 'main' : `account_${index + 1}`;
}

/** 规范化一个账号项 */
function normalizeAccount(raw: Raw, index: number): AccountConfig | null {
    const up = (raw.upstream && typeof raw.upstream === 'object')
        ? (raw.upstream as Raw)
        : raw;
    // 兼容旧写法：账号项直接写 onebotUrl / token
    const url = str(up.url, str(raw.onebotUrl, `ws://127.0.0.1:${DEFAULT_UPSTREAM_PORT}`));
    if (!url) return null;

    const uin = str(raw.uin, '');
    const id = str(raw.id, '').trim() || accountIdFor(uin, index);

    return {
        id,
        uin,
        name: str(raw.name, uin ? `${uin}` : (index === 0 ? '主号' : `账号 ${index + 1}`)),
        enabled: bool(raw.enabled, true),
        upstream: {
            url,
            token: str(up.token, ''),
            reconnectMs: num(up.reconnectMs, 5000),
            actionTimeoutMs: num(up.actionTimeoutMs, 15000),
        },
    };
}

/** 规范化下游实例下面的命名配置 */
function normalizeProfiles(raw: unknown): DownstreamProfile[] {
    if (!Array.isArray(raw)) return [];

    const out: DownstreamProfile[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const p = item as Raw;
        const id = str(p.id, '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push({
            id,
            name: str(p.name, id) || id,
            settings: (p.settings && typeof p.settings === 'object')
                ? (p.settings as Record<string, unknown>)
                : {},
        });
    }
    return out;
}

/** 规范化一个下游实例项（v2 / v3 共用） */
function normalizeDownstream(raw: Raw): DownstreamConfig | null {
    const id = str(raw.id, '').trim();
    const kind = str(raw.kind, '').trim();
    if (!id || !kind) return null;

    // 准入名单：只在配置里存在时带上，避免给所有实例塞空对象
    const access = raw.access && typeof raw.access === 'object'
        ? {
            allow: Array.isArray((raw.access as Record<string, unknown>).allow)
                ? ((raw.access as Record<string, unknown>).allow as unknown[]).map(Number).filter(Number.isFinite)
                : [],
            deny: Array.isArray((raw.access as Record<string, unknown>).deny)
                ? ((raw.access as Record<string, unknown>).deny as unknown[]).map(Number).filter(Number.isFinite)
                : [],
        }
        : undefined;

    return {
        id,
        kind: kind as DownstreamConfig['kind'],
        name: str(raw.name, id),
        enabled: bool(raw.enabled, true),
        settings: (raw.settings as Record<string, unknown>) ?? {},
        profiles: normalizeProfiles(raw.profiles),
        ...(access ? { access } : {}),
    };
}

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

    // ---- 上游：旧版只有一个号 ----
    const url = str(raw.onebotUrl, base.accounts[0]!.upstream.url);
    base.accounts[0]!.upstream = {
        url,
        token: str(raw.onebotToken, ''),
        reconnectMs: num(raw.onebotReconnectMs, 5000),
        actionTimeoutMs: num(raw.onebotActionTimeoutMs, 15000),
    };

    // 上游软件本体的安装位置：旧版是顶层扁平字段
    base.snowluma.dir = str(raw.snowlumaDir, '');
    base.snowluma.webuiPort = num(raw.snowlumaWebuiPort, base.snowluma.webuiPort);

    // ---- 全局设置 ----
    const trigger = (raw.trigger ?? {}) as Raw;
    // 旧版把名单放在 trigger 里；新版名单属于「会话准入」，这里迁过去
    const legacyAllowedUsers = numArray(trigger.allowedUsers);
    const legacyAllowedGroups = numArray(trigger.allowedGroups);
    base.trigger = {
        atOnly: bool(trigger.atOnly, base.trigger.atOnly),
        privateReply: bool(trigger.privateReply, base.trigger.privateReply),
        // 保留字段以兼容旧前端，但不再参与判定
        allowedUsers: [],
        allowedGroups: [],
    };
    base.sessionAccess = {
        denyUsers: [],
        denyGroups: [],
        allowUsers: legacyAllowedUsers,
        allowGroups: legacyAllowedGroups,
        unknownPolicy: 'allow',
        denyReply: '',
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

/** 结构版本 2：单上游 + downstreams（无命名配置） */
function normalizeV2(raw: Raw): { config: BridgeConfig; notes: string[] } {
    const notes: string[] = [];
    const base: BridgeConfig = structuredClone(DEFAULT_CONFIG);

    base.consolePort = num(raw.consolePort, base.consolePort);
    base.extPort = num(raw.extPort, base.extPort);
    base.maxMessageLength = num(raw.maxMessageLength, base.maxMessageLength);
    base.stDataDir = str(raw.stDataDir, '');
    base.registrationToken = str(raw.registrationToken, '');

    // 单个 upstream → 第一个账号
    const up = (raw.upstream ?? {}) as Raw;
    base.accounts = [{
        ...base.accounts[0]!,
        upstream: {
            url: str(up.url, base.accounts[0]!.upstream.url),
            token: str(up.token, ''),
            reconnectMs: num(up.reconnectMs, 5000),
            actionTimeoutMs: num(up.actionTimeoutMs, 15000),
        },
    }];
    notes.push('上游已从单条连接迁移为账号列表（首个账号沿用原 OneBot 地址与 token）');

    const sl = (raw.snowluma ?? {}) as Raw;
    base.snowluma = {
        dir: str(sl.dir, base.snowluma.dir),
        webuiPort: num(sl.webuiPort, base.snowluma.webuiPort),
    };

    base.downstreams = normalizeDownstreamList(raw.downstreams, notes);

    const defId = str(raw.defaultDownstreamId, base.defaultDownstreamId);
    base.defaultDownstreamId = base.downstreams.some((d) => d.id === defId)
        ? defId
        : (base.downstreams[0]?.id ?? '');

    base.defaultDownstreamProfileId = str(raw.defaultDownstreamProfileId, '');

    const t = (raw.trigger ?? {}) as Raw;
    base.trigger = {
        atOnly: bool(t.atOnly, base.trigger.atOnly),
        privateReply: bool(t.privateReply, base.trigger.privateReply),
        allowedUsers: [],
        allowedGroups: [],
    };

    // 会话准入：读新结构；旧结构里的名单作为回落
    const sa = (raw.sessionAccess ?? {}) as Raw;
    const legacyUsers = numArray(t.allowedUsers);
    const legacyGroups = numArray(t.allowedGroups);
    base.sessionAccess = {
        denyUsers: numArray(sa.denyUsers),
        denyGroups: numArray(sa.denyGroups),
        allowUsers: numArray(sa.allowUsers).length > 0 || sa.allowUsers !== undefined
            ? numArray(sa.allowUsers)
            : legacyUsers,
        allowGroups: numArray(sa.allowGroups).length > 0 || sa.allowGroups !== undefined
            ? numArray(sa.allowGroups)
            : legacyGroups,
        unknownPolicy: sa.unknownPolicy === 'deny' ? 'deny' : 'allow',
        denyReply: str(sa.denyReply, ''),
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
        // 五个字段都兼容「faces 下」与「顶层平铺」两种写法：
        // v1 的旧配置把 ollama* 放在顶层，v2 之后才收进 faces。
        // 只读 faces 会把 v2 里的旧值静默丢掉（用户改了地址却不生效）。
        ollamaBaseUrl: str(f.ollamaBaseUrl, str(raw.ollamaBaseUrl, base.faces.ollamaBaseUrl)),
        ollamaVisionModel: str(f.ollamaVisionModel, str(raw.ollamaVisionModel, base.faces.ollamaVisionModel)),
        ollamaTextModel: str(f.ollamaTextModel, str(raw.ollamaTextModel, '')),
        ollamaExePath: str(f.ollamaExePath, str(raw.ollamaExePath, '')),
        ollamaModelsDir: str(f.ollamaModelsDir, str(raw.ollamaModelsDir, '')),
    };

    return { config: base, notes };
}

/** 结构版本 3：accounts[] + downstreams[].profiles[]，只做缺省填充 */
function normalizeV3(raw: Raw): { config: BridgeConfig; notes: string[] } {
    const notes: string[] = [];
    const base: BridgeConfig = structuredClone(DEFAULT_CONFIG);

    base.consolePort = num(raw.consolePort, base.consolePort);
    base.extPort = num(raw.extPort, base.extPort);
    base.maxMessageLength = num(raw.maxMessageLength, base.maxMessageLength);
    base.stDataDir = str(raw.stDataDir, '');
    base.registrationToken = str(raw.registrationToken, '');

    // ---- 账号 ----
    if (Array.isArray(raw.accounts)) {
        const list: AccountConfig[] = [];
        const seen = new Set<string>();
        raw.accounts.forEach((item, i) => {
            if (!item || typeof item !== 'object') return;
            const acc = normalizeAccount(item as Raw, i);
            if (!acc) return;
            if (seen.has(acc.id)) {
                notes.push(`账号 id 重复：${acc.id}，后者已忽略`);
                return;
            }
            seen.add(acc.id);
            list.push(acc);
        });
        if (list.length > 0) base.accounts = list;
        else notes.push('accounts 为空，已回落单个默认账号');
    }

    const sl = (raw.snowluma ?? {}) as Raw;
    base.snowluma = {
        dir: str(sl.dir, base.snowluma.dir),
        webuiPort: num(sl.webuiPort, base.snowluma.webuiPort),
    };

    base.downstreams = normalizeDownstreamList(raw.downstreams, notes);

    const defId = str(raw.defaultDownstreamId, base.defaultDownstreamId);
    base.defaultDownstreamId = base.downstreams.some((d) => d.id === defId)
        ? defId
        : (base.downstreams[0]?.id ?? '');

    // 默认配置 id 必须真的存在，否则回落「不指定」
    const defProfile = str(raw.defaultDownstreamProfileId, '');
    const defDown = base.downstreams.find((d) => d.id === base.defaultDownstreamId);
    base.defaultDownstreamProfileId = defDown?.profiles.some((p) => p.id === defProfile)
        ? defProfile
        : '';

    const t = (raw.trigger ?? {}) as Raw;
    base.trigger = {
        atOnly: bool(t.atOnly, base.trigger.atOnly),
        privateReply: bool(t.privateReply, base.trigger.privateReply),
        allowedUsers: [],
        allowedGroups: [],
    };

    const sa = (raw.sessionAccess ?? {}) as Raw;
    base.sessionAccess = {
        denyUsers: numArray(sa.denyUsers),
        denyGroups: numArray(sa.denyGroups),
        allowUsers: numArray(sa.allowUsers),
        allowGroups: numArray(sa.allowGroups),
        unknownPolicy: sa.unknownPolicy === 'deny' ? 'deny' : 'allow',
        denyReply: str(sa.denyReply, ''),
    };

    base.replyProcessors = Array.isArray(raw.replyProcessors)
        ? (raw.replyProcessors as ProcessorRule[])
        : [];

    const d = (raw.defaults ?? {}) as DefaultsConfig & Raw;
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
        // 五个字段都兼容「faces 下」与「顶层平铺」两种写法：
        // v1 的旧配置把 ollama* 放在顶层，v2 之后才收进 faces。
        // 只读 faces 会把 v2 里的旧值静默丢掉（用户改了地址却不生效）。
        ollamaBaseUrl: str(f.ollamaBaseUrl, str(raw.ollamaBaseUrl, base.faces.ollamaBaseUrl)),
        ollamaVisionModel: str(f.ollamaVisionModel, str(raw.ollamaVisionModel, base.faces.ollamaVisionModel)),
        ollamaTextModel: str(f.ollamaTextModel, str(raw.ollamaTextModel, '')),
        ollamaExePath: str(f.ollamaExePath, str(raw.ollamaExePath, '')),
        ollamaModelsDir: str(f.ollamaModelsDir, str(raw.ollamaModelsDir, '')),
    };

    return { config: base, notes };
}

/** 下游列表规范化（各版本共用） */
function normalizeDownstreamList(raw: unknown, notes: string[]): DownstreamConfig[] {
    if (!Array.isArray(raw)) return DEFAULT_CONFIG.downstreams.map((d) => structuredClone(d));

    const list: DownstreamConfig[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const d = normalizeDownstream(item as Raw);
        if (!d) {
            notes.push(`忽略缺少 id/kind 的下游项：${JSON.stringify(item).slice(0, 80)}`);
            continue;
        }
        if (seen.has(d.id)) {
            notes.push(`下游 id 重复：${d.id}，后者已忽略`);
            continue;
        }
        seen.add(d.id);
        list.push(d);
    }

    if (list.length > 0) return list;
    notes.push('downstreams 为空，已回落默认（dsh + 酒馆）');
    return DEFAULT_CONFIG.downstreams.map((d) => structuredClone(d));
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

    // 旧版没有 configVersion 字段，视为 1
    const version = num(parsed.configVersion, 1);
    const result = version >= 3
        ? normalizeV3(parsed)
        : version === 2
            ? normalizeV2(parsed)
            : migrateLegacy(parsed);

    result.config.conversationProfiles = Array.isArray(parsed.conversationProfiles)
        ? parsed.conversationProfiles.flatMap(p => {
            try {
                const profile = parseConversation(p);
                const ref = (p as { legacyRef?: { downstreamId: string; profileId: string } }).legacyRef;
                if (ref && typeof ref.downstreamId === 'string' && typeof ref.profileId === 'string') profile.legacyRef = ref;
                return [profile];
            } catch { result.notes.push('忽略无效的会话配置'); return []; }
        })
        : importLegacyConversations(result.config);
    const defaultConversationId = str(parsed.defaultConversationId);
    result.config.defaultConversationId = result.config.conversationProfiles.some(p => p.id === defaultConversationId) ? defaultConversationId : '';
    return { ...result, existed: true };
}

/** 原子写配置（临时文件 + rename，避免写一半断电留下坏文件） */
export function saveConfigFile(file: string, config: BridgeConfig): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const payload = { ...config, configVersion: CONFIG_VERSION };
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 4)}\n`, 'utf8');
    fs.renameSync(tmp, file);
}
