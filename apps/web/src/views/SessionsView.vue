<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import {
    Users, Star, Save, RotateCcw, Info, SlidersHorizontal, ShieldCheck, Settings2,
} from 'lucide-vue-next';
import { useStatusStore } from '@/stores/status';
import UiCard from '@/components/ui/UiCard.vue';
import UiBadge from '@/components/ui/UiBadge.vue';
import UiSelect from '@/components/ui/UiSelect.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiInput from '@/components/ui/UiInput.vue';
import IdListEditor from '@/components/ui/IdListEditor.vue';
import DownstreamBehaviorEditor, {
    type BehaviorSettings,
} from '@/components/ui/DownstreamBehaviorEditor.vue';
import UiSwitch from '@/components/ui/UiSwitch.vue';
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

// ---------------- 触发规则 / 消息限制（原系统设置页迁入） ----------------
const atOnly = ref(false);
const privateReply = ref(true);
const maxMessageLength = ref(2000);
const savingRules = ref(false);
const rulesSnapshot = ref('');

/** 规则表单序列化，用于脏状态判断 */
function rulesSignature(): string {
    return [atOnly.value, privateReply.value, maxMessageLength.value].join('\u0000');
}

const rulesDirty = computed(() => rulesSignature() !== rulesSnapshot.value);

function syncRulesFromStore() {
    const c = store.status?.config as Record<string, unknown> | undefined;
    if (!c) return;

    const tr = (c['trigger'] ?? {}) as { atOnly?: boolean; privateReply?: boolean };
    atOnly.value = tr.atOnly ?? false;
    privateReply.value = tr.privateReply ?? true;

    // 后端使用扁平字段 maxMessageLength
    if (typeof c['maxMessageLength'] === 'number') {
        maxMessageLength.value = c['maxMessageLength'] as number;
    }

    rulesSnapshot.value = rulesSignature();
}

async function saveRules() {
    savingRules.value = true;
    try {
        await api.updateConfig({
            trigger: {
                atOnly: atOnly.value,
                privateReply: privateReply.value,
            },
            maxMessageLength: maxMessageLength.value,
        });
        await store.refresh();
        syncRulesFromStore();
        toast.success('规则已保存', '触发条件与消息限制已更新');
    } catch (e) {
        toast.error('保存失败', e instanceof Error ? e.message : String(e));
    } finally {
        savingRules.value = false;
    }
}

function resetRules() {
    syncRulesFromStore();
    toast.info('已还原为当前保存值');
}

// ---------------- 会话准入（黑白名单） ----------------
const denyUsers = ref<number[]>([]);
const denyGroups = ref<number[]>([]);
const allowUsers = ref<number[]>([]);
const allowGroups = ref<number[]>([]);
const unknownPolicy = ref<'allow' | 'deny'>('allow');
const denyReply = ref('');
const savingAccess = ref(false);
const accessSnapshot = ref('');
/** 被拒的新会话（控制台可一键加白） */
const pendingList = ref<Array<{ key: string; userId: number; senderName: string; lastAt: string }>>([]);

function accessSignature(): string {
    return [
        denyUsers.value.join(','),
        denyGroups.value.join(','),
        allowUsers.value.join(','),
        allowGroups.value.join(','),
        unknownPolicy.value,
        denyReply.value,
    ].join('\u0000');
}

const accessDirty = computed(() => accessSignature() !== accessSnapshot.value);

function syncAccessFromStore() {
    const c = store.status?.config as Record<string, unknown> | undefined;
    const sa = (c?.['sessionAccess'] ?? {}) as {
        denyUsers?: number[];
        denyGroups?: number[];
        allowUsers?: number[];
        allowGroups?: number[];
        unknownPolicy?: 'allow' | 'deny';
        denyReply?: string;
    };
    denyUsers.value = sa.denyUsers ?? [];
    denyGroups.value = sa.denyGroups ?? [];
    allowUsers.value = sa.allowUsers ?? [];
    allowGroups.value = sa.allowGroups ?? [];
    unknownPolicy.value = sa.unknownPolicy === 'deny' ? 'deny' : 'allow';
    denyReply.value = sa.denyReply ?? '';
    accessSnapshot.value = accessSignature();
}

async function saveAccess() {
    savingAccess.value = true;
    try {
        await api.updateSessionAccess({
            access: {
                denyUsers: denyUsers.value,
                denyGroups: denyGroups.value,
                allowUsers: allowUsers.value,
                allowGroups: allowGroups.value,
                unknownPolicy: unknownPolicy.value,
                denyReply: denyReply.value,
            },
        });
        await store.refresh();
        await loadPending();
        syncAccessFromStore();
        toast.success('会话准入已保存', '黑白名单立即生效');
    } catch (e) {
        toast.error('保存失败', e instanceof Error ? e.message : String(e));
    } finally {
        savingAccess.value = false;
    }
}

function resetAccess() {
    syncAccessFromStore();
    toast.info('已还原为当前保存值');
}

/** 拉取被拒的新会话 */
async function loadPending() {
    try {
        const r = await api.sessionAccess();
        const p = (r.pending ?? {}) as Record<string, {
            userId: number;
            senderName: string;
            lastAt: string;
        }>;
        pendingList.value = Object.entries(p).map(([key, v]) => ({
            key,
            userId: v.userId,
            senderName: v.senderName,
            lastAt: v.lastAt,
        }));
    } catch {
        pendingList.value = [];
    }
}

/** 把某个被拒的用户加入白名单 */
async function approvePending(userId: number) {
    if (!allowUsers.value.includes(userId)) allowUsers.value.push(userId);
    await saveAccess();
}

function formatTime(iso: string): string {
    try {
        return new Date(iso).toLocaleString();
    } catch {
        return iso;
    }
}

/** 首次加载 / 刷新后同步表单 */
onMounted(() => {
    void store.refresh().then(() => {
        syncDefaultsFromStore();
        syncRulesFromStore();
        syncAccessFromStore();
        void loadPending();
    });
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

/**
 * 会话级下游。
 *
 * 下游是「实例」而不是固定枚举：后端配置里可以有多个（dsh、dsh-e2e、酒馆…），
 * 这里直接把它们列出来。value='' 表示继承全局默认。
 */
async function setDownstream(key: string, value: string) {
    try {
        await api.updateSession({ sessionKey: key, backendId: value });
        await store.refresh();
        if (value === '') {
            toast.info('已改为继承全局', `${key} → ${globalDownstreamLabel.value}`);
        } else {
            const name = downstreamName(value);
            toast.success('该会话已切换下游', `${key} → ${name}`);
        }
    } catch (e) {
        toast.error('切换失败', e instanceof Error ? e.message : String(e));
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

// ---------------- 会话级下游 ----------------

/** 可选的下游实例（来自后端状态） */
const downstreamList = computed(() => store.status?.downstreams ?? []);

/** 全局默认下游 id */
const globalDownstreamId = computed(() => store.status?.defaultDownstreamId ?? '');

/** 全局默认下游的显示名 */
const globalDownstreamLabel = computed(() => downstreamName(globalDownstreamId.value));

/** 某 id 的显示名（找不到时原样显示 id） */
function downstreamName(id: string): string {
    if (!id) return '(未设置)';
    const hit = downstreamList.value.find((d) => d.id === id);
    return hit ? hit.name || hit.id : id;
}

/** 下拉选项：继承 + 所有已注册实例 */
const downstreamOptions = computed(() => [
    { value: '', label: `继承全局（${globalDownstreamLabel.value}）` },
    ...downstreamList.value.map((d) => ({
        value: d.id,
        label: `${d.name || d.id}${d.available ? '' : '（离线）'}`,
    })),
]);

/** 该会话实际生效的下游（后端已算好则直接用） */
function effectiveDownstream(key: string): {
    backendId: string;
    inherited: boolean;
    profileId: string;
    profileInherited: boolean;
} {
    const fromServer = store.status?.sessionBackends?.[key];
    if (fromServer) {
        return {
            backendId: fromServer.backendId,
            inherited: fromServer.inherited,
            profileId: fromServer.profileId ?? '',
            profileInherited: store.status?.sessionChoices[key]?.profileId === undefined,
        };
    }
    const own = store.status?.sessionChoices[key];
    if (own?.backendId) {
        return {
            backendId: own.backendId,
            inherited: false,
            profileId: own.profileId ?? '',
            profileInherited: own.profileId === undefined,
        };
    }
    return {
        backendId: globalDownstreamId.value,
        inherited: true,
        profileId: own?.profileId ?? '',
        profileInherited: own?.profileId === undefined,
    };
}

/** 该下游是否是 dsh（用于配色与文案） */
function isDsh(id: string): boolean {
    const hit = downstreamList.value.find((d) => d.id === id);
    return hit ? hit.kind.startsWith('dsh') : id.startsWith('dsh');
}

// ---------------- 下游命名配置 ----------------

interface ProfileItem {
    id: string;
    name: string;
    settings: Record<string, unknown>;
}

/** 从配置里读某个下游实例的所有命名配置 */
function profilesOf(backendId: string): ProfileItem[] {
    const list = (store.status?.config?.['downstreams'] ?? []) as Array<{
        id: string;
        profiles?: ProfileItem[];
    }>;
    const hit = list.find((d) => d.id === backendId);
    return hit?.profiles ?? [];
}

/** 全局默认配置 id */
const globalProfileId = computed(() => store.status?.defaultDownstreamProfileId ?? '');

/** 配置下拉选项：继承 + 该实例下的所有配置 */
function profileOptions(backendId: string): Array<{ value: string; label: string }> {
    const profiles = profilesOf(backendId);
    const inheritLabel = globalProfileId.value
        ? `继承全局（${profileName(backendId, globalProfileId.value)}）`
        : '继承全局（实例设置）';
    return [
        { value: '', label: inheritLabel },
        ...profiles.map((p) => ({ value: p.id, label: p.name || p.id })),
    ];
}

/** 配置显示名 */
function profileName(backendId: string, profileId: string): string {
    if (!profileId) return '';
    const hit = profilesOf(backendId).find((p) => p.id === profileId);
    return hit ? hit.name || hit.id : profileId;
}

/** 切换会话的下游配置 */
async function setProfile(key: string, value: string): Promise<void> {
    try {
        await api.updateSession({ sessionKey: key, profileId: value });
        await store.refresh();
        if (value === '') {
            toast.info('已改为继承全局配置');
        } else {
            const backendId = effectiveDownstream(key).backendId;
            toast.success('该会话已切换配置', profileName(backendId, value));
        }
    } catch (e) {
        toast.error('切换失败', e instanceof Error ? e.message : String(e));
    }
}

// ---------------- 下游配置的行为设置 ----------------
// 提示词注入 / 历史引用 / 进度转发属于「配置」而非「连接」，
// 所以编辑入口在这里，而不是下游管理页。

/** 正在编辑行为设置的组合 key：`<backendId>:<profileId>` */
const editingBehaviorOf = ref('');
/** 保存中的组合 key */
const savingBehavior = ref('');

/** 行为设置草稿（按组合 key 存） */
const behaviorDrafts = reactive<Record<string, BehaviorSettings>>({});

/** 空白的默认行为 */
function emptyBehavior(): BehaviorSettings {
    return {
        prompt: { qqBase: false, character: false, faces: false, images: false, extra: '' },
        historyExtracts: [],
        progress: { enabled: false, minIntervalMs: 4000, maxMessages: 3, prefix: '⏳ ' },
    };
}

/** 某下游实例的 kind（决定是否显示 dsh 专属项） */
function kindOf(backendId: string): string {
    return downstreamList.value.find((d) => d.id === backendId)?.kind ?? '';
}

/**
 * 打开行为设置编辑器。
 *
 * 从后端取的 `behaviors[profileId]` 是**合并后**的实际值（实例 + 配置），
 * 这样表单显示的就是真正生效的设置，不会因为只看到配置层的差异而误判。
 */
async function openBehavior(backendId: string, profileId: string): Promise<void> {
    if (!profileId) {
        toast.info('该会话正使用实例设置', '请先在上面选一个具体配置再编辑');
        return;
    }

    const combo = `${backendId}:${profileId}`;
    if (editingBehaviorOf.value === combo) {
        editingBehaviorOf.value = '';
        return;
    }

    try {
        const r = await api.downstreamProfiles(backendId);
        const b = r.behaviors?.[profileId];
        if (!b) {
            toast.warning('读不到该配置', '可能已被删除，刷新后重试');
            return;
        }
        behaviorDrafts[combo] = b;
        editingBehaviorOf.value = combo;
    } catch (e) {
        toast.error('读取配置失败', e instanceof Error ? e.message : String(e));
    }
}

/** 保存行为设置到该配置 */
async function saveBehavior(backendId: string, profileId: string): Promise<void> {
    const combo = `${backendId}:${profileId}`;
    const draft = behaviorDrafts[combo];
    if (!draft) return;

    /** 进度设置的 kinds 由后端保留默认，这里只提交可见字段 */
    const profile = profilesOf(backendId).find((p) => p.id === profileId);
    if (!profile) {
        toast.warning('配置不存在', '可能已被删除，刷新后重试');
        return;
    }

    savingBehavior.value = combo;
    try {
        await api.saveDownstreamProfile(backendId, {
            id: profileId,
            name: profile.name,
            settings: {
                ...profile.settings,
                prompt: draft.prompt,
                historyExtracts: draft.historyExtracts.filter((r) => r.pattern.trim()),
                progress: draft.progress,
            },
        });
        editingBehaviorOf.value = '';
        delete behaviorDrafts[combo];
        await store.refresh();
        toast.success('设置已保存', `${backendId} / ${profile.name || profileId}`);
    } catch (e) {
        toast.error('保存失败', e instanceof Error ? e.message : String(e));
    } finally {
        savingBehavior.value = '';
    }
}

// ---------------- 账号维度 ----------------

/** 会话 key 里的账号前缀（`<accountId>:private_...`） */
function accountOfSession(key: string): string {
    const i = key.indexOf(':');
    return i > 0 ? key.slice(0, i) : '';
}

/** 账号显示名（找不到时用 id 本身） */
function accountName(accountId: string): string {
    if (!accountId) return '';
    const hit = (store.status?.accounts ?? []).find((a) => a.id === accountId);
    return hit ? (hit.name || hit.id) : accountId;
}

/** 会话 key 去掉账号前缀后的部分（更易读） */
function sessionShortKey(key: string): string {
    const i = key.indexOf(':');
    return i > 0 ? key.slice(i + 1) : key;
}

/** 按账号分组后的会话（同号排在一起，扫一眼就知道哪个号在用） */
const groupedSessions = computed(() => {
    const groups = new Map<string, string[]>();
    for (const key of sessionKeys.value) {
        const acc = accountOfSession(key) || '(无账号)';
        const arr = groups.get(acc) ?? [];
        arr.push(key);
        groups.set(acc, arr);
    }
    return [...groups.entries()].map(([accountId, keys]) => ({
        accountId,
        keys,
        name: accountName(accountId) || accountId,
    }));
});

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

        <!-- ============ 触发规则 / 消息限制 ============ -->
        <UiCard>
            <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-5 py-4">
                <div class="flex items-center gap-3">
                    <div class="flex size-10 items-center justify-center rounded-xl bg-aurora/15 text-aurora">
                        <SlidersHorizontal class="size-5" />
                    </div>
                    <div>
                        <h2 class="text-sm font-semibold tracking-tight">触发规则</h2>
                        <p class="text-xs text-muted-foreground">
                            控制哪些 QQ 消息会被处理（酒馆与 dsh 共用）
                        </p>
                    </div>
                </div>
                <UiBadge v-if="rulesDirty" tone="warning" class="text-micro">未保存</UiBadge>
            </div>

            <div class="divide-y divide-border/40">
                <div class="flex items-center justify-between px-5 py-3.5">
                    <div class="min-w-0">
                        <p class="text-sm">群聊仅在 @ 机器人时响应</p>
                        <p class="text-xs text-muted-foreground">关闭后群里所有消息都会触发</p>
                    </div>
                    <UiSwitch v-model="atOnly" class="shrink-0" />
                </div>
                <div class="flex items-center justify-between px-5 py-3.5">
                    <div class="min-w-0">
                        <p class="text-sm">私聊自动回复</p>
                        <p class="text-xs text-muted-foreground">关闭后私聊消息不处理</p>
                    </div>
                    <UiSwitch v-model="privateReply" class="shrink-0" />
                </div>
            </div>

            <div class="grid gap-4 border-t border-border/40 px-5 py-4 sm:grid-cols-2">
                <div>
                    <label class="text-xs font-medium text-muted-foreground">单条消息长度上限</label>
                    <UiInput v-model.number="maxMessageLength" type="number" class="mt-1.5" />
                    <p class="mt-1 text-[11px] text-muted-foreground/70">
                        超出会截断并追加省略号；分段规则见「回复分段」
                    </p>
                </div>
                <div class="flex items-end">
                    <p class="text-[11px] text-muted-foreground/70">
                        用户 / 群的黑白名单已移到上方「会话准入」
                    </p>
                </div>
            </div>

            <div class="flex flex-wrap items-center gap-2 border-t border-border/60 px-5 py-3">
                <UiButton size="sm" :disabled="savingRules || !rulesDirty" @click="saveRules">
                    <Save class="size-4" />
                    {{ savingRules ? '保存中…' : '保存规则' }}
                </UiButton>
                <UiButton variant="outline" size="sm" :disabled="!rulesDirty" @click="resetRules">
                    <RotateCcw class="size-4" />
                    还原
                </UiButton>
            </div>
        </UiCard>

        <!-- ============ 会话准入（黑白名单） ============ -->
        <UiCard>
            <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-5 py-4">
                <div class="flex items-center gap-3">
                    <div class="flex size-10 items-center justify-center rounded-xl bg-warning/15 text-warning">
                        <ShieldCheck class="size-5" />
                    </div>
                    <div>
                        <h2 class="text-sm font-semibold tracking-tight">会话准入</h2>
                        <p class="text-xs text-muted-foreground">
                            决定谁有资格和机器人互动。黑名单优先，白名单留空表示不限
                        </p>
                    </div>
                </div>
                <UiBadge v-if="accessDirty" tone="warning" class="text-micro">未保存</UiBadge>
            </div>

            <div class="grid gap-5 px-5 py-4 sm:grid-cols-2">
                <div>
                    <label class="text-xs font-medium text-muted-foreground">用户黑名单</label>
                    <p class="mb-1.5 mt-0.5 text-[11px] text-muted-foreground/70">这些 QQ 号永远拒绝</p>
                    <IdListEditor
                        v-model="denyUsers"
                        placeholder="输入 QQ 号后回车"
                        empty-text="未设置，没人被拉黑"
                        hint="qq"
                        :disabled="savingAccess"
                    />
                </div>
                <div>
                    <label class="text-xs font-medium text-muted-foreground">群黑名单</label>
                    <p class="mb-1.5 mt-0.5 text-[11px] text-muted-foreground/70">这些群永远拒绝</p>
                    <IdListEditor
                        v-model="denyGroups"
                        placeholder="输入群号后回车"
                        empty-text="未设置，没有群被拉黑"
                        hint="group"
                        :disabled="savingAccess"
                    />
                </div>
                <div>
                    <label class="text-xs font-medium text-muted-foreground">用户白名单</label>
                    <p class="mb-1.5 mt-0.5 text-[11px] text-muted-foreground/70">
                        留空 = 不限制；非空时只有这些 QQ 号可用
                    </p>
                    <IdListEditor
                        v-model="allowUsers"
                        placeholder="输入 QQ 号后回车"
                        empty-text="未设置，所有人可用"
                        hint="qq"
                        :disabled="savingAccess"
                    />
                </div>
                <div>
                    <label class="text-xs font-medium text-muted-foreground">群白名单</label>
                    <p class="mb-1.5 mt-0.5 text-[11px] text-muted-foreground/70">
                        留空 = 不限制；非空时只有这些群可用
                    </p>
                    <IdListEditor
                        v-model="allowGroups"
                        placeholder="输入群号后回车"
                        empty-text="未设置，所有群可用"
                        hint="group"
                        :disabled="savingAccess"
                    />
                </div>
            </div>

            <!-- 准入规则说明 + 拒绝文案 -->
            <div class="border-t border-border/40 px-5 py-4">
                <div class="rounded-md border border-border/50 bg-accent/15 px-3 py-2.5">
                    <p class="text-[11px] font-medium">生效规则</p>
                    <ul class="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
                        <li>· 黑白名单<strong class="text-foreground">都为空</strong> → 所有人都能用</li>
                        <li>· 白名单<strong class="text-foreground">非空</strong> → 只放行名单里的（名单外一律拒绝）</li>
                        <li>· 白名单空、黑名单非空 → 拒绝黑名单里的，其余放行</li>
                        <li>· 用户与群<strong class="text-foreground">分别判断</strong>，两边都通过才回复</li>
                    </ul>
                    <p class="mt-1.5 text-[10px] text-muted-foreground/70">
                        白名单优先：同时在两个名单里时会被放行。要真正拉黑某人，
                        请先从白名单移除
                    </p>
                </div>

                <div class="mt-3">
                    <label class="text-xs font-medium text-muted-foreground">拒绝时回的话</label>
                    <UiInput
                        v-model="denyReply"
                        class="mt-1.5"
                        placeholder="留空 = 静默不回，只写日志"
                    />
                    <p class="mt-1 text-[11px] text-muted-foreground/70">
                        被准入拦下、以及下游不可用时都用这句；留空则完全不回复
                    </p>
                </div>
            </div>

            <!-- 被拒记录 -->
            <div v-if="pendingList.length > 0" class="border-t border-border/40 px-5 py-4">
                <div class="mb-2 flex items-center gap-2">
                    <p class="text-xs font-medium text-muted-foreground">待处理（被拒的新会话）</p>
                    <UiBadge tone="warning" class="text-micro">{{ pendingList.length }}</UiBadge>
                </div>
                <div class="space-y-1">
                    <div
                        v-for="p in pendingList"
                        :key="p.key"
                        class="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/50 px-2.5 py-1.5"
                    >
                        <div class="min-w-0 text-[11px]">
                            <span class="font-mono">{{ p.key }}</span>
                            <span class="ml-2 text-muted-foreground">{{ p.senderName }}</span>
                            <span class="ml-2 text-muted-foreground/60">{{ formatTime(p.lastAt) }}</span>
                        </div>
                        <UiButton
                            variant="ghost"
                            size="sm"
                            @click="approvePending(p.userId)"
                        >
                            加入白名单
                        </UiButton>
                    </div>
                </div>
            </div>

            <div class="flex flex-wrap items-center gap-2 border-t border-border/60 px-5 py-3">
                <UiButton size="sm" :disabled="savingAccess || !accessDirty" @click="saveAccess">
                    <Save class="size-4" />
                    {{ savingAccess ? '保存中…' : '保存准入' }}
                </UiButton>
                <UiButton variant="outline" size="sm" :disabled="!accessDirty" @click="resetAccess">
                    <RotateCcw class="size-4" />
                    还原
                </UiButton>
            </div>
        </UiCard>

        <!-- ============ 会话级配置 ============ -->
        <UiCard>
            <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-5 py-4">
                <div class="min-w-0">
                    <h2 class="text-sm font-semibold tracking-tight">会话级配置</h2>
                    <p class="text-xs text-muted-foreground">
                        每个 QQ 号可独立选择「回复下游」与「下游配置」（人设 / 对话约束 / 角色卡）。留空表示继承全局默认。
                    </p>
                </div>
                <UiBadge tone="outline" class="text-micro">
                    全局默认：{{ globalDownstreamLabel }}
                </UiBadge>
            </div>

            <div v-if="sessionKeys.length === 0" class="flex flex-col items-center gap-2 px-5 py-12">
                <Users class="size-8 text-muted-foreground/40" />
                <p class="text-sm text-muted-foreground">还没有会话记录</p>
                <p class="text-xs text-muted-foreground/70">QQ 发一条消息后会话会自动出现</p>
            </div>

            <div v-else class="divide-y divide-border/50">
                <template v-for="group in groupedSessions" :key="group.accountId">
                    <!-- 账号分组标题 -->
                    <div class="flex items-center gap-2 bg-accent/20 px-5 py-2">
                        <UiBadge tone="outline" class="font-mono text-micro">
                            {{ group.accountId || '(无账号)' }}
                        </UiBadge>
                        <span class="text-[11px] text-muted-foreground">
                            {{ group.name }} · {{ group.keys.length }} 个会话
                        </span>
                    </div>

                    <div v-for="key in group.keys" :key="key" class="px-5 py-4">
                        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
                            <div class="flex flex-wrap items-center gap-2">
                                <UiBadge tone="outline" class="font-mono text-micro">
                                    {{ sessionShortKey(key) }}
                                </UiBadge>
                                <UiBadge v-if="!store.status?.sessionChoices[key]" tone="success">新</UiBadge>
                                <UiBadge
                                    :tone="isDsh(effectiveDownstream(key).backendId) ? 'info' : 'success'"
                                    dot
                                    class="text-micro"
                                >
                                    {{ downstreamName(effectiveDownstream(key).backendId) }}
                                    <span v-if="effectiveDownstream(key).inherited" class="opacity-70">（继承）</span>
                                </UiBadge>
                                <UiBadge
                                    v-if="effectiveDownstream(key).profileId"
                                    tone="outline"
                                    class="text-micro"
                                >
                                    {{ profileName(
                                        effectiveDownstream(key).backendId,
                                        effectiveDownstream(key).profileId,
                                    ) }}
                                </UiBadge>
                            </div>
                            <button
                                class="text-xs text-muted-foreground transition-colors hover:text-destructive"
                                @click="clearAll(key)"
                            >
                                清除配置
                            </button>
                        </div>

                        <!-- 回复下游：dsh / 酒馆角色对话 -->
                        <div class="mb-3">
                            <label class="text-xs font-medium text-muted-foreground">回复下游</label>
                            <UiSelect
                                :model-value="store.status?.sessionChoices[key]?.backendId ?? ''"
                                :options="downstreamOptions"
                                class="mt-1"
                                @update:model-value="(v: string) => setDownstream(key, v)"
                            />
                            <p class="mt-1 text-[11px] text-muted-foreground/70">
                                <template v-if="isDsh(effectiveDownstream(key).backendId)">
                                    该会话交给 dsh 直接回答，不使用下方角色卡；群聊 @ / 私聊开关与白名单仍然生效
                                </template>
                                <template v-else>
                                    该会话走酒馆角色对话，角色的语气与人设来自下方所选角色
                                </template>
                            </p>
                        </div>

                        <!-- 下游配置：同一实例下的不同预设 -->
                        <div class="mb-3">
                            <div class="flex items-center justify-between">
                                <label class="text-xs font-medium text-muted-foreground">下游配置</label>
                                <span
                                    v-if="effectiveDownstream(key).profileInherited"
                                    class="text-[10px] text-muted-foreground/70"
                                >
                                    继承全局
                                </span>
                            </div>
                            <UiSelect
                                :model-value="store.status?.sessionChoices[key]?.profileId ?? ''"
                                :options="profileOptions(effectiveDownstream(key).backendId)"
                                class="mt-1"
                                @update:model-value="(v: string) => setProfile(key, v)"
                            />
                            <p class="mt-1 text-[11px] text-muted-foreground/70">
                                <template v-if="profilesOf(effectiveDownstream(key).backendId).length === 0">
                                    该下游还没有配置。先到「下游」页新建一个，
                                    然后回到这里选它，就能设置提示词 / 历史引用 / 进度转发
                                </template>
                                <template v-else>
                                    配置决定这个会话用哪套提示词 / 对话约束 / 角色卡；
                                    选中配置后可展开编辑它的行为设置
                                </template>
                            </p>

                            <!-- 编辑该配置的行为设置（提示词 / 历史引用 / 进度转发） -->
                            <div
                                v-if="effectiveDownstream(key).profileId"
                                class="mt-1.5"
                            >
                                <UiButton
                                    variant="ghost"
                                    size="sm"
                                    @click="openBehavior(
                                        effectiveDownstream(key).backendId,
                                        effectiveDownstream(key).profileId,
                                    )"
                                >
                                    <Settings2 class="size-3.5" />
                                    {{
                                        editingBehaviorOf === `${effectiveDownstream(key).backendId}:${effectiveDownstream(key).profileId}`
                                            ? '收起设置'
                                            : '编辑该配置的提示词与行为'
                                    }}
                                </UiButton>
                            </div>

                            <!-- 行为设置：属于配置，不属于连接 -->
                            <div
                                v-if="editingBehaviorOf === `${effectiveDownstream(key).backendId}:${effectiveDownstream(key).profileId}`"
                                class="mt-2 rounded-md border border-primary/30 bg-primary/5 p-2.5"
                            >
                                <DownstreamBehaviorEditor
                                    v-if="behaviorDrafts[editingBehaviorOf]"
                                    :model-value="behaviorDrafts[editingBehaviorOf]!"
                                    :kind="kindOf(effectiveDownstream(key).backendId)"
                                    :disabled="savingBehavior === editingBehaviorOf"
                                    @update:model-value="(v) => { behaviorDrafts[editingBehaviorOf] = v; }"
                                />
                                <div class="mt-2 flex flex-wrap items-center gap-1.5">
                                    <UiButton
                                        size="sm"
                                        :disabled="savingBehavior === editingBehaviorOf"
                                        @click="saveBehavior(
                                            effectiveDownstream(key).backendId,
                                            effectiveDownstream(key).profileId,
                                        )"
                                    >
                                        <Save class="size-3.5" />
                                        保存设置
                                    </UiButton>
                                    <UiButton
                                        variant="ghost"
                                        size="sm"
                                        @click="editingBehaviorOf = ''"
                                    >
                                        取消
                                    </UiButton>
                                    <div class="flex-1" />
                                    <span class="text-[10px] text-muted-foreground/70">
                                        影响所有使用该配置的会话
                                    </span>
                                </div>
                            </div>
                        </div>

                    <div
                        class="grid gap-3 sm:grid-cols-2"
                        :class="isDsh(effectiveDownstream(key).backendId) ? 'opacity-60' : ''"
                    >
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
                        <template v-if="isDsh(effectiveDownstream(key).backendId)">
                            dsh 会以所选角色作为人设提示，但不加载酒馆世界书全文
                        </template>
                        <template v-else>
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
                        </template>
                    </p>
                    </div>
                </template>
            </div>
        </UiCard>
    </div>
</template>
