<script setup lang="ts">
import type { FlowRun } from '@/api/flows';
defineProps<{ run: FlowRun }>();
const statuses: Record<string, string> = { pending: '等待', running: '执行中', success: '完成', skipped: '跳过', failed: '失败', filtered: '未发送' };
const modes = { live: '真实 QQ 消息', preview: '模拟预览', test: '真实调用测试' };
</script>
<template>
    <div class="space-y-4">
        <div class="flex flex-wrap gap-3 text-xs text-muted-foreground"><span>{{ modes[run.mode] }}</span><span>{{ statuses[run.status] }}</span><span>{{ run.elapsedMs }} ms</span><span>{{ new Date(run.createdAt).toLocaleString() }}</span></div>
        <p v-if="run.error" role="alert" class="text-sm text-destructive">{{ run.error }}</p>
        <div class="grid gap-3 xl:grid-cols-4">
            <details v-for="step in run.steps" :key="step.id" class="min-w-0 rounded-xl border border-border bg-background p-4" :open="step.status === 'failed'">
                <summary class="cursor-pointer text-xs font-medium"><span :class="step.status === 'failed' ? 'text-destructive' : step.status === 'success' ? 'text-success' : 'text-muted-foreground'">{{ step.name }} · {{ statuses[step.status] }}</span></summary>
                <div class="mt-3 space-y-3 text-xs"><p v-if="step.elapsedMs !== undefined" class="text-muted-foreground">{{ step.elapsedMs }} ms</p><p v-if="step.error" class="whitespace-pre-wrap break-words text-destructive">{{ step.error }}</p><div v-if="step.system !== undefined"><p class="text-muted-foreground">前置提示词</p><pre class="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words">{{ step.system || '无' }}</pre></div><div v-if="step.input !== undefined"><p class="text-muted-foreground">输入</p><pre class="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words">{{ step.input || '空' }}</pre></div><div v-if="step.output !== undefined"><p class="text-muted-foreground">输出</p><pre class="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words">{{ step.output || '空' }}</pre></div></div>
            </details>
        </div>
        <details v-if="run.variables.length" class="text-xs"><summary class="cursor-pointer">变量变更（{{ run.variablesSaved ? '已保存到本会话' : '拟变更，未写入真实会话' }}）</summary><div v-for="v in run.variables" :key="v.name" class="mt-2 break-words rounded-lg bg-muted p-3"><strong>{{ v.name }}</strong><pre class="mt-2 whitespace-pre-wrap">{{ v.before || '空' }} → {{ v.after || '空' }}</pre></div></details>
        <p v-for="warning in run.warnings" :key="warning" class="text-xs text-warning">{{ warning }}</p>
    </div>
</template>
