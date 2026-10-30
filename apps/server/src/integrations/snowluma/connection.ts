import { probeSnowLuma, listAccounts, readOneBotConfig } from './snowluma-service.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface HookProcess { pid: number; uin: string; injected: boolean; connected: boolean }
export function localHookProcesses(pids: number[], pipeNames: string[]): HookProcess[] {
    return pids.filter(pid => Number.isInteger(pid) && pid > 0).map(pid => ({ pid, uin: '', injected: pipeNames.some(name => name.toLowerCase() === `mojo.${pid}.control`), connected: false }));
}
async function inspectLocalProcesses(): Promise<HookProcess[]> {
    const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const { stdout } = await promisify(execFile)(shell, ['-NoProfile', '-NonInteractive', '-Command', "@(Get-CimInstance Win32_Process -Filter \"Name='QQ.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' } | ForEach-Object { [int]$_.ProcessId }) | ConvertTo-Json -Compress"], { windowsHide: true, timeout: 4000, maxBuffer: 65536 });
    const value: unknown = stdout.trim() ? JSON.parse(stdout) : [];
    const pipes = await fs.readdir('\\\\.\\pipe\\');
    return localHookProcesses((Array.isArray(value) ? value : [value]).map(Number), pipes);
}
export function parseHookProcesses(raw: unknown): HookProcess[] {
    const list = (raw as { list?: unknown })?.list;
    if (!Array.isArray(list)) throw new Error('SnowLuma 进程接口格式不兼容');
    return list.flatMap(p => p && Number.isInteger(p.pid) && typeof p.injected === 'boolean'
        ? [{ pid: p.pid, uin: String(p.uin ?? ''), injected: p.injected, connected: p.connected === true }] : []);
}
export async function readHookProcesses(port: number): Promise<{ known: boolean; processes: HookProcess[]; reason: string }> {
    try {
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WebUI 端口无效');
        const response = await fetch(`http://127.0.0.1:${port}/api/processes`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
        if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'SnowLuma WebUI 需要登录，请在其页面确认注入状态' : 'SnowLuma WebUI 暂时不可用');
        return { known: true, processes: parseHookProcesses(await response.json()), reason: '' };
    } catch (e) { return { known: false, processes: [], reason: e instanceof Error && e.message.includes('需要登录') ? e.message : 'SnowLuma WebUI 未运行、不可访问或接口不兼容，请在 SnowLuma 中确认注入状态' }; }
}
export function readEndpoint(configDir: string, uin: string) {
    const raw = readOneBotConfig(configDir, uin);
    const networks = raw.config?.networks as { wsServers?: Array<Record<string, unknown>> } | undefined;
    const ws = networks?.wsServers?.find(s => s.enabled !== false && Number(s.port) > 0);
    if (!ws) return null;
    const host = String(ws.host ?? '127.0.0.1');
    const localHost = ['0.0.0.0', '::', '[::]', ''].includes(host) ? '127.0.0.1' : host;
    const url = new URL(`ws://${localHost.includes(':') && !localHost.startsWith('[') ? `[${localHost}]` : localHost}:${Number(ws.port)}`);
    url.pathname = String(ws.path ?? '/');
    return { url: url.toString(), token: String(ws.accessToken ?? '') };
}
export async function inspectSnowLuma(dir: string, port: number) {
    const probe = probeSnowLuma(dir, port);
    if (!probe.ok) throw new Error(probe.error || 'SnowLuma 目录无效');
    const hook = await readHookProcesses(port);
    if (!hook.known && process.platform === 'win32') {
        try {
            const processes = await inspectLocalProcesses();
            if (processes.length) { hook.known = true; hook.processes = processes; hook.reason = '依据本机 QQ 主进程与 SnowLuma 注入管道检测，暂时无法对应账号'; }
        } catch { /* 无读取权限时保留未知，不能以失败推断未注入。 */ }
    }
    return { probe, hook, accounts: listAccounts(probe.dataDir).map(a => {
        const endpoint = readEndpoint(probe.configDir, a.uin);
        const processes = hook.processes.filter(p => p.uin === a.uin);
        return { uin: a.uin, endpoint: endpoint?.url ?? '', injection: processes.length ? processes.some(p => p.injected) ? 'injected' : 'not-injected' : 'unknown' };
    }) };
}
