import { createHash } from 'node:crypto';
import type { BridgeConfig, ProcessorRule } from './schema.ts';
import type { SessionStore } from '../core/sessions.ts';
import { parseFlow, type ExtractionRule, type VariableDefinition, type VariableAssignment } from './conversation-flow.ts';

export interface ConversationConfig {
    id: string;
    name: string;
    systemPrompt: string;
    inputPrefix: string;
    inputSuffix: string;
    inputRules: ProcessorRule[];
    replyRules: ProcessorRule[];
    replyPrefix?: string;
    replySuffix?: string;
    variables?: VariableDefinition[];
    upstreamExtracts?: ExtractionRule[];
    downstreamExtracts?: ExtractionRule[];
    upstreamAssignments?: VariableAssignment[];
    downstreamAssignments?: VariableAssignment[];
    /** 只用于识别旧会话，不参与连接或协议配置。 */
    legacyRef?: { downstreamId: string; profileId: string; preserveBehavior?: boolean };
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function parseConversation(raw: unknown): ConversationConfig {
    if (!object(raw)) throw new Error('会话配置必须是对象');
    if (Object.keys(raw).some(k => !['id', 'name', 'systemPrompt', 'inputPrefix', 'inputSuffix', 'inputRules', 'replyRules', 'legacyRef', 'replyPrefix', 'replySuffix', 'variables', 'upstreamExtracts', 'downstreamExtracts', 'upstreamAssignments', 'downstreamAssignments'].includes(k))) throw new Error('会话配置只接受对话内容、提取规则与变量设置');
    const id = String(raw.id ?? '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || id === '__inherit__') throw new Error('配置 ID 须为 1–64 位字母、数字、短横线或下划线，且不可使用保留 ID');
    const text = (k: string, max = 16000) => {
        const value = raw[k] ?? '';
        if (typeof value !== 'string' || value.length > max) throw new Error(`${k} 格式无效或过长`);
        return value;
    };
    const rules = (k: string): ProcessorRule[] => {
        const values = raw[k] ?? [];
        if (!Array.isArray(values) || values.length > 50) throw new Error(`${k} 最多 50 条规则`);
        return values.map(r => {
            if (!object(r) || !['replace', 'remove', 'strip'].includes(String(r.type))) throw new Error('消息处理规则类型无效');
            for (const field of ['pattern', 'replacement', 'flags', 'begin', 'end']) if (r[field] !== undefined && (typeof r[field] !== 'string' || r[field].length > 4000)) throw new Error('消息处理规则参数无效');
            if (r.type === 'strip' ? !r.begin || !r.end : !r.pattern) throw new Error('消息处理规则缺少匹配内容');
            if (r.type !== 'strip') new RegExp(String(r.pattern), String(r.flags ?? 'g'));
            return r as unknown as ProcessorRule;
        });
    };
    const inputRules = rules('inputRules'); const replyRules = rules('replyRules');
    return { id, name: text('name', 120).trim() || id, systemPrompt: text('systemPrompt'), inputPrefix: text('inputPrefix'), inputSuffix: text('inputSuffix'), inputRules, replyRules, ...parseFlow({ ...raw, inputRules, replyRules }) };
}

/** 旧版命名配置只导入对话字段；连接参数与协议模板保留在原位置以兼容旧会话。 */
export function importLegacyConversations(config: BridgeConfig): ConversationConfig[] {
    const imported: ConversationConfig[] = [];
    for (const d of config.downstreams) {
        for (const p of d.profiles) {
            const prompt = object(p.settings.prompt) ? p.settings.prompt : {};
            const profile = parseConversation({ id: `legacy-${createHash('sha256').update(JSON.stringify([d.id, p.id])).digest('hex').slice(0, 16)}`, name: `${p.name || p.id}（原 ${d.name || d.id}）`.slice(0, 120), systemPrompt: String(p.settings.systemPrompt ?? prompt.extra ?? '').slice(0, 16000), inputPrefix: '', inputSuffix: '', inputRules: [], replyRules: [] });
            profile.legacyRef = { downstreamId: d.id, profileId: p.id, preserveBehavior: true };
            imported.push(profile);
        }
    }
    return imported;
}

export function resolveConversation(config: BridgeConfig, sessions: SessionStore, key: string): ConversationConfig | undefined {
    const own = sessions.get(key)?.conversationId;
    if (own !== undefined) return config.conversationProfiles.find(p => p.id === own);
    if (config.defaultConversationId) return config.conversationProfiles.find(p => p.id === config.defaultConversationId);
    const legacy = sessions.resolve(key);
    return config.conversationProfiles.find(p => p.legacyRef?.downstreamId === legacy.backendId && p.legacyRef?.profileId === legacy.profileId);
}
