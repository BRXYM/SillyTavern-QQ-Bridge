<script setup lang="ts">
import { computed, ref, onMounted, watch } from 'vue';
import { useStatusStore } from '@/stores/status';
import { useToastStore } from '@/stores/toast';
import { api } from '@/api/client';
import { conversationsApi, type ConversationProfile } from '@/api/conversations';
import UiCard from './ui/UiCard.vue';
import UiInput from './ui/UiInput.vue';
import UiSelect from './ui/UiSelect.vue';
import UiButton from './ui/UiButton.vue';

const store = useStatusStore();
const toast = useToastStore();
const account = ref('');
const downstream = ref('');
const query = ref('');
const busy = ref(false);
const editor = ref<{ key: string; backendId: string; profileId: string } | null>(null);
const configurations = ref<ConversationProfile[]>([]);
const bindings = ref<Record<string, { id: string; inherited: boolean }>>({});
async function load() { try { const r = await conversationsApi.list(); configurations.value = r.profiles; bindings.value = r.bindings; } catch (e) { toast.error('读取会话配置失败', String(e)); } }
onMounted(load);
watch(() => [store.status?.sessionChoices, store.status?.config], () => void load());
const accountOptions = computed(() => [
    { value: '', label: '全部 QQ 账号' },
    ...(store.status?.accounts ?? []).map(a => ({ value: a.id, label: `${a.name || a.id} · ${a.uin || a.selfId || a.id}` })),
]);
function name(id: string) { return store.downstreams.find(d => d.id === id)?.name || id || '未设置'; }

const rows = computed(() => {
    const s = store.status;
    const keys = new Set([...Object.keys(s?.sessions ?? {}), ...Object.keys(s?.sessionChoices ?? {})]);
    return [...keys].sort().map(key => {
        const accountId = key.includes(':') ? key.slice(0, key.indexOf(':')) : '';
        const a = s?.accounts?.find(a => a.id === accountId);
        const choice = s?.sessionChoices[key];
        const resolved = s?.sessionBackends?.[key];
        const backendId = resolved?.backendId ?? choice?.backendId ?? s?.defaultDownstreamId ?? '';
        const profileId = bindings.value[key]?.id ?? '';
        return {
            key, accountId, accountName: a?.name || accountId || '旧版会话',
            session: key.includes(':') ? key.slice(key.indexOf(':') + 1) : key,
            backendId, profileId,
            profileName: configurations.value.find(p => p.id === profileId)?.name || profileId || '未使用会话配置',
            inherited: resolved?.inherited ?? !choice?.backendId,
            available: store.downstreams.find(d => d.id === backendId)?.available ?? false,
        };
    });
});
const filtered = computed(() => rows.value.filter(r =>
    (!account.value || r.accountId === account.value)
    && (!downstream.value || r.backendId === downstream.value)
    && (!query.value.trim() || `${r.key} ${r.accountName} ${name(r.backendId)} ${r.profileName}`.toLowerCase().includes(query.value.trim().toLowerCase())),
));
const profileOptions = computed(() => [{ value: '__inherit__', label: '继承默认会话配置' }, { value: '', label: '不使用会话配置' }, ...configurations.value.map(p => ({ value: p.id, label: p.name }))]);
function open(key: string) {
    const choice = store.status?.sessionChoices[key];
    editor.value = { key, backendId: choice?.backendId ?? '', profileId: choice?.conversationId === undefined ? '__inherit__' : choice.conversationId };
}
async function save() {
    if (!editor.value) return;
    busy.value = true;
    try {
        await api.updateSession({ sessionKey: editor.value.key, backendId: editor.value.backendId, conversationId: editor.value.profileId === '__inherit__' ? null : editor.value.profileId });
        await store.refresh(); await load(); editor.value = null; toast.success('会话路由已保存');
    } catch (e) { toast.error('保存失败', e instanceof Error ? e.message : String(e)); }
    finally { busy.value = false; }
}
</script>

<template>
    <UiCard class="overflow-hidden">
        <div class="space-y-4 border-b border-border p-5">
            <div class="flex flex-wrap items-center justify-between gap-2"><h2 class="font-semibold">会话路由</h2><span class="text-xs text-muted-foreground">{{ filtered.length }} / {{ rows.length }} 个会话</span></div>
            <p class="text-xs leading-5 text-muted-foreground">查看每个 QQ 会话实际使用的服务和配置。群聊按成员隔离；未绑定的会话继承全局默认。</p>
            <div class="grid gap-3 md:grid-cols-3">
                <UiSelect v-model="account" aria-label="筛选 QQ 账号" :options="accountOptions" />
                <UiSelect v-model="downstream" aria-label="筛选下游" :options="[{ value: '', label: '全部下游' }, ...store.downstreams.map(d => ({ value: d.id, label: name(d.id) }))]" />
                <UiInput v-model="query" aria-label="搜索会话" placeholder="搜索 QQ、群号、下游或配置" />
            </div>
        </div>
        <div v-if="editor" class="space-y-3 border-b border-primary/20 bg-primary/5 p-5">
            <p class="break-all text-sm font-medium">调整路由 · {{ editor.key }}</p>
            <div class="grid gap-3 md:grid-cols-2">
                <label class="space-y-2 text-xs">下游连接<UiSelect v-model="editor.backendId" :disabled="busy" :options="[{ value: '', label: `继承全局（${name(store.defaultDownstreamId)}）` }, ...store.downstreams.map(d => ({ value: d.id, label: `${name(d.id)}${d.enabled ? '' : '（已停用）'}` }))]" /></label>
                <label class="space-y-2 text-xs">会话配置<UiSelect v-model="editor.profileId" :disabled="busy" :options="profileOptions" /></label>
            </div>
            <div class="flex gap-2"><UiButton size="sm" :disabled="busy" @click="save">保存路由</UiButton><UiButton variant="ghost" size="sm" :disabled="busy" @click="editor = null">取消</UiButton></div>
        </div>
        <div v-if="!filtered.length" class="p-8 text-center text-sm text-muted-foreground">{{ rows.length ? '没有符合筛选条件的会话' : '接通 QQ 并收到消息后，会话会出现在这里。' }}</div>
        <div v-else class="max-h-[520px] overflow-auto">
            <table class="w-full min-w-[680px] text-left text-xs">
                <thead class="bg-muted/40 text-muted-foreground"><tr><th class="px-5 py-3">QQ 账号 / 会话</th><th class="px-5 py-3">实际下游</th><th class="px-5 py-3">会话配置</th><th class="px-5 py-3">操作</th></tr></thead>
                <tbody class="divide-y divide-border">
                    <tr v-for="row in filtered" :key="row.key">
                        <td class="max-w-64 px-5 py-4"><p class="font-medium">{{ row.accountName }}</p><p class="mt-1 break-all font-mono text-muted-foreground">{{ row.session }}</p></td>
                        <td class="px-5 py-4"><p>{{ name(row.backendId) }}</p><p class="mt-1 text-muted-foreground">{{ row.inherited ? '继承默认' : '单独绑定' }} · {{ row.available ? '可用' : '不可用' }}</p></td>
                        <td class="px-5 py-4"><p>{{ row.profileName }}</p><p class="mt-1 font-mono text-muted-foreground">{{ bindings[row.key]?.inherited ? '继承默认' : '单独指定' }}</p></td>
                        <td class="px-5 py-4"><UiButton variant="outline" size="sm" :disabled="busy" @click="open(row.key)">调整</UiButton></td>
                    </tr>
                </tbody>
            </table>
        </div>
    </UiCard>
</template>
