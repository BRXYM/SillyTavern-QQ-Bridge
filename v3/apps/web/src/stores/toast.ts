import { defineStore } from 'pinia';
import { ref } from 'vue';

export type ToastTone = 'default' | 'success' | 'warning' | 'error' | 'info';

export interface ToastItem {
    id: number;
    title: string;
    description?: string;
    tone: ToastTone;
    /** 存活时长（毫秒） */
    duration: number;
    /** 创建时间戳，用于计算剩余进度 */
    createdAt: number;
    /** 是否处于暂停（hover）状态 */
    paused: boolean;
    /** 暂停时的剩余毫秒 */
    remaining: number;
}

let seq = 0;

export const useToastStore = defineStore('toast', () => {
    const items = ref<ToastItem[]>([]);

    function push(opts: {
        title: string;
        description?: string;
        tone?: ToastTone;
        duration?: number;
    }): number {
        const id = ++seq;
        const duration = opts.duration ?? 3000;
        items.value.push({
            id,
            title: opts.title,
            description: opts.description,
            tone: opts.tone ?? 'default',
            duration,
            createdAt: Date.now(),
            paused: false,
            remaining: duration,
        });
        return id;
    }

    function dismiss(id: number) {
        const i = items.value.findIndex((t) => t.id === id);
        if (i >= 0) items.value.splice(i, 1);
    }

    function pause(id: number) {
        const t = items.value.find((x) => x.id === id);
        if (!t || t.paused) return;
        const elapsed = Date.now() - t.createdAt;
        t.remaining = Math.max(0, t.remaining - elapsed);
        t.paused = true;
        t.createdAt = Date.now();
    }

    function resume(id: number) {
        const t = items.value.find((x) => x.id === id);
        if (!t || !t.paused) return;
        t.paused = false;
        t.createdAt = Date.now();
    }

    const success = (title: string, description?: string) =>
        push({ title, description, tone: 'success' });
    const error = (title: string, description?: string) =>
        push({ title, description, tone: 'error' });
    const warning = (title: string, description?: string) =>
        push({ title, description, tone: 'warning' });
    const info = (title: string, description?: string) =>
        push({ title, description, tone: 'info' });

    return { items, push, dismiss, pause, resume, success, error, warning, info };
});
