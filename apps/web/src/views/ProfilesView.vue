<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { conversationsApi, type ConversationProfile, type ConversationPreview, type ConversationState } from '@/api/conversations';
import { useStatusStore } from '@/stores/status';
import UiCard from '@/components/ui/UiCard.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiInput from '@/components/ui/UiInput.vue';
import ConversationDataEditor from '@/components/ConversationDataEditor.vue';
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
const preview = ref<ConversationPreview | null>(null);
const previewState = ref<ConversationState | undefined>();
const previewRound = ref(1);
const references = ['{{message.upstream}}', '{{message.downstream}}', '{{current.upstream.name}}', '{{current.downstream.name}}', '{{previous.upstream.name}}', '{{previous.downstream.name}}', '{{vars.nickname}}'];
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
    Object.assign(draft.value!, { replyPrefix: draft.value!.replyPrefix ?? '', replySuffix: draft.value!.replySuffix ?? '', variables: draft.value!.variables ?? [], upstreamExtracts: draft.value!.upstreamExtracts ?? [], downstreamExtracts: draft.value!.downstreamExtracts ?? [], upstreamAssignments: draft.value!.upstreamAssignments ?? [], downstreamAssignments: draft.value!.downstreamAssignments ?? [] });
    preview.value = null; previewState.value = undefined; previewRound.value = 1; error.value = ''; notice.value = '';
}
function createExample() {
    edit();
    let id = 'example_variables'; let index = 1;
    while (profiles.value.some(p => p.id === id)) id = `example_variables_${index++}`;
    Object.assign(draft.value!, {
        id, name: '称呼与编号示例',
        systemPrompt: '请称呼用户为 {{vars.nickname}}。上一次成功对话的编号：{{previous.downstream.ticket}}',
        variables: [{ name: 'nickname', initialValue: '访客' }, { name: 'lastTicket', initialValue: '' }],
        upstreamExtracts: [{ name: 'nickname', source: '{{message.upstream}}', mode: 'regex', expression: '^我叫(.+)$', group: 1, flags: '' }],
        upstreamAssignments: [{ name: 'nickname', value: '{{current.upstream.nickname}}', skipEmpty: true }],
        downstreamExtracts: [{ name: 'ticket', source: '{{message.downstream}}', mode: 'regex', expression: '编号[:：]\\s*(\\S+)', group: 1, flags: '' }],
        downstreamAssignments: [{ name: 'lastTicket', value: '{{current.downstream.ticket}}', skipEmpty: true }],
        replyPrefix: '{{vars.nickname}}，',
    });
    sample.value = '我叫小明'; sampleReply.value = '已收到。编号：T001';
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
    try { preview.value = await conversationsApi.preview({ ...draft.value, id: draft.value.id || 'preview' }, sample.value, sampleReply.value, previewState.value); previewSignature.value = draftSignature.value; }
    catch (e) { error.value = String(e); }
    finally { busy.value = false; }
}
</script>
<template>
    <div class="flex flex-col gap-5">
        <UiCard class="space-y-3 p-5 sm:p-6"><h2 class="text-lg font-semibold">会话配置</h2><p class="text-sm leading-6 text-muted-foreground">定义前置提示词、输入内容和消息处理规则。配置可供多个流程复用；在「消息流程」中组合连接与配置，再为会话选择流程。</p><RouterLink to="/flows" class="inline-block text-xs text-primary">前往消息流程 →</RouterLink></UiCard>
        <p v-if="error" role="alert" class="rounded-lg bg-destructive/10 p-4 text-sm text-destructive">{{ error }}</p><p v-if="notice" role="status" class="text-sm text-success">{{ notice }}</p>
        <div class="flex flex-wrap items-center justify-between gap-3"><span class="text-sm text-muted-foreground">{{ profiles.length }} 份配置</span><div class="flex gap-2"><UiButton variant="outline" :disabled="busy" @click="createExample">从示例新建</UiButton><UiButton :disabled="busy" @click="edit()">新建会话配置</UiButton></div></div>
        <UiCard v-if="draft" class="space-y-5 p-5 sm:p-6">
            <div class="grid gap-3 sm:grid-cols-2"><label class="space-y-2 text-xs">配置 ID<UiInput v-model="draft.id" :disabled="editing || busy" placeholder="例如 assistant" /></label><label class="space-y-2 text-xs">名称<UiInput v-model="draft.name" :disabled="busy" placeholder="例如 简洁助手" /></label></div>
            <div class="rounded-xl border border-info/25 bg-info/5 p-4 text-xs leading-6 text-muted-foreground"><p class="font-medium text-foreground">处理顺序与引用</p><p>本轮上游提取 → 上游变量赋值 → 文本处理 / 提示词 → 调用下游 → 下游提取 → 下游变量赋值 → 回复处理。</p><p>本轮下游数据只能在下游阶段引用；上游要使用下游数据时，请引用上一轮。提取名称替换示例中的 name，变量名替换 nickname。</p><div class="mt-2 flex flex-wrap gap-2"><code v-for="item in references" :key="item" class="rounded bg-background px-2 py-1" v-text="item" /></div></div>
            <details class="rounded-lg border border-border p-4"><summary class="cursor-pointer text-sm font-medium">单会话持久变量初始值（{{ draft.variables?.length ?? 0 }}）</summary><div class="mt-4 space-y-3"><p class="text-xs leading-5 text-muted-foreground">初始值仅在该会话尚无同名变量时使用，后续由赋值规则或会话管理更新。重启保留；切换配置时同名变量沿用，其他会话互不影响。</p><div v-for="(variable, i) in draft.variables" :key="i" class="flex flex-wrap gap-2"><UiInput v-model="variable.name" :disabled="busy" aria-label="初始变量名" placeholder="变量名，例如 nickname" class="min-w-40 flex-1" /><UiInput v-model="variable.initialValue" :disabled="busy" aria-label="变量初始值" placeholder="初始值" class="min-w-40 flex-1" /><UiButton variant="ghost" size="sm" :disabled="busy" @click="draft.variables = draft.variables!.filter((_, n) => n !== i)">移除</UiButton></div><UiButton size="sm" variant="outline" :disabled="busy" @click="draft.variables = [...(draft.variables ?? []), { name: '', initialValue: '' }]">添加变量初始值</UiButton></div></details>
            <section class="space-y-4 rounded-xl border border-primary/25 bg-primary/5 p-4 sm:p-5" aria-labelledby="upstream-processing-title">
                <h3 id="upstream-processing-title" class="font-semibold">上游消息处理 · QQ → 下游服务</h3><p class="text-xs leading-5 text-muted-foreground">这里修改收到的 QQ 消息，处理结果发送给下游服务。</p>
                <ConversationDataEditor :extracts="draft.upstreamExtracts ?? []" :assignments="draft.upstreamAssignments ?? []" stage="upstream" :disabled="busy" @update:extracts="draft.upstreamExtracts = $event" @update:assignments="draft.upstreamAssignments = $event" />
                <MessageRulesEditor v-model="draft.inputRules" :disabled="busy" label="QQ 原文处理规则" />
                <div class="grid gap-3 sm:grid-cols-2"><label class="space-y-2 text-xs">发给下游的消息：开头追加<textarea v-model="draft.inputPrefix" :disabled="busy" rows="3" class="w-full rounded-lg border border-border bg-background p-3 text-sm" /></label><label class="space-y-2 text-xs">发给下游的消息：结尾追加<textarea v-model="draft.inputSuffix" :disabled="busy" rows="3" class="w-full rounded-lg border border-border bg-background p-3 text-sm" /></label></div>
                <label class="block space-y-2 text-sm font-medium">发送给下游的前置提示词<textarea v-model="draft.systemPrompt" :disabled="busy" rows="5" placeholder="支持引用本轮上游、上一轮提取值和会话变量。" class="w-full rounded-lg border border-border bg-background p-3 text-sm font-normal" /></label>
            </section>
            <section class="space-y-4 rounded-xl border border-info/25 bg-info/5 p-4 sm:p-5" aria-labelledby="downstream-processing-title">
                <h3 id="downstream-processing-title" class="font-semibold">下游消息处理 · 下游服务 → QQ</h3><p class="text-xs leading-5 text-muted-foreground">这里修改下游返回的回复，处理结果发送回 QQ。可引用本轮两端的提取数据。</p>
                <ConversationDataEditor :extracts="draft.downstreamExtracts ?? []" :assignments="draft.downstreamAssignments ?? []" stage="downstream" :disabled="busy" @update:extracts="draft.downstreamExtracts = $event" @update:assignments="draft.downstreamAssignments = $event" />
                <MessageRulesEditor v-model="draft.replyRules" :disabled="busy" label="下游原始回复处理规则" />
                <div class="grid gap-3 sm:grid-cols-2"><label class="space-y-2 text-xs">返回 QQ 的回复：开头追加<textarea v-model="draft.replyPrefix" :disabled="busy" rows="3" class="w-full rounded-lg border border-border bg-background p-3 text-sm" /></label><label class="space-y-2 text-xs">返回 QQ 的回复：结尾追加<textarea v-model="draft.replySuffix" :disabled="busy" rows="3" class="w-full rounded-lg border border-border bg-background p-3 text-sm" /></label></div>
            </section>
            <details class="rounded-lg border border-border p-4"><summary class="cursor-pointer text-sm">预览消息处理 · 第 {{ previewRound }} 轮</summary><div class="mt-4 space-y-3"><label class="block space-y-2 text-xs">模拟 QQ 原文<UiInput v-model="sample" /></label><label class="block space-y-2 text-xs">模拟下游原始回复<UiInput v-model="sampleReply" /></label><div class="flex flex-wrap gap-2"><UiButton variant="outline" size="sm" :disabled="busy" @click="runPreview">预览本轮</UiButton><UiButton v-if="preview && previewSignature === draftSignature" variant="outline" size="sm" :disabled="busy" @click="previewState = preview.state; previewRound++; preview = null">使用本轮状态继续下一轮</UiButton><UiButton variant="ghost" size="sm" :disabled="busy" @click="previewState = undefined; previewRound = 1; preview = null">重置预览</UiButton></div><p class="text-xs text-muted-foreground">使用独立模拟状态，不调用下游、不修改真实会话变量。上一轮指上次成功调用下游时的提取值。</p><div v-if="preview && previewSignature === draftSignature" class="space-y-3 break-words rounded-lg bg-muted p-4 text-xs"><p class="whitespace-pre-wrap">发给下游的前置提示词：{{ preview.system || '无' }}</p><p class="whitespace-pre-wrap">发给下游的消息：{{ preview.input }}</p><p class="whitespace-pre-wrap">返回 QQ 的回复：{{ preview.output }}</p><pre class="overflow-auto whitespace-pre-wrap">本轮提取：{{ JSON.stringify(preview.extracted, null, 2) }}</pre><pre class="overflow-auto whitespace-pre-wrap">本轮结束后的会话变量：{{ JSON.stringify(preview.state.vars, null, 2) }}</pre><p v-for="warning in preview.warnings" :key="warning" class="text-warning">{{ warning }}</p></div></div></details>
            <div class="flex gap-2"><UiButton :disabled="busy" @click="save">保存配置</UiButton><UiButton variant="ghost" :disabled="busy" @click="draft = null">取消</UiButton></div>
        </UiCard>
        <UiCard v-if="!profiles.length && !draft" class="p-8 text-center text-sm text-muted-foreground">创建第一份会话配置，然后在消息流程中选用。</UiCard>
        <UiCard v-for="p in profiles" :key="p.id" class="space-y-3 p-5"><div class="flex flex-wrap items-start justify-between gap-3"><div><h3 class="font-semibold">{{ p.name }}</h3><p class="mt-1 font-mono text-xs text-muted-foreground">{{ p.id }}</p></div><div class="flex gap-2"><UiButton variant="outline" size="sm" :disabled="busy" @click="edit(p)">编辑</UiButton><UiButton variant="ghost" size="sm" :disabled="busy" @click="deleting = p.id">删除</UiButton></div></div><p class="line-clamp-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">{{ p.systemPrompt || '无前置提示词' }}</p><p class="text-xs text-muted-foreground">{{ p.inputRules.length }} 条输入规则 · {{ p.replyRules.length }} 条回复规则 · {{ Object.values(bindings).filter(b => b.id === p.id).length }} 个会话引用</p><div v-if="deleting === p.id" class="flex flex-wrap items-center gap-3 rounded-lg bg-muted p-3 text-xs"><span>被流程引用的配置须先解除引用；旧会话绑定将恢复默认配置。</span><UiButton variant="destructive" size="sm" :disabled="busy" @click="remove(p.id)">确认删除</UiButton><UiButton variant="ghost" size="sm" :disabled="busy" @click="deleting = ''">取消</UiButton></div></UiCard>
    </div>
</template>
