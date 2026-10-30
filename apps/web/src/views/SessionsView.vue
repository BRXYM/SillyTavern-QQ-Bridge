<script setup lang="ts">
import { onMounted, ref, computed } from 'vue';
import SessionRoutes from '@/components/SessionRoutes.vue';
import UiCard from '@/components/ui/UiCard.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiSelect from '@/components/ui/UiSelect.vue';
import { flowsApi, type MessageFlow } from '@/api/flows';
import { useStatusStore } from '@/stores/status';
const store = useStatusStore();
const selected = ref(''); const backend = ref('');
const flows = ref<MessageFlow[]>([]); const defaults = ref<Record<string, string>>({});
const busy = ref(false); const error = ref(''); const notice = ref('');
const choices = computed(() => flows.value.filter(f => f.downstreamId === backend.value));
async function load() {
    try { const r = await flowsApi.list(); flows.value = r.flows; defaults.value = r.downstreamDefaults; selected.value = r.defaultId; backend.value = r.flows.find(f => f.id === r.defaultId)?.downstreamId ?? ''; }
    catch (e) { error.value = String(e); }
}
function changeBackend(id: string) { backend.value = id; selected.value = defaults.value[id] || flows.value.find(f => f.downstreamId === id && f.enabled)?.id || ''; }
onMounted(load);
async function save() {
    busy.value = true; error.value = ''; notice.value = '';
    try { await flowsApi.setDefault(selected.value); await store.refresh(); await load(); notice.value = '默认下游和流程配置已保存。'; }
    catch (e) { error.value = String(e); } finally { busy.value = false; }
}
</script>
<template>
    <div class="flex flex-col gap-5">
        <UiCard class="space-y-4 p-5 sm:p-6"><h2 class="text-lg font-semibold">默认下游与流程配置</h2><p class="text-sm text-muted-foreground">先选下游，再选它的流程配置。未单独指定的会话继承这组默认值；每个下游也可以有自己的默认配置。</p><div class="grid gap-4 md:grid-cols-2"><label class="space-y-2 text-xs">默认下游<UiSelect :model-value="backend" :disabled="busy" :options="store.downstreams.map(d => ({ value: d.id, label: d.name || d.id }))" @update:model-value="changeBackend" /></label><label class="space-y-2 text-xs">默认流程配置<UiSelect v-model="selected" :disabled="busy" :options="choices.map(f => ({ value: f.id, label: `${f.name}${f.enabled ? '' : '（已停用）'}` }))" /></label></div><div class="flex flex-wrap items-center gap-4"><UiButton :disabled="busy || !selected" @click="save">保存默认组合</UiButton><RouterLink to="/flows" class="text-xs text-primary">编排算子与流程配置 →</RouterLink></div><p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p><p v-if="notice" role="status" class="text-sm text-success">{{ notice }}</p></UiCard>
        <SessionRoutes />
    </div>
</template>
