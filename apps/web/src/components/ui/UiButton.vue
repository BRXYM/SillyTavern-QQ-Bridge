<script setup lang="ts">
import { cn } from '@/lib/utils';

type Variant = 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive';
type Size = 'default' | 'sm' | 'icon';

interface Props {
    variant?: Variant;
    size?: Size;
    class?: string;
    disabled?: boolean;
    type?: 'button' | 'submit' | 'reset';
}

withDefaults(defineProps<Props>(), {
    variant: 'default',
    size: 'default',
    type: 'button',
    disabled: false,
});

const variantClass: Record<Variant, string> = {
    default: 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90',
    secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
    outline: 'border border-border bg-transparent hover:bg-accent hover:text-accent-foreground',
    ghost: 'hover:bg-accent hover:text-accent-foreground',
    destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
};

const sizeClass: Record<Size, string> = {
    default: 'h-10 px-4 py-2',
    sm: 'h-8 rounded-md px-3 text-xs',
    icon: 'size-10',
};
</script>

<template>
    <button
        :type="type"
        :disabled="disabled"
        :class="cn(
            'ui-button inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium',
            'transition-[color,background-color,border-color,box-shadow,scale,opacity] duration-150 ease-out',
            'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:border-ring',
            'active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50',
            variantClass[variant],
            sizeClass[size],
            $props.class,
        )"
    >
        <slot />
    </button>
</template>
