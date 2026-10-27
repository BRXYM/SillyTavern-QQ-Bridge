<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
    Server, Play, Square, RotateCw, Download, ExternalLink, FolderOpen, RefreshCw,
    Wand2, CheckCircle2, AlertTriangle, Info, Copy, Trash2, Save, Eye, EyeOff,
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
async function doDiscover(opts: { silent?: boolean } = {}) {
    discovering.value = true;
    discoverResult.value = null;
    try {
        const r = await api.discoverSnowLuma(snowDir.value.trim());
        discoverResult.value = r;

        if (!r.found || r.candidates.length === 0) {
            if (!opts.silent) {
                toast.warning(
                    '未自动找到 SnowLuma',
                    '请手动填写目录。可设置环境变量 SNOWLUMA_DIR 让检测更准',
                );
            }
            return;
        }

        // 优先选「运行中的进程」这类强信号，其次第一个
        const best =
            r.candidates.find((c) => c.source.includes('运行中的进程') && c.ok) ??
            r.candidates.find((c) => c.ok) ??
            r.candidates[0];

        if (best) {
            snowDir.value = best.dir;
            if ((best.accounts ?? []).length > 0 && !snowUin.value) {
                snowUin.value = (best.accounts ?? [])[0]!;
            }
            // 进入页面时的自动检测不弹通知
            if (!opts.silent) {
                toast.success(`已定位 SnowLuma`, `${best.dir} · ${best.source}`);
            }
            void doProbe({ silent: opts.silent });
        }
    } catch (e) {
        if (!opts.silent) {
            toast.error('自动检测失败', e instanceof Error ? e.message : String(e));
        }
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

// ---------------- OneBot 连接（原系统设置页迁入） ----------------
const onebotUrl = ref('ws://127.0.0.1:3001');
const onebotToken = ref('');
const showToken = ref(false);
const savingOnebot = ref(false);
const loadingOnebot = ref(false);
/** 已保存值的快照，用于判断脏状态 */
const onebotSnapshot = ref('');

const upstreamConnected = computed(() => store.onebotConnected);

const onebotDirty = computed(
    () => `${onebotUrl.value}\u0000${onebotToken.value}` !== onebotSnapshot.value,
);

function syncOnebotFromStore() {
    const c = store.status?.config as Record<string, unknown> | undefined;
    if (!c) return;
    onebotUrl.value = (c['onebotUrl'] as string) ?? 'ws://127.0.0.1:3001';
    onebotToken.value = (c['onebotToken'] as string) ?? '';
    onebotSnapshot.value = `${onebotUrl.value}\u0000${onebotToken.value}`;
}

async function saveOnebot() {
    savingOnebot.value = true;
    try {
        await api.updateConfig({
            onebotUrl: onebotUrl.value.trim(),
            onebotToken: onebotToken.value.trim(),
        });
        await store.refresh();
        syncOnebotFromStore();
        toast.success('连接配置已保存', '上游连接参数变更后会自动重连');
    } catch (e) {
        toast.error('保存失败', e instanceof Error ? e.message : String(e));
    } finally {
        savingOnebot.value = false;
    }
}

/** 从 SnowLuma 的 onebot_<uin>.json 读取地址与 Token 并填入表单 */
async function loadOnebotFromSnowLuma() {
    const uin = snowUin.value.trim();
    if (!uin) {
        toast.warning('请先填写 QQ 号', '需要 QQ 号才能定位对应账号的配置');
        return;
    }
    loadingOnebot.value = true;
    try {
        const r = await api.readSnowLumaConfig(uin, snowDir.value.trim());
        const cfg = r.config as
            | { networks?: { wsServers?: Array<{ host?: string; port?: number; path?: string; accessToken?: string }> } }
            | null;
        const ws = cfg?.networks?.wsServers?.[0];
        if (!ws) {
            toast.warning('未找到 wsServer 配置', '该账号尚未配置 OneBot 服务端，可先点「自动配置连接」');
            return;
        }
        const host = ws.host || '127.0.0.1';
        const port = ws.port ?? 3001;
        const p = ws.path && ws.path !== '/' ? ws.path : '';
        onebotUrl.value = `ws://${host}:${port}${p}`;
        if (ws.accessToken) onebotToken.value = ws.accessToken;
        toast.success('已读取 SnowLuma 配置', `${onebotUrl.value} · ${ws.accessToken ? '含 Token' : '无 Token'}`);
    } catch (e) {
        toast.error('读取失败', e instanceof Error ? e.message : String(e));
    } finally {
        loadingOnebot.value = false;
    }
}

async function doProbe(opts: { keepResult?: boolean; silent?: boolean } = {}) {
    if (!snowDir.value.trim()) {
        if (!opts.silent) toast.warning('请先填写 SnowLuma 目录');
        return;
    }
    probing.value = true;
    // 手动探测时清空上次结果；自动配置后刷新探测则保留结果面板
    if (!opts.keepResult) applyResult.value = null;
    try {
        const r = await api.probeSnowLuma(snowDir.value.trim(), snowWebuiPort.value);
        probe.value = r;
        if (!r.ok) {
            if (!opts.silent) toast.error('目录探测失败', r.error);
            return;
        }
        // 自动选中第一个账号
        if (!snowUin.value && r.accounts.length > 0) {
            snowUin.value = r.accounts[0]!.uin;
        }
        // 自动探测（进入页面时）不弹通知，避免每次进入都打扰
        if (!opts.silent) {
            toast.success(
                `已识别 SnowLuma ${r.version || '(未知版本)'}`,
                `${r.mode === 'source' ? '源码模式' : r.mode === 'release' ? '发行包模式' : '自定义布局'} · ${r.accounts.length} 个账号`,
            );
        }
    } catch (e) {
        if (!opts.silent) toast.error('探测失败', e instanceof Error ? e.message : String(e));
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
        // 刷新探测状态（保留结果面板，静默避免叠加通知）
        void doProbe({ keepResult: true, silent: true });
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

    // OneBot 连接表单
    syncOnebotFromStore();

    const saved = cfg?.['snowlumaDir'];
    if (typeof saved === 'string' && saved) {
        snowDir.value = saved;
        const p = cfg?.['snowlumaWebuiPort'];
        if (typeof p === 'number' && p > 0) snowWebuiPort.value = p;
        // 进入页面自动探测：静默，不弹通知
        void doProbe({ silent: true });
    } else {
        // 首次使用：自动尝试定位 SnowLuma（静默）
        void doDiscover({ silent: true });
    }
    const url = cfg?.['onebotUrl'];
    if (typeof url === 'string') {
        const m = url.match(/:(\d+)/);
        if (m) snowPort.value = Number(m[1]);
    }

});
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
                    <UiBadge
                        :tone="snowState === 'running' ? 'success' : snowState === 'stopped' ? 'secondary' : 'warning'"
                        dot
                        :pulse="snowState === 'running'"
                    >
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
                                    @click="useCandidate(c.dir, c.accounts ?? [])"
                                >
                                    <div class="min-w-0 flex-1">
                                        <p class="truncate font-mono text-[11px]">{{ c.dir }}</p>
                                        <p class="mt-0.5 truncate text-[11px] text-muted-foreground">
                                            {{ c.source }}
                                            <span v-if="c.version" class="ml-1">· v{{ c.version }}</span>
                                            <span v-if="(c.accounts ?? []).length" class="ml-1 text-primary">
                                                · {{ (c.accounts ?? []).join(', ') }}
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

            <!-- OneBot 连接（原系统设置页迁入） -->
            <div class="border-t border-border/40 px-5 py-4">
                <div class="mb-3 flex items-center justify-between">
                    <div>
                        <h3 class="text-[13px] font-semibold tracking-tight">OneBot 连接</h3>
                        <p class="text-xs text-muted-foreground">
                            Bridge 主动连接 SnowLuma 的 WebSocket 服务端
                        </p>
                    </div>
                    <UiBadge
                        :tone="upstreamConnected ? 'success' : 'secondary'"
                        dot
                        :pulse="upstreamConnected"
                        class="shrink-0"
                    >
                        {{ upstreamConnected ? '已连接' : '未连接' }}
                    </UiBadge>
                </div>

                <div class="grid gap-4 sm:grid-cols-2">
                    <div>
                        <label class="text-xs font-medium text-muted-foreground">WebSocket 地址</label>
                        <UiInput v-model="onebotUrl" class="mt-1.5" mono placeholder="ws://127.0.0.1:3001" />
                    </div>
                    <div>
                        <label class="text-xs font-medium text-muted-foreground">Access Token</label>
                        <div class="mt-1.5 flex items-center gap-2">
                            <UiInput
                                v-model="onebotToken"
                                :type="showToken ? 'text' : 'password'"
                                class="flex-1"
                                mono
                                placeholder="留空 = 不鉴权"
                            />
                            <UiButton
                                variant="ghost"
                                size="icon"
                                :title="showToken ? '隐藏 Token' : '显示 Token'"
                                @click="showToken = !showToken"
                            >
                                <Eye v-if="!showToken" class="size-4" />
                                <EyeOff v-else class="size-4" />
                            </UiButton>
                        </div>
                    </div>
                </div>

                <div class="mt-3 flex flex-wrap items-center gap-2">
                    <UiButton size="sm" :disabled="savingOnebot || !onebotDirty" @click="saveOnebot">
                        <Save class="size-4" />
                        {{ savingOnebot ? '保存中…' : '保存连接配置' }}
                    </UiButton>
                    <UiButton
                        variant="outline"
                        size="sm"
                        :disabled="loadingOnebot || !snowDir"
                        @click="loadOnebotFromSnowLuma"
                    >
                        <Download class="size-4" />
                        {{ loadingOnebot ? '读取中…' : '从 SnowLuma 读取' }}
                    </UiButton>
                    <span v-if="onebotDirty" class="text-[11px] text-warning">有未保存的修改</span>
                    <div class="flex-1" />
                    <span class="hidden text-[11px] text-muted-foreground sm:block">
                        端口须与上方 OneBot 端口一致
                    </span>
                </div>
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

        <UiCard class="border-info/30 bg-info/5">
            <div class="px-5 py-4">
                <p class="text-sm font-medium">接入说明</p>
                <ul class="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
                    <li>• <strong>SnowLuma</strong> 是唯一上游，这里负责目录探测与 OneBot 配置写入</li>
                    <li>• 需要把消息交给谁（dsh / 酒馆）在「下游管理」里配置</li>
                    <li>• 进程的启动与停止不在此处，请用 mcmanager 等工具管理</li>
                </ul>
            </div>
        </UiCard>
    </div>
</template>
