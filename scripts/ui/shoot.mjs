#!/usr/bin/env node
/**
 * UI screenshot harness.
 *
 * Renders app screens from fixture data in headless Chromium and writes PNGs to
 * artifacts/ui/. It exists because nothing else in the test stack renders: Tier 0
 * runs in jsdom, which has no layout engine and returns zeros from
 * getBoundingClientRect; Tier 1 loads the page but only asserts pure logic; Tier 2
 * asserts the Rust-derived blocking snapshot. A change to styles.css can therefore
 * be wrong in every visible way and still be green.
 *
 * This is a debugging tool, not a gate. It takes pictures; a human or an agent
 * decides whether they look right. There are deliberately no committed reference
 * images — cross-machine font rendering makes pixel diffs flaky, and the
 * maintenance lands on every PR.
 *
 * It needs no Rust toolchain, no Tauri build and no signing — just the Vite dev
 * server and a Chromium that Playwright can drive. That is the point: it runs in
 * seconds on a laptop and in CI on Linux, on the same fixtures, so a styling
 * change can be looked at without building the app.
 *
 * First run on a fresh machine needs the browser once:
 *   npx playwright install chromium
 *
 * Usage:
 *   pnpm ui:shoot                          all screens
 *   pnpm ui:shoot --screen=week-crowded    one screen
 *   pnpm ui:shoot --out=/tmp/shots         somewhere other than artifacts/ui
 *   pnpm ui:shoot --measure                also print measured lane geometry
 *
 * Screens live in test/ui/screens.js and fixtures in test/ui/fixtures.js. Adding
 * a screenshot should not mean editing this file.
 */
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { startDevServer } from '../ci/lib/dev-server.mjs';
import { screens } from '../../test/ui/screens.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PORT = process.env.UI_SHOOT_PORT || '5198';
const BOOT_TIMEOUT_MS = 60_000;

function log(...a) { console.log('[ui:shoot]', ...a); }

function parseArgs(argv) {
    const args = { screen: null, out: path.join(REPO_ROOT, 'artifacts', 'ui'), measure: false };
    for (const arg of argv) {
        if (arg.startsWith('--screen=')) args.screen = arg.slice('--screen='.length);
        else if (arg.startsWith('--out=')) args.out = path.resolve(arg.slice('--out='.length));
        else if (arg === '--measure') args.measure = true;
        else throw new Error(`unknown argument: ${arg}`);
    }
    return args;
}

/**
 * Chromium, with the differences between a laptop and a container handled.
 *
 * On a developer machine the default is right: Playwright resolves the browser
 * it downloaded for its own version. Two things differ elsewhere:
 *
 *   - Sandboxed container images ship a Chromium that Playwright did not
 *     download, whose build number will not match the one this Playwright
 *     expects. UI_SHOOT_CHROMIUM points at that binary instead of failing.
 *   - Chromium's sandbox cannot initialise as uid 0, which is normal in a
 *     container and never the case on a laptop — so the flag keys off uid
 *     rather than an env var someone has to remember to set.
 */
async function launchChromium() {
    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    const options = {};
    if (process.env.UI_SHOOT_CHROMIUM) options.executablePath = process.env.UI_SHOOT_CHROMIUM;
    if (isRoot) options.args = ['--no-sandbox'];

    try {
        return await chromium.launch(options);
    } catch (err) {
        if (/Executable doesn't exist|please run.*install/i.test(err.message)) {
            throw new Error(
                'Chromium is not installed for Playwright.\n'
                + '  Install it:      npx playwright install chromium\n'
                + '  Or point at one: UI_SHOOT_CHROMIUM=/path/to/chrome pnpm ui:shoot',
                { cause: err },
            );
        }
        throw err;
    }
}

/**
 * The entire Tauri stub.
 *
 * The app does not boot without a Tauri runtime: app.js awaits loadData(), which
 * is an uncaught invoke('load_data'), so a missing transport aborts the whole
 * DOMContentLoaded handler before anything renders. Rather than adding a
 * no-backend code path to src/, the transport is faked here at the browser
 * boundary, so nothing test-only ships.
 *
 * Unknown commands resolve `null` instead of throwing, which is what keeps this
 * from needing an entry per command as the backend grows. If a screen ever needs
 * more than a canned constant here, leave that screen out of the harness rather
 * than growing this into a second implementation of the backend.
 */
function installTauriStub(context, appData) {
    return context.addInitScript((appData) => {
        const RESPONSES = {
            load_data: appData,
            // Returning null here would crash refreshDesktopHelperStatus, which
            // reads `.running` off the result unguarded.
            check_helper_status: { installed: false, running: false },
        };
        window.__TAURI_INTERNALS__ = {
            invoke: (cmd) => Promise.resolve(cmd in RESPONSES ? RESPONSES[cmd] : null),
            transformCallback: (cb) => { window.__uiShootCallback = cb; return 1; },
            convertFileSrc: (p) => p,
            // getCurrentWindow()/getCurrentWebview() read these synchronously and
            // throw without them — setupAppForegroundRefresh calls the first.
            metadata: {
                currentWindow: { label: 'main' },
                currentWebview: { label: 'main' },
            },
        };
    }, appData);
}

// Must mirror detectPlatform() in src/blocking-platform.js, including the
// secondary classes — those are what actually gate layout. `handset-device` in
// particular hides whole sections (the week calendar among them), so an iPhone
// stamped as bare `ios` renders screens a phone never shows.
const PLATFORM_BODY_CLASSES = {
    windows: ['windows'],
    mac: ['mac'],
    ipad: ['ios'],
    iphone: ['ios', 'ios-phone', 'mobile-phone-home', 'handset-device'],
    android: ['android', 'mobile-phone-home', 'handset-device'],
};

/**
 * Boot the app on a screen's fixture and leave it showing the main content.
 *
 * `eulaRevision` is read off the internals contract by the caller rather than
 * hardcoded — a literal here would start silently hitting the EULA gate the next
 * time CURRENT_EULA_REVISION is bumped.
 */
async function openScreen(browser, screen, eulaRevision) {
    const context = await browser.newContext({
        viewport: screen.viewport || { width: 1100, height: 900 },
        deviceScaleFactor: 2,
    });

    // Returning-user settings. Each flag clears one full-screen overlay that
    // would otherwise cover #main-content:
    //   onboardingComplete + eulaAcceptedRevision  — mirrors src/test-utils.js
    //   welcomeOnboardingShown                     — src/onboarding.js
    //   digitalHabitsRebrandNoticeShown            — src/onboarding.js
    const appData = {
        ...screen.fixture,
        settings: {
            ...screen.fixture.settings,
            onboardingComplete: true,
            welcomeOnboardingShown: true,
            digitalHabitsRebrandNoticeShown: true,
            eulaAcceptedRevision: eulaRevision,
        },
    };

    await installTauriStub(context, appData);
    const page = await context.newPage();

    const problems = [];
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text().split('\n')[0]}`); });

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.__REDDBLOCK_INTERNALS__ === 'object', null, { timeout: BOOT_TIMEOUT_MS });

    const bodyClasses = PLATFORM_BODY_CLASSES[screen.platform];
    if (!bodyClasses) {
        throw new Error(
            `screen "${screen.name}" has platform "${screen.platform}"; expected one of `
            + Object.keys(PLATFORM_BODY_CLASSES).join(', '),
        );
    }

    await page.evaluate(async ({ appData, bodyClasses }) => {
        const internals = window.__REDDBLOCK_INTERNALS__;

        // A Vite run forces the EULA gate regardless of persisted settings
        // (resetDevOnlyEulaAcceptance), so seeding the revision is not enough.
        // acceptEula() is the app's own acceptance path and is exposed on the
        // internals contract for exactly this.
        await internals.acceptEula();

        internals.appData = appData;
        internals.render();

        // Gates that depend on backend answers we deliberately do not fake
        // (migration, full-disk access, extension setup). Every overlay in
        // showExclusiveOnboardingScreen's list ends in `-onboarding`, so this
        // also covers ones added later. Must run after render(), which re-runs
        // the onboarding visibility pass and would otherwise re-hide the app.
        document.querySelectorAll('[id$="-onboarding"]').forEach(el => el.classList.add('hidden'));
        document.getElementById('main-content')?.classList.remove('hidden');
        document.getElementById('now-blocking-row')?.classList.remove('hidden');

        // detectPlatform() has no Linux branch and falls through to Windows, so
        // an unstamped screenshot taken on Linux silently claims to be Windows.
        // Restate the platform explicitly for every shot.
        document.body.classList.remove(
            'windows', 'mac', 'ios', 'ios-phone', 'android', 'mobile-phone-home', 'handset-device',
        );
        bodyClasses.forEach(c => document.body.classList.add(c));

        // detectPlatform does not only add classes — it hides desktop chrome on
        // its mac/iOS/Android branches. Having already run its Windows branch on
        // Linux, it left the Windows title bar and window controls *visible*, so
        // restamping classes alone puts a Windows close button on an Android
        // screenshot and squeezes the layout beneath it. Mirror the DOM side
        // effects of the branch this platform would really have taken.
        const showsWindowChrome = bodyClasses.includes('windows');
        const isMobile = bodyClasses.includes('ios') || bodyClasses.includes('android');
        document.getElementById('window-controls')?.classList.toggle('hidden', !showsWindowChrome);
        document.querySelector('.title-bar')?.classList.toggle('hidden', isMobile);
        document.getElementById('helper-settings-section')?.classList.toggle('hidden', isMobile);
    }, { appData, bodyClasses });

    if (screen.theme === 'dark') {
        await page.evaluate(() => document.body.classList.add('dark-mode'));
    }

    await page.waitForFunction(
        () => !document.getElementById('main-content')?.classList.contains('hidden'),
        null,
        { timeout: BOOT_TIMEOUT_MS },
    );

    if (screen.prepare) await screen.prepare(page);

    // A screen whose subject is display:none on its own platform is not a
    // screenshot, it is a claim about a screen that does not exist there — and
    // `body.handset-device` hides whole sections, so this is easy to get wrong
    // by stamping a platform without the classes the real app pairs with it.
    // Fail loudly rather than emitting a blank or misleading PNG.
    if (screen.clip) {
        const visible = await page.evaluate((selector) => {
            const el = document.querySelector(selector);
            if (!el) return 'missing';
            const box = el.getBoundingClientRect();
            return box.width > 0 && box.height > 0 ? 'ok' : 'hidden';
        }, screen.clip);
        if (visible !== 'ok') {
            throw new Error(
                `screen "${screen.name}": ${screen.clip} is ${visible} on platform "${screen.platform}". `
                + 'That platform does not show this UI — drop the screen or fix its platform.',
            );
        }
    }

    return { context, page, problems };
}

/** Measured lane geometry — what the layout actually produced, not what it intended. */
function measureLanes(page) {
    return page.evaluate(() => Array.from(document.querySelectorAll('.day-track')).map(track => ({
        day: track.dataset.dayIndex,
        rowHeight: Math.round(track.closest('.day-row').getBoundingClientRect().height * 10) / 10,
        overflow: track.querySelector('.calendar-lane-overflow')?.textContent || null,
        blocks: Array.from(track.querySelectorAll('.calendar-block')).map(b => ({
            name: b.title,
            // Withheld blocks measure 0px because they are display:none. Naming
            // that explicitly matters — reported as a height it reads like a
            // layout bug rather than the deliberate cap.
            kind: b.classList.contains('overflow-hidden') ? 'withheld'
                : b.classList.contains('compact') ? 'band' : 'label',
            height: Math.round(b.getBoundingClientRect().height * 10) / 10,
        })),
    })));
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const selected = args.screen ? screens.filter(s => s.name === args.screen) : screens;
    if (selected.length === 0) {
        throw new Error(`no screen named "${args.screen}". Known: ${screens.map(s => s.name).join(', ')}`);
    }

    // Only a full run may clear the directory. Clearing it on a single-screen
    // run would delete the other screenshots — which is exactly what you are
    // comparing against while iterating on one screen.
    if (!args.screen) await rm(args.out, { recursive: true, force: true });
    await mkdir(args.out, { recursive: true });

    let stopServer = () => {};
    let browser;
    const cleanup = async () => {
        try { if (browser) await browser.close(); } catch { /* ignore */ }
        stopServer('SIGTERM');
    };
    process.on('exit', () => stopServer('SIGKILL'));

    try {
        ({ stop: stopServer } = await startDevServer({ port: PORT, bootTimeoutMs: BOOT_TIMEOUT_MS, log }));
        browser = await launchChromium();

        // One throwaway boot to read CURRENT_EULA_REVISION off the internals
        // contract. The init script is per-context, so this cannot share a
        // context with the real shots.
        const probe = await openScreen(browser, selected[0], 0);
        const eulaRevision = await probe.page.evaluate(() => window.__REDDBLOCK_INTERNALS__.CURRENT_EULA_REVISION);
        await probe.context.close();

        for (const screen of selected) {
            const { context, page, problems } = await openScreen(browser, screen, eulaRevision);
            const file = path.join(args.out, `${screen.name}.png`);
            await (screen.clip
                ? page.locator(screen.clip).screenshot({ path: file })
                // Unclipped means "the whole screen", including anything below
                // the fold — a viewport-only shot silently crops the app.
                : page.screenshot({ path: file, fullPage: true }));
            log(`${screen.name} → ${path.relative(REPO_ROOT, file)}`);

            if (args.measure) {
                for (const day of await measureLanes(page)) {
                    if (day.blocks.length === 0) continue;
                    log(`  day ${day.day} (row ${day.rowHeight}px${day.overflow ? `, pill ${day.overflow}` : ''})`
                        + day.blocks.map(b => b.kind === 'withheld'
                            ? `\n    withheld        ${b.name}`
                            : `\n    ${b.kind.padEnd(8)} ${String(b.height).padStart(5)}px  ${b.name}`).join(''));
                }
            }
            if (problems.length) problems.slice(0, 5).forEach(p => log(`  ! ${p}`));
            await context.close();
        }

        log(`wrote ${selected.length} screenshot(s) to ${path.relative(REPO_ROOT, args.out)}`);
        await cleanup();
        process.exit(0);
    } catch (err) {
        log('FAILED:', err.message);
        await cleanup();
        process.exit(1);
    }
}

main();
