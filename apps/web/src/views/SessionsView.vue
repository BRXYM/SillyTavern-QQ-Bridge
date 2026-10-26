<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Users, Star, Save, RotateCcw, Info } from 'lucide-vue-next';
import { useStatusStore } from '@/stores/status';
import UiCard from '@/components/ui/UiCard.vue';
import UiBadge from '@/components/ui/UiBadge.vue';
import UiSelect from '@/components/ui/UiSelect.vue';
import UiButton from '@/components/ui/UiButton.vue';
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

// ---------------- 全局默认（可编辑） ----------------
const defaults = computed(
    () => (store.status?.config['defaults'] ?? {}) as { character?: string; world?: string },
);

const defCharacter = ref('');
const defWorld = ref('');
const savingDefaults = ref(false);
/** 已保存值的快照，用于判断脏状态 */
const savedSnapshot = ref('');

function syncDefaultsFromStore() {
    defCharacter.value = defaults.value.character ?? '';
    defWorld.value = defaults.value.world ?? '';
    savedSnapshot.value = `${defCharacter.value}\u0000${defWorld.value}`;
}

const defaultsDirty = computed(
    () => `${defCharacter.value}\u0000${defWorld.value}` !== savedSnapshot.value,
);

async function saveDefaults() {
    savingDefaults.value = true;
    try {
        await api.updateConfig({
            defaults: {
                character: defCharacter.value,
                world: defWorld.value,
            },
        });
        await store.refresh();
        syncDefaultsFromStore();
        toast.success(
            '默认配置已保存',
            `角色 ${defCharacter.value || '(未设)'} / 世界书 ${defWorld.value || '(未设)'}`,
        );
    } catch (e) {
        toast.error('保存失败', e instanceof Error ? e.message : String(e));
    } finally {
        savingDefaults.value = false;
    }
}

function resetDefaults() {
    defCharacter.value = defaults.value.character ?? '';
    defWorld.value = defaults.value.world ?? '';
    toast.info('已还原为当前保存值');
}

/** 首次加载 / 刷新后同步表单 */
onMounted(() => {
    void store.refresh().then(() => syncDefaultsFromStore());
});

// ---------------- 会话级 ----------------
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

/** 会话实际生效的角色/世界书（含继承） */
function effective(key: string, field: 'character' | 'world'): { value: string; inherited: boolean } {
    const own = store.status?.sessionChoices[key]?.[field];
    if (own) return { value: own, inherited: false };
    const d = defaults.value[field] ?? '';
    return { value: d, inherited: true };
}
</script>

<template>
    <div class="flex flex-col gap-5">
        <!-- ============ 全局默认 ============ -->
        <UiCard>
            <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-5 py-4">
                <div class="flex items-center gap-3">
                    <div class="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                        <Star class="size-5" />
                    </div>
                    <div>
                        <h2 class="text-sm font-semibold tracking-tight">全局默认</h2>
                        <p class="text-xs text-muted-foreground">
                            会话未单独指定时，自动使用这里的角色与世界书
                        </p>
                    </div>
                </div>
                <UiBadge v-if="defaultsDirty" tone="warning" class="text-micro">未保存</UiBadge>
            </div>

            <div class="grid gap-4 px-5 py-4 sm:grid-cols-2">
                <div>
                    <label class="text-xs font-medium text-muted-foreground">默认角色</label>
                    <UiSelect v-model="defCharacter" :options="charOptions()" class="mt-1.5" />
                    <p class="mt-1 text-[11px] text-muted-foreground/70">
                        酒馆未选角色时自动切换到该角色
                    </p>
                </div>
                <div>
                    <label class="text-xs font-medium text-muted-foreground">默认世界书</label>
                    <UiSelect v-model="defWorld" :options="worldOptions()" class="mt-1.5" />
                    <p class="mt-1 text-[11px] text-muted-foreground/70">
                        新会话默认激活的世界书，留空则不激活
                    </p>
                </div>
            </div>

            <div class="flex flex-wrap items-center gap-2 border-t border-border/60 px-5 py-3">
                <UiButton size="sm" :disabled="savingDefaults || !defaultsDirty" @click="saveDefaults">
                    <Save class="size-4" />
                    {{ savingDefaults ? '保存中…' : '保存默认配置' }}
                </UiButton>
                <UiButton variant="outline" size="sm" :disabled="!defaultsDirty" @click="resetDefaults">
                    <RotateCcw class="size-4" />
                    还原
                </UiButton>
                <div class="flex-1" />
                <span class="text-[11px] text-muted-foreground">
                    已加载 {{ store.status?.catalogs.characters.length ?? 0 }} 个角色 /
                    {{ store.status?.catalogs.worlds.length ?? 0 }} 本世界书
                </span>
            </div>

            <div class="border-t border-border/40 px-5 py-2.5">
                <p class="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                    <Info class="mt-0.5 size-3.5 shrink-0" />
                    清单来自酒馆扩展上报与本地扫描。若列表不全，可到「系统设置」点「刷新清单」
                </p>
            </div>
        </UiCard>

        <!-- ============ 会话级配置 ============ -->
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
                            <UiBadge v-if="!store.status?.sessionChoices[key]" tone="success">新</UiBadge>
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
                            <div class="flex items-center justify-between">
                                <label class="text-xs font-medium text-muted-foreground">角色</label>
                                <span
                                    v-if="effective(key, 'character').inherited"
                                    class="text-[10px] text-muted-foreground/70"
                                >
                                    继承默认
                                </span>
                            </div>
                            <UiSelect
                                :model-value="store.status?.sessionChoices[key]?.character ?? ''"
                                :options="charOptions()"
                                class="mt-1"
                                @update:model-value="(v: string) => setCharacter(key, v)"
                            />
                        </div>
                        <div>
                            <div class="flex items-center justify-between">
                                <label class="text-xs font-medium text-muted-foreground">世界书</label>
                                <span
                                    v-if="effective(key, 'world').inherited"
                                    class="text-[10px] text-muted-foreground/70"
                                >
                                    继承默认
                                </span>
                            </div>
                            <UiSelect
                                :model-value="store.status?.sessionChoices[key]?.world ?? ''"
                                :options="worldOptions()"
                                class="mt-1"
                                @update:model-value="(v: string) => setWorld(key, v)"
                            />
                        </div>
                    </div>

                    <p class="mt-2 text-[11px] text-muted-foreground/70">
                        实际生效：角色
                        <span
                            :class="effective(key, 'character').inherited ? 'text-muted-foreground' : 'text-primary'"
                        >
                            {{ effective(key, 'character').value || '(未设)' }}
                        </span>
                        <span class="mx-1 opacity-40">·</span>
                        世界书
                        <span
                            :class="effective(key, 'world').inherited ? 'text-muted-foreground' : 'text-primary'"
                        >
                            {{ effective(key, 'world').value || '(未设)' }}
                        </span>
                    </p>
                </div>
            </div>
        </UiCard>
    </div>
</template>
