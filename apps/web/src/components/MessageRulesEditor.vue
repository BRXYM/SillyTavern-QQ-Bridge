<script setup lang="ts">
import type { MessageRule } from '@/api/conversations';
import UiButton from './ui/UiButton.vue';
import UiInput from './ui/UiInput.vue';
import UiSelect from './ui/UiSelect.vue';
defineProps<{ modelValue: MessageRule[]; disabled?: boolean; label: string }>();
const emit = defineEmits<{ 'update:modelValue': [MessageRule[]] }>();
</script>
<template>
    <div class="space-y-3">
        <div class="flex items-center justify-between gap-3"><h3 class="text-sm font-medium">{{ label }}</h3><UiButton size="sm" variant="outline" :disabled="disabled" @click="emit('update:modelValue', [...modelValue, { type: 'replace', pattern: '', replacement: '', flags: 'g' }])">添加规则</UiButton></div>
        <p v-if="!modelValue.length" class="text-xs text-muted-foreground">保持原文，不做额外处理。</p>
        <div v-for="(rule, index) in modelValue" :key="index" class="space-y-3 rounded-lg border border-border p-3">
            <div class="flex gap-2"><UiSelect v-model="rule.type" :disabled="disabled" :aria-label="`${label}第 ${index + 1} 条类型`" :options="[{ value: 'replace', label: '替换文本' }, { value: 'remove', label: '删除匹配文本' }, { value: 'strip', label: '删除标记及其内容' }]" /><UiButton variant="ghost" size="sm" :disabled="disabled" @click="emit('update:modelValue', modelValue.filter((_, i) => i !== index))">移除</UiButton></div>
            <div v-if="rule.type === 'strip'" class="grid gap-2 sm:grid-cols-2"><UiInput :model-value="rule.begin ?? ''" @update:model-value="(v: string | number) => rule.begin = String(v)" :disabled="disabled" placeholder="开始标记，例如 <think>" aria-label="开始标记" /><UiInput :model-value="rule.end ?? ''" @update:model-value="(v: string | number) => rule.end = String(v)" :disabled="disabled" placeholder="结束标记，例如 </think>" aria-label="结束标记" /></div>
            <template v-else><UiInput :model-value="rule.pattern ?? ''" @update:model-value="(v: string | number) => rule.pattern = String(v)" :disabled="disabled" aria-label="匹配表达式" placeholder="匹配表达式，例如 ^助手：" /><UiInput v-if="rule.type === 'replace'" :model-value="rule.replacement ?? ''" @update:model-value="(v: string | number) => rule.replacement = String(v)" :disabled="disabled" aria-label="替换后的内容" placeholder="替换后的内容，可留空" /></template>
        </div>
    </div>
</template>
