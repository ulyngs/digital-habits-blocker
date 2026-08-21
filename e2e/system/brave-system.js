/**
 * Brave-first macOS system tests.
 *
 * This file intentionally talks to the browser, rather than the Tier 2
 * diagnostics command.  The runner owns the signed app and sets the
 * SYSTEM_TEST_* environment variables below.  Keeping this as a plain module
 * makes it useful from a local runner and from a small feasibility spike:
 *
 *   node e2e/system/brave-system.js --probe
 *   node e2e/system/brave-system.js
 *
 * The suite is macOS-only and never kills an unrelated Brave process.  It
 * launches one browser with a temporary profile and only terminates the PID
 * returned by spawn().
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

export const SYSTEM_TEST_URL =
    process.env.SYSTEM_TEST_URL || 'https://redd-block-system-test.invalid/path?probe=1';
export const SYSTEM_TEST_HOST = new URL(SYSTEM_TEST_URL).hostname;
export const SYSTEM_TEST_ALLOWED_URL =
    process.env.SYSTEM_TEST_ALLOWED_URL || 'https://redd-block-allowed-system-test.invalid/path?probe=2';
export const SYSTEM_TEST_ALLOWED_HOST = new URL(SYSTEM_TEST_ALLOWED_URL).hostname;
export const SYSTEM_TEST_OUTSIDE_URL =
    process.env.SYSTEM_TEST_OUTSIDE_URL || 'https://redd-block-outside-system-test.invalid/path?probe=3';
export const SYSTEM_TEST_OUTSIDE_HOST = new URL(SYSTEM_TEST_OUTSIDE_URL).hostname;
const BLOCKED_PAGE_FRAGMENT = 'blocked.html';
const DEFAULT_TIMEOUT_MS = 20_000;
const BACKGROUND_CADENCE_MS = 6_000;

function envPath(name, fallback) {
    return process.env[name] || fallback;
}

function artifactsDir() {
    return envPath('SYSTEM_TEST_ARTIFACTS_DIR', path.resolve('e2e/system-artifacts'));
}

/** Apply runner-provided paths without requiring a second config module. */
export function configureSystemTest(options = {}) {
    if (options.appPath) process.env.SYSTEM_TEST_APP = options.appPath;
    if (options.dataDir) process.env.SYSTEM_TEST_DATA_DIR = options.dataDir;
    if (options.artifactsDir) process.env.SYSTEM_TEST_ARTIFACTS_DIR = options.artifactsDir;
    if (options.profileDir) process.env.SYSTEM_TEST_PROFILE_DIR = options.profileDir;
    if (options.bravePort) process.env.SYSTEM_TEST_BRAVE_PORT = String(options.bravePort);
    return {
        dataFile: process.env.SYSTEM_TEST_DATA_DIR ? dataFile() : null,
        artifactsDir: artifactsDir(),
        profileDir: envPath('SYSTEM_TEST_PROFILE_DIR', path.resolve('e2e/system-profile')),
    };
}

function dataFile() {
    const configured = process.env.SYSTEM_TEST_DATA_DIR;
    if (!configured) {
        throw new Error('SYSTEM_TEST_DATA_DIR must point to the isolated data directory or JSON file');
    }
    return configured.endsWith('.json') ? configured : path.join(configured, 'redd-block-data.json');
}

function now() {
    return Date.now();
}

function id(label) {
    return `system-test-${label}-${now()}`;
}

function emptyData() {
    return {
        blocklists: [],
        activeBlocks: [],
        schedules: [],
        settings: { onboardingComplete: true, eulaAcceptedRevision: 1, eulaAcceptedAt: now() },
    };
}

export async function readData() {
    try {
        return JSON.parse(await readFile(dataFile(), 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return emptyData();
        throw error;
    }
}

export async function writeData(data) {
    const file = dataFile();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function mainBravePids() {
    if (process.platform !== 'darwin') return [];
    const output = execFileSync('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' });
    return output.split('\n').flatMap((line) => {
        const match = /^\s*(\d+)\s+(.+)$/.exec(line);
        if (!match) return [];
        const executable = path.basename(match[2].trim());
        return executable === 'Brave Browser' ? [Number(match[1])] : [];
    });
}

function assertNoBraveRunning() {
    const pids = mainBravePids();
    if (pids.length) {
        throw new Error(
            `Refusing to run: Brave Browser is already running (main PID(s): ${pids.join(', ')}). `
            + 'Quit normal Brave before starting the isolated system test.',
        );
    }
}

function appleScriptString(value) {
    return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function runBraveAutomation(script) {
    try {
        return execFileSync('/usr/bin/osascript', ['-e', script], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: DEFAULT_TIMEOUT_MS,
        }).trim();
    } catch (error) {
        const detail = error?.stderr?.toString?.().trim() || error.message;
        throw new Error(`Brave Automation failed: ${detail}`, { cause: error });
    }
}

class BraveAutomationPage {
    constructor(windowId) {
        this.windowId = Number(windowId);
    }

    windowReference() {
        return `first window whose id is ${this.windowId}`;
    }

    url() {
        return runBraveAutomation(
            `tell application "Brave Browser" to return URL of active tab of ${this.windowReference()}`,
        );
    }

    async goto(url) {
        runBraveAutomation(
            `tell application "Brave Browser" to set URL of active tab of ${this.windowReference()} to ${appleScriptString(url)}`,
        );
        return null;
    }

    async reload() {
        await this.goto(this.url());
    }

    async waitForTimeout(ms) {
        await new Promise((resolve) => setTimeout(resolve, ms));
    }

    async bringToFront() {
        // Deliberately do not reorder the user's other Brave windows.
    }

    async screenshot({ path: outputPath }) {
        void outputPath;
        // Brave's AppleScript window id is not a CGWindow id. Keep failure
        // capture read-only in shared mode; the JSON artifact records the URL.
    }

    async close() {
        runBraveAutomation(
            `tell application "Brave Browser" to close ${this.windowReference()}`,
        );
    }
}

async function attachExistingBrave() {
    const pids = mainBravePids();
    if (pids.length === 0) throw new Error('Brave Browser must already be running for shared-window mode');
    const windowId = runBraveAutomation(
        `tell application "Brave Browser"
activate
set _window to make new window
set URL of active tab of _window to ${appleScriptString(SYSTEM_TEST_URL)}
return id of _window
end tell`,
    );
    const page = new BraveAutomationPage(windowId);
    return { automation: true, page, originalMainPids: pids };
}

function braveBinary() {
    const configured = process.env.SYSTEM_TEST_BRAVE_BINARY;
    const candidate = configured || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
    if (!existsSync(candidate)) {
        throw new Error(`Brave executable not found: ${candidate}`);
    }
    return candidate;
}

async function launchBrave({ profileDir, port }) {
    assertNoBraveRunning();
    await mkdir(profileDir, { recursive: true });
    const child = spawn(braveBinary(), [
        `--user-data-dir=${profileDir}`,
        `--remote-debugging-port=${port}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-sync',
        '--new-window',
        SYSTEM_TEST_URL,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const logs = [];
    child.stdout.on('data', (chunk) => logs.push(String(chunk)));
    child.stderr.on('data', (chunk) => logs.push(String(chunk)));
    child.__systemTestLogs = logs;
    child.__systemTestPid = child.pid;
    const deadline = now() + DEFAULT_TIMEOUT_MS;
    let browser;
    while (now() < deadline) {
        try {
            browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
            break;
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }
    if (!browser) {
        child.kill('SIGKILL');
        throw new Error(`Brave did not expose CDP on port ${port}`);
    }
    const runningMainPids = mainBravePids();
    if (runningMainPids.length !== 1) {
        await browser.close().catch(() => {});
        try { process.kill(child.pid, 'SIGKILL'); } catch {}
        throw new Error(
            `Expected exactly one Brave Browser main process for the system test, found ${runningMainPids.join(', ') || 'none'}`,
        );
    }
    return { child, browser };
}

async function closeBrave(session) {
    if (!session) return;
    if (session.automation) {
        await session.page?.close().catch(() => {});
        return;
    }
    await session.browser?.close().catch(() => {});
    if (session.child?.pid) {
        try { process.kill(session.child.pid, 'SIGKILL'); } catch (error) {
            if (error.code !== 'ESRCH') throw error;
        }
        const deadline = now() + 5_000;
        while (now() < deadline && mainBravePids().includes(session.child.pid)) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (mainBravePids().includes(session.child.pid)) {
            throw new Error(`Could not clean up isolated Brave PID ${session.child.pid}`);
        }
    }
}

function allPages(browser) {
    return browser.contexts().flatMap((context) => context.pages());
}

async function activePage(browser) {
    const pages = allPages(browser);
    if (!pages.length) throw new Error('Brave has no pages');
    return pages[0];
}

async function waitForUrl(page, predicate, timeout = DEFAULT_TIMEOUT_MS) {
    const deadline = now() + timeout;
    while (now() < deadline) {
        const url = page.url();
        if (predicate(url)) return url;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Timed out waiting for Brave URL; got ${page.url()}`);
}

async function navigateProbe(page, targetUrl = SYSTEM_TEST_URL) {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS })
        .catch(() => {});
    return page.url();
}

export function isBlockedUrl(url) {
    return url.includes(BLOCKED_PAGE_FRAGMENT) || url.startsWith('file:');
}

/** Pure smoke checks for CI jobs that cannot grant Automation/TCC. */
export function selfTest() {
    if (!SYSTEM_TEST_URL.includes('.invalid')) {
        throw new Error(`SYSTEM_TEST_URL must use a reserved .invalid host: ${SYSTEM_TEST_URL}`);
    }
    if (!SYSTEM_TEST_ALLOWED_URL.includes('.invalid')) {
        throw new Error(`SYSTEM_TEST_ALLOWED_URL must use a reserved .invalid host: ${SYSTEM_TEST_ALLOWED_URL}`);
    }
    if (!SYSTEM_TEST_OUTSIDE_URL.includes('.invalid')) {
        throw new Error(`SYSTEM_TEST_OUTSIDE_URL must use a reserved .invalid host: ${SYSTEM_TEST_OUTSIDE_URL}`);
    }
    if (!isBlockedUrl('file:///blocked.html') || isBlockedUrl(SYSTEM_TEST_URL)) {
        throw new Error('block-page URL helper returned an unexpected result');
    }
    return { requested: SYSTEM_TEST_URL, allowed: SYSTEM_TEST_ALLOWED_URL, passed: true };
}

export function blockEntry(blocklistId, { paused = false, durationMs = 60_000 } = {}) {
    const start = now() - 250;
    return {
        id: id('block'),
        blocklistId,
        startTime: start,
        endTime: start + durationMs,
        ...(paused ? { isPaused: true, pauseEndTime: now() + durationMs } : {}),
    };
}

export async function setPolicy(policy) {
    const data = await readData();
    const next = { ...emptyData(), ...data, ...policy };
    next.settings = {
        ...(data.settings || {}),
        onboardingComplete: true,
        eulaAcceptedRevision: 1,
        eulaAcceptedAt: data.settings?.eulaAcceptedAt || now(),
    };
    await writeData(next);
    return next;
}

export async function clearPolicy() {
    const data = await readData();
    await writeData({ ...data, activeBlocks: [], schedules: [] });
}

async function screenshotOnFailure(page, label, data) {
    const directory = artifactsDir();
    await mkdir(directory, { recursive: true });
    const safe = label.replace(/[^a-z0-9_-]+/gi, '-');
    await page.screenshot({ path: path.join(directory, `${safe}.png`), fullPage: true }).catch(() => {});
    await writeFile(path.join(directory, `${safe}.json`), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function assertRedirect(page, label, timeout = DEFAULT_TIMEOUT_MS) {
    await waitForUrl(
        page,
        (url) => isBlockedUrl(url),
        timeout,
    )
        .catch(async () => {
            throw new Error(`${label}: expected browser redirect, got ${page.url()}`);
        });
    const url = page.url();
    if (!isBlockedUrl(url)) throw new Error(`${label}: redirect URL is not a block page: ${url}`);
    return url;
}

async function assertRestored(page, label, timeout = DEFAULT_TIMEOUT_MS) {
    await waitForUrl(page, (url) => url === SYSTEM_TEST_URL, timeout).catch(() => {
        throw new Error(`${label}: expected ${SYSTEM_TEST_URL}, got ${page.url()}`);
    });
    if (page.url() !== SYSTEM_TEST_URL) throw new Error(`${label}: expected ${SYSTEM_TEST_URL}, got ${page.url()}`);
}

async function testWebsiteLifecycle(page) {
    const blocklistId = id('lifecycle-bl');
    await setPolicy({
        blocklists: [{ id: blocklistId, name: 'System test', mode: 'blocklist', websites: [SYSTEM_TEST_HOST], apps: [] }],
        activeBlocks: [blockEntry(blocklistId)],
    });
    await navigateProbe(page);
    const blocked = await assertRedirect(page, 'blocklist redirect');
    if (!decodeURIComponent(blocked).includes(SYSTEM_TEST_URL)) {
        throw new Error(`blocklist metadata did not retain original URL: ${blocked}`);
    }

    await setPolicy({ activeBlocks: [blockEntry(blocklistId, { paused: true })] });
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await assertRestored(page, 'pause restore');

    await setPolicy({ activeBlocks: [blockEntry(blocklistId)] });
    await navigateProbe(page);
    await assertRedirect(page, 'resume redirect');

    await setPolicy({ activeBlocks: [{ ...blockEntry(blocklistId), endTime: now() + 1_500 }] });
    await page.waitForTimeout(250);
    await assertRedirect(page, 'natural-expiry redirect');
    await page.waitForTimeout(BACKGROUND_CADENCE_MS);
    await assertRestored(page, 'natural-expiry restore', DEFAULT_TIMEOUT_MS);

    await setPolicy({ activeBlocks: [blockEntry(blocklistId)] });
    await navigateProbe(page);
    await assertRedirect(page, 'stop setup redirect');
    await setPolicy({ activeBlocks: [] });
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await assertRestored(page, 'stop restore');
}

async function testAllowlistPrecedence(page) {
    const allowedProbe = await navigateProbe(page, SYSTEM_TEST_ALLOWED_URL);
    if (allowedProbe !== SYSTEM_TEST_ALLOWED_URL) {
        throw new Error(
            `allowlist fixture failed URL feasibility probe: requested ${SYSTEM_TEST_ALLOWED_URL}, got ${allowedProbe}`,
        );
    }
    const blockedId = id('precedence-block');
    const firstAllowId = id('allow-one');
    const secondAllowId = id('allow-two');
    await setPolicy({
        blocklists: [
            { id: blockedId, name: 'Blocklist', mode: 'blocklist', websites: [SYSTEM_TEST_HOST], apps: [] },
            { id: firstAllowId, name: 'Allow one', mode: 'allowlist', websites: [SYSTEM_TEST_HOST], apps: [] },
            { id: secondAllowId, name: 'Allow two', mode: 'allowlist', websites: [SYSTEM_TEST_ALLOWED_HOST], apps: [] },
        ],
        activeBlocks: [blockEntry(blockedId), blockEntry(firstAllowId), blockEntry(secondAllowId)],
    });
    await navigateProbe(page);
    await assertRedirect(page, 'blocklist precedence over allowlist overlap');

    // Remove the overlapping blocklist. The two concurrent allowlists union;
    // a host not in either list remains blocked by allowlist mode.
    await setPolicy({ activeBlocks: [blockEntry(firstAllowId), blockEntry(secondAllowId)] });
    await navigateProbe(page);
    if (isBlockedUrl(page.url())) throw new Error('allowlist union unexpectedly redirected the first allowed .invalid URL');
    await page.goto(SYSTEM_TEST_ALLOWED_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    if (page.url() !== SYSTEM_TEST_ALLOWED_URL) {
        throw new Error(
            `allowlist union fixture URL was rewritten: requested ${SYSTEM_TEST_ALLOWED_URL}, got ${page.url()}`,
        );
    }
    if (isBlockedUrl(page.url())) throw new Error('allowlist union unexpectedly redirected the allowed .invalid URL');
    await page.goto(SYSTEM_TEST_OUTSIDE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await assertRedirect(page, 'allowlist union blocks outside .invalid URL');
}

async function testRestartCases(page, { restartApp } = {}) {
    if (typeof restartApp !== 'function') return { skipped: true, reason: 'runner did not provide restartApp()' };
    const blocklistId = id('restart-bl');
    await setPolicy({
        blocklists: [{ id: blocklistId, name: 'Restart', mode: 'blocklist', websites: [SYSTEM_TEST_HOST], apps: [] }],
        activeBlocks: [blockEntry(blocklistId)],
    });
    await navigateProbe(page);
    await assertRedirect(page, 'restart active setup');
    await restartApp();
    await page.bringToFront();
    await assertRedirect(page, 'restart active enforcement');

    await setPolicy({ activeBlocks: [blockEntry(blocklistId, { paused: true })] });
    await restartApp();
    await assertRestored(page, 'restart paused restore');

    await setPolicy({ activeBlocks: [] });
    await restartApp();
    await assertRestored(page, 'restart stopped restore');
    return { skipped: false };
}

export async function probeInvalidUrl({ profileDir, port }) {
    const cdpPort = Number(port || process.env.SYSTEM_TEST_BRAVE_PORT || 9333);
    const session = mainBravePids().length > 0
        ? await attachExistingBrave()
        : await launchBrave({ profileDir, port: cdpPort });
    try {
        const page = session.page || await activePage(session.browser);
        const reported = await navigateProbe(page);
        return { requested: SYSTEM_TEST_URL, reported, preserved: reported === SYSTEM_TEST_URL };
    } finally {
        await closeBrave(session);
    }
}

export async function runBraveSystemSuite(options = {}) {
    // `restartApp` is supplied by the app runner so it can stop/relaunch the
    // exact signed-app PID it owns. It should resolve after the app's webview
    // and Automation watcher are ready; omitting it reports restart cases as
    // skipped rather than guessing at an unrelated process.
    // The local runner passes these names explicitly; the environment forms
    // remain useful when this module is run directly from a shell.
    if (options.appPath) process.env.SYSTEM_TEST_APP = options.appPath;
    if (options.dataDir) process.env.SYSTEM_TEST_DATA_DIR = options.dataDir;
    if (options.artifactsDir) process.env.SYSTEM_TEST_ARTIFACTS_DIR = options.artifactsDir;
    const profileDir = options.profileDir || envPath('SYSTEM_TEST_PROFILE_DIR', path.resolve('e2e/system-profile'));
    const port = Number(options.bravePort || options.port || process.env.SYSTEM_TEST_BRAVE_PORT || 9333);
    const session = mainBravePids().length > 0
        ? await attachExistingBrave()
        : await launchBrave({ profileDir, port });
    const page = session.page || await activePage(session.browser);
    const results = [];
    try {
        const probe = await navigateProbe(page);
        if (probe !== SYSTEM_TEST_URL) {
            throw new Error(`URL feasibility probe failed: requested ${SYSTEM_TEST_URL}, got ${probe}`);
        }
        const tests = [['website-lifecycle', testWebsiteLifecycle]];
        if (!session.automation) tests.push(['allowlist-precedence', testAllowlistPrecedence]);
        else results.push({
            name: 'allowlist-precedence',
            skipped: true,
            reason: 'allowlist policy is browser-global and shared Brave contains user tabs',
        });
        for (const [name, test] of tests) {
            try {
                await test(page);
                results.push({ name, passed: true });
            } catch (error) {
                await screenshotOnFailure(page, name, { error: String(error), url: page.url(), data: await readData() });
                throw error;
            }
        }
        try {
            results.push({ name: 'restart-cases', ...(await testRestartCases(page, options)) });
        } catch (error) {
            await screenshotOnFailure(page, 'restart-cases', { error: String(error), url: page.url(), data: await readData() });
            throw error;
        }
        return { results, probe: { requested: SYSTEM_TEST_URL, reported: probe, preserved: true } };
    } finally {
        await clearPolicy().catch(() => {});
        if (session.child?.__systemTestLogs?.length) {
            await mkdir(artifactsDir(), { recursive: true });
            await writeFile(path.join(artifactsDir(), 'brave-stderr.log'), session.child.__systemTestLogs.join(''), 'utf8');
        }
        await closeBrave(session);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const profileDir = envPath('SYSTEM_TEST_PROFILE_DIR', path.resolve('e2e/system-profile'));
    const port = Number(process.env.SYSTEM_TEST_BRAVE_PORT || 9333);
    const result = process.argv.includes('--self-test')
        ? selfTest()
        : process.argv.includes('--probe')
        ? await probeInvalidUrl({ profileDir, port })
        : await runBraveSystemSuite({ profileDir, port });
    console.log(JSON.stringify(result, null, 2));
}
