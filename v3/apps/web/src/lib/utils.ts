/** class 合并：冲突类名后者覆盖前者 */
export function cn(...classes: Array<string | false | null | undefined>): string {
    return classes.filter(Boolean).join(' ');
}

/** 字节数格式化 */
export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const v = bytes / Math.pow(1024, i);
    return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 运行时长 */
export function formatUptime(startedAt?: string): string {
    if (!startedAt) return '--';
    const ms = Date.now() - new Date(startedAt).getTime();
    if (ms < 0) return '--';
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (d > 0) return `${d}天 ${h}小时`;
    if (h > 0) return `${h}小时 ${m}分`;
    if (m > 0) return `${m}分 ${sec}秒`;
    return `${sec}秒`;
}

/** 时间格式化 */
export function formatTime(iso?: string): string {
    if (!iso) return '--';
    try {
        return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });
    } catch {
        return '--';
    }
}
