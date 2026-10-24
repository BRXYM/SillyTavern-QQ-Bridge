import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['tests/**/*.test.ts'],
    },
    resolve: {
        alias: {
            '@bridge/shared': new URL('../shared/src/index.ts', import.meta.url).pathname,
            '@bridge/core': new URL('../core/src/index.ts', import.meta.url).pathname,
        },
    },
});
