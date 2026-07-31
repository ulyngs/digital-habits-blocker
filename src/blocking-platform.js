// Blocking platform: app-blocking "Let's go!" warning, Android/iOS blocking
// init, friction gate, warning-overlay coordinator, window sizing, handset
// modal screens, platform detection. Extracted verbatim from app.js.
import { state, appState } from './state.js';
import { Channel } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import snoozeIconUrl from './images/snooze.png';
import { tauriAPI, openUrl } from './tauri-api.js';
import { escapeHtml } from './utils.js';
import { tSettings, tSettingsFmt } from './i18n.js';
import { isProtectedApp, ALWAYS_ON_END_TIME } from './blocklist-utils.js';
import { isSchedulePausedNow, refreshDesktopHelperStatus, scheduleHasFutureSingleOccurrence, syncSchedulesToHelper } from './schedule-engine.js';
import { saveData, updateHostsFile, createDefaultBlocklist } from './persistence.js';
import { render } from './render.js';
import { renderBlocklists } from './blocklists.js';
import { canEditScheduleBetweenBlocks, isScheduleSegmentActiveNow } from './schedule-editor.js';
import { applyScheduleStartOverlayPresentation, getScheduleStartOverlayForWarningApps, playAppBlockingLetsGoVoice } from './schedule-overlay.js';
import { closeBlocklistModal, closeOverrideModal, closePauseModal, closeScheduleConfirmModal, closeStartBlockConfirmModal, initializeOverrideModalChallenge, openPauseModal, populateOverrideConfirmModalContent } from './confirm-modals.js';
import { isModalVisible } from './modal-manager.js';
import { updateManageSectionVisibility } from './settings.js';
import { CURRENT_EULA_REVISION, getAcceptedEulaRevision, hasAcceptedEula, isFirstRunOnboardingInProgress } from './onboarding.js';
import { generateId, runPostAcceptanceStartup } from './app.js';

// Update blocked apps sent to the in-process app watcher (desktop only).
// Computes the effective union of apps from active one-off blocks AND active schedule
// segments. Both sources are evaluated on the frontend now that the legacy helper
// daemon (which previously merged schedule + manual apps internally) is gone.
/// Set of app names that were in the blocked set at the LAST
/// `updateBlockedApps` call. Used to compute which apps just
/// transitioned to blocking ("newly added") so the watcher can
/// distinguish "block just starting → raise Let's-go warning" from
/// "user launched a blocked app while a block was already running →
/// silent SIGTERM". `null` until the first call so the very first
/// sync (typically right after app launch, when blocks may already
/// be active from a prior session) doesn't fire warnings — we treat
/// that initial state as "what was already running before we got
/// here", not as a transition the user just initiated.
let appBlockingPreviousAppsSet = null;

export async function updateBlockedApps() {
    // iOS uses Screen Time API for app blocking
    if (state.isIOS) return;
    // Android: app blocking is embedded in the schedule sync itself
    // (blockedApps on each Kotlin Schedule), not a separate helper-daemon
    // push — see syncSchedulesToHelper.
    if (state.isAndroid) return;

    const now = Date.now();
    const nowDate = new Date(now);
    const manualApps = collectManualBlockedApps(now);
    const scheduleApps = collectScheduleBlockedApps(now);
    const allBlockedApps = new Set([...manualApps, ...scheduleApps]);
    const appsArray = Array.from(allBlockedApps).sort();

    const prevAll = appBlockingPreviousAppsSet;
    const prevManual = appBlockingPreviousManualAppsSet ?? new Set();
    const prevSchedule = appBlockingPreviousScheduleAppsSet ?? new Set();

    // Compute the diff against the last sync so the watcher knows
    // which apps just transitioned to blocked (warning-eligible) vs
    // which were already blocked (silent enforcement). On the very
    // first call the previous sets are null — we treat that as
    // "initial state, no transitions" and skip warnings entirely.
    const newlyAddedApps = prevAll === null
        ? []
        : appsArray.filter((a) => !prevAll.has(a));
    if (newlyAddedApps.length > 0) {
        noteAppBlockingNewlyAddedMeta(
            newlyAddedApps,
            manualApps,
            scheduleApps,
            prevManual,
            prevSchedule,
            now,
            nowDate,
        );
        appBlockingWarningSnoozeUsed = false;
        clearAppBlockingWarningSnoozeTimer();
        appBlockingWarningSnoozedUntilMs = 0;
    }
    appBlockingPreviousAppsSet = new Set(appsArray);
    appBlockingPreviousManualAppsSet = new Set(manualApps);
    appBlockingPreviousScheduleAppsSet = new Set(scheduleApps);

    // Desktop v3: `set_blocked_apps_via_helper` routes to the in-process
    // app watcher — always push while the app is alive. The legacy
    // helper-daemon gate left schedule app blocking as a no-op whenever
    // `state.helperAvailable` was still false at the first tick.
    try {
        const result = await tauriAPI.setBlockedAppsViaHelper(appsArray, newlyAddedApps);
        if (result && result.success) {
            console.log(
                '[updateBlockedApps] Apps synced to watcher:',
                appsArray.length, 'apps,', newlyAddedApps.length, 'newly added',
            );
        } else {
            console.warn('[updateBlockedApps] Watcher sync failed:', result?.error);
        }
    } catch (e) {
        console.warn('[updateBlockedApps] Failed to sync blocked apps to watcher:', e);
    }
}

// ---- App-blocking: "Let's go!" warning (driven by native watcher) ---------
//
// Two pieces of UI:
//   1. The full-screen always-on-top overlay (raised by the native watcher
//      when a blocked PID first appears; rendered out of `appBlockingWarningRows`
//      entries that have NO `ackedDeadlineMs`).
//   2. The in-app countdown banner (shown after the user clicks "Let's go!";
//      driven by entries that have an `ackedDeadlineMs` set).
//
// Per-row ack metadata so the overlay and banner can coexist sensibly
// when a new blocked app gets launched mid-countdown — the new PID
// shows in the overlay while the previously-acked PIDs continue
// counting down in the banner.

/** @type {Map<number, { name: string, ackedDeadlineMs?: number }>} */
export const appBlockingWarningRows = new Map();
let appBlockingWarningUiAttached = false;
let appBlockingClosedownTickInterval = null;

/// 30 seconds of wrap-up time after the user clicks "Let's go!" before
/// the watcher sends the polite Cmd-Q. Mirrors `PREQUIT_DURATION` in
/// `app_watcher.rs`. Kept in JS too so the banner can show the right
/// countdown without a server round-trip.
export const APP_BLOCKING_CLOSEDOWN_PREQUIT_MS = 30 * 1000;
/// Schedule-block warnings may be snoozed once for this long before the
/// overlay reappears (without the snooze button on the second show).
export const APP_BLOCKING_SCHEDULE_SNOOZE_MS = 2 * 60 * 1000;

export function buildAppBlockingSnoozeIconImg(size) {
    return `<img src="${snoozeIconUrl}" alt="" class="app-blocking-snooze-icon" width="${size}" height="${size}" aria-hidden="true">`;
}

export const APP_BLOCKING_SNOOZE_ICON_IMG_12 = buildAppBlockingSnoozeIconImg(12);

/** `'schedule'` | `'manual'` | null — set when apps newly enter the blocked set. */
let appBlockingWarningSnoozeUsed = false;
export let appBlockingWarningSnoozedUntilMs = 0;
let appBlockingWarningSnoozeTimer = null;
let appBlockingSnoozedBlocklistId = null;
let appBlockingSnoozeCardTickInterval = null;
let appBlockingPreviousManualAppsSet = null;
let appBlockingPreviousScheduleAppsSet = null;
/** Per-app attribution for the block that just started blocking it. */
/** @type {Map<string, { blocklistId: string, source: 'schedule'|'manual' }>} */
export const appBlockingNewlyAddedMeta = new Map();

export function clearAppBlockingWarningSnoozeTimer() {
    if (appBlockingWarningSnoozeTimer !== null) {
        window.clearTimeout(appBlockingWarningSnoozeTimer);
        appBlockingWarningSnoozeTimer = null;
    }
}

export function stopAppBlockingSnoozeCardTick() {
    if (appBlockingSnoozeCardTickInterval !== null) {
        window.clearInterval(appBlockingSnoozeCardTickInterval);
        appBlockingSnoozeCardTickInterval = null;
    }
}

export function ensureAppBlockingSnoozeCardTick() {
    if (appBlockingSnoozeCardTickInterval !== null) return;
    appBlockingSnoozeCardTickInterval = window.setInterval(() => {
        if (appBlockingWarningSnoozedUntilMs <= Date.now()) {
            stopAppBlockingSnoozeCardTick();
            return;
        }
        if (typeof renderBlocklists === 'function') renderBlocklists();
    }, 1000);
}

export function getActiveAppBlockingSnoozeBlocklistId(now = Date.now()) {
    if (appBlockingWarningSnoozedUntilMs <= now) return null;
    return appBlockingSnoozedBlocklistId;
}

export function resolveSnoozedBlocklistIdFromWarning() {
    const unknownApp = tSettings('appBlockingUnknownApp');
    const rawNames = [];
    for (const [, row] of appBlockingWarningRows) {
        if (row.ackedDeadlineMs) continue;
        const n = (row.name || unknownApp).trim() || unknownApp;
        rawNames.push(n);
    }
    const names = uniqueBlockedAppDisplayNames(rawNames);
    if (names.length === 0) return null;
    return findResponsibleBlocklistForWarningApps(names)?.id ?? null;
}

export function formatAppBlockingSnoozeStartsIn(remainingMs) {
    const mins = Math.max(1, Math.ceil(remainingMs / 60000));
    if (mins < 60) {
        return tSettingsFmt('blocklistScheduleStartsInMinutesFmt', { n: String(mins) });
    }
    const hrs = Math.floor(mins / 60);
    const remMins = mins % 60;
    if (hrs < 24) {
        if (remMins > 0) {
            return tSettingsFmt('blocklistScheduleStartsInHoursFmt', { n: String(hrs) })
                + ` ${remMins}m`;
        }
        return tSettingsFmt('blocklistScheduleStartsInHoursFmt', { n: String(hrs) });
    }
    return tSettingsFmt('blocklistScheduleStartsInDaysFmt', {
        n: String(Math.floor(mins / (24 * 60))),
    });
}

export function resetAppBlockingWarningSnoozeState() {
    clearAppBlockingWarningSnoozeTimer();
    stopAppBlockingSnoozeCardTick();
    appBlockingWarningSnoozedUntilMs = 0;
    appBlockingWarningSnoozeUsed = false;
    appBlockingSnoozedBlocklistId = null;
    appBlockingNewlyAddedMeta.clear();
    if (typeof renderBlocklists === 'function') renderBlocklists();
}

export function collectManualBlockedApps(now = Date.now()) {
    const set = new Set();
    for (const block of state.appData.activeBlocks || []) {
        if (block.startTime > now || block.endTime <= now || block.isPaused) continue;
        const blocklist = state.appData.blocklists.find((bl) => bl.id === block.blocklistId);
        for (const app of blocklist?.apps || []) {
            if (!isProtectedApp(app)) set.add(app);
        }
    }
    return set;
}

export function collectScheduleBlockedApps(now = Date.now()) {
    const set = new Set();
    const nowDate = new Date(now);
    for (const schedule of state.appData.schedules || []) {
        if (!schedule.segments) continue;
        if (isSchedulePausedNow(schedule, now)) continue;
        if (!isScheduleSegmentActiveNow(schedule, nowDate)) continue;
        const blocklist = state.appData.blocklists.find((bl) => bl.id === schedule.blocklistId);
        for (const app of blocklist?.apps || []) {
            if (!isProtectedApp(app)) set.add(app);
        }
    }
    return set;
}

export function findManualBlocklistIdForApp(appName, now = Date.now()) {
    const target = String(appName || '').trim().toLowerCase();
    if (!target) return null;
    for (const block of state.appData.activeBlocks || []) {
        if (block.startTime > now || block.endTime <= now || block.isPaused) continue;
        const blocklist = state.appData.blocklists.find((bl) => bl.id === block.blocklistId);
        if (blocklist?.apps?.some((a) => String(a).trim().toLowerCase() === target)) {
            return blocklist.id;
        }
    }
    return null;
}

export function findScheduleBlocklistIdForApp(appName, now = Date.now(), nowDate = new Date(now)) {
    const target = String(appName || '').trim().toLowerCase();
    if (!target) return null;
    for (const schedule of state.appData.schedules || []) {
        if (!schedule.segments) continue;
        if (isSchedulePausedNow(schedule, now)) continue;
        if (!isScheduleSegmentActiveNow(schedule, nowDate)) continue;
        const blocklist = state.appData.blocklists.find((bl) => bl.id === schedule.blocklistId);
        if (blocklist?.apps?.some((a) => String(a).trim().toLowerCase() === target)) {
            return blocklist.id;
        }
    }
    return null;
}

export function noteAppBlockingNewlyAddedMeta(
    newlyAddedApps,
    manualApps,
    scheduleApps,
    prevManual,
    prevSchedule,
    now,
    nowDate,
) {
    appBlockingNewlyAddedMeta.clear();
    for (const app of newlyAddedApps) {
        const newFromManual = !prevManual.has(app) && manualApps.has(app);
        const newFromSchedule = !prevSchedule.has(app) && scheduleApps.has(app);
        if (newFromSchedule && !newFromManual) {
            const blocklistId = findScheduleBlocklistIdForApp(app, now, nowDate);
            if (blocklistId) appBlockingNewlyAddedMeta.set(app, { blocklistId, source: 'schedule' });
        } else if (newFromManual) {
            const blocklistId = findManualBlocklistIdForApp(app, now);
            if (blocklistId) appBlockingNewlyAddedMeta.set(app, { blocklistId, source: 'manual' });
        } else if (newFromSchedule) {
            const blocklistId = findManualBlocklistIdForApp(app, now)
                ?? findScheduleBlocklistIdForApp(app, now, nowDate);
            if (blocklistId) appBlockingNewlyAddedMeta.set(app, { blocklistId, source: 'manual' });
        }
    }
}

/** True when the current warning is from a schedule block (not a manual one-off). */
export function isAppBlockingWarningScheduleEligible(appNames) {
    return appNames.some((appName) => {
        const meta = appBlockingNewlyAddedMeta.get(appName);
        if (meta) return meta.source === 'schedule';
        if (findManualBlocklistIdForApp(appName)) return false;
        return !!findScheduleBlocklistIdForApp(appName);
    });
}

export function onAppBlockingSnoozeExpired() {
    appBlockingWarningSnoozeTimer = null;
    appBlockingWarningSnoozedUntilMs = 0;
    appBlockingSnoozedBlocklistId = null;
    stopAppBlockingSnoozeCardTick();
    if (typeof renderBlocklists === 'function') renderBlocklists();

    const unackedPids = [...appBlockingWarningRows.entries()]
        .filter(([, row]) => !row.ackedDeadlineMs)
        .map(([pid]) => pid);
    if (unackedPids.length === 0) return;

    renderAppBlockingWarningOverlay();
    tauriAPI
        .reshowBlockingWarning(unackedPids)
        .catch((e) => console.warn('[app-blocking-ui] snooze re-show:', e));
}

export function setupAppBlockingWarningOverlay() {
    if (state.isIOS || state.isAndroid || appBlockingWarningUiAttached) return;
    appBlockingWarningUiAttached = true;

    const snoozeIconEl = document.querySelector('#app-blocking-snooze-btn .app-blocking-snooze-icon');
    if (snoozeIconEl) snoozeIconEl.src = snoozeIconUrl;

    // Resolve friendly app names (e.g. "Microsoft Edge") when the warning UI needs them.
    void ensureInstalledAppsCache().then(() => {
        if (appBlockingWarningRows.size > 0) {
            renderAppBlockingWarningOverlay();
            renderAppBlockingClosedownBanner();
        }
        if (typeof renderBlocklists === 'function' && state.appData?.blocklists?.length) {
            renderBlocklists();
        }
    });

    const onFail = (label) => (e) => {
        console.warn(`[app-blocking-ui] failed to attach ${label}:`, e);
        appBlockingWarningUiAttached = false;
    };

    // The new flow has just two events: warning-show (user-ack required)
    // and warning-hide (the PID exited or got SIGKILLed). The old
    // warning-update countdown stream is gone — there's no number to tick.
    tauriAPI.onAppBlockingWarningShow((event) => {
        const p = event?.payload || {};
        const pid = Number(p.pid);
        if (!Number.isFinite(pid)) return;
        appBlockingWarningRows.set(pid, {
            name: p.name || 'App',
        });
        renderAppBlockingWarningOverlay();
        renderAppBlockingClosedownBanner();
    }).catch(onFail('warning-show'));

    tauriAPI.onAppBlockingWarningHide((event) => {
        const p = event?.payload || {};
        const pid = Number(p.pid);
        if (!Number.isFinite(pid)) return;
        appBlockingWarningRows.delete(pid);
        if (appBlockingWarningRows.size === 0) {
            resetAppBlockingWarningSnoozeState();
        }
        renderAppBlockingWarningOverlay();
        renderAppBlockingClosedownBanner();
    }).catch(onFail('warning-hide'));

    const snoozeBtn = document.getElementById('app-blocking-snooze-btn');
    snoozeBtn?.addEventListener('click', () => {
        appBlockingWarningSnoozeUsed = true;
        appBlockingWarningSnoozedUntilMs = Date.now() + APP_BLOCKING_SCHEDULE_SNOOZE_MS;
        appBlockingSnoozedBlocklistId = resolveSnoozedBlocklistIdFromWarning();
        applyWarningOverlayPresence();
        clearAppBlockingWarningSnoozeTimer();
        ensureAppBlockingSnoozeCardTick();
        if (typeof renderBlocklists === 'function') renderBlocklists();
        appBlockingWarningSnoozeTimer = window.setTimeout(
            onAppBlockingSnoozeExpired,
            APP_BLOCKING_SCHEDULE_SNOOZE_MS,
        );
        tauriAPI
            .snoozeBlockingWarning()
            .catch((e) => console.warn('[app-blocking-ui] snooze:', e));
    });

    // "Let's go!" button — ack every currently-awaiting row, hide the
    // full-screen overlay immediately, and surface the in-app close-down
    // countdown banner. The watcher's AwaitingUserAck → PreQuit
    // transition happens server-side via `letsGoAcknowledge`; we just
    // mirror that timeline in the UI so the user sees how long they
    // have to wrap up.
    const letsGoBtn = document.getElementById('app-blocking-lets-go-btn');
    letsGoBtn?.addEventListener('click', () => {
        resetAppBlockingWarningSnoozeState();
        void playAppBlockingLetsGoVoice();
        const ackedDeadlineMs = Date.now() + APP_BLOCKING_CLOSEDOWN_PREQUIT_MS;
        for (const row of appBlockingWarningRows.values()) {
            if (!row.ackedDeadlineMs) row.ackedDeadlineMs = ackedDeadlineMs;
        }
        applyWarningOverlayPresence();
        renderAppBlockingClosedownBanner();
        tauriAPI
            .letsGoAcknowledge()
            .catch((e) => console.warn('[app-blocking-ui] lets-go ack:', e));
    });

    void reconcileBlockingWarningShell();
}

/** Find a blocklist that currently enforces blocking for `appName`
 *  (active schedule segment or one-off), preferring schedules. */
export function findActiveBlocklistForBlockedAppName(appName) {
    if (!appName) return null;
    const target = String(appName).trim().toLowerCase();
    if (!target) return null;
    const now = Date.now();
    const nowDate = new Date(now);

    for (const schedule of state.appData.schedules || []) {
        if (!schedule.segments) continue;
        if (isSchedulePausedNow(schedule, now)) continue;
        if (!isScheduleSegmentActiveNow(schedule, nowDate)) continue;
        const blocklist = state.appData.blocklists.find((bl) => bl.id === schedule.blocklistId);
        if (blocklist?.apps?.some((a) => String(a).trim().toLowerCase() === target)) {
            return blocklist;
        }
    }

    for (const block of state.appData.activeBlocks || []) {
        if (block.startTime > now || block.endTime <= now || block.isPaused) continue;
        const blocklist = state.appData.blocklists.find((bl) => bl.id === block.blocklistId);
        if (blocklist?.apps?.some((a) => String(a).trim().toLowerCase() === target)) {
            return blocklist;
        }
    }

    return null;
}

/** Pick the blocklist to show in the warning overlay for the given apps. */
export function findResponsibleBlocklistForWarningApps(appNames) {
    for (const appName of appNames) {
        const meta = appBlockingNewlyAddedMeta.get(appName);
        if (meta?.blocklistId) {
            const blocklist = state.appData.blocklists.find((bl) => bl.id === meta.blocklistId);
            if (blocklist) return blocklist;
        }
    }
    for (const appName of appNames) {
        const blocklist = findActiveBlocklistForBlockedAppName(appName);
        if (blocklist) return blocklist;
    }
    for (const appName of appNames) {
        const blocklist = findBlocklistForBlockedAppName(appName);
        if (blocklist) return blocklist;
    }
    return null;
}

/** Find any blocklist that lists `appName` (case-insensitive). Last-resort
 *  fallback when no active enforcement source can be determined. */
export function findBlocklistForBlockedAppName(appName) {
    if (!appName) return null;
    const target = String(appName).trim().toLowerCase();
    if (!target) return null;
    const blocklists = state.appData?.blocklists || [];
    for (const bl of blocklists) {
        const apps = bl.apps || [];
        if (apps.some((a) => String(a).trim().toLowerCase() === target)) {
            return bl;
        }
    }
    return null;
}

export function renderAppBlockingWarningOverlay() {
    const overlay = document.getElementById('app-blocking-warning-overlay');
    if (!overlay) return;

    if (appBlockingWarningRows.size === 0) {
        state.appBlockingActiveStartOverlay = null;
        applyWarningOverlayPresence();
        return;
    }

    const unknownApp = tSettings('appBlockingUnknownApp');
    const rawNames = [];
    for (const [, row] of appBlockingWarningRows) {
        if (row.ackedDeadlineMs) continue;
        const n = (row.name || unknownApp).trim() || unknownApp;
        rawNames.push(n);
    }
    const names = uniqueBlockedAppDisplayNames(rawNames);
    if (names.length === 0) {
        state.appBlockingActiveStartOverlay = null;
        applyWarningOverlayPresence();
        return;
    }

    const responsibleBlocklist = findResponsibleBlocklistForWarningApps(names);
    const blocklistName = responsibleBlocklist?.name || tSettings('appBlockingFallbackBlocklistName');
    const blocklistEmoji = responsibleBlocklist?.emoji || '🎯';
    const startOverlay = getScheduleStartOverlayForWarningApps(names);

    const headingEl = document.getElementById('app-blocking-warning-heading');
    const summaryEl = document.getElementById('app-blocking-warning-summary');
    const emojiWrapEl = document.getElementById('app-blocking-warning-emoji-wrap');
    const emojiEl = document.getElementById('app-blocking-warning-emoji');
    const imageEl = document.getElementById('app-blocking-warning-image');
    const letsGoBtn = document.getElementById('app-blocking-lets-go-btn');
    const letsGoLabelEl = document.getElementById('app-blocking-lets-go-btn-label');
    const letsGoVoiceIconEl = document.getElementById('app-blocking-lets-go-voice-icon');
    const snoozeBtn = document.getElementById('app-blocking-snooze-btn');

    letsGoBtn?.removeAttribute('disabled');

    const showSnooze = isAppBlockingWarningScheduleEligible(names)
        && !appBlockingWarningSnoozeUsed
        && appBlockingWarningSnoozedUntilMs <= Date.now();
    snoozeBtn?.classList.toggle('hidden', !showSnooze);

    // Native code enters full-screen warning mode before this handler runs.
    // Show the overlay immediately so the window is never a blank white shell
    // while custom overlay assets load.
    applyWarningOverlayPresence();

    void applyScheduleStartOverlayPresentation({
        overlay: startOverlay,
        blocklistName,
        blocklistEmoji,
        appNames: names,
        headingEl,
        summaryEl,
        emojiWrapEl,
        emojiEl,
        imageEl,
        letsGoLabelEl,
        letsGoVoiceIconEl,
    }).then((activeOverlay) => {
        state.appBlockingActiveStartOverlay = activeOverlay;
        applyWarningOverlayPresence();
    }).catch((err) => {
        console.warn('[schedule-overlay] warning presentation failed:', err);
        applyWarningOverlayPresence();
    });
}

// ---- Warning-overlay coordinator -----------------------------------------
//
// Reconciles the always-on-top compact-window panel mode with the only
// warning surface we now have — the app-blocking "Let's go!" warning.
// The native watcher's `blocking_warning_begin/end` already manages the
// panel-mode refcount in Rust (see `emit_warning_show/_hide`), so this
// function is purely DOM-side: overlay visibility, body class for the
// compact-mode CSS, and resize-observer setup.
export function applyWarningOverlayPresence() {
    if (state.isIOS || state.isAndroid) return;
    const overlay = document.getElementById('app-blocking-warning-overlay');
    if (!overlay) return;

    // Show the overlay only for rows the user hasn't yet acknowledged
    // — once they've clicked "Let's go!" the row gets an
    // `ackedDeadlineMs` and migrates from the overlay to the banner.
    // Also hide while a schedule snooze is active.
    const hasUnackedRows = [...appBlockingWarningRows.values()]
        .some((row) => !row.ackedDeadlineMs);
    const isSnoozed = appBlockingWarningSnoozedUntilMs > Date.now();

    overlay.classList.toggle('hidden', !hasUnackedRows || isSnoozed);
    const inWarningMode = hasUnackedRows && !isSnoozed;
    document.documentElement.classList.toggle('app-blocking-warning-window-mode', inWarningMode);
    document.body.classList.toggle('app-blocking-warning-window-mode', inWarningMode);

    if (!inWarningMode) {
        void restoreBlockingWarningShellIfIdle();
    }
}

export function restoreBlockingWarningShellIfIdle() {
    if (state.isIOS || state.isAndroid) return Promise.resolve();
    return tauriAPI.reconcileBlockingWarningShell().catch(() => {});
}

export async function reconcileBlockingWarningShell() {
    if (state.isIOS || state.isAndroid) return;
    applyWarningOverlayPresence();
}

/// Render the in-app close-down countdown banner. Idempotent — call
/// whenever rows change or the timer ticks. Shows the soonest deadline
/// across acked rows so the countdown reads honestly.
export function renderAppBlockingClosedownBanner() {
    const banner = document.getElementById('app-blocking-closedown-banner');
    const text = document.getElementById('app-blocking-closedown-banner-text');
    if (!banner || !text) return;

    const acked = [...appBlockingWarningRows.values()].filter(
        (row) => typeof row.ackedDeadlineMs === 'number',
    );
    if (acked.length === 0) {
        banner.classList.add('hidden');
        stopAppBlockingClosedownTick();
        return;
    }

    const appFallback = tSettings('appBlockingBannerAppFallback');
    const rawNames = acked.map((r) => (r.name || appFallback).trim() || appFallback);
    const names = uniqueBlockedAppDisplayNames(rawNames);
    const appsHtml = joinAppListWithLimit(names, 3);
    const soonestDeadline = Math.min(...acked.map((r) => r.ackedDeadlineMs));
    const remainingMs = Math.max(0, soonestDeadline - Date.now());
    const remainingSecs = Math.ceil(remainingMs / 1000);

    if (remainingSecs > 0) {
        text.innerHTML = tSettingsFmt('appBlockingClosedownCountdownHtml', {
            apps: appsHtml,
            seconds: String(remainingSecs),
        });
    } else {
        // PreQuit elapsed — Rust is now sending Cmd-Q and waiting on
        // the 10s SIGKILL grace. Banner stays up until the watcher's
        // warning-hide event clears the row.
        const finalKey = names.length === 1
            ? 'appBlockingClosedownFinalSingleHtml'
            : 'appBlockingClosedownFinalMultiHtml';
        text.innerHTML = tSettingsFmt(finalKey, { apps: appsHtml });
    }

    banner.classList.remove('hidden');
    ensureAppBlockingClosedownTick();
}

export function ensureAppBlockingClosedownTick() {
    if (appBlockingClosedownTickInterval !== null) return;
    appBlockingClosedownTickInterval = window.setInterval(() => {
        renderAppBlockingClosedownBanner();
    }, 1000);
}

export function stopAppBlockingClosedownTick() {
    if (appBlockingClosedownTickInterval !== null) {
        window.clearInterval(appBlockingClosedownTickInterval);
        appBlockingClosedownTickInterval = null;
    }
}

export function normalizeBlockedAppKey(name) {
    return String(name || '').trim().replace(/\.exe$/i, '').toLowerCase();
}

export function displayNameForBlockedApp(processName) {
    const key = normalizeBlockedAppKey(processName);
    if (!key) return processName;
    const match = (state.installedAppsCache || []).find(
        (a) => normalizeBlockedAppKey(a.process_name) === key,
    );
    if (match?.display_name) return match.display_name;

    // Unknown app (not installed / not in the cache). Package-style ids
    // (Android, e.g. app.vanadium.browser) read worse when title-cased, so
    // leave them as-is; only prettify bare desktop process names ("chrome").
    if (key.includes('.')) return key;
    return key.charAt(0).toUpperCase() + key.slice(1);
}

let installedAppsCachePromise = null;

/**
 * Populate display names without putting PackageManager's launcher scan on the
 * startup path. Android reads its persisted cache by default; callers opening
 * the app picker pass `refresh: true` to intentionally rescan and replace it.
 */
export async function ensureInstalledAppsCache({ refresh = false } = {}) {
    if (state.installedAppsCache && !refresh) return;
    if (state.isIOS) return;
    if (installedAppsCachePromise) return installedAppsCachePromise;

    installedAppsCachePromise = (async () => {
        try {
            if (state.isAndroid) {
                const result = refresh
                    ? await tauriAPI.androidRefreshInstalledApps()
                    : await tauriAPI.androidGetCachedInstalledApps();
                const apps = result?.apps || [];
                if (apps.length > 0) {
                    state.installedAppsCache = apps.map((app) => ({
                        display_name: app.label || app.packageName,
                        process_name: app.packageName,
                    }))
                        .filter((app) => app.process_name)
                        .sort((a, b) => a.display_name.localeCompare(b.display_name));
                }
            } else {
                state.installedAppsCache = await tauriAPI.listInstalledApps();
            }
        } catch (e) {
            console.warn('[installed-apps] Failed to load installed apps cache:', e);
        } finally {
            installedAppsCachePromise = null;
        }
    })();
    return installedAppsCachePromise;
}

/** One entry per blocked app — Edge's many PIDs collapse to a single name. */
export function uniqueBlockedAppDisplayNames(names) {
    const seen = new Set();
    const out = [];
    for (const name of names) {
        const key = normalizeBlockedAppKey(name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(displayNameForBlockedApp(name));
    }
    return out;
}

/** Pretty list join: "A", "A and B", "A, B and C", "A, B and 4 more". */
export function joinAppListWithLimit(names, max = 3, { bold = true } = {}) {
    const arr = names.filter(Boolean);
    const wrap = bold
        ? (n) => `<strong>${escapeHtml(n)}</strong>`
        : (n) => escapeHtml(n);
    if (arr.length === 0) return '';
    if (arr.length === 1) return wrap(arr[0]);
    const and = tSettings('andWord');
    if (arr.length <= max) {
        const head = arr.slice(0, -1).map(wrap).join(', ');
        const tail = wrap(arr[arr.length - 1]);
        return `${head} ${and} ${tail}`;
    }
    const shown = arr.slice(0, max - 1).map(wrap).join(', ');
    const remaining = arr.length - (max - 1);
    const moreLabel = tSettingsFmt('appBlockingListMoreFmt', { n: String(remaining) });
    return `${shown} ${and} ${wrap(moreLabel)}`;
}

// Check if the helper daemon is available (desktop only)
export async function checkHelperStatus() {
    if (state.isIOS || state.isAndroid) return; // Mobile uses platform blockers, not helper daemon.
    const status = await refreshDesktopHelperStatus();
    console.log('Helper status:', status);

    if (status.running && !status.version_ok) {
        console.log('Helper is outdated (version:', status.version, ') - will prompt to update on first block');
    } else if (!status.installed) {
        console.log('Helper not installed - will prompt on first block');
    }

}


/// True if a failed install-helper result looks like the user cancelled the UAC / admin prompt
/// rather than an actual failure. Backend returns messages prefixed with "cancelled:" for this.
export function isHelperInstallCancelled(errorMsg) {
    if (!errorMsg || typeof errorMsg !== 'string') return false;
    return errorMsg.startsWith('cancelled:') || errorMsg.toLowerCase().includes('cancelled');
}

/** True if the error indicates the helper daemon is not reachable (e.g. connection refused on Windows). */
export function isHelperConnectionError(errorMsg) {
    if (!errorMsg || typeof errorMsg !== 'string') return false;
    return errorMsg.includes('Failed to connect to helper') || errorMsg.includes('refused') || errorMsg.includes('10061');
}


// Check Screen Time authorization (iOS only)
export async function checkScreentimeAuth() {
    try {
        const result = await tauriAPI.screentimeCheckAuth();
        state.screentimeAuthorized = result.granted;
        console.log('Screen Time auth status:', result.status);
        if (!state.screentimeAuthorized) {
            console.log('Screen Time not authorized - will prompt on first block');
        }
    } catch (err) {
        console.error('Error checking Screen Time auth:', err);
        state.screentimeAuthorized = false;
    }
    updateOnboardingVisibility();
}

// Request Screen Time authorization (iOS only)
export async function requestScreentimeAuth() {
    try {
        const result = await tauriAPI.screentimeRequestAuth();
        state.screentimeAuthorized = result.granted;
        console.log('Screen Time auth result:', result);
        return result;
    } catch (err) {
        console.error('Error requesting Screen Time auth:', err);
        state.screentimeAuthorized = false;
        return { granted: false, status: 'error', error: err.toString() };
    }
}

// Check Accessibility permission (Android only). Called on startup and
// again on `visibilitychange` while the onboarding gate is showing,
// since the user grants Accessibility in a separate system settings
// screen and there's no callback for "user came back".
export async function checkAndroidPermissions() {
    try {
        const result = await tauriAPI.androidCheckPermissions();
        state.androidPermissionsGranted = !!result.accessibilityEnabled;
        console.log('Android permissions:', result);
    } catch (err) {
        console.error('Error checking Android permissions:', err);
        state.androidPermissionsGranted = false;
    }
    updateOnboardingVisibility();
}

export async function initializeAndroidBlockingState() {
    await migrateAndroidNativeSchedules();
    // Adopt pauses granted by the native activity before syncing, otherwise
    // stale JS state would immediately overwrite Kotlin's pause.
    await reconcileAndroidNativePauses();
    await syncSchedulesToHelper();

    // Display-name hydration is cosmetic. Read the persisted cache only after
    // enforcement state is reconciled; PackageManager is never scanned here.
    void ensureInstalledAppsCache().then(() => {
        if (state.installedAppsCache) render();
    });
}

/** Adopt still-active pauses granted by the native Android pause activity. */
export async function reconcileAndroidNativePauses() {
    let states;
    try {
        ({ states } = await tauriAPI.androidGetScheduleStates());
    } catch (e) {
        console.warn('[reconcileAndroidNativePauses] Failed to read native states:', e);
        return;
    }

    const now = Date.now();
    let changed = false;
    for (const entity of states || []) {
        if (entity.isEnabled || !entity.disabledUntil || entity.disabledUntil <= now) continue;
        const target = findAndroidBlockingTarget(entity.id);
        if (!target) continue;

        const pauseTarget = target.type === 'block' ? target.block : target.schedule;
        if (!pauseTarget.isPaused || (pauseTarget.pauseEndTime || 0) < entity.disabledUntil) {
            pauseTarget.isPaused = true;
            pauseTarget.pauseEndTime = entity.disabledUntil;
            changed = true;
        }
    }

    if (changed) {
        await saveData();
        render();
    }
}

export const ANDROID_DAY_TO_MON0 = {
    MONDAY: 0, TUESDAY: 1, WEDNESDAY: 2, THURSDAY: 3, FRIDAY: 4, SATURDAY: 5, SUNDAY: 6,
};

// One-time upward migration: reads the legacy redd-block-android app's
// SharedPreferences (via `read_native_schedules`, same device-protected
// storage file the Kotlin plugin still writes/reads — applicationId is
// unchanged across the update, see tauri-plugin-android-blocker/README)
// and converts each legacy Schedule into this app's blocklist+schedule
// model. Runs once; the flag is only set after a successful save+sync so
// a crash mid-migration doesn't leave a half-imported state.
export async function migrateAndroidNativeSchedules() {
    if (!state.isAndroid) return;
    if (state.appData.settings?.androidMigrationDone) return;

    // Blocks restored from currently-running legacy MANUAL schedules; their
    // Kotlin sessions are (re)started after the post-migration sync below.
    const restoredAlwaysOnBlockIds = [];

    try {
        const { routinesJson, activeSessionsJson } = await tauriAPI.androidReadNativeSchedules();
        const legacySchedules = JSON.parse(routinesJson || '[]');

        // Legacy MANUAL blocks are "on" when the user toggled them on
        // (isEnabled), which in the old app always started a live session.
        // Collect session ids too as a robustness fallback in case the
        // session pref and the enabled flag ever drifted apart.
        const activeSessionScheduleIds = new Set();
        try {
            const sessions = JSON.parse(activeSessionsJson || '[]');
            if (Array.isArray(sessions)) {
                for (const s of sessions) {
                    const sid = s?.scheduleId || s?.routineId;
                    if (sid) activeSessionScheduleIds.add(sid);
                }
            }
        } catch (_) { /* malformed sessions → treat as none active */ }

        if (Array.isArray(legacySchedules) && legacySchedules.length > 0) {
            for (const legacy of legacySchedules) {
                const timing = legacy.schedule || {};

                const blocklistId = generateId();
                state.appData.blocklists.push({
                    id: blocklistId,
                    name: legacy.name || 'Imported Schedule',
                    websites: legacy.blockedWebsites || [],
                    apps: legacy.blockedApps || [],
                    overrideDifficulty: { type: 'random-words', count: legacy.frictionWordCount || 15 },
                });

                if (timing.type === 'MANUAL') {
                    // Legacy MANUAL schedules are indefinite toggle-on/off
                    // blocks. If one was toggled on (enabled, or a live
                    // session exists), carry it over as an always-on block so
                    // the user's protection survives the upgrade — the new
                    // app supports indefinite ("Until I stop") blocks. Idle
                    // MANUAL schedules survive as the blocklist above only.
                    // (Without this, the first set_schedules sync deletes the
                    // legacy schedule/session and blocking silently stops.)
                    const isRunning = legacy.isEnabled || activeSessionScheduleIds.has(legacy.id);
                    if (isRunning) {
                        const blockId = generateId();
                        state.appData.activeBlocks.push({
                            id: blockId,
                            blocklistId,
                            startTime: Date.now(),
                            endTime: ALWAYS_ON_END_TIME,
                            isAlwaysOn: true,
                        });
                        restoredAlwaysOnBlockIds.push(blockId);
                        console.info('[migrateAndroidNativeSchedules] Imported running MANUAL legacy schedule as always-on block:', legacy.id);
                    } else {
                        console.info('[migrateAndroidNativeSchedules] Imported MANUAL legacy schedule as blocklist only:', legacy.id);
                    }
                    continue;
                }

                const days = timing.type === 'WEEKLY'
                    ? (timing.daysOfWeek || []).map(d => ANDROID_DAY_TO_MON0[d]).filter(d => d !== undefined)
                    : [0, 1, 2, 3, 4, 5, 6]; // DAILY: every day

                // Map legacy disabled state onto the pause model:
                //  - disabledUntil in the future = mid temporary-unlock →
                //    timed pause, auto-resumes at the same moment.
                //  - disabledUntil passed = the legacy re-enable was due →
                //    import as enabled.
                //  - no disabledUntil = user turned it off → indefinite pause.
                const nowMs = Date.now();
                const disabledUntil = typeof legacy.disabledUntil === 'number' ? legacy.disabledUntil : null;
                const isPaused = !legacy.isEnabled && (!disabledUntil || disabledUntil > nowMs);
                const pauseEndTime = (isPaused && disabledUntil) ? disabledUntil : undefined;

                state.appData.schedules.push({
                    id: generateId(),
                    blocklistId,
                    isPaused,
                    ...(pauseEndTime ? { pauseEndTime } : {}),
                    // Legacy DAILY/WEEKLY schedules recur indefinitely.
                    // Without repeatType, isNonRepeatingSchedule() would
                    // misclassify these as one-shot occurrences.
                    repeatType: 'forever',
                    repeatDate: null,
                    createdAt: Date.now(),
                    segments: [{
                        startHour: timing.timeHour ?? 0,
                        startMinute: timing.timeMinute ?? 0,
                        endHour: timing.endTimeHour ?? 23,
                        endMinute: timing.endTimeMinute ?? 59,
                        days,
                    }],
                });
            }
        }

        if (!state.appData.settings) state.appData.settings = {};
        state.appData.settings.androidMigrationDone = true;
        // No legacy data to import (genuinely fresh Android install) — create
        // the default space here, since loadData deferred it pending migration.
        if (state.appData.blocklists.length === 0) {
            createDefaultBlocklist();
        }
        await saveData();

        // Restore Kotlin sessions for carried-over always-on blocks: the sync
        // (re)creates their MANUAL Schedule entities, then start_manual_block
        // activates the session with no auto-stop — mirrors proceedWithBlock.
        // Must run before initializeAndroidBlockingState's own sync, which
        // would otherwise leave the entities present but sessionless.
        if (restoredAlwaysOnBlockIds.length > 0) {
            await syncSchedulesToHelper();
            for (const blockId of restoredAlwaysOnBlockIds) {
                try {
                    await tauriAPI.androidStartManualBlock(blockId, null);
                } catch (startErr) {
                    console.warn('[migrateAndroidNativeSchedules] Failed to start restored always-on block:', blockId, startErr);
                }
            }
        }

        console.log('[migrateAndroidNativeSchedules] Imported', legacySchedules.length, 'legacy schedules');
    } catch (e) {
        // Leave the flag unset on failure so we retry on next launch —
        // the Kotlin side keeps enforcing the legacy prefs regardless,
        // so there's no urgency/harm in retrying.
        console.error('[migrateAndroidNativeSchedules] Failed:', e);
    }
}

// Registers the friction-gate Channel with the Kotlin plugin. BlockerService
// launches the main activity with block details as intent extras when it
// intercepts a blocked app/website; BlockerPlugin forwards them through this
// channel. See tauri-plugin-android-blocker/android/.../BlockerPlugin.kt.
export function listenForAndroidFrictionGate() {
    const channel = new Channel();
    channel.onmessage = (event) => {
        if (event.type === 'resumed') {
            // BlockerPlugin.onResume() — the reliable native-lifecycle
            // signal for "user came back from a system settings screen".
            // DOM visibilitychange is unreliable inside an Android
            // WebView-hosted Activity, so this is the primary path (the
            // visibilitychange listener in setupEventListeners is a
            // fallback in case onResume didn't fire for some reason).
            onAndroidResumed();
        } else if (event.type === 'friction-gate') {
            openAndroidFrictionGateModal(event);
        }
    };
    tauriAPI.androidSetEventHandler(channel).catch((err) => {
        console.error('Failed to register Android friction-gate handler:', err);
    });
}

export async function onAndroidResumed() {
    if (state.androidPermissionsGranted) {
        await reconcileAndroidNativePauses();
        await syncSchedulesToHelper();
        return;
    }
    const wasGranted = state.androidPermissionsGranted;
    await checkAndroidPermissions();
    if (!wasGranted && state.androidPermissionsGranted) {
        try {
            await initializeAndroidBlockingState();
            render();
        } catch (err) {
            console.error('Error initializing Android blocking state after permission grant:', err);
        }
    }
}

// Dedicated close functions for modals where blindly re-adding .hidden
// would skip cleanup (resetting state.editingBlocklistId, state.challengeText, etc.).
// Modals not listed here (app-picker-modal's close is a local closure,
// settings-modal has no dedicated close fn) fall back to a plain hide —
// an acceptable degradation (stale state clears on next legitimate
// open/close), much better than the app closing outright.
export const ANDROID_MODAL_CLOSE_FNS = {
    'blocklist-modal': closeBlocklistModal,
    'override-modal': closeOverrideModal,
    'pause-modal': closePauseModal,
    'start-block-confirm-modal': closeStartBlockConfirmModal,
    'start-schedule-confirm-modal': closeScheduleConfirmModal,
};

// Tauri's generated WryActivity.onKeyDown only calls webView.goBack() on
// hardware/gesture back if canGoBack() is true; otherwise it falls
// through to the default Activity behavior, which closes the app (see
// gen/android/.../WryActivity.kt). This app never pushed history state
// for its modals, so every back press closed the app outright —
// including e.g. backing out of the blocklist/schedule editor. Trap
// it: push one history entry whenever a modal-overlay opens, and on
// popstate (which goBack() triggers) close the topmost open modal
// instead of letting the Activity finish.
export function setupAndroidBackButtonHandling() {
    let trapArmed = false;

    function topmostVisibleModal() {
        const overlays = document.querySelectorAll('.modal-overlay');
        let topmost = null;
        for (const el of overlays) {
            if (!el.classList.contains('hidden')) topmost = el;
        }
        return topmost;
    }

    function armTrapIfNeeded() {
        if (trapArmed) return;
        if (!topmostVisibleModal()) return;
        trapArmed = true;
        history.pushState({ androidModalTrap: true }, '');
    }

    // Any modal-overlay's `hidden` class toggling is how every open*Modal
    // function in this codebase shows a modal — watching that generically
    // avoids having to hook every individual open function.
    const observer = new MutationObserver(() => armTrapIfNeeded());
    document.querySelectorAll('.modal-overlay').forEach((el) => {
        observer.observe(el, { attributes: true, attributeFilter: ['class'] });
    });

    window.addEventListener('popstate', () => {
        const modal = topmostVisibleModal();
        if (!modal) {
            trapArmed = false;
            return;
        }
        const closeFn = ANDROID_MODAL_CLOSE_FNS[modal.id];
        if (closeFn) {
            closeFn();
        } else {
            modal.classList.add('hidden');
        }
        // Re-arm if another modal was underneath (nested case).
        trapArmed = false;
        armTrapIfNeeded();
    });
}

export function findAndroidBlockingTarget(nativeScheduleId) {
    const activeBlock = state.appData.activeBlocks?.find(block => block.id === nativeScheduleId);
    if (activeBlock) {
        return { type: 'block', block: activeBlock };
    }

    for (const schedule of state.appData.schedules || []) {
        // Kotlin ids are the schedule id plus a flattened suffix:
        // `<id>-<segIdx>` for repeating segments, `<id>-<segIdx>-<occIdx>`
        // for one-shot occurrences. Schedule ids are UUIDs, so prefix
        // matching can't collide with another schedule.
        if (nativeScheduleId === schedule.id || nativeScheduleId.startsWith(`${schedule.id}-`)) {
            return { type: 'schedule', schedule };
        }
    }

    return null;
}

// Shows the shared challenge UI for a block that fired on Android.
// Kotlin sends either the manual block id or the flattened schedule-segment id
// (`<scheduleId>-<segmentIndex>`). Manual blocks can still be stopped; schedule
// blocks only offer a pause from this interruption surface.
export function openAndroidFrictionGateModal(event) {
    // A friction-gate event is emitted by BlockerService itself, so the
    // Accessibility permission is active even if the startup permission
    // check has not completed yet. Hide any stale onboarding guess before
    // opening the challenge surface.
    state.androidPermissionsGranted = true;
    updateOnboardingVisibility();

    const target = findAndroidBlockingTarget(event.scheduleId);
    if (!target) {
        // Every Kotlin schedule is created from state.appData via set_schedules
        // (or imported by migrateAndroidNativeSchedules), so an unknown id
        // means the two stores are out of sync. Don't show a challenge we
        // can't act on (and don't disturb a gate that is already open);
        // the next syncSchedulesToHelper reconciles Kotlin.
        console.error('[friction-gate] No matching block/schedule for id:', event.scheduleId);
        return;
    }

    // Newest gate wins. A friction gate only makes sense for the app the
    // user is trying to open right now, so a gate that is still open for a
    // *different* target (user hopped between blocked apps) must be closed
    // before opening the new one: override-modal and pause-modal share
    // z-index 200, so DOM order — not open order — decides which paints on
    // top, and the close functions are also what clears the other gate's
    // backing state. If the incoming event matches the gate already showing,
    // keep it instead so a half-typed challenge survives re-interception.
    if (target.type === 'block'
        && isModalVisible('override-modal')
        && state.overrideBlockId === target.block.id) {
        return;
    }
    if (target.type === 'schedule'
        && isModalVisible('pause-modal')
        && !state.pauseBlockId
        && state.pauseScheduleData?.blocklistId === target.schedule.blocklistId) {
        return;
    }
    closeOverrideModal();
    closePauseModal();

    if (target.type === 'block') {
        state.overrideBlockId = target.block.id;
        state.overrideBlocklistIdForHelper = target.block.blocklistId;
        const blocklist = state.appData.blocklists.find(bl => bl.id === target.block.blocklistId);
        if (!blocklist) {
            console.error('[friction-gate] No matching blocklist for block:', target.block.blocklistId);
            return;
        }
        const difficulty = blocklist.overrideDifficulty || { type: 'random-words', count: 15 };
        populateOverrideConfirmModalContent(blocklist, { block: target.block });
        initializeOverrideModalChallenge(difficulty, blocklist.color);
        return;
    }

    const scheduleBlocklist = state.appData.blocklists.find(bl => bl.id === target.schedule.blocklistId);
    if (!scheduleBlocklist) {
        console.error('[friction-gate] No matching blocklist for schedule:', target.schedule.blocklistId);
        return;
    }

    state.pauseScheduleData = {
        blocklistId: target.schedule.blocklistId,
        isActiveNow: isScheduleSegmentActiveNow(target.schedule),
        frictionless: canEditScheduleBetweenBlocks(target.schedule),
    };
    openPauseModal(null);
}

export async function initializeIOSBlockingState() {
    // Sync state.lastBlockedDomains from active (non-paused) blocks so pause/resume works after restart
    const now = Date.now();
    const activeDomains = new Set();
    state.appData.activeBlocks
        .filter(b => b.startTime <= now && b.endTime > now && !b.isPaused)
        .forEach(b => {
            const bl = state.appData.blocklists.find(bl => bl.id === b.blocklistId);
            if (bl && bl.websites) bl.websites.forEach(d => activeDomains.add(d));
        });
    state.lastBlockedDomains = activeDomains;
    // Re-register DeviceActivity schedules so background activation survives app restarts.
    await syncSchedulesToHelper();
}

export function updateOnboardingVisibility() {
    if (activeExclusiveOnboardingScreenId()) {
        return;
    }
    const eulaOverlay = document.getElementById('eula-onboarding');
    const screentimeOverlay = document.getElementById('ios-screentime-onboarding');
    const androidOverlay = document.getElementById('android-permissions-onboarding');
    const main = document.getElementById('main-content');
    const showEula = !hasAcceptedEula();
    const showScreentime = state.isIOS && !showEula && !state.screentimeAuthorized;
    const showAndroidPermissions = state.isAndroid && !showEula && state.androidPermissionsGranted === false;
    const keepEulaVisibleForPendingSetup = !state.isIOS
        && !state.isAndroid
        && isFirstRunOnboardingInProgress()
        && !state.migrationOnboardingActive;
    const showEulaScreen = showEula || keepEulaVisibleForPendingSetup;
    const blockMainUi = showEulaScreen
        || showScreentime
        || showAndroidPermissions
        || state.migrationOnboardingActive
        || (!state.isIOS && !state.isAndroid && isFirstRunOnboardingInProgress());

    eulaOverlay?.classList.toggle('hidden', !showEulaScreen);
    screentimeOverlay?.classList.toggle('hidden', !showScreentime);
    androidOverlay?.classList.toggle('hidden', !showAndroidPermissions);
    main?.classList.toggle('hidden', blockMainUi);
    if (showAndroidPermissions) {
        document.getElementById('android-accessibility-status')?.classList.toggle('hidden', state.androidPermissionsGranted);
    }

    // Hide the BLOCKING NOW title-bar row on onboarding screens
    const nowBlockingRow = document.getElementById('now-blocking-row');
    if (nowBlockingRow) {
        nowBlockingRow.classList.toggle('hidden', blockMainUi);
    }

}

export function activeExclusiveOnboardingScreenId() {
    const screenIds = [
        'welcome-onboarding',
        'fda-onboarding',
        'migration-onboarding',
    ];
    return screenIds.find((id) => {
        const screen = document.getElementById(id);
        return screen != null && !screen.classList.contains('hidden');
    }) || null;
}

export function showExclusiveOnboardingScreen(activeId) {
    const screenIds = [
        'welcome-onboarding',
        'eula-onboarding',
        'fda-onboarding',
        'migration-onboarding',
        'ios-screentime-onboarding',
        'android-permissions-onboarding',
    ];
    screenIds.forEach((id) => {
        document.getElementById(id)?.classList.toggle('hidden', id !== activeId);
    });
}

export async function acceptEula() {
    if (!state.appData.settings) {
        state.appData.settings = {};
    }
    const alreadyAccepted = getAcceptedEulaRevision() === CURRENT_EULA_REVISION;
    state.forceShowEulaThisSession = false;
    if (!alreadyAccepted) {
        state.appData.settings.eulaAcceptedRevision = CURRENT_EULA_REVISION;
        state.appData.settings.eulaAcceptedAt = Date.now();
        await saveData();
    }
    if (state.isIOS) {
        await checkScreentimeAuth();
    } else if (state.isAndroid) {
        await checkAndroidPermissions();
    } else {
        if (!state.appData.settings.onboardingComplete) {
            state.firstRunExtensionSetupPending = true;
        }
        updateOnboardingVisibility();
    }
    await runPostAcceptanceStartup();
}

export function getExternalLinkTarget(href) {
    if (!href || typeof href !== 'string') return null;
    const trimmed = href.trim();
    const lower = trimmed.toLowerCase();
    if (lower.startsWith('https://') || lower.startsWith('http://') || lower.startsWith('mailto:')) {
        return trimmed;
    }
    return null;
}

export async function openExternal(target) {
    try {
        await openUrl(target);
    } catch (err) {
        console.warn('[openExternal] opener plugin failed:', err);
        if (!state.isIOS && !state.isAndroid) {
            window.open(target, '_blank', 'noopener,noreferrer');
        }
    }
}

/** Mobile webviews do not reliably open target=_blank links in the system browser; route via opener plugin. */
export function setupMobileExternalLinkOpens() {
    if (!state.isIOS && !state.isAndroid) return;
    document.addEventListener('click', (event) => {
        const anchor = event.target.closest('a[href]');
        if (!anchor) return;
        const url = getExternalLinkTarget(anchor.dataset.externalUrl || anchor.getAttribute('href'));
        if (!url) return;
        event.preventDefault();
        event.stopPropagation();
        void openExternal(url);
    }, true);
}

// Load data from main process
/// Run expiry once (e.g. on app load) so in-memory state matches Screen Time / helper.
/// Clears expired blocks and pause state, then syncs to plugin/helper.
export async function runExpiryOnce() {
    const now = Date.now();
    let changed = false;

    // Clear expired pause on blocks
    for (const block of state.appData.activeBlocks) {
        if (block.isPaused && block.pauseEndTime && block.pauseEndTime <= now) {
            delete block.isPaused;
            delete block.pauseEndTime;
            changed = true;
        }
    }
    // Clear expired pause on schedules
    if (state.appData.schedules) {
        for (const schedule of state.appData.schedules) {
            if (schedule.isPaused && schedule.pauseEndTime && schedule.pauseEndTime <= now) {
                delete schedule.isPaused;
                delete schedule.pauseEndTime;
                changed = true;
            }
        }
    }
    // Remove expired blocks
    const prevCount = state.appData.activeBlocks.length;
    state.appData.activeBlocks = state.appData.activeBlocks.filter(b => b.endTime > now);
    if (state.appData.activeBlocks.length !== prevCount) changed = true;

    // Remove expired schedules (date-limited or non-repeating past end)
    if (state.appData.schedules && state.appData.schedules.length > 0) {
        const nowDate = new Date(now);
        const expiredIds = [];
        for (const schedule of state.appData.schedules) {
            if (schedule.repeatType === 'forever') continue;
            if (schedule.repeatType === 'date' && schedule.repeatDate) {
                const endDate = new Date(schedule.repeatDate);
                endDate.setHours(23, 59, 59, 999);
                if (nowDate > endDate) expiredIds.push(schedule.id);
                continue;
            }
            if (!scheduleHasFutureSingleOccurrence(schedule, nowDate)) {
                expiredIds.push(schedule.id);
            }
        }
        if (expiredIds.length > 0) {
            state.appData.schedules = state.appData.schedules.filter(s => !expiredIds.includes(s.id));
            changed = true;
        }
    }

    if (!changed) return;
    await saveData();
    await updateHostsFile();
    await syncSchedulesToHelper();
    await updateBlockedApps();
}





export function getModalDismissButton(modalOverlay) {
    if (!modalOverlay) return null;
    return modalOverlay.querySelector('.modal-buttons .cancel-btn, [id^="cancel-"], [id^="close-"]');
}

export function resetModalScrollPosition(modalEl) {
    if (!modalEl) return;
    const apply = () => {
        modalEl.scrollTop = 0;
        const content = modalEl.querySelector('.modal-content');
        if (content) content.scrollTop = 0;
        const scrollBody = modalEl.querySelector('.mobile-modal-scroll-body');
        if (scrollBody) scrollBody.scrollTop = 0;
    };
    apply();
    requestAnimationFrame(apply);
}

export function attachModalScrollResetOnShow(modalEl) {
    if (!modalEl || modalEl.dataset.scrollResetOnShow === '1') return;
    modalEl.dataset.scrollResetOnShow = '1';
    new MutationObserver(() => {
        if (!modalEl.classList.contains('hidden')) {
            resetModalScrollPosition(modalEl);
        }
    }).observe(modalEl, { attributes: true, attributeFilter: ['class'] });
}

export function setupHandsetModalScreens() {
    const modalIds = [
        'blocklist-modal',
        'quick-start-modal',
        'override-modal',
        'pause-modal',
        'start-block-confirm-modal',
        'start-schedule-confirm-modal',
        'settings-modal',
        'override-all-modal',
        // Desktop single-column reuses this sheet; wrap chrome on every platform.
        'enter-scheduler-modal',
    ];

    for (const modalId of modalIds) {
        const overlay = document.getElementById(modalId);
        const content = overlay?.querySelector('.modal-content');
        const titleSource = content?.querySelector('h3');
        if (!overlay || !content || !titleSource) continue;

        overlay.classList.add('mobile-fullscreen-modal');
        if (content.querySelector('.mobile-modal-header')) continue;

        const isRoomStyleConfirmModal =
            modalId === 'start-block-confirm-modal' || modalId === 'start-schedule-confirm-modal';
        if (!isRoomStyleConfirmModal) {
            titleSource.classList.add('mobile-modal-title-source');
        }

        const header = document.createElement('div');
        header.className = 'mobile-modal-header';

        const backButton = document.createElement('button');
        backButton.type = 'button';
        backButton.className = 'mobile-modal-back-btn';
        backButton.setAttribute('aria-label', 'Back');
        backButton.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M15 18l-6-6 6-6"></path>
            </svg>
        `;

        const headerTitle = document.createElement('div');
        headerTitle.className = 'mobile-modal-header-title';

        const syncHeaderTitle = () => {
            const nextTitle = titleSource.textContent?.trim() || titleSource.innerText?.trim() || '';
            if (!isRoomStyleConfirmModal) {
                headerTitle.textContent = nextTitle;
            }
            backButton.setAttribute('aria-label', nextTitle ? `Back from ${nextTitle}` : 'Back');
        };

        syncHeaderTitle();
        new MutationObserver(syncHeaderTitle).observe(titleSource, {
            childList: true,
            characterData: true,
            subtree: true
        });

        backButton.addEventListener('click', () => {
            const dismissButton = getModalDismissButton(overlay);
            if (dismissButton) dismissButton.click();
            else overlay.classList.add('hidden');
        });

        header.append(backButton);
        if (!isRoomStyleConfirmModal) {
            header.append(headerTitle);
        }
        if (modalId === 'settings-modal') {
            const versionEl = content.querySelector('#current-app-version');
            const settingsHeader = content.querySelector('.settings-modal-header');
            if (document.body.classList.contains('handset-device')) {
                if (versionEl) {
                    versionEl.classList.add('settings-header-version');
                    header.appendChild(versionEl);
                }
                settingsHeader?.classList.add('hidden');
            }
        }
        content.prepend(header);

        if (isRoomStyleConfirmModal) {
            const roomHeader = content.querySelector('.start-confirm-header-room');
            // Handset only: title lives in the sticky mobile header. On desktop/iPad the
            // header wrapper is display:none — keep the room header in the scroll body.
            if (roomHeader && document.body.classList.contains('handset-device')) {
                header.appendChild(roomHeader);
            }
        }

        const scrollBody = document.createElement('div');
        scrollBody.className = 'mobile-modal-scroll-body';
        const keepFooterOutsideScroll =
            modalId === 'blocklist-modal' || modalId === 'settings-modal';
        while (header.nextSibling) {
            const node = header.nextSibling;
            if (
                keepFooterOutsideScroll
                && node.nodeType === Node.ELEMENT_NODE
                && node.classList.contains('modal-buttons')
            ) {
                break;
            }
            scrollBody.appendChild(node);
        }
        content.appendChild(scrollBody);
        if (keepFooterOutsideScroll) {
            const footer = content.querySelector(':scope > .modal-buttons');
            if (footer) content.appendChild(footer);
        }
        attachModalScrollResetOnShow(overlay);
    }
}


function configureMobileBlocklistFields() {
    // Mobile apps are selected from the platform picker. Keep the text fields
    // out of the UI and the tab order so app names cannot be entered manually.
    ['app-input', 'modal-app-input', 'quick-start-app-input'].forEach((id) => {
        const input = document.getElementById(id);
        if (!input) return;
        input.style.display = 'none';
        input.disabled = true;
        input.setAttribute('aria-hidden', 'true');
        input.tabIndex = -1;
    });

    // Keep desktop's website-first layout, but put apps first in both mobile
    // entry points. Moving the nodes also keeps accessibility/tab order in
    // sync with what is shown on screen.
    [
        ['blocklist-apps-group', 'blocklist-websites-group'],
        ['quick-start-apps-group', 'quick-start-websites-group'],
    ].forEach(([appsId, websitesId]) => {
        const appsGroup = document.getElementById(appsId);
        const websitesGroup = document.getElementById(websitesId);
        if (!appsGroup || !websitesGroup || appsGroup.parentElement !== websitesGroup.parentElement) return;
        websitesGroup.parentElement.insertBefore(appsGroup, websitesGroup);
    });
}

// Detect platform for window controls and iOS
export function detectPlatform() {
    // Check for iOS (Tauri iOS uses a WKWebView with standard iOS user agent)
    const isIOSDevice = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    if (isIOSDevice) {
        state.isIOS = true;
        document.body.classList.add('ios');
        // iPhone / iPod (anything not iPad): used for layout (e.g. hide week calendar)
        const isIPad = /iPad/.test(navigator.userAgent) ||
            (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        if (!isIPad) {
            document.body.classList.add('ios-phone');
            document.body.classList.add('handset-device');
        }
        // Hide desktop-only UI on iOS
        document.getElementById('window-controls')?.classList.add('hidden');
        document.querySelector('.title-bar')?.classList.add('hidden');
        // Hide helper-related settings section on iOS
        document.getElementById('helper-settings-section')?.classList.add('hidden');

        // iOS app blocking uses Screen Time tokens (not app names).
        configureMobileBlocklistFields();
    } else if (/Android/.test(navigator.userAgent)) {
        state.isAndroid = true;
        document.body.classList.add('android');
        document.body.classList.add('handset-device');
        // Hide desktop-only UI on Android — same fullscreen-webview
        // treatment as iOS (custom title bar / window controls make no
        // sense on a mobile OS).
        document.getElementById('window-controls')?.classList.add('hidden');
        document.querySelector('.title-bar')?.classList.add('hidden');
        document.getElementById('helper-settings-section')?.classList.add('hidden');
        // Android app blocking uses the installed-app picker. Keep package
        // names out of the manual text-entry path on mobile.
        configureMobileBlocklistFields();
    } else {
        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        if (isMac) {
            document.body.classList.add('mac');
            state.isMacOSDesktop = true;
            // Hide controls on macOS - native traffic lights are used
            document.getElementById('window-controls')?.classList.add('hidden');
        } else {
            document.body.classList.add('windows');
            // Show controls on Windows
            document.getElementById('window-controls')?.classList.remove('hidden');
        }
    }
    updateManageSectionVisibility();
}

// Update window height to fit content
export function updateWindowHeight() {
    // Use requestAnimationFrame to ensure layout is complete
    requestAnimationFrame(() => {
        const appContainer = document.querySelector('.app-container');
        if (appContainer) {
            // Get the actual height needed for the content
            const contentHeight = appContainer.scrollHeight;
            // Add a small buffer for window chrome/borders
            const targetHeight = Math.max(contentHeight + 20, 500);
            // Window height adjustment handled by Tauri
            // tauriAPI.setWindowHeight(targetHeight);
        }
    });
}

// Update maximize button icon based on window state (Windows custom title bar only).
let lastMaximizedButtonState = null;
let maximizeButtonSyncInFlight = false;
let maximizeButtonResizeSyncTimer = null;
let maximizeButtonSyncInitialized = false;
/** @type {(() => void) | null} */
let unlistenMaximizeButtonResized = null;
/** @type {(() => void) | null} */
let unlistenMaximizeButtonFocus = null;

export function isWindowsDesktopWithCustomTitleBar() {
    return document.body.classList.contains('windows')
        && !!document.getElementById('titlebar-maximize')
        && !document.getElementById('window-controls')?.classList.contains('hidden');
}

export async function updateMaximizeButton() {
    const maximizeBtn = document.getElementById('titlebar-maximize');
    const maximizeIcon = document.getElementById('maximize-icon');
    const restoreIcon = document.getElementById('restore-icon');

    if (!maximizeBtn || !maximizeIcon || !restoreIcon) return;

    const win = getCurrentWindow();
    let isMaximized;
    try {
        isMaximized = await win.isMaximized();
    } catch (err) {
        console.warn('Failed to read window maximize state:', err);
        return;
    }

    if (isMaximized === lastMaximizedButtonState) return;
    lastMaximizedButtonState = isMaximized;

    if (isMaximized) {
        maximizeIcon.style.display = 'none';
        restoreIcon.style.display = 'block';
        maximizeBtn.title = 'Restore';
    } else {
        maximizeIcon.style.display = 'block';
        restoreIcon.style.display = 'none';
        maximizeBtn.title = 'Maximize';
    }
}

export async function syncMaximizeButtonFromWindow({ force = false } = {}) {
    if (!isWindowsDesktopWithCustomTitleBar()) return;
    if (maximizeButtonSyncInFlight) return;
    maximizeButtonSyncInFlight = true;
    try {
        if (force) lastMaximizedButtonState = null;
        await updateMaximizeButton();
    } finally {
        maximizeButtonSyncInFlight = false;
    }
}

export function scheduleMaximizeButtonSyncFromResize() {
    if (maximizeButtonResizeSyncTimer) {
        clearTimeout(maximizeButtonResizeSyncTimer);
    }
    // Coalesce rapid resize events (e.g. drag-resize) without delaying click/focus syncs.
    maximizeButtonResizeSyncTimer = setTimeout(() => {
        maximizeButtonResizeSyncTimer = null;
        void syncMaximizeButtonFromWindow();
    }, 50);
}

export async function setupMaximizeButtonSync() {
    if (maximizeButtonSyncInitialized || !isWindowsDesktopWithCustomTitleBar()) return;
    maximizeButtonSyncInitialized = true;

    await syncMaximizeButtonFromWindow({ force: true });

    const win = getCurrentWindow();

    if (unlistenMaximizeButtonResized) {
        unlistenMaximizeButtonResized();
        unlistenMaximizeButtonResized = null;
    }
    if (unlistenMaximizeButtonFocus) {
        unlistenMaximizeButtonFocus();
        unlistenMaximizeButtonFocus = null;
    }

    unlistenMaximizeButtonResized = await win.onResized(() => {
        scheduleMaximizeButtonSyncFromResize();
    });

    unlistenMaximizeButtonFocus = await win.onFocusChanged(({ payload: focused }) => {
        if (focused) void syncMaximizeButtonFromWindow();
    });

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            void syncMaximizeButtonFromWindow();
        }
    });
}
