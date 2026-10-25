<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
    Server, Play, Square, RotateCw, Download, ExternalLink, FolderOpen, RefreshCw,
    Wand2, CheckCircle2, AlertTriangle, Info, Copy,
} from 'lucide-vue-next';
import UiCard from '@/components/ui/UiCard.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiBadge from '@/components/ui/UiBadge.vue';
import UiInput from '@/components/ui/UiInput.vue';
import UiSelect from '@/components/ui/UiSelect.vue';
import { api, type SnowLumaProbe, type SnowLumaApplyResult, type SnowLumaDiscoverResult } from '@/api/client';
import { useStatusStore } from '@/stores/status';
import { useToastStore } from '@/stores/toast';

type Mode = 'external' | 'managed' | 'disabled';

const store = useStatusStore();
const toast = useToastStore();

// ---------------- SnowLuma ----------------
const snowDir = ref('');
const snowPort = ref(3001);
const snowWebuiPort = ref(5099);
const snowUin = ref('');
const probing = ref(false);
const applying = ref(false);
const probe = ref<SnowLumaProbe | null>(null);
const applyResult = ref<SnowLumaApplyResult | null>(null);
const discovering = ref(false);
const discoverResult = ref<SnowLumaDiscoverResult | null>(null);

/** 自动检测 SnowLuma 目录 */
async function doDiscover() {
    discovering.value = true;
    discoverResult.value = null;
    try {
        const r = await api.discoverSnowLuma(snowDir.value.trim());
        discoverResult.value = r;

        if (!r.found || r.candidates.length === 0) {
            toast.warning(
                '未自动找到 SnowLuma',
                '请手动填写目录。可设置环境变量 SNOWLUMA_DIR 让检测更准',
            );
            return;
        }

        // 优先选「运行中的进程」这类强信号，其次第一个
        const best =
            r.candidates.find((c) => c.source.includes('运行中的进程') && c.ok) ??
            r.candidates.find((c) => c.ok) ??
            r.candidates[0];

        if (best) {
            snowDir.value = best.dir;
            if (best.accounts.length > 0 && !snowUin.value) {
                snowUin.value = best.accounts[0]!;
            }
            toast.success(
                `已定位 SnowLuma`,
                `${best.dir} · ${best.source}`,
            );
            void doProbe();
        }
    } catch (e) {
        toast.error('自动检测失败', e instanceof Error ? e.message : String(e));
    } finally {
        discovering.value = false;
    }
}

/** 选用某个候选目录 */
function useCandidate(dir: string, accounts: string[]) {
    snowDir.value = dir;
    if (accounts.length > 0) snowUin.value = accounts[0]!;
    discoverResult.value = null;
    void doProbe();
}

const snowRunning = computed(() => probe.value?.onebotPortListening ?? false);
const snowState = computed<'running' | 'stopped' | 'unknown'>(() => {
    if (!probe.value) return 'unknown';
    return snowRunning.value ? 'running' : 'stopped';
});

async function doProbe(opts: { keepResult?: boolean } = {}) {
    if (!snowDir.value.trim()) {
        toast.warning('请先填写 SnowLuma 目录');
        return;
    }
    probing.value = true;
    // 手动探测时清空上次结果；自动配置后刷新探测则保留结果面板
    if (!opts.keepResult) applyResult.value = null;
    try {
        const r = await api.probeSnowLuma(snowDir.value.trim(), snowWebuiPort.value);
        probe.value = r;
        if (!r.ok) {
            toast.error('目录探测失败', r.error);
            return;
        }
        // 自动选中第一个账号
        if (!snowUin.value && r.accounts.length > 0) {
            snowUin.value = r.accounts[0]!.uin;
        }
        toast.success(
            `已识别 SnowLuma ${r.version || '(未知版本)'}`,
            `${r.mode === 'source' ? '源码模式' : r.mode === 'release' ? '发行包模式' : '自定义布局'} · ${r.accounts.length} 个账号`,
        );
    } catch (e) {
        toast.error('探测失败', e instanceof Error ? e.message : String(e));
    } finally {
        probing.value = false;
    }
}

async function doApply(forceToken = false) {
    if (!snowUin.value.trim()) {
        toast.warning('请填写 QQ 号', '可在 SnowLuma 登录后自动识别');
        return;
    }
    applying.value = true;
    try {
        const r = await api.applySnowLuma({
            dir: snowDir.value.trim(),
            uin: snowUin.value.trim(),
            port: snowPort.value,
            webuiPort: snowWebuiPort.value,
            forceToken,
        });
        applyResult.value = r;
        if (r.needRestart) {
            toast.warning(
                '配置已写入，需重启 SnowLuma',
                'OneBot 服务在启动时读取配置，重启后生效',
            );
        } else {
            toast.success('配置已就绪', `无需改动 · ${r.endpoint}`);
        }
        // 刷新探测状态（保留结果面板）
        void doProbe({ keepResult: true });
    } catch (e) {
        toast.error('自动配置失败', e instanceof Error ? e.message : String(e));
    } finally {
        applying.value = false;
    }
}

async function copyToken() {
    const t = applyResult.value?.token;
    if (!t) return;
    try {
        await navigator.clipboard.writeText(t);
        toast.success('Token 已复制');
    } catch {
        toast.error('复制失败', '请手动选中复制');
    }
}

function openSnowUI() {
    window.open('http://127.0.0.1:5099', '_blank', 'noopener');
}

onMounted(async () => {
    await store.refresh();
    const cfg = store.status?.config as Record<string, unknown> | undefined;
    const saved = cfg?.['snowlumaDir'];
    if (typeof saved === 'string' && saved) {
        snowDir.value = saved;
        const p = cfg?.['snowlumaWebuiPort'];
        if (typeof p === 'number' && p > 0) snowWebuiPort.value = p;
        void doProbe();
    } else {
        // 首次使用：自动尝试定位 SnowLuma
        void doDiscover();
    }
    const url = cfg?.['onebotUrl'];
    if (typeof url === 'string') {
        const m = url.match(/:(\d+)/);
        if (m) snowPort.value = Number(m[1]);
    }
});

// ---------------- SillyTavern ----------------
const services = ref([
    {
        name: 'sillytavern',
        label: 'SillyTavern',
        desc: '酒馆角色扮演前端',
        mode: 'external' as Mode,
        endpoint: 'http://127.0.0.1:8000',
        installDir: '',
        version: '1.17.0',
        port: 8000,
    },
]);

const modeOptions = [
    { value: 'external', label: '手动指定（连接已有服务）' },
    { value: 'managed', label: '自动管理（下载 / 启停）' },
    { value: 'disabled', label: '禁用' },
];

const stateTone = (s: string) =>
    s === 'running' ? 'success' : s === 'stopped' ? 'secondary' : 'warning';
const stateText = (s: string) =>
    ({ running: '运行中', starting: '启动中', stopping: '停止中', stopped: '已停止', error: '异常' } as Record<string, string>)[s] ?? s;
</script>

<template>
    <div class="flex flex-col gap-5">
        <!-- ================= SnowLuma ================= -->
        <UiCard>
            <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-5 py-4">
                <div class="flex items-center gap-3">
                    <div class="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                        <Server class="size-5" />
                    </div>
                    <div>
                        <h2 class="text-sm font-semibold tracking-tight">SnowLuma</h2>
                        <p class="text-xs text-muted-foreground">QQ → OneBot v11 协议端</p>
                    </div>
                </div>
                <div class="flex items-center gap-2">
                    <UiBadge :tone="stateTone(snowState)" dot :pulse="snowState === 'running'">
                        {{ snowState === 'running' ? '运行中' : snowState === 'stopped' ? '未连接' : '未探测' }}
                    </UiBadge>
                    <UiBadge v-if="probe?.version" tone="outline" class="font-mono text-micro">
                        v{{ probe.version }}
                    </UiBadge>
                    <UiBadge tone="outline" class="font-mono text-micro">:{{ snowPort }}</UiBadge>
                </div>
            </div>

            <!-- 路径配置 -->
            <div class="grid gap-4 px-5 py-4">
                <div>
                    <label class="text-xs font-medium text-muted-foreground">SnowLuma 目录</label>
                    <div class="mt-1.5 flex items-center gap-2">
                        <UiInput
                            v-model="snowDir"
                            class="flex-1"
                            mono
                            placeholder="例如 D:\WorkSpace\SnowLuma"
                        />
                        <UiButton variant="secondary" size="sm" :disabled="discovering" @click="doDiscover">
                            <Wand2 class="size-4" :class="discovering ? 'animate-pulse' : ''" />
                            {{ discovering ? '检测中…' : '自动检测' }}
                        </UiButton>
                        <UiButton variant="outline" size="sm" :disabled="probing" @click="doProbe">
                            <RefreshCw class="size-4" :class="probing ? 'animate-spin' : ''" />
                            探测
                        </UiButton>
                    </div>
                    <p class="mt-1.5 text-xs text-muted-foreground">
                        填 SnowLuma 的根目录（含 <code class="font-mono">dist/</code> 或
                        <code class="font-mono">packages/core/</code> 的那一层），Bridge 会自动定位配置与账号
                    </p>
                </div>

                <!-- 自动检测候选 -->
                <div v-if="discoverResult" class="rounded-lg border border-border/60 bg-accent/15 px-3.5 py-3">
                    <div class="flex items-start gap-2">
                        <Wand2 class="mt-0.5 size-4 shrink-0 text-primary" />
                        <div class="min-w-0 flex-1">
                            <p class="text-xs font-medium">
                                {{ discoverResult.found ? `找到 ${discoverResult.candidates.length} 个候选` : '未找到 SnowLuma' }}
                            </p>
                            <div v-if="discoverResult.candidates.length" class="mt-2 flex flex-col gap-1.5">
                                <button
                                    v-for="c in discoverResult.candidates"
                                    :key="c.dir"
                                    class="flex w-full items-center gap-2 rounded-md border border-border/50 bg-card px-2.5 py-2 text-left transition-colors hover:border-primary/40 hover:bg-accent/30"
                                    @click="useCandidate(c.dir, c.accounts)"
                                >
                                    <div class="min-w-0 flex-1">
                                        <p class="truncate font-mono text-[11px]">{{ c.dir }}</p>
                                        <p class="mt-0.5 truncate text-[11px] text-muted-foreground">
                                            {{ c.source }}
                                            <span v-if="c.version" class="ml-1">· v{{ c.version }}</span>
                                            <span v-if="c.accounts.length" class="ml-1 text-primary">
                                                · {{ c.accounts.join(', ') }}
                                            </span>
                                        </p>
                                    </div>
                                    <UiBadge v-if="c.ok" tone="success" class="shrink-0 text-micro">可用</UiBadge>
                                    <UiBadge v-else tone="warning" class="shrink-0 text-micro">不可用</UiBadge>
                                </button>
                            </div>
                            <p v-else class="mt-1 text-xs text-muted-foreground">
                                尝试过：{{ discoverResult.tried.join(' · ') }}
                            </p>
                        </div>
                    </div>
                </div>

                <!-- 探测结果 -->
                <div v-if="probe" class="rounded-lg border border-border/60 bg-accent/15 px-3.5 py-3">
                    <div class="flex items-start gap-2">
                        <CheckCircle2 v-if="probe.ok" class="mt-0.5 size-4 shrink-0 text-success" />
                        <AlertTriangle v-else class="mt-0.5 size-4 shrink-0 text-warning" />
                        <div class="min-w-0 flex-1 text-xs leading-relaxed">
                            <template v-if="probe.ok">
                                <p class="font-medium">
                                    SnowLuma {{ probe.version || '(版本未知)' }} ·
                                    {{ probe.mode === 'source' ? '源码模式' : probe.mode === 'release' ? '发行包模式' : '自定义布局' }}
                                </p>
                                <p class="mt-1 text-muted-foreground">
                                    配置目录：<span class="font-mono break-all">{{ probe.configDir }}</span>
                                </p>
                                <p class="text-muted-foreground">
                                    数据目录：<span class="font-mono break-all">{{ probe.dataDir }}</span>
                                    <span v-if="!probe.onebotPortListening" class="ml-1 text-warning">
                                        （OneBot :{{ probe.onebotPort }} 未监听）
                                    </span>
                                </p>
                                <p v-if="probe.reason" class="text-muted-foreground">
                                    判定依据：{{ probe.reason }}
                                </p>
                                <p
                                    v-if="probe.alternatives?.length"
                                    class="mt-1 text-muted-foreground/70"
                                >
                                    另有 {{ probe.alternatives.length }} 套未采用的配置目录
                                </p>
                                <p class="mt-1 text-muted-foreground">
                                    已登录账号：<span v-if="probe.accounts.length === 0" class="text-warning">无（请先在 SnowLuma 登录 QQ）</span>
                                    <span v-else class="font-mono">{{ probe.accounts.map((a) => a.uin).join(', ') }}</span>
                                </p>
                            </template>
                            <p v-else class="text-destructive">{{ probe.error }}</p>
                        </div>
                    </div>
                </div>

                <!-- 账号与端口 -->
                <div class="grid gap-4 sm:grid-cols-3">
                    <div>
                        <label class="text-xs font-medium text-muted-foreground">QQ 号</label>
                        <UiInput
                            v-model="snowUin"
                            class="mt-1.5"
                            mono
                            placeholder="登录后自动识别"
                        />
                    </div>
                    <div>
                        <label class="text-xs font-medium text-muted-foreground">WebUI 端口</label>
                        <UiInput v-model.number="snowWebuiPort" type="number" class="mt-1.5" />
                    </div>
                    <div>
                        <label class="text-xs font-medium text-muted-foreground">OneBot 端口</label>
                        <UiInput v-model.number="snowPort" type="number" class="mt-1.5" />
                    </div>
                </div>
            </div>

            <!-- 一键配置结果 -->
            <div v-if="applyResult" class="border-t border-border/40 px-5 py-4">
                <div
                    class="rounded-lg border px-3.5 py-3"
                    :class="applyResult.needRestart
                        ? 'border-warning/35 bg-warning/5'
                        : 'border-success/35 bg-success/5'"
                >
                    <p
                        class="flex items-center gap-1.5 text-xs font-medium"
                        :class="applyResult.needRestart ? 'text-warning' : 'text-success'"
                    >
                        <CheckCircle2 class="size-4" />
                        {{ applyResult.needRestart ? '配置已写入' : '连接已就绪，无需改动' }}
                    </p>
                    <div class="mt-2 grid gap-1.5 text-xs">
                        <div class="flex gap-2">
                            <span class="w-20 shrink-0 text-muted-foreground">连接地址</span>
                            <span class="font-mono">{{ applyResult.endpoint }}</span>
                        </div>
                        <div class="flex items-center gap-2">
                            <span class="w-20 shrink-0 text-muted-foreground">Access Token</span>
                            <span class="min-w-0 flex-1 truncate font-mono">{{ applyResult.token }}</span>
                            <button
                                class="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                                title="复制"
                                @click="copyToken"
                            >
                                <Copy class="size-3.5" />
                            </button>
                        </div>
                        <div class="flex gap-2">
                            <span class="w-20 shrink-0 text-muted-foreground">配置文件</span>
                            <span class="min-w-0 flex-1 break-all font-mono">{{ applyResult.path }}</span>
                        </div>
                        <div class="flex gap-2">
                            <span class="w-20 shrink-0 text-muted-foreground">状态</span>
                            <span :class="applyResult.needRestart ? 'text-warning' : 'text-success'">
                                {{ applyResult.created ? '新建配置' : applyResult.changed ? '已更新配置' : '配置已匹配，未做修改' }}
                            </span>
                        </div>
                    </div>
                    <p v-if="applyResult.needRestart" class="mt-2 flex items-start gap-1.5 text-xs text-warning">
                        <AlertTriangle class="mt-0.5 size-3.5 shrink-0" />
                        需重启 SnowLuma 使配置生效（OneBot 服务在启动时读取）
                    </p>
                </div>
            </div>

            <!-- 操作 -->
            <div class="flex flex-wrap items-center gap-2 border-t border-border/60 px-5 py-3">
                <UiButton
                    variant="default"
                    size="sm"
                    :disabled="applying || !snowDir"
                    @click="doApply(false)"
                >
                    <Wand2 class="size-4" />
                    {{ applying ? '配置中…' : '自动配置连接' }}
                </UiButton>
                <UiButton
                    variant="outline"
                    size="sm"
                    :disabled="applying || !snowDir"
                    @click="doApply(true)"
                >
                    <RefreshCw class="size-4" />
                    重置 Token 并配置
                </UiButton>
                <div class="flex-1" />
                <UiButton variant="ghost" size="sm" @click="openSnowUI">
                    <ExternalLink class="size-4" />
                    打开 SnowLuma 界面
                </UiButton>
            </div>

            <div class="border-t border-border/40 px-5 py-3">
                <p class="flex items-start gap-1.5 text-xs text-muted-foreground">
                    <Info class="mt-0.5 size-3.5 shrink-0" />
                    「自动配置连接」会写入
                    <code class="mx-1 font-mono">config/onebot_&lt;QQ号&gt;.json</code>
                    的 wsServer，并把地址与 Token 同步到 Bridge 的上游连接，无需手动复制粘贴
                </p>
            </div>
        </UiCard>

        <!-- ================= SillyTavern ================= -->
        <UiCard v-for="svc in services" :key="svc.name">
            <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-5 py-4">
                <div class="flex items-center gap-3">
                    <div class="flex size-10 items-center justify-center rounded-xl bg-aurora/15 text-aurora">
                        <Server class="size-5" />
                    </div>
                    <div>
                        <h2 class="text-sm font-semibold tracking-tight">{{ svc.label }}</h2>
                        <p class="text-xs text-muted-foreground">{{ svc.desc }}</p>
                    </div>
                </div>
                <div class="flex items-center gap-2">
                    <UiBadge tone="secondary" dot>已停止</UiBadge>
                    <UiBadge v-if="svc.port" tone="outline" class="font-mono text-micro">:{{ svc.port }}</UiBadge>
                </div>
            </div>

            <div class="grid gap-4 px-5 py-4 lg:grid-cols-2">
                <div>
                    <label class="text-xs font-medium text-muted-foreground">运行模式</label>
                    <UiSelect v-model="svc.mode" :options="modeOptions" class="mt-1.5" />
                </div>
                <div>
                    <label class="text-xs font-medium text-muted-foreground">版本</label>
                    <div class="mt-1.5 flex items-center gap-2">
                        <UiInput :model-value="svc.version" disabled class="flex-1" />
                        <UiButton variant="outline" size="sm" @click="toast.info('检查更新', '尚未提供版本接口')">
                            <Download class="size-4" />
                        </UiButton>
                    </div>
                </div>
                <div v-if="svc.mode === 'external'" class="lg:col-span-2">
                    <label class="text-xs font-medium text-muted-foreground">服务地址</label>
                    <UiInput v-model="svc.endpoint" class="mt-1.5" mono />
                </div>
                <div v-else-if="svc.mode === 'managed'" class="lg:col-span-2">
                    <label class="text-xs font-medium text-muted-foreground">安装目录</label>
                    <div class="mt-1.5 flex items-center gap-2">
                        <UiInput v-model="svc.installDir" class="flex-1" mono />
                        <UiButton variant="outline" size="sm" @click="toast.info('目录选择器', '将在后续版本提供')">
                            <FolderOpen class="size-4" />
                        </UiButton>
                    </div>
                </div>
            </div>

            <div class="flex flex-wrap items-center gap-2 border-t border-border/60 px-5 py-3">
                <UiButton variant="default" size="sm" @click="toast.info('启动服务', '服务编排器未接入')">
                    <Play class="size-4" />
                    启动
                </UiButton>
                <UiButton variant="outline" size="sm" disabled @click="toast.info('停止服务', '服务编排器未接入')">
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

        <UiCard class="border-info/30 bg-info/5">
            <div class="px-5 py-4">
                <p class="text-sm font-medium">服务编排说明</p>
                <ul class="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
                    <li>• <strong>SnowLuma</strong>：已支持目录探测 + OneBot 配置自动写入</li>
                    <li>• <strong>SillyTavern</strong>：下载、启停、健康检查将在后续版本提供</li>
                    <li>• 进程本身的服务托管不在此处，请用 mcmanager 等工具管理</li>
                </ul>
            </div>
        </UiCard>
    </div>
</template>
