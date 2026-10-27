/**
 * 迁移期类型声明。
 *
 * 这几个模块仍是 .mjs（表情库 / Ollama / dsh 服务管理），
 * 它们已被独立验证、逻辑稳定，本轮重构不动其实现。
 * 这里只声明 TS 侧用到的形状，等后续迁移到 TS 时删除本文件。
 *
 * 用通配符形式（`*dsh-service.mjs`）而不是逐个相对路径：
 * `declare module` 的相对写法按字面量匹配 import 原文，
 * 同一文件在不同深度引用时要写多份，容易漏。
 */

declare module '*dsh-service.mjs' {
    export interface DshProbe {
        path: string;
        source: string;
        version: string;
        binJs?: string;
        /** 本机所有可用安装，按优先级排序 */
        all?: Array<{ path: string; source: string; version: string; binJs?: string }>;
    }
    export interface DshStatusInfo {
        installed: boolean;
        exePath: string;
        configuredMissing: boolean;
        profile: string;
        workRoot: string;
        home: string;
        profiles: string[];
        version: string;
        historyFile: string;
        sessionCount: number;
    }
    export interface DshAskResult {
        ok: boolean;
        text: string;
        elapsedMs: number;
        error?: string;
        sessionKey?: string;
        via?: string;
    }
    export class DshClient {
        constructor(opts?: {
            exePath?: string;
            profile?: string;
            workRoot?: string;
            timeoutMs?: number;
            log?: (...args: unknown[]) => void;
            historyTurns?: number;
            historyFile?: string;
            systemPrompt?: string;
            concurrency?: number;
        });
        readonly concurrency: number;
        status(): DshStatusInfo;
        ask(opts: {
            sessionKey: string;
            text: string;
            useHistory?: boolean;
            system?: string;
        }): Promise<DshAskResult>;
        clearHistory(sessionKey: string, opts?: { removeWorkDir?: boolean }): boolean;
        clearAllHistory(): number;
        listSessions(): Array<{
            sessionKey: string;
            messages: number;
            turns: number;
            updatedAt: string | null;
        }>;
        load(): { running: number; waiting: number; concurrency: number; maxQueue: number };
    }
    export function findDsh(configured?: string, opts?: { fresh?: boolean }): DshProbe;
    export function listProfiles(): string[];
    export function dshHome(): string;
    export function invalidateDshProbe(): void;
    export function cleanOutput(raw: string): string;
}

declare module '*dsh-profile-service.mjs' {
    export const PLUGIN_NAME: string;
    export const PLUGIN_ROW_ID: string;
    export function dshHome(): string;
    export function profilesRoot(home?: string): string;
    export function resolveProfileDir(profile: string, home?: string): string;
    export function pluginTargetDir(home?: string): string;
    export function detectRealUserDshHome(): string;
    export function looksLikeDshHome(home: string): boolean;
    export function detectHomeMismatch(home?: string): {
        home: string;
        reason: string;
        hint: string;
        actualDshDirs: string[];
    } | null;

    export interface ProfileInfo {
        profile: string;
        dir: string;
        bundles: string[];
        patchReload: string;
        invalid?: boolean;
    }
    export function listProfileBundles(home?: string): ProfileInfo[];

    export interface InjectionState {
        profile: string;
        profileDir: string;
        profileExists: boolean;
        installed: boolean;
        inBundles: boolean;
        hasPatchRow: boolean;
        pluginDir: string;
        version: string;
        config: { url: string; token: string; cwdRoot: string } | null;
        error: string;
    }
    export function probeInjection(opts: { profile: string; home?: string }): InjectionState;

    export interface InjectResult {
        ok: boolean;
        action: string;
        target: string;
        profileDir: string;
        files: number;
        error: string;
        injection: InjectionState | null;
    }
    export function injectPlugin(opts: {
        profile: string;
        sourceDir: string;
        url: string;
        token?: string;
        cwdRoot?: string;
        /** 插件注册到哪个下游实例 */
        downstreamId?: string;
        /** 控制台端口，插件据此自注册 */
        consolePort?: number;
        home?: string;
    }): InjectResult;

    export function removePlugin(opts: {
        profile: string;
        home?: string;
    }): { ok: boolean; action: string; error: string };

    export function verifyInjection(opts: {
        exePath?: string;
        profile: string;
        home?: string;
    }): {
        ok: boolean;
        present?: boolean;
        error: string;
        configDumpLength?: number;
        exe?: string;
        raw?: string;
        /** true = 失败原因与本次注入无关（profile 里别的插件缺依赖） */
        unrelated?: boolean;
        unrelatedReason?: string;
    };

    export interface ServiceStatusInfo {
        profile: string;
        host: string;
        port: number;
        url: string;
        running: boolean;
        pid: number;
        lastPid: number;
        logFile: string;
        lastError: string;
    }
    export interface ServiceInspect extends ServiceStatusInfo {
        logTail: string[];
    }
    export class DshService {
        constructor(opts?: {
            exePath?: string;
            profile?: string;
            host?: string;
            port?: number;
            logFile?: string;
            log?: (...args: unknown[]) => void;
        });
        readonly profile: string;
        readonly host: string;
        readonly port: number;
        readonly logFile: string;
        status(): ServiceStatusInfo;
        inspect(opts?: { logTail?: number }): Promise<ServiceInspect>;
        start(opts?: { extraArgs?: string[] }): Promise<{
            ok: boolean;
            alreadyRunning?: boolean;
            pid?: number;
            url?: string;
            error?: string;
            logTail?: string[];
        }>;
        stop(): Promise<{ ok: boolean; action?: string; pid?: number; error?: string }>;
        restart(): Promise<{ ok: boolean; stage?: string; error?: string }>;
    }
    export function pidOnPort(port: number): number;
    export function isPortOpen(port: number, host?: string, timeout?: number): Promise<boolean>;
}

declare module '*faces-service.mjs' {
    export interface FaceStats {
        total: number;
        labeled: number;
        [key: string]: unknown;
    }
    export interface FacePick {
        md5: string;
        url?: string;
        imageUrl?: string;
    }
    export interface FacePickResult {
        face: FacePick | null;
        score: number;
        hitTags?: string[];
        totalScored?: number;
        excluded?: number;
        candidates: Array<{ md5: string; score: number; hitTags: string[] }>;
        reason?: string;
    }
    export class FaceService {
        constructor(opts: {
            dataDir: string;
            callOnebot: (action: string, params: Record<string, unknown>) => Promise<unknown>;
            log: (...args: unknown[]) => void;
            onChanged?: (reason: string) => void;
            ollama?: {
                baseUrl?: string;
                visionModel?: string;
                textModel?: string;
                timeoutMs?: number;
            };
        });
        readonly store: {
            manifest(): {
                vocab: Record<string, string[]>;
                totalWords: number;
                total: number;
                labeled: number;
            };
            pickById(id: string, keyword?: string): FacePick | null;
            pickByTagsDetailed(
                tags: string[],
                opts?: { exclude?: string[]; topN?: number },
            ): FacePickResult;
        };
        stats(): FaceStats;
    }
}

declare module '*ollama-service.mjs' {
    export class OllamaClient {
        constructor(opts?: { baseUrl?: string; timeoutMs?: number });
        baseUrl: string;
        list(): Promise<Array<{ name: string; size?: number; modified_at?: string }>>;
    }
    export class OllamaDaemon {
        constructor(opts?: {
            exePath?: string;
            baseUrl?: string;
            modelsDir?: string;
            log?: (...args: unknown[]) => void;
        });
        baseUrl: string;
        exePath: string;
        modelsDir: string;
        status(): Record<string, unknown>;
        start(client: OllamaClient): Promise<{
            ok: boolean;
            alreadyRunning?: boolean;
            version?: string;
        }>;
        stop(client: OllamaClient): Promise<{ ok: boolean; action?: string; error?: string }>;
    }
    export function countModelsIn(dir: string): number;
}

/** snowluma-service：SnowLuma 本体的探测与 OneBot 配置写入 */
declare module '*snowluma-service.mjs' {
    export interface SnowLumaProbe {
        ok: boolean;
        dir: string;
        configDir: string;
        dataDir: string;
        mode: 'release' | 'source' | 'flat' | '';
        reason: string;
        version: string;
        hasConfig: boolean;
        error: string;
    }
    export interface SnowLumaAccount {
        uin: string;
        hasIdentityDb: boolean;
        updatedAt: string | null;
    }
    export interface DiscoverResult {
        found: boolean;
        dir: string;
        source: string;
        candidates: Array<{ dir: string; source: string; ok?: boolean; version?: string; mode?: string; accounts?: string[] }>;
        tried: string[];
    }
    export interface ApplyResult {
        ok: boolean;
        changed: boolean;
        created: boolean;
        path: string;
        token: string;
        endpoint: string;
        configDir: string;
        dataDir: string;
        mode: string;
        version: string;
        needRestart: boolean;
    }
    export const UIN_REGEX: RegExp;
    export function probeSnowLuma(rootDir: string, activePort?: number | null): SnowLumaProbe;
    export function listAccounts(dataDir: string): SnowLumaAccount[];
    export function makeDefaultOneBotConfig(opts?: {
        port?: number;
        host?: string;
        token?: string;
    }): Record<string, unknown>;
    export function readOneBotConfig(
        configDir: string,
        uin: string,
    ): { exists: boolean; path: string; config: Record<string, unknown> | null };
    export function writeOneBotConfig(
        configDir: string,
        uin: string,
        next: Record<string, unknown>,
        mode?: 'merge' | 'replace',
    ): unknown;
    export function ensureOneBotEndpoint(opts: {
        configDir: string;
        uin: string;
        port?: number;
        host?: string;
        forceToken?: boolean;
    }): ApplyResult;
    export function isPortOpen(port: number, host?: string, timeout?: number): Promise<boolean>;
    export function discoverSnowLumaDir(opts?: {
        knownDir?: string;
        hintDirs?: string[];
    }): Promise<DiscoverResult>;
}

/** sillytavern-service：酒馆本体的探测与扩展安装 */
declare module '*sillytavern-service.mjs' {
    export interface StProbe {
        ok: boolean;
        dir: string;
        extDir: string;
        installed: boolean;
        installedVersion: string;
        version: string;
        files: string[];
        error: string;
    }
    export interface StDiscoverResult {
        found: boolean;
        dir: string;
        source: string;
        candidates: Array<{ dir: string; source: string }>;
        tried: string[];
        error?: string;
    }
    export interface ExtensionInstallResult {
        ok: boolean;
        action: string;
        target: string;
        version: string;
        files: string[];
        needRefresh: boolean;
        error: string;
    }
    export function looksLikeSillyTavern(dir: string): boolean;
    export function probeSillyTavern(rootDir: string): StProbe;
    export function readSourceExtension(sourceDir: string): {
        ok: boolean;
        version: string;
        files: string[];
        error: string;
    };
    export function installExtension(opts: {
        stDir: string;
        sourceDir: string;
        force?: boolean;
    }): ExtensionInstallResult;
    export function uninstallExtension(stDir: string): {
        ok: boolean;
        action: string;
        needRefresh: boolean;
        error?: string;
    };
    export function isPortOpen(port: number, host?: string, timeout?: number): Promise<boolean>;
    export function discoverSillyTavernDir(opts?: {
        knownDir?: string;
        hintDirs?: string[];
    }): Promise<StDiscoverResult>;
}
