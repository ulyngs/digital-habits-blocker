/**
 * Safari companion for the Brave system suite.
 *
 * Safari cannot expose CDP or a disposable profile.  We therefore create one
 * uniquely marked tab through AppleScript, address only that tab by its marker,
 * and close only that tab during cleanup. Existing Safari windows and tabs are
 * never closed, quit, or navigated.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import process from 'node:process';
import {
    SYSTEM_TEST_HOST,
    SYSTEM_TEST_URL,
    blockEntry,
    clearPolicy,
    configureSystemTest,
    setPolicy,
} from './brave-system.js';

const DEFAULT_TIMEOUT_MS = 20_000;
const SAFARI_APP = '/Applications/Safari.app';

function artifactsDir() {
    return process.env.SYSTEM_TEST_ARTIFACTS_DIR || pathResolve('e2e/system-artifacts');
}

function pathResolve(relative) {
    return new URL(`../../${relative}`, import.meta.url).pathname;
}

function scriptString(value) {
    return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function runAppleScript(script) {
    try {
        return execFileSync('/usr/bin/osascript', ['-e', script], {
            encoding: 'utf8',
            timeout: DEFAULT_TIMEOUT_MS,
            maxBuffer: 1024 * 1024,
        }).trim();
    } catch (error) {
        const details = String(error.stderr || error.message || error).trim();
        throw new Error(`Safari AppleScript failed: ${details}`, { cause: error });
    }
}

async function recordFailure(label, error, tab) {
    const directory = artifactsDir();
    await mkdir(directory, { recursive: true });
    let url = null;
    try {
        if (tab) url = readTab(tab);
    } catch {
        url = null;
    }
    await writeFile(
        `${directory}/safari-${label}.json`,
        `${JSON.stringify({ error: String(error), url }, null, 2)}\n`,
        'utf8',
    ).catch(() => {});
}

export function safariAvailable() {
    return process.platform === 'darwin' && existsSync(SAFARI_APP);
}

function markerUrl(marker) {
    const separator = SYSTEM_TEST_URL.includes('?') ? '&' : '?';
    return `${SYSTEM_TEST_URL}${separator}system_test_tab=${marker}`;
}

function findMarkedTab(marker) {
    const script = `
set _marker to ${scriptString(marker)}
set _sep to tab
if application "Safari" is not running then return ""
tell application "Safari"
  set _wi to 0
  repeat with _w in windows
    set _wi to _wi + 1
    set _ti to 0
    repeat with _t in tabs of _w
      set _ti to _ti + 1
      try
        if (URL of _t as text) contains _marker then return (_wi as text) & _sep & (_ti as text)
      end try
    end repeat
  end repeat
end tell
return ""
`;
    const value = runAppleScript(script);
    const match = /^(\d+)\s+(\d+)$/.exec(value.replace(/\t/g, ' '));
    return match ? { windowIndex: Number(match[1]), tabIndex: Number(match[2]) } : null;
}

async function openMarkedTab(url, marker) {
    // `make new document` creates a new Safari window/document. It does not
    // reuse or navigate an existing user tab. We locate the tab by marker
    // afterwards because Safari's document IDs are not stable across releases.
    runAppleScript(`
tell application "Safari"
  activate
  make new document with properties {URL:${scriptString(url)}}
end tell
`);
    const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const tab = findMarkedTab(marker);
        if (tab) return tab;
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`Safari test tab marker not found: ${marker}`);
}

function readTab(tab) {
    return runAppleScript(`
tell application "Safari"
  try
    return URL of tab ${tab.tabIndex} of window ${tab.windowIndex} as text
  on error
    return ""
  end try
end tell
`);
}

function closeTab(tab) {
    // Deliberately close only the marked tab's saved coordinates. If a user
    // rearranged windows/tabs, skip cleanup rather than risk another tab.
    const current = findMarkedTab(tab.marker);
    if (!current || current.windowIndex !== tab.windowIndex || current.tabIndex !== tab.tabIndex) return false;
    runAppleScript(`
tell application "Safari"
  try
    close tab ${tab.tabIndex} of window ${tab.windowIndex}
  end try
end tell
`);
    return true;
}

function isBlockedUrl(url) {
    return url.includes('blocked.html') || url.startsWith('file:');
}

async function waitForTab(tab, predicate, label, timeout = DEFAULT_TIMEOUT_MS) {
    const deadline = Date.now() + timeout;
    let current = '';
    while (Date.now() < deadline) {
        current = readTab(tab);
        if (predicate(current)) return current;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Safari ${label} timed out; last URL: ${current}`);
}

export async function runSafariSystemSuite(options = {}) {
    configureSystemTest(options);
    if (!safariAvailable()) return { browser: 'safari', skipped: true, reason: 'Safari.app not installed' };

    const marker = `reddblock_system_${Date.now()}`;
    const targetUrl = markerUrl(marker);
    let tab;
    const blocklistId = `system-test-safari-${Date.now()}`;
    try {
        tab = await openMarkedTab(targetUrl, marker);
        tab.marker = marker;
        await setPolicy({
            blocklists: [{ id: blocklistId, name: 'Safari system test', mode: 'blocklist', websites: [SYSTEM_TEST_HOST], apps: [] }],
            activeBlocks: [blockEntry(blocklistId)],
        });
        const blocked = await waitForTab(tab, isBlockedUrl, 'block redirect');
        if (!blocked.includes(marker)) throw new Error(`Safari block page lost owned-tab marker: ${blocked}`);

        await setPolicy({ activeBlocks: [blockEntry(blocklistId, { paused: true })] });
        await waitForTab(tab, (url) => url === targetUrl, 'pause restore');

        await setPolicy({ activeBlocks: [blockEntry(blocklistId)] });
        await waitForTab(tab, isBlockedUrl, 'resume redirect');

        await setPolicy({ activeBlocks: [{ ...blockEntry(blocklistId), endTime: Date.now() + 1_500 }] });
        await waitForTab(tab, isBlockedUrl, 'natural-expiry setup');
        await waitForTab(tab, (url) => url === targetUrl, 'natural-expiry restore', 12_000);

        await setPolicy({ activeBlocks: [blockEntry(blocklistId)] });
        await waitForTab(tab, isBlockedUrl, 'stop setup');
        await setPolicy({ activeBlocks: [] });
        await waitForTab(tab, (url) => url === targetUrl, 'stop restore');
        return {
            browser: 'safari',
            skipped: false,
            tested: true,
            results: ['block-redirect', 'pause', 'resume', 'natural-expiry', 'stop'].map((name) => ({ name, passed: true })),
        };
    } catch (error) {
        await recordFailure('suite', error, tab);
        throw error;
    } finally {
        await clearPolicy().catch(() => {});
        if (tab) closeTab(tab);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    runSafariSystemSuite({
        dataDir: process.env.SYSTEM_TEST_DATA_DIR,
        artifactsDir: process.env.SYSTEM_TEST_ARTIFACTS_DIR,
    }).then((result) => console.log(JSON.stringify(result, null, 2)));
}
