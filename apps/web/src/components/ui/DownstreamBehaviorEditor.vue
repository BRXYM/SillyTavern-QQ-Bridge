<script setup lang="ts">
/**
 * 下游「配置」的行为设置编辑器。
 *
 * 为什么独立成组件：这些设置从「下游管理」搬到了「会话管理」，
 * 而会话页那边是按「下游实例 + 配置」的层级展示的，需要复用同一套表单。
 *
 * 边界：只关心「下游怎么说话」（提示词、历史引用、进度转发），
 * 不关心「怎么连上它」（路径、端口、服务、插件）—— 后者留在下游管理页。
 */
import { computed, reactive, watch } from 'vue';
import { MessageSquare, Activity, Plus, Trash2 } from 'lucide-vue-next';
import UiBadge from '@/components/ui/UiBadge.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiInput from '@/components/ui/UiInput.vue';
import UiSwitch from '@/components/ui/UiSwitch.vue';

/** 提示词开关项 */
export interface PromptState {
    qqBase: boolean;
    character: boolean;
    faces: boolean;
    images: boolean;
    extra: string;
}

export interface HistoryRule {
    pattern: string;
    label?: string;
}

export interface ProgressState {
    enabled: boolean;
    minIntervalMs: number;
    maxMessages: number;
    prefix: string;
}

/** 一份配置里与「行为」有关的全部设置 */
export interface BehaviorSettings {
    prompt: PromptState;
    historyExtracts: HistoryRule[];
    progress: ProgressState;
}

interface Props {
    /** 当前设置的快照（由父组件从配置里读出） */
    modelValue: BehaviorSettings;
    /** 目标下游类型：dsh 才有进度转发，酒馆没有 */
    kind: string;
    disabled?: boolean;
}

const props = withDefaults(defineProps<Props>(), { disabled: false });
const emit = defineEmits<{ 'update:modelValue': [value: BehaviorSettings] }>();

/** 提示词开关项（顺序固定：基础 → 人设 → 表情 → 图片） */
const PROMPT_OPTIONS = [
    {
        key: 'qqBase' as const,
        label: 'QQ 聊天约束',
        desc: '要求简短、口语化、不要 Markdown',
    },
    {
        key: 'character' as const,
        label: '角色人设',
        desc: '把会话绑定的角色（含世界书名）告诉下游',
    },
    {
        key: 'faces' as const,
        label: '表情词表',
        desc: '关闭时 AI 不会产出 [表情:标签]',
    },
    {
        key: 'images' as const,
        label: '图片能力',
        desc: '允许用 [图片:URL] 发送网络图片',
    },
] as const;

type PromptKey = (typeof PROMPT_OPTIONS)[number]['key'];

const isDsh = computed(() => props.kind.startsWith('dsh'));
const promptEnabled = computed(
    () => PROMPT_OPTIONS.filter((o) => props.modelValue.prompt[o.key]).length,
);

/** 只改一个字段也要发出完整对象，父组件才好整体保存 */
function patch(next: Partial<BehaviorSettings>): void {
    emit('update:modelValue', { ...props.modelValue, ...next });
}

function setPromptFlag(key: PromptKey, value: boolean): void {
    patch({ prompt: { ...props.modelValue.prompt, [key]: value } });
}

function setPromptExtra(value: string): void {
    patch({ prompt: { ...props.modelValue.prompt, extra: value } });
}

function addHistoryRule(): void {
    patch({
        historyExtracts: [...props.modelValue.historyExtracts, { pattern: '', label: '' }],
    });
}

function removeHistoryRule(idx: number): void {
    patch({
        historyExtracts: props.modelValue.historyExtracts.filter((_, i) => i !== idx),
    });
}

function setHistoryRule(idx: number, p: Partial<HistoryRule>): void {
    patch({
        historyExtracts: props.modelValue.historyExtracts.map((r, i) =>
            i === idx ? { ...r, ...p } : r,
        ),
    });
}

function setProgress(p: Partial<ProgressState>): void {
    patch({ progress: { ...props.modelValue.progress, ...p } });
}
</script>

<template>
    <div class="flex flex-col gap-2">
        <!-- 提示词注入 -->
        <div class="rounded-md border border-border/60 bg-card/40 p-3">
            <div class="flex flex-wrap items-center gap-2">
                <MessageSquare class="size-3.5 text-muted-foreground" />
                <span class="text-xs font-medium">提示词注入</span>
                <UiBadge :tone="promptEnabled > 0 ? 'info' : 'outline'" class="text-micro">
                    {{ promptEnabled > 0 ? `已开 ${promptEnabled} 项` : '全部关闭' }}
                </UiBadge>
            </div>

            <p class="mt-1 text-[10px] text-muted-foreground">
                默认只转发用户原话。打开任意一项后才会把对应内容拼进去
            </p>

            <div class="mt-2 space-y-1.5">
                <label
                    v-for="opt in PROMPT_OPTIONS"
                    :key="opt.key"
                    class="flex items-start justify-between gap-3 rounded border border-border/40 px-2.5 py-1.5"
                >
                    <div class="min-w-0">
                        <p class="text-[11px] font-medium">{{ opt.label }}</p>
                        <p class="text-[10px] text-muted-foreground">{{ opt.desc }}</p>
                    </div>
                    <UiSwitch
                        :model-value="modelValue.prompt[opt.key]"
                        :disabled="disabled"
                        class="shrink-0"
                        @update:model-value="(v: boolean) => setPromptFlag(opt.key, v)"
                    />
                </label>
            </div>

            <div class="mt-2">
                <label class="text-[10px] text-muted-foreground">附加文本（总是最后拼接）</label>
                <textarea
                    :value="modelValue.prompt.extra"
                    rows="2"
                    :disabled="disabled"
                    class="mt-1 w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 font-mono text-[11px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:opacity-50"
                    placeholder="留空 = 不发送，例如：只用短句，不要用敬语"
                    @input="(e: Event) => setPromptExtra((e.target as HTMLTextAreaElement).value)"
                />
            </div>
        </div>

        <!-- 历史引用 -->
        <div v-if="isDsh" class="rounded-md border border-border/60 bg-card/40 p-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="flex items-center gap-2">
                    <span class="text-[11px] font-medium">历史引用</span>
                    <UiBadge
                        :tone="modelValue.historyExtracts.length > 0 ? 'info' : 'outline'"
                        class="text-micro"
                    >
                        {{ modelValue.historyExtracts.length > 0
                            ? `${modelValue.historyExtracts.length} 条规则`
                            : '不发送历史' }}
                    </UiBadge>
                </div>
                <UiButton
                    variant="ghost"
                    size="sm"
                    :disabled="disabled"
                    @click="addHistoryRule"
                >
                    <Plus class="size-3.5" />
                    加规则
                </UiButton>
            </div>

            <p class="mt-1 text-[10px] text-muted-foreground">
                dsh 自己会按 session 保留上下文，所以默认不重发历史。
                这里只在需要引用上一轮片段（表情标签、数值等）时加正则，
                命中的内容以「[参考]」附在本次消息前
            </p>

            <div
                v-for="(rule, idx) in modelValue.historyExtracts"
                :key="idx"
                class="mt-1.5 flex items-center gap-1.5"
            >
                <UiInput
                    :model-value="rule.label ?? ''"
                    placeholder="名称"
                    class="max-w-24"
                    :disabled="disabled"
                    @update:model-value="(v: string) => setHistoryRule(idx, { label: v })"
                />
                <UiInput
                    :model-value="rule.pattern"
                    placeholder="正则，如 \[表情:([^\]]+)\]"
                    mono
                    class="flex-1"
                    :disabled="disabled"
                    @update:model-value="(v: string) => setHistoryRule(idx, { pattern: v })"
                />
                <UiButton
                    variant="ghost"
                    size="sm"
                    :disabled="disabled"
                    @click="removeHistoryRule(idx)"
                >
                    <Trash2 class="size-3.5" />
                </UiButton>
            </div>
        </div>

        <!-- 进度转发 -->
        <div v-if="isDsh" class="rounded-md border border-border/60 bg-card/40 p-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="flex items-center gap-2">
                    <Activity class="size-3.5 text-muted-foreground" />
                    <span class="text-xs font-medium">进度转发</span>
                    <UiBadge :tone="modelValue.progress.enabled ? 'info' : 'outline'" class="text-micro">
                        {{ modelValue.progress.enabled ? '已开启' : '关闭' }}
                    </UiBadge>
                </div>
                <UiSwitch
                    :model-value="modelValue.progress.enabled"
                    :disabled="disabled"
                    class="shrink-0"
                    @update:model-value="(v: boolean) => setProgress({ enabled: v })"
                />
            </div>

            <p class="mt-1 text-[10px] text-muted-foreground">
                把分析摘要（开始处理、读取、搜索等）发到 QQ，让用户知道进行到哪一步。
                默认关闭；开启后会限流，不会刷屏
            </p>

            <div v-if="modelValue.progress.enabled" class="mt-2 grid gap-2 sm:grid-cols-3">
                <div>
                    <label class="text-[10px] text-muted-foreground">最小间隔（毫秒）</label>
                    <UiInput
                        :model-value="String(modelValue.progress.minIntervalMs)"
                        type="number"
                        mono
                        class="mt-1"
                        :disabled="disabled"
                        @update:model-value="(v: string) => setProgress({
                            minIntervalMs: Math.max(0, Number(v) || 0),
                        })"
                    />
                </div>
                <div>
                    <label class="text-[10px] text-muted-foreground">最多几条</label>
                    <UiInput
                        :model-value="String(modelValue.progress.maxMessages)"
                        type="number"
                        mono
                        class="mt-1"
                        :disabled="disabled"
                        @update:model-value="(v: string) => setProgress({
                            maxMessages: Math.max(0, Number(v) || 0),
                        })"
                    />
                </div>
                <div>
                    <label class="text-[10px] text-muted-foreground">消息前缀</label>
                    <UiInput
                        :model-value="modelValue.progress.prefix"
                        class="mt-1"
                        placeholder="⏳ "
                        :disabled="disabled"
                        @update:model-value="(v: string) => setProgress({ prefix: v })"
                    />
                </div>
            </div>
        </div>
    </div>
</template>
