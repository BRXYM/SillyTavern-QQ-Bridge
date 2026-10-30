<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ArrowRight, Boxes, SlidersHorizontal, MessageSquare, Send } from 'lucide-vue-next';
import { api } from '@/api/client';
import { flowsApi, type MessageFlow, type FlowRun } from '@/api/flows';
import { conversationsApi, type ConversationProfile, type ConversationState } from '@/api/conversations';
import { useStatusStore } from '@/stores/status';
import UiCard from '@/components/ui/UiCard.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiInput from '@/components/ui/UiInput.vue';
import UiSelect from '@/components/ui/UiSelect.vue';
import UiSwitch from '@/components/ui/UiSwitch.vue';
import FlowRunDetails from '@/components/FlowRunDetails.vue';
const store = useStatusStore();
const route = useRoute();
const sessionFilter = ref(String(route.query.sessionKey ?? ''));
const flows = ref<MessageFlow[]>([]);
const connections = ref<Array<{ id: string; name: string; enabled: boolean }>>([]);
const profiles = ref<ConversationProfile[]>([]);
const defaultId = ref('');
const draft = ref<MessageFlow | null>(null);
const selectedId = ref('');
const step = ref('call');
const savedSignature = ref('');
const busy = ref(false);
const error = ref('');
const notice = ref('');
const deleting = ref('');
const sample = ref('你好，请简单介绍自己。');
const sampleReply = ref('你好，很高兴认识你。');
const result = ref<FlowRun | null>(null);
const simulatedState = ref<ConversationState | undefined>();
const nextState = ref<ConversationState | undefined>();
const round = ref(1);
const runs = ref<FlowRun[]>([]);
const runFilter = ref('');
const detail = ref('');
const runError = ref('');
let timer: ReturnType<typeof setInterval> | undefined;
const dirty = computed(() => JSON.stringify(draft.value) !== savedSignature.value);
const legacyView = computed(() => !dirty.value && flows.value.find(f => f.id === selectedId.value)?.legacyPreserveBehavior);
watch(() => [JSON.stringify(draft.value), sample.value, sampleReply.value], () => { result.value = null; nextState.value = undefined; });
const connectionName = (id: string) => connections.value.find(c => c.id === id)?.name || id || '未选择连接';
const profileName = (id: string) => profiles.value.find(p => p.id === id)?.name || id || '不做消息处理';
const nodes = computed(() => draft.value ? [
    { id: 'upstream', name: '上游处理', desc: draft.value.upstreamEnabled ? legacyView.value ? '沿用原消息处理' : profileName(draft.value.conversationId) : '原样传递 QQ 消息', enabled: draft.value.upstreamEnabled, icon: SlidersHorizontal },
    { id: 'call', name: '调用下游', desc: connectionName(draft.value.downstreamId), enabled: true, icon: Boxes },
    { id: 'downstream', name: '下游处理', desc: draft.value.downstreamEnabled ? legacyView.value ? '沿用原回复处理' : profileName(draft.value.conversationId) : '原样返回服务回复', enabled: draft.value.downstreamEnabled, icon: MessageSquare },
    { id: 'reply', name: '回复 QQ', desc: '从收到消息的原账号回复', enabled: true, icon: Send },
] : []);
const visibleRuns = computed(() => runs.value.filter(r => (!runFilter.value || r.flowId === runFilter.value) && (!sessionFilter.value || r.sessionKey === sessionFilter.value)));
function editable(f: MessageFlow): MessageFlow { return { id: f.id, name: f.name, enabled: f.enabled, downstreamId: f.downstreamId, conversationId: f.conversationId, upstreamEnabled: f.upstreamEnabled, downstreamEnabled: f.downstreamEnabled }; }
function select(f: MessageFlow) { draft.value = editable(f); selectedId.value = f.id; savedSignature.value = JSON.stringify(draft.value); step.value = 'call'; result.value = null; simulatedState.value = undefined; nextState.value = undefined; round.value = 1; error.value = ''; notice.value = ''; }
function create() { select({ id: '', name: '', enabled: true, downstreamId: connections.value.find(c => c.enabled)?.id ?? connections.value[0]?.id ?? '', conversationId: '', upstreamEnabled: false, downstreamEnabled: false }); selectedId.value = ''; }
async function load() {
    try {
        const [f, d, p] = await Promise.all([flowsApi.list(), api.downstreams(), conversationsApi.list()]);
        flows.value = f.flows; defaultId.value = f.defaultId; connections.value = d.registered.map(c => ({ id: c.id, name: c.name || c.id, enabled: c.enabled })); profiles.value = p.profiles;
        if (!draft.value) { if (f.flows.length) select(f.flows.find(f => f.id === defaultId.value) ?? f.flows[0]!); else create(); }
    } catch (e) { error.value = String(e); }
}
async function loadRuns() { try { runs.value = (await flowsApi.runs()).runs; runError.value = ''; } catch (e) { runError.value = String(e); } }
onMounted(async () => { await load(); await loadRuns(); timer = setInterval(() => { if (!document.hidden) void loadRuns(); }, 3000); });
onUnmounted(() => clearInterval(timer));
async function save() {
    if (!draft.value) return; busy.value = true; error.value = ''; notice.value = '';
    try {
        if (!selectedId.value && flows.value.some(f => f.id === draft.value!.id)) throw new Error('流程 ID 已存在');
        const saved = await flowsApi.save(draft.value); await load(); select(saved.flow); await store.refresh(); notice.value = '流程已保存，会话可直接选择使用。';
    } catch (e) { error.value = e instanceof Error ? e.message : String(e); }
    finally { busy.value = false; }
}
async function setDefault(f: MessageFlow) {
    busy.value = true; error.value = ''; notice.value = '';
    try { await flowsApi.setDefault(f.id); await load(); await store.refresh(); notice.value = '已设为默认流程，继承默认的会话立即采用。'; }
    catch (e) { error.value = String(e); } finally { busy.value = false; }
}
async function remove(f: MessageFlow) {
    busy.value = true; error.value = '';
    try { await flowsApi.remove(f.id); deleting.value = ''; if (selectedId.value === f.id) draft.value = null; await load(); await store.refresh(); }
    catch (e) { error.value = String(e); } finally { busy.value = false; }
}
async function preview() {
    if (!draft.value) return; busy.value = true; error.value = ''; result.value = null;
    try { const r = await flowsApi.preview({ ...draft.value, id: draft.value.id || 'preview_flow' }, sample.value, sampleReply.value, simulatedState.value); result.value = r.run; nextState.value = r.ok ? r.state : undefined; await loadRuns(); }
    catch (e) { error.value = String(e); } finally { busy.value = false; }
}
async function test() {
    if (!selectedId.value || dirty.value) return; busy.value = true; error.value = ''; result.value = null;
    try { result.value = (await flowsApi.test(selectedId.value, sample.value)).run; nextState.value = undefined; await loadRuns(); }
    catch (e) { error.value = String(e); } finally { busy.value = false; }
}
</script>
<template>
    <div class="flex flex-col gap-5">
        <UiCard class="space-y-3 p-5 sm:p-6"><h2 class="text-lg font-semibold">把连接和配置组合成消息流程</h2><p class="text-sm leading-6 text-muted-foreground">固定四个步骤，点击卡片查看设置。连接与会话配置可复用；会话只需要选择流程。</p><div class="flex flex-wrap gap-4 text-xs text-primary"><RouterLink to="/sessions">为会话选择流程 →</RouterLink><RouterLink to="/downstreams">管理连接 →</RouterLink><RouterLink to="/profiles">编辑处理配置 →</RouterLink></div></UiCard>
        <p v-if="error" role="alert" class="rounded-lg bg-destructive/10 p-4 text-sm text-destructive">{{ error }}</p><p v-if="notice" role="status" class="text-sm text-success">{{ notice }}</p>
        <div class="grid items-start gap-5 xl:grid-cols-[250px_minmax(0,1fr)]">
            <UiCard class="space-y-3 p-4"><div class="flex items-center justify-between gap-2"><h3 class="text-sm font-semibold">我的流程</h3><UiButton size="sm" :disabled="busy" @click="create">新建</UiButton></div>
                <button v-for="f in flows" :key="f.id" type="button" :disabled="busy" class="w-full rounded-xl border p-3 text-left transition-colors" :class="selectedId === f.id ? 'border-primary/40 bg-primary/5' : 'border-border hover:bg-muted'" @click="select(f)"><span class="block break-words text-sm font-medium">{{ f.name }}</span><span class="mt-1 block break-all font-mono text-[10px] text-muted-foreground">{{ f.id }}</span><span class="mt-2 block text-xs text-muted-foreground">{{ f.id === defaultId ? '默认 · ' : '' }}{{ f.compatibility ? '旧绑定兼容 · ' : '' }}{{ f.enabled ? '启用' : '停用' }} · {{ f.references ?? 0 }} 个会话</span></button>
                <p v-if="!flows.length" class="text-xs text-muted-foreground">创建第一个流程，选择连接和处理配置。</p>
            </UiCard>
            <UiCard v-if="draft" class="min-w-0 space-y-5 p-5 sm:p-6">
                <div class="grid gap-3 md:grid-cols-2"><label class="space-y-2 text-xs">流程 ID<UiInput v-model="draft.id" :disabled="busy || !!selectedId" placeholder="例如 daily_chat" /></label><label class="space-y-2 text-xs">流程名称<UiInput v-model="draft.name" :disabled="busy" placeholder="例如 日常聊天" /></label></div>
                <div class="flex flex-wrap items-center justify-between gap-3"><label class="flex items-center gap-3 text-xs"><UiSwitch v-model="draft.enabled" :disabled="busy" />启用流程</label><span class="text-xs text-muted-foreground">{{ dirty ? '有未保存修改' : '已加载保存的定义' }}</span></div>
                <div class="grid gap-2 md:grid-cols-4" aria-label="消息流程步骤">
                    <button v-for="(node, index) in nodes" :key="node.id" type="button" class="relative min-w-0 space-y-3 rounded-xl border p-4 text-left" :class="step === node.id ? 'border-primary bg-primary/5 ring-1 ring-primary/15' : 'border-border bg-muted/15'" @click="step = node.id"><div class="flex items-center justify-between"><component :is="node.icon" class="size-4 text-primary" /><span class="text-[10px] text-muted-foreground">{{ index + 1 }}</span></div><p class="text-sm font-semibold">{{ node.name }}</p><p class="break-words text-xs leading-5 text-muted-foreground">{{ node.desc }}</p><p class="text-[10px] text-muted-foreground">{{ node.enabled ? '执行' : '跳过处理' }}</p><ArrowRight v-if="index < 3" class="absolute -right-2.5 top-1/2 z-10 hidden size-4 text-muted-foreground md:block" /></button>
                </div>
                <div class="space-y-4 rounded-xl border border-border bg-muted/15 p-4">
                    <template v-if="step === 'call'"><h4 class="text-sm font-medium">调用哪个服务</h4><UiSelect v-model="draft.downstreamId" :disabled="busy" aria-label="流程下游连接" :options="connections.map(c => ({ value: c.id, label: `${c.name} · ${c.id}${c.enabled ? '' : '（已停用）'}` }))" /><p class="text-xs text-muted-foreground">这里只引用已配置的连接。地址、协议和认证在下游连接中维护。</p></template>
                    <template v-else-if="step === 'upstream' || step === 'downstream'"><div class="flex items-center justify-between gap-3"><h4 class="text-sm font-medium">{{ step === 'upstream' ? 'QQ → 服务：上游处理' : '服务 → QQ：下游处理' }}</h4><UiSwitch v-if="step === 'upstream'" v-model="draft.upstreamEnabled" :disabled="busy" /><UiSwitch v-else v-model="draft.downstreamEnabled" :disabled="busy" /></div><label class="block space-y-2 text-xs">共用的会话配置<UiSelect :model-value="draft.conversationId" :disabled="busy" :options="[{ value: '', label: '不使用会话配置' }, ...profiles.map(p => ({ value: p.id, label: p.name }))]" @update:model-value="(v: string) => { draft!.conversationId = v; draft!.upstreamEnabled = !!v; draft!.downstreamEnabled = !!v; }" /></label><p class="text-xs text-muted-foreground">同一配置包含上游和下游两个区域，各步骤只执行对应区域。变量仍然属于单个会话。</p><RouterLink to="/profiles" class="inline-block text-xs text-primary">编辑配置中的提示词、提取规则与变量 →</RouterLink></template>
                    <template v-else><h4 class="text-sm font-medium">回复原 QQ 会话</h4><p class="text-xs leading-6 text-muted-foreground">从收到消息的原账号回复到原私聊或群聊。保留现有分段、节奏和媒体转换；投递失败会记录，不自动重发。</p></template>
                </div>
                <p v-if="flows.find(f => f.id === selectedId)?.compatibility" class="text-xs leading-5 text-warning">这是旧绑定生成的兼容流程。未修改时预览沿用原处理方式。编辑保存时请选择处理配置或关闭对应步骤；连接未改变时保留旧协议覆盖。</p>
                <div class="flex flex-wrap gap-2"><UiButton :disabled="busy" @click="save">保存流程</UiButton><UiButton variant="outline" :disabled="busy || !selectedId || dirty || !draft.enabled" @click="setDefault(draft)">设为默认流程</UiButton><UiButton v-if="selectedId && !flows.find(f => f.id === selectedId)?.compatibility" variant="ghost" :disabled="busy" @click="deleting = selectedId">删除</UiButton></div>
                <div v-if="deleting && deleting === selectedId" class="flex flex-wrap items-center gap-3 rounded-lg bg-muted p-3 text-xs"><span>被会话或默认设置引用的流程不能删除。</span><UiButton variant="destructive" size="sm" :disabled="busy" @click="remove(draft)">确认删除</UiButton><UiButton variant="ghost" size="sm" :disabled="busy" @click="deleting = ''">取消</UiButton></div>
            </UiCard>
        </div>
        <UiCard v-if="draft" class="space-y-4 p-5"><h3 class="font-semibold">运行与预览</h3><div class="grid gap-4 md:grid-cols-2"><label class="space-y-2 text-xs">QQ 输入 / 真实调用测试消息<UiInput v-model="sample" :disabled="busy" /></label><label class="space-y-2 text-xs">模拟下游回复（仅预览使用）<UiInput v-model="sampleReply" :disabled="busy" /></label></div><div class="flex flex-wrap gap-2"><UiButton variant="outline" :disabled="busy" @click="preview">模拟执行 · 第 {{ round }} 轮</UiButton><UiButton variant="outline" :disabled="busy || !selectedId || dirty || !sample.trim()" @click="test">真实调用已保存流程</UiButton><UiButton v-if="nextState" variant="ghost" :disabled="busy" @click="simulatedState = nextState; nextState = undefined; round++; result = null">沿用模拟状态进入下一轮</UiButton><UiButton variant="ghost" :disabled="busy" @click="simulatedState = undefined; nextState = undefined; round = 1; result = null">重置模拟状态</UiButton></div><p class="text-xs leading-5 text-muted-foreground">模拟执行不访问下游。真实测试会调用外部服务，使用独立会话标识。两者都不发送 QQ，也不修改真实会话变量；编辑后需先保存才能真实调用。</p><FlowRunDetails v-if="result" :run="result" /></UiCard>
        <UiCard class="space-y-4 p-5"><div class="flex flex-wrap items-center justify-between gap-3"><div><h3 class="font-semibold">最近执行</h3><p class="mt-1 text-xs text-muted-foreground">保留当前进程最近 50 次执行，重启清空；正文最多记录 4096 字，不记录连接凭据。</p></div><UiSelect v-model="runFilter" aria-label="筛选执行流程" class="max-w-xs" :options="[{ value: '', label: '全部流程' }, ...flows.map(f => ({ value: f.id, label: f.name }))]" /></div><p v-if="sessionFilter" class="break-all text-xs text-muted-foreground">仅查看会话 {{ sessionFilter }} <button type="button" class="ml-2 text-primary" @click="sessionFilter = ''">清除</button></p><p v-if="runError" role="alert" class="text-xs text-warning">{{ runError }}</p><p v-if="!visibleRuns.length" class="py-5 text-sm text-muted-foreground">模拟执行、真实测试或 QQ 收到消息后，步骤记录会出现在这里。</p><div v-for="run in visibleRuns" :key="run.id" class="rounded-xl border border-border p-4"><button type="button" class="flex w-full flex-wrap items-center justify-between gap-3 text-left text-xs" @click="detail = detail === run.id ? '' : run.id"><span class="font-medium">{{ run.flowName }}</span><span class="break-all text-muted-foreground">{{ run.sessionKey }} · {{ run.mode === 'live' ? 'QQ 消息' : run.mode === 'preview' ? '模拟' : '真实测试' }}</span><span :class="run.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'">{{ run.status === 'failed' ? '失败' : run.status === 'running' ? '执行中' : run.status === 'filtered' ? '未发送' : '完成' }} · {{ run.elapsedMs }} ms</span></button><FlowRunDetails v-if="detail === run.id" class="mt-4" :run="run" /></div></UiCard>
    </div>
</template>
