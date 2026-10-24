<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { Save, RefreshCw, Wifi, SlidersHorizontal } from 'lucide-vue-next';
import { useStatusStore } from '@/stores/status';
import UiCard from '@/components/ui/UiCard.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiInput from '@/components/ui/UiInput.vue';
import UiSwitch from '@/components/ui/UiSwitch.vue';
import UiSelect from '@/components/ui/UiSelect.vue';
import { api } from '@/api/client';
import { useToastStore } from '@/stores/toast';

const store = useStatusStore();
const toast = useToastStore();

const onebotUrl = ref('ws://127.0.0.1:3001');
const onebotToken = ref('');
const maxMessageLength = ref(2000);
const atOnly = ref(false);
const privateReply = ref(true);
const allowedUsers = ref('');
const allowedGroups = ref('');
const defaultCharacter = ref('');
const defaultWorld = ref('');
const stDataDir = ref('');

const saved = ref(false);

onMounted(async () => {
    await store.refresh();
    const c = store.status?.config as Record<string, unknown> | undefined;
    if (!c) return;

    const ob = (c['onebot'] ?? {}) as { url?: string; token?: string };
    onebotUrl.value = ob.url ?? 'ws://127.0.0.1:3001';
    onebotToken.value = ob.token ?? '';

    const lim = (c['limits'] ?? {}) as { maxMessageLength?: number };
    maxMessageLength.value = lim.maxMessageLength ?? 2000;

    const tr = (c['trigger'] ?? {}) as {
        atOnly?: boolean;
        privateReply?: boolean;
        allowedUsers?: number[];
        allowedGroups?: number[];
    };
    atOnly.value = tr.atOnly ?? false;
    privateReply.value = tr.privateReply ?? true;
    allowedUsers.value = (tr.allowedUsers ?? []).join(',');
    allowedGroups.value = (tr.allowedGroups ?? []).join(',');

    const df = (c['defaults'] ?? {}) as { character?: string; world?: string };
    defaultCharacter.value = df.character ?? '';
    defaultWorld.value = df.world ?? '';

    stDataDir.value = (c['stDataDir'] as string) ?? '';
});

function parseList(s: string): number[] {
    return s.split(',').map((x) => x.trim()).filter(Boolean).map(Number).filter(Number.isFinite);
}

async function save() {
    await api.updateConfig({
        onebot: { url: onebotUrl.value.trim(), token: onebotToken.value.trim() },
        limits: { maxMessageLength: maxMessageLength.value },
        trigger: {
            atOnly: atOnly.value,
            privateReply: privateReply.value,
            allowedUsers: parseList(allowedUsers.value),
            allowedGroups: parseList(allowedGroups.value),
        },
        defaults: { character: defaultCharacter.value, world: defaultWorld.value },
        stDataDir: stDataDir.value.trim(),
    });
    saved.value = true;
    setTimeout(() => (saved.value = false), 2000);
    toast.success('设置已保存', '连接与触发规则已更新');
    await store.refresh();
}

async function refreshCatalog() {
    try {
        await api.refreshCatalog();
        await store.refresh();
        toast.info('清单已刷新', `${store.status?.catalogs.characters.length ?? 0} 个角色 / ${store.status?.catalogs.worlds.length ?? 0} 本世界书`);
    } catch (e) {
        toast.error('刷新失败', e instanceof Error ? e.message : String(e));
    }
}

function charOptions() {
    return [
        { value: '', label: '（不自动选择）' },
        ...(store.status?.catalogs.characters ?? []).map((c) => ({ value: c, label: c })),
    ];
}
function worldOptions() {
    return [
        { value: '', label: '（不自动激活）' },
        ...(store.status?.catalogs.worlds ?? []).map((w) => ({ value: w, label: w })),
    ];
}
</script>

<template>
    <div class="flex flex-col gap-5">
        <!-- 上游连接 -->
        <UiCard>
            <div class="flex items-center gap-3 border-b border-border/60 px-5 py-4">
                <div class="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <Wifi class="size-5" />
                </div>
                <div>
                    <h2 class="text-sm font-semibold tracking-tight">OneBot 连接</h2>
                    <p class="text-xs text-muted-foreground">连接 SnowLuma 的 WebSocket 服务端</p>
                </div>
            </div>

            <div class="grid gap-4 px-5 py-4 sm:grid-cols-2">
                <div>
                    <label class="text-xs font-medium text-muted-foreground">WebSocket 地址</label>
                    <UiInput v-model="onebotUrl" class="mt-1" mono />
                </div>
                <div>
                    <label class="text-xs font-medium text-muted-foreground">Access Token</label>
                    <UiInput v-model="onebotToken" type="password" class="mt-1" mono />
                </div>
                <div>
                    <label class="text-xs font-medium text-muted-foreground">单条消息长度上限</label>
                    <UiInput v-model.number="maxMessageLength" type="number" class="mt-1" />
                </div>
            </div>
        </UiCard>

        <!-- 触发规则 -->
        <UiCard>
            <div class="flex items-center gap-3 border-b border-border/60 px-5 py-4">
                <div class="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <SlidersHorizontal class="size-5" />
                </div>
                <div>
                    <h2 class="text-sm font-semibold tracking-tight">触发规则</h2>
                    <p class="text-xs text-muted-foreground">控制哪些消息会被转发到酒馆</p>
                </div>
            </div>

            <div class="divide-y divide-border/40">
                <div class="flex items-center justify-between px-5 py-3.5">
                    <div>
                        <p class="text-sm">群聊仅在 @ 机器人时响应</p>
                        <p class="text-xs text-muted-foreground">关闭后群里所有消息都会触发</p>
                    </div>
                    <UiSwitch v-model="atOnly" />
                </div>
                <div class="flex items-center justify-between px-5 py-3.5">
                    <div>
                        <p class="text-sm">私聊自动回复</p>
                        <p class="text-xs text-muted-foreground">关闭后私聊消息不处理</p>
                    </div>
                    <UiSwitch v-model="privateReply" />
                </div>
            </div>

            <div class="grid gap-4 border-t border-border/40 px-5 py-4 sm:grid-cols-2">
                <div>
                    <label class="text-xs font-medium text-muted-foreground">用户白名单（逗号分隔 QQ 号）</label>
                    <UiInput v-model="allowedUsers" class="mt-1" mono placeholder="留空 = 不限制" />
                </div>
                <div>
                    <label class="text-xs font-medium text-muted-foreground">群白名单（逗号分隔群号）</label>
                    <UiInput v-model="allowedGroups" class="mt-1" mono placeholder="留空 = 不限制" />
                </div>
            </div>
        </UiCard>

        <!-- 默认角色 / 世界书 -->
        <UiCard>
            <div class="flex items-center justify-between border-b border-border/60 px-5 py-4">
                <div>
                    <h2 class="text-sm font-semibold tracking-tight">默认角色 / 世界书</h2>
                    <p class="text-xs text-muted-foreground">酒馆未选择角色时自动使用</p>
                </div>
                <UiButton variant="ghost" size="sm" @click="refreshCatalog">
                    <RefreshCw class="size-4" />
                    刷新清单
                </UiButton>
            </div>

            <div class="grid gap-4 px-5 py-4 sm:grid-cols-2">
                <div>
                    <label class="text-xs font-medium text-muted-foreground">默认角色</label>
                    <UiSelect v-model="defaultCharacter" :options="charOptions()" class="mt-1" />
                </div>
                <div>
                    <label class="text-xs font-medium text-muted-foreground">默认世界书</label>
                    <UiSelect v-model="defaultWorld" :options="worldOptions()" class="mt-1" />
                </div>
                <div class="sm:col-span-2">
                    <label class="text-xs font-medium text-muted-foreground">酒馆数据目录</label>
                    <UiInput v-model="stDataDir" class="mt-1" mono />
                    <p class="mt-1 text-xs text-muted-foreground">
                        用于扫描角色卡与世界书清单
                    </p>
                </div>
            </div>
        </UiCard>

        <!-- 保存 -->
        <div class="flex items-center gap-3">
            <UiButton @click="save">
                <Save class="size-4" />
                保存全部设置
            </UiButton>
            <span v-if="saved" class="text-xs text-success">已保存</span>
        </div>
    </div>
</template>
