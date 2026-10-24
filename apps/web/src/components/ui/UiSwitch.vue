<script setup lang="ts">
import { cn } from '@/lib/utils';

interface Props {
    modelValue: boolean;
    class?: string;
    disabled?: boolean;
}

withDefaults(defineProps<Props>(), { disabled: false });

const emit = defineEmits<{ 'update:modelValue': [v: boolean] }>();
</script>

<template>
    <button
        type="button"
        role="switch"
        :aria-checked="modelValue"
        :disabled="disabled"
        :class="cn(
            'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
            'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40',
            'disabled:cursor-not-allowed disabled:opacity-50',
            modelValue ? 'bg-primary' : 'bg-foreground/20',
            $props.class,
        )"
        @click="emit('update:modelValue', !modelValue)"
    >
        <span
            :class="cn(
                'inline-block size-4 rounded-full bg-white shadow-sm ring-1 ring-black/10',
                'transition-transform duration-200 ease-out',
                modelValue ? 'translate-x-[22px]' : 'translate-x-1',
            )"
        />
    </button>
</template>
