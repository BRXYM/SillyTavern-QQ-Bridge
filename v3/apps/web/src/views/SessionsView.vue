<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { Users } from 'lucide-vue-next';
import { useStatusStore } from '@/stores/status';
import UiCard from '@/components/ui/UiCard.vue';
import UiBadge from '@/components/ui/UiBadge.vue';
import UiSelect from '@/components/ui/UiSelect.vue';
import { api } from '@/api/client';
import { useToastStore } from '@/stores/toast';

const store = useStatusStore();
const toast = useToastStore();

onMounted(() => void store.refresh());

const sessionKeys = computed(() => {
    const stats = Object.keys(store.status?.sessions ?? {});
    const choices = Object.keys(store.status?.sessionChoices ?? {});
    return [...new Set([...stats, ...choices])].sort();
});

function charOptions() {
    return [
        { value: '', label: '（用默认）' },
        ...(store.status?.catalogs.characters ?? []).map((c) => ({ value: c, label: c })),
    ];
}

function worldOptions() {
    return [
        { value: '', label: '（用默认）' },
        ...(store.status?.catalogs.worlds ?? []).map((w) => ({ value: w, label: w })),
    ];
}

async function setCharacter(key: string, value: string) {
    try {
        await api.updateSession({ sessionKey: key, character: value });
        await store.refresh();
        toast.success('角色已切换', `${key} → ${value || '继承默认'}`);
    } catch (e) {
        toast.error('切换失败', e instanceof Error ? e.message : String(e));
    }
}

async function setWorld(key: string, value: string) {
    try {
        await api.updateSession({ sessionKey: key, world: value });
        await store.refresh();
        toast.success('世界书已绑定', `${key} → ${value || '继承默认'}`);
    } catch (e) {
        toast.error('绑定失败', e instanceof Error ? e.message : String(e));
    }
}

async function clearAll(key: string) {
    try {
        await api.updateSession({ sessionKey: key, reset: true });
        await store.refresh();
        toast.info('已清除配置', `${key} 恢复为全部继承默认`);
    } catch (e) {
        toast.error('清除失败', e instanceof Error ? e.message : String(e));
    }
}

const defaults = computed(() => (store.status?.config['defaults'] ?? {}) as { character?: string; world?: string });
</script>

<template>
    <div class="flex flex-col gap-5">
        <UiCard>
            <div class="border-b border-border/60 px-5 py-4">
                <h2 class="text-sm font-semibold tracking-tight">会话级配置</h2>
                <p class="text-xs text-muted-foreground">
                    每个 QQ 号可独立设置角色与世界书。留空表示继承全局默认。
                </p>
            </div>

            <div v-if="sessionKeys.length === 0" class="flex flex-col items-center gap-2 px-5 py-12">
                <Users class="size-8 text-muted-foreground/40" />
                <p class="text-sm text-muted-foreground">还没有会话记录</p>
                <p class="text-xs text-muted-foreground/70">QQ 发一条消息后会话会自动出现</p>
            </div>

            <div v-else class="divide-y divide-border/50">
                <div v-for="key in sessionKeys" :key="key" class="px-5 py-4">
                    <div class="mb-3 flex items-center justify-between gap-2">
                        <div class="flex items-center gap-2">
                            <UiBadge tone="outline" class="font-mono text-micro">{{ key }}</UiBadge>
                            <UiBadge
                                v-if="!store.status?.sessionChoices[key]"
                                tone="success"
                            >
                                新
                            </UiBadge>
                        </div>
                        <button
                            class="text-xs text-muted-foreground transition-colors hover:text-destructive"
                            @click="clearAll(key)"
                        >
                            清除配置
                        </button>
                    </div>

                    <div class="grid gap-3 sm:grid-cols-2">
                        <div>
                            <label class="text-xs font-medium text-muted-foreground">角色</label>
                            <UiSelect
                                :model-value="store.status?.sessionChoices[key]?.character ?? ''"
                                :options="charOptions()"
                                class="mt-1"
                                @update:model-value="(v: string) => setCharacter(key, v)"
                            />
                        </div>
                        <div>
                            <label class="text-xs font-medium text-muted-foreground">世界书</label>
                            <UiSelect
                                :model-value="store.status?.sessionChoices[key]?.world ?? ''"
                                :options="worldOptions()"
                                class="mt-1"
                                @update:model-value="(v: string) => setWorld(key, v)"
                            />
                        </div>
                    </div>

                    <p class="mt-2 text-xs text-muted-foreground/70">
                        默认：角色 {{ defaults.character || '(未设)' }} / 世界书 {{ defaults.world || '(未设)' }}
                    </p>
                </div>
            </div>
        </UiCard>
    </div>
</template>
