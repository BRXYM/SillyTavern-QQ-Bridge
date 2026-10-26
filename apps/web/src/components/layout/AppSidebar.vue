<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
    LayoutDashboard, Server, Users, Scissors, Image, Terminal, SlidersHorizontal,
    BrainCircuit, PanelLeftClose, PanelLeftOpen,
} from 'lucide-vue-next';
import { cn } from '@/lib/utils';
import type { NavMeta } from '@/router';

interface Props {
    collapsed: boolean;
}
defineProps<Props>();
const emit = defineEmits<{ toggle: [] }>();

const route = useRoute();
const router = useRouter();

const iconMap: Record<string, unknown> = {
    LayoutDashboard, Server, Users, Scissors, Image, Terminal, SlidersHorizontal, BrainCircuit,
};

/** 按 group 聚合，保留出现顺序 */
const groups = computed(() => {
    const map = new Map<string, Array<{ name: string; path: string; meta: NavMeta; icon: unknown }>>();
    for (const r of router.getRoutes()) {
        const meta = r.meta as unknown as NavMeta;
        if (!meta?.title || !r.name) continue;
        const item = {
            name: String(r.name),
            path: r.path,
            meta,
            icon: iconMap[meta.icon] ?? LayoutDashboard,
        };
        if (!map.has(meta.group)) map.set(meta.group, []);
        map.get(meta.group)!.push(item);
    }
    return [...map.entries()];
});

const activeName = computed(() => String(route.name ?? ''));
</script>

<template>
    <div class="flex h-full flex-col overflow-hidden bg-sidebar">
        <!-- 品牌区：渐变方块 + 双行标题 -->
        <div
            :class="cn(
                'flex h-[68px] shrink-0 items-center',
                collapsed ? 'justify-center' : 'px-3',
            )"
        >
            <div :class="cn('grid shrink-0 place-items-center', collapsed ? '' : 'w-9')">
                <div class="ui-gradient flex size-9 items-center justify-center rounded-xl shadow-sm">
                    <span class="text-[13px] font-bold tracking-tight text-white">SL</span>
                </div>
            </div>
            <div v-if="!collapsed" class="min-w-0 flex-1 overflow-hidden pr-1">
                <div class="flex items-baseline gap-1.5 whitespace-nowrap">
                    <span class="text-[13px] font-bold tracking-tight">SnowLuma Bridge</span>
                </div>
                <span class="block whitespace-nowrap text-[11px] text-muted-foreground">
                    QQ ↔ 酒馆 · 桥接中枢
                </span>
            </div>
        </div>

        <!-- 分组导航 -->
        <nav
            :class="cn(
                'flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden pb-3',
                collapsed ? 'px-2' : 'px-2.5',
            )"
        >
            <div v-for="[group, items] in groups" :key="group">
                <!-- 分组标题（收起时显示分隔线） -->
                <div v-if="!collapsed" class="ui-section-label px-2 pb-1 pt-3">{{ group }}</div>
                <div v-else class="mx-auto my-2 h-px w-6 bg-sidebar-border" />

                <RouterLink
                    v-for="item in items"
                    :key="item.name"
                    :to="item.path"
                    :class="cn(
                        'group relative flex items-center rounded-[10px] py-2 text-[13px] font-medium',
                        'transition-colors',
                        collapsed ? 'justify-center' : 'gap-2',
                        activeName === item.name
                            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                            : 'text-muted-foreground hover:bg-sidebar-accent/45 hover:text-foreground',
                    )"
                >
                    <!-- 图标：渐变小方块（激活时） -->
                    <span :class="cn('grid shrink-0 place-items-center', collapsed ? '' : 'w-10')">
                        <span
                            :class="cn(
                                'flex size-6 items-center justify-center rounded-md transition-colors',
                                activeName === item.name ? 'ui-gradient text-white' : 'text-current',
                            )"
                        >
                            <component :is="item.icon" class="size-[15px]" />
                        </span>
                    </span>

                    <span
                        v-if="!collapsed"
                        class="min-w-0 flex-1 truncate pr-2"
                    >
                        {{ item.meta.title }}
                    </span>

                    <!-- 右侧活跃点 -->
                    <span
                        v-if="activeName === item.name && !collapsed"
                        class="mr-2 size-1.5 shrink-0 rounded-full bg-primary"
                    />
                </RouterLink>
            </div>
        </nav>

        <div class="shrink-0 border-t border-sidebar-border p-2.5">
            <button
                class="flex w-full items-center justify-center rounded-lg py-2 text-muted-foreground transition-colors hover:bg-sidebar-accent/45 hover:text-foreground"
                @click="emit('toggle')"
            >
                <component :is="collapsed ? PanelLeftOpen : PanelLeftClose" class="size-4" />
            </button>
        </div>
    </div>
</template>
