<script setup lang="ts">
import { cn } from '@/lib/utils';

type Tone = 'default' | 'secondary' | 'destructive' | 'success' | 'warning' | 'info' | 'outline';

interface Props {
    tone?: Tone;
    class?: string;
    /** 左侧状态点 */
    dot?: boolean;
    pulse?: boolean;
}

withDefaults(defineProps<Props>(), {
    tone: 'default',
    dot: false,
    pulse: false,
});

const toneClass: Record<Tone, string> = {
    default: 'border-transparent bg-primary/15 text-primary',
    secondary: 'border-transparent bg-secondary text-secondary-foreground',
    destructive: 'border-transparent bg-destructive/15 text-destructive',
    success: 'border-transparent bg-success/15 text-success',
    warning: 'border-transparent bg-warning/15 text-warning',
    info: 'border-transparent bg-info/15 text-info',
    outline: 'border-border text-foreground',
};

const dotClass: Record<Tone, string> = {
    default: 'bg-primary',
    secondary: 'bg-muted-foreground',
    destructive: 'bg-destructive',
    success: 'bg-success',
    warning: 'bg-warning',
    info: 'bg-info',
    outline: 'bg-foreground',
};
</script>

<template>
    <span
        :class="cn(
            'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
            toneClass[tone],
            $props.class,
        )"
    >
        <span
            v-if="dot"
            :class="cn('size-1.5 shrink-0 rounded-full', dotClass[tone], pulse && 'animate-pulse')"
        />
        <slot />
    </span>
</template>
