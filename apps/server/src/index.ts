/** 进程入口：应用装配和业务实现见 app/application.ts。 */
import { createApplication } from './app/application.ts';
import { log } from './core/logger.ts';

async function main(): Promise<void> {
    const app = createApplication();
    const shutdown = async (signal: string) => {
        log(`收到 ${signal}，正在关闭…`);
        try {
            await app.stop();
            log('已退出');
            process.exit(0);
        } catch (error) {
            log(`关闭时出错：${String(error)}`);
            process.exit(1);
        }
    };
    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
    await app.start();
}

void main().catch((error) => {
    log(`✗ 启动失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exit(1);
});
