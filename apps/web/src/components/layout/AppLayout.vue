<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import AppSidebar from './AppSidebar.vue';
import AppTopBar from './AppTopBar.vue';
import type { NavMeta } from '@/router';
import { useStatusStore } from '@/stores/status';

const route = useRoute();
const status = useStatusStore();
const collapsed = ref(false);

const meta = computed(() => (route.meta ?? {}) as unknown as NavMeta);
const pageTitle = computed(() => meta.value.title ?? 'SnowLuma Bridge');
const pageDesc = computed(() => meta.value.desc ?? '');
const pageIcon = computed(() => meta.value.icon ?? 'LayoutDashboard');

/**
 * 全局状态同步在这里启动一次，所有页面共享。
 *
 * 之前是各页面自己启停轮询，导致只有总览/日志页在刷新，
 * 切到别的页面后连接状态就停在离开那一刻。
 */
onMounted(() => status.startPolling());
onUnmounted(() => status.stopPolling());
</script>

<template>
    <div class="flex h-dvh w-full max-w-full overflow-hidden bg-sidebar text-foreground">
        <!-- 侧栏 -->
        <aside
            class="relative h-full shrink-0 overflow-hidden transition-[width] duration-300 ease-out"
            :style="{ width: collapsed ? '60px' : '232px' }"
        >
            <div class="h-full w-full overflow-hidden">
                <AppSidebar :collapsed="collapsed" @toggle="collapsed = !collapsed" />
            </div>
        </aside>

        <!-- 主画布：左侧内切 + 光晕背景 -->
        <div
            class="ui-canvas m-0 flex min-w-0 flex-1 flex-col overflow-hidden rounded-tl-[26px] bg-background shadow-[0_0_24px_-8px_rgb(0_0_0/0.16)] dark:shadow-[inset_1px_1px_0_0_rgb(255_255_255/0.03)]"
        >
            <AppTopBar :title="pageTitle" :desc="pageDesc" :icon="pageIcon" />

            <main class="flex min-h-0 flex-1 flex-col">
                <div class="min-h-0 flex-1 overflow-y-auto">
                    <div class="mx-auto w-full max-w-[1440px] px-4 py-5 sm:px-6 sm:py-6">
                        <RouterView v-slot="{ Component }">
                            <Transition
                                enter-active-class="transition duration-[220ms] ease-out"
                                enter-from-class="opacity-0 translate-y-1.5"
                                enter-to-class="opacity-100 translate-y-0"
                                mode="out-in"
                            >
                                <component :is="Component" />
                            </Transition>
                        </RouterView>
                    </div>
                </div>
            </main>
        </div>
    </div>
</template>
