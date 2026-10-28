<script setup lang="ts">
/**
 * 号码列表编辑器。
 *
 * 为什么不用逗号输入框：QQ 号是一组独立的实体，用逗号串起来时
 * 既看不出有几项，也很难单独删掉其中一条。这里改成逐条展示、逐条增删。
 *
 * 输入支持一次粘贴多个（逗号/空格/换行分隔），避免从别处复制时还要手动拆。
 */
import { computed, ref } from 'vue';
import { Plus, X, Hash } from 'lucide-vue-next';
import UiButton from '@/components/ui/UiButton.vue';
import UiInput from '@/components/ui/UiInput.vue';

interface Props {
    modelValue: number[];
    /** 输入框占位文字 */
    placeholder?: string;
    /** 列表为空时的提示 */
    emptyText?: string;
    /** 单项前缀，例如「QQ」「群」 */
    hint?: string;
    disabled?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
    placeholder: '输入号码后回车',
    emptyText: '暂无条目',
    hint: '',
    disabled: false,
});

const emit = defineEmits<{ 'update:modelValue': [value: number[]] }>();

const draft = ref('');
const error = ref('');

/** 解析一段文本里的所有号码（支持逗号/空格/换行混排） */
function parseIds(text: string): number[] {
    return text
        .split(/[,，\s]+/)
        .map((x) => x.trim())
        .filter(Boolean)
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0);
}

const items = computed(() => props.modelValue ?? []);

function add(): void {
    const text = draft.value.trim();
    if (!text) return;

    const incoming = parseIds(text);
    if (incoming.length === 0) {
        error.value = '请输入有效号码（纯数字）';
        return;
    }

    // 去重后合并，保持原顺序
    const next = [...items.value];
    for (const id of incoming) {
        if (!next.includes(id)) next.push(id);
    }

    error.value = '';
    draft.value = '';
    emit('update:modelValue', next);
}

function remove(id: number): void {
    emit(
        'update:modelValue',
        items.value.filter((x) => x !== id),
    );
}

function clearAll(): void {
    emit('update:modelValue', []);
}
</script>

<template>
    <div class="flex flex-col gap-2">
        <!-- 输入行 -->
        <div class="flex items-center gap-1.5">
            <UiInput
                v-model="draft"
                :placeholder="placeholder"
                :disabled="disabled"
                mono
                class="flex-1"
                @keyup.enter="add"
            />
            <UiButton size="sm" :disabled="disabled || !draft.trim()" @click="add">
                <Plus class="size-3.5" />
                添加
            </UiButton>
        </div>

        <p v-if="error" class="text-[11px] text-destructive">{{ error }}</p>

        <!-- 条目列表 -->
        <div v-if="items.length === 0" class="rounded-md border border-dashed border-border/60 px-3 py-2.5">
            <p class="text-[11px] text-muted-foreground">{{ emptyText }}</p>
        </div>

        <div v-else class="flex flex-wrap gap-1.5">
            <span
                v-for="id in items"
                :key="id"
                class="inline-flex items-center gap-1 rounded-md border border-border/60 bg-accent/30 py-1 pl-2 pr-1 font-mono text-[11px]"
            >
                <Hash v-if="hint" class="size-2.5 text-muted-foreground/60" />
                <span>{{ id }}</span>
                <button
                    type="button"
                    class="rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                    :disabled="disabled"
                    :title="`移除 ${id}`"
                    @click="remove(id)"
                >
                    <X class="size-3" />
                </button>
            </span>
        </div>

        <!-- 汇总 -->
        <div v-if="items.length > 0" class="flex items-center justify-between">
            <p class="text-[10px] text-muted-foreground/70">共 {{ items.length }} 项</p>
            <button
                type="button"
                class="text-[10px] text-muted-foreground transition-colors hover:text-destructive disabled:opacity-40"
                :disabled="disabled"
                @click="clearAll"
            >
                清空
            </button>
        </div>
    </div>
</template>
