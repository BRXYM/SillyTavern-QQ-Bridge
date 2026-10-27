/**
 * 全局运行状态。
 *
 * 数据获取分三层，按「快 → 省 → 稳」排序：
 *
 *   1. **SSE 事件（主）**     服务一变化就被推送，异常感知即时
 *   2. **HTTP 快照（兜底）**  低频全量对齐（默认 15s），SSE 断了也能恢复
 *   3. **localStorage 缓存**  首屏秒开，避免每次刷新闪空白
 *
 * 关键设计：
 *   - 上游/下游/会话的变化分别走轻量接口，不再为一次变化拉整份 status
 *   - 请求失败**不清空**已有状态，只标记 reachable=false 并记录错误
 *   - 页面不可见时暂停轮询，切回来立即补一次
 */
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { api, type StatusDto, type DownstreamStatusDto } from '@/api/client';
import { statusStream, type StatusEvent } from '@/lib/status-stream';

/** 全量对齐间隔：SSE 正常时可以拉得比较慢 */
const FULL_INTERVAL = 15000;
/** SSE 断开时的兜底间隔 */
const FALLBACK_INTERVAL = 3000;
/** 后端不可达时的最大退避 */
const MAX_INTERVAL = 30000;
const CACHE_KEY = 'snowluma-bridge:last-status';

interface CachedSnapshot {
    at: number;
    status: StatusDto;
}

function readCache(): CachedSnapshot | null {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as CachedSnapshot;
        if (!parsed?.status) return null;
        // 超过 10 分钟的旧快照参考价值不大
        if (Date.now() - (parsed.at ?? 0) > 10 * 60 * 1000) return null;
        return parsed;
    } catch {
        return null;
    }
}

function writeCache(status: StatusDto): void {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), status }));
    } catch {
        /* 配额满或隐私模式：忽略 */
    }
}

export const useStatusStore = defineStore('status', () => {
    const cached = readCache();

    /** 最近一次成功拉到的状态；失败时保留旧值 */
    const status = ref<StatusDto | null>(cached?.status ?? null);
    const error = ref<string | null>(null);
    const loading = ref(false);
    const reachable = ref(false);
    const lastSuccessAt = ref<number | null>(cached?.at ?? null);
    const fromCache = ref(Boolean(cached));
    /** SSE 是否在线（界面可据此显示"实时"标识） */
    const live = ref(false);

    const onebotConnected = computed(() => status.value?.onebotConnected ?? false);
    const extClients = computed(() => status.value?.stClients ?? 0);
    const upstream = computed(() => status.value?.upstream ?? null);
    const downstreams = computed(() => status.value?.downstreams ?? []);
    const defaultDownstreamId = computed(() => status.value?.defaultDownstreamId ?? '');

    // ---------------------------------------------------------------
    // 局部更新：只改受影响的字段，避免整表替换导致界面闪动
    // ---------------------------------------------------------------

    /** 上游连接状态变化 → 只更新 upstream */
    function applyUpstreamEvent(payload?: Record<string, unknown>): void {
        if (!status.value) return;
        const connected = payload?.connected === true;
        const prev = status.value.upstream;
        status.value = {
            ...status.value,
            onebotConnected: connected,
            upstream: {
                ...(prev ?? {
                    endpoint: '',
                    selfId: '',
                    nickname: '',
                    connectedForSec: 0,
                    connectedAt: null,
                    disconnectedAt: null,
                    reconnectCount: 0,
                    eventsIn: 0,
                    actionsOut: 0,
                    actionErrors: 0,
                    lastEventAt: null,
                    lastError: '',
                    lastErrorAt: null,
                }),
                connected,
                lastError: typeof payload?.error === 'string' ? payload.error : (prev?.lastError ?? ''),
            },
        };
    }

    /** 下游可用性变化 → 只更新对应实例 */
    function applyDownstreamEvent(payload?: Record<string, unknown>): void {
        if (!status.value) return;
        const id = typeof payload?.id === 'string' ? payload.id : '';
        const list = status.value.downstreams ?? [];

        if (!id) {
            // 没有具体 id（例如整体重建）：标记为需要对齐，由下一轮全量拉取处理
            void refresh();
            return;
        }

        const available = payload?.available === true;
        const exists = list.some((d) => d.id === id);
        if (!exists) {
            // 新注册的下游：本地没有，拉一次全量
            void refresh();
            return;
        }

        status.value = {
            ...status.value,
            downstreams: list.map((d): DownstreamStatusDto =>
                d.id === id ? { ...d, available } : d,
            ),
        };
    }

    /**
     * 处理一批事件。
     * 会话 / 配置这类变化对界面影响面较大，直接触发一次轻量刷新；
     * 上游 / 下游变化则精确命中字段，避免多余请求。
     */
    async function handleEvents(events: StatusEvent[]): Promise<void> {
        let needRefresh = false;
        for (const event of events) {
            switch (event.kind) {
                case 'upstream':
                    applyUpstreamEvent(event.payload);
                    break;
                case 'downstream':
                    applyDownstreamEvent(event.payload);
                    break;
                case 'session':
                case 'config':
                case 'metrics':
                    needRefresh = true;
                    break;
                default:
                    break;
            }
        }
        if (needRefresh) await refresh();
    }

    // ---------------------------------------------------------------
    // 全量对齐
    // ---------------------------------------------------------------
    let inFlight: Promise<void> | null = null;

    async function refresh(): Promise<void> {
        if (inFlight) return inFlight;

        inFlight = (async () => {
            try {
                loading.value = true;
                const next = await api.status();
                status.value = next;
                error.value = null;
                reachable.value = true;
                fromCache.value = false;
                lastSuccessAt.value = Date.now();
                writeCache(next);
            } catch (e) {
                // 保留最后一次成功状态，仅标记不可达
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
    // 轮询与事件订阅
    // ---------------------------------------------------------------
    let timer: number | null = null;
    let refCount = 0;
    let interval = FULL_INTERVAL;
    let unsubscribeEvents: (() => void) | null = null;
    let unbindVisibility: (() => void) | null = null;

    function nextDelay(): number {
        if (!reachable.value) return Math.min(interval * 2, MAX_INTERVAL);
        // SSE 在线时慢速对齐即可；断开时退回快速轮询
        return live.value ? FULL_INTERVAL : FALLBACK_INTERVAL;
    }

    function tick(): void {
        timer = window.setTimeout(async () => {
            await refresh();
            interval = nextDelay();
            if (refCount > 0) tick();
        }, interval);
    }

    /**
     * 启动全局状态同步。
     * 由 App 根部调用一次，所有页面共享同一份状态。
     */
    function startPolling(): void {
        refCount += 1;
        if (timer !== null) return;

        interval = FULL_INTERVAL;
        void refresh();

        // 订阅 SSE：事件到达即更新
        if (!unsubscribeEvents) {
            unsubscribeEvents = statusStream.subscribe((events) => {
                live.value = statusStream.isConnected;
                void handleEvents(events);
            });
            statusStream.connect();
        }

        // 切回前台时立即对齐一次
        if (!unbindVisibility) {
            const onVisible = () => {
                if (document.visibilityState === 'visible' && refCount > 0) void refresh();
            };
            document.addEventListener('visibilitychange', onVisible);
            unbindVisibility = () => document.removeEventListener('visibilitychange', onVisible);
        }

        tick();
    }

    function stopPolling(): void {
        refCount = Math.max(0, refCount - 1);
        if (refCount > 0) return;

        if (timer !== null) {
            window.clearTimeout(timer);
            timer = null;
        }
        unsubscribeEvents?.();
        unsubscribeEvents = null;
        unbindVisibility?.();
        unbindVisibility = null;
        live.value = false;
        interval = FULL_INTERVAL;
    }

    return {
        status,
        error,
        loading,
        reachable,
        lastSuccessAt,
        fromCache,
        live,
        onebotConnected,
        extClients,
        upstream,
        downstreams,
        defaultDownstreamId,
        refresh,
        startPolling,
        stopPolling,
    };
});
