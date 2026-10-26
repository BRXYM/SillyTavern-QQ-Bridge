import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

/** 后端端口：与 scripts/dev.mjs 的 API_PORT 保持一致 */
const API_PORT = Number(process.env.API_PORT ?? 9510);
const WEB_PORT = Number(process.env.WEB_PORT ?? 5178);

export default defineConfig({
    plugins: [vue(), tailwindcss()],
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('./src', import.meta.url)),
            '@bridge/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
        },
    },
    server: {
        // 监听所有网卡，便于从面板 / 局域网 / 反向代理访问
        host: true,
        port: WEB_PORT,
        strictPort: true,
        proxy: {
            '/api': {
                target: `http://127.0.0.1:${API_PORT}`,
                changeOrigin: true,
            },
            // 表情库图片缓存：后端以 /faces/cache/<file> 提供静态图片。
            // 不代理的话，Vite 会把它当成前端路由，返回 index.html，
            // 浏览器就渲染不出图（表现为预览空白/碎图）。
            '/faces': {
                target: `http://127.0.0.1:${API_PORT}`,
                changeOrigin: true,
            },
        },
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true,
    },
});
