// Enforcement: opt-in toggle, blocking-method settings, Safari FDA onboarding,
// behaviour banner, enforcer action banners, web-automation watcher.
// Extracted verbatim from app.js.
import { state, appState } from './state.js';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ask } from '@tauri-apps/plugin-dialog';
import iconChromeUrl from './images/icon-chrome.svg';
import iconBraveUrl from './images/icon-brave.svg';
import iconEdgeUrl from './images/icon-edge.svg';
import iconFirefoxUrl from './images/icon-firefox.svg';
import iconSafariUrl from './images/icon-safari.svg';
import logoReddFocusUrl from './images/logo-reddfocus.svg';
import logoReddShieldUrl from './images/logo-redd-shield.svg';
import screenshotChromeStep1 from './images/toggle-chrome-incognito-windows-1.png';
import screenshotChromeStep2 from './images/toggle-chrome-incognito-windows-2.png';
import screenshotEdgeStep1 from './images/toggle-edge-incognito-windows-1.png';
import screenshotEdgeStep2 from './images/toggle-edge-incognito-windows-2.png';
import screenshotFirefoxStep1 from './images/toggle-firefox-private-windows-1.png';
import screenshotFirefoxStep2 from './images/toggle-firefox-private-windows-2.png';
import screenshotSafariStep1 from './images/mac-extension-settings-1.png';
import screenshotSafariStep2 from './images/mac-extension-settings-2.png';
import screenshotAutomationSettings from './images/automation-settings.png';
import screenshotEnableFda from './images/enable-fda.png';
import { tauriAPI, openUrl } from './tauri-api.js';
import { SETTINGS_TRANSLATIONS, getSettingsLanguage, tSettings, tSettingsFmt } from './i18n.js';
import { hasAnyEnforcedBlocks } from './schedule-engine.js';
import { isModalVisible } from './modal-manager.js';
import { kickClockNow } from './render.js';
import { isScheduleSegmentActiveNow } from './schedule-editor.js';
import { setLanguagePickerOpen } from './app.js';
import { reconcileBlockingWarningShell, showExclusiveOnboardingScreen, updateOnboardingVisibility } from './blocking-platform.js';
import {
    EXT_ONBOARDING_DISMISSED_KEY, MIGRATION_POLL_MS, applyEnforcementDescCopy,
    hasAcceptedEula, showMigrationOnboarding, presentWelcomeOnboarding,
} from './onboarding.js';

// ---- Enforcement opt-in toggle -------------------------------------------
// Reads the current enforcement-enabled setting from the backend and
// wires the toggle in the extension setup dialog. When a block is
// active and enforcement is ON, the toggle is locked (disabled) so
// the user can't weaken enforcement mid-session. The server-side
// guard in enforcement_toggle.rs is the ultimate backstop.

export function setSettingsBlockingMethodExpanded(expanded) {
    const toggle = document.getElementById('settings-blocking-method-toggle');
    const content = document.getElementById('settings-blocking-method-content');
    if (!toggle || !content) return;
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    content.classList.toggle('hidden', !expanded);
}

export function resetSettingsEnforcementSection() {
    if (__ANDROID_BUILD__) return;
    setSettingsBlockingMethodExpanded(false);
}

export function setupSettingsEnforcementSection() {
    if (__ANDROID_BUILD__) return;
    const toggle = document.getElementById('settings-blocking-method-toggle');
    if (!toggle || toggle.dataset.bound === '1') return;
    toggle.dataset.bound = '1';
    toggle.addEventListener('click', () => {
        const isOpen = toggle.getAttribute('aria-expanded') === 'true';
        setSettingsBlockingMethodExpanded(!isOpen);
    });
}

export function syncGraceSettingVisibility(enabled) {
    const row = document.getElementById('settings-grace-row');
    const input = document.getElementById('grace-seconds-input');
    const errorEl = document.getElementById('grace-error');
    if (row) row.classList.toggle('hidden', !enabled);
    if (input) input.classList.toggle('hidden', !enabled);
    if (errorEl && !enabled) {
        errorEl.textContent = '';
        errorEl.classList.add('hidden');
    }
    if (enabled) updateGraceSettingLock();
}

export function updateGraceSettingLock() {
    const input = document.getElementById('grace-seconds-input');
    const row = document.getElementById('settings-grace-row');
    const wrap = document.getElementById('settings-grace-input-wrap');
    const tooltip = document.getElementById('grace-input-lock-tooltip');
    if (!input || !wrap || row?.classList.contains('hidden')) return;

    const locked = hasAnyEnforcedBlocks();
    input.disabled = locked;
    if (locked) {
        input.setAttribute('aria-disabled', 'true');
    } else {
        input.removeAttribute('aria-disabled');
    }
    if (tooltip) {
        tooltip.textContent = locked ? tSettings('settingsEnforcementLockedTooltip') : '';
        tooltip.classList.toggle('hidden', !locked);
    }
}

export function syncEnforcementToggleSectionVisual(_toggle) {
    const migrationToggle = document.getElementById('enforcement-toggle-input');
    const migrationSection = document.getElementById('enforcement-toggle-section');
    if (migrationSection && migrationToggle) {
        const on = !!migrationToggle.checked;
        migrationSection.classList.toggle('enforcement-on', on);
        migrationSection.classList.toggle('enforcement-off', !on);
    }
    syncGraceSettingVisibility(getEnforcementToggleInputs().some((t) => t.checked));
}

export function getEnforcementToggleInputs() {
    return Array.from(document.querySelectorAll('.enforcement-toggle-input'));
}

export async function updateAllEnforcementToggleLocks() {
    if (__ANDROID_BUILD__) return;
    for (const toggle of getEnforcementToggleInputs()) {
        await updateEnforcementToggleLock(toggle);
    }
}

export function syncAllEnforcementToggleInputs(checked) {
    for (const toggle of getEnforcementToggleInputs()) {
        toggle.checked = !!checked;
        syncEnforcementToggleSectionVisual(toggle);
    }
}

let enforcementToggleWired = false;

export async function onEnforcementToggleChange(changedToggle) {
    const desired = changedToggle.checked;
    syncAllEnforcementToggleInputs(desired);
    try {
        const saved = await invoke('set_enforcement_enabled', { enabled: desired });
        syncAllEnforcementToggleInputs(saved);
        await updateAllEnforcementToggleLocks();
    } catch (e) {
        console.warn('[enforcement-toggle] set failed:', e);
        syncAllEnforcementToggleInputs(!desired);
        await updateAllEnforcementToggleLocks();
    }
}

export async function wireEnforcementToggle() {
    if (__ANDROID_BUILD__) return;
    if (state.isIOS) return;
    const toggles = getEnforcementToggleInputs();
    if (!toggles.length) return;

    let enabled = false;
    try {
        enabled = !!(await invoke('get_enforcement_enabled'));
    } catch (e) {
        console.warn('[enforcement-toggle] read failed:', e);
    }

    syncAllEnforcementToggleInputs(enabled);
    await updateAllEnforcementToggleLocks();

    if (!enforcementToggleWired) {
        enforcementToggleWired = true;
        for (const toggle of toggles) {
            toggle.addEventListener('change', () => { void onEnforcementToggleChange(toggle); });
        }
    }
}

let blockingMethodSettingsWired = false;
let lastSettingsBlockingMethodBrowsers = null;

export function syncBlockingMethodRowVisibility(browsers = {}) {
    if (!state.isMacOSDesktop) return;
    lastSettingsBlockingMethodBrowsers = browsers;
    const installed = new Set(installedMacBlockingMethodKeys(browsers));
    for (const key of MAC_BLOCKING_METHOD_KEYS) {
        const select = document.getElementById(`blocking-method-${key}`);
        const row = select?.closest('.settings-row');
        if (row) row.classList.toggle('hidden', !installed.has(key));
    }
    const section = document.getElementById('settings-blocking-method-section');
    if (section) section.classList.toggle('hidden', installed.size === 0);
}

export function syncBlockingMethodLabelIcons() {
    if (__ANDROID_BUILD__) return;
    for (const key of MAC_BLOCKING_METHOD_KEYS) {
        const icon = document.getElementById(`settings-blocking-method-${key}-icon`);
        if (icon) icon.src = browserIconUrl(key);
    }
}

export function syncBlockingMethodSelects(methods = getBlockingMethodsMap()) {
    for (const key of MAC_BLOCKING_METHOD_KEYS) {
        const select = document.getElementById(`blocking-method-${key}`);
        if (!select) continue;
        const value = methods[key] || 'automation';
        select.value = value;
        select.disabled = false;
    }
}

export async function wireBlockingMethodSettings() {
    if (__ANDROID_BUILD__) return;
    if (!state.isMacOSDesktop) return;

    let browsers = lastOnboardingState?.browsers || state.lastMigrationBrowserState?.browsers || {};
    try {
        const fresh = await invoke('onboarding_state');
        if (fresh?.browsers) browsers = fresh.browsers;
    } catch (e) {
        console.warn('[blocking-method] browser scan failed:', e);
    }
    syncBlockingMethodRowVisibility(browsers);

    let methods = getBlockingMethodsMap();
    try {
        methods = await tauriAPI.getBlockingMethods();
        if (!state.appData.settings) state.appData.settings = {};
        state.appData.settings.blockingMethods = methods;
    } catch (e) {
        console.warn('[blocking-method] read failed:', e);
    }
    syncBlockingMethodSelects(methods);
    syncBlockingMethodLabelIcons();

    if (!blockingMethodSettingsWired) {
        blockingMethodSettingsWired = true;
        for (const key of MAC_BLOCKING_METHOD_KEYS) {
            const select = document.getElementById(`blocking-method-${key}`);
            if (!select) continue;
            select.addEventListener('change', () => {
                void onBlockingMethodChange(key, select);
            });
        }
        const safariFdaBtn = document.getElementById('settings-safari-fda-grant-btn');
        if (safariFdaBtn && !safariFdaBtn._safariFdaWired) {
            safariFdaBtn._safariFdaWired = true;
            safariFdaBtn.addEventListener('click', () => {
                void (async () => {
                    try {
                        await invoke('open_safari_fda_settings');
                    } catch (e) {
                        console.warn('[safari-fda] open settings failed:', e);
                    }
                    await pollSafariFdaUntilGranted({ refreshSettings: true });
                })();
            });
        }
    }
    syncSafariFdaSettingsRow();
}

export function safariUsesExtensionMode() {
    return state.isMacOSDesktop && browserBlockingMethod('safari') === 'extension';
}

let activeSafariFdaOnboardingSession = null;

export function hideSafariFdaOnboardingUi() {
    if (__ANDROID_BUILD__) return;
    const session = activeSafariFdaOnboardingSession;
    if (!session) return;
    session.overlay?.classList.add('hidden');
    if (session.pollHandle) {
        clearInterval(session.pollHandle);
        session.pollHandle = null;
    }
}

/** Safari FDA onboarding — same layout/copy pattern as the EULA screen. */
export function applySafariFdaOnboardingLanguage() {
    if (__ANDROID_BUILD__) return;
    const shield = document.getElementById('fda-onboarding-shield-logo');
    if (shield) {
        shield.src = logoReddShieldUrl;
        shield.alt = '';
    }
    const screenshot = document.getElementById('fda-onboarding-screenshot');
    if (screenshot) screenshot.src = screenshotEnableFda;

    const title = document.getElementById('fda-onboarding-title');
    if (title) title.textContent = tSettings('safariFdaOnboardingTitle');

    const howto = document.getElementById('fda-onboarding-howto');
    if (howto) howto.textContent = tSettings('safariFdaOnboardingHowto');

    const backBtn = document.getElementById('fda-onboarding-back-btn');
    if (backBtn) backBtn.textContent = tSettings('eulaBackBtn');

    void syncSafariFdaOnboardingGrantButton();
}

export async function syncSafariFdaOnboardingGrantButton() {
    if (__ANDROID_BUILD__) return;
    const grantBtn = document.getElementById('fda-onboarding-grant-btn');
    const whyEl = document.getElementById('fda-onboarding-why');
    if (!grantBtn) return false;
    let granted = false;
    try {
        granted = !!(await invoke('sync_safari_fda_access'));
    } catch (_) { /* not granted */ }
    grantBtn.textContent = granted
        ? tSettings('safariFdaOnboardingAlreadyGrantedBtn')
        : tSettings('safariFdaOnboardingGrantBtn');
    if (whyEl) {
        whyEl.innerHTML = granted
            ? tSettings('safariFdaOnboardingAlreadyGrantedWhy')
            : tSettings('safariFdaOnboardingWhyHtml');
    }
    if (activeSafariFdaOnboardingSession) {
        activeSafariFdaOnboardingSession.fdaLiveGranted = granted;
    }
    return granted;
}

export async function finalizeSafariFdaOnboardingGrant(statusEl) {
    if (__ANDROID_BUILD__) return;
    if (statusEl) {
        statusEl.classList.remove('hidden');
        statusEl.textContent = tSettings('safariFdaOnboardingGrantedStatus');
    }
    try {
        await invoke('complete_safari_fda_onboarding');
    } catch (e) {
        console.warn('[safari-fda] complete failed:', e);
        return false;
    }
    hideSafariFdaOnboardingUi();
    const resolve = activeSafariFdaOnboardingSession?.resolve;
    activeSafariFdaOnboardingSession = null;
    resolve?.();
    return true;
}

export function showSafariFdaOnboardingOverlay() {
    if (__ANDROID_BUILD__) return;
    if (!safariUsesExtensionMode()) {
        return Promise.resolve();
    }
    if (activeSafariFdaOnboardingSession) {
        void presentSafariFdaOnboardingUi();
        return activeSafariFdaOnboardingSession.promise;
    }
    let session;
    const promise = new Promise((resolve) => {
        const overlay = document.getElementById('fda-onboarding');
        const grantBtn = document.getElementById('fda-onboarding-grant-btn');
        const statusEl = document.getElementById('fda-onboarding-status');
        if (!overlay || !grantBtn) {
            resolve();
            return;
        }
        applySafariFdaOnboardingLanguage();

        const onGrant = async () => {
            let alreadyGranted = false;
            try {
                alreadyGranted = !!(await invoke('sync_safari_fda_access'));
            } catch (_) { /* fall through */ }
            if (alreadyGranted) {
                await finalizeSafariFdaOnboardingGrant(statusEl);
                return;
            }
            grantBtn.disabled = true;
            const originalLabel = grantBtn.textContent;
            grantBtn.textContent = tSettings('safariFdaOnboardingOpeningSettings');
            try {
                await invoke('open_safari_fda_settings');
            } catch (e) {
                console.warn('[safari-fda] open settings failed:', e);
            }
            grantBtn.textContent = originalLabel;
            grantBtn.disabled = false;
            if (statusEl) {
                statusEl.classList.remove('hidden');
                statusEl.textContent = tSettings('safariFdaOnboardingWaiting');
            }
            if (!session.pollHandle) {
                session.pollHandle = setInterval(async () => {
                    try {
                        const granted = await invoke('sync_safari_fda_access');
                        session.fdaLiveGranted = granted;
                        if (granted) {
                            await finalizeSafariFdaOnboardingGrant(statusEl);
                        }
                    } catch (_) { /* transient */ }
                }, 1500);
            }
        };

        session = {
            overlay,
            grantBtn,
            statusEl,
            pollHandle: null,
            resolve,
            onGrant,
        };
        activeSafariFdaOnboardingSession = session;
        if (!grantBtn._safariFdaGrantListenerAdded) {
            grantBtn._safariFdaGrantListenerAdded = true;
            grantBtn.addEventListener('click', () => {
                void session.onGrant?.();
            });
        }
        const backBtn = document.getElementById('fda-onboarding-back-btn');
        if (backBtn && !backBtn._safariFdaBackWired) {
            backBtn._safariFdaBackWired = true;
            backBtn.addEventListener('click', () => {
                hideSafariFdaOnboardingUi();
                const r = activeSafariFdaOnboardingSession?.resolve;
                activeSafariFdaOnboardingSession = null;
                r?.();
            });
        }
        void presentSafariFdaOnboardingUi();
    });
    if (session) session.promise = promise;
    return promise;
}

export async function presentSafariFdaOnboardingUi() {
    if (__ANDROID_BUILD__) return;
    const session = activeSafariFdaOnboardingSession;
    if (!session) return;
    document.getElementById('settings-modal')?.classList.add('hidden');
    setLanguagePickerOpen(false);
    showExclusiveOnboardingScreen('fda-onboarding');
    document.getElementById('main-content')?.classList.add('hidden');
    document.getElementById('now-blocking-row')?.classList.add('hidden');
    const statusEl = document.getElementById('fda-onboarding-status');
    if (statusEl && !session.pollHandle) {
        statusEl.classList.add('hidden');
        statusEl.textContent = '';
    }
    await syncSafariFdaOnboardingGrantButton();
}

export async function pollSafariFdaUntilGranted({ refreshSettings = false } = {}) {
    for (let i = 0; i < 40; i++) {
        let granted = false;
        try {
            granted = !!(await invoke('sync_safari_fda_access'));
        } catch (_) { /* retry */ }
        if (granted) {
            try {
                await invoke('complete_safari_fda_onboarding');
            } catch (e) {
                console.warn('[safari-fda] complete failed:', e);
            }
            if (refreshSettings) syncSafariFdaSettingsRow();
            if (state.migrationOnboardingActive || isModalVisible('migration-onboarding')) {
                const fresh = await invoke('onboarding_state');
                renderBrowserInstallButtons(fresh, { force: true });
            }
            await refreshBehaviourBannerIfStale({ force: true });
            return true;
        }
        await new Promise(r => setTimeout(r, 1500));
    }
    return false;
}

export async function ensureSafariExtensionFdaBeforeSetup() {
    if (__ANDROID_BUILD__) return;
    if (!safariUsesExtensionMode()) return;
    let granted = false;
    try {
        const probe = await invoke('check_safari_fda_access');
        granted = !!(probe && probe.granted);
    } catch (_) { /* not granted */ }
    if (granted) {
        try {
            await invoke('complete_safari_fda_onboarding');
        } catch (_) { /* marker only */ }
        return;
    }
    await showSafariFdaOnboardingOverlay();
}

export async function syncSafariFdaSettingsRow() {
    if (__ANDROID_BUILD__) return;
    const row = document.getElementById('settings-safari-fda-row');
    const statusEl = document.getElementById('settings-safari-fda-status');
    const grantBtn = document.getElementById('settings-safari-fda-grant-btn');
    if (!row || !statusEl) return;
    const browsers = lastSettingsBlockingMethodBrowsers
        || lastOnboardingState?.browsers
        || state.lastMigrationBrowserState?.browsers
        || {};
    if (!safariUsesExtensionMode() || !browsers.safari?.installed) {
        row.classList.add('hidden');
        return;
    }
    row.classList.remove('hidden');
    if (grantBtn) grantBtn.textContent = tSettings('safariFdaSettingsGrantBtn');
    let granted = false;
    try {
        granted = !!(await invoke('sync_safari_fda_access'));
    } catch (_) { /* not granted */ }
    statusEl.textContent = granted
        ? tSettings('safariFdaSettingsGranted')
        : tSettings('safariFdaSettingsNotGranted');
    if (grantBtn) grantBtn.classList.toggle('hidden', granted);
}

export async function onBlockingMethodChange(key, select) {
    const previous = browserBlockingMethod(key);
    const desired = select.value === 'extension' ? 'extension' : 'automation';
    select.disabled = true;
    try {
        const methods = await tauriAPI.setBlockingMethod(key, desired);
        if (!state.appData.settings) state.appData.settings = {};
        state.appData.settings.blockingMethods = methods;
        syncBlockingMethodSelects(methods);
        await refreshAutomationPermissionStatus({ force: true });
        if (state.migrationOnboardingActive || isModalVisible('migration-onboarding')) {
            const fresh = await invoke('onboarding_state');
            renderBrowserInstallButtons(fresh, { force: true });
        }
        if (key === 'safari' && desired === 'automation') {
            hideSafariFdaOnboardingUi();
            syncSafariFdaSettingsRow();
        }
        if (desired === 'extension') {
            if (key === 'safari') {
                await ensureSafariExtensionFdaBeforeSetup();
            }
            let fresh = null;
            try {
                fresh = await invoke('onboarding_state');
            } catch (e) {
                console.warn('[blocking-method] onboarding_state failed:', e);
            }
            const needsSetup = fresh
                && effectiveBrowserComplianceStatus(key, fresh.browsers || {}) !== 'compliant';
            if (needsSetup) {
                document.getElementById('settings-modal')?.classList.add('hidden');
                setLanguagePickerOpen(false);
                await openExtensionSetupOverlay();
            } else if (fresh) {
                await updateBehaviourChangeBanner(fresh);
            }
            if (key === 'safari') syncSafariFdaSettingsRow();
        } else if (key === 'safari') {
            syncSafariFdaSettingsRow();
        }
    } catch (e) {
        console.warn('[blocking-method] set failed:', e);
        select.value = previous;
        await ask(
            String(e?.message || e || 'Could not change blocking method.'),
            { title: 'Blocking method', kind: 'error' },
        );
    } finally {
        select.disabled = false;
    }
}

export async function updateEnforcementToggleLock(toggle) {
    if (!toggle) return;
    try {
        // Try a no-op read to check current state; the real lock check
        // is whether turning OFF would be rejected. We approximate by
        // checking if enforcement is ON and the backend would reject
        // disabling it. Simplest: try a dry-run disable, catch the
        // error. But that's ugly — instead, check if any block is
        // active by reading from the data file the same way the
        // backend does. For simplicity, we just check if the toggle
        // is ON and read the active-block state via the data.
        const data = await invoke('load_data');
        const activeBlocks = (data && data.activeBlocks) || [];
        const schedules = (data && data.schedules) || [];
        const nowMs = Date.now();
        const nowDate = new Date(nowMs);
        const anyActive = activeBlocks.some(b => {
            const start = b.startTime || Infinity;
            const end = b.endTime;
            const paused = b.isPaused || false;
            const isAlways = end === null || end === undefined;
            return start <= nowMs && (isAlways || end > nowMs) && !paused;
        }) || schedules.some(schedule => isScheduleSegmentActiveNow(schedule, nowDate));

        const isLocked = toggle.checked && anyActive;
        toggle.disabled = isLocked;
        const label = toggle.closest('.enforcement-switch-with-tip');
        const tooltip = label?.querySelector('.enforcement-switch-tooltip');
        if (tooltip) {
            tooltip.textContent = isLocked ? tSettings('settingsEnforcementLockedTooltip') : '';
            tooltip.classList.toggle('hidden', !isLocked);
        }
    } catch (e) {
        // Can't determine lock state — leave unlocked
        toggle.disabled = false;
        const label = toggle.closest('.enforcement-switch-with-tip');
        const tooltip = label?.querySelector('.enforcement-switch-tooltip');
        if (tooltip) {
            tooltip.textContent = '';
            tooltip.classList.add('hidden');
        }
    }
}

// Per-browser metadata: label + extension store URL (Chromium-family
// browsers all use the Chrome Web Store listing).
export const BROWSER_STORE_LINKS = {
    chrome: { label: 'Chrome', url: 'https://chromewebstore.google.com/detail/redd-focus-hide-distracti/hhblkhfdjijdinijakbmcpkmdfhoadcd' },
    brave: { label: 'Brave', url: 'https://chromewebstore.google.com/detail/redd-focus-hide-distracti/hhblkhfdjijdinijakbmcpkmdfhoadcd' },
    edge: { label: 'Edge', url: 'https://microsoftedge.microsoft.com/addons/detail/redd-focus-hide-distract/gmjfgjdhnhcegfelcddbdljdffiaepam' },
    firefox: { label: 'Firefox', url: 'https://addons.mozilla.org/en-US/firefox/addon/reddfocus/' },
    safari: { label: 'Safari', url: 'macappstore://apps.apple.com/app/id1660218371' },
};

// On macOS we block Safari + Chromium browsers via the Automation
// (Apple Events) watcher rather than the browser extension — so for
// these the onboarding "compliance" is about the per-browser Automation
// grant, not whether ReDD Focus is installed/enabled. Firefox stays on
// the extension path. Non-macOS keeps the extension model everywhere.
export const AUTOMATION_BROWSER_KEYS = ['chrome', 'brave', 'edge', 'safari'];
export const MAC_BLOCKING_METHOD_KEYS = ['safari', 'chrome', 'edge', 'brave'];
/** @deprecated use MAC_BLOCKING_METHOD_KEYS */
export const MAC_CHROMIUM_BLOCKING_KEYS = MAC_BLOCKING_METHOD_KEYS;

export function installedMacBlockingMethodKeys(browsers = {}) {
    return MAC_BLOCKING_METHOD_KEYS.filter((key) => browsers[key]?.installed);
}

export function getBlockingMethodsMap() {
    return state.appData?.settings?.blockingMethods || {};
}

export function browserBlockingMethod(key) {
    if (!state.isMacOSDesktop || !MAC_BLOCKING_METHOD_KEYS.includes(key)) {
        if (state.isMacOSDesktop && key === 'firefox') return 'extension';
        return 'extension';
    }
    return getBlockingMethodsMap()[key] || 'automation';
}

export function browserUsesAutomation(key) {
    if (!state.isMacOSDesktop) return false;
    if (key === 'firefox') return false;
    if (MAC_BLOCKING_METHOD_KEYS.includes(key)) {
        return browserBlockingMethod(key) === 'automation';
    }
    return false;
}

// key -> 'granted' | 'denied' | 'unknown', refreshed from
// `web_automation_permission_status` (a no-prompt native query). Empty
// until the first refresh; treated as 'unknown' per key.
export let lastAutomationPermissionByKey = {};
let lastAutomationRunningByKey = {};
let lastAutomationPermissionFetchAt = 0;
// False until the first successful macOS Automation status fetch; while
// false, automation browsers are treated as compliant so the setup banner
// doesn't flash "Allow Automation…" during startup.
let automationPermissionStatusReady = false;
export const AUTOMATION_PERMISSION_FETCH_MIN_MS = 2000;

// Pull the live per-browser Automation decision (no consent prompt) and
// cache it by browser key. Safe to call on any platform — no-ops off
// macOS. Returns the cached map for convenience.
export function normalizeLaunchProbeBrowsers(browserKeyOrLabels) {
    if (browserKeyOrLabels == null) return null;
    const list = Array.isArray(browserKeyOrLabels) ? browserKeyOrLabels : [browserKeyOrLabels];
    const keys = list.map((b) => browserKeyFromLabel(b) || b).filter(Boolean);
    return keys.length > 0 ? keys : null;
}

export async function refreshAutomationPermissionStatus({
    force = false,
    launchProbe = false,
    launchProbeBrowser = null,
    launchProbeBrowsers = null,
} = {}) {
    if (__ANDROID_BUILD__) return lastAutomationPermissionByKey;
    if (!state.isMacOSDesktop) return lastAutomationPermissionByKey;
    const now = Date.now();
    if (!force && now - lastAutomationPermissionFetchAt < AUTOMATION_PERMISSION_FETCH_MIN_MS) {
        return lastAutomationPermissionByKey;
    }
    try {
        const probeList = launchProbeBrowsers ?? normalizeLaunchProbeBrowsers(launchProbeBrowser);
        const list = await tauriAPI.webAutomationPermissionStatus({
            launchProbe,
            launchProbeBrowser: probeList ? null : launchProbeBrowser,
            launchProbeBrowsers: probeList,
        });
        lastAutomationPermissionFetchAt = now;
        const map = {};
        const runningMap = {};
        for (const info of (list || [])) {
            const key = browserKeyFromLabel(info.label || info.browser);
            if (key) {
                map[key] = info.state; // 'granted' | 'denied' | 'unknown'
                runningMap[key] = !!info.running;
            }
        }
        lastAutomationPermissionByKey = map;
        lastAutomationRunningByKey = runningMap;
        if (state.isMacOSDesktop) automationPermissionStatusReady = true;
    } catch (e) {
        console.warn('[automation] permission status fetch failed:', e);
    }
    return lastAutomationPermissionByKey;
}

// Unified onboarding compliance status that knows about the macOS
// Automation model. For Automation browsers, mirrors
// `automationBrowserRowMode`: only flag when the browser is running
// and we know access is missing — closed browsers with unknown status
// stay compliant so the setup banner doesn't nag prematurely. Falls
// back to the extension compliance for Firefox / non-macOS.
export function automationBrowserIsRunning(key, browserScan) {
    if (automationPermissionStatusReady && Object.prototype.hasOwnProperty.call(lastAutomationRunningByKey, key)) {
        return !!lastAutomationRunningByKey[key];
    }
    return !!browserScan?.present;
}

export function effectiveBrowserComplianceStatus(key, browsers) {
    if (browserUsesAutomation(key)) {
        const browserScan = (browsers || {})[key];
        if (!automationPermissionStatusReady) {
            // Before the first permission fetch, still surface a running
            // browser the onboarding scan sees — avoids hiding the setup
            // banner when Chrome is open but the Automation cache is cold.
            if (browserScan?.present) return 'needs-automation';
            return 'compliant';
        }
        const mode = automationBrowserRowMode(key, browserScan);
        if (mode === 'granted' || mode === 'awaiting-open') return 'compliant';
        return 'needs-automation';
    }
    return browserComplianceStatus(key, (browsers || {})[key]) || 'needs-install';
}

// Compute per-step status for the migration UI:
//   - 'compliant': extension installed, enabled, allowed in private, allowed on all websites
//   - 'needs-deduplicate': Safari has both bundled + standalone ReDD Focus
//   - 'needs-website-access': Safari installed + enabled + private, but not allowed on all websites
//   - 'needs-private': installed + enabled but not allowed in private
//   - 'needs-enable': installed but disabled
//   - 'needs-install': extension not installed
// Returns null if the browser itself isn't installed on the machine.
export function browserComplianceStatus(key, b) {
    if (!b || !b.installed) return null;
    const profiles = b.profiles || [];
    const def = profiles.find(p => p.isDefault) || profiles[0];
    if (key === 'safari') {
        if (b.duplicateExtensions?.detected) return 'needs-deduplicate';
        if (b.needsFdaAccess || profiles.some(p => /Full Disk Access/i.test(p.note || ''))) {
            return 'needs-fda';
        }
        if (!profiles.length || profiles.some(p => !p.installed)) return 'needs-install';
        if (profiles.some(p => p.enabled !== true)) return 'needs-enable';
        if (profiles.some(p => p.privateBrowsing === false)) return 'needs-private';
        if (profiles.some(p => p.websiteAccessAll === false)) return 'needs-website-access';
        return 'compliant';
    }
    if (!def || !def.installed) return 'needs-install';
    const enabled = def.enabled;
    if (enabled === false) return 'needs-enable';
    const priv = def.privateBrowsing;
    if (priv !== true) return 'needs-private';
    if (key === 'firefox' && state.isMacOSDesktop && b.nativeHostReady === false) {
        return 'needs-native-host';
    }
    return 'compliant';
}

export function statusLabel(key, status) {
    switch (status) {
        case 'compliant': return tSettings('migrationComplianceOk');
        case 'needs-deduplicate': return tSettings('migrationStatusDuplicateSafari');
        case 'needs-fda': return tSettings('migrationStatusGrantFda');
        case 'needs-website-access': return tSettings('migrationStatusAllowAllWebsites');
        case 'needs-private': return tSettings('migrationStatusAllowPrivate');
        case 'needs-enable': return tSettings('migrationStatusEnableExtension');
        case 'needs-native-host': return tSettings('migrationStatusNativeHost');
        case 'needs-install': return tSettings('migrationStatusInstall');
        default: return tSettings('migrationStatusInstall');
    }
}

export function safariProfileLabel(profile) {
    const name = String(profile && profile.name ? profile.name : '').trim();
    const legacyDefault = SETTINGS_TRANSLATIONS.en.migrationSafariProfileDefaultName;
    if (!name || name === legacyDefault || name === '(Default Safari profile)') {
        return tSettings('migrationSafariProfileDefaultName');
    }
    return name;
}

export function safariProfileStatusHint(b, status) {
    const profiles = b && Array.isArray(b.profiles) ? b.profiles : [];
    if (profiles.length <= 1) return null;

    const failing = profiles.filter(profile => {
        switch (status) {
            case 'needs-install': return !profile.installed;
            case 'needs-enable': return !profile.installed || profile.enabled === false;
            case 'needs-private': return !profile.installed || profile.enabled !== true || profile.privateBrowsing !== true;
            case 'needs-website-access': return !profile.installed || profile.enabled !== true || profile.privateBrowsing !== true || profile.websiteAccessAll !== true;
            default: return false;
        }
    });
    if (!failing.length) return null;

    const labels = failing.slice(0, 3).map(safariProfileLabel);
    const more = failing.length > labels.length
        ? tSettingsFmt('migrationSafariProfilesMore', { n: failing.length - labels.length })
        : '';
    return `${tSettings('migrationSafariProfilesAffected')} ${labels.join(', ')}${more}.`;
}

export function extensionsUrl(key) {
    switch (key) {
        case 'chrome': return 'chrome://extensions';
        case 'edge': return 'edge://extensions';
        case 'brave': return 'brave://extensions';
        case 'firefox': return 'about:addons';
        case 'safari': return tSettings('migrationSafariSettingsPath');
        default: return 'extensions';
    }
}

export function isCopyableExtensionsTarget(key) {
    return key !== 'safari';
}

// Renders an inline URL chip with a small copy-to-clipboard icon.
// Clicking the chip copies the URL so the user can paste it into
// the browser's address bar.
export const COPY_ICON_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-left:4px;opacity:0.7"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

export function extensionsUrlChipHtml(key) {
    const url = extensionsUrl(key);
    if (!isCopyableExtensionsTarget(key)) {
        return `<span class="migration-inline-url-btn migration-copy-chip-static">${url}</span>`;
    }
    return `<button type="button" class="migration-inline-url-btn migration-copy-chip" data-copy-url="${url}">${url}${COPY_ICON_SVG}</button>`;
}

// Attach clipboard copy behaviour to any .migration-copy-chip inside
// the given root element.
export function attachCopyChipHandlers(root) {
    root.querySelectorAll('.migration-copy-chip').forEach(btn => {
        btn.addEventListener('click', async () => {
            const url = btn.dataset.copyUrl;
            try {
                await navigator.clipboard.writeText(url);
                btn.classList.add('copied');
                const orig = btn.innerHTML;
                btn.innerHTML = tSettings('migrationCopied');
                setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('copied'); }, 1500);
            } catch (e) {
                console.warn('[migration] clipboard copy failed:', e);
            }
        });
    });
}

export function privateModeNoun(key) {
    switch (key) {
        case 'chrome': return tSettings('migrationPrivateIncognitoChrome');
        case 'edge': return tSettings('migrationPrivateIncognitoEdge');
        case 'brave': return tSettings('migrationPrivateIncognitoBrave');
        case 'firefox': return tSettings('migrationPrivateIncognitoFirefox');
        case 'safari': return tSettings('migrationPrivateIncognitoSafari');
        default: return tSettings('migrationPrivateIncognito');
    }
}

// Open the user's extension settings for a given browser. For Safari
// we prefer SafariServices' showPreferencesForExtension (via the
// in-process Swift bridge), which deep-links to ReDD Focus in
// Safari → Settings → Extensions. The Rust command retries after
// launching Safari when needed, then falls back to AppleScript for
// dev builds (`cargo tauri dev`) and other cases where SafariServices
// can't find the host extension. AppleScript needs Accessibility
// permission for ReDD Blocker (or your terminal, when running dev).
export async function openExtensionSettings(key) {
    if (key === 'safari') {
        try {
            await invoke('open_safari_extension_settings');
            return;
        } catch (e) {
            console.warn('[migration] safari extension settings failed, falling back:', e);
        }
    }
    return invoke('open_browser_extension_settings', { browser: key });
}

export function browserStatusHint(key, entry, b, status) {
    const hasMultipleSafariProfiles = key === 'safari' && Array.isArray(b && b.profiles) && b.profiles.length > 1;
    const safariSuffix = key === 'safari'
        ? ` ${safariProfileStatusHint(b, status) || tSettings('migrationSafariCheckEveryProfile')}`
        : '';
    switch (status) {
        case 'needs-enable':
            return key === 'safari'
                ? hasMultipleSafariProfiles
                    ? tSettingsFmt('migrationHintEnableSafariMulti', { SUFFIX: safariSuffix })
                    : tSettings('migrationHintEnableSafariOne')
                : tSettingsFmt('migrationHintEnableBrowser', { BROWSER: entry.label });
        case 'needs-private':
            return key === 'safari'
                ? hasMultipleSafariProfiles
                    ? tSettingsFmt('migrationHintPrivateSafariMulti', { SUFFIX: safariSuffix })
                    : tSettings('migrationHintPrivateSafariOne')
                : tSettingsFmt('migrationHintPrivateBrowser', { BROWSER: entry.label });
        case 'needs-website-access':
            return hasMultipleSafariProfiles
                ? tSettingsFmt('migrationHintWebsitesSafariMulti', { SUFFIX: safariSuffix })
                : tSettings('migrationHintWebsitesSafariOne');
        default:
            return '';
    }
}

export function renderSafariDuplicateExtensionPanel(row, key) {
    if (__ANDROID_BUILD__) return;
    const panel = document.createElement('div');
    panel.className = 'safari-duplicate-panel';

    const intro = document.createElement('p');
    intro.className = 'safari-duplicate-intro';
    intro.innerHTML = tSettings('migrationSafariDuplicateIntroHtml');
    panel.appendChild(intro);

    const instructions = document.createElement('div');
    instructions.className = 'safari-duplicate-instructions';

    const instructionsHeading = document.createElement('div');
    instructionsHeading.className = 'safari-duplicate-instructions-heading';
    instructionsHeading.textContent = tSettings('migrationSafariDuplicateInstructionsHeading');
    instructions.appendChild(instructionsHeading);

    instructions.appendChild(buildSafariDuplicateInstructionStep(1, 'migrationSafariDuplicateStep1Html'));
    instructions.appendChild(buildSafariDuplicateInstructionStep(2, 'migrationSafariDuplicateStep2Html'));
    panel.appendChild(instructions);

    const actionsRow = document.createElement('div');
    actionsRow.className = 'migration-actions-row safari-duplicate-actions';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'migration-primary-btn safari-duplicate-open-btn';
    openBtn.textContent = tSettings('migrationSafariDuplicateOpenBtn');
    openBtn.addEventListener('click', () => {
        openExtensionSettings(key).catch(e => console.warn('[migration] open ext settings:', e));
    });
    actionsRow.appendChild(openBtn);

    const helpToggle = document.createElement('button');
    helpToggle.type = 'button';
    helpToggle.className = 'safari-duplicate-help-toggle';
    if (state.migrationSafariDuplicateHelpExpanded) helpToggle.classList.add('open');
    helpToggle.setAttribute('aria-expanded', state.migrationSafariDuplicateHelpExpanded ? 'true' : 'false');
    helpToggle.innerHTML = `<span>${tSettings('migrationSafariDuplicateHelpLink')}</span><svg class="safari-duplicate-help-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"></polyline></svg>`;
    actionsRow.appendChild(helpToggle);

    panel.appendChild(actionsRow);

    const helpWrap = document.createElement('div');
    helpWrap.className = 'safari-duplicate-help-wrap';
    helpWrap.classList.toggle('hidden', !state.migrationSafariDuplicateHelpExpanded);

    const helpText = document.createElement('p');
    helpText.className = 'safari-duplicate-help-text';
    helpText.textContent = tSettings('migrationSafariDuplicateHelpText');
    helpWrap.appendChild(helpText);
    panel.appendChild(helpWrap);

    helpToggle.addEventListener('click', () => {
        state.migrationSafariDuplicateHelpExpanded = !state.migrationSafariDuplicateHelpExpanded;
        helpWrap.classList.toggle('hidden', !state.migrationSafariDuplicateHelpExpanded);
        helpToggle.classList.toggle('open', state.migrationSafariDuplicateHelpExpanded);
        helpToggle.setAttribute('aria-expanded', state.migrationSafariDuplicateHelpExpanded ? 'true' : 'false');
    });

    row.appendChild(panel);
}

export function buildSafariDuplicateInstructionStep(stepNum, translationKey, extraClass = '') {
    const step = document.createElement('div');
    step.className = `safari-duplicate-step${extraClass ? ` ${extraClass}` : ''}`;

    const num = document.createElement('span');
    num.className = 'safari-duplicate-step-num';
    num.textContent = String(stepNum);
    num.setAttribute('aria-hidden', 'true');

    const body = document.createElement('div');
    body.className = 'safari-duplicate-step-body';
    body.innerHTML = tSettings(translationKey);

    step.appendChild(num);
    step.appendChild(body);
    return step;
}

// Display order for the extension-setup rows. Safari sits above the
// Chromium browsers; Firefox stays last.
export const MIGRATION_BROWSER_ORDER = ['safari', 'chrome', 'brave', 'edge', 'firefox'];

export function migrationBrowserKeys(state) {
    const browsers = state?.browsers || {};
    const detectedKeys = MIGRATION_BROWSER_ORDER.filter(k => {
        const b = browsers[k];
        return b && b.installed;
    });
    return detectedKeys.length > 0 ? detectedKeys : ['chrome'];
}

// HTML for the extension-setup header (bold title + lighter subtitle).
// On macOS the path is Automation for Safari/Chromium plus — only when
// Firefox is installed — the ReDD Focus extension in Firefox, so the
// subtitle is built from live state. Other platforms keep the
// extension-everywhere copy.
export function migrationExtHeaderCopy(state) {
    if (!appState.isMacOSDesktop) return null;
    const focusLogoHtml =
        `<img src="${logoReddFocusUrl}" alt="" class="welcome-reddfocus-inline-logo" aria-hidden="true"> `;
    const browsers = state?.browsers || appState.lastMigrationBrowserState?.browsers || {};
    const firefoxInstalled = !!(browsers.firefox && browsers.firefox.installed);
    return {
        titleHtml: tSettings('migrationExtTitleMac'),
        subtitleHtml: (firefoxInstalled
            ? tSettings('migrationExtSubMacFirefox')
            : tSettings('migrationExtSubMac')).replace('{FOCUS}', focusLogoHtml),
    };
}

export function migrationMacCopyKey(state) {
    const browsers = state?.browsers || appState.lastMigrationBrowserState?.browsers || {};
    const firefoxInstalled = !!(browsers.firefox && browsers.firefox.installed);
    return `${getSettingsLanguage()}:${firefoxInstalled ? 1 : 0}`;
}

export function invalidateMigrationMacCopyCache() {
    if (__ANDROID_BUILD__) return;
    state.lastMigrationHeaderCopyKey = '';
    state.lastMigrationHowtoCopyKey = '';
}

export function syncMigrationMacHowto(state) {
    if (__ANDROID_BUILD__) return;
    if (!appState.isMacOSDesktop) return;
    const focusLogoHtml =
        `<img src="${logoReddFocusUrl}" alt="" class="welcome-reddfocus-inline-logo" aria-hidden="true"> `;
    const browsers = state?.browsers || appState.lastMigrationBrowserState?.browsers || {};
    const firefoxInstalled = !!(browsers.firefox && browsers.firefox.installed);
    const li1 = document.getElementById('migration-howto-li1');
    const li2 = document.getElementById('migration-howto-li2');
    const li3 = document.getElementById('migration-howto-li3');
    const copyKey = migrationMacCopyKey(state);
    if (copyKey !== appState.lastMigrationHowtoCopyKey) {
        if (li1) li1.innerHTML = tSettings('migrationExtStep1Mac');
        if (li2) {
            li2.innerHTML = tSettings('migrationExtStep2MacFirefox').replace('{FOCUS}', focusLogoHtml);
        }
        appState.lastMigrationHowtoCopyKey = copyKey;
    }
    if (li2) li2.classList.toggle('hidden', !firefoxInstalled);
    if (li3) li3.classList.add('hidden');
}

export function isMigrationFreshPostPhase() {
    return !!document.getElementById('migration-post-title-row')?.classList.contains('hidden');
}

export function migrationSetupAllCompliant(state) {
    const browsers = state?.browsers || {};
    const keys = migrationBrowserKeys(state);
    if (keys.length === 0) return false;
    return keys.every(k => effectiveBrowserComplianceStatus(k, browsers) === 'compliant');
}

export function isMacFreshMigrationPost() {
    return state.isMacOSDesktop && isMigrationFreshPostPhase();
}

export function syncMigrationPostHeader(state) {
    if (__ANDROID_BUILD__) return;
    const header = document.getElementById('migration-post-header');
    const checklist = document.getElementById('migration-checklist');
    const readyBanner = document.getElementById('migration-setup-ready-banner');
    const readyText = document.getElementById('migration-setup-ready-banner-text');
    if (!header) return;

    const freshPost = isMigrationFreshPostPhase();
    const allReady = migrationSetupAllCompliant(state);
    const showReadyBanner = freshPost && allReady;

    if (readyBanner) {
        readyBanner.classList.toggle('hidden', !showReadyBanner);
        if (showReadyBanner && readyText) {
            readyText.innerHTML = tSettings('migrationSetupAllReady');
        }
    }

    const skipBtn = document.getElementById('migration-skip-btn');
    if (skipBtn) skipBtn.classList.toggle('hidden', allReady);

    if (!isMacFreshMigrationPost()) {
        header.classList.add('hidden');
        checklist?.classList.remove('hidden');
        return;
    }

    header.classList.remove('hidden');
    const copy = migrationExtHeaderCopy(state);
    if (copy) {
        const shieldLogo = document.getElementById('migration-post-header-shield-logo');
        const titleEl = document.getElementById('migration-post-header-title');
        const subEl = document.getElementById('migration-post-header-subtitle');
        const copyKey = migrationMacCopyKey(state);
        if (copyKey !== appState.lastMigrationHeaderCopyKey) {
            if (shieldLogo) shieldLogo.src = logoReddShieldUrl;
            if (titleEl) titleEl.textContent = copy.titleHtml;
            if (subEl) subEl.innerHTML = copy.subtitleHtml;
            appState.lastMigrationHeaderCopyKey = copyKey;
        }
    }
    checklist?.classList.add('hidden');
}

export function migrationExtLinesHtml(state) {
    const focusLogoHtml =
        `<img src="${logoReddFocusUrl}" alt="" class="welcome-reddfocus-inline-logo" aria-hidden="true"> `;
    if (appState.isMacOSDesktop) {
        if (isMacFreshMigrationPost()) {
            return '';
        }
        const copy = migrationExtHeaderCopy(state);
        if (copy) {
            return `<span style="font-weight:400;font-size:1.25em">${copy.titleHtml}</span><br>${copy.subtitleHtml}`;
        }
    }
    return tSettings('migrationChecklistExtLinesHtml').replace('{LOGO}', focusLogoHtml);
}

// After the user grants/opens settings, nudge a couple of quick
// re-checks so the row flips to "Allowed" without waiting for the next
// regular poll tick. Pass `launchProbe: true` only here (and other
// explicit post-settings actions) — never on background banner polls,
// or we'd relaunch browsers the enforcer just closed.
export function schedulePostGrantPoll() {
    setTimeout(() => pollMigrationCompliance({ launchProbe: true }), 1200);
    setTimeout(() => pollMigrationCompliance({ launchProbe: true }), 3500);
}

export function scheduleAutomationVerificationPoll(browserKeyOrLabels = null) {
    const probeTargets = normalizeLaunchProbeBrowsers(browserKeyOrLabels);
    const verify = async () => {
        await refreshAutomationPermissionStatus({
            force: true,
            launchProbe: false,
            launchProbeBrowsers: probeTargets,
        });
        try {
            const fresh = await invoke('onboarding_state');
            lastOnboardingState = fresh;
            await updateBehaviourChangeBanner(fresh);
            await syncEnforcerClosedBannersWithCompliance(fresh);
        } catch (_) { /* no-op */ }
    };
    setTimeout(verify, 1200);
    setTimeout(verify, 3500);
}

// Build an onboarding row for a macOS Automation-blocked browser
// (Safari / Chromium). States:
//   granted           -> green "Allowed" badge (only when last live check
//                        was granted — may stay while the browser is closed)
//   awaiting-open     -> grey row: browser not running and we cannot confirm
//                        a grant (unknown / denied / never probed)
//   needs-grant       -> browser open, not granted yet: "Grant access" prompt
//   denied            -> browser open, revoked: deep-link to System Settings
export function automationBrowserRowMode(key, browserScan) {
    const perm = lastAutomationPermissionByKey[key] || 'unknown';
    const running = automationBrowserIsRunning(key, browserScan);
    if (perm === 'granted') return 'granted';
    if (!running) return 'awaiting-open';
    if (perm === 'denied') return 'denied';
    return 'needs-grant';
}

export function buildAutomationBrowserRow(key, entry, browserScan) {
    const mode = automationBrowserRowMode(key, browserScan);
    const granted = mode === 'granted';
    const denied = mode === 'denied';
    const awaitingOpen = mode === 'awaiting-open';
    const status = granted ? 'compliant' : (awaitingOpen ? 'automation-awaiting-open' : 'needs-enable');

    const row = document.createElement('div');
    row.className = `migration-browser-row ${status}`;

    const header = document.createElement('div');
    header.className = 'migration-browser-header';

    const name = document.createElement('span');
    name.className = 'migration-browser-name';
    const icon = document.createElement('img');
    icon.className = 'migration-browser-icon';
    icon.src = browserIconUrl(key);
    icon.alt = '';
    icon.setAttribute('aria-hidden', 'true');
    name.appendChild(icon);
    name.appendChild(document.createTextNode(entry.label));
    header.appendChild(name);

    const badge = document.createElement('span');
    badge.className = `migration-browser-badge ${status}`;
    badge.textContent = granted
        ? tSettings('migrationBadgeAutomationOn')
        : (awaitingOpen
            ? tSettings('migrationBadgeAutomationUnknown')
            : tSettings('migrationBadgeAutomationOff'));
    header.appendChild(badge);
    row.appendChild(header);

    if (granted) return row;

    const hint = document.createElement('div');
    hint.className = 'migration-browser-hint';
    hint.textContent = awaitingOpen
        ? tSettingsFmt('migrationAutomationAwaitingOpenHint', { browser: entry.label })
        : (denied
            ? tSettingsFmt('migrationAutomationDeniedHint', { browser: entry.label })
            : tSettingsFmt('migrationAutomationGrantHint', { browser: entry.label }));
    row.appendChild(hint);

    if (awaitingOpen) {
        const delayNote = document.createElement('div');
        delayNote.className = 'migration-browser-hint migration-delay-note';
        delayNote.textContent = tSettings('migrationDelayDetectionNote');
        row.appendChild(delayNote);
        return row;
    }

    const actionsRow = document.createElement('div');
    actionsRow.className = 'migration-actions-row';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'migration-primary-btn';
    const restore = (label) => setTimeout(() => { btn.textContent = label; }, 1800);

    if (denied) {
        const label = tSettings('migrationOpenAutomationSettings');
        btn.textContent = label;
        btn.addEventListener('click', async () => {
            try {
                await tauriAPI.openAutomationSettings();
                btn.textContent = tSettings('migrationOpened');
            } catch (e) {
                console.warn('[automation] open settings failed:', e);
                btn.textContent = tSettings('migrationFailed');
            }
            restore(label);
            schedulePostGrantPoll();
        });
    } else {
        const label = tSettingsFmt('migrationGrantAutomation', { browser: entry.label });
        btn.textContent = label;
        btn.addEventListener('click', async () => {
            try {
                // Launches the browser and surfaces the system Automation
                // prompt for it. If the prompt can't appear (already
                // answered once), fall back to the Settings deep-link.
                await tauriAPI.requestAutomationPermission(entry.label);
                btn.textContent = tSettings('migrationGrantAutomationOpened');
            } catch (e) {
                console.warn('[automation] request permission failed, opening settings:', e);
                try { await tauriAPI.openAutomationSettings(); } catch (_) { /* no-op */ }
                btn.textContent = tSettings('migrationGrantAutomationOpened');
            }
            restore(label);
            schedulePostGrantPoll();
        });
    }
    actionsRow.appendChild(btn);

    const steps = automationScreenshotSteps();
    if (steps.length) {
        const showMeBtn = document.createElement('button');
        showMeBtn.type = 'button';
        showMeBtn.className = 'migration-show-me-btn';
        showMeBtn.setAttribute('aria-expanded', 'false');
        showMeBtn.innerHTML = `<span>${tSettings('migrationShowMeHow')}</span><svg class="migration-show-me-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"></polyline></svg>`;
        actionsRow.appendChild(showMeBtn);

        const delayNote = document.createElement('div');
        delayNote.className = 'migration-browser-hint migration-delay-note';
        delayNote.textContent = tSettings('migrationDelayDetectionNote');
        row.appendChild(actionsRow);
        row.appendChild(delayNote);

        const expandKey = `${key}-automation`;
        const screenshotsWrap = document.createElement('div');
        screenshotsWrap.className = 'migration-screenshots-wrap hidden';

        const screenshotsContainer = document.createElement('div');
        screenshotsContainer.className = 'extension-enforcer-screenshots screenshots-row';

        steps.forEach((step, i) => {
            const figure = document.createElement('figure');
            figure.className = 'extension-enforcer-step';
            const cap = formatExtensionScreenshotCaption(step, i);
            if (cap) {
                const caption = document.createElement('figcaption');
                caption.className = 'extension-enforcer-step-label';
                caption.textContent = cap;
                figure.appendChild(caption);
            }
            const img = document.createElement('img');
            img.className = 'extension-enforcer-screenshot';
            img.src = step.src;
            img.alt = screenshotAltText(step, i, cap);
            figure.appendChild(img);
            screenshotsContainer.appendChild(figure);
        });

        applyScreenshotContainerLayout(screenshotsContainer, steps);

        screenshotsWrap.appendChild(screenshotsContainer);
        row.appendChild(screenshotsWrap);

        showMeBtn.addEventListener('click', () => {
            const isOpen = showMeBtn.classList.toggle('open');
            screenshotsWrap.classList.toggle('hidden', !isOpen);
            showMeBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
            if (isOpen) state.migrationShowMeHowExpandedKeys.add(expandKey);
            else state.migrationShowMeHowExpandedKeys.delete(expandKey);
        });

        if (state.migrationShowMeHowExpandedKeys.has(expandKey)) {
            showMeBtn.classList.add('open');
            screenshotsWrap.classList.remove('hidden');
            showMeBtn.setAttribute('aria-expanded', 'true');
        }
    } else {
        row.appendChild(actionsRow);
    }

    return row;
}

export function migrationBrowserRenderSignature(state) {
    const browsers = state?.browsers || {};
    return migrationBrowserKeys(state).map(k => {
        if (browserUsesAutomation(k)) {
            const present = browsers[k]?.present ? 1 : 0;
            return `${k}:auto:${lastAutomationPermissionByKey[k] || 'unknown'}:${present}`;
        }
        const b = browsers[k];
        const status = browserComplianceStatus(k, b) || 'needs-install';
        if (k === 'firefox') {
            return `${k}:${status}:${b?.nativeHostReady ? 1 : 0}`;
        }
        if (k === 'safari' && b?.profiles?.length) {
            const profileSig = b.profiles.map(p =>
                `${p.installed ? 1 : 0}${p.enabled === true ? 1 : p.enabled === false ? 0 : '?'}${p.privateBrowsing === true ? 1 : p.privateBrowsing === false ? 0 : '?'}${p.websiteAccessAll === true ? 1 : p.websiteAccessAll === false ? 0 : '?'}`
            ).join(';');
            return `${k}:${status}:${b.needsFdaAccess ? 'fda' : ''}:${b.duplicateExtensions?.detected ? 'dup' : ''}:${profileSig}`;
        }
        return `${k}:${status}`;
    }).join('|');
}

export function updateMigrationBrowserChecklist(state) {
    if (__ANDROID_BUILD__) return;
    const checklistItem = document.getElementById('migration-checklist-ext');
    const browsers = state?.browsers || {};
    const keys = migrationBrowserKeys(state);

    const howto = document.getElementById('migration-howto');
    const anyMissing = keys.some(k => effectiveBrowserComplianceStatus(k, browsers) !== 'compliant');
    const showHowto = anyMissing;
    if (howto) howto.classList.toggle('hidden', !showHowto);

    if (!checklistItem) return;
    const allCompliant = keys.length > 0
        && keys.every(k => effectiveBrowserComplianceStatus(k, browsers) === 'compliant');
    if (allCompliant) {
        checklistItem.classList.remove('checklist-todo');
        checklistItem.classList.add('checklist-done');
        const mark = checklistItem.querySelector('.checklist-mark');
        if (mark) mark.textContent = '✓';
    } else {
        checklistItem.classList.remove('checklist-done');
        checklistItem.classList.add('checklist-todo');
        const mark = checklistItem.querySelector('.checklist-mark');
        if (mark) mark.textContent = '○';
    }
}

export function renderBrowserInstallButtons(state, { force = false } = {}) {
    if (__ANDROID_BUILD__) return;
    appState.lastMigrationBrowserState = state;
    void applyEnforcementDescCopy(state);
    // Keep the header subtitle in sync with the live scan (the macOS
    // copy depends on whether Firefox is installed).
    syncMigrationPostHeader(state);
    if (appState.isMacOSDesktop) syncMigrationMacHowto(state);
    const extLines = document.getElementById('migration-checklist-ext-lines');
    if (extLines) extLines.innerHTML = migrationExtLinesHtml(state);
    const sig = migrationBrowserRenderSignature(state);
    if (!force && sig === appState.lastMigrationBrowserRenderSignature) {
        updateMigrationBrowserChecklist(state);
        return;
    }
    appState.lastMigrationBrowserRenderSignature = sig;

    const container = document.getElementById('migration-browser-buttons');
    if (!container) return;
    container.innerHTML = '';

    const browsers = state && state.browsers ? state.browsers : {};

    // Show every browser we detect on disk (regardless of running
    // state). During migration the user may need to install the
    // extension in browsers they haven't opened yet — only filtering
    // to running browsers (as the in-session compliance banner does)
    // would hide those.
    const keys = migrationBrowserKeys(state);

    for (const key of keys) {
        const entry = BROWSER_STORE_LINKS[key];
        if (!entry) continue;

        // macOS: Safari + Chromium block via Automation, not the
        // extension — render a permission-grant row instead.
        if (browserUsesAutomation(key)) {
            container.appendChild(buildAutomationBrowserRow(key, entry, browsers[key]));
            continue;
        }

        const status = browserComplianceStatus(key, browsers[key]) || 'needs-install';

        const row = document.createElement('div');
        row.className = `migration-browser-row ${status}`;

        // Two-line row layout: header (browser name + status badge)
        // on top, action (URL + Copy, or hint text) below. Keeps each
        // row readable at typical window widths and avoids the prior
        // cramped single-line stacking.
        const header = document.createElement('div');
        header.className = 'migration-browser-header';

        const name = document.createElement('span');
        name.className = 'migration-browser-name';

        const icon = document.createElement('img');
        icon.className = 'migration-browser-icon';
        icon.src = browserIconUrl(key);
        icon.alt = '';
        icon.setAttribute('aria-hidden', 'true');
        name.appendChild(icon);

        name.appendChild(document.createTextNode(entry.label));
        header.appendChild(name);

        const badge = document.createElement('span');
        badge.className = `migration-browser-badge ${status}`;
        switch (status) {
            case 'compliant': badge.textContent = statusLabel(key, status); break;
            case 'needs-deduplicate': badge.textContent = tSettings('migrationBadgeDuplicateSafari'); break;
            case 'needs-install': badge.textContent = tSettings('migrationBadgeNotInstalled'); break;
            case 'needs-enable': badge.textContent = tSettings('migrationBadgeDisabled'); break;
            case 'needs-private': badge.textContent = tSettings('migrationBadgeNotPrivate'); break;
            case 'needs-native-host': badge.textContent = tSettings('migrationBadgeNativeHost'); break;
            case 'needs-fda': badge.textContent = tSettings('migrationStatusGrantFda'); break;
            case 'needs-website-access': badge.textContent = tSettings('migrationBadgeNoWebsiteAccess'); break;
            default: badge.textContent = tSettings('migrationBadgeNotInstalled');
        }
        header.appendChild(badge);

        row.appendChild(header);

        if (status === 'needs-fda') {
            const hint = document.createElement('div');
            hint.className = 'migration-browser-hint migration-browser-after-hint';
            hint.innerHTML = tSettings('safariFdaSetupHintHtml');
            row.appendChild(hint);
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'migration-primary-btn';
            btn.textContent = tSettings('safariFdaOnboardingGrantBtn');
            btn.addEventListener('click', () => {
                void showSafariFdaOnboardingOverlay().then(async () => {
                    const fresh = await invoke('onboarding_state');
                    renderBrowserInstallButtons(fresh, { force: true });
                    await updateBehaviourChangeBanner(fresh);
                });
            });
            const actionsRow = document.createElement('div');
            actionsRow.className = 'migration-actions-row';
            actionsRow.appendChild(btn);
            row.appendChild(actionsRow);
        } else if (status === 'needs-install') {
            // Instruction hint first, then Install button below (matching
            // the needs-enable/private layout where instruction precedes action).
            const afterHint = document.createElement('div');
            afterHint.className = 'migration-browser-hint migration-browser-after-hint';
            const privNoun = privateModeNoun(key);
            if (key === 'firefox') {
                afterHint.innerHTML = appState.isMacOSDesktop
                    ? tSettings('migrationPostInstallFirefoxMacHtml')
                    : tSettings('migrationPostInstallFirefoxHtml');
            } else if (key === 'safari') {
                afterHint.innerHTML = tSettings('migrationPostInstallSafariHtml');
            } else if (appState.isMacOSDesktop) {
                const tpl = tSettings('migrationPostInstallChromiumMacHtml');
                afterHint.innerHTML = tpl
                    .replace('{URL_CHIP}', extensionsUrlChipHtml(key))
                    .replace(/{BROWSER}/g, entry.label)
                    .replace(/{PRIV}/g, privNoun);
                attachCopyChipHandlers(afterHint);
            } else {
                const tpl = tSettings('migrationPostInstallChromiumHtml');
                afterHint.innerHTML = tpl
                    .replace('{URL_CHIP}', extensionsUrlChipHtml(key))
                    .replace(/{BROWSER}/g, entry.label)
                    .replace(/{PRIV}/g, privNoun);
                attachCopyChipHandlers(afterHint);
            }
            row.appendChild(afterHint);

            const installBtn = document.createElement('button');
            installBtn.type = 'button';
            installBtn.className = 'migration-browser-copy';
            installBtn.textContent = tSettings('migrationInstallButton');
            installBtn.title = tSettingsFmt('migrationInstallStoreTitle', { browser: entry.label });
            installBtn.addEventListener('click', async () => {
                try {
                    await invoke('open_url_in_browser', { browser: key, url: entry.url });
                    installBtn.textContent = tSettings('migrationInstallOpened');
                    setTimeout(() => { installBtn.textContent = tSettings('migrationInstallButton'); }, 2000);
                } catch (e) {
                    console.warn('[migration] open_url_in_browser failed, falling back to clipboard:', e);
                    try {
                        await navigator.clipboard.writeText(entry.url);
                        installBtn.textContent = tSettings('migrationUrlCopied');
                        setTimeout(() => { installBtn.textContent = tSettings('migrationInstallButton'); }, 2000);
                    } catch (e2) {
                        installBtn.textContent = tSettings('migrationFailed');
                        setTimeout(() => { installBtn.textContent = tSettings('migrationInstallButton'); }, 2000);
                    }
                }
            });

            const actionsRow = document.createElement('div');
            actionsRow.className = 'migration-actions-row';
            actionsRow.appendChild(installBtn);
            row.appendChild(actionsRow);
        } else if (status === 'needs-deduplicate') {
            renderSafariDuplicateExtensionPanel(row, key);
        } else if (status === 'needs-native-host') {
            const hint = document.createElement('div');
            hint.className = 'migration-browser-hint migration-browser-after-hint';
            hint.innerHTML = tSettings('migrationFirefoxNativeHostHtml');
            row.appendChild(hint);
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'migration-browser-copy';
            btn.textContent = tSettings('migrationFirefoxNativeHostButton');
            btn.addEventListener('click', async () => {
                try {
                    await invoke('ensure_firefox_native_host');
                    const fresh = await invoke('onboarding_state');
                    renderBrowserInstallButtons(fresh, { force: true });
                    await updateBehaviourChangeBanner(fresh);
                } catch (e) {
                    console.warn('[firefox] ensure_firefox_native_host failed:', e);
                }
            });
            const actionsRow = document.createElement('div');
            actionsRow.className = 'migration-actions-row';
            actionsRow.appendChild(btn);
            row.appendChild(actionsRow);
        } else if (status === 'needs-enable' || status === 'needs-private' || status === 'needs-website-access') {
            // Mirror the notification-banner layout for clarity:
            // [optional ✓ Extension installed]
            // instruction text (single line for Chromium / Firefox,
            //   three-step checklist for Safari)
            // [Open Extension Settings] [Show me how ▶]
            // delay note
            // [screenshots wrap, full-row when expanded]
            const isSafari = key === 'safari';

            // "✓ Extension installed" line. Always show for Safari —
            // we bundle the .appex inside ReDD Blocker.app, so install
            // is structurally guaranteed at this point. For Chromium /
            // Firefox we only show it once we've moved past the
            // install step (status !== 'needs-enable') because there
            // the install + enable are distinct user actions.
            if (isSafari || status !== 'needs-enable') {
                const extInstalledLine = document.createElement('div');
                extInstalledLine.className = 'migration-checklist-line migration-checklist-done';
                extInstalledLine.textContent = `✓ ${tSettings('migrationExtensionInstalledMark')}`;
                row.appendChild(extInstalledLine);
            }

            const privNoun = privateModeNoun(key);
            const steps = enforcerScreenshotSteps(key);
            const hasSteps = steps && steps.length;

            if (isSafari) {
                const safariBrowser = browsers[key];
                const profiles = (safariBrowser && Array.isArray(safariBrowser.profiles)) ? safariBrowser.profiles : [];
                const allEnabled = profiles.length > 0 && profiles.every(p => p.enabled === true);
                const allPrivate = profiles.length > 0 && profiles.every(p => p.privateBrowsing === true);
                const allAllSites = profiles.length > 0 && profiles.every(p => p.websiteAccessAll === true);

                const stepDefs = [
                    { label: tSettings('migrationSafariStepEnable'), done: allEnabled },
                    { label: tSettings('migrationSafariStepPrivate'), done: allPrivate },
                    { label: tSettings('migrationSafariStepEveryWebsite'), done: allAllSites },
                ];
                const activeIdx = stepDefs.findIndex(s => !s.done);

                const checklist = document.createElement('div');
                checklist.className = 'migration-safari-steps';

                stepDefs.forEach((step, i) => {
                    const line = document.createElement('div');
                    let klass = 'migration-checklist-line';
                    const lineLabel = tSettingsFmt('migrationSafariChecklistLine', { n: String(i + 1), label: step.label });
                    if (step.done) {
                        klass += ' migration-checklist-done';
                        line.className = klass;
                        line.textContent = `✓ ${lineLabel}`;
                    } else {
                        let iconHtml;
                        if (i === activeIdx) {
                            klass += ' migration-checklist-active';
                            iconHtml = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#b45309" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>`;
                        } else {
                            klass += ' migration-checklist-pending';
                            iconHtml = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8" opacity="0.4"/></svg>`;
                        }
                        line.className = klass;
                        line.innerHTML = `<span class="migration-check-icon">${iconHtml}</span> ${lineLabel}`;
                    }
                    checklist.appendChild(line);
                });

                row.appendChild(checklist);
            } else {
                const instructionLine = document.createElement('div');
                instructionLine.className = 'migration-instruction';
                let tplKey;
                if (status === 'needs-enable') {
                    tplKey = 'migrationInstructionEnableHtml';
                } else if (status === 'needs-website-access') {
                    tplKey = 'migrationInstructionWebsiteAccessHtml';
                } else if (key === 'firefox') {
                    tplKey = 'migrationInstructionFirefoxPrivateHtml';
                } else {
                    tplKey = 'migrationInstructionChromiumPrivateHtml';
                }
                const chip = extensionsUrlChipHtml(key);
                instructionLine.innerHTML = tSettings(tplKey)
                    .replace('{URL_CHIP}', chip)
                    .replace(/{BROWSER}/g, entry.label)
                    .replace(/{PRIV}/g, privNoun);
                attachCopyChipHandlers(instructionLine);
                row.appendChild(instructionLine);
            }

            const actionsRow = document.createElement('div');
            actionsRow.className = 'migration-actions-row';

            const primaryBtn = document.createElement('button');
            primaryBtn.type = 'button';
            primaryBtn.className = 'migration-primary-btn';
            primaryBtn.textContent = tSettings('migrationOpenExtensionSettings');
            primaryBtn.addEventListener('click', () => {
                openExtensionSettings(key).catch(e => console.warn('[migration] open ext settings:', e));
            });
            actionsRow.appendChild(primaryBtn);

            let showMeBtn = null;
            if (hasSteps) {
                showMeBtn = document.createElement('button');
                showMeBtn.type = 'button';
                showMeBtn.className = 'migration-show-me-btn';
                showMeBtn.setAttribute('aria-expanded', 'false');
                showMeBtn.innerHTML = `<span>${tSettings('migrationShowMeHow')}</span><svg class="migration-show-me-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"></polyline></svg>`;
                actionsRow.appendChild(showMeBtn);
            }

            row.appendChild(actionsRow);

            const delayNote = document.createElement('div');
            delayNote.className = 'migration-browser-hint migration-delay-note';
            delayNote.textContent = tSettings('migrationDelayDetectionNote');
            row.appendChild(delayNote);

            if (hasSteps) {
                const screenshotsWrap = document.createElement('div');
                screenshotsWrap.className = 'migration-screenshots-wrap hidden';

                const screenshotsContainer = document.createElement('div');
                const safariTwoUp = key === 'safari' && steps.length === 2;
                screenshotsContainer.className = `extension-enforcer-screenshots ${steps.length >= 3 ? 'screenshots-grid' : 'screenshots-row'}${safariTwoUp ? ' safari-screenshots-asymmetric' : ''}`;

                steps.forEach((step, i) => {
                    if (i > 0 && steps.length < 3) {
                        const arrow = document.createElement('span');
                        arrow.className = 'extension-enforcer-screenshot-arrow';
                        arrow.textContent = '→';
                        screenshotsContainer.appendChild(arrow);
                    }
                    const figure = document.createElement('figure');
                    figure.className = 'extension-enforcer-step';
                    const cap = formatExtensionScreenshotCaption(step, i);
                    if (cap) {
                        const caption = document.createElement('figcaption');
                        caption.className = 'extension-enforcer-step-label';
                        caption.textContent = cap;
                        figure.appendChild(caption);
                    }
                    const img = document.createElement('img');
                    img.className = 'extension-enforcer-screenshot';
                    img.src = step.src;
                    img.alt = screenshotAltText(step, i, cap);
                    figure.appendChild(img);
                    screenshotsContainer.appendChild(figure);
                });

                screenshotsWrap.appendChild(screenshotsContainer);
                row.appendChild(screenshotsWrap);

                showMeBtn.addEventListener('click', () => {
                    const isOpen = showMeBtn.classList.toggle('open');
                    screenshotsWrap.classList.toggle('hidden', !isOpen);
                    showMeBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
                    if (isOpen) state.migrationShowMeHowExpandedKeys.add(key);
                    else state.migrationShowMeHowExpandedKeys.delete(key);
                });

                if (state.migrationShowMeHowExpandedKeys.has(key)) {
                    showMeBtn.classList.add('open');
                    screenshotsWrap.classList.remove('hidden');
                    showMeBtn.setAttribute('aria-expanded', 'true');
                }
            }
        }

        container.appendChild(row);
    }

    updateMigrationBrowserChecklist(state);
}

// While the post-cleanup screen is open, periodically re-check
// extension compliance so the checklist ticks itself off when the
// user comes back from the store.
export async function pollMigrationCompliance({ launchProbe = false } = {}) {
    if (!state.migrationOnboardingActive) return;
    try {
        await refreshAutomationPermissionStatus({ force: true, launchProbe });
        const fresh = await invoke('onboarding_state');
        renderBrowserInstallButtons(fresh);
    } catch (e) { /* no-op */ }
}

export function startMigrationPolling() {
    if (__ANDROID_BUILD__) return;
    if (state.migrationPollIntervalId) return;
    state.migrationPollIntervalId = setInterval(pollMigrationCompliance, MIGRATION_POLL_MS);
}

export function stopMigrationPolling() {
    if (__ANDROID_BUILD__) return;
    if (state.migrationPollIntervalId) {
        clearInterval(state.migrationPollIntervalId);
        state.migrationPollIntervalId = null;
    }
}

export function onAppForeground() {
    if (typeof kickClockNow === 'function') kickClockNow();
    void reconcileBlockingWarningShell();
    behaviourBannerDismissedThisSession = false;
    if (state.migrationOnboardingActive) {
        pollMigrationCompliance();
        return;
    }
    if (!hasAcceptedEula() || !state.startupInitializationComplete) return;
    refreshBehaviourBannerIfStale({ force: true });
    void reconcileBlockingWarningShell();
}

export function setupAppForegroundRefresh() {
    if (__ANDROID_BUILD__) return;
    if (state.isIOS || state.isAndroid) return;
    window.addEventListener('focus', onAppForeground);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') onAppForeground();
    });
    getCurrentWindow().onFocusChanged(({ payload: focused }) => {
        if (focused) onAppForeground();
    }).catch((e) => {
        console.warn('[app] window focus listener unavailable:', e);
    });
    // Keep the setup banner in sync when extension state changes
    // without a window focus (e.g. user toggles an extension while
    // ReDD Blocker stays visible). Matches enforcer tick (~5 s).
    setInterval(() => {
        if (!state.startupInitializationComplete || state.migrationOnboardingActive) return;
        if (!hasAcceptedEula()) return;
        void refreshBehaviourBannerIfStale();
    }, 5_000);
}

// Session-only flag for the slim setup banner. We deliberately do
// NOT persist this in localStorage anymore: the banner is a status
// indicator ("you have a browser without ReDD Focus set up"), not
// a one-time notice. Persisting dismissal silently hid the reminder
// forever, so fresh users who clicked × on it after the welcome
// screen never saw it again — even though the underlying problem
// (extension not allowed in incognito on Chrome, etc.) was still
// there. Now × hides for the session and the banner re-evaluates
// on every launch / focus refresh.
let behaviourBannerDismissedThisSession = false;

// Persistent low-key reminder banner. Surfaces on every launch
// whenever any browser the user has installed is missing the
// ReDD Focus extension (or has it disabled, or not allowed in
// private browsing). Auto-hides when every installed browser is
// fully compliant — i.e. the banner is purely a "you still have
// setup to do" indicator. Independent of the v1.x migration story:
// fresh installs see it too, because a fresh user with the
// extension not yet installed in their daily-driver browser is in
// exactly the same shape as a v1.x upgrader who hasn't installed
// the extension yet — both need the reminder.
//
// Body copy is built per-state: instead of generic "install ReDD
// Focus" text, we surface the actual outstanding actions so the
// user knows at a glance what's still missing without having to
// open the setup dialog (e.g. "Install in Chrome and Edge · Allow
// in private browsing in Brave").
// Last `onboarding_state` snapshot we've observed. Updated by
// `runDesktopOnboarding`, `refreshBehaviourBannerIfStale`, and
// `pollMigrationCompliance`.
export let lastOnboardingState = null;

export async function updateBehaviourChangeBanner(state) {
    if (__ANDROID_BUILD__) return;
    const banner = document.getElementById('behaviour-change-banner');
    if (!banner) return;

    if (!state?.browsers) {
        try {
            state = await invoke('onboarding_state');
        } catch (_) {
            return;
        }
    }

    lastOnboardingState = state;

    if (appState.isMacOSDesktop) await refreshAutomationPermissionStatus({ force: true, launchProbe: false });

    let enforcementEnabled = false;
    try {
        enforcementEnabled = await invoke('get_enforcement_enabled');
    } catch (_) { /* non-desktop or command not available */ }

    // ---- Browser-side compliance ------------------------------------
    // `installed` means the browser app exists on disk (regardless of
    // running state) — same scope the welcome screen uses, so the
    // user doesn't get nagged about Brave if they don't have Brave.
    const browsers = (state && state.browsers) || {};
    const detectedKeys = Object.keys(BROWSER_STORE_LINKS).filter(k => browsers[k] && browsers[k].installed);
    const allCompliant = detectedKeys.length > 0
        && detectedKeys.every(k => effectiveBrowserComplianceStatus(k, browsers) === 'compliant');
    const hasBrowserIssues = detectedKeys.length > 0 && !allCompliant;

    const shouldShow = !behaviourBannerDismissedThisSession
        && detectedKeys.length > 0
        && (hasBrowserIssues || !enforcementEnabled);
    if (!shouldShow) {
        banner.classList.add('hidden');
        return;
    }
    banner.classList.remove('hidden');

    const headlineEl = document.getElementById('setup-banner-headline');
    if (headlineEl) {
        const headlineKey = bannerHeadlineKey(browsers, detectedKeys);
        headlineEl.textContent = tSettings(headlineKey);
    }

    const parts = [];
    const actionSummary = buildBannerActionSummary(browsers, detectedKeys);
    if (actionSummary) parts.push(actionSummary);
    if (!enforcementEnabled && detectedKeys.length > 0) {
        parts.push(tSettings('bannerTurnOnBrowserProtection'));
    }

    const bodyEl = document.getElementById('behaviour-change-text');
    if (bodyEl) {
        bodyEl.textContent = parts.join(' · ');
    }

    const helpBtn = document.getElementById('behaviour-change-help');
    const dismissBtn = document.getElementById('behaviour-change-dismiss');

    if (helpBtn) {
        helpBtn.classList.remove('hidden', 'ghost');
        if (!helpBtn._listenerAdded) {
            helpBtn._listenerAdded = true;
            helpBtn.addEventListener('click', openExtensionSetupOverlay);
        }
    }

    if (dismissBtn && !dismissBtn._listenerAdded) {
        dismissBtn._listenerAdded = true;
        dismissBtn.addEventListener('click', () => {
            behaviourBannerDismissedThisSession = true;
            banner.classList.add('hidden');
        });
    }
}

export function bannerHeadlineKey(browsers, detectedKeys) {
    if (!state.isMacOSDesktop) {
        return 'setupBrowsersBannerHeadline';
    }

    const extensionStatuses = new Set([
        'needs-install',
        'needs-native-host',
        'needs-enable',
        'needs-private',
        'needs-website-access',
    ]);

    const hasExtensionIssue = detectedKeys.some((key) =>
        extensionStatuses.has(effectiveBrowserComplianceStatus(key, browsers))
    );

    return hasExtensionIssue
        ? 'setupBrowsersBannerHeadline'
        : 'setupBrowsersBannerHeadlineMac';
}

// Build a compact, action-grouped summary of what's still missing
// across the user's installed browsers. Browsers with the same
// outstanding action are grouped into a single phrase so the
// banner doesn't repeat verbs:
//
//   "Install in Chrome and Edge · Allow in private browsing in Brave"
//   "Allow on all websites in Safari"
//
// Order is foundational-first (install → enable → private → website
// access) so the user sees the prerequisite step before any follow-up
// step. Returns "" when nothing is non-compliant — the caller is
// expected to have already gated on that, but defending against an
// empty result keeps callers safe.
export function buildBannerActionSummary(browsers, detectedKeys) {
    const groups = new Map();
    for (const key of detectedKeys) {
        const status = effectiveBrowserComplianceStatus(key, browsers);
        if (!status || status === 'compliant') continue;
        const label = BROWSER_STORE_LINKS[key]?.label || key;
        if (!groups.has(status)) groups.set(status, []);
        groups.get(status).push(label);
    }

    const order = ['needs-install', 'needs-automation', 'needs-fda', 'needs-native-host', 'needs-enable', 'needs-private', 'needs-website-access'];
    const phrases = [];
    for (const status of order) {
        const list = groups.get(status);
        if (!list || list.length === 0) continue;
        phrases.push(`${bannerActionPhrase(status)} ${joinBrowserNames(list)}`);
    }
    return phrases.join(' · ');
}

export function bannerActionPhrase(status) {
    switch (status) {
        case 'needs-install':
            return tSettings('bannerActionInstallIn');
        case 'needs-automation':
            return tSettings('bannerActionAutomationIn');
        case 'needs-fda':
            return tSettings('bannerActionGrantFdaIn');
        case 'needs-enable':
            return tSettings('bannerActionEnableIn');
        case 'needs-private':
            return tSettings('bannerActionPrivateBrowsingIn');
        case 'needs-website-access':
            return tSettings('bannerActionAllWebsitesIn');
        default:
            return tSettings('bannerActionSetUpIn');
    }
}

// Natural-language join: "Chrome", "Chrome and Edge",
// "Chrome, Edge, and Brave" (Oxford comma in English).
// Danish: no comma before the final conjunction.
export function joinBrowserNames(list) {
    if (list.length === 0) return '';
    if (list.length === 1) return list[0];
    const and = tSettings('andWord');
    if (list.length === 2) return `${list[0]} ${and} ${list[1]}`;
    if (getSettingsLanguage() === 'da') {
        return `${list.slice(0, -1).join(', ')} ${and} ${list[list.length - 1]}`;
    }
    return `${list.slice(0, -1).join(', ')}, ${and} ${list[list.length - 1]}`;
}

// Re-opens the post-cleanup migration overlay (the per-browser
// install checklist) — the canonical "set up ReDD Focus" surface.
// Used by both the slim banner's "Set up browsers" button and the
// new Settings → Advanced Options entry. Centralised so both call
// sites stay in sync if the overlay's API changes.
export async function openExtensionSetupOverlay() {
    if (__ANDROID_BUILD__) return;
    try {
        const fresh = await invoke('onboarding_state');
        state.migrationOnboardingDismissed = false;
        // Hide settings if it was the launch point — the migration
        // overlay needs the full window.
        document.getElementById('settings-modal')?.classList.add('hidden');
        setLanguagePickerOpen(false);
        await showMigrationOnboarding('post', fresh, { mode: 'fresh' });
    } catch (e) {
        console.warn('[setup-overlay] reopen failed:', e);
    }
}

export async function continueOnboardingReplayFromWelcome() {
    if (__ANDROID_BUILD__) return;
    if (!hasAcceptedEula()) {
        updateOnboardingVisibility();
        return;
    }
    await openExtensionSetupOverlay();
}

export async function restartOnboardingFromSettings() {
    if (__ANDROID_BUILD__) return;
    if (state.isIOS || state.isAndroid) return;
    document.getElementById('settings-modal')?.classList.add('hidden');
    setLanguagePickerOpen(false);

    state.migrationOnboardingDismissed = false;
    localStorage.removeItem(EXT_ONBOARDING_DISMISSED_KEY);
    state.firstRunExtensionSetupPending = true;
    state.lastMigrationBrowserRenderSignature = '';
    state.extensionSetupPausedForBackNavigation = false;

    await presentWelcomeOnboarding(continueOnboardingReplayFromWelcome);
}

// Re-poll extension compliance so the slim banner reflects reality
// if the user just finished setting up an extension in another
// browser and tabbed back. Throttled to match the enforcer tick (~5 s)
// so it stays in sync with the countdown banner without hammering
// `onboarding_state` on rapid focus toggling. Pass `force: true` to
// bypass the throttle when compliance clearly changed (enforcer
// grace-resolved, window hide → show, etc.).
let lastBannerRefreshAt = 0;
export const BANNER_REFRESH_THROTTLE_MS = 5_000;
export async function refreshBehaviourBannerIfStale({ force = false } = {}) {
    if (__ANDROID_BUILD__) return;
    if (state.isIOS || state.isAndroid) return;
    if (state.migrationOnboardingActive) return; // overlay is the source of truth
    if (!state.startupInitializationComplete) return;
    const now = Date.now();
    if (!force && now - lastBannerRefreshAt < BANNER_REFRESH_THROTTLE_MS) return;
    lastBannerRefreshAt = now;
    try {
        if (state.isMacOSDesktop) await refreshAutomationPermissionStatus({ force });
        const fresh = await invoke('onboarding_state');
        await updateBehaviourChangeBanner(fresh);
        await syncEnforcerClosedBannersWithCompliance(fresh);
    } catch (_) { /* no-op */ }
}

// ---- Enforcer UI: dynamic per-browser action banners ---------------------
// Subscribes to Rust enforcer events and shows attention-grabbing dark-orange
// banners with a live countdown when a browser is about to be closed.

let enforcerUiAlertsAttached = false;
export const ENFORCER_ACTIVE_BANNER_ID = 'extension-enforcer-action-banner-active';
export const ENFORCER_CLOSED_BANNER_ID = 'extension-enforcer-action-banner-closed';
export const enforcerActionBannerStates = new Map();
export const enforcerClosedBannerStates = new Map();
let enforcerActionBannerInterval = null;
let enforcerClosedBannerPollInterval = null;
let enforcerScreenshotResizeTimer = null;
export const ENFORCER_CLOSED_BANNER_POLL_MS = 5_000;

export function stopEnforcerClosedBannerPoll() {
    if (enforcerClosedBannerPollInterval) {
        clearInterval(enforcerClosedBannerPollInterval);
        enforcerClosedBannerPollInterval = null;
    }
}

export function ensureEnforcerClosedBannerPoll() {
    if (__ANDROID_BUILD__) return;
    if (enforcerClosedBannerStates.size === 0) {
        stopEnforcerClosedBannerPoll();
        return;
    }
    void syncEnforcerClosedBannersWithCompliance();
    if (enforcerClosedBannerPollInterval) return;
    enforcerClosedBannerPollInterval = setInterval(() => {
        void syncEnforcerClosedBannersWithCompliance();
    }, ENFORCER_CLOSED_BANNER_POLL_MS);
}

export async function syncEnforcerClosedBannersWithCompliance(state) {
    if (__ANDROID_BUILD__) return;
    if (enforcerClosedBannerStates.size === 0) {
        stopEnforcerClosedBannerPoll();
        return;
    }
    if (!state?.browsers) {
        try {
            state = await invoke('onboarding_state');
        } catch (_) {
            return;
        }
    }
    if (appState.isMacOSDesktop) await refreshAutomationPermissionStatus({ force: true, launchProbe: false });
    const browsers = state.browsers || {};
    let changed = false;
    for (const key of [...enforcerClosedBannerStates.keys()]) {
        const b = browsers[key];
        if (b && effectiveBrowserComplianceStatus(key, browsers) === 'compliant') {
            enforcerClosedBannerStates.delete(key);
            changed = true;
        }
    }
    if (changed) {
        renderCombinedEnforcerClosedBanner();
    } else if (enforcerClosedBannerStates.size === 0) {
        stopEnforcerClosedBannerPoll();
    }
}

export function setupEnforcerUiAlerts() {
    if (__ANDROID_BUILD__) return;
    if (state.isIOS || state.isAndroid || enforcerUiAlertsAttached) return;
    enforcerUiAlertsAttached = true;
    tauriAPI.onEnforcerGraceUpdate((event) => {
        const payload = event?.payload || {};
        renderEnforcerActionBanner(payload);
    }).catch((e) => {
        console.warn('[enforcer-ui] failed to attach grace-update listener:', e);
        enforcerUiAlertsAttached = false;
    });
    tauriAPI.onEnforcerGraceResolved((event) => {
        const payload = event?.payload || {};
        hideEnforcerActionBanner(payload.browser || payload.label);
        // Enforcer just re-scanned and found this browser compliant —
        // refresh the setup banner immediately so it doesn't lag up
        // to 30 s behind the countdown banner (same profile scan,
        // but the setup banner was on a separate throttle).
        void refreshBehaviourBannerIfStale({ force: true });
    }).catch((e) => {
        console.warn('[enforcer-ui] failed to attach grace-resolved listener:', e);
    });
    tauriAPI.onEnforcerBrowserClosed((event) => {
        const payload = event?.payload || {};
        renderEnforcerClosedBanner(payload);
    }).catch((e) => {
        console.warn('[enforcer-ui] failed to attach browser-closed listener:', e);
    });
    window.addEventListener('resize', () => {
        clearTimeout(enforcerScreenshotResizeTimer);
        enforcerScreenshotResizeTimer = setTimeout(syncAllEnforcerScreenshotHeights, 100);
    });
}

// ---- Website automation (macOS) permission prompt --------------------------
//
// The Automation watcher (src-tauri/src/web_automation.rs) drives
// Safari + Chromium blocking via Apple Events. The first event to each
// browser surfaces the system "ReDD Blocker wants to control <App>"
// prompt; if the user denies it, the watcher emits
// `web-automation://permission-needed` (and `...resolved` once granted).
// Without the grant, website blocking silently does nothing, so we show
// a persistent banner with a one-click jump to System Settings. The
// banner reuses the shared `update-banner setup-banner` look (same as
// the "Enable ReDD Focus in your browsers" reminder) so we don't grow a
// second banner style; it's created on demand and parked in the top
// banner stack just above `#behaviour-change-banner`. The whole thing is
// macOS-only and self-contained — it deliberately does not touch the
// extension enforcer's banner machinery.

export const WEB_AUTOMATION_BANNER_ID = 'web-automation-permission-banner';
export const webAutomationPendingBrowsers = new Map(); // label -> true
let webAutomationUiAlertsAttached = false;

export async function startWebAutomationWatcher() {
    if (__ANDROID_BUILD__) return;
    if (!state.isMacOSDesktop) return;
    try {
        await tauriAPI.webAutomationStart();
    } catch (e) {
        console.warn('[web-automation] web_automation_start failed:', e);
    }
}

export function setupWebAutomationUiAlerts() {
    if (__ANDROID_BUILD__) return;
    if (!state.isMacOSDesktop || webAutomationUiAlertsAttached) return;
    webAutomationUiAlertsAttached = true;
    tauriAPI.onWebAutomationPermissionNeeded(async (event) => {
        const label = event?.payload?.label || event?.payload?.browser;
        if (!label) return;
        const key = browserKeyFromLabel(label);
        if (key) lastAutomationPermissionByKey[key] = 'denied';
        if (state.migrationOnboardingActive && state.lastMigrationBrowserState) {
            renderBrowserInstallButtons(state.lastMigrationBrowserState, { force: true });
        }
        // When enforcement is enabled, the extension enforcer already runs
        // a grace countdown for the denied browser and force-closes it,
        // surfacing its own banner + deep-link. Showing this soft banner
        // too would be redundant. Only surface it when enforcement is OFF
        // (where blocking silently no-ops and this is the user's only cue).
        try {
            if (await invoke('get_enforcement_enabled')) return;
        } catch (_) { /* fall through and show the banner */ }
        webAutomationPendingBrowsers.set(String(label), true);
        renderWebAutomationPermissionBanner();
    }).catch((e) => {
        console.warn('[web-automation] failed to attach permission-needed listener:', e);
        webAutomationUiAlertsAttached = false;
    });
    tauriAPI.onWebAutomationPermissionResolved((event) => {
        const label = event?.payload?.label || event?.payload?.browser;
        if (!label) return;
        const key = browserKeyFromLabel(label);
        if (key) lastAutomationPermissionByKey[key] = 'granted';
        webAutomationPendingBrowsers.delete(String(label));
        hideEnforcerActionBanner(label);
        renderWebAutomationPermissionBanner();
        void refreshBehaviourBannerIfStale({ force: true });
        if (state.migrationOnboardingActive && state.lastMigrationBrowserState) {
            renderBrowserInstallButtons(state.lastMigrationBrowserState, { force: true });
        }
    }).catch((e) => {
        console.warn('[web-automation] failed to attach permission-resolved listener:', e);
    });
}

// Build (once) the soft permission banner. Reuses the same DOM shape and
// classes as the static `#behaviour-change-banner` (info icon + headline +
// body + dark CTA + × dismiss) so all styling comes from the shared
// `.update-banner`/`.setup-banner` rules — no bespoke inline styles. It's
// parked just above `#behaviour-change-banner` in the top banner stack,
// mirroring how the enforcer banners insert themselves.
export function ensureWebAutomationBanner() {
    if (__ANDROID_BUILD__) return;
    let banner = document.getElementById(WEB_AUTOMATION_BANNER_ID);
    if (banner) return banner;

    banner = document.createElement('div');
    banner.id = WEB_AUTOMATION_BANNER_ID;
    banner.className = 'update-banner setup-banner hidden';
    banner.innerHTML = `
        <div class="update-banner-content">
            <svg class="setup-banner-info-icon" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="11" fill="currentColor"></circle>
                <circle cx="12" cy="7.5" r="1.3" fill="white"></circle>
                <rect x="11" y="10" width="2" height="8" rx="1" fill="white"></rect>
            </svg>
            <div class="setup-banner-message">
                <strong class="setup-banner-headline web-automation-banner-headline"></strong>
                <span class="setup-banner-body web-automation-banner-text"></span>
                <div class="setup-banner-actions-row">
                    <button class="update-banner-btn web-automation-banner-open" type="button"></button>
                </div>
            </div>
        </div>
        <button class="update-banner-dismiss web-automation-banner-dismiss" title="Dismiss" type="button">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
        </button>
    `;

    banner.querySelector('.web-automation-banner-open')?.addEventListener('click', () => {
        tauriAPI.openAutomationSettings()
            .then(() => scheduleAutomationVerificationPoll())
            .catch((e) =>
                console.warn('[web-automation] openAutomationSettings failed:', e));
    });
    banner.querySelector('.web-automation-banner-dismiss')?.addEventListener('click', () => {
        webAutomationPendingBrowsers.clear();
        banner.classList.add('hidden');
    });

    const setupBanner = document.getElementById('behaviour-change-banner');
    if (setupBanner) {
        setupBanner.insertAdjacentElement('beforebegin', banner);
    } else {
        document.querySelector('.app-container')?.prepend(banner);
    }
    return banner;
}

export function renderWebAutomationPermissionBanner() {
    if (__ANDROID_BUILD__) return;
    const labels = [...webAutomationPendingBrowsers.keys()];
    if (labels.length === 0) {
        document.getElementById(WEB_AUTOMATION_BANNER_ID)?.classList.add('hidden');
        return;
    }
    const banner = ensureWebAutomationBanner();
    const list = joinBrowserNames(labels);
    const headlineEl = banner.querySelector('.web-automation-banner-headline');
    if (headlineEl) headlineEl.textContent = tSettings('webAutomationBannerHeadline');
    const text = banner.querySelector('.web-automation-banner-text');
    if (text) text.textContent = tSettingsFmt('webAutomationBannerBody', { browsers: list });
    const openBtn = banner.querySelector('.web-automation-banner-open');
    if (openBtn) openBtn.textContent = tSettings('migrationOpenAutomationSettings');
    banner.classList.remove('hidden');
}

export function browserKeyFromLabel(label) {
    if (!label) return null;
    const normalized = String(label).toLowerCase();
    if (normalized.includes('firefox')) return 'firefox';
    if (normalized.includes('brave')) return 'brave';
    if (normalized.includes('edge')) return 'edge';
    if (normalized.includes('safari')) return 'safari';
    return 'chrome';
}

export function browserIconUrl(key) {
    switch (key) {
        case 'firefox': return iconFirefoxUrl;
        case 'edge': return iconEdgeUrl;
        case 'safari': return iconSafariUrl;
        case 'brave': return iconBraveUrl;
        case 'chrome':
        default: return iconChromeUrl;
    }
}

export function formatExtensionScreenshotCaption(step, index) {
    if (step.hideCaption) return '';
    if (step.captionKey) return tSettings(step.captionKey);
    if (step.labelKey) {
        const label = tSettings(step.labelKey);
        return tSettingsFmt('migrationScreenshotCaptionStep', { n: String(index + 1), label });
    }
    if (step.caption) return step.caption;
    if (step.label) return tSettingsFmt('migrationScreenshotCaptionStep', { n: String(index + 1), label: step.label });
    return tSettingsFmt('migrationScreenshotStepOnly', { n: String(index + 1) });
}

export function screenshotAltText(step, index, caption) {
    if (step.altKey) return tSettings(step.altKey);
    if (caption) return caption;
    return tSettingsFmt('migrationScreenshotStepOnly', { n: String(index + 1) });
}

export function enforcerShowMeHowButtonHtml() {
    return `<span>${tSettings('migrationShowMeHow')}</span><svg class="extension-enforcer-show-me-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"></polyline></svg>`;
}

export function automationScreenshotSteps() {
    return [
        {
            src: screenshotAutomationSettings,
            plainPanel: true,
            hideCaption: true,
            altKey: 'migrationShotAutomationStep1',
        },
    ];
}

export function enforcerScreenshotSteps(key) {
    if (key === 'chrome') return [
        { src: screenshotChromeStep1, labelKey: 'migrationShotChromeStep1' },
        { src: screenshotChromeStep2, labelKey: 'migrationShotChromeStep2' },
    ];
    if (key === 'edge') return [
        { src: screenshotEdgeStep1, labelKey: 'migrationShotEdgeStep1' },
        { src: screenshotEdgeStep2, labelKey: 'migrationShotEdgeStep2' },
    ];
    if (key === 'firefox') return [
        { src: screenshotFirefoxStep1, labelKey: 'migrationShotFirefoxStep1' },
        { src: screenshotFirefoxStep2, labelKey: 'migrationShotFirefoxStep2' },
    ];
    if (key === 'safari') return [
        { src: screenshotSafariStep1, captionKey: 'migrationShotSafariCap1' },
        { src: screenshotSafariStep2, captionKey: 'migrationShotSafariCap2' },
    ];
    return null;
}

export function enforcerCopy(payload) {
    const browserRaw = payload.label || payload.browser;
    const browser = browserRaw || tSettings('enforcerBrowserFallback');
    const seconds = Math.max(0, Number(payload.remaining_secs ?? payload.remainingSecs ?? 0));
    const issue = payload.issue || 'unknown';
    const closeHeadline = tSettingsFmt('enforcerClosingHeadline', { browser });
    const countdownStr = (key = 'enforcerCountdownDefault') => tSettingsFmt(key, { seconds: String(seconds), browser });

    if (issue === 'missing') {
        return {
            headline: tSettingsFmt('enforcerHeadlineMissing', { browser }),
            countdownHeadline: closeHeadline,
            countdownInstruction: tSettings('enforcerCountdownInstrMissing'),
            countdown: countdownStr('enforcerCountdownMissing'),
            instruction: tSettingsFmt('enforcerInstrMissing', { browser }),
            action: tSettings('enforcerActionInstall'),
        };
    }
    if (issue === 'disabled') {
        const key = browserKeyFromLabel(browser);
        const screenshotSteps = enforcerScreenshotSteps(key);
        return {
            headline: tSettingsFmt('enforcerHeadlineDisabled', { browser }),
            countdownHeadline: closeHeadline,
            countdownInstruction: tSettings('enforcerCountdownInstrDisabled'),
            countdown: countdownStr('enforcerCountdownDisabled'),
            instructionHtml: tSettings('migrationInstructionEnableHtml')
                .replace('{URL_CHIP}', extensionsUrlChipHtml(key))
                .replace(/{BROWSER}/g, browser),
            note: tSettings('migrationDelayDetectionNote'),
            action: tSettingsFmt('enforcerActionOpenExtensions', { browser }),
            actionHtml: tSettings('migrationOpenExtensionSettings'),
            screenshotSteps,
        };
    }
    if (issue === 'private') {
        const key = browserKeyFromLabel(browser);
        const privNoun = privateModeNoun(key);
        const screenshotSteps = enforcerScreenshotSteps(key);
        const tplKey = key === 'firefox'
            ? 'migrationInstructionFirefoxPrivateHtml'
            : 'migrationInstructionChromiumPrivateHtml';
        return {
            headline: tSettingsFmt('enforcerHeadlinePrivate', { browser }),
            countdownHeadline: closeHeadline,
            countdownInstruction: tSettings('enforcerCountdownInstrPrivate'),
            countdown: countdownStr('enforcerCountdownPrivate'),
            instructionHtml: tSettings(tplKey)
                .replace('{URL_CHIP}', extensionsUrlChipHtml(key))
                .replace(/{BROWSER}/g, browser)
                .replace(/{PRIV}/g, privNoun),
            note: tSettings('migrationDelayDetectionNote'),
            action: tSettingsFmt('enforcerActionOpenExtensions', { browser }),
            actionHtml: tSettings('migrationOpenExtensionSettings'),
            screenshotSteps,
        };
    }
    if (issue === 'websiteaccess') {
        return {
            headline: tSettingsFmt('enforcerHeadlineWebsiteAccess', { browser }),
            countdownHeadline: closeHeadline,
            countdownInstruction: tSettings('enforcerCountdownInstrWebsiteAccess'),
            countdown: countdownStr('enforcerCountdownWebsiteAccess'),
            instruction: tSettingsFmt('enforcerInstrWebsiteAccessPlain', { browser }),
            action: tSettingsFmt('enforcerActionOpenExtensions', { browser }),
        };
    }
    if (issue === 'access') {
        return {
            headline: tSettingsFmt('enforcerHeadlineAccess', { browser }),
            countdownHeadline: closeHeadline,
            countdownInstruction: tSettings('enforcerCountdownInstrAccess'),
            countdown: countdownStr('enforcerCountdownAccess'),
            instruction: browser === 'Safari'
                ? tSettings('enforcerInstrAccessSafari')
                : tSettingsFmt('enforcerInstrAccessBrowser', { browser }),
            action: browser === 'Safari'
                ? tSettings('migrationOpenExtensionSettings')
                : tSettingsFmt('enforcerActionOpenBrowserSettings', { browser }),
        };
    }
    if (issue === 'automation') {
        // macOS: ReDD Blocker lost the Automation grant for this browser,
        // so it can't redirect blocked tabs. No extension URL applies —
        // the only fix is re-enabling the grant in System Settings.
        return {
            headline: tSettingsFmt('enforcerHeadlineAutomation', { browser }),
            countdownHeadline: closeHeadline,
            countdownInstruction: tSettings('enforcerCountdownInstrAutomation'),
            countdown: countdownStr(),
            instruction: tSettingsFmt('enforcerInstrAutomation', { browser }),
            action: tSettings('migrationOpenAutomationSettings'),
            hideUrlChip: true,
            screenshotSteps: automationScreenshotSteps(),
        };
    }
    return {
        headline: tSettingsFmt('enforcerHeadlineDefault', { browser }),
        countdownHeadline: closeHeadline,
        countdownInstruction: tSettings('enforcerCountdownInstrDefault'),
        countdown: countdownStr(),
        instruction: tSettingsFmt('enforcerInstrDefault', { browser }),
        action: tSettingsFmt('enforcerActionOpenExtensions', { browser }),
    };
}

export function renderEnforcerCountdownInstruction(el, baseText) {
    if (__ANDROID_BUILD__) return;
    if (!el) return;
    el.replaceChildren();
    let base = (baseText || '').trim();
    const delay = tSettings('enforcerCountdownDelayNote');
    if (base.endsWith('.')) base = base.slice(0, -1);
    if (base) {
        el.append(document.createTextNode(`${base} `));
    }
    const delaySpan = document.createElement('span');
    delaySpan.className = 'extension-enforcer-countdown-delay-note';
    delaySpan.textContent = delay;
    el.appendChild(delaySpan);
}

export function renderEnforcerActionCopy(banner, payload, copy) {
    if (__ANDROID_BUILD__) return;
    const key = enforcerBannerKey(payload);
    const isClosed = banner.classList.contains('extension-enforcer-action-banner-closed');
    const isActiveCountdown = !!copy.countdown && !isClosed;
    const icon = banner.querySelector('.extension-enforcer-browser-icon');
    const headlineText = banner.querySelector('.extension-enforcer-action-headline-text');
    const countdown = banner.querySelector('.extension-enforcer-action-countdown');
    const countdownRow = banner.querySelector('.extension-enforcer-action-countdown-row');
    const instruction = banner.querySelector('.extension-enforcer-action-instruction');
    const closedStatus = banner.querySelector('.extension-enforcer-closed-status');

    if (icon) {
        icon.src = browserIconUrl(key);
        icon.alt = '';
        icon.title = payload.label || payload.browser || key;
    }
    if (headlineText) headlineText.textContent = isActiveCountdown ? (copy.countdownHeadline || '') : (copy.headline || '');
    if (countdown) {
        const seconds = Math.max(0, Number(payload.remaining_secs ?? payload.remainingSecs ?? 0));
        countdown.replaceChildren();
        if (isActiveCountdown) {
            const mins = Math.floor(seconds / 60);
            const secs = String(seconds % 60).padStart(2, '0');
            const time = document.createElement('strong');
            time.className = 'extension-enforcer-countdown-time';
            time.textContent = `${mins}:${secs}`;
            const label = document.createElement('span');
            label.className = 'extension-enforcer-countdown-label';
            label.textContent = tSettings('enforcerCountdownRemaining');
            countdown.append(time, label);
        }
    }
    if (countdownRow) countdownRow.classList.toggle('hidden', !isActiveCountdown);
    if (closedStatus) {
        closedStatus.textContent = tSettings('enforcerClosedStatus');
        closedStatus.classList.toggle('hidden', !isClosed);
    }
    if (instruction) {
        if (isActiveCountdown) {
            renderEnforcerCountdownInstruction(instruction, copy.countdownInstruction || '');
        } else if (copy.instructionHtml) {
            instruction.innerHTML = copy.instructionHtml;
            attachCopyChipHandlers(instruction);
        } else {
            instruction.textContent = copy.instruction || '';
        }
    }

    const note = banner.querySelector('.extension-enforcer-action-note');
    if (note) {
        note.textContent = isActiveCountdown ? '' : (copy.note || '');
        note.classList.toggle('hidden', isActiveCountdown || !copy.note);
    }

    const url = banner.querySelector('.extension-enforcer-action-url');
    if (url) {
        const href = extensionsUrl(key);
        const showUrl = (isActiveCountdown || isClosed) && !!href;
        url.replaceChildren();
        if (showUrl) {
            populateEnforcerUrlChip(url, key);
        } else {
            delete url.dataset.copyUrl;
            delete url.dataset.copiedUntil;
            url.classList.remove('copied');
            url.disabled = false;
        }
        url.classList.toggle('hidden', !showUrl);
    }

    const progress = banner.querySelector('.extension-enforcer-progress-bar');
    if (progress) {
        const remaining = Math.max(0, Number(payload.remaining_secs ?? payload.remainingSecs ?? 0));
        const totalRaw = payload.total_secs ?? payload.totalSecs ?? remaining;
        const total = Math.max(1, Number(totalRaw || 1));
        const pct = Math.max(0, Math.min(100, (remaining / total) * 100));
        progress.style.width = isActiveCountdown ? `${pct}%` : '0%';
    }

    const showMeBtn = banner.querySelector('.extension-enforcer-show-me-btn');
    const screenshotsWrap = banner.querySelector('.extension-enforcer-screenshots-wrap');
    const container = banner.querySelector('.extension-enforcer-screenshots');
    if (showMeBtn && screenshotsWrap && container) {
        const steps = copy.screenshotSteps;
        if (steps && steps.length) {
            const stepsKey = steps.map(s => s.src).join(',');
            if (container.dataset.stepsKey !== stepsKey) {
                container.dataset.stepsKey = stepsKey;
                container.innerHTML = '';
                applyScreenshotContainerLayout(container, steps, {
                    browserKey: banner.dataset.browser,
                });
                steps.forEach((step, i) => {
                    const figure = document.createElement('figure');
                    figure.className = 'extension-enforcer-step';
                    const cap = formatExtensionScreenshotCaption(step, i);
                    if (cap) {
                        const caption = document.createElement('figcaption');
                        caption.className = 'extension-enforcer-step-label';
                        caption.textContent = cap;
                        figure.appendChild(caption);
                    }
                    const img = document.createElement('img');
                    img.className = 'extension-enforcer-screenshot';
                    img.src = step.src;
                    img.alt = screenshotAltText(step, i, cap);
                    figure.appendChild(img);
                    container.appendChild(figure);
                });
            }
            applyScreenshotContainerLayout(container, steps, {
                browserKey: banner.dataset.browser,
            });
            showMeBtn.classList.remove('hidden');
            if (!screenshotsWrap.classList.contains('hidden')) {
                scheduleEnforcerScreenshotSync(screenshotsWrap);
            }
        } else {
            showMeBtn.classList.add('hidden');
            showMeBtn.classList.remove('open');
            showMeBtn.setAttribute('aria-expanded', 'false');
            screenshotsWrap.classList.add('hidden');
            container.classList.remove('safari-screenshots-asymmetric');
        }
    }
}

export function enforcerBannerKey(payload) {
    return browserKeyFromLabel(payload?.label || payload?.browser || 'chrome');
}

export function enforcerBannerId(key) {
    return `extension-enforcer-action-banner-${key}`;
}

export function formatBrowserList(labels) {
    const clean = labels.filter(Boolean);
    if (clean.length <= 1) return clean[0] || tSettings('enforcerBrowserFallback');
    if (clean.length === 2) return `${clean[0]} and ${clean[1]}`;
    return `${clean.slice(0, -1).join(', ')}, and ${clean[clean.length - 1]}`;
}

export function ensureActiveEnforcerActionBanner() {
    if (__ANDROID_BUILD__) return;
    let banner = document.getElementById(ENFORCER_ACTIVE_BANNER_ID);
    if (banner) return banner;

    banner = document.createElement('div');
    banner.id = ENFORCER_ACTIVE_BANNER_ID;
    banner.className = 'update-banner extension-enforcer-action-banner';
    banner.innerHTML = `
        <div class="extension-enforcer-progress-track" aria-hidden="true">
            <div class="extension-enforcer-progress-bar"></div>
        </div>
        <div class="extension-enforcer-banner-top">
            <div class="update-banner-content">
                <svg class="extension-enforcer-alert-icon" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="12" cy="12" r="11" fill="currentColor"></circle>
                    <rect x="11" y="6" width="2" height="8" rx="1" fill="white"></rect>
                    <circle cx="12" cy="17" r="1.3" fill="white"></circle>
                </svg>
                <div class="extension-enforcer-message">
                    <strong class="extension-enforcer-action-headline">
                        <span class="extension-enforcer-action-headline-text"></span>
                    </strong>
                    <em class="extension-enforcer-action-instruction"></em>
                </div>
                <div class="extension-enforcer-action-right">
                    <div class="extension-enforcer-action-countdown-row">
                        <span class="extension-enforcer-action-countdown"></span>
                    </div>
                </div>
            </div>
            <button class="update-banner-dismiss extension-enforcer-action-dismiss" title="Dismiss" type="button"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
        </div>
        <div class="extension-enforcer-action-strip">
            <div class="extension-enforcer-actions-row extension-enforcer-active-actions"></div>
        </div>
        <div class="extension-enforcer-screenshots-wrap hidden">
            <div class="extension-enforcer-screenshots"></div>
        </div>
    `;

    banner.querySelector('.extension-enforcer-action-dismiss')?.addEventListener('click', () => {
        banner.classList.add('hidden');
    });

    const setupBanner = document.getElementById('behaviour-change-banner');
    if (setupBanner) {
        setupBanner.insertAdjacentElement('beforebegin', banner);
    } else {
        document.querySelector('.app-container')?.prepend(banner);
    }
    return banner;
}

export function ensureClosedEnforcerActionBanner() {
    if (__ANDROID_BUILD__) return;
    let banner = document.getElementById(ENFORCER_CLOSED_BANNER_ID);
    if (banner) return banner;

    banner = document.createElement('div');
    banner.id = ENFORCER_CLOSED_BANNER_ID;
    banner.className = 'update-banner extension-enforcer-action-banner extension-enforcer-action-banner-closed hidden';
    banner.innerHTML = `
        <div class="extension-enforcer-banner-top">
            <div class="update-banner-content">
                <img class="extension-enforcer-browser-icon" aria-hidden="true">
                <div class="extension-enforcer-message">
                    <strong class="extension-enforcer-action-headline">
                        <span class="extension-enforcer-action-headline-text"></span>
                    </strong>
                    <em class="extension-enforcer-action-instruction"></em>
                </div>
            </div>
            <button class="update-banner-dismiss extension-enforcer-action-dismiss" title="Dismiss" type="button"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
        </div>
        <div class="extension-enforcer-action-strip">
            <div class="extension-enforcer-actions-row extension-enforcer-closed-actions"></div>
        </div>
        <div class="extension-enforcer-screenshots-wrap hidden">
            <div class="extension-enforcer-screenshots"></div>
        </div>
    `;

    banner.querySelector('.extension-enforcer-action-dismiss')?.addEventListener('click', () => {
        banner.classList.add('hidden');
        enforcerClosedBannerStates.clear();
        stopEnforcerClosedBannerPoll();
    });

    const activeBanner = document.getElementById(ENFORCER_ACTIVE_BANNER_ID);
    const setupBanner = document.getElementById('behaviour-change-banner');
    if (activeBanner) {
        activeBanner.insertAdjacentElement('afterend', banner);
    } else if (setupBanner) {
        setupBanner.insertAdjacentElement('beforebegin', banner);
    } else {
        document.querySelector('.app-container')?.prepend(banner);
    }
    return banner;
}

export function ensureEnforcerActionBanner(payload) {
    if (__ANDROID_BUILD__) return;
    const key = enforcerBannerKey(payload);
    let banner = document.getElementById(enforcerBannerId(key));
    if (banner) return { banner, key };

    banner = document.createElement('div');
    banner.id = enforcerBannerId(key);
    banner.className = 'update-banner extension-enforcer-action-banner';
    banner.dataset.browser = key;
    banner.innerHTML = `
        <div class="extension-enforcer-progress-track" aria-hidden="true">
            <div class="extension-enforcer-progress-bar"></div>
        </div>
        <div class="extension-enforcer-banner-top">
            <div class="update-banner-content">
                <svg class="extension-enforcer-alert-icon" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="12" cy="12" r="11" fill="currentColor"></circle>
                    <rect x="11" y="6" width="2" height="8" rx="1" fill="white"></rect>
                    <circle cx="12" cy="17" r="1.3" fill="white"></circle>
                </svg>
                <div class="extension-enforcer-message">
                    <strong class="extension-enforcer-action-headline">
                        <img class="extension-enforcer-browser-icon" aria-hidden="true">
                        <span class="extension-enforcer-action-headline-text"></span>
                    </strong>
                    <em class="extension-enforcer-action-instruction"></em>
                </div>
                <div class="extension-enforcer-action-right">
                    <div class="extension-enforcer-action-countdown-row">
                        <span class="extension-enforcer-action-countdown"></span>
                    </div>
                    <small class="extension-enforcer-action-note hidden"></small>
                    <div class="extension-enforcer-closed-status hidden"></div>
                </div>
            </div>
            <button class="update-banner-dismiss extension-enforcer-action-dismiss" title="Dismiss" type="button"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
        </div>
        <div class="extension-enforcer-action-strip">
            <div class="extension-enforcer-actions-row">
                <button class="update-banner-btn extension-enforcer-action-btn" type="button"></button>
                <button class="extension-enforcer-show-me-btn hidden" type="button" aria-expanded="false"></button>
            </div>
            <button type="button" class="extension-enforcer-action-url hidden"></button>
        </div>
        <div class="extension-enforcer-screenshots-wrap hidden">
            <div class="extension-enforcer-screenshots"></div>
        </div>
    `;

    const showMeBtn = banner.querySelector('.extension-enforcer-show-me-btn');
    if (showMeBtn) showMeBtn.innerHTML = enforcerShowMeHowButtonHtml();
    const screenshotsWrap = banner.querySelector('.extension-enforcer-screenshots-wrap');
    if (showMeBtn && screenshotsWrap) {
        showMeBtn.addEventListener('click', () => {
            const isOpen = showMeBtn.classList.toggle('open');
            screenshotsWrap.classList.toggle('hidden', !isOpen);
            showMeBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
            if (isOpen) scheduleEnforcerScreenshotSync(screenshotsWrap);
        });
    }
    const urlBtn = banner.querySelector('.extension-enforcer-action-url');
    if (urlBtn) {
        urlBtn.addEventListener('click', async () => {
            const url = urlBtn.dataset.copyUrl;
            if (!url) return;
            try {
                await navigator.clipboard.writeText(url);
                urlBtn.dataset.copiedUntil = String(Date.now() + 1500);
                urlBtn.classList.add('copied');
                urlBtn.textContent = tSettings('migrationCopied');
                setTimeout(() => {
                    delete urlBtn.dataset.copiedUntil;
                    urlBtn.classList.remove('copied');
                }, 1500);
            } catch (e) {
                console.warn('[enforcer-ui] copy URL failed:', e);
            }
        });
    }

    const setupBanner = document.getElementById('behaviour-change-banner');
    const existingBanners = document.querySelectorAll('.extension-enforcer-action-banner');
    const lastExistingBanner = existingBanners[existingBanners.length - 1];
    if (lastExistingBanner) {
        lastExistingBanner.insertAdjacentElement('afterend', banner);
    } else if (setupBanner) {
        setupBanner.insertAdjacentElement('beforebegin', banner);
    } else {
        document.querySelector('.app-container')?.prepend(banner);
    }

    banner.querySelector('.extension-enforcer-action-dismiss')?.addEventListener('click', () => {
        banner.classList.add('hidden');
    });
    return { banner, key };
}

export function enforcerClosedCopy(payload) {
    const browserRaw = payload.label || payload.browser;
    const browser = browserRaw || tSettings('enforcerBrowserFallback');
    const issue = payload.issue || 'unknown';
    if (issue === 'private') {
        const key = browserKeyFromLabel(browser);
        const instruction = key === 'chrome'
            ? tSettings('enforcerClosedInstrPrivateChrome')
            : key === 'firefox'
            ? tSettings('enforcerClosedInstrPrivateFirefox')
            : '';
        const screenshotSteps = enforcerScreenshotSteps(key);
        return {
            headline: tSettingsFmt('enforcerClosedPrivate', { browser }),
            instruction: instruction.trim(),
            action: tSettingsFmt('enforcerActionOpenExtensions', { browser }),
            actionHtml: tSettings('migrationOpenExtensionSettings'),
            screenshotSteps,
        };
    }
    if (issue === 'disabled') {
        const key = browserKeyFromLabel(browser);
        const screenshotSteps = enforcerScreenshotSteps(key);
        return {
            headline: tSettingsFmt('enforcerClosedDisabled', { browser }),
            instruction: tSettingsFmt('enforcerClosedInstrDisabled', { browser }),
            action: tSettingsFmt('enforcerActionOpenExtensions', { browser }),
            actionHtml: tSettings('migrationOpenExtensionSettings'),
            screenshotSteps,
        };
    }
    if (issue === 'missing') {
        return {
            headline: tSettingsFmt('enforcerClosedMissing', { browser }),
            instruction: tSettingsFmt('enforcerClosedInstrMissing', { browser }),
            action: tSettings('enforcerActionInstall'),
        };
    }
    if (issue === 'websiteaccess') {
        return {
            headline: tSettingsFmt('enforcerClosedWebsiteAccess', { browser }),
            instruction: tSettingsFmt('enforcerClosedInstrWebsiteAccess', { browser }),
            action: tSettingsFmt('enforcerActionOpenExtensions', { browser }),
        };
    }
    if (issue === 'access') {
        return {
            headline: tSettingsFmt('enforcerClosedAccess', { browser }),
            instruction: browser === 'Safari' ? tSettings('enforcerClosedInstrAccessSafari') : '',
            action: browser === 'Safari'
                ? tSettings('migrationOpenExtensionSettings')
                : tSettingsFmt('enforcerActionOpenBrowserSettings', { browser }),
        };
    }
    if (issue === 'automation') {
        return {
            headline: tSettingsFmt('enforcerClosedAutomation', { browser }),
            instruction: tSettingsFmt('enforcerClosedInstrAutomation', { browser }),
            action: tSettings('migrationOpenAutomationSettings'),
            hideUrlChip: true,
            screenshotSteps: automationScreenshotSteps(),
        };
    }
    return {
        headline: tSettingsFmt('enforcerClosedDefault', { browser }),
        instruction: tSettingsFmt('enforcerClosedInstrDefault', { browser }),
        action: tSettingsFmt('enforcerActionOpenExtensions', { browser }),
    };
}

export async function openEnforcerFix(payload) {
    const browser = payload.label || payload.browser || 'Chrome';
    const key = browserKeyFromLabel(browser);
    try {
        if (payload.issue === 'automation') {
            await tauriAPI.openAutomationSettings();
            return;
        }
        if (payload.issue === 'missing' && key && BROWSER_STORE_LINKS[key]?.url) {
            try {
                await invoke('open_url_in_browser', { browser: key, url: BROWSER_STORE_LINKS[key].url });
            } catch (_) {
                await openUrl(BROWSER_STORE_LINKS[key].url);
            }
            return;
        }
        if (payload.issue === 'access' && key === 'safari') {
            await openExtensionSettings('safari');
            return;
        }
        await openExtensionSettings(key || browser);
    } catch (e) {
        console.warn('[enforcer-ui] fix action failed:', e);
    }
}

export function populateEnforcerUrlChip(button, key) {
    const href = extensionsUrl(key);
    button.replaceChildren();
    button.dataset.browserKey = key;
    button.classList.toggle('extension-enforcer-action-url-static', !isCopyableExtensionsTarget(key));
    delete button.dataset.copyUrl;
    button.disabled = !isCopyableExtensionsTarget(key);
    if (!isCopyableExtensionsTarget(key)) {
        button.classList.remove('copied');
        button.textContent = href;
        return;
    }
    button.dataset.copyUrl = href;
    const copied = Number(button.dataset.copiedUntil || 0) > Date.now();
    button.classList.toggle('copied', copied);
    if (copied) {
        button.textContent = tSettings('migrationCopied');
        return;
    }

    const text = document.createElement('span');
    text.textContent = href;
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('width', '13');
    icon.setAttribute('height', '13');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '2');
    icon.setAttribute('stroke-linecap', 'round');
    icon.setAttribute('stroke-linejoin', 'round');
    icon.setAttribute('aria-hidden', 'true');
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', '9');
    rect.setAttribute('y', '9');
    rect.setAttribute('width', '13');
    rect.setAttribute('height', '13');
    rect.setAttribute('rx', '2');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1');
    icon.append(rect, path);
    button.append(text, icon);
}

export async function copyEnforcerUrlChip(button) {
    const url = button.dataset.copyUrl;
    if (!url || button.disabled) return;
    try {
        await navigator.clipboard.writeText(url);
        button.dataset.copiedUntil = String(Date.now() + 1500);
        button.classList.add('copied');
        button.textContent = tSettings('migrationCopied');
        setTimeout(() => {
            delete button.dataset.copiedUntil;
            button.classList.remove('copied');
            populateEnforcerUrlChip(button, button.dataset.browserKey || '');
        }, 1500);
    } catch (e) {
        console.warn('[enforcer-ui] copy URL failed:', e);
    }
}

export function scheduleEnforcerScreenshotSync(wrap) {
    if (__ANDROID_BUILD__) return;
    if (!wrap) return;
    requestAnimationFrame(() => {
        syncEnforcerScreenshotHeights(wrap);
        requestAnimationFrame(() => syncEnforcerScreenshotHeights(wrap));
        wrap.querySelectorAll('.extension-enforcer-screenshot').forEach(img => {
            if (img.complete) return;
            img.addEventListener('load', () => scheduleEnforcerScreenshotSync(wrap), { once: true });
        });
    });
}

export function syncAllEnforcerScreenshotHeights() {
    if (__ANDROID_BUILD__) return;
    document.querySelectorAll('.extension-enforcer-screenshots-wrap:not(.hidden)')
        .forEach(scheduleEnforcerScreenshotSync);
}

/** Size enforcer how-to screenshots to fill remaining viewport height. */
export function syncEnforcerScreenshotHeights(wrap) {
    if (__ANDROID_BUILD__) return;
    if (!wrap || wrap.classList.contains('hidden')) {
        if (wrap) {
            wrap.style.maxHeight = '';
            wrap.style.overflowY = '';
        }
        return;
    }

    const container = wrap.querySelector('.extension-enforcer-screenshots');
    if (!container) return;

    const images = [...container.querySelectorAll('.extension-enforcer-screenshot')];
    images.forEach(img => {
        img.style.maxHeight = '';
        img.style.width = '';
        img.style.height = '';
    });

    const bottomPadding = 10;
    const availableTotal = Math.max(
        180,
        window.innerHeight - wrap.getBoundingClientRect().top - bottomPadding,
    );
    wrap.style.maxHeight = `${availableTotal}px`;
    wrap.style.overflowY = 'auto';

    const containerStyle = getComputedStyle(container);
    const panelOverhead = parseFloat(containerStyle.paddingTop)
        + parseFloat(containerStyle.paddingBottom)
        + 8;
    const labels = [...container.querySelectorAll('.extension-enforcer-step-label')];
    const labelOverhead = labels.length
        ? Math.max(...labels.map(label => label.getBoundingClientRect().height)) + 6
        : 0;
    const maxImgHeight = Math.max(160, availableTotal - panelOverhead - labelOverhead);

    images.forEach(img => {
        const step = img.closest('.extension-enforcer-step');
        const columnWidth = step?.getBoundingClientRect().width || 0;
        const naturalW = img.naturalWidth;
        const naturalH = img.naturalHeight;

        img.style.maxHeight = '';
        img.style.maxWidth = '';
        img.style.width = '';
        img.style.height = '';

        if (naturalW > 0 && naturalH > 0 && columnWidth > 0) {
            const heightAtFullWidth = (columnWidth / naturalW) * naturalH;
            if (heightAtFullWidth <= maxImgHeight) {
                img.style.width = `${Math.round(columnWidth)}px`;
                img.style.height = `${Math.round(heightAtFullWidth)}px`;
            } else {
                img.style.width = `${Math.round((maxImgHeight / naturalH) * naturalW)}px`;
                img.style.height = `${Math.round(maxImgHeight)}px`;
            }
            return;
        }

        img.style.maxHeight = `${maxImgHeight}px`;
        img.style.maxWidth = columnWidth > 0 ? `${Math.round(columnWidth)}px` : '100%';
        img.style.width = 'auto';
        img.style.height = 'auto';
    });
}

export function applyScreenshotContainerLayout(container, steps, { browserKey } = {}) {
    if (!container || !steps?.length) return;
    container.classList.toggle('screenshots-grid', steps.length >= 3);
    container.classList.toggle('screenshots-row', steps.length < 3);
    container.classList.toggle(
        'screenshots-plain',
        steps.length === 1 && steps.every(s => s.plainPanel),
    );
    container.classList.toggle(
        'safari-screenshots-asymmetric',
        browserKey === 'safari' && steps.length === 2,
    );
}

export function renderEnforcerScreenshots(container, steps, browserKey) {
    if (__ANDROID_BUILD__) return;
    if (!container || !steps?.length) return;
    const stepsKey = `${browserKey}:${steps.map(s => s.src).join(',')}`;
    if (container.dataset.stepsKey === stepsKey) return;
    container.dataset.stepsKey = stepsKey;
    container.innerHTML = '';
    applyScreenshotContainerLayout(container, steps, { browserKey });
    steps.forEach((step, i) => {
        const figure = document.createElement('figure');
        figure.className = 'extension-enforcer-step';
        const cap = formatExtensionScreenshotCaption(step, i);
        if (cap) {
            const caption = document.createElement('figcaption');
            caption.className = 'extension-enforcer-step-label';
            caption.textContent = cap;
            figure.appendChild(caption);
        }
        const img = document.createElement('img');
        img.className = 'extension-enforcer-screenshot';
        img.src = step.src;
        img.alt = screenshotAltText(step, i, cap);
        figure.appendChild(img);
        container.appendChild(figure);
    });
    const wrap = container.closest('.extension-enforcer-screenshots-wrap');
    if (wrap && !wrap.classList.contains('hidden')) {
        scheduleEnforcerScreenshotSync(wrap);
    }
}

export function closedIssueCopyKey(issue) {
    switch (issue) {
        case 'missing': return 'enforcerClosedCombinedMissing';
        case 'disabled': return 'enforcerClosedCombinedDisabled';
        case 'private': return 'enforcerClosedCombinedPrivate';
        case 'websiteaccess': return 'enforcerClosedCombinedWebsiteAccess';
        case 'access': return 'enforcerClosedCombinedAccess';
        case 'automation': return 'enforcerClosedCombinedAutomation';
        default: return 'enforcerClosedCombinedDefault';
    }
}

export function closedInstructionCopyKey(issue) {
    switch (issue) {
        case 'missing': return 'enforcerClosedInstrMissing';
        case 'disabled': return 'enforcerClosedInstrDisabled';
        case 'private': return 'enforcerClosedInstrPrivateGeneric';
        case 'websiteaccess': return 'enforcerClosedInstrWebsiteAccess';
        case 'access': return 'enforcerClosedInstrDefault';
        case 'automation': return 'enforcerClosedInstrAutomationGeneric';
        default: return 'enforcerClosedInstrDefault';
    }
}

export function ensureClosedBannerBrowserIcon(banner) {
    const content = banner.querySelector('.update-banner-content');
    if (!content) return null;
    let icon = content.querySelector('.extension-enforcer-browser-icon');
    if (!icon) {
        icon = document.createElement('img');
        icon.className = 'extension-enforcer-browser-icon';
        icon.setAttribute('aria-hidden', 'true');
        const message = content.querySelector('.extension-enforcer-message');
        if (message) content.insertBefore(icon, message);
        else content.prepend(icon);
    }
    return icon;
}

export function partitionEnforcerStates(states) {
    const automation = [];
    const focus = [];
    for (const state of states) {
        if (state.payload?.issue === 'automation') automation.push(state);
        else focus.push(state);
    }
    return { automation, focus };
}

export function renderEnforcerAutomationActionRow(automationStates, mode) {
    if (__ANDROID_BUILD__) return;
    const row = document.createElement('div');
    row.className = 'extension-enforcer-browser-action-row extension-enforcer-automation-row';

    const action = document.createElement('button');
    action.className = 'update-banner-btn extension-enforcer-action-btn';
    action.type = 'button';
    action.textContent = tSettings('migrationOpenAutomationSettings');
    const keys = automationStates.map((s) => s.key);
    action.onclick = async () => {
        try {
            await tauriAPI.openAutomationSettings();
            if (mode === 'closed') scheduleAutomationVerificationPoll(keys);
        } catch (e) {
            console.warn('[enforcer-ui] automation fix failed:', e);
        }
    };
    row.appendChild(action);

    const steps = automationScreenshotSteps();
    const showMe = document.createElement('button');
    showMe.className = 'extension-enforcer-show-me-btn';
    showMe.type = 'button';
    showMe.setAttribute('aria-expanded', 'false');
    showMe.innerHTML = enforcerShowMeHowButtonHtml();
    showMe.classList.toggle('hidden', !steps?.length);
    showMe.onclick = () => {
        const banner = mode === 'closed'
            ? ensureClosedEnforcerActionBanner()
            : ensureActiveEnforcerActionBanner();
        const screenshotsWrap = banner.querySelector('.extension-enforcer-screenshots-wrap');
        const screenshots = banner.querySelector('.extension-enforcer-screenshots');
        if (!steps?.length || !screenshotsWrap || !screenshots) return;
        const browserKey = keys[0] || 'chrome';
        const wasOpen = !screenshotsWrap.classList.contains('hidden')
            && screenshots.dataset.stepsKey?.startsWith(`${browserKey}:`);
        if (wasOpen) {
            screenshotsWrap.classList.add('hidden');
            showMe.classList.remove('open');
            showMe.setAttribute('aria-expanded', 'false');
        } else {
            renderEnforcerScreenshots(screenshots, steps, browserKey);
            screenshotsWrap.classList.remove('hidden');
            showMe.classList.add('open');
            showMe.setAttribute('aria-expanded', 'true');
            scheduleEnforcerScreenshotSync(screenshotsWrap);
        }
    };
    row.appendChild(showMe);

    return row;
}

export function renderEnforcerActionRows(states, mode) {
    if (__ANDROID_BUILD__) return;
    const { automation, focus } = partitionEnforcerStates(states);
    const frag = document.createDocumentFragment();
    if (automation.length) frag.appendChild(renderEnforcerAutomationActionRow(automation, mode));
    for (const state of focus) frag.appendChild(renderEnforcerBrowserActionRow(state, mode));
    return frag;
}

export function renderEnforcerBrowserActionRow(state, mode) {
    if (__ANDROID_BUILD__) return;
    const row = document.createElement('div');
    row.className = 'extension-enforcer-browser-action-row';

    if (mode !== 'closed') {
        const icon = document.createElement('img');
        icon.className = 'extension-enforcer-browser-action-icon';
        icon.src = browserIconUrl(state.key);
        icon.alt = '';
        row.appendChild(icon);
    }

    const action = document.createElement('button');
    action.className = 'update-banner-btn extension-enforcer-action-btn';
    action.type = 'button';
    if (state.copy.actionHtml) {
        action.innerHTML = state.copy.actionHtml;
    } else {
        action.textContent = state.copy.action || tSettingsFmt('enforcerActionOpenExtensions', { browser: state.payload.label || state.payload.browser || state.key });
    }
    action.onclick = () => openEnforcerFix(state.payload);
    row.appendChild(action);

    const showMe = document.createElement('button');
    showMe.className = 'extension-enforcer-show-me-btn';
    showMe.type = 'button';
    showMe.setAttribute('aria-expanded', 'false');
    showMe.innerHTML = enforcerShowMeHowButtonHtml();
    const steps = state.copy.screenshotSteps;
    showMe.classList.toggle('hidden', !steps?.length);
    showMe.onclick = () => {
        const banner = mode === 'closed'
            ? ensureClosedEnforcerActionBanner()
            : ensureActiveEnforcerActionBanner();
        const screenshotsWrap = banner.querySelector('.extension-enforcer-screenshots-wrap');
        const screenshots = banner.querySelector('.extension-enforcer-screenshots');
        if (!steps?.length || !screenshotsWrap || !screenshots) return;
        const wasOpen = !screenshotsWrap.classList.contains('hidden')
            && screenshots.dataset.stepsKey?.startsWith(`${state.key}:`);
        if (wasOpen) {
            screenshotsWrap.classList.add('hidden');
            showMe.classList.remove('open');
            showMe.setAttribute('aria-expanded', 'false');
        } else {
            renderEnforcerScreenshots(screenshots, steps, state.key);
            screenshotsWrap.classList.remove('hidden');
            showMe.classList.add('open');
            showMe.setAttribute('aria-expanded', 'true');
            scheduleEnforcerScreenshotSync(screenshotsWrap);
        }
    };
    row.appendChild(showMe);

    // The automation issue has no extension URL to copy — skip the chip.
    if (!state.copy.hideUrlChip) {
        const url = document.createElement('button');
        url.type = 'button';
        url.className = 'extension-enforcer-action-url';
        if (state.urlCopiedUntil) url.dataset.copiedUntil = String(state.urlCopiedUntil);
        populateEnforcerUrlChip(url, state.key);
        url.onclick = async () => {
            await copyEnforcerUrlChip(url);
            const store = mode === 'closed' ? enforcerClosedBannerStates : enforcerActionBannerStates;
            const stored = store.get(state.key);
            if (stored) stored.urlCopiedUntil = Number(url.dataset.copiedUntil || 0);
        };
        row.appendChild(url);
    }

    return row;
}

export function hasActiveEnforcerCountdown() {
    const now = Date.now();
    return [...enforcerActionBannerStates.values()].some(state =>
        state.closing || state.deadline > now);
}

export function promoteEnforcerActionToClosed(key, payload) {
    if (!payload) return;
    enforcerClosedBannerStates.set(key, {
        ...(enforcerClosedBannerStates.get(key) || {}),
        payload,
        closedAt: Date.now(),
    });
}

export function resetEnforcerClosedBannerCycle() {
    if (enforcerClosedBannerStates.size === 0) return;
    enforcerClosedBannerStates.clear();
    stopEnforcerClosedBannerPoll();
    document.getElementById(ENFORCER_CLOSED_BANNER_ID)?.classList.add('hidden');
}

export function renderCombinedEnforcerActionBanner() {
    if (__ANDROID_BUILD__) return;
    const banner = ensureActiveEnforcerActionBanner();
    const states = [...enforcerActionBannerStates.entries()].map(([key, state]) => ({ key, ...state }));
    if (states.length === 0) {
        banner.classList.add('hidden');
        renderCombinedEnforcerClosedBanner();
        return;
    }

    const activeStates = states
        .map(state => {
            const remainingSecs = state.closing
                ? 0
                : Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000));
            const payload = { ...state.payload, remaining_secs: remainingSecs, remainingSecs };
            return { ...state, payload, remainingSecs, copy: enforcerCopy(payload) };
        })
        .filter(state => state.remainingSecs > 0 || state.closing);

    if (activeStates.length === 0) {
        banner.classList.add('hidden');
        renderCombinedEnforcerClosedBanner();
        return;
    }

    const allClosing = activeStates.every(state => state.closing);
    const timerState = activeStates.reduce((max, state) => (
        state.remainingSecs > max.remainingSecs ? state : max
    ), activeStates[0]);
    const labels = activeStates.map(state => state.payload.label || state.payload.browser || BROWSER_STORE_LINKS[state.key]?.label || state.key);
    const browserList = formatBrowserList(labels);

    const headline = banner.querySelector('.extension-enforcer-action-headline-text');
    if (headline) {
        headline.textContent = allClosing
            ? tSettingsFmt('enforcerClosingNowHeadline', { browser: browserList })
            : tSettingsFmt('enforcerClosingHeadline', { browser: browserList });
    }

    const instruction = banner.querySelector('.extension-enforcer-action-instruction');
    if (instruction) {
        const { automation, focus } = partitionEnforcerStates(activeStates);
        const base = activeStates.length > 1
            ? (automation.length && !focus.length
                ? tSettings('enforcerCountdownInstrAutomation')
                : tSettings('enforcerCountdownInstrMultiple'))
            : (timerState.copy.countdownInstruction || '');
        renderEnforcerCountdownInstruction(instruction, base);
    }

    const countdown = banner.querySelector('.extension-enforcer-action-countdown');
    const countdownRow = banner.querySelector('.extension-enforcer-action-countdown-row');
    if (countdownRow) countdownRow.classList.toggle('hidden', allClosing);
    if (countdown) {
        if (allClosing) {
            countdown.replaceChildren();
        } else {
            const mins = Math.floor(timerState.remainingSecs / 60);
            const secs = String(timerState.remainingSecs % 60).padStart(2, '0');
            countdown.replaceChildren();
            const time = document.createElement('strong');
            time.className = 'extension-enforcer-countdown-time';
            time.textContent = `${mins}:${secs}`;
            const label = document.createElement('span');
            label.className = 'extension-enforcer-countdown-label';
            label.textContent = tSettings('enforcerCountdownRemaining');
            countdown.append(time, label);
        }
    }

    const progress = banner.querySelector('.extension-enforcer-progress-bar');
    if (progress) {
        const totalRaw = timerState.payload.total_secs ?? timerState.payload.totalSecs ?? timerState.remainingSecs;
        const total = Math.max(1, Number(totalRaw || 1));
        const pct = Math.max(0, Math.min(100, (timerState.remainingSecs / total) * 100));
        progress.style.width = `${pct}%`;
    }

    const actions = banner.querySelector('.extension-enforcer-active-actions');
    if (actions) {
        actions.innerHTML = '';
        actions.appendChild(renderEnforcerActionRows(activeStates, 'active'));
    }

    banner.classList.remove('hidden', 'extension-enforcer-action-banner-closed');
    document.getElementById(ENFORCER_CLOSED_BANNER_ID)?.classList.add('hidden');
}

export function updateEnforcerActionBannerCountdown() {
    if (__ANDROID_BUILD__) return;
    if (enforcerActionBannerStates.size === 0) return;
    for (const [key, state] of enforcerActionBannerStates) {
        const remainingSecs = Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000));
        const payload = {
            ...state.payload,
            remaining_secs: remainingSecs,
            remainingSecs,
        };
        state.payload = payload;
        // Smooth handoff: once the local countdown reaches zero, keep
        // the active banner alive in "Closing..." mode until the
        // backend confirms the browser is gone (post-close) or resolved.
        if (remainingSecs <= 0) {
            state.closing = true;
        }
    }
    renderCombinedEnforcerActionBanner();
    if (enforcerActionBannerStates.size === 0 && enforcerActionBannerInterval) {
        clearInterval(enforcerActionBannerInterval);
        enforcerActionBannerInterval = null;
    }
}

export function renderEnforcerActionBanner(payload) {
    if (__ANDROID_BUILD__) return;
    if (!payload || !payload.browser) return;
    const key = enforcerBannerKey(payload);
    if (enforcerActionBannerStates.size === 0) {
        // A fresh countdown starts a new enforcement cycle. Drop any
        // previous post-close browsers so the next closed banner only
        // reflects browsers involved in this cycle.
        resetEnforcerClosedBannerCycle();
    }

    const remainingSecs = Math.max(0, Number(payload.remaining_secs ?? payload.remainingSecs ?? 0));
    const existing = enforcerActionBannerStates.get(key);
    enforcerActionBannerStates.set(key, {
        payload: { ...payload, remaining_secs: remainingSecs, remainingSecs },
        deadline: Date.now() + remainingSecs * 1000,
        closing: payload.closing != null ? !!payload.closing : (existing?.closing ?? false),
        urlCopiedUntil: existing?.urlCopiedUntil,
    });

    renderCombinedEnforcerActionBanner();
    document.getElementById(ENFORCER_CLOSED_BANNER_ID)?.classList.add('hidden');
    if (!enforcerActionBannerInterval) {
        enforcerActionBannerInterval = setInterval(updateEnforcerActionBannerCountdown, 1000);
    }
}

export function renderCombinedEnforcerClosedBanner() {
    if (__ANDROID_BUILD__) return;
    const banner = ensureClosedEnforcerActionBanner();
    if (hasActiveEnforcerCountdown()) {
        banner.classList.add('hidden');
        return;
    }

    const states = [...enforcerClosedBannerStates.entries()]
        .map(([key, state]) => ({ key, ...state, copy: enforcerClosedCopy(state.payload) }));

    if (states.length === 0) {
        banner.classList.add('hidden');
        stopEnforcerClosedBannerPoll();
        return;
    }

    ensureEnforcerClosedBannerPoll();

    banner.querySelector('.extension-enforcer-action-right')?.remove();

    const browserList = formatBrowserList(states.map(state => (
        state.payload.label || state.payload.browser || BROWSER_STORE_LINKS[state.key]?.label || state.key
    )));
    const issue = states.every(state => state.payload.issue === states[0].payload.issue)
        ? states[0].payload.issue
        : 'unknown';

    const headline = banner.querySelector('.extension-enforcer-action-headline-text');
    if (headline) {
        headline.textContent = states.length === 1
            ? states[0].copy.headline
            : tSettingsFmt(closedIssueCopyKey(issue), { browser: browserList });
    }

    const browserIcon = ensureClosedBannerBrowserIcon(banner);
    if (browserIcon) {
        if (states.length === 1) {
            browserIcon.src = browserIconUrl(states[0].key);
            browserIcon.alt = '';
            browserIcon.style.visibility = 'visible';
        } else {
            browserIcon.style.visibility = 'hidden';
        }
    }

    const instruction = banner.querySelector('.extension-enforcer-action-instruction');
    if (instruction) {
        const { automation, focus } = partitionEnforcerStates(states);
        if (states.length > 1) {
            if (automation.length && !focus.length) {
                instruction.textContent = tSettingsFmt(
                    'enforcerClosedInstrAutomationGeneric',
                    { browser: formatBrowserList(automation.map((s) => (
                        s.payload.label || s.payload.browser || BROWSER_STORE_LINKS[s.key]?.label || s.key
                    ))) }
                );
            } else {
                instruction.textContent = tSettings('enforcerClosedInstrMultiple');
            }
        } else {
            // Single-browser case: pass the browser name in for
            // `{browser}` substitution. Several of these instruction
            // strings (enforcerClosedInstrDisabled / Missing /
            // WebsiteAccess) contain `{browser}` — using tSettings()
            // here left the literal placeholder visible in the UI.
            const single = states[0];
            const browser = single.payload.label
                || single.payload.browser
                || BROWSER_STORE_LINKS[single.key]?.label
                || single.key;
            instruction.textContent = tSettingsFmt(
                closedInstructionCopyKey(issue),
                { browser }
            );
        }
    }

    const actions = banner.querySelector('.extension-enforcer-closed-actions');
    if (actions) {
        actions.innerHTML = '';
        actions.appendChild(renderEnforcerActionRows(states, 'closed'));
    }

    banner.classList.remove('hidden');
}

export function renderEnforcerClosedBanner(payload) {
    if (__ANDROID_BUILD__) return;
    if (!payload || (!payload.browser && !payload.label)) return;
    const key = enforcerBannerKey(payload);
    enforcerActionBannerStates.delete(key);
    if (enforcerActionBannerStates.size === 0 && enforcerActionBannerInterval) {
        clearInterval(enforcerActionBannerInterval);
        enforcerActionBannerInterval = null;
    }
    promoteEnforcerActionToClosed(key, payload);
    renderCombinedEnforcerActionBanner();
}

export function hideEnforcerActionBanner(browser) {
    const key = browserKeyFromLabel(browser);
    enforcerActionBannerStates.delete(key);
    enforcerClosedBannerStates.delete(key);
    renderCombinedEnforcerActionBanner();
    if (enforcerActionBannerStates.size === 0 && enforcerActionBannerInterval) {
        clearInterval(enforcerActionBannerInterval);
        enforcerActionBannerInterval = null;
    }
}