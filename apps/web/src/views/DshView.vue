<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
    Terminal, RefreshCw, Play, CheckCircle2, AlertTriangle, Info, Power,
    Loader2, Save, Server, MessageSquare, Trash2, History, ShieldAlert,
    Plug, PlugZap, RotateCw, XCircle, FileText,
} from 'lucide-vue-next';
import UiCard from '@/components/ui/UiCard.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiBadge from '@/components/ui/UiBadge.vue';
import UiInput from '@/components/ui/UiInput.vue';
import UiSelect from '@/components/ui/UiSelect.vue';
import UiSwitch from '@/components/ui/UiSwitch.vue';
import { dshApi, type DshStatus } from '@/api/dsh';
import { useToastStore } from '@/stores/toast';

const toast = useToastStore();

const loading = ref(false);
const status = ref<DshStatus | null>(null);

// 配置
const exePath = ref('');
const profile = ref('headless');
const workRoot = ref('');
const timeoutMs = ref(180000);
const historyTurns = ref(6);
const systemPrompt = ref('');
const errorReply = ref('');
const persistHistory = ref(true);
const concurrency = ref(1);

// 常驻服务
const serviceProfile = ref('web');
const servicePort = ref(3080);
const serviceLogFile = ref('');
const working = ref('');
const pluginToken = ref('');
const pluginEnabled = ref(true);

const savingConfig = ref(false);

// 后端切换
const backend = ref<'taver' | 'dsh'>('taver');
const switching = ref(false);

// 测试
const testText = ref('只回复两个字：正常');
const testSession = ref('_test');
const testing = ref(false);
const testResult = ref<{ ok: boolean; text: string; elapsedMs: number; error?: string } | null>(null);

const clearing = ref('');

const installed = computed(() => status.value?.installed ?? false);
const usingDsh = computed(() => backend.value === 'dsh');
const sessions = computed(() => status.value?.sessions ?? []);
const contextFile = computed(() => status.value?.runtime?.historyFile ?? '');

/** 常驻服务 / 插件状态 */
const service = computed(() => status.value?.service ?? null);
const plugin = computed(() => status.value?.plugin ?? null);
const serviceRunning = computed(() => service.value?.running === true);
const pluginOnline = computed(() => plugin.value?.online === true);
const pluginInjected = computed(() => plugin.value?.injection?.inBundles === true);
const pluginNeedsRestart = computed(
    () => pluginInjected.value && plugin.value?.injection?.installed === true && !pluginOnline.value,
);

/** 可选 profile：优先用 profile 目录里真实存在的 */
const knownProfiles = computed(() => {
    const list = plugin.value?.profiles?.map((p) => p.profile) ?? [];
    const base = ['web', 'headless', 'desktop'];
    return [...new Set([...base, ...list])];
});

const profileOptions = computed(() => {
    const list = status.value?.profiles ?? [];
    const base = ['headless', 'web', 'desktop'];
    const all = [...new Set([...base, ...list])];
    return all.map((p) => ({ value: p, label: p }));
});

const serviceProfileOptions = computed(() =>
    knownProfiles.value.map((p) => ({ value: p, label: p })),
);

const injectProfile = ref('web');

async function load(opts: { silent?: boolean; fresh?: boolean } = {}) {
    loading.value = true;
    try {
        const s = await dshApi.status(opts.fresh === true);
        status.value = s;
        backend.value = s.backend;
        exePath.value = s.configuredExePath ?? '';
        profile.value = s.config.profile;
        workRoot.value = s.config.workRoot;
        timeoutMs.value = s.config.timeoutMs;
        historyTurns.value = s.config.historyTurns;
        systemPrompt.value = s.config.systemPrompt;
        errorReply.value = s.config.errorReply;
        persistHistory.value = s.config.persistHistory;
        concurrency.value = s.config.concurrency ?? 1;
        serviceProfile.value = s.config.serviceProfile ?? 'web';
        servicePort.value = s.config.servicePort ?? 3080;
        serviceLogFile.value = s.config.serviceLogFile ?? '';
        pluginToken.value = s.config.pluginToken ?? '';
        pluginEnabled.value = s.config.pluginEnabled !== false;
        injectProfile.value = s.plugin?.injection?.profile || serviceProfile.value || 'web';
        if (!opts.silent && !s.installed) {
            toast.warning('未找到 dsh', '请安装 @deepseek-ai/dsh，或手动填写可执行文件路径');
        }
    } catch (e) {
        if (!opts.silent) {
            toast.error('读取 dsh 状态失败', e instanceof Error ? e.message : String(e));
        }
    } finally {
        loading.value = false;
    }
}

async function saveConfig() {
    savingConfig.value = true;
    try {
        await dshApi.setConfig({
            exePath: exePath.value.trim(),
            profile: profile.value,
            workRoot: workRoot.value.trim(),
            timeoutMs: Number(timeoutMs.value),
            historyTurns: Number(historyTurns.value),
            systemPrompt: systemPrompt.value,
            errorReply: errorReply.value,
            persistHistory: persistHistory.value,
            concurrency: Number(concurrency.value),
            serviceProfile: serviceProfile.value,
            servicePort: Number(servicePort.value),
            serviceLogFile: serviceLogFile.value.trim(),
            pluginToken: pluginToken.value.trim(),
            pluginEnabled: pluginEnabled.value,
        });
        toast.success('已保存', 'dsh 配置已生效');
        await load({ silent: true });
    } catch (e) {
        toast.error('保存失败', e instanceof Error ? e.message : String(e));
    } finally {
        savingConfig.value = false;
    }
}

// ---------------- 常驻服务 ----------------
async function serviceAction(action: 'start' | 'stop' | 'restart') {
    working.value = `service:${action}`;
    try {
        const r = await dshApi.serviceAction(action);
        const label = action === 'start' ? '已启动' : action === 'stop' ? '已停止' : '已重启';
        if (r.ok) {
            toast.success(`服务${label}`, `${r.host}:${r.port}${r.pid ? ` · pid ${r.pid}` : ''}`);
        } else {
            toast.error(`服务${action === 'stop' ? '停止' : '启动'}失败`, r.error ?? r.result?.error ?? '未知错误');
        }
        await load({ silent: true });
    } catch (e) {
        toast.error('操作失败', e instanceof Error ? e.message : String(e));
        await load({ silent: true });
    } finally {
        working.value = '';
    }
}

// ---------------- 连接插件 ----------------
async function injectConnector() {
    working.value = 'inject';
    try {
        const r = await dshApi.pluginInject({
            profile: injectProfile.value,
            token: pluginToken.value.trim(),
            cwdRoot: workRoot.value.trim(),
            verify: true,
            restart: true,
        });
        if (!r.inject.ok) {
            toast.error('注入失败', r.inject.error || '未知错误');
            return;
        }
        const verified = r.verified;
        if (verified && !verified.ok) {
            toast.warning('已注入但校验未通过', verified.error);
        } else if (r.restart && !r.restart.ok) {
            toast.warning('已注入，重启失败', r.restart.error ?? '请手动点「重启服务」');
        } else {
            toast.success('连接插件已注入', `profile ${r.inject.injection.profile} · 服务已重启，等待插件上线`);
        }
        await load({ silent: true });
    } catch (e) {
        toast.error('注入失败', e instanceof Error ? e.message : String(e));
    } finally {
        working.value = '';
    }
}

async function removeConnector() {
    working.value = 'remove';
    try {
        const r = await dshApi.pluginRemove({ profile: injectProfile.value, restart: true });
        if (!r.remove.ok) {
            toast.error('移除失败', r.remove.error || '未知错误');
            return;
        }
        toast.success('连接插件已移除', `profile ${injectProfile.value}，已重启服务`);
        await load({ silent: true });
    } catch (e) {
        toast.error('移除失败', e instanceof Error ? e.message : String(e));
    } finally {
        working.value = '';
    }
}

async function restartForPlugin() {
    working.value = 'restart';
    try {
        const r = await dshApi.serviceAction('restart');
        if (r.ok) toast.success('服务已重启', '插件会在几秒内重新连上');
        else toast.error('重启失败', r.error ?? r.result?.error ?? '未知错误');
        await load({ silent: true });
    } catch (e) {
        toast.error('重启失败', e instanceof Error ? e.message : String(e));
    } finally {
        working.value = '';
    }
}

async function resetPluginSessions() {
    working.value = 'plugin-reset';
    try {
        const r = await dshApi.pluginReset({});
        toast.success('已请求插件释放会话', `共 ${r.sent} 个`);
        await load({ silent: true });
    } catch (e) {
        toast.error('操作失败', e instanceof Error ? e.message : String(e));
    } finally {
        working.value = '';
    }
}

async function switchBackend(next: 'taver' | 'dsh') {
    switching.value = true;
    try {
        const r = await dshApi.setBackend(next);
        backend.value = r.backend as 'taver' | 'dsh';
        toast.success(
            '后端已切换',
            next === 'dsh' ? 'QQ 消息将交给 dsh 处理' : 'QQ 消息将交给酒馆处理',
        );
        await load({ silent: true });
    } catch (e) {
        toast.error('切换失败', e instanceof Error ? e.message : String(e));
        await load({ silent: true });
    } finally {
        switching.value = false;
    }
}

async function runTest() {
    testing.value = true;
    testResult.value = null;
    try {
        const r = await dshApi.test({
            text: testText.value.trim(),
            sessionKey: testSession.value.trim() || '_test',
        });
        testResult.value = r;
        if (r.ok) {
            toast.success('调用成功', `耗时 ${(r.elapsedMs / 1000).toFixed(1)}s`);
        } else {
            toast.error('调用失败', r.error ?? '未知错误');
        }
        await load({ silent: true });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        testResult.value = { ok: false, text: '', elapsedMs: 0, error: msg };
        toast.error('调用失败', msg);
    } finally {
        testing.value = false;
    }
}

async function resetTestSession() {
    clearing.value = 'test';
    try {
        await dshApi.reset({ sessionKey: testSession.value.trim() || '_test' });
        toast.success('已清空测试上下文', testSession.value);
        await load({ silent: true });
    } catch (e) {
        toast.error('清空失败', e instanceof Error ? e.message : String(e));
    } finally {
        clearing.value = '';
    }
}

async function clearSession(sessionKey: string) {
    clearing.value = sessionKey;
    try {
        const r = await dshApi.reset({ sessionKey, removeWorkDir: true });
        toast.success('已清空上下文', `${sessionKey}${r.existed ? '' : '（原本为空）'}`);
        await load({ silent: true });
    } catch (e) {
        toast.error('清空失败', e instanceof Error ? e.message : String(e));
    } finally {
        clearing.value = '';
    }
}

async function clearAll() {
    clearing.value = '__all__';
    try {
        const r = await dshApi.reset({ all: true });
        toast.success('已清空全部上下文', `共 ${r.cleared ?? 0} 个会话`);
        await load({ silent: true });
    } catch (e) {
        toast.error('清空失败', e instanceof Error ? e.message : String(e));
    } finally {
        clearing.value = '';
    }
}

onMounted(() => void load({ silent: true }));
</script>

<template>
    <div class="flex flex-col gap-5">
        <!-- 后端切换 -->
        <UiCard>
            <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-5 py-4">
                <div class="flex items-center gap-3">
                    <div class="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                        <Server class="size-5" />
                    </div>
                    <div>
                        <h2 class="text-sm font-semibold tracking-tight">全局默认后端</h2>
                        <p class="text-xs text-muted-foreground">
                            全局默认：QQ 消息交给谁处理（单个会话可在「会话」页单独覆盖）
                        </p>
                    </div>
                </div>
                <UiBadge :tone="usingDsh ? 'info' : 'success'" dot>
                    {{ usingDsh ? 'dsh' : '酒馆' }}
                </UiBadge>
            </div>

            <div class="grid gap-3 px-5 py-4 sm:grid-cols-2">
                <button
                    class="flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors"
                    :class="!usingDsh
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:bg-accent/30'"
                    :disabled="switching"
                    @click="switchBackend('taver')"
                >
                    <div class="flex items-center gap-2">
                        <span class="text-sm font-medium">酒馆 SillyTavern</span>
                        <CheckCircle2 v-if="!usingDsh" class="size-3.5 text-primary" />
                    </div>
                    <span class="text-[11px] text-muted-foreground">
                        走角色卡 + 世界书，有长期记忆，适合角色扮演
                    </span>
                </button>

                <button
                    class="flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors"
                    :class="usingDsh
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:bg-accent/30'"
                    :disabled="switching || !installed"
                    @click="switchBackend('dsh')"
                >
                    <div class="flex items-center gap-2">
                        <span class="text-sm font-medium">dsh DeepSeek Harness</span>
                        <CheckCircle2 v-if="usingDsh" class="size-3.5 text-primary" />
                        <UiBadge v-if="!installed" tone="warning" class="text-micro">未安装</UiBadge>
                    </div>
                    <span class="text-[11px] text-muted-foreground">
                        直连本机 dsh，无角色卡，适合任务与工具调用
                    </span>
                </button>
            </div>

            <div v-if="usingDsh" class="border-t border-border/40 bg-info/5 px-5 py-2.5">
                <p class="text-[11px] text-muted-foreground">
                    这里是<b>全局默认后端</b>：未单独设置后端的会话都会走 dsh。
                    如需让某个 QQ 会话继续走酒馆角色对话，到「会话」页把它的「回复后端」改为「酒馆」即可。
                    触发规则（群聊仅 @、私聊开关、用户/群白名单）、回复处理管道、表情包解析与分段规则两条链路一致。
                </p>
            </div>
        </UiCard>

        <!-- ============ dsh 常驻服务 ============ -->
        <UiCard>
            <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-5 py-3.5">
                <div class="flex items-center gap-2">
                    <Power class="size-4 text-muted-foreground" />
                    <h3 class="text-sm font-semibold tracking-tight">dsh 常驻服务</h3>
                    <UiBadge :tone="serviceRunning ? 'success' : 'outline'" dot class="text-micro">
                        {{ serviceRunning ? '运行中' : '未运行' }}
                    </UiBadge>
                </div>
                <div class="flex flex-wrap items-center gap-2">
                    <UiButton
                        variant="outline"
                        size="sm"
                        :disabled="working !== '' || !installed"
                        @click="serviceAction(serviceRunning ? 'stop' : 'start')"
                    >
                        <Loader2 v-if="working.startsWith('service:')" class="size-3.5 animate-spin" />
                        <Power v-else class="size-3.5" />
                        {{ serviceRunning ? '停止' : '启动' }}
                    </UiButton>
                    <UiButton
                        variant="outline"
                        size="sm"
                        :disabled="working !== '' || !installed"
                        @click="serviceAction('restart')"
                    >
                        <Loader2 v-if="working === 'service:restart'" class="size-3.5 animate-spin" />
                        <RotateCw v-else class="size-3.5" />
                        重启
                    </UiButton>
                    <UiButton variant="ghost" size="sm" :disabled="loading" @click="load({ silent: true })">
                        <RefreshCw class="size-3.5" :class="loading ? 'animate-spin' : ''" />
                    </UiButton>
                </div>
            </div>

            <div class="grid gap-x-6 gap-y-2 px-5 py-3.5 text-[11px] sm:grid-cols-2">
                <div class="flex min-w-0 items-center gap-1.5 sm:col-span-2">
                    <span class="shrink-0 text-muted-foreground">地址</span>
                    <span class="truncate font-mono">{{ service?.url || '—' }}</span>
                    <UiBadge v-if="service?.pid" tone="outline" class="text-micro">pid {{ service.pid }}</UiBadge>
                </div>
                <div class="flex items-center gap-1.5">
                    <span class="text-muted-foreground">profile</span>
                    <span class="font-mono">{{ service?.profile || '—' }}</span>
                </div>
                <div class="flex min-w-0 items-center gap-1.5">
                    <span class="shrink-0 text-muted-foreground">日志</span>
                    <span class="truncate font-mono" :title="service?.logFile">{{ service?.logFile || '—' }}</span>
                </div>
            </div>

            <div v-if="service?.lastError" class="border-t border-destructive/30 bg-destructive/5 px-5 py-2">
                <p class="flex items-start gap-1.5 text-[11px] text-destructive">
                    <XCircle class="mt-0.5 size-3.5 shrink-0" />
                    {{ service.lastError }}
                </p>
            </div>

            <div class="border-t border-border/40 px-5 py-3">
                <p class="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <FileText class="size-3.5" />
                    日志尾部
                    <span class="text-muted-foreground/60">（{{ (service?.logTail ?? []).length }} 行）</span>
                </p>
                <pre
                    v-if="(service?.logTail ?? []).length"
                    class="max-h-40 overflow-auto rounded-md bg-muted/40 px-3 py-2 font-mono text-[10px] leading-relaxed text-muted-foreground"
                >{{ (service?.logTail ?? []).join('\n') }}</pre>
                <p v-else class="text-[11px] text-muted-foreground/70">暂无日志（服务未启动或日志文件为空）</p>
            </div>

            <div class="border-t border-border/40 bg-info/5 px-5 py-2.5">
                <p class="text-[11px] text-muted-foreground">
                    服务以<b>分离进程</b>启动：Bridge 退出或重启都不会带走它，下次通过端口与 PID 自动接管。
                </p>
            </div>
        </UiCard>

        <!-- ============ 连接插件注入 ============ -->
        <UiCard>
            <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-5 py-3.5">
                <div class="flex items-center gap-2">
                    <component :is="pluginOnline ? PlugZap : Plug" class="size-4 text-muted-foreground" />
                    <h3 class="text-sm font-semibold tracking-tight">连接插件</h3>
                    <UiBadge :tone="pluginOnline ? 'success' : pluginInjected ? 'warning' : 'outline'" dot class="text-micro">
                        {{ pluginOnline ? '已连接' : pluginInjected ? '已注入·待重启' : '未注入' }}
                    </UiBadge>
                </div>
                <div class="flex flex-wrap items-center gap-2">
                    <UiButton
                        size="sm"
                        :disabled="working !== '' || !installed"
                        @click="injectConnector"
                    >
                        <Loader2 v-if="working === 'inject'" class="size-3.5 animate-spin" />
                        <PlugZap v-else class="size-3.5" />
                        {{ pluginInjected ? '重新注入' : '注入并重启' }}
                    </UiButton>
                    <UiButton
                        v-if="pluginNeedsRestart && !pluginOnline"
                        variant="outline"
                        size="sm"
                        :disabled="working !== ''"
                        @click="restartForPlugin"
                    >
                        <Loader2 v-if="working === 'restart'" class="size-3.5 animate-spin" />
                        <RotateCw v-else class="size-3.5" />
                        重启服务
                    </UiButton>
                    <UiButton
                        v-if="pluginInjected"
                        variant="outline"
                        size="sm"
                        :disabled="working !== ''"
                        @click="removeConnector"
                    >
                        <Loader2 v-if="working === 'remove'" class="size-3.5 animate-spin" />
                        <Trash2 v-else class="size-3.5" />
                        移除
                    </UiButton>
                </div>
            </div>

            <div class="grid gap-4 px-5 py-4 lg:grid-cols-2">
                <div class="flex flex-col gap-1.5">
                    <label class="text-xs font-medium">注入到 profile</label>
                    <UiSelect v-model="injectProfile" :options="serviceProfileOptions" />
                    <p class="text-[11px] text-muted-foreground">
                        插件会写进该 profile 的 <code class="font-mono">dsh.profile.bundles</code>，重启后生效
                    </p>
                </div>

                <div class="flex flex-col gap-1.5">
                    <label class="text-xs font-medium">连接地址</label>
                    <UiInput :model-value="plugin?.url ?? ''" mono disabled />
                    <p class="text-[11px] text-muted-foreground">
                        插件从 dsh 进程内连回 Bridge 的扩展端口，跟随上面的扩展端口配置
                    </p>
                </div>

                <div class="flex flex-col gap-1.5">
                    <label class="text-xs font-medium">握手 token</label>
                    <UiInput v-model="pluginToken" mono placeholder="留空 = 不校验" />
                    <p class="text-[11px] text-muted-foreground">
                        仅本机回环连接，一般不需要；多实例共用端口时可用于区分
                    </p>
                </div>

                <div class="flex items-center justify-between gap-4 rounded-lg border border-border/60 px-3 py-2.5">
                    <div class="min-w-0">
                        <p class="text-xs font-medium">优先走插件链路</p>
                        <p class="text-[11px] text-muted-foreground">
                            插件在线时不再为每条消息起 headless 子进程
                        </p>
                    </div>
                    <UiSwitch v-model="pluginEnabled" class="shrink-0" />
                </div>

                <div class="rounded-lg border border-border/60 px-3 py-2.5 lg:col-span-2">
                    <div class="grid gap-x-6 gap-y-1.5 text-[11px] sm:grid-cols-2">
                        <div class="flex items-center gap-1.5">
                            <span class="text-muted-foreground">插件包</span>
                            <span class="truncate font-mono">{{ plugin?.pluginName || '—' }}</span>
                        </div>
                        <div class="flex items-center gap-1.5">
                            <span class="text-muted-foreground">已放置</span>
                            <span :class="plugin?.injection?.installed ? 'text-success' : 'text-warning'">
                                {{ plugin?.injection?.installed ? `已放置 v${plugin.injection.version}` : '未放置' }}
                            </span>
                        </div>
                        <div class="flex min-w-0 items-center gap-1.5">
                            <span class="shrink-0 text-muted-foreground">bundles</span>
                            <span :class="pluginInjected ? 'text-success' : 'text-warning'">
                                {{ pluginInjected ? '已登记' : '未登记' }}
                            </span>
                        </div>
                        <div class="flex items-center gap-1.5">
                            <span class="text-muted-foreground">配置行</span>
                            <span :class="plugin?.injection?.hasPatchRow ? 'text-success' : 'text-warning'">
                                {{ plugin?.injection?.hasPatchRow ? '已写入 cordis.patch.yml' : '未写入' }}
                            </span>
                        </div>
                        <div class="flex min-w-0 items-center gap-1.5 sm:col-span-2">
                            <span class="shrink-0 text-muted-foreground">插件目录</span>
                            <span class="truncate font-mono">{{ plugin?.targetDir || '—' }}</span>
                        </div>
                        <div v-if="plugin?.clients?.length" class="flex min-w-0 items-center gap-1.5 sm:col-span-2">
                            <span class="shrink-0 text-muted-foreground">在线连接</span>
                            <span class="truncate font-mono">
                                {{ plugin.clients.map((c) => `pid ${c.pid}${c.profile ? `/${c.profile}` : ''}`).join('、') }}
                            </span>
                        </div>
                    </div>
                </div>

                <div class="flex flex-wrap items-center gap-2 lg:col-span-2">
                    <UiButton
                        variant="ghost"
                        size="sm"
                        :disabled="working !== '' || !pluginOnline"
                        @click="resetPluginSessions"
                    >
                        <Loader2 v-if="working === 'plugin-reset'" class="size-3.5 animate-spin" />
                        <History v-else class="size-3.5" />
                        让插件释放全部会话
                    </UiButton>
                    <span class="text-[11px] text-muted-foreground">
                        插件链路下上下文由 dsh 自己的 session 承载，释放后从新会话开始
                    </span>
                </div>
            </div>

            <div class="border-t border-border/40 bg-info/5 px-5 py-2.5">
                <p class="text-[11px] text-muted-foreground">
                    插件装进 profile 后由 dsh 主动连回 Bridge，QQ 消息直接进入 dsh 的原生 Agent：
                    无进程启动开销，且能复用 web profile 的模型选择、MCP、工具与技能。
                    插件离线时自动回落到 headless 子进程，行为不变。
                </p>
            </div>
        </UiCard>

        <!-- 探测状态 -->
        <UiCard>
            <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-5 py-3.5">
                <div class="flex items-center gap-2">
                    <Terminal class="size-4 text-muted-foreground" />
                    <h3 class="text-sm font-semibold tracking-tight">dsh 环境</h3>
                </div>
                <UiButton variant="outline" size="sm" :disabled="loading" @click="load({ fresh: true })">
                    <RefreshCw class="size-3.5" :class="loading ? 'animate-spin' : ''" />
                    重新探测
                </UiButton>
            </div>

            <div class="grid gap-x-6 gap-y-2 px-5 py-3.5 text-[11px] sm:grid-cols-2">
                <div class="flex items-center gap-1.5">
                    <span class="text-muted-foreground">状态</span>
                    <span :class="installed ? 'text-success' : 'text-warning'">
                        {{ installed ? '已安装' : '未找到' }}
                    </span>
                </div>
                <div class="flex items-center gap-1.5">
                    <span class="text-muted-foreground">版本</span>
                    <span class="font-mono">{{ status?.version || '—' }}</span>
                </div>
                <div class="flex min-w-0 items-center gap-1.5 sm:col-span-2">
                    <span class="shrink-0 text-muted-foreground">可执行文件</span>
                    <span class="truncate font-mono" :title="status?.exePath">
                        {{ status?.exePath || '—' }}
                    </span>
                    <UiBadge v-if="status?.source" tone="outline" class="text-micro">
                        {{ status.source === 'config' ? '手动填写' : status.source }}
                    </UiBadge>
                </div>
                <div
                    v-if="status?.runtime?.configuredMissing"
                    class="flex items-center gap-1.5 rounded-md border border-warning/40 bg-warning/5 px-2 py-1 sm:col-span-2"
                >
                    <AlertTriangle class="size-3 shrink-0 text-warning" />
                    <span class="text-warning">
                        填写的路径不存在，当前已回落到自动探测结果
                    </span>
                </div>
                <div class="flex min-w-0 items-center gap-1.5 sm:col-span-2">
                    <span class="shrink-0 text-muted-foreground">DSH_HOME</span>
                    <span class="truncate font-mono">{{ status?.home || '—' }}</span>
                </div>
                <div class="flex min-w-0 items-center gap-1.5 sm:col-span-2">
                    <span class="shrink-0 text-muted-foreground">可用 profile</span>
                    <span class="font-mono">{{ (status?.profiles ?? []).join(', ') || '—' }}</span>
                </div>
                <div class="flex min-w-0 items-center gap-1.5 sm:col-span-2">
                    <span class="shrink-0 text-muted-foreground">上下文文件</span>
                    <span class="truncate font-mono" :title="contextFile">
                        {{ contextFile || '（仅内存，不落盘）' }}
                    </span>
                </div>
            </div>
        </UiCard>

        <!-- 配置 -->
        <UiCard>
            <div class="flex items-center gap-2 border-b border-border/60 px-5 py-3.5">
                <Save class="size-4 text-muted-foreground" />
                <h3 class="text-sm font-semibold tracking-tight">调用参数</h3>
                <span class="text-[11px] text-muted-foreground">保存后立即生效</span>
            </div>

            <div class="grid gap-4 px-5 py-4 lg:grid-cols-2">
                <div class="flex flex-col gap-1.5">
                    <label class="text-xs font-medium">可执行文件路径</label>
                    <UiInput v-model="exePath" mono placeholder="留空自动探测" />
                    <p class="text-[11px] text-muted-foreground">
                        留空时自动从 PATH 与 npm 全局目录查找
                    </p>
                </div>

                <div class="flex flex-col gap-1.5">
                    <label class="text-xs font-medium">Profile</label>
                    <UiSelect v-model="profile" :options="profileOptions" />
                    <p class="text-[11px] text-muted-foreground">
                        headless 一次性问答，最适合消息往返
                    </p>
                </div>

                <div class="flex flex-col gap-1.5">
                    <label class="text-xs font-medium">工作目录根</label>
                    <UiInput v-model="workRoot" mono placeholder="留空使用系统临时目录" />
                    <p class="text-[11px] text-muted-foreground">
                        每个 QQ 会话在下面分独立子目录，用于隔离上下文（插件链路同样使用）
                    </p>
                </div>

                <div class="flex flex-col gap-1.5">
                    <label class="text-xs font-medium">超时（毫秒）</label>
                    <UiInput v-model.number="timeoutMs" type="number" mono />
                </div>

                <div class="flex flex-col gap-1.5">
                    <label class="text-xs font-medium">常驻服务 profile</label>
                    <UiSelect v-model="serviceProfile" :options="serviceProfileOptions" />
                    <p class="text-[11px] text-muted-foreground">
                        「启动 / 重启服务」与插件注入都用这个 profile
                    </p>
                </div>

                <div class="flex flex-col gap-1.5">
                    <label class="text-xs font-medium">常驻服务端口</label>
                    <UiInput v-model.number="servicePort" type="number" mono />
                    <p class="text-[11px] text-muted-foreground">
                        dsh web 服务监听端口（默认 3080）
                    </p>
                </div>

                <div class="flex flex-col gap-1.5 lg:col-span-2">
                    <label class="text-xs font-medium">服务日志路径</label>
                    <UiInput v-model="serviceLogFile" mono placeholder="留空写到系统临时目录" />
                </div>

                <div class="flex flex-col gap-1.5">
                    <label class="text-xs font-medium">保留上下文轮数</label>
                    <UiInput v-model.number="historyTurns" type="number" mono />
                    <p class="text-[11px] text-muted-foreground">
                        headless 不记忆会话，由 Bridge 自行维护并拼进 prompt；0 = 不带上下文
                    </p>
                </div>

                <div class="flex flex-col gap-1.5">
                    <label class="text-xs font-medium">调用失败提示</label>
                    <UiInput v-model="errorReply" placeholder="留空 = 只写日志，不回复" />
                    <p class="text-[11px] text-muted-foreground">
                        超时 / 未安装等失败场景下回给 QQ 的一句话
                    </p>
                </div>

                <div class="flex flex-col gap-1.5">
                    <label class="text-xs font-medium">并发上限</label>
                    <UiInput v-model.number="concurrency" type="number" mono />
                    <p class="text-[11px] text-muted-foreground">
                        每次调用都会起一个 dsh 进程，多人同时发消息时按此排队（1–8）
                        <span v-if="status?.load">
                            · 当前运行 {{ status.load.running }} / 排队 {{ status.load.waiting }}
                        </span>
                    </p>
                </div>

                <div class="flex flex-col gap-1.5 lg:col-span-2">
                    <label class="text-xs font-medium">补充设定（人设 / 规则）</label>
                    <textarea
                        v-model="systemPrompt"
                        rows="4"
                        class="w-full rounded-md border border-border bg-transparent px-3 py-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
                        placeholder="例如：你叫小鲸鱼，说话简短活泼；不确定的事情直接说不确定，不要编造。"
                    />
                    <p class="text-[11px] text-muted-foreground">
                        会拼在内置的 QQ 聊天约束与表情包提示之后，作为 system 设定传给 dsh
                    </p>
                </div>

                <div class="flex items-center justify-between gap-4 rounded-lg border border-border/60 px-3 py-2.5 lg:col-span-2">
                    <div class="min-w-0">
                        <p class="text-xs font-medium">上下文落盘</p>
                        <p class="text-[11px] text-muted-foreground">
                            开启后重启 Bridge 仍能续聊；关闭则只保存在内存
                        </p>
                    </div>
                    <UiSwitch v-model="persistHistory" class="shrink-0" />
                </div>

                <div class="flex items-end lg:col-span-2">
                    <UiButton size="sm" :disabled="savingConfig" @click="saveConfig">
                        <Save class="size-3.5" />
                        {{ savingConfig ? '保存中…' : '保存参数' }}
                    </UiButton>
                </div>
            </div>
        </UiCard>

        <!-- 会话上下文 -->
        <UiCard>
            <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-5 py-3.5">
                <div class="flex items-center gap-2">
                    <History class="size-4 text-muted-foreground" />
                    <h3 class="text-sm font-semibold tracking-tight">会话上下文</h3>
                    <UiBadge tone="outline" class="text-micro">{{ sessions.length }} 个</UiBadge>
                </div>
                <div class="flex items-center gap-2">
                    <UiButton variant="ghost" size="sm" :disabled="loading" @click="load({ silent: true })">
                        <RefreshCw class="size-3.5" :class="loading ? 'animate-spin' : ''" />
                        刷新
                    </UiButton>
                    <UiButton
                        variant="outline"
                        size="sm"
                        :disabled="clearing !== '' || sessions.length === 0"
                        @click="clearAll"
                    >
                        <Loader2 v-if="clearing === '__all__'" class="size-3.5 animate-spin" />
                        <Trash2 v-else class="size-3.5" />
                        清空全部
                    </UiButton>
                </div>
            </div>

            <div v-if="sessions.length === 0" class="px-5 py-5 text-center text-xs text-muted-foreground">
                还没有会话上下文。切到 dsh 并发一条 QQ 消息后，这里会出现记录。
            </div>

            <div v-else class="divide-y divide-border/40">
                <div
                    v-for="s in sessions"
                    :key="s.sessionKey"
                    class="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5"
                >
                    <div class="min-w-0">
                        <p class="truncate font-mono text-xs">{{ s.sessionKey }}</p>
                        <p class="text-[11px] text-muted-foreground">
                            {{ s.turns }} 轮 / {{ s.messages }} 条
                            <span v-if="s.updatedAt"> · {{ new Date(s.updatedAt).toLocaleString() }}</span>
                        </p>
                    </div>
                    <UiButton
                        variant="ghost"
                        size="sm"
                        :disabled="clearing !== ''"
                        @click="clearSession(s.sessionKey)"
                    >
                        <Loader2 v-if="clearing === s.sessionKey" class="size-3.5 animate-spin" />
                        <Trash2 v-else class="size-3.5" />
                        清空
                    </UiButton>
                </div>
            </div>
        </UiCard>

        <!-- 连通性测试 -->
        <UiCard>
            <div class="flex items-center gap-2 border-b border-border/60 px-5 py-3.5">
                <MessageSquare class="size-4 text-muted-foreground" />
                <h3 class="text-sm font-semibold tracking-tight">连通性测试</h3>
                <span class="text-[11px] text-muted-foreground">直接调用 dsh，不影响真实 QQ 会话</span>
            </div>

            <div class="flex flex-col gap-3 px-5 py-4">
                <div class="flex flex-wrap items-center gap-2">
                    <UiInput
                        v-model="testText"
                        placeholder="要问 dsh 的内容"
                        class="min-w-64 flex-1"
                        @keyup.enter="runTest"
                    />
                    <UiButton size="sm" :disabled="testing || !installed" @click="runTest">
                        <Loader2 v-if="testing" class="size-3.5 animate-spin" />
                        <Play v-else class="size-3.5" />
                        {{ testing ? '调用中…' : '发送' }}
                    </UiButton>
                </div>

                <div class="flex flex-wrap items-center gap-2">
                    <span class="text-[11px] text-muted-foreground">测试会话</span>
                    <UiInput v-model="testSession" mono class="max-w-48" />
                    <UiButton
                        variant="ghost"
                        size="sm"
                        :disabled="clearing === 'test'"
                        @click="resetTestSession"
                    >
                        <Loader2 v-if="clearing === 'test'" class="size-3.5 animate-spin" />
                        <Trash2 v-else class="size-3.5" />
                        清空测试上下文
                    </UiButton>
                </div>

                <div
                    v-if="testResult"
                    class="rounded-lg border px-3 py-2.5"
                    :class="testResult.ok ? 'border-success/40 bg-success/5' : 'border-destructive/40 bg-destructive/5'"
                >
                    <div class="mb-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                        <component
                            :is="testResult.ok ? CheckCircle2 : AlertTriangle"
                            class="size-3"
                            :class="testResult.ok ? 'text-success' : 'text-destructive'"
                        />
                        <span v-if="testResult.ok">耗时 {{ (testResult.elapsedMs / 1000).toFixed(1) }}s</span>
                        <span v-else>{{ testResult.error }}</span>
                    </div>
                    <p
                        v-if="testResult.text"
                        class="whitespace-pre-wrap break-words text-xs leading-relaxed"
                    >
                        {{ testResult.text }}
                    </p>
                </div>
            </div>
        </UiCard>

        <!-- 说明 -->
        <UiCard class="border-info/30 bg-info/5">
            <div class="flex items-start gap-3 px-5 py-4">
                <Info class="mt-0.5 size-4 shrink-0 text-info" />
                <div class="min-w-0 text-xs leading-relaxed text-muted-foreground">
                    <p class="font-medium text-foreground">关于 dsh 接入</p>
                    <ul class="mt-1.5 flex flex-col gap-1">
                        <li>• 只调用已安装的 dsh，不负责安装（<code class="font-mono">npm i -g @deepseek-ai/dsh</code>）</li>
                        <li>• 使用 <code class="font-mono">headless</code> profile：一次问答、打印结果、退出，无需常驻端口</li>
                        <li>• 每个 QQ 会话分配独立工作目录，上下文互不干扰，并可落盘续聊</li>
                        <li>• 群聊仅在 @ 机器人时触发、私聊开关与白名单，与酒馆共用同一套触发规则</li>
                        <li>• 回复会经过与酒馆相同的处理管道、分段与表情包解析</li>
                    </ul>
                    <div class="mt-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2">
                        <ShieldAlert class="mt-0.5 size-3.5 shrink-0 text-warning" />
                        <p class="text-[11px] text-muted-foreground">
                            dsh 具备本机文件与命令能力。请只在受信任的私聊 / 群聊启用，
                            并给工作目录根设置一个专用目录。
                        </p>
                    </div>
                </div>
            </div>
        </UiCard>
    </div>
</template>
