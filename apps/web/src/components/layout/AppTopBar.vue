<script setup lang="ts">
import { computed } from 'vue';
import {
    LayoutDashboard, Server, Users, Scissors, Image, Terminal, SlidersHorizontal,
    Sun, Moon, Radio, Boxes,
} from 'lucide-vue-next';
import { useThemeStore } from '@/stores/theme';
import { useStatusStore } from '@/stores/status';

interface Props {
    title: string;
    desc: string;
    icon: string;
}
const props = defineProps<Props>();

const theme = useThemeStore();
const status = useStatusStore();

const iconMap: Record<string, unknown> = {
    LayoutDashboard, Server, Users, Scissors, Image, Terminal, SlidersHorizontal,
};
const iconComp = computed(() => iconMap[props.icon] ?? LayoutDashboard);

const onebotOnline = computed(() => status.onebotConnected);
const extOnline = computed(() => (status.status?.stClients ?? 0) > 0);
</script>

<template>
    <header class="ui-glass z-30 flex min-h-[60px] shrink-0 items-center gap-3 px-4 md:px-6">
        <!-- 页面标识 -->
        <div class="flex min-w-0 items-center gap-2.5">
            <component :is="iconComp" class="size-[18px] shrink-0 text-primary" />
            <div class="min-w-0">
                <h1 class="truncate text-[15px] font-semibold tracking-tight">{{ title }}</h1>
                <p class="hidden truncate text-[11px] text-muted-foreground md:block">{{ desc }}</p>
            </div>
        </div>

        <div class="flex-1" />

        <!-- 状态胶囊（自绘，非 badge 组件风格） -->
        <div class="hidden items-center gap-2 md:flex">
            <div
                class="flex items-center gap-1.5 rounded-full border border-border/70 bg-card/60 px-2.5 py-1"
                :title="onebotOnline ? 'SnowLuma 上游已连接' : 'SnowLuma 上游未连接'"
            >
                <span
                    :class="[
                        'size-1.5 rounded-full',
                        onebotOnline ? 'bg-success animate-pulse' : 'bg-destructive',
                    ]"
                />
                <Radio class="size-3 text-muted-foreground" />
                <span class="text-[11px] font-medium tabular-nums">
                    {{ onebotOnline ? status.status?.selfId || '在线' : '离线' }}
                </span>
            </div>

            <div
                class="flex items-center gap-1.5 rounded-full border border-border/70 bg-card/60 px-2.5 py-1"
                :title="extOnline ? '酒馆扩展已接入' : '酒馆扩展未接入'"
            >
                <span
                    :class="[
                        'size-1.5 rounded-full',
                        extOnline ? 'bg-aurora animate-pulse' : 'bg-muted-foreground/50',
                    ]"
                />
                <Boxes class="size-3 text-muted-foreground" />
                <span class="text-[11px] font-medium tabular-nums">
                    酒馆 {{ status.status?.stClients ?? 0 }}
                </span>
            </div>
        </div>

        <!-- 分隔 -->
        <div class="hidden h-5 w-px bg-border md:block" />

        <!-- 主题切换 -->
        <button
            class="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            :title="theme.isDark ? '切换到亮色' : '切换到暗色'"
            @click="theme.toggle()"
        >
            <component :is="theme.isDark ? Sun : Moon" class="size-4" />
        </button>
    </header>
</template>
