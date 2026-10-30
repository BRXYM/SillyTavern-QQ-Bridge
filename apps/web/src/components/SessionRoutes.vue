<script setup lang="ts">
import { computed, ref, onMounted, watch } from 'vue';
import { useStatusStore } from '@/stores/status';
import { useToastStore } from '@/stores/toast';
import { api } from '@/api/client';
import { flowsApi, type FlowList } from '@/api/flows';
import UiCard from './ui/UiCard.vue';
import UiInput from './ui/UiInput.vue';
import UiSelect from './ui/UiSelect.vue';
import UiButton from './ui/UiButton.vue';
import SessionVariablesEditor from './SessionVariablesEditor.vue';
const store = useStatusStore();
const toast = useToastStore();
const account = ref('');
const flowFilter = ref('');
const query = ref('');
const busy = ref(false);
const variablesOf = ref('');
const editor = ref<{ key: string; flowId: string } | null>(null);
const data = ref<FlowList>({ flows: [], defaultId: '', bindings: {} });
async function load() { try { data.value = await flowsApi.list(); } catch(e) { toast.error('读取流程绑定失败', String(e)); } }
onMounted(load);
watch(() => [store.status?.sessionChoices, store.status?.config], () => void load());
const accountOptions = computed(() => [{ value: '', label: '全部 QQ 账号' }, ...(store.status?.accounts ?? []).map(a => ({ value: a.id, label: `${a.name || a.id} · ${a.uin || a.selfId || a.id}` }))]);
function downstreamName(id: string) { return store.downstreams.find(d => d.id === id)?.name || id || '连接缺失'; }
const rows = computed(() => {
    const status = store.status;
    const keys = new Set([...Object.keys(status?.sessions ?? {}), ...Object.keys(status?.sessionChoices ?? {})]);
    return [...keys].sort().map(key => {
        const accountId = key.includes(':') ? key.slice(0, key.indexOf(':')) : '';
        const a = status?.accounts?.find(a => a.id === accountId);
        const binding = data.value.bindings[key];
        const flow = data.value.flows.find(f => f.id === binding?.id);
        const configs = (status?.config.conversationProfiles ?? []) as Array<{ id: string; name: string }>;
        return { key, accountId, accountName: a?.name || accountId || '旧版会话', session: key.includes(':') ? key.slice(key.indexOf(':') + 1) : key,
            flowId: binding?.id ?? '', flowName: flow?.name || binding?.id || '尚未加载', inherited: binding?.inherited ?? true, compatibility: flow?.compatibility,
            downstream: downstreamName(flow?.downstreamId ?? ''), profile: flow?.legacyPreserveBehavior ? '沿用原处理方式' : flow?.upstreamEnabled || flow?.downstreamEnabled ? configs.find(p => p.id === flow?.conversationId)?.name || flow?.conversationId || '配置缺失' : '不做消息处理',
            available: !!flow?.enabled && !!store.downstreams.find(d => d.id === flow.downstreamId)?.available };
    });
});
const filtered = computed(() => rows.value.filter(r => (!account.value || r.accountId === account.value) && (!flowFilter.value || r.flowId === flowFilter.value) && (!query.value.trim() || `${r.key} ${r.accountName} ${r.flowName} ${r.downstream} ${r.profile}`.toLowerCase().includes(query.value.trim().toLowerCase()))));
function open(key: string) { const binding = data.value.bindings[key]; editor.value = { key, flowId: binding?.inherited ? '__inherit__' : binding?.id || '__inherit__' }; }
async function save() {
    if (!editor.value) return; busy.value = true;
    try { await api.updateSession({ sessionKey: editor.value.key, flowId: editor.value.flowId === '__inherit__' ? null : editor.value.flowId }); await store.refresh(); await load(); editor.value = null; toast.success('会话流程已保存'); }
    catch(e) { toast.error('保存失败', String(e)); } finally { busy.value = false; }
}
</script>
<template>
    <UiCard class="overflow-hidden">
        <div class="space-y-4 border-b border-border p-5"><div class="flex items-center justify-between gap-2"><h2 class="font-semibold">会话与流程</h2><span class="text-xs text-muted-foreground">{{ filtered.length }} / {{ rows.length }} 个会话</span></div><p class="text-xs leading-5 text-muted-foreground">每个会话只选择一个流程。旧的下游和配置组合会显示为兼容流程，变量继续跟随本会话。</p><div class="grid gap-3 md:grid-cols-3"><UiSelect v-model="account" aria-label="筛选 QQ 账号" :options="accountOptions" /><UiSelect v-model="flowFilter" aria-label="筛选消息流程" :options="[{ value: '', label: '全部流程' }, ...data.flows.map(f => ({ value: f.id, label: f.name }))]" /><UiInput v-model="query" aria-label="搜索会话" placeholder="搜索会话、流程或连接" /></div></div>
        <div v-if="editor" class="space-y-3 border-b border-primary/20 bg-primary/5 p-5"><p class="break-all text-sm font-medium">选择流程 · {{ editor.key }}</p><UiSelect v-model="editor.flowId" :disabled="busy" aria-label="会话使用的流程" :options="[{ value: '__inherit__', label: '继承默认流程' }, ...data.flows.map(f => ({ value: f.id, label: `${f.name}${f.enabled ? '' : '（已停用）'}` }))]" /><div class="flex gap-2"><UiButton size="sm" :disabled="busy" @click="save">保存绑定</UiButton><UiButton variant="ghost" size="sm" :disabled="busy" @click="editor = null">取消</UiButton></div></div>
        <SessionVariablesEditor v-if="variablesOf" :key="variablesOf" :session-key="variablesOf" @close="variablesOf = ''" />
        <div v-if="!filtered.length" class="p-8 text-center text-sm text-muted-foreground">{{ rows.length ? '没有符合条件的会话' : 'QQ 收到消息后，会话会出现在这里。' }}</div>
        <div v-else class="max-h-[560px] overflow-auto"><table class="w-full min-w-[780px] text-left text-xs"><thead class="bg-muted/40 text-muted-foreground"><tr><th class="px-5 py-3">QQ 账号 / 会话</th><th class="px-5 py-3">所选流程</th><th class="px-5 py-3">处理组合</th><th class="px-5 py-3">操作</th></tr></thead><tbody class="divide-y divide-border"><tr v-for="row in filtered" :key="row.key"><td class="max-w-56 px-5 py-4"><p class="font-medium">{{ row.accountName }}</p><p class="mt-1 break-all font-mono text-muted-foreground">{{ row.session }}</p></td><td class="max-w-60 px-5 py-4"><p class="break-words">{{ row.flowName }}</p><p class="mt-1 text-muted-foreground">{{ row.inherited ? '继承默认' : '单独绑定' }} · {{ row.available ? '可用' : '不可用' }}</p></td><td class="max-w-60 px-5 py-4"><p class="break-words">{{ row.downstream }}</p><p class="mt-1 break-words text-muted-foreground">{{ row.profile }}</p></td><td class="px-5 py-4"><div class="flex flex-wrap items-center gap-2"><UiButton variant="outline" size="sm" :disabled="busy" @click="open(row.key)">选择流程</UiButton><UiButton variant="ghost" size="sm" @click="variablesOf = row.key">变量</UiButton><RouterLink :to="{ path: '/flows', query: { sessionKey: row.key } }" class="text-primary">执行记录</RouterLink></div></td></tr></tbody></table></div>
    </UiCard>
</template>
