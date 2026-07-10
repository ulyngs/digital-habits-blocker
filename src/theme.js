// Theme (light/dark), UI zoom, and responsive layout tiers.
// Extracted verbatim from app.js.
import { state } from './state.js';
import { tauriAPI } from './tauri-api.js';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { resolveMicrosoftStorePackage, isVersionHigher, getLatestVersionPlatformKey } from './update-banner.js';
import { updateOverrideAllButtonVisibility, refreshUninstallButtonState } from './settings.js';
import { stopHelperUiRefreshLoop } from './modal-manager.js';
import { saveData } from './persistence.js';
import { syncAllStopBtnLabelFits, syncPauseDurationRowLayout } from './confirm-modals.js';
import { wireEnforcementToggle, wireBlockingMethodSettings, resetSettingsEnforcementSection } from './enforcement.js';
import { applyEnforcementDescCopy } from './onboarding.js';
import {
    setLanguagePickerOpen,
    applySettingsLanguage,
    applyFormattedCurrentVersion,
    syncMobileScheduleDayLabelsViewportMode,
    setupLanguagePicker,
    applyFormattedLatestVersion,
} from './app.js';

export const UI_ZOOM_MIN = 0.8;
export const UI_ZOOM_MAX = 1.8;
export const UI_ZOOM_MAX_DESKTOP = 1.5;  // cap on macOS/Windows (native webview zoom)
export const UI_ZOOM_MAX_IOS = 1.4;  // cap on iOS (CSS zoom on phone; transform scale on iPad)
/** Layout breakpoints — CSS `zoom` does not affect @media / @container; tiers use effective width. */
export const UI_ZOOM_LAYOUT_STACK_MAX = 768;
export const UI_ZOOM_LAYOUT_CRAMPED_MAX = 1024;
export const UI_ZOOM_LAYOUT_NARROW_MAX = 800;
export const SCHED_TABS_ICON_ONLY_EXIT_WIDTH_DELTA = 8;
let uiZoomLayoutRaf = 0;
let selectionPromptLayoutRaf = 0;
let uiZoomLayoutObserverBound = false;
let schedTabsIconOnlyEnteredAtWidth = 0;
export const UI_ZOOM_STEP = 0.1;
export const DEFAULT_UI_ZOOM = 1.0;
let zoomToastHideTimeout = null;
let nativeWebviewZoomSupported = null;

export function setupTheme() {
    // Apply initial theme from saved settings
    applyTheme();

    // Setup settings modal
    const settingsTriggers = ['settings-btn', 'settings-btn-stack']
        .map((id) => document.getElementById(id))
        .filter(Boolean);
    const settingsModal = document.getElementById('settings-modal');
    const closeSettingsBtn = document.getElementById('close-settings-btn');
    const themeSelect = document.getElementById('theme-select');

    // Apply language immediately on startup.
    applySettingsLanguage();
    setupLanguagePicker();

    if (settingsTriggers.length && settingsModal) {
        settingsTriggers.forEach((settingsBtn) => {
            settingsBtn.addEventListener('click', () => {
            const latestVersionEl = document.getElementById('latest-app-version');
            const latestVersionWrap = document.getElementById('settings-latest-version-wrap');
            if (latestVersionEl) latestVersionEl.style.display = 'none';
            if (latestVersionWrap) latestVersionWrap.style.display = 'none';
            settingsModal.classList.remove('hidden');
            syncFooterZoomControl(getActiveUiZoomScale());
            resetSettingsEnforcementSection();
            void applyEnforcementDescCopy(state.lastMigrationBrowserState);
            // Re-evaluate the in-app Uninstall button (Mac only): a
            // schedule could have fired since the modal was last open,
            // flipping the disabled state. Cheap; idempotent.
            refreshUninstallButtonState();
            updateOverrideAllButtonVisibility();
            void wireEnforcementToggle();
            void wireBlockingMethodSettings();
            // Set current theme selection
            if (themeSelect) {
                const currentTheme = state.appData.settings?.themeMode || 'system';
                themeSelect.value = currentTheme;
            }
            void (async () => {
                applySettingsLanguage();

                // Fetch and display version info
                const currentVersionEl = document.getElementById('current-app-version');
                let currentVersion = null;

                if (currentVersionEl) {
                    try {
                        currentVersion = await tauriAPI.getAppVersion();
                        applyFormattedCurrentVersion(currentVersionEl, currentVersion || 'Unknown');
                    } catch (e) {
                        console.error('[Version] Error fetching current version:', e);
                        applyFormattedCurrentVersion(currentVersionEl, 'Unknown');
                    }
                }

                if (latestVersionEl) {
                    latestVersionEl.style.display = 'none';
                    if (latestVersionWrap) latestVersionWrap.style.display = 'none';

                    if (!(await resolveMicrosoftStorePackage())) {
                        try {
                            const response = await fetch(`https://ulyngs.github.io/redd-block/latest-versions.json?t=${Date.now()}`);
                            const versions = await response.json();
                            const latestVersion = versions[getLatestVersionPlatformKey()];

                            if (latestVersion && currentVersion && isVersionHigher(latestVersion, currentVersion)) {
                                applyFormattedLatestVersion(latestVersionEl, latestVersion);
                                latestVersionEl.style.display = 'block';
                                if (latestVersionWrap) latestVersionWrap.style.display = 'block';
                            }
                        } catch (e) {
                            console.log('[Version] Could not check for updates (offline or error):', e.message);
                        }
                    }
                }
            })();
            });
        });
    }

    if (closeSettingsBtn && settingsModal) {
        closeSettingsBtn.addEventListener('click', () => {
            setLanguagePickerOpen(false);
            settingsModal.classList.add('hidden');
            stopHelperUiRefreshLoop();
        });
    }

    // Close modal when clicking outside
    if (settingsModal) {
        settingsModal.addEventListener('click', (e) => {
            if (e.target === settingsModal) {
                setLanguagePickerOpen(false);
                settingsModal.classList.add('hidden');
                stopHelperUiRefreshLoop();
            }
        });
    }

    // Theme selection change
    if (themeSelect) {
        themeSelect.addEventListener('change', (e) => {
            if (!state.appData.settings) state.appData.settings = {};
            state.appData.settings.themeMode = e.target.value;

            // Update legacy darkMode for backwards compatibility
            if (e.target.value === 'dark') {
                state.appData.settings.darkMode = true;
            } else if (e.target.value === 'light') {
                state.appData.settings.darkMode = false;
            } else {
                // Auto/system mode - use system preference
                delete state.appData.settings.darkMode;
            }

            applyTheme();
            saveData();
        });
    }

    // Listen for system theme changes when in auto mode
    if (window.matchMedia) {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
            if (state.appData.settings?.themeMode === 'system' || !state.appData.settings?.themeMode) {
                applyTheme();
            }
        });
    }
}

export function applyTheme() {
    const body = document.body;
    const themeMode = state.appData.settings?.themeMode || 'system';

    let isDark;
    if (themeMode === 'dark') {
        isDark = true;
    } else if (themeMode === 'light') {
        isDark = false;
    } else {
        // Auto/system mode - detect system preference
        isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    if (isDark) {
        body.classList.add('dark-mode');
    } else {
        body.classList.remove('dark-mode');
    }
}

export function getUiZoomMax() {
    if (state.isIOS) return UI_ZOOM_MAX_IOS;
    const isDesktop = document.body.classList.contains('windows') || document.body.classList.contains('mac');
    return isDesktop ? UI_ZOOM_MAX_DESKTOP : UI_ZOOM_MAX;
}

export function clampUiZoom(scale) {
    return Math.min(getUiZoomMax(), Math.max(UI_ZOOM_MIN, scale));
}

export function getDefaultUiZoom() {
    return DEFAULT_UI_ZOOM;
}

export function getSavedUiZoom() {
    const parsed = Number(state.appData.settings?.uiZoom);
    if (!Number.isFinite(parsed)) return getDefaultUiZoom();
    return clampUiZoom(parsed);
}

export function isIosTablet() {
    return state.isIOS && !document.body.classList.contains('ios-phone');
}

/** Desktop only — iPad uses transform scaling; phones use CSS zoom. */
export function usesNativeWebviewZoom() {
    if (!state.isIOS && (document.body.classList.contains('windows') || document.body.classList.contains('mac'))) {
        return nativeWebviewZoomSupported !== false;
    }
    return false;
}

export function getActiveUiZoomScale() {
    const inline = parseFloat(document.documentElement.style.zoom);
    if (Number.isFinite(inline) && inline > 0) return inline;
    const cssVar = parseFloat(document.documentElement.style.getPropertyValue('--ui-zoom'));
    if (Number.isFinite(cssVar) && cssVar > 0) return cssVar;
    return getSavedUiZoom();
}

export function getEffectiveViewportWidth() {
    const zoom = getActiveUiZoomScale();
    const viewportWidth = window.visualViewport?.width
        || window.innerWidth
        || document.documentElement?.clientWidth
        || 0;
    return viewportWidth > 0 ? viewportWidth / zoom : viewportWidth;
}

/** Mirror responsive layout tiers when UI zoom is above 100% (zoom ignores @media queries). iOS only. */
export function syncUiZoomResponsiveLayout() {
    const zoom = getActiveUiZoomScale();
    document.documentElement.style.setProperty('--ui-zoom', String(zoom));

    if (state.isIOS) {
        const effVp = getEffectiveViewportWidth();
        const ipadPortraitStack = state.isIOS
            && usesStackSettingsPlacement()
            && !document.body.classList.contains('ios-phone');
        const cramped = effVp > UI_ZOOM_LAYOUT_STACK_MAX
            && effVp <= UI_ZOOM_LAYOUT_CRAMPED_MAX
            && !ipadPortraitStack;

        document.body.classList.toggle('ui-zoom-tier-stack', effVp > 0 && effVp <= UI_ZOOM_LAYOUT_STACK_MAX);
        document.body.classList.toggle('ui-zoom-tier-cramped', cramped);
        document.body.classList.toggle('ui-zoom-tier-narrow', effVp > 0 && effVp <= UI_ZOOM_LAYOUT_NARROW_MAX);
        document.body.classList.toggle('settings-placement-stack', usesStackSettingsPlacement());
    } else {
        document.body.classList.remove('settings-placement-stack');
        document.body.classList.remove(
            'ui-zoom-tier-stack',
            'ui-zoom-tier-cramped',
            'ui-zoom-tier-narrow',
        );
    }

    syncSchedulerModeTabLabelMode();
    syncMobileScheduleDayLabelsViewportMode();
    syncAllStopBtnLabelFits();
    scheduleSelectionPromptLayout();
    const pauseModal = document.getElementById('pause-modal');
    if (pauseModal && !pauseModal.classList.contains('hidden')) {
        syncPauseDurationRowLayout();
    }
}

export function usesStackSettingsPlacement() {
    if (window.matchMedia('(max-width: 768px)').matches) return true;
    return document.body.classList.contains('ios')
        && !document.body.classList.contains('ios-phone')
        && window.matchMedia('(min-width: 769px) and (max-width: 1024px) and (orientation: portrait)').matches;
}

/** True when labelled Now/Schedule tabs do not fit in the scheduler header row. */
export function schedulerModeTabsNeedIconOnly(header, modeTabs, toolbar) {
    const toolbarVisible = toolbar && getComputedStyle(toolbar).display !== 'none';
    if (toolbarVisible) {
        const tabsRect = modeTabs.getBoundingClientRect();
        const toolbarRect = toolbar.getBoundingClientRect();
        if (tabsRect.right > toolbarRect.left - 6) {
            return true;
        }
    }
    if (header.scrollWidth > header.clientWidth + 1) {
        return true;
    }
    if (modeTabs.scrollWidth > modeTabs.clientWidth + 1) {
        return true;
    }
    for (const tab of modeTabs.querySelectorAll('.mode-tab')) {
        if (tab.scrollWidth > tab.clientWidth + 1) {
            return true;
        }
    }
    return false;
}

/** Keep desktop/iOS scheduler header chrome from overlapping as space tightens. */
export function syncSchedulerModeTabLabelMode() {
    const enterHeader = document.getElementById('scheduler-enter-header');
    const timePicker = document.getElementById('time-picker-container');
    const modeTabs = enterHeader?.querySelector('.scheduler-mode-tabs');
    const body = document.body;
    if (!enterHeader || !modeTabs || !timePicker || timePicker.classList.contains('hidden')) {
        body.classList.remove('ui-zoom-sched-hide-title', 'ui-zoom-sched-tabs-icons');
        schedTabsIconOnlyEnteredAtWidth = 0;
        return;
    }

    const hadIconOnly = body.classList.contains('ui-zoom-sched-tabs-icons');
    const headerWidth = enterHeader.clientWidth;

    // If icon-only was the last stable state, only retry full labels after the
    // row actually gets wider. Otherwise the ResizeObserver can bounce forever
    // between the two near-identical layouts right at the threshold.
    if (hadIconOnly) {
        if (!schedTabsIconOnlyEnteredAtWidth) {
            schedTabsIconOnlyEnteredAtWidth = headerWidth;
            return;
        }
        if (headerWidth <= schedTabsIconOnlyEnteredAtWidth + SCHED_TABS_ICON_ONLY_EXIT_WIDTH_DELTA) {
            return;
        }
    }

    body.classList.remove('ui-zoom-sched-hide-title', 'ui-zoom-sched-tabs-icons');
    void enterHeader.offsetWidth;

    const mainTitle = document.getElementById('main-start-block-title');
    const toolbar = document.querySelector('#settings-toolbar-scheduler');
    const iconOnly = schedulerModeTabsNeedIconOnly(enterHeader, modeTabs, toolbar);

    if (!state.isIOS && mainTitle && iconOnly) {
        body.classList.add('ui-zoom-sched-hide-title');
        void enterHeader.offsetWidth;
    }

    body.classList.toggle('ui-zoom-sched-tabs-icons', iconOnly && state.isIOS);
    schedTabsIconOnlyEnteredAtWidth = iconOnly && state.isIOS ? enterHeader.clientWidth : 0;
}

export function scheduleSelectionPromptLayout() {
    cancelAnimationFrame(selectionPromptLayoutRaf);
    selectionPromptLayoutRaf = requestAnimationFrame(() => {
        selectionPromptLayoutRaf = 0;
        syncSelectionPromptLayout();
    });
}

export function isGridTopRowStacked() {
    const blocklists = document.getElementById('blocklists-section');
    const scheduler = document.getElementById('scheduler-section');
    if (!blocklists || !scheduler) return true;
    const blocklistsRect = blocklists.getBoundingClientRect();
    const schedulerRect = scheduler.getBoundingClientRect();
    return schedulerRect.top > blocklistsRect.top + 16;
}

export function clearSelectionPromptLayout() {
    const prompt = document.getElementById('selection-prompt');
    const gridTopRow = document.querySelector('.grid-top-row');
    const schedulerSection = document.getElementById('scheduler-section');
    if (prompt) {
        prompt.style.top = '';
        prompt.style.left = '';
        prompt.style.right = '';
    }
    if (schedulerSection) {
        schedulerSection.style.removeProperty('--time-picker-placeholder-height');
    }
    if (gridTopRow) gridTopRow.classList.remove('grid-top-row--selection-prompt-active');
    document.body.classList.remove('selection-prompt-layout-two-col', 'selection-prompt-layout-stack');
}

export function measureTimePickerPlaceholderHeight(section) {
    const mainContent = document.getElementById('main-content');
    const timePicker = section?.querySelector('#time-picker-container');
    if (!section || !mainContent || !timePicker || section.clientWidth <= 0) return 0;

    let measurer = document.getElementById('scheduler-placeholder-measurer');
    if (!measurer) {
        measurer = document.createElement('div');
        measurer.id = 'scheduler-placeholder-measurer';
        measurer.setAttribute('aria-hidden', 'true');
        measurer.style.cssText = 'position:absolute;left:-10000px;top:0;visibility:hidden;pointer-events:none;box-sizing:border-box;';
        mainContent.appendChild(measurer);
    }

    measurer.className = 'scheduler-content';
    measurer.style.width = `${section.clientWidth}px`;
    measurer.innerHTML = timePicker.outerHTML;

    const measuredPicker = measurer.querySelector('#time-picker-container');
    measuredPicker?.classList.remove('hidden');
    measuredPicker?.querySelector('#instant-block-panel')?.classList.remove('hidden');
    measuredPicker?.querySelector('#schedule-block-panel')?.classList.add('hidden');
    measuredPicker?.querySelector('.always-on-message')?.classList.add('hidden');
    measuredPicker?.querySelector('#timed-controls')?.classList.add('hidden');
    measuredPicker?.querySelector('#block-action-buttons')?.classList.add('hidden');

    return measuredPicker?.offsetHeight || 0;
}

/** Pin the empty-state hint to the first blocklist card (two-column) or reserve time-picker space (stack). */
export function syncSelectionPromptLayout() {
    const prompt = document.getElementById('selection-prompt');
    const gridTopRow = document.querySelector('.grid-top-row');
    const schedulerSection = document.getElementById('scheduler-section');
    const firstCard = document.querySelector('#blocklists-container .blocklist-card');
    if (!prompt || !gridTopRow) return;

    const active = !prompt.classList.contains('hidden')
        && !gridTopRow.classList.contains('grid-top-row--blocklist-selected')
        && !!firstCard;

    if (!active) {
        clearSelectionPromptLayout();
        return;
    }

    const gap = 48;
    const stacked = isGridTopRowStacked();
    const anchorRect = gridTopRow.getBoundingClientRect();
    const cardRect = firstCard.getBoundingClientRect();
    const promptHeight = prompt.offsetHeight || 24;

    gridTopRow.classList.add('grid-top-row--selection-prompt-active');
    document.body.classList.toggle('selection-prompt-layout-two-col', !stacked);
    document.body.classList.toggle('selection-prompt-layout-stack', stacked);

    if (stacked) {
        prompt.style.top = '';
        prompt.style.left = '';
        prompt.style.right = '';
        if (schedulerSection) {
            const placeholderHeight = measureTimePickerPlaceholderHeight(schedulerSection);
            if (placeholderHeight > 0) {
                schedulerSection.style.setProperty('--time-picker-placeholder-height', `${placeholderHeight}px`);
            }
        }
        return;
    }

    if (schedulerSection) {
        schedulerSection.style.removeProperty('--time-picker-placeholder-height');
    }

    const top = cardRect.top - anchorRect.top + (cardRect.height - promptHeight) / 2;
    const left = cardRect.right - anchorRect.left + gap;
    prompt.style.top = `${Math.round(top)}px`;
    prompt.style.left = `${Math.round(left)}px`;
    prompt.style.right = '';
}

export function scheduleUiZoomResponsiveLayout() {
    cancelAnimationFrame(uiZoomLayoutRaf);
    uiZoomLayoutRaf = requestAnimationFrame(() => {
        uiZoomLayoutRaf = 0;
        syncUiZoomResponsiveLayout();
    });
}

export function bindUiZoomLayoutObserver() {
    if (uiZoomLayoutObserverBound || typeof ResizeObserver === 'undefined') return;
    const targets = [
        document.getElementById('main-content'),
        document.querySelector('.grid-top-row'),
        document.getElementById('scheduler-enter-header'),
        document.getElementById('scheduler-section'),
        document.getElementById('blocklists-container'),
        document.getElementById('selection-prompt'),
        document.querySelector('.week-calendar-section'),
        document.getElementById('day-rows'),
        document.querySelector('.footer'),
    ].filter(Boolean);
    if (!targets.length) return;
    uiZoomLayoutObserverBound = true;
    const ro = new ResizeObserver(() => {
        scheduleUiZoomResponsiveLayout();
        scheduleSelectionPromptLayout();
    });
    targets.forEach((el) => ro.observe(el));
}

export function applyUiZoom(scale) {
    const clamped = clampUiZoom(scale);
    syncFooterZoomControl(clamped);
    document.documentElement.style.setProperty('--ui-zoom', String(clamped));

    if (usesNativeWebviewZoom()) {
        getCurrentWebview().setZoom(clamped).then(() => {
            nativeWebviewZoomSupported = true;
            document.documentElement.style.zoom = '';
            scheduleUiZoomResponsiveLayout();
        }).catch(() => {
            nativeWebviewZoomSupported = false;
            document.documentElement.style.zoom = String(clamped);
            scheduleUiZoomResponsiveLayout();
        });
        return;
    }

    // iPad WKWebView uses desktop content mode: neither CSS zoom nor pageZoom scales text.
    // `.app-container { transform: scale(var(--ui-zoom)) }` in styles.css handles iPad instead.
    if (isIosTablet()) {
        document.documentElement.style.zoom = '';
        scheduleUiZoomResponsiveLayout();
        return;
    }

    if (state.isIOS) {
        document.documentElement.style.zoom = String(clamped);
        scheduleUiZoomResponsiveLayout();
        return;
    }

    // Fallback when native webview zoom is unavailable (e.g. permission).
    document.documentElement.style.zoom = String(clamped);
    scheduleUiZoomResponsiveLayout();
}

/** Mirror the current zoom level into the settings control and +/- button state. */
export function syncFooterZoomControl(scale) {
    const pct = `${Math.round(scale * 100)}%`;
    const max = getUiZoomMax();
    document.querySelectorAll('.zoom-value').forEach((el) => {
        el.textContent = pct;
    });
    document.querySelectorAll('.zoom-out-btn').forEach((btn) => {
        btn.disabled = scale <= UI_ZOOM_MIN + 1e-6;
    });
    document.querySelectorAll('.zoom-in-btn').forEach((btn) => {
        btn.disabled = scale >= max - 1e-6;
    });
}

export function setupFooterZoomControl() {
    const control = document.getElementById('settings-zoom-control');
    if (!control || control.dataset.bound === '1') return;
    control.dataset.bound = '1';
    control.querySelector('.zoom-out-btn')?.addEventListener('click', () => zoomUiOut());
    control.querySelector('.zoom-in-btn')?.addEventListener('click', () => zoomUiIn());
}

export function showUiZoomToast(scale) {
    const toast = document.getElementById('zoom-toast');
    const message = document.getElementById('zoom-toast-message');
    if (!toast || !message) return;

    message.textContent = `Zoom ${Math.round(scale * 100)}%`;
    toast.classList.remove('hidden');

    if (zoomToastHideTimeout) {
        clearTimeout(zoomToastHideTimeout);
    }
    zoomToastHideTimeout = setTimeout(() => {
        toast.classList.add('hidden');
        zoomToastHideTimeout = null;
    }, 1400);
}

export function setUiZoom(scale, options = {}) {
    const clamped = clampUiZoom(scale);
    applyUiZoom(clamped);
    if (options.showToast) {
        showUiZoomToast(clamped);
    }

    if (!state.appData.settings) state.appData.settings = {};
    if (state.appData.settings.uiZoom === clamped) return;

    state.appData.settings.uiZoom = clamped;
    saveData();
}

export function zoomUiIn(options = {}) {
    const current = getSavedUiZoom();
    setUiZoom(Math.round((current + UI_ZOOM_STEP) * 100) / 100, options);
}

export function zoomUiOut(options = {}) {
    const current = getSavedUiZoom();
    setUiZoom(Math.round((current - UI_ZOOM_STEP) * 100) / 100, options);
}

export function resetUiZoom(options = {}) {
    setUiZoom(getDefaultUiZoom(), options);
}

export function setupUiZoomShortcuts() {
    setupFooterZoomControl();

    // One-time zoom reset on Android. Early Android builds inherited the
    // desktop default zoom (1.2) and PERSISTED it into settings.uiZoom, so
    // just changing the default doesn't heal existing installs. CSS zoom
    // above 1.0 on Android WebView shrinks the effective viewport (~327px
    // on a 393dp phone → horizontal overflow) and triggers paint bugs
    // (duplicated/offset text). Reset once; the user can still zoom
    // manually afterwards and that choice sticks.
    if (state.isAndroid && state.appData.settings?.uiZoom !== undefined && !state.appData.settings.androidZoomReset) {
        state.appData.settings.uiZoom = DEFAULT_UI_ZOOM;
        state.appData.settings.androidZoomReset = true;
        saveData();
    }

    applyUiZoom(getSavedUiZoom());
    bindUiZoomLayoutObserver();
    window.addEventListener('resize', scheduleUiZoomResponsiveLayout, { passive: true });
    window.visualViewport?.addEventListener('resize', scheduleUiZoomResponsiveLayout, { passive: true });

    if (state.isIOS) return;

    tauriAPI.onMenuZoomIn(() => zoomUiIn({ showToast: true })).catch(() => { });
    tauriAPI.onMenuZoomOut(() => zoomUiOut({ showToast: true })).catch(() => { });
    tauriAPI.onMenuZoomReset(() => resetUiZoom({ showToast: true })).catch(() => { });

    document.addEventListener('keydown', (e) => {
        const hasAccel = e.metaKey || e.ctrlKey;
        if (!hasAccel || e.altKey) return;

        const key = e.key;
        const isZoomIn = key === '+' || key === '=' || key === 'Add';
        const isZoomOut = key === '-' || key === '_' || key === 'Subtract';
        const isZoomReset = key === '0' || key === ')';
        if (!isZoomIn && !isZoomOut && !isZoomReset) return;

        e.preventDefault();

        if (isZoomIn) {
            zoomUiIn({ showToast: true });
            return;
        }
        if (isZoomOut) {
            zoomUiOut({ showToast: true });
            return;
        }
        resetUiZoom({ showToast: true });
    });
}
