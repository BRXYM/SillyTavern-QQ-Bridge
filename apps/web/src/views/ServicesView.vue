<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, request, type AccountConfigDto } from '@/api/client';
import { useStatusStore } from '@/stores/status';
import UiCard from '@/components/ui/UiCard.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiInput from '@/components/ui/UiInput.vue';
const store = useStatusStore();
const dir = ref('');
const port = ref(5099);
const busy = ref(false);
const error = ref('');
const notice = ref('');
const inspected = ref<{ accounts: Array<{ uin: string; endpoint: string; injection: string }>; hook: { known: boolean; reason: string; processes: Array<{ pid: number; uin: string; injected: boolean }> } } | null>(null);
const checkedAt = ref('');
const accounts = ref<Awaited<ReturnType<typeof api.accounts>>['accounts']>([]);
const editing = ref<AccountConfigDto | null>(null);
const editingExisting = ref(false);
const live = (id: string) => store.status?.accounts?.find(a => a.id === id);
const unassigned = computed(() => inspected.value?.hook.processes.filter(p => !p.uin && !p.injected) ?? []);
const webui = computed(() => `http://127.0.0.1:${Number.isInteger(port.value) && port.value > 0 && port.value <= 65535 ? port.value : 5099}`);
async function loadAccounts() { accounts.value = (await api.accounts()).accounts; await store.refresh(); }
async function inspect() {
    busy.value = true; error.value = ''; notice.value = ''; inspected.value = null;
    try {
        if (!dir.value.trim()) {
            const found = await api.discoverSnowLuma();
            if (!found.found) throw new Error('未找到 SnowLuma，请填写安装目录后重试，或直接添加 OneBot 连接。');
            dir.value = found.candidates.find(c => c.ok)?.dir || found.dir;
        }
        inspected.value = await request(`/snowluma/connection?dir=${encodeURIComponent(dir.value.trim())}&port=${port.value}`);
        checkedAt.value = new Date().toLocaleTimeString();
        await loadAccounts();
    } catch (e) { error.value = e instanceof Error ? e.message : String(e); }
    finally { busy.value = false; }
}
onMounted(async () => {
    try {
        await loadAccounts();
        const settings = store.status?.config.snowluma as { dir?: string; webuiPort?: number } | undefined;
        dir.value = settings?.dir ?? ''; port.value = settings?.webuiPort ?? 5099;
        await inspect();
    } catch (e) { error.value = String(e); }
});
async function connect(uin: string) {
    busy.value = true; error.value = ''; notice.value = '';
    try {
        await request('/snowluma/connect', { method: 'POST', body: JSON.stringify({ dir: dir.value, port: port.value, uin }) });
        await loadAccounts(); notice.value = '已发起连接，等待 OneBot 握手。请以账号的实时连接状态为准。';
    } catch (e) { error.value = e instanceof Error ? e.message : String(e); }
    finally { busy.value = false; }
}
function newAccount() {
    editingExisting.value = false;
    let n = 1; while (accounts.value.some(a => a.id === `account_${n}`)) n++;
    editing.value = { id: `account_${n}`, name: '', uin: '', enabled: true, upstream: { url: 'ws://127.0.0.1:3001', token: '', reconnectMs: 5000, actionTimeoutMs: 15000 } };
}
function edit(a: AccountConfigDto) { editingExisting.value = true; editing.value = JSON.parse(JSON.stringify({ id: a.id, name: a.name, uin: a.uin, enabled: a.enabled, upstream: a.upstream })); }
async function save() {
    if (!editing.value) return;
    busy.value = true; error.value = ''; notice.value = '';
    try { if (!editingExisting.value && accounts.value.some(a => a.id === editing.value!.id)) throw new Error('连接 ID 已存在，请更换'); await api.saveAccount(editing.value); editing.value = null; await loadAccounts(); notice.value = '连接参数已保存；启用的账号将尝试连接。'; }
    catch (e) { error.value = String(e); }
    finally { busy.value = false; }
}
async function action(a: AccountConfigDto, connectNow: boolean) {
    busy.value = true; error.value = ''; notice.value = '';
    try {
        if (connectNow) await request(`/accounts/${encodeURIComponent(a.id)}/connect`, { method: 'POST', body: '{}' });
        else await api.saveAccount({ ...a, enabled: false });
        await loadAccounts(); notice.value = connectNow ? '已发起连接，请查看实时状态。' : '已断开并停用自动重连。';
    } catch (e) { error.value = String(e); }
    finally { busy.value = false; }
}
</script>
<template>
    <div class="flex flex-col gap-5">
        <UiCard class="space-y-4 p-5 sm:p-6">
            <h2 class="text-lg font-semibold">连接 SnowLuma 中的 QQ</h2>
            <p class="text-sm leading-6 text-muted-foreground">读取 SnowLuma 已有的 OneBot 连接，选择账号接入。QQ 需要先在 SnowLuma 中完成手动注入，并启用 OneBot WebSocket 服务。</p>
            <div class="grid gap-3 md:grid-cols-[1fr_150px_auto]"><label class="space-y-2 text-xs">SnowLuma 安装目录<UiInput v-model="dir" :disabled="busy" placeholder="留空自动查找" /></label><label class="space-y-2 text-xs">WebUI 端口<UiInput v-model.number="port" :disabled="busy" type="number" /></label><UiButton class="self-end" :disabled="busy" @click="inspect">{{ busy ? '处理中…' : '检测 / 刷新' }}</UiButton></div>
            <p v-if="checkedAt" class="text-xs text-muted-foreground">检测时间 {{ checkedAt }}。注入状态为检测时的快照；账号连接状态实时更新。</p>
            <p v-if="inspected && !inspected.hook.known" class="rounded-lg bg-warning/10 p-3 text-xs text-warning">已读取 SnowLuma；暂时无法确认 QQ 注入状态。{{ inspected.hook.reason }}。</p>
            <p v-if="unassigned.length" role="alert" class="rounded-lg bg-warning/10 p-3 text-sm text-warning">检测到 QQ 进程尚未注入（PID {{ unassigned.map(p => p.pid).join('、') }}），但尚无法对应到账号。请在 SnowLuma 中手动注入后刷新。</p>
            <div v-for="a in inspected?.accounts ?? []" :key="a.uin" class="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border p-4"><div class="min-w-0"><h3 class="text-sm font-medium">QQ {{ a.uin }}</h3><p class="mt-1 break-all text-xs text-muted-foreground">{{ a.endpoint || '未发现启用的 OneBot WebSocket 端点，请先在 SnowLuma 中配置' }}</p><p v-if="a.injection === 'not-injected'" role="alert" class="mt-2 text-sm text-warning">QQ 尚未注入，请先在 SnowLuma 中手动注入。</p><p v-else class="mt-2 text-xs text-muted-foreground">{{ a.injection === 'injected' ? '已检测到注入' : '已读取账号记录，当前注入状态未知' }}</p></div><UiButton size="sm" :disabled="busy || !a.endpoint" @click="connect(a.uin)">连接此 QQ</UiButton></div>
            <p v-if="inspected && !inspected.accounts.length" class="text-sm text-muted-foreground">已找到 SnowLuma，尚未读取到账号记录。请先在 QQ 登录并在 SnowLuma 中确认账号。</p>
            <a :href="webui" target="_blank" rel="noreferrer" class="inline-block text-xs text-primary">打开 SnowLuma，查看账号与注入状态 ↗</a>
        </UiCard>
        <p v-if="error" role="alert" class="rounded-lg bg-destructive/10 p-4 text-sm text-destructive">{{ error }}</p><p v-if="notice" role="status" class="text-sm text-success">{{ notice }}</p>
        <div class="flex flex-wrap items-center justify-between gap-3"><h2 class="font-semibold">已保存的上游连接</h2><UiButton variant="outline" size="sm" :disabled="busy" @click="newAccount">手动添加 OneBot 连接</UiButton></div>
        <UiCard v-if="editing" class="space-y-4 p-5"><h3 class="font-medium">OneBot 连接参数</h3><div class="grid gap-3 sm:grid-cols-2"><label class="space-y-2 text-xs">连接 ID<UiInput v-model="editing.id" :disabled="busy || editingExisting" /></label><label class="space-y-2 text-xs">名称<UiInput v-model="editing.name" :disabled="busy" /></label><label class="space-y-2 text-xs">QQ 号<UiInput v-model="editing.uin" :disabled="busy" /></label><label class="space-y-2 text-xs">WebSocket 地址<UiInput v-model="editing.upstream.url" :disabled="busy" placeholder="ws://127.0.0.1:3001" /></label><label class="space-y-2 text-xs">Access Token<UiInput v-model="editing.upstream.token" :disabled="busy" type="password" autocomplete="off" /></label></div><div class="flex gap-2"><UiButton :disabled="busy" @click="save">保存连接</UiButton><UiButton variant="ghost" :disabled="busy" @click="editing = null">取消</UiButton></div></UiCard>
        <UiCard v-for="a in accounts" :key="a.id" class="space-y-3 p-5"><div class="flex flex-wrap items-start justify-between gap-4"><div class="min-w-0"><h3 class="font-semibold">{{ a.name || a.uin || a.id }} <span class="ml-2 text-xs font-normal" :class="live(a.id)?.connected ? 'text-success' : 'text-muted-foreground'">{{ live(a.id)?.connected ? '已连接' : !a.enabled ? '已停用' : '未连接' }}</span></h3><p class="mt-2 break-all font-mono text-xs text-muted-foreground">{{ a.id }} · {{ a.upstream.url }}</p></div><div class="flex flex-wrap gap-2"><UiButton variant="outline" size="sm" :disabled="busy" @click="action(a, true)">{{ live(a.id)?.connected ? '重新连接' : '连接' }}</UiButton><UiButton variant="ghost" size="sm" :disabled="busy || !a.enabled" @click="action(a, false)">断开</UiButton><UiButton variant="ghost" size="sm" :disabled="busy" @click="edit(a)">编辑连接</UiButton></div></div><p v-if="a.enabled && !live(a.id)?.connected && live(a.id)?.lastError" class="break-words text-xs text-warning">{{ live(a.id)?.lastError }}。请确认 QQ 已注入、OneBot 端点已启动且 token 一致。</p></UiCard>
    </div>
</template>
