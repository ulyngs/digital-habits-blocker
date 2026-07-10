// Tauri API imports - proper ES modules from @tauri-apps/api
import { invoke, convertFileSrc, Channel } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ask, message, open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import logoReddFocusUrl from './images/logo-reddfocus.svg';
import logoReddShieldUrl from './images/logo-redd-shield.svg';
import appleLogoUrl from './images/apple-logo.svg';
import iconChromeUrl from './images/icon-chrome.svg';
import iconBraveUrl from './images/icon-brave.svg';
import iconEdgeUrl from './images/icon-edge.svg';
import iconFirefoxUrl from './images/icon-firefox.svg';
import iconSafariUrl from './images/icon-safari.svg';
import screenshotChromeStep1 from './images/toggle-chrome-incognito-windows-1.png';
import screenshotChromeStep2 from './images/toggle-chrome-incognito-windows-2.png';
import screenshotEdgeStep1 from './images/toggle-edge-incognito-windows-1.png';
import screenshotEdgeStep2 from './images/toggle-edge-incognito-windows-2.png';
import screenshotFirefoxStep1 from './images/toggle-firefox-private-windows-1.png';
import screenshotFirefoxStep2 from './images/toggle-firefox-private-windows-2.png';
import screenshotSafariStep1 from './images/mac-extension-settings-1.png';
import screenshotSafariStep2 from './images/mac-extension-settings-2.png';
import screenshotAutomationSettings from './images/automation-settings.png';
import snoozeIconUrl from './images/snooze.png';
import welcomeDemoVideoUrl from './reddblock-video.mp4';
import {
    resolveReleaseNotesForVersion,
    renderReleaseNotesHtml,
    releaseNotesHasContent,
    filterReleaseNotesForPlatform,
} from './changelog.js';
// Compatibility layer wrapping Tauri APIs — extracted to tauri-api.js
import { tauriAPI, openUrl } from './tauri-api.js';
import { state, appState } from './state.js';
import './dev-internals.js';
import {
    ALWAYS_ON_END_TIME,
    PROTECTED_APP_NAMES,
    PROTECTED_DOMAINS,
    isProtectedApp,
    isProtectedDomain,
    isBlockAlwaysOn,
    isScreenTimeSummaryEntry,
    parseLegacyScreenTimeSummary,
    normalizeIOSScreenTimeSelection,
    cloneIOSScreenTimeSelection,
    hasUsableIOSScreenTimeSelection,
    formatIOSScreenTimeSelectionLabel,
    getBlocklistModalLockedApps,
    blocklistNeedsIOSSelectionRefresh,
    ensureIOSBlocklistSelectionReady,
    normalizeBlocklist,
    collectActiveIOSManualBlockPayload,
} from './blocklist-utils.js';
import { openInstalledAppsPicker } from './apps-picker.js';
import { closeAllPopovers, disableScheduleControls, disableTimeControls, getEndTimeAsDate, getStartTimeAsDate, handleDurationInputChange, handleDurationQuickBtn, handlePopoverOutsideClick, handleTimePartClick, initializeTimeInputs, pad, parseEndTimeBoundedInt, scrollElementWithinContainer, scrollPopoverOptionIntoView, setupEndTimeDirectInputs, updateDurationQuickBtns, updateTimeDisplay } from './time-inputs.js';
import { loadData, saveData, updateHostsFile } from './persistence.js';
import { cleanDomainInput, isValidDomain, processWebsiteInput, setupWebsitesImportMenu, resetWebsitesImportMenuPosition } from './website-input.js';
import { updateBlockedApps, acceptEula, appBlockingWarningSnoozedUntilMs, checkAndroidPermissions, checkHelperStatus, checkScreentimeAuth, collectManualBlockedApps, collectScheduleBlockedApps, detectPlatform, displayNameForBlockedApp, ensureInstalledAppsCache, initializeAndroidBlockingState, initializeIOSBlockingState, listenForAndroidFrictionGate, onAndroidResumed, renderAppBlockingClosedownBanner, renderAppBlockingWarningOverlay, requestScreentimeAuth, runExpiryOnce, setupAndroidBackButtonHandling, setupAppBlockingWarningOverlay, setupHandsetModalScreens, setupMaximizeButtonSync, setupMobileExternalLinkOpens, syncMaximizeButtonFromWindow, updateOnboardingVisibility, openExternal, updateWindowHeight, isHelperInstallCancelled, isHelperConnectionError, joinAppListWithLimit, findResponsibleBlocklistForWarningApps, getActiveAppBlockingSnoozeBlocklistId, formatAppBlockingSnoozeStartsIn, APP_BLOCKING_SNOOZE_ICON_IMG_12 } from './blocking-platform.js';
import { CURRENT_EULA_REVISION, applyEnforcementDescCopy, applyMacAutomationIntroCopy, ensureExtensionSetupOnboardingShown, getAcceptedEulaRevision, hasAcceptedEula, isFirstRunOnboardingInProgress, resetDevOnlyEulaAcceptance, returnToWelcomeFromEula, runDesktopOnboarding, runInitialOnboardingSequence, setupMacAutomationIntroModal, syncMigrationPostBackButtonVisibility, syncSetupBannerHeadline, welcomeFirefoxInstalled } from './onboarding.js';
// app.js calls these enforcement.js exports but historically never imported
// them — they resolved only through Rollup's scope hoisting, which held while
// the desktop bundle retained every enforcement helper. The Android build now
// strips desktop-only UI (__ANDROID_BUILD__ guards, CSS purge, DOM removal),
// so Rollup tree-shakes any export without a real import edge and these bare
// references become runtime ReferenceErrors (e.g. syncBlockingMethodLabelIcons
// in applySettingsLanguage). Importing them keeps the edges on every target;
// the guarded functions remain as no-ops on Android.
import {
    MAC_BLOCKING_METHOD_KEYS,
    browserBlockingMethod,
    invalidateMigrationMacCopyCache,
    migrationExtLinesHtml,
    refreshBehaviourBannerIfStale,
    renderBrowserInstallButtons,
    setupAppForegroundRefresh,
    setupEnforcerUiAlerts,
    setupSettingsEnforcementSection,
    setupWebAutomationUiAlerts,
    startWebAutomationWatcher,
    syncBlockingMethodLabelIcons,
    syncMigrationMacHowto,
    syncMigrationPostHeader,
    syncSafariFdaOnboardingGrantButton,
    updateAllEnforcementToggleLocks,
    updateGraceSettingLock,
    wireEnforcementToggle,
} from './enforcement.js';
import {
    MAC_BLOCKING_METHOD_KEYS,
    browserBlockingMethod,
    invalidateMigrationMacCopyCache,
    migrationExtLinesHtml,
    renderBrowserInstallButtons,
    setupAppForegroundRefresh,
    setupEnforcerUiAlerts,
    setupSettingsEnforcementSection,
    setupWebAutomationUiAlerts,
    applySafariFdaOnboardingLanguage,
    syncBlockingMethodLabelIcons,
    startWebAutomationWatcher,
    syncMigrationMacHowto,
    syncMigrationPostHeader,
    refreshBehaviourBannerIfStale,
    updateAllEnforcementToggleLocks,
    updateGraceSettingLock,
    wireEnforcementToggle,
} from './enforcement.js';
import {
    addScheduleSegment, discardSchedulePendingChanges, getCommittedScheduleSegmentCount,
    getDefaultScheduleSegments, getInitialExpandedScheduleSegmentIndex, handleRepeatDateChange,
    handleRepeatOptionClick, handleSegmentDayToggle, rebuildScheduleSegments,
    saveSchedulePendingChanges, setAlwaysOnMode, setScheduleMode, startSchedule,
    toggleRepeatDropdown, updateScheduleButtonState, isScheduleSegmentActiveNow,
    formatDateForDisplay,
} from './schedule-editor.js';
import {
    SCHEDULE_OVERLAY_DEFAULT_PRESET_VALUE, applyScheduleStartOverlayPresentation,
    getEffectiveScheduleStartOverlayId, getScheduleStartOverlayForWarningApps,
    handleSchedulePanelOverlayOptionClick, isScheduleOverlayCustomiseModalOpen,
    playAppBlockingLetsGoVoice, populateScheduleOverlayCustomiseSelector,
    rememberLastScheduleStartOverlayId, setupScheduleOverlayCustomiseModal,
    syncScheduleConfirmOverlaySummary, syncScheduleOverlayCustomiseDirtyState,
    syncScheduleOverlayCustomiseEditorState, syncScheduleOverlayCustomiseTitle,
    toggleSchedulePanelOverlayDropdown,
} from './schedule-overlay.js';
import { applyModalBlocklistTint, applyOverrideTypeUi, closeBlocklistModal, closeOverrideModal, closePauseModal, closeScheduleConfirmModal, closeStartBlockConfirmModal, deselectBlocklist, handleBlocklistSelect, openBlocklistModal, openPauseModal, openResumeConfirmation, proceedWithBlock, proceedWithPause, proceedWithSchedule, proceedWithScheduleEdit, renderScheduleConfirmSegments, setBtnActionLabel, setOverrideCountMaxMode, setStartBlockBtnLeadingIcon, setStartConfirmPrimaryLabel, startBlock, syncAllStopBtnLabelFits, syncOverrideCountUi, syncPauseDurationRowLayout, updateOverridePreview, updatePauseRestartTime, openOverrideModal, updatePauseButtonAppearance, openScheduleOverrideModal, showScheduleConfirmModal, showScheduleEditConfirmModal, syncStopBtnLabelFit, setStartBtnBlocklistInfo } from './confirm-modals.js';
import { renderBlocklists, autoSelectSoleBlocklist, closeAllBlocklistMenus, truncateBlocklistName, setupBlocklistsImportExportButtons, duplicateBlocklist, getNextCopyName, undoDelete, deleteBlocklist, clearPendingScheduleDraft, pendingDelete, saveBlocklistOrderFromDOM, getBlocklistScheduleDraft, saveBlocklistScheduleDraft, isBlocklistCurrentlyActive } from './blocklists.js';
import {
    getSelectedBlocklistModalMode,
    setBlocklistModalMode,
    syncModalAppPlaceholder,
    syncModalWebsitePlaceholder,
    updateBlocklistModalModeLabels,
} from './list-mode.js';
import { render, kickClockNow, startTickInterval, updateWeekCalendar, syncSelectedControlState, renderNowBlockingRow, renderScheduleAlwaysOnRow, renderScheduleVisibilityChips, renderWeekBlocks, renderBlocklistSelector, getCalendarSegmentLayout, layoutOverlappingBlocks } from './render.js';
import { formatTitleBarScheduleStartWhen, hasAnyEnforcedBlocks, isNonRepeatingSchedule, isOneOffBlockEnforced, isSchedulePausedNow, pickEarliestUpcomingScheduledBlock, refreshDesktopHelperStatus, resolveOneShotOccurrences, scheduleHasFutureSingleOccurrence, syncActiveBlocksToHelper, syncSchedulesToHelper } from './schedule-engine.js';
import { dismissTopmostEscapeLayer, isModalVisible, refreshOpenHelperUi, startHelperUiRefreshLoop, stopHelperUiRefreshLoop } from './modal-manager.js';
import {
    overrideAllChallengeText, overrideAllWordChallengeState, refreshUninstallButtonState,
    setupGraceSetting, setupHelpMenuLinks, setupHelperSettings, setupInAppUninstall,
    setupOverrideAll, setupSettingsHelpButtons, setupWindowsUninstallGuidance,
    syncUninstallConfirmModal, updateCleanHostsBtnState, updateHelperStatusIndicator,
    updateManageSectionVisibility, updateOverrideAllButtonVisibility,
} from './settings.js';
import { setupTheme, setupUiZoomShortcuts, scheduleUiZoomResponsiveLayout, scheduleSelectionPromptLayout, getEffectiveViewportWidth, bindUiZoomLayoutObserver } from './theme.js';
import { checkForAppUpdate, getLatestVersionPlatformKey, isVersionHigher, resolveMicrosoftStorePackage, updateBannerWhatsNewButtonHtml } from './update-banner.js';
import { updateDownloadInProgress } from './update-banner.js';
import { getWordList5, getIOSRandomWordsCharCount, generateRandomWordsByCount, generateRandomWords, generateOverrideChallengeText, generateGibberish, normalizeOverrideCount, normalizeCustomOverrideText, getTypingCharsPerMinuteForType, getMaxOverrideCharsForType, getOverrideGeneratedCharCount, getDifficultyTypingCharCount, getOverridePreviewText, getOverrideEstimatedMinutes, formatOverrideMaxDifficultyHint, usesMobileWordCountForOverrideType, isMobileOverrideChallengePlatform, formatIOSGibberishChallenge, MIN_OVERRIDE_CHARS, DEFAULT_OVERRIDE_COUNT, TARGET_MAX_OVERRIDE_MINUTES, MAX_IOS_OVERRIDE_WORD_COUNT, IOS_OVERRIDE_WORDS_PER_MINUTE, OVERRIDE_PREVIEW_TRUNCATE_AT } from './override-challenge.js';
import { escapeHtml, cleanUrlForDisplay, parseRgbFromColorString, rgbToHex, rgbToHsl, hslToRgb, getRelativeLuminance, getEnteringChipColor, getContrastTextColor } from './utils.js';
import { SETTINGS_TRANSLATIONS, getSettingsLanguage, weekdayAbbrevMon0List, weekdayLetterMon0List, tSettings, tSettingsFmt, LANGUAGE_FLAG_SVG, LANGUAGE_NATIVE_LABELS, languageNativeLabel } from './i18n.js';
/** Windows Settings → Apps → Installed apps (Apps & features). */
export const WINDOWS_APPS_SETTINGS_URI = 'ms-settings:appsfeatures';



/** Blocklist modal undo: session-scoped stack and "last" values for recording previous state. */

export function pushModalUndo(type, undoFn) {
    if (state.blocklistModalApplyingUndo) return;
    state.blocklistModalUndoStack.push({ type, undo: undoFn });
}

/** Reference to the removed Custom Text option so it can be re-added (getElementById returns null after remove()). */
/** Blocklist id to pass to helper when confirming single-block override (set when opening modal). */
let draggedBlocklistId = null; // Track which blocklist is being dragged
let startupInitializationPromise = null; // Prevent duplicate post-onboarding startup runs
/** Max length for blocklist display name (add/edit modal + persisted saves). */
export const BLOCKLIST_NAME_MAX_LENGTH = 60;
/** Past this length the card title row usually ellipsizes; use "in 11h" instead of "starts in 11h". */
export const BLOCKLIST_CARD_COMPACT_SCHEDULE_UPCOMING_CHARS = 26;
/** Collapse stop-button emoji+name this many px before measured overflow (iOS flex overlap). */
export const IOS_STOP_BTN_META_COLLAPSE_SLACK_PX = 24;


// Schedule mode state
state.scheduleSegments = getDefaultScheduleSegments(); // Array of time segments with per-segment days

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    detectPlatform(); // Before loadData so first-launch defaults can differ on iOS
    await loadData();
    await resetDevOnlyEulaAcceptance();

    // Returning Android users already have complete persisted focus-space
    // state. Paint it before *any* native IPC or listener wiring, then check
    // Accessibility immediately afterwards. A revoked permission swaps this
    // optimistic frame for the onboarding gate as soon as the IPC completes.
    // Fresh installs and upgrades still wait for migration below because they
    // do not yet have a safe, complete state to render.
    const renderedAndroidFirstFrame = state.isAndroid
        && hasAcceptedEula()
        && state.appData.settings?.androidMigrationDone === true;
    if (renderedAndroidFirstFrame) {
        setupTheme();
        render();
        await new Promise((resolve) => {
            requestAnimationFrame(() => {
                setTimeout(() => {
                    state.androidFirstFrameCommitted = true;
                    resolve();
                }, 0);
            });
        });
    }

    setupHandsetModalScreens();
    setupMobileExternalLinkOpens();
    if (state.isAndroid) {
        listenForAndroidFrictionGate();
        setupAndroidBackButtonHandling();
    }
    setupNowBlockingChipScroll();
    setupEventListeners();
    setupAppBlockingWarningOverlay();
    initWelcomeDemoControls();
    if (!renderedAndroidFirstFrame) setupTheme();
    setupUiZoomShortcuts();
    setupHelpMenuLinks();
    setupHelperSettings();
    setupSettingsHelpButtons();
    setupBlocklistsImportExportButtons();
    setupAppForegroundRefresh();
    setupOverrideAll();
    setupInAppUninstall();
    setupWindowsUninstallGuidance();
    setupMacAutomationIntroModal();
    setupGraceSetting();
    setupSettingsEnforcementSection();
    if (!state.isIOS && !state.isAndroid) {
        void wireEnforcementToggle();
    }
    await runInitialOnboardingSequence();
    if (state.isIOS && hasAcceptedEula()) {
        await checkScreentimeAuth();
    } else if (state.isAndroid && hasAcceptedEula()) {
        // Deliberately after the optimistic persisted first frame above. The
        // result is still required before Android reconciliation begins.
        if (state.androidPermissionsGranted == null) {
            await checkAndroidPermissions();
        }
    }

    if (hasAcceptedEula()) {
        await runPostAcceptanceStartup();
    }

});

function setupNowBlockingChipScroll() {
    const chipsEl = document.getElementById('now-blocking-chips');
    if (!chipsEl) return;

    let isPointerDown = false;
    let isDragging = false;
    let suppressClick = false;
    let startX = 0;
    let startScrollLeft = 0;

    window.addEventListener('resize', () => syncNowBlockingChipsScrollability(), { passive: true });

    chipsEl.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('.now-blocking-chip-menu-btn')) return;
        if (!chipsEl.classList.contains('can-horizontal-scroll')) return;

        isPointerDown = true;
        isDragging = false;
        suppressClick = false;
        startX = e.clientX;
        startScrollLeft = chipsEl.scrollLeft;
        chipsEl.classList.add('is-dragging');
        e.preventDefault();
    });

    const stopDragging = () => {
        suppressClick = isDragging;
        isPointerDown = false;
        isDragging = false;
        chipsEl.classList.remove('is-dragging');
    };

    document.addEventListener('mousemove', (e) => {
        if (!isPointerDown) return;
        const deltaX = e.clientX - startX;
        if (Math.abs(deltaX) > 3) {
            isDragging = true;
        }
        chipsEl.scrollLeft = startScrollLeft - deltaX;
        e.preventDefault();
    });

    document.addEventListener('mouseup', stopDragging);
    chipsEl.addEventListener('mouseleave', () => {
        if (!isPointerDown) return;
        stopDragging();
    });

    chipsEl.addEventListener('click', (e) => {
        if (!suppressClick) return;
        if (e.target.closest('.now-blocking-chip-menu-btn')) {
            suppressClick = false;
            return;
        }
        suppressClick = false;
        e.preventDefault();
        e.stopPropagation();
    }, true);
}

export function syncNowBlockingChipsScrollability() {
    const chipsEl = document.getElementById('now-blocking-chips');
    const row = document.getElementById('now-blocking-row');
    if (!chipsEl || !row || row.classList.contains('hidden')) return;
    if (row.classList.contains('idle')) {
        chipsEl.classList.remove('can-horizontal-scroll');
        return;
    }
    chipsEl.classList.toggle('can-horizontal-scroll', chipsEl.scrollWidth > chipsEl.clientWidth + 1);
}

export async function runPostAcceptanceStartup() {
    if (state.startupInitializationComplete) return;
    if (startupInitializationPromise) {
        await startupInitializationPromise;
        return;
    }

    startupInitializationPromise = (async () => {
        await runExpiryOnce(); // Align in-memory state with Screen Time / helper (e.g. after app was closed)

        // Desktop reconciliation and returning-user Android initialization
        // perform several native scans and IPC round-trips. None is needed to
        // draw already-migrated persisted focus spaces, so paint those first
        // and let the browser commit the frame before continuing startup.
        // Android's one-time legacy migration deliberately remains ahead of
        // the first render: it owns initial default/imported-space creation.
        const androidDataReadyForEarlyRender = state.isAndroid
            && state.appData.settings?.androidMigrationDone === true;
        const renderedBeforeNativeStartup = state.androidFirstFrameCommitted || (!state.isIOS
            && (!state.isAndroid || androidDataReadyForEarlyRender));
        if (renderedBeforeNativeStartup) {
            render();
            startTickInterval();
            await new Promise((resolve) => {
                requestAnimationFrame(() => setTimeout(resolve, 0));
            });
        }

        if (state.isIOS) {
            await checkScreentimeAuth();
            if (state.screentimeAuthorized) {
                await initializeIOSBlockingState();
            }
        } else if (state.isAndroid) {
            // The normal startup and EULA-acceptance paths check this before
            // entering post-acceptance startup. Avoid a duplicate native IPC;
            // retain the fallback for direct/test callers.
            if (state.androidPermissionsGranted == null) {
                await checkAndroidPermissions();
            }
            // Not gated on the accessibility grant: migration must run
            // before ANY set_schedules call, because Kotlin stores the
            // synced schedules under the same legacy prefs key
            // ("routines") that the migration reads — a pre-migration
            // sync would overwrite the legacy data and then re-import
            // our own schedules as duplicates. Neither command needs
            // accessibility; enforcement simply stays off until granted.
            await initializeAndroidBlockingState();
        } else {
            // Run first-launch migration off the legacy helper + check
            // Automation TCC (macOS) + extension compliance. Idempotent;
            // a no-op on subsequent launches past the current version.
            setupEnforcerUiAlerts();
            setupWebAutomationUiAlerts();
            await ensureInstalledAppsCache();
            await runDesktopOnboarding();
            await checkHelperStatus();
            console.log('[startup-sync] Desktop startup helperAvailable:', state.helperAvailable);
            // Reconcile manual blocks first so paused one-offs are removed from helper state after reinstall.
            await syncActiveBlocksToHelper();
            // Then sync schedules to helper so both enforcement sources are aligned.
            await syncSchedulesToHelper();
            console.log('[startup-sync] Startup helper reconciliation complete');
            // Push active schedule / block app sets into the in-process watcher
            // immediately — don't wait for the 1s tick interval.
            await updateHostsFile();
            await updateBlockedApps();
            if (!state.migrationOnboardingActive) {
                try {
                    await invoke('enforcer_start');
                } catch (e) {
                    console.warn('[startup] enforcer_start failed:', e);
                }
            }
            // Start the automation watcher even while the migration overlay
            // is open — blocks may already be active and the watcher is
            // idle until then anyway.
            await startWebAutomationWatcher();
        }
        // Desktop has already produced its first meaningful frame. Render
        // again after reconciliation in case native startup changed any UI
        // state; mobile reaches its first render here as before.
        render();
        if (!renderedBeforeNativeStartup) {
            startTickInterval();
        }

        // Check for app updates (non-blocking, desktop only)
        if (!state.isIOS && !state.isAndroid) {
            checkForAppUpdate();
        }
        state.startupInitializationComplete = true;
    })();

    try {
        await startupInitializationPromise;
    } finally {
        if (!state.startupInitializationComplete) {
            startupInitializationPromise = null;
        }
    }
}




// Setup event listeners
function setupEventListeners() {
    // Window controls (using Tauri docs naming)
    document.getElementById('titlebar-minimize')?.addEventListener('click', () => {
        tauriAPI.minimizeWindow();
    });

    document.getElementById('titlebar-maximize')?.addEventListener('click', async () => {
        await tauriAPI.maximizeWindow();
        // State may settle asynchronously on Windows — refresh immediately and once more.
        await syncMaximizeButtonFromWindow({ force: true });
        setTimeout(() => {
            void syncMaximizeButtonFromWindow({ force: true });
        }, 100);
    });

    document.getElementById('titlebar-close')?.addEventListener('click', () => {
        tauriAPI.closeWindow();
    });

    const eulaCheckbox = document.getElementById('eula-agree-checkbox');
    const eulaContinueBtn = document.getElementById('eula-continue-btn');
    if (eulaCheckbox && eulaContinueBtn) {
        eulaContinueBtn.disabled = !eulaCheckbox.checked;
    }
    eulaCheckbox?.addEventListener('change', () => {
        if (eulaContinueBtn) {
            eulaContinueBtn.disabled = !eulaCheckbox.checked;
        }
    });
    eulaContinueBtn?.addEventListener('click', async () => {
        if (!eulaCheckbox?.checked || !eulaContinueBtn) return;
        if (state.firstRunExtensionSetupPending && hasAcceptedEula()) {
            state.extensionSetupPausedForBackNavigation = false;
            document.getElementById('eula-onboarding')?.classList.add('hidden');
            void ensureExtensionSetupOnboardingShown();
            return;
        }
        eulaContinueBtn.disabled = true;
        eulaContinueBtn.textContent = tSettings('eulaContinueBusy');
        try {
            await acceptEula();
        } catch (err) {
            console.error('Failed to accept EULA:', err);
            alert(tSettings('eulaAcceptSaveFailedAlert'));
            eulaContinueBtn.disabled = !eulaCheckbox.checked;
            eulaContinueBtn.textContent = tSettings('eulaContinueBtn');
            return;
        }
        eulaContinueBtn.textContent = tSettings('eulaContinueBtn');
    });

    document.getElementById('eula-back-btn')?.addEventListener('click', () => {
        returnToWelcomeFromEula();
    });

    // EULA onboarding: delegated listeners so localized HTML can rebuild links/text without losing handlers.
    const eulaRoot = document.getElementById('eula-onboarding');
    if (eulaRoot) {
        eulaRoot.addEventListener(
            'click',
            (event) => {
                const toggleHost = event.target.closest('[data-toggle-target]');
                if (toggleHost && eulaRoot.contains(toggleHost) && !event.target.closest('a')) {
                    const target = document.getElementById(toggleHost.dataset.toggleTarget);
                    if (!target) return;
                    target.checked = !target.checked;
                    target.dispatchEvent(new Event('change', { bubbles: true }));
                }
            },
            true
        );
    }

    document.getElementById('ios-screentime-grant-btn')?.addEventListener('click', async () => {
        const btn = document.getElementById('ios-screentime-grant-btn');
        const note = document.getElementById('ios-screentime-onboarding-note');
        if (!btn) return;

        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Requesting access...';

        const result = await requestScreentimeAuth();

        if (result.granted) {
            updateOnboardingVisibility();
            try {
                await initializeIOSBlockingState();
                render();
            } catch (err) {
                console.error('Error initializing iOS blocking state after auth:', err);
            }
        } else if (note) {
            if (result.status === 'denied') {
                note.textContent = 'Screen Time access was denied. Please tap the button again, or enable ReDD Blocker in Settings > Screen Time > Apps With Screen Time Access.';
            } else if (result.error) {
                note.textContent = `Screen Time access failed: ${result.error}`;
            }
        }
        updateOnboardingVisibility();

        btn.disabled = false;
        btn.textContent = originalText;
    });

    document.getElementById('android-accessibility-grant-btn')?.addEventListener('click', async () => {
        const btn = document.getElementById('android-accessibility-grant-btn');
        const status = document.getElementById('android-accessibility-status');
        if (!btn) return;

        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Opening Settings...';
        if (status) {
            status.textContent = 'Enable ReDD Blocker in Accessibility, then return here.';
            status.classList.remove('hidden');
        }

        try {
            await tauriAPI.androidOpenAccessibilitySettings();
        } catch (err) {
            console.error('Failed to open Android accessibility settings:', err);
            if (status) {
                status.textContent = `Could not open Accessibility settings: ${err}`;
            }
        } finally {
            btn.disabled = false;
            btn.textContent = originalText;
        }
    });

    if (state.isAndroid) {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                void onAndroidResumed();
            }
        });
    }

    // Windows custom title bar: sync maximize/restore icon from window events (no polling).
    void setupMaximizeButtonSync();

    // Time pickers — instant end uses compact `input.time-part time-popover-anchor` (click opens list + caret);
    // schedule uses its own overlays; pause modal uses button anchors.
    document.querySelectorAll('.time-popover-anchor').forEach(el => {
        el.addEventListener('click', handleTimePartClick);
    });

    // Close popovers on outside click
    document.addEventListener('click', handlePopoverOutsideClick);

    // Click on background to deselect blocklists
    document.addEventListener('click', (e) => {
        // Don't deselect if clicking on interactive elements
        if (e.target.closest('.blocklist-card') ||
            e.target.closest('.scheduler-section') ||
            e.target.closest('.time-picker-container') ||
            e.target.closest('.schedule-block-panel') ||
            e.target.closest('.repeat-dropdown-wrapper') ||
            e.target.closest('.repeat-dropdown-menu') ||
            e.target.closest('.modal-overlay') ||
            e.target.closest('.section-header') ||
            e.target.closest('.footer') ||
            e.target.closest('.title-bar') ||
            e.target.closest('.week-calendar-section') ||
            e.target.closest('.time-popover') ||
            e.target.closest('.time-part')) {
            return;
        }

        // Deselect blocklist if one is selected
        if (state.selectedBlocklistId) {
            deselectBlocklist();
        }
    });

    // Close blocklist card menus when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.blocklist-menu-wrapper') && !e.target.closest('.blocklist-menu')) {
            closeAllBlocklistMenus();
        }
    });

    // ESC: sub-overlays → dialog → (elsewhere) deselect selected blocklist
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (dismissTopmostEscapeLayer()) {
            e.preventDefault();
            return;
        }
        if (state.selectedBlocklistId) {
            deselectBlocklist();
            e.preventDefault();
        }
    });

    // Ctrl+Z / Cmd+Z: undo in blocklist add/edit modal (session-scoped).
    // Use capture phase so we run before the input's native undo (which would undo character-by-character).
    // Rule: clear pending (unsaved) text in website/app fields before undoing stack actions. Prefer clearing
    // the focused field first, then clear any other field that still has pending text, then pop stack.
    document.addEventListener('keydown', (e) => {
        const blocklistModal = document.getElementById('blocklist-modal');
        if (!blocklistModal || blocklistModal.classList.contains('hidden')) return;
        const isUndo = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey;
        if (!isUndo) return;

        const websiteInput = document.getElementById('modal-website-input');
        const appInput = document.getElementById('modal-app-input');
        const target = e.target;
        const websiteHasPending = websiteInput && websiteInput.value.trim().length > 0;
        const appHasPending = appInput && appInput.value.trim().length > 0;

        // 1) Clear the focused field if it has pending text (so one Ctrl+Z clears where you're typing)
        if ((target === websiteInput || document.activeElement === websiteInput) && websiteHasPending) {
            websiteInput.value = '';
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        if ((target === appInput || document.activeElement === appInput) && appHasPending) {
            appInput.value = '';
            syncModalAppPlaceholder();
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        // 2) If any field still has pending text, clear it before we touch the stack (so we don't undo
        //    a tag add/remove while leaving unsaved text in the other field)
        if (websiteHasPending) {
            websiteInput.value = '';
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        if (appHasPending) {
            appInput.value = '';
            syncModalAppPlaceholder();
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        // 3) Both fields empty of pending text — pop stack
        if (state.blocklistModalUndoStack.length > 0) {
            state.blocklistModalApplyingUndo = true;
            const entry = state.blocklistModalUndoStack.pop();
            try {
                entry.undo();
            } finally {
                state.blocklistModalApplyingUndo = false;
            }
            e.preventDefault();
        }
    }, true);

    // Duration picker - input change
    const durationInput = document.getElementById('duration-minutes-input');
    if (durationInput) {
        durationInput.addEventListener('input', (e) => {
            // Enforce max 5 digits visually
            if (durationInput.value.length > 5) {
                durationInput.value = durationInput.value.slice(0, 5);
            }
            handleDurationInputChange();
        });
        durationInput.addEventListener('blur', () => {
            let mins = parseInt(durationInput.value);
            if (isNaN(mins) || mins < 1) mins = 60;
            if (mins > 99999) mins = 99999;
            durationInput.value = mins;
            handleDurationInputChange();
        });
    }

    // Quick-select buttons: timed durations + until-I-stop option
    document.querySelectorAll('.duration-quick-btn').forEach(btn => {
        btn.addEventListener('click', handleDurationQuickBtn);
    });

    // Initialize time picker with defaults
    initializeTimeInputs();
    setupEndTimeDirectInputs();

    // Blocklist selector
    document.getElementById('blocklist-select').addEventListener('change', handleBlocklistSelect);

    // Start block button
    document.getElementById('start-block-btn').addEventListener('click', startBlock);

    // Add blocklist button
    document.getElementById('add-blocklist-btn').addEventListener('click', () => openBlocklistModal());

    document.querySelectorAll('#blocklist-mode-toggle .mode-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            if (btn.disabled || btn.classList.contains('disabled')) return;
            setBlocklistModalMode(btn.dataset.mode);
        });
    });

    // Onboarding
    // Onboarding removed — default blocklist created in loadData()

    // Modal listeners
    setupModalListeners();

    // Override modal
    setupOverrideModalListeners();

    // Undo toast button
    document.getElementById('undo-toast-btn')?.addEventListener('click', undoDelete);

    // Start block confirmation modal buttons
    document.getElementById('cancel-start-confirm-btn')?.addEventListener('click', closeStartBlockConfirmModal);
    document.getElementById('proceed-start-confirm-btn')?.addEventListener('click', proceedWithBlock);
    document.getElementById('start-block-confirm-modal')?.addEventListener('click', (e) => {
        if (e.target.classList.contains('modal-overlay')) {
            closeStartBlockConfirmModal();
        }
    });

    // Schedule confirmation modal buttons.
    // The proceed button routes between the start-flow and edit-flow handlers via
    // window.editScheduleData (set by showScheduleEditConfirmModal). A single
    // dispatch listener avoids a previous bug where both addEventListener and a
    // per-flow .onclick fired, causing proceedWithSchedule to add a duplicate
    // schedule after an edit-flow save.
    document.getElementById('cancel-schedule-confirm-btn')?.addEventListener('click', closeScheduleConfirmModal);
    document.getElementById('proceed-schedule-confirm-btn')?.addEventListener('click', () => {
        if (window.editScheduleData) {
            proceedWithScheduleEdit();
        } else {
            proceedWithSchedule();
        }
    });
    document.getElementById('start-schedule-confirm-modal')?.addEventListener('click', (e) => {
        if (e.target.classList.contains('modal-overlay')) {
            closeScheduleConfirmModal();
        }
    });

    setupScheduleOverlayCustomiseModal();

    // Schedule mode tabs
    document.getElementById('instant-mode-tab')?.addEventListener('click', () => setScheduleMode(false));
    document.getElementById('schedule-mode-tab')?.addEventListener('click', () => setScheduleMode(true));

    // Add segment button
    document.getElementById('add-segment-btn')?.addEventListener('click', addScheduleSegment);

    // Start schedule button
    document.getElementById('start-schedule-btn')?.addEventListener('click', startSchedule);
    document.getElementById('schedule-pending-save')?.addEventListener('click', saveSchedulePendingChanges);
    document.getElementById('schedule-pending-discard')?.addEventListener('click', discardSchedulePendingChanges);

    // Repeat dropdown (renamed from Until)
    document.getElementById('repeat-dropdown-btn')?.addEventListener('click', toggleRepeatDropdown);
    document.getElementById('schedule-panel-overlay-dropdown-btn')?.addEventListener('click', toggleSchedulePanelOverlayDropdown);
    document.getElementById('schedule-panel-overlay-dropdown-menu')?.addEventListener('click', handleSchedulePanelOverlayOptionClick);
    document.querySelectorAll('.repeat-option').forEach(opt => {
        opt.addEventListener('click', handleRepeatOptionClick);
    });
    document.getElementById('repeat-date-input')?.addEventListener('change', handleRepeatDateChange);

    // Initialize first segment day toggles
    document.querySelectorAll('.segment-day-toggle').forEach(btn => {
        btn.addEventListener('click', () => {
            const segmentIndex = parseInt(btn.closest('.segment-days').dataset.segmentIndex);
            const dayIndex = parseInt(btn.dataset.day);
            handleSegmentDayToggle(segmentIndex, dayIndex, btn);
        });
    });

    // Listen for blocks updated from main process
    tauriAPI.onBlocksUpdated(async () => {
        await loadData();
        render();
    });
}




// Modal listeners
function setupModalListeners() {
    let modalWebsites = [];
    let modalApps = [];
    let modalIOSScreenTimeSelection = null;

    const getModalDisplayApps = () => {
        const displayApps = modalApps.map(displayNameForBlockedApp);
        const screenTimeLabel = formatIOSScreenTimeSelectionLabel(modalIOSScreenTimeSelection);
        if (screenTimeLabel) {
            displayApps.push(screenTimeLabel);
        }
        return displayApps;
    };

    const getModalLockedAppDisplayItems = () => {
        const screenTimeLabel = formatIOSScreenTimeSelectionLabel(modalIOSScreenTimeSelection);
        return (window.lockedApps || []).map((app) => (
            app === screenTimeLabel ? app : displayNameForBlockedApp(app)
        ));
    };

    const modalWebsiteInput = document.getElementById('modal-website-input');
    const modalAppInput = document.getElementById('modal-app-input');
    const modalWebsitesTags = document.getElementById('modal-websites-tags');
    const modalAppsTags = document.getElementById('modal-apps-tags');

    // Email-to-field-style multi-selection. Track selection by VALUE so the
    // sets stay valid across re-renders and modifications.
    const selectedWebsites = new Set();
    const selectedApps = new Set();

    const isWebsiteLocked = (w) => Array.isArray(window.lockedWebsites) && window.lockedWebsites.includes(w);
    const isAppLocked = (a) => Array.isArray(window.lockedApps) && window.lockedApps.includes(a);

    const clearWebsiteSelection = () => {
        if (selectedWebsites.size === 0) return false;
        selectedWebsites.clear();
        window.renderModalTags();
        return true;
    };
    const clearAppSelection = () => {
        if (selectedApps.size === 0) return false;
        selectedApps.clear();
        window.renderModalTags();
        return true;
    };

    const selectAllUnlockedWebsites = () => {
        selectedWebsites.clear();
        modalWebsites.forEach(w => {
            if (!isWebsiteLocked(w)) selectedWebsites.add(w);
        });
        window.renderModalTags();
    };
    const selectAllUnlockedApps = () => {
        selectedApps.clear();
        modalApps.forEach(a => {
            if (!isAppLocked(a)) selectedApps.add(displayNameForBlockedApp(a));
        });
        // Also include the iOS Screen Time aggregate label if present.
        const iosLabel = formatIOSScreenTimeSelectionLabel(modalIOSScreenTimeSelection);
        if (iosLabel && !isAppLocked(iosLabel)) selectedApps.add(iosLabel);
        window.renderModalTags();
    };

    // Bulk-delete every selected website. Pushes a single undo entry that
    // restores all of them at once, matching the user's "select-all then
    // backspace" mental model in a text editor.
    const deleteSelectedWebsites = () => {
        if (selectedWebsites.size === 0) return false;
        const toDelete = modalWebsites.filter(w => selectedWebsites.has(w) && !isWebsiteLocked(w));
        if (toDelete.length === 0) {
            selectedWebsites.clear();
            window.renderModalTags();
            return false;
        }
        const restoreCopy = [...toDelete];
        pushModalUndo('website-bulk', () => {
            restoreCopy.forEach(w => {
                if (!modalWebsites.includes(w)) modalWebsites.push(w);
            });
            window.renderModalTags();
        });
        toDelete.forEach(w => {
            const i = modalWebsites.indexOf(w);
            if (i !== -1) modalWebsites.splice(i, 1);
        });
        selectedWebsites.clear();
        window.renderModalTags();
        return true;
    };

    // Arrow-key navigation through chips, like an email-to field.
    //   direction === -1  → ArrowLeft  (move selection left, or pull last chip
    //                       into selection when selection is empty)
    //   direction === +1  → ArrowRight (move selection right, deselect & return
    //                       focus to the input if past the last chip)
    // Returns:
    //   'moved'      — selection changed
    //   'deselected' — past the last chip; selection was cleared
    //   false        — nothing happened
    const moveSelectionInList = (list, lockedFn, selection, direction) => {
        if (selection.size === 0) {
            if (direction === -1) {
                for (let i = list.length - 1; i >= 0; i--) {
                    if (!lockedFn(list[i])) {
                        selection.add(list[i]);
                        return 'moved';
                    }
                }
            }
            return false;
        }

        const selectedIdx = [];
        list.forEach((item, idx) => {
            if (selection.has(item)) selectedIdx.push(idx);
        });
        if (selectedIdx.length === 0) return false;

        if (direction === -1) {
            let next = selectedIdx[0] - 1;
            while (next >= 0 && lockedFn(list[next])) next--;
            if (next < 0) {
                // At the start: collapse a multi-selection onto the leftmost
                // chip; otherwise nothing to do.
                if (selectedIdx.length > 1) {
                    selection.clear();
                    selection.add(list[selectedIdx[0]]);
                    return 'moved';
                }
                return false;
            }
            selection.clear();
            selection.add(list[next]);
            return 'moved';
        }

        // direction === +1 (ArrowRight)
        let next = selectedIdx[selectedIdx.length - 1] + 1;
        while (next < list.length && lockedFn(list[next])) next++;
        if (next >= list.length) {
            selection.clear();
            return 'deselected';
        }
        selection.clear();
        selection.add(list[next]);
        return 'moved';
    };

    const moveWebsiteSelection = (direction) => {
        const result = moveSelectionInList(modalWebsites, isWebsiteLocked, selectedWebsites, direction);
        if (result) {
            window.renderModalTags();
            if (result === 'deselected') modalWebsiteInput.focus();
        }
        return result;
    };
    const moveAppSelection = (direction) => {
        const displayApps = getModalDisplayApps();
        const lockedDisplay = new Set(getModalLockedAppDisplayItems());
        const isDisplayLocked = (displayName) => lockedDisplay.has(displayName);
        const result = moveSelectionInList(displayApps, isDisplayLocked, selectedApps, direction);
        if (result) {
            window.renderModalTags();
            if (result === 'deselected') modalAppInput.focus();
        }
        return result;
    };

    const deleteSelectedApps = () => {
        if (selectedApps.size === 0) return false;
        const iosLabel = formatIOSScreenTimeSelectionLabel(modalIOSScreenTimeSelection);
        const toDeleteApps = modalApps.filter(
            a => selectedApps.has(displayNameForBlockedApp(a)) && !isAppLocked(a),
        );
        const shouldDeleteIos = iosLabel && selectedApps.has(iosLabel) && !isAppLocked(iosLabel);
        if (toDeleteApps.length === 0 && !shouldDeleteIos) {
            selectedApps.clear();
            window.renderModalTags();
            return false;
        }
        const previousIosSelection = shouldDeleteIos ? cloneIOSScreenTimeSelection(modalIOSScreenTimeSelection) : null;
        const restoredApps = [...toDeleteApps];
        pushModalUndo('app-bulk', () => {
            restoredApps.forEach(a => {
                if (!modalApps.includes(a)) modalApps.push(a);
            });
            if (previousIosSelection) {
                modalIOSScreenTimeSelection = cloneIOSScreenTimeSelection(previousIosSelection);
            }
            window.renderModalTags();
        });
        toDeleteApps.forEach(a => {
            const i = modalApps.indexOf(a);
            if (i !== -1) modalApps.splice(i, 1);
        });
        if (shouldDeleteIos) modalIOSScreenTimeSelection = null;
        selectedApps.clear();
        window.renderModalTags();
        return true;
    };

    // Close modal when clicking outside content
    document.getElementById('blocklist-modal').addEventListener('click', (e) => {
        if (e.target.classList.contains('modal-overlay')) {
            closeBlocklistModal();
        }
    });

    // Make the tags+input area feel like a single email-to-field: clicking
    // anywhere in the tags container (between chips, after the last chip,
    // empty space) focuses the matching input so the user can immediately
    // press Backspace to delete the last tag.
    const focusInputOnTagAreaClick = (tagsContainer, input) => {
        if (!tagsContainer || !input) return;
        const wrapper = tagsContainer.closest('.tags-input-container');
        if (!wrapper) return;
        wrapper.addEventListener('click', (e) => {
            if (e.target === input) return;
            // Don't hijack clicks on chips, the X buttons, or the trailing
            // browse/import button — they all have their own click semantics.
            if (e.target.closest('.tag')) return;
            if (e.target.closest('button')) return;
            input.focus();
        });
    };
    focusInputOnTagAreaClick(modalWebsitesTags, modalWebsiteInput);
    focusInputOnTagAreaClick(modalAppsTags, modalAppInput);

    function confirmModalWebsiteInputValue() {
        const raw = modalWebsiteInput.value.trim();
        if (!raw) return null;

        const result = processWebsiteInput(raw);
        const errorMsg = document.getElementById('website-input-error');

        if (result.websiteInvalid) {
            if (errorMsg) {
                errorMsg.classList.remove('hidden');
                setTimeout(() => errorMsg.classList.add('hidden'), 3000);
            }
        } else if (errorMsg) {
            errorMsg.classList.add('hidden');
        }

        if (result.hadProtected) {
            modalWebsiteInput.placeholder = tSettings('cannotBlockDomainPlaceholder');
            modalWebsiteInput.classList.add('input-error');
            setTimeout(() => {
                modalWebsiteInput.placeholder = tSettings('placeholderWebsiteExample');
                modalWebsiteInput.classList.remove('input-error');
            }, 2000);
        }

        if (result.toAdd.length > 0) {
            const toAddCopy = [...result.toAdd];
            pushModalUndo('website', () => {
                toAddCopy.forEach(w => {
                    const i = modalWebsites.indexOf(w);
                    if (i !== -1) modalWebsites.splice(i, 1);
                });
                window.renderModalTags();
            });
            result.toAdd.forEach(website => {
                if (!modalWebsites.includes(website)) modalWebsites.push(website);
            });
            window.renderModalTags();
        }
        modalWebsiteInput.value = result.inputValueToSet;
        return result;
    }

    function focusModalWebsiteInputFromNameField() {
        modalWebsiteInput.focus({ preventScroll: true });
        const pendingLen = modalWebsiteInput.value.length;
        const caret = pendingLen > 0 ? pendingLen : 0;
        modalWebsiteInput.setSelectionRange(caret, caret);
    }

    // Mobile: Name → websites. iOS shows plain Return (no default advance).
    if (state.isIOS) {
        const nameInput = document.getElementById('blocklist-name');
        nameInput.setAttribute('enterkeyhint', 'next');
        nameInput.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.keyCode !== 13) return;
            e.preventDefault();
            e.stopPropagation();
            focusModalWebsiteInputFromNameField();
        }, true);
    }

    document.getElementById('blocklist-name').addEventListener('input', () => {
        const nameInput = document.getElementById('blocklist-name');
        nameInput.classList.remove('input-error');
        const previous = state.lastBlocklistNameValue;
        pushModalUndo('name', () => {
            nameInput.value = previous;
            state.lastBlocklistNameValue = previous;
            nameInput.classList.remove('input-error');
        });
        state.lastBlocklistNameValue = nameInput.value;
    });

    modalWebsiteInput.addEventListener('keydown', (e) => {
        const accel = e.metaKey || e.ctrlKey;

        // Cmd/Ctrl-A in an empty input → select all unlocked website tags.
        // Caret in input + text present keeps the native "select text" behaviour.
        if (accel && (e.key === 'a' || e.key === 'A') && !modalWebsiteInput.value.length) {
            e.preventDefault();
            selectAllUnlockedWebsites();
            return;
        }

        // Arrow navigation. ArrowLeft from an empty input pulls the last chip
        // into selection; ArrowLeft/Right with an active selection walks the
        // chip list. With caret-in-text, fall through to the default behaviour.
        if (e.key === 'ArrowLeft' && !accel && !modalWebsiteInput.value.length && selectedWebsites.size === 0) {
            if (moveWebsiteSelection(-1)) e.preventDefault();
            return;
        }
        if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !accel && selectedWebsites.size > 0) {
            if (moveWebsiteSelection(e.key === 'ArrowLeft' ? -1 : 1)) e.preventDefault();
            return;
        }

        // Backspace/Delete with active selection → bulk delete.
        if ((e.key === 'Backspace' || e.key === 'Delete') && selectedWebsites.size > 0) {
            e.preventDefault();
            deleteSelectedWebsites();
            return;
        }

        // Backspace on empty input removes the last website tag (if not locked)
        if (e.key === 'Backspace' && !modalWebsiteInput.value.length && modalWebsites.length > 0) {
            const lastIdx = modalWebsites.length - 1;
            const last = modalWebsites[lastIdx];
            if (!window.lockedWebsites || !window.lockedWebsites.includes(last)) {
                pushModalUndo('website', () => {
                    modalWebsites.splice(lastIdx, 0, last);
                    window.renderModalTags();
                });
                modalWebsites.splice(lastIdx, 1);
                window.renderModalTags();
                e.preventDefault();
            }
        }

        // Any printable key with an active selection clears it so the user can
        // keep typing without nuking their tags.
        if (selectedWebsites.size > 0 && !accel && e.key.length === 1) {
            clearWebsiteSelection();
        }
        // Enter or Space confirms the website(s) — supports multiple domains separated by space, newline, or comma
        if ((e.key === 'Enter' || e.key === ' ') && modalWebsiteInput.value.trim()) {
            e.preventDefault();
            confirmModalWebsiteInputValue();
        }
    });

    setupWebsitesImportMenu({
        addDomainsToModal: (rawDomains) => {
            // Validate, drop protected, drop dupes — same filtering rules as
            // the manual input keydown path.
            const cleaned = (rawDomains || [])
                .map(d => cleanDomainInput(d))
                .filter(d => isValidDomain(d) && !isProtectedDomain(d));
            const newDomains = cleaned.filter(d => !modalWebsites.includes(d));
            if (newDomains.length === 0) return;

            const addedCopy = [...newDomains];
            pushModalUndo('website', () => {
                addedCopy.forEach(w => {
                    const i = modalWebsites.indexOf(w);
                    if (i !== -1) modalWebsites.splice(i, 1);
                });
                window.renderModalTags();
            });
            newDomains.forEach(w => modalWebsites.push(w));
            window.renderModalTags();
        }
    });

    modalAppInput.addEventListener('keydown', (e) => {
        const accel = e.metaKey || e.ctrlKey;

        if (accel && (e.key === 'a' || e.key === 'A') && !modalAppInput.value.length) {
            e.preventDefault();
            selectAllUnlockedApps();
            return;
        }

        if (e.key === 'ArrowLeft' && !accel && !modalAppInput.value.length && selectedApps.size === 0) {
            if (moveAppSelection(-1)) e.preventDefault();
            return;
        }
        if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !accel && selectedApps.size > 0) {
            if (moveAppSelection(e.key === 'ArrowLeft' ? -1 : 1)) e.preventDefault();
            return;
        }

        if ((e.key === 'Backspace' || e.key === 'Delete') && selectedApps.size > 0) {
            e.preventDefault();
            deleteSelectedApps();
            return;
        }

        // Backspace on empty input removes the last app tag (if not locked)
        if (e.key === 'Backspace' && !modalAppInput.value.length && modalApps.length > 0) {
            const lastIdx = modalApps.length - 1;
            const last = modalApps[lastIdx];
            if (!window.lockedApps || !window.lockedApps.includes(last)) {
                pushModalUndo('app', () => {
                    modalApps.splice(lastIdx, 0, last);
                    window.renderModalTags();
                });
                modalApps.splice(lastIdx, 1);
                window.renderModalTags();
                e.preventDefault();
            }
        }

        if (selectedApps.size > 0 && !accel && e.key.length === 1) {
            clearAppSelection();
        }
        if (e.key === 'Enter' && modalAppInput.value.trim()) {
            e.preventDefault();
            const app = modalAppInput.value.trim();
            if (isProtectedApp(app)) {
                // Show brief warning — ReDD Blocker cannot block itself
                modalAppInput.value = '';
                modalAppInput.placeholder = tSettings('cannotBlockSelfAppPlaceholder');
                modalAppInput.classList.add('input-error');
                setTimeout(() => {
                    syncModalAppPlaceholder();
                    modalAppInput.classList.remove('input-error');
                }, 2000);
                return;
            }
            if (!modalApps.includes(app)) {
                pushModalUndo('app', () => {
                    const i = modalApps.indexOf(app);
                    if (i !== -1) modalApps.splice(i, 1);
                    window.renderModalTags();
                });
                modalApps.push(app);
                window.renderModalTags();
            }
            modalAppInput.value = '';
        }
    });

    // Browse button for modal
    const modalBrowseBtn = document.getElementById('modal-browse-apps-btn');
    if (state.isIOS && modalBrowseBtn) {
        modalBrowseBtn.addEventListener('click', async () => {
            try {
                // Allow mode: the native picker expands category picks into
                // their member app tokens (the only thing `.all(except:)` can
                // enforce) and returns no category tokens.
                const result = await tauriAPI.showActivityPicker({
                    initialApplicationTokenData: modalIOSScreenTimeSelection?.applicationTokens || [],
                    initialCategoryTokenData: modalIOSScreenTimeSelection?.categoryTokens || [],
                    mode: getSelectedBlocklistModalMode()
                });
                if (!result.cancelled && (result.applicationCount > 0 || result.categoryCount > 0)) {
                    const previousSelection = cloneIOSScreenTimeSelection(modalIOSScreenTimeSelection);
                    pushModalUndo('ios-screentime-selection', () => {
                        modalIOSScreenTimeSelection = cloneIOSScreenTimeSelection(previousSelection);
                        window.renderModalTags();
                    });
                    modalIOSScreenTimeSelection = normalizeIOSScreenTimeSelection({
                        applicationTokens: result.applicationTokens || [],
                        categoryTokens: result.categoryTokens || [],
                        applicationCount: result.applicationCount || 0,
                        categoryCount: result.categoryCount || 0,
                        requiresReselection: false
                    });
                    window.renderModalTags();
                } else if (!result.cancelled && modalIOSScreenTimeSelection) {
                    const previousSelection = cloneIOSScreenTimeSelection(modalIOSScreenTimeSelection);
                    pushModalUndo('ios-screentime-selection-clear', () => {
                        modalIOSScreenTimeSelection = cloneIOSScreenTimeSelection(previousSelection);
                        window.renderModalTags();
                    });
                    modalIOSScreenTimeSelection = null;
                    window.renderModalTags();
                }
            } catch (err) {
                console.error('Activity picker error:', err);
                alert('Failed to open app picker: ' + err);
            }
        });
    } else if (modalBrowseBtn) {
        modalBrowseBtn.addEventListener('click', async () => {
            // Open the in-app installed apps picker instead of the OS file picker
            openInstalledAppsPicker();
        });
    }
    // Override type
    document.getElementById('override-type').addEventListener('change', (e) => {
        const overrideTypeSelect = e.target;
        const previousType = state.lastOverrideTypeValue;
        pushModalUndo('override-type', () => {
            overrideTypeSelect.value = previousType;
            state.lastOverrideTypeValue = previousType;
            overrideTypeSelect.dispatchEvent(new Event('change'));
        });

        const type = e.target.value;
        const overrideCountInput = document.getElementById('override-count');
        applyOverrideTypeUi(type);

        // Clamp to the new type-specific max when switching types.
        overrideCountInput.value = normalizeOverrideCount(overrideCountInput.value, type);
        state.lastOverrideTypeValue = overrideTypeSelect.value;

        const maxDifficultyCb = document.getElementById('override-max-difficulty-checkbox');
        if (maxDifficultyCb && maxDifficultyCb.checked && type !== 'custom') {
            const maxCount = getMaxOverrideCharsForType(type);
            overrideCountInput.value = String(maxCount);
            overrideCountInput.max = String(maxCount);
            state.lastOverrideCountValue = overrideCountInput.value;
            setOverrideCountMaxMode(true);
        }
    });
    document.getElementById('override-max-difficulty-checkbox').addEventListener('change', (e) => {
        const checked = e.target.checked;
        const overrideTypeSelect = document.getElementById('override-type');
        const overrideCountInput = document.getElementById('override-count');
        if (checked) {
            state.lastOverrideTypeValueBeforeMaxDifficulty = overrideTypeSelect.value;
            state.lastOverrideCountValueBeforeMaxDifficulty = overrideCountInput.value.trim() || state.lastOverrideCountValueBeforeMaxDifficulty;
            const type = overrideTypeSelect.value;
            applyOverrideTypeUi(type);
            const maxCount = getMaxOverrideCharsForType(type);
            overrideCountInput.value = String(maxCount);
            overrideCountInput.max = String(maxCount);
            state.lastOverrideCountValue = overrideCountInput.value;
            setOverrideCountMaxMode(true);
            updateOverridePreview(); // preview must reflect max count (set just above)
        } else {
            const typeToRestore = state.lastOverrideTypeValueBeforeMaxDifficulty;
            overrideTypeSelect.value = typeToRestore;
            applyOverrideTypeUi(typeToRestore);
            const maxChars = getMaxOverrideCharsForType(typeToRestore);
            overrideCountInput.max = String(maxChars);
            overrideCountInput.value = normalizeOverrideCount(String(state.lastOverrideCountValueBeforeMaxDifficulty), typeToRestore);
            state.lastOverrideCountValue = overrideCountInput.value;
            state.lastOverrideCountValueBeforeMaxDifficulty = overrideCountInput.value;
            setOverrideCountMaxMode(false);
            updateOverridePreview(); // preview must reflect restored count (set just above)
        }
    });
    document.getElementById('custom-override-text').addEventListener('input', (e) => {
        const customTextArea = e.target;
        const previous = state.lastCustomOverrideTextValue;
        pushModalUndo('custom-override-text', () => {
            customTextArea.value = previous;
            state.lastCustomOverrideTextValue = previous;
            const warningEl = document.getElementById('override-count-warning');
            const maxChars = getMaxOverrideCharsForType('custom');
            if (previous.length >= maxChars) {
                const charsPerMinute = getTypingCharsPerMinuteForType('custom');
                const estimatedMinutes = Math.ceil(maxChars / charsPerMinute);
                warningEl.textContent = `Max is ${maxChars} characters so it's still possible to override in case of emergency (takes you ~${estimatedMinutes} minutes to type).`;
                warningEl.classList.remove('hidden');
            } else {
                warningEl.classList.add('hidden');
                warningEl.textContent = '';
            }
        });

        const warningEl = document.getElementById('override-count-warning');
        const maxChars = getMaxOverrideCharsForType('custom');
        const charsPerMinute = getTypingCharsPerMinuteForType('custom');
        const estimatedMinutes = Math.ceil(maxChars / charsPerMinute);
        e.target.maxLength = maxChars;

        if (e.target.value.length > maxChars) {
            e.target.value = e.target.value.slice(0, maxChars);
        }

        if (e.target.value.length >= maxChars) {
            warningEl.textContent = `Max is ${maxChars} characters so it's still possible to override in case of emergency (takes you ~${estimatedMinutes} minutes to type).`;
            warningEl.classList.remove('hidden');
        } else {
            warningEl.classList.add('hidden');
            warningEl.textContent = '';
        }
        state.lastCustomOverrideTextValue = e.target.value;
        updateOverridePreview();
    });

    // Override count blur on enter
    document.getElementById('override-count').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.target.blur();
        }
    });
    document.getElementById('override-count').addEventListener('input', (e) => {
        const overrideCountInput = e.target;
        const previous = state.lastOverrideCountValue;
        const current = overrideCountInput.value;
        if (previous !== current) {
            pushModalUndo('override-count', () => {
                overrideCountInput.value = previous;
                state.lastOverrideCountValue = previous;
            });
        }

        const warningEl = document.getElementById('override-count-warning');
        const overrideType = document.getElementById('override-type')?.value || 'random-words';
        const maxChars = getMaxOverrideCharsForType(overrideType);
        const unitLabel = usesMobileWordCountForOverrideType(overrideType) ? 'words' : 'characters';
        e.target.max = String(maxChars);
        const rawValue = e.target.value.trim();
        if (rawValue === '') {
            warningEl.classList.add('hidden');
            warningEl.textContent = '';
            state.lastOverrideCountValue = e.target.value;
            updateOverridePreview();
            return;
        }

        const parsed = parseInt(rawValue, 10);
        if (Number.isFinite(parsed) && parsed > maxChars) {
            const estimatedMinutes = getOverrideEstimatedMinutes(overrideType, maxChars, '');
            e.target.value = maxChars;
            warningEl.textContent = `Max is ${maxChars} ${unitLabel} so it's still possible to override in case of emergency (takes you ~${estimatedMinutes} minutes to type).`;
            warningEl.classList.remove('hidden');
        } else {
            warningEl.classList.add('hidden');
            warningEl.textContent = '';
        }
        state.lastOverrideCountValue = e.target.value;
        updateOverridePreview();
    });
    document.getElementById('override-count').addEventListener('blur', (e) => {
        const overrideType = document.getElementById('override-type')?.value || 'random-words';
        e.target.value = normalizeOverrideCount(e.target.value, overrideType);
        updateOverridePreview();
    });

    const adjustOverrideCount = (delta) => {
        const overrideCountInput = document.getElementById('override-count');
        const maxDifficultyCb = document.getElementById('override-max-difficulty-checkbox');
        if (!overrideCountInput || maxDifficultyCb?.checked) return;
        const overrideType = document.getElementById('override-type')?.value || 'random-words';
        const parsed = Number.parseInt(overrideCountInput.value, 10);
        const current = Number.isFinite(parsed) ? parsed : DEFAULT_OVERRIDE_COUNT;
        overrideCountInput.value = normalizeOverrideCount(String(current + delta), overrideType);
        overrideCountInput.dispatchEvent(new Event('input', { bubbles: true }));
    };
    document.getElementById('override-count-minus')?.addEventListener('click', () => adjustOverrideCount(-1));
    document.getElementById('override-count-plus')?.addEventListener('click', () => adjustOverrideCount(1));

    document.querySelectorAll('.color-swatch').forEach(swatch => {
        swatch.addEventListener('click', () => {
            document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
            swatch.classList.add('selected');
            applyModalBlocklistTint(swatch.dataset.color);
        });
    });
    document.getElementById('custom-color-input')?.addEventListener('input', (e) => {
        const customSwatch = document.getElementById('custom-color-swatch');
        const color = e.target.value;
        customSwatch.style.background = color;
        customSwatch.dataset.color = color;
        document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
        customSwatch.classList.add('selected');
        applyModalBlocklistTint(color);
    });

    // Emoji swatches
    document.querySelectorAll('.emoji-swatch').forEach(swatch => {
        swatch.addEventListener('click', () => {
            // Only handle non-custom swatches here, or custom swatches if they already have an emoji
            if (!swatch.classList.contains('custom-emoji-swatch') || swatch.dataset.emoji) {
                document.querySelectorAll('.emoji-swatch').forEach(s => s.classList.remove('selected'));
                swatch.classList.add('selected');
            }
        });
    });

    // Custom emoji picker with emoji-picker-element popover
    const customEmojiSwatch = document.getElementById('custom-emoji-swatch');
    const emojiPickerPopover = document.getElementById('emoji-picker-popover');
    const emojiPicker = emojiPickerPopover?.querySelector('emoji-picker');

    if (customEmojiSwatch && emojiPickerPopover && emojiPicker) {
        function readSafeAreaInsetTop() {
            const probe = document.createElement('div');
            probe.style.cssText = 'position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top,0px);';
            document.body.appendChild(probe);
            const inset = parseFloat(getComputedStyle(probe).paddingTop) || 0;
            probe.remove();
            return inset;
        }

        /** Lowest Y (viewport coords) the picker top may use without overlapping safe area / chrome. */
        function getEmojiPickerMinTop(padding) {
            const safeTop = readSafeAreaInsetTop();
            const blocklistModal = document.getElementById('blocklist-modal');
            if (blocklistModal && !blocklistModal.classList.contains('hidden')) {
                const modalHeader = blocklistModal.querySelector('.mobile-modal-header');
                if (modalHeader) {
                    return modalHeader.getBoundingClientRect().bottom + padding;
                }
            }
            const titleBar = document.querySelector('.title-bar');
            const titleBarBottom = titleBar?.classList.contains('hidden')
                ? 0
                : (titleBar?.getBoundingClientRect().bottom ?? 0);
            return Math.max(safeTop + padding, titleBarBottom + padding);
        }

        function positionEmojiPickerPopover() {
            const gap = 8;
            const padding = 8;

            emojiPickerPopover.style.top = '';
            emojiPickerPopover.style.bottom = '';
            emojiPickerPopover.style.left = '';
            emojiPickerPopover.style.right = '';

            // Escape modal overflow clipping while open
            if (emojiPickerPopover.parentElement !== document.body) {
                document.body.appendChild(emojiPickerPopover);
            }

            emojiPickerPopover.classList.remove('hidden');

            const rect = customEmojiSwatch.getBoundingClientRect();
            const popoverRect = emojiPickerPopover.getBoundingClientRect();
            const popoverHeight = popoverRect.height;
            const popoverWidth = popoverRect.width;

            const minTop = getEmojiPickerMinTop(padding);
            const aboveTop = rect.top - popoverHeight - gap;
            const belowTop = rect.bottom + gap;
            // Place above only when the picker's top edge stays below the safe/chrome line.
            let top = aboveTop >= minTop ? aboveTop : belowTop;
            top = Math.max(minTop, Math.min(top, window.innerHeight - popoverHeight - padding));

            let left = rect.right - popoverWidth;
            left = Math.max(padding, Math.min(left, window.innerWidth - popoverWidth - padding));

            emojiPickerPopover.style.top = `${top}px`;
            emojiPickerPopover.style.left = `${left}px`;
        }

        // Toggle popover on swatch click
        customEmojiSwatch.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            // The picker carries a sizeable emoji database. Load it only
            // when somebody opens the custom picker instead of parsing it on
            // every app launch (especially costly in Android WebView).
            if (!customElements.get('emoji-picker')) {
                await import('emoji-picker-element');
            }

            if (emojiPickerPopover.classList.contains('hidden')) {
                positionEmojiPickerPopover();
            } else {
                emojiPickerPopover.classList.add('hidden');
            }
        });

        // Handle emoji selection
        emojiPicker.addEventListener('emoji-click', (e) => {
            const emoji = e.detail.unicode;
            customEmojiSwatch.innerHTML = emoji;
            customEmojiSwatch.dataset.emoji = emoji;

            // Select the custom swatch
            document.querySelectorAll('.emoji-swatch').forEach(s => s.classList.remove('selected'));
            customEmojiSwatch.classList.add('selected');

            // Hide popover
            emojiPickerPopover.classList.add('hidden');
        });

        // Close popover when clicking outside
        document.addEventListener('click', (e) => {
            if (!emojiPickerPopover.classList.contains('hidden') &&
                !emojiPickerPopover.contains(e.target) &&
                !customEmojiSwatch.contains(e.target)) {
                emojiPickerPopover.classList.add('hidden');
            }
        });
    }

    // Blocklist modal advanced options toggle
    const blocklistAdvancedToggle = document.getElementById('blocklist-advanced-toggle');
    const blocklistAdvancedContent = document.getElementById('blocklist-advanced-content');
    if (blocklistAdvancedToggle && blocklistAdvancedContent) {
        blocklistAdvancedToggle.addEventListener('click', () => {
            const willExpand = blocklistAdvancedContent.classList.contains('hidden');
            blocklistAdvancedToggle.classList.toggle('expanded');
            blocklistAdvancedContent.classList.toggle('hidden');
            if (willExpand) {
                requestAnimationFrame(() => {
                    const scrollBody = blocklistAdvancedContent.closest('.mobile-modal-scroll-body');
                    scrollElementWithinContainer(scrollBody, blocklistAdvancedContent);
                });
            }
        });
    }

    // Cancel button
    document.getElementById('cancel-blocklist-btn').addEventListener('click', () => {
        closeBlocklistModal();
    });

    // Save button
    document.getElementById('save-blocklist-btn').addEventListener('click', () => {
        const nameInput = document.getElementById('blocklist-name');
        const name = truncateBlocklistName(nameInput.value.trim());
        const nameEmpty = !name;
        if (nameEmpty) {
            nameInput.classList.add('input-error');
        } else {
            nameInput.classList.remove('input-error');
        }

        // Auto-confirm any pending website input using the same validation flow as Enter/Space.
        let websiteInvalid = false;
        const pendingWebsiteRaw = modalWebsiteInput.value.trim();
        if (pendingWebsiteRaw) {
            const result = confirmModalWebsiteInputValue();
            if (result?.hadProtected) return;
            if (result?.websiteInvalid) websiteInvalid = true;
        }

        if (nameEmpty || websiteInvalid) return;

        nameInput.value = name;

        const pendingApp = modalAppInput.value.trim();
        if (pendingApp && !isProtectedApp(pendingApp) && !modalApps.includes(pendingApp)) {
            pushModalUndo('app', () => {
                const i = modalApps.indexOf(pendingApp);
                if (i !== -1) modalApps.splice(i, 1);
                window.renderModalTags();
            });
            modalApps.push(pendingApp);
            modalAppInput.value = '';
            window.renderModalTags();
        } else {
            modalAppInput.value = '';
        }

        const mode = getSelectedBlocklistModalMode();
        const overrideType = document.getElementById('override-type').value;
        const overrideCountInput = document.getElementById('override-count');
        const maxDifficultyChecked = document.getElementById('override-max-difficulty-checkbox').checked;
        const overrideCount = maxDifficultyChecked
            ? getMaxOverrideCharsForType(overrideType)
            : normalizeOverrideCount(overrideCountInput.value, overrideType);
        overrideCountInput.value = overrideCount;
        const customTextArea = document.getElementById('custom-override-text');
        const customText = normalizeCustomOverrideText(customTextArea.value);
        customTextArea.value = customText;
        const selectedSwatch = document.querySelector('.color-swatch.selected');
        const color = selectedSwatch ? selectedSwatch.dataset.color : null;
        const selectedEmoji = document.querySelector('.emoji-swatch.selected');
        const emoji = selectedEmoji ? selectedEmoji.dataset.emoji : '📱';

        const showItemDetails = document.getElementById('show-item-details-checkbox').checked;
        // Preserve the blocklist's existing schedule visibility (toggled via the chips above the
        // schedule); default to true for new blocklists.
        const existingBlocklistForSave = state.editingBlocklistId
            ? state.appData.blocklists.find(bl => bl.id === state.editingBlocklistId)
            : null;
        const alwaysShowInSchedule = existingBlocklistForSave?.alwaysShowInSchedule !== false;

        const overrideDifficultyPayload = {
            type: overrideType,
            count: overrideCount,
            maxDifficulty: maxDifficultyChecked,
            customText: customText
        };
        if (maxDifficultyChecked) {
            overrideDifficultyPayload.countBeforeMax = normalizeOverrideCount(
                String(state.lastOverrideCountValueBeforeMaxDifficulty),
                state.lastOverrideTypeValueBeforeMaxDifficulty
            );
            overrideDifficultyPayload.typeBeforeMax = state.lastOverrideTypeValueBeforeMaxDifficulty;
        }

        // IMPORTANT: Create copies of the arrays, not references!
        const blocklist = {
            id: state.editingBlocklistId || generateId(),
            name,
            mode,
            color,
            emoji,
            websites: [...modalWebsites],
            apps: [...modalApps],
            iosScreenTimeSelection: cloneIOSScreenTimeSelection(modalIOSScreenTimeSelection),
            showItemDetails,
            alwaysShowInSchedule,
            overrideDifficulty: overrideDifficultyPayload
        };

        if (state.editingBlocklistId) {
            const idx = state.appData.blocklists.findIndex(bl => bl.id === state.editingBlocklistId);
            if (idx !== -1) {
                state.appData.blocklists[idx] = blocklist;
            }
        } else {
            state.appData.blocklists.push(blocklist);
        }

        saveData();

        // If this blocklist is active (block or schedule), update blocking rules immediately
        const now = Date.now();
        const hasActiveBlock = state.appData.activeBlocks.some(
            b => b.blocklistId === blocklist.id && b.startTime <= now && b.endTime > now
        );
        const hasActiveSchedule = state.appData.schedules?.some(
            s => s.blocklistId === blocklist.id && s.segments && s.segments.length > 0
        );

        if (hasActiveBlock || hasActiveSchedule) {
            // Update website blocking
            updateHostsFile();

            // Sync schedules to helper (blocklist domains/apps may have changed)
            syncSchedulesToHelper();

            // Update app blocking - this handles both active blocks and schedules
            updateBlockedApps();
        }

        // Keep live preview while editing, but don't revert after a confirmed save.
        state.blocklistModalPreviewSnapshot = null;
        closeBlocklistModal();

        // Only update blocklist display without resetting schedule segments
        renderBlocklists();
        renderBlocklistSelector();
        renderWeekBlocks(); // Refresh calendar so colour / emoji / name changes propagate
        renderNowBlockingRow(); // Title-bar chips read emoji/name from freshly saved blocklist
        renderScheduleAlwaysOnRow();

        // If this was the first blocklist created from the empty state,
        // auto-select it so the user doesn't have to click it. `force`
        // clears the deselect flag — creating a new blocklist is a
        // strong "I want to use this" signal.
        if (!state.editingBlocklistId) autoSelectSoleBlocklist({ force: true });

        // Re-trigger blocklist selection to update button text (name may have changed)
        if (state.selectedBlocklistId) {
            const dropdown = document.getElementById('blocklist-select');
            if (dropdown) {
                dropdown.value = state.selectedBlocklistId;
                handleBlocklistSelect({ target: dropdown });
            }
        }
    });

    // Store references for modal functions
    window.getModalApps = () => modalApps;
    window.lockedWebsites = [];
    window.lockedApps = [];
    window.clearModalTagSelections = () => {
        selectedWebsites.clear();
        selectedApps.clear();
    };

    window.renderModalTags = () => {
        renderTags(modalWebsitesTags, modalWebsites, (idx) => {
            const value = modalWebsites[idx];
            if (window.lockedWebsites && window.lockedWebsites.includes(value)) {
                return; // Do not remove locked items; do not push undo.
            }
            pushModalUndo('website', () => {
                modalWebsites.splice(idx, 0, value);
                window.renderModalTags();
            });
            modalWebsites.splice(idx, 1);
            window.renderModalTags();
        }, window.lockedWebsites, {
            selectedItems: selectedWebsites,
            onTagClick: (idx) => {
                const value = modalWebsites[idx];
                if (!value || isWebsiteLocked(value)) return;
                if (selectedWebsites.has(value)) {
                    selectedWebsites.delete(value);
                } else {
                    selectedWebsites.add(value);
                }
                window.renderModalTags();
                // Keep keyboard focus on the input so Backspace works immediately.
                modalWebsiteInput.focus();
            }
        });

        const displayApps = getModalDisplayApps();
        const screenTimeLabel = formatIOSScreenTimeSelectionLabel(modalIOSScreenTimeSelection);
        renderTags(modalAppsTags, displayApps, (idx) => {
            if (displayApps[idx] === screenTimeLabel) {
                if (isAppLocked(screenTimeLabel)) return;
                const previousSelection = cloneIOSScreenTimeSelection(modalIOSScreenTimeSelection);
                pushModalUndo('ios-screentime-selection-remove', () => {
                    modalIOSScreenTimeSelection = cloneIOSScreenTimeSelection(previousSelection);
                    window.renderModalTags();
                });
                modalIOSScreenTimeSelection = null;
            } else {
                const processName = modalApps[idx];
                if (!processName || isAppLocked(processName)) return;
                const appIdx = modalApps.indexOf(processName);
                if (appIdx === -1) return;
                pushModalUndo('app', () => {
                    modalApps.splice(appIdx, 0, processName);
                    window.renderModalTags();
                });
                modalApps.splice(appIdx, 1);
            }
            window.renderModalTags();
        }, getModalLockedAppDisplayItems(), {
            selectedItems: selectedApps,
            onTagClick: (idx) => {
                const value = displayApps[idx];
                if (!value) return;
                if (value === screenTimeLabel) {
                    if (isAppLocked(screenTimeLabel)) return;
                } else if (isAppLocked(modalApps[idx])) {
                    return;
                }
                if (selectedApps.has(value)) {
                    selectedApps.delete(value);
                } else {
                    selectedApps.add(value);
                }
                window.renderModalTags();
                modalAppInput.focus();
            }
        });

        syncModalWebsitePlaceholder();
        syncModalAppPlaceholder();
    };

    // Esc inside the modal clears any active tag selection (it does NOT close
    // the modal in that case — only when no selection is active).
    document.getElementById('blocklist-modal').addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const clearedWebsites = clearWebsiteSelection();
        const clearedApps = clearAppSelection();
        if (clearedWebsites || clearedApps) e.stopPropagation();
    });

    window.setModalData = (websites, apps, iosScreenTimeSelection = null, lockedWebsitesList = [], lockedAppsList = []) => {
        modalWebsites.length = 0;
        modalApps.length = 0;
        selectedWebsites.clear();
        selectedApps.clear();
        modalIOSScreenTimeSelection = cloneIOSScreenTimeSelection(iosScreenTimeSelection);
        window.lockedWebsites = lockedWebsitesList;
        window.lockedApps = lockedAppsList;

        websites.forEach(w => modalWebsites.push(w));
        apps.forEach(a => modalApps.push(a));
        window.renderModalTags();
    };
}

// Override modal listeners
function setupOverrideModalListeners() {
    const challengeInput = document.getElementById('challenge-input');
    const challengeWordInput = document.getElementById('challenge-word-input');
    const progressBar = document.getElementById('challenge-progress-bar');
    const challengeTextEl = document.getElementById('challenge-text');
    const challengeCurrentWordEl = document.getElementById('challenge-current-word');

    function getOverrideTypedValue() {
        return state.overrideWordChallengeState?.typedText ?? challengeInput.value;
    }

    // Helper to render challenge text with optional error highlight
    function renderChallengeText(errorIndex = -1) {
        if (errorIndex < 0 || errorIndex >= state.challengeText.length) {
            challengeTextEl.textContent = state.challengeText;
        } else {
            // Highlight the error character
            const before = escapeHtml(state.challengeText.slice(0, errorIndex));
            const errorChar = escapeHtml(state.challengeText[errorIndex]);
            const after = escapeHtml(state.challengeText.slice(errorIndex + 1));
            challengeTextEl.innerHTML = `${before}<span class="error-char">${errorChar}</span>${after}`;
        }
    }

    // Prevent paste - users must type manually
    challengeInput.addEventListener('paste', (e) => {
        e.preventDefault();
    });
    challengeWordInput.addEventListener('paste', (e) => {
        e.preventDefault();
    });

    challengeInput.addEventListener('input', () => {
        const typed = challengeInput.value;
        const target = state.challengeText;

        // Calculate progress and find first error
        let correctChars = 0;
        let firstErrorIndex = -1;
        for (let i = 0; i < typed.length && i < target.length; i++) {
            if (typed[i] === target[i]) {
                correctChars++;
            } else {
                firstErrorIndex = i;
                break; // Stop at first mismatch
            }
        }

        const progress = (correctChars / target.length) * 100;
        progressBar.style.width = `${progress}%`;

        // Show red highlight on the reference text at the first mismatch (-1 clears)
        renderChallengeText(firstErrorIndex);
    });

    challengeWordInput.addEventListener('input', () => {
        if (!state.overrideWordChallengeState) return;
        challengeCurrentWordEl.textContent = getCurrentChallengeWord(state.overrideWordChallengeState);
    });

    // Enter key submits the override
    challengeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault(); // Prevent newline in textarea
            document.getElementById('confirm-override-btn').click();
        }
    });
    challengeWordInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            document.getElementById('confirm-override-btn').click();
        }
    });

    document.getElementById('cancel-override-btn').addEventListener('click', () => {
        // Check for helper removal special case
        if (state.overrideBlockId === 'helper-removal' && window.helperRemovalCancelCallback) {
            window.helperRemovalCancelCallback();
            return;
        }
        closeOverrideModal();
    });

    // Pause block button
    document.getElementById('pause-block-btn').addEventListener('click', () => {
        if (!state.selectedBlocklistId) return;
        const now = Date.now();

        // Try one-off block first
        const activeBlock = state.appData.activeBlocks.find(b =>
            b.blocklistId === state.selectedBlocklistId && b.startTime <= now && b.endTime > now
        );
        if (activeBlock) {
            if (activeBlock.isPaused) {
                // Resume — show confirmation dialog
                openResumeConfirmation(state.selectedBlocklistId, 'block', activeBlock.id);
            } else {
                // Pause
                state.pauseScheduleData = null;
                openPauseModal(activeBlock.id);
            }
            return;
        }

        // Try schedule — find the currently active segment
        const schedule = state.appData.schedules?.find(s => s.blocklistId === state.selectedBlocklistId);
        if (schedule) {
            if (isSchedulePausedNow(schedule, now)) {
                // Resume — show confirmation dialog
                openResumeConfirmation(state.selectedBlocklistId, 'schedule', null);
                return;
            }
            state.pauseScheduleData = {
                blocklistId: state.selectedBlocklistId,
                isActiveNow: isScheduleSegmentActiveNow(schedule)
            };
            openPauseModal(null); // null blockId signals schedule pause
        }
    });

    // Pause modal event listeners
    document.getElementById('cancel-pause-btn').addEventListener('click', closePauseModal);
    document.getElementById('pause-modal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closePauseModal();
    });

    document.getElementById('confirm-pause-btn').addEventListener('click', async () => {
        await proceedWithPause();
    });

    // Pause duration inputs — update restart time display
    document.getElementById('pause-days').addEventListener('input', updatePauseRestartTime);
    document.getElementById('pause-hours').addEventListener('input', function () {
        let val = parseInt(this.value);
        if (val > 23) { this.value = 23; }
        if (val < 0) { this.value = 0; }
        updatePauseRestartTime();
    });
    document.getElementById('pause-minutes').addEventListener('input', function () {
        let val = parseInt(this.value);
        if (val > 59) { this.value = 59; }
        if (val < 0) { this.value = 0; }
        updatePauseRestartTime();
    });

    // Pause challenge input — track progress
    const pauseChallengeInput = document.getElementById('pause-challenge-input');
    const pauseChallengeWordInput = document.getElementById('pause-challenge-word-input');
    const pauseCurrentWordEl = document.getElementById('pause-current-word');
    pauseChallengeInput.addEventListener('input', () => {
        const typed = pauseChallengeInput.value;
        const target = state.pauseChallengeText;
        const progress = target.length > 0 ? Math.min(100, (typed.length / target.length) * 100) : 0;
        document.getElementById('pause-challenge-progress-bar').style.width = `${progress}%`;

        // Enable/disable confirm button
        document.getElementById('confirm-pause-btn').disabled = (typed !== target);
    });
    pauseChallengeWordInput.addEventListener('paste', (e) => {
        e.preventDefault();
    });
    pauseChallengeWordInput.addEventListener('input', () => {
        if (!state.pauseWordChallengeState) return;
        pauseCurrentWordEl.textContent = getCurrentChallengeWord(state.pauseWordChallengeState);
    });

    pauseChallengeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            document.getElementById('confirm-pause-btn').click();
        }
    });
    pauseChallengeWordInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            document.getElementById('confirm-pause-btn').click();
        }
    });

    const pauseDurationSection = document.querySelector('#pause-modal .pause-duration-section');
    if (pauseDurationSection && typeof ResizeObserver !== 'undefined') {
        const pauseDurationRo = new ResizeObserver(() => syncPauseDurationRowLayout());
        pauseDurationRo.observe(pauseDurationSection);
    }
    window.addEventListener('resize', () => syncPauseDurationRowLayout());

    const blockActionButtons = document.getElementById('block-action-buttons');
    if (blockActionButtons && typeof ResizeObserver !== 'undefined') {
        const stopButtonFitRo = new ResizeObserver(() => syncAllStopBtnLabelFits());
        stopButtonFitRo.observe(blockActionButtons);
    }
    window.addEventListener('resize', () => syncAllStopBtnLabelFits());
    window.addEventListener('resize', () => syncMobileScheduleDayLabelsViewportMode());
    window.visualViewport?.addEventListener('resize', syncMobileScheduleDayLabelsViewportMode);

    document.getElementById('confirm-override-btn').addEventListener('click', async () => {
        if (state.overrideWordChallengeState) {
            const expectedWord = getCurrentChallengeWord(state.overrideWordChallengeState);
            const typedWord = challengeWordInput.value.trim();
            if (typedWord === expectedWord) {
                state.overrideWordChallengeState.currentIndex++;
                const completedText = getCompletedChallengeText(state.overrideWordChallengeState);
                state.overrideWordChallengeState.typedText = state.overrideWordChallengeState.currentIndex >= state.overrideWordChallengeState.words.length
                    ? state.challengeText
                    : completedText;
                if (state.overrideWordChallengeState.currentIndex < state.overrideWordChallengeState.words.length) {
                    renderOverrideWordChallengeState();
                    challengeWordInput.focus();
                    return;
                }
            } else {
                const modalContent = document.querySelector('#override-modal .modal-content');
                modalContent.classList.remove('wiggle');
                void modalContent.offsetWidth;
                modalContent.classList.add('wiggle');
                challengeCurrentWordEl.textContent = getCurrentChallengeWord(state.overrideWordChallengeState);
                return;
            }
        }

        const typed = getOverrideTypedValue();
        const target = state.challengeText;

        // Find first mismatch
        let firstErrorIndex = -1;
        if (typed !== target) {
            for (let i = 0; i < Math.max(typed.length, target.length); i++) {
                if (typed[i] !== target[i]) {
                    firstErrorIndex = i;
                    break;
                }
            }
            // If typed is shorter than target, first missing char is the error
            if (firstErrorIndex === -1 && typed.length < target.length) {
                firstErrorIndex = typed.length;
            }
        }

        if (typed === target && (state.overrideBlockId || window.overrideScheduleId)) {
            // Check for helper removal special case
            if (state.overrideBlockId === 'helper-removal' && window.helperRemovalConfirmCallback) {
                window.helperRemovalConfirmCallback();
                return;
            }

            if (state.overrideBlockId && state.overrideBlockId !== 'helper-removal') {
                const overriddenBlock = state.appData.activeBlocks.find(b => b.id === state.overrideBlockId);
                const blocklistIdToClear = state.overrideBlocklistIdForHelper ?? (overriddenBlock ? overriddenBlock.blocklistId : null);
                state.appData.activeBlocks = state.appData.activeBlocks.filter(b => b.id !== state.overrideBlockId);
                await saveData();

                if (state.isIOS) {
                    await tauriAPI.screentimeClearBlock();
                    state.lastBlockedDomains = new Set();
                    await updateHostsFile();
                    await syncSchedulesToHelper();
                } else if (state.isAndroid) {
                    try {
                        await tauriAPI.androidStopManualBlock(state.overrideBlockId);
                    } catch (err) {
                        console.error('androidStopManualBlock failed:', err);
                    }
                    await syncSchedulesToHelper();
                } else {
                    const status = await refreshDesktopHelperStatus();
                    if (status.helperReady) {
                        if (blocklistIdToClear != null) {
                            await tauriAPI.clearBlockViaHelper(blocklistIdToClear);
                        } else {
                            console.error('[override] No blocklist id for single-block override; not touching helper state');
                        }
                    } else {
                        await updateHostsFile();
                    }
                }

                state.overrideBlocklistIdForHelper = null;
                // Update blocked apps (will stop watcher if no apps to block, including schedules)
                await updateBlockedApps();
            } else if (window.overrideScheduleId) {
                // Schedules behave like one-off blocks now: stopping always tears down the
                // entire schedule (no per-instance skip). Segments are re-loaded into the
                // editor so the user can re-start them later without re-typing them.
                const scheduleId = window.overrideScheduleId;
                const scheduleToStop = state.appData.schedules.find(s =>
                    s.id === scheduleId || s.blocklistId === scheduleId
                );

                if (scheduleToStop) {
                    state.scheduleSegments = scheduleToStop.segments.map(seg => ({ ...seg }));
                    state.activeScheduleSegmentCount = 0; // No segments are locked anymore

                    // Save these segments as pending so they persist when clicking off/on
                    if (!state.appData.settings) state.appData.settings = {};
                    if (!state.appData.settings.pendingScheduleSegments) state.appData.settings.pendingScheduleSegments = {};
                    state.appData.settings.pendingScheduleSegments[scheduleToStop.blocklistId] = state.scheduleSegments.map(seg => ({ ...seg }));

                    state.appData.schedules = state.appData.schedules.filter(s =>
                        s.id !== scheduleId && s.blocklistId !== scheduleId
                    );

                    // Rebuild UI to show all segments as editable if we're viewing this blocklist
                    if (state.selectedBlocklistId === scheduleToStop.blocklistId && state.isScheduleMode) {
                        rebuildScheduleSegments();
                        disableScheduleControls(false);
                    }
                } else {
                    state.activeScheduleSegmentCount = 0;
                }

                // On iOS, clear both Screen Time stores so the overridden schedule's blocks are removed
                // immediately; updateHostsFile and syncSchedulesToHelper will then re-apply correct state.
                if (state.isIOS) {
                    await tauriAPI.screentimeClearBlock();
                    state.lastBlockedDomains = new Set();
                }

                await saveData();
                await updateHostsFile();
                await syncSchedulesToHelper();
                await updateBlockedApps();

                delete window.overrideScheduleId;
            }

            render();

            // Refresh the blocklist selection UI to update button and controls
            const blocklistSelect = document.getElementById('blocklist-select');
            handleBlocklistSelect({ target: blocklistSelect });
            await refreshOpenHelperUi();

            closeOverrideModal();
        } else {
            // Wrong! Wiggle and highlight error
            const modalContent = document.querySelector('#override-modal .modal-content');
            modalContent.classList.remove('wiggle');
            void modalContent.offsetWidth; // Trigger reflow
            modalContent.classList.add('wiggle');

            // Highlight first wrong character
            if (state.overrideWordChallengeState) {
                challengeCurrentWordEl.textContent = getCurrentChallengeWord(state.overrideWordChallengeState);
            } else {
                renderChallengeText(firstErrorIndex);
            }
        }
    });

    // Click outside to close
    const overrideModal = document.getElementById('override-modal');
    overrideModal.addEventListener('click', (e) => {
        if (e.target === overrideModal) {
            closeOverrideModal();
        }
    });
}

// Render tags
function renderTags(container, items, onRemove, lockedItems = [], options = {}) {
    const selectedItems = options.selectedItems instanceof Set ? options.selectedItems : null;
    const onTagClick = typeof options.onTagClick === 'function' ? options.onTagClick : null;

    container.innerHTML = items.map((item, idx) => {
        const isLocked = lockedItems.includes(item);
        const isSelected = !isLocked && selectedItems?.has(item);
        const classes = ['tag'];
        if (isLocked) classes.push('locked');
        if (isSelected) classes.push('selected');
        const removeBtn = !isLocked ? `<button class="tag-remove" data-idx="${idx}">×</button>` : '';

        return `
    <span class="${classes.join(' ')}" data-idx="${idx}">
      ${escapeHtml(item)}
      ${removeBtn}
    </span>
  `;
    }).join('');

    container.querySelectorAll('.tag-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.idx);
            if (onRemove) onRemove(idx);
        });
    });

    if (onTagClick) {
        container.querySelectorAll('.tag').forEach(tagEl => {
            tagEl.addEventListener('click', (e) => {
                // Don't toggle when the user clicks the inline ✕ — that path
                // is handled by .tag-remove above and removes the chip outright.
                if (e.target.closest('.tag-remove')) return;
                const idx = parseInt(tagEl.dataset.idx);
                if (Number.isFinite(idx)) onTagClick(idx);
            });
        });
    }
}
// Track current selected end time only (start is always 'now')

// Pad number with leading zero

// Show schedule confirmation modal




// Utility functions
export function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

export function formatTime(date) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Last minute of the civil day (23:59). Drag/snap math uses 1440 as exclusive
// end-of-day; converting 1440 through hour/minute fields wrongly yielded 23:00.
export const MINUTES_PER_DAY = 1440;
export const MAX_SAME_DAY_END_MINUTES = MINUTES_PER_DAY - 1;

export function clampSameDayMinutes(totalMinutes) {
    return Math.max(0, Math.min(MAX_SAME_DAY_END_MINUTES, Math.round(totalMinutes)));
}

export function snapMinutesToInterval(minutes, intervalMinutes = 15) {
    return clampSameDayMinutes(Math.round(minutes / intervalMinutes) * intervalMinutes);
}

// Format a minutes-since-midnight value as zero-padded "HH:MM". Used by drag-resize
// handlers to live-update the time label inside a preview block.
export function formatMinutesAsHHMM(totalMinutes) {
    const clamped = clampSameDayMinutes(totalMinutes);
    const h = Math.floor(clamped / 60);
    const m = clamped % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function formatDuration(minutes) {
    if (minutes < 60) {
        return `${minutes} min${minutes !== 1 ? 's' : ''}`;
    }
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (mins === 0) {
        return `${hours} hour${hours !== 1 ? 's' : ''}`;
    }
    return `${hours}h ${mins}m`;
}

/** Remaining time chip, e.g. EN "1h 39m left", DA "1t 39m endnu" (`totalMins` = full minutes). */
export function formatBlockTimeRemainingShort(totalMins) {
    const n = Math.max(0, Math.floor(totalMins));
    const hrs = Math.floor(n / 60);
    const mins = n % 60;
    if (getSettingsLanguage() === 'da') {
        if (hrs > 0 && mins > 0) return `${hrs}t ${mins}m endnu`;
        if (hrs > 0) return `${hrs}t endnu`;
        return `${mins}m endnu`;
    }
    if (hrs > 0 && mins > 0) return `${hrs}h ${mins}m left`;
    if (hrs > 0) return `${hrs}h left`;
    return `${mins}m left`;
}


export function buildWordChallengeState(text) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    return {
        words,
        currentIndex: 0,
        typedText: ''
    };
}


export function isMobileWordByWordChallenge(difficulty) {
    return !!(isMobileOverrideChallengePlatform() && (difficulty?.type === 'random-words' || difficulty?.type === 'gibberish'));
}

export function getCurrentChallengeWord(state) {
    if (!state || state.currentIndex >= state.words.length) return '';
    return state.words[state.currentIndex];
}

export function getCompletedChallengeText(state) {
    if (!state || state.currentIndex <= 0) return '';
    return state.words.slice(0, state.currentIndex).join(' ');
}

export function setOverrideWordChallengeMode(enabled) {
    document.getElementById('challenge-word-progress')?.classList.toggle('hidden', !enabled);
    document.getElementById('challenge-current-word')?.classList.toggle('hidden', !enabled);
    document.getElementById('challenge-word-input')?.classList.toggle('hidden', !enabled);
    document.getElementById('challenge-input')?.classList.toggle('hidden', enabled);
}

export function renderOverrideWordChallengeState() {
    const progressLabelEl = document.getElementById('challenge-word-progress');
    const currentWordEl = document.getElementById('challenge-current-word');
    const wordInput = document.getElementById('challenge-word-input');
    const progressBar = document.getElementById('challenge-progress-bar');
    if (!state.overrideWordChallengeState || !progressLabelEl || !currentWordEl || !wordInput || !progressBar) return;
    const currentWord = getCurrentChallengeWord(state.overrideWordChallengeState);
    const completedText = getCompletedChallengeText(state.overrideWordChallengeState);
    const targetText = completedText ? `${completedText} ${currentWord}` : currentWord;
    progressLabelEl.textContent = `Word ${state.overrideWordChallengeState.currentIndex + 1} of ${state.overrideWordChallengeState.words.length}`;
    currentWordEl.textContent = currentWord;
    wordInput.value = '';
    progressBar.style.width = state.challengeText.length > 0
        ? `${Math.min(100, (targetText.length / state.challengeText.length) * 100)}%`
        : '0%';
    document.getElementById('confirm-override-btn').disabled = !currentWord;
}

export function setPauseWordChallengeMode(enabled) {
    document.getElementById('pause-word-progress')?.classList.toggle('hidden', !enabled);
    document.getElementById('pause-current-word')?.classList.toggle('hidden', !enabled);
    document.getElementById('pause-challenge-word-input')?.classList.toggle('hidden', !enabled);
    document.getElementById('pause-challenge-input')?.classList.toggle('hidden', enabled);
}

export function renderPauseWordChallengeState() {
    const progressLabelEl = document.getElementById('pause-word-progress');
    const currentWordEl = document.getElementById('pause-current-word');
    const wordInput = document.getElementById('pause-challenge-word-input');
    const progressBar = document.getElementById('pause-challenge-progress-bar');
    if (!state.pauseWordChallengeState || !progressLabelEl || !currentWordEl || !wordInput || !progressBar) return;
    const currentWord = getCurrentChallengeWord(state.pauseWordChallengeState);
    const completedText = getCompletedChallengeText(state.pauseWordChallengeState);
    const targetText = completedText ? `${completedText} ${currentWord}` : currentWord;
    progressLabelEl.textContent = `Word ${state.pauseWordChallengeState.currentIndex + 1} of ${state.pauseWordChallengeState.words.length}`;
    currentWordEl.textContent = currentWord;
    wordInput.value = '';
    progressBar.style.width = state.pauseChallengeText.length > 0
        ? `${Math.min(100, (targetText.length / state.pauseChallengeText.length) * 100)}%`
        : '0%';
    document.getElementById('confirm-pause-btn').disabled = !currentWord;
}

export function setOverrideAllWordChallengeMode(enabled) {
    document.getElementById('override-all-word-progress')?.classList.toggle('hidden', !enabled);
    document.getElementById('override-all-current-word')?.classList.toggle('hidden', !enabled);
    document.getElementById('override-all-challenge-word-input')?.classList.toggle('hidden', !enabled);
    document.getElementById('override-all-challenge-input')?.classList.toggle('hidden', enabled);
}

export function renderOverrideAllWordChallengeState() {
    const progressLabelEl = document.getElementById('override-all-word-progress');
    const currentWordEl = document.getElementById('override-all-current-word');
    const wordInput = document.getElementById('override-all-challenge-word-input');
    const progressBar = document.getElementById('override-all-progress-bar');
    if (!overrideAllWordChallengeState || !progressLabelEl || !currentWordEl || !wordInput || !progressBar) return;
    const currentWord = getCurrentChallengeWord(overrideAllWordChallengeState);
    const completedText = getCompletedChallengeText(overrideAllWordChallengeState);
    const targetText = completedText ? `${completedText} ${currentWord}` : currentWord;
    progressLabelEl.textContent = `Word ${overrideAllWordChallengeState.currentIndex + 1} of ${overrideAllWordChallengeState.words.length}`;
    currentWordEl.textContent = currentWord;
    wordInput.value = '';
    progressBar.style.width = overrideAllChallengeText.length > 0
        ? `${Math.min(100, (targetText.length / overrideAllChallengeText.length) * 100)}%`
        : '0%';
    document.getElementById('confirm-override-all-btn').disabled = !currentWord;
}

// Clean up URL for display (remove protocol, www, trailing slash)

const MOBILE_COMPACT_SCHEDULE_DAY_LABELS_MAX_VIEWPORT_WIDTH = 1024;

let iosCompactScheduleDayLabelsActive = null;

/** Smaller mobile viewports, including iPad portrait, use single-letter day pills from first render. */
function shouldUseCompactIosScheduleDayLabels() {
    return shouldUseCompactMobileScheduleDayLabels();
}

export function shouldUseCompactMobileScheduleDayLabels() {
    if (!state.isIOS && !state.isAndroid) return false;
    const effVp = Math.round(getEffectiveViewportWidth());
    return effVp > 0 && effVp <= MOBILE_COMPACT_SCHEDULE_DAY_LABELS_MAX_VIEWPORT_WIDTH;
}

export function syncMobileScheduleDayLabelsViewportMode() {
    if (!state.isIOS && !state.isAndroid) return;
    const nextCompact = shouldUseCompactMobileScheduleDayLabels();
    if (nextCompact === state.mobileCompactScheduleDayLabelsActive) return;
    state.mobileCompactScheduleDayLabelsActive = nextCompact;

    const schedulePanel = document.getElementById('schedule-block-panel');
    if (state.isScheduleMode && schedulePanel && !schedulePanel.classList.contains('hidden')) {
        rebuildScheduleSegments();
    }

    const scheduleConfirmModal = document.getElementById('start-schedule-confirm-modal');
    if (scheduleConfirmModal && !scheduleConfirmModal.classList.contains('hidden')) {
        renderScheduleConfirmSegments(document.getElementById('schedule-confirm-segments'), state.scheduleSegments);
    }
}


const LANGUAGE_PICKER_ROOT_IDS = ['language-picker', 'welcome-language-picker'];

function languagePickerElements(rootId) {
    return {
        picker: document.getElementById(rootId),
        trigger: document.getElementById(`${rootId}-trigger`),
        dropdown: document.getElementById(`${rootId}-dropdown`),
        triggerFlag: document.getElementById(`${rootId}-trigger-flag`),
        triggerCode: document.getElementById(`${rootId}-trigger-code`),
        currentName: document.getElementById(`${rootId}-current-name`),
        currentFlag: document.getElementById(`${rootId}-current-flag`),
        switchName: document.getElementById(`${rootId}-switch-name`),
        switchFlag: document.getElementById(`${rootId}-switch-flag`),
        curLabel: document.getElementById(`${rootId}-current-label`),
        swLabel: document.getElementById(`${rootId}-switch-label`),
        switchBtn: document.getElementById(`${rootId}-switch-btn`),
    };
}

export function isAnyLanguagePickerOpen() {
    return LANGUAGE_PICKER_ROOT_IDS.some((rootId) => {
        const { dropdown } = languagePickerElements(rootId);
        return dropdown && !dropdown.classList.contains('hidden');
    });
}

export function closeAllLanguagePickers() {
    for (const rootId of LANGUAGE_PICKER_ROOT_IDS) {
        const { dropdown, trigger } = languagePickerElements(rootId);
        if (!dropdown || !trigger) continue;
        dropdown.classList.add('hidden');
        trigger.setAttribute('aria-expanded', 'false');
    }
}

export function setLanguagePickerOpen(open, rootId) {
    if (open) {
        for (const id of LANGUAGE_PICKER_ROOT_IDS) {
            const { dropdown, trigger } = languagePickerElements(id);
            if (!dropdown || !trigger) continue;
            const show = id === rootId;
            dropdown.classList.toggle('hidden', !show);
            trigger.setAttribute('aria-expanded', show ? 'true' : 'false');
        }
        return;
    }
    if (rootId) {
        const { dropdown, trigger } = languagePickerElements(rootId);
        if (!dropdown || !trigger) return;
        dropdown.classList.add('hidden');
        trigger.setAttribute('aria-expanded', 'false');
        return;
    }
    closeAllLanguagePickers();
}

function syncLanguagePickerUIForRoot(rootId) {
    const lang = getSettingsLanguage();
    const other = lang === 'da' ? 'en' : 'da';
    const {
        picker,
        trigger,
        triggerFlag,
        triggerCode,
        currentName,
        currentFlag,
        switchName,
        switchFlag,
        curLabel,
        swLabel,
    } = languagePickerElements(rootId);
    if (!picker) return;

    if (triggerCode) {
        triggerCode.textContent = languageNativeLabel(lang);
    }
    if (triggerFlag) triggerFlag.innerHTML = LANGUAGE_FLAG_SVG[lang] || '';
    if (currentFlag) currentFlag.innerHTML = LANGUAGE_FLAG_SVG[lang] || '';
    if (switchFlag) switchFlag.innerHTML = LANGUAGE_FLAG_SVG[other] || '';

    const curLabelText = languageNativeLabel(lang);
    const othLabelText = languageNativeLabel(other);
    if (currentName) currentName.textContent = curLabelText;
    if (switchName) switchName.textContent = othLabelText;
    if (curLabel) curLabel.textContent = tSettings('languagePickerCurrent');
    if (swLabel) swLabel.textContent = tSettings('languagePickerSwitch');
    if (trigger) trigger.setAttribute('aria-label', tSettings('language'));
}

function syncLanguagePickerUI() {
    for (const rootId of LANGUAGE_PICKER_ROOT_IDS) {
        syncLanguagePickerUIForRoot(rootId);
    }
}

function switchLanguageSetting() {
    const cur = getSettingsLanguage();
    const next = cur === 'da' ? 'en' : 'da';
    if (!state.appData.settings) state.appData.settings = {};
    state.appData.settings.language = next;
    applySettingsLanguage();
    saveData();
    if (!state.isIOS && !state.isAndroid) void refreshBehaviourBannerIfStale({ force: true });
    closeAllLanguagePickers();
}

let languagePickerDocClickBound = false;

function setupLanguagePickerForRoot(rootId) {
    const { picker, trigger, dropdown, switchBtn } = languagePickerElements(rootId);
    if (!picker || !trigger || !dropdown || !switchBtn) return;
    if (picker.dataset.bound === '1') return;
    picker.dataset.bound = '1';

    trigger.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const isOpen = trigger.getAttribute('aria-expanded') === 'true';
        setLanguagePickerOpen(!isOpen, rootId);
    });

    dropdown.addEventListener('click', (e) => e.stopPropagation());

    switchBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        switchLanguageSetting();
    });
}

export function setupLanguagePicker() {
    for (const rootId of LANGUAGE_PICKER_ROOT_IDS) {
        setupLanguagePickerForRoot(rootId);
    }

    if (!languagePickerDocClickBound) {
        languagePickerDocClickBound = true;
        document.addEventListener('click', () => {
            closeAllLanguagePickers();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (isAnyLanguagePickerOpen()) closeAllLanguagePickers();
        });
    }
}

/** Confirmation modals — describe typing challenge count + time estimate */
export function formatConfirmModalOverrideTypingLine({ type, count, estimatedMinutes, resumeShortGibberish = false }) {
    const minutes = estimatedMinutes;
    const charUnitDa = 'tegn';
    const charUnitEn = count === 1 ? 'character' : 'characters';
    const charUnit = getSettingsLanguage() === 'da' ? charUnitDa : charUnitEn;
    const wordUnitDa = count === 1 ? 'ord' : 'ord';
    const wordUnitEn = count === 1 ? 'word' : 'words';
    const wordUnit = getSettingsLanguage() === 'da' ? wordUnitDa : wordUnitEn;

    if (type === 'custom') {
        return tSettingsFmt('confirmOverrideCustomPhraseFmt', { count, minutes });
    }
    if (type === 'gibberish') {
        if (usesMobileWordCountForOverrideType(type)) {
            return tSettingsFmt('confirmOverrideGibberishWordsFmt', { count, wordUnit, minutes });
        }
        if (resumeShortGibberish) {
            return tSettingsFmt('confirmOverrideGibberishShortFmt', { count, minutes });
        }
        return tSettingsFmt('confirmOverrideGibberishLettersFmt', { count, charUnit, minutes });
    }
    return usesMobileWordCountForOverrideType(type)
        ? tSettingsFmt('confirmOverrideRandomWordsIosFmt', { count, wordUnit, minutes })
        : tSettingsFmt('confirmOverrideRandomWordsFmt', { count, charUnit, minutes });
}

/** Static copy on the migration / extension-setup overlay — call when language changes. */
export function applyMigrationOverlayStaticCopy() {
    invalidateMigrationMacCopyCache();
    const setHtml = (id, html) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = html;
    };
    const setText = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    };
    setText('migration-pre-title', tSettings('migrationPreWelcomeTitle'));
    setText('migration-pre-subtitle', tSettings('migrationPreSubtitle'));
    setHtml('migration-pre-explainer', tSettings('migrationPreExplainerHtml'));
    setText('migration-pre-bullet-1', tSettings('migrationPreBulletHelper'));
    setHtml('migration-pre-bullet-2', tSettings('migrationPreBulletHostsHtml'));
    setText('migration-pre-bullet-3', tSettings('migrationPreBulletBlocklists'));
    setHtml('migration-pre-warn', tSettings('migrationPreWarnHtml'));
    setText('migration-checklist-cleaned-label', tSettings('migrationChecklistCleanedOld'));
    setText('migration-checklist-blocks-label', tSettings('migrationChecklistBlocklistsPreserved'));
    syncMigrationPostHeader(state.lastMigrationBrowserState);
    setHtml('migration-checklist-ext-lines', migrationExtLinesHtml(state.lastMigrationBrowserState));
    setText('migration-howto-title', tSettings('migrationHowtoHeading'));
    if (state.isMacOSDesktop) {
        syncMigrationMacHowto(state.lastMigrationBrowserState);
    } else {
        setHtml('migration-howto-li1', tSettings('migrationHowtoLi1Html'));
        document.getElementById('migration-howto-li2')?.classList.add('hidden');
        document.getElementById('migration-howto-li3')?.classList.remove('hidden');
        setHtml('migration-howto-li3', tSettings('migrationHowtoLi3Html'));
    }
    setText('migration-done-btn', tSettings('migrationDone'));
    setText('migration-skip-btn', tSettings('migrationSkip'));
    setText('migration-back-btn', tSettings('eulaBackBtn'));
    syncMigrationPostBackButtonVisibility();
    setText('enforcement-toggle-headline-text', tSettings('migrationEnforcementHeadline'));
    void applyEnforcementDescCopy(state.lastMigrationBrowserState);
    setText('enforcement-toggle-disable-note-text', tSettings('migrationEnforcementDisableNote'));
    void updateAllEnforcementToggleLocks();
    setText('settings-enforcement-heading', tSettings('settingsEnforcementHeading'));
    const continueBtn = document.getElementById('migration-continue-btn');
    if (continueBtn && !continueBtn.disabled) {
        continueBtn.textContent = tSettings('migrationContinue');
    }
    setText('migration-post-title', tSettings('migrationPostTitleCleanup'));
    setText('migration-post-subtitle', tSettings('migrationPostSubtitleCleanup'));
}

/** First-run EULA screen — localized from current UI language / saved preference / browser locale (da). */
export function applyEulaOnboardingLanguage() {
    const title = tSettings('welcomeOnboardingTitle');

    const shieldLogo = document.getElementById('eula-onboarding-shield-logo');
    if (shieldLogo) {
        shieldLogo.src = logoReddShieldUrl;
        shieldLogo.alt = '';
    }

    const heading = document.getElementById('eula-welcome-title');
    if (heading) heading.textContent = title;

    const headingIos = document.getElementById('eula-welcome-title-ios');
    if (headingIos) headingIos.textContent = title;

    const subtitle = document.getElementById('eula-onboarding-subtitle');
    if (subtitle) subtitle.textContent = tSettings('welcomeOnboardingSubtitle');

    const subtitleIos = document.getElementById('eula-onboarding-subtitle-ios');
    if (subtitleIos) subtitleIos.textContent = tSettings('welcomeOnboardingSubtitle');

    const appIcon = document.getElementById('eula-onboarding-app-icon');
    if (appIcon) appIcon.setAttribute('alt', tSettings('eulaWelcomeIconAlt'));

    const agreeInner = document.getElementById('eula-agree-line-inner');
    if (agreeInner) agreeInner.innerHTML = tSettings('eulaAgreeLineHtml');

    const note = document.getElementById('eula-note');
    if (note) note.innerHTML = tSettings('eulaNoteHtml');

    const blurb = document.getElementById('eula-project-blurb');
    if (blurb) blurb.innerHTML = tSettings('eulaProjectBlurb');

    const footer1 = document.getElementById('eula-onboarding-footer-1');
    if (footer1) footer1.innerHTML = tSettings('welcomeFooter1Html');

    const footer2 = document.getElementById('eula-onboarding-footer-2');
    if (footer2) footer2.innerHTML = tSettings('welcomeFooter2Html');

    const cb = document.getElementById('eula-agree-checkbox');
    if (cb) cb.setAttribute('aria-label', tSettings('eulaAgreeAria'));

    const continueBtn = document.getElementById('eula-continue-btn');
    if (continueBtn) continueBtn.textContent = tSettings('eulaContinueBtn');

    const backBtn = document.getElementById('eula-back-btn');
    if (backBtn) {
        backBtn.textContent = tSettings('eulaBackBtn');
        backBtn.classList.toggle('hidden', state.isIOS);
    }
}

/** Welcome onboarding screen — localized in the same way as the EULA screen. */
export function applyWelcomeOnboardingLanguage() {
    const shieldLogo = document.getElementById('welcome-onboarding-shield-logo');
    if (shieldLogo) {
        shieldLogo.src = logoReddShieldUrl;
        shieldLogo.alt = '';
    }

    const heading = document.getElementById('welcome-onboarding-title');
    if (heading) heading.textContent = tSettings('welcomeOnboardingTitle');

    const subtitle = document.getElementById('welcome-onboarding-subtitle');
    if (subtitle) subtitle.textContent = tSettings('welcomeOnboardingSubtitle');

    const howHeading = document.getElementById('welcome-how-heading');
    if (howHeading) howHeading.textContent = tSettings('welcomeHowHeading');

    const focusLogoHtml =
        `<img src="${logoReddFocusUrl}" alt="" class="welcome-reddfocus-inline-logo" aria-hidden="true"> `;
    const appleLogoHtml =
        `<img src="${appleLogoUrl}" alt="" class="welcome-apple-inline-logo" aria-hidden="true"> `;

    const stepMac = document.getElementById('welcome-step-mac');
    const stepFirefox = document.getElementById('welcome-step-firefox');

    const step1Title = document.getElementById('welcome-step-1-title');
    const step1Body = document.getElementById('welcome-step-1-body');
    const step2Title = document.getElementById('welcome-step-2-title');
    const step2Body = document.getElementById('welcome-step-2-body');

    if (state.isMacOSDesktop) {
        stepMac?.classList.remove('hidden');
        stepFirefox?.classList.toggle('hidden', !welcomeFirefoxInstalled);

        if (step1Title) {
            step1Title.innerHTML = tSettings('welcomeStep1TitleAutomationHtml').replace('{APPLE}', appleLogoHtml);
        }
        if (step1Body) step1Body.innerHTML = tSettings('welcomeStep1BodyAutomationHtml');

        if (welcomeFirefoxInstalled) {
            if (step2Title) {
                step2Title.innerHTML = tSettings('welcomeStep2TitleFirefoxHtml')
                    .replace('{APPLE}', appleLogoHtml)
                    .replace('{LOGO}', focusLogoHtml);
            }
            if (step2Body) {
                step2Body.innerHTML = tSettings('welcomeStep2BodyFirefoxHtml');
            }
        }
    } else {
        stepMac?.classList.add('hidden');
        stepFirefox?.classList.remove('hidden');

        let step2TitleKey = 'welcomeStep2TitleHtml';
        let step2BodyKey = 'welcomeStep2BodyHtml';
        if (state.isAndroid) {
            step2TitleKey = 'welcomeStep2TitleAndroidHtml';
            step2BodyKey = 'welcomeStep2BodyAndroidHtml';
        } else if (state.isIOS) {
            step2TitleKey = 'welcomeStep2TitleIosHtml';
            step2BodyKey = 'welcomeStep2BodyIosHtml';
        }

        if (step2Title) step2Title.innerHTML = tSettings(step2TitleKey);
        if (step2Body) {
            step2Body.innerHTML = tSettings(step2BodyKey).replace('{LOGO}', focusLogoHtml);
        }
    }

    const step3Title = document.getElementById('welcome-step-3-title');
    if (step3Title) step3Title.textContent = tSettings('welcomeStep3TitleHtml');
    const step3Body = document.getElementById('welcome-step-3-body');
    if (step3Body) step3Body.innerHTML = tSettings('welcomeStep3BodyHtml');

    document.querySelectorAll('#welcome-onboarding .welcome-step:not(.hidden) .welcome-step-num').forEach((num, i) => {
        num.textContent = String(i + 1);
    });

    const demoToggleLabel = document.getElementById('welcome-demo-toggle-label');
    if (demoToggleLabel) demoToggleLabel.textContent = tSettings('welcomeDemoToggleLabel');

    const demoCaption = document.getElementById('welcome-demo-video-caption');
    if (demoCaption) demoCaption.textContent = tSettings('welcomeDemoVideoCaption');

    const demoPlayBtn = document.getElementById('welcome-demo-play-btn');
    syncWelcomeDemoPlayLabel();

    const closeLabel = document.getElementById('welcome-demo-close-label');
    if (closeLabel) closeLabel.textContent = tSettings('welcomeDemoCloseLabel');
    const closeBtn = document.getElementById('welcome-demo-close-btn');
    if (closeBtn) closeBtn.setAttribute('aria-label', tSettings('welcomeDemoCloseLabel'));

    syncWelcomeDemoFullscreenLabel();

    const demoVideo = document.getElementById('welcome-demo-video');
    if (demoVideo && !demoVideo.src) {
        demoVideo.src = welcomeDemoVideoUrl;
    }

    const continueBtn = document.getElementById('welcome-onboarding-continue-btn');
    if (continueBtn) continueBtn.textContent = tSettings('welcomeOnboardingContinueBtn');

    const footer1 = document.getElementById('welcome-onboarding-footer-1');
    if (footer1) footer1.innerHTML = tSettings('welcomeFooter1Html');

    const footer2 = document.getElementById('welcome-onboarding-footer-2');
    if (footer2) footer2.innerHTML = tSettings('welcomeFooter2Html');
}

function isWelcomeDemoVideoExpanded() {
    return document.getElementById('welcome-demo-video-wrap')?.classList.contains('welcome-demo-video-wrap--expanded') ?? false;
}

function setWelcomeDemoVideoExpanded(expanded) {
    const wrap = document.getElementById('welcome-demo-video-wrap');
    const fullscreenBtn = document.getElementById('welcome-demo-fullscreen-btn');
    const closeBtn = document.getElementById('welcome-demo-close-btn');
    if (!wrap) return;
    wrap.classList.toggle('welcome-demo-video-wrap--expanded', expanded);
    fullscreenBtn?.toggleAttribute('hidden', expanded);
    closeBtn?.toggleAttribute('hidden', !expanded);
    syncWelcomeDemoFullscreenLabel();
}

function syncWelcomeDemoFullscreenLabel() {
    const fullscreenBtn = document.getElementById('welcome-demo-fullscreen-btn');
    if (!fullscreenBtn) return;
    fullscreenBtn.setAttribute(
        'aria-label',
        tSettings(isWelcomeDemoVideoExpanded() ? 'welcomeDemoFullscreenExitAriaLabel' : 'welcomeDemoFullscreenEnterAriaLabel'),
    );
}

function syncWelcomeDemoPlayLabel() {
    const playBtn = document.getElementById('welcome-demo-play-btn');
    const video = document.getElementById('welcome-demo-video');
    if (!playBtn || !video) return;
    const labelKey = video.paused
        ? (video.currentTime > 0 ? 'welcomeDemoResumeAriaLabel' : 'welcomeDemoPlayAriaLabel')
        : 'welcomeDemoPauseAriaLabel';
    playBtn.setAttribute('aria-label', tSettings(labelKey));
}

function syncWelcomeDemoVideoCaption() {
    const caption = document.getElementById('welcome-demo-video-caption');
    const video = document.getElementById('welcome-demo-video');
    if (!caption || !video) return;
    caption.classList.toggle('hidden', !video.paused);
}

function toggleWelcomeDemoPlayback(video) {
    if (video.paused) {
        video.play().catch(() => {});
    } else {
        video.pause();
    }
}

export function resetWelcomeDemoPanel() {
    const toggle = document.getElementById('welcome-demo-toggle');
    const panel = document.getElementById('welcome-demo-panel');
    const video = document.getElementById('welcome-demo-video');
    const playBtn = document.getElementById('welcome-demo-play-btn');
    setWelcomeDemoVideoExpanded(false);
    if (toggle) {
        toggle.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
    }
    if (panel) panel.classList.add('hidden');
    if (video) {
        video.pause();
        video.currentTime = 0;
    }
    if (playBtn) playBtn.classList.remove('hidden');
    syncWelcomeDemoVideoCaption();
}

function initWelcomeDemoControls() {
    // Skip on Android: the welcome demo video is a large mp4 served
    // through Tauri's custom-protocol asset handler, which doesn't
    // support the HTTP Range requests Android WebView's <video> element
    // needs — it 404/fails to load there even though it works fine in
    // WKWebView on iOS. Hide the whole toggle/panel rather than show a
    // permanently-broken video player.
    if (state.isAndroid) {
        document.getElementById('welcome-demo-toggle')?.classList.add('hidden');
        document.getElementById('welcome-demo-panel')?.classList.add('hidden');
        return;
    }

    const toggle = document.getElementById('welcome-demo-toggle');
    const panel = document.getElementById('welcome-demo-panel');
    const videoWrap = document.getElementById('welcome-demo-video-wrap');
    const video = document.getElementById('welcome-demo-video');
    const playBtn = document.getElementById('welcome-demo-play-btn');
    const fullscreenBtn = document.getElementById('welcome-demo-fullscreen-btn');
    const closeBtn = document.getElementById('welcome-demo-close-btn');
    if (!toggle || !panel || !video || !playBtn) return;

    toggle.addEventListener('click', () => {
        const isOpen = toggle.classList.toggle('open');
        toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        panel.classList.toggle('hidden', !isOpen);
        if (!isOpen) {
            setWelcomeDemoVideoExpanded(false);
            video.pause();
            video.currentTime = 0;
            playBtn.classList.remove('hidden');
        }
    });

    playBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleWelcomeDemoPlayback(video);
    });

    fullscreenBtn?.addEventListener('click', (event) => {
        event.stopPropagation();
        setWelcomeDemoVideoExpanded(true);
    });

    closeBtn?.addEventListener('click', (event) => {
        event.stopPropagation();
        setWelcomeDemoVideoExpanded(false);
    });

    let demoClickTimer = null;
    video.addEventListener('click', () => {
        if (demoClickTimer) clearTimeout(demoClickTimer);
        demoClickTimer = setTimeout(() => {
            demoClickTimer = null;
            toggleWelcomeDemoPlayback(video);
        }, 220);
    });

    video.addEventListener('dblclick', (event) => {
        event.preventDefault();
        if (demoClickTimer) {
            clearTimeout(demoClickTimer);
            demoClickTimer = null;
        }
        if (isWelcomeDemoVideoExpanded()) {
            setWelcomeDemoVideoExpanded(false);
        } else {
            setWelcomeDemoVideoExpanded(true);
        }
    });

    window.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && isWelcomeDemoVideoExpanded()) {
            event.preventDefault();
            setWelcomeDemoVideoExpanded(false);
        }
    }, true);

    videoWrap?.addEventListener('click', (event) => {
        if (!isWelcomeDemoVideoExpanded() || event.target !== videoWrap) return;
        setWelcomeDemoVideoExpanded(false);
    });

    video.addEventListener('play', () => {
        playBtn.classList.add('hidden');
        syncWelcomeDemoPlayLabel();
        syncWelcomeDemoVideoCaption();
    });
    video.addEventListener('pause', () => {
        if (video.currentTime < video.duration) playBtn.classList.remove('hidden');
        syncWelcomeDemoPlayLabel();
        syncWelcomeDemoVideoCaption();
    });
    video.addEventListener('ended', () => {
        playBtn.classList.remove('hidden');
        video.currentTime = 0;
        syncWelcomeDemoPlayLabel();
        syncWelcomeDemoVideoCaption();
    });
}

function formatCurrentVersionText(version) {
    return `${tSettings('yourVersionPrefix')} ${version || 'Unknown'}`;
}

function formatLatestVersionText(version) {
    return `${tSettings('latestVersionPrefix')} ${version || 'Unknown'}`;
}

export function applyFormattedCurrentVersion(el, version) {
    if (!el) return;
    el.dataset.appVersion = version || 'Unknown';
    el.textContent = formatCurrentVersionText(el.dataset.appVersion);
}

export function applyFormattedLatestVersion(el, version) {
    if (!el) return;
    el.dataset.appVersion = version;
    el.textContent = formatLatestVersionText(version);
}

function refreshSettingsVersionLabels() {
    const currentVersionEl = document.getElementById('current-app-version');
    if (currentVersionEl?.dataset.appVersion) {
        currentVersionEl.textContent = formatCurrentVersionText(currentVersionEl.dataset.appVersion);
    }
    const latestVersionEl = document.getElementById('latest-app-version');
    if (latestVersionEl?.dataset.appVersion) {
        latestVersionEl.textContent = formatLatestVersionText(latestVersionEl.dataset.appVersion);
    }
}

export function applySettingsLanguage() {
    const setText = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    };
    const setHtml = (id, html) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = html;
    };

    // Main shell / scheduler
    setText('update-banner-prefix', tSettings('updateBannerPrefix'));
    setText('update-banner-suffix', tSettings('updateBannerSuffix'));
    if (!updateDownloadInProgress) {
        setText('update-banner-link', tSettings('updateBannerCta'));
    }
    const updateWhatsNewBtn = document.getElementById('update-banner-whats-new');
    if (updateWhatsNewBtn && !updateWhatsNewBtn.classList.contains('hidden')) {
        updateWhatsNewBtn.innerHTML = updateBannerWhatsNewButtonHtml();
    }
    setText(
        'setup-banner-headline',
        tSettings(state.isMacOSDesktop ? 'setupBrowsersBannerHeadlineMac' : 'setupBrowsersBannerHeadline'),
    );
    syncSetupBannerHeadline();
    setText('behaviour-change-help', tSettings('setupBrowsersBannerCta'));
    const behaviourDismissBtn = document.getElementById('behaviour-change-dismiss');
    if (behaviourDismissBtn) {
        behaviourDismissBtn.title = tSettings('setupBrowsersBannerDismissTitle');
    }
    setText('main-start-block-title', tSettings('mainStartBlockTitle'));
    setText('instant-mode-tab-label', tSettings('modeTimer'));
    setText('schedule-mode-tab-label', tSettings('modeSchedule'));
    setText('selection-prompt-label', tSettings('selectionPrompt'));
    const blocklistSelect = document.getElementById('blocklist-select');
    if (blocklistSelect && blocklistSelect.options.length > 0) {
        blocklistSelect.options[0].textContent = tSettings('selectionPromptOption');
    }
    setText('main-blocklists-title', tSettings('yourBlocklists'));
    setText('main-schedule-title', tSettings('scheduleTitle'));
    setText('no-active-blocks-label', tSettings('noActiveBlocks'));
    setText('always-on-row-label-lead', tSettings('alwaysOnRowLead'));
    setText(
        'always-on-row-label-hint',
        ` (${tSettings('alwaysOnRowTimelineHint')}):`
    );
    setText('now-blocking-label-text', tSettings('nowBlockingLabel'));
    setText('schedule-footer-hint', tSettings('scheduleFooterHint'));
    setText('duration-quick-btn-15', tSettings('durationQuick15m'));
    setText('duration-quick-btn-30', tSettings('durationQuick30m'));
    setText('duration-quick-btn-45', tSettings('durationQuick45m'));
    setText('duration-quick-btn-60', tSettings('durationQuick1Hour'));
    setText('duration-quick-btn-120', tSettings('durationQuick2Hours'));
    setText('duration-quick-btn-always-label', tSettings('durationQuickAlways'));
    setText('always-on-message-text', tSettings('alwaysOnMessage'));
    setText('duration-label', tSettings('duration'));
    setText('duration-unit-label', tSettings('durationUnitMin'));
    setText('end-label', tSettings('end'));
    setText('quick-select-label', tSettings('quickSelect'));
    setText('schedule-start-label', tSettings('start'));
    setText('schedule-end-label', tSettings('end'));
    setText('schedule-days-label', tSettings('days'));
    setText('add-segment-label', tSettings('add'));
    setText('schedule-segments-heading', tSettings('scheduleWhenHeading'));
    setText('repeat-label', tSettings('repeat'));
    setText('schedule-panel-overlay-label', tSettings('scheduleActiveOverlayLabel'));
    const repeatNo = document.querySelector('.repeat-option[data-value="no"]');
    const repeatForever = document.querySelector('.repeat-option[data-value="forever"]');
    const repeatDate = document.querySelector('.repeat-option[data-value="date"]');
    if (repeatNo) repeatNo.textContent = tSettings('repeatNo');
    if (repeatForever) repeatForever.textContent = tSettings('repeatForever');
    if (repeatDate) repeatDate.textContent = tSettings('repeatUntilDate');
    const repeatDropdownText = document.getElementById('repeat-dropdown-text');
    if (repeatDropdownText) {
        if (state.scheduleRepeatType === 'forever') repeatDropdownText.textContent = tSettings('repeatForever');
        else if (state.scheduleRepeatType === 'date') repeatDropdownText.textContent = tSettings('repeatUntilDate');
        else repeatDropdownText.textContent = tSettings('repeatNo');
    }
    setText('pause-btn-label', tSettings('pause'));
    setBtnActionLabel(document.getElementById('start-block-btn-label'), tSettings('startBlockButton'), { simple: true });
    const startBlockBtn = document.getElementById('start-block-btn');
    if (startBlockBtn) {
        setStartBlockBtnLeadingIcon(
            startBlockBtn,
            startBlockBtn.classList.contains('stop-block') ? 'stop' : 'enter',
        );
    }
    setBtnActionLabel(document.getElementById('start-schedule-btn-label'), tSettings('startScheduleButton'));
    const startScheduleBtn = document.getElementById('start-schedule-btn');
    if (startScheduleBtn) {
        setStartBlockBtnLeadingIcon(
            startScheduleBtn,
            startScheduleBtn.classList.contains('stop-schedule') ? 'stop' : 'enter',
        );
    }
    setText('footer-made-with', tSettings('madeWith'));
    setText('footer-by', tSettings('by'));
    const setPlaceholder = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.placeholder = text;
    };
    setPlaceholder('blocklist-name', tSettings('placeholderNameExample'));
    syncModalAppPlaceholder();
    syncModalWebsitePlaceholder();
    setPlaceholder('challenge-input', tSettings('typeHere'));
    setPlaceholder('pause-challenge-input', tSettings('typeHere'));
    setPlaceholder('override-all-challenge-input', tSettings('typeHere'));
    setText('website-input-error', tSettings('invalidDomainMsg'));

    // Blocklist modal
    const modalTitle = document.getElementById('modal-title');
    if (modalTitle) {
        modalTitle.textContent = state.editingBlocklistId ? tSettings('editBlocklist') : tSettings('createBlocklist');
    }
    setText('active-blocklist-warning-text', tSettings('activeBlocklistWarning'));
    setText('blocklist-name-label', tSettings('name'));
    setText('blocklist-mode-label', tSettings('blocklistModeLabel'));
    setText('blocklist-mode-blocklist-label', tSettings('blocklistModeBlocklist'));
    setText('blocklist-mode-allowlist-label', tSettings('blocklistModeAllowlist'));
    updateBlocklistModalModeLabels(getSelectedBlocklistModalMode());
    setText('override-difficulty-label', tSettings('overrideDifficulty'));
    setText('override-method-label', tSettings('overrideMethod'));
    setText('override-option-random-words', tSettings('overrideRandomWords'));
    setText('override-option-gibberish', tSettings('overrideGibberish'));
    setText('override-option-custom', tSettings('overrideCustomText'));
    setText('override-max-difficulty-label', tSettings('overrideMaxDifficulty'));
    setText('override-preview-label', tSettings('overridePreviewLooksLike'));
    const overrideType = document.getElementById('override-type')?.value || 'random-words';
    syncOverrideCountUi(overrideType);
    updateOverridePreview();
    setText('blocklist-emoji-label', tSettings('emoji'));
    setText('blocklist-color-label', tSettings('color'));
    setText('blocklist-advanced-options-label', tSettings('advancedOptions'));
    setText('show-item-details-label', tSettings('listBlockedOnCard'));
    setText('websites-import-menu-text-file-label', tSettings('importWebsitesFromFile'));
    setText('websites-import-menu-section-label', tSettings('importWebsitesPreMadeList'));
    setText('websites-import-menu-email', tSettings('importPresetEmail'));
    setText('websites-import-menu-gambling', tSettings('importPresetGambling'));
    setText('websites-import-menu-news', tSettings('importPresetNews'));
    setText('websites-import-menu-porn', tSettings('importPresetPorn'));
    setText('websites-import-menu-search-engines', tSettings('importPresetSearchEngines'));
    setText('websites-import-menu-shopping', tSettings('importPresetShopping'));
    setText('websites-import-menu-social-media', tSettings('importPresetSocialMedia'));
    const importWebsitesBtn = document.getElementById('modal-import-websites-btn');
    if (importWebsitesBtn) {
        importWebsitesBtn.title = tSettings('importWebsitesTitle');
        importWebsitesBtn.setAttribute('aria-label', tSettings('importWebsitesTitle'));
    }
    setText('modal-import-websites-caption', tSettings('modalPremadeListsCaption'));
    setText('modal-browse-apps-caption', tSettings('modalBrowseAppsCaption'));
    const modalBrowseAppsBtn = document.getElementById('modal-browse-apps-btn');
    if (modalBrowseAppsBtn) {
        const browseTitle = document.body.classList.contains('ios')
            ? tSettings('modalBrowseAppsTitleIos')
            : tSettings('browseApplicationsTitle');
        modalBrowseAppsBtn.title = browseTitle;
        modalBrowseAppsBtn.setAttribute('aria-label', browseTitle);
    }
    setText('cancel-blocklist-btn', tSettings('cancel'));
    setText('save-blocklist-btn', tSettings('save'));

    // Modal copy
    setText('override-modal-title', tSettings('stopFocusSpaceTitle'));
    setText('override-confirm-blocking-label', tSettings('startConfirmBlockingLabel'));
    setText('override-confirm-show-all-blocking', tSettings('showAll'));
    setText('override-modal-instruction', tSettings('overrideInstruction'));
    setText('cancel-override-btn', tSettings('cancel'));
    setStartConfirmPrimaryLabel('confirm-override-btn', tSettings('stopBlock'));
    setText('pause-modal-title', tSettings('pauseFocusSpaceTitle'));
    setText('pause-confirm-blocking-label', tSettings('startConfirmBlockingLabel'));
    setText('pause-confirm-show-all-blocking', tSettings('showAll'));
    setText('pause-modal-instruction', tSettings('pauseInstruction'));
    setText('pause-for-label', tSettings('pauseFor'));
    setText('pause-restarts-at-label', tSettings('restartsAt'));
    setText('cancel-pause-btn', tSettings('cancel'));
    setStartConfirmPrimaryLabel('confirm-pause-btn', tSettings('pauseBlock'));
    setText('start-block-confirm-title', tSettings('startThisBlock'));
    setText('start-confirm-blocking-label', tSettings('startConfirmBlockingLabel'));
    setText('start-confirm-duration-label', tSettings('startConfirmDurationLabel'));
    setText('start-confirm-show-all-blocking', tSettings('showAll'));
    setText('confirm-override-header', tSettings('startBlockHoldHeader'));
    setText('cancel-start-confirm-btn', tSettings('cancel'));
    setStartConfirmPrimaryLabel('proceed-start-confirm-btn', tSettings('startBlock'));
    setText('start-schedule-confirm-title', tSettings('startThisSchedule'));
    setText('schedule-confirm-blocking-label', tSettings('startConfirmBlockingLabel'));
    setText('schedule-confirm-show-all-blocking', tSettings('showAll'));
    setText('schedule-confirm-times-label', tSettings('startConfirmTimesLabel'));
    setText('schedule-confirm-repeat-label', tSettings('startConfirmRepeatsLabel'));
    setText('schedule-confirm-overlay-label', tSettings('scheduleConfirmOverlayLabel'));
    const confirmOverlayCustomiseBtn = document.getElementById('schedule-confirm-overlay-customise-btn');
    if (confirmOverlayCustomiseBtn) {
        confirmOverlayCustomiseBtn.title = tSettings('scheduleOverlayCustomiseBtn');
        confirmOverlayCustomiseBtn.setAttribute('aria-label', tSettings('scheduleOverlayCustomiseBtn'));
    }
    const panelOverlayCustomiseBtn = document.getElementById('schedule-panel-overlay-customise-btn');
    if (panelOverlayCustomiseBtn) {
        panelOverlayCustomiseBtn.title = tSettings('scheduleOverlayCustomiseBtn');
        panelOverlayCustomiseBtn.setAttribute('aria-label', tSettings('scheduleOverlayCustomiseBtn'));
    }
    const overlayDescEl = document.getElementById('schedule-confirm-overlay-desc');
    if (overlayDescEl && !overlayDescEl.textContent) {
        overlayDescEl.textContent = tSettings('scheduleConfirmOverlayDefaultDesc');
    }
    syncScheduleOverlayCustomiseTitle();
    setText('schedule-overlay-select-label', tSettings('scheduleOverlaySelectLabel'));
    setText('schedule-overlay-select-unsaved-badge', tSettings('scheduleOverlayUnsavedBadge'));
    setText('schedule-overlay-add-new-btn', tSettings('scheduleOverlayAddNewBtn'));
    setText('schedule-overlay-delete-btn', tSettings('scheduleOverlayDeleteBtn'));
    setText('schedule-overlay-delete-title', tSettings('scheduleOverlayDeleteConfirmTitle'));
    setText('cancel-schedule-overlay-delete-btn', tSettings('cancel'));
    setText('confirm-schedule-overlay-delete-btn', tSettings('scheduleOverlayDeleteBtn'));
    setText('schedule-overlay-discard-title', tSettings('scheduleOverlayDiscardConfirmTitle'));
    setText('cancel-schedule-overlay-discard-btn', tSettings('scheduleOverlayKeepEditingBtn'));
    setText('confirm-schedule-overlay-discard-btn', tSettings('scheduleOverlayDiscardConfirmBtn'));
    if (isScheduleOverlayCustomiseModalOpen() && state.scheduleOverlayCustomiseSelection) {
        populateScheduleOverlayCustomiseSelector(state.scheduleOverlayCustomiseSelection);
        syncScheduleOverlayCustomiseEditorState(state.scheduleOverlayCustomiseSelection);
        syncScheduleOverlayCustomiseTitle(state.scheduleOverlayCustomiseSelection);
        syncScheduleOverlayCustomiseDirtyState();
        const noticeEl = document.getElementById('schedule-overlay-default-notice');
        if (noticeEl && state.scheduleOverlayCustomiseSelection === SCHEDULE_OVERLAY_DEFAULT_PRESET_VALUE) {
            noticeEl.textContent = tSettings('scheduleOverlayDefaultNotice');
        }
    }
    setText('schedule-overlay-name-label', tSettings('scheduleOverlayNameLabel'));
    const overlayNameInput = document.getElementById('schedule-overlay-name-input');
    if (overlayNameInput) overlayNameInput.placeholder = tSettings('scheduleOverlayNamePlaceholder');
    setText('schedule-overlay-heading-label', tSettings('scheduleOverlayHeadingLabel'));
    setText('schedule-overlay-heading-placeholders-note', tSettings('scheduleOverlayHeadingPlaceholdersHint'));
    const overlayHeadingInput = document.getElementById('schedule-overlay-heading-input');
    if (overlayHeadingInput) overlayHeadingInput.placeholder = tSettings('scheduleOverlayHeadingPlaceholder');
    setText('schedule-overlay-message-label', tSettings('scheduleOverlayMessageLabel'));
    setText('schedule-overlay-message-placeholders-note', tSettings('scheduleOverlayMessagePlaceholdersHint'));
    setText('schedule-overlay-lets-go-label', tSettings('scheduleOverlayLetsGoFieldLabel'));
    setText('schedule-overlay-image-label', tSettings('scheduleOverlayImageLabel'));
    setText('schedule-overlay-image-drop-hint', tSettings('scheduleOverlayImageDropHint'));
    setText('schedule-overlay-voice-label', tSettings('scheduleOverlayVoiceLabel'));
    setText('schedule-overlay-voice-help', tSettings('scheduleOverlayVoiceHelp'));
    setText('schedule-overlay-choose-image-btn', tSettings('scheduleOverlayChooseImage'));
    setText('schedule-overlay-record-voice-btn-label', tSettings('scheduleOverlayRecordVoice'));
    setText('schedule-overlay-stop-record-voice-btn-label', tSettings('scheduleOverlayStopRecording'));
    setText('schedule-overlay-choose-voice-btn', tSettings('scheduleOverlayChooseAudio'));
    setText('schedule-overlay-preview-label', tSettings('scheduleOverlayPreviewLabel'));
    setText('schedule-overlay-customise-cancel-btn', tSettings('cancel'));
    setText('schedule-overlay-customise-save-btn', tSettings('scheduleOverlaySaveBtn'));
    setText('schedule-overlay-reset-heading-btn', tSettings('scheduleOverlaySectionReset'));
    setText('schedule-overlay-reset-message-btn', tSettings('scheduleOverlaySectionReset'));
    setText('schedule-overlay-reset-button-btn', tSettings('scheduleOverlaySectionReset'));
    setText('schedule-overlay-reset-image-btn', tSettings('scheduleOverlaySectionReset'));
    setText('schedule-overlay-reset-voice-btn', tSettings('scheduleOverlaySectionReset'));
    setText('schedule-confirm-override-header', tSettings('startScheduleHoldHeader'));
    setText('cancel-schedule-confirm-btn', tSettings('cancel'));
    setStartConfirmPrimaryLabel('proceed-schedule-confirm-btn', tSettings('startSchedule'));
    setText('undo-toast-btn', tSettings('undo'));
    const undoToastMsg = document.getElementById('undo-toast-message');
    if (undoToastMsg && pendingDelete?.blocklist) {
        undoToastMsg.textContent = tSettingsFmt('deleteUndoToastFmt', { name: pendingDelete.blocklist.name });
    }
    setText('override-all-title', tSettings('overrideAllTitle'));
    setText('override-all-warning-strong', tSettings('overrideAllWarningStrong'));
    setText('override-all-warning-body', tSettings('overrideAllWarningBody'));
    setText('override-all-instruction', tSettings('overrideAllInstruction'));
    setText('cancel-override-all-btn', tSettings('cancel'));
    setText('confirm-override-all-btn', tSettings('overrideAll'));
    setText('next-day-indicator', `+1 ${tSettings('nextDay')}`);
    setText('pause-next-day-indicator', `+1 ${tSettings('nextDay')}`);

    setText('settings-modal-title', tSettings('settingsTitle'));
    setText('settings-general-heading', tSettings('settingsGeneralHeading'));
    setText('settings-manage-heading', tSettings('settingsManageHeading'));
    setText('settings-theme-label', tSettings('lightDarkMode'));
    setText('settings-zoom-label', tSettings('zoomLevel'));
    setText('settings-language-label', tSettings('language'));
    syncLanguagePickerUI();
    setText('theme-option-system', tSettings('themeAuto'));
    setText('theme-option-light', tSettings('themeLight'));
    setText('theme-option-dark', tSettings('themeDark'));
    setText('settings-override-all-label', tSettings('settingsOverrideAllLabel'));
    setText('settings-override-all-hint', tSettings('settingsOverrideAllHint'));
    setText('settings-override-all-btn-label', tSettings('settingsOverrideAllBtn'));
    setText('settings-uninstall-label', tSettings('uninstallApp'));
    setText('settings-uninstall-hint', tSettings('settingsUninstallHint'));
    setText('settings-uninstall-btn-label', tSettings('uninstallAppBtn'));
    setText('settings-windows-uninstall-label', tSettings('uninstallApp'));
    setText('settings-windows-uninstall-hint', tSettings('windowsUninstallHint'));
    setText('settings-windows-uninstall-btn-label', tSettings('windowsUninstallOpenSettingsBtn'));
    setText('settings-help-label', tSettings('settingsDiagnosticsLabel'));
    setText('settings-enforcement-heading', tSettings('settingsEnforcementHeading'));
    setText('settings-blocking-method-toggle-label', tSettings('settingsBlockingMethodHeading'));
    setText('settings-blocking-method-hint', tSettings('settingsBlockingMethodHint'));
    setText('settings-blocking-method-chrome-label', tSettings('settingsBlockingMethodChrome'));
    setText('settings-blocking-method-brave-label', tSettings('settingsBlockingMethodBrave'));
    setText('settings-blocking-method-edge-label', tSettings('settingsBlockingMethodEdge'));
    setText('settings-blocking-method-safari-label', tSettings('settingsBlockingMethodSafari'));
    syncBlockingMethodLabelIcons();
    for (const key of MAC_BLOCKING_METHOD_KEYS) {
        const select = document.getElementById(`blocking-method-${key}`);
        if (!select) continue;
        const current = select.value || browserBlockingMethod(key);
        select.innerHTML = '';
        for (const [value, labelKey] of [
            ['automation', 'settingsBlockingMethodAutomation'],
            ['extension', 'settingsBlockingMethodExtension'],
        ]) {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = tSettings(labelKey);
            if (value === current) opt.selected = true;
            select.appendChild(opt);
        }
    }
    setText('settings-enforcement-row-label', tSettings('settingsEnforcementRowLabel'));
    void applyEnforcementDescCopy(state.lastMigrationBrowserState);
    setText('settings-setup-btn-label', tSettings('settingsSetupBtn'));
    setText('settings-diagnostics-btn-label', tSettings('settingsDiagnosticsBtn'));
    setText('diagnostics-modal-title', tSettings('diagnosticsModalTitle'));
    setText('diagnostics-refresh-btn-label', tSettings('diagnosticsRefresh'));
    setText('diagnostics-copy-btn-label', tSettings('diagnosticsCopyReport'));
    setText('close-diagnostics-btn', tSettings('close'));
    setText('settings-onboarding-btn-label', tSettings('settingsOnboardingBtn'));
    setText('settings-blocklists-io-label', tSettings('settingsBlocklistsIoLabel'));
    setText('settings-blocklists-io-hint', tSettings('settingsBlocklistsIoHint'));
    setText('settings-export-blocklists-btn-label', tSettings('settingsExportBlocklistsBtn'));
    setText('settings-import-blocklists-btn-label', tSettings('settingsImportBlocklistsBtn'));
    setText('uninstall-confirm-title', tSettings('uninstallConfirmTitle'));
    setText('uninstall-delete-data-label', tSettings('uninstallDeleteDataLabel'));
    syncUninstallConfirmModal(null);
    setText('cancel-uninstall-confirm-btn', tSettings('cancel'));
    setText('confirm-uninstall-confirm-btn', tSettings('uninstallConfirmOk'));
    applyMacAutomationIntroCopy();
    // The hint paragraph and button tooltip need re-translation too —
    // refreshUninstallButtonState reads from tSettings() and rewrites
    // both. Cheap to call unconditionally.
    refreshUninstallButtonState();
    updateOverrideAllButtonVisibility();
    void updateAllEnforcementToggleLocks();
    setText('settings-helper-service-label', tSettings('helperService'));
    setText('settings-update-helper-label', tSettings('updateHelper'));
    setText('settings-clean-hosts-label', tSettings('cleanHostsFile'));
    setText('settings-helper-hint', tSettings('helperHint'));
    setText('close-settings-btn', tSettings('settingsDone'));
    setText('grace-period-label-text', tSettings('gracePeriodLabel'));
    setText('grace-period-hint-text', tSettings('gracePeriodHint'));
    setText('app-blocking-lets-go-btn-label', tSettings('appBlockingLetsGo'));
    setText('app-blocking-snooze-btn-label', tSettings('appBlockingSnoozeBtn'));
    setHtml('settings-feedback-footer-text', tSettings('settingsFeedbackFooterHtml'));
    updateGraceSettingLock();
    refreshSettingsVersionLabels();

    const helperStatusText = document.getElementById('settings-helper-status-text');
    if (helperStatusText) {
        const raw = (helperStatusText.textContent || '').trim();
        const statusMap = {
            'Checking...': tSettings('helperStatusChecking'),
            'Active': tSettings('helperStatusActive'),
            'Idle': tSettings('helperStatusIdle'),
            'Installed, not reachable': tSettings('helperStatusInstalledNotReachable'),
            'Update available': tSettings('helperStatusUpdateAvailable'),
            'Not installed': tSettings('helperStatusNotInstalled'),
            'Unknown': tSettings('helperStatusUnknown'),
            'Tjekker...': tSettings('helperStatusChecking'),
            'Aktiv': tSettings('helperStatusActive'),
            'Inaktiv': tSettings('helperStatusIdle'),
            'Installeret, men ikke tilgaengelig': tSettings('helperStatusInstalledNotReachable'),
            'Installeret, men ikke tilgængelig': tSettings('helperStatusInstalledNotReachable'),
            'Opdatering tilgaengelig': tSettings('helperStatusUpdateAvailable'),
            'Opdatering tilgængelig': tSettings('helperStatusUpdateAvailable'),
            'Ikke installeret': tSettings('helperStatusNotInstalled'),
            'Ukendt': tSettings('helperStatusUnknown'),
        };
        if (statusMap[raw]) helperStatusText.textContent = statusMap[raw];
    }

    applyMigrationOverlayStaticCopy();
    applyEulaOnboardingLanguage();
    applyWelcomeOnboardingLanguage();
    applySafariFdaOnboardingLanguage();
    setText('ios-screentime-onboarding-title', tSettings('welcomeOnboardingTitle'));
    setText('ios-screentime-onboarding-note', tSettings('eulaProjectBlurb'));

    if (state.migrationOnboardingActive && state.lastMigrationBrowserState) {
        renderBrowserInstallButtons(state.lastMigrationBrowserState, { force: true });
    }

    // Re-render pieces with dynamic language-dependent text.
    renderAppBlockingWarningOverlay();
    renderAppBlockingClosedownBanner();
    renderBlocklists();
    if (document.getElementById('blocklist-select')) renderBlocklistSelector();
    if (typeof updateScheduleButtonState === 'function') updateScheduleButtonState();
    if (typeof syncSelectedControlState === 'function') syncSelectedControlState();
    if (typeof updateWeekCalendar === 'function') updateWeekCalendar();
    if (typeof rebuildScheduleSegments === 'function') rebuildScheduleSegments();
    renderNowBlockingRow();
    if (typeof updateOverridePreview === 'function') updateOverridePreview();
}
