<script setup lang="ts">
import { computed } from 'vue';
import { useStatusStore } from '@/stores/status';
import UiCard from './ui/UiCard.vue';
const store = useStatusStore();
const accounts = computed(() => store.status?.accounts ?? []);
const profiles = computed(() => ((store.status?.config.downstreams ?? []) as Array<{ profiles?: unknown[] }>).reduce((n, d) => n + (d.profiles?.length ?? 0), 0));
const links = computed(() => [
    { to: '/snowluma', label: 'QQ 账号', value: accounts.value.length, detail: `${accounts.value.filter(a => a.connected).length} 个在线` },
    { to: '/downstreams', label: '下游连接', value: store.downstreams.length, detail: `${store.downstreams.filter(d => d.enabled && d.available).length} 个可用` },
    { to: '/profiles', label: '对话配置', value: profiles.value, detail: '按下游保存，供会话复用' },
    { to: '/sessions', label: '会话与路由', value: new Set([...Object.keys(store.status?.sessions ?? {}), ...Object.keys(store.status?.sessionChoices ?? {})]).size, detail: '查看绑定与继承关系' },
]);
</script>

<template>
    <UiCard class="space-y-5 p-5 sm:p-6">
        <div class="flex flex-wrap items-start justify-between gap-3">
            <div><h2 class="text-lg font-semibold">多 QQ · 多下游 · 自由控制台</h2><p class="mt-2 text-sm text-muted-foreground">连接账号与服务，为每个会话定义处理方式。</p></div>
            <RouterLink to="/sessions" class="rounded-lg bg-primary px-4 py-2 text-xs font-medium text-primary-foreground">查看会话路由 →</RouterLink>
        </div>
        <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <RouterLink v-for="item in links" :key="item.to" :to="item.to" class="rounded-xl border border-border bg-muted/20 p-4 transition-colors hover:border-primary/40 hover:bg-primary/5">
                <p class="text-xs text-muted-foreground">{{ item.label }} ↗</p><p class="mt-2 text-2xl font-semibold tabular-nums">{{ item.value }}</p><p class="mt-2 text-xs text-muted-foreground">{{ item.detail }}</p>
            </RouterLink>
        </div>
        <div class="grid gap-4 border-t border-border pt-4 md:grid-cols-2">
            <div><h3 class="mb-2 text-xs font-medium">账号入口</h3><p v-if="!accounts.length" class="text-xs text-muted-foreground">先添加一个 QQ 账号，再连接下游服务。</p><div v-for="a in accounts" :key="a.id" class="flex items-start justify-between gap-3 py-1.5 text-xs"><span class="min-w-0 break-all">{{ a.name || a.id }} <span class="text-muted-foreground">{{ a.uin || a.selfId || a.id }}</span></span><span class="shrink-0" :class="a.connected ? 'text-success' : 'text-warning'">{{ a.connected ? '在线' : '未连接' }}</span></div></div>
            <div><h3 class="mb-2 text-xs font-medium">下游出口</h3><p v-if="!store.downstreams.length" class="text-xs text-muted-foreground">添加 dsh、酒馆或自建 HTTP 服务。</p><div v-for="d in store.downstreams" :key="d.id" class="flex items-start justify-between gap-3 py-1.5 text-xs"><span class="min-w-0 break-all">{{ d.name || d.id }} <span v-if="d.id === store.defaultDownstreamId" class="text-primary">· 全局默认</span></span><span class="shrink-0" :class="d.enabled && d.available ? 'text-success' : 'text-muted-foreground'">{{ !d.enabled ? '已停用' : d.available ? '可用' : '不可用' }}</span></div></div>
        </div>
        <p v-if="!store.reachable" role="status" class="text-xs text-warning">后端尚未连接，以上可能是上次保存的状态。</p>
    </UiCard>
</template>
