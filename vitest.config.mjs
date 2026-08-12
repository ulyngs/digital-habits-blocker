import { defineConfig } from 'vitest/config';

// Tier 0: plain unit tests over the pure helpers in `src/`.
//
// Deliberately NOT `vite.config.js` — that config carries the index.html
// rewriting, PurgeCSS and Android asset-pruning plugins, none of which mean
// anything when the entry point is a test file rather than the app shell.
// The only thing Tier 0 needs from the build is the `__ANDROID_BUILD__`
// compile-time constant, so the modules under test resolve the same branches
// they do in a desktop build.
export default defineConfig({
    define: {
        __ANDROID_BUILD__: false,
    },
    test: {
        include: ['test/tier0/**/*.test.js'],
        // Several `src/` modules import siblings that touch `document` at
        // import time; jsdom keeps Tier 0 usable for those without each test
        // having to hand-roll a DOM.
        environment: 'jsdom',
        restoreMocks: true,
    },
});
