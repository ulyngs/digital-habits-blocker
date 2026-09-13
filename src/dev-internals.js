// Dev/test surface: window.__REDDBLOCK_INTERNALS__ (consumed by the in-app
// blocking/integration test scripts, which are classic scripts stripped from
// production builds) plus the Cmd+Shift+T test-runner shortcut.
// The internals keys and their getter/setter semantics are a contract with
// src/test-utils.js / src/blocking-tests.js / src/integration-tests.js —
// never rename them.
import { state } from './state.js';
import { tauriAPI } from './tauri-api.js';
import { PROTECTED_APP_NAMES, PROTECTED_DOMAINS, isAllowlistBlocklist, isProtectedApp, isProtectedDomain } from './blocklist-utils.js';
import { buildAndroidScheduleEntries, buildIOSScheduleEntries, isAndroidAllowlistUnsupported, isSchedulePausedNow } from './schedule-engine.js';
import { isFocusSpaceOn, setFocusSpaceEnabled } from './focus-space-switch.js';
import {
    buildWordChallengeState,
    getCompletedChallengeText,
    getCurrentChallengeWord,
    normalizeChallengeComparableText,
    renderChallengeReferenceText,
    sanitizeChallengeTargetText,
    sanitizeChallengeTypedInput,
    shouldBlockChallengeSpaceKey,
} from './override-challenge.js';
import { createChallengeController } from './challenge-controller.js';
import { saveData, updateHostsFile } from './persistence.js';
import {
    acceptEula,
    appBlockingWarningRows,
    setupAndroidBackButtonHandling,
    updateBlockedApps,
} from './blocking-platform.js';
import { CURRENT_EULA_REVISION } from './onboarding.js';
import { render, isClockTickRunning } from './render.js';
import { duplicateBlocklist, getNextCopyName, isBlocklistEditFrictionRequired } from './blocklists.js';
import { getMaxOverrideCountForType, getMaxOverrideWords } from './override-challenge.js';
import {
    deriveIOSEffectiveWebsitePolicy,
    deriveIOSEffectiveAppPolicy,
    validateIOSAllowlistLimits,
    IOS_ALLOWLIST_EXCEPTION_LIMIT,
} from './allowlist-ios.js';
import {
    getDefaultPauseMinutes,
    clampDefaultPauseMinutes,
    FALLBACK_DEFAULT_PAUSE_MINUTES,
    MAX_DEFAULT_PAUSE_MINUTES,
} from './pause-default.js';

// Expose for integration tests (dev mode only)
window.__REDDBLOCK_INTERNALS__ = {
    get appData() { return state.appData; },
    set appData(val) { state.appData = val; },
    saveData,
    updateHostsFile,
    get tauriAPI() { return tauriAPI; },
    render,
    isProtectedApp,
    PROTECTED_APP_NAMES,
    isProtectedDomain,
    PROTECTED_DOMAINS,
    isAllowlistBlocklist,
    isBlocklistEditFrictionRequired,
    duplicateBlocklist,
    getNextCopyName,
    getMaxOverrideCountForType,
    getMaxOverrideWords,
    buildAndroidScheduleEntries,
    isAndroidAllowlistUnsupported,
    buildIOSScheduleEntries,
    isSchedulePausedNow,
    isFocusSpaceOn,
    setFocusSpaceEnabled,
    // Challenge-engine primitives (characterization tests / controller suite)
    normalizeChallengeComparableText,
    sanitizeChallengeTypedInput,
    sanitizeChallengeTargetText,
    shouldBlockChallengeSpaceKey,
    renderChallengeReferenceText,
    buildWordChallengeState,
    getCurrentChallengeWord,
    getCompletedChallengeText,
    createChallengeController,
    deriveIOSEffectiveWebsitePolicy,
    deriveIOSEffectiveAppPolicy,
    validateIOSAllowlistLimits,
    IOS_ALLOWLIST_EXCEPTION_LIMIT,
    // Lets the e2e harness pre-accept the EULA on a fresh machine. Without an
    // accepted revision the app stops at the gate and never reaches
    // runPostAcceptanceStartup(), so the 1 s tick that expires paused blocks
    // and schedules never starts — see e2e/specs/tier2.e2e.js.
    CURRENT_EULA_REVISION,
    // Lets the e2e harness distinguish "tick ran and found nothing" from
    // "tick never started" — see e2e/specs/tier2.e2e.js.
    isClockTickRunning,
    // The app's real first-run acceptance path: persists the revision AND runs
    // runPostAcceptanceStartup(), which is what starts the 1 s clock tick.
    // The e2e harness calls this rather than hand-patching settings, which
    // leaves the app sitting behind the gate with a doctored in-memory value.
    acceptEula,
    // Tier 2 drives the same popstate path that Android's WryActivity invokes
    // after hardware/gesture back. The native Activity is not present in the
    // desktop WebDriver binary, so expose the setup hook for that boundary
    // test rather than duplicating modal-close logic in the harness.
    setupAndroidBackButtonHandling,
    appBlockingWarningRows,
    updateBlockedApps,
    getDefaultPauseMinutes,
    clampDefaultPauseMinutes,
    FALLBACK_DEFAULT_PAUSE_MINUTES,
    MAX_DEFAULT_PAUSE_MINUTES,
};

// ========================================
// DEV MODE: Test Runner Keyboard Shortcut
// ========================================
// Press Cmd+Shift+T (Mac) or Ctrl+Shift+T (Windows) to run tests
document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault();
        console.log('🧪 Test shortcut detected!');
        if (window.ReddBlockTests && typeof window.ReddBlockTests.runAllTests === 'function') {
            window.ReddBlockTests.runAllTests();
        } else {
            console.log('⚠️ Tests not loaded. Make sure test-utils.js and blocking-tests.js are included.');
        }
    }
});

// Also expose a global function for running tests directly from console
window.runBlockingTests = function () {
    if (window.ReddBlockTests && typeof window.ReddBlockTests.runAllTests === 'function') {
        window.ReddBlockTests.runAllTests();
    } else {
        console.log('⚠️ Tests not loaded. Try: window.ReddBlockTestUtils and window.ReddBlockTests');
    }
};

console.log('💡 To run blocking tests, type: runBlockingTests() in the console');
