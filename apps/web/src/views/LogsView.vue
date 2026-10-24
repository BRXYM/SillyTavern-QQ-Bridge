<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, nextTick, watch } from 'vue';
import { Terminal, Trash2, ArrowDown } from 'lucide-vue-next';
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
    </div>
</template>
