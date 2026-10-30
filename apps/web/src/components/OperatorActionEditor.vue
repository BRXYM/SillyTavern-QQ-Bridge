<script setup lang="ts">
import type { OperatorAction } from '@/api/flows';
import UiInput from './ui/UiInput.vue';
import UiSelect from './ui/UiSelect.vue';
import UiButton from './ui/UiButton.vue';
import ConversationDataEditor from './ConversationDataEditor.vue';
import MessageRulesEditor from './MessageRulesEditor.vue';
defineProps<{ action: OperatorAction; operatorId: string; connections: Array<{ id: string; name: string }>; disabled?: boolean }>();
</script>
<template>
    <div class="space-y-4">
        <template v-if="action.type === 'input'"><label class="block space-y-2 text-xs">读取内容<UiInput v-model="action.source" :disabled="disabled" /></label><p class="text-xs text-muted-foreground">把模板结果作为当前文本，可从原始消息、前面算子输出、上轮历史或会话变量读取。</p></template>
        <template v-else-if="action.type === 'process'">
            <label class="block space-y-2 text-xs">处理来源（留空时使用当前文本）<UiInput :model-value="action.source ?? ''" :disabled="disabled" placeholder="默认当前文本，也可引用任意已有数据" @update:model-value="(v: string | number) => action.type === 'process' && (action.source = String(v) || undefined)" /></label>
            <div class="grid gap-3 sm:grid-cols-2"><label class="space-y-2 text-xs">处理前追加<UiInput v-model="action.prefix" :disabled="disabled" /></label><label class="space-y-2 text-xs">处理后追加<UiInput v-model="action.suffix" :disabled="disabled" /></label></div>
            <label class="flex items-center gap-2 text-xs"><input type="checkbox" :disabled="disabled" :checked="action.system !== undefined" @change="action.system = ($event.target as HTMLInputElement).checked ? '' : undefined" />设置后续服务调用的提示词</label>
            <textarea v-if="action.system !== undefined" v-model="action.system" :disabled="disabled" aria-label="操作提示词" rows="4" class="w-full rounded-lg border border-input bg-background p-3 text-sm" placeholder="支持变量与算子引用；空内容表示清除提示词" />
            <label class="flex items-center gap-2 text-xs"><input v-model="action.stopIfEmpty" type="checkbox" :disabled="disabled" />处理结果为空时结束整个流程</label>
            <MessageRulesEditor v-model="action.rules" :disabled="disabled" label="文本处理规则" />
            <ConversationDataEditor v-model:extracts="action.extracts" v-model:assignments="action.assignments" :operator-id="operatorId" :disabled="disabled" />
            <details class="rounded-lg border border-border p-3 text-xs"><summary class="cursor-pointer">会话变量初始值（{{ action.variables.length }}）</summary><p class="my-3 leading-5 text-muted-foreground">变量尚不存在时才初始化，后续由赋值操作更新。变量按单个会话持久保存。</p><div v-for="(v, i) in action.variables" :key="i" class="my-2 flex gap-2"><UiInput v-model="v.name" :disabled="disabled" aria-label="初始变量名" placeholder="变量名" /><UiInput v-model="v.initialValue" :disabled="disabled" aria-label="变量初始值" placeholder="初始值" /><UiButton size="sm" variant="ghost" :disabled="disabled" @click="action.variables.splice(i, 1)">移除</UiButton></div><UiButton variant="outline" size="sm" :disabled="disabled" @click="action.variables.push({ name: '', initialValue: '' })">添加初始值</UiButton></details>
            <div v-if="action.legacySystem || action.legacyRules || action.legacyStage" class="space-y-2 rounded-lg bg-muted p-3 text-xs"><p>旧处理已迁移到本操作，原方向引用继续有效。</p><label v-if="action.legacySystem" class="flex gap-2"><input v-model="action.legacySystem" type="checkbox" :disabled="disabled" />沿用旧连接提示词</label><label v-if="action.legacyRules" class="flex gap-2"><input v-model="action.legacyRules" type="checkbox" :disabled="disabled" />沿用旧回复规则</label></div>
        </template>
        <template v-else-if="action.type === 'call'"><label class="block space-y-2 text-xs">调用的连接<UiSelect :model-value="action.downstreamId ?? ''" :disabled="disabled" :options="[{ value: '', label: '本流程所属的下游' }, ...connections.map(c => ({ value: c.id, label: c.name }))]" @update:model-value="(v: string) => action.type === 'call' && (action.downstreamId = v || undefined)" /></label><label class="block space-y-2 text-xs">请求消息模板<UiInput v-model="action.input" :disabled="disabled" /></label><label class="block space-y-2 text-xs">提示词模板<UiInput v-model="action.system" :disabled="disabled" /></label><p class="text-xs leading-5 text-muted-foreground">返回结果成为当前文本。可以在同一算子内继续处理、再次调用其他连接或返回 QQ。</p><label v-if="action.legacySession" class="flex gap-2 text-xs"><input v-model="action.legacySession" type="checkbox" :disabled="disabled" />沿用升级前的服务会话上下文</label></template>
        <template v-else-if="action.type === 'reply'"><label class="block space-y-2 text-xs">返回内容<textarea v-model="action.text" :disabled="disabled" aria-label="返回内容" rows="3" class="w-full rounded-lg border border-input bg-background p-3 text-sm" /></label><label class="flex items-center gap-2 text-xs"><input v-model="action.stopAfter" type="checkbox" :disabled="disabled" />返回后结束流程</label><p class="text-xs leading-5 text-muted-foreground">从原 QQ 账号发送到原会话。未勾选结束时继续执行后续操作；可在调用服务之前或任意算子中返回多次。</p></template>
        <p v-else class="text-xs leading-5 text-muted-foreground">到达本操作时结束流程，后续操作和算子全部跳过；不会自动发送当前文本。</p>
    </div>
</template>
