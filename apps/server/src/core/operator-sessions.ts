import { createHash } from 'node:crypto';
import type { MessageFlow } from '../config/flows.ts';
/** 保持 60 字以内，避免 dsh 工作目录名截断后把不同操作合并到同一上下文。 */
export function operatorSessionKey(sessionKey: string, flowId: string, operatorId: string, actionId: string) {
    return 'flow_' + createHash('sha256').update(JSON.stringify([sessionKey, flowId, operatorId, actionId])).digest('hex').slice(0, 40);
}
export function operatorSessionKeys(flows: MessageFlow[], sessionKey: string, downstreamId: string) {
    const keys = new Set([sessionKey]);
    for (const flow of flows) for (const op of flow.operators ?? []) for (const action of op.actions) {
        if (action.type === 'call' && (action.downstreamId || flow.downstreamId) === downstreamId) keys.add(action.legacySession ? sessionKey : operatorSessionKey(sessionKey, flow.id, op.id, action.id));
    }
    return [...keys];
}
