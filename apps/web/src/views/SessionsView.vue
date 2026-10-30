<script setup lang="ts">
import { onMounted, ref } from 'vue';
import SessionRoutes from '@/components/SessionRoutes.vue';
import UiCard from '@/components/ui/UiCard.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiSelect from '@/components/ui/UiSelect.vue';
import { flowsApi, type MessageFlow } from '@/api/flows';
import { useStatusStore } from '@/stores/status';
const store = useStatusStore();
const selected = ref('');
const flows = ref<MessageFlow[]>([]);
const busy = ref(false);
const error = ref('');
const notice = ref('');
async function load() {
    try { const r = await flowsApi.list(); flows.value = r.flows; selected.value = r.defaultId; }
    catch (e) { error.value = String(e); }
}
onMounted(load);
async function save() {
    busy.value = true; error.value = ''; notice.value = '';
    try { await flowsApi.setDefault(selected.value); await store.refresh(); await load(); notice.value = '默认流程已保存，继承默认的会话立即采用。'; }
    catch (e) { error.value = String(e); } finally { busy.value = false; }
}
</script>
<template>
    <div class="flex flex-col gap-5">
        <UiCard class="space-y-4 p-5 sm:p-6"><h2 class="text-lg font-semibold">默认消息流程</h2><p class="text-sm text-muted-foreground">流程已经组合好连接与处理配置，会话只需要选择流程；未单独指定的会话继承这里的默认值。</p><label class="block space-y-2 text-xs">默认流程<UiSelect v-model="selected" :disabled="busy" :options="flows.map(f => ({ value: f.id, label: `${f.name}${f.compatibility ? '（旧绑定兼容）' : ''}${f.enabled ? '' : '（已停用）'}` }))" /></label><div class="flex flex-wrap items-center gap-4"><UiButton :disabled="busy || !selected" @click="save">保存默认流程</UiButton><RouterLink to="/flows" class="text-xs text-primary">创建或编辑消息流程 →</RouterLink></div><p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p><p v-if="notice" role="status" class="text-sm text-success">{{ notice }}</p></UiCard>
        <SessionRoutes />
    </div>
</template>
