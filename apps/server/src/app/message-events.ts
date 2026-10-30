import type { UpstreamManager, AccountEvent } from '../upstream/manager.ts';
import { dispatchEvent, type DispatchDeps } from '../core/dispatch.ts';
import { publishStatus } from '../api/events.ts';
import { log } from '../core/logger.ts';

export function bindMessageEvents(upstreams: UpstreamManager, dispatchDeps: DispatchDeps): void {
    // 上游状态变化：连上/断开/重连/报错都立即推给前端，不等下一次轮询
    upstreams.on('account-connected', (accountId: string) => {
        publishStatus('upstream', { connected: true, accountId });
    });
    upstreams.on('account-disconnected', (accountId: string) => {
        publishStatus('upstream', { connected: false, accountId });
    });
    upstreams.on('account-error', (accountId: string, error: string) => {
        publishStatus('upstream', { connected: false, accountId, error });
    });

    upstreams.on('event', (event: AccountEvent) => {
        void dispatchEvent(dispatchDeps, event).catch((e) => {
            log(`✗ 派发异常 [${event.accountId}]：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
        });
    });

}
