<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { conversationsApi, type ConversationState } from '@/api/conversations';
import UiButton from './ui/UiButton.vue';
import UiInput from './ui/UiInput.vue';
const props = defineProps<{ sessionKey: string }>();
const emit = defineEmits<{ close: [] }>();
const rows = ref<Array<{ name: string; value: string }>>([]);
const state = ref<ConversationState | null>(null);
const revision = ref(0);
const busy = ref(false);
const error = ref('');
const notice = ref('');
async function load() {
    busy.value = true; error.value = ''; notice.value = '';
    try { const data = await conversationsApi.variables(props.sessionKey); state.value = data.state; revision.value = data.revision; rows.value = Object.entries(data.state.vars).map(([name, value]) => ({ name, value })); }
    catch (e) { error.value = String(e); }
    finally { busy.value = false; }
}
async function save() {
    busy.value = true; error.value = ''; notice.value = '';
    try {
        if (new Set(rows.value.map(v => v.name)).size !== rows.value.length) throw new Error('变量名不能重复');
        const data = await conversationsApi.saveVariables(props.sessionKey, Object.fromEntries(rows.value.map(v => [v.name, v.value])), revision.value);
        state.value = data.state; revision.value = data.revision; notice.value = '已保存，只影响本会话；下次处理消息时可引用。';
    } catch (e) { error.value = e instanceof Error ? e.message : String(e); }
    finally { busy.value = false; }
}
onMounted(load);
</script>
<template>
    <div class="space-y-4 border-b border-border bg-info/5 p-5">
        <h3 class="break-all text-sm font-medium">单会话持久变量 · {{ sessionKey }}</h3>
        <p class="text-xs leading-5 text-muted-foreground">值按账号、群与成员所属的会话隔离，重启保留，切换配置时同名变量沿用。算子中的初始值仅在变量尚不存在时使用；移除后，下次处理消息可能重新初始化。</p>
        <div v-for="(row, index) in rows" :key="index" class="flex flex-wrap gap-2"><UiInput v-model="row.name" :disabled="busy" aria-label="会话变量名" placeholder="英文变量名" class="min-w-36 flex-1" /><UiInput v-model="row.value" :disabled="busy" aria-label="会话变量值" placeholder="变量值" class="min-w-48 flex-1" /><UiButton variant="ghost" size="sm" :disabled="busy" @click="rows.splice(index, 1)">移除</UiButton></div>
        <div class="flex flex-wrap gap-2"><UiButton variant="outline" size="sm" :disabled="busy || rows.length >= 32 || !state" @click="rows.push({ name: '', value: '' })">添加变量</UiButton><UiButton size="sm" :disabled="busy || !state" @click="save">保存变量</UiButton><UiButton variant="outline" size="sm" :disabled="busy" @click="load">重新读取</UiButton><UiButton variant="ghost" size="sm" :disabled="busy" @click="emit('close')">关闭</UiButton></div>
        <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p><p v-if="notice" role="status" class="text-xs text-success">{{ notice }}</p>
        <details v-if="state" class="text-xs"><summary class="cursor-pointer text-muted-foreground">上次保存的算子数据与旧提取值</summary><pre class="mt-3 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background p-3">{{ JSON.stringify({ operators: state.operators, legacy: state.previous }, null, 2) }}</pre></details>
    </div>
</template>
