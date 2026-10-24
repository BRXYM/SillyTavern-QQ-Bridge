<script setup lang="ts">
import { cn } from '@/lib/utils';

interface Option {
    value: string;
    label: string;
}

interface Props {
    modelValue: string;
    options: Option[];
    class?: string;
    disabled?: boolean;
    placeholder?: string;
}

withDefaults(defineProps<Props>(), { disabled: false });

const emit = defineEmits<{ 'update:modelValue': [v: string] }>();
</script>

<template>
    <select
        data-ui-control
        :value="modelValue"
        :disabled="disabled"
        :class="cn(
            'flex h-10 w-full appearance-none rounded-md border border-border bg-transparent',
            'px-3 py-1 text-sm outline-none transition-[color,box-shadow]',
            'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40',
            'disabled:cursor-not-allowed disabled:opacity-50',
            'bg-[length:16px] bg-[right_0.6rem_center] bg-no-repeat',
            $props.class,
        )"
        :style="{
            backgroundImage:
                'url(\'data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%23888%22 stroke-width=%222%22><path d=%22M6 9l6 6 6-6%22/></svg>\')',
        }"
        @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
    >
        <option v-if="placeholder" value="">{{ placeholder }}</option>
        <option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option>
    </select>
</template>
