<script setup lang="ts">
import { actionNames, type FlowRun } from '@/api/flows';
defineProps<{ run: FlowRun }>();
const statuses: Record<string, string> = { pending: '等待', running: '执行中', success: '完成', skipped: '跳过', failed: '失败', filtered: '未发送' };
const modes = { live: '真实 QQ 消息', preview: '模拟预览', test: '真实调用测试' };
</script>
<template>
    <div class="space-y-4">
        <div class="flex flex-wrap gap-3 text-xs text-muted-foreground"><span>{{ modes[run.mode] }}</span><span>{{ statuses[run.status] }}</span><span>{{ run.elapsedMs }} ms</span><span>{{ new Date(run.createdAt).toLocaleString() }}</span></div>
        <p v-if="run.error" role="alert" class="text-sm text-destructive">{{ run.error }}</p>
        <div v-if="run.deliveries?.length" class="space-y-2 rounded-xl border border-primary/20 bg-primary/5 p-4"><h4 class="text-xs font-semibold">{{ run.mode === 'live' ? '流程返回记录' : '模拟返回记录（未发送 QQ）' }}</h4><div v-for="(reply, i) in run.deliveries" :key="i" class="rounded-lg bg-background p-3 text-xs"><p class="mb-2 break-all text-muted-foreground">{{ i + 1 }} · {{ reply.operatorId }}.{{ reply.actionId }} · {{ reply.simulated ? '仅展示' : `发送 ${reply.sent} 段 / 失败 ${reply.failed} 段` }}</p><pre class="max-h-48 overflow-auto whitespace-pre-wrap break-words">{{ reply.text }}</pre></div></div>
        <div class="space-y-3">
            <details v-for="(step, i) in run.steps" :key="step.id" class="min-w-0 rounded-xl border border-border bg-background p-4" :open="step.status === 'failed'">
                <summary class="cursor-pointer text-xs font-medium"><span :class="step.status === 'failed' ? 'text-destructive' : step.status === 'success' ? 'text-success' : 'text-muted-foreground'">{{ i + 1 }} · {{ step.name }} · {{ statuses[step.status] }}</span><span class="ml-3 text-muted-foreground">{{ step.elapsedMs ?? 0 }} ms</span></summary>
                <div class="mt-4 space-y-3 text-xs"><p v-if="step.error" class="whitespace-pre-wrap break-words text-destructive">{{ step.error }}</p>
                    <div v-if="step.actions" class="space-y-3"><details v-for="(action, j) in step.actions" :key="action.id" class="rounded-lg bg-muted/25 p-3" :open="action.status === 'failed'"><summary class="cursor-pointer">{{ j + 1 }}. {{ actionNames[action.type] }} · {{ statuses[action.status] }} · {{ action.elapsedMs ?? 0 }} ms</summary><div class="mt-3 space-y-3"><p v-if="action.downstreamId" class="text-muted-foreground">连接：{{ action.downstreamId }}</p><p v-if="action.error" class="break-words text-destructive">{{ action.error }}</p><div v-if="action.system !== undefined"><p class="text-muted-foreground">提示词</p><pre class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words">{{ action.system || '无' }}</pre></div><div v-if="action.input !== undefined"><p class="text-muted-foreground">输入</p><pre class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words">{{ action.input || '空' }}</pre></div><div v-if="action.output !== undefined"><p class="text-muted-foreground">输出</p><pre class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words">{{ action.output || '空' }}</pre></div></div></details></div>
                    <template v-else><div v-if="step.system !== undefined"><p class="text-muted-foreground">提示词</p><pre class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words">{{ step.system || '无' }}</pre></div><div v-if="step.input !== undefined"><p class="text-muted-foreground">输入</p><pre class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words">{{ step.input || '空' }}</pre></div><div v-if="step.output !== undefined"><p class="text-muted-foreground">输出</p><pre class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words">{{ step.output || '空' }}</pre></div></template>
                </div>
            </details>
        </div>
        <details v-if="run.variables.length" class="text-xs"><summary class="cursor-pointer">会话变量变更</summary><div v-for="v in run.variables" :key="v.name" class="mt-2 break-words rounded-lg bg-muted p-3"><strong>{{ v.name }}</strong><span class="ml-3 text-muted-foreground">{{ (v.saved ?? run.variablesSaved) ? '已保存' : '未写入真实会话' }}</span><pre class="mt-2 whitespace-pre-wrap">{{ v.before || '空' }} → {{ v.after || '空' }}</pre></div></details>
        <p v-for="warning in run.warnings" :key="warning" class="text-xs text-warning">{{ warning }}</p>
    </div>
</template>
