<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { api, type DownstreamProfileDto } from '@/api/client';
import { useStatusStore } from '@/stores/status';
import { useToastStore } from '@/stores/toast';
import UiCard from '@/components/ui/UiCard.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiInput from '@/components/ui/UiInput.vue';
import UiSelect from '@/components/ui/UiSelect.vue';

const store = useStatusStore();
const toast = useToastStore();
type Connection = Awaited<ReturnType<typeof api.downstreams>>['registered'][number];
const connections = ref<Connection[]>([]);
const selected = ref('');
const current = computed(() => connections.value.find(d => d.id === selected.value));
const draft = ref<{ id: string; name: string; json: string } | null>(null);
const editing = ref(false);
const busy = ref(false);
const error = ref('');
const result = ref('');
const testText = ref('你好，请简短介绍你的用途。');
const confirmDelete = ref('');
watch(selected, () => { draft.value = null; error.value = ''; result.value = ''; confirmDelete.value = ''; });
async function load() {
    try {
        connections.value = (await api.downstreams()).registered;
        if (!connections.value.some(d => d.id === selected.value)) selected.value = connections.value[0]?.id ?? '';
        await store.refresh();
    } catch (e) { error.value = String(e); }
}
onMounted(load);
function edit(profile?: DownstreamProfileDto) {
    editing.value = !!profile;
    const initial = current.value?.kind === 'http-json'
        ? { systemPrompt: current.value.settings.systemPrompt ?? '', requestBody: current.value.settings.requestBody ?? { message: '{{input.text}}', session_id: '{{input.sessionKey}}' } }
        : current.value?.kind.startsWith('dsh')
            ? { prompt: { extra: '' }, historyExtracts: [], progress: { enabled: false } }
            : { character: '', world: '' };
    draft.value = { id: profile?.id ?? '', name: profile?.name ?? '', json: JSON.stringify(profile?.settings ?? initial, null, 2) };
    error.value = ''; result.value = ''; confirmDelete.value = '';
}
async function save() {
    if (!draft.value || busy.value) return;
    busy.value = true; error.value = '';
    try {
        const settings: unknown = JSON.parse(draft.value.json);
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('配置须为 JSON 对象');
        if (!editing.value && current.value?.profiles?.some(p => p.id === draft.value!.id)) throw new Error('配置 ID 已存在，请更换 ID');
        await api.saveDownstreamProfile(selected.value, { id: draft.value.id, name: draft.value.name, settings: settings as Record<string, unknown> });
        draft.value = null;
        await load(); toast.success('对话配置已保存', '使用这份配置的会话将采用更新后的设置');
    } catch (e) { error.value = e instanceof Error ? e.message : String(e); }
    finally { busy.value = false; }
}
async function remove(id: string) {
    busy.value = true; error.value = '';
    try {
        const r = await api.deleteDownstreamProfile(selected.value, id);
        confirmDelete.value = ''; await load();
        toast.info('配置已删除', `${r.affectedSessions ?? 0} 个会话恢复继承`);
    } catch (e) { error.value = String(e); }
    finally { busy.value = false; }
}
async function test(id: string) {
    busy.value = true; error.value = ''; result.value = '';
    try {
        const r = await api.testDownstream(selected.value, { profileId: id, text: testText.value, sessionKey: `profile_${selected.value}_${id}` });
        if (!r.ok) throw new Error(r.error || '调用失败');
        result.value = `${(r.elapsedMs / 1000).toFixed(1)} 秒 · ${r.text}`;
    } catch (e) { error.value = e instanceof Error ? e.message : String(e); }
    finally { busy.value = false; }
}
function usage(id: string) {
    return Object.values(store.status?.sessionBackends ?? {}).filter(s => s.backendId === selected.value && s.profileId === id).length;
}
</script>

<template>
    <div class="flex flex-col gap-5">
        <UiCard class="p-5 sm:p-6">
            <h2 class="text-lg font-semibold">为同一个服务，定义不同的对话方式</h2>
            <p class="mt-2 text-sm leading-6 text-muted-foreground">先选择下游，再管理它的对话配置。连接地址与认证在「下游连接」中维护；会话在「会话与路由」中选择配置。</p>
            <label for="profile-connection" class="mb-2 mt-5 block text-xs font-medium">所属下游连接</label>
            <UiSelect id="profile-connection" v-model="selected" :disabled="busy" :options="connections.map(d => ({ value: d.id, label: `${d.name || d.id} · ${d.id}` }))" />
            <div class="mt-4 flex flex-wrap gap-4 text-xs text-muted-foreground">
                <span>{{ current?.profiles?.length ?? 0 }} 份对话配置</span>
                <span>{{ current?.kind ?? '尚无下游' }}</span>
                <RouterLink to="/downstreams" class="text-primary">管理连接 →</RouterLink>
                <RouterLink to="/sessions" class="text-primary">绑定会话 →</RouterLink>
            </div>
        </UiCard>
        <p v-if="error" role="alert" class="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{{ error }}</p>
        <div class="flex flex-wrap items-center justify-between gap-3">
            <h3 class="font-semibold">{{ current?.name || current?.id || '对话配置' }}</h3>
            <div class="flex gap-2">
                <UiButton variant="outline" size="sm" :disabled="busy || !!draft" @click="load">刷新</UiButton>
                <UiButton size="sm" :disabled="!current || busy" @click="edit()">新建对话配置</UiButton>
            </div>
        </div>
        <UiCard v-if="draft" class="space-y-4 p-5">
            <h3 class="font-medium">{{ editing ? '编辑配置' : '新建配置' }}</h3>
            <div class="grid gap-3 sm:grid-cols-2">
                <label class="space-y-2 text-xs">配置 ID<UiInput v-model="draft.id" :disabled="editing || busy" placeholder="例如 assistant" /></label>
                <label class="space-y-2 text-xs">显示名称<UiInput v-model="draft.name" :disabled="busy" placeholder="例如 简洁助手" /></label>
            </div>
            <label for="profile-json" class="block text-xs font-medium">配置参数（JSON，只填写需要覆盖的值）</label>
            <textarea id="profile-json" v-model="draft.json" :disabled="busy" rows="13" spellcheck="false" class="w-full rounded-lg border border-border bg-background p-3 font-mono text-xs" />
            <p class="text-xs leading-5 text-muted-foreground">
                <template v-if="current?.kind === 'http-json'">HTTP 配置支持 systemPrompt 和 requestBody。模板可用 input.text、input.sessionKey、input.system；请求字段请按目标接口填写。</template>
                <template v-else-if="current?.kind.startsWith('dsh')">dsh 配置可覆盖 prompt.extra、historyExtracts、progress 等行为参数。空对象继承实例设置。</template>
                <template v-else>酒馆配置可填写 character（角色名）和 world（世界书名），以及对应的行为设置。</template>
            </p>
            <p class="text-xs text-warning">保存会影响所有使用这份配置的会话。测试会实际调用下游，请先保存修改。</p>
            <div class="flex gap-2"><UiButton :disabled="busy" @click="save">{{ busy ? '处理中…' : '保存配置' }}</UiButton><UiButton variant="ghost" :disabled="busy" @click="draft = null">取消</UiButton></div>
        </UiCard>
        <UiCard v-if="!current?.profiles?.length" class="p-8 text-center text-sm text-muted-foreground">还没有对话配置。可以先创建一份；未选配置的会话使用实例设置。</UiCard>
        <UiCard v-for="profile in current?.profiles ?? []" :key="profile.id" class="p-5 sm:p-6">
            <div class="flex flex-wrap items-start justify-between gap-4">
                <div class="min-w-0"><h3 class="break-words font-semibold">{{ profile.name || profile.id }}</h3><p class="mt-1 break-all font-mono text-xs text-muted-foreground">{{ selected }} / {{ profile.id }}</p><p class="mt-3 text-xs text-muted-foreground">{{ usage(profile.id) }} 个会话正在使用</p></div>
                <div class="flex flex-wrap gap-2">
                    <UiButton variant="outline" size="sm" :disabled="busy" @click="edit(profile)">编辑</UiButton>
                    <UiButton variant="outline" size="sm" :disabled="busy || !testText.trim()" @click="test(profile.id)">测试已保存配置</UiButton>
                    <UiButton variant="ghost" size="sm" :disabled="busy" @click="confirmDelete = profile.id">删除</UiButton>
                </div>
            </div>
            <div v-if="confirmDelete === profile.id" class="mt-4 flex flex-wrap items-center gap-3 rounded-lg bg-muted p-3 text-xs"><span>删除后，相关会话将恢复继承设置。</span><UiButton variant="destructive" size="sm" :disabled="busy" @click="remove(profile.id)">确认删除</UiButton><UiButton variant="ghost" size="sm" :disabled="busy" @click="confirmDelete = ''">取消</UiButton></div>
        </UiCard>
        <UiCard class="space-y-3 p-5"><label for="profile-test-text" class="block text-xs font-medium">测试消息（点击上方测试按钮后才发送）</label><UiInput id="profile-test-text" v-model="testText" :disabled="busy" /><p v-if="result" role="status" class="whitespace-pre-wrap break-words text-sm">{{ result }}</p></UiCard>
    </div>
</template>
