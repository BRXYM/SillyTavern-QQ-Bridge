<script setup lang="ts">
import { onMounted, ref } from 'vue';
import SessionRoutes from '@/components/SessionRoutes.vue';
import UiCard from '@/components/ui/UiCard.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiSelect from '@/components/ui/UiSelect.vue';
import { conversationsApi, type ConversationProfile } from '@/api/conversations';
import { useStatusStore } from '@/stores/status';
const store = useStatusStore();
const backend = ref('');
const conversation = ref('');
const profiles = ref<ConversationProfile[]>([]);
const busy = ref(false);
const error = ref('');
const notice = ref('');
async function load() {
    try { await store.refresh(); const r = await conversationsApi.list(); profiles.value = r.profiles; conversation.value = r.defaultId; backend.value = store.defaultDownstreamId; }
    catch (e) { error.value = String(e); }
}
onMounted(load);
async function save() {
    busy.value = true; error.value = ''; notice.value = '';
    try { await conversationsApi.defaults(backend.value, conversation.value); await store.refresh(); notice.value = '默认设置已保存，继承默认的会话立即生效。'; }
    catch (e) { error.value = String(e); }
    finally { busy.value = false; }
}
</script>
<template>
    <div class="flex flex-col gap-5">
        <UiCard class="space-y-4 p-5 sm:p-6">
            <h2 class="text-lg font-semibold">默认会话设置</h2><p class="text-sm text-muted-foreground">未单独绑定的会话使用以下下游与会话配置，两者可以独立选择。</p>
            <div class="grid gap-4 md:grid-cols-2"><label class="space-y-2 text-xs">默认下游连接<UiSelect v-model="backend" :disabled="busy" :options="store.downstreams.map(d => ({ value: d.id, label: `${d.name || d.id}${d.enabled ? '' : '（已停用）'}` }))" /></label><label class="space-y-2 text-xs">默认会话配置<UiSelect v-model="conversation" :disabled="busy" :options="[{ value: '', label: '不使用会话配置' }, ...profiles.map(p => ({ value: p.id, label: p.name }))]" /></label></div>
            <div class="flex flex-wrap items-center gap-4"><UiButton :disabled="busy || !backend" @click="save">保存默认设置</UiButton><RouterLink to="/profiles" class="text-xs text-primary">编辑会话配置 →</RouterLink><RouterLink to="/downstreams" class="text-xs text-primary">管理下游连接 →</RouterLink></div>
            <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p><p v-if="notice" role="status" class="text-sm text-success">{{ notice }}</p>
        </UiCard>
        <SessionRoutes />
    </div>
</template>
