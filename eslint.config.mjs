// ESLint flat config.
//
// Scope is deliberately narrow: `js.configs.recommended` only, no stylistic
// rules. Formatting is not linted here — the Rust side is covered by
// `cargo fmt --check` and the JS side has no formatter, so adding one would be
// a separate (and much larger) change than wiring up static analysis.
//
// The value this earns today is the correctness subset: `no-dupe-keys` caught
// three silently-shadowed i18n keys, and `no-undef` caught a ReferenceError on
// a live code path in the schedule overlay editor.

import js from '@eslint/js';
import globals from 'globals';

export default [
    {
        ignores: [
            'dist/**',
            'node_modules/**',
            'src-tauri/target/**',
            'src-tauri/gen/**',
            'browser-ext-migration/**',
            // Gradle output — the Kotlin unit-test run drops an HTML report
            // with its own bundled JS in here. Git ignores it too.
            'tauri-plugin-android-blocker/android/build/**',
        ],
    },

    js.configs.recommended,

    {
        // Shared rule tuning. Kept in one block so the per-area configs below
        // only ever differ in globals and sourceType.
        rules: {
            // 197 findings at time of writing, essentially all dead imports.
            // Real cleanup (and a bundle-size win — Vite emits an asset for
            // every `import url from './x.png'` at transform time, whether or
            // not the binding is used), but a mechanical one that would bury
            // the correctness findings above. Warn now, promote to error once
            // the backlog is cleared.
            'no-unused-vars': 'warn',
            // Both uses in this repo are intentional control-character
            // sanitisation — ANSI-escape stripping in the changelog renderer
            // and in the store-submission JSON writer.
            'no-control-regex': 'off',
            // `try { … } catch {}` is the established idiom here for
            // best-effort process/filesystem calls.
            'no-empty': ['error', { allowEmptyCatch: true }],
        },
    },

    {
        // Frontend ES modules.
        files: ['src/**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: {
                ...globals.browser,
                // Compile-time constant injected by vite.config.js `define`.
                __ANDROID_BUILD__: 'readonly',
            },
        },
    },

    {
        // The three test runners are classic scripts, injected via <script>
        // tags in src/index.html and stripped from production bundles, so they
        // share one global scope rather than importing each other.
        files: ['src/test-utils.js', 'src/blocking-tests.js', 'src/integration-tests.js'],
        languageOptions: {
            sourceType: 'script',
        },
    },

    {
        // Tier 0 unit tests. They import `describe`/`test`/`expect` explicitly
        // rather than relying on vitest globals, so only the DOM globals of the
        // jsdom environment need declaring.
        files: ['test/tier0/**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: {
                ...globals.browser,
                __ANDROID_BUILD__: 'readonly',
            },
        },
    },

    {
        // Build/CI/release tooling.
        files: ['scripts/**/*.{js,mjs,cjs}', 'vite.config.js', 'vitest.config.mjs'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: globals.node,
        },
    },

    {
        // Playwright/WebDriver runners evaluate callbacks inside the page, so
        // browser globals are legitimately in scope alongside the Node ones.
        files: ['scripts/ci/**/*.mjs', 'e2e/**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: {
                ...globals.node,
                ...globals.browser,
                ...globals.mocha,
                // WebdriverIO injects these into the spec scope.
                browser: 'readonly',
                $: 'readonly',
                $$: 'readonly',
            },
        },
    },

    {
        // Classic script served inside the bundled block page.
        files: ['src-tauri/blocked/**/*.js'],
        languageOptions: {
            sourceType: 'script',
            globals: globals.browser,
        },
    },
];
