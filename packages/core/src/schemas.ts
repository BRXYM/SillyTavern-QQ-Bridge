import { z } from 'zod';

/** 配对符：[名称, 符号] */
export const pairDelimiterSchema = z.tuple([z.string(), z.string().min(1)]);

export const segmentationSchema = z.object({
    enabled: z.boolean().default(true),
    maxLen: z.number().int().min(20).max(2000).default(200),
    minLen: z.number().int().min(0).max(100).default(6),
    maxSegments: z.number().int().min(1).max(20).default(12),
    hardChars: z.string().default('。！？!?…'),
    softChars: z.string().default('，,；;'),
    pairChars: z.array(pairDelimiterSchema).default([
        ['动作', '*'],
        ['台词', '"'],
        ['中文台词', '“”'],
        ['括号动作', '（）'],
    ]),
    splitStrings: z.array(z.string()).default([]),
    splitOnPairs: z.boolean().default(true),
    /** 配对符内容短于该长度时不作为独立分段（避免 "菜" 这种单字引用被拆开） */
    pairMinLen: z.number().int().min(0).max(50).default(3),
    convertActionMarkers: z.boolean().default(true),
    delayMs: z.tuple([z.number().int().min(0), z.number().int().min(0)]).default([300, 900]),
});

export const processorRuleSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('replace'),
        pattern: z.string(),
        flags: z.string().default('g'),
        replacement: z.string().default(''),
        enabled: z.boolean().default(true),
    }),
    z.object({
        type: z.literal('remove'),
        pattern: z.string(),
        flags: z.string().default('g'),
        enabled: z.boolean().default(true),
    }),
    z.object({
        type: z.literal('strip'),
        begin: z.string().min(1),
        end: z.string().min(1),
        keep: z.boolean().default(false),
        enabled: z.boolean().default(true),
    }),
]);

export const bridgeConfigSchema = z.object({
    server: z.object({
        port: z.number().int().min(1024).max(65535).default(9510),
        host: z.string().default('127.0.0.1'),
    }).default({}),
    extension: z.object({
        wsPort: z.number().int().min(1024).max(65535).default(9500),
    }).default({}),
    onebot: z.object({
        url: z.string().default('ws://127.0.0.1:3001'),
        token: z.string().default(''),
    }).default({}),
    trigger: z.object({
        atOnly: z.boolean().default(false),
        privateReply: z.boolean().default(true),
        allowedUsers: z.array(z.number().int()).default([]),
        allowedGroups: z.array(z.number().int()).default([]),
    }).default({}),
    limits: z.object({
        maxMessageLength: z.number().int().min(100).max(10000).default(2000),
    }).default({}),
    defaults: z.object({
        character: z.string().default(''),
        world: z.string().default(''),
    }).default({}),
    segmentation: segmentationSchema.default({}),
    imageReplies: z.object({
        enabled: z.boolean().default(true),
        instruction: z.boolean().default(true),
        baseUrl: z.string().default(''),
    }).default({}),
    replyProcessors: z.array(processorRuleSchema).default([]),
    stDataDir: z.string().default(''),
});

export type BridgeConfigParsed = z.infer<typeof bridgeConfigSchema>;

/** 解析配置，失败时抛出带路径的详细错误 */
export function parseConfig(raw: unknown): BridgeConfigParsed {
    return bridgeConfigSchema.parse(raw);
}

/** 安全解析：失败时返回默认值 + 错误列表 */
export function safeParseConfig(raw: unknown): {
    config: BridgeConfigParsed;
    errors: string[];
} {
    const result = bridgeConfigSchema.safeParse(raw);
    if (result.success) {
        return { config: result.data, errors: [] };
    }
    const errors = result.error.issues.map(
        (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    return {
        config: bridgeConfigSchema.parse({}),
        errors,
    };
}

export const sessionChoiceSchema = z.object({
    character: z.string().optional(),
    world: z.string().optional(),
    replyProcessors: z.array(processorRuleSchema).optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
});

export const sessionsFileSchema = z.record(z.string(), sessionChoiceSchema);
