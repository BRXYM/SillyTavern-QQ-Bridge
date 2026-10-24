import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['tests/**/*.test.ts'],
    },
    resolve: {
        // workspace 包直接指向源码，避免构建顺序依赖
        alias: {
            '@bridge/shared': new URL('../shared/src/index.ts', import.meta.url).pathname,
        },
    },
});
