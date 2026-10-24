<script setup lang="ts">
import { onMounted } from 'vue';
import { useThemeStore } from '@/stores/theme';
import AppLayout from '@/components/layout/AppLayout.vue';
import ToastHost from '@/components/ui/ToastHost.vue';

const theme = useThemeStore();

onMounted(() => {
    theme.apply();
});
</script>

<template>
    <AppLayout />
    <ToastHost />
</template>
