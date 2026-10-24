import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { api, type StatusDto } from '@/api/client';

/** 正常轮询间隔 */
const BASE_INTERVAL = 3000;
/** 后端不可达时的最大退避间隔 */
const MAX_INTERVAL = 30000;

export const useStatusStore = defineStore('status', () => {
    const status = ref<StatusDto | null>(null);
    const error = ref<string | null>(null);
    const loading = ref(false);
    /** 后端是否可达（与 status 内容无关，仅表示 HTTP 是否连通） */
    const reachable = ref(false);

    const onebotConnected = computed(() => status.value?.onebotConnected ?? false);
    const extClients = computed(() => status.value?.stClients ?? 0);

    /** 正在进行的请求，避免并发重复打后端 */
    let inFlight: Promise<void> | null = null;

    async function refresh(): Promise<void> {
        if (inFlight) return inFlight;

        inFlight = (async () => {
            try {
                loading.value = true;
                status.value = await api.status();
                error.value = null;
                reachable.value = true;
            } catch (e) {
                error.value = e instanceof Error ? e.message : String(e);
                reachable.value = false;
            } finally {
                loading.value = false;
                inFlight = null;
            }
        })();

        return inFlight;
    }

    // ---------------------------------------------------------------
    // 轮询：带指数退避，后端掉线时不再每 3 秒刷屏
    // ---------------------------------------------------------------
    let timer: number | null = null;
    /** 引用计数：多个页面同时启用轮询时只跑一份 */
    let refCount = 0;
    let interval = BASE_INTERVAL;

    function tick() {
        timer = window.setTimeout(async () => {
            await refresh();
            // 失败则退避翻倍，成功则回到基准间隔
            interval = reachable.value
                ? BASE_INTERVAL
                : Math.min(interval * 2, MAX_INTERVAL);
            if (refCount > 0) tick();
        }, interval);
    }

    function startPolling() {
        refCount += 1;
        if (timer !== null) return;
        interval = BASE_INTERVAL;
        void refresh();
        tick();
    }

    function stopPolling() {
        refCount = Math.max(0, refCount - 1);
        if (refCount > 0) return;
        if (timer !== null) {
            window.clearTimeout(timer);
            timer = null;
        }
        interval = BASE_INTERVAL;
    }

    return {
        status,
        error,
        loading,
        reachable,
        onebotConnected,
        extClients,
        refresh,
        startPolling,
        stopPolling,
    };
});
