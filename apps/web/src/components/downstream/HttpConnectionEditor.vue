<script setup lang="ts">
import { ref, watch } from 'vue';
import { Save, Loader2 } from 'lucide-vue-next';
import UiButton from '@/components/ui/UiButton.vue';
import { api, type DownstreamProfileDto } from '@/api/client';
import { useToastStore } from '@/stores/toast';
const props = defineProps<{ item: { id: string; name: string; kind: string; enabled: boolean; settings: Record<string, unknown>; profiles?: DownstreamProfileDto[] } }>();
const emit = defineEmits<{ saved: [] }>();
const toast = useToastStore();
const text = ref('');
const saving = ref(false);
const fields = ['url', 'method', 'headers', 'timeoutMs', 'response', 'requestBody'];
watch(() => props.item.settings, (settings) => { text.value = JSON.stringify(Object.fromEntries(fields.map((key) => [key, settings[key]])), null, 2); }, { immediate: true });
async function save() {
    saving.value = true;
    try {
        const connection = JSON.parse(text.value);
        if (!connection || typeof connection !== 'object' || Array.isArray(connection) || Object.keys(connection).some((key) => !fields.includes(key))) throw new Error('这里只填写 url / method / headers / timeoutMs / response / requestBody');
        const result = await api.saveDownstream({ ...props.item, settings: { ...props.item.settings, ...connection } });
        if (!result.ok) throw new Error(result.error || '运行时加载失败');
        toast.success('连接设置已保存', props.item.name);
        emit('saved');
    } catch (e) { toast.error('保存失败', e instanceof Error ? e.message : String(e)); }
    finally { saving.value = false; }
}
</script>
<template>
    <div class="space-y-3">
        <p class="text-xs leading-relaxed text-muted-foreground">连接参数与响应字段映射。认证请求头可引用环境变量，例如 Bearer 后接双花括号包裹的 env.MY_API_KEY；requestBody 只定义接口字段映射，可用 input.text、input.system 等模板变量。前置提示词与消息处理在「消息流程」的处理操作中维护。</p>
        <textarea v-model="text" aria-label="HTTP 连接设置" rows="12" spellcheck="false" :disabled="saving" class="w-full rounded-lg border border-border bg-background p-3 font-mono text-xs leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring/30" />
        <UiButton size="sm" :disabled="saving" @click="save"><Loader2 v-if="saving" class="size-3.5 animate-spin" /><Save v-else class="size-3.5" />保存连接设置</UiButton>
    </div>
</template>
