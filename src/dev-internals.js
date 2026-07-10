// Dev/test surface: window.__REDDBLOCK_INTERNALS__ (consumed by the in-app
// blocking/integration test scripts, which are classic scripts stripped from
// production builds) plus the Cmd+Shift+T test-runner shortcut.
// The internals keys and their getter/setter semantics are a contract with
// src/test-utils.js / src/blocking-tests.js / src/integration-tests.js —
// never rename them.
import { state } from './state.js';
import { tauriAPI } from './tauri-api.js';
import { PROTECTED_APP_NAMES, PROTECTED_DOMAINS, isProtectedApp, isProtectedDomain } from './blocklist-utils.js';
import { saveData, updateHostsFile } from './persistence.js';
import { render } from './render.js';
import { duplicateBlocklist, getNextCopyName } from './blocklists.js';
import { getMaxOverrideCharsForType } from './override-challenge.js';
import {
    deriveIOSEffectiveWebsitePolicy,
    deriveIOSEffectiveAppPolicy,
    validateIOSAllowlistLimits,
    IOS_ALLOWLIST_EXCEPTION_LIMIT,
} from './allowlist-ios.js';

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
    duplicateBlocklist,
    getNextCopyName,
    getMaxOverrideCharsForType,
    deriveIOSEffectiveWebsitePolicy,
    deriveIOSEffectiveAppPolicy,
    validateIOSAllowlistLimits,
    IOS_ALLOWLIST_EXCEPTION_LIMIT,
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
