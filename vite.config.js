import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { PurgeCSS } from 'purgecss';

// In dev (vite dev), index.html loads test-utils.js / blocking-tests.js /
// integration-tests.js so the developer can call runBlockingTests() and
// runIntegrationTests() from the console. In production we don't want to
// ship ~120 KB of test runners, so strip those <script> tags during build.
//
// This must run as a `pre` transformIndexHtml hook: the test files are classic
// scripts (no type="module"), and Vite's core build-html plugin warns
// ("<script> can't be bundled without type=\"module\"") while scanning the HTML
// for bundling. That scan happens before normal-order transformIndexHtml hooks,
// so a normal-order strip removes them from the output but still trips the
// warning. Running `pre` deletes the tags before the scan sees them.
const stripDevTestScripts = () => ({
    name: 'strip-dev-test-scripts',
    apply: 'build',
    transformIndexHtml: {
        order: 'pre',
        handler(html) {
            return html.replace(
                /\s*<script src="\.\/(test-utils|blocking-tests|integration-tests)\.js"><\/script>/g,
                '',
            );
        },
    },
});

// Remove a complete HTML element (including nested elements of the same tag)
// by id. This intentionally operates at build time: Android keeps the shared
// source template while avoiding parse/layout work for desktop-only screens.
function removeElementById(html, id) {
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const startPattern = new RegExp(
        `<([a-zA-Z][\\w:-]*)\\b[^>]*\\bid=["']${escapedId}["'][^>]*>`,
        'i',
    );
    const startMatch = startPattern.exec(html);
    if (!startMatch) return html;

    const tag = startMatch[1];
    const tokenPattern = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi');
    tokenPattern.lastIndex = startMatch.index;
    let depth = 0;
    let token;
    while ((token = tokenPattern.exec(html))) {
        const closing = token[0].startsWith('</');
        const selfClosing = token[0].endsWith('/>');
        if (closing) depth -= 1;
        else if (!selfClosing) depth += 1;
        if (depth === 0) {
            return html.slice(0, startMatch.index) + html.slice(tokenPattern.lastIndex);
        }
    }
    throw new Error(`Could not find closing <${tag}> for #${id}`);
}

// Elements that only ever render on desktop/iOS. stripNonAndroidUi removes them
// from the Android DOM, and purgeAndroidCss strips them from the same source
// HTML before deciding which CSS rules are still reachable — so the two stay in
// lock-step and purge never keeps styles for markup that isn't shipped.
const DESKTOP_AND_IOS_ONLY_IDS = [
    'window-controls',
    'update-banner',
    'app-blocking-closedown-banner',
    'behaviour-change-banner',
    'welcome-demo-panel',
    'fda-onboarding',
    'migration-onboarding',
    'ios-screentime-onboarding',
    'schedule-overlay-customise-modal',
    'schedule-overlay-discard-modal',
    'schedule-overlay-delete-modal',
    'settings-enforcement-panel',
    'uninstall-confirm-modal',
    'mac-automation-intro-modal',
    'app-blocking-warning-overlay',
];

// Path to the source template. purgeAndroidCss scans this directly because the
// emitted index.html is not present in the Rollup bundle during generateBundle
// (Vite's own html plugin emits it later), so a bundle scan would miss every
// class that only appears in static markup.
const INDEX_HTML_PATH = fileURLToPath(new URL('./src/index.html', import.meta.url));

// True if `css` contains at least one rule targeting `.className`. The negative
// lookahead stops `.card` from matching `.card-header`, so this is a faithful
// "does this exact class have any styling" probe (ignoring pseudo/compound
// context, which is all we need for the purge guard below).
function cssHasClassRule(css, className) {
    const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\.${escaped}(?![\\w-])`).test(css);
}

// Every distinct class token used in a `class="…"` attribute of `html`.
function collectHtmlClasses(html) {
    const classes = new Set();
    for (const attr of html.matchAll(/class="([^"]*)"/g)) {
        for (const token of attr[1].split(/\s+/)) {
            if (token) classes.add(token);
        }
    }
    return classes;
}

const stripNonAndroidUi = (enabled) => ({
    name: 'strip-non-android-ui',
    apply: 'build',
    transformIndexHtml(html) {
        if (!enabled) return html;
        return DESKTOP_AND_IOS_ONLY_IDS.reduce(removeElementById, html);
    },
});

// Strip unused CSS rules from the Android bundle. Startup on low-end Android
// devices pays for parsing/matching the full ~280 KB stylesheet even though a
// large share of it styles desktop/iOS-only screens that stripNonAndroidUi has
// already removed from the DOM. Reachability is judged from the source HTML
// with the same desktop/iOS-only elements stripped, plus the *emitted* JS
// chunks (post tree-shake) — see the content-collection note below for why the
// HTML is read from source rather than the bundle.
//
// The main app stylesheet is the only asset we purge. quill.css is left intact
// because Quill (lazy-loaded) attaches its ql-* classes at runtime from library
// code, so there's no static token for PurgeCSS to match and it would gut it.
const purgeAndroidCss = (enabled) => ({
    name: 'purge-android-css',
    apply: 'build',
    async generateBundle(_options, bundle) {
        if (!enabled) return;

        // Class tokens come from two sources: the JS chunks (post tree-shake)
        // and the source HTML template with the desktop/iOS-only elements
        // stripped — mirroring exactly what stripNonAndroidUi ships. The
        // emitted index.html is deliberately *not* read from the bundle: Vite's
        // html plugin emits it after this hook runs, so it isn't present here.
        // Minification preserves string literals, so base+modifier classes
        // built in JS (e.g. `calendar-block ${x ? 'active' : ''}`) still match
        // as long as the modifier word appears literally somewhere.
        const strippedHtml = DESKTOP_AND_IOS_ONLY_IDS.reduce(
            removeElementById,
            readFileSync(INDEX_HTML_PATH, 'utf8'),
        );
        const content = [{ raw: strippedHtml, extension: 'html' }];
        for (const file of Object.values(bundle)) {
            if (file.type === 'chunk') {
                content.push({ raw: file.code, extension: 'js' });
            }
        }

        const target = Object.values(bundle).find(
            (file) =>
                file.type === 'asset' &&
                file.fileName.endsWith('.css') &&
                !file.fileName.includes('quill'),
        );
        if (!target) return;

        const css = typeof target.source === 'string'
            ? target.source
            : Buffer.from(target.source).toString('utf8');

        const [result] = await new PurgeCSS().purge({
            content,
            css: [{ raw: css }],
            // Match Tailwind-style token extraction: any run of class-name chars.
            defaultExtractor: (text) => text.match(/[A-Za-z0-9_-]+/g) || [],
            keyframes: true,
            fontFace: true,
            // The stylesheet drives light/dark theming through custom properties
            // that JS reads via getComputedStyle; PurgeCSS's variable pruning is
            // too aggressive for that, so leave declarations alone.
            variables: false,
            safelist: {
                standard: [
                    // Toggled by JS via classList/attribute state, not always
                    // present as a full literal next to their base class.
                    'active', 'selected', 'open', 'visible', 'hidden', 'show',
                    'disabled', 'danger', 'interactive', 'dragging', 'collapsed',
                    'expanded', 'error', 'success', 'loading', 'pressed',
                    'can-horizontal-scroll', 'overnight-continuation',
                    'instant-preview', 'preview',
                    // Theme roots stamped on <html>/<body>.
                    /^theme-/, /^data-theme/,
                ],
                // Android-shared screens whose class names are assembled from
                // runtime data (`${status}` etc.), so their modifiers can't be
                // seen statically. Keep their whole subtree. Desktop-only
                // families (migration-*, extension-enforcer-*, safari-*,
                // mac-automation-*) are deliberately NOT listed so they purge.
                greedy: [
                    /calendar-block/, /schedule-segment/, /^repeat-option/,
                    /^popover-option/, /^now-blocking-/, /^schedule-overlay-/,
                ],
            },
        });

        // Guard against an over-aggressive purge. PurgeCSS deletes rules
        // silently — a broken layout is the only symptom, and it doesn't show
        // up until the APK runs on a device. So assert the invariant that made
        // this safe in the first place: every class that (a) still appears in
        // the shipped Android markup and (b) had a rule in the full stylesheet
        // must still have a rule after purging. Any offender means the purge
        // ate live styling; fail the build with the exact list rather than
        // shipping it. (Scoped to static HTML classes — JS-assembled class
        // names are covered by the safelist, not statically decidable here.)
        const orphaned = [];
        for (const className of collectHtmlClasses(strippedHtml)) {
            if (cssHasClassRule(css, className) && !cssHasClassRule(result.css, className)) {
                orphaned.push(className);
            }
        }
        if (orphaned.length > 0) {
            throw new Error(
                `purge-android-css removed styling still used by the Android UI. `
                + `Add the affected class(es) to the safelist or exclude their `
                + `element from DESKTOP_AND_IOS_ONLY_IDS:\n  `
                + orphaned.sort().join('\n  '),
            );
        }

        target.source = result.css;
    },
});

export default defineConfig(async ({ mode }) => ({
    plugins: [
        stripDevTestScripts(),
        stripNonAndroidUi(mode === 'android'),
        purgeAndroidCss(mode === 'android'),
        // Bundle analysis: `ANALYZE=1 npm run vite:build:android` writes
        // dist/stats.html (treemap of what actually ships). Dev-only; no
        // effect on the shipped bundle. Loaded via dynamic import because
        // rollup-plugin-visualizer is ESM-only and this config is CJS.
        process.env.ANALYZE &&
            (await import('rollup-plugin-visualizer')).visualizer({
                filename: 'dist/stats.html',
                gzipSize: true,
                brotliSize: true,
            }),
    ].filter(Boolean),

    // Compile-time platform flag. Unlike `state.isAndroid` (resolved at
    // runtime), this is a literal baked in per build mode, so Rollup can
    // dead-code-eliminate `if (!__ANDROID_BUILD__) { … }` branches and
    // tree-shake the desktop-only modules they reference out of the
    // Android bundle entirely.
    define: {
        __ANDROID_BUILD__: JSON.stringify(mode === 'android'),
    },

    // Root directory is src/
    root: 'src',

    build: {
        outDir: '../dist',
        emptyOutDir: true,
        rollupOptions: {
            input: {
                main: fileURLToPath(new URL('./src/index.html', import.meta.url)),
            },
        },
    },

    // Dev server config
    server: {
        port: 5173,
        strictPort: true,
        // Listen on all interfaces when developing for iOS physical devices
        host: process.env.TAURI_DEV_HOST || false,
    },

    // Clear console on hot reload
    clearScreen: false,
}));
