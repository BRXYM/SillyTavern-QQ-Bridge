<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, nextTick, watch } from 'vue';
import { Terminal, Trash2, ArrowDown, Sparkles, CheckCircle2, AlertTriangle } from 'lucide-vue-next';
import { useStatusStore } from '@/stores/status';
import UiCard from '@/components/ui/UiCard.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiBadge from '@/components/ui/UiBadge.vue';
import { cn } from '@/lib/utils';

const store = useStatusStore();
const autoScroll = ref(true);
const logBox = ref<HTMLElement | null>(null);
const search = ref('');

onMounted(() => {
    store.startPolling();
});

onUnmounted(() => {
    store.stopPolling();
});

const logs = computed(() => {
    const all = (store.status as unknown as { logs?: string[] })?.logs ?? [];
    return search.value
        ? all.filter((l) => l.toLowerCase().includes(search.value.toLowerCase()))
        : all;
});

function levelOf(line: string): 'error' | 'warn' | 'success' | 'info' | 'debug' {
    if (/\bERROR\b|✗|失败/.test(line)) return 'error';
    if (/\bWARN\b|⚠/.test(line)) return 'warn';
    if (/\bOK\b|✓|成功/.test(line)) return 'success';
    if (/\[EXT\]|\[HTTP\]/.test(line)) return 'debug';
    return 'info';
}

// ---------------- 表情预演 ----------------
interface FaceDetail {
    token: string;
    ok: boolean;
    mode?: 'id' | 'tag';
    tags?: string[];
    picked?: string;
    pickedTags?: string[];
    score?: number;
    hitTags?: string[];
    totalScored?: number;
    excluded?: number;
    reason?: string;
    candidates?: Array<{ md5: string; score: number; hitTags: string[]; caption: string }>;
}

interface PreviewResult {
    ok: boolean;
    input: string;
    hasMark: boolean;
    tokens: string[];
    images: number;
    details: FaceDetail[];
    segments: Array<{ type: string; text?: string }>;
    library: string;
    verdict: string;
    error?: string;
}

const previewText = ref('这也太惨了，早点休息吧[表情:疲惫]');
const previewLoading = ref(false);
const previewResult = ref<PreviewResult | null>(null);

/** 快速样例，覆盖命中/未命中/多发/纯文本四种情况 */
const previewSamples = [
    '这也太惨了[表情:疲惫]',
    '恭喜恭喜！[表情:得意,猫]',
    '哈哈哈[表情:得意]',
    '怎么会这样[表情:不存在的词]',
    '这个报错通常是端口占用',
];

async function runPreview() {
    previewLoading.value = true;
    try {
        const res = await fetch('/api/faces/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: previewText.value }),
        });
        previewResult.value = await res.json();
    } catch (e) {
        previewResult.value = {
            ok: false,
            input: previewText.value,
            hasMark: false,
            tokens: [],
            images: 0,
            details: [],
            segments: [],
            library: '',
            verdict: '',
            error: e instanceof Error ? e.message : String(e),
        };
    } finally {
        previewLoading.value = false;
    }
}


const levelClass = (lvl: string) =>
    ({
        error: 'text-log-error',
        warn: 'text-log-warn',
        success: 'text-log-success',
        info: 'text-log-info',
        debug: 'text-log-debug',
    })[lvl] ?? 'text-foreground';

watch(
    () => logs.value.length,
    async () => {
        if (!autoScroll.value) return;
        await nextTick();
        if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight;
    },
);

function clearView() {
    search.value = '';
}
</script>

<template>
    <div class="flex flex-col gap-4">
        <UiCard>
            <div class="flex flex-wrap items-center gap-3 border-b border-border/60 px-5 py-3">
                <div class="flex items-center gap-2">
                    <Terminal class="size-4 text-primary" />
                    <span class="text-sm font-semibold tracking-tight">运行日志</span>
                    <UiBadge tone="outline" class="tabular-nums">{{ logs.length }} 条</UiBadge>
                </div>

                <div class="flex-1" />

                <input
                    v-model="search"
                    placeholder="筛选…"
                    class="h-8 w-40 rounded-md border border-border bg-transparent px-2 text-xs outline-none focus-visible:border-ring"
                />
                <UiButton
                    :variant="autoScroll ? 'secondary' : 'ghost'"
                    size="sm"
                    @click="autoScroll = !autoScroll"
                >
                    <ArrowDown class="size-4" />
                    自动滚动
                </UiButton>
                <UiButton variant="ghost" size="sm" @click="clearView">
                    <Trash2 class="size-4" />
                    清空筛选
                </UiButton>
            </div>

            <div
                ref="logBox"
                class="h-[calc(100dvh-260px)] min-h-80 overflow-y-auto bg-background/50 px-4 py-3 font-mono text-xs leading-relaxed"
            >
                <div v-if="logs.length === 0" class="py-10 text-center text-muted-foreground">
                    暂无日志
                </div>
                <div
                    v-for="(line, i) in logs"
                    :key="i"
                    :class="cn('whitespace-pre-wrap break-all', levelClass(levelOf(line)))"
                >
                    {{ line }}
                </div>
            </div>
        </UiCard>

        <!-- ============ 表情预演 ============ -->
        <UiCard>
            <div class="flex flex-wrap items-center gap-3 border-b border-border/60 px-5 py-3">
                <div class="flex items-center gap-2">
                    <Sparkles class="size-4 text-primary" />
                    <span class="text-sm font-semibold tracking-tight">表情预演</span>
                    <span class="text-[11px] text-muted-foreground">
                        把 AI 的回复粘进来，看表情会被解析成什么（不会真的发 QQ）
                    </span>
                </div>
            </div>

            <div class="flex flex-col gap-3 px-5 py-4">
                <div class="flex flex-wrap items-center gap-2">
                    <input
                        v-model="previewText"
                        placeholder="例如：这也太惨了，早点休息吧[表情:疲惫]"
                        class="h-9 min-w-64 flex-1 rounded-md border border-border bg-transparent px-3 font-mono text-xs outline-none focus-visible:border-ring"
                        @keyup.enter="runPreview"
                    />
                    <UiButton size="sm" :disabled="previewLoading" @click="runPreview">
                        {{ previewLoading ? '解析中…' : '预演' }}
                    </UiButton>
                </div>

                <div class="flex flex-wrap gap-1.5">
                    <button
                        v-for="s in previewSamples"
                        :key="s"
                        class="rounded-full bg-accent/40 px-2.5 py-1 text-[11px] transition-colors hover:bg-accent"
                        @click="previewText = s; runPreview()"
                    >
                        {{ s }}
                    </button>
                </div>

                <div v-if="previewResult" class="rounded-lg border border-border/60">
                    <div
                        class="flex items-center gap-2 border-b border-border/50 px-3 py-2 text-xs"
                        :class="previewResult.images > 0 ? 'bg-success/10' : 'bg-warning/10'"
                    >
                        <component
                            :is="previewResult.images > 0 ? CheckCircle2 : AlertTriangle"
                            class="size-3.5 shrink-0"
                            :class="previewResult.images > 0 ? 'text-success' : 'text-warning'"
                        />
                        <span class="font-medium">{{ previewResult.verdict }}</span>
                        <span class="ml-auto font-mono text-[10px] text-muted-foreground">
                            库：{{ previewResult.library }}
                        </span>
                    </div>

                    <div v-if="previewResult.details.length" class="divide-y divide-border/40">
                        <div
                            v-for="(d, i) in previewResult.details"
                            :key="i"
                            class="px-3 py-2.5 text-[11px]"
                        >
                            <div class="flex flex-wrap items-center gap-2">
                                <span
                                    :class="d.ok ? 'text-success' : 'text-destructive'"
                                    class="font-mono"
                                >
                                    {{ d.ok ? '✓' : '✗' }}
                                </span>
                                <span class="font-mono">[表情:{{ d.token }}]</span>
                                <UiBadge :tone="d.mode === 'id' ? 'info' : 'outline'" class="text-micro">
                                    {{ d.mode === 'id' ? '短 ID' : '标签' }}
                                </UiBadge>

                                <template v-if="d.ok">
                                    <span class="text-muted-foreground">→</span>
                                    <span class="font-mono text-primary">{{ d.picked }}</span>
                                    <span v-if="d.pickedTags" class="text-muted-foreground">
                                        [{{ d.pickedTags.join('/') }}]
                                    </span>
                                    <UiBadge v-if="d.score !== undefined" tone="success" class="text-micro">
                                        分 {{ d.score }}
                                    </UiBadge>
                                    <span v-if="d.hitTags?.length" class="text-[10px] text-muted-foreground">
                                        命中 {{ d.hitTags.join(' ') }}
                                    </span>
                                </template>

                                <span v-else class="text-destructive">{{ d.reason }}</span>
                            </div>

                            <div
                                v-if="d.candidates && d.candidates.length"
                                class="mt-1.5 flex flex-col gap-0.5 pl-5 text-[10px] text-muted-foreground"
                            >
                                <div v-for="c in d.candidates" :key="c.md5">
                                    {{ c.md5 }} · 分 {{ c.score }} · {{ c.hitTags.join(' ') }}
                                    <span v-if="c.caption" class="opacity-70">「{{ c.caption }}」</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div v-else class="px-3 py-2.5 text-[11px] text-muted-foreground">
                        文本里没有表情标记，会按纯文本发送。
                    </div>

                    <div class="flex flex-wrap items-center gap-1.5 border-t border-border/50 px-3 py-2">
                        <span class="text-[10px] text-muted-foreground">最终发送：</span>
                        <span
                            v-for="(s, i) in previewResult.segments"
                            :key="i"
                            class="rounded px-1.5 py-0.5 text-[10px]"
                            :class="s.type === 'text' ? 'bg-accent/50' : 'bg-info/20 text-info'"
                        >
                            {{ s.type === 'text' ? `文字「${(s.text ?? '').slice(0, 20)}」` : '图片' }}
                        </span>
                    </div>
                </div>
            </div>
        </UiCard>
    </div>
</template>
