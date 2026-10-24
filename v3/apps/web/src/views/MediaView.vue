<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { Image as ImageIcon, Save } from 'lucide-vue-next';
import { useStatusStore } from '@/stores/status';
import UiCard from '@/components/ui/UiCard.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiInput from '@/components/ui/UiInput.vue';
import UiSwitch from '@/components/ui/UiSwitch.vue';
import { api } from '@/api/client';
import { useToastStore } from '@/stores/toast';

const store = useStatusStore();
const toast = useToastStore();

const enabled = ref(true);
const baseUrl = ref('');

onMounted(async () => {
    await store.refresh();
    const cfg = (store.status?.config['imageReplies'] ?? {}) as { enabled?: boolean; baseUrl?: string };
    enabled.value = cfg.enabled !== false;
    baseUrl.value = cfg.baseUrl ?? '';
});

async function save() {
    try {
        await api.updateConfig({
            imageReplies: { enabled: enabled.value, instruction: true, baseUrl: baseUrl.value.trim() },
        });
        await store.refresh();
        toast.success('图片设置已保存');
    } catch (e) {
        toast.error('保存失败', e instanceof Error ? e.message : String(e));
    }
}

const examples = [
    { label: '图片标记', code: '[图片:https://example.com/cat.png]' },
    { label: '表情别名', code: '[表情:https://example.com/hi.gif]' },
    { label: 'HTML 图片', code: '<img src="https://example.com/x.png">' },
];
</script>

<template>
    <div class="flex flex-col gap-5">
        <UiCard>
            <div class="flex items-center justify-between border-b border-border/60 px-5 py-4">
                <div class="flex items-center gap-3">
                    <div class="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                        <ImageIcon class="size-5" />
                    </div>
                    <div>
                        <h2 class="text-sm font-semibold tracking-tight">图片与表情包</h2>
                        <p class="text-xs text-muted-foreground">AI 可在回复中插入图片消息</p>
                    </div>
                </div>
                <UiSwitch v-model="enabled" />
            </div>

            <div class="px-5 py-4">
                <label class="text-xs font-medium text-muted-foreground">图片库根地址（可选）</label>
                <UiInput
                    v-model="baseUrl"
                    class="mt-1"
                    mono
                    placeholder="https://example.com/emojis/"
                />
                <p class="mt-1.5 text-xs text-muted-foreground">
                    填写后会作为提示告知 AI，便于它引用该地址下的图片
                </p>
            </div>

            <div class="border-t border-border/40 px-5 py-4">
                <p class="mb-2 text-xs font-medium text-muted-foreground">支持的标记格式</p>
                <div class="flex flex-col gap-1.5">
                    <div
                        v-for="ex in examples"
                        :key="ex.label"
                        class="flex items-center gap-3 rounded-md bg-accent/20 px-3 py-2"
                    >
                        <span class="w-24 shrink-0 text-xs text-muted-foreground">{{ ex.label }}</span>
                        <code class="min-w-0 flex-1 truncate font-mono text-xs text-primary">{{ ex.code }}</code>
                    </div>
                </div>
            </div>

            <div class="border-t border-border/60 px-5 py-3">
                <UiButton @click="save">
                    <Save class="size-4" />
                    保存设置
                </UiButton>
            </div>
        </UiCard>

        <UiCard class="border-info/30 bg-info/5">
            <div class="px-5 py-4">
                <p class="text-sm font-medium">工作方式</p>
                <ul class="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
                    <li>• 连接器解析 AI 回复中的图片标记，转为 OneBot 图片消息段</li>
                    <li>• 图片与文字会分开发送，更接近真实聊天</li>
                    <li>• 酒馆扩展会向提示词注入使用说明，让 AI 知道可以发图</li>
                </ul>
            </div>
        </UiCard>
    </div>
</template>
