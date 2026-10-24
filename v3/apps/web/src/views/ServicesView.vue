<script setup lang="ts">
import { ref } from 'vue';
import { Server, Play, Square, RotateCw, Download, ExternalLink, FolderOpen } from 'lucide-vue-next';
import UiCard from '@/components/ui/UiCard.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiBadge from '@/components/ui/UiBadge.vue';
import UiInput from '@/components/ui/UiInput.vue';
import UiSelect from '@/components/ui/UiSelect.vue';
import { useToastStore } from '@/stores/toast';

type Mode = 'external' | 'managed' | 'disabled';
type State = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

interface ServiceCard {
    name: string;
    label: string;
    desc: string;
    mode: Mode;
    state: State;
    endpoint: string;
    installDir: string;
    version: string;
    port?: number;
}

// 阶段 1 使用本地状态占位，后续接入后端 /api/services
// 安装目录仅为界面演示占位，实际路径由后端返回
const services = ref<ServiceCard[]>([
    {
        name: 'snowluma',
        label: 'SnowLuma',
        desc: 'QQ → OneBot v11 协议端',
        mode: 'external',
        state: 'stopped',
        endpoint: 'ws://127.0.0.1:3001',
        installDir: '',
        version: '2.1.1',
        port: 3001,
    },
    {
        name: 'sillytavern',
        label: 'SillyTavern',
        desc: '酒馆角色扮演前端',
        mode: 'external',
        state: 'stopped',
        endpoint: 'http://127.0.0.1:8000',
        installDir: '',
        version: '1.17.0',
        port: 8000,
    },
]);

const toast = useToastStore();

const modeOptions = [
    { value: 'external', label: '手动指定（连接已有服务）' },
    { value: 'managed', label: '自动管理（下载 / 启停）' },
    { value: 'disabled', label: '禁用' },
];

const stateTone = (s: State) =>
    s === 'running' ? 'success' : s === 'error' ? 'destructive' : s === 'stopped' ? 'secondary' : 'warning';

const stateText = (s: State) =>
    ({ running: '运行中', starting: '启动中', stopping: '停止中', stopped: '已停止', error: '异常' })[s];


</script>

<template>
    <div class="flex flex-col gap-5">
        <UiCard v-for="svc in services" :key="svc.name">
            <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-5 py-4">
                <div class="flex items-center gap-3">
                    <div class="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                        <Server class="size-5" />
                    </div>
                    <div>
                        <h2 class="text-sm font-semibold tracking-tight">{{ svc.label }}</h2>
                        <p class="text-xs text-muted-foreground">{{ svc.desc }}</p>
                    </div>
                </div>
                <div class="flex items-center gap-2">
                    <UiBadge :tone="stateTone(svc.state)" dot :pulse="svc.state === 'running'">
                        {{ stateText(svc.state) }}
                    </UiBadge>
                    <UiBadge v-if="svc.port" tone="outline" class="font-mono text-micro">:{{ svc.port }}</UiBadge>
                </div>
            </div>

            <div class="grid gap-4 px-5 py-4 lg:grid-cols-2">
                <!-- 模式 -->
                <div>
                    <label class="text-xs font-medium text-muted-foreground">运行模式</label>
                    <UiSelect v-model="svc.mode" :options="modeOptions" class="mt-1.5" />
                </div>

                <!-- 版本 -->
                <div>
                    <label class="text-xs font-medium text-muted-foreground">版本</label>
                    <div class="mt-1.5 flex items-center gap-2">
                        <UiInput :model-value="svc.version" disabled class="flex-1" />
                        <UiButton variant="outline" size="sm" @click="toast.info('检查更新', 'v2 后端尚未提供版本接口')">
                            <Download class="size-4" />
                        </UiButton>
                    </div>
                </div>

                <!-- 手动指定模式 -->
                <div v-if="svc.mode === 'external'" class="lg:col-span-2">
                    <label class="text-xs font-medium text-muted-foreground">服务地址</label>
                    <UiInput v-model="svc.endpoint" class="mt-1.5" mono />
                </div>

                <!-- 自动管理模式 -->
                <div v-else-if="svc.mode === 'managed'" class="lg:col-span-2">
                    <label class="text-xs font-medium text-muted-foreground">安装目录</label>
                    <div class="mt-1.5 flex items-center gap-2">
                        <UiInput v-model="svc.installDir" class="flex-1" mono />
                        <UiButton variant="outline" size="sm" @click="toast.info('目录选择器', '将在服务编排阶段提供')">
                            <FolderOpen class="size-4" />
                        </UiButton>
                    </div>
                    <p class="mt-1.5 text-xs text-muted-foreground">
                        未安装时点击「下载安装」，程序会自动获取最新版本并解压到此目录
                    </p>
                </div>
            </div>

            <!-- 操作 -->
            <div class="flex flex-wrap items-center gap-2 border-t border-border/60 px-5 py-3">
                <UiButton
                    v-if="svc.mode === 'managed'"
                    variant="secondary"
                    size="sm"
                    @click="toast.info('下载安装', '安装器正在接入')"
                >
                    <Download class="size-4" />
                    下载安装
                </UiButton>
                <UiButton
                    variant="default"
                    size="sm"
                    :disabled="svc.state === 'running'"
                    @click="toast.info('启动服务', '服务编排器未接入')"
                >
                    <Play class="size-4" />
                    启动
                </UiButton>
                <UiButton
                    variant="outline"
                    size="sm"
                    :disabled="svc.state !== 'running'"
                    @click="toast.info('停止服务', '服务编排器未接入')"
                >
                    <Square class="size-4" />
                    停止
                </UiButton>
                <UiButton variant="outline" size="sm" @click="toast.info('重启服务', '服务编排器未接入')">
                    <RotateCw class="size-4" />
                    重启
                </UiButton>
                <div class="flex-1" />
                <UiButton variant="ghost" size="sm" @click="toast.info('打开界面', '将在新窗口中打开')">
                    <ExternalLink class="size-4" />
                    打开界面
                </UiButton>
            </div>
        </UiCard>

        <UiCard class="border-warning/30 bg-warning/5">
            <div class="px-5 py-4">
                <p class="text-sm font-medium">服务编排功能正在接入</p>
                <p class="mt-1 text-xs text-muted-foreground">
                    当前版本仅展示界面骨架。后端的下载、启停、健康检查将在下一阶段实现。
                </p>
            </div>
        </UiCard>
    </div>
</template>
