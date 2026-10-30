<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ArrowRight, ArrowUp, ArrowDown, Copy, Trash2, Plus, Boxes } from 'lucide-vue-next';
import { api } from '@/api/client';
import { flowsApi, actionNames, newAction, newOperator, type MessageFlow, type FlowOperator, type OperatorAction, type FlowRun } from '@/api/flows';
import type { ConversationState } from '@/api/conversations';
import { useStatusStore } from '@/stores/status';
import UiCard from '@/components/ui/UiCard.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiInput from '@/components/ui/UiInput.vue';
import UiSelect from '@/components/ui/UiSelect.vue';
import UiSwitch from '@/components/ui/UiSwitch.vue';
import FlowRunDetails from '@/components/FlowRunDetails.vue';
import OperatorActionEditor from '@/components/OperatorActionEditor.vue';
const store = useStatusStore();
const route = useRoute();
const flows = ref<MessageFlow[]>([]);
const connections = ref<Array<{ id: string; name: string; enabled: boolean }>>([]);
const defaultId = ref('');
const downstreamDefaults = ref<Record<string, string>>({});
const connectionFilter = ref('');
const draft = ref<MessageFlow | null>(null);
const selectedId = ref('');
const selectedNode = ref('');
const savedSignature = ref('');
const busy = ref(false);
const error = ref('');
const notice = ref('');
const deleting = ref(false);
const addType = ref<OperatorAction['type']>('process');
const sample = ref('你好，请简单介绍自己。');
const sampleReply = ref('你好，很高兴认识你。');
const mockJson = ref('{}');
const result = ref<FlowRun | null>(null);
const simulatedState = ref<ConversationState>();
const nextState = ref<ConversationState>();
const round = ref(1);
const runs = ref<FlowRun[]>([]);
const runFilter = ref('');
const sessionFilter = ref(String(route.query.sessionKey ?? ''));
const detail = ref('');
const runError = ref('');
let timer: ReturnType<typeof setInterval> | undefined;
let active = true;
const dirty = computed(() => !selectedId.value || JSON.stringify(draft.value) !== savedSignature.value);
const node = computed(() => draft.value?.operators.find(n => n.id === selectedNode.value));
const shownFlows = computed(() => flows.value.filter(f => !connectionFilter.value || f.downstreamId === connectionFilter.value));
const connectionName = (id: string) => connections.value.find(c => c.id === id)?.name || id || '未选择连接';
const typeOptions = Object.entries(actionNames).map(([value, label]) => ({ value, label }));
const visibleRuns = computed(() => runs.value.filter(r => (!runFilter.value || r.flowId === runFilter.value) && (!sessionFilter.value || r.sessionKey === sessionFilter.value)));
watch(() => [JSON.stringify(draft.value), sample.value, sampleReply.value, mockJson.value], () => { result.value = null; nextState.value = undefined; });
watch(() => route.query.sessionKey, key => { sessionFilter.value = String(key ?? ''); });
function editable(f: MessageFlow): MessageFlow { return JSON.parse(JSON.stringify({ id: f.id, name: f.name, enabled: f.enabled, downstreamId: f.downstreamId, operators: f.operators })); }
function select(f: MessageFlow) {
    draft.value = editable(f); selectedId.value = f.id; savedSignature.value = JSON.stringify(draft.value);
    selectedNode.value = draft.value.operators[0]?.id ?? ''; result.value = null; simulatedState.value = undefined; nextState.value = undefined; round.value = 1; error.value = ''; notice.value = ''; deleting.value = false;
}
function create(example = false) {
    const operators = example ? [newOperator('process'), newOperator('call')] : [newOperator('input'), newOperator('call'), newOperator('reply')];
    if (example) {
        operators[0]!.name = '受理与确认'; operators[0]!.actions.push({ ...newAction('reply'), type: 'reply', text: '收到，正在处理你的消息。', stopAfter: false });
        operators[1]!.name = '调用、处理与返回'; const p = newAction('process'); if (p.type === 'process') p.prefix = '处理结果：'; operators[1]!.actions.push(p, newAction('reply'));
    }
    select({ id: '', name: example ? '先确认，再处理' : '', enabled: true, downstreamId: connectionFilter.value || connections.value.find(c => c.enabled)?.id || connections.value[0]?.id || '', operators }); selectedId.value = '';
}
function duplicateFlow() { if (!draft.value) return; const f = editable(draft.value); f.id = ''; f.name += ' · 副本'; select(f); selectedId.value = ''; }
function addOperator() { if (!draft.value) return; const op = newOperator(addType.value); draft.value.operators.push(op); selectedNode.value = op.id; }
function move<T>(list: T[], index: number, delta: number) { const next = index + delta; if (next >= 0 && next < list.length) [list[index], list[next]] = [list[next]!, list[index]!]; }
function duplicateNode(index: number) { if (!draft.value) return; const copy: FlowOperator = JSON.parse(JSON.stringify(draft.value.operators[index])); copy.id = newOperator('process').id; copy.name += ' · 副本'; draft.value.operators.splice(index + 1, 0, copy); selectedNode.value = copy.id; }
function removeNode(index: number) { if (!draft.value) return; draft.value.operators.splice(index, 1); if (!node.value) selectedNode.value = draft.value.operators[Math.min(index, draft.value.operators.length - 1)]?.id ?? ''; }
function changeType(index: number, type: string) { if (!node.value) return; const action = newAction(type as OperatorAction['type']); action.id = node.value.actions[index]!.id; node.value.actions[index] = action; }
async function load() {
    try {
        const [f, d] = await Promise.all([flowsApi.list(), api.downstreams()]);
        flows.value = f.flows; defaultId.value = f.defaultId; downstreamDefaults.value = f.downstreamDefaults;
        connections.value = d.registered.map(c => ({ id: c.id, name: c.name || c.id, enabled: c.enabled }));
        if (!draft.value) { const first = f.flows.find(f => f.id === defaultId.value) ?? f.flows[0]; if (first) select(first); else create(); }
    } catch (e) { error.value = String(e); }
}
async function loadRuns() { try { const r = await flowsApi.runs(); if (active) { runs.value = r.runs; runError.value = ''; } } catch (e) { if (active) runError.value = String(e); } }
onMounted(async () => { await load(); await loadRuns(); if (active) timer = setInterval(() => { if (!document.hidden) void loadRuns(); }, 3000); });
onUnmounted(() => { active = false; clearInterval(timer); });
async function save() {
    if (!draft.value) return; busy.value = true; error.value = ''; notice.value = '';
    try {
        if (!selectedId.value && flows.value.some(f => f.id === draft.value!.id)) throw new Error('流程 ID 已存在，请使用新的 ID');
        const saved = await flowsApi.save(draft.value); await load(); select(saved.flow); await store.refresh(); notice.value = '流程配置已保存，会话可以选择所属下游和这份配置。';
    } catch (e) { error.value = e instanceof Error ? e.message : String(e); } finally { busy.value = false; }
}
async function setDefault(global = false) {
    if (!draft.value || !selectedId.value) return; busy.value = true; error.value = ''; notice.value = '';
    try { if (global) await flowsApi.setDefault(selectedId.value); else await flowsApi.setDownstreamDefault(draft.value.downstreamId, selectedId.value); await load(); await store.refresh(); notice.value = global ? '已设为全局默认的下游与流程配置。' : '已设为该下游的默认流程配置。'; }
    catch (e) { error.value = String(e); } finally { busy.value = false; }
}
async function remove() {
    if (!selectedId.value) return; busy.value = true; error.value = '';
    try { await flowsApi.remove(selectedId.value); draft.value = null; deleting.value = false; await load(); await store.refresh(); }
    catch (e) { error.value = String(e); } finally { busy.value = false; }
}
async function preview() {
    if (!draft.value) return; busy.value = true; error.value = ''; result.value = null;
    try { const r = await flowsApi.preview({ ...draft.value, id: draft.value.id || 'preview_flow' }, sample.value, sampleReply.value, simulatedState.value, JSON.parse(mockJson.value)); result.value = r.run; nextState.value = r.ok ? r.state : undefined; await loadRuns(); }
    catch (e) { error.value = String(e); } finally { busy.value = false; }
}
async function test() {
    if (!selectedId.value || dirty.value) return; busy.value = true; error.value = ''; result.value = null;
    try { result.value = (await flowsApi.test(selectedId.value, sample.value)).run; nextState.value = undefined; await loadRuns(); }
    catch (e) { error.value = String(e); } finally { busy.value = false; }
}
function exportFile() {
    if (!draft.value) return;
    const blob = new Blob([JSON.stringify(editable(draft.value), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `${draft.value.id || 'flow'}.json`; link.click(); URL.revokeObjectURL(url);
}
async function importFile(event: Event) {
    const input = event.target as HTMLInputElement; const file = input.files?.[0]; if (!file) return;
    try {
        if (file.size > 512000) throw new Error('流程文件最多 512 KB');
        const value = JSON.parse(await file.text());
        if (!value || !Array.isArray(value.operators) || typeof value.downstreamId !== 'string') throw new Error('请选择包含 operators 和 downstreamId 的流程文件');
        const parsed = (await flowsApi.validate(value)).flow;
        if (flows.value.some(f => f.id === parsed.id)) parsed.id = '';
        select(parsed); selectedId.value = ''; notice.value = '文件已载入编辑区，操作参数校验通过。';
    } catch (e) { error.value = String(e); } finally { input.value = ''; }
}
</script>
<template>
    <div class="flex flex-col gap-5">
        <UiCard class="space-y-3 p-5 sm:p-6"><h2 class="text-lg font-semibold">用算子编排下游的流程配置</h2><p class="text-sm leading-6 text-muted-foreground">每个算子都能读取、处理、调用服务或返回 QQ。操作按列表顺序执行，算子可自由增删、复制和排序；回复可以出现在任意位置。</p><div class="flex flex-wrap items-center gap-4 text-xs text-primary"><RouterLink to="/sessions">选择下游与流程配置 →</RouterLink><RouterLink to="/downstreams">管理连接 →</RouterLink><button type="button" :disabled="busy" @click="create(true)">载入“先确认，再处理”示例</button></div></UiCard>
        <p v-if="error" role="alert" class="rounded-lg bg-destructive/10 p-4 text-sm text-destructive">{{ error }}</p><p v-if="notice" role="status" class="text-sm text-success">{{ notice }}</p>
        <div class="grid items-start gap-5 xl:grid-cols-[220px_minmax(0,1fr)]">
            <UiCard class="space-y-3 p-4"><div class="flex items-center justify-between"><h3 class="text-sm font-semibold">流程配置</h3><UiButton size="sm" :disabled="busy" @click="create()">新建</UiButton></div><UiSelect v-model="connectionFilter" aria-label="筛选所属下游" :options="[{ value: '', label: '全部下游' }, ...connections.map(c => ({ value: c.id, label: c.name }))]" /><button v-for="f in shownFlows" :key="f.id" type="button" :disabled="busy" class="w-full space-y-2 rounded-xl border p-3 text-left transition-colors" :class="selectedId === f.id ? 'border-primary/40 bg-primary/5' : 'border-border hover:bg-muted'" @click="select(f)"><span class="block break-words text-sm font-medium">{{ f.name }}</span><span class="block break-words text-xs text-muted-foreground">{{ connectionName(f.downstreamId) }} · {{ f.operators.length }} 个算子</span><span class="block text-[11px] text-muted-foreground">{{ f.id === defaultId ? '全局默认 · ' : downstreamDefaults[f.downstreamId] === f.id ? '下游默认 · ' : '' }}{{ f.compatibility ? '旧配置迁移 · ' : '' }}{{ f.enabled ? '启用' : '停用' }}</span></button><p v-if="!shownFlows.length" class="py-3 text-xs text-muted-foreground">该下游还没有流程配置，点击新建。</p></UiCard>
            <UiCard v-if="draft" class="min-w-0 space-y-5 p-5 sm:p-6">
                <div class="grid gap-3 md:grid-cols-2"><label class="space-y-2 text-xs">配置 ID<UiInput v-model="draft.id" :disabled="busy || !!selectedId" placeholder="例如 daily_chat" /></label><label class="space-y-2 text-xs">配置名称<UiInput v-model="draft.name" :disabled="busy" placeholder="例如 日常聊天" /></label></div>
                <div class="flex flex-wrap items-end gap-4"><label class="min-w-48 flex-1 space-y-2 text-xs">所属下游<UiSelect v-model="draft.downstreamId" :disabled="busy || !!selectedId" :options="connections.map(c => ({ value: c.id, label: `${c.name}${c.enabled ? '' : '（停用）'}` }))" /></label><label class="flex items-center gap-2 pb-2 text-xs"><UiSwitch v-model="draft.enabled" :disabled="busy" aria-label="启用流程配置" />启用</label></div>
                <div class="flex flex-wrap items-center justify-between gap-3"><h3 class="text-sm font-semibold">算子编排 · {{ draft.operators.length }} 个</h3><span class="text-xs text-muted-foreground">{{ dirty ? '有未保存修改' : '已加载保存定义' }}</span></div>
                <div class="flex gap-3 overflow-x-auto pb-3" aria-label="算子编排">
                    <div v-for="(operator, i) in draft.operators" :key="operator.id" class="relative w-52 shrink-0 rounded-xl border transition-colors" :class="selectedNode === operator.id ? 'border-primary bg-primary/5 ring-1 ring-primary/15' : 'border-border bg-muted/15'"><button type="button" class="w-full space-y-3 p-4 text-left" :aria-label="`编辑算子 ${i + 1} ${operator.name}`" @click="selectedNode = operator.id"><div class="flex items-center justify-between text-primary"><Boxes class="size-4" /><span class="text-[10px]">{{ i + 1 }} · {{ operator.enabled ? '启用' : '停用' }}</span></div><p class="break-words text-sm font-semibold">{{ operator.name }}</p><p class="break-words text-xs leading-5 text-muted-foreground">{{ operator.actions.map(a => actionNames[a.type]).join(' → ') }}</p></button><div class="flex justify-between border-t border-border px-2 py-1"><UiButton size="sm" variant="ghost" :disabled="busy || i === 0" :aria-label="`前移算子 ${i + 1}`" @click="move(draft.operators, i, -1)"><ArrowUp class="size-3.5" /></UiButton><UiButton size="sm" variant="ghost" :disabled="busy || i === draft.operators.length - 1" :aria-label="`后移算子 ${i + 1}`" @click="move(draft.operators, i, 1)"><ArrowDown class="size-3.5" /></UiButton><UiButton size="sm" variant="ghost" :disabled="busy || draft.operators.length >= 32" :aria-label="`复制算子 ${i + 1}`" @click="duplicateNode(i)"><Copy class="size-3.5" /></UiButton><UiButton size="sm" variant="ghost" :disabled="busy" :aria-label="`移除算子 ${i + 1}`" @click="removeNode(i)"><Trash2 class="size-3.5" /></UiButton></div><ArrowRight v-if="i < draft.operators.length - 1" class="absolute -right-2.5 top-1/2 z-10 size-4 text-muted-foreground" /></div>
                </div>
                <div class="flex flex-wrap gap-2"><UiSelect v-model="addType" aria-label="新算子的首个操作" class="max-w-44" :options="typeOptions" /><UiButton variant="outline" :disabled="busy || draft.operators.length >= 32" @click="addOperator"><Plus class="size-4" />添加算子</UiButton></div>
                <div v-if="node" class="space-y-4 rounded-xl border border-border bg-muted/10 p-4 sm:p-5">
                    <div class="grid gap-3 sm:grid-cols-2"><label class="space-y-2 text-xs">算子名称<UiInput v-model="node.name" :disabled="busy" /></label><label class="space-y-2 text-xs">算子 ID（用于数据引用）<UiInput :model-value="node.id" :disabled="busy" @update:model-value="(v: string | number) => { node!.id = String(v); selectedNode = String(v); }" /></label></div><label class="flex items-center gap-2 text-xs"><UiSwitch v-model="node.enabled" :disabled="busy" aria-label="启用所选算子" />启用该算子</label>
                    <div v-for="(action, i) in node.actions" :key="action.id" class="space-y-4 rounded-xl border border-border bg-background p-4"><div class="flex flex-wrap items-center justify-between gap-2"><div class="flex min-w-0 items-center gap-2"><span class="text-xs text-muted-foreground">{{ i + 1 }}</span><UiSelect :model-value="action.type" :disabled="busy" class="max-w-40" :aria-label="`操作 ${i + 1} 类型`" :options="typeOptions" @update:model-value="(v: string) => changeType(i, v)" /></div><div class="flex gap-1"><UiButton variant="ghost" size="sm" :disabled="busy || i === 0" :aria-label="`前移操作 ${i + 1}`" @click="move(node.actions, i, -1)"><ArrowUp class="size-3.5" /></UiButton><UiButton variant="ghost" size="sm" :disabled="busy || i === node.actions.length - 1" :aria-label="`后移操作 ${i + 1}`" @click="move(node.actions, i, 1)"><ArrowDown class="size-3.5" /></UiButton><UiButton variant="ghost" size="sm" :disabled="busy || node.actions.length === 1" :aria-label="`移除操作 ${i + 1}`" @click="node.actions.splice(i, 1)"><Trash2 class="size-3.5" /></UiButton></div></div><OperatorActionEditor :action="action" :operator-id="node.id" :connections="connections" :disabled="busy" /><p class="break-all font-mono text-[10px] text-muted-foreground">{{ node.id }}.{{ action.id }}</p></div>
                    <div class="flex flex-wrap gap-2"><UiButton v-for="option in typeOptions" :key="option.value" variant="outline" size="sm" :disabled="busy || node.actions.length >= 16" @click="node.actions.push(newAction(option.value as OperatorAction['type']))">+ {{ option.label }}</UiButton></div>
                </div>
                <details class="rounded-lg bg-muted/30 p-4 text-xs"><summary class="cursor-pointer font-medium">算子之间如何引用数据</summary><div class="mt-3 space-y-2 break-all leading-5 text-muted-foreground"><p v-text="'{{text}} 当前文本 · {{system}} 当前提示词'" /><p v-text="'{{message.upstream}} QQ 原文 · {{message.downstream}} 最近一次服务回复'" /><p v-text="'{{operators.算子ID.output}} 已执行算子输出 · {{operators.算子ID.extracted.名称}} 提取值'" /><p v-text="'{{extracted.名称}} 本算子提取值 · {{history.算子ID.extracted.名称}} 上次保存的提取值'" /><p v-text="'{{vars.变量名}} 单会话持久变量 · {{history.算子ID.output}} 上次保存的算子输出'" /><p>仅可读取本次已产生的数据；之后才执行的结果可在下一轮通过 history 或变量引用。历史输入输出每项最多保留 4000 字。修改算子 ID 后需同步修改引用。</p></div></details>
                <p v-if="flows.find(f => f.id === selectedId)?.compatibility" class="text-xs leading-5 text-warning">旧配置已展开为可编辑算子。保存后处理参数直接属于流程，不再依赖原会话配置。</p>
                <div class="flex flex-wrap gap-2"><UiButton :disabled="busy || !draft.operators.length" @click="save">保存流程配置</UiButton><UiButton variant="outline" :disabled="busy || !selectedId || dirty || !draft.enabled" @click="setDefault()">设为下游默认</UiButton><UiButton variant="outline" :disabled="busy || !selectedId || dirty || !draft.enabled" @click="setDefault(true)">设为全局默认</UiButton><UiButton variant="ghost" :disabled="busy" @click="duplicateFlow">复制配置</UiButton><UiButton variant="ghost" :disabled="busy" @click="exportFile">导出 JSON</UiButton><label class="inline-flex cursor-pointer items-center px-3 text-xs text-primary">导入 JSON<input type="file" accept=".json,application/json" :disabled="busy" class="sr-only" aria-label="导入流程文件" @change="importFile" /></label><UiButton v-if="selectedId && !flows.find(f => f.id === selectedId)?.virtual" variant="ghost" :disabled="busy" @click="deleting = true">删除</UiButton></div>
                <div v-if="deleting" class="flex flex-wrap items-center gap-3 rounded-lg bg-muted p-3 text-xs"><span>被会话或默认值引用的配置不能删除。</span><UiButton size="sm" variant="destructive" :disabled="busy" @click="remove">确认删除</UiButton><UiButton size="sm" variant="ghost" @click="deleting = false">取消</UiButton></div>
            </UiCard>
        </div>
        <UiCard v-if="draft" class="space-y-4 p-5"><h3 class="font-semibold">执行与调试</h3><div class="grid gap-4 md:grid-cols-2"><label class="space-y-2 text-xs">输入消息<UiInput v-model="sample" :disabled="busy" /></label><label class="space-y-2 text-xs">默认模拟服务回复<UiInput v-model="sampleReply" :disabled="busy" /></label></div><details class="text-xs"><summary class="cursor-pointer text-muted-foreground">为多个调用分别设置模拟回复</summary><p class="my-2 leading-5 text-muted-foreground">填写 JSON 对象，键为调用操作底部的“算子ID.操作ID”，值为模拟回复文本。未填写的调用使用默认模拟回复。</p><textarea v-model="mockJson" :disabled="busy" rows="4" aria-label="多调用模拟回复映射" class="w-full rounded-lg border border-input bg-background p-3 font-mono text-xs" /></details><div class="flex flex-wrap gap-2"><UiButton variant="outline" :disabled="busy || !draft.operators.length" @click="preview">模拟执行 · 第 {{ round }} 轮</UiButton><UiButton variant="outline" :disabled="busy || !selectedId || dirty || !sample.trim()" @click="test">真实调用已保存配置</UiButton><UiButton v-if="nextState" variant="ghost" :disabled="busy" @click="simulatedState = nextState; nextState = undefined; round++; result = null">沿用模拟状态进入下一轮</UiButton><UiButton variant="ghost" :disabled="busy" @click="simulatedState = undefined; nextState = undefined; round = 1; result = null">重置模拟状态</UiButton></div><p class="text-xs leading-5 text-muted-foreground">模拟执行不访问外部服务。真实测试使用独立服务会话，会执行流程中所有调用。两者的返回操作都只展示结果，不发送 QQ、不写真实会话变量。</p><FlowRunDetails v-if="result" :run="result" /></UiCard>
        <UiCard class="space-y-4 p-5"><div class="flex flex-wrap items-center justify-between gap-3"><div><h3 class="font-semibold">最近执行</h3><p class="mt-1 text-xs text-muted-foreground">当前进程保留最近 50 次；正文记录最多 4096 字。</p></div><UiSelect v-model="runFilter" aria-label="筛选执行流程" class="max-w-xs" :options="[{ value: '', label: '全部流程配置' }, ...flows.map(f => ({ value: f.id, label: f.name }))]" /></div><p v-if="sessionFilter" class="break-all text-xs text-muted-foreground">会话 {{ sessionFilter }} <button type="button" class="ml-2 text-primary" @click="sessionFilter = ''">清除筛选</button></p><p v-if="runError" role="alert" class="text-xs text-warning">{{ runError }}</p><p v-if="!visibleRuns.length" class="py-5 text-sm text-muted-foreground">执行后可展开查看每个算子和操作的结果。</p><div v-for="run in visibleRuns" :key="run.id" class="rounded-xl border border-border p-4"><button type="button" class="flex w-full flex-wrap items-center justify-between gap-3 text-left text-xs" @click="detail = detail === run.id ? '' : run.id"><span class="font-medium">{{ run.flowName }}</span><span class="break-all text-muted-foreground">{{ run.sessionKey }} · {{ run.mode === 'live' ? 'QQ 消息' : run.mode === 'preview' ? '模拟' : '真实测试' }}</span><span :class="run.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'">{{ run.status === 'failed' ? '失败' : run.status === 'running' ? '执行中' : '完成' }} · {{ run.elapsedMs }} ms</span></button><FlowRunDetails v-if="detail === run.id" class="mt-4" :run="run" /></div></UiCard>
    </div>
</template>
