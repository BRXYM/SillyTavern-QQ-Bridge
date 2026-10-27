<script setup lang="ts">
import { onMounted, computed } from 'vue';
import { Info, Cable, Database, Palette, Boxes } from 'lucide-vue-next';
import { useStatusStore } from '@/stores/status';
import UiCard from '@/components/ui/UiCard.vue';
import UiBadge from '@/components/ui/UiBadge.vue';

const store = useStatusStore();

onMounted(() => void store.refresh());

const frontendOrigin = computed(() => window.location.origin);
const frontendRouteMode = computed(() => (window.location.hash ? 'hash' : 'history'));

function fmt(v: unknown, fallback = '—'): string {
    if (v === undefined || v === null || v === '') return fallback;
    return String(v);
}
</script>

<template>
    <div class="flex flex-col gap-5">
        <!-- 说明 -->
        <UiCard class="border-info/30 bg-info/5">
            <div class="flex items-start gap-3 px-5 py-4">
                <Info class="mt-0.5 size-4 shrink-0 text-info" />
                <div class="min-w-0">
                    <p class="text-sm font-medium">系统配置</p>
                    <p class="mt-1 text-xs leading-relaxed text-muted-foreground">
                        本页展示当前前后端的运行环境信息，后续将在此增加更多系统级配置项。
                        业务配置已按功能拆分到对应页面：
                    </p>
                    <ul class="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
                        <li>• <strong class="text-foreground">OneBot 连接 / 上游配置</strong> → SnowLuma 接入</li>
                        <li>• <strong class="text-foreground">默认角色 / 世界书</strong> → 会话</li>
                        <li>• <strong class="text-foreground">触发规则 / 消息限制</strong> → 会话（酒馆与 dsh 共用）</li>
                        <li>• <strong class="text-foreground">下游实例 / dsh 服务与插件</strong> → 下游管理</li>
                        <li>• <strong class="text-foreground">回复分段 / 图片表情</strong> → 对应页面</li>
                    </ul>
                </div>
            </div>
        </UiCard>

        <!-- 前端 -->
        <UiCard>
            <div class="flex items-center gap-3 border-b border-border/60 px-5 py-4">
                <div class="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <Palette class="size-5" />
                </div>
                <div>
                    <h2 class="text-sm font-semibold tracking-tight">前端</h2>
                    <p class="text-xs text-muted-foreground">Vue 管理界面运行信息</p>
                </div>
            </div>
            <div class="grid gap-x-4 gap-y-3 px-5 py-4 sm:grid-cols-2">
                <div>
                    <p class="ui-section-label">地址</p>
                    <p class="mt-0.5 font-mono text-[12px]">{{ frontendOrigin }}</p>
                </div>
                <div>
                    <p class="ui-section-label">路由模式</p>
                    <p class="mt-0.5 font-mono text-[12px]">{{ frontendRouteMode }}</p>
                </div>
                <div>
                    <p class="ui-section-label">后端连通性</p>
                    <UiBadge :tone="store.reachable ? 'success' : 'destructive'" dot class="mt-0.5">
                        {{ store.reachable ? '正常' : '异常' }}
                    </UiBadge>
                </div>
                <div>
                    <p class="ui-section-label">轮询状态</p>
                    <p class="mt-0.5 text-[12px] text-muted-foreground">
                        {{ store.loading ? '刷新中…' : '空闲' }}
                    </p>
                </div>
            </div>
        </UiCard>

        <!-- 后端 -->
        <UiCard>
            <div class="flex items-center gap-3 border-b border-border/60 px-5 py-4">
                <div class="flex size-10 items-center justify-center rounded-xl bg-aurora/15 text-aurora">
                    <Cable class="size-5" />
                </div>
                <div>
                    <h2 class="text-sm font-semibold tracking-tight">后端</h2>
                    <p class="text-xs text-muted-foreground">桥接服务运行信息</p>
                </div>
            </div>
            <div class="grid gap-x-4 gap-y-3 px-5 py-4 sm:grid-cols-2">
                <div>
                    <p class="ui-section-label">Node 版本</p>
                    <p class="mt-0.5 font-mono text-[12px]">{{ fmt(store.status?.process?.nodeVersion) }}</p>
                </div>
                <div>
                    <p class="ui-section-label">平台</p>
                    <p class="mt-0.5 font-mono text-[12px]">
                        {{ store.status?.process ? `${store.status.process.platform} / ${store.status.process.arch}` : '—' }}
                    </p>
                </div>
                <div>
                    <p class="ui-section-label">进程 PID</p>
                    <p class="mt-0.5 font-mono text-[12px]">{{ fmt(store.status?.process?.pid) }}</p>
                </div>
                <div>
                    <p class="ui-section-label">内存占用</p>
                    <p class="mt-0.5 font-mono text-[12px]">
                        {{ store.status?.process ? `${store.status.process.rssMb} MB` : '—' }}
                    </p>
                </div>
                <div>
                    <p class="ui-section-label">控制台 / API 端口</p>
                    <p class="mt-0.5 font-mono text-[12px]">{{ fmt(store.status?.config['consolePort']) }}</p>
                </div>
                <div>
                    <p class="ui-section-label">扩展 WS 端口</p>
                    <p class="mt-0.5 font-mono text-[12px]">{{ fmt(store.status?.config['stExtPort']) }}</p>
                </div>
            </div>
        </UiCard>

        <!-- 资源 -->
        <UiCard>
            <div class="flex items-center gap-3 border-b border-border/60 px-5 py-4">
                <div class="flex size-10 items-center justify-center rounded-xl bg-info/10 text-info">
                    <Database class="size-5" />
                </div>
                <div>
                    <h2 class="text-sm font-semibold tracking-tight">数据资源</h2>
                    <p class="text-xs text-muted-foreground">已加载的角色与世界书清单</p>
                </div>
            </div>
            <div class="grid gap-x-4 gap-y-3 px-5 py-4 sm:grid-cols-2">
                <div>
                    <p class="ui-section-label">角色</p>
                    <p class="mt-0.5 font-mono text-[12px] tabular-nums">
                        {{ store.status?.catalogs.characters.length ?? 0 }} 个
                    </p>
                </div>
                <div>
                    <p class="ui-section-label">世界书</p>
                    <p class="mt-0.5 font-mono text-[12px] tabular-nums">
                        {{ store.status?.catalogs.worlds.length ?? 0 }} 本
                    </p>
                </div>
                <div>
                    <p class="ui-section-label">清单更新时间</p>
                    <p class="mt-0.5 text-[12px] text-muted-foreground">
                        {{ fmt(store.status?.catalogs.updatedAt, '尚未上报') }}
                    </p>
                </div>
                <div>
                    <p class="ui-section-label">酒馆数据目录</p>
                    <p class="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" :title="String(store.status?.config['stDataDir'] ?? '')">
                        {{ fmt(store.status?.config['stDataDir'], '未配置（自动探测）') }}
                    </p>
                </div>
            </div>
        </UiCard>

        <!-- 待补充 -->
        <UiCard>
            <div class="flex items-center gap-3 border-b border-border/60 px-5 py-4">
                <div class="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                    <Boxes class="size-5" />
                </div>
                <div>
                    <h2 class="text-sm font-semibold tracking-tight">后续将在此加入</h2>
                    <p class="text-xs text-muted-foreground">系统级配置项</p>
                </div>
            </div>
            <div class="px-5 py-4">
                <ul class="flex flex-col gap-1.5 text-xs text-muted-foreground">
                    <li>• 日志级别与保留策略</li>
                    <li>• 数据备份与恢复</li>
                    <li>• 端口与监听地址</li>
                    <li>• 更新检查</li>
                </ul>
            </div>
        </UiCard>
    </div>
</template>
