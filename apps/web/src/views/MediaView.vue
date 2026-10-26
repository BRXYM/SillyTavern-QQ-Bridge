<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
    Image as ImageIcon, RefreshCw, Wand2, X, Save, Plus, Sparkles, User,
    CheckCircle2, AlertTriangle, Cpu, StopCircle, Info, Search, Tag,
} from 'lucide-vue-next';
import UiCard from '@/components/ui/UiCard.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiBadge from '@/components/ui/UiBadge.vue';
import UiInput from '@/components/ui/UiInput.vue';
import {
    facesApi,
    type FaceItem,
    type FaceTagInfo,
    type FaceStats,
    type FaceProgress,
    type FaceDiagnostics,
} from '@/api/faces';
import { useToastStore } from '@/stores/toast';

const toast = useToastStore();

// ---------------- 状态 ----------------
const loading = ref(false);
const syncing = ref(false);
const starting = ref(false);
const items = ref<FaceItem[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = 60;
const stats = ref<FaceStats>({ total: 0, labeled: 0, unlabeled: 0, withUserTags: 0, cached: 0, failed: 0 });
const tagList = ref<FaceTagInfo[]>([]);
const progress = ref<FaceProgress | null>(null);
const diag = ref<FaceDiagnostics | null>(null);

const activeTag = ref('');
const keyword = ref('');

// ---------------- 编辑弹窗 ----------------
const editing = ref<FaceItem | null>(null);
const editUserTags = ref<string[]>([]);
const newTag = ref('');
const saving = ref(false);

let pollTimer: number | null = null;

// ---------------- 数据加载 ----------------
async function loadList() {
    loading.value = true;
    try {
        const r = await facesApi.list({
            tag: activeTag.value,
            keyword: keyword.value.trim(),
            page: page.value,
            pageSize,
        });
        items.value = r.items;
        total.value = r.total;
        stats.value = r.stats;
    } catch (e) {
        toast.error('加载失败', e instanceof Error ? e.message : String(e));
    } finally {
        loading.value = false;
    }
}

async function loadTags() {
    try {
        const r = await facesApi.tags();
        tagList.value = r.tags;
        stats.value = r.stats;
    } catch {
        /* 标签接口失败不阻断主流程 */
    }
}

async function loadDiag() {
    try {
        diag.value = await facesApi.diagnostics();
    } catch {
        diag.value = null;
    }
}

async function refreshAll() {
    await Promise.all([loadList(), loadTags(), loadDiag()]);
}

// ---------------- 同步 ----------------
async function syncFromQQ() {
    syncing.value = true;
    try {
        const r = await facesApi.sync();
        toast.success(
            '同步完成',
            `新增 ${r.added}，更新 ${r.updated}，共 ${r.total} 个（缓存 ${r.downloaded} 张）`,
        );
        await refreshAll();
    } catch (e) {
        toast.error('同步失败', e instanceof Error ? e.message : String(e));
    } finally {
        syncing.value = false;
    }
}

// ---------------- 打标 ----------------
async function startLabel(all: boolean) {
    starting.value = true;
    try {
        const r = await facesApi.startLabel({ all });
        toast.info(
            all ? '开始重新识别全部' : '开始识别未打标的表情',
            `共 ${r.total} 个，后台执行中，可继续使用其他页面`,
        );
        startPolling();
    } catch (e) {
        toast.error('无法启动', e instanceof Error ? e.message : String(e));
    } finally {
        starting.value = false;
    }
}

async function stopLabel() {
    try {
        const r = await facesApi.stopLabel();
        toast.info('已停止', `取消排队 ${r.dropped} 个`);
        await pollOnce();
    } catch (e) {
        toast.error('停止失败', e instanceof Error ? e.message : String(e));
    }
}

async function pollOnce() {
    try {
        const p = await facesApi.progress();
        progress.value = p;
        if (!p.running && pollTimer !== null) {
            // 任务结束：停轮询并刷新列表
            window.clearInterval(pollTimer);
            pollTimer = null;
            await refreshAll();
            if (p.done > 0) {
                toast.success('识别完成', `成功 ${p.done} 个${p.failed ? `，失败 ${p.failed} 个` : ''}`);
            }
        }
    } catch {
        /* 忽略轮询失败 */
    }
}

function startPolling() {
    if (pollTimer !== null) return;
    void pollOnce();
    pollTimer = window.setInterval(() => void pollOnce(), 1500);
}

// ---------------- 标签编辑 ----------------
function openEdit(item: FaceItem) {
    editing.value = item;
    // 只编辑用户标签，AI 标签不可改
    editUserTags.value = [...item.userTags];
    newTag.value = '';
}

function closeEdit() {
    editing.value = null;
    editUserTags.value = [];
    newTag.value = '';
}

function addTag() {
    const t = newTag.value.trim().replace(/\s+/g, '');
    if (!t) return;
    if (editUserTags.value.some((x) => x.toLowerCase() === t.toLowerCase())) {
        toast.warning('标签已存在', t);
        newTag.value = '';
        return;
    }
    editUserTags.value.push(t.slice(0, 24));
    newTag.value = '';
}

function removeTag(t: string) {
    editUserTags.value = editUserTags.value.filter((x) => x !== t);
}

async function saveTags() {
    if (!editing.value) return;
    saving.value = true;
    try {
        await facesApi.setUserTags(editing.value.md5, editUserTags.value);
        toast.success('标签已保存', '用户标签与 AI 标签分别存储，互不影响');
        closeEdit();
        await refreshAll();
    } catch (e) {
        toast.error('保存失败', e instanceof Error ? e.message : String(e));
    } finally {
        saving.value = false;
    }
}

// ---------------- 筛选 ----------------
function pickTag(t: string) {
    activeTag.value = activeTag.value === t ? '' : t;
    page.value = 1;
    void loadList();
}

function onSearch() {
    page.value = 1;
    void loadList();
}

function resetFilter() {
    activeTag.value = '';
    keyword.value = '';
    page.value = 1;
    void loadList();
}

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));

function goPage(p: number) {
    if (p < 1 || p > totalPages.value) return;
    page.value = p;
    void loadList();
}

// ---------------- 生命周期 ----------------
onMounted(async () => {
    await refreshAll();
    const p = await facesApi.progress().catch(() => null);
    if (p?.running) startPolling();
});

onUnmounted(() => {
    if (pollTimer !== null) window.clearInterval(pollTimer);
});
</script>

<template>
    <div class="flex flex-col gap-5">
        <!-- ============ 概览与操作 ============ -->
        <UiCard>
            <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-5 py-4">
                <div class="flex items-center gap-3">
                    <div class="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                        <ImageIcon class="size-5" />
                    </div>
                    <div>
                        <h2 class="text-sm font-semibold tracking-tight">表情库</h2>
                        <p class="text-xs text-muted-foreground">
                            QQ 收藏表情 + 本地 AI 标签，可按标签检索与手动修正
                        </p>
                    </div>
                </div>
                <div class="flex flex-wrap items-center gap-2">
                    <UiBadge tone="outline" class="text-micro">{{ stats.total }} 个</UiBadge>
                    <UiBadge v-if="stats.labeled" tone="success" class="text-micro">
                        已识别 {{ stats.labeled }}
                    </UiBadge>
                    <UiBadge v-if="stats.unlabeled" tone="warning" class="text-micro">
                        待识别 {{ stats.unlabeled }}
                    </UiBadge>
                    <UiBadge v-if="stats.withUserTags" tone="info" class="text-micro">
                        自定义 {{ stats.withUserTags }}
                    </UiBadge>
                </div>
            </div>

            <!-- 模型状态 -->
            <div v-if="diag" class="border-b border-border/40 px-5 py-3">
                <div class="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px]">
                    <span class="flex items-center gap-1.5">
                        <Cpu class="size-3.5 text-muted-foreground" />
                        <span class="text-muted-foreground">Ollama</span>
                        <span :class="diag.ollama.reachable ? 'text-success' : 'text-destructive'">
                            {{ diag.ollama.reachable ? '已连接' : '未连接' }}
                        </span>
                    </span>
                    <span class="flex items-center gap-1.5">
                        <span class="text-muted-foreground">视觉模型</span>
                        <span class="font-mono">{{ diag.ollama.visionModel }}</span>
                        <span :class="diag.ollama.modelReady ? 'text-success' : 'text-warning'">
                            {{ diag.ollama.modelReady ? '就绪' : '未安装' }}
                        </span>
                    </span>
                    <span v-if="!diag.ollama.reachable" class="text-warning">
                        {{ diag.ollama.error }}
                    </span>
                </div>
            </div>

            <!-- 打标进度 -->
            <div v-if="progress?.running" class="border-b border-border/40 bg-accent/15 px-5 py-3">
                <div class="flex items-center justify-between gap-3">
                    <div class="flex min-w-0 flex-1 items-center gap-2">
                        <Sparkles class="size-3.5 shrink-0 animate-pulse text-primary" />
                        <span class="shrink-0 text-xs font-medium">正在识别</span>
                        <span class="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                            {{ progress.done }} / {{ progress.total }}
                            <span v-if="progress.current" class="ml-1 font-mono">
                                ({{ progress.current }})
                            </span>
                            <span v-if="progress.queued" class="ml-1">排队 {{ progress.queued }}</span>
                        </span>
                    </div>
                    <span class="shrink-0 font-mono text-xs tabular-nums">{{ progress.percent }}%</span>
                    <UiButton variant="outline" size="sm" @click="stopLabel">
                        <StopCircle class="size-3.5" />
                        停止
                    </UiButton>
                </div>
                <div class="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                        class="h-full rounded-full bg-primary transition-[width] duration-300"
                        :style="{ width: `${progress.percent}%` }"
                    />
                </div>
                <p v-if="progress.lastError" class="mt-1.5 text-[11px] text-destructive">
                    {{ progress.lastError }}
                </p>
            </div>

            <!-- 操作按钮 -->
            <div class="flex flex-wrap items-center gap-2 px-5 py-3">
                <UiButton size="sm" :disabled="syncing" @click="syncFromQQ">
                    <RefreshCw class="size-4" :class="syncing ? 'animate-spin' : ''" />
                    {{ syncing ? '同步中…' : '刷新 QQ 表情' }}
                </UiButton>
                <UiButton
                    variant="secondary"
                    size="sm"
                    :disabled="starting || progress?.running || stats.unlabeled === 0"
                    @click="startLabel(false)"
                >
                    <Wand2 class="size-4" />
                    识别未打标（{{ stats.unlabeled }}）
                </UiButton>
                <UiButton
                    variant="outline"
                    size="sm"
                    :disabled="starting || progress?.running || stats.total === 0"
                    @click="startLabel(true)"
                >
                    <Sparkles class="size-4" />
                    重新识别全部
                </UiButton>
                <div class="flex-1" />
                <span v-if="progress?.sync.lastAt" class="text-[11px] text-muted-foreground">
                    上次同步 {{ new Date(progress.sync.lastAt).toLocaleString('zh-CN') }}
                </span>
            </div>
        </UiCard>

        <!-- ============ 筛选 ============ -->
        <UiCard v-if="stats.total > 0">
            <div class="flex flex-wrap items-center gap-2 border-b border-border/60 px-5 py-3">
                <div class="flex items-center gap-1.5">
                    <Search class="size-3.5 text-muted-foreground" />
                    <UiInput
                        v-model="keyword"
                        placeholder="搜索标签或描述…"
                        class="w-56"
                        @keyup.enter="onSearch"
                    />
                </div>
                <UiButton variant="outline" size="sm" @click="onSearch">搜索</UiButton>
                <UiButton
                    v-if="activeTag || keyword"
                    variant="ghost"
                    size="sm"
                    @click="resetFilter"
                >
                    <X class="size-3.5" />
                    清除
                </UiButton>
                <div class="flex-1" />
                <span class="text-[11px] text-muted-foreground">共 {{ total }} 个结果</span>
            </div>

            <!-- 标签筛选 -->
            <div v-if="tagList.length" class="flex flex-wrap gap-1.5 px-5 py-3">
                <button
                    v-for="t in tagList"
                    :key="t.tag"
                    class="flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors"
                    :class="activeTag === t.tag
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-accent/40 text-foreground hover:bg-accent'"
                    @click="pickTag(t.tag)"
                >
                    <Tag class="size-3" />
                    {{ t.tag }}
                    <span class="opacity-60">{{ t.total }}</span>
                </button>
            </div>
        </UiCard>

        <!-- ============ 表情网格 ============ -->
        <UiCard v-if="stats.total > 0">
            <div v-if="loading" class="px-5 py-12 text-center text-xs text-muted-foreground">
                加载中…
            </div>

            <div v-else-if="items.length === 0" class="flex flex-col items-center gap-2 px-5 py-12">
                <Search class="size-7 text-muted-foreground/30" />
                <p class="text-sm text-muted-foreground">没有匹配的表情</p>
                <p class="text-xs text-muted-foreground/70">试试清除筛选条件</p>
            </div>

            <div v-else class="grid grid-cols-2 gap-3 px-5 py-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                <div
                    v-for="item in items"
                    :key="item.md5"
                    class="group flex flex-col overflow-hidden rounded-lg border border-border/60 bg-card transition-shadow hover:shadow-md"
                >
                    <!-- 图片 -->
                    <div class="relative flex aspect-square items-center justify-center bg-muted/30 p-2">
                        <img
                            :src="item.imageUrl"
                            :alt="item.caption || item.md5"
                            class="max-h-full max-w-full object-contain"
                            loading="lazy"
                        />
                        <!-- 状态角标 -->
                        <div class="absolute right-1.5 top-1.5 flex gap-1">
                            <span
                                v-if="item.labeledAt"
                                class="rounded bg-success/90 px-1.5 py-0.5 text-[9px] font-medium text-white"
                            >
                                AI
                            </span>
                            <span
                                v-if="item.userTags.length"
                                class="rounded bg-info/90 px-1.5 py-0.5 text-[9px] font-medium text-white"
                            >
                                自定义
                            </span>
                        </div>
                        <div v-if="item.labelError" class="absolute bottom-1.5 left-1.5">
                            <AlertTriangle class="size-3.5 text-destructive" />
                        </div>
                    </div>

                    <!-- 标签 -->
                    <div class="flex flex-1 flex-col gap-1.5 p-2">
                        <div class="flex flex-wrap gap-1">
                            <span
                                v-for="t in item.aiTags"
                                :key="`ai-${t}`"
                                class="rounded bg-accent/60 px-1.5 py-0.5 text-[10px] leading-none"
                            >
                                {{ t }}
                            </span>
                            <span
                                v-for="t in item.userTags"
                                :key="`u-${t}`"
                                class="rounded bg-info/15 px-1.5 py-0.5 text-[10px] leading-none text-info"
                            >
                                {{ t }}
                            </span>
                            <span
                                v-if="item.tags.length === 0"
                                class="text-[10px] text-muted-foreground/60"
                            >
                                未打标
                            </span>
                        </div>
                        <p
                            v-if="item.caption"
                            class="line-clamp-2 text-[10px] leading-snug text-muted-foreground/80"
                            :title="item.caption"
                        >
                            {{ item.caption }}
                        </p>
                        <div class="mt-auto flex justify-end">
                            <button
                                class="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                                @click="openEdit(item)"
                            >
                                <Tag class="size-3" />
                                编辑标签
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- 分页 -->
            <div v-if="totalPages > 1" class="flex items-center justify-center gap-2 border-t border-border/60 px-5 py-3">
                <UiButton variant="outline" size="sm" :disabled="page <= 1" @click="goPage(page - 1)">
                    上一页
                </UiButton>
                <span class="text-[11px] text-muted-foreground">{{ page }} / {{ totalPages }}</span>
                <UiButton variant="outline" size="sm" :disabled="page >= totalPages" @click="goPage(page + 1)">
                    下一页
                </UiButton>
            </div>
        </UiCard>

        <!-- 空状态 -->
        <UiCard v-if="stats.total === 0 && !loading">
            <div class="flex flex-col items-center gap-3 px-5 py-16">
                <ImageIcon class="size-10 text-muted-foreground/30" />
                <p class="text-sm text-muted-foreground">表情库还是空的</p>
                <p class="max-w-md text-center text-xs leading-relaxed text-muted-foreground/70">
                    点击上方「刷新 QQ 表情」从当前 QQ 账号拉取收藏表情。
                    需要 SnowLuma 已登录且 Bridge 已连接。
                </p>
            </div>
        </UiCard>

        <!-- ============ 编辑弹窗 ============ -->
        <div
            v-if="editing"
            class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
            @click.self="closeEdit"
        >
            <div class="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-xl bg-card shadow-2xl">
                <!-- 头部 -->
                <div class="flex items-center justify-between border-b border-border/60 px-5 py-3.5">
                    <h3 class="text-sm font-semibold tracking-tight">编辑标签</h3>
                    <button
                        class="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        @click="closeEdit"
                    >
                        <X class="size-4" />
                    </button>
                </div>

                <div class="min-h-0 flex-1 overflow-y-auto">
                    <!-- 图片预览 -->
                    <div class="flex justify-center bg-muted/20 px-5 py-4">
                        <img
                            :src="editing.imageUrl"
                            :alt="editing.caption"
                            class="max-h-48 rounded-lg object-contain"
                        />
                    </div>

                    <!-- AI 标签（只读） -->
                    <div class="border-t border-border/40 px-5 py-3.5">
                        <div class="flex items-center gap-1.5">
                            <Sparkles class="size-3.5 text-primary" />
                            <p class="text-xs font-medium">AI 标签</p>
                            <span class="text-[10px] text-muted-foreground">（重新识别时会替换）</span>
                        </div>
                        <div class="mt-2 flex flex-wrap gap-1.5">
                            <span
                                v-for="t in editing.aiTags"
                                :key="t"
                                class="rounded bg-accent/60 px-2 py-1 text-[11px]"
                            >
                                {{ t }}
                            </span>
                            <span v-if="editing.aiTags.length === 0" class="text-[11px] text-muted-foreground/70">
                                尚未识别
                            </span>
                        </div>
                        <p v-if="editing.caption" class="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                            描述：{{ editing.caption }}
                        </p>
                        <p v-if="editing.labelError" class="mt-1 text-[11px] text-destructive">
                            上次识别失败：{{ editing.labelError }}
                        </p>
                    </div>

                    <!-- 用户标签（可编辑） -->
                    <div class="border-t border-border/40 px-5 py-3.5">
                        <div class="flex items-center gap-1.5">
                            <User class="size-3.5 text-info" />
                            <p class="text-xs font-medium">自定义标签</p>
                            <span class="text-[10px] text-muted-foreground">（不会被重新识别覆盖）</span>
                        </div>
                        <div class="mt-2 flex flex-wrap gap-1.5">
                            <span
                                v-for="t in editUserTags"
                                :key="t"
                                class="flex items-center gap-1 rounded bg-info/15 px-2 py-1 text-[11px] text-info"
                            >
                                {{ t }}
                                <button
                                    class="transition-opacity hover:opacity-70"
                                    @click="removeTag(t)"
                                >
                                    <X class="size-3" />
                                </button>
                            </span>
                            <span v-if="editUserTags.length === 0" class="text-[11px] text-muted-foreground/70">
                                暂无自定义标签
                            </span>
                        </div>
                        <div class="mt-2.5 flex items-center gap-2">
                            <UiInput
                                v-model="newTag"
                                placeholder="输入新标签后回车"
                                class="flex-1"
                                @keyup.enter="addTag"
                            />
                            <UiButton variant="outline" size="sm" :disabled="!newTag.trim()" @click="addTag">
                                <Plus class="size-3.5" />
                                添加
                            </UiButton>
                        </div>
                    </div>

                    <!-- 合并预览 -->
                    <div class="border-t border-border/40 px-5 py-3">
                        <p class="text-[11px] text-muted-foreground">
                            最终生效标签：
                            <span class="text-foreground">
                                {{ [...editing.aiTags, ...editUserTags].join('、') || '（无）' }}
                            </span>
                        </p>
                    </div>
                </div>

                <!-- 底部 -->
                <div class="flex items-center justify-end gap-2 border-t border-border/60 px-5 py-3">
                    <UiButton variant="outline" size="sm" @click="closeEdit">取消</UiButton>
                    <UiButton size="sm" :disabled="saving" @click="saveTags">
                        <Save class="size-3.5" />
                        {{ saving ? '保存中…' : '保存标签' }}
                    </UiButton>
                </div>
            </div>
        </div>

        <!-- 说明 -->
        <UiCard class="border-info/30 bg-info/5">
            <div class="flex items-start gap-3 px-5 py-4">
                <Info class="mt-0.5 size-4 shrink-0 text-info" />
                <div class="min-w-0 text-xs leading-relaxed text-muted-foreground">
                    <p class="font-medium text-foreground">关于标签</p>
                    <ul class="mt-1.5 flex flex-col gap-1">
                        <li>
                            • <strong class="text-primary">AI 标签</strong>：本地视觉模型识别生成，
                            重新识别时整体替换
                        </li>
                        <li>
                            • <strong class="text-info">自定义标签</strong>：手工添加，
                            重新识别不会删除，与 AI 标签作用一致（都可被检索和用于 AI 选图）
                        </li>
                        <li>• 识别在后台串行执行，不阻塞桥接与聊天</li>
                        <li>• 全部识别时会卸载模型，把显存还给酒馆</li>
                    </ul>
                </div>
            </div>
        </UiCard>
    </div>
</template>

<style scoped>
.line-clamp-2 {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
}
</style>
