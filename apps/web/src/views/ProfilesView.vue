<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { conversationsApi, type ConversationProfile } from '@/api/conversations';
import { useStatusStore } from '@/stores/status';
import UiCard from '@/components/ui/UiCard.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiInput from '@/components/ui/UiInput.vue';
import MessageRulesEditor from '@/components/MessageRulesEditor.vue';
const store = useStatusStore();
const profiles = ref<ConversationProfile[]>([]);
const bindings = ref<Record<string, { id: string }>>({});
const draft = ref<ConversationProfile | null>(null);
const editing = ref(false);
const busy = ref(false);
const error = ref('');
const notice = ref('');
const deleting = ref('');
const sample = ref('你好，请介绍一下自己。');
const sampleReply = ref('<think>推理内容</think>你好，很高兴认识你。');
const preview = ref<{ input: string; system: string; output: string } | null>(null);
const draftSignature = computed(() => JSON.stringify({ draft: draft.value, sample: sample.value, reply: sampleReply.value }));
const previewSignature = ref('');
async function load() {
    try { const r = await conversationsApi.list(); profiles.value = r.profiles; bindings.value = r.bindings; }
    catch (e) { error.value = String(e); }
}
onMounted(load);
function edit(p?: ConversationProfile) {
    editing.value = !!p;
    draft.value = p ? JSON.parse(JSON.stringify(p)) : { id: '', name: '', systemPrompt: '', inputPrefix: '', inputSuffix: '', inputRules: [], replyRules: [] };
    preview.value = null; error.value = ''; notice.value = '';
}
async function save() {
    if (!draft.value) return;
    busy.value = true; error.value = '';
    try {
        if (!editing.value && profiles.value.some(p => p.id === draft.value!.id)) throw new Error('配置 ID 已存在');
        await conversationsApi.save(draft.value); draft.value = null; await load(); await store.refresh(); notice.value = '会话配置已保存，引用它的会话立即采用新内容。';
    } catch (e) { error.value = e instanceof Error ? e.message : String(e); }
    finally { busy.value = false; }
}
async function remove(id: string) {
    busy.value = true; error.value = '';
    try { await conversationsApi.remove(id); deleting.value = ''; await load(); await store.refresh(); notice.value = '已删除，相关会话恢复默认配置。'; }
    catch (e) { error.value = String(e); }
    finally { busy.value = false; }
}
async function runPreview() {
    if (!draft.value) return;
    busy.value = true; error.value = '';
    try { preview.value = await conversationsApi.preview({ ...draft.value, id: draft.value.id || 'preview' }, sample.value, sampleReply.value); previewSignature.value = draftSignature.value; }
    catch (e) { error.value = String(e); }
    finally { busy.value = false; }
}
</script>
<template>
    <div class="flex flex-col gap-5">
        <UiCard class="space-y-3 p-5 sm:p-6"><h2 class="text-lg font-semibold">会话配置</h2><p class="text-sm leading-6 text-muted-foreground">定义前置提示词、输入内容和消息处理规则。配置可供不同下游复用；会话绑定和默认配置在「会话管理」中设置。</p><RouterLink to="/sessions" class="inline-block text-xs text-primary">前往会话管理 →</RouterLink></UiCard>
        <p v-if="error" role="alert" class="rounded-lg bg-destructive/10 p-4 text-sm text-destructive">{{ error }}</p><p v-if="notice" role="status" class="text-sm text-success">{{ notice }}</p>
        <div class="flex items-center justify-between"><span class="text-sm text-muted-foreground">{{ profiles.length }} 份配置</span><UiButton :disabled="busy" @click="edit()">新建会话配置</UiButton></div>
        <UiCard v-if="draft" class="space-y-5 p-5 sm:p-6">
            <div class="grid gap-3 sm:grid-cols-2"><label class="space-y-2 text-xs">配置 ID<UiInput v-model="draft.id" :disabled="editing || busy" placeholder="例如 assistant" /></label><label class="space-y-2 text-xs">名称<UiInput v-model="draft.name" :disabled="busy" placeholder="例如 简洁助手" /></label></div>
            <label class="block space-y-2 text-sm font-medium">前置提示词<textarea v-model="draft.systemPrompt" :disabled="busy" rows="6" placeholder="你希望服务如何理解和处理这段对话？" class="w-full rounded-lg border border-border bg-background p-3 text-sm font-normal" /></label>
            <div class="grid gap-3 sm:grid-cols-2"><label class="space-y-2 text-xs">用户消息前追加<textarea v-model="draft.inputPrefix" :disabled="busy" rows="3" class="w-full rounded-lg border border-border bg-background p-3 text-sm" /></label><label class="space-y-2 text-xs">用户消息后追加<textarea v-model="draft.inputSuffix" :disabled="busy" rows="3" class="w-full rounded-lg border border-border bg-background p-3 text-sm" /></label></div>
            <MessageRulesEditor v-model="draft.inputRules" :disabled="busy" label="发送前处理" /><MessageRulesEditor v-model="draft.replyRules" :disabled="busy" label="回复后处理" />
            <details class="rounded-lg border border-border p-4"><summary class="cursor-pointer text-sm">预览消息处理</summary><div class="mt-4 space-y-3"><label class="block space-y-2 text-xs">示例输入<UiInput v-model="sample" /></label><label class="block space-y-2 text-xs">示例回复<UiInput v-model="sampleReply" /></label><UiButton variant="outline" size="sm" :disabled="busy" @click="runPreview">预览处理结果</UiButton><p class="text-xs text-muted-foreground">只预览文本处理，不调用下游。</p><div v-if="preview && previewSignature === draftSignature" class="space-y-3 break-words rounded-lg bg-muted p-4 text-xs"><p class="whitespace-pre-wrap">前置提示词：{{ preview.system || '无' }}</p><p class="whitespace-pre-wrap">发送内容：{{ preview.input }}</p><p class="whitespace-pre-wrap">回复内容：{{ preview.output }}</p></div></div></details>
            <div class="flex gap-2"><UiButton :disabled="busy" @click="save">保存配置</UiButton><UiButton variant="ghost" :disabled="busy" @click="draft = null">取消</UiButton></div>
        </UiCard>
        <UiCard v-if="!profiles.length && !draft" class="p-8 text-center text-sm text-muted-foreground">创建第一份会话配置，然后在会话管理中选用。</UiCard>
        <UiCard v-for="p in profiles" :key="p.id" class="space-y-3 p-5"><div class="flex flex-wrap items-start justify-between gap-3"><div><h3 class="font-semibold">{{ p.name }}</h3><p class="mt-1 font-mono text-xs text-muted-foreground">{{ p.id }}</p></div><div class="flex gap-2"><UiButton variant="outline" size="sm" :disabled="busy" @click="edit(p)">编辑</UiButton><UiButton variant="ghost" size="sm" :disabled="busy" @click="deleting = p.id">删除</UiButton></div></div><p class="line-clamp-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">{{ p.systemPrompt || '无前置提示词' }}</p><p class="text-xs text-muted-foreground">{{ p.inputRules.length }} 条输入规则 · {{ p.replyRules.length }} 条回复规则 · {{ Object.values(bindings).filter(b => b.id === p.id).length }} 个会话引用</p><div v-if="deleting === p.id" class="flex flex-wrap items-center gap-3 rounded-lg bg-muted p-3 text-xs"><span>删除后，引用它的会话恢复默认配置。</span><UiButton variant="destructive" size="sm" :disabled="busy" @click="remove(p.id)">确认删除</UiButton><UiButton variant="ghost" size="sm" :disabled="busy" @click="deleting = ''">取消</UiButton></div></UiCard>
    </div>
</template>
