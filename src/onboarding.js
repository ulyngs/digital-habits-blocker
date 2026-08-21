// Onboarding: welcome screen, EULA acceptance/persistence, desktop
// migration overlay wiring. Extracted verbatim from app.js.
import { state, appState } from './state.js';
import { invoke } from '@tauri-apps/api/core';
import { tSettings } from './i18n.js';
import { hasSeenAnyOnboarding, saveData } from './persistence.js';
import {
    AUTOMATION_BROWSER_KEYS, BROWSER_STORE_LINKS, bannerHeadlineKey, browserIconUrl,
    browserUsesAutomation, ensureSafariExtensionFdaBeforeSetup, invalidateMigrationMacCopyCache,
    lastAutomationPermissionByKey, lastOnboardingState, openExtensionSetupOverlay,
    refreshAutomationPermissionStatus, renderBrowserInstallButtons, safariUsesExtensionMode,
    startMigrationPolling, startWebAutomationWatcher, stopMigrationPolling,
    syncMigrationPostHeader, updateBehaviourChangeBanner, wireEnforcementToggle,
} from './enforcement.js';
import {
    applyEulaOnboardingLanguage, applyMigrationOverlayStaticCopy, applyRebrandOnboardingLanguage,
    applyWelcomeOnboardingLanguage, resetWelcomeDemoPanel,
} from './app.js';
import { showExclusiveOnboardingScreen, updateOnboardingVisibility } from './blocking-platform.js';

export const CURRENT_EULA_REVISION = 1;

export function isLocalDevRun() {
    if (import.meta?.env?.DEV) {
        return true;
    }
    return ['http:', 'https:'].includes(window.location.protocol)
        && ['localhost', '127.0.0.1'].includes(window.location.hostname);
}

export async function resetDevOnlyEulaAcceptance() {
    // Mobile debug builds run through Vite too, but they should behave like
    // installed apps here: once the EULA is accepted, keep respecting it.
    state.forceShowEulaThisSession = !state.isIOS && !state.isAndroid && isLocalDevRun();
}

export function getAcceptedEulaRevision() {
    const rawRevision = state.appData?.settings?.eulaAcceptedRevision;
    if (Number.isInteger(rawRevision) && rawRevision > 0) {
        return rawRevision;
    }
    if (typeof rawRevision === 'string') {
        const parsedRevision = Number.parseInt(rawRevision, 10);
        if (Number.isInteger(parsedRevision) && parsedRevision > 0) {
            return parsedRevision;
        }
    }
    if (state.appData?.settings?.eulaAccepted === true) {
        return CURRENT_EULA_REVISION;
    }
    return null;
}

export function normalizeLoadedEulaState() {
    if (!state.appData.settings) {
        state.appData.settings = {};
    }

    let changed = false;
    const acceptedRevision = getAcceptedEulaRevision();

    if (acceptedRevision == null) {
        if (state.appData.settings.eulaAcceptedRevision != null) {
            delete state.appData.settings.eulaAcceptedRevision;
            changed = true;
        }
    } else if (state.appData.settings.eulaAcceptedRevision !== acceptedRevision) {
        state.appData.settings.eulaAcceptedRevision = acceptedRevision;
        changed = true;
    }

    const rawAcceptedAt = state.appData.settings.eulaAcceptedAt;
    if (rawAcceptedAt != null) {
        const parsedAcceptedAt = Number(rawAcceptedAt);
        if (Number.isFinite(parsedAcceptedAt) && parsedAcceptedAt > 0) {
            if (state.appData.settings.eulaAcceptedAt !== parsedAcceptedAt) {
                state.appData.settings.eulaAcceptedAt = parsedAcceptedAt;
                changed = true;
            }
        } else {
            delete state.appData.settings.eulaAcceptedAt;
            changed = true;
        }
    }

    if ('eulaAccepted' in state.appData.settings) {
        delete state.appData.settings.eulaAccepted;
        changed = true;
    }

    return changed;
}

export function hasAcceptedEula() {
    return !state.forceShowEulaThisSession && getAcceptedEulaRevision() === CURRENT_EULA_REVISION;
}

// ---- Welcome screen --------------------------------------------------------
//
// Friendly one-screen intro shown once per machine, before the EULA.
// Sets context (open-source, who built it) before legal acceptance
// and the macOS Automation / Firefox extension setup overview.
//
// Persistence: `state.appData.settings.welcomeOnboardingShown` (boolean).
// Wiped by `scripts/dev-reset-fda-onboarding.sh` (incl. --nuke; it also
// clears any pre-3.x /var/lib/redd-block copy, which the backend would
// otherwise import straight back over the per-user file).
export function hasWelcomeOnboardingBeenShown() {
    return state.appData?.settings?.welcomeOnboardingShown === true;
}

export async function persistWelcomeOnboardingShown() {
    if (!state.appData.settings) state.appData.settings = {};
    state.appData.settings.welcomeOnboardingShown = true;
    try {
        await saveData();
    } catch (e) {
        console.warn('[welcome-onboarding] persist failed:', e);
    }
}

export async function runInitialOnboardingSequence() {
    if (__SYSTEM_TEST_BUILD__) {
        updateOnboardingVisibility();
        return;
    }
    if (!state.isIOS && !state.isAndroid) {
        if (shouldShowRebrandNotice()) {
            await presentRebrandNotice();
        } else if (!hasSeenRebrandNotice()) {
            // Fresh install: mark the rename notice as seen without showing
            // it, so completing onboarding later never retriggers it.
            await persistRebrandNoticeShown();
        }
    }
    if (!state.isIOS && !hasWelcomeOnboardingBeenShown()) {
        await presentWelcomeOnboarding();
        await persistWelcomeOnboardingShown();
    }
    updateOnboardingVisibility();
}

// ---- Digital Habits rename notice ------------------------------------------
//
// One-time announcement for users upgrading from ReDD Blocker: the app on
// disk is now "Digital Habits: Blocker" and the organisation behind it is
// now the Centre for Digital Habits. Desktop-only — mobile users see the
// rename in their app store update. Fresh installs never see it (the flag
// is persisted silently on first run, see runInitialOnboardingSequence).
//
// Persistence: `state.appData.settings.digitalHabitsRebrandNoticeShown`.
export function hasSeenRebrandNotice() {
    return state.appData?.settings?.digitalHabitsRebrandNoticeShown === true;
}

export function shouldShowRebrandNotice() {
    if (state.isIOS || state.isAndroid) return false;
    return hasSeenAnyOnboarding() && !hasSeenRebrandNotice();
}

export async function persistRebrandNoticeShown() {
    if (!state.appData.settings) state.appData.settings = {};
    state.appData.settings.digitalHabitsRebrandNoticeShown = true;
    try {
        await saveData();
    } catch (e) {
        console.warn('[rebrand-notice] persist failed:', e);
    }
}

export async function presentRebrandNotice() {
    const overlay = document.getElementById('rebrand-onboarding');
    const btn = document.getElementById('rebrand-onboarding-continue-btn');
    if (!overlay || !btn) return;

    showExclusiveOnboardingScreen('rebrand-onboarding');
    document.getElementById('main-content')?.classList.add('hidden');
    document.getElementById('now-blocking-row')?.classList.add('hidden');
    // Mirror the main title bar's window-control visibility (shown on
    // Windows) since this overlay covers the app's own title bar.
    const mainControlsHidden =
        document.getElementById('window-controls')?.classList.contains('hidden') ?? true;
    document.getElementById('rebrand-window-controls')?.classList.toggle('hidden', mainControlsHidden);
    applyRebrandOnboardingLanguage();

    await new Promise((resolve) => {
        const onClick = async () => {
            btn.removeEventListener('click', onClick);
            await persistRebrandNoticeShown();
            overlay.classList.add('hidden');
            updateOnboardingVisibility();
            resolve();
        };
        btn.addEventListener('click', onClick);
    });
}

export function presentWelcomeOnboarding(onContinue) {
    return (async () => {
        const overlay = document.getElementById('welcome-onboarding');
        const btn = document.getElementById('welcome-onboarding-continue-btn');
        if (!overlay || !btn) {
            return;
        }

        showExclusiveOnboardingScreen('welcome-onboarding');
        document.getElementById('main-content')?.classList.add('hidden');
        document.getElementById('now-blocking-row')?.classList.add('hidden');
        resetWelcomeDemoPanel();
        welcomeFirefoxInstalled = await detectWelcomeFirefoxInstalled();
        applyWelcomeOnboardingLanguage();

        await new Promise((resolve) => {
            const onClick = () => {
                btn.removeEventListener('click', onClick);
                overlay.classList.add('hidden');
                onContinue?.();
                resolve();
            };
            btn.addEventListener('click', onClick);
        });
    })();
}

export function syncSetupBannerHeadline() {
    const headlineEl = document.getElementById('setup-banner-headline');
    if (!headlineEl) return;
    const browsers = lastOnboardingState?.browsers;
    if (!browsers) {
        headlineEl.textContent = tSettings(state.isMacOSDesktop ? 'setupBrowsersBannerHeadlineMac' : 'setupBrowsersBannerHeadline');
        return;
    }
    const detectedKeys = Object.keys(BROWSER_STORE_LINKS).filter(k => browsers[k] && browsers[k].installed);
    headlineEl.textContent = tSettings(bannerHeadlineKey(browsers, detectedKeys));
}

export function showEulaOnboardingScreen() {
    showExclusiveOnboardingScreen('eula-onboarding');
    document.getElementById('main-content')?.classList.add('hidden');
    document.getElementById('now-blocking-row')?.classList.add('hidden');
    applyEulaOnboardingLanguage();
    const eulaContinueBtn = document.getElementById('eula-continue-btn');
    const eulaCheckbox = document.getElementById('eula-agree-checkbox');
    if (eulaCheckbox && hasAcceptedEula()) {
        eulaCheckbox.checked = true;
    }
    if (eulaContinueBtn) {
        eulaContinueBtn.disabled = !eulaCheckbox?.checked;
        eulaContinueBtn.textContent = tSettings('eulaContinueBtn');
    }
}

export function isFirstRunOnboardingInProgress() {
    if (!hasAcceptedEula()) return false;
    return state.firstRunExtensionSetupPending && !state.migrationOnboardingDismissed;
}

export function continueFirstRunOnboardingFromWelcome() {
    if (!hasAcceptedEula()) {
        updateOnboardingVisibility();
        return;
    }
    if (isFirstRunOnboardingInProgress()) {
        showEulaOnboardingScreen();
        return;
    }
    updateOnboardingVisibility();
}

/** macOS welcome screen: whether Firefox.app is on disk (step 2 gate). */
export let welcomeFirefoxInstalled = false;

export async function detectWelcomeFirefoxInstalled() {
    if (!state.isMacOSDesktop) return false;
    try {
        return !!(await invoke('is_firefox_installed'));
    } catch (e) {
        console.warn('[welcome-onboarding] is_firefox_installed failed:', e);
        return false;
    }
}

/** Cached for enforcement copy when the browser scan is not available yet. */
let enforcementCopyFirefoxInstalled = false;

export function firefoxInstalledFromState(state) {
    const b = state?.browsers?.firefox ?? appState.lastMigrationBrowserState?.browsers?.firefox;
    if (!b) return null;
    return !!b.installed;
}

export async function resolveEnforcementCopyFirefoxInstalled(state) {
    if (!appState.isMacOSDesktop) return false;
    const fromState = firefoxInstalledFromState(state);
    if (fromState !== null) {
        enforcementCopyFirefoxInstalled = fromState;
        return fromState;
    }
    enforcementCopyFirefoxInstalled = await detectWelcomeFirefoxInstalled();
    return enforcementCopyFirefoxInstalled;
}

export function migrationEnforcementDescHtml(firefoxInstalled = enforcementCopyFirefoxInstalled) {
    if (!state.isMacOSDesktop) {
        return tSettings('migrationEnforcementDescExtension');
    }
    return tSettings(firefoxInstalled
        ? 'migrationEnforcementDescMacFirefox'
        : 'migrationEnforcementDescMacAutomation');
}

export function settingsEnforcementHintHtml(firefoxInstalled = enforcementCopyFirefoxInstalled) {
    if (!state.isMacOSDesktop) {
        return tSettings('settingsEnforcementRowHintExtension');
    }
    return tSettings(firefoxInstalled
        ? 'settingsEnforcementRowHintMacFirefox'
        : 'settingsEnforcementRowHintMacAutomation');
}

export async function applyEnforcementDescCopy(state) {
    await resolveEnforcementCopyFirefoxInstalled(state);
    setHtmlById('enforcement-toggle-desc-text', migrationEnforcementDescHtml());
    setHtmlById('settings-enforcement-toggle-desc-text', settingsEnforcementHintHtml());
}

export function setHtmlById(id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
}

export function returnToWelcomeFromEula() {
    presentWelcomeOnboarding(continueFirstRunOnboardingFromWelcome);
}

// ---- Desktop onboarding (v1.1+) --------------------------------------------
//
// - Runs the idempotent first-launch migration (strip hosts markers,
//   uninstall legacy privileged helper, register native-messaging
//   manifests).
// - Queries onboarding_state to decide whether to surface the
//   Automation permission banner (macOS TCC) and/or the extension
//   compliance banner.
// - No-ops on iOS.

// Migration / extension-install onboarding state machine.
//
// Drives a single full-screen overlay used in three trigger contexts:
//   1. v1.x residue on disk → "pre" phase (explanation + admin prompt
//      → cleanup → swap to "post" phase).
//   2. v1.x residue cleaned this launch → "post" phase, framed as
//      "Cleanup complete" + browser install checklist.
//   3. Fresh user (never had v1.x; just accepted EULA) with the
//      ReDD Focus extension not yet compliant in any detected
//      browser → same screen as #2 but framed as "Welcome" (no
//      cleanup language). Dismissal persisted in localStorage so we
//      don't nag every launch — the slim extension-compliance
//      banner takes over after that.
//
// While the screen is open, the enforcer is paused (set in
// commands::enforcement::auto_start when migration was pending at
// launch). We resume it explicitly when the user dismisses post.
/** True while the welcome → EULA → extension-setup chain is in progress. */
// While the migration post-phase is on screen, the user is bouncing
// between this window and Safari (or Chrome/Firefox/etc.) toggling
// extension settings. The window-`focus` listener below already
// re-polls on tab-back, but a user who has Safari and ReDD Blocker
// side-by-side never triggers focus events as they click toggles.
// Run a low-frequency poll so the checklist ticks itself off within
// the "up to 20 seconds" window the UI already promises. Cleared
// when the overlay is dismissed.
/** Preserves "Show me how" across `renderBrowserInstallButtons` poll refreshes. */
/** Preserves Safari duplicate "How did this happen?" across poll refreshes. */
/** Snapshot for re-rendering localized browser rows when language changes mid-overlay. */
/** Skips full DOM rebuild on poll when compliance state is unchanged (prevents icon flash). */
/** Skips header/how-to HTML rewrites on poll when copy inputs are unchanged (prevents logo flash). */
export const MIGRATION_POLL_MS = 2500;
export const EXT_ONBOARDING_DISMISSED_KEY = 'reddBlockExtOnboardingDismissed';

/** Bumped each Setup open so a late Done/Skip finish cannot dismiss a newer one. */
let migrationSetupEpoch = 0;

/** Hide Setup immediately, then finish enforcer/persist work in the background. */
async function finishExtensionSetup() {
    const epoch = migrationSetupEpoch;
    hideMigrationOnboarding();
    try {
        await invoke('enforcer_start');
    } catch (e) {
        console.warn('[migration] enforcer_start failed:', e);
    }
    await startWebAutomationWatcher();
    try { localStorage.setItem(EXT_ONBOARDING_DISMISSED_KEY, String(Date.now())); }
    catch (_) { /* localStorage may be disabled; harmless */ }
    await persistOnboardingComplete();
    await persistMacAutomationIntroShown();
    if (epoch !== migrationSetupEpoch) return;
    try {
        const fresh = await invoke('onboarding_state');
        await updateBehaviourChangeBanner(fresh);
    } catch (e) { /* no-op */ }
}

// Document-level capture so Done/Skip keep working even if content wiring throws.
let migrationFinishDelegationWired = false;
function wireMigrationFinishDelegation() {
    if (migrationFinishDelegationWired) return;
    migrationFinishDelegationWired = true;
    document.addEventListener('click', (event) => {
        const btn = event.target?.closest?.('#migration-done-btn, #migration-skip-btn');
        if (!btn || btn.disabled) return;
        if (!appState.migrationOnboardingActive) return;
        void finishExtensionSetup();
    }, true);
}

export async function runDesktopOnboarding() {
    if (__SYSTEM_TEST_BUILD__) return;
    if (state.isIOS || state.isAndroid) return;
    try {
        const pendingAtLaunch = await invoke('migration_pending');
        const wasUpgrade = await invoke('migration_was_pending_at_launch');

        if (pendingAtLaunch) {
            // Residue still present → show pre-prompt screen.
            await showMigrationOnboarding('pre');
            return;
        }
        if (wasUpgrade && !state.migrationOnboardingDismissed) {
            // Residue cleaned this launch (or by an earlier launch
            // before the user dismissed). Show the post-cleanup
            // screen so they know what changed and install the
            // extension. Cleanup-mode framing.
            const onboardingState = await invoke('onboarding_state');
            await showMigrationOnboarding('post', onboardingState, { mode: 'after-cleanup' });
            return;
        }

        const onboardingState = await invoke('onboarding_state');

        // Returning macOS upgraders: one-time intro before the full browser-
        // setup overlay (which would take over the window and hide this).
        if (await maybeShowMacAutomationIntro(onboardingState)) {
            return;
        }

        // Fresh-user case: surface the extension setup screen until the
        // user dismisses it. renderBrowserInstallButtons falls back to a
        // Chrome row when no installed browsers are detected yet.
        await ensureExtensionSetupOnboardingShown();

        if (state.migrationOnboardingActive) return;

        await updateBehaviourChangeBanner(onboardingState);
    } catch (e) {
        console.warn('[onboarding] state check failed:', e);
    }
}

export function hasMacAutomationIntroBeenShown() {
    return state.appData?.settings?.macAutomationIntroShown === true;
}

export async function persistMacAutomationIntroShown() {
    if (!state.appData.settings) state.appData.settings = {};
    if (state.appData.settings.macAutomationIntroShown) return;
    state.appData.settings.macAutomationIntroShown = true;
    try {
        await saveData();
    } catch (e) {
        console.warn('[mac-automation-intro] persist failed:', e);
    }
}

export async function persistOnboardingComplete() {
    if (!state.appData.settings) state.appData.settings = {};
    if (state.appData.settings.onboardingComplete) return;
    state.appData.settings.onboardingComplete = true;
    try {
        await saveData();
    } catch (e) {
        console.warn('[onboarding] persist onboardingComplete failed:', e);
    }
}

export function applyMacAutomationIntroCopy() {
    const setText = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    };
    const setHtml = (id, html) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = html;
    };

    setText('mac-automation-intro-badge-text', tSettings('macAutomationIntroBadge'));
    setText('mac-automation-intro-title', tSettings('macAutomationIntroTitle'));
    setHtml('mac-automation-intro-lead', tSettings('macAutomationIntroLeadHtml'));
    setText('mac-automation-intro-automation-browsers-label', tSettings('macAutomationIntroAutomationBrowsers'));
    setText('mac-automation-intro-automation-method', tSettings('macAutomationIntroAutomationMethod'));
    setText('mac-automation-intro-firefox-label', tSettings('macAutomationIntroFirefoxLabel'));
    setText('mac-automation-intro-extension-method', tSettings('macAutomationIntroExtensionMethod'));
    setHtml('mac-automation-intro-unchanged', tSettings('macAutomationIntroUnchangedHtml'));
    setText('mac-automation-intro-dismiss-btn', tSettings('macAutomationIntroDismissBtn'));
    setText('mac-automation-intro-review-btn', tSettings('macAutomationIntroReviewBtn'));

    const stack = document.getElementById('mac-automation-intro-automation-icons');
    if (stack && !stack.dataset.ready) {
        for (const key of ['safari', 'chrome', 'edge', 'brave']) {
            const img = document.createElement('img');
            img.src = browserIconUrl(key);
            img.alt = '';
            img.className = 'mac-automation-intro-stack-icon';
            stack.appendChild(img);
        }
        stack.dataset.ready = '1';
    }
    const firefoxIcon = document.getElementById('mac-automation-intro-firefox-icon');
    if (firefoxIcon) firefoxIcon.src = browserIconUrl('firefox');
}

export function hideMacAutomationIntroModal() {
    document.getElementById('mac-automation-intro-modal')?.classList.add('hidden');
}

export async function dismissMacAutomationIntroModal({ openSetup = false } = {}) {
    await persistMacAutomationIntroShown();
    hideMacAutomationIntroModal();
    if (openSetup) {
        await openExtensionSetupOverlay();
    }
}

// True when ReDD Focus was previously set up in a browser that now
// blocks via Automation — i.e. they used the old extension-based model.
export function hadLegacyAutomationBrowserExtension(state) {
    const browsers = state?.browsers || {};
    for (const key of AUTOMATION_BROWSER_KEYS) {
        const b = browsers[key];
        if (!b?.installed) continue;
        const profiles = b.profiles || [];
        if (key === 'safari') {
            if (profiles.some((p) => p.installed)) return true;
            continue;
        }
        const def = profiles.find((p) => p.isDefault) || profiles[0];
        if (def?.installed) return true;
    }
    return false;
}

export async function shouldShowMacAutomationIntro(onboardingState) {
    if (!appState.isMacOSDesktop || !hasAcceptedEula() || !hasWelcomeOnboardingBeenShown()) return false;
    if (hasMacAutomationIntroBeenShown() || appState.migrationOnboardingActive) return false;

    const extDismissed = !!localStorage.getItem(EXT_ONBOARDING_DISMISSED_KEY);
    const returningUser = appState.appData?.settings?.onboardingComplete === true || extDismissed;
    if (!returningUser) return false;

    // Fresh first-run path after EULA — browser-setup overlay covers it.
    if (appState.firstRunExtensionSetupPending && !extDismissed) return false;

    await refreshAutomationPermissionStatus();
    const browsers = onboardingState?.browsers || {};
    const automationKeys = AUTOMATION_BROWSER_KEYS.filter(
        (k) => browsers[k]?.installed && browserUsesAutomation(k),
    );
    if (automationKeys.length === 0) {
        await persistMacAutomationIntroShown();
        return false;
    }

    const allAutomationGranted = automationKeys.every(
        (k) => (lastAutomationPermissionByKey[k] || 'unknown') === 'granted',
    );
    if (allAutomationGranted) {
        await persistMacAutomationIntroShown();
        return false;
    }

    // Prefer the legacy-extension signal for ambiguous cases; anyone who
    // already finished onboarding is treated as an upgrader.
    if (!hadLegacyAutomationBrowserExtension(onboardingState)
        && appState.appData?.settings?.onboardingComplete !== true) {
        return false;
    }

    return true;
}

export async function maybeShowMacAutomationIntro(onboardingState) {
    if (!(await shouldShowMacAutomationIntro(onboardingState))) return false;
    applyMacAutomationIntroCopy();
    document.getElementById('migration-onboarding')?.classList.add('hidden');
    appState.migrationOnboardingActive = false;
    stopMigrationPolling();
    document.getElementById('main-content')?.classList.remove('hidden');
    document.getElementById('now-blocking-row')?.classList.remove('hidden');
    document.getElementById('mac-automation-intro-modal')?.classList.remove('hidden');
    return true;
}

export function setupMacAutomationIntroModal() {
    const modal = document.getElementById('mac-automation-intro-modal');
    if (!modal || modal._wired) return;
    modal._wired = true;

    document.getElementById('mac-automation-intro-dismiss-btn')
        ?.addEventListener('click', () => { void dismissMacAutomationIntroModal(); });
    document.getElementById('mac-automation-intro-review-btn')
        ?.addEventListener('click', () => { void dismissMacAutomationIntroModal({ openSetup: true }); });
    modal.addEventListener('click', (e) => {
        if (e.target === modal) void dismissMacAutomationIntroModal();
    });
}

export async function ensureExtensionSetupOnboardingShown() {
    if (state.isIOS || state.isAndroid || state.migrationOnboardingActive) return;
    if (safariUsesExtensionMode()) {
        await ensureSafariExtensionFdaBeforeSetup();
    }
    const dismissed = localStorage.getItem(EXT_ONBOARDING_DISMISSED_KEY);
    if (!state.firstRunExtensionSetupPending && (dismissed || state.migrationOnboardingDismissed)) return;
    try {
        if (state.firstRunExtensionSetupPending) {
            state.migrationOnboardingDismissed = false;
        }
        const onboardingState = await invoke('onboarding_state');
        await showMigrationOnboarding('post', onboardingState, { mode: 'fresh' });
    } catch (e) {
        console.warn('[onboarding] extension setup overlay failed:', e);
    }
}

export async function showMigrationOnboarding(phase, onboardingState, opts = {}) {
    const screen = document.getElementById('migration-onboarding');
    const pre = document.getElementById('migration-phase-pre');
    const post = document.getElementById('migration-phase-post');
    const main = document.getElementById('main-content');
    const howto = document.getElementById('migration-howto');
    if (!screen || !pre || !post) return;

    migrationSetupEpoch += 1;
    wireMigrationFinishDelegation();

    applyMigrationOverlayStaticCopy();
    pre.classList.toggle('hidden', phase !== 'pre');
    post.classList.toggle('hidden', phase !== 'post');

    // Configure framing before reveal so we never flash the wrong copy.
    if (phase === 'post') {
        const mode = opts.mode || 'fresh';
        const title = document.getElementById('migration-post-title');
        const subtitle = document.getElementById('migration-post-subtitle');
        const titleRow = document.getElementById('migration-post-title-row');
        const cleanupItems = post.querySelectorAll('.migration-cleanup-only');
        if (mode === 'after-cleanup') {
            if (title) {
                title.textContent = tSettings('migrationPostTitleCleanup');
            }
            if (subtitle) {
                subtitle.textContent = tSettings('migrationPostSubtitleCleanup');
            }
            titleRow?.classList.remove('hidden');
            cleanupItems.forEach(el => el.classList.remove('hidden'));
        } else {
            titleRow?.classList.add('hidden');
            cleanupItems.forEach(el => el.classList.add('hidden'));
        }
        howto?.classList.toggle('hidden', mode !== 'fresh');
    }

    // Reveal before wiring so a wiring error cannot leave a blank main UI.
    showExclusiveOnboardingScreen('migration-onboarding');
    state.migrationOnboardingActive = true;
    state.migrationOnboardingDismissed = false;
    startMigrationPolling();
    document.getElementById('now-blocking-row')?.classList.add('hidden');
    if (main) main.classList.add('hidden');

    try {
        if (phase === 'post') {
            state.lastMigrationBrowserRenderSignature = '';
            syncMigrationPostHeader(onboardingState);
            wireMigrationPostPhase(onboardingState);
        } else if (phase === 'pre') {
            wireMigrationPrePhase();
        }
    } catch (e) {
        console.error('[migration] overlay wiring failed:', e);
    }

    // Bring our window back to the front. The osascript admin
    // prompt steals focus, and on macOS we run as a menu-bar
    // accessory (no dock icon), so `window.setFocus` alone isn't
    // enough — we need NSApp.activate(ignoringOtherApps:). The
    // backend `activate_app` command does that. We retry twice with
    // a small delay because macOS doesn't always restore focus
    // immediately after osascript exits.
    const focusBack = async () => {
        try { await invoke('activate_app'); } catch (e) {
            console.warn('[migration] activate_app failed:', e);
        }
    };
    await focusBack();
    setTimeout(focusBack, 250);
}


export function pauseMigrationOnboardingForBackNavigation() {
    document.getElementById('migration-onboarding')?.classList.add('hidden');
    state.migrationOnboardingActive = false;
    stopMigrationPolling();
}

export function syncMigrationPostBackButtonVisibility() {
    const backBtn = document.getElementById('migration-back-btn');
    if (backBtn) {
        backBtn.classList.toggle('hidden', !state.firstRunExtensionSetupPending);
    }
}

export async function returnFromExtensionSetupOnboarding() {
    if (!state.firstRunExtensionSetupPending) return;
    state.extensionSetupPausedForBackNavigation = true;
    pauseMigrationOnboardingForBackNavigation();
    showEulaOnboardingScreen();
}

export function hideMigrationOnboarding() {
    const screen = document.getElementById('migration-onboarding');
    const main = document.getElementById('main-content');
    const nowBlockingRow = document.getElementById('now-blocking-row');
    if (screen) screen.classList.add('hidden');
    if (main) main.classList.remove('hidden');
    if (nowBlockingRow) nowBlockingRow.classList.remove('hidden');
    state.migrationOnboardingActive = false;
    state.migrationOnboardingDismissed = true;
    state.firstRunExtensionSetupPending = false;
    state.migrationShowMeHowExpandedKeys.clear();
    state.migrationSafariDuplicateHelpExpanded = false;
    state.lastMigrationBrowserState = null;
    state.lastMigrationBrowserRenderSignature = '';
    invalidateMigrationMacCopyCache();
    stopMigrationPolling();
}

export function wireMigrationPrePhase() {
    const btn = document.getElementById('migration-continue-btn');
    const status = document.getElementById('migration-pre-status');
    if (!btn) return;

    // Always reset button + status to a clean pre-cleanup state.
    // This function is also called when the overlay is re-shown
    // (e.g. residue reappears after a successful migration); without
    // this, btn.disabled / btn.textContent / status would carry over
    // from the previous click and the user would be locked out.
    btn.disabled = false;
    btn.textContent = tSettings('migrationContinue');
    if (status) {
        status.textContent = '';
        status.classList.add('hidden');
        status.classList.remove('error');
    }

    if (btn._listenerAdded) return;
    btn._listenerAdded = true;

    btn.addEventListener('click', async () => {
        if (btn.disabled) return;
        btn.disabled = true;
        if (status) {
            status.textContent = tSettings('migrationApproveAdminPrompt');
            status.classList.remove('hidden', 'error');
        }

        const failTryAgain = (msg) => {
            btn.disabled = false;
            btn.textContent = tSettings('migrationTryAgain');
            if (status) {
                status.textContent = msg;
                status.classList.add('error');
            }
        };

        // Race the IPC Promise against a periodic disk-state poll.
        // The Promise is the fast signal (resolves on UAC decline in
        // <1s; on cleanup completion within a few seconds); the poll
        // is the safety net for cases where the Promise never settles
        // (we've seen this happen with the blocking elevated
        // PowerShell on the executor thread). Whichever signals
        // first wins. The poll alone would be correct but too slow on
        // the cancel path (user would wait for the timeout).
        const POLL_MS = 1500;
        const TIMEOUT_MS = 120000;
        const start = Date.now();
        let invokeSettled = false;
        const invokePromise = invoke('run_upgrade_migration')
            .catch((e) => {
                console.warn('[migration] run_upgrade_migration rejected:', e);
            })
            .finally(() => { invokeSettled = true; });

        try {
            while (true) {
                // Sleep, but wake early if the IPC Promise settles.
                await Promise.race([
                    new Promise((r) => setTimeout(r, POLL_MS)),
                    invokePromise,
                ]);
                const stillPending = await invoke('migration_pending');
                if (!stillPending) break;
                // Fast path: IPC said it's done AND residue is still
                // there → user cancelled / cleanup failed. Don't make
                // them wait for the polling timeout.
                if (invokeSettled) {
                    failTryAgain(tSettings('migrationCleanupNeedAdmin'));
                    return;
                }
                if (Date.now() - start > TIMEOUT_MS) {
                    failTryAgain(tSettings('migrationCleanupRetryGeneric'));
                    return;
                }
            }
            const fresh = await invoke('onboarding_state');
            // Explicit after-cleanup framing: we just finished the
            // pre-phase elevated cleanup, so the post screen must
            // surface the "Old version cleaned up / Your blocklists
            // are preserved" rows and the cleanup-flavoured title.
            // Without this, the post phase renders in the default
            // 'fresh' mode for a frame, gets immediately overwritten
            // by the window-focus handler at the bottom of
            // setupEventListeners() (which re-runs runDesktopOnboarding
            // and re-enters with mode: 'after-cleanup' because
            // migration_was_pending_at_launch is still true) — visible
            // on Windows as a flash of the fresh framing right before
            // the cleanup framing settles.
            await showMigrationOnboarding('post', fresh, { mode: 'after-cleanup' });
        } catch (e) {
            console.warn('[migration] poll failed:', e);
            failTryAgain(tSettings('migrationCleanupRetryGeneric'));
        }
    });
}

export function wireMigrationPostPhase(onboardingState) {
    renderBrowserInstallButtons(onboardingState);
    // macOS: the first paint shows Automation rows as 'unknown' because
    // the native status query is async. Fetch it, then re-render so the
    // rows settle to their real Allowed / needs-permission state.
    if (appState.isMacOSDesktop) {
        refreshAutomationPermissionStatus().then(() => {
            if (appState.migrationOnboardingActive) {
                renderBrowserInstallButtons(onboardingState, { force: true });
            }
        });
    }
    wireEnforcementToggle();
    syncMigrationPostBackButtonVisibility();
    const backBtn = document.getElementById('migration-back-btn');
    if (backBtn && !backBtn._listenerAdded) {
        backBtn._listenerAdded = true;
        backBtn.addEventListener('click', () => {
            void returnFromExtensionSetupOnboarding();
        });
    }
}
if (import.meta.env.DEV) {
    /** Dev only: `previewRebrandNotice()` in the webview console.
     *  Note: clicking Continue persists the shown-flag to real app data. */
    window.previewRebrandNotice = () => { void presentRebrandNotice(); };
}
