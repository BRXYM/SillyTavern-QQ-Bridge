<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
    Activity, Users, MessageSquare, Wifi, Radio, Boxes, ArrowUpRight, Zap, Bell,
    Server, Cpu, HardDrive, Clock, CheckCircle2, XCircle, AlertTriangle, RefreshCw,
    Gauge, Hash, ArrowDownToLine, ArrowUpFromLine, Sparkles,
} from 'lucide-vue-next';
import { useStatusStore } from '@/stores/status';
import { useToastStore } from '@/stores/toast';
import UiCard from '@/components/ui/UiCard.vue';
import UiBadge from '@/components/ui/UiBadge.vue';
import UiButton from '@/components/ui/UiButton.vue';
import { formatTime } from '@/lib/utils';

const store = useStatusStore();
const toast = useToastStore();

/** 本地时钟，用于让「已连接时长」每秒走动 */
const now = ref(Date.now());
let ticker: number | null = null;

onMounted(() => {
    // 轮询由 AppLayout 统一管理，这里只保留秒级时钟用于刷新"已运行时长"
    ticker = window.setInterval(() => { now.value = Date.now(); }, 1000);
});
onUnmounted(() => {
    
    if (ticker) window.clearInterval(ticker);
});

// ---------------- 基础数据 ----------------
const status = computed(() => store.status);
const sessions = computed(() => Object.entries(status.value?.sessions ?? {}));
const sessionCount = computed(() => status.value?.metrics?.sessionCount ?? sessions.value.length);

/** 某会话实际生效的下游名称（后端已算好则直接用，否则按 sessionChoices / 全局推断） */
function sessionBackendLabel(key: string): string {
    const fromServer = status.value?.sessionBackends?.[key];
    if (fromServer) return fromServer.backendId;
    const own = status.value?.sessionChoices?.[key]?.backendId;
    if (own) return own;
    return status.value?.defaultDownstreamId ?? 'dsh';
}

/** 该下游是否 dsh（用于列表里显示不同配色） */
function isDshDownstream(id: string): boolean {
    const ds = status.value?.downstreams?.find((d) => d.id === id);
    return ds ? ds.kind.startsWith('dsh') : id === 'dsh';
}
const totalIn = computed(() =>
    status.value?.metrics?.totalIn ?? sessions.value.reduce((n, [, s]) => n + s.in, 0),
);
const totalOut = computed(() =>
    status.value?.metrics?.totalOut ?? sessions.value.reduce((n, [, s]) => n + s.out, 0),
);
const charCount = computed(() => status.value?.catalogs.characters.length ?? 0);
const worldCount = computed(() => status.value?.catalogs.worlds.length ?? 0);

const upstream = computed(() => status.value?.upstream);
/** 每个上游账号的明细（多账号时在卡片底部展示） */
const accounts = computed(() => status.value?.accounts ?? []);

const proc = computed(() => status.value?.process);

const upOnline = computed(() => upstream.value?.connected ?? store.onebotConnected);

// ---------------- 时长格式化 ----------------
function humanDuration(sec: number): string {
    if (!Number.isFinite(sec) || sec <= 0) return '—';
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (d > 0) return `${d}天 ${h}时`;
    if (h > 0) return `${h}时 ${m}分`;
    if (m > 0) return `${m}分 ${s}秒`;
    return `${s}秒`;
}

/** 上游已连接时长：用本地时钟推算，避免依赖轮询间隔 */
const upstreamUptime = computed(() => {
    const at = upstream.value?.connectedAt;
    if (!upOnline.value || !at) return '—';
    return humanDuration((now.value - at) / 1000);
});

const procUptime = computed(() => {
    const started = proc.value?.startedAt;
    if (!started) return '—';
    return humanDuration((now.value - started) / 1000);
});

function ago(ts: number | null | undefined): string {
    if (!ts) return '—';
    const diff = Math.floor((now.value - ts) / 1000);
    if (diff < 5) return '刚刚';
    if (diff < 60) return `${diff} 秒前`;
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    return `${Math.floor(diff / 86400)} 天前`;
}

// ---------------- 健康度 ----------------
const health = computed(() => {
    let score = 0;
    if (store.reachable) score += 20;
    if (upOnline.value) score += 40;

    // 下游：按可用实例占比给分（有启用的下游才计入）
    const enabled = store.downstreams.filter((d) => d.enabled);
    if (enabled.length > 0) {
        const available = enabled.filter((d) => d.available).length;
        score += Math.round((available / enabled.length) * 30);
    } else {
        score += 30;
    }

    if (sessionCount.value > 0) score += 10;
    return Math.min(100, score);
});
const healthLabel = computed(() =>
    health.value >= 95 ? '运行良好'
        : health.value >= 70 ? '基本就绪'
            : health.value >= 40 ? '部分就绪'
                : '未就绪',
);
const healthTone = computed(() =>
    health.value >= 95 ? 'text-success'
        : health.value >= 70 ? 'text-primary'
            : health.value >= 40 ? 'text-warning'
                : 'text-destructive',
);

const R = 30;
const CIRC = 2 * Math.PI * R;
const dashArray = computed(() => `${(health.value / 100) * CIRC} ${CIRC}`);

// ---------------- 链路检查 ----------------
interface CheckItem {
    label: string;
    ok: boolean;
    detail: string;
}
const checks = computed<CheckItem[]>(() => {
    const list: CheckItem[] = [
        {
            label: 'SnowLuma 上游',
            ok: upOnline.value,
            detail: upOnline.value
                ? `${upstream.value?.endpoint ?? '—'} · ${upstreamUptime.value}`
                : upstream.value?.lastError || '未连接',
        },
        {
            label: 'Bridge 后端',
            ok: store.reachable,
            detail: store.reachable ? 'API 正常响应' : store.error || '无法访问',
        },
    ];

    // 下游逐个列出，异常时能直接看出是哪一个
    for (const d of store.downstreams) {
        if (!d.enabled) continue;
        list.push({
            label: d.name || d.id,
            ok: d.available,
            detail: d.available
                ? `${d.kind}${d.detail?.pluginConnections ? ` · ${d.detail.pluginConnections} 个连接` : ''}`
                : d.reason || '不可用',
        });
    }

    list.push({
        label: '活跃会话',
        ok: sessionCount.value > 0,
        detail: sessionCount.value > 0
            ? `${sessionCount.value} 个会话在运行`
            : 'QQ 发消息后自动出现',
    });

    return list;
});

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
        <!-- ============ 顶部：健康度 + 实时链路 ============ -->
        <div class="grid gap-4 lg:grid-cols-[260px_1fr]">
            <!-- 健康环 -->
            <UiCard class="flex flex-col items-center justify-center gap-2 px-4 py-5">
                <div class="relative grid place-items-center">
                    <svg width="88" height="88" viewBox="0 0 88 88" class="-rotate-90">
                        <circle cx="44" cy="44" :r="R" fill="none" stroke="currentColor"
                            stroke-width="8" class="text-muted/70" />
                        <circle cx="44" cy="44" :r="R" fill="none" stroke="url(#hg)" stroke-width="8"
                            stroke-linecap="round" :stroke-dasharray="dashArray"
                            class="transition-[stroke-dasharray] duration-500 ease-out" />
                        <defs>
                            <linearGradient id="hg" x1="0" y1="0" x2="1" y2="1">
                                <stop offset="0%" stop-color="oklch(58% 0.19 288)" />
                                <stop offset="100%" stop-color="oklch(72% 0.13 195)" />
                            </linearGradient>
                        </defs>
                    </svg>
                    <div class="absolute flex flex-col items-center">
                        <span class="text-[22px] font-bold leading-none tabular-nums">{{ health }}</span>
                        <span class="mt-0.5 text-[10px] text-muted-foreground">健康度</span>
                    </div>
                </div>
                <p class="text-[13px] font-semibold tracking-tight" :class="healthTone">
                    {{ healthLabel }}
                </p>
                <p class="text-center text-[11px] leading-relaxed text-muted-foreground">
                    {{ checks.filter((c) => c.ok).length }} / {{ checks.length }} 项检查通过
                </p>
            </UiCard>

            <!-- 链路检查清单 -->
            <UiCard>
                <div class="flex items-center justify-between border-b border-border/60 px-5 py-3">
                    <div class="flex items-center gap-2">
                        <Gauge class="size-4 text-primary" />
                        <h2 class="text-[13px] font-semibold tracking-tight">运行链路</h2>
                    </div>
                    <div class="flex items-center gap-2 text-[11px] text-muted-foreground">
                        <RefreshCw class="size-3" :class="store.loading ? 'animate-spin' : ''" />
                        {{ status?.generatedAt ? ago(status.generatedAt) : '等待数据' }}
                    </div>
                </div>
                <div class="divide-y divide-border/40">
                    <div v-for="c in checks" :key="c.label"
                        class="flex items-center gap-3 px-5 py-2.5">
                        <component
                            :is="c.ok ? CheckCircle2 : XCircle"
                            class="size-4 shrink-0"
                            :class="c.ok ? 'text-success' : 'text-destructive'"
                        />
                        <span class="w-28 shrink-0 text-[12px] font-medium">{{ c.label }}</span>
                        <span class="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                            {{ c.detail }}
                        </span>
                        <UiBadge :tone="c.ok ? 'success' : 'destructive'" class="shrink-0 text-micro">
                            {{ c.ok ? '正常' : '异常' }}
                        </UiBadge>
                    </div>
                </div>
            </UiCard>
        </div>

        <!-- ============ 连接详情：SnowLuma / 酒馆 / 机器人 ============ -->
        <div class="grid gap-4 lg:grid-cols-2">
            <!-- SnowLuma 上游 -->
            <UiCard>
                <div class="flex items-center justify-between border-b border-border/60 px-5 py-3">
                    <div class="flex items-center gap-2">
                        <Radio class="size-4 text-primary" />
                        <div>
                            <h2 class="text-[13px] font-semibold tracking-tight">SnowLuma 上游</h2>
                            <p class="text-[11px] text-muted-foreground">OneBot v11 连接</p>
                        </div>
                    </div>
                    <UiBadge :tone="upOnline ? 'success' : 'destructive'" dot :pulse="upOnline">
                        {{ upOnline ? '已连接' : '未连接' }}
                    </UiBadge>
                </div>
                <div class="grid gap-x-4 gap-y-2.5 px-5 py-3.5 sm:grid-cols-2">
                    <div>
                        <p class="ui-section-label">连接地址</p>
                        <p class="mt-0.5 truncate font-mono text-[12px]">{{ upstream?.endpoint ?? '—' }}</p>
                    </div>
                    <div>
                        <p class="ui-section-label">已连接时长</p>
                        <p class="mt-0.5 font-mono text-[12px]" :class="upOnline ? 'text-success' : 'text-muted-foreground'">
                            {{ upstreamUptime }}
                        </p>
                    </div>
                    <div>
                        <p class="ui-section-label">机器人 QQ</p>
                        <p class="mt-0.5 font-mono text-[12px]">{{ upstream?.selfId || store.status?.selfId || '—' }}</p>
                    </div>
                    <div>
                        <p class="ui-section-label">昵称</p>
                        <p class="mt-0.5 truncate text-[12px]">{{ upstream?.nickname || '—' }}</p>
                    </div>
                    <div>
                        <p class="ui-section-label">收到事件</p>
                        <p class="mt-0.5 font-mono text-[12px] tabular-nums">{{ upstream?.eventsIn ?? 0 }}</p>
                    </div>
                    <div>
                        <p class="ui-section-label">发出动作</p>
                        <p class="mt-0.5 font-mono text-[12px] tabular-nums">
                            {{ upstream?.actionsOut ?? 0 }}
                            <span v-if="(upstream?.actionErrors ?? 0) > 0" class="ml-1 text-destructive">
                                ({{ upstream?.actionErrors }} 失败)
                            </span>
                        </p>
                    </div>
                    <div>
                        <p class="ui-section-label">最近事件</p>
                        <p class="mt-0.5 text-[12px] text-muted-foreground">{{ ago(upstream?.lastEventAt) }}</p>
                    </div>
                    <div>
                        <p class="ui-section-label">重连次数</p>
                        <p class="mt-0.5 font-mono text-[12px] tabular-nums">
                            {{ upstream?.reconnectCount ?? 0 }}
                        </p>
                    </div>
                </div>
                <div v-if="upstream?.lastError && !upOnline"
                    class="flex items-start gap-2 border-t border-destructive/25 bg-destructive/5 px-5 py-2.5">
                    <AlertTriangle class="mt-0.5 size-3.5 shrink-0 text-destructive" />
                    <p class="min-w-0 flex-1 break-words text-[11px] text-destructive">
                        {{ upstream.lastError }}
                        <span class="ml-1 text-muted-foreground">{{ ago(upstream.lastErrorAt) }}</span>
                    </p>
                </div>

                <!-- 多账号明细：掉线时能一眼看出是哪个号 -->
                <div
                    v-if="(accounts?.length ?? 0) > 1"
                    class="border-t border-border/40 px-5 py-3"
                >
                    <p class="ui-section-label mb-1.5">账号明细</p>
                    <div class="flex flex-col gap-1">
                        <div
                            v-for="acc in accounts"
                            :key="acc.id"
                            class="flex flex-wrap items-center gap-2 text-[11px]"
                        >
                            <span
                                class="size-1.5 shrink-0 rounded-full"
                                :class="acc.connected ? 'bg-success' : 'bg-destructive/60'"
                            />
                            <span class="font-mono">{{ acc.id }}</span>
                            <span class="text-muted-foreground">
                                {{ acc.name || '—' }}<template v-if="acc.selfId"> · {{ acc.selfId }}</template>
                            </span>
                            <span class="flex-1" />
                            <span class="font-mono tabular-nums text-muted-foreground">
                                ↑{{ acc.eventsIn }} ↓{{ acc.actionsOut }}
                            </span>
                            <span
                                v-if="acc.lastError"
                                class="min-w-0 max-w-48 truncate text-destructive"
                                :title="acc.lastError"
                            >
                                {{ acc.lastError }}
                            </span>
                        </div>
                    </div>
                </div>
            </UiCard>

            <!-- 酒馆扩展 -->
            <UiCard>
                <div class="flex items-center justify-between border-b border-border/60 px-5 py-3">
                    <div class="flex items-center gap-2">
                        <Boxes class="size-4 text-aurora" />
                        <div>
                            <h2 class="text-[13px] font-semibold tracking-tight">下游状态</h2>
                            <p class="text-[11px] text-muted-foreground">谁在回这条消息</p>
                        </div>
                    </div>
                    <UiBadge
                        :tone="store.live ? 'success' : 'secondary'"
                        dot
                        :pulse="store.live"
                        class="text-micro"
                    >
                        {{ store.live ? '实时' : '轮询' }}
                    </UiBadge>
                </div>

                <div v-if="store.downstreams.length === 0" class="px-5 py-6 text-center">
                    <p class="text-[12px] text-muted-foreground">还没有下游实例</p>
                    <p class="mt-1 text-[11px] text-muted-foreground/70">
                        到「下游管理」新增，或安装 dsh 连接插件自动注册
                    </p>
                </div>

                <div v-else class="divide-y divide-border/40">
                    <div
                        v-for="d in store.downstreams"
                        :key="d.id"
                        class="flex items-center gap-2.5 px-5 py-2.5"
                        :class="d.enabled ? '' : 'opacity-50'"
                    >
                        <span
                            class="size-1.5 shrink-0 rounded-full"
                            :class="d.available
                                ? 'bg-success animate-pulse'
                                : (d.enabled ? 'bg-warning' : 'bg-muted-foreground/40')"
                        />
                        <div class="min-w-0 flex-1">
                            <p class="truncate text-[12px]">
                                {{ d.name || d.id }}
                                <span
                                    v-if="d.id === store.defaultDownstreamId"
                                    class="ml-1 text-[10px] text-primary"
                                >默认</span>
                            </p>
                            <p class="truncate text-[11px] text-muted-foreground/80">
                                {{ d.kind }}
                                <span v-if="!d.available && d.reason"> · {{ d.reason }}</span>
                            </p>
                        </div>
                        <UiBadge
                            :tone="d.available ? 'success' : (d.enabled ? 'warning' : 'outline')"
                            class="shrink-0 text-micro"
                        >
                            {{ d.enabled ? (d.available ? '可用' : '离线') : '停用' }}
                        </UiBadge>
                    </div>
                </div>

                <div class="border-t border-border/40 px-5 py-2.5">
                    <p class="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <Info class="size-3.5 shrink-0" />
                        {{ store.live
                            ? '服务变化会即时推送，无需等待轮询'
                            : '实时通道未连接，当前按轮询刷新' }}
                    </p>
                </div>
            </UiCard>
        </div>

        <!-- ============ 指标卡 ============ -->
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
                        <p class="mt-1.5 flex items-baseline gap-1 text-[22px] font-bold leading-none tabular-nums">
                            <ArrowDownToLine class="size-3.5 self-center text-info" />
                            {{ totalIn }}
                            <span class="mx-0.5 text-[13px] font-normal text-muted-foreground">/</span>
                            <ArrowUpFromLine class="size-3.5 self-center text-success" />
                            {{ totalOut }}
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

            <UiCard class="ui-lift p-4">
                <div class="flex items-start justify-between">
                    <div>
                        <p class="ui-section-label">内存占用</p>
                        <p class="mt-1.5 text-[22px] font-bold leading-none tabular-nums">
                            {{ proc?.rssMb ?? '—' }}<span class="ml-0.5 text-[13px] font-normal text-muted-foreground">MB</span>
                        </p>
                        <p class="mt-1 text-[11px] text-muted-foreground">
                            堆 {{ proc?.heapUsedMb ?? '—' }} / {{ proc?.heapTotalMb ?? '—' }} MB
                        </p>
                    </div>
                    <div class="flex size-9 items-center justify-center rounded-xl bg-warning/15 text-warning">
                        <HardDrive class="size-4" />
                    </div>
                </div>
            </UiCard>
        </div>

        <!-- ============ 进程信息 ============ -->
        <UiCard>
            <div class="flex items-center justify-between border-b border-border/60 px-5 py-3">
                <div class="flex items-center gap-2">
                    <Cpu class="size-4 text-muted-foreground" />
                    <h2 class="text-[13px] font-semibold tracking-tight">Bridge 进程</h2>
                </div>
                <span class="font-mono text-[11px] text-muted-foreground">PID {{ proc?.pid ?? '—' }}</span>
            </div>
            <div class="grid gap-x-4 gap-y-2.5 px-5 py-3.5 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                    <p class="ui-section-label">运行时长</p>
                    <p class="mt-0.5 flex items-center gap-1 font-mono text-[12px]">
                        <Clock class="size-3 text-muted-foreground" />
                        {{ procUptime }}
                    </p>
                </div>
                <div>
                    <p class="ui-section-label">Node 版本</p>
                    <p class="mt-0.5 font-mono text-[12px]">{{ proc?.nodeVersion ?? '—' }}</p>
                </div>
                <div>
                    <p class="ui-section-label">平台</p>
                    <p class="mt-0.5 font-mono text-[12px]">
                        {{ proc ? `${proc.platform} / ${proc.arch}` : '—' }}
                    </p>
                </div>
                <div>
                    <p class="ui-section-label">外部内存</p>
                    <p class="mt-0.5 font-mono text-[12px] tabular-nums">{{ proc?.externalMb ?? '—' }} MB</p>
                </div>
            </div>
        </UiCard>

        <!-- ============ 最近活跃 ============ -->
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
                        <p class="mt-0.5 flex items-center gap-1.5 truncate text-[11px]">
                            <span :class="isDshDownstream(sessionBackendLabel(key)) ? 'text-info' : 'text-muted-foreground/80'">
                                {{ sessionBackendLabel(key) }}
                            </span>
                            <span class="opacity-30">·</span>
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
