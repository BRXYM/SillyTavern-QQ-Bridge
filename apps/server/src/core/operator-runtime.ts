import { applyReplyProcessors } from '@bridge/core';
import { operatorSessionKey } from './operator-sessions.ts';
import { validateFlow } from '../config/flows.ts';
import { record } from '../config/conversation-flow.ts';
import { emptyState, parseState, parseValues, type OperatorRecord, type ConversationState } from './conversation-engine.ts';
import type { FlowExecution, FlowActionRun, FlowStep } from './flow-runtime.ts';

const clip = (text: string, max = 4096) => text.length > max ? text.slice(0, max) + '…（截断）' : text;
/** 算子有序执行；操作在任意算子内组合，没有预设的输入/调用/输出位置。 */
export async function executeOperatorFlow(options: FlowExecution) {
    const { flow } = options;
    const run = options.store.begin(flow, options.sessionKey, options.mode);
    const started = Date.now(); const before = parseState(options.state ?? emptyState());
    const work = parseState(before);
    const history = structuredClone(before.operators ?? {});
    const operators: Record<string, OperatorRecord> = {};
    const current = { upstream: {} as Record<string, string>, downstream: {} as Record<string, string> };
    const message = { upstream: options.text, downstream: '' };
    let text = options.text; let system = ''; let stopped = false; let calls = 0;
    let node: FlowStep | undefined; let actionLog: FlowActionRun | undefined;
    let nodeStart = started; let actionStart = started;
    let checkpoint: ConversationState | undefined; let lastSignature = JSON.stringify(before);
    const warn = (value: string) => { if (run.warnings.length < 32 && !run.warnings.includes(value)) run.warnings.push(value); };
    let extracted: Record<string, string> = {};
    function render(template: string, replacement = false) {
        const output = template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (literal, token: string) => {
            const parts = token.trim().split('.');
            if (!['text', 'system', 'message', 'vars', 'extracted', 'operators', 'history', 'current', 'previous'].includes(parts[0]!)) return literal;
            let value: unknown = { text, system, message, vars: work.vars, extracted, operators, history, current, previous: before.previous };
            for (const key of parts) {
                if (!record(value) || !Object.hasOwn(value, key)) { warn(`引用 ${token.trim()} 尚无数据，按空文本处理；后续算子数据请改用 history 或变量`); return ''; }
                value = value[key];
            }
            return typeof value === 'string' ? replacement ? value.replace(/\$/g, '$$$$') : value : '';
        });
        if (output.length > 128000) throw new Error('操作模板展开超过 128000 字');
        return output;
    }
    function snapshot() {
        const records: Record<string, OperatorRecord> = {};
        for (const [id, value] of Object.entries(operators)) records[id] = { input: value.input.slice(0, 4000), output: value.output.slice(0, 4000), extracted: value.extracted };
        return parseState({ ...work, operators: records });
    }
    function save() {
        const state = snapshot(); const signature = JSON.stringify(state);
        if (options.commit && signature !== lastSignature) { options.commit(state); run.variablesSaved = true; lastSignature = signature; }
        checkpoint = state;
    }
    function diff() {
        const saved = options.commit ? checkpoint?.vars ?? before.vars : before.vars;
        run.variables = [...new Set([...Object.keys(before.vars), ...Object.keys(work.vars)])].filter(name => before.vars[name] !== work.vars[name]).map(name => ({ name, before: clip(before.vars[name] ?? ''), after: clip(work.vars[name] ?? ''), saved: !!options.commit && saved[name] === work.vars[name] }));
    }
    try {
        if (!flow.enabled) throw new Error('流程配置已停用');
        validateFlow(flow, options.config);
        if (text.length > 64000) throw new Error('上游消息超过 64000 字');
        for (let ni = 0; ni < flow.operators!.length; ni++) {
            const operator = flow.operators![ni]!; node = run.steps[ni]!; nodeStart = Date.now();
            if (!operator.enabled || stopped) { node.status = 'skipped'; node.output = stopped ? '流程已结束' : '算子已停用'; continue; }
            node.status = 'running'; node.input = clip(text);
            const op: OperatorRecord = { input: text, output: text, extracted: {} }; operators[operator.id] = op;
            extracted = op.extracted;
            for (let ai = 0; ai < operator.actions.length; ai++) {
                const action = operator.actions[ai]!; actionLog = node.actions![ai]!; actionStart = Date.now();
                if (stopped) { actionLog.status = 'skipped'; continue; }
                actionLog.status = 'running'; actionLog.input = clip(text);
                switch (action.type) {
                    case 'input': text = render(action.source); break;
                    case 'process': {
                        for (const variable of action.variables) if (!Object.hasOwn(work.vars, variable.name)) work.vars[variable.name] = variable.initialValue;
                        work.vars = parseValues(work.vars);
                        if (action.source !== undefined) text = render(action.source);
                        for (const rule of action.extracts) {
                            const source = render(rule.source); let value: unknown;
                            try {
                                if (rule.mode === 'regex') value = new RegExp(rule.expression, rule.flags).exec(source)?.[rule.group];
                                else {
                                    value = JSON.parse(source);
                                    for (const key of rule.expression ? rule.expression.split('.') : []) {
                                        if ((!record(value) && !Array.isArray(value)) || !Object.hasOwn(value, key)) { value = undefined; break; }
                                        value = (value as Record<string, unknown>)[key];
                                    }
                                }
                            } catch { warn(`算子 ${operator.name} 的提取 ${rule.name} 未获得有效数据`); }
                            const result = value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
                            if (result.length > 4000) throw new Error(`提取 ${rule.name} 超过 4000 字`);
                            if (value === undefined || value === null) warn(`提取 ${rule.name} 未匹配`);
                            extracted[rule.name] = result;
                        }
                        parseValues(extracted);
                        if (action.legacyStage) current[action.legacyStage] = extracted;
                        const assignments = Object.fromEntries(action.assignments.flatMap(a => { const value = render(a.value); return a.skipEmpty !== false && !value ? [] : [[a.name, value]]; }));
                        work.vars = parseValues({ ...work.vars, ...assignments });
                        text = render(action.prefix) + applyReplyProcessors(text, action.rules.map(rule => rule.type === 'replace' ? { ...rule, replacement: render(rule.replacement ?? '', true) } : rule)) + render(action.suffix);
                        if (action.system !== undefined) system = render(action.system);
                        if (action.legacySystem) system = options.legacySystem ?? '';
                        if (action.legacyRules) text = applyReplyProcessors(text, options.legacyRules ?? []);
                        if (action.legacyStage) work.previous[action.legacyStage] = structuredClone(extracted);
                        if (action.stopIfEmpty && !text.trim()) stopped = true;
                        actionLog.system = clip(system); break;
                    }
                    case 'call': {
                        const target = action.downstreamId || flow.downstreamId;
                        const input = render(action.input); const prompt = render(action.system);
                        actionLog.input = clip(input); actionLog.system = clip(prompt); actionLog.downstreamId = target;
                        if (!input.trim()) throw new Error('调用消息为空，请先处理消息或结束流程');
                        const scoped = action.legacySession ? options.sessionKey : operatorSessionKey(options.sessionKey, flow.id, operator.id, action.id);
                        calls++;
                        const result = await options.ask(options.decorateInput?.(input) ?? input, prompt, { downstreamId: target, operatorId: operator.id, actionId: action.id, sessionKey: scoped });
                        if (!result.ok) throw new Error(result.error || '服务调用失败');
                        text = result.text; message.downstream = result.text; system = prompt; break;
                    }
                    case 'reply': {
                        const reply = render(action.text);
                        if (!reply.trim()) { actionLog.status = 'skipped'; actionLog.output = '回复为空，未发送'; break; }
                        op.output = text;
                        // 中途回复是不可撤销的外部效果，先保存此前状态；后续失败只停止后续操作。
                        save();
                        let sent = { sent: 0, failed: 0 };
                        if (options.deliver) sent = await options.deliver(reply);
                        run.deliveries!.push({ operatorId: operator.id, actionId: action.id, text: clip(reply), simulated: !options.deliver, ...sent });
                        if (sent.failed) throw new Error(`QQ 投递失败：成功 ${sent.sent} 段，失败 ${sent.failed} 段`);
                        actionLog.output = options.deliver ? `已发 ${sent.sent} 段` : `模拟返回：${clip(reply)}`;
                        if (!options.deliver || !sent.sent) actionLog.status = 'skipped';
                        if (action.stopAfter) stopped = true;
                        break;
                    }
                    case 'stop': stopped = true; break;
                }
                if (text.length > 128000) throw new Error('操作输出超过 128000 字');
                op.output = text;
                if (actionLog.status === 'running') actionLog.status = 'success';
                actionLog.output ??= clip(text); actionLog.elapsedMs = Date.now() - actionStart;
            }
            node.output = clip(text); node.system = clip(system); node.status = 'success'; node.elapsedMs = Date.now() - nodeStart;
        }
        save(); diff(); run.status = 'success';
        return { ok: true, output: text, state: checkpoint, run };
    } catch (e) {
        const error = clip(e instanceof Error ? e.message : String(e));
        if (actionLog?.status === 'running') { actionLog.status = 'failed'; actionLog.error = error; actionLog.elapsedMs = Date.now() - actionStart; }
        const failed = node ?? run.steps[0];
        if (failed) { failed.status = 'failed'; failed.error = error; failed.elapsedMs = Date.now() - nodeStart; }
        run.status = 'failed'; run.error = error;
        run.partialEffects = calls > 0 || !!run.deliveries?.some(r => r.sent);
        if (run.partialEffects) warn('流程已停止；此前的服务调用、已发送回复及已保存状态不会撤销，不会自动重试。');
        diff(); return { ok: false, error, output: text, state: checkpoint, run };
    } finally {
        for (const step of run.steps) {
            if (step.status === 'pending') { step.status = 'skipped'; step.output = '流程已结束或前序失败'; }
            for (const action of step.actions ?? []) if (action.status === 'pending') action.status = 'skipped';
        }
        run.elapsedMs = Date.now() - started;
    }
}
