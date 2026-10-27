<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import {
    Boxes, RefreshCw, Plus, Trash2, Play, Loader2, CheckCircle2,
    AlertTriangle, Server, Star, Info, Power, RotateCw, Plug, PlugZap,
    Terminal, FileText, ChevronDown, ChevronRight, MessageSquare, Save,
    ShieldCheck, Activity,
} from 'lucide-vue-next';
import UiCard from '@/components/ui/UiCard.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiBadge from '@/components/ui/UiBadge.vue';
import UiInput from '@/components/ui/UiInput.vue';
import UiSelect from '@/components/ui/UiSelect.vue';
import UiSwitch from '@/components/ui/UiSwitch.vue';
import { api, type DownstreamStatusDto } from '@/api/client';
import { dshApi, type DshStatus } from '@/api/dsh';
import { useStatusStore } from '@/stores/status';
import { useToastStore } from '@/stores/toast';

const store = useStatusStore();
const toast = useToastStore();

const loading = ref(false);
const saving = ref(false);
const testing = ref('');
const removing = ref('');
const working = ref('');
const testResults = ref<Record<string, { ok: boolean; text: string; elapsedMs: number; error?: string }>>({});

/** 展开的实例（按 id） */
const expanded = reactive<Record<string, boolean>>({});

/** 后端注册的所有下游实例 */
const registered = ref<Array<{
    id: string;
    kind: string;
    name: string;
    enabled: boolean;
    settings: Record<string, unknown>;
}>>([]);

const statuses = computed<DownstreamStatusDto[]>(() => store.status?.downstreams ?? []);
const defaultId = computed(() => store.status?.defaultDownstreamId ?? '');
const kinds = ref<Array<{ kind: string; label: string; description: string }>>([]);

/** dsh 环境信息（只有存在 dsh 实例时才拉） */
const dsh = ref<DshStatus | null>(null);

/** 新增表单 */
const showForm = ref(false);
const form = ref({ id: '', kind: 'dsh-plugin', name: '', timeoutMs: 180000 });

function statusOf(id: string): DownstreamStatusDto | undefined {
    return statuses.value.find((d) => d.id === id);
}

function kindLabel(kind: string): string {
    return kinds.value.find((k) => k.kind === kind)?.label ?? kind;
}

function isDshKind(kind: string): boolean {
    return kind.startsWith('dsh');
}

/**
 * 提示词开关项。
 *
 * 全部默认关闭：Bridge 只转发用户原话，不夹带任何说明。
 * 每一项都是独立开关，按需打开。
 */
const PROMPT_OPTIONS = [
    {
        key: 'qqBase' as const,
        label: 'QQ 聊天约束',
        desc: '要求简短、口语化、不要 Markdown。开启后 AI 更像在聊天',
    },
    {
        key: 'character' as const,
        label: '角色人设',
        desc: '把会话绑定的角色（含世界书名）作为人设告诉下游',
    },
    {
        key: 'faces' as const,
        label: '表情词表',
        desc: '关闭时 AI 不会产出 [表情:标签]，表情包功能失效',
    },
    {
        key: 'images' as const,
        label: '图片能力',
        desc: '允许 AI 用 [图片:URL] 发送网络图片',
    },
] as const;

type PromptKey = (typeof PROMPT_OPTIONS)[number]['key'];

interface PromptState {
    qqBase: boolean;
    character: boolean;
    faces: boolean;
    images: boolean;
    extra: string;
}

/** 每个实例的提示词草稿（未保存的新值放这里，避免直接改 registered） */
const promptDrafts = reactive<Record<string, PromptState>>({});

/** 取某实例的提示词状态（优先草稿，否则读配置） */
function promptOf(id: string): PromptState {
    if (!promptDrafts[id]) {
        const item = registered.value.find((d) => d.id === id);
        const raw = (item?.settings?.prompt ?? {}) as Partial<PromptState>;
        promptDrafts[id] = {
            qqBase: raw.qqBase === true,
            character: raw.character === true,
            faces: raw.faces === true,
            images: raw.images === true,
            extra: typeof raw.extra === 'string' ? raw.extra : '',
        };
    }
    return promptDrafts[id]!;
}

function promptEnabledCount(id: string): number {
    const p = promptOf(id);
    return PROMPT_OPTIONS.filter((o) => p[o.key] === true).length;
}

function setPromptFlag(id: string, key: PromptKey, value: boolean): void {
    promptOf(id)[key] = value;
}

function setPromptExtra(id: string, value: string): void {
    promptOf(id).extra = value;
}

// ---------------- 历史引用规则 ----------------

interface HistoryRule {
    pattern: string;
    label?: string;
}

/** 每个实例的历史规则草稿 */
const historyDrafts = reactive<Record<string, HistoryRule[]>>({});

/** 取某实例的历史规则（优先草稿，否则读配置） */
function historyOf(id: string): HistoryRule[] {
    if (!historyDrafts[id]) {
        const item = registered.value.find((d) => d.id === id);
        const raw = item?.settings?.historyExtracts;
        historyDrafts[id] = Array.isArray(raw)
            ? raw.map((r) => ({
                pattern: String((r as HistoryRule).pattern ?? ''),
                label: String((r as HistoryRule).label ?? ''),
            }))
            : [];
    }
    return historyDrafts[id]!;
}

function addHistoryRule(id: string): void {
    historyOf(id).push({ pattern: '', label: '' });
}

function removeHistoryRule(id: string, idx: number): void {
    historyOf(id).splice(idx, 1);
}

function setHistoryRule(id: string, idx: number, patch: Partial<HistoryRule>): void {
    const rule = historyOf(id)[idx];
    if (rule) Object.assign(rule, patch);
}

// ---------------- 准入名单 ----------------

interface AccessState {
    /** 逗号分隔的原始输入，提交时再解析成数字 */
    allow: string;
    deny: string;
}

const accessDrafts = reactive<Record<string, AccessState>>({});

function accessOf(id: string): AccessState {
    if (!accessDrafts[id]) {
        const item = registered.value.find((d) => d.id === id);
        const raw = (item as unknown as { access?: { allow?: number[]; deny?: number[] } } | undefined)?.access;
        accessDrafts[id] = {
            allow: (raw?.allow ?? []).join(','),
            deny: (raw?.deny ?? []).join(','),
        };
    }
    return accessDrafts[id]!;
}

function setAccessList(id: string, field: 'allow' | 'deny', value: string): void {
    accessOf(id)[field] = value;
}

/** 解析逗号分隔的 QQ 号列表 */
function parseIds(s: string): number[] {
    return s
        .split(/[,，\s]+/)
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
}

function accessSummary(id: string): { label: string; tone: 'outline' | 'warning' | 'info' } {
    const a = accessOf(id);
    const allow = parseIds(a.allow);
    const deny = parseIds(a.deny);
    if (deny.length > 0) return { label: `黑名单 ${deny.length}`, tone: 'warning' };
    if (allow.length > 0) return { label: `白名单 ${allow.length}`, tone: 'info' };
    return { label: '不限制', tone: 'outline' };
}

async function saveAccess(item: {
    id: string;
    kind: string;
    name: string;
    enabled: boolean;
    settings: Record<string, unknown>;
}): Promise<void> {
    const a = accessOf(item.id);
    working.value = `access:${item.id}`;
    try {
        await api.saveDownstream({
            id: item.id,
            kind: item.kind,
            name: item.name,
            enabled: item.enabled,
            settings: item.settings,
            access: { allow: parseIds(a.allow), deny: parseIds(a.deny) },
        });
        delete accessDrafts[item.id];
        await load({ silent: true });
        toast.success('准入名单已保存', accessSummary(item.id).label);
    } catch (e) {
        toast.error('保存失败', e instanceof Error ? e.message : String(e));
    } finally {
        working.value = '';
    }
}

// ---------------- 进度转发 ----------------

interface ProgressState {
    enabled: boolean;
    minIntervalMs: number;
    maxMessages: number;
    prefix: string;
}

const progressDrafts = reactive<Record<string, ProgressState>>({});

function progressOf(id: string): ProgressState {
    if (!progressDrafts[id]) {
        const item = registered.value.find((d) => d.id === id);
        const raw = (item?.settings?.progress ?? {}) as Partial<ProgressState>;
        progressDrafts[id] = {
            enabled: raw.enabled === true,
            minIntervalMs: Number(raw.minIntervalMs ?? 4000),
            maxMessages: Number(raw.maxMessages ?? 3),
            prefix: typeof raw.prefix === 'string' ? raw.prefix : '⏳ ',
        };
    }
    return progressDrafts[id]!;
}

function setProgressFlag(id: string, key: 'enabled', value: boolean): void {
    progressOf(id)[key] = value;
}

function setProgressNum(id: string, key: 'minIntervalMs' | 'maxMessages', value: string): void {
    const n = Number(value);
    progressOf(id)[key] = Number.isFinite(n) && n >= 0 ? n : 0;
}

function setProgressText(id: string, key: 'prefix', value: string): void {
    progressOf(id)[key] = value;
}

async function saveProgress(item: {
    id: string;
    kind: string;
    name: string;
    enabled: boolean;
    settings: Record<string, unknown>;
}): Promise<void> {
    const p = progressOf(item.id);
    working.value = `progress:${item.id}`;
    try {
        await api.saveDownstream({
            id: item.id,
            kind: item.kind,
            name: item.name,
            enabled: item.enabled,
            settings: {
                ...item.settings,
                progress: {
                    enabled: p.enabled,
                    minIntervalMs: p.minIntervalMs,
                    maxMessages: p.maxMessages,
                    prefix: p.prefix,
                },
            },
        });
        delete progressDrafts[item.id];
        await load({ silent: true });
        toast.success('进度设置已保存', p.enabled ? '将转发分析摘要' : '已关闭');
    } catch (e) {
        toast.error('保存失败', e instanceof Error ? e.message : String(e));
    } finally {
        working.value = '';
    }
}

/** 保存某实例的提示词设置 */
async function savePrompt(item: {
    id: string;
    kind: string;
    name: string;
    enabled: boolean;
    settings: Record<string, unknown>;
}): Promise<void> {
    const draft = promptOf(item.id);
    const rules = historyOf(item.id).filter((r) => r.pattern.trim());
    working.value = `prompt:${item.id}`;
    try {
        await api.saveDownstream({
            id: item.id,
            kind: item.kind,
            name: item.name,
            enabled: item.enabled,
            settings: {
                ...item.settings,
                // 只存有效规则，空 pattern 直接丢弃
                historyExtracts: rules.map((r) => ({
                    pattern: r.pattern.trim(),
                    ...(r.label?.trim() ? { label: r.label.trim() } : {}),
                })),
                prompt: {
                    qqBase: draft.qqBase,
                    character: draft.character,
                    faces: draft.faces,
                    images: draft.images,
                    extra: draft.extra,
                },
            },
        });
        // 保存成功后让草稿失效，下次从配置重新读
        delete promptDrafts[item.id];
        delete historyDrafts[item.id];
        await load({ silent: true });
        toast.success(
            '提示词已保存',
            promptEnabledCount(item.id) > 0 ? '将按开启项注入' : '全部关闭，只转发原话',
        );
    } catch (e) {
        toast.error('保存失败', e instanceof Error ? e.message : String(e));
    } finally {
        working.value = '';
    }
}

/** 安装来源的中文名 */
function sourceLabel(source?: string): string {
    switch (source) {
        case 'desktop':
            return '桌面版';
        case 'config':
            return '手动指定';
        case 'PATH':
            return 'PATH';
        case 'npm-global':
            return 'npm 全局';
        default:
            return source || '未知';
    }
}

function toggle(id: string): void {
    expanded[id] = !expanded[id];
}

async function load(opts: { silent?: boolean } = {}) {
    loading.value = true;
    try {
        const r = await api.downstreams();
        registered.value = r.registered;
        kinds.value = r.kinds;
        await store.refresh();

        // 有 dsh 实例时才查 dsh 详情，避免无谓的子进程探测
        if (r.registered.some((d) => isDshKind(d.kind))) {
            dsh.value = await dshApi.status().catch(() => null);
        }
    } catch (e) {
        if (!opts.silent) {
            toast.error('读取下游失败', e instanceof Error ? e.message : String(e));
        }
    } finally {
        loading.value = false;
    }
}

async function setDefault(id: string) {
    saving.value = true;
    try {
        await api.setDefaultDownstream(id);
        await store.refresh();
        toast.success('已设为默认下游', id);
    } catch (e) {
        toast.error('设置失败', e instanceof Error ? e.message : String(e));
    } finally {
        saving.value = false;
    }
}

async function toggleEnabled(
    item: { id: string; enabled: boolean; kind: string; name: string; settings: Record<string, unknown> },
    next: boolean,
) {
    saving.value = true;
    try {
        await api.saveDownstream({
            id: item.id,
            kind: item.kind,
            name: item.name,
            enabled: next,
            settings: item.settings,
        });
        await load({ silent: true });
        toast.success(next ? '已启用' : '已停用', item.id);
    } catch (e) {
        toast.error('操作失败', e instanceof Error ? e.message : String(e));
    } finally {
        saving.value = false;
    }
}

async function remove(id: string) {
    if (registered.value.length <= 1) {
        toast.warning('不能删除', '至少要保留一个下游实例');
        return;
    }
    removing.value = id;
    try {
        await api.deleteDownstream(id);
        await load({ silent: true });
        toast.success('已删除', id);
    } catch (e) {
        toast.error('删除失败', e instanceof Error ? e.message : String(e));
    } finally {
        removing.value = '';
    }
}

async function runTest(id: string) {
    testing.value = id;
    try {
        const r = await api.testDownstream(id, { text: '只回复两个字：正常' });
        testResults.value[id] = r;
        if (r.ok) toast.success('调用成功', `${(r.elapsedMs / 1000).toFixed(1)}s`);
        else toast.error('调用失败', r.error ?? '未知错误');
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        testResults.value[id] = { ok: false, text: '', elapsedMs: 0, error: msg };
        toast.error('调用失败', msg);
    } finally {
        testing.value = '';
    }
}

async function create() {
    const id = form.value.id.trim();
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
        toast.error('id 不合法', '只能包含字母、数字、下划线和短横线（1-32 位）');
        return;
    }
    saving.value = true;
    try {
        await api.saveDownstream({
            id,
            kind: form.value.kind,
            name: form.value.name.trim() || id,
            enabled: true,
            settings: isDshKind(form.value.kind)
                ? { timeoutMs: Number(form.value.timeoutMs) || 180000 }
                : {},
        });
        showForm.value = false;
        form.value = { id: '', kind: 'dsh-plugin', name: '', timeoutMs: 180000 };
        await load({ silent: true });
        toast.success('已新增下游', id);
    } catch (e) {
        toast.error('新增失败', e instanceof Error ? e.message : String(e));
    } finally {
        saving.value = false;
    }
}

// ---------------- dsh 专属：常驻服务 + 连接插件 ----------------

const serviceRunning = computed(() => dsh.value?.service?.running === true);
const pluginOnline = computed(() => (dsh.value?.plugin?.clients?.length ?? 0) > 0);
const pluginInjected = computed(() => dsh.value?.plugin?.injection?.inBundles === true);

async function serviceAction(action: 'start' | 'stop' | 'restart') {
    working.value = `service:${action}`;
    try {
        const r = await dshApi.serviceAction(action);
        const label = action === 'start' ? '已启动' : action === 'stop' ? '已停止' : '已重启';
        if (r.ok) toast.success(`dsh 服务${label}`, `${r.host}:${r.port}`);
        else toast.error('操作失败', r.error ?? '未知错误');
        await load({ silent: true });
    } catch (e) {
        toast.error('操作失败', e instanceof Error ? e.message : String(e));
        await load({ silent: true });
    } finally {
        working.value = '';
    }
}

async function installPlugin() {
    working.value = 'install';
    try {
        const r = await dshApi.installPlugin({ verify: true, restart: true, waitOnline: true });

        if (!r.ok) {
            toast.error('安装失败', r.error || '未知错误');
            return;
        }

        // stage 直接说明走到哪一步，比单看 ok 更有信息量
        if (r.online) {
            toast.success('安装完成', r.message ?? '插件已连接，消息将直接进入 dsh');
        } else if (r.stage === 'restart-failed') {
            toast.warning('已安装但重启失败', r.restart?.error ?? '请手动重启服务');
        } else {
            toast.warning('已安装', r.message ?? '插件尚未上线，见服务日志');
        }
        await load({ silent: true });
    } catch (e) {
        toast.error('安装失败', e instanceof Error ? e.message : String(e));
    } finally {
        working.value = '';
    }
}

async function removePlugin() {
    working.value = 'remove-plugin';
    try {
        const r = await dshApi.removePlugin({ restart: true });
        if (!r.remove.ok) {
            toast.error('移除失败', r.remove.error || '未知错误');
            return;
        }
        toast.success('连接插件已移除', '已重启服务');
        await load({ silent: true });
    } catch (e) {
        toast.error('移除失败', e instanceof Error ? e.message : String(e));
    } finally {
        working.value = '';
    }
}

onMounted(() => void load({ silent: true }));
</script>

<template>
    <div class="flex flex-col gap-5">
        <!-- 说明 -->
        <UiCard class="border-info/30 bg-info/5">
            <div class="flex items-start gap-3 px-5 py-4">
                <Info class="mt-0.5 size-4 shrink-0 text-info" />
                <div class="min-w-0 text-xs leading-relaxed text-muted-foreground">
                    <p class="font-medium text-foreground">下游 = 谁来回这条 QQ 消息</p>
                    <p class="mt-1">
                        SnowLuma 是唯一上游；下游可以有多个实例（dsh、酒馆、多个 dsh 各连不同模型）。
                        每个 QQ 会话可单独选一个，未指定时用「默认下游」。
                        新下游可以在这里手动添加，也可以由插件调用注册接口自动登记。
                    </p>
                </div>
            </div>
        </UiCard>

        <!-- 列表 -->
        <UiCard>
            <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-5 py-3.5">
                <div class="flex items-center gap-2">
                    <Boxes class="size-4 text-muted-foreground" />
                    <h3 class="text-sm font-semibold tracking-tight">下游实例</h3>
                    <UiBadge tone="outline" class="text-micro">{{ registered.length }} 个</UiBadge>
                    <UiBadge :tone="store.live ? 'success' : 'secondary'" dot class="text-micro">
                        {{ store.live ? '实时' : '轮询' }}
                    </UiBadge>
                </div>
                <div class="flex flex-wrap items-center gap-2">
                    <UiButton size="sm" :disabled="saving" @click="showForm = !showForm">
                        <Plus class="size-3.5" />
                        新增
                    </UiButton>
                    <UiButton variant="ghost" size="sm" :disabled="loading" @click="load()">
                        <RefreshCw class="size-3.5" :class="loading ? 'animate-spin' : ''" />
                    </UiButton>
                </div>
            </div>

            <!-- 新增表单 -->
            <div v-if="showForm" class="border-b border-border/40 bg-accent/20 px-5 py-4">
                <div class="grid gap-3 sm:grid-cols-2">
                    <div class="flex flex-col gap-1.5">
                        <label class="text-xs font-medium">实例 id</label>
                        <UiInput v-model="form.id" mono placeholder="例如 dsh-claude" />
                        <p class="text-[11px] text-muted-foreground">字母/数字/下划线/短横线，会话用它引用</p>
                    </div>
                    <div class="flex flex-col gap-1.5">
                        <label class="text-xs font-medium">类型</label>
                        <UiSelect
                            v-model="form.kind"
                            :options="kinds.map((k) => ({ value: k.kind, label: k.label }))"
                        />
                        <p class="text-[11px] text-muted-foreground">
                            {{ kinds.find((k) => k.kind === form.kind)?.description }}
                        </p>
                    </div>
                    <div class="flex flex-col gap-1.5">
                        <label class="text-xs font-medium">显示名称</label>
                        <UiInput v-model="form.name" placeholder="留空用 id" />
                    </div>
                    <div v-if="isDshKind(form.kind)" class="flex flex-col gap-1.5">
                        <label class="text-xs font-medium">超时（毫秒）</label>
                        <UiInput v-model.number="form.timeoutMs" type="number" mono />
                    </div>
                </div>
                <div class="mt-3 flex items-center gap-2">
                    <UiButton size="sm" :disabled="saving" @click="create">
                        <Loader2 v-if="saving" class="size-3.5 animate-spin" />
                        <Plus v-else class="size-3.5" />
                        创建
                    </UiButton>
                    <UiButton variant="ghost" size="sm" @click="showForm = false">取消</UiButton>
                </div>
            </div>

            <div v-if="registered.length === 0" class="px-5 py-8 text-center text-xs text-muted-foreground">
                还没有下游实例
            </div>

            <div v-else class="divide-y divide-border/50">
                <div v-for="item in registered" :key="item.id">
                    <!-- 实例主行 -->
                    <div class="px-5 py-3.5">
                        <div class="flex flex-wrap items-center justify-between gap-2">
                            <div class="flex flex-wrap items-center gap-2">
                                <button
                                    v-if="isDshKind(item.kind)"
                                    class="text-muted-foreground transition-colors hover:text-foreground"
                                    @click="toggle(item.id)"
                                >
                                    <component :is="expanded[item.id] ? ChevronDown : ChevronRight" class="size-3.5" />
                                </button>
                                <span class="font-mono text-xs">{{ item.id }}</span>
                                <UiBadge tone="outline" class="text-micro">{{ kindLabel(item.kind) }}</UiBadge>
                                <UiBadge v-if="defaultId === item.id" tone="info" class="text-micro">
                                    <Star class="mr-0.5 size-2.5" />
                                    默认
                                </UiBadge>
                                <UiBadge
                                    :tone="statusOf(item.id)?.available ? 'success' : 'warning'"
                                    dot
                                    class="text-micro"
                                >
                                    {{ statusOf(item.id)?.available ? '可用' : '离线' }}
                                </UiBadge>
                                <UiBadge v-if="!item.enabled" tone="outline" class="text-micro">已停用</UiBadge>
                            </div>
                            <div class="flex flex-wrap items-center gap-1.5">
                                <UiButton
                                    v-if="defaultId !== item.id"
                                    variant="ghost"
                                    size="sm"
                                    :disabled="saving || !item.enabled"
                                    @click="setDefault(item.id)"
                                >
                                    <Star class="size-3.5" />
                                    设为默认
                                </UiButton>
                                <UiButton
                                    variant="ghost"
                                    size="sm"
                                    :disabled="testing !== '' || !item.enabled"
                                    @click="runTest(item.id)"
                                >
                                    <Loader2 v-if="testing === item.id" class="size-3.5 animate-spin" />
                                    <Play v-else class="size-3.5" />
                                    测试
                                </UiButton>
                                <UiButton
                                    variant="ghost"
                                    size="sm"
                                    :disabled="removing !== ''"
                                    @click="remove(item.id)"
                                >
                                    <Loader2 v-if="removing === item.id" class="size-3.5 animate-spin" />
                                    <Trash2 v-else class="size-3.5" />
                                </UiButton>
                            </div>
                        </div>

                        <p class="mt-1 text-[11px] text-muted-foreground">
                            {{ item.name }}
                            <span v-if="statusOf(item.id)?.reason" class="ml-1 opacity-80">
                                · {{ statusOf(item.id)!.reason }}
                            </span>
                        </p>

                        <div class="mt-2 flex items-center justify-between rounded-md border border-border/50 px-2.5 py-1.5">
                            <div class="min-w-0">
                                <p class="text-[11px] font-medium">启用</p>
                                <p class="text-[10px] text-muted-foreground">
                                    停用后不再接收新消息（会话引用它的会报错）
                                </p>
                            </div>
                            <UiSwitch
                                :model-value="item.enabled"
                                :disabled="saving"
                                class="shrink-0"
                                @update:model-value="(v: boolean) => toggleEnabled(item, v)"
                            />
                        </div>

                        <div
                            v-if="testResults[item.id]"
                            class="mt-2 rounded-md border px-2.5 py-1.5"
                            :class="testResults[item.id]!.ok
                                ? 'border-success/40 bg-success/5'
                                : 'border-destructive/40 bg-destructive/5'"
                        >
                            <p class="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                                <component
                                    :is="testResults[item.id]!.ok ? CheckCircle2 : AlertTriangle"
                                    class="size-3"
                                    :class="testResults[item.id]!.ok ? 'text-success' : 'text-destructive'"
                                />
                                <span v-if="testResults[item.id]!.ok">
                                    {{ (testResults[item.id]!.elapsedMs / 1000).toFixed(1) }}s
                                </span>
                                <span v-else>{{ testResults[item.id]!.error }}</span>
                            </p>
                            <p v-if="testResults[item.id]!.text" class="mt-1 whitespace-pre-wrap break-words text-xs">
                                {{ testResults[item.id]!.text }}
                            </p>
                        </div>
                    </div>

                    <!-- dsh 实例展开：常驻服务 + 连接插件 -->
                    <div
                        v-if="isDshKind(item.kind) && expanded[item.id]"
                        class="border-t border-border/40 bg-accent/10 px-5 py-3.5"
                    >
                        <!-- 环境 -->
                        <div class="mb-3 grid gap-x-6 gap-y-1.5 text-[11px] sm:grid-cols-2">
                            <div class="flex items-center gap-1.5">
                                <span class="text-muted-foreground">dsh 安装</span>
                                <span :class="dsh?.installed ? 'text-success' : 'text-warning'">
                                    {{ dsh?.installed ? `已安装 ${dsh.version}` : '未找到' }}
                                </span>
                            </div>
                            <div class="flex min-w-0 items-center gap-1.5">
                                <span class="shrink-0 text-muted-foreground">DSH_HOME</span>
                                <span class="truncate font-mono">{{ dsh?.home || '—' }}</span>
                            </div>
                        </div>

                        <!-- 多版本：桌面版优先，其余作为备选 -->
                        <div
                            v-if="(dsh?.installations?.length ?? 0) > 1"
                            class="mb-3 rounded-md border border-border/50 px-2.5 py-2"
                        >
                            <p class="mb-1 text-[10px] text-muted-foreground">
                                检测到 {{ dsh?.installations?.length }} 个安装，已自动选用优先级最高的
                            </p>
                            <div
                                v-for="inst in dsh?.installations ?? []"
                                :key="inst.path"
                                class="flex items-center gap-1.5 py-0.5 text-[10px]"
                            >
                                <span
                                    class="size-1 shrink-0 rounded-full"
                                    :class="inst.path === dsh?.exePath ? 'bg-success' : 'bg-muted-foreground/30'"
                                />
                                <span :class="inst.path === dsh?.exePath ? 'text-foreground' : 'text-muted-foreground/70'">
                                    {{ sourceLabel(inst.source) }}
                                </span>
                                <span class="font-mono text-muted-foreground/70">v{{ inst.version || '?' }}</span>
                                <span class="min-w-0 flex-1 truncate font-mono text-muted-foreground/50">
                                    {{ inst.path }}
                                </span>
                            </div>
                        </div>

                        <!-- 目录自检异常 -->
                        <div
                            v-if="dsh?.homeCheck"
                            class="mb-3 flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/5 px-2.5 py-2"
                        >
                            <AlertTriangle class="mt-0.5 size-3 shrink-0 text-warning" />
                            <div class="min-w-0 text-[10px] text-muted-foreground">
                                <p class="text-warning">{{ dsh.homeCheck.reason }}</p>
                                <p class="mt-0.5">{{ dsh.homeCheck.hint }}</p>
                                <p class="mt-0.5 font-mono">{{ dsh.homeCheck.home }}</p>
                            </div>
                        </div>

                        <!-- 常驻服务 -->
                        <div class="rounded-md border border-border/60 bg-card/40 p-3">
                            <div class="flex flex-wrap items-center justify-between gap-2">
                                <div class="flex items-center gap-2">
                                    <Power class="size-3.5 text-muted-foreground" />
                                    <span class="text-xs font-medium">dsh 常驻服务</span>
                                    <UiBadge :tone="serviceRunning ? 'success' : 'outline'" dot class="text-micro">
                                        {{ serviceRunning ? '运行中' : '未运行' }}
                                    </UiBadge>
                                    <UiBadge v-if="dsh?.service?.pid" tone="outline" class="text-micro">
                                        pid {{ dsh.service.pid }}
                                    </UiBadge>
                                </div>
                                <div class="flex flex-wrap items-center gap-1.5">
                                    <UiButton
                                        variant="outline"
                                        size="sm"
                                        :disabled="working !== '' || !dsh?.installed"
                                        @click="serviceAction(serviceRunning ? 'stop' : 'start')"
                                    >
                                        <Loader2 v-if="working.startsWith('service:')" class="size-3.5 animate-spin" />
                                        <Power v-else class="size-3.5" />
                                        {{ serviceRunning ? '停止' : '启动' }}
                                    </UiButton>
                                    <UiButton
                                        variant="outline"
                                        size="sm"
                                        :disabled="working !== '' || !dsh?.installed"
                                        @click="serviceAction('restart')"
                                    >
                                        <Loader2 v-if="working === 'service:restart'" class="size-3.5 animate-spin" />
                                        <RotateCw v-else class="size-3.5" />
                                        重启
                                    </UiButton>
                                </div>
                            </div>
                            <p class="mt-1.5 text-[10px] text-muted-foreground">
                                分离进程：Bridge 退出也不会带走它。
                                <span class="font-mono">{{ dsh?.service?.url || '' }}</span>
                            </p>
                            <div v-if="dsh?.service?.lastError" class="mt-1.5 text-[10px] text-destructive">
                                {{ dsh.service.lastError }}
                            </div>
                        </div>

                        <!-- 连接插件 -->
                        <div class="mt-2 rounded-md border border-border/60 bg-card/40 p-3">
                            <div class="flex flex-wrap items-center justify-between gap-2">
                                <div class="flex items-center gap-2">
                                    <component :is="pluginOnline ? PlugZap : Plug" class="size-3.5 text-muted-foreground" />
                                    <span class="text-xs font-medium">连接插件</span>
                                    <UiBadge
                                        :tone="pluginOnline ? 'success' : pluginInjected ? 'warning' : 'outline'"
                                        dot
                                        class="text-micro"
                                    >
                                        {{ pluginOnline ? '已连接' : pluginInjected ? '已注入·待重启' : '未注入' }}
                                    </UiBadge>
                                </div>
                                <div class="flex flex-wrap items-center gap-1.5">
                                    <UiButton size="sm" :disabled="working !== '' || !dsh?.installed" @click="installPlugin">
                                        <Loader2 v-if="working === 'install'" class="size-3.5 animate-spin" />
                                        <PlugZap v-else class="size-3.5" />
                                        {{ pluginInjected ? '重新安装' : '一键安装插件' }}
                                    </UiButton>
                                    <UiButton
                                        v-if="pluginInjected"
                                        variant="outline"
                                        size="sm"
                                        :disabled="working !== ''"
                                        @click="removePlugin"
                                    >
                                        <Loader2 v-if="working === 'remove-plugin'" class="size-3.5 animate-spin" />
                                        <Trash2 v-else class="size-3.5" />
                                        移除
                                    </UiButton>
                                </div>
                            </div>
                            <div class="mt-2 grid gap-x-6 gap-y-1.5 text-[10px] text-muted-foreground sm:grid-cols-2">
                                <div class="flex items-center gap-1">
                                    <span>插件包</span>
                                    <span class="truncate font-mono text-foreground">{{ dsh?.plugin?.pluginName }}</span>
                                </div>
                                <div class="flex items-center gap-1">
                                    <span>bundles</span>
                                    <span :class="pluginInjected ? 'text-success' : 'text-warning'">
                                        {{ pluginInjected ? '已登记' : '未登记' }}
                                    </span>
                                </div>
                                <div v-if="dsh?.plugin?.clients?.length" class="flex items-center gap-1 sm:col-span-2">
                                    <span>在线</span>
                                    <span class="truncate font-mono text-foreground">
                                        {{ dsh.plugin.clients.map((c) => `pid ${c.pid}`).join('、') }}
                                    </span>
                                </div>
                            </div>
                            <p class="mt-1.5 text-[10px] text-muted-foreground">
                                插件在线时消息在 dsh 进程内处理；离线自动回落到 headless 子进程。
                            </p>
                        </div>

                        <!-- 服务日志 -->
                        <div v-if="(dsh?.service?.logTail?.length ?? 0) > 0" class="mt-2">
                            <p class="mb-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                                <FileText class="size-3" />
                                服务日志尾部
                            </p>
                            <pre
                                class="max-h-32 overflow-auto rounded-md bg-muted/40 px-2.5 py-2 font-mono text-[10px] leading-relaxed text-muted-foreground"
                            >{{ (dsh?.service?.logTail ?? []).slice(-12).join('\n') }}</pre>
                        </div>

                        <!-- 提示词：默认全关，只转发用户原话 -->
                        <div class="mt-2 rounded-md border border-border/60 bg-card/40 p-3">
                            <div class="flex flex-wrap items-center justify-between gap-2">
                                <div class="flex items-center gap-2">
                                    <MessageSquare class="size-3.5 text-muted-foreground" />
                                    <span class="text-xs font-medium">提示词注入</span>
                                    <UiBadge
                                        :tone="promptEnabledCount(item.id) > 0 ? 'info' : 'outline'"
                                        class="text-micro"
                                    >
                                        {{ promptEnabledCount(item.id) > 0
                                            ? `已开 ${promptEnabledCount(item.id)} 项`
                                            : '全部关闭' }}
                                    </UiBadge>
                                </div>
                                <UiButton
                                    size="sm"
                                    variant="outline"
                                    :disabled="saving"
                                    @click="savePrompt(item)"
                                >
                                    <Loader2 v-if="working === `prompt:${item.id}`" class="size-3.5 animate-spin" />
                                    <Save v-else class="size-3.5" />
                                    保存
                                </UiButton>
                            </div>

                            <p class="mt-1.5 text-[10px] text-muted-foreground">
                                默认不发送任何提示词，只把用户原话转发给下游。
                                打开下面任意一项后，才会把对应内容拼进去。
                            </p>

                            <div class="mt-2 space-y-1.5">
                                <label
                                    v-for="opt in PROMPT_OPTIONS"
                                    :key="opt.key"
                                    class="flex items-start justify-between gap-3 rounded border border-border/40 px-2.5 py-1.5"
                                >
                                    <div class="min-w-0">
                                        <p class="text-[11px] font-medium">{{ opt.label }}</p>
                                        <p class="text-[10px] text-muted-foreground">{{ opt.desc }}</p>
                                    </div>
                                    <UiSwitch
                                        :model-value="promptOf(item.id)[opt.key] === true"
                                        class="shrink-0"
                                        @update:model-value="(v: boolean) => setPromptFlag(item.id, opt.key, v)"
                                    />
                                </label>
                            </div>

                            <div class="mt-2">
                                <label class="text-[10px] text-muted-foreground">附加文本（总是最后拼接）</label>
                                <textarea
                                    :value="promptOf(item.id).extra"
                                    rows="3"
                                    class="mt-1 w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 font-mono text-[11px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
                                    placeholder="留空 = 不发送"
                                    @input="(e: Event) => setPromptExtra(item.id, (e.target as HTMLTextAreaElement).value)"
                                />
                            </div>

                            <!-- 历史引用：dsh 自己存 session，默认不发历史 -->
                            <div class="mt-3 border-t border-border/40 pt-2.5">
                                <div class="flex flex-wrap items-center justify-between gap-2">
                                    <div class="flex items-center gap-2">
                                        <span class="text-[11px] font-medium">历史引用</span>
                                        <UiBadge
                                            :tone="historyOf(item.id).length > 0 ? 'info' : 'outline'"
                                            class="text-micro"
                                        >
                                            {{ historyOf(item.id).length > 0
                                                ? `${historyOf(item.id).length} 条规则`
                                                : '不发送历史' }}
                                        </UiBadge>
                                    </div>
                                    <UiButton
                                        variant="ghost"
                                        size="sm"
                                        @click="addHistoryRule(item.id)"
                                    >
                                        <Plus class="size-3.5" />
                                        加规则
                                    </UiButton>
                                </div>
                                <p class="mt-1 text-[10px] text-muted-foreground">
                                    dsh 会按 session 自动保留上下文，所以默认不再重发历史。
                                    这里只在需要引用上一轮片段（表情标签、数值等）时加正则；
                                    命中的内容以「[参考]」附在本次消息前。
                                </p>

                                <div
                                    v-for="(rule, idx) in historyOf(item.id)"
                                    :key="idx"
                                    class="mt-1.5 flex items-center gap-1.5"
                                >
                                    <UiInput
                                        :model-value="rule.label ?? ''"
                                        placeholder="名称"
                                        class="max-w-24"
                                        @update:model-value="(v: string) => setHistoryRule(item.id, idx, { label: v })"
                                    />
                                    <UiInput
                                        :model-value="rule.pattern"
                                        placeholder="正则，如 \[表情:([^\]]+)\]"
                                        mono
                                        class="flex-1"
                                        @update:model-value="(v: string) => setHistoryRule(item.id, idx, { pattern: v })"
                                    />
                                    <UiButton
                                        variant="ghost"
                                        size="sm"
                                        @click="removeHistoryRule(item.id, idx)"
                                    >
                                        <Trash2 class="size-3.5" />
                                    </UiButton>
                                </div>
                            </div>
                        </div>

                        <!-- 准入名单：哪些 QQ 可以用这个下游 -->
                        <div class="mt-2 rounded-md border border-border/60 bg-card/40 p-3">
                            <div class="flex flex-wrap items-center justify-between gap-2">
                                <div class="flex items-center gap-2">
                                    <ShieldCheck class="size-3.5 text-muted-foreground" />
                                    <span class="text-xs font-medium">准入名单</span>
                                    <UiBadge
                                        :tone="accessSummary(item.id).tone"
                                        class="text-micro"
                                    >
                                        {{ accessSummary(item.id).label }}
                                    </UiBadge>
                                </div>
                                <UiButton
                                    size="sm"
                                    variant="outline"
                                    :disabled="saving"
                                    @click="saveAccess(item)"
                                >
                                    <Loader2 v-if="working === `access:${item.id}`" class="size-3.5 animate-spin" />
                                    <Save v-else class="size-3.5" />
                                    保存
                                </UiButton>
                            </div>

                            <p class="mt-1.5 text-[10px] text-muted-foreground">
                                控制哪些 QQ 号能用这个下游。留空 = 所有人可用；
                                黑名单优先于白名单。
                            </p>

                            <div class="mt-2 grid gap-2 sm:grid-cols-2">
                                <div>
                                    <label class="text-[10px] text-muted-foreground">白名单（只允许这些）</label>
                                    <UiInput
                                        :model-value="accessOf(item.id).allow"
                                        class="mt-1"
                                        mono
                                        placeholder="逗号分隔 QQ 号，留空 = 不限制"
                                        @update:model-value="(v: string) => setAccessList(item.id, 'allow', v)"
                                    />
                                </div>
                                <div>
                                    <label class="text-[10px] text-muted-foreground">黑名单（禁止这些）</label>
                                    <UiInput
                                        :model-value="accessOf(item.id).deny"
                                        class="mt-1"
                                        mono
                                        placeholder="逗号分隔 QQ 号"
                                        @update:model-value="(v: string) => setAccessList(item.id, 'deny', v)"
                                    />
                                </div>
                            </div>
                        </div>

                        <!-- 进度转发：把分析摘要发到 QQ -->
                        <div class="mt-2 rounded-md border border-border/60 bg-card/40 p-3">
                            <div class="flex flex-wrap items-center justify-between gap-2">
                                <div class="flex items-center gap-2">
                                    <Activity class="size-3.5 text-muted-foreground" />
                                    <span class="text-xs font-medium">进度转发</span>
                                    <UiBadge :tone="progressOf(item.id).enabled ? 'info' : 'outline'" class="text-micro">
                                        {{ progressOf(item.id).enabled ? '已开启' : '关闭' }}
                                    </UiBadge>
                                </div>
                                <div class="flex items-center gap-2">
                                    <UiSwitch
                                        :model-value="progressOf(item.id).enabled"
                                        class="shrink-0"
                                        @update:model-value="(v: boolean) => setProgressFlag(item.id, 'enabled', v)"
                                    />
                                    <UiButton
                                        size="sm"
                                        variant="outline"
                                        :disabled="saving"
                                        @click="saveProgress(item)"
                                    >
                                        <Loader2 v-if="working === `progress:${item.id}`" class="size-3.5 animate-spin" />
                                        <Save v-else class="size-3.5" />
                                        保存
                                    </UiButton>
                                </div>
                            </div>

                            <p class="mt-1.5 text-[10px] text-muted-foreground">
                                把 dsh 的分析摘要（开始处理、读取、搜索、执行命令等）发到 QQ，
                                让用户知道进行到哪一步。默认关闭；开启后会限流，不会刷屏。
                            </p>

                            <div v-if="progressOf(item.id).enabled" class="mt-2 grid gap-2 sm:grid-cols-3">
                                <div>
                                    <label class="text-[10px] text-muted-foreground">最小间隔（毫秒）</label>
                                    <UiInput
                                        :model-value="String(progressOf(item.id).minIntervalMs)"
                                        type="number"
                                        mono
                                        class="mt-1"
                                        @update:model-value="(v: string) => setProgressNum(item.id, 'minIntervalMs', v)"
                                    />
                                </div>
                                <div>
                                    <label class="text-[10px] text-muted-foreground">最多几条</label>
                                    <UiInput
                                        :model-value="String(progressOf(item.id).maxMessages)"
                                        type="number"
                                        mono
                                        class="mt-1"
                                        @update:model-value="(v: string) => setProgressNum(item.id, 'maxMessages', v)"
                                    />
                                </div>
                                <div>
                                    <label class="text-[10px] text-muted-foreground">消息前缀</label>
                                    <UiInput
                                        :model-value="progressOf(item.id).prefix"
                                        class="mt-1"
                                        placeholder="⏳ "
                                        @update:model-value="(v: string) => setProgressText(item.id, 'prefix', v)"
                                    />
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </UiCard>

        <!-- 说明：插件自注册 -->
        <UiCard class="border-border/60">
            <div class="flex items-start gap-3 px-5 py-4">
                <Server class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div class="min-w-0 text-xs leading-relaxed text-muted-foreground">
                    <p class="font-medium text-foreground">插件自动注册</p>
                    <p class="mt-1">
                        dsh 连接插件启动时会调用
                        <code class="font-mono">POST /api/downstreams/register</code>
                        把自己登记成下游，无需手工配置。该接口需要凭据
                        （配置里的 <code class="font-mono">registrationToken</code>，首次运行自动生成），
                        且只接受本机连接。
                    </p>
                    <p class="mt-1.5 flex items-center gap-1.5">
                        <Terminal class="size-3" />
                        上游 SnowLuma 的探测与配置在「SnowLuma 接入」页。
                    </p>
                </div>
            </div>
        </UiCard>
    </div>
</template>
