<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue';
import {
    Activity, Users, MessageSquare, Wifi, Radio, Boxes, ArrowUpRight, Zap, Bell,
} from 'lucide-vue-next';
import { useStatusStore } from '@/stores/status';
import { useToastStore } from '@/stores/toast';
import UiCard from '@/components/ui/UiCard.vue';
import UiBadge from '@/components/ui/UiBadge.vue';
import UiButton from '@/components/ui/UiButton.vue';
import { formatTime } from '@/lib/utils';

const store = useStatusStore();
const toast = useToastStore();

onMounted(() => {
    store.startPolling();
});
onUnmounted(() => {
    store.stopPolling();
});

const sessions = computed(() => Object.entries(store.status?.sessions ?? {}));
const sessionCount = computed(() => sessions.value.length);
const totalIn = computed(() => sessions.value.reduce((n, [, s]) => n + s.in, 0));
const totalOut = computed(() => sessions.value.reduce((n, [, s]) => n + s.out, 0));

const charCount = computed(() => store.status?.catalogs.characters.length ?? 0);
const worldCount = computed(() => store.status?.catalogs.worlds.length ?? 0);

const health = computed(() => {
    let score = 0;
    if (store.onebotConnected) score += 45;
    if ((store.status?.stClients ?? 0) > 0) score += 35;
    if (sessionCount.value > 0) score += 20;
    return score;
});
const healthLabel = computed(() =>
    health.value >= 95 ? '运行良好' : health.value >= 60 ? '部分就绪' : '未就绪',
);

const R = 26;
const CIRC = 2 * Math.PI * R;
const dashArray = computed(() => `${(health.value / 100) * CIRC} ${CIRC}`);

const recent = computed(() =>
    [...sessions.value].sort((a, b) => b[1].last - a[1].last).slice(0, 6),
);

const chipTone = (k: string) => (k.startsWith('group_') ? 'warning' : 'info');

function demoToast() {
    toast.success('已保存设置', '分段规则已更新，立即生效');
    toast.info('会话已同步', '角色与世界书绑定已同步');
    toast.warning('上游连接不稳定', 'SnowLuma 在 30 秒内断开了 2 次');
}

async function retry() {
    await store.refresh();
    if (store.reachable) toast.success('已恢复连接', '后端服务正常');
    else toast.error('仍然无法连接', store.error ?? '请检查后端是否启动');
}
</script>

<template>
    <div class="flex flex-col gap-5">
        <!-- Hero 渐变条 + 健康环 -->
        <div class="grid gap-4 lg:grid-cols-[1fr_240px]">
            <div class="ui-gradient ui-lift relative overflow-hidden rounded-2xl px-5 py-4 text-white">
                <div class="relative z-10 flex h-full flex-col justify-center gap-3">
                    <div class="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-white/65">
                        <Zap class="size-3" />
                        Bridge Runtime
                    </div>

                    <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <h2 class="text-[20px] font-bold leading-tight tracking-tight">{{ healthLabel }}</h2>
                        <span class="text-[12px] text-white/75">
                            {{ sessionCount }} 会话 · 收 {{ totalIn }} / 发 {{ totalOut }}
                        </span>
                    </div>

                    <div class="flex flex-wrap gap-1.5">
                        <div class="flex items-center gap-1.5 rounded-full bg-white/15 px-2 py-[3px]">
                            <Radio class="size-3" />
                            <span class="text-[10.5px] font-medium">
                                SnowLuma {{ store.onebotConnected ? '在线' : '离线' }}
                            </span>
                        </div>
                        <div class="flex items-center gap-1.5 rounded-full bg-white/15 px-2 py-[3px]">
                            <Boxes class="size-3" />
                            <span class="text-[10.5px] font-medium">
                                酒馆 {{ store.status?.stClients ?? 0 }}
                            </span>
                        </div>
                        <div v-if="store.status?.selfId" class="flex items-center gap-1.5 rounded-full bg-white/15 px-2 py-[3px]">
                            <span class="text-[10.5px] font-medium tabular-nums">{{ store.status.selfId }}</span>
                        </div>
                    </div>
                </div>

                <div class="pointer-events-none absolute -right-12 -top-14 size-48 rounded-full bg-white/10 blur-2xl" />
                <div class="pointer-events-none absolute -bottom-16 right-20 size-36 rounded-full bg-white/[0.08] blur-2xl" />
            </div>

            <UiCard class="flex items-center gap-3 px-4 py-4">
                <div class="relative grid shrink-0 place-items-center">
                    <svg width="68" height="68" viewBox="0 0 68 68" class="-rotate-90">
                        <circle cx="34" cy="34" :r="R" fill="none" stroke="currentColor" stroke-width="7" class="text-muted/80" />
                        <circle
                            cx="34" cy="34" :r="R" fill="none" stroke="url(#hg)" stroke-width="7"
                            stroke-linecap="round" :stroke-dasharray="dashArray"
                            class="transition-[stroke-dasharray] duration-500 ease-out"
                        />
                        <defs>
                            <linearGradient id="hg" x1="0" y1="0" x2="1" y2="1">
                                <stop offset="0%" stop-color="oklch(58% 0.19 288)" />
                                <stop offset="100%" stop-color="oklch(72% 0.13 195)" />
                            </linearGradient>
                        </defs>
                    </svg>
                    <div class="absolute flex flex-col items-center">
                        <span class="text-[17px] font-bold leading-none tabular-nums">{{ health }}</span>
                    </div>
                </div>

                <div class="min-w-0 flex-1">
                    <p class="ui-section-label">健康度</p>
                    <p class="mt-1 text-[12px] leading-snug text-muted-foreground">
                        上游 {{ store.onebotConnected ? '✓' : '✗' }}
                        <span class="mx-0.5 opacity-40">·</span>
                        扩展 {{ (store.status?.stClients ?? 0) > 0 ? '✓' : '✗' }}
                        <span class="mx-0.5 opacity-40">·</span>
                        会话 {{ sessionCount > 0 ? '✓' : '✗' }}
                    </p>
                </div>
            </UiCard>
        </div>

        <!-- 三列指标 -->
        <div class="grid gap-4 sm:grid-cols-3">
            <UiCard class="ui-lift p-4">
                <div class="flex items-start justify-between">
                    <div>
                        <p class="ui-section-label">活跃会话</p>
                        <p class="mt-1.5 text-[22px] font-bold leading-none tabular-nums">{{ sessionCount }}</p>
                        <p class="mt-1 text-[11px] text-muted-foreground">QQ 用户 / 群聊</p>
                    </div>
                    <div class="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
                        <Users class="size-4" />
                    </div>
                </div>
            </UiCard>

            <UiCard class="ui-lift p-4">
                <div class="flex items-start justify-between">
                    <div>
                        <p class="ui-section-label">消息吞吐</p>
                        <p class="mt-1.5 text-[22px] font-bold leading-none tabular-nums">
                            {{ totalIn }}<span class="mx-1 text-[13px] font-normal text-muted-foreground">/</span>{{ totalOut }}
                        </p>
                        <p class="mt-1 text-[11px] text-muted-foreground">接收 / 发送</p>
                    </div>
                    <div class="flex size-9 items-center justify-center rounded-xl bg-aurora/15 text-aurora">
                        <Activity class="size-4" />
                    </div>
                </div>
            </UiCard>

            <UiCard class="ui-lift p-4">
                <div class="flex items-start justify-between">
                    <div>
                        <p class="ui-section-label">角色 / 世界书</p>
                        <p class="mt-1.5 text-[22px] font-bold leading-none tabular-nums">
                            {{ charCount }}<span class="mx-1 text-[13px] font-normal text-muted-foreground">/</span>{{ worldCount }}
                        </p>
                        <p class="mt-1 text-[11px] text-muted-foreground">已加载资源</p>
                    </div>
                    <div class="flex size-9 items-center justify-center rounded-xl bg-info/10 text-info">
                        <MessageSquare class="size-4" />
                    </div>
                </div>
            </UiCard>
        </div>

        <!-- 最近活跃 -->
        <UiCard>
            <div class="flex items-center justify-between border-b border-border/60 px-5 py-3.5">
                <div>
                    <h2 class="text-[13px] font-semibold tracking-tight">最近活跃</h2>
                    <p class="text-[11px] text-muted-foreground">按最后消息时间排序</p>
                </div>
                <div class="flex items-center gap-2">
                    <UiButton variant="ghost" size="sm" @click="demoToast">
                        <Bell class="size-3.5" />
                        测试通知
                    </UiButton>
                    <RouterLink
                        to="/sessions"
                        class="flex items-center gap-1 text-[11px] font-medium text-primary transition-opacity hover:opacity-80"
                    >
                        全部会话
                        <ArrowUpRight class="size-3" />
                    </RouterLink>
                </div>
            </div>

            <div v-if="recent.length === 0" class="px-5 py-12 text-center">
                <Wifi class="mx-auto size-7 text-muted-foreground/30" />
                <p class="mt-2 text-[13px] text-muted-foreground">暂无会话</p>
                <p class="text-[11px] text-muted-foreground/70">QQ 发消息后会自动出现</p>
            </div>

            <div v-else class="divide-y divide-border/50">
                <div
                    v-for="[key, stat] in recent"
                    :key="key"
                    class="flex items-center gap-3 px-5 py-2.5 transition-colors hover:bg-accent/25"
                >
                    <UiBadge :tone="chipTone(key)" class="shrink-0 font-mono text-micro">
                        {{ key.startsWith('group_') ? '群' : '私' }}
                    </UiBadge>
                    <div class="min-w-0 flex-1">
                        <p class="truncate font-mono text-[12px] leading-tight">{{ key }}</p>
                        <p class="mt-0.5 truncate text-[11px]">
                            <span v-if="store.status?.sessionChoices[key]?.character" class="text-primary">
                                {{ store.status.sessionChoices[key].character }}
                            </span>
                            <span v-else class="text-muted-foreground/70">继承默认角色</span>
                        </p>
                    </div>
                    <div class="shrink-0 text-right">
                        <p class="text-[11px] tabular-nums text-muted-foreground">
                            收 {{ stat.in }} · 发 {{ stat.out }}
                        </p>
                        <p class="text-[10px] tabular-nums text-muted-foreground/70">
                            {{ formatTime(new Date(stat.last).toISOString()) }}
                        </p>
                    </div>
                </div>
            </div>
        </UiCard>

        <UiCard v-if="store.error" class="border-destructive/40 bg-destructive/5">
            <div class="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                <div class="min-w-0">
                    <p class="text-[13px] font-medium text-destructive">后端连接失败</p>
                    <p class="mt-1 break-words text-[11px] text-muted-foreground">{{ store.error }}</p>
                    <p class="mt-1 text-[11px] text-muted-foreground/70">
                        正在自动重试（间隔逐步拉长至 30 秒）
                    </p>
                </div>
                <UiButton variant="outline" size="sm" :disabled="store.loading" @click="retry">
                    {{ store.loading ? '重试中…' : '立即重试' }}
                </UiButton>
            </div>
        </UiCard>
    </div>
</template>
