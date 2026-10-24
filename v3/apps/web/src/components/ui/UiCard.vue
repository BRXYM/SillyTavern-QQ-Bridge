<script setup lang="ts">
import { cn } from '@/lib/utils';

interface Props {
    class?: string;
    /** 可点击卡片：hover 高亮 */
    interactive?: boolean;
}

defineProps<Props>();
</script>

<template>
    <div
        :class="cn(
            'ui-card rounded-xl border border-border/60 bg-card text-card-foreground',
            interactive && 'transition-colors hover:border-primary/40 hover:bg-accent/30',
            $props.class,
        )"
    >
        <slot />
    </div>
</template>
