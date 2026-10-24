<script setup lang="ts">
import { cn } from '@/lib/utils';

interface Props {
    modelValue: string | number;
    placeholder?: string;
    type?: string;
    class?: string;
    disabled?: boolean;
    mono?: boolean;
}

withDefaults(defineProps<Props>(), {
    type: 'text',
    disabled: false,
    mono: false,
});

const emit = defineEmits<{
    'update:modelValue': [value: string];
    change: [value: string];
}>();

function onInput(e: Event) {
    emit('update:modelValue', (e.target as HTMLInputElement).value);
}

function onChange(e: Event) {
    emit('change', (e.target as HTMLInputElement).value);
}
</script>

<template>
    <input
        data-ui-control
        :type="type"
        :value="modelValue"
        :placeholder="placeholder"
        :disabled="disabled"
        :class="cn(
            'flex h-10 w-full min-w-0 appearance-none rounded-md border border-border bg-transparent',
            'px-3 py-1 text-sm shadow-xs transition-[color,box-shadow] outline-none',
            'placeholder:text-muted-foreground',
            'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40',
            'disabled:cursor-not-allowed disabled:opacity-50',
            mono && 'font-mono tabular-nums text-xs',
            $props.class,
        )"
        @input="onInput"
        @change="onChange"
    />
</template>
