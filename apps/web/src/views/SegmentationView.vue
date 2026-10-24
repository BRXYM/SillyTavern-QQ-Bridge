<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Plus, X, Scissors } from 'lucide-vue-next';
import { useStatusStore } from '@/stores/status';
import UiCard from '@/components/ui/UiCard.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiInput from '@/components/ui/UiInput.vue';
import UiSwitch from '@/components/ui/UiSwitch.vue';
import UiSelect from '@/components/ui/UiSelect.vue';
import { api } from '@/api/client';
import { useToastStore } from '@/stores/toast';

interface Pair { name: string; token: string }

const store = useStatusStore();
const toast = useToastStore();

const enabled = ref(true);
const maxLen = ref(100);
const minLen = ref(6);
const maxSegments = ref(8);
const hardChars = ref('。！？!?…');
const softChars = ref('，,；;');
const splitOnPairs = ref(true);
const pairMinLen = ref(3);
const convertMarkers = ref(true);
const delayMin = ref(300);
const delayMax = ref(900);
const pairs = ref<Pair[]>([
    { name: '动作', token: '*' },
    { name: '台词', token: '"' },
]);
const splitStrings = ref('');

const PRESETS = [
    { label: '星号（*动作*）', token: '*' },
    { label: '双引号（"台词"）', token: '"' },
    { label: '中文双引号（“台词”）', token: '“”' },
    { label: '单引号（\'台词\'）', token: "'" },
    { label: '中文单引号（‘台词’）', token: '‘’' },
    { label: '圆括号（（动作））', token: '（）' },
    { label: '半角括号（(动作)）', token: '()' },
    { label: '方括号（[动作]）', token: '[]' },
    { label: '方头括号（【动作】）', token: '【】' },
    { label: '书名号（《标题》）', token: '《》' },
    { label: '尖括号（<动作>）', token: '<>' },
    { label: '花括号（{动作}）', token: '{}' },
];

const presetOptions = PRESETS.map((p) => ({ value: p.token, label: p.label }));

// 预览
const testText = ref('*她抬起头，眼睛里闪着光。* "你来啦！我等你好久了。" *她放下书。* "外面下雪了吗？"');
const preview = ref<Array<{ text: string; delayMs: number }>>([]);
const previewError = ref('');

onMounted(async () => {
    await store.refresh();
    loadFromStore();
    void runPreview();
});

/** 从后端状态回填已保存的分段配置 */
function loadFromStore() {
    const raw = (store.status?.config?.['segmentation'] ?? {}) as Record<string, unknown>;
    if (!raw || Object.keys(raw).length === 0) return;

    if (typeof raw.enabled === 'boolean') enabled.value = raw.enabled;
    if (typeof raw.maxLen === 'number') maxLen.value = raw.maxLen;
    if (typeof raw.minLen === 'number') minLen.value = raw.minLen;
    if (typeof raw.maxSegments === 'number') maxSegments.value = raw.maxSegments;
    if (typeof raw.hardChars === 'string') hardChars.value = raw.hardChars;
    if (typeof raw.softChars === 'string') softChars.value = raw.softChars;
    if (typeof raw.splitOnPairs === 'boolean') splitOnPairs.value = raw.splitOnPairs;
    // 后端未配置时按 DEFAULT 的 3 处理
    pairMinLen.value = typeof raw.pairMinLen === 'number' ? raw.pairMinLen : 3;
    if (typeof raw.convertActionMarkers === 'boolean') convertMarkers.value = raw.convertActionMarkers;

    if (Array.isArray(raw.delayMs) && raw.delayMs.length >= 2) {
        delayMin.value = Number(raw.delayMs[0]) || 0;
        delayMax.value = Number(raw.delayMs[1]) || 0;
    }

    if (Array.isArray(raw.pairChars)) {
        const next: Pair[] = [];
        for (const item of raw.pairChars as unknown[]) {
            if (Array.isArray(item) && typeof item[1] === 'string') {
                next.push({ name: String(item[0] ?? item[1]), token: item[1] });
            }
        }
        if (next.length) pairs.value = next;
    }

    if (Array.isArray(raw.splitStrings)) {
        splitStrings.value = (raw.splitStrings as unknown[])
            .filter((s): s is string => typeof s === 'string')
            .join('\n');
    }
}

function currentConfig() {
    return {
        enabled: enabled.value,
        maxLen: maxLen.value,
        minLen: minLen.value,
        maxSegments: maxSegments.value,
        hardChars: hardChars.value,
        softChars: softChars.value,
        pairChars: pairs.value.map((p) => [p.name || p.token, p.token]),
        splitStrings: splitStrings.value.split('\n').map((s) => s.trim()).filter(Boolean),
        splitOnPairs: splitOnPairs.value,
        pairMinLen: pairMinLen.value,
        convertActionMarkers: convertMarkers.value,
        delayMs: [delayMin.value, delayMax.value],
    };
}

async function runPreview() {
    try {
        previewError.value = '';
        const r = await api.testSegmentation(testText.value, currentConfig());
        preview.value = r.segments ?? [];
    } catch (e) {
        previewError.value = e instanceof Error ? e.message : String(e);
        preview.value = [];
    }
}

async function save() {
    try {
        await api.updateConfig({ segmentation: currentConfig() });
        await store.refresh();
        toast.success('分段设置已保存');
    } catch (e) {
        toast.error('保存失败', e instanceof Error ? e.message : String(e));
    }
}

function addPair() {
    pairs.value.push({ name: '', token: '*' });
    toast.info('已添加配对符', '请选择符号组合');
}

function removePair(i: number) {
    pairs.value.splice(i, 1);
}

const totalChars = computed(() => preview.value.reduce((n, s) => n + s.text.length, 0));
</script>

<template>
    <div class="grid gap-5 lg:grid-cols-[1fr_420px]">
        <!-- 左侧：配置 -->
        <div class="flex flex-col gap-5">
            <UiCard>
                <div class="flex items-center justify-between border-b border-border/60 px-5 py-4">
                    <div>
                        <h2 class="text-sm font-semibold tracking-tight">分段规则</h2>
                        <p class="text-xs text-muted-foreground">按标点把长回复拆成多条短消息</p>
                    </div>
                    <UiSwitch v-model="enabled" />
                </div>

                <div class="grid gap-4 px-5 py-4 sm:grid-cols-3">
                    <div>
                        <label class="text-xs font-medium text-muted-foreground">单条最大字数</label>
                        <UiInput v-model.number="maxLen" type="number" class="mt-1" />
                    </div>
                    <div>
                        <label class="text-xs font-medium text-muted-foreground">最多分几条</label>
                        <UiInput v-model.number="maxSegments" type="number" class="mt-1" />
                    </div>
                    <div>
                        <label class="text-xs font-medium text-muted-foreground">最短片段（合并阈值）</label>
                        <UiInput v-model.number="minLen" type="number" class="mt-1" />
                    </div>
                </div>

                <div class="grid gap-4 border-t border-border/40 px-5 py-4 sm:grid-cols-2">
                    <div>
                        <label class="text-xs font-medium text-muted-foreground">硬分隔符（句末标点）</label>
                        <UiInput v-model="hardChars" class="mt-1" />
                    </div>
                    <div>
                        <label class="text-xs font-medium text-muted-foreground">软分隔符（逗号类）</label>
                        <UiInput v-model="softChars" class="mt-1" />
                    </div>
                </div>

                <div class="grid gap-4 border-t border-border/40 px-5 py-4 sm:grid-cols-2">
                    <div>
                        <label class="text-xs font-medium text-muted-foreground">间隔最小 (ms)</label>
                        <UiInput v-model.number="delayMin" type="number" class="mt-1" />
                    </div>
                    <div>
                        <label class="text-xs font-medium text-muted-foreground">间隔最大 (ms)</label>
                        <UiInput v-model.number="delayMax" type="number" class="mt-1" />
                    </div>
                </div>
            </UiCard>

            <!-- 配对符 -->
            <UiCard>
                <div class="flex items-center justify-between border-b border-border/60 px-5 py-4">
                    <div>
                        <h2 class="text-sm font-semibold tracking-tight">配对符</h2>
                        <p class="text-xs text-muted-foreground">成对内容保持完整，内部标点不切分</p>
                    </div>
                    <UiSwitch v-model="splitOnPairs" />
                </div>

                <div class="flex flex-col gap-2 px-5 py-4">
                    <div
                        v-for="(p, i) in pairs"
                        :key="i"
                        class="flex items-center gap-2"
                    >
                        <UiInput v-model="p.name" placeholder="名称" class="max-w-24" />
                        <UiSelect v-model="p.token" :options="presetOptions" class="flex-1" />
                        <UiButton variant="ghost" size="icon" @click="removePair(i)">
                            <X class="size-4" />
                        </UiButton>
                    </div>
                    <UiButton variant="outline" size="sm" class="mt-2 self-start" @click="addPair">
                        <Plus class="size-4" />
                        添加配对符
                    </UiButton>
                </div>

                <div class="border-t border-border/40 px-5 py-4">
                    <div class="flex items-center gap-4">
                        <div class="min-w-0 flex-1">
                            <label class="text-xs font-medium text-muted-foreground">忽略长度</label>
                            <p class="mt-1 text-xs leading-relaxed text-muted-foreground/80">
                                配对符内少于该字数时不单独成段，避免
                                <code class="font-mono text-primary">"菜"</code>
                                这类单字强调被拆开；设为 0 关闭限制
                            </p>
                        </div>
                        <div class="w-20 shrink-0">
                            <UiInput
                                v-model.number="pairMinLen"
                                type="number"
                                min="0"
                                max="50"
                            />
                        </div>
                    </div>
                </div>

                <div class="border-t border-border/40 px-5 py-4">
                    <label class="text-xs font-medium text-muted-foreground">自定义分隔串（每行一个）</label>
                    <textarea
                        v-model="splitStrings"
                        rows="2"
                        class="mt-1 w-full rounded-md border border-border bg-transparent px-3 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
                        placeholder="留空不用；例如 || 或 ---"
                    />
                </div>

                <div class="flex items-center justify-between border-t border-border/40 px-5 py-4">
                    <label class="text-xs font-medium text-muted-foreground">
                        把 *动作* 转成 （动作）
                    </label>
                    <UiSwitch v-model="convertMarkers" />
                </div>

                <div class="border-t border-border/60 px-5 py-3">
                    <UiButton @click="save">保存分段设置</UiButton>
                </div>
            </UiCard>
        </div>

        <!-- 右侧：预览 -->
        <UiCard class="lg:sticky lg:top-4 lg:self-start">
            <div class="border-b border-border/60 px-5 py-4">
                <h2 class="flex items-center gap-2 text-sm font-semibold tracking-tight">
                    <Scissors class="size-4 text-primary" />
                    切分预览
                </h2>
                <p class="text-xs text-muted-foreground">粘贴一段 AI 回复，实时查看效果</p>
            </div>

            <div class="px-5 py-4">
                <textarea
                    v-model="testText"
                    rows="4"
                    class="w-full rounded-md border border-border bg-transparent px-3 py-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
                />
                <UiButton variant="secondary" size="sm" class="mt-2" @click="runPreview">
                    重新切分
                </UiButton>
            </div>

            <div class="border-t border-border/40 px-5 py-4">
                <div class="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                    <span>共 {{ preview.length }} 条</span>
                    <span>{{ totalChars }} 字</span>
                </div>

                <div v-if="previewError" class="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {{ previewError }}
                </div>

                <div v-else class="flex flex-col gap-1.5">
                    <div
                        v-for="(seg, i) in preview"
                        :key="i"
                        class="rounded-md border-l-2 border-primary/40 bg-accent/20 px-3 py-2"
                    >
                        <div class="mb-0.5 flex items-center gap-2 text-micro text-muted-foreground tabular-nums">
                            <span>#{{ i + 1 }}</span>
                            <span v-if="seg.delayMs > 0">+{{ seg.delayMs }}ms</span>
                            <span class="ml-auto">{{ seg.text.length }} 字</span>
                        </div>
                        <p class="whitespace-pre-wrap break-words text-xs leading-relaxed">{{ seg.text }}</p>
                    </div>
                </div>
            </div>
        </UiCard>
    </div>
</template>
