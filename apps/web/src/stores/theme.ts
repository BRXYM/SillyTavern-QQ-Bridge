import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

export type Theme = 'light' | 'dark';

export const useThemeStore = defineStore('theme', () => {
    const theme = ref<Theme>(readInitial());

    function readInitial(): Theme {
        try {
            const saved = localStorage.getItem('bridge_theme');
            if (saved === 'light' || saved === 'dark') return saved;
        } catch {
            /* 忽略 */
        }
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    function apply() {
        const root = document.documentElement;
        if (theme.value === 'dark') {
            root.classList.add('dark');
            root.dataset['theme'] = 'dark';
            root.style.colorScheme = 'dark';
        } else {
            root.classList.remove('dark');
            root.dataset['theme'] = 'light';
            root.style.colorScheme = 'light';
        }
        try {
            localStorage.setItem('bridge_theme', theme.value);
        } catch {
            /* 忽略 */
        }
    }

    function toggle() {
        theme.value = theme.value === 'dark' ? 'light' : 'dark';
        apply();
    }

    const isDark = computed(() => theme.value === 'dark');

    return { theme, isDark, apply, toggle };
});
