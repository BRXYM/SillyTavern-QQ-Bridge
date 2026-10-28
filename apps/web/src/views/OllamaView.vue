<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
    Cpu, Play, Square, RefreshCw, Download, Trash2, CheckCircle2, AlertTriangle,
    Info, Loader2, Zap, Image as ImageIcon, MessageSquare, Save, HardDrive,
    ArrowUpCircle, Tag, X, Wrench,
} from 'lucide-vue-next';
import UiCard from '@/components/ui/UiCard.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiBadge from '@/components/ui/UiBadge.vue';
import UiInput from '@/components/ui/UiInput.vue';
import UiSelect from '@/components/ui/UiSelect.vue';
import {
    ollamaApi, formatBytes,
    type OllamaStatus, type OllamaModel, type OllamaPullJob, type OllamaModelDetail,
} from '@/api/ollama';
import { useToastStore } from '@/stores/toast';

const toast = useToastStore();

// ---------------- 基础状态 ----------------
const loading = ref(false);
const status = ref<OllamaStatus | null>(null);
const models = ref<OllamaModel[]>([]);

const starting = ref(false);
const stopping = ref(false);

/** 单个模型的操作锁：name -> 动作名 */
const busy = ref<Record<string, string>>({});

// ---------------- 服务配置 ----------------
const exePath = ref('');
const modelsDir = ref('');
const baseUrl = ref('http://127.0.0.1:11434');
const savingConfig = ref(false);

// ---------------- 拉取 ----------------
const pullName = ref('');
const pulling = ref(false);
const pullJob = ref<OllamaPullJob | null>(null);

// ---------------- 打标模型 ----------------
const visionModel = ref('');
const textModel = ref('');
const savingSelect = ref(false);

// ---------------- 测试 ----------------
const testPrompt = ref('用一句话介绍你自己。');
const testResult = ref('');
const testRunning = ref(false);
const testElapsed = ref(0);
const testModel = ref('');

const visionPath = ref('');
const visionTestModel = ref('');
const visionPrompt = ref('用不超过 40 个字描述这张表情包：画面主体、表情动作、传达的情绪。');
const visionResult = ref('');
const visionRunning = ref(false);
const visionElapsed = ref(0);

// ---------------- 详情弹窗 ----------------
const detail = ref<OllamaModelDetail | null>(null);
const detailLoading = ref(false);

let pollTimer: number | null = null;

const online = computed(() => status.value?.online ?? false);

/**
 * 后端是否在跑旧代码。
 *
 * 判定依据：新版 /api/ollama/status 一定会返回 diskModelCount，
 * 老版没有这个字段。之前排查"模型看不到"卡了很久，
 * 就是因为运行中的进程是改动前的旧代码，页面却毫无提示。
 */
const staleBackend = computed(() => {
    const s = status.value;
    if (!s) return false;
    return s.diskModelCount === undefined;
});
const modelOptions = computed(() =>
    models.value.map((m) => ({
        value: m.name,
        label: `${m.name}${m.parameterSize ? ` · ${m.parameterSize}` : ''}`,
    })),
);

const loadedCount = computed(() => models.value.filter((m) => m.loaded).length);

/** 只有具备 vision 能力的模型才能用于识图 */
const visionModelOptions = computed(() => {
    const list = models.value.filter((m) => m.capabilities.includes('vision'));
    if (list.length) {
        return list.map((m) => ({
            value: m.name,
            label: `${m.name}${m.parameterSize ? ` · ${m.parameterSize}` : ''}`,
        }));
    }
    // 一个视觉模型都没有时退回全部，避免下拉为空无法选
    return modelOptions.value;
});

const totalSize = computed(() => models.value.reduce((s, m) => s + m.sizeBytes, 0));

// ---------------- 加载 ----------------
async function loadAll(opts: { silent?: boolean } = {}) {
    loading.value = true;
    try {
        const s = await ollamaApi.status();
        status.value = s;
        pullJob.value = s.pull;
        if (s.pull.running) startPolling();

        exePath.value = s.daemon.exePath;
        modelsDir.value = s.daemon.modelsDir;
        baseUrl.value = s.baseUrl;

        // 打标模型只在首次进入或后端变更时覆盖，避免编辑中被冲掉
        if (!visionModel.value) visionModel.value = s.visionModel;
        if (!textModel.value) textModel.value = s.textModel;
        if (!testModel.value) testModel.value = s.visionModel;
        if (!visionTestModel.value) visionTestModel.value = s.visionModel;

        if (s.online) {
            const r = await ollamaApi.models();
            models.value = r.models;
        } else {
            models.value = [];
            if (!opts.silent) {
                toast.warning('Ollama 未运行', s.error || '可点「启动服务」尝试拉起');
            }
        }
    } catch (e) {
        if (!opts.silent) {
            toast.error('读取 Ollama 状态失败', e instanceof Error ? e.message : String(e));
        }
    } finally {
        loading.value = false;
    }
}

// ---------------- 服务启停 ----------------
async function startService() {
    starting.value = true;
    try {
        const r = await ollamaApi.start();
        toast.success(
            r.alreadyRunning ? 'Ollama 已在运行' : 'Ollama 已启动',
            `版本 ${r.version || '未知'}`,
        );
        await loadAll({ silent: true });
    } catch (e) {
        toast.error('启动失败', e instanceof Error ? e.message : String(e));
    } finally {
        starting.value = false;
    }
}

async function stopService() {
    stopping.value = true;
    try {
        const r = await ollamaApi.stop();
        if (r.ok) {
            toast.success('Ollama 已停止', '模型已卸载，显存已释放');
        } else {
            toast.warning('无法停止', r.error ?? '未知原因');
        }
        await loadAll({ silent: true });
    } catch (e) {
        toast.error('停止失败', e instanceof Error ? e.message : String(e));
    } finally {
        stopping.value = false;
    }
}

// ---------------- 一键修复模型目录 ----------------
const repairing = ref(false);

async function repairService() {
    repairing.value = true;
    try {
        const r = await ollamaApi.repair();
        if (r.ok) {
            toast.success('修复完成', `现在可见 ${r.modelCount ?? 0} 个模型`);
        } else {
            toast.warning('需要手动处理', r.hint ?? r.error ?? '未知原因');
        }
        await loadAll({ silent: true });
    } catch (e) {
        toast.error('修复失败', e instanceof Error ? e.message : String(e));
    } finally {
        repairing.value = false;
    }
}

/**
 * 保存服务配置。
 *
 * 提交到 /api/ollama/select：因为地址、模型名、可执行文件路径、模型目录
 * 这几项要一起生效 —— 客户端、守护进程、打标器三者共用同一份。
 * 只改其中一项就走 updateConfig 会让它们不同步。
 */
async function saveServiceConfig() {
    savingConfig.value = true;
    try {
        await ollamaApi.select({
            baseUrl: baseUrl.value.trim(),
            exePath: exePath.value.trim(),
            modelsDir: modelsDir.value.trim(),
        });
        toast.success('已保存', '配置已生效，无需重启 Bridge');
        await loadAll({ silent: true });
    } catch (e) {
        toast.error('保存失败', e instanceof Error ? e.message : String(e));
    } finally {
        savingConfig.value = false;
    }
}

// ---------------- 模型操作 ----------------
async function loadModel(m: OllamaModel) {
    busy.value = { ...busy.value, [m.name]: 'load' };
    try {
        await ollamaApi.load(m.name, '30m');
        toast.success('已加载', `${m.name} 已驻留内存 30 分钟`);
        await loadAll({ silent: true });
    } catch (e) {
        toast.error('加载失败', e instanceof Error ? e.message : String(e));
    } finally {
        const b = { ...busy.value };
        delete b[m.name];
        busy.value = b;
    }
}

async function unloadModel(m: OllamaModel) {
    busy.value = { ...busy.value, [m.name]: 'unload' };
    try {
        await ollamaApi.unload(m.name);
        toast.success('已卸载', `${m.name} 已从显存释放`);
        await loadAll({ silent: true });
    } catch (e) {
        toast.error('卸载失败', e instanceof Error ? e.message : String(e));
    } finally {
        const b = { ...busy.value };
        delete b[m.name];
        busy.value = b;
    }
}

async function removeModel(m: OllamaModel) {
    const usedAsVision = m.name === status.value?.visionModel;
    const usedAsText = m.name === status.value?.textModel;
    if (usedAsVision || usedAsText) {
        toast.warning(
            '该模型正在被使用',
            usedAsVision
                ? '它是当前表情打标模型，删除后打标会失败，请先切换到其他模型'
                : '它是当前标签收敛模型，删除后打标会失败，请先切换',
        );
        return;
    }
    if (!window.confirm(`确定删除模型 ${m.name}？\n将释放 ${formatBytes(m.sizeBytes)} 磁盘空间，不可恢复。`)) {
        return;
    }
    busy.value = { ...busy.value, [m.name]: 'delete' };
    try {
        await ollamaApi.remove(m.name);
        toast.success('已删除', m.name);
        await loadAll({ silent: true });
    } catch (e) {
        toast.error('删除失败', e instanceof Error ? e.message : String(e));
    } finally {
        const b = { ...busy.value };
        delete b[m.name];
        busy.value = b;
    }
}

async function showDetail(m: OllamaModel) {
    detailLoading.value = true;
    detail.value = { ok: false, name: m.name } as OllamaModelDetail;
    try {
        detail.value = await ollamaApi.show(m.name);
    } catch (e) {
        toast.error('读取详情失败', e instanceof Error ? e.message : String(e));
        detail.value = null;
    } finally {
        detailLoading.value = false;
    }
}

// ---------------- 拉取 ----------------
async function startPull() {
    const name = pullName.value.trim();
    if (!name) {
        toast.warning('请填写模型名', '例如 qwen2.5vl:3b 或 llama3.2');
        return;
    }
    pulling.value = true;
    try {
        const r = await ollamaApi.pull(name);
        pullJob.value = r.pull;
        toast.info('开始拉取', `${name} 正在后台下载`);
        startPolling();
    } catch (e) {
        toast.error('无法开始拉取', e instanceof Error ? e.message : String(e));
    } finally {
        pulling.value = false;
    }
}

async function pollPull() {
    try {
        const p = await ollamaApi.pullProgress();
        pullJob.value = p;
        if (!p.running) {
            if (pollTimer !== null) {
                window.clearInterval(pollTimer);
                pollTimer = null;
            }
            if (p.error) {
                toast.error('拉取失败', p.error);
            } else if (p.finishedAt) {
                toast.success('拉取完成', p.model);
            }
            await loadAll({ silent: true });
        }
    } catch {
        /* 忽略轮询失败 */
    }
}

function startPolling() {
    if (pollTimer !== null) return;
    void pollPull();
    pollTimer = window.setInterval(() => void pollPull(), 1200);
}

// ---------------- 打标模型 ----------------
async function saveTaggingModel() {
    savingSelect.value = true;
    try {
        await ollamaApi.select({
            visionModel: visionModel.value.trim(),
            textModel: textModel.value.trim(),
        });
        toast.success('已切换打标模型', visionModel.value || '（未设置）');
    } catch (e) {
        toast.error('保存失败', e instanceof Error ? e.message : String(e));
    } finally {
        savingSelect.value = false;
    }
}

function useAsVision(m: OllamaModel) {
    visionModel.value = m.name;
    void saveTaggingModel();
}

// ---------------- 连通性测试 ----------------
async function runTest() {
    const model = testModel.value.trim();
    if (!model) {
        toast.warning('请选择模型');
        return;
    }
    testRunning.value = true;
    testResult.value = '';
    try {
        const r = await ollamaApi.chat({
            model,
            prompt: testPrompt.value.trim() || '你好',
            numPredict: 200,
        });
        testResult.value = r.content;
        testElapsed.value = r.elapsedMs;
        toast.success('对话成功', `耗时 ${(r.elapsedMs / 1000).toFixed(1)}s`);
        await loadAll({ silent: true });
    } catch (e) {
        toast.error('对话失败', e instanceof Error ? e.message : String(e));
    } finally {
        testRunning.value = false;
    }
}

async function runVisionTest() {
    const model = visionTestModel.value.trim() || visionModel.value.trim();
    if (!model) {
        toast.warning('请先选择视觉模型');
        return;
    }
    if (!visionPath.value.trim()) {
        toast.warning('请填写图片路径', '本地绝对路径，例如 D:\\pic\\a.jpg');
        return;
    }
    visionRunning.value = true;
    visionResult.value = '';
    try {
        const r = await ollamaApi.vision({
            model,
            prompt: visionPrompt.value.trim(),
            imagePath: visionPath.value.trim(),
        });
        visionResult.value = r.content;
        visionElapsed.value = r.elapsedMs;
        toast.success('识别成功', `耗时 ${(r.elapsedMs / 1000).toFixed(1)}s`);
    } catch (e) {
        toast.error('识别失败', e instanceof Error ? e.message : String(e));
    } finally {
        visionRunning.value = false;
    }
}

// ---------------- 生命周期 ----------------
onMounted(() => void loadAll({ silent: true }));
onUnmounted(() => {
    if (pollTimer !== null) window.clearInterval(pollTimer);
});

const capabilityLabel: Record<string, string> = {
    completion: '文本',
    vision: '视觉',
    embedding: '向量',
    tools: '工具',
};
</script>

<template>
    <div class="flex flex-col gap-5">
        <!-- ============ 服务状态 ============ -->
        <UiCard>
            <!-- 后端代码过期：最常见的"改了没生效" -->
            <div v-if="staleBackend" class="border-b border-border/60 bg-destructive/10 px-5 py-3">
                <div class="flex items-start gap-2">
                    <AlertTriangle class="mt-0.5 size-3.5 shrink-0 text-destructive" />
                    <div class="min-w-0 text-[11px] leading-relaxed text-muted-foreground">
                        <p class="font-medium text-foreground">后端在运行旧代码</p>
                        <p class="mt-0.5">
                            当前接口返回的字段与前端不匹配，说明 Node 后端进程还是改动前启动的那个。
                            刷新页面不会让后端重新加载代码，必须重启进程。
                        </p>
                        <p class="mt-1 font-medium text-foreground">解决办法</p>
                        <p class="mt-0.5">
                            在项目根目录双击 <code class="font-mono">restart.cmd</code>，
                            或在终端执行 <code class="font-mono">pnpm dev</code>（先停掉旧的）。
                            如果提示端口无法释放，用管理员身份运行该脚本。
                        </p>
                    </div>
                </div>
            </div>
            <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-5 py-4">
                <div class="flex items-center gap-3">
                    <div class="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                        <Cpu class="size-5" />
                    </div>
                    <div>
                        <h2 class="text-sm font-semibold tracking-tight">Ollama 本地模型</h2>
                        <p class="text-xs text-muted-foreground">
                            管理本机已安装的模型与运行状态（不负责安装 Ollama）
                        </p>
                    </div>
                </div>
                <div class="flex flex-wrap items-center gap-2">
                    <UiBadge :tone="online ? 'success' : 'destructive'" dot :pulse="online">
                        {{ online ? '运行中' : '未运行' }}
                    </UiBadge>
                    <UiBadge v-if="status?.version" tone="outline" class="text-micro">
                        v{{ status.version }}
                    </UiBadge>
                    <UiButton
                        variant="outline"
                        size="sm"
                        :disabled="loading"
                        @click="loadAll()"
                    >
                        <RefreshCw class="size-3.5" :class="loading ? 'animate-spin' : ''" />
                        刷新
                    </UiButton>
                </div>
            </div>

            <!-- 关键信息 -->
            <div class="grid gap-x-6 gap-y-2 border-b border-border/40 px-5 py-3.5 text-[11px] sm:grid-cols-2 lg:grid-cols-4">
                <div class="flex items-center gap-1.5">
                    <span class="text-muted-foreground">地址</span>
                    <span class="truncate font-mono">{{ status?.baseUrl ?? '—' }}</span>
                </div>
                <div class="flex items-center gap-1.5">
                    <span class="text-muted-foreground">可执行文件</span>
                    <span
                        class="truncate font-mono"
                        :class="status?.daemon.exeExists ? 'text-success' : 'text-warning'"
                        :title="status?.daemon.exePath"
                    >
                        {{ status?.daemon.exeExists ? '已找到' : '未找到' }}
                    </span>
                </div>
                <div class="flex items-center gap-1.5">
                    <span class="text-muted-foreground">已下载</span>
                    <span class="font-mono">{{ models.length }} 个 / {{ formatBytes(totalSize) }}</span>
                </div>
                <div class="flex items-center gap-1.5">
                    <span class="text-muted-foreground">已加载</span>
                    <span class="font-mono" :class="loadedCount ? 'text-success' : ''">
                        {{ loadedCount }} 个
                    </span>
                </div>
            </div>

            <!-- 未运行提示 -->
            <div
                v-if="status && !online"
                class="border-b border-border/40 bg-warning/10 px-5 py-3"
            >
                <div class="flex items-start gap-2">
                    <AlertTriangle class="mt-0.5 size-3.5 shrink-0 text-warning" />
                    <div class="min-w-0 text-[11px] leading-relaxed text-muted-foreground">
                        <p class="font-medium text-foreground">Ollama 服务未监听 {{ status.baseUrl }}</p>
                        <p class="mt-0.5">
                            {{ status.error }}
                        </p>
                        <p class="mt-0.5">
                            如果已安装 Ollama，点「启动服务」由 Bridge 拉起；
                            未找到可执行文件时请在下方填写完整路径。
                        </p>
                    </div>
                </div>
            </div>

            <!-- 关键告警：磁盘有模型但服务看不到 -->
            <div
                v-if="status?.envMismatch"
                class="border-b border-border/40 bg-destructive/10 px-5 py-3"
            >
                <div class="flex items-start gap-2">
                    <AlertTriangle class="mt-0.5 size-3.5 shrink-0 text-destructive" />
                    <div class="min-w-0 text-[11px] leading-relaxed text-muted-foreground">
                        <p class="font-medium text-foreground">
                            Ollama 正在运行，但看不到本地已下载的
                            {{ status.diskModelCount }} 个模型
                        </p>
                        <p class="mt-0.5">
                            模型在磁盘上是存在的（{{ status.daemon.modelsDir || '已探测到模型目录' }}），
                            只是当前这个 Ollama 进程启动时没有拿到这个目录，
                            所以它读的是默认位置（<code class="font-mono">%USERPROFILE%\.ollama\models</code>）。
                        </p>
                        <p class="mt-1 font-medium text-foreground">解决办法：重启这个 Ollama 进程</p>
                        <p class="mt-0.5">
                            如果它是 Bridge 启动的，点「停止服务」再「启动服务」即可修复；
                            如果点停止提示无权限，说明它是开机自启或用别的账户跑的，
                            请到任务管理器里结束 <code class="font-mono">ollama.exe</code> 后，再点「启动服务」。
                        </p>
                        <UiButton size="sm" class="mt-2" :disabled="repairing" @click="repairService">
                            <Loader2 v-if="repairing" class="size-3.5 animate-spin" />
                            <Wrench v-else class="size-3.5" />
                            {{ repairing ? '修复中…' : '一键修复' }}
                        </UiButton>
                    </div>
                </div>
            </div>

            <!-- 操作 -->
            <div class="flex flex-wrap items-center gap-2 px-5 py-3">
                <UiButton size="sm" :disabled="starting || online" @click="startService">
                    <Loader2 v-if="starting" class="size-4 animate-spin" />
                    <Play v-else class="size-4" />
                    {{ starting ? '启动中…' : '启动服务' }}
                </UiButton>
                <UiButton
                    variant="outline"
                    size="sm"
                    :disabled="stopping || !online"
                    @click="stopService"
                >
                    <Loader2 v-if="stopping" class="size-4 animate-spin" />
                    <Square v-else class="size-4" />
                    {{ stopping ? '停止中…' : '停止服务' }}
                </UiButton>
                <div class="flex-1" />
                <span
                    v-if="status?.daemon.startedByUs"
                    class="text-[11px] text-muted-foreground"
                >
                    该进程由 Bridge 启动，可直接停止
                </span>
                <span
                    v-else-if="online && !status?.daemon.managed"
                    class="text-[11px] text-muted-foreground"
                >
                    进程非 Bridge 启动，停止需用任务管理器
                </span>
            </div>
        </UiCard>

        <!-- ============ 服务配置 ============ -->
        <UiCard>
            <div class="flex items-center gap-2 border-b border-border/60 px-5 py-3.5">
                <HardDrive class="size-4 text-muted-foreground" />
                <h3 class="text-sm font-semibold tracking-tight">服务配置</h3>
                <span class="text-[11px] text-muted-foreground">保存后立即生效</span>
            </div>
            <div class="grid gap-4 px-5 py-4 lg:grid-cols-2">
                <div class="flex flex-col gap-1.5">
                    <label class="text-xs font-medium">服务地址</label>
                    <UiInput v-model="baseUrl" mono placeholder="http://127.0.0.1:11434" />
                    <p class="text-[11px] text-muted-foreground">
                        允许远程 Ollama 时填对方地址，如 http://192.168.1.10:11434
                    </p>
                </div>
                <div class="flex flex-col gap-1.5">
                    <label class="text-xs font-medium">可执行文件路径</label>
                    <UiInput
                        v-model="exePath"
                        mono
                        placeholder="D:\WorkSpace\Ollama\bin\ollama.exe"
                    />
                    <p class="text-[11px] text-muted-foreground">
                        留空则自动探测常见安装位置；用于「服务未运行时一键拉起」
                    </p>
                </div>
                <div class="flex flex-col gap-1.5">
                    <label class="text-xs font-medium">模型目录</label>
                    <UiInput v-model="modelsDir" mono placeholder="D:\WorkSpace\Ollama\models" />
                    <p class="text-[11px] text-muted-foreground">
                        作为 OLLAMA_MODELS 传给子进程，留空沿用系统环境变量
                    </p>
                </div>
                <div class="flex items-end gap-2">
                    <UiButton size="sm" :disabled="savingConfig" @click="saveServiceConfig">
                        <Save class="size-3.5" />
                        {{ savingConfig ? '保存中…' : '保存配置' }}
                    </UiButton>
                </div>
            </div>
        </UiCard>

        <!-- ============ 拉取模型 ============ -->
        <UiCard>
            <div class="flex items-center gap-2 border-b border-border/60 px-5 py-3.5">
                <Download class="size-4 text-muted-foreground" />
                <h3 class="text-sm font-semibold tracking-tight">拉取模型</h3>
                <span class="text-[11px] text-muted-foreground">从官方仓库下载到本地</span>
            </div>
            <div class="px-5 py-4">
                <div class="flex flex-wrap items-center gap-2">
                    <UiInput
                        v-model="pullName"
                        mono
                        placeholder="qwen2.5vl:3b"
                        class="max-w-xs flex-1"
                        :disabled="pullJob?.running"
                        @keyup.enter="startPull"
                    />
                    <UiButton size="sm" :disabled="pulling || pullJob?.running || !online" @click="startPull">
                        <Loader2 v-if="pullJob?.running" class="size-3.5 animate-spin" />
                        <Download v-else class="size-3.5" />
                        {{ pullJob?.running ? '下载中…' : '开始拉取' }}
                    </UiButton>
                    <span class="text-[11px] text-muted-foreground">
                        模型名由你填写，例如 qwen2.5vl:3b / llama3.2:3b / qwen2.5:1.5b
                    </span>
                </div>

                <!-- 进度 -->
                <div v-if="pullJob && (pullJob.running || pullJob.finishedAt)" class="mt-3">
                    <div class="flex items-center justify-between gap-3 text-[11px]">
                        <div class="flex min-w-0 items-center gap-1.5">
                            <Loader2 v-if="pullJob.running" class="size-3.5 shrink-0 animate-spin text-primary" />
                            <CheckCircle2 v-else-if="!pullJob.error" class="size-3.5 shrink-0 text-success" />
                            <AlertTriangle v-else class="size-3.5 shrink-0 text-destructive" />
                            <span class="shrink-0 font-medium">{{ pullJob.model }}</span>
                            <span class="min-w-0 truncate text-muted-foreground">{{ pullJob.status }}</span>
                        </div>
                        <span class="shrink-0 font-mono tabular-nums">
                            <template v-if="pullJob.total > 0">
                                {{ formatBytes(pullJob.completed) }} / {{ formatBytes(pullJob.total) }}
                                · {{ pullJob.percent }}%
                            </template>
                        </span>
                    </div>
                    <div class="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                        <div
                            class="h-full rounded-full transition-[width] duration-300"
                            :class="pullJob.error ? 'bg-destructive' : 'bg-primary'"
                            :style="{ width: `${pullJob.percent}%` }"
                        />
                    </div>
                    <p v-if="pullJob.error" class="mt-1.5 text-[11px] text-destructive">
                        {{ pullJob.error }}
                    </p>
                </div>
            </div>
        </UiCard>

        <!-- ============ 模型列表 ============ -->
        <UiCard>
            <div class="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-5 py-3.5">
                <div class="flex items-center gap-2">
                    <Cpu class="size-4 text-muted-foreground" />
                    <h3 class="text-sm font-semibold tracking-tight">本地模型</h3>
                    <UiBadge tone="outline" class="text-micro">{{ models.length }} 个</UiBadge>
                </div>
                <span class="text-[11px] text-muted-foreground">加载 = 预热到内存；卸载 = 立即释放显存</span>
            </div>

            <div v-if="loading && models.length === 0" class="px-5 py-12 text-center text-xs text-muted-foreground">
                加载中…
            </div>

            <div v-else-if="!online" class="flex flex-col items-center gap-2 px-5 py-12">
                <AlertTriangle class="size-7 text-muted-foreground/30" />
                <p class="text-sm text-muted-foreground">Ollama 未运行，无法列出模型</p>
                <p class="text-xs text-muted-foreground/70">启动服务后回到这里刷新</p>
            </div>

            <div v-else-if="models.length === 0" class="flex flex-col items-center gap-2 px-5 py-12">
                <Cpu class="size-7 text-muted-foreground/30" />
                <p class="text-sm text-muted-foreground">还没有下载任何模型</p>
                <p class="text-xs text-muted-foreground/70">在上方「拉取模型」里填写名称开始下载</p>
            </div>

            <div v-else class="divide-y divide-border/40">
                <div
                    v-for="m in models"
                    :key="m.name"
                    class="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3 transition-colors hover:bg-accent/20"
                >
                    <!-- 名称与标签 -->
                    <div class="min-w-0 flex-1">
                        <div class="flex flex-wrap items-center gap-1.5">
                            <span class="truncate text-[13px] font-medium">{{ m.name }}</span>
                            <UiBadge v-if="m.loaded" tone="success" dot class="text-micro">已加载</UiBadge>
                            <UiBadge
                                v-for="c in m.capabilities"
                                :key="c"
                                :tone="c === 'vision' ? 'info' : 'outline'"
                                class="text-micro"
                            >
                                {{ capabilityLabel[c] ?? c }}
                            </UiBadge>
                        </div>
                        <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                            <span>{{ formatBytes(m.sizeBytes) }}</span>
                            <span v-if="m.parameterSize">{{ m.parameterSize }}</span>
                            <span v-if="m.quantization">{{ m.quantization }}</span>
                            <span v-if="m.family">{{ m.family }}</span>
                            <span v-if="m.loaded && m.running?.sizeVramBytes" class="text-success">
                                显存 {{ formatBytes(m.running.sizeVramBytes) }}
                            </span>
                            <span
                                v-if="m.loaded && m.running?.expiresAt"
                                class="text-muted-foreground/70"
                            >
                                驻留至 {{ new Date(m.running.expiresAt).toLocaleTimeString('zh-CN') }}
                            </span>
                        </div>
                    </div>

                    <!-- 打标标记 -->
                    <div class="flex shrink-0 flex-wrap items-center gap-1">
                        <UiBadge
                            v-if="m.name === status?.visionModel"
                            tone="info"
                            class="text-micro"
                        >
                            <Tag class="size-3" />
                            打标模型
                        </UiBadge>
                        <UiBadge
                            v-if="m.name === status?.textModel"
                            tone="outline"
                            class="text-micro"
                        >
                            收敛模型
                        </UiBadge>
                    </div>

                    <!-- 操作 -->
                    <div class="flex shrink-0 flex-wrap items-center gap-1.5">
                        <UiButton variant="outline" size="sm" @click="showDetail(m)">
                            详情
                        </UiButton>
                        <UiButton
                            v-if="!m.loaded"
                            variant="secondary"
                            size="sm"
                            :disabled="!!busy[m.name]"
                            @click="loadModel(m)"
                        >
                            <Loader2 v-if="busy[m.name] === 'load'" class="size-3.5 animate-spin" />
                            <Zap v-else class="size-3.5" />
                            加载
                        </UiButton>
                        <UiButton
                            v-else
                            variant="outline"
                            size="sm"
                            :disabled="!!busy[m.name]"
                            @click="unloadModel(m)"
                        >
                            <Loader2 v-if="busy[m.name] === 'unload'" class="size-3.5 animate-spin" />
                            <Square v-else class="size-3.5" />
                            卸载
                        </UiButton>
                        <UiButton
                            v-if="m.capabilities.includes('vision') && m.name !== status?.visionModel"
                            variant="secondary"
                            size="sm"
                            @click="useAsVision(m)"
                        >
                            <ArrowUpCircle class="size-3.5" />
                            用于打标
                        </UiButton>
                        <UiButton
                            variant="ghost"
                            size="sm"
                            class="text-destructive hover:bg-destructive/10"
                            :disabled="!!busy[m.name]"
                            @click="removeModel(m)"
                        >
                            <Loader2 v-if="busy[m.name] === 'delete'" class="size-3.5 animate-spin" />
                            <Trash2 v-else class="size-3.5" />
                        </UiButton>
                    </div>
                </div>
            </div>
        </UiCard>

        <!-- ============ 打标模型 ============ -->
        <UiCard>
            <div class="flex items-center gap-2 border-b border-border/60 px-5 py-3.5">
                <Tag class="size-4 text-muted-foreground" />
                <h3 class="text-sm font-semibold tracking-tight">表情打标模型</h3>
                <span class="text-[11px] text-muted-foreground">
                    两阶段：视觉出描述 → 文本收敛标签
                </span>
            </div>
            <div class="grid gap-4 px-5 py-4 lg:grid-cols-2">
                <div class="flex flex-col gap-1.5">
                    <label class="text-xs font-medium">视觉模型</label>
                    <UiSelect
                        v-model="visionModel"
                        :options="modelOptions"
                        placeholder="— 选择模型 —"
                        :disabled="models.length === 0"
                    />
                    <p class="text-[11px] text-muted-foreground">
                        需要具备视觉能力，如 qwen2.5vl:3b / llava:7b
                    </p>
                </div>
                <div class="flex flex-col gap-1.5">
                    <label class="text-xs font-medium">文本模型（可选）</label>
                    <UiSelect
                        v-model="textModel"
                        :options="[{ value: '', label: '复用视觉模型' }, ...modelOptions]"
                        :disabled="models.length === 0"
                    />
                    <p class="text-[11px] text-muted-foreground">
                        用于把描述收敛到受控词表，小模型即可如 qwen2.5:1.5b
                    </p>
                </div>
                <div class="flex items-center gap-2">
                    <UiButton size="sm" :disabled="savingSelect || !visionModel" @click="saveTaggingModel">
                        <Save class="size-3.5" />
                        {{ savingSelect ? '保存中…' : '设为打标模型' }}
                    </UiButton>
                    <span class="text-[11px] text-muted-foreground">
                        当前：{{ status?.visionModel || '（未设置）' }}
                    </span>
                </div>
            </div>
        </UiCard>

        <!-- ============ 连通性测试 ============ -->
        <div class="grid gap-5 lg:grid-cols-2">
            <!-- 文本 -->
            <UiCard>
                <div class="flex items-center gap-2 border-b border-border/60 px-5 py-3.5">
                    <MessageSquare class="size-4 text-muted-foreground" />
                    <h3 class="text-sm font-semibold tracking-tight">文本对话测试</h3>
                </div>
                <div class="flex flex-col gap-3 px-5 py-4">
                    <div class="flex flex-col gap-1.5">
                        <label class="text-xs font-medium">模型</label>
                        <UiSelect
                            v-model="testModel"
                            :options="modelOptions"
                            placeholder="— 选择模型 —"
                            :disabled="models.length === 0"
                        />
                    </div>
                    <div class="flex flex-col gap-1.5">
                        <label class="text-xs font-medium">提示词</label>
                        <UiInput v-model="testPrompt" @keyup.enter="runTest" />
                    </div>
                    <UiButton size="sm" :disabled="testRunning || !online" @click="runTest">
                        <Loader2 v-if="testRunning" class="size-3.5 animate-spin" />
                        <Zap v-else class="size-3.5" />
                        {{ testRunning ? '生成中…' : '发送' }}
                    </UiButton>
                    <div v-if="testResult" class="rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5">
                        <div class="mb-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                            <CheckCircle2 class="size-3 text-success" />
                            耗时 {{ (testElapsed / 1000).toFixed(1) }}s
                        </div>
                        <p class="whitespace-pre-wrap break-words text-xs leading-relaxed">
                            {{ testResult }}
                        </p>
                    </div>
                </div>
            </UiCard>

            <!-- 视觉 -->
            <UiCard>
                <div class="flex items-center gap-2 border-b border-border/60 px-5 py-3.5">
                    <ImageIcon class="size-4 text-muted-foreground" />
                    <h3 class="text-sm font-semibold tracking-tight">图像识别测试</h3>
                </div>
                <div class="flex flex-col gap-3 px-5 py-4">
                    <div class="flex flex-col gap-1.5">
                        <label class="text-xs font-medium">模型</label>
                        <UiSelect
                            v-model="visionTestModel"
                            :options="visionModelOptions"
                            placeholder="— 选择视觉模型 —"
                            :disabled="visionModelOptions.length === 0"
                        />
                    </div>
                    <div class="flex flex-col gap-1.5">
                        <label class="text-xs font-medium">图片路径</label>
                        <UiInput v-model="visionPath" mono placeholder="D:\pics\cat.jpg" />
                    </div>
                    <div class="flex flex-col gap-1.5">
                        <label class="text-xs font-medium">提示词</label>
                        <UiInput v-model="visionPrompt" />
                    </div>
                    <UiButton size="sm" :disabled="visionRunning || !online" @click="runVisionTest">
                        <Loader2 v-if="visionRunning" class="size-3.5 animate-spin" />
                        <ImageIcon v-else class="size-3.5" />
                        {{ visionRunning ? '识别中…' : '开始识别' }}
                    </UiButton>
                    <div v-if="visionResult" class="rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5">
                        <div class="mb-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                            <CheckCircle2 class="size-3 text-success" />
                            耗时 {{ (visionElapsed / 1000).toFixed(1) }}s
                        </div>
                        <p class="whitespace-pre-wrap break-words text-xs leading-relaxed">
                            {{ visionResult }}
                        </p>
                    </div>
                </div>
            </UiCard>
        </div>

        <!-- ============ 说明 ============ -->
        <UiCard class="border-info/30 bg-info/5">
            <div class="flex items-start gap-3 px-5 py-4">
                <Info class="mt-0.5 size-4 shrink-0 text-info" />
                <div class="min-w-0 text-xs leading-relaxed text-muted-foreground">
                    <p class="font-medium text-foreground">关于 Ollama 管理</p>
                    <ul class="mt-1.5 flex flex-col gap-1">
                        <li>• 本页只管理<strong class="text-foreground">已安装</strong>的 Ollama，不负责下载或安装程序</li>
                        <li>• 「启动服务」在服务未运行时拉起 <code class="font-mono">ollama serve</code> 子进程</li>
                        <li>• 只有 Bridge 自己启动的进程才能被「停止服务」结束，外部进程请用任务管理器</li>
                        <li>• 模型默认驻留 30 分钟；打标任务结束后会自动卸载以释放显存</li>
                        <li>• 显存不足时（6GB 卡），建议同时只加载一个模型</li>
                    </ul>
                </div>
            </div>
        </UiCard>

        <!-- ============ 详情弹窗 ============ -->
        <div
            v-if="detail"
            class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
            @click.self="detail = null"
        >
            <div class="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-xl bg-card shadow-2xl">
                <div class="flex items-center justify-between border-b border-border/60 px-5 py-3.5">
                    <h3 class="text-sm font-semibold tracking-tight">模型详情</h3>
                    <button
                        class="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        @click="detail = null"
                    >
                        <X class="size-4" />
                    </button>
                </div>
                <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                    <div v-if="detailLoading" class="py-8 text-center text-xs text-muted-foreground">
                        读取中…
                    </div>
                    <template v-else>
                        <p class="font-mono text-sm font-medium">{{ detail.name }}</p>
                        <dl class="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[11px]">
                            <div>
                                <dt class="text-muted-foreground">架构</dt>
                                <dd>{{ detail.family || '—' }}</dd>
                            </div>
                            <div>
                                <dt class="text-muted-foreground">参数量</dt>
                                <dd>{{ detail.parameterSize || '—' }}</dd>
                            </div>
                            <div>
                                <dt class="text-muted-foreground">量化</dt>
                                <dd>{{ detail.quantization || '—' }}</dd>
                            </div>
                            <div>
                                <dt class="text-muted-foreground">上下文</dt>
                                <dd>{{ detail.contextLength ? detail.contextLength.toLocaleString() : '—' }}</dd>
                            </div>
                        </dl>
                        <div v-if="detail.capabilities.length" class="mt-3 flex flex-wrap gap-1.5">
                            <UiBadge
                                v-for="c in detail.capabilities"
                                :key="c"
                                :tone="c === 'vision' ? 'info' : 'outline'"
                                class="text-micro"
                            >
                                {{ capabilityLabel[c] ?? c }}
                            </UiBadge>
                        </div>
                        <div v-if="detail.system" class="mt-4">
                            <p class="mb-1 text-[11px] font-medium text-muted-foreground">系统提示模板</p>
                            <pre class="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-2.5 font-mono text-[10px] leading-relaxed">{{ detail.system }}</pre>
                        </div>
                    </template>
                </div>
                <div class="flex justify-end border-t border-border/60 px-5 py-3">
                    <UiButton variant="outline" size="sm" @click="detail = null">关闭</UiButton>
                </div>
            </div>
        </div>
    </div>
</template>
