<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { WandSparkles, Loader2, Play, Save, ChevronDown, ChevronRight } from 'lucide-vue-next';
import UiCard from '@/components/ui/UiCard.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiInput from '@/components/ui/UiInput.vue';
import UiSelect from '@/components/ui/UiSelect.vue';
import UiBadge from '@/components/ui/UiBadge.vue';
import { adaptationApi, type AdaptationInput, type AdaptationJob } from '@/api/adaptations';
import { useToastStore } from '@/stores/toast';

const props = defineProps<{ sources: Array<{ id: string; name: string }> }>();
const emit = defineEmits<{ applied: [] }>();
const toast = useToastStore();
const open = ref(false);
const busy = ref('');
const job = ref<AdaptationJob | null>(null);
const recent = ref<AdaptationJob[]>([]);
const draftText = ref('');
const testText = ref('你好');
const result = ref<{ ok: boolean; text: string; error?: string; elapsedMs: number } | null>(null);
const error = ref('');
const form = reactive<AdaptationInput>({ id: '', name: '', goal: '', endpoint: '', documentation: '', sourceId: '' });
let timer: ReturnType<typeof setTimeout> | undefined;
let alive = true;
const active = computed(() => job.value?.status === 'generating');
const stateLabels = { generating: 'dsh 正在分析', ready: '草稿已就绪', 'needs-input': '需要补充资料', failed: '生成失败', applied: '已保存为下游' };
const textareaClass = 'w-full min-w-0 rounded-lg border border-border bg-background px-3 py-2 text-xs leading-relaxed outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-60';
function selectJob(value: AdaptationJob) {
    clearTimeout(timer);
    job.value = value;
    Object.assign(form, value.input);
    draftText.value = value.draft ? JSON.stringify(value.draft, null, 2) : '';
    result.value = null;
    error.value = '';
    open.value = true;
    if (value.status === 'generating') timer = setTimeout(poll, 1500);
}
async function poll() {
    if (!alive || !job.value || !active.value) return;
    try {
        const value = (await adaptationApi.get(job.value.id)).job;
        if (!alive) return;
        job.value = value;
        error.value = '';
        if (value.status !== 'generating') {
            draftText.value = value.draft ? JSON.stringify(value.draft, null, 2) : '';
            recent.value = (await adaptationApi.list()).jobs;
        }
    } catch (e) { error.value = e instanceof Error ? e.message : String(e); }
    if (alive && active.value) timer = setTimeout(poll, error.value ? 5000 : 1500);
}
async function generate() {
    busy.value = 'generate'; error.value = ''; result.value = null;
    try {
        const value = (await adaptationApi.create({ ...form })).job;
        if (!alive) return;
        selectJob(value);
        recent.value = (await adaptationApi.list()).jobs;
    } catch (e) { error.value = e instanceof Error ? e.message : String(e); }
    finally { busy.value = ''; }
}
async function test() {
    if (!job.value) return;
    busy.value = 'test'; error.value = ''; result.value = null;
    try { result.value = await adaptationApi.test(job.value.id, JSON.parse(draftText.value), testText.value); }
    catch (e) { error.value = e instanceof Error ? e.message : String(e); }
    finally { busy.value = ''; }
}
async function apply() {
    if (!job.value) return;
    busy.value = 'save'; error.value = '';
    try {
        const saved = await adaptationApi.apply(job.value.id, JSON.parse(draftText.value));
        job.value = (await adaptationApi.get(job.value.id)).job;
        recent.value = (await adaptationApi.list()).jobs;
        emit('applied');
        if (saved.runtime?.ok === false) toast.warning('配置已保存，运行时加载失败', saved.runtime.error);
        else if (saved.warning) toast.warning('下游已保存', saved.warning);
        else toast.success('已添加下游', `${saved.id}，可在会话中选择`);
    } catch (e) { error.value = e instanceof Error ? e.message : String(e); }
    finally { busy.value = ''; }
}
onMounted(async () => {
    try {
        const jobs = (await adaptationApi.list()).jobs;
        if (!alive) return;
        recent.value = jobs;
        const running = jobs.find((value) => value.status === 'generating');
        if (running) selectJob(running);
    } catch { /* 后端未更新时不影响普通下游列表 */ }
});
onUnmounted(() => { alive = false; clearTimeout(timer); });
</script>

<template>
    <UiCard class="overflow-hidden border-primary/25">
        <button type="button" class="flex w-full items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-primary/5" :aria-expanded="open" @click="open = !open">
            <span class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><WandSparkles class="size-5" /></span>
            <span class="min-w-0 flex-1">
                <span class="block text-sm font-semibold">用 dsh 适配新下游</span>
                <span class="mt-1 block text-xs leading-relaxed text-muted-foreground">描述要接入的服务，生成连接与对话配置草稿</span>
            </span>
            <UiBadge v-if="active" tone="info">生成中</UiBadge>
            <component :is="open ? ChevronDown : ChevronRight" class="size-4 shrink-0 text-muted-foreground" />
        </button>
        <div v-if="open" class="space-y-5 border-t border-border/60 px-5 py-5">
            <p class="text-xs leading-relaxed text-muted-foreground">支持同步 HTTP / JSON 或纯文本接口。将接口路径、请求示例、响应示例粘贴到资料中；资料不足时 dsh 会列出问题。生成后可编辑、测试并保存，测试会真实调用目标服务。密钥通过请求头中的环境变量引用填写。</p>
            <div class="grid gap-4 md:grid-cols-2">
                <label class="space-y-1.5 text-xs font-medium">实例 ID<UiInput v-model="form.id" :disabled="active || !!busy" placeholder="例如 my-workflow" /></label>
                <label class="space-y-1.5 text-xs font-medium">显示名称<UiInput v-model="form.name" :disabled="active || !!busy" placeholder="例如 我的知识库" /></label>
                <label class="space-y-1.5 text-xs font-medium">目标地址<UiInput v-model="form.endpoint" :disabled="active || !!busy" placeholder="http://127.0.0.1:8000/api/chat（可选）" /></label>
                <label class="space-y-1.5 text-xs font-medium">适配助手
                    <UiSelect v-model="form.sourceId" :disabled="active || !!busy" :options="[{ value: '', label: '自动选择可用 dsh' }, ...props.sources.map((s) => ({ value: s.id, label: s.name }))]" />
                </label>
            </div>
            <label class="block space-y-1.5 text-xs font-medium">接入目标
                <textarea v-model="form.goal" :class="textareaClass" rows="3" maxlength="8000" :disabled="active || !!busy" placeholder="例如：将 QQ 消息发送到我的客服接口，用 answer 字段回复；每个 QQ 会话独立传入 session_id。" />
            </label>
            <label class="block space-y-1.5 text-xs font-medium">接口资料
                <textarea v-model="form.documentation" :class="textareaClass" rows="6" maxlength="40000" :disabled="active || !!busy" placeholder="粘贴接口文档正文、请求和响应示例。仅有文档链接时，请同时提供关键正文。不要粘贴真实密钥。" />
            </label>
            <UiButton size="sm" :disabled="active || !!busy || !form.id.trim() || !form.goal.trim() || !props.sources.length" @click="generate">
                <Loader2 v-if="active || busy === 'generate'" class="size-4 animate-spin" /><WandSparkles v-else class="size-4" />
                {{ active ? 'dsh 正在生成…' : '生成适配草稿' }}
            </UiButton>
            <p v-if="!props.sources.length" class="text-xs text-warning">先启用并连接一个 dsh 实例，再生成适配草稿。</p>
            <div v-if="job" class="space-y-3 rounded-xl border border-border bg-muted/15 p-4">
                <div class="flex flex-wrap items-center gap-2"><UiBadge :tone="job.status === 'failed' ? 'destructive' : 'info'">{{ stateLabels[job.status] }}</UiBadge><span class="text-xs text-muted-foreground">{{ job.input.name }} · {{ job.sourceId }}</span></div>
                <p v-if="job.summary" class="whitespace-pre-wrap text-xs leading-relaxed">{{ job.summary }}</p>
                <ul v-if="job.questions.length" class="list-disc space-y-1 pl-5 text-xs text-warning"><li v-for="question in job.questions" :key="question">{{ question }}</li></ul>
                <p v-if="job.error" class="text-xs text-destructive">{{ job.error }}</p>
                <template v-if="job.draft">
                    <label class="block space-y-1.5 text-xs font-medium">连接与对话配置
                        <textarea v-model="draftText" :class="[textareaClass, 'font-mono']" rows="15" spellcheck="false" :readonly="job.status === 'applied'" :disabled="!!busy" @input="result = null" />
                    </label>
                    <div class="flex flex-wrap items-center gap-2">
                        <UiInput v-model="testText" class="max-w-sm" placeholder="用于真实调用的测试文本" :disabled="!!busy" />
                        <UiButton size="sm" variant="outline" :disabled="!!busy" @click="test"><Loader2 v-if="busy === 'test'" class="size-3.5 animate-spin" /><Play v-else class="size-3.5" />测试草稿</UiButton>
                        <UiButton v-if="job.status === 'ready'" size="sm" :disabled="!!busy" @click="apply"><Loader2 v-if="busy === 'save'" class="size-3.5 animate-spin" /><Save v-else class="size-3.5" />保存为新下游</UiButton>
                    </div>
                    <p class="text-[11px] text-muted-foreground">保存后新增实例与默认对话配置；在会话中选择该实例即可使用。</p>
                    <div v-if="result" class="rounded-lg border p-3 text-xs" :class="result.ok ? 'border-success/30 bg-success/5' : 'border-destructive/30 bg-destructive/5'">
                        <p class="font-medium">{{ result.ok ? '真实调用成功' : '真实调用失败' }} · {{ (result.elapsedMs / 1000).toFixed(1) }}s</p>
                        <p class="mt-1 whitespace-pre-wrap break-words">{{ result.ok ? result.text : result.error }}</p>
                    </div>
                </template>
            </div>
            <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p>
            <details v-if="recent.length" class="text-xs text-muted-foreground">
                <summary class="cursor-pointer">最近适配任务（{{ recent.length }}）</summary>
                <div class="mt-2 flex flex-wrap gap-2"><button v-for="value in recent" :key="value.id" type="button" class="rounded-md border border-border px-2.5 py-1.5 hover:bg-accent disabled:opacity-50" :disabled="active || !!busy" @click="selectJob(value)">{{ value.input.name }} · {{ stateLabels[value.status] }}</button></div>
            </details>
        </div>
    </UiCard>
</template>
