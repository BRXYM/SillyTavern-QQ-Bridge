<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import {
    Server, Play, Square, RotateCw, Download, ExternalLink, FolderOpen, RefreshCw,
    Wand2, CheckCircle2, AlertTriangle, Info, Copy, Trash2, Save, Eye, EyeOff,
    Plug, Plus,
} from 'lucide-vue-next';
import UiCard from '@/components/ui/UiCard.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiBadge from '@/components/ui/UiBadge.vue';
import UiInput from '@/components/ui/UiInput.vue';
import UiSelect from '@/components/ui/UiSelect.vue';
import UiSwitch from '@/components/ui/UiSwitch.vue';
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

/**
 * 当前正在进行的 SnowLuma 操作。
 *
 * 为什么要单独记一份：`discovering` / `probing` / `applying` 只是布尔，
 * 界面上只表现为按钮文字变了，用户要盯一会儿才发现"哦，在检测"。
 * 这里额外维护「阶段 + 具体说明」，让它变成一个一眼可见的进度条。
 */
type SnowTask = 'idle' | 'discover' | 'probe' | 'apply';
const snowTask = ref<SnowTask>('idle');
/** 当前阶段的说明文字，随进度更新 */
const snowHint = ref('');
/** 当前阶段的标题 */
const snowTaskTitle = computed(() => {
    switch (snowTask.value) {
        case 'discover': return '正在自动检测 SnowLuma';
        case 'probe': return '正在读取 SnowLuma 配置';
        case 'apply': return '正在写入 OneBot 配置';
        default: return '';
    }
});

/** 有任何 SnowLuma 操作在跑时为 true —— 期间锁住可交互区域 */
const snowBusy = computed(() => snowTask.value !== 'idle');

/** 首次进入、还没有任何结果时的"骨架"状态 */
const snowInitialLoading = computed(() => snowBusy.value && !probe.value && !discoverResult.value);

/** 自动检测 SnowLuma 目录 */
async function doDiscover(opts: { silent?: boolean } = {}) {
    discovering.value = true;
    snowTask.value = 'discover';
    snowHint.value = '正在扫描运行中的进程与常见目录…';
    discoverResult.value = null;
    try {
        const r = await api.discoverSnowLuma(snowDir.value.trim());
        discoverResult.value = r;

        if (!r.found || r.candidates.length === 0) {
            snowHint.value = '没有找到可用的 SnowLuma';
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
            snowHint.value = `找到 ${r.candidates.length} 个候选，正在读取 ${best.dir}`;
            snowDir.value = best.dir;
            if ((best.accounts ?? []).length > 0 && !snowUin.value) {
                snowUin.value = (best.accounts ?? [])[0]!;
            }
            // 进入页面时的自动检测不弹通知
            if (!opts.silent) {
                toast.success(`已定位 SnowLuma`, `${best.dir} · ${best.source}`);
            }
            // 探测会接管 snowTask，这里 await 保证阶段串联
            await doProbe({ silent: opts.silent });
            return;
        }
    } catch (e) {
        if (!opts.silent) {
            toast.error('自动检测失败', e instanceof Error ? e.message : String(e));
        }
    } finally {
        discovering.value = false;
        // 只有探测没接手时才收尾，否则会把探测的进度提前抹掉
        if (snowTask.value === 'discover') {
            snowTask.value = 'idle';
            snowHint.value = '';
        }
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

// ---------------- 上游账号（多账号） ----------------
// 每一个账号对应 SnowLuma 的一个 OneBot 端点。这里只做增删改，
// 地址与 Token 通常由下面的「自动配置连接」写入，不必手填。

const loadingOnebot = ref(false);

interface AccountForm {
    id: string;
    uin: string;
    name: string;
    enabled: boolean;
    url: string;
    token: string;
}

const accounts = ref<Array<AccountForm & {
    running: boolean;
    connected: boolean;
    selfId: string;
    nickname: string;
    lastError: string;
}>>([]);
const loadingAccounts = ref(false);
const savingAccount = ref(false);
/** 正在编辑的账号 id（空 = 新增表单收起） */
const editingAccount = ref<AccountForm | null>(null);

const upstreamConnected = computed(() => store.onebotConnected);

/**
 * 账号的在线状态以 `/api/status` 为准。
 *
 * `/api/accounts` 只在挂载与保存时拉一次，SSE 推来的连接变化不会进它，
 * 页面开着时状态会一直停在旧值。这里用状态快照里的 accounts 覆盖在线相关字段，
 * 其余（地址、token、备注）仍以 accounts 接口为准。
 */
watch(
    () => store.status?.accounts,
    (live) => {
        if (!live || live.length === 0) return;
        const byId = new Map(live.map((a) => [a.id, a]));
        accounts.value = accounts.value.map((acc) => {
            const hit = byId.get(acc.id);
            if (!hit) return { ...acc, running: false, connected: false };
            return {
                ...acc,
                running: true,
                connected: hit.connected,
                selfId: hit.selfId,
                nickname: hit.nickname,
                lastError: hit.lastError,
            };
        });
    },
    { deep: true },
);

async function loadAccounts(silent = false): Promise<void> {
    loadingAccounts.value = true;
    try {
        const r = await api.accounts();
        accounts.value = r.accounts.map((a) => ({
            id: a.id,
            uin: a.uin,
            name: a.name,
            enabled: a.enabled,
            url: a.upstream.url,
            token: a.upstream.token,
            running: a.running,
            connected: a.connected,
            selfId: a.selfId,
            nickname: a.nickname,
            lastError: a.lastError,
        }));
    } catch (e) {
        if (!silent) toast.error('读取账号失败', e instanceof Error ? e.message : String(e));
    } finally {
        loadingAccounts.value = false;
    }
}

function newAccount(): void {
    // id 用序号，用户可改；uin 留空也行（连上后自动识别）
    editingAccount.value = {
        id: `account_${accounts.value.length + 1}`,
        uin: '',
        name: '',
        enabled: true,
        url: 'ws://127.0.0.1:3001',
        token: '',
    };
}

function editAccount(a: AccountForm): void {
    editingAccount.value = { ...a };
}

async function saveAccount(): Promise<void> {
    const acc = editingAccount.value;
    if (!acc) return;
    if (!acc.url.trim()) {
        toast.warning('请填写 OneBot 地址');
        return;
    }

    savingAccount.value = true;
    try {
        await api.saveAccount({
            id: acc.id.trim(),
            uin: acc.uin.trim(),
            name: acc.name.trim() || acc.uin.trim() || acc.id,
            enabled: acc.enabled,
            upstream: {
                url: acc.url.trim(),
                token: acc.token.trim(),
                reconnectMs: 5000,
                actionTimeoutMs: 15000,
            },
        });
        editingAccount.value = null;
        await loadAccounts(true);
        await store.refresh();
        toast.success('账号已保存', `${acc.id} · 配置变更后会立即重连`);
    } catch (e) {
        toast.error('保存失败', e instanceof Error ? e.message : String(e));
    } finally {
        savingAccount.value = false;
    }
}

async function removeAccount(id: string): Promise<void> {
    if (accounts.value.length <= 1) {
        toast.warning('不能删除', '至少要保留一个账号');
        return;
    }
    try {
        const r = await api.deleteAccount(id);
        await loadAccounts(true);
        await store.refresh();
        toast.success(
            '账号已删除',
            r.removedSessions > 0 ? `连带清除了 ${r.removedSessions} 个会话配置` : undefined,
        );
    } catch (e) {
        toast.error('删除失败', e instanceof Error ? e.message : String(e));
    }
}

// ---------------- 已接入 QQ 号汇总 ----------------// 这区块回答一个问题：「现在到底有哪些号在跑？」
// 三个来源合并看：Bridge 自己配的账号、实际连上的 selfId、SnowLuma 里登录的号。
// 后两个能暴露出「SnowLuma 里有这个号，但 Bridge 还没接」这种漏配。

interface ActiveAccount {
    /** Bridge 账号 id（未配置的号为空） */
    id: string;
    /** QQ 号 */
    uin: string;
    name: string;
    /** 上游连接是否在线 */
    online: boolean;
    /** 是否已配置在 Bridge 里 */
    configured: boolean;
    /** 是否在 SnowLuma 的账号目录里 */
    inSnowLuma: boolean;
}

const activeAccounts = computed<ActiveAccount[]>(() => {
    const out = new Map<string, ActiveAccount>();

    // 1) Bridge 配置的账号
    //
    // key 优先用配置里的 uin，而不是 selfId：没连上时只有 uin，
    // 连上后两者都在，用 selfId 做 key 会让同一个号在连上前后变成两条。
    for (const acc of accounts.value) {
        const uin = acc.uin || acc.selfId;
        const key = uin || acc.id;
        out.set(key, {
            id: acc.id,
            uin,
            name: acc.name,
            online: acc.connected,
            configured: true,
            inSnowLuma: false,
        });
    }

    // 2) SnowLuma 数据目录里有的号（不代表在线，只说明 SnowLuma 见过这个号）
    for (const item of probe.value?.accounts ?? []) {
        const uin = String(item.uin);
        const hit = out.get(uin);
        if (hit) {
            hit.inSnowLuma = true;
        } else {
            // SnowLuma 有、Bridge 没配 —— 这就是"漏接的号"
            out.set(uin, {
                id: '',
                uin,
                name: '',
                online: false,
                configured: false,
                inSnowLuma: true,
            });
        }
    }

    // 3) 配置里 uin 留空、但实际连上后识别出了 selfId 的账号
    //    （key 是账号 id 那条），补上真实号，避免显示成"(号未识别)"
    for (const acc of accounts.value) {
        if (acc.uin || !acc.selfId) continue;
        const entry = out.get(acc.id);
        if (entry) entry.uin = acc.selfId;
    }

    // 在线的排前面，其余按 QQ 号排序，扫一眼就知道谁在跑
    return [...out.values()].sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1;
        if (a.configured !== b.configured) return a.configured ? -1 : 1;
        return a.uin.localeCompare(b.uin);
    });
});

const onlineAccountCount = computed(() => activeAccounts.value.filter((a) => a.online).length);
const unconfiguredAccounts = computed(() => activeAccounts.value.filter((a) => !a.configured));

/** 一键把一个 SnowLuma 里已登录的号接进来 */
function adoptAccount(uin: string): void {
    snowUin.value = uin;
    editingAccount.value = {
        id: `qq_${uin}`,
        uin,
        name: `QQ ${uin}`,
        enabled: true,
        url: 'ws://127.0.0.1:3001',
        token: '',
    };
    // 顺手读它的 OneBot 端点，省得手填端口和 token
    void fillAccountFromSnowLuma();
}

/** 从 SnowLuma 的 onebot_<uin>.json 读取地址与 Token，回填到编辑表单 */
async function fillAccountFromSnowLuma() {    const uin = snowUin.value.trim();
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
        const url = `ws://${host}:${port}${p}`;

        // 有正在编辑的表单就回填它，否则给这个号新建一个
        const target = editingAccount.value ?? {
            id: `qq_${uin}`,
            uin,
            name: `QQ ${uin}`,
            enabled: true,
            url,
            token: ws.accessToken ?? '',
        };
        target.url = url;
        if (ws.accessToken) target.token = ws.accessToken;
        editingAccount.value = { ...target };

        toast.success(
            '已读取 SnowLuma 配置',
            `${url} · ${ws.accessToken ? '含 Token' : '无 Token'}`,
        );
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
    // 探测是最终阶段，会覆盖掉「自动检测」的进度说明
    snowTask.value = 'probe';
    snowHint.value = `正在读取 ${snowDir.value.trim()} 的配置与账号…`;
    // 手动探测时清空上次结果；自动配置后刷新探测则保留结果面板
    if (!opts.keepResult) applyResult.value = null;
    try {
        const r = await api.probeSnowLuma(snowDir.value.trim(), snowWebuiPort.value);
        probe.value = r;
        if (!r.ok) {
            snowHint.value = '目录探测失败';
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
        // 只在没被别的阶段接手时收尾
        if (snowTask.value === 'probe') {
            snowTask.value = 'idle';
            snowHint.value = '';
        }
    }
}

async function doApply(forceToken = false) {
    if (!snowUin.value.trim()) {
        toast.warning('请填写 QQ 号', '可在 SnowLuma 登录后自动识别');
        return;
    }
    applying.value = true;
    snowTask.value = 'apply';
    snowHint.value = `正在写入 onebot_${snowUin.value.trim()}.json…`;
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
        await doProbe({ keepResult: true, silent: true });
    } catch (e) {
        toast.error('自动配置失败', e instanceof Error ? e.message : String(e));
    } finally {
        applying.value = false;
        if (snowTask.value === 'apply') {
            snowTask.value = 'idle';
            snowHint.value = '';
        }
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

    // 账号列表
    void loadAccounts(true);

    const sl = (cfg?.['snowluma'] ?? {}) as Record<string, unknown>;
    const saved = sl['dir'];
    if (typeof saved === 'string' && saved) {
        snowDir.value = saved;
        const p = sl['webuiPort'];
        if (typeof p === 'number' && p > 0) snowWebuiPort.value = p;
        // 进入页面自动探测：静默，不弹通知
        void doProbe({ silent: true });
    } else {
        // 首次使用：自动尝试定位 SnowLuma（静默）
        void doDiscover({ silent: true });
    }

    // OneBot 端口：取第一个账号的地址
    const firstAcc = (cfg?.['accounts'] as Array<{ upstream?: { url?: string } }> | undefined)?.[0];
    const url = firstAcc?.upstream?.url;
    if (typeof url === 'string') {
        const m = url.match(/:(\d+)/);
        if (m) snowPort.value = Number(m[1]);
    }

    // 读取自动注入状态
    void loadHook();
});

// ---------------- QQ 进程自动注入 ----------------

interface HookState {
    ok: boolean;
    configured: boolean;
    found?: boolean;
    dir?: string;
    runtimePath?: string;
    hasWebuiConfig?: boolean;
    webuiPort?: number;
    hookAutoLoad?: boolean;
    error?: string;
}

const hook = ref<HookState | null>(null);
const savingHook = ref(false);
/** 改完需要重启 SnowLuma 才生效 */
const hookNeedsRestart = ref(false);

async function loadHook(): Promise<void> {
    try {
        hook.value = await api.snowlumaHook();
        hookNeedsRestart.value = false;
    } catch (e) {
        hook.value = {
            ok: false,
            configured: false,
            error: e instanceof Error ? e.message : String(e),
        };
    }
}

async function toggleHook(enabled: boolean): Promise<void> {
    savingHook.value = true;
    try {
        const r = await api.setSnowlumaHook(enabled);
        hookNeedsRestart.value = r.needsRestart === true;
        toast.success(
            enabled ? '已开启自动注入' : '已关闭自动注入',
            r.needsRestart ? '需要重启 SnowLuma 才生效' : '已生效',
        );
        await loadHook();
        // loadHook 会把 restsart 标记重置，这里恢复
        hookNeedsRestart.value = r.needsRestart === true;
    } catch (e) {
        toast.error('设置失败', e instanceof Error ? e.message : String(e));
        await loadHook();
    } finally {
        savingHook.value = false;
    }
}
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

            <!-- 进行中的操作：进度条 + 明确说明，避免"看不出在检测" -->
            <div
                v-if="snowBusy"
                class="border-b border-primary/20 bg-primary/5 px-5 py-2.5"
            >
                <div class="flex flex-wrap items-center gap-2">
                    <Loader2 class="size-3.5 shrink-0 animate-spin text-primary" />
                    <p class="text-xs font-medium text-primary">{{ snowTaskTitle }}</p>
                    <span class="text-[11px] text-muted-foreground">{{ snowHint }}</span>
                </div>
                <!-- 不确定进度的滑动条：告诉用户"在动"，不是卡住 -->
                <div class="mt-1.5 h-0.5 w-full overflow-hidden rounded-full bg-primary/15">
                    <div class="h-full w-1/3 animate-[snowluma-progress_1.2s_ease-in-out_infinite] rounded-full bg-primary" />
                </div>
            </div>

            <!-- 路径配置 -->
            <div
                class="grid gap-4 px-5 py-4 transition-opacity"
                :class="snowBusy ? 'pointer-events-none opacity-60' : ''"
                :aria-busy="snowBusy"
            >
                <div>
                    <label class="text-xs font-medium text-muted-foreground">SnowLuma 目录</label>
                    <div class="mt-1.5 flex items-center gap-2">
                        <UiInput
                            v-model="snowDir"
                            class="flex-1"
                            mono
                            placeholder="例如 D:\WorkSpace\SnowLuma"
                        />
                        <UiButton variant="secondary" size="sm" :disabled="snowBusy" @click="doDiscover">
                            <Wand2 class="size-4" :class="discovering ? 'animate-pulse' : ''" />
                            {{ discovering ? '检测中…' : '自动检测' }}
                        </UiButton>
                        <UiButton variant="outline" size="sm" :disabled="snowBusy || !snowDir" @click="doProbe">
                            <RefreshCw class="size-4" :class="probing ? 'animate-spin' : ''" />
                            {{ probing ? '探测中…' : '探测' }}
                        </UiButton>
                    </div>
                    <p class="mt-1.5 text-xs text-muted-foreground">
                        填 SnowLuma 的根目录（含 <code class="font-mono">dist/</code> 或
                        <code class="font-mono">packages/core/</code> 的那一层），Bridge 会自动定位配置与账号
                    </p>
                </div>

                <!-- 首次进入且正在检测：给个骨架，避免卡片只剩一个按钮 -->
                <div
                    v-if="snowInitialLoading"
                    class="flex items-center gap-2 rounded-lg border border-border/50 bg-accent/10 px-3.5 py-3"
                >
                    <Loader2 class="size-4 shrink-0 animate-spin text-muted-foreground/60" />
                    <p class="text-xs text-muted-foreground">
                        正在查找 SnowLuma…<span class="opacity-70">首次检测要扫进程和几个常见目录，稍等几秒</span>
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
                                    SnowLuma 里有记录的账号：
                                    <span v-if="probe.accounts.length === 0" class="text-warning">
                                        无（请先在 SnowLuma 登录 QQ）
                                    </span>
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
                    :disabled="snowBusy || !snowDir"
                    @click="doApply(false)"
                >
                    <Loader2 v-if="applying" class="size-4 animate-spin" />
                    <Wand2 v-else class="size-4" />
                    {{ applying ? '配置中…' : '自动配置连接' }}
                </UiButton>
                <UiButton
                    variant="outline"
                    size="sm"
                    :disabled="snowBusy || !snowDir"
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

            <!-- 上游账号（多账号） -->
            <div class="border-t border-border/40 px-5 py-4">
                <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div>
                        <h3 class="text-[13px] font-semibold tracking-tight">上游账号</h3>
                        <p class="text-xs text-muted-foreground">
                            每个账号对应 SnowLuma 的一个 OneBot 端点，可以同时接多个 QQ 号
                        </p>
                    </div>
                    <UiButton size="sm" variant="outline" :disabled="snowBusy" @click="newAccount">
                        <Plus class="size-4" />
                        添加账号
                    </UiButton>
                </div>

                <!-- 已接入 QQ 号汇总 -->
                <div class="mb-3 rounded-md border border-border/60 bg-accent/15 px-3 py-2.5">
                    <div class="flex flex-wrap items-center gap-2">
                        <p class="text-[11px] font-medium">已接入 QQ 号</p>
                        <UiBadge :tone="onlineAccountCount > 0 ? 'success' : 'secondary'" dot class="text-micro">
                            {{ onlineAccountCount }} / {{ activeAccounts.length }} 在线
                        </UiBadge>
                        <div class="flex-1" />
                        <span v-if="unconfiguredAccounts.length > 0" class="text-[10px] text-warning">
                            {{ unconfiguredAccounts.length }} 个号有记录但未接入
                        </span>
                    </div>

                    <p v-if="activeAccounts.length === 0" class="mt-1.5 text-[11px] text-muted-foreground">
                        还没有接入任何 QQ 号。填好上面的 QQ 号点「自动配置连接」即可接入。
                    </p>

                    <div v-else class="mt-1.5 flex flex-wrap gap-1.5">
                        <span
                            v-for="a in activeAccounts"
                            :key="a.uin || a.id"
                            class="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]"
                            :class="a.online
                                ? 'border-success/40 bg-success/5'
                                : (a.configured
                                    ? 'border-border/60 bg-card'
                                    : 'border-warning/40 bg-warning/5')"
                        >
                            <span
                                class="size-1.5 shrink-0 rounded-full"
                                :class="a.online
                                    ? 'bg-success'
                                    : (a.configured ? 'bg-muted-foreground/40' : 'bg-warning')"
                            />
                            <span class="font-mono">{{ a.uin || '(号未识别)' }}</span>
                            <span v-if="a.name" class="text-muted-foreground">{{ a.name }}</span>
                            <span v-if="!a.configured" class="text-warning">仅 SnowLuma 有记录</span>
                            <button
                                v-if="!a.configured && a.uin"
                                type="button"
                                class="ml-0.5 rounded px-1 text-[10px] text-primary transition-colors hover:bg-primary/10"
                                :title="`接入 ${a.uin}`"
                                @click="adoptAccount(a.uin)"
                            >
                                接入
                            </button>
                        </span>
                    </div>

                    <p class="mt-1.5 text-[10px] text-muted-foreground/70">
                        绿点 = 上游连接在线；灰点 = 已配置但未连上；黄色 = SnowLuma 数据目录里有这个号，
                        但 Bridge 还没接入
                    </p>
                </div>

                <!-- 账号列表 -->
                <div v-if="accounts.length === 0" class="rounded-md border border-dashed border-border/60 px-3 py-3">
                    <p class="text-[11px] text-muted-foreground">
                        还没有账号。填好上面的 QQ 号后点「自动配置连接」会自动创建一个。
                    </p>
                </div>

                <div v-else class="flex flex-col gap-2">
                    <div
                        v-for="acc in accounts"
                        :key="acc.id"
                        class="rounded-md border border-border/60 px-3 py-2.5"
                    >
                        <div class="flex flex-wrap items-center gap-2">
                            <UiBadge
                                :tone="acc.connected ? 'success' : (acc.enabled ? 'secondary' : 'outline')"
                                dot
                                :pulse="acc.connected"
                            >
                                {{ acc.connected ? '在线' : (acc.enabled ? '离线' : '已停用') }}
                            </UiBadge>
                            <span class="font-mono text-[12px]">{{ acc.id }}</span>
                            <span class="text-[12px] text-muted-foreground">
                                {{ acc.name }}<template v-if="acc.uin"> · {{ acc.uin }}</template>
                                <template v-if="acc.selfId && acc.selfId !== acc.uin">
                                    ● 实际 {{ acc.selfId }}
                                </template>
                            </span>
                            <div class="flex-1" />
                            <UiButton size="sm" variant="ghost" @click="editAccount(acc)">
                                <Save class="size-3.5" />
                                编辑
                            </UiButton>
                            <UiButton
                                size="sm"
                                variant="ghost"
                                :disabled="accounts.length <= 1"
                                @click="removeAccount(acc.id)"
                            >
                                <Trash2 class="size-3.5" />
                            </UiButton>
                        </div>
                        <p class="mt-1 truncate font-mono text-[11px] text-muted-foreground/80">
                            {{ acc.url }}
                        </p>
                        <p v-if="acc.lastError" class="mt-0.5 truncate text-[11px] text-destructive">
                            {{ acc.lastError }}
                        </p>
                    </div>
                </div>

                <!-- 编辑 / 新增表单 -->
                <div v-if="editingAccount" class="mt-3 rounded-md border border-primary/30 bg-primary/5 px-3 py-3">
                    <div class="grid gap-3 sm:grid-cols-2">
                        <div>
                            <label class="text-xs font-medium text-muted-foreground">账号 id</label>
                            <UiInput v-model="editingAccount.id" class="mt-1.5" mono placeholder="qq_123456" />
                            <p class="mt-1 text-[10px] text-muted-foreground/70">
                                作为会话前缀，创建后不建议再改（改了等于断开它名下的会话）
                            </p>
                        </div>
                        <div>
                            <label class="text-xs font-medium text-muted-foreground">QQ 号</label>
                            <UiInput v-model="editingAccount.uin" class="mt-1.5" mono placeholder="可留空，连上后自动识别" />
                        </div>
                        <div>
                            <label class="text-xs font-medium text-muted-foreground">备注名</label>
                            <UiInput v-model="editingAccount.name" class="mt-1.5" placeholder="主号 / 测试号" />
                        </div>
                        <div>
                            <label class="text-xs font-medium text-muted-foreground">WebSocket 地址</label>
                            <UiInput v-model="editingAccount.url" class="mt-1.5" mono placeholder="ws://127.0.0.1:3001" />
                        </div>
                        <div class="sm:col-span-2">
                            <label class="text-xs font-medium text-muted-foreground">Access Token</label>
                            <UiInput v-model="editingAccount.token" class="mt-1.5" mono placeholder="留空 = 不鉴权" />
                        </div>
                    </div>

                    <div class="mt-3 flex flex-wrap items-center gap-2">
                        <UiButton size="sm" :disabled="savingAccount" @click="saveAccount">
                            <Save class="size-4" />
                            {{ savingAccount ? '保存中…' : '保存' }}
                        </UiButton>
                        <UiButton
                            variant="outline"
                            size="sm"
                            :disabled="loadingOnebot || !snowDir"
                            @click="fillAccountFromSnowLuma"
                        >
                            <Download class="size-4" />
                            {{ loadingOnebot ? '读取中…' : '从 SnowLuma 读取' }}
                        </UiButton>
                        <UiButton variant="ghost" size="sm" @click="editingAccount = null">
                            取消
                        </UiButton>
                    </div>
                </div>

                <p class="mt-3 flex items-start gap-1.5 text-xs text-muted-foreground">
                    <Info class="mt-0.5 size-3.5 shrink-0" />
                    「自动配置连接」会写入
                    <code class="mx-1 font-mono">config/onebot_&lt;QQ号&gt;.json</code>
                    的 wsServer，并为该号建立/复用对应账号，无需手动复制粘贴
                </p>
            </div>
        </UiCard>

        <!-- ================= QQ 进程自动注入 ================= -->
        <UiCard>
            <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-5 py-4">
                <div class="flex items-center gap-3">
                    <div class="flex size-10 items-center justify-center rounded-xl bg-aurora/15 text-aurora">
                        <Plug class="size-5" />
                    </div>
                    <div>
                        <h2 class="text-sm font-semibold tracking-tight">QQ 进程自动注入</h2>
                        <p class="text-xs text-muted-foreground">
                            让 SnowLuma 自动接管新出现的 QQ 进程，不必每次手动点注入
                        </p>
                    </div>
                </div>
                <UiBadge
                    :tone="hook?.hookAutoLoad ? 'success' : 'outline'"
                    dot
                    :pulse="hook?.hookAutoLoad === true"
                >
                    {{ hook?.hookAutoLoad ? '已开启' : '未开启' }}
                </UiBadge>
            </div>

            <!-- 未配置目录 -->
            <div v-if="hook && !hook.configured" class="px-5 py-4">
                <p class="text-xs text-muted-foreground">
                    请先在上方填写并保存 <strong class="text-foreground">SnowLuma 目录</strong>，
                    然后回到这里开启。
                </p>
            </div>

            <!-- 目录里找不到 runtime.json -->
            <div v-else-if="hook && hook.found === false" class="px-5 py-4">
                <p class="flex items-start gap-1.5 text-xs text-warning">
                    <AlertTriangle class="mt-0.5 size-3.5 shrink-0" />
                    {{ hook.error }}
                </p>
            </div>

            <template v-else-if="hook && hook.found">
                <div class="flex items-center justify-between px-5 py-3.5">
                    <div class="min-w-0">
                        <p class="text-sm">自动注入</p>
                        <p class="text-xs text-muted-foreground">
                            开启后 SnowLuma 发现 QQ 进程会自动注入；关闭则需在它自己的界面手动注入
                        </p>
                    </div>
                    <UiSwitch
                        :model-value="hook.hookAutoLoad === true"
                        :disabled="savingHook"
                        class="shrink-0"
                        @update:model-value="toggleHook"
                    />
                </div>

                <div class="grid gap-x-6 gap-y-2 border-t border-border/40 px-5 py-3.5 text-[11px] sm:grid-cols-2">
                    <div class="flex min-w-0 items-center gap-1.5 sm:col-span-2">
                        <span class="shrink-0 text-muted-foreground">配置文件</span>
                        <span class="truncate font-mono" :title="hook.runtimePath">{{ hook.runtimePath }}</span>
                    </div>
                    <div class="flex items-center gap-1.5">
                        <span class="text-muted-foreground">WebUI 端口</span>
                        <span class="font-mono">{{ hook.webuiPort }}</span>
                    </div>
                    <div class="flex items-center gap-1.5">
                        <span class="text-muted-foreground">查看注入状态</span>
                        <a
                            class="font-mono text-primary hover:underline"
                            :href="`http://127.0.0.1:${hook.webuiPort}`"
                            target="_blank"
                            rel="noopener"
                        >
                            打开 SnowLuma
                        </a>
                    </div>
                </div>

                <div
                    v-if="hookNeedsRestart"
                    class="border-t border-warning/40 bg-warning/5 px-5 py-2.5"
                >
                    <p class="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                        <AlertTriangle class="mt-0.5 size-3.5 shrink-0 text-warning" />
                        已写入配置，但<strong class="text-warning">需要重启 SnowLuma 才生效</strong>
                        （它只在启动时读这一项）。
                    </p>
                </div>

                <div class="border-t border-border/40 bg-info/5 px-5 py-2.5">
                    <p class="text-[11px] text-muted-foreground">
                        Bridge 只负责打开 SnowLuma 自带的开关，不自己注入进程：
                        注入需要与 QQ 版本匹配的原生模块，只有 SnowLuma 能做对。
                        写入前会备份为 <code class="font-mono">runtime.json.bak-snowluma-bridge</code>。
                    </p>
                </div>
            </template>
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
