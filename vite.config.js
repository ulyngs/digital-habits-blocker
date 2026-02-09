import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
    // Root directory is src/
    root: 'src',

    // Output to dist/ for production builds
    build: {
        outDir: '../dist',
        emptyOutDir: true,
        rollupOptions: {
            input: {
                main: resolve(__dirname, 'src/index.html'),
                debug: resolve(__dirname, 'src/debug.html'),
            },
        },
    },

    // Dev server config
    server: {
        port: 5173,
        strictPort: true,
    },

    // Clear console on hot reload
    clearScreen: false,
});
