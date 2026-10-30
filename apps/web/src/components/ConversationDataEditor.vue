<script setup lang="ts">
import type { ExtractionRule, VariableAssignment } from '@/api/conversations';
import UiInput from './ui/UiInput.vue';
import UiButton from './ui/UiButton.vue';
import UiSelect from './ui/UiSelect.vue';
const props = defineProps<{ extracts: ExtractionRule[]; assignments: VariableAssignment[]; stage?: 'upstream' | 'downstream'; operatorId?: string; disabled?: boolean }>();
const emit = defineEmits<{ 'update:extracts': [ExtractionRule[]]; 'update:assignments': [VariableAssignment[]] }>();
function addExtract() { emit('update:extracts', [...props.extracts, { name: '', source: props.operatorId ? '{{text}}' : `{{message.${props.stage}}}`, mode: 'regex', expression: '', group: 1, flags: '' }]); }
</script>
<template>
    <details class="rounded-lg border border-border p-4">
        <summary class="cursor-pointer text-sm font-medium">提取数据与更新变量（{{ extracts.length }} / {{ assignments.length }}）</summary>
        <div class="mt-4 space-y-4">
            <p class="text-xs leading-5 text-muted-foreground">提取发生在文本处理之前；按列表顺序执行。随后同时更新本操作的会话变量，最后展开提示词及前后追加内容。</p>
            <div class="flex items-center justify-between"><h4 class="text-xs font-medium">提取规则</h4><UiButton variant="outline" size="sm" :disabled="disabled" @click="addExtract">添加提取</UiButton></div>
            <div v-for="(r, i) in extracts" :key="i" class="space-y-3 rounded-lg bg-muted/40 p-3">
                <div class="flex gap-2"><UiInput v-model="r.name" :disabled="disabled" aria-label="提取名称" placeholder="名称，例如 nickname" /><UiButton variant="ghost" size="sm" :disabled="disabled" @click="emit('update:extracts', extracts.filter((_, n) => n !== i))">移除</UiButton></div>
                <label class="block space-y-1 text-xs">提取来源（可引用本轮、上轮或变量）<UiInput v-model="r.source" :disabled="disabled" aria-label="提取来源" /></label>
                <UiSelect v-model="r.mode" :disabled="disabled" aria-label="提取方式" :options="[{ value: 'regex', label: '正则捕获' }, { value: 'json', label: 'JSON 路径' }]" />
                <UiInput v-model="r.expression" :disabled="disabled" aria-label="提取表达式" :placeholder="r.mode === 'regex' ? '例如 姓名[:：](.+)' : '例如 data.name 或 items.0.name，留空提取整个 JSON'" />
                <div v-if="r.mode === 'regex'" class="grid gap-3 sm:grid-cols-2"><label class="space-y-1 text-xs">捕获组（0 为整个匹配）<UiInput v-model.number="r.group" type="number" :disabled="disabled" /></label><label class="space-y-1 text-xs">正则标记<UiInput v-model="r.flags" :disabled="disabled" placeholder="例如 i 或 m，可留空" /></label></div>
                <p class="text-xs text-muted-foreground">引用：<code v-text="operatorId ? '{{operators.' + operatorId + '.extracted.' + (r.name || '名称') + '}}' : '{{current.' + stage + '.' + (r.name || '名称') + '}}'" /></p>
            </div>
            <div class="flex items-center justify-between"><h4 class="text-xs font-medium">更新单会话持久变量</h4><UiButton variant="outline" size="sm" :disabled="disabled" @click="emit('update:assignments', [...assignments, { name: '', value: '', skipEmpty: true }])">添加赋值</UiButton></div>
            <div v-for="(a, i) in assignments" :key="i" class="space-y-3 rounded-lg bg-muted/40 p-3"><div class="flex gap-2"><UiInput v-model="a.name" :disabled="disabled" aria-label="目标变量名" placeholder="变量名，例如 nickname" /><UiButton variant="ghost" size="sm" :disabled="disabled" @click="emit('update:assignments', assignments.filter((_, n) => n !== i))">移除</UiButton></div><UiInput v-model="a.value" :disabled="disabled" aria-label="变量赋值模板" placeholder="填写文本或变量引用" /><label class="flex items-center gap-2 text-xs"><input type="checkbox" :checked="a.skipEmpty !== false" :disabled="disabled" @change="a.skipEmpty = ($event.target as HTMLInputElement).checked" />结果为空时保留旧值</label></div>
        </div>
    </details>
</template>
