import os from 'node:os';
import { log } from '../core/logger.ts';
import { dshHome, detectHomeMismatch } from '../integrations/dsh/dsh-profile-service.mjs';
import type { AppPaths } from './paths.ts';

export function logEnvironment(paths: AppPaths): void {
    log(`环境: cwd=${process.cwd()} | home=${os.homedir()} | DSH_HOME=${process.env.DSH_HOME || '(未设置)'} | config=${paths.config}`);
    const mismatch = detectHomeMismatch();
    if (mismatch) {
        log(`⚠ ${mismatch.reason}`);
        log(`   dsh 实际目录: ${mismatch.home}`);
        log(`   ${mismatch.hint}`);
    } else log(`dsh home: ${dshHome()}`);
}
