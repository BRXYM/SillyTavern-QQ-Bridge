<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import {
    CheckCircle2, AlertTriangle, XCircle, Info, X,
} from 'lucide-vue-next';
import { useToastStore, type ToastItem, type ToastTone } from '@/stores/toast';
import { cn } from '@/lib/utils';

const store = useToastStore();

const iconMap: Record<ToastTone, unknown> = {
    default: Info,
    success: CheckCircle2,
    warning: AlertTriangle,
    error: XCircle,
    info: Info,
};

const toneIconClass: Record<ToastTone, string> = {
    default: 'text-muted-foreground',
    success: 'text-success',
    warning: 'text-warning',
    error: 'text-destructive',
    info: 'text-info',
};

const barClass: Record<ToastTone, string> = {
    default: 'bg-muted-foreground/60',
    success: 'bg-success',
    warning: 'bg-warning',
    error: 'bg-destructive',
    info: 'bg-info',
};

const borderClass: Record<ToastTone, string> = {
    default: 'border-border/70',
    success: 'border-success/35',
    warning: 'border-warning/35',
    error: 'border-destructive/40',
    info: 'border-info/35',
};

/** 每条 toast 的进度：0..1 */
const progress = ref<Record<number, number>>({});
const timers = new Map<number, number>();
const tickers = new Map<number, number>();

function clearTimers(id: number) {
    const t = timers.get(id);
    if (t) { window.clearTimeout(t); timers.delete(id); }
    const tk = tickers.get(id);
    if (tk) { window.clearInterval(tk); tickers.delete(tk); }
}

function start(item: ToastItem) {
    clearTimers(item.id);
    const remaining = item.paused ? item.remaining : item.duration;
    progress.value[item.id] = 1 - remaining / item.duration;

    // 进度条平滑推进
    const started = Date.now();
    const startP = progress.value[item.id] ?? 0;
    const ticker = window.setInterval(() => {
        if (item.paused) return;
        const elapsed = Date.now() - started;
        const p = startP + elapsed / item.duration;
        progress.value[item.id] = Math.min(1, p);
    }, 50);
    tickers.set(item.id, ticker);

    const timer = window.setTimeout(() => {
        progress.value[item.id] = 1;
        store.dismiss(item.id);
        clearTimers(item.id);
        delete progress.value[item.id];
    }, remaining);
    timers.set(item.id, timer);
}

function onEnter(item: ToastItem) {
    store.pause(item.id);
    clearTimers(item.id);
}

function onLeave(item: ToastItem) {
    store.resume(item.id);
    start(item);
}

function close(item: ToastItem) {
    clearTimers(item.id);
    store.dismiss(item.id);
}

// 监听新增项（用 watch on items 长度变化）
import { watch } from 'vue';
watch(
    () => store.items.map((i) => i.id),
    (ids, prev) => {
        const prevSet = new Set(prev ?? []);
        for (const id of ids) {
            if (!prevSet.has(id)) {
                const item = store.items.find((x) => x.id === id);
                if (item) start(item);
            }
        }
        // 清理已移除项
        for (const id of prevSet) {
            if (!ids.includes(id)) {
                clearTimers(id);
                delete progress.value[id];
            }
        }
    },
    { immediate: true },
);

onUnmounted(() => {
    for (const id of timers.keys()) clearTimers(id);
});

const list = computed(() => store.items);
</script>

<template>
    <!-- 右上角通知栈 -->
    <div class="pointer-events-none fixed right-4 top-4 z-[100] flex w-[340px] max-w-[calc(100vw-2rem)] flex-col gap-2">
        <TransitionGroup
            enter-active-class="transition duration-200 ease-out"
            enter-from-class="opacity-0 translate-x-4"
            enter-to-class="opacity-100 translate-x-0"
            leave-active-class="transition duration-150 ease-in"
            leave-from-class="opacity-100 translate-x-0"
            leave-to-class="opacity-0 translate-x-6"
            move-class="transition-transform duration-200"
        >
            <div
                v-for="item in list"
                :key="item.id"
                class="pointer-events-auto overflow-hidden rounded-xl border bg-popover shadow-[0_10px_34px_-14px_rgb(0_0_0/0.3)] ring-1 ring-black/[0.03] dark:ring-white/[0.06]"
                :class="borderClass[item.tone]"
                @mouseenter="onEnter(item)"
                @mouseleave="onLeave(item)"
            >
                <div class="flex items-start gap-2.5 px-3.5 pb-2.5 pt-3">
                    <component
                        :is="iconMap[item.tone]"
                        class="mt-0.5 size-4 shrink-0"
                        :class="toneIconClass[item.tone]"
                    />
                    <div class="min-w-0 flex-1">
                        <p class="text-[12.5px] font-semibold leading-snug tracking-tight">
                            {{ item.title }}
                        </p>
                        <p
                            v-if="item.description"
                            class="mt-0.5 break-words text-[11.5px] leading-relaxed text-muted-foreground"
                        >
                            {{ item.description }}
                        </p>
                    </div>
                    <button
                        class="-mr-1 -mt-0.5 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
                        @click="close(item)"
                    >
                        <X class="size-3.5" />
                    </button>
                </div>

                <!-- 进度条：从左到右走满后消失 -->
                <div class="h-[3px] w-full bg-border/40">
                    <div
                        class="h-full transition-[width] duration-75 ease-linear"
                        :class="barClass[item.tone]"
                        :style="{ width: `${(progress[item.id] ?? 0) * 100}%` }"
                    />
                </div>
            </div>
        </TransitionGroup>
    </div>
</template>
