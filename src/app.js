// Tauri API imports - proper ES modules from @tauri-apps/api
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ask, message } from '@tauri-apps/plugin-dialog';

// Compatibility layer wrapping Tauri APIs
const tauriAPI = {
    // Core data operations
    loadData: () => invoke('load_data'),
    saveData: (data) => invoke('save_data', { data }),
    getAppVersion: () => invoke('get_app_version'),

    // Window operations
    setWindowSize: (width, height) => invoke('set_window_size', { width, height }),
    minimizeWindow: () => getCurrentWindow().minimize(),
    maximizeWindow: async () => {
        const win = getCurrentWindow();
        if (await win.isMaximized()) {
            return win.unmaximize();
        }
        return win.maximize();
    },
    closeWindow: () => getCurrentWindow().hide(),

    // Helper daemon operations
    checkHelperStatus: () => invoke('check_helper_status').catch(() => ({ installed: false, running: false })),
    checkHelper: async () => {
        const status = await invoke('check_helper_status').catch(() => ({ installed: false, running: false }));
        return status.running === true;
    },
    installHelper: () => invoke('install_helper'),
    uninstallHelper: () => invoke('uninstall_helper'),
    startBlockViaHelper: (data) => invoke('start_block_via_helper', { ...data }),
    // Tauri maps Rust snake_case params to camelCase in JS; use blocklistId not blocklist_id
    clearBlockViaHelper: (blocklistId) => invoke('clear_block_via_helper', blocklistId != null ? { blocklistId } : {}),
    cleanHostsFile: () => invoke('clean_hosts_file'),
    getHelperDiagnostics: () => invoke('get_helper_diagnostics'),
    setBlocksViaHelper: (blocks) => invoke('set_blocks_via_helper', { blocks }),

    // App operations
    openAppPicker: () => invoke('open_app_picker'),
    blockWebsites: (domains) => invoke('block_websites', { domains }),

    // App blocking via helper daemon (persistent, survives app close)
    setBlockedAppsViaHelper: (apps) => invoke('set_blocked_apps_via_helper', { apps }),

    // Schedule management via helper daemon (persistent, handles transitions autonomously)
    setSchedulesViaHelper: (schedules) => invoke('set_schedules_via_helper', { schedules }),

    // Screen Time API (iOS only - provided by tauri-plugin-screentime)
    screentimeRequestAuth: () => invoke('plugin:screentime|request_authorization'),
    screentimeCheckAuth: () => invoke('plugin:screentime|check_authorization'),
    screentimeBlockWebsites: (domains) => invoke('plugin:screentime|block_websites', { domains }),
    screentimeUnblockWebsites: () => invoke('plugin:screentime|unblock_websites'),
    screentimeStartBlock: (payload) => invoke('plugin:screentime|screentime_start_block', payload),
    screentimeClearBlock: () => invoke('plugin:screentime|screentime_clear_block'),
    showActivityPicker: (payload = {}) => invoke('plugin:screentime|show_activity_picker', payload),
    setSchedulesPlugin: (schedules) => invoke('plugin:screentime|set_schedules', { schedules }),
    screentimeRegisterOneOffActivity: (activityName, startTimestampMs) =>
        invoke('plugin:screentime|register_one_off_activity', { activityName, startTimestampMs }),
    screentimeSetResumePayload: (payload) =>
        invoke('plugin:screentime|set_resume_payload', payload),
    screentimeSetBlockEndState: (payload) =>
        invoke('plugin:screentime|set_block_end_state', payload),

    // Event listening
    onBlocksUpdated: (callback) => listen('blocks-updated', callback),
    onMenuZoomIn: (callback) => listen('menu-zoom-in', callback),
    onMenuZoomOut: (callback) => listen('menu-zoom-out', callback),
    onMenuZoomReset: (callback) => listen('menu-zoom-reset', callback),
    onMenuHelpReportIssue: (callback) => listen('menu-help-report-issue', callback),
    onMenuHelpContactUs: (callback) => listen('menu-help-contact-us', callback),
    onMenuHelpWhoWeAre: (callback) => listen('menu-help-who-we-are', callback),
};

async function openUrl(url, openWith) {
    return invoke('plugin:opener|open_url', {
        url,
        with: openWith,
    });
}

// State
let appData = {
    blocklists: [],
    activeBlocks: [],
    schedules: [],
    settings: {}
};

// Expose for integration tests (dev mode only)
window.__REDDBLOCK_INTERNALS__ = {
    get appData() { return appData; },
    set appData(val) { appData = val; }
};

let selectedBlocklistId = null;
let editingBlocklistId = null;
let blocklistModalPreviewSnapshot = null;
/** Blocklist modal undo: session-scoped stack and "last" values for recording previous state. */
let blocklistModalUndoStack = [];
let blocklistModalApplyingUndo = false;

function pushModalUndo(type, undoFn) {
    if (blocklistModalApplyingUndo) return;
    blocklistModalUndoStack.push({ type, undo: undoFn });
}

let lastBlocklistNameValue = '';
let lastOverrideCountValue = '';
let lastCustomOverrideTextValue = '';
let lastOverrideTypeValue = '';
let lastOverrideCountValueBeforeMaxDifficulty = 50;
let lastOverrideTypeValueBeforeMaxDifficulty = 'random-words';
/** Reference to the removed Custom Text option so it can be re-added (getElementById returns null after remove()). */
let overrideBlockId = null;
/** Blocklist id to pass to helper when confirming single-block override (set when opening modal). */
let overrideBlocklistIdForHelper = null;
let challengeText = '';
let lastBlockedDomains = new Set(); // Track what's currently blocked to avoid re-prompting
let activatedBlockIds = new Set(); // Track blocks that have already triggered host updates
let helperAvailable = false; // Track if the privileged helper daemon is running
const HELPER_STATUS_CACHE_TTL_MS = 3000;
let lastDesktopHelperStatus = null;
let lastDesktopHelperStatusAt = 0;
let draggedBlocklistId = null; // Track which blocklist is being dragged
let isIOS = false; // Track if running on iOS
let screentimeAuthorized = false; // Track if Screen Time is authorized (iOS)
let startupInitializationPromise = null; // Prevent duplicate post-onboarding startup runs
let startupInitializationComplete = false; // Track whether post-onboarding startup already ran
let pauseBlockId = null; // Track which block is being paused
let pauseChallengeText = ''; // Challenge text for pause modal
let pauseMaxMinutes = null; // Maximum pause duration in minutes (null = unlimited)
let pauseScheduleData = null; // Track schedule-specific pause data { blocklistId, segmentEndTime }
const MIN_OVERRIDE_CHARS = 5;
const DEFAULT_OVERRIDE_COUNT = 10;
const TARGET_MAX_OVERRIDE_MINUTES = 30;
/** When character count >= this, preview text is frozen (no more regeneration) for random words and gibberish. */
const OVERRIDE_PREVIEW_TRUNCATE_AT = 37;
let overridePreviewFrozenByType = { 'random-words': null, 'gibberish': null };
let lastOverridePreviewType = null;
const UI_ZOOM_MIN = 0.8;
const UI_ZOOM_MAX = 1.8;
const UI_ZOOM_MAX_DESKTOP = 1.5;  // cap on macOS/Windows (native webview zoom)
const UI_ZOOM_STEP = 0.1;
const DEFAULT_UI_ZOOM = 1.0;
let zoomToastHideTimeout = null;
let nativeWebviewZoomSupported = null;

// Week calendar state
let currentWeekStart = null; // Date object for Monday of the displayed week

// Schedule mode state
let isScheduleMode = false; // false = instant mode, true = schedule mode
let isAlwaysOnMode = true; // false = timed block, true = always-on (permanent) block
let scheduleSegments = getDefaultScheduleSegments(); // Array of time segments with per-segment days

// Far-future timestamp used for "always on" blocks (year 9999)
const ALWAYS_ON_END_TIME = new Date(9999, 11, 31, 23, 59, 59, 999).getTime();

// Protected app names — ReDD Block must never block itself
const PROTECTED_APP_NAMES = ['redd block', 'redd-block', 'redd-block-helper'];

// Protected domains — blocking these would break networking or the app itself
const PROTECTED_DOMAINS = [
    'localhost', 'localhost.localdomain',
    '127.0.0.1', '0.0.0.0', '::1',
    'broadcasthost', 'local',
    'reddfocus.org', 'www.reddfocus.org',
    'ulyngs.github.io'
];

/**
 * Check if an app name matches a protected app (case-insensitive).
 * Returns true if the app should NOT be added to a blocklist.
 */
function isProtectedApp(name) {
    if (!name) return false;
    const lower = name.trim().toLowerCase();
    return PROTECTED_APP_NAMES.some(p => lower === p);
}

/**
 * Check if a domain is protected (case-insensitive).
 * Returns true if the domain should NOT be added to a blocklist.
 */
function isProtectedDomain(domain) {
    if (!domain) return false;
    const lower = domain.trim().toLowerCase();
    return PROTECTED_DOMAINS.some(p => lower === p);
}

// Helper: detect always-on blocks by flag OR far-future end time
function isBlockAlwaysOn(block) {
    return block.isAlwaysOn === true || block.endTime >= ALWAYS_ON_END_TIME;
}

function isScreenTimeSummaryEntry(appName) {
    return typeof appName === 'string' && appName.includes('selected (Screen Time)');
}

function parseLegacyScreenTimeSummary(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const summaryLabel = entries.join(', ');
    let applicationCount = 0;
    let categoryCount = 0;
    for (const entry of entries) {
        const appMatch = entry.match(/(\d+)\s+app/);
        const categoryMatch = entry.match(/(\d+)\s+categor(?:y|ies)/);
        if (appMatch) applicationCount += Number.parseInt(appMatch[1], 10);
        if (categoryMatch) categoryCount += Number.parseInt(categoryMatch[1], 10);
    }
    return {
        applicationTokens: [],
        categoryTokens: [],
        applicationCount,
        categoryCount,
        summaryLabel,
        requiresReselection: true
    };
}

function normalizeIOSScreenTimeSelection(selection, legacySummaryEntries = []) {
    if (!selection && legacySummaryEntries.length === 0) return null;

    const normalized = {
        applicationTokens: Array.isArray(selection?.applicationTokens) ? [...selection.applicationTokens] : [],
        categoryTokens: Array.isArray(selection?.categoryTokens) ? [...selection.categoryTokens] : [],
        applicationCount: Number.isFinite(selection?.applicationCount) ? selection.applicationCount : null,
        categoryCount: Number.isFinite(selection?.categoryCount) ? selection.categoryCount : null,
        summaryLabel: typeof selection?.summaryLabel === 'string' ? selection.summaryLabel : '',
        requiresReselection: selection?.requiresReselection === true
    };

    if (normalized.applicationCount == null) {
        normalized.applicationCount = normalized.applicationTokens.length;
    }
    if (normalized.categoryCount == null) {
        normalized.categoryCount = normalized.categoryTokens.length;
    }

    if (!selection && legacySummaryEntries.length > 0) {
        return parseLegacyScreenTimeSummary(legacySummaryEntries);
    }

    if (
        !normalized.summaryLabel &&
        (normalized.applicationCount > 0 || normalized.categoryCount > 0) &&
        normalized.applicationTokens.length === 0 &&
        normalized.categoryTokens.length === 0
    ) {
        const legacySelection = parseLegacyScreenTimeSummary(legacySummaryEntries);
        if (legacySelection?.summaryLabel) {
            normalized.summaryLabel = legacySelection.summaryLabel;
        }
        normalized.requiresReselection = true;
    }

    const hasAnySelection =
        normalized.applicationTokens.length > 0 ||
        normalized.categoryTokens.length > 0 ||
        normalized.applicationCount > 0 ||
        normalized.categoryCount > 0 ||
        !!normalized.summaryLabel;

    return hasAnySelection ? normalized : null;
}

function cloneIOSScreenTimeSelection(selection) {
    const normalized = normalizeIOSScreenTimeSelection(selection);
    return normalized ? { ...normalized } : null;
}

function hasUsableIOSScreenTimeSelection(selection) {
    const normalized = normalizeIOSScreenTimeSelection(selection);
    return !!normalized && (
        normalized.applicationTokens.length > 0 ||
        normalized.categoryTokens.length > 0
    );
}

function formatIOSScreenTimeSelectionLabel(selection) {
    const normalized = normalizeIOSScreenTimeSelection(selection);
    if (!normalized) return '';
    if (normalized.summaryLabel) return normalized.summaryLabel;

    const parts = [];
    if (normalized.applicationCount > 0) parts.push(`${normalized.applicationCount} app${normalized.applicationCount > 1 ? 's' : ''}`);
    if (normalized.categoryCount > 0) parts.push(`${normalized.categoryCount} categor${normalized.categoryCount > 1 ? 'ies' : 'y'}`);
    return parts.length > 0 ? `${parts.join(', ')} selected (Screen Time)` : '';
}

function getBlocklistRegularApps(blocklist) {
    if (!Array.isArray(blocklist?.apps)) return [];
    return blocklist.apps.filter(app => typeof app === 'string' && !isScreenTimeSummaryEntry(app));
}

function getBlocklistIOSScreenTimeSelection(blocklist) {
    const legacySummaryEntries = Array.isArray(blocklist?.apps)
        ? blocklist.apps.filter(isScreenTimeSummaryEntry)
        : [];
    return normalizeIOSScreenTimeSelection(blocklist?.iosScreenTimeSelection, legacySummaryEntries);
}

function getBlocklistDisplayApps(blocklist) {
    const apps = [...getBlocklistRegularApps(blocklist)];
    const screenTimeLabel = formatIOSScreenTimeSelectionLabel(getBlocklistIOSScreenTimeSelection(blocklist));
    if (screenTimeLabel) {
        apps.push(screenTimeLabel);
    }
    return apps;
}

function getBlocklistIOSPayload(blocklist) {
    const selection = getBlocklistIOSScreenTimeSelection(blocklist);
    return {
        appTokenData: selection?.applicationTokens || [],
        categoryTokenData: selection?.categoryTokens || []
    };
}

function blocklistNeedsIOSSelectionRefresh(blocklist) {
    const selection = getBlocklistIOSScreenTimeSelection(blocklist);
    return !!selection && selection.requiresReselection === true && !hasUsableIOSScreenTimeSelection(selection);
}

function ensureIOSBlocklistSelectionReady(blocklist, actionLabel) {
    if (!isIOS || !blocklistNeedsIOSSelectionRefresh(blocklist)) {
        return true;
    }

    const blocklistName = blocklist?.name || 'This blocklist';
    alert(`${blocklistName} has an old Screen Time app selection that iOS can no longer enforce reliably. Please edit the blocklist and re-select its apps before ${actionLabel}.`);
    return false;
}

function normalizeBlocklist(blocklist) {
    const normalizedBlocklist = { ...blocklist };
    normalizedBlocklist.apps = getBlocklistRegularApps(blocklist);
    normalizedBlocklist.iosScreenTimeSelection = getBlocklistIOSScreenTimeSelection(blocklist);
    return normalizedBlocklist;
}

function collectActiveIOSManualBlockPayload(now = Date.now()) {
    const allDomains = new Set();
    const appTokenData = new Set();
    const categoryTokenData = new Set();

    for (const block of appData.activeBlocks || []) {
        if (block.startTime > now || block.endTime <= now || block.isPaused) continue;
        const blocklist = appData.blocklists.find(bl => bl.id === block.blocklistId);
        if (!blocklist) continue;

        for (const domain of blocklist.websites || []) {
            if (!isProtectedDomain(domain)) allDomains.add(domain);
        }

        const iosPayload = getBlocklistIOSPayload(blocklist);
        for (const token of iosPayload.appTokenData) appTokenData.add(token);
        for (const token of iosPayload.categoryTokenData) categoryTokenData.add(token);
    }

    return {
        domains: Array.from(allDomains).sort(),
        appTokenData: Array.from(appTokenData),
        categoryTokenData: Array.from(categoryTokenData)
    };
}

function isNonRepeatingSchedule(schedule) {
    return !!schedule && schedule.repeatType !== 'forever' && !(schedule.repeatType === 'date' && schedule.repeatDate);
}

// Resolve concrete one-shot occurrences for non-repeating schedules.
function resolveOneShotSegmentOccurrences(schedule, segment, segmentIndex = 0) {
    if (!isNonRepeatingSchedule(schedule) || !segment) return [];

    const createdAt = new Date(schedule.createdAt || Date.now());
    if (Number.isNaN(createdAt.getTime())) return [];

    const createdDay = createdAt.getDay() === 0 ? 6 : createdAt.getDay() - 1; // Mon=0
    const segmentDays = Array.isArray(segment.days)
        ? segment.days.filter(day => Number.isInteger(day) && day >= 0 && day <= 6)
        : [];

    if (segmentDays.length === 0) return [];

    const occurrences = segmentDays.map(dayIndex => {
        let daysUntil = dayIndex - createdDay;
        if (daysUntil < 0) daysUntil += 7;

        const start = new Date(createdAt);
        start.setDate(start.getDate() + daysUntil);
        start.setHours(segment.startHour, segment.startMinute, 0, 0);

        const end = new Date(start);
        end.setHours(segment.endHour, segment.endMinute, 0, 0);
        if (end <= start) {
            end.setDate(end.getDate() + 1);
        }

        return {
            segmentIndex,
            dayIndex,
            start,
            end
        };
    });

    occurrences.sort((a, b) => {
        const startDiff = a.start.getTime() - b.start.getTime();
        if (startDiff !== 0) return startDiff;
        const endDiff = a.end.getTime() - b.end.getTime();
        if (endDiff !== 0) return endDiff;
        return a.dayIndex - b.dayIndex;
    });

    return occurrences;
}

function resolveOneShotOccurrences(schedule) {
    if (!isNonRepeatingSchedule(schedule) || !Array.isArray(schedule.segments)) return [];

    const occurrences = [];
    schedule.segments.forEach((segment, segmentIndex) => {
        occurrences.push(...resolveOneShotSegmentOccurrences(schedule, segment, segmentIndex));
    });

    occurrences.sort((a, b) => {
        const startDiff = a.start.getTime() - b.start.getTime();
        if (startDiff !== 0) return startDiff;
        const segmentDiff = a.segmentIndex - b.segmentIndex;
        if (segmentDiff !== 0) return segmentDiff;
        return a.dayIndex - b.dayIndex;
    });

    return occurrences;
}

function getIOSScheduleEntryWindow(schedule, seg) {
    const createdAt = new Date(schedule.createdAt || Date.now());

    if (schedule.repeatType === 'forever') {
        return {
            repeats: true,
            activeFromTimestampMs: null,
            activeUntilTimestampMs: null
        };
    }

    if (schedule.repeatType === 'date' && schedule.repeatDate) {
        const endDate = new Date(schedule.repeatDate);
        endDate.setHours(23, 59, 59, 999);
        return {
            repeats: true,
            activeFromTimestampMs: createdAt.getTime(),
            activeUntilTimestampMs: endDate.getTime()
        };
    }

    const occurrences = resolveOneShotSegmentOccurrences(schedule, seg);
    const firstOccurrence = occurrences[0];

    return {
        repeats: false,
        activeFromTimestampMs: firstOccurrence ? firstOccurrence.start.getTime() : null,
        activeUntilTimestampMs: firstOccurrence ? firstOccurrence.end.getTime() : null
    };
}

function getSingleOccurrenceSegmentDates(schedule, segment) {
    const [firstOccurrence] = resolveOneShotSegmentOccurrences(schedule, segment);
    if (!firstOccurrence) return null;

    return {
        start: new Date(firstOccurrence.start),
        end: new Date(firstOccurrence.end)
    };
}

async function syncSchedulesToHelper() {
    if (isIOS) {
        try {
            const flatEntries = [];
            for (const schedule of appData.schedules || []) {
                if (!schedule.segments || schedule.segments.length === 0) continue;
                const blocklist = appData.blocklists.find(bl => bl.id === schedule.blocklistId);
                const domains = blocklist?.websites || [];
                const iosPayload = getBlocklistIOSPayload(blocklist);
                if (isNonRepeatingSchedule(schedule)) {
                    const occurrences = resolveOneShotOccurrences(schedule);
                    occurrences.forEach((occurrence, occurrenceIdx) => {
                        flatEntries.push({
                            id: `${schedule.id}-${occurrence.segmentIndex}-${occurrenceIdx}`,
                            startHour: occurrence.start.getHours(),
                            startMinute: occurrence.start.getMinutes(),
                            endHour: occurrence.end.getHours(),
                            endMinute: occurrence.end.getMinutes(),
                            days: [],
                            domains,
                            appTokenData: iosPayload.appTokenData,
                            categoryTokenData: iosPayload.categoryTokenData,
                            repeats: false,
                            activeFromTimestampMs: occurrence.start.getTime(),
                            activeUntilTimestampMs: occurrence.end.getTime(),
                            isPaused: !!schedule.isPaused,
                            pauseEndTimestampMs: schedule.pauseEndTime || null
                        });
                    });
                    continue;
                }
                for (let segIdx = 0; segIdx < schedule.segments.length; segIdx++) {
                    const seg = schedule.segments[segIdx];
                    const window = getIOSScheduleEntryWindow(schedule, seg);
                    flatEntries.push({
                        id: `${schedule.id}-${segIdx}`,
                        startHour: seg.startHour,
                        startMinute: seg.startMinute,
                        endHour: seg.endHour,
                        endMinute: seg.endMinute,
                        days: seg.days ? [...seg.days] : [],
                        domains,
                        appTokenData: iosPayload.appTokenData,
                        categoryTokenData: iosPayload.categoryTokenData,
                        repeats: window.repeats,
                        activeFromTimestampMs: window.activeFromTimestampMs,
                        activeUntilTimestampMs: window.activeUntilTimestampMs,
                        isPaused: !!schedule.isPaused,
                        pauseEndTimestampMs: schedule.pauseEndTime || null
                    });
                }
            }
            console.log('[syncSchedulesToHelper] iOS: Sending', flatEntries.length, 'segment entries to plugin');
            const result = await tauriAPI.setSchedulesPlugin(flatEntries);
            if (!result.success) {
                console.warn('[syncSchedulesToHelper] iOS plugin failed:', result.error);
                if (!hasShownIOSScheduleSyncError) {
                    hasShownIOSScheduleSyncError = true;
                    await message(`iOS schedule sync failed: ${result.error || 'unknown plugin error'}`, {
                        title: 'Schedule Sync Failed',
                        kind: 'error'
                    });
                }
            }
        } catch (e) {
            console.warn('[syncSchedulesToHelper] iOS error:', e);
            if (!hasShownIOSScheduleSyncError) {
                hasShownIOSScheduleSyncError = true;
                const errorText = e?.message || String(e);
                await message(`iOS schedule sync threw an error: ${errorText}`, {
                    title: 'Schedule Sync Error',
                    kind: 'error'
                });
            }
        }
        return;
    }
    try {
        const status = await tauriAPI.checkHelperStatus();
        if (!status.running || !status.version_ok) {
            console.log('[syncSchedulesToHelper] Helper not available, skipping');
            return;
        }

        // Build schedule payloads with pre-resolved domains and apps
        const helperSchedules = (appData.schedules || []).map(schedule => {
            const blocklist = appData.blocklists.find(bl => bl.id === schedule.blocklistId);
            const helperSegments = isNonRepeatingSchedule(schedule)
                ? resolveOneShotOccurrences(schedule).map(occurrence => ({
                    startHour: occurrence.start.getHours(),
                    startMinute: occurrence.start.getMinutes(),
                    endHour: occurrence.end.getHours(),
                    endMinute: occurrence.end.getMinutes(),
                    days: [],
                    activeFromTimestampMs: occurrence.start.getTime(),
                    activeUntilTimestampMs: occurrence.end.getTime()
                }))
                : (schedule.segments || []).map(seg => ({
                    startHour: seg.startHour,
                    startMinute: seg.startMinute,
                    endHour: seg.endHour,
                    endMinute: seg.endMinute,
                    days: [...seg.days]
                }));
            return {
                id: schedule.id,
                domains: blocklist?.websites || [],
                apps: blocklist?.apps || [],
                isPaused: !!schedule.isPaused,
                pauseEndTime: schedule.pauseEndTime || null,
                segments: helperSegments
            };
        });

        console.log('[syncSchedulesToHelper] Sending', helperSchedules.length, 'schedules to helper');
        const result = await tauriAPI.setSchedulesViaHelper(helperSchedules);
        if (!result.success) {
            console.warn('[syncSchedulesToHelper] Failed:', result.error);
        }
    } catch (e) {
        console.warn('[syncSchedulesToHelper] Error:', e);
    }
}

async function syncActiveBlocksToHelper() {
    if (isIOS) return;
    try {
        const status = await tauriAPI.checkHelperStatus();
        if (!status.running || !status.version_ok) return;
        const now = Date.now();
        console.log('[syncActiveBlocksToHelper] Total activeBlocks:', appData.activeBlocks.length,
            'blocks:', appData.activeBlocks.map(b => ({
                id: b.id, blocklistId: b.blocklistId, startTime: b.startTime, endTime: b.endTime,
                isPaused: b.isPaused, isAlwaysOn: b.isAlwaysOn,
                startOk: b.startTime <= now, endOk: b.endTime > now, pauseOk: !b.isPaused
            })));
        const activeBlocks = appData.activeBlocks.filter(block => block.startTime <= now && block.endTime > now);
        console.log('[syncActiveBlocksToHelper] Filtered activeBlocks:', activeBlocks.length);

        // Build the blocks array for the atomic set-blocks command.
        // Paused blocks are included so the helper can auto-resume them when the pause expires,
        // even if the frontend isn't running.
        const helperBlocks = activeBlocks.map(block => {
            const blocklist = appData.blocklists.find(bl => bl.id === block.blocklistId);
            return {
                domains: blocklist?.websites || [],
                endTime: block.endTime,
                blocklistId: block.blocklistId,
                isPaused: !!block.isPaused,
                pauseEndTime: block.pauseEndTime || null
            };
        });
        
        console.log('[syncActiveBlocksToHelper] Sending', helperBlocks.length, 'blocks to helper');
        // Atomically replace all blocks in the helper daemon (no clear→re-add race)
        await tauriAPI.setBlocksViaHelper(helperBlocks);
    } catch (e) {
        console.warn('[syncActiveBlocksToHelper] Error:', e);
    }
}

function isOneOffBlockEnforced(block, now = Date.now()) {
    return !!(block && block.startTime <= now && block.endTime > now && !block.isPaused);
}

function isOneOffBlockStillActive(block, now = Date.now()) {
    return !!(block && block.endTime > now);
}

function isSchedulePausedNow(schedule, now = Date.now()) {
    return !!(schedule && schedule.isPaused && schedule.pauseEndTime > now);
}

function hasAnyEnforcedBlocks(now = Date.now(), nowDate = new Date(now)) {
    const hasActiveOneOff = appData.activeBlocks.some(block => isOneOffBlockEnforced(block, now));
    if (hasActiveOneOff) return true;
    return !!appData.schedules?.some(schedule => isScheduleSegmentActiveNow(schedule, nowDate));
}

function scheduleHasFutureRecurringOccurrence(schedule, nowDate = new Date()) {
    if (!schedule || !Array.isArray(schedule.segments) || schedule.segments.length === 0) return false;

    const currentDay = nowDate.getDay() === 0 ? 6 : nowDate.getDay() - 1;

    return schedule.segments.some(seg => {
        const segmentDays = (Array.isArray(seg.days) && seg.days.length > 0) ? seg.days : [currentDay];
        return segmentDays.some(segmentDay => {
            let daysUntil = segmentDay - currentDay;
            if (daysUntil < 0) daysUntil += 7;

            const candidateStart = new Date(nowDate);
            candidateStart.setDate(candidateStart.getDate() + daysUntil);
            candidateStart.setHours(seg.startHour, seg.startMinute, 0, 0);

            const candidateEnd = new Date(candidateStart);
            candidateEnd.setHours(seg.endHour, seg.endMinute, 0, 0);
            if (candidateEnd <= candidateStart) {
                candidateEnd.setDate(candidateEnd.getDate() + 1);
            }

            if (candidateEnd <= nowDate) {
                candidateStart.setDate(candidateStart.getDate() + 7);
                candidateEnd.setDate(candidateEnd.getDate() + 7);
            }

            if (schedule.repeatType === 'date' && schedule.repeatDate) {
                const repeatEnd = new Date(schedule.repeatDate);
                repeatEnd.setHours(23, 59, 59, 999);
                return candidateStart <= repeatEnd && candidateEnd > nowDate;
            }

            return candidateEnd > nowDate;
        });
    });
}

function scheduleHasFutureSingleOccurrence(schedule, nowDate = new Date()) {
    if (!schedule || !Array.isArray(schedule.segments) || schedule.segments.length === 0) return false;
    return resolveOneShotOccurrences(schedule).some(occurrence => occurrence.end > nowDate);
}

function scheduleCanStillBecomeActive(schedule, nowDate = new Date()) {
    if (!schedule || !Array.isArray(schedule.segments) || schedule.segments.length === 0) return false;
    if (schedule.repeatType === 'forever' || (schedule.repeatType === 'date' && schedule.repeatDate)) {
        return scheduleHasFutureRecurringOccurrence(schedule, nowDate);
    }
    return scheduleHasFutureSingleOccurrence(schedule, nowDate);
}

function hasAnyBlockingStateToClear(now = Date.now(), nowDate = new Date(now)) {
    const hasOneOffState = appData.activeBlocks.some(block => isOneOffBlockStillActive(block, now));
    if (hasOneOffState) return true;
    return !!appData.schedules?.some(schedule => scheduleCanStillBecomeActive(schedule, nowDate));
}

async function refreshDesktopHelperStatus() {
    if (isIOS) {
        return { installed: false, running: false, version: null, version_ok: false, helperReady: false };
    }
    try {
        const status = await tauriAPI.checkHelperStatus();
        const helperReady = !!(status.running && status.version_ok);
        const nextStatus = { ...status, helperReady };
        helperAvailable = helperReady;
        lastDesktopHelperStatus = nextStatus;
        lastDesktopHelperStatusAt = Date.now();
        return nextStatus;
    } catch (err) {
        console.error('Error checking helper status:', err);
        helperAvailable = false;
        lastDesktopHelperStatus = {
            installed: false,
            running: false,
            version: null,
            version_ok: false,
            helperReady: false,
            error: err
        };
        lastDesktopHelperStatusAt = Date.now();
        return lastDesktopHelperStatus;
    }
}

function getCachedDesktopHelperStatus(maxAgeMs = HELPER_STATUS_CACHE_TTL_MS) {
    if (!lastDesktopHelperStatus) return null;
    if ((Date.now() - lastDesktopHelperStatusAt) > maxAgeMs) return null;
    return lastDesktopHelperStatus;
}

const HELPER_UI_REFRESH_MS = 3000;
let helperUiRefreshTimer = null;
let helperUiRefreshInFlight = false;

function isModalVisible(id) {
    const modal = document.getElementById(id);
    return !!(modal && !modal.classList.contains('hidden'));
}

function stopHelperUiRefreshLoop() {
    if (helperUiRefreshTimer != null) {
        clearInterval(helperUiRefreshTimer);
        helperUiRefreshTimer = null;
    }
}

async function refreshOpenHelperUi() {
    if (helperUiRefreshInFlight || isIOS) return;

    const settingsVisible = isModalVisible('settings-modal');
    const diagnosticsVisible = isModalVisible('diagnostics-modal');
    if (!settingsVisible && !diagnosticsVisible) {
        stopHelperUiRefreshLoop();
        return;
    }

    helperUiRefreshInFlight = true;
    try {
        if (settingsVisible) {
            await updateHelperStatusIndicator();
            updateCleanHostsBtnState();
        }
        if (diagnosticsVisible) {
            await refreshDiagnosticsModalContent();
        }
    } finally {
        helperUiRefreshInFlight = false;
    }
}

function startHelperUiRefreshLoop() {
    if (isIOS || helperUiRefreshTimer != null) return;
    helperUiRefreshTimer = setInterval(() => {
        void refreshOpenHelperUi();
    }, HELPER_UI_REFRESH_MS);
}

let scheduleRepeatType = 'forever'; // 'forever', 'date', or 'no'
let scheduleRepeatDate = null; // Date object when repeatType is 'date'
let activeScheduleSegmentCount = 0; // Number of segments locked in the active schedule (new segments can be added)
let hasShownIOSScheduleSyncError = false;
const CURRENT_EULA_REVISION = 1;
let forceShowEulaThisSession = false;

// Word list for random word challenges
const wordList = [
    // 1-2 chars
    'a', 'ad', 'am', 'an', 'as', 'at', 'be', 'by', 'do', 'go', 'he', 'hi', 'if', 'in', 'is', 'it', 'me', 'my', 'no', 'of', 'on', 'or', 'so', 'to', 'up', 'us', 'we',
    // 3 chars
    'act', 'add', 'age', 'aim', 'air', 'all', 'and', 'any', 'art', 'ask', 'bad', 'bag', 'bar', 'bat', 'bed', 'bee', 'big', 'bit', 'box', 'boy', 'bus', 'but', 'buy', 'can', 'car', 'cat', 'day', 'die', 'dog', 'dry', 'due', 'eat', 'egg', 'end', 'eye', 'far', 'few', 'fit', 'fly', 'for', 'fun', 'get', 'god', 'got', 'guy', 'hot', 'how', 'ice', 'ill', 'ink', 'job', 'joy', 'key', 'kid', 'law', 'lay', 'leg', 'let', 'lie', 'log', 'lot', 'low', 'man', 'map', 'may', 'men', 'mix', 'net', 'new', 'nod', 'nor', 'not', 'now', 'num', 'off', 'oil', 'old', 'one', 'out', 'own', 'pay', 'pen', 'per', 'pet', 'pie', 'pig', 'pin', 'pot', 'put', 'ran', 'raw', 'red', 'row', 'run', 'sad', 'say', 'sea', 'see', 'set', 'she', 'sin', 'sit', 'six', 'sky', 'son', 'sun', 'tap', 'tax', 'tea', 'ten', 'the', 'tie', 'tip', 'toe', 'too', 'top', 'toy', 'try', 'two', 'use', 'van', 'war', 'way', 'who', 'why', 'win', 'yes', 'yet', 'you',
    // 4 chars
    'also', 'able', 'acid', 'aged', 'away', 'baby', 'back', 'ball', 'bank', 'base', 'bath', 'bear', 'beat', 'beer', 'bell', 'belt', 'best', 'bill', 'bird', 'blow', 'blue', 'boat', 'body', 'bomb', 'bond', 'bone', 'book', 'boom', 'born', 'boss', 'both', 'bowl', 'burn', 'busy', 'call', 'calm', 'came', 'camp', 'card', 'care', 'case', 'cash', 'cast', 'cell', 'chat', 'chip', 'city', 'club', 'coal', 'coat', 'code', 'cold', 'come', 'cook', 'cool', 'cope', 'core', 'cost', 'crew', 'crop', 'dark', 'date', 'dead', 'deal', 'dean', 'dear', 'debt', 'deep', 'deny', 'desk', 'dial', 'diet', 'disc', 'disk', 'does', 'done', 'door', 'dose', 'down', 'draw', 'drew', 'drop', 'drug', 'dual', 'duke', 'dust', 'duty', 'each', 'earn', 'ease', 'east', 'easy', 'edge', 'edit', 'else', 'even', 'ever', 'evil', 'exit', 'face', 'fact', 'fail', 'fair', 'fall', 'farm', 'fast', 'fate', 'fear', 'feed', 'feel', 'feet', 'fell', 'felt', 'file', 'fill', 'film', 'find', 'fine', 'fire', 'firm', 'fish', 'five', 'flat', 'fled', 'flew', 'flow', 'food', 'foot', 'ford', 'form', 'fort', 'four', 'free', 'from', 'fuel', 'full', 'fund', 'gain', 'game', 'gate', 'gave', 'gear', 'gene', 'gift', 'girl', 'give', 'glad', 'goal', 'goes', 'gold', 'golf', 'gone', 'good', 'gray', 'grew', 'grey', 'grow', 'hair', 'half', 'hall', 'hand', 'hang', 'hard', 'harm', 'hate', 'have', 'head', 'hear', 'heat', 'held', 'hell', 'help', 'here', 'hero', 'high', 'hill', 'hire', 'hold', 'hole', 'holy', 'home', 'hope', 'host', 'hour', 'huge', 'hung', 'hunt', 'hurt', 'idea', 'inch', 'into', 'iron', 'item', 'join', 'joke', 'jump', 'jury', 'just', 'keep', 'kept', 'kick', 'kill', 'kind', 'king', 'knee', 'knew', 'know', 'lack', 'lady', 'laid', 'lake', 'land', 'lane', 'last', 'late', 'lead', 'left', 'less', 'life', 'lift', 'like', 'line', 'link', 'list', 'live', 'load', 'loan', 'lock', 'logo', 'long', 'look', 'lord', 'lose', 'loss', 'lost', 'love', 'luck', 'made', 'mail', 'main', 'make', 'male', 'many', 'mark', 'mass', 'mate', 'math', 'meal', 'mean', 'meat', 'meet', 'menu', 'mere', 'mile', 'milk', 'mill', 'mind', 'mine', 'miss', 'mode', 'mood', 'moon', 'more', 'most', 'move', 'much', 'must', 'name', 'navy', 'near', 'neck', 'need', 'news', 'next', 'nice', 'nick', 'nine', 'none', 'nose', 'note', 'okay', 'once', 'only', 'onto', 'open', 'oral', 'over', 'pace', 'pack', 'page', 'paid', 'pain', 'pair', 'palm', 'park', 'part', 'pass', 'past', 'path', 'peak', 'pick', 'pile', 'pink', 'pipe', 'plan', 'play', 'plot', 'plug', 'plus', 'poll', 'pool', 'poor', 'port', 'post', 'pull', 'pure', 'push', 'race', 'rail', 'rain', 'rank', 'rare', 'rate', 'read', 'real', 'rear', 'rely', 'rent', 'rest', 'rice', 'rich', 'ride', 'ring', 'rise', 'risk', 'road', 'rock', 'role', 'roll', 'roof', 'room', 'root', 'rose', 'rule', 'rush', 'safe', 'said', 'sake', 'sale', 'salt', 'same', 'sand', 'save', 'seat', 'seed', 'seek', 'seem', 'seen', 'self', 'sell', 'send', 'sent', 'ship', 'shop', 'shot', 'show', 'shut', 'sick', 'side', 'sign', 'silk', 'site', 'size', 'skin', 'slip', 'slow', 'snow', 'soft', 'soil', 'sold', 'sole', 'some', 'song', 'soon', 'sort', 'soul', 'spot', 'star', 'stay', 'step', 'stop', 'such', 'suit', 'sure', 'take', 'tale', 'talk', 'tall', 'tank', 'tape', 'task', 'team', 'tech', 'tell', 'tend', 'term', 'test', 'text', 'than', 'that', 'them', 'then', 'they', 'thin', 'this', 'thus', 'till', 'time', 'tiny', 'told', 'toll', 'tone', 'took', 'tool', 'tour', 'town', 'tree', 'trip', 'true', 'tune', 'turn', 'twin', 'type', 'unit', 'upon', 'used', 'user', 'vary', 'vast', 'very', 'vice', 'view', 'vote', 'wage', 'wait', 'wake', 'walk', 'wall', 'want', 'ward', 'warm', 'wash', 'wave', 'ways', 'weak', 'wear', 'week', 'well', 'went', 'were', 'west', 'what', 'when', 'whom', 'wide', 'wife', 'wild', 'will', 'wind', 'wine', 'wing', 'wire', 'wise', 'wish', 'with', 'wood', 'word', 'work', 'yard', 'yeah', 'year', 'your', 'zero', 'zone',
    // 5+ chars (selection)
    'about', 'above', 'abuse', 'actor', 'acute', 'admit', 'adopt', 'adult', 'after', 'again', 'agent', 'agree', 'ahead', 'alarm', 'album', 'alert', 'alike', 'alive', 'allow', 'alone', 'along', 'alter', 'among', 'anger', 'angle', 'angry', 'apart', 'apple', 'apply', 'arena', 'argue', 'arise', 'array', 'aside', 'asset', 'audio', 'audit', 'avoid', 'award', 'aware', 'badly', 'baker', 'bases', 'basic', 'basis', 'beach', 'began', 'begin', 'begun', 'being', 'below', 'bench', 'birth', 'black', 'blame', 'blind', 'block', 'blood', 'board', 'boost', 'booth', 'bound', 'brain', 'brand', 'bread', 'break', 'breed', 'brief', 'bring', 'broad', 'brown', 'brush', 'build', 'built', 'buyer', 'cable', 'carry', 'catch', 'cause', 'chain', 'chair', 'chart', 'chase', 'cheap', 'check', 'chest', 'chief', 'child', 'china', 'chose', 'civil', 'claim', 'class', 'clean', 'clear', 'click', 'clock', 'close', 'coach', 'coast', 'could', 'count', 'court', 'cover', 'craft', 'crash', 'cream', 'crime', 'cross', 'crowd', 'crown', 'curve', 'cycle', 'daily', 'dance', 'dated', 'dealt', 'death', 'debut', 'delay', 'depth', 'doing', 'doubt', 'dozen', 'draft', 'drama', 'drawn', 'dream', 'dress', 'drill', 'drink', 'drive', 'drove', 'dying', 'eager', 'early', 'earth', 'eight', 'elite', 'empty', 'enemy', 'enjoy', 'enter', 'entry', 'equal', 'error', 'event', 'every', 'exact', 'exist', 'extra', 'faith', 'false', 'fault', 'fiber', 'field', 'fifth', 'fifty', 'fight', 'final', 'first', 'fixed', 'flash', 'fleet', 'floor', 'fluid', 'focus', 'force', 'forth', 'forty', 'forum', 'found', 'frame', 'frank', 'fraud', 'fresh', 'front', 'fruit', 'fully', 'funny', 'giant', 'given', 'glass', 'globe', 'going', 'grace', 'grade', 'grand', 'grant', 'grass', 'great', 'green', 'gross', 'group', 'grown', 'guard', 'guess', 'guest', 'guide', 'happy', 'heart', 'heavy', 'hence', 'horse', 'hotel', 'house', 'human', 'ideal', 'image', 'index', 'inner', 'input', 'issue', 'japan', 'joint', 'judge', 'known', 'label', 'large', 'laser', 'later', 'laugh', 'layer', 'learn', 'lease', 'least', 'leave', 'legal', 'level', 'light', 'limit', 'links', 'lives', 'local', 'logic', 'loose', 'lower', 'lucky', 'lunch', 'lying', 'magic', 'major', 'maker', 'march', 'match', 'maybe', 'mayor', 'limit', 'admit', 'adult', 'advice', 'affect', 'afford', 'afraid', 'agency', 'agenda', 'almost', 'always', 'amount', 'animal', 'annual', 'answer', 'anyway', 'appeal', 'appear', 'aspect', 'assist', 'assume', 'attack', 'attend', 'august', 'author', 'avenue', 'backed', 'barely', 'battle', 'beauty', 'became', 'become', 'before', 'behalf', 'behind', 'belief', 'belong', 'berlin', 'better', 'beyond', 'bishop', 'border', 'bottle', 'bottom', 'bought', 'branch', 'breath', 'bridge', 'bright', 'broken', 'budget', 'burden', 'bureau', 'button', 'camera', 'cancer', 'cannot', 'carbon', 'career', 'castle', 'casual', 'caught', 'center', 'centre', 'chance', 'change', 'charge', 'choice', 'choose', 'chosen', 'church', 'circle', 'client', 'closed', 'closer', 'coffee', 'column', 'combat', 'coming', 'common', 'comply', 'copper', 'corner', 'costly', 'county', 'couple', 'course', 'covers', 'create', 'credit'
];

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    await loadData();
    await resetDevOnlyEulaAcceptance();
    detectPlatform(); // Must run early so isIOS is set before other setup
    setupEventListeners();
    setupTheme();
    setupUiZoomShortcuts();
    setupHelpMenuLinks();
    setupHelperSettings();
    setupDiagnosticsButton();
    setupOverrideAll();
    setupGraceSetting();
    if (isIOS && hasAcceptedEula()) {
        await checkScreentimeAuth();
    } else {
        updateOnboardingVisibility();
    }

    if (hasAcceptedEula()) {
        await runPostAcceptanceStartup();
    }

});

function isLocalDevRun() {
    return ['http:', 'https:'].includes(window.location.protocol)
        && ['localhost', '127.0.0.1'].includes(window.location.hostname);
}

async function resetDevOnlyEulaAcceptance() {
    forceShowEulaThisSession = isLocalDevRun();
}

function getAcceptedEulaRevision() {
    const rawRevision = appData?.settings?.eulaAcceptedRevision;
    if (Number.isInteger(rawRevision) && rawRevision > 0) {
        return rawRevision;
    }
    if (typeof rawRevision === 'string') {
        const parsedRevision = Number.parseInt(rawRevision, 10);
        if (Number.isInteger(parsedRevision) && parsedRevision > 0) {
            return parsedRevision;
        }
    }
    if (appData?.settings?.eulaAccepted === true) {
        return CURRENT_EULA_REVISION;
    }
    return null;
}

function normalizeLoadedEulaState() {
    if (!appData.settings) {
        appData.settings = {};
    }

    let changed = false;
    const acceptedRevision = getAcceptedEulaRevision();

    if (acceptedRevision == null) {
        if (appData.settings.eulaAcceptedRevision != null) {
            delete appData.settings.eulaAcceptedRevision;
            changed = true;
        }
    } else if (appData.settings.eulaAcceptedRevision !== acceptedRevision) {
        appData.settings.eulaAcceptedRevision = acceptedRevision;
        changed = true;
    }

    const rawAcceptedAt = appData.settings.eulaAcceptedAt;
    if (rawAcceptedAt != null) {
        const parsedAcceptedAt = Number(rawAcceptedAt);
        if (Number.isFinite(parsedAcceptedAt) && parsedAcceptedAt > 0) {
            if (appData.settings.eulaAcceptedAt !== parsedAcceptedAt) {
                appData.settings.eulaAcceptedAt = parsedAcceptedAt;
                changed = true;
            }
        } else {
            delete appData.settings.eulaAcceptedAt;
            changed = true;
        }
    }

    if ('eulaAccepted' in appData.settings) {
        delete appData.settings.eulaAccepted;
        changed = true;
    }

    return changed;
}

function hasAcceptedEula() {
    return !forceShowEulaThisSession && getAcceptedEulaRevision() === CURRENT_EULA_REVISION;
}

async function runPostAcceptanceStartup() {
    if (startupInitializationComplete) return;
    if (startupInitializationPromise) {
        await startupInitializationPromise;
        return;
    }

    startupInitializationPromise = (async () => {
        await runExpiryOnce(); // Align in-memory state with Screen Time / helper (e.g. after app was closed)
        if (isIOS) {
            await checkScreentimeAuth();
            if (screentimeAuthorized) {
                await initializeIOSBlockingState();
            }
        } else {
            // Run first-launch migration off the legacy helper + check
            // Automation TCC (macOS) + extension compliance. Idempotent;
            // a no-op on subsequent launches past the current version.
            await runDesktopOnboarding();
            await checkHelperStatus();
            console.log('[startup-sync] Desktop startup helperAvailable:', helperAvailable);
            // Reconcile manual blocks first so paused one-offs are removed from helper state after reinstall.
            await syncActiveBlocksToHelper();
            // Then sync schedules to helper so both enforcement sources are aligned.
            await syncSchedulesToHelper();
            console.log('[startup-sync] Startup helper reconciliation complete');
        }
        render();
        scrollToNow(false); // Initial scroll (instant, no animation)
        startTickInterval();

        // Check for app updates (non-blocking, desktop only)
        if (!isIOS) {
            checkForAppUpdate();
        }
        startupInitializationComplete = true;
    })();

    try {
        await startupInitializationPromise;
    } finally {
        if (!startupInitializationComplete) {
            startupInitializationPromise = null;
        }
    }
}

// Check if a newer app version is available and show update banner
async function checkForAppUpdate() {
    try {
        const currentVersion = await tauriAPI.getAppVersion();
        if (!currentVersion) return;

        const response = await fetch(`https://ulyngs.github.io/redd-block/latest-versions.json?t=${Date.now()}`);
        const versions = await response.json();

        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        const platform = isMac ? 'macos' : 'windows';
        const latestVersion = versions[platform];

        if (latestVersion && isVersionHigher(latestVersion, currentVersion)) {
            const banner = document.getElementById('update-banner');
            const versionEl = document.getElementById('update-banner-version');
            const dismissBtn = document.getElementById('update-banner-dismiss');

            if (banner && versionEl) {
                versionEl.textContent = latestVersion;
                banner.classList.remove('hidden');

                if (dismissBtn) {
                    dismissBtn.addEventListener('click', () => {
                        banner.classList.add('hidden');
                    });
                }
            }
        }
    } catch (e) {
        // Silently fail if offline
        console.log('[Update] Could not check for updates:', e.message);
    }
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
let migrationOnboardingActive = false;
let migrationOnboardingDismissed = false;
const EXT_ONBOARDING_DISMISSED_KEY = 'reddBlockExtOnboardingDismissed';
const BEHAVIOUR_CHANGE_DISMISSED_KEY = 'reddBlockBehaviourChangeDismissed';

async function runDesktopOnboarding() {
    if (isIOS) return;
    try {
        const pendingAtLaunch = await invoke('migration_pending');
        const wasUpgrade = await invoke('migration_was_pending_at_launch');

        if (pendingAtLaunch) {
            // Residue still present → show pre-prompt screen.
            await showMigrationOnboarding('pre');
            return;
        }
        if (wasUpgrade && !migrationOnboardingDismissed) {
            // Residue cleaned this launch (or by an earlier launch
            // before the user dismissed). Show the post-cleanup
            // screen so they know what changed and install the
            // extension. Cleanup-mode framing.
            const state = await invoke('onboarding_state');
            await showMigrationOnboarding('post', state, { mode: 'after-cleanup' });
            return;
        }

        // Fresh-user case: not an upgrade, but at least one INSTALLED
        // browser is missing the extension AND the user hasn't seen+
        // dismissed this screen before.
        //
        // Note: state.extension_compliant from the backend is keyed
        // off RUNNING browsers (so the in-session enforcer doesn't
        // nag about closed ones). Here we want a broader check: any
        // browser the user has installed but that doesn't have ReDD
        // Focus set up. That's the migration UI's
        // browserComplianceStatus logic.
        const state = await invoke('onboarding_state');
        console.log('[onboarding] state:', state);
        const dismissed = localStorage.getItem(EXT_ONBOARDING_DISMISSED_KEY);
        const browsers = state.browsers || {};
        const anyDetected = Object.keys(BROWSER_STORE_LINKS).some(k => browsers[k] && browsers[k].installed);
        const anyMissing = Object.keys(BROWSER_STORE_LINKS).some(k => {
            const b = browsers[k];
            return b && b.installed && browserComplianceStatus(k, b) !== 'compliant';
        });
        if (!dismissed && anyDetected && anyMissing && !migrationOnboardingDismissed) {
            await showMigrationOnboarding('post', state, { mode: 'fresh' });
            return;
        }

        // Returning user with extension already set up, OR user has
        // dismissed the welcome — fall back to the slim banner for
        // ongoing nagging.
        updateExtensionComplianceBanner(state);
        await updateBehaviourChangeBanner(state);
    } catch (e) {
        console.warn('[onboarding] state check failed:', e);
    }
}

async function showMigrationOnboarding(phase, state, opts = {}) {
    const screen = document.getElementById('migration-onboarding');
    const pre = document.getElementById('migration-phase-pre');
    const post = document.getElementById('migration-phase-post');
    const main = document.getElementById('main-content');
    if (!screen || !pre || !post) return;

    migrationOnboardingActive = true;
    if (main) main.classList.add('hidden');
    screen.classList.remove('hidden');
    pre.classList.toggle('hidden', phase !== 'pre');
    post.classList.toggle('hidden', phase !== 'post');

    // For the post phase, swap headline + subtitle + checklist depending
    // on whether we got here from a v1.x cleanup (mode=after-cleanup)
    // or it's a fresh user (mode=fresh, default).
    if (phase === 'post') {
        const mode = opts.mode || 'fresh';
        const title = document.getElementById('migration-post-title');
        const subtitle = document.getElementById('migration-post-subtitle');
        const cleanupItems = post.querySelectorAll('.migration-cleanup-only');
        if (mode === 'after-cleanup') {
            if (title) title.textContent = 'Cleanup complete';
            if (subtitle) subtitle.textContent = 'One step left: install ReDD Focus in each browser you use.';
            cleanupItems.forEach(el => el.classList.remove('hidden'));
        } else {
            if (title) title.textContent = 'Welcome to ReDD Block';
            if (subtitle) subtitle.textContent = 'Install ReDD Focus in your browsers to start blocking distracting websites.';
            cleanupItems.forEach(el => el.classList.add('hidden'));
        }
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

    if (phase === 'pre') {
        wireMigrationPrePhase();
    } else if (phase === 'post') {
        wireMigrationPostPhase(state);
    }
}

function hideMigrationOnboarding() {
    const screen = document.getElementById('migration-onboarding');
    const main = document.getElementById('main-content');
    if (screen) screen.classList.add('hidden');
    if (main) main.classList.remove('hidden');
    migrationOnboardingActive = false;
    migrationOnboardingDismissed = true;
}

function wireMigrationPrePhase() {
    const btn = document.getElementById('migration-continue-btn');
    const status = document.getElementById('migration-pre-status');
    if (!btn) return;

    // Always reset button + status to a clean pre-cleanup state.
    // This function is also called when the overlay is re-shown
    // (e.g. residue reappears after a successful migration); without
    // this, btn.disabled / btn.textContent / status would carry over
    // from the previous click and the user would be locked out.
    btn.disabled = false;
    btn.textContent = 'Continue';
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
            status.textContent = 'Approve the admin prompt to continue…';
            status.classList.remove('hidden', 'error');
        }

        const failTryAgain = (msg) => {
            btn.disabled = false;
            btn.textContent = 'Try again';
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
                    failTryAgain("We need that admin permission to finish — your blocklists are safe.");
                    return;
                }
                if (Date.now() - start > TIMEOUT_MS) {
                    failTryAgain("Something went wrong. Click to retry.");
                    return;
                }
            }
            const fresh = await invoke('onboarding_state');
            await showMigrationOnboarding('post', fresh);
        } catch (e) {
            console.warn('[migration] poll failed:', e);
            failTryAgain("Something went wrong. Click to retry.");
        }
    });
}

function wireMigrationPostPhase(state) {
    renderBrowserInstallButtons(state);
    const doneBtn = document.getElementById('migration-done-btn');
    const skipBtn = document.getElementById('migration-skip-btn');

    const finish = async () => {
        try {
            await invoke('enforcer_start');
        } catch (e) {
            console.warn('[migration] enforcer_start failed:', e);
        }
        // Persist dismissal so we don't surface this full-screen
        // again on every launch — the slim extension-compliance
        // banner takes over for ongoing nagging. Stored locally
        // (per-install) which is fine for a UX hint.
        try { localStorage.setItem(EXT_ONBOARDING_DISMISSED_KEY, String(Date.now())); }
        catch (_) { /* localStorage may be disabled; harmless */ }
        hideMigrationOnboarding();
        try {
            const fresh = await invoke('onboarding_state');
            updateExtensionComplianceBanner(fresh);
            await updateBehaviourChangeBanner(fresh);
        } catch (e) { /* no-op */ }
    };

    if (doneBtn && !doneBtn._listenerAdded) {
        doneBtn._listenerAdded = true;
        doneBtn.addEventListener('click', finish);
    }
    if (skipBtn && !skipBtn._listenerAdded) {
        skipBtn._listenerAdded = true;
        skipBtn.addEventListener('click', finish);
    }
}

// Per-browser metadata: label + extension store URL (Chromium-family
// browsers all use the Chrome Web Store listing).
const BROWSER_STORE_LINKS = {
    chrome: { label: 'Chrome', url: 'https://chromewebstore.google.com/detail/redd-focus-hide-distracti/hhblkhfdjijdinijakbmcpkmdfhoadcd' },
    brave: { label: 'Brave', url: 'https://chromewebstore.google.com/detail/redd-focus-hide-distracti/hhblkhfdjijdinijakbmcpkmdfhoadcd' },
    edge: { label: 'Edge', url: 'https://chromewebstore.google.com/detail/redd-focus-hide-distracti/hhblkhfdjijdinijakbmcpkmdfhoadcd' },
    firefox: { label: 'Firefox', url: 'https://addons.mozilla.org/en-US/firefox/addon/reddfocus/' },
    safari: { label: 'Safari', url: 'https://apps.apple.com/us/app/redd-focus-hide-distractions/id1660218371' },
};

// Compute per-step status for the migration UI:
//   - 'compliant': extension installed, enabled, allowed in private
//   - 'needs-private': installed + enabled but not allowed in private
//   - 'needs-enable': installed but disabled
//   - 'needs-install': extension not installed
// Returns null if the browser itself isn't installed on the machine.
function browserComplianceStatus(key, b) {
    if (!b || !b.installed) return null;
    const def = (b.profiles || []).find(p => p.isDefault) || (b.profiles || [])[0];
    if (key === 'safari' && def && /Full Disk Access|extension settings plist|Safari extension settings/i.test(def.note || '')) {
        return 'needs-fda';
    }
    if (!def || !def.installed) return 'needs-install';
    const enabled = def.enabled;
    if (enabled === false) return 'needs-enable';
    const priv = def.privateBrowsing;
    if (priv !== true) return 'needs-private';
    return 'compliant';
}

function statusLabel(key, status) {
    switch (status) {
        case 'compliant': return '✓ Set up';
        case 'needs-fda': return 'Grant Full Disk Access';
        case 'needs-private': return 'Allow in private browsing';
        case 'needs-enable': return 'Enable extension';
        case 'needs-install': return 'Install';
        default: return 'Install';
    }
}

function renderBrowserInstallButtons(state) {
    const container = document.getElementById('migration-browser-buttons');
    const checklistItem = document.getElementById('migration-checklist-ext');
    if (!container) return;
    container.innerHTML = '';

    const browsers = state && state.browsers ? state.browsers : {};

    // Show every browser we detect on disk (regardless of running
    // state). During migration the user may need to install the
    // extension in browsers they haven't opened yet — only filtering
    // to running browsers (as the in-session compliance banner does)
    // would hide those.
    const detectedKeys = Object.keys(BROWSER_STORE_LINKS).filter(k => {
        const b = browsers[k];
        return b && b.installed;
    });

    // Fallback: if the scan didn't identify any installed browser
    // (unusual), surface a single Chrome row so the user has
    // somewhere to go.
    const keys = detectedKeys.length > 0 ? detectedKeys : ['chrome'];

    for (const key of keys) {
        const entry = BROWSER_STORE_LINKS[key];
        if (!entry) continue;
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
        name.textContent = entry.label;
        header.appendChild(name);

        const badge = document.createElement('span');
        badge.className = `migration-browser-badge ${status}`;
        switch (status) {
            case 'compliant': badge.textContent = statusLabel(key, status); break;
            case 'needs-install': badge.textContent = 'Not installed'; break;
            case 'needs-enable': badge.textContent = 'Disabled'; break;
            case 'needs-private': badge.textContent = 'No private mode'; break;
            case 'needs-fda': badge.textContent = 'Needs access'; break;
            default: badge.textContent = 'Not installed';
        }
        header.appendChild(badge);

        row.appendChild(header);

        if (status === 'needs-fda') {
            const hint = document.createElement('div');
            hint.className = 'migration-browser-hint';
            hint.textContent = 'Grant ReDD Block Full Disk Access so it can verify Safari extension settings. Safari will be closed during active enforcement until this is fixed.';
            row.appendChild(hint);

            const action = document.createElement('div');
            action.className = 'migration-browser-action';

            const settingsBtn = document.createElement('button');
            settingsBtn.type = 'button';
            settingsBtn.className = 'migration-browser-copy';
            settingsBtn.textContent = 'Open Settings';
            settingsBtn.title = 'Open Full Disk Access settings';
            settingsBtn.addEventListener('click', async () => {
                try {
                    await invoke('open_safari_fda_settings');
                    settingsBtn.textContent = 'Opened';
                    setTimeout(() => { settingsBtn.textContent = 'Open Settings'; }, 1500);
                } catch (e) {
                    console.warn('[migration] open Full Disk Access settings failed:', e);
                    settingsBtn.textContent = 'Failed';
                    setTimeout(() => { settingsBtn.textContent = 'Open Settings'; }, 1500);
                }
            });
            action.appendChild(settingsBtn);

            const refreshBtn = document.createElement('button');
            refreshBtn.type = 'button';
            refreshBtn.className = 'migration-browser-copy secondary';
            refreshBtn.textContent = 'Check again';
            refreshBtn.title = 'Refresh Safari access status';
            refreshBtn.addEventListener('click', pollMigrationCompliance);
            action.appendChild(refreshBtn);

            row.appendChild(action);
        } else if (status === 'needs-install') {
            const action = document.createElement('div');
            action.className = 'migration-browser-action';

            const urlText = document.createElement('code');
            urlText.className = 'migration-browser-url';
            urlText.textContent = entry.url;
            urlText.title = entry.url;
            action.appendChild(urlText);

            const copyBtn = document.createElement('button');
            copyBtn.type = 'button';
            copyBtn.className = 'migration-browser-copy';
            copyBtn.textContent = 'Copy URL';
            copyBtn.title = `Copy URL — paste into ${entry.label} to install`;
            copyBtn.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(entry.url);
                    copyBtn.textContent = 'Copied';
                    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
                } catch (e) {
                    console.warn('[migration] clipboard write failed:', e);
                    copyBtn.textContent = 'Failed';
                    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
                }
            });
            action.appendChild(copyBtn);

            row.appendChild(action);
        } else if (status === 'needs-enable' || status === 'needs-private') {
            const hint = document.createElement('div');
            hint.className = 'migration-browser-hint';
            hint.textContent = status === 'needs-enable'
                ? `Enable ReDD Focus in ${entry.label}'s extensions settings.`
                : `Allow ReDD Focus in private/incognito browsing in ${entry.label}'s extensions settings.`;
            row.appendChild(hint);
        }

        container.appendChild(row);
    }

    // Show the "How to install" instructions only when at least one
    // browser still needs the extension. Hidden when everything's
    // compliant — the user is done, no need to nag.
    const howto = document.getElementById('migration-howto');
    const anyMissing = keys.some(k => browserComplianceStatus(k, browsers[k]) !== 'compliant');
    if (howto) howto.classList.toggle('hidden', !anyMissing);

    // Tick the checklist as "done" only once every detected browser
    // is compliant. "any" was misleading — if Firefox was set up but
    // Brave still needed installing, the checklist would mark itself
    // green even though there's still work to do.
    if (checklistItem) {
        const allCompliant = keys.length > 0
            && keys.every(k => browserComplianceStatus(k, browsers[k]) === 'compliant');
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
}

// While the post-cleanup screen is open, periodically re-check
// extension compliance so the checklist ticks itself off when the
// user comes back from the store.
async function pollMigrationCompliance() {
    if (!migrationOnboardingActive) return;
    try {
        const fresh = await invoke('onboarding_state');
        renderBrowserInstallButtons(fresh);
    } catch (e) { /* no-op */ }
}
window.addEventListener('focus', () => {
    if (migrationOnboardingActive) pollMigrationCompliance();
});

// Persistent low-key banner for users who upgraded from v1.x.
// Different from the one-time welcome overlay: this stays around
// across launches as an ongoing reminder that the blocking
// architecture changed. Auto-hides when:
//   - user explicitly dismisses (× button), OR
//   - every detected browser is fully compliant (they're done),
//   - or the user is on a fresh install with no v1.x history
//     (`user_came_from_v1x` returns false).
async function updateBehaviourChangeBanner(state) {
    const banner = document.getElementById('behaviour-change-banner');
    if (!banner) return;

    let cameFromV1x = false;
    try { cameFromV1x = await invoke('user_came_from_v1x'); }
    catch (_) { /* Tauri command may not be available on iOS — no-op */ }

    const dismissed = !!localStorage.getItem(BEHAVIOUR_CHANGE_DISMISSED_KEY);

    // Compute "are they done with extension setup yet?". Same gate
    // as the welcome screen — every detected browser must be
    // fully compliant.
    const browsers = (state && state.browsers) || {};
    const detectedKeys = Object.keys(BROWSER_STORE_LINKS).filter(k => browsers[k] && browsers[k].installed);
    const allCompliant = detectedKeys.length > 0
        && detectedKeys.every(k => browserComplianceStatus(k, browsers[k]) === 'compliant');

    const shouldShow = cameFromV1x && !dismissed && !allCompliant;
    if (!shouldShow) {
        banner.classList.add('hidden');
        return;
    }
    banner.classList.remove('hidden');

    const helpBtn = document.getElementById('behaviour-change-help');
    const dismissBtn = document.getElementById('behaviour-change-dismiss');
    if (helpBtn && !helpBtn._listenerAdded) {
        helpBtn._listenerAdded = true;
        helpBtn.addEventListener('click', async () => {
            // Re-open the post-cleanup overlay so the user gets the
            // checklist + per-browser URLs again. Same UI, same code
            // path as the first-launch flow.
            try {
                const fresh = await invoke('onboarding_state');
                migrationOnboardingDismissed = false;
                await showMigrationOnboarding('post', fresh, { mode: 'fresh' });
            } catch (e) { console.warn('[behaviour] reopen failed:', e); }
        });
    }
    if (dismissBtn && !dismissBtn._listenerAdded) {
        dismissBtn._listenerAdded = true;
        dismissBtn.addEventListener('click', () => {
            try { localStorage.setItem(BEHAVIOUR_CHANGE_DISMISSED_KEY, String(Date.now())); }
            catch (_) { /* harmless */ }
            banner.classList.add('hidden');
        });
    }
}

function updateExtensionComplianceBanner(state) {
    const banner = document.getElementById('extension-compliance-banner');
    const text = document.getElementById('extension-compliance-text');
    const dismiss = document.getElementById('extension-compliance-dismiss');
    if (!banner) return;

    if (state.extension_compliant) {
        banner.classList.add('hidden');
        return;
    }

    const failing = findFirstNonCompliantBrowser(state.browsers);
    if (text) {
        text.textContent = failing
            ? failing === 'Safari'
                ? `Safari is unavailable until ReDD Block can verify ReDD Focus. Grant Full Disk Access, install ReDD Focus, enable it, and allow it in Private Browsing.`
                : `ReDD Focus isn't fully enabled in ${failing}. Install, enable it, and allow it in private browsing.`
            : 'Install the ReDD Focus extension to block websites.';
    }
    if (dismiss) {
        dismiss.onclick = () => banner.classList.add('hidden');
    }
    banner.classList.remove('hidden');
}

function findFirstNonCompliantBrowser(browsers) {
    if (!browsers) return null;
    const labels = {
        firefox: 'Firefox', chrome: 'Chrome', brave: 'Brave', edge: 'Edge', safari: 'Safari',
    };
    for (const key of Object.keys(labels)) {
        const b = browsers[key];
        if (!b || !b.present) continue;
        const def = (b.profiles || []).find(p => p.isDefault) || (b.profiles || [])[0];
        if (!def) continue;
        const okInstalled = def.installed;
        const okEnabled = def.enabled === true;
        const okPriv = def.privateBrowsing === true;
        if (!(okInstalled && okEnabled && okPriv)) return labels[key];
    }
    return null;
}

// Check if the helper daemon is available (desktop only)
async function checkHelperStatus() {
    if (isIOS) return; // iOS uses Screen Time, not helper daemon
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
function isHelperInstallCancelled(errorMsg) {
    if (!errorMsg || typeof errorMsg !== 'string') return false;
    return errorMsg.startsWith('cancelled:') || errorMsg.toLowerCase().includes('cancelled');
}

/** True if the error indicates the helper daemon is not reachable (e.g. connection refused on Windows). */
function isHelperConnectionError(errorMsg) {
    if (!errorMsg || typeof errorMsg !== 'string') return false;
    return errorMsg.includes('Failed to connect to helper') || errorMsg.includes('refused') || errorMsg.includes('10061');
}

// Check Screen Time authorization (iOS only)
async function checkScreentimeAuth() {
    try {
        const result = await tauriAPI.screentimeCheckAuth();
        screentimeAuthorized = result.granted;
        console.log('Screen Time auth status:', result.status);
        if (!screentimeAuthorized) {
            console.log('Screen Time not authorized - will prompt on first block');
        }
    } catch (err) {
        console.error('Error checking Screen Time auth:', err);
        screentimeAuthorized = false;
    }
    updateOnboardingVisibility();
}

// Request Screen Time authorization (iOS only)
async function requestScreentimeAuth() {
    try {
        const result = await tauriAPI.screentimeRequestAuth();
        screentimeAuthorized = result.granted;
        console.log('Screen Time auth result:', result);
        return result;
    } catch (err) {
        console.error('Error requesting Screen Time auth:', err);
        screentimeAuthorized = false;
        return { granted: false, status: 'error', error: err.toString() };
    }
}

async function initializeIOSBlockingState() {
    // Sync lastBlockedDomains from active (non-paused) blocks so pause/resume works after restart
    const now = Date.now();
    const activeDomains = new Set();
    appData.activeBlocks
        .filter(b => b.startTime <= now && b.endTime > now && !b.isPaused)
        .forEach(b => {
            const bl = appData.blocklists.find(bl => bl.id === b.blocklistId);
            if (bl && bl.websites) bl.websites.forEach(d => activeDomains.add(d));
        });
    lastBlockedDomains = activeDomains;
    // Re-register DeviceActivity schedules so background activation survives app restarts.
    await syncSchedulesToHelper();
}

function updateOnboardingVisibility() {
    const eulaOverlay = document.getElementById('eula-onboarding');
    const screentimeOverlay = document.getElementById('ios-screentime-onboarding');
    const main = document.getElementById('main-content');
    const showEula = !hasAcceptedEula();
    const showScreentime = isIOS && !showEula && !screentimeAuthorized;

    eulaOverlay?.classList.toggle('hidden', !showEula);
    screentimeOverlay?.classList.toggle('hidden', !showScreentime);
    main?.classList.toggle('hidden', showEula || showScreentime);
}

async function acceptEula() {
    if (!appData.settings) {
        appData.settings = {};
    }
    const alreadyAccepted = getAcceptedEulaRevision() === CURRENT_EULA_REVISION;
    forceShowEulaThisSession = false;
    if (!alreadyAccepted) {
        appData.settings.eulaAcceptedRevision = CURRENT_EULA_REVISION;
        appData.settings.eulaAcceptedAt = Date.now();
        await saveData();
    }
    if (isIOS) {
        await checkScreentimeAuth();
    } else {
        updateOnboardingVisibility();
    }
    await runPostAcceptanceStartup();
}

async function openExternal(target) {
    try {
        await openUrl(target);
    } catch {
        window.open(target, '_blank', 'noopener,noreferrer');
    }
}

// Load data from main process
async function loadData() {
    appData = await tauriAPI.loadData();
    let shouldSave = false;
    if (!appData || !appData.blocklists) {
        appData = {
            blocklists: [],
            activeBlocks: [],
            schedules: [],
            settings: {}
        };
    }
    // Ensure schedules array exists for older data
    if (!appData.schedules) {
        appData.schedules = [];
    }
    // Ensure settings exists
    if (!appData.settings) {
        appData.settings = {};
    }
    if (normalizeLoadedEulaState()) {
        shouldSave = true;
    }
    appData.blocklists = (appData.blocklists || []).map(normalizeBlocklist);
    // Create default blocklist on first launch (no blocklists yet)
    if (appData.blocklists.length === 0) {
        appData.blocklists.push({
            id: generateId(),
            name: 'Distractions',
            mode: 'blocklist',
            websites: ['instagram.com', 'youtube.com', 'reddit.com'],
            apps: [],
            iosScreenTimeSelection: null,
            overrideDifficulty: {
                type: 'random-words',
                count: 50
            }
        });
        // Mark onboarding as complete for backwards compat
        appData.settings.onboardingComplete = true;
        shouldSave = true;
    }

    if (shouldSave) {
        await saveData();
    }
}

// Save data to main process
async function saveData() {
    await tauriAPI.saveData(appData);
}

/// Run expiry once (e.g. on app load) so in-memory state matches Screen Time / helper.
/// Clears expired blocks and pause state, then syncs to plugin/helper.
async function runExpiryOnce() {
    const now = Date.now();
    let changed = false;

    // Clear expired pause on blocks
    for (const block of appData.activeBlocks) {
        if (block.isPaused && block.pauseEndTime && block.pauseEndTime <= now) {
            delete block.isPaused;
            delete block.pauseEndTime;
            changed = true;
        }
    }
    // Clear expired pause on schedules
    if (appData.schedules) {
        for (const schedule of appData.schedules) {
            if (schedule.isPaused && schedule.pauseEndTime && schedule.pauseEndTime <= now) {
                delete schedule.isPaused;
                delete schedule.pauseEndTime;
                changed = true;
            }
        }
    }
    // Remove expired blocks
    const prevCount = appData.activeBlocks.length;
    appData.activeBlocks = appData.activeBlocks.filter(b => b.endTime > now);
    if (appData.activeBlocks.length !== prevCount) changed = true;

    // Remove expired schedules (date-limited or non-repeating past end)
    if (appData.schedules && appData.schedules.length > 0) {
        const nowDate = new Date(now);
        const expiredIds = [];
        for (const schedule of appData.schedules) {
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
            appData.schedules = appData.schedules.filter(s => !expiredIds.includes(s.id));
            changed = true;
        }
    }

    if (!changed) return;
    await saveData();
    await updateHostsFile();
    await syncSchedulesToHelper();
    await updateBlockedApps();
}

// Compare semver versions - returns true if versionA > versionB
function isVersionHigher(versionA, versionB) {
    const partsA = versionA.split('.').map(Number);
    const partsB = versionB.split('.').map(Number);

    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
        const a = partsA[i] || 0;
        const b = partsB[i] || 0;
        if (a > b) return true;
        if (a < b) return false;
    }
    return false; // Equal versions
}

// Detect platform for window controls and iOS
function detectPlatform() {
    // Check for iOS (Tauri iOS uses a WKWebView with standard iOS user agent)
    const isIOSDevice = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    if (isIOSDevice) {
        isIOS = true;
        document.body.classList.add('ios');
        // iPhone / iPod (anything not iPad): used for layout (e.g. hide week calendar)
        const isIPad = /iPad/.test(navigator.userAgent) ||
            (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        if (!isIPad) {
            document.body.classList.add('ios-phone');
        }
        // Hide desktop-only UI on iOS
        document.getElementById('window-controls')?.classList.add('hidden');
        document.querySelector('.title-bar')?.classList.add('hidden');
        // Hide helper-related settings section on iOS
        document.getElementById('helper-settings-section')?.classList.add('hidden');

        // On iOS, app blocking uses Screen Time tokens (not app names).
        // Hide the text input for apps and show only the picker button.
        const appInput = document.getElementById('app-input');
        if (appInput) appInput.style.display = 'none';
        const modalAppInput = document.getElementById('modal-app-input');
        if (modalAppInput) modalAppInput.style.display = 'none';



        // Update hint/tooltip for modal — find via modal-app-input's parent
        const modalAppGroup = document.querySelector('#modal-app-input')?.closest('.form-group');
        if (modalAppGroup) {
            const modalTooltip = modalAppGroup.querySelector('.info-tooltip');
            if (modalTooltip) modalTooltip.textContent = 'On iOS, apps are selected using Apple\'s Screen Time picker. Tap the button to choose which apps to block.';
        }

        // Make the browse buttons more prominent (full-width) since they're the only option
        document.querySelectorAll('.browse-btn').forEach(btn => {
            btn.style.width = '100%';
            btn.style.justifyContent = 'center';
            btn.style.padding = '10px';
            btn.title = 'Select Apps (Screen Time)';
            // Add text label next to the icon
            if (!btn.querySelector('.browse-label')) {
                const label = document.createElement('span');
                label.className = 'browse-label';
                label.textContent = ' Select Apps';
                label.style.marginLeft = '6px';
                label.style.fontSize = '13px';
                btn.appendChild(label);
            }
        });
    } else {
        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        if (isMac) {
            document.body.classList.add('mac');
            // Hide controls on macOS - native traffic lights are used
            document.getElementById('window-controls')?.classList.add('hidden');
        } else {
            document.body.classList.add('windows');
            // Show controls on Windows
            document.getElementById('window-controls')?.classList.remove('hidden');
        }
    }
}

// Update window height to fit content
function updateWindowHeight() {
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

// Update maximize button icon based on window state
async function updateMaximizeButton() {
    const maximizeBtn = document.getElementById('titlebar-maximize');
    const maximizeIcon = document.getElementById('maximize-icon');
    const restoreIcon = document.getElementById('restore-icon');

    if (!maximizeBtn || !maximizeIcon || !restoreIcon) return;

    const win = getCurrentWindow();
    const isMaximized = await win.isMaximized();

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

// Setup event listeners
function setupEventListeners() {
    // When the user comes back to ReDD Block after visiting System
    // Settings or the browser extension store, re-run the onboarding
    // state check so the compliance banner clears once the user has
    // installed the extension.
    window.addEventListener('focus', () => {
        if (!isIOS && startupInitializationComplete) {
            runDesktopOnboarding().catch(() => {});
        }
    });

    // Window controls (using Tauri docs naming)
    document.getElementById('titlebar-minimize')?.addEventListener('click', () => {
        tauriAPI.minimizeWindow();
    });

    document.getElementById('titlebar-maximize')?.addEventListener('click', async () => {
        await tauriAPI.maximizeWindow();
        // Update icon after state changes
        setTimeout(updateMaximizeButton, 100);
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
        const originalText = eulaContinueBtn.textContent;
        eulaContinueBtn.disabled = true;
        eulaContinueBtn.textContent = 'Continuing...';
        try {
            await acceptEula();
        } catch (err) {
            console.error('Failed to accept EULA:', err);
            alert('Could not save your agreement. Please try again.');
            eulaContinueBtn.disabled = !eulaCheckbox.checked;
            eulaContinueBtn.textContent = originalText;
            return;
        }
        eulaContinueBtn.textContent = originalText;
    });

    document.querySelectorAll('#eula-onboarding a[data-external-url]').forEach((link) => {
        link.addEventListener(
            'click',
            (event) => {
                const url = link.dataset.externalUrl;
                if (!url) return;
                event.preventDefault();
                event.stopImmediatePropagation();
                openUrl(url).catch((err) => {
                    console.warn('[eula] open in browser failed:', err);
                    window.open(url, '_blank', 'noopener,noreferrer');
                });
            },
            true
        );
    });

    document.querySelectorAll('#eula-onboarding [data-toggle-target]').forEach((el) => {
        el.addEventListener('click', (event) => {
            if (event.target.closest('a')) return;
            const target = document.getElementById(el.dataset.toggleTarget);
            if (!target) return;
            target.checked = !target.checked;
            target.dispatchEvent(new Event('change', { bubbles: true }));
        });
    });

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
                note.textContent = 'Screen Time access was denied. Please tap the button again, or enable ReDD Block in Settings > Screen Time > Apps With Screen Time Access.';
            } else if (result.error) {
                note.textContent = `Screen Time access failed: ${result.error}`;
            }
        }
        updateOnboardingVisibility();

        btn.disabled = false;
        btn.textContent = originalText;
    });

    // Initial check for maximize state
    updateMaximizeButton();

    // Check periodically to catch state changes (double-click title bar, etc.)
    // This ensures the icon updates even if window is maximized/restored via other means
    setInterval(updateMaximizeButton, 300);

    // Time pickers - custom popover handlers
    document.querySelectorAll('.time-part').forEach(btn => {
        btn.addEventListener('click', handleTimePartClick);
    });

    // Close popovers on outside click
    document.addEventListener('click', handlePopoverOutsideClick);

    // Click on background to deselect blocklists
    document.addEventListener('click', (e) => {
        // Don't deselect if clicking on interactive elements
        if (e.target.closest('.blocklist-card') ||
            e.target.closest('.scheduler-section') ||
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
        if (selectedBlocklistId) {
            deselectBlocklist();
        }
    });

    // Close blocklist card menus when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.blocklist-menu-wrapper')) {
            closeAllBlocklistMenus();
        }
    });

    // ESC: close blocklist add/edit modal if open, otherwise deselect blocklist
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const blocklistModal = document.getElementById('blocklist-modal');
        if (blocklistModal && !blocklistModal.classList.contains('hidden')) {
            closeBlocklistModal();
            e.preventDefault();
            return;
        }
        if (selectedBlocklistId) {
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
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        // 3) Both fields empty of pending text — pop stack
        if (blocklistModalUndoStack.length > 0) {
            blocklistModalApplyingUndo = true;
            const entry = blocklistModalUndoStack.pop();
            try {
                entry.undo();
            } finally {
                blocklistModalApplyingUndo = false;
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

    // Duration picker - quick toggle buttons
    document.querySelectorAll('.duration-quick-btn').forEach(btn => {
        btn.addEventListener('click', handleDurationQuickBtn);
    });

    // Duration mode toggle ("for a bit" / "always")
    document.getElementById('duration-mode-timed')?.addEventListener('click', () => setAlwaysOnMode(false));
    document.getElementById('duration-mode-always')?.addEventListener('click', () => setAlwaysOnMode(true));

    // Initialize time picker with defaults
    initializeTimeInputs();

    // Blocklist selector
    document.getElementById('blocklist-select').addEventListener('change', handleBlocklistSelect);

    // Start block button
    document.getElementById('start-block-btn').addEventListener('click', startBlock);

    // Add blocklist button
    document.getElementById('add-blocklist-btn').addEventListener('click', () => openBlocklistModal());

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

    // Schedule confirmation modal buttons
    document.getElementById('cancel-schedule-confirm-btn')?.addEventListener('click', closeScheduleConfirmModal);
    document.getElementById('proceed-schedule-confirm-btn')?.addEventListener('click', proceedWithSchedule);

    // Week calendar navigation buttons
    document.getElementById('prev-week-btn')?.addEventListener('click', () => navigateWeek(-1));
    document.getElementById('next-week-btn')?.addEventListener('click', () => navigateWeek(1));
    document.getElementById('today-btn')?.addEventListener('click', () => scrollToToday());

    // Schedule mode tabs
    document.getElementById('instant-mode-tab')?.addEventListener('click', () => setScheduleMode(false));
    document.getElementById('schedule-mode-tab')?.addEventListener('click', () => setScheduleMode(true));

    // Add segment button
    document.getElementById('add-segment-btn')?.addEventListener('click', addScheduleSegment);

    // Start schedule button
    document.getElementById('start-schedule-btn')?.addEventListener('click', startSchedule);

    // Repeat dropdown (renamed from Until)
    document.getElementById('repeat-dropdown-btn')?.addEventListener('click', toggleRepeatDropdown);
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

    // Week calendar scroll handling with day snap
    const calendarScroll = document.querySelector('.week-calendar-scroll');
    const timeColumn = document.getElementById('week-calendar-time-column');
    if (calendarScroll) {
        let scrollTimeout;
        calendarScroll.addEventListener('scroll', () => {
            // Keep the time sidebar's vertical scroll in lockstep with the day grid.
            if (timeColumn) timeColumn.scrollTop = calendarScroll.scrollTop;

            clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(() => {
                // Update the visible date range display
                updateVisibleRangeDisplay();
            }, 150);
        });

        // Forward wheel-over-sidebar to the main scroll so the time column isn't an interaction dead zone.
        if (timeColumn) {
            timeColumn.addEventListener('wheel', (e) => {
                if (e.deltaY !== 0) {
                    calendarScroll.scrollTop += e.deltaY;
                    e.preventDefault();
                }
            }, { passive: false });
        }

        // Click on calendar (not on block) scrolls to today
        calendarScroll.addEventListener('click', (e) => {
            if (!e.target.closest('.calendar-block')) {
                scrollToToday();
            }
        });
    }

    // Listen for blocks updated from main process
    tauriAPI.onBlocksUpdated(async () => {
        await loadData();
        render();
    });
}



// Validate that a string looks like a valid domain (e.g. reddit.com, example.co.uk)
function isValidDomain(str) {
    // Strip protocol and path if user pasted a URL
    let domain = str.replace(/^https?:\/\//i, '').split('/')[0].split('?')[0].split('#')[0];
    // Must have at least one dot, only valid domain chars, and a TLD of 2+ chars
    return /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain);
}

// Clean a user input string into a domain
function cleanDomainInput(str) {
    return str.replace(/^https?:\/\//i, '').split('/')[0].split('?')[0].split('#')[0].toLowerCase().trim();
}

// Parse input that may contain multiple domains (space, newline, or comma separated)
function parseDomainList(raw) {
    if (!raw || !raw.trim()) return [];
    return raw.split(/\s+|,/).map(s => cleanDomainInput(s)).filter(Boolean);
}

/** Process raw website input: parse, validate, classify. Returns result for keydown/save handlers. */
function processWebsiteInput(raw) {
    const domains = parseDomainList(raw);
    const invalid = domains.filter(d => !isValidDomain(d));
    const valid = domains.filter(d => isValidDomain(d));
    const protectedList = valid.filter(d => isProtectedDomain(d));
    const toAdd = valid.filter(d => !isProtectedDomain(d));
    return {
        invalid,
        toAdd,
        websiteInvalid: invalid.length > 0,
        inputValueToSet: invalid.length === 0 ? '' : invalid.join(' '),
        hadProtected: protectedList.length > 0
    };
}

// Modal listeners
function setupModalListeners() {
    let modalWebsites = [];
    let modalApps = [];
    let modalIOSScreenTimeSelection = null;

    const getModalDisplayApps = () => {
        const displayApps = [...modalApps];
        const screenTimeLabel = formatIOSScreenTimeSelectionLabel(modalIOSScreenTimeSelection);
        if (screenTimeLabel) {
            displayApps.push(screenTimeLabel);
        }
        return displayApps;
    };

    const modalWebsiteInput = document.getElementById('modal-website-input');
    const modalAppInput = document.getElementById('modal-app-input');
    const modalWebsitesTags = document.getElementById('modal-websites-tags');
    const modalAppsTags = document.getElementById('modal-apps-tags');

    // Close modal when clicking outside content
    document.getElementById('blocklist-modal').addEventListener('click', (e) => {
        if (e.target.classList.contains('modal-overlay')) {
            closeBlocklistModal();
        }
    });

    document.getElementById('blocklist-name').addEventListener('input', () => {
        const nameInput = document.getElementById('blocklist-name');
        nameInput.classList.remove('input-error');
        const previous = lastBlocklistNameValue;
        pushModalUndo('name', () => {
            nameInput.value = previous;
            lastBlocklistNameValue = previous;
            nameInput.classList.remove('input-error');
        });
        lastBlocklistNameValue = nameInput.value;
    });

    modalWebsiteInput.addEventListener('keydown', (e) => {
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
        // Enter or Space confirms the website(s) — supports multiple domains separated by space, newline, or comma
        if ((e.key === 'Enter' || e.key === ' ') && modalWebsiteInput.value.trim()) {
            e.preventDefault();
            const result = processWebsiteInput(modalWebsiteInput.value.trim());
            const errorMsg = document.getElementById('website-input-error');

            if (result.websiteInvalid) {
                if (errorMsg) {
                    errorMsg.classList.remove('hidden');
                    setTimeout(() => errorMsg.classList.add('hidden'), 3000);
                }
            } else {
                if (errorMsg) errorMsg.classList.add('hidden');
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
        }
    });

    modalAppInput.addEventListener('keydown', (e) => {
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
        if (e.key === 'Enter' && modalAppInput.value.trim()) {
            e.preventDefault();
            const app = modalAppInput.value.trim();
            if (isProtectedApp(app)) {
                // Show brief warning — ReDD Block cannot block itself
                modalAppInput.value = '';
                modalAppInput.placeholder = tSettings('cannotBlockSelfAppPlaceholder');
                modalAppInput.classList.add('input-error');
                setTimeout(() => {
                    modalAppInput.placeholder = tSettings('placeholderAppExample');
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
    if (isIOS && modalBrowseBtn) {
        modalBrowseBtn.addEventListener('click', async () => {
            try {
                const result = await tauriAPI.showActivityPicker({
                    initialApplicationTokenData: modalIOSScreenTimeSelection?.applicationTokens || [],
                    initialCategoryTokenData: modalIOSScreenTimeSelection?.categoryTokens || []
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
            const appNames = await tauriAPI.openAppPicker();
            if (appNames && appNames.length > 0) {
                const toAdd = appNames.filter(n => !modalApps.includes(n));
                if (toAdd.length > 0) {
                    const toAddCopy = [...toAdd];
                    pushModalUndo('app', () => {
                        toAddCopy.forEach(a => {
                            const i = modalApps.indexOf(a);
                            if (i !== -1) modalApps.splice(i, 1);
                        });
                        window.renderModalTags();
                    });
                }
                let added = false;
                for (const appName of appNames) {
                    if (!modalApps.includes(appName)) {
                        modalApps.push(appName);
                        added = true;
                    }
                }
                if (added) {
                    window.renderModalTags();
                }
            }
        });
    }
    // Override type
    document.getElementById('override-type').addEventListener('change', (e) => {
        const overrideTypeSelect = e.target;
        const previousType = lastOverrideTypeValue;
        pushModalUndo('override-type', () => {
            overrideTypeSelect.value = previousType;
            lastOverrideTypeValue = previousType;
            overrideTypeSelect.dispatchEvent(new Event('change'));
        });

        const type = e.target.value;
        const overrideCountInput = document.getElementById('override-count');
        applyOverrideTypeUi(type);

        // Clamp to the new type-specific max when switching types.
        overrideCountInput.value = normalizeOverrideCount(overrideCountInput.value, type);
        lastOverrideTypeValue = overrideTypeSelect.value;

        const maxDifficultyCb = document.getElementById('override-max-difficulty-checkbox');
        if (maxDifficultyCb && maxDifficultyCb.checked && type !== 'custom') {
            const maxCount = getMaxOverrideCharsForType(type);
            overrideCountInput.value = String(maxCount);
            overrideCountInput.max = String(maxCount);
            lastOverrideCountValue = overrideCountInput.value;
            setOverrideCountMaxMode(true);
        }
    });
    document.getElementById('override-max-difficulty-checkbox').addEventListener('change', (e) => {
        const checked = e.target.checked;
        const overrideTypeSelect = document.getElementById('override-type');
        const overrideCountInput = document.getElementById('override-count');
        if (checked) {
            lastOverrideTypeValueBeforeMaxDifficulty = overrideTypeSelect.value;
            lastOverrideCountValueBeforeMaxDifficulty = overrideCountInput.value.trim() || lastOverrideCountValueBeforeMaxDifficulty;
            const type = overrideTypeSelect.value;
            applyOverrideTypeUi(type);
            const maxCount = getMaxOverrideCharsForType(type);
            overrideCountInput.value = String(maxCount);
            overrideCountInput.max = String(maxCount);
            lastOverrideCountValue = overrideCountInput.value;
            setOverrideCountMaxMode(true);
            updateOverridePreview(); // preview must reflect max count (set just above)
        } else {
            const typeToRestore = lastOverrideTypeValueBeforeMaxDifficulty;
            overrideTypeSelect.value = typeToRestore;
            applyOverrideTypeUi(typeToRestore);
            const maxChars = getMaxOverrideCharsForType(typeToRestore);
            overrideCountInput.max = String(maxChars);
            overrideCountInput.value = normalizeOverrideCount(String(lastOverrideCountValueBeforeMaxDifficulty), typeToRestore);
            lastOverrideCountValue = overrideCountInput.value;
            lastOverrideCountValueBeforeMaxDifficulty = overrideCountInput.value;
            setOverrideCountMaxMode(false);
            updateOverridePreview(); // preview must reflect restored count (set just above)
        }
    });
    document.getElementById('custom-override-text').addEventListener('input', (e) => {
        const customTextArea = e.target;
        const previous = lastCustomOverrideTextValue;
        pushModalUndo('custom-override-text', () => {
            customTextArea.value = previous;
            lastCustomOverrideTextValue = previous;
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
        lastCustomOverrideTextValue = e.target.value;
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
        const previous = lastOverrideCountValue;
        const current = overrideCountInput.value;
        if (previous !== current) {
            pushModalUndo('override-count', () => {
                overrideCountInput.value = previous;
                lastOverrideCountValue = previous;
            });
        }

        const warningEl = document.getElementById('override-count-warning');
        const overrideType = document.getElementById('override-type')?.value || 'random-words';
        const maxChars = getMaxOverrideCharsForType(overrideType);
        e.target.max = String(maxChars);
        const rawValue = e.target.value.trim();
        if (rawValue === '') {
            warningEl.classList.add('hidden');
            warningEl.textContent = '';
            lastOverrideCountValue = e.target.value;
            updateOverridePreview();
            return;
        }

        const parsed = parseInt(rawValue, 10);
        if (Number.isFinite(parsed) && parsed > maxChars) {
            const charsPerMinute = getTypingCharsPerMinuteForType(overrideType);
            const estimatedMinutes = Math.ceil(maxChars / charsPerMinute);
            e.target.value = maxChars;
            warningEl.textContent = `Max is ${maxChars} characters so it's still possible to override in case of emergency (takes you ~${estimatedMinutes} minutes to type).`;
            warningEl.classList.remove('hidden');
        } else {
            warningEl.classList.add('hidden');
            warningEl.textContent = '';
        }
        lastOverrideCountValue = e.target.value;
        updateOverridePreview();
    });
    document.getElementById('override-count').addEventListener('blur', (e) => {
        const overrideType = document.getElementById('override-type')?.value || 'random-words';
        e.target.value = normalizeOverrideCount(e.target.value, overrideType);
        updateOverridePreview();
    });

    // Color swatches
    document.querySelectorAll('.color-swatch').forEach(swatch => {
        swatch.addEventListener('click', () => {
            document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
            swatch.classList.add('selected');
        });
    });

    // Custom color picker
    const customColorInput = document.getElementById('custom-color-input');
    const customSwatch = document.getElementById('custom-color-swatch');
    if (customColorInput && customSwatch) {
        // Trigger input when swatch is clicked
        customSwatch.addEventListener('click', () => {
            customColorInput.click();
        });

        customColorInput.addEventListener('input', (e) => {
            const color = e.target.value;
            customSwatch.style.background = color;
            customSwatch.dataset.color = color;
            document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
            customSwatch.classList.add('selected');
        });
    }

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
        // Toggle popover on swatch click
        customEmojiSwatch.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();

            if (emojiPickerPopover.classList.contains('hidden')) {
                // Position the popover above the button using fixed positioning
                const rect = customEmojiSwatch.getBoundingClientRect();
                emojiPickerPopover.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
                emojiPickerPopover.style.right = (window.innerWidth - rect.right) + 'px';
                emojiPickerPopover.classList.remove('hidden');
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
            blocklistAdvancedToggle.classList.toggle('expanded');
            blocklistAdvancedContent.classList.toggle('hidden');
        });
    }

    // Cancel button
    document.getElementById('cancel-blocklist-btn').addEventListener('click', () => {
        closeBlocklistModal();
    });

    // Save button
    document.getElementById('save-blocklist-btn').addEventListener('click', () => {
        const nameInput = document.getElementById('blocklist-name');
        const name = nameInput.value.trim();
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
            const result = processWebsiteInput(pendingWebsiteRaw);
            const errorMsg = document.getElementById('website-input-error');

            if (result.websiteInvalid) {
                if (errorMsg) {
                    errorMsg.classList.remove('hidden');
                    setTimeout(() => errorMsg.classList.add('hidden'), 3000);
                }
                websiteInvalid = true;
            } else {
                if (errorMsg) errorMsg.classList.add('hidden');
            }

            if (result.hadProtected) {
                modalWebsiteInput.value = '';
                modalWebsiteInput.placeholder = tSettings('cannotBlockDomainPlaceholder');
                modalWebsiteInput.classList.add('input-error');
                setTimeout(() => {
                    modalWebsiteInput.placeholder = tSettings('placeholderWebsiteExample');
                    modalWebsiteInput.classList.remove('input-error');
                }, 2000);
                return; // Block save so behavior matches explicit add interactions.
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
            }
            result.toAdd.forEach(pendingWebsite => {
                if (!modalWebsites.includes(pendingWebsite)) modalWebsites.push(pendingWebsite);
            });
            if (result.toAdd.length > 0) window.renderModalTags();
            modalWebsiteInput.value = result.inputValueToSet;
        }

        if (nameEmpty || websiteInvalid) return;

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

        const mode = 'blocklist'; // Allowlist mode not yet implemented
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
        const emoji = selectedEmoji ? selectedEmoji.dataset.emoji : '🚫';

        const showItemDetails = document.getElementById('show-item-details-checkbox').checked;
        const alwaysShowInSchedule = document.getElementById('always-show-in-schedule-checkbox').checked;

        const overrideDifficultyPayload = {
            type: overrideType,
            count: overrideCount,
            maxDifficulty: maxDifficultyChecked,
            customText: customText
        };
        if (maxDifficultyChecked) {
            overrideDifficultyPayload.countBeforeMax = normalizeOverrideCount(
                String(lastOverrideCountValueBeforeMaxDifficulty),
                lastOverrideTypeValueBeforeMaxDifficulty
            );
            overrideDifficultyPayload.typeBeforeMax = lastOverrideTypeValueBeforeMaxDifficulty;
        }

        // IMPORTANT: Create copies of the arrays, not references!
        const blocklist = {
            id: editingBlocklistId || generateId(),
            name,
            mode,
            color,
            emoji,
            websites: [...modalWebsites],  // Copy the array
            apps: [...modalApps],          // Copy the array
            iosScreenTimeSelection: cloneIOSScreenTimeSelection(modalIOSScreenTimeSelection),
            showItemDetails,
            alwaysShowInSchedule,
            overrideDifficulty: overrideDifficultyPayload
        };

        if (editingBlocklistId) {
            const idx = appData.blocklists.findIndex(bl => bl.id === editingBlocklistId);
            if (idx !== -1) {
                appData.blocklists[idx] = blocklist;
            }
        } else {
            appData.blocklists.push(blocklist);
        }

        saveData();

        // If this blocklist is active (block or schedule), update blocking rules immediately
        const now = Date.now();
        const hasActiveBlock = appData.activeBlocks.some(
            b => b.blocklistId === blocklist.id && b.startTime <= now && b.endTime > now
        );
        const hasActiveSchedule = appData.schedules?.some(
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
        blocklistModalPreviewSnapshot = null;
        closeBlocklistModal();

        // Only update blocklist display without resetting schedule segments
        renderBlocklists();
        renderBlocklistSelector();
        renderWeekBlocks(); // Refresh calendar to apply alwaysShowInSchedule changes

        // Re-trigger blocklist selection to update button text (name may have changed)
        if (selectedBlocklistId) {
            const dropdown = document.getElementById('blocklist-select');
            if (dropdown) {
                dropdown.value = selectedBlocklistId;
                handleBlocklistSelect({ target: dropdown });
            }
        }
    });

    // Store references for modal functions
    window.modalWebsites = modalWebsites;
    window.modalApps = modalApps;
    window.lockedWebsites = [];
    window.lockedApps = [];

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
        }, window.lockedWebsites);

        const displayApps = getModalDisplayApps();
        renderTags(modalAppsTags, displayApps, (idx) => {
            const value = displayApps[idx];
            if (window.lockedApps && window.lockedApps.includes(value)) {
                return; // Do not remove locked items; do not push undo.
            }
            if (value === formatIOSScreenTimeSelectionLabel(modalIOSScreenTimeSelection)) {
                const previousSelection = cloneIOSScreenTimeSelection(modalIOSScreenTimeSelection);
                pushModalUndo('ios-screentime-selection-remove', () => {
                    modalIOSScreenTimeSelection = cloneIOSScreenTimeSelection(previousSelection);
                    window.renderModalTags();
                });
                modalIOSScreenTimeSelection = null;
            } else {
                const appIdx = modalApps.indexOf(value);
                if (appIdx === -1) return;
                pushModalUndo('app', () => {
                    modalApps.splice(appIdx, 0, value);
                    window.renderModalTags();
                });
                modalApps.splice(appIdx, 1);
            }
            window.renderModalTags();
        }, window.lockedApps);
    };

    window.setModalData = (websites, apps, iosScreenTimeSelection = null, lockedWebsitesList = [], lockedAppsList = []) => {
        modalWebsites.length = 0;
        modalApps.length = 0;
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
    const progressBar = document.getElementById('challenge-progress-bar');
    const challengeTextEl = document.getElementById('challenge-text');

    // Helper to render challenge text with optional error highlight
    function renderChallengeText(errorIndex = -1) {
        if (errorIndex < 0 || errorIndex >= challengeText.length) {
            challengeTextEl.textContent = challengeText;
        } else {
            // Highlight the error character
            const before = escapeHtml(challengeText.slice(0, errorIndex));
            const errorChar = escapeHtml(challengeText[errorIndex]);
            const after = escapeHtml(challengeText.slice(errorIndex + 1));
            challengeTextEl.innerHTML = `${before}<span class="error-char">${errorChar}</span>${after}`;
        }
    }

    // Prevent paste - users must type manually
    challengeInput.addEventListener('paste', (e) => {
        e.preventDefault();
    });

    challengeInput.addEventListener('input', () => {
        const typed = challengeInput.value;
        const target = challengeText;

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

        // Clear error highlighting while typing
        renderChallengeText(-1);
    });

    // Enter key submits the override
    challengeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault(); // Prevent newline in textarea
            document.getElementById('confirm-override-btn').click();
        }
    });

    document.getElementById('cancel-override-btn').addEventListener('click', () => {
        // Check for helper removal special case
        if (overrideBlockId === 'helper-removal' && window.helperRemovalCancelCallback) {
            window.helperRemovalCancelCallback();
            return;
        }
        closeOverrideModal();
    });

    // Pause block button
    document.getElementById('pause-block-btn').addEventListener('click', () => {
        if (!selectedBlocklistId) return;
        const now = Date.now();

        // Try one-off block first
        const activeBlock = appData.activeBlocks.find(b =>
            b.blocklistId === selectedBlocklistId && b.startTime <= now && b.endTime > now
        );
        if (activeBlock) {
            if (activeBlock.isPaused) {
                // Resume — show confirmation dialog
                openResumeConfirmation(selectedBlocklistId, 'block', activeBlock.id);
            } else {
                // Pause
                pauseScheduleData = null;
                openPauseModal(activeBlock.id);
            }
            return;
        }

        // Try schedule — find the currently active segment
        const schedule = appData.schedules?.find(s => s.blocklistId === selectedBlocklistId);
        if (schedule) {
            if (schedule.isPaused && schedule.pauseEndTime > now) {
                // Resume — show confirmation dialog
                openResumeConfirmation(selectedBlocklistId, 'schedule', null);
                return;
            }
            pauseScheduleData = {
                blocklistId: selectedBlocklistId,
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
    pauseChallengeInput.addEventListener('input', () => {
        const typed = pauseChallengeInput.value;
        const target = pauseChallengeText;
        const progress = target.length > 0 ? Math.min(100, (typed.length / target.length) * 100) : 0;
        document.getElementById('pause-challenge-progress-bar').style.width = `${progress}%`;

        // Enable/disable confirm button
        document.getElementById('confirm-pause-btn').disabled = (typed !== target);
    });

    pauseChallengeInput.addEventListener('keydown', (e) => {
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

    document.getElementById('confirm-override-btn').addEventListener('click', async () => {
        const typed = challengeInput.value;
        const target = challengeText;

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

        if (typed === target && (overrideBlockId || window.overrideScheduleId)) {
            // Check for helper removal special case
            if (overrideBlockId === 'helper-removal' && window.helperRemovalConfirmCallback) {
                window.helperRemovalConfirmCallback();
                return;
            }

            if (overrideBlockId && overrideBlockId !== 'helper-removal') {
                const overriddenBlock = appData.activeBlocks.find(b => b.id === overrideBlockId);
                const blocklistIdToClear = overrideBlocklistIdForHelper ?? (overriddenBlock ? overriddenBlock.blocklistId : null);
                appData.activeBlocks = appData.activeBlocks.filter(b => b.id !== overrideBlockId);
                await saveData();

                if (isIOS) {
                    await tauriAPI.screentimeClearBlock();
                    lastBlockedDomains = new Set();
                    await updateHostsFile();
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

                overrideBlocklistIdForHelper = null;
                // Update blocked apps (will stop watcher if no apps to block, including schedules)
                await updateBlockedApps();
            } else if (window.overrideScheduleId) {
                // Check which radio button is selected
                const overrideType = document.querySelector('input[name="schedule-override-type"]:checked')?.value || 'stop-schedule';
                const scheduleId = window.overrideScheduleId;
                const segmentIndex = window.overrideSegmentIndex;
                const segmentDay = window.overrideSegmentDay;

                // Only allow "just this block" if segmentIndex and segmentDay are defined
                // (i.e., only when clicking a specific block in the timeline, not from stop schedule button)
                if (overrideType === 'just-this' && segmentIndex !== undefined && segmentDay !== undefined) {
                    // "Just this block" - remove only the specific day from the segment
                    const schedule = appData.schedules.find(s => s.id === scheduleId);
                    if (schedule && schedule.segments[segmentIndex]) {
                        const segment = schedule.segments[segmentIndex];
                        // Remove this day from the segment
                        segment.days = segment.days.filter(d => d !== segmentDay);

                        // If segment has no more days, remove the entire segment
                        if (segment.days.length === 0) {
                            schedule.segments.splice(segmentIndex, 1);
                        }

                        // If schedule has no more segments, remove the entire schedule
                        if (schedule.segments.length === 0) {
                            appData.schedules = appData.schedules.filter(s => s.id !== scheduleId);
                            activeScheduleSegmentCount = 0;
                        }
                    }
                } else {
                    // "Stop schedule" - remove the entire schedule but preserve segments
                    const scheduleToStop = appData.schedules.find(s =>
                        s.id === scheduleId || s.blocklistId === scheduleId
                    );

                    if (scheduleToStop) {
                        // Load all segments from the stopped schedule into scheduleSegments
                        // so they become editable (not greyed out)
                        scheduleSegments = scheduleToStop.segments.map(seg => ({ ...seg }));
                        activeScheduleSegmentCount = 0; // No segments are locked anymore

                        // Save these segments as pending so they persist when clicking off/on
                        if (!appData.settings) appData.settings = {};
                        if (!appData.settings.pendingScheduleSegments) appData.settings.pendingScheduleSegments = {};
                        appData.settings.pendingScheduleSegments[scheduleToStop.blocklistId] = scheduleSegments.map(seg => ({ ...seg }));

                        // Remove the schedule from active schedules
                        appData.schedules = appData.schedules.filter(s =>
                            s.id !== scheduleId && s.blocklistId !== scheduleId
                        );

                        // Rebuild UI to show all segments as editable if we're viewing this blocklist
                        if (selectedBlocklistId === scheduleToStop.blocklistId && isScheduleMode) {
                            rebuildScheduleSegments();
                            disableScheduleControls(false); // Enable all controls
                        }
                    } else {
                        activeScheduleSegmentCount = 0;
                    }
                }

                // On iOS, clear both Screen Time stores so the overridden schedule's blocks are removed
                // immediately; updateHostsFile and syncSchedulesToHelper will then re-apply correct state.
                if (isIOS) {
                    await tauriAPI.screentimeClearBlock();
                    lastBlockedDomains = new Set();
                }

                await saveData();
                await updateHostsFile();
                // Sync updated schedules to helper daemon
                await syncSchedulesToHelper();
                // Update blocked apps after schedule changes
                await updateBlockedApps();

                // Reset modal title
                const titleEl = document.getElementById('override-modal-title');
                if (titleEl) {
                    titleEl.textContent = 'Override Block?';
                }

                // Hide radio options and reset for next use
                document.getElementById('schedule-override-options').classList.add('hidden');

                delete window.overrideScheduleId;
                delete window.overrideSegmentIndex;
                delete window.overrideSegmentDay;
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
            renderChallengeText(firstErrorIndex);
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
function renderTags(container, items, onRemove, lockedItems = []) {
    container.innerHTML = items.map((item, idx) => {
        const isLocked = lockedItems.includes(item);
        const lockedClass = isLocked ? 'locked' : '';
        const removeBtn = !isLocked ? `<button class="tag-remove" data-idx="${idx}">×</button>` : '';

        return `
    <span class="tag ${lockedClass}">
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
}
// Track current selected end time only (start is always 'now')
let selectedEndHour = 20;
let selectedEndMinute = 30;
let targetDurationMinutes = 60; // Default 60-minute block
let userEditedEndTime = false; // Track if user manually changed end time

// Pad number with leading zero
function pad(num) {
    return num.toString().padStart(2, '0');
}

// Disable or enable time controls (when a block is active, controls should be disabled)
function disableTimeControls(disabled) {
    const durationInput = document.getElementById('duration-minutes-input');
    const endHourBtn = document.getElementById('end-hour-btn');
    const endMinuteBtn = document.getElementById('end-minute-btn');
    const endTimeDisplay = document.getElementById('end-time-display');
    const quickSelectBtns = document.querySelectorAll('.duration-quick-btn');
    const timePickerContainer = document.getElementById('time-picker-container');

    if (durationInput) {
        durationInput.disabled = disabled;
        durationInput.style.opacity = disabled ? '0.5' : '1';
        durationInput.style.pointerEvents = disabled ? 'none' : 'auto';
    }

    if (endHourBtn) {
        endHourBtn.disabled = disabled;
        endHourBtn.style.opacity = disabled ? '0.5' : '1';
        endHourBtn.style.pointerEvents = disabled ? 'none' : 'auto';
    }

    if (endMinuteBtn) {
        endMinuteBtn.disabled = disabled;
        endMinuteBtn.style.opacity = disabled ? '0.5' : '1';
        endMinuteBtn.style.pointerEvents = disabled ? 'none' : 'auto';
    }

    if (endTimeDisplay) {
        endTimeDisplay.style.pointerEvents = disabled ? 'none' : 'auto';
    }

    quickSelectBtns.forEach(function (btn) {
        btn.disabled = disabled;
        btn.style.opacity = disabled ? '0.5' : '1';
        btn.style.pointerEvents = disabled ? 'none' : 'auto';
    });

    // Add a visual indicator to the whole container
    if (timePickerContainer) {
        timePickerContainer.classList.toggle('controls-disabled', disabled);
    }

    // Disable/enable duration mode toggle (always / for some time)
    const durationToggle = document.getElementById('duration-mode-toggle');
    if (durationToggle) {
        durationToggle.style.opacity = disabled ? '0.5' : '1';
        durationToggle.style.pointerEvents = disabled ? 'none' : 'auto';
    }
}

// Disable or enable schedule controls (when a schedule is active)
function disableScheduleControls(disabled) {
    const repeatDropdown = document.getElementById('schedule-repeat-select');
    const addSegmentBtn = document.getElementById('add-segment-btn');
    const repeatDropdownBtn = document.getElementById('repeat-dropdown-btn');
    const repeatLabel = document.querySelector('.repeat-label');
    const repeatSection = document.getElementById('schedule-repeat-section');

    // Disable repeat dropdown button and label
    if (repeatDropdownBtn) {
        repeatDropdownBtn.disabled = disabled;
        repeatDropdownBtn.style.pointerEvents = disabled ? 'none' : 'auto';
        repeatDropdownBtn.style.cursor = disabled ? 'default' : 'pointer';
        if (disabled) {
            repeatDropdownBtn.classList.add('repeat-dropdown-disabled');
        } else {
            repeatDropdownBtn.classList.remove('repeat-dropdown-disabled');
        }
    }

    // Style repeat label
    if (repeatLabel) {
        if (disabled) {
            repeatLabel.classList.add('repeat-label-disabled');
        } else {
            repeatLabel.classList.remove('repeat-label-disabled');
        }
    }

    // When schedule is active and repeat is "until date", grey out the date selector.
    // Use the persisted active schedule first so this updates immediately after starting.
    const dateWrapper = document.getElementById('repeat-date-wrapper');
    const dateInput = document.getElementById('repeat-date-input');
    if (dateWrapper && dateInput) {
        const activeSchedule = selectedBlocklistId && appData.schedules
            ? appData.schedules.find(s => s.blocklistId === selectedBlocklistId)
            : null;
        const isDateRepeatActive = !!(activeSchedule && activeSchedule.repeatType === 'date');
        const shouldDisableDateSelector = disabled && (isDateRepeatActive || scheduleRepeatType === 'date');

        if (shouldDisableDateSelector) {
            dateWrapper.classList.add('repeat-date-disabled');
            dateInput.disabled = true;
            dateInput.style.pointerEvents = 'none';
        } else {
            dateWrapper.classList.remove('repeat-date-disabled');
            dateInput.disabled = false;
            dateInput.style.pointerEvents = 'auto';
        }
    }

    // Disable Add button when schedule is active (activeScheduleSegmentCount > 0)
    if (addSegmentBtn) {
        const isScheduleActive = activeScheduleSegmentCount > 0;
        addSegmentBtn.disabled = isScheduleActive;
        addSegmentBtn.style.opacity = isScheduleActive ? '0.5' : '1';
        addSegmentBtn.style.pointerEvents = isScheduleActive ? 'none' : 'auto';
        addSegmentBtn.style.cursor = isScheduleActive ? 'not-allowed' : 'pointer';
    }

    // Disable controls on EXISTING segments (those within activeScheduleSegmentCount)
    document.querySelectorAll('.schedule-segment').forEach((segment, index) => {
        const isExistingSegment = index < activeScheduleSegmentCount;

        if (disabled && isExistingSegment) {
            // Disable this segment's controls
            segment.querySelectorAll('.time-part, .segment-day-toggle, .remove-segment-btn').forEach(el => {
                el.disabled = true;
                el.style.opacity = '0.5';
                el.style.pointerEvents = 'none';
            });
            segment.classList.add('segment-locked');
        } else {
            // Enable this segment's controls
            segment.querySelectorAll('.time-part, .segment-day-toggle, .remove-segment-btn').forEach(el => {
                el.disabled = false;
                el.style.opacity = '1';
                el.style.pointerEvents = 'auto';
            });
            segment.classList.remove('segment-locked');
        }
    });
}

// Initialize time picker with popover options (end time only)
function initializeTimeInputs() {
    const now = new Date();

    // Reset editing flag and load saved duration for this blocklist (or default to 60)
    userEditedEndTime = false;

    // Restore always-on mode preference for this blocklist
    const savedAlwaysOn = selectedBlocklistId && appData.settings?.alwaysOnMode?.[selectedBlocklistId];
    setAlwaysOnMode(savedAlwaysOn !== undefined ? !!savedAlwaysOn : true);

    if (selectedBlocklistId && appData.settings?.instantBlockDuration?.[selectedBlocklistId] !== undefined) {
        targetDurationMinutes = appData.settings.instantBlockDuration[selectedBlocklistId];
    } else {
        targetDurationMinutes = 60;
    }

    // End time = now + target duration
    const endTime = new Date(now.getTime() + targetDurationMinutes * 60 * 1000);
    selectedEndHour = endTime.getHours();
    selectedEndMinute = endTime.getMinutes();

    // Populate hour options (0-23) for end time only
    const hourContainer = document.getElementById('end-hour-options');
    if (hourContainer) {
        hourContainer.innerHTML = '';
        for (let h = 0; h < 24; h++) {
            const btn = document.createElement('button');
            btn.className = 'popover-option';
            btn.textContent = pad(h);
            btn.dataset.value = h;
            btn.dataset.type = 'hour';
            btn.dataset.target = 'end';
            btn.addEventListener('click', selectTimeOption);
            hourContainer.appendChild(btn);
        }
    }

    // Populate minute options (0-59) for end time only
    const minuteContainer = document.getElementById('end-minute-options');
    if (minuteContainer) {
        minuteContainer.innerHTML = '';
        for (let m = 0; m < 60; m++) {
            const btn = document.createElement('button');
            btn.className = 'popover-option';
            btn.textContent = pad(m);
            btn.dataset.value = m;
            btn.dataset.type = 'minute';
            btn.dataset.target = 'end';
            btn.addEventListener('click', selectTimeOption);
            minuteContainer.appendChild(btn);
        }
    }

    // Update displays
    updateTimeDisplay();
    handleTimeChange();

    // Initialize click handlers for schedule segment time buttons
    document.querySelectorAll('.schedule-block-panel .time-part').forEach(btn => {
        btn.addEventListener('click', handleScheduleTimeClick);
    });
}

// Update the time display buttons (end time only)
function updateTimeDisplay() {
    const endHourBtn = document.getElementById('end-hour-btn');
    const endMinuteBtn = document.getElementById('end-minute-btn');
    if (endHourBtn) endHourBtn.textContent = pad(selectedEndHour);
    if (endMinuteBtn) endMinuteBtn.textContent = pad(selectedEndMinute);

    // Update selected state in popovers
    updatePopoverSelection();
}

// Update selected state in popover options (end time only)
function updatePopoverSelection() {
    // Clear all selections
    document.querySelectorAll('.popover-option').forEach(btn => btn.classList.remove('selected'));

    // Mark current end time selections
    document.querySelectorAll('#end-hour-options .popover-option').forEach(btn => {
        if (parseInt(btn.dataset.value) === selectedEndHour) btn.classList.add('selected');
    });
    document.querySelectorAll('#end-minute-options .popover-option').forEach(btn => {
        if (parseInt(btn.dataset.value) === selectedEndMinute) btn.classList.add('selected');
    });
}

// Handle click on time part button
function handleTimePartClick(e) {
    e.stopPropagation();
    const btn = e.currentTarget;
    const type = btn.dataset.type;
    const target = btn.dataset.target;

    // Close all popovers first
    closeAllPopovers();

    // Open the relevant popover
    const popover = document.getElementById(`${target}-${type}-popover`);
    popover.classList.remove('hidden');
    btn.classList.add('active');

    // Scroll to selected option
    const selectedOption = popover.querySelector('.popover-option.selected');
    if (selectedOption) {
        selectedOption.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
}



// Select a time option from popover (end time only)
function selectTimeOption(e) {
    e.stopPropagation();
    const btn = e.currentTarget;
    const value = parseInt(btn.dataset.value);
    const type = btn.dataset.type;

    // User manually edited end time
    userEditedEndTime = true;

    // Update end time values
    if (type === 'hour') selectedEndHour = value;
    else selectedEndMinute = value;

    // Update display and close popover
    updateTimeDisplay();
    closeAllPopovers();
    handleTimeChange();
}


// Close all popovers
function closeAllPopovers() {
    document.querySelectorAll('.time-popover').forEach(p => p.classList.add('hidden'));
    document.querySelectorAll('.time-part').forEach(btn => btn.classList.remove('active'));
}

// Handle clicks outside popovers
function handlePopoverOutsideClick(e) {
    if (!e.target.closest('.time-popover') && !e.target.closest('.time-part')) {
        closeAllPopovers();
    }
}

// Get start time as Date (always now, with seconds zeroed for consistent duration calculation)
function getStartTimeAsDate() {
    const now = new Date();
    now.setSeconds(0, 0); // Zero out seconds and milliseconds to match end time format
    return now;
}

// Get end time as Date
function getEndTimeAsDate() {
    const date = new Date();
    date.setHours(selectedEndHour, selectedEndMinute, 0, 0);
    return date;
}

// Get smart label for start time relative to now
function getStartTimeLabel(startTime) {
    const now = new Date();
    const diffMs = startTime.getTime() - now.getTime();
    const diffMins = Math.round(diffMs / 60000);

    if (diffMins <= 1) {
        return tSettings('modeNow');
    } else if (diffMins < 60) {
        return `in ${diffMins} min`;
    } else {
        const hours = Math.floor(diffMins / 60);
        const mins = diffMins % 60;
        if (mins === 0) {
            return `in ${hours}h`;
        } else {
            return `in ${hours}h ${mins}m`;
        }
    }
}

// Handle duration input change - update end time accordingly
function handleDurationInputChange() {
    const input = document.getElementById('duration-minutes-input');
    const val = input.value;

    // Don't clamp while typing - allow it to be empty
    if (val === '') return;

    let mins = parseInt(val);
    if (isNaN(mins) || mins <= 0) return;

    // Track the target duration and reset end time editing flag
    targetDurationMinutes = Math.min(mins, 99999);
    userEditedEndTime = false;

    // Only update end time if it's a valid positive number
    const startTime = getStartTimeAsDate();
    const newEndTime = new Date(startTime.getTime() + targetDurationMinutes * 60 * 1000);

    selectedEndHour = newEndTime.getHours();
    selectedEndMinute = newEndTime.getMinutes();

    updateTimeDisplay();
    updateDurationQuickBtns(targetDurationMinutes);
    handleTimeChange();
}

// Handle duration quick toggle button click
function handleDurationQuickBtn(e) {
    const mins = parseInt(e.target.dataset.mins);
    const input = document.getElementById('duration-minutes-input');
    input.value = mins;

    // Track the target duration and reset end time editing flag
    targetDurationMinutes = mins;
    userEditedEndTime = false;

    // Calculate new end time based on start + duration
    const startTime = getStartTimeAsDate();
    const newEndTime = new Date(startTime.getTime() + mins * 60 * 1000);

    selectedEndHour = newEndTime.getHours();
    selectedEndMinute = newEndTime.getMinutes();

    updateTimeDisplay();
    updateDurationQuickBtns(mins);
    handleTimeChange();
}

// Update quick button active states based on current duration
function updateDurationQuickBtns(durationMinutes) {
    document.querySelectorAll('.duration-quick-btn').forEach(btn => {
        const btnMins = parseInt(btn.dataset.mins);
        if (btnMins === durationMinutes) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
}

// ========================================
// SCHEDULE MODE FUNCTIONS
// ========================================

// Get default schedule segments based on current time
// Start at the current hour (floor), end 2 hours later
function getDefaultScheduleSegments() {
    const now = new Date();
    const startHour = now.getHours();
    const endHour = (startHour + 2) % 24;
    // Get current day (0=Sun...6=Sat in JS, convert to 0=Mon...6=Sun)
    const jsDay = now.getDay();
    const currentDay = jsDay === 0 ? 6 : jsDay - 1; // Convert: Sun=6, Mon=0, Tue=1, etc.
    return [
        { startHour, startMinute: 0, endHour, endMinute: 0, days: [currentDay] }
    ];
}

// Switch between timed and always-on modes for instant blocks
function setAlwaysOnMode(alwaysOn) {
    isAlwaysOnMode = alwaysOn;

    // Update toggle button active states
    const timedBtn = document.getElementById('duration-mode-timed');
    const alwaysBtn = document.getElementById('duration-mode-always');
    if (timedBtn) timedBtn.classList.toggle('active', !alwaysOn);
    if (alwaysBtn) alwaysBtn.classList.toggle('active', alwaysOn);

    // Show/hide timed controls vs always-on message
    const timedControls = document.getElementById('timed-controls');
    const alwaysOnMessage = document.getElementById('always-on-message');
    if (timedControls) timedControls.classList.toggle('hidden', alwaysOn);
    if (alwaysOnMessage) alwaysOnMessage.classList.toggle('hidden', !alwaysOn);

    // Save preference per blocklist
    if (selectedBlocklistId) {
        if (!appData.settings) appData.settings = {};
        if (!appData.settings.alwaysOnMode) appData.settings.alwaysOnMode = {};
        if (appData.settings.alwaysOnMode[selectedBlocklistId] !== alwaysOn) {
            appData.settings.alwaysOnMode[selectedBlocklistId] = alwaysOn;
            saveData();
        }
    }

    // Update calendar preview and button state
    handleTimeChange();

    // Update window height after layout change
    setTimeout(() => updateWindowHeight(), 50);
}

// Switch between instant and schedule modes
function setScheduleMode(isSchedule) {
    isScheduleMode = isSchedule;

    // Persist this tab choice per blocklist so it restores when switching back
    if (selectedBlocklistId && appData.settings) {
        if (!appData.settings.preferredStartMode) appData.settings.preferredStartMode = {};
        if (appData.settings.preferredStartMode[selectedBlocklistId] !== isSchedule) {
            appData.settings.preferredStartMode[selectedBlocklistId] = isSchedule;
            saveData();
        }
    }

    // Update tab active states
    document.getElementById('instant-mode-tab').classList.toggle('active', !isSchedule);
    document.getElementById('schedule-mode-tab').classList.toggle('active', isSchedule);

    // Update section heading
    const heading = document.querySelector('#scheduler-section .section-header h2');
    if (heading) {
        heading.textContent = tSettings('mainStartBlockTitle');
    }

    // Toggle panels
    const instantPanel = document.getElementById('instant-block-panel');
    const schedulePanel = document.getElementById('schedule-block-panel');
    const startBlockBtn = document.getElementById('start-block-btn');
    const startScheduleBtn = document.getElementById('start-schedule-btn');

    if (isSchedule) {
        // Check if selected blocklist has an existing schedule
        const existingSchedule = selectedBlocklistId && appData.schedules
            ? appData.schedules.find(s => s.blocklistId === selectedBlocklistId)
            : null;

        if (existingSchedule && existingSchedule.segments) {
            // Load existing schedule segments (locked)
            scheduleSegments = existingSchedule.segments.map(seg => ({ ...seg }));
            activeScheduleSegmentCount = getCommittedScheduleSegmentCount(existingSchedule);
            scheduleRepeatType = existingSchedule.repeatType || 'no';
            scheduleRepeatDate = existingSchedule.repeatDate;

            // Also load any pending (new) segments that were added but not yet committed
            const pendingSegments = appData.settings?.pendingScheduleSegments?.[selectedBlocklistId];
            if (pendingSegments && pendingSegments.length > 0) {
                const cleanedPendingSegments = pendingSegments.filter(seg =>
                    !existingSchedule.segments.some(existingSeg => areSegmentsEqual(existingSeg, seg))
                );
                if (cleanedPendingSegments.length > 0) {
                    // Append pending segments to the existing locked segments
                    scheduleSegments.push(...cleanedPendingSegments.map(seg => ({ ...seg })));
                    const currentPending = JSON.stringify(appData.settings.pendingScheduleSegments[selectedBlocklistId] || []);
                    const nextPending = JSON.stringify(cleanedPendingSegments);
                    if (currentPending !== nextPending) {
                        appData.settings.pendingScheduleSegments[selectedBlocklistId] = cleanedPendingSegments.map(seg => ({ ...seg }));
                        saveData();
                    }
                } else {
                    if (appData.settings.pendingScheduleSegments[selectedBlocklistId]) {
                        delete appData.settings.pendingScheduleSegments[selectedBlocklistId];
                        saveData();
                    }
                }
            }
        } else {
            // Check for pending (unsaved) segments for this blocklist
            const pendingSegments = appData.settings?.pendingScheduleSegments?.[selectedBlocklistId];
            if (pendingSegments && pendingSegments.length > 0) {
                scheduleSegments = pendingSegments.map(seg => ({ ...seg }));
            } else {
                // Reset schedule segments to fresh default times
                scheduleSegments = getDefaultScheduleSegments();
            }
            activeScheduleSegmentCount = 0;
        }
        rebuildScheduleSegments();

        instantPanel.classList.add('hidden');
        schedulePanel.classList.remove('hidden');
        startBlockBtn.classList.add('hidden');
        if (selectedBlocklistId) {
            startScheduleBtn.classList.remove('hidden');
            updateScheduleButtonState();
        }
    } else {
        instantPanel.classList.remove('hidden');
        schedulePanel.classList.add('hidden');
        startScheduleBtn.classList.add('hidden');
        if (selectedBlocklistId) {
            startBlockBtn.classList.remove('hidden');
            const blocklist = appData.blocklists.find(bl => bl.id === selectedBlocklistId);

            // Re-evaluate pause button visibility for Now mode
            const pauseBtn = document.getElementById('pause-block-btn');
            const now = Date.now();
            const activeBlock = appData.activeBlocks.find(b =>
                b.blocklistId === selectedBlocklistId &&
                b.startTime <= now &&
                b.endTime > now
            );
            if (activeBlock) {
                if (pauseBtn) {
                    pauseBtn.classList.remove('hidden');
                    updatePauseButtonAppearance(!!activeBlock.isPaused);
                }

                // Also update button to show Stop state
                const btnLabel = startBlockBtn.querySelector('.btn-label');
                const btnName = startBlockBtn.querySelector('.btn-name');
                const btnIcon = startBlockBtn.querySelector('svg');
                if (btnLabel) btnLabel.textContent = 'Stop Block:';
                if (btnName) btnName.textContent = blocklist ? blocklist.name : '';
                startBlockBtn.classList.add('stop-block');
                startBlockBtn.disabled = false;
                startBlockBtn.dataset.activeBlockId = activeBlock.id;
                if (btnIcon) {
                    btnIcon.innerHTML = `
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                        <path d="M7 11V7a5 5 0 0 1 9.9-1"></path>
                    `;
                }
                disableTimeControls(true);

                // Keep the info message visible for active always-on blocks.
                const alwaysOnMsg = document.getElementById('always-on-message');
                const durationToggle = document.getElementById('duration-mode-toggle');
                if (alwaysOnMsg) alwaysOnMsg.classList.toggle('hidden', !isBlockAlwaysOn(activeBlock));
                if (durationToggle) durationToggle.classList.add('hidden');
            } else {
                if (pauseBtn) pauseBtn.classList.add('hidden');
                startBlockBtn.classList.remove('stop-block');
                delete startBlockBtn.dataset.activeBlockId;
                const btnName = startBlockBtn.querySelector('.btn-name');
                if (btnName) btnName.textContent = blocklist ? blocklist.name : '';
            }
        }
    }

    // Toggle schedule-mode class on day-tracks for click-to-create
    document.querySelectorAll('.day-track').forEach(track => {
        track.classList.toggle('schedule-mode', isSchedule);
    });

    // Update calendar preview
    handleTimeChange();
}

// Toggle Repeat dropdown visibility
function toggleRepeatDropdown(e) {
    e.stopPropagation();

    // Don't allow opening dropdown when schedule is active
    if (activeScheduleSegmentCount > 0) return;

    // Also check if button is disabled
    const repeatDropdownBtn = document.getElementById('repeat-dropdown-btn');
    if (repeatDropdownBtn && repeatDropdownBtn.disabled) {
        return;
    }

    const menu = document.getElementById('repeat-dropdown-menu');
    if (!menu) return;

    const isHidden = menu.classList.contains('hidden');
    menu.classList.toggle('hidden');

    if (isHidden) {
        // Close on outside click
        setTimeout(() => {
            document.addEventListener('click', function closeMenu(evt) {
                if (!menu.contains(evt.target)) {
                    menu.classList.add('hidden');
                    document.removeEventListener('click', closeMenu);
                }
            });
        }, 10);
    }
}

// Handle Repeat option selection
function handleRepeatOptionClick(e) {
    // Don't allow changing repeat options when schedule is active
    if (activeScheduleSegmentCount > 0) {
        // Close dropdown silently
        const menu = document.getElementById('repeat-dropdown-menu');
        if (menu) menu.classList.add('hidden');
        return;
    }

    const value = e.target.dataset.value;
    const menu = document.getElementById('repeat-dropdown-menu');
    const btnText = document.getElementById('repeat-dropdown-text');
    const dateInput = document.getElementById('repeat-date-input');

    scheduleRepeatType = value;

    // Update dropdown text
    if (btnText) {
        if (value === 'no') {
            btnText.textContent = tSettings('repeatNo');
        } else if (value === 'forever') {
            btnText.textContent = tSettings('repeatForever');
        } else {
            btnText.textContent = tSettings('repeatUntilDate');
        }
    }

    // Update active state
    document.querySelectorAll('.repeat-option').forEach(opt => {
        opt.classList.toggle('active', opt.dataset.value === value);
    });

    // Show/hide date input wrapper
    const dateWrapper = document.getElementById('repeat-date-wrapper');
    const dateOverlay = document.getElementById('repeat-date-overlay');
    if (dateInput && dateWrapper) {
        if (value === 'date') {
            dateWrapper.classList.remove('hidden');
            // Set default date to 6 days from now (completing a full week including today)
            if (!scheduleRepeatDate) {
                const defaultDate = new Date();
                defaultDate.setDate(defaultDate.getDate() + 6);
                scheduleRepeatDate = defaultDate;
                dateInput.value = formatDateForInput(defaultDate);
            }
            // Update overlay with formatted date
            if (dateOverlay) {
                dateOverlay.textContent = formatDateForDisplay(scheduleRepeatDate);
            }
        } else {
            dateWrapper.classList.add('hidden');
            scheduleRepeatDate = null;
        }
    }

    // Close menu
    if (menu) menu.classList.add('hidden');

    // Update preview
    handleTimeChange();
}

// Handle Repeat date change
function handleRepeatDateChange(e) {
    const dateStr = e.target.value;
    if (dateStr) {
        scheduleRepeatDate = new Date(dateStr + 'T23:59:59');
        // Update the overlay with formatted date
        const dateOverlay = document.getElementById('repeat-date-overlay');
        if (dateOverlay) {
            dateOverlay.textContent = formatDateForDisplay(scheduleRepeatDate);
        }
        // Update preview
        handleTimeChange();
    }
}

// Format date for input element (YYYY-MM-DD)
function formatDateForInput(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function localDateKey(date) {
    return formatDateForInput(date);
}

function parseLocalDateKey(dateKey) {
    if (!dateKey) return null;
    const [year, month, day] = dateKey.split('-').map(Number);
    if (![year, month, day].every(Number.isFinite)) return null;
    return new Date(year, month - 1, day);
}

// Format date for display (e.g., "3 Feb 2026")
function formatDateForDisplay(date) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const day = date.getDate();
    const month = months[date.getMonth()];
    const year = date.getFullYear();
    return `${day} ${month} ${year}`;
}

function isScheduleSegmentActiveNow(schedule, nowDate = new Date()) {
    if (!schedule || !schedule.segments || schedule.segments.length === 0) return false;
    const nowMs = nowDate.getTime();
    if (isSchedulePausedNow(schedule, nowMs)) return false;
    if (isNonRepeatingSchedule(schedule)) {
        return resolveOneShotOccurrences(schedule).some(occurrence => {
            const startMs = occurrence.start.getTime();
            const endMs = occurrence.end.getTime();
            return nowMs >= startMs && nowMs < endMs;
        });
    }
    const currentDay = nowDate.getDay() === 0 ? 6 : nowDate.getDay() - 1;
    const currentMins = nowDate.getHours() * 60 + nowDate.getMinutes();
    return schedule.segments.some(seg => {
        const startMins = seg.startHour * 60 + seg.startMinute;
        const endMins = seg.endHour * 60 + seg.endMinute;
        if (startMins === endMins) return seg.days.includes(currentDay);
        if (endMins > startMins) return seg.days.includes(currentDay) && currentMins >= startMins && currentMins < endMins;
        const yesterdayDay = currentDay === 0 ? 6 : currentDay - 1;
        return (seg.days.includes(currentDay) && currentMins >= startMins) || (seg.days.includes(yesterdayDay) && currentMins < endMins);
    });
}

function getCommittedScheduleSegmentCount(schedule) {
    return schedule && schedule.segments ? schedule.segments.length : 0;
}

function areSegmentsEqual(a, b) {
    if (!a || !b) return false;
    const aDays = Array.isArray(a.days) ? [...a.days].sort((x, y) => x - y) : [];
    const bDays = Array.isArray(b.days) ? [...b.days].sort((x, y) => x - y) : [];
    return a.startHour === b.startHour &&
        a.startMinute === b.startMinute &&
        a.endHour === b.endHour &&
        a.endMinute === b.endMinute &&
        JSON.stringify(aDays) === JSON.stringify(bDays);
}

// Update schedule button enabled state
function updateScheduleButtonState() {
    const startScheduleBtn = document.getElementById('start-schedule-btn');
    if (!startScheduleBtn) return;

    // Check if selected blocklist has an active schedule
    const activeSchedule = selectedBlocklistId && appData.schedules
        ? appData.schedules.find(s => s.blocklistId === selectedBlocklistId)
        : null;
    const now = Date.now();
    const scheduleIsPaused = isSchedulePausedNow(activeSchedule, now);
    const scheduleIsActiveNow = !!(activeSchedule && isScheduleSegmentActiveNow(activeSchedule));
    const scheduleIsFunctionallyActive = scheduleIsPaused || scheduleIsActiveNow;

    const blocklist = selectedBlocklistId
        ? appData.blocklists.find(bl => bl.id === selectedBlocklistId)
        : null;

    const btnLabel = startScheduleBtn.querySelector('.btn-label');
    const btnName = startScheduleBtn.querySelector('.btn-name');
    const btnIcon = startScheduleBtn.querySelector('svg');

    // Check if there are new segments (beyond the locked count)
    const committedSegmentCount = getCommittedScheduleSegmentCount(activeSchedule);
    const hasNewSegments = activeSchedule && scheduleSegments.length > committedSegmentCount;

    // Show/hide pause button for started schedules (pause is allowed even when no segment is active)
    const pauseBtn = document.getElementById('pause-block-btn');
    if (pauseBtn) {
        if (activeSchedule && activeSchedule.segments) {
            const isPaused = activeSchedule.isPaused && activeSchedule.pauseEndTime > now;

            if (isPaused) {
                // Schedule is paused — show Resume button
                pauseBtn.classList.remove('hidden');
                updatePauseButtonAppearance(true);
            } else {
                pauseBtn.classList.remove('hidden');
                updatePauseButtonAppearance(false);
            }
        } else {
            pauseBtn.classList.add('hidden');
        }
    }

    if (activeSchedule && !hasNewSegments) {
        // Active schedule with no pending changes - show Stop button (grey/secondary style)
        if (btnLabel) btnLabel.textContent = tSettings('stopScheduleButton');
        if (btnName) btnName.textContent = blocklist ? blocklist.name : '';
        startScheduleBtn.classList.add('stop-schedule');
        startScheduleBtn.classList.remove('edit-schedule');
        startScheduleBtn.disabled = false;
        startScheduleBtn.dataset.activeScheduleId = activeSchedule.id || activeSchedule.blocklistId;



        // Change to unlock icon
        if (btnIcon) {
            btnIcon.innerHTML = `
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                <path d="M7 11V7a5 5 0 0 1 9.9-1"></path>
            `;
        }

        // Disable controls for existing segments
        disableScheduleControls(true);
    } else if (activeSchedule && hasNewSegments) {
        // Existing schedule not currently active (or has pending changes) - show Edit button
        if (btnLabel) btnLabel.textContent = tSettings('editScheduleButton');
        if (btnName) btnName.textContent = blocklist ? blocklist.name : '';
        startScheduleBtn.classList.remove('stop-schedule');
        startScheduleBtn.classList.add('edit-schedule');
        startScheduleBtn.disabled = false;
        startScheduleBtn.dataset.activeScheduleId = activeSchedule.id || activeSchedule.blocklistId;

        // Calendar icon for edit mode
        if (btnIcon) {
            btnIcon.innerHTML = `
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                <line x1="16" y1="2" x2="16" y2="6"></line>
                <line x1="8" y1="2" x2="8" y2="6"></line>
                <line x1="3" y1="10" x2="21" y2="10"></line>
            `;
        }

        // Controls are mixed - existing segments disabled, new segments enabled
        disableScheduleControls(true);
    } else {
        // No active schedule - show Start button (normal)
        if (btnLabel) btnLabel.textContent = tSettings('startScheduleButton');
        if (btnName) btnName.textContent = blocklist ? blocklist.name : '';
        startScheduleBtn.classList.remove('stop-schedule');
        startScheduleBtn.classList.remove('edit-schedule');
        delete startScheduleBtn.dataset.activeScheduleId;



        // Lock icon
        if (btnIcon) {
            btnIcon.innerHTML = `
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
            `;
        }

        // Enable all controls
        disableScheduleControls(false);
    }

    // Enable button if blocklist is selected
    const isValid = selectedBlocklistId;
    startScheduleBtn.disabled = !isValid;
}

// Add a new time segment
function addScheduleSegment() {
    // Don't allow adding segments when schedule is active
    if (activeScheduleSegmentCount > 0) {
        return;
    }

    // Get the previous segment's end time, round up to next full hour for new start
    const prevSegment = scheduleSegments[scheduleSegments.length - 1];
    let newStartHour;
    if (prevSegment) {
        // Start 1 hour after previous end, round up if minutes present
        newStartHour = prevSegment.endMinute > 0
            ? (prevSegment.endHour + 2) % 24
            : (prevSegment.endHour + 1) % 24;
    } else {
        newStartHour = 14;
    }
    const newStartMinute = 0; // Always start on the hour
    // Default to 2 hours after start
    const newEndHour = (newStartHour + 2) % 24;
    const newEndMinute = 0;

    // Default to current day (0=Mon...6=Sun)
    const jsDay = new Date().getDay();
    const currentDay = jsDay === 0 ? 6 : jsDay - 1;

    // Add to state
    scheduleSegments.push({
        startHour: newStartHour,
        startMinute: newStartMinute,
        endHour: newEndHour,
        endMinute: newEndMinute,
        days: [currentDay]
    });

    // Rebuild all segments to ensure consistent rendering
    rebuildScheduleSegments();

    // Re-apply disabled state to locked segments (if schedule is active)
    if (activeScheduleSegmentCount > 0) {
        disableScheduleControls(true);
    }

    // Update calendar preview and button state
    handleTimeChange();
    updateScheduleButtonState();
}

// Handle clicking a day toggle within a segment
function handleSegmentDayToggle(segmentIndex, dayIndex, btn) {
    // Don't allow toggling days on locked segments (part of active schedule)
    if (segmentIndex < activeScheduleSegmentCount) return;

    const segment = scheduleSegments[segmentIndex];
    if (!segment) return;

    // Toggle the day in the segment's days array
    const dayIdx = segment.days.indexOf(dayIndex);
    if (dayIdx === -1) {
        segment.days.push(dayIndex);
        segment.days.sort((a, b) => a - b);
        btn.classList.add('active');
    } else {
        // Allow removing the day (segment with no days just won't apply)
        segment.days.splice(dayIdx, 1);
        btn.classList.remove('active');
    }

    // Update preview and button state
    handleTimeChange();
    updateScheduleButtonState();
}

// Remove a time segment
function removeScheduleSegment(index) {
    // Don't allow removing locked segments (part of active schedule)
    if (index < activeScheduleSegmentCount) return;

    if (scheduleSegments.length <= 1) return; // Always keep at least one

    // Remove from state
    scheduleSegments.splice(index, 1);

    // Rebuild DOM (simpler than updating indices)
    rebuildScheduleSegments();

    // Update calendar preview
    handleTimeChange();
}

// Sort schedule segments chronologically by start time
function sortScheduleSegments() {
    scheduleSegments.sort((a, b) => {
        // Compare by start hour first, then by start minute
        const aMinutes = a.startHour * 60 + a.startMinute;
        const bMinutes = b.startHour * 60 + b.startMinute;
        return aMinutes - bMinutes;
    });
}

// Rebuild schedule segments DOM from state
function rebuildScheduleSegments() {
    // Sort chronologically before rebuilding
    sortScheduleSegments();

    const container = document.getElementById('schedule-segments');
    container.innerHTML = '';

    const dayLabels = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

    scheduleSegments.forEach((seg, index) => {
        const segment = document.createElement('div');
        segment.className = 'schedule-segment';
        segment.dataset.segmentIndex = index;

        const showRemove = scheduleSegments.length > 1;
        const segmentDays = seg.days || [];

        // Generate day toggles HTML
        const dayTogglesHtml = dayLabels.map((label, i) =>
            `<button type="button" class="segment-day-toggle${segmentDays.includes(i) ? ' active' : ''}" data-day="${i}">${label}</button>`
        ).join('');

        // Only show labels on the first segment
        const showLabels = index === 0;

        segment.innerHTML = `
            <div class="segment-row">
                <div class="time-pickers-row">
                    <div class="time-picker-group">
                        ${showLabels ? '<label class="time-label">Start</label>' : ''}
                        <div class="time-picker-row">
                            <div class="time-display schedule-start-display">
                                <div class="time-part-wrapper">
                                    <button class="time-part schedule-hour-btn" data-type="hour" data-target="schedule-start-${index}">${String(seg.startHour).padStart(2, '0')}</button>
                                </div>
                                <span class="time-colon">:</span>
                                <div class="time-part-wrapper">
                                    <button class="time-part schedule-minute-btn" data-type="minute" data-target="schedule-start-${index}">${String(seg.startMinute).padStart(2, '0')}</button>
                                </div>
                            </div>
                        </div>
                    </div>
                    <span class="time-separator">→</span>
                    <div class="time-picker-group">
                        ${showLabels ? '<label class="time-label">End</label>' : ''}
                        <div class="time-picker-row">
                            <div class="time-display schedule-end-display">
                                <div class="time-part-wrapper">
                                    <button class="time-part schedule-hour-btn" data-type="hour" data-target="schedule-end-${index}">${String(seg.endHour).padStart(2, '0')}</button>
                                </div>
                                <span class="time-colon">:</span>
                                <div class="time-part-wrapper">
                                    <button class="time-part schedule-minute-btn" data-type="minute" data-target="schedule-end-${index}">${String(seg.endMinute).padStart(2, '0')}</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="segment-days-group">
                    ${showLabels ? '<label class="time-label">Days</label>' : ''}
                    <div class="segment-days" data-segment-index="${index}">
                        ${dayTogglesHtml}
                    </div>
                </div>
                ${showRemove ? `
                    <button type="button" class="remove-segment-btn" data-segment-index="${index}">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                            stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18"></line>
                            <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                    </button>
                ` : ''}
            </div>
        `;

        container.appendChild(segment);

        // Add click handlers for time parts
        segment.querySelectorAll('.time-part').forEach(btn => {
            btn.addEventListener('click', handleScheduleTimeClick);
        });

        // Add click handlers for day toggles
        segment.querySelectorAll('.segment-day-toggle').forEach(btn => {
            btn.addEventListener('click', () => {
                const dayIndex = parseInt(btn.dataset.day);
                handleSegmentDayToggle(index, dayIndex, btn);
            });
        });

        // Add click handler for remove button
        const removeBtn = segment.querySelector('.remove-segment-btn');
        if (removeBtn) {
            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(removeBtn.dataset.segmentIndex);
                removeScheduleSegment(idx);
            });
        }
    });
}

// Handle schedule time button click (show popover)
function handleScheduleTimeClick(e) {
    e.stopPropagation();
    const btn = e.target;
    const type = btn.dataset.type; // 'hour' or 'minute'
    const target = btn.dataset.target; // e.g., 'schedule-start-0' or 'schedule-end-1'

    // Parse target
    const parts = target.split('-');
    const isStart = parts[1] === 'start';
    const segmentIndex = parseInt(parts[2]);

    // Create and show popover for time selection
    showScheduleTimePopover(btn, type, isStart, segmentIndex);
}

// Show time popover for schedule time selection
function showScheduleTimePopover(btn, type, isStart, segmentIndex) {
    // Remove any existing schedule popovers
    document.querySelectorAll('.schedule-time-popover').forEach(p => p.remove());

    const popover = document.createElement('div');
    popover.className = 'time-popover schedule-time-popover';

    const scroll = document.createElement('div');
    scroll.className = 'popover-scroll';

    const segment = scheduleSegments[segmentIndex];
    const currentValue = type === 'hour'
        ? (isStart ? segment.startHour : segment.endHour)
        : (isStart ? segment.startMinute : segment.endMinute);

    const max = type === 'hour' ? 24 : 60;
    const step = type === 'hour' ? 1 : 5;
    let suppressOptionClickUntil = 0;
    let touchStartY = null;
    let touchStartScrollTop = 0;
    let isTouchDragging = false;
    let lastTouchY = null;
    let lastTouchTime = 0;
    let touchVelocity = 0;
    let momentumFrame = null;

    function stopMomentum() {
        if (momentumFrame != null) {
            cancelAnimationFrame(momentumFrame);
            momentumFrame = null;
        }
    }

    function startMomentum(initialVelocity) {
        stopMomentum();
        let velocity = initialVelocity;
        let lastFrameTime = performance.now();

        const tick = (now) => {
            const dt = Math.min(32, now - lastFrameTime);
            lastFrameTime = now;

            scroll.scrollTop -= velocity * dt;
            velocity *= 0.95;

            if (Math.abs(velocity) < 0.02) {
                momentumFrame = null;
                return;
            }

            const atTop = scroll.scrollTop <= 0;
            const atBottom = scroll.scrollTop >= scroll.scrollHeight - scroll.clientHeight;
            if ((atTop && velocity > 0) || (atBottom && velocity < 0)) {
                momentumFrame = null;
                return;
            }

            momentumFrame = requestAnimationFrame(tick);
        };

        momentumFrame = requestAnimationFrame(tick);
    }

    // On iPad/iPhone, dragging inside a scrollable list of buttons can be
    // interpreted as taps unless we explicitly suppress selection right after
    // a scroll gesture.
    scroll.addEventListener('touchstart', (e) => {
        stopMomentum();
        touchStartY = e.touches[0]?.clientY ?? null;
        touchStartScrollTop = scroll.scrollTop;
        isTouchDragging = false;
        lastTouchY = touchStartY;
        lastTouchTime = performance.now();
        touchVelocity = 0;
    }, { passive: true });

    scroll.addEventListener('touchmove', (e) => {
        const currentY = e.touches[0]?.clientY;
        if (touchStartY != null && currentY != null) {
            const deltaY = currentY - touchStartY;
            const now = performance.now();
            const elapsed = Math.max(1, now - lastTouchTime);
            if (lastTouchY != null) {
                touchVelocity = (currentY - lastTouchY) / elapsed;
            }
            lastTouchY = currentY;
            lastTouchTime = now;
            if (Math.abs(deltaY) > 6) {
                isTouchDragging = true;
                suppressOptionClickUntil = Date.now() + 250;
                // Drive the scrolling ourselves so slow finger drags work
                // reliably in iPad WKWebView even though the children are buttons.
                scroll.scrollTop = touchStartScrollTop - deltaY;
                e.preventDefault();
            }
        }
    }, { passive: false });

    scroll.addEventListener('touchend', () => {
        if (isTouchDragging) {
            suppressOptionClickUntil = Date.now() + 250;
            if (Math.abs(touchVelocity) > 0.08) {
                startMomentum(touchVelocity);
            }
        }
        touchStartY = null;
        isTouchDragging = false;
        lastTouchY = null;
    }, { passive: true });

    scroll.addEventListener('touchcancel', () => {
        touchStartY = null;
        isTouchDragging = false;
        lastTouchY = null;
    }, { passive: true });

    for (let i = 0; i < max; i += step) {
        const option = document.createElement('button');
        option.className = 'popover-option' + (i === currentValue ? ' selected' : '');
        option.textContent = String(i).padStart(2, '0');
        option.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent blocklist deselection
            if (Date.now() < suppressOptionClickUntil) {
                return;
            }

            // Update state
            if (type === 'hour') {
                if (isStart) segment.startHour = i;
                else segment.endHour = i;
            } else {
                if (isStart) segment.startMinute = i;
                else segment.endMinute = i;
            }

            // Update button text
            btn.textContent = String(i).padStart(2, '0');

            // Close popover
            popover.remove();

            // Update calendar preview
            handleTimeChange();
        });
        scroll.appendChild(option);
    }

    popover.appendChild(scroll);
    btn.parentElement.appendChild(popover);

    // Scroll to current value
    const activeOption = scroll.querySelector('.selected');
    if (activeOption) {
        activeOption.scrollIntoView({ block: 'center' });
    }

    // Close on outside click
    setTimeout(() => {
        document.addEventListener('click', function closePopover(e) {
            if (!popover.contains(e.target) && e.target !== btn) {
                popover.remove();
                document.removeEventListener('click', closePopover);
            }
        });
    }, 10);
}

// Start a schedule - show confirmation modal first
async function startSchedule() {
    if (!selectedBlocklistId) return;

    const blocklist = appData.blocklists.find(bl => bl.id === selectedBlocklistId);
    if (!blocklist) return;

    // Check if this blocklist already has an active schedule
    const activeSchedule = appData.schedules
        ? appData.schedules.find(s => s.blocklistId === selectedBlocklistId)
        : null;

    // Check if there are new segments beyond the locked count
    const committedSegmentCount = getCommittedScheduleSegmentCount(activeSchedule);
    const hasNewSegments = activeSchedule && scheduleSegments.length > committedSegmentCount;
    if (activeSchedule && !hasNewSegments) {
        // Stop mode - open override dialog for the schedule
        openScheduleOverrideModal(activeSchedule);
        return;
    }

    if (!ensureIOSBlocklistSelectionReady(blocklist, 'starting this schedule')) return;

    if (activeSchedule && hasNewSegments) {
        // Edit mode - show confirmation for adding new segments only
        const newSegments = scheduleSegments.slice(committedSegmentCount);
        showScheduleEditConfirmModal(blocklist, activeSchedule, newSegments);
        return;
    }

    // Normal start mode - check that at least one segment has days
    const hasAnyDays = scheduleSegments.some(seg => seg.days && seg.days.length > 0);
    if (!hasAnyDays) return;

    // Show confirmation modal for new schedule
    showScheduleConfirmModal(blocklist);
}

// Show schedule confirmation modal
function showScheduleConfirmModal(blocklist) {
    const dayNames = tSettings('dayAbbrevMon0');

    // Blocklist name
    document.getElementById('schedule-confirm-name').textContent = blocklist.name;

    // Websites
    const websites = blocklist.websites || [];
    const websitesRow = document.getElementById('schedule-websites-row');
    const websitesEl = document.getElementById('schedule-confirm-websites');
    const showAllWebsitesBtn = document.getElementById('show-all-schedule-websites');

    if (websites.length === 0) {
        websitesRow.classList.add('hidden');
    } else {
        websitesRow.classList.remove('hidden');
        const maxShow = 3;
        if (websites.length <= maxShow) {
            websitesEl.textContent = websites.join(', ');
            showAllWebsitesBtn.classList.add('hidden');
        } else {
            websitesEl.textContent = websites.slice(0, maxShow).join(', ') + '...';
            websitesEl.dataset.fullList = websites.join(', ');
            showAllWebsitesBtn.classList.remove('hidden');
            showAllWebsitesBtn.onclick = () => {
                websitesEl.textContent = websites.join(', ');
                showAllWebsitesBtn.classList.add('hidden');
            };
        }
    }

    // Apps
    const apps = getBlocklistDisplayApps(blocklist);
    const appsRow = document.getElementById('schedule-apps-row');
    const appsEl = document.getElementById('schedule-confirm-apps');
    const showAllAppsBtn = document.getElementById('show-all-schedule-apps');

    if (apps.length === 0) {
        appsRow.classList.add('hidden');
    } else {
        appsRow.classList.remove('hidden');
        const maxShow = 3;
        if (apps.length <= maxShow) {
            appsEl.textContent = apps.join(', ');
            showAllAppsBtn.classList.add('hidden');
        } else {
            appsEl.textContent = apps.slice(0, maxShow).join(', ') + '...';
            showAllAppsBtn.classList.remove('hidden');
            showAllAppsBtn.onclick = () => {
                appsEl.textContent = apps.join(', ');
                showAllAppsBtn.classList.add('hidden');
            };
        }
    }

    // Schedule segments
    const segmentsEl = document.getElementById('schedule-confirm-segments');
    segmentsEl.innerHTML = '';

    scheduleSegments.forEach((seg, index) => {
        const segDays = (seg.days || []).map(d => dayNames[d]).join(', ');
        const startTime = `${String(seg.startHour).padStart(2, '0')}:${String(seg.startMinute).padStart(2, '0')}`;
        const endTime = `${String(seg.endHour).padStart(2, '0')}:${String(seg.endMinute).padStart(2, '0')}`;

        const row = document.createElement('div');
        row.className = 'schedule-segment-row';
        row.innerHTML = `
            <span class="segment-time">${startTime} → ${endTime}</span>
            <span class="segment-days">${segDays || tSettings('noDaysSelected')}</span>
        `;
        segmentsEl.appendChild(row);
    });

    // Repeat info
    const repeatEl = document.getElementById('schedule-confirm-repeat');
    if (scheduleRepeatType === 'forever') {
        repeatEl.textContent = tSettings('repeatForever');
    } else if (scheduleRepeatType === 'date' && scheduleRepeatDate) {
        repeatEl.textContent = `${tSettings('repeatUntilDate')} ${scheduleRepeatDate.toLocaleDateString(tSettings('locale'))}`;
    } else {
        repeatEl.textContent = tSettings('repeatNo');
    }

    // Override info
    const difficulty = blocklist.overrideDifficulty || { type: 'random-words', count: 50 };
    const charCount = difficulty.count || 50;
    const charsPerMinute = 100;
    const estimatedMinutes = Math.ceil(charCount / charsPerMinute);
    const charWord = charCount === 1 ? 'character' : 'characters';

    let overrideText;
    if (difficulty.type === 'random') {
        overrideText = `Type ${charCount} random ${charWord} (letters and numbers) exactly as shown (~${estimatedMinutes} min).`;
    } else {
        overrideText = `Type ${charCount} ${charWord} (displayed as random words) exactly as shown (~${estimatedMinutes} min).`;
    }

    document.getElementById('schedule-confirm-override-text').textContent = overrideText;

    // Show modal
    document.getElementById('start-schedule-confirm-modal').classList.remove('hidden');
}

// Close schedule confirmation modal
function closeScheduleConfirmModal() {
    document.getElementById('start-schedule-confirm-modal').classList.add('hidden');
}

// Open override modal for stopping a schedule (uses same override modal as blocks)
// This is ONLY called from the stop schedule button - always stops entire schedule
function openScheduleOverrideModal(schedule) {
    // Store the schedule ID for the override process
    window.overrideScheduleId = schedule.id || schedule.blocklistId;

    // Clear segment index/day - this ensures we can ONLY stop the entire schedule
    window.overrideSegmentIndex = undefined;
    window.overrideSegmentDay = undefined;

    // Get the blocklist name
    const blocklist = appData.blocklists.find(bl => bl.id === schedule.blocklistId);
    const blocklistName = blocklist ? blocklist.name : 'Schedule';

    // Set the challenge text for the override modal using blocklist settings
    const difficulty = blocklist?.overrideDifficulty || { type: 'random-words', count: 50 };
    const charCount = difficulty.count || 50;
    const isRandom = difficulty.type === 'gibberish';

    // Use the existing override modal - set up challenge
    challengeText = isRandom ? generateGibberish(charCount) : generateRandomWords(charCount);
    overrideBlockId = null; // Not a block, it's a schedule
    overrideBlocklistIdForHelper = null;

    // Update modal title to indicate it's a schedule
    const titleEl = document.getElementById('override-modal-title');
    if (titleEl) {
        titleEl.textContent = `Stop Schedule: ${blocklistName}`;
    }

    // Hide the radio options - stop schedule button ONLY stops entire schedule
    const optionsDiv = document.getElementById('schedule-override-options');
    if (optionsDiv) {
        optionsDiv.classList.add('hidden');
    }

    // Set override type to stop-schedule (even though options are hidden)
    const stopScheduleRadio = document.querySelector('input[name="schedule-override-type"][value="stop-schedule"]');
    if (stopScheduleRadio) {
        stopScheduleRadio.checked = true;
    }

    // Render challenge text directly (renderChallengeText is scoped inside setupOverrideModalListeners)
    const challengeTextEl = document.getElementById('challenge-text');
    if (challengeTextEl) {
        challengeTextEl.textContent = challengeText;
    }

    // Clear input and progress
    const challengeInput = document.getElementById('challenge-input');
    if (challengeInput) challengeInput.value = '';
    const progressBar = document.getElementById('challenge-progress-bar');
    if (progressBar) progressBar.style.width = '0%';

    document.getElementById('override-modal').classList.remove('hidden');
}

// Open schedule override modal when clicking on a scheduled block in the calendar
function openScheduledBlockOverrideModal(schedule, segmentIndex, day) {
    // Store the schedule info for the override process
    window.overrideScheduleId = schedule.id;
    window.overrideSegmentIndex = segmentIndex;
    window.overrideSegmentDay = day;

    // Get the blocklist
    const blocklist = appData.blocklists.find(bl => bl.id === schedule.blocklistId);
    const blocklistName = blocklist ? blocklist.name : 'Schedule';

    // Calculate if this schedule has multiple occurrences
    const segment = schedule.segments[segmentIndex];
    const totalDaysInSegment = segment ? segment.days.length : 1;
    const totalSegments = schedule.segments.length;
    const hasMultipleOccurrences = totalSegments > 1 || totalDaysInSegment > 1 ||
        (schedule.repeatType === 'forever' || schedule.repeatType === 'date');

    // Show/hide the radio options based on multiple occurrences
    const optionsDiv = document.getElementById('schedule-override-options');
    if (hasMultipleOccurrences) {
        optionsDiv.classList.remove('hidden');
        // Reset to default "Just this block"
        document.querySelector('input[name="schedule-override-type"][value="just-this"]').checked = true;
    } else {
        optionsDiv.classList.add('hidden');
    }

    // Set up the challenge text using blocklist settings
    const difficulty = blocklist?.overrideDifficulty || { type: 'random-words', count: 50 };
    const charCount = difficulty.count || 50;
    const isRandom = difficulty.type === 'gibberish';
    challengeText = isRandom ? generateGibberish(charCount) : generateRandomWords(charCount);
    overrideBlockId = null; // Not a one-off block
    overrideBlocklistIdForHelper = null;

    // Update modal title
    const titleEl = document.getElementById('override-modal-title');
    if (titleEl) {
        titleEl.textContent = `Override Scheduled Block?`;
    }

    // Update summary
    const summaryEl = document.getElementById('override-summary');
    if (summaryEl && blocklist) {
        summaryEl.innerHTML = `<span class="block-name">${blocklist.emoji || ''} ${blocklistName}</span>`;
    }

    // Render challenge text
    const challengeTextEl = document.getElementById('challenge-text');
    if (challengeTextEl) {
        challengeTextEl.textContent = challengeText;
    }

    // Clear input and progress
    const challengeInput = document.getElementById('challenge-input');
    if (challengeInput) challengeInput.value = '';
    const progressBar = document.getElementById('challenge-progress-bar');
    if (progressBar) progressBar.style.width = '0%';

    document.getElementById('override-modal').classList.remove('hidden');
}

// Show confirmation modal for editing (adding segments to) an existing schedule
function showScheduleEditConfirmModal(blocklist, existingSchedule, newSegments) {
    const dayNames = tSettings('dayAbbrevMon0');

    // Store references for the proceed function
    window.editScheduleData = {
        scheduleId: existingSchedule.id || existingSchedule.blocklistId,
        newSegments: newSegments
    };

    // Blocklist name
    document.getElementById('schedule-confirm-name').textContent = `Add to: ${blocklist.name}`;

    // Hide websites and apps rows (not changing those)
    document.getElementById('schedule-websites-row').classList.add('hidden');
    document.getElementById('schedule-apps-row').classList.add('hidden');

    // Show NEW segments only
    const segmentsEl = document.getElementById('schedule-confirm-segments');
    segmentsEl.innerHTML = `<div class="edit-schedule-notice">${getSettingsLanguage() === 'da' ? 'Tilføjer disse tidssegmenter:' : 'Adding these time segments:'}</div>`;

    newSegments.forEach((seg, index) => {
        const segDays = (seg.days || []).map(d => dayNames[d]).join(', ');
        const startTime = `${String(seg.startHour).padStart(2, '0')}:${String(seg.startMinute).padStart(2, '0')}`;
        const endTime = `${String(seg.endHour).padStart(2, '0')}:${String(seg.endMinute).padStart(2, '0')}`;

        const row = document.createElement('div');
        row.className = 'schedule-segment-row new-segment';
        row.innerHTML = `
            <span class="segment-time">${startTime} → ${endTime}</span>
            <span class="segment-days">${segDays || tSettings('noDaysSelected')}</span>
        `;
        segmentsEl.appendChild(row);
    });

    // Hide repeat info (not changing)
    document.getElementById('schedule-confirm-repeat').parentElement.classList.add('hidden');

    // Update modal button to say "Add Segments"
    const confirmBtn = document.querySelector('#start-schedule-confirm-modal .confirm-btn');
    if (confirmBtn) {
        confirmBtn.textContent = 'Add Segments';
        confirmBtn.onclick = proceedWithScheduleEdit;
    }

    // Show modal
    document.getElementById('start-schedule-confirm-modal').classList.remove('hidden');
}

// Add new segments to existing schedule
async function proceedWithScheduleEdit() {
    closeScheduleConfirmModal();

    const editData = window.editScheduleData;
    if (!editData) return;

    // Find the existing schedule
    const schedule = appData.schedules.find(s =>
        s.id === editData.scheduleId || s.blocklistId === editData.scheduleId
    );
    if (!schedule) return;

    // Add the new segments
    editData.newSegments.forEach(seg => {
        schedule.segments.push({
            startHour: seg.startHour,
            startMinute: seg.startMinute,
            endHour: seg.endHour,
            endMinute: seg.endMinute,
            days: [...seg.days]
        });
    });

    // Update activeScheduleSegmentCount to include the new segments
    activeScheduleSegmentCount = schedule.segments.length;
    scheduleSegments = schedule.segments.map(seg => ({ ...seg }));

    // Clear pending segments for this blocklist (they're now committed)
    if (appData.settings?.pendingScheduleSegments?.[selectedBlocklistId]) {
        delete appData.settings.pendingScheduleSegments[selectedBlocklistId];
    }

    // Save
    await saveData();

    console.log('Schedule updated with new segments:', schedule);

    // Restore the confirm button to normal
    const confirmBtn = document.querySelector('#start-schedule-confirm-modal .confirm-btn');
    if (confirmBtn) {
        confirmBtn.textContent = tSettings('startSchedule');
        confirmBtn.onclick = proceedWithSchedule;
    }

    // Restore hidden rows
    document.getElementById('schedule-confirm-repeat').parentElement.classList.remove('hidden');

    // Update UI
    updateScheduleButtonState();
    renderBlocklists();
    updateWeekCalendar();
    // Sync updated schedule to helper daemon
    syncSchedulesToHelper();

    // Clean up
    delete window.editScheduleData;
}

// Actually create the schedule (called after confirmation)
async function proceedWithSchedule() {
    closeScheduleConfirmModal();

    const blocklist = appData.blocklists.find(bl => bl.id === selectedBlocklistId);
    if (!blocklist) return;
    if (!ensureIOSBlocklistSelectionReady(blocklist, 'starting this schedule')) return;

    // v2: no helper to install. The app itself is the engine; if it
    // launched, blocking works. The legacy helper-install-modal
    // branch was here.

    // Create schedule object
    const schedule = {
        id: crypto.randomUUID(),
        blocklistId: selectedBlocklistId,
        segments: scheduleSegments.map(seg => ({
            startHour: seg.startHour,
            startMinute: seg.startMinute,
            endHour: seg.endHour,
            endMinute: seg.endMinute,
            days: [...seg.days]
        })),
        repeatType: scheduleRepeatType,
        repeatDate: scheduleRepeatType === 'date' ? scheduleRepeatDate : null,
        createdAt: Date.now()
    };

    // Save to appData
    appData.schedules.push(schedule);

    // Clear pending segments for this blocklist (they're now committed)
    if (appData.settings?.pendingScheduleSegments?.[selectedBlocklistId]) {
        delete appData.settings.pendingScheduleSegments[selectedBlocklistId];
    }

    await saveData();

    console.log('Schedule created:', schedule);

    // Update blocked apps if schedule is currently active
    await updateBlockedApps();
    // Update the active segment count to lock the created segments
    activeScheduleSegmentCount = scheduleSegments.length;

    // Reset schedule repeat options for next use
    scheduleRepeatType = 'forever';
    scheduleRepeatDate = null;

    // Rebuild segments UI to show them as locked
    rebuildScheduleSegments();
    disableScheduleControls(true);
    updateScheduleButtonState();

    // Re-render blocklists to show schedule badge
    renderBlocklists();

    // Update calendar to show scheduled blocks
    updateWeekCalendar();

    // Clear preview blocks
    document.querySelectorAll('.calendar-block.preview').forEach(el => el.remove());

    // Trigger hosts file update to start blocking if schedule is currently active
    await updateHostsFile();

    // Sync all schedules to helper daemon for autonomous transitions
    await syncSchedulesToHelper();
}
// Handle time picker change
function handleTimeChange() {
    const noBlocksMsg = document.getElementById('no-blocks-message');
    const startBtn = document.getElementById('start-block-btn');
    const nextDayIndicator = document.getElementById('next-day-indicator');

    // Remove any existing preview blocks and active-schedule blocks (for schedule mode)
    document.querySelectorAll('.calendar-block.preview, .calendar-block.active-schedule').forEach(el => el.remove());

    // Handle schedule mode separately
    if (isScheduleMode) {
        renderSchedulePreview();

        // Save pending schedule segments for this blocklist
        if (selectedBlocklistId) {
            if (!appData.settings) appData.settings = {};
            if (!appData.settings.pendingScheduleSegments) appData.settings.pendingScheduleSegments = {};

            const existingSchedule = appData.schedules?.find(s => s.blocklistId === selectedBlocklistId);

            if (!existingSchedule) {
                // No active schedule - save all pending segments
                const currentPending = JSON.stringify(appData.settings.pendingScheduleSegments[selectedBlocklistId] || []);
                const newPending = JSON.stringify(scheduleSegments);
                if (currentPending !== newPending) {
                    appData.settings.pendingScheduleSegments[selectedBlocklistId] = scheduleSegments.map(seg => ({ ...seg }));
                    saveData();
                }
            } else {
                // Active schedule exists - save only NEW segments (those beyond activeScheduleSegmentCount)
                const committedSegmentCount = getCommittedScheduleSegmentCount(existingSchedule);
                if (scheduleSegments.length > committedSegmentCount) {
                    const newSegments = scheduleSegments.slice(committedSegmentCount);
                    const currentPending = JSON.stringify(appData.settings.pendingScheduleSegments[selectedBlocklistId] || []);
                    const newPending = JSON.stringify(newSegments);
                    if (currentPending !== newPending) {
                        appData.settings.pendingScheduleSegments[selectedBlocklistId] = newSegments.map(seg => ({ ...seg }));
                        saveData();
                    }
                } else {
                    // No new segments - clear any pending segments
                    if (appData.settings.pendingScheduleSegments[selectedBlocklistId]) {
                        delete appData.settings.pendingScheduleSegments[selectedBlocklistId];
                        saveData();
                    }
                }
            }
        }
        return;
    }

    // --- Always-on mode: show a preview block from now to end of visible week ---
    if (isAlwaysOnMode) {
        startBtn.disabled = !selectedBlocklistId;

        // Hide next-day indicator
        if (nextDayIndicator) nextDayIndicator.classList.add('hidden');

        if (noBlocksMsg) noBlocksMsg.classList.add('hidden');

        // Render a preview block from now to the end of the visible week
        const blocklist = appData.blocklists.find(bl => bl.id === selectedBlocklistId);
        const now = Date.now();
        const hasActiveBlock = blocklist && appData.activeBlocks.some(b => b.blocklistId === selectedBlocklistId && b.startTime <= now && b.endTime > now);

        if (blocklist && currentWeekStart && !hasActiveBlock) {
            const blockStart = new Date();
            const { renderEnd } = getCalendarRenderRange();
            renderPreviewBlock(blockStart, renderEnd, blocklist);
        } else {
            // Remove preview if there's an active block or no blocklist
            document.querySelectorAll('.calendar-block.preview').forEach(el => el.remove());
        }

        updateWindowHeight();
        return;
    }

    // --- Instant mode logic ---
    // Get times (start is always now)
    let blockStart = getStartTimeAsDate();
    let blockEnd = getEndTimeAsDate();

    // Determine block end time
    if (!userEditedEndTime && targetDurationMinutes > 0) {
        // If driving by duration, exact calculation
        blockEnd = new Date(blockStart.getTime() + targetDurationMinutes * 60 * 1000);
    } else {
        // If driving by end time picker, assume nearest future time (handle overnight)
        if (blockEnd <= blockStart) {
            blockEnd.setDate(blockEnd.getDate() + 1);
        }
    }

    // Calculate how many days in the future the end time is
    const startDay = new Date(blockStart);
    startDay.setHours(0, 0, 0, 0);
    const endDay = new Date(blockEnd);
    endDay.setHours(0, 0, 0, 0);
    const daysDiff = Math.round((endDay - startDay) / (24 * 60 * 60 * 1000));

    // Show/hide day indicator with correct count
    if (nextDayIndicator) {
        if (daysDiff > 0) {
            if (daysDiff === 1) {
                nextDayIndicator.textContent = 'tomorrow';
            } else {
                // For >1 days, show date like "8 Jan"
                const dateStr = blockEnd.getDate() + ' ' + blockEnd.toLocaleString('default', { month: 'short' });
                nextDayIndicator.textContent = dateStr;
            }
            nextDayIndicator.classList.remove('hidden');
        } else {
            nextDayIndicator.classList.add('hidden');
        }
    }

    // Calculate duration
    const durationMs = blockEnd.getTime() - blockStart.getTime();
    const durationMinutes = Math.round(durationMs / 60000);

    if (durationMinutes <= 0) {
        startBtn.disabled = true;
        return;
    }

    // Sync duration input and quick buttons with calculated duration
    const durationInput = document.getElementById('duration-minutes-input');
    if (durationInput && document.activeElement !== durationInput) {
        durationInput.value = durationMinutes;
    }
    updateDurationQuickBtns(durationMinutes);

    // Save duration to settings per-blocklist so it persists across blocklist selections
    if (selectedBlocklistId) {
        if (!appData.settings) appData.settings = {};
        if (!appData.settings.instantBlockDuration) appData.settings.instantBlockDuration = {};
        if (appData.settings.instantBlockDuration[selectedBlocklistId] !== durationMinutes) {
            appData.settings.instantBlockDuration[selectedBlocklistId] = durationMinutes;
            saveData();
        }
    }

    startBtn.disabled = !selectedBlocklistId;
    if (noBlocksMsg) {
        noBlocksMsg.classList.add('hidden');
    }

    // Create preview block in week calendar (only if no active block for this blocklist)
    const blocklist = appData.blocklists.find(bl => bl.id === selectedBlocklistId);
    const now = Date.now();
    const hasActiveBlock = blocklist && appData.activeBlocks.some(b => b.blocklistId === selectedBlocklistId && b.startTime <= now && b.endTime > now);

    if (blocklist && currentWeekStart && !hasActiveBlock) {
        renderPreviewBlock(blockStart, blockEnd, blocklist);
    }

    updateWindowHeight();
}

// Render schedule preview blocks on the calendar
function renderSchedulePreview() {
    if (!selectedBlocklistId || !currentWeekStart) return;

    const blocklist = appData.blocklists.find(bl => bl.id === selectedBlocklistId);
    if (!blocklist) return;
    const draftCreatedAt = Date.now();
    const shouldRepeat = scheduleRepeatType === 'forever' || scheduleRepeatType === 'date';

    // Determine the visible date range (21 days: 7 before anchor to 7 after anchor + 7)
    const renderStart = new Date(currentWeekStart);
    renderStart.setDate(renderStart.getDate() - 7);

    if (!shouldRepeat) {
        const draftOccurrences = resolveOneShotOccurrences({
            repeatType: 'no',
            createdAt: draftCreatedAt,
            segments: scheduleSegments
        }).filter(occurrence => occurrence.segmentIndex >= activeScheduleSegmentCount);

        draftOccurrences.forEach(occurrence => {
            renderPreviewBlock(occurrence.start, occurrence.end, blocklist, true, occurrence.segmentIndex);
        });

        layoutOverlappingBlocks();
        return;
    }

    // For each segment, render blocks on its specific days
    const nowMs = draftCreatedAt;
    scheduleSegments.forEach((segment, segmentIndex) => {
        // Determine if this is a locked (active) segment or a new preview segment
        const isLockedSegment = segmentIndex < activeScheduleSegmentCount;
        if (isLockedSegment) return;

        // Get the days for this segment (0=Mon, 1=Tue, ..., 6=Sun)
        const segmentDays = segment.days || [];

        // Repeating schedules render across all visible weeks.
        const daysToRender = 21;

        for (let d = 0; d < daysToRender; d++) {
            const dayDate = new Date(renderStart);
            dayDate.setDate(dayDate.getDate() + d);

            // Convert JS day (0=Sun) to our format (0=Mon)
            const jsDayOfWeek = dayDate.getDay();
            const dayIndex = jsDayOfWeek === 0 ? 6 : jsDayOfWeek - 1;

            // Check if this day matches any selected days in the segment
            if (!segmentDays.includes(dayIndex)) continue;

            // For date-limited schedules, check if outside the "until" date
            if (scheduleRepeatType === 'date' && scheduleRepeatDate && dayDate > scheduleRepeatDate) {
                continue;
            }

            const blockStart = new Date(dayDate);
            blockStart.setHours(segment.startHour, segment.startMinute, 0, 0);

            const blockEnd = new Date(dayDate);
            blockEnd.setHours(segment.endHour, segment.endMinute, 0, 0);

            // Handle overnight blocks
            if (blockEnd <= blockStart) {
                blockEnd.setDate(blockEnd.getDate() + 1);
            }

            // A forever/until-date schedule starts running when the user confirms it — it
            // doesn't backfill the past. Skip occurrences that have already fully elapsed,
            // and for one currently in progress, clamp the start to "now".
            if (blockEnd.getTime() <= nowMs) continue;
            if (blockStart.getTime() < nowMs) blockStart.setTime(nowMs);

            // Render only pending/new segments as preview in schedule mode.
            renderPreviewBlock(blockStart, blockEnd, blocklist, true, segmentIndex);
        }
    });

    layoutOverlappingBlocks();
}

// Render an active (locked) schedule block on the calendar (not a preview)
function renderActiveScheduleBlock(blockStart, blockEnd, blocklist, segmentIndex) {
    const startDay = new Date(blockStart);
    startDay.setHours(0, 0, 0, 0);

    const endDay = new Date(blockEnd);
    endDay.setHours(0, 0, 0, 0);

    let currentDay = new Date(startDay);

    while (currentDay <= endDay) {
        const dateStr = localDateKey(currentDay);
        const track = document.querySelector(`.day-track[data-date="${dateStr}"]`);

        if (track) {
            const dayStart = new Date(currentDay);
            dayStart.setHours(0, 0, 0, 0);
            const dayEnd = new Date(currentDay);
            dayEnd.setHours(23, 59, 59, 999);

            const {
                topPosition,
                height,
                segmentStartDate,
                segmentEndDate
            } = getCalendarSegmentLayout(blockStart.getTime(), blockEnd.getTime(), dayStart.getTime(), dayEnd.getTime());

            const startTimeStr = formatTime(segmentStartDate);
            const endTimeStr = formatTime(segmentEndDate);

            const blockEl = document.createElement('div');
            blockEl.className = 'calendar-block active-schedule';
            blockEl.dataset.segmentIndex = segmentIndex;
            blockEl.style.top = `${topPosition}px`;
            blockEl.style.height = `${height}px`;

            if (blocklist.color) {
                blockEl.style.background = blocklist.color;
                blockEl.style.color = getContrastTextColor(blocklist.color);
            }

            blockEl.innerHTML = `
                <span class="block-emoji">${blocklist.emoji || '🚫'}</span>
                <span class="block-label">${escapeHtml(blocklist.name)}</span>
                <span class="block-time">${startTimeStr} - ${endTimeStr}</span>
                <span class="schedule-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/></svg></span>
            `;

            track.appendChild(blockEl);
        }

        currentDay.setDate(currentDay.getDate() + 1);
    }
}

function renderScheduledCalendarInterval(schedule, blockStart, blockEnd, blocklist, segmentIndex) {
    const startDay = new Date(blockStart);
    startDay.setHours(0, 0, 0, 0);

    const endDay = new Date(blockEnd);
    endDay.setHours(0, 0, 0, 0);

    const fullStartTimeStr = formatTime(blockStart);
    const fullEndTimeStr = formatTime(blockEnd);
    let currentDay = new Date(startDay);

    while (currentDay <= endDay) {
        const dateStr = localDateKey(currentDay);
        const track = document.querySelector(`.day-track[data-date="${dateStr}"]`);

        if (track) {
            const dayStart = new Date(currentDay);
            dayStart.setHours(0, 0, 0, 0);
            const dayEnd = new Date(currentDay);
            dayEnd.setHours(23, 59, 59, 999);

            const {
                topPosition,
                height
            } = getCalendarSegmentLayout(blockStart.getTime(), blockEnd.getTime(), dayStart.getTime(), dayEnd.getTime());

            const dayIndex = currentDay.getDay() === 0 ? 6 : currentDay.getDay() - 1;
            const isContinuationDay = currentDay.getTime() > startDay.getTime();
            const blockEl = document.createElement('div');
            blockEl.className = `calendar-block scheduled${isContinuationDay ? ' overnight-continuation' : ''}`;
            blockEl.dataset.scheduleId = schedule.id;
            blockEl.dataset.segmentIndex = segmentIndex;
            blockEl.dataset.day = dayIndex;
            blockEl.style.top = `${topPosition}px`;
            blockEl.style.height = `${height}px`;

            if (blocklist.color) {
                blockEl.style.background = blocklist.color;
                blockEl.style.opacity = '0.7';
                blockEl.style.color = getContrastTextColor(blocklist.color);
            }

            blockEl.innerHTML = `
                <span class="block-emoji">${blocklist.emoji || '🚫'}</span>
                <span class="block-label">${escapeHtml(blocklist.name)}</span>
                <span class="block-time">${fullStartTimeStr} - ${fullEndTimeStr}</span>
                <span class="schedule-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/></svg></span>
            `;

            blockEl.addEventListener('click', (e) => {
                e.stopPropagation();
                openScheduledBlockOverrideModal(schedule, segmentIndex, dayIndex);
            });

            track.appendChild(blockEl);
        }

        currentDay.setDate(currentDay.getDate() + 1);
    }
}

// Render preview block on week calendar
function renderPreviewBlock(blockStart, blockEnd, blocklist, skipClear = false, segmentIndex = null) {
    // Clear any existing preview blocks first (unless rendering multiple schedule blocks)
    if (!skipClear) {
        document.querySelectorAll('.calendar-block.preview').forEach(el => el.remove());
    }

    const startDay = new Date(blockStart);
    startDay.setHours(0, 0, 0, 0);

    const endDay = new Date(blockEnd);
    endDay.setHours(0, 0, 0, 0);

    // Render preview in each day it spans
    let currentDay = new Date(startDay);

    while (currentDay <= endDay) {
        const dateStr = localDateKey(currentDay);
        const track = document.querySelector(`.day-track[data-date="${dateStr}"]`);

        if (track) {
            // Calculate start time for this day segment
            const dayStart = new Date(currentDay);
            dayStart.setHours(0, 0, 0, 0);
            const dayEnd = new Date(currentDay);
            dayEnd.setHours(23, 59, 59, 999);

            const {
                topPosition,
                height,
                segmentStartDate,
                segmentEndDate
            } = getCalendarSegmentLayout(blockStart.getTime(), blockEnd.getTime(), dayStart.getTime(), dayEnd.getTime());

            const previewEl = document.createElement('div');
            previewEl.className = 'calendar-block preview';
            previewEl.style.top = `${topPosition}px`;
            previewEl.style.height = `${height}px`;
            previewEl.dataset.previewGroupId = segmentIndex !== null ? `preview-segment-${segmentIndex}` : 'preview-instant';

            if (segmentIndex !== null) {
                previewEl.dataset.segmentIndex = segmentIndex;
                previewEl.classList.add('interactive');
            }

            if (blocklist.color) {
                previewEl.style.background = blocklist.color;
                previewEl.style.color = getContrastTextColor(blocklist.color);
            }

            // Add resize handles for schedule mode
            const resizeHandles = segmentIndex !== null ? `
                <div class="resize-handle resize-handle-top" data-handle="top" style="cursor: ns-resize;"></div>
                <div class="resize-handle resize-handle-bottom" data-handle="bottom" style="cursor: ns-resize;"></div>
            ` : '';

            previewEl.innerHTML = `
                ${resizeHandles}
                <span class="block-emoji">${blocklist.emoji || '🚫'}</span>
                <span class="block-label">${escapeHtml(blocklist.name)}</span>
                <span class="block-time">${formatTime(segmentStartDate)} - ${formatTime(segmentEndDate)}</span>
            `;

            // Attach drag/resize event handlers for schedule mode
            if (segmentIndex !== null && isScheduleMode) {
                attachPreviewBlockDragHandlers(previewEl, segmentIndex, track);
            }

            track.appendChild(previewEl);
        }

        // Move to next day
        currentDay.setDate(currentDay.getDate() + 1);
    }

    if (!skipClear) {
        layoutOverlappingBlocks();
    }
}

// Attach drag and resize handlers to a preview block
function attachPreviewBlockDragHandlers(previewEl, segmentIndex, track) {
    let isDragging = false;
    let isResizing = false;
    let resizeHandle = null;
    let startY = 0;
    let startX = 0;
    let startTop = 0;
    let startHeight = 0;
    let startDayIndex = null;
    let currentHoverTrack = track;
    let clickOffsetX = 0; // Offset from track center where user clicked
    const pixelsPerHour = 40;
    const snapMinutes = 15; // Snap to 15-minute intervals

    // Get the day index from the track's date
    function getDayIndexFromTrack(trackEl) {
        const dateStr = trackEl.dataset.date;
        if (!dateStr) return null;
        const date = parseLocalDateKey(dateStr);
        if (!date) return null;
        // Convert JS day (0=Sun) to our format (0=Mon)
        const jsDay = date.getDay();
        return jsDay === 0 ? 6 : jsDay - 1;
    }

    // Get the original day this block represents
    startDayIndex = getDayIndexFromTrack(track);

    // Convert pixels to minutes
    function pixelsToMinutes(px) {
        return (px / pixelsPerHour) * 60;
    }

    // Snap minutes to nearest interval
    function snapToInterval(minutes) {
        return Math.round(minutes / snapMinutes) * snapMinutes;
    }

    // Convert minutes to hours/minutes object
    function minutesToTime(totalMinutes) {
        totalMinutes = Math.max(0, Math.min(1440, totalMinutes)); // Clamp to 0-24 hours
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        return { hours: Math.min(23, hours), minutes };
    }

    // Update segment times and optionally days, then refresh UI
    function updateSegmentTimesAndDays(newStartMinutes, newEndMinutes, dayShift = 0) {
        const startTime = minutesToTime(newStartMinutes);
        const endTime = minutesToTime(newEndMinutes);

        // Ensure minimum duration of 15 minutes
        if (newEndMinutes - newStartMinutes < 15) {
            return;
        }

        scheduleSegments[segmentIndex].startHour = startTime.hours;
        scheduleSegments[segmentIndex].startMinute = startTime.minutes;
        scheduleSegments[segmentIndex].endHour = endTime.hours;
        scheduleSegments[segmentIndex].endMinute = endTime.minutes;

        // If there's a day shift, update the days array
        if (dayShift !== 0) {
            const segment = scheduleSegments[segmentIndex];
            const oldDays = segment.days || [];
            const newDays = oldDays.map(d => {
                let newDay = d + dayShift;
                // Wrap around the week (0-6)
                if (newDay < 0) newDay += 7;
                if (newDay > 6) newDay -= 7;
                return newDay;
            });
            segment.days = newDays;

            // Update the day toggle buttons in the UI
            updateDayToggleUI(segmentIndex);
        }

        // Update the time picker UI
        updateTimePickerUI(segmentIndex);

        // Re-render preview blocks
        document.querySelectorAll('.calendar-block.preview').forEach(el => el.remove());
        renderSchedulePreview();
    }

    // Update time picker buttons to reflect new times
    function updateTimePickerUI(index) {
        const segment = scheduleSegments[index];
        const startHourBtn = document.querySelector(`[data-target="schedule-start-${index}"][data-type="hour"]`);
        const startMinBtn = document.querySelector(`[data-target="schedule-start-${index}"][data-type="minute"]`);
        const endHourBtn = document.querySelector(`[data-target="schedule-end-${index}"][data-type="hour"]`);
        const endMinBtn = document.querySelector(`[data-target="schedule-end-${index}"][data-type="minute"]`);

        if (startHourBtn) startHourBtn.textContent = String(segment.startHour).padStart(2, '0');
        if (startMinBtn) startMinBtn.textContent = String(segment.startMinute).padStart(2, '0');
        if (endHourBtn) endHourBtn.textContent = String(segment.endHour).padStart(2, '0');
        if (endMinBtn) endMinBtn.textContent = String(segment.endMinute).padStart(2, '0');
    }

    // Update day toggle buttons in the schedule segment UI
    function updateDayToggleUI(index) {
        const segment = scheduleSegments[index];
        const days = segment.days || [];
        const segmentContainer = document.querySelector(`.schedule-segment[data-segment-index="${index}"]`);
        if (!segmentContainer) return;

        const dayButtons = segmentContainer.querySelectorAll('.segment-day-toggle');
        dayButtons.forEach(btn => {
            const dayIndex = parseInt(btn.dataset.day);
            if (days.includes(dayIndex)) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
    }

    // Add hover listeners to resize handles to change cursor
    const resizeHandles = previewEl.querySelectorAll('.resize-handle');
    resizeHandles.forEach(handle => {
        handle.addEventListener('mouseenter', () => {
            previewEl.classList.add('resize-hover');
        });
        handle.addEventListener('mouseleave', () => {
            previewEl.classList.remove('resize-hover');
        });
    });

    // Mouse down handler
    previewEl.addEventListener('mousedown', (e) => {
        // Check if clicking on a resize handle
        const handle = e.target.closest('.resize-handle');
        if (handle) {
            isResizing = true;
            resizeHandle = handle.dataset.handle;
            previewEl.classList.add('resizing');
            document.body.style.cursor = 'ns-resize';
        } else {
            isDragging = true;
            previewEl.classList.add('dragging');
            document.body.style.cursor = 'grabbing';
        }

        startY = e.clientY;
        startX = e.clientX;
        startTop = parseFloat(previewEl.style.top) || 0;
        startHeight = parseFloat(previewEl.style.height) || 40;
        currentHoverTrack = track;

        // Calculate offset from track center where user clicked (for accurate day boundary detection)
        const trackRect = track.getBoundingClientRect();
        const trackCenterX = trackRect.left + trackRect.width / 2;
        clickOffsetX = e.clientX - trackCenterX;

        e.preventDefault();

        // Add mouse move and up handlers to document
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    });

    function handleMouseMove(e) {
        const deltaY = e.clientY - startY;

        if (isDragging) {
            // Find all preview blocks for this segment
            const allSegmentBlocks = document.querySelectorAll(`.calendar-block.preview[data-segment-index="${segmentIndex}"]`);

            // Move all blocks vertically together
            const newTop = Math.max(0, startTop + deltaY);
            const maxTop = (24 * pixelsPerHour) - parseFloat(previewEl.style.height);
            const finalTop = Math.min(newTop, maxTop);

            allSegmentBlocks.forEach(block => {
                block.style.top = `${finalTop}px`;
                block.classList.add('dragging');
            });

            // Check if mouse is over a different day track - move all blocks together horizontally
            const allTracks = Array.from(document.querySelectorAll('.day-track'));
            let targetTrackIndex = -1;

            // Use offset-corrected position to detect which day we're over
            // This ensures the block moves when cursor crosses the day boundary, not before/after
            const effectiveX = e.clientX - clickOffsetX;

            for (let i = 0; i < allTracks.length; i++) {
                const rect = allTracks[i].getBoundingClientRect();
                const trackCenterX = rect.left + rect.width / 2;
                // Check if the effective center is within this track
                if (effectiveX >= rect.left && effectiveX <= rect.right) {
                    targetTrackIndex = i;
                    currentHoverTrack = allTracks[i];
                    break;
                }
            }

            if (targetTrackIndex >= 0) {
                // Calculate day shift from original track position
                const originalTrackIndex = allTracks.indexOf(track);
                const dayShiftDuringDrag = targetTrackIndex - originalTrackIndex;

                // Move all segment blocks to their shifted day positions
                allSegmentBlocks.forEach(block => {
                    // Get this block's original track (stored as data attribute or calculate from current position)
                    if (!block.dataset.originalTrackIndex) {
                        block.dataset.originalTrackIndex = allTracks.indexOf(block.parentElement);
                    }
                    const blockOriginalIndex = parseInt(block.dataset.originalTrackIndex);
                    const newTrackIndex = blockOriginalIndex + dayShiftDuringDrag;

                    // Move block to new track if in valid range
                    if (newTrackIndex >= 0 && newTrackIndex < allTracks.length) {
                        if (allTracks[newTrackIndex] !== block.parentElement) {
                            allTracks[newTrackIndex].appendChild(block);
                        }
                    }
                });
            }
        } else if (isResizing) {
            // Find all preview blocks for this segment
            const allSegmentBlocks = document.querySelectorAll(`.calendar-block.preview[data-segment-index="${segmentIndex}"]`);

            if (resizeHandle === 'top') {
                // Resize from top - adjust start time
                const newTop = Math.max(0, startTop + deltaY);
                const newHeight = startHeight - deltaY;
                if (newHeight >= 10) { // Minimum height
                    allSegmentBlocks.forEach(block => {
                        block.style.top = `${newTop}px`;
                        block.style.height = `${newHeight}px`;
                    });
                }
            } else if (resizeHandle === 'bottom') {
                // Resize from bottom - adjust end time
                const newHeight = Math.max(10, startHeight + deltaY);
                const maxHeight = (24 * pixelsPerHour) - startTop;
                const finalHeight = Math.min(newHeight, maxHeight);
                allSegmentBlocks.forEach(block => {
                    block.style.height = `${finalHeight}px`;
                });
            }
        }
    }

    function handleMouseUp(e) {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);

        // Remove classes and data from all blocks in this segment
        const allSegmentBlocks = document.querySelectorAll(`.calendar-block.preview[data-segment-index="${segmentIndex}"]`);
        allSegmentBlocks.forEach(block => {
            block.classList.remove('dragging');
            block.classList.remove('resizing');
            delete block.dataset.originalTrackIndex;
        });
        document.body.style.cursor = '';

        if (isDragging || isResizing) {
            // Calculate new times based on final position
            const finalTop = parseFloat(previewEl.style.top) || 0;
            const finalHeight = parseFloat(previewEl.style.height) || 40;

            const newStartMinutes = snapToInterval(pixelsToMinutes(finalTop));
            const newEndMinutes = snapToInterval(pixelsToMinutes(finalTop + finalHeight));

            // Calculate day shift if block was moved to different day
            let dayShift = 0;
            if (isDragging && currentHoverTrack !== track) {
                const newDayIndex = getDayIndexFromTrack(currentHoverTrack);
                if (newDayIndex !== null && startDayIndex !== null) {
                    dayShift = newDayIndex - startDayIndex;
                }
            }

            updateSegmentTimesAndDays(newStartMinutes, newEndMinutes, dayShift);
        }

        isDragging = false;
        isResizing = false;
        resizeHandle = null;
    }
}

// Handle blocklist selection
function handleBlocklistSelect(e) {
    const newBlocklistId = e.target.value || null;

    // Before switching, save pending changes for the current blocklist
    if (selectedBlocklistId) {
        // Save pending schedule segments if in schedule mode
        if (isScheduleMode) {
            const existingSchedule = appData.schedules?.find(s => s.blocklistId === selectedBlocklistId);
            if (!appData.settings) appData.settings = {};
            if (!appData.settings.pendingScheduleSegments) appData.settings.pendingScheduleSegments = {};

            if (!existingSchedule) {
                // No active schedule - save all segments
                if (scheduleSegments.length > 0) {
                    appData.settings.pendingScheduleSegments[selectedBlocklistId] = scheduleSegments.map(seg => ({ ...seg }));
                    saveData();
                }
            } else {
                // Active schedule exists - save only NEW segments (those beyond activeScheduleSegmentCount)
                const committedSegmentCount = getCommittedScheduleSegmentCount(existingSchedule);
                if (scheduleSegments.length > committedSegmentCount) {
                    const newSegments = scheduleSegments.slice(committedSegmentCount);
                    appData.settings.pendingScheduleSegments[selectedBlocklistId] = newSegments.map(seg => ({ ...seg }));
                    saveData();
                } else {
                    // No new segments - clear any pending segments
                    if (appData.settings.pendingScheduleSegments[selectedBlocklistId]) {
                        delete appData.settings.pendingScheduleSegments[selectedBlocklistId];
                        saveData();
                    }
                }
            }
        } else {
            // Save pending instant block duration if in instant mode
            if (!appData.settings) appData.settings = {};
            if (!appData.settings.instantBlockDuration) appData.settings.instantBlockDuration = {};
            if (targetDurationMinutes !== 60) { // Only save if different from default
                appData.settings.instantBlockDuration[selectedBlocklistId] = targetDurationMinutes;
                saveData();
            }
        }
    }

    selectedBlocklistId = newBlocklistId;

    const timePicker = document.getElementById('time-picker-container');
    const passwordHint = document.getElementById('password-hint');
    const selectionPrompt = document.getElementById('selection-prompt');
    const startBlockBtn = document.getElementById('start-block-btn');
    const startScheduleBtn = document.getElementById('start-schedule-btn');
    const modeTabs = document.querySelector('.scheduler-mode-tabs');

    if (selectedBlocklistId) {
        // Determine which mode to show based on active blocks/schedules
        const blocklist = appData.blocklists.find(bl => bl.id === selectedBlocklistId);
        const now = Date.now();

        // Check if there's an active block (one-off)
        const hasActiveBlock = blocklist && appData.activeBlocks.some(b =>
            b.blocklistId === selectedBlocklistId && b.startTime <= now && b.endTime > now
        );

        // Check if there's an active schedule
        const existingSchedule = appData.schedules
            ? appData.schedules.find(s => s.blocklistId === selectedBlocklistId)
            : null;
        const hasActiveSchedule = existingSchedule && existingSchedule.segments && existingSchedule.segments.length > 0;

        // Determine default mode:
        if (hasActiveBlock && !hasActiveSchedule) {
            setScheduleMode(false);
        } else if (hasActiveSchedule && !hasActiveBlock) {
            setScheduleMode(true);
        } else if (hasActiveBlock && hasActiveSchedule) {
            setScheduleMode(false);
        } else {
            // No active block or schedule: restore this blocklist's last-viewed tab (instant vs schedule)
            const preferredSchedule = appData.settings?.preferredStartMode?.[selectedBlocklistId];
            setScheduleMode(preferredSchedule === true);
        }

        // Hide selection prompt, show time picker, hint, tabs, and appropriate button
        if (selectionPrompt) selectionPrompt.classList.add('hidden');
        timePicker.classList.remove('hidden');
        if (passwordHint) passwordHint.classList.remove('hidden');
        if (modeTabs) modeTabs.classList.remove('hidden');

        // Show the appropriate button based on mode
        if (isScheduleMode) {
            if (startBlockBtn) startBlockBtn.classList.add('hidden');
            if (startScheduleBtn) {
                startScheduleBtn.classList.remove('hidden');
                updateScheduleButtonState();
            }
        } else {
            if (startScheduleBtn) startScheduleBtn.classList.add('hidden');
            if (startBlockBtn) {
                startBlockBtn.classList.remove('hidden');

                const blocklist = appData.blocklists.find(bl => bl.id === selectedBlocklistId);
                const now = Date.now();
                // IMPORTANT: Only find active block for THIS specific blocklist
                const activeBlock = appData.activeBlocks.find(b =>
                    b.blocklistId === selectedBlocklistId &&
                    b.startTime <= now &&
                    b.endTime > now
                );

                if (blocklist) {
                    const btnLabel = startBlockBtn.querySelector('.btn-label');
                    const btnName = startBlockBtn.querySelector('.btn-name');
                    const btnIcon = startBlockBtn.querySelector('svg');

                    // Always clear the activeBlockId first to prevent cross-blocklist issues
                    delete startBlockBtn.dataset.activeBlockId;
                    startBlockBtn.classList.remove('stop-block');

                    const pauseBtn = document.getElementById('pause-block-btn');

                    if (activeBlock) {
                        // Active block - show Stop Block button (grey) with unlock icon
                        if (btnLabel) btnLabel.textContent = 'Stop Block:';
                        if (btnName) btnName.textContent = blocklist.name;
                        startBlockBtn.classList.add('stop-block');
                        startBlockBtn.disabled = false;
                        startBlockBtn.dataset.activeBlockId = activeBlock.id;

                        // Show pause button with correct appearance
                        if (pauseBtn) {
                            pauseBtn.classList.remove('hidden');
                            updatePauseButtonAppearance(!!activeBlock.isPaused);
                        }

                        // Change to unlock icon
                        if (btnIcon) {
                            btnIcon.innerHTML = `
                                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                                <path d="M7 11V7a5 5 0 0 1 9.9-1"></path>
                            `;
                        }

                        // Disable time controls
                        disableTimeControls(true);

                        // Keep the info message visible for active always-on blocks.
                        const alwaysOnMsg = document.getElementById('always-on-message');
                        const durationToggle = document.getElementById('duration-mode-toggle');
                        if (alwaysOnMsg) alwaysOnMsg.classList.toggle('hidden', !isBlockAlwaysOn(activeBlock));
                        if (durationToggle) durationToggle.classList.add('hidden');
                    } else {
                        // No active block - show Start Block button (normal) with lock icon
                        // Ensure we've already cleared the activeBlockId above
                        if (btnLabel) btnLabel.textContent = tSettings('startBlockButton');
                        if (btnName) btnName.textContent = blocklist.name;

                        // Change to lock icon
                        if (btnIcon) {
                            btnIcon.innerHTML = `
                                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                                <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                            `;
                        }

                        // Enable time controls
                        disableTimeControls(false);

                        // Re-show duration mode toggle and always-on message based on current mode
                        const alwaysOnMsg = document.getElementById('always-on-message');
                        const durationToggle = document.getElementById('duration-mode-toggle');
                        if (durationToggle) durationToggle.classList.remove('hidden');
                        if (alwaysOnMsg) alwaysOnMsg.classList.toggle('hidden', !isAlwaysOnMode);

                        // Hide pause button
                        if (pauseBtn) pauseBtn.classList.add('hidden');
                    }
                }
            }
        }
        initializeTimeInputs();
    } else {
        // Show selection prompt, hide time picker, hint, tabs, and both buttons
        if (selectionPrompt) selectionPrompt.classList.remove('hidden');
        timePicker.classList.add('hidden');
        if (passwordHint) passwordHint.classList.add('hidden');
        if (modeTabs) modeTabs.classList.add('hidden');
        if (startBlockBtn) startBlockBtn.classList.add('hidden');
        if (startScheduleBtn) startScheduleBtn.classList.add('hidden');
        const pauseBtn = document.getElementById('pause-block-btn');
        if (pauseBtn) pauseBtn.classList.add('hidden');
    }

    // Update visual selection state on blocklist cards
    renderBlocklists();

    handleTimeChange(); // Update button state and preview

    // Wait for DOM reflow to capture the correct height after showing/hiding elements
    setTimeout(() => {
        updateWindowHeight();
    }, 50);
}

// Deselect current blocklist (same behavior as clicking on background).
// Used by click-outside handler and ESC key.
function deselectBlocklist() {
    if (!selectedBlocklistId) return;
    const currentBlocklistId = selectedBlocklistId;
    if (isScheduleMode) {
        const existingSchedule = appData.schedules?.find(s => s.blocklistId === currentBlocklistId);
        if (!appData.settings) appData.settings = {};
        if (!appData.settings.pendingScheduleSegments) appData.settings.pendingScheduleSegments = {};

        if (!existingSchedule) {
            if (scheduleSegments.length > 0) {
                appData.settings.pendingScheduleSegments[currentBlocklistId] = scheduleSegments.map(seg => ({ ...seg }));
                saveData();
            }
        } else {
            const committedSegmentCount = getCommittedScheduleSegmentCount(existingSchedule);
            if (scheduleSegments.length > committedSegmentCount) {
                const newSegments = scheduleSegments.slice(committedSegmentCount);
                appData.settings.pendingScheduleSegments[currentBlocklistId] = newSegments.map(seg => ({ ...seg }));
                saveData();
            } else {
                if (appData.settings.pendingScheduleSegments[currentBlocklistId]) {
                    delete appData.settings.pendingScheduleSegments[currentBlocklistId];
                    saveData();
                }
            }
        }
    } else {
        if (!appData.settings) appData.settings = {};
        if (!appData.settings.instantBlockDuration) appData.settings.instantBlockDuration = {};
        if (targetDurationMinutes !== 60) {
            appData.settings.instantBlockDuration[currentBlocklistId] = targetDurationMinutes;
            saveData();
        }
    }
    selectedBlocklistId = null;
    const blocklistSelect = document.getElementById('blocklist-select');
    blocklistSelect.value = '';
    handleBlocklistSelect({ target: blocklistSelect });
}

// Show start block confirmation modal
function startBlock() {
    if (!selectedBlocklistId) return;

    const blocklist = appData.blocklists.find(bl => bl.id === selectedBlocklistId);
    if (!blocklist) return;

    // Check if this is a "Stop Block" action (button is in stop mode)
    const startBlockBtn = document.getElementById('start-block-btn');
    if (startBlockBtn && startBlockBtn.dataset.activeBlockId) {
        // Verify the activeBlockId belongs to the currently selected blocklist
        const activeBlock = appData.activeBlocks.find(b =>
            b.id === startBlockBtn.dataset.activeBlockId &&
            b.blocklistId === selectedBlocklistId
        );

        if (activeBlock) {
            // Open override dialog instead of starting a new block
            openOverrideModal(startBlockBtn.dataset.activeBlockId);
            return;
        } else {
            // ActiveBlockId doesn't match selected blocklist - clear it and continue
            delete startBlockBtn.dataset.activeBlockId;
            startBlockBtn.classList.remove('stop-block');
        }
    }

    // Calculate duration for display
    let durationText = '';
    if (isAlwaysOnMode) {
        durationText = tSettings('alwaysUntilOff');
    } else {
        // Get times for display
        let blockStart = getStartTimeAsDate();
        let blockEnd = getEndTimeAsDate();
        if (blockEnd <= blockStart) {
            blockEnd.setDate(blockEnd.getDate() + 1);
        }

        const durationMs = blockEnd.getTime() - blockStart.getTime();
        const durationMinutes = Math.round(durationMs / 60000);
        const hours = Math.floor(durationMinutes / 60);
        const mins = durationMinutes % 60;
        if (hours > 0 && mins > 0) {
            durationText = `${hours}h ${mins}m`;
        } else if (hours > 0) {
            durationText = `${hours} hour${hours > 1 ? 's' : ''}`;
        } else {
            durationText = `${mins} minute${mins > 1 ? 's' : ''}`;
        }
    }

    // Populate blocklist name
    document.getElementById('start-confirm-name').textContent = blocklist.name;

    // Populate duration
    document.getElementById('start-confirm-duration').textContent = durationText;

    // Helper to format list with show all
    const formatListWithShowAll = (items, elementId, showAllBtnId, rowId) => {
        const valueEl = document.getElementById(elementId);
        const showAllBtn = document.getElementById(showAllBtnId);
        const rowEl = document.getElementById(rowId);

        if (!items || items.length === 0) {
            rowEl.classList.add('hidden');
            return;
        }

        rowEl.classList.remove('hidden');

        if (items.length <= 3) {
            valueEl.textContent = items.map(cleanUrlForDisplay).join(', ');
            showAllBtn.classList.add('hidden');
        } else {
            const displayItems = items.slice(0, 3).map(cleanUrlForDisplay);
            valueEl.textContent = displayItems.join(', ') + ', ...';
            showAllBtn.classList.remove('hidden');
            showAllBtn.onclick = () => {
                valueEl.textContent = items.map(cleanUrlForDisplay).join(', ');
                showAllBtn.classList.add('hidden');
            };
        }
    };

    // Populate websites
    formatListWithShowAll(blocklist.websites, 'start-confirm-websites', 'show-all-websites', 'websites-row');

    // Populate apps (apps don't need URL cleaning)
    const appsValueEl = document.getElementById('start-confirm-apps');
    const showAllAppsBtn = document.getElementById('show-all-apps');
    const appsRowEl = document.getElementById('apps-row');

    const displayApps = getBlocklistDisplayApps(blocklist);
    if (displayApps.length === 0) {
        appsRowEl.classList.add('hidden');
    } else {
        appsRowEl.classList.remove('hidden');
        if (displayApps.length <= 3) {
            appsValueEl.textContent = displayApps.join(', ');
            showAllAppsBtn.classList.add('hidden');
        } else {
            appsValueEl.textContent = displayApps.slice(0, 3).join(', ') + ', ...';
            showAllAppsBtn.classList.remove('hidden');
            showAllAppsBtn.onclick = () => {
                appsValueEl.textContent = displayApps.join(', ');
                showAllAppsBtn.classList.add('hidden');
            };
        }
    }

    // Build override difficulty text with time estimate
    const difficulty = blocklist.overrideDifficulty || { type: 'random-words', count: 50 };
    let overrideText = '';

    // Estimate typing time: ~20 chars/min for random/gibberish (it's slow!), ~30 for custom text
    let charCount = difficulty.count;
    let charsPerMinute = 150; // Conservative for random words (average typing is ~200 chars/min)

    if (difficulty.type === 'custom' && difficulty.customText) {
        charCount = difficulty.customText.length;
        charsPerMinute = 200; // Custom text is slightly easier (you can see the pattern)
        const estimatedMinutes = Math.ceil(charCount / charsPerMinute);
        overrideText = `Type a specific ${charCount}-character phrase exactly as shown (~${estimatedMinutes} min).`;
    } else if (difficulty.type === 'gibberish') {
        charsPerMinute = 100; // Gibberish is the hardest
        const estimatedMinutes = Math.ceil(charCount / charsPerMinute);
        const charWord = charCount === 1 ? 'character' : 'characters';
        overrideText = `Type ${charCount} random ${charWord} (letters and numbers) exactly as shown (~${estimatedMinutes} min).`;
    } else {
        const estimatedMinutes = Math.ceil(charCount / charsPerMinute);
        const charWord = charCount === 1 ? 'character' : 'characters';
        overrideText = `Type ${charCount} ${charWord} (displayed as random words) exactly as shown (~${estimatedMinutes} min).`;
    }

    document.getElementById('start-confirm-override-text').textContent = overrideText;

    // Show modal
    document.getElementById('start-block-confirm-modal').classList.remove('hidden');
}

// Close start block confirmation modal
function closeStartBlockConfirmModal() {
    document.getElementById('start-block-confirm-modal').classList.add('hidden');
    // Reset resume state and restore default text
    if (resumeData) {
        resumeData = null;
        document.querySelector('#start-block-confirm-modal .modal-content h3').textContent = 'Start this block?';
        document.getElementById('proceed-start-confirm-btn').textContent = tSettings('startBlock');
    }
}

// Actually start a block (called after confirmation)
async function proceedWithBlock() {
    // If this is a resume action, delegate to proceedWithResume
    if (resumeData) {
        await proceedWithResume();
        return;
    }

    // Close confirmation modal
    closeStartBlockConfirmModal();

    const startBtn = document.getElementById('start-block-btn');

    if (!selectedBlocklistId) return;

    // Get times from the custom time picker
    let blockStart = getStartTimeAsDate();
    let blockEnd;

    if (isAlwaysOnMode) {
        // Always-on: use far-future end time
        blockEnd = new Date(ALWAYS_ON_END_TIME);
    } else {
        blockEnd = getEndTimeAsDate();
        // If end is before or equal to start, assume end is next day
        if (blockEnd <= blockStart) {
            blockEnd.setDate(blockEnd.getDate() + 1);
        }
    }

    // Disable button while processing
    startBtn.disabled = true;
    startBtn.textContent = 'Starting...';

    const blocklist = appData.blocklists.find(bl => bl.id === selectedBlocklistId);
    if (!blocklist) {
        startBtn.disabled = false;
        startBtn.innerHTML = getStartBlockButtonHTML();
        return;
    }
    if (!ensureIOSBlocklistSelectionReady(blocklist, 'starting this block')) {
        startBtn.disabled = false;
        startBtn.innerHTML = getStartBlockButtonHTML();
        return;
    }

    const block = {
        id: generateId(),
        blocklistId: selectedBlocklistId,
        startTime: blockStart.getTime(),
        endTime: blockEnd.getTime()
    };

    // Mark always-on blocks with a flag for display purposes
    if (isAlwaysOnMode) {
        block.isAlwaysOn = true;
    }

    let result;

    if (isIOS) {
        // iOS: Use Screen Time API via plugin
        if (!screentimeAuthorized) {
            const authResult = await requestScreentimeAuth();
            if (!authResult.granted) {
                startBtn.disabled = false;
                startBtn.innerHTML = getStartBlockButtonHTML();
                if (authResult.status === 'denied') {
                    alert('Screen Time authorization was denied. Please go to Settings > Screen Time > ReDD Block and enable access.');
                } else if (authResult.error) {
                    alert('Screen Time authorization failed: ' + authResult.error);
                } else {
                    alert('Screen Time authorization is required to block websites. Please try again.');
                }
                updateOnboardingVisibility();
                return;
            }
            updateOnboardingVisibility();
        }

        try {
            // Apply union of all active blocks + active schedule segments (not just this blocklist).
            appData.activeBlocks.push(block);
            activatedBlockIds.add(block.id);
            const updateResult = await updateHostsFile();
            if (!updateResult.success) {
                appData.activeBlocks = appData.activeBlocks.filter(b => b.id !== block.id);
                activatedBlockIds.delete(block.id);
                result = { success: false, error: updateResult.error || 'Failed to update blocking' };
            } else {
                result = { success: true };
                // Register one-off DeviceActivity so block ends at endTime when app is closed
                // Register one-off DeviceActivity so block ends at endTime when app is closed (Option B: store this block's payload to remove)
                if (!block.isAlwaysOn && block.endTime < ALWAYS_ON_END_TIME) {
                    try {
                        const iosPayload = getBlocklistIOSPayload(blocklist);
                        await tauriAPI.screentimeSetBlockEndState({
                            blockId: block.id,
                            domains: Array.from(blocklist?.websites || []),
                            appTokenData: iosPayload.appTokenData,
                            categoryTokenData: iosPayload.categoryTokenData
                        });
                        const res = await tauriAPI.screentimeRegisterOneOffActivity('redd-block-end-' + block.id, block.endTime);
                        if (res && res.success === false) {
                            console.error('[iOS] One-off DeviceActivity registration failed:', res.error || 'Unknown error');
                        }
                    } catch (e) {
                        console.warn('[iOS] One-off block-end registration failed:', e);
                    }
                }
            }
        } catch (err) {
            appData.activeBlocks = appData.activeBlocks.filter(b => b.id !== block.id);
            activatedBlockIds.delete(block.id);
            result = { success: false, error: err.toString() };
        }
    } else {
        // Desktop: Try to use the helper daemon (no password required!)
        if (helperAvailable) {
            // Re-verify helper is still reachable before starting block (avoids stale "available" state on Windows)
            const status = await tauriAPI.checkHelperStatus();
            if (!status.running || !status.version_ok) {
                helperAvailable = false;
            }
        }
        // v2: the app process IS the helper. startBlockViaHelper is a
        // no-op shim that just acknowledges the save_data the
        // frontend already did. The legacy "is the helper installed?"
        // / install-modal branch was here.
        result = await tauriAPI.startBlockViaHelper({
            domains: blocklist.websites || [],
            endTime: blockEnd.getTime(),
            blocklistId: selectedBlocklistId
        });
    }

    if (!result.success) {
        // Re-enable button
        startBtn.disabled = false;
        startBtn.innerHTML = getStartBlockButtonHTML();

        // Only show error if user didn't cancel
        if (!result.cancelled) {
            if (isHelperConnectionError(result.error)) {
                helperAvailable = false;
                alert('The block service isn\'t running. Please open Settings, remove the helper, then try starting a block again to reinstall it.');
            } else {
                alert('Could not start block: ' + (result.error || 'Unknown error'));
            }
        }
        return;
    }

    // Add block to local data (desktop: push here; iOS already pushed in branch above)
    if (!isIOS && helperAvailable) {
        appData.activeBlocks.push(block);
        activatedBlockIds.add(block.id);
    }

    // Clear pending duration for this blocklist (it's now committed)
    if (appData.settings?.instantBlockDuration?.[selectedBlocklistId]) {
        delete appData.settings.instantBlockDuration[selectedBlocklistId];
    }

    // Save data and reset UI
    await saveData();

    // Update blocked apps (handles both active blocks and schedules)
    await updateBlockedApps();

    // Render UI to update blocklist cards (show ACTIVE badge)
    render();

    // Restore button HTML structure first (textContent = 'Starting...' wiped it)
    const startBtn2 = document.getElementById('start-block-btn');
    startBtn2.innerHTML = getStartBlockButtonHTML();
    startBtn2.disabled = false;

    // Ensure the blocklist stays selected in dropdown and update UI to show Stop Block button
    const blocklistSelect = document.getElementById('blocklist-select');
    blocklistSelect.value = selectedBlocklistId; // Make sure it's still set
    handleBlocklistSelect({ target: blocklistSelect });
}

// Helper function for start block button HTML (includes .btn-label and .btn-name for updateability)
function getStartBlockButtonHTML() {
    return `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
        </svg>
        <span class="btn-label">${tSettings('startBlockButton')}</span>
        <span class="btn-name"></span>
    `;
}


// Update hosts file based on active blocks
// silent = true means don't prompt for password (used for cleanup)
async function updateHostsFile(silent = false) {
    const allDomains = new Set();
    const now = Date.now();

    // Only block domains for blocks that are currently active and not paused
    appData.activeBlocks
        .filter(block => block.startTime <= now && block.endTime > now && !block.isPaused)
        .forEach(block => {
            const blocklist = appData.blocklists.find(bl => bl.id === block.blocklistId);
            if (blocklist && blocklist.websites) {
                blocklist.websites.forEach(domain => allDomains.add(domain));
            }
        });

    // Also check scheduled blocks - add domains if a schedule segment is currently active
    const nowDate = new Date();

    if (appData.schedules) {
        appData.schedules.forEach(schedule => {
            if (!schedule.segments) return;

            // Skip paused schedules
            if (schedule.isPaused && schedule.pauseEndTime > Date.now()) return;

            if (isScheduleSegmentActiveNow(schedule, nowDate)) {
                const blocklist = appData.blocklists.find(bl => bl.id === schedule.blocklistId);
                if (blocklist && blocklist.websites) {
                    blocklist.websites.forEach(domain => allDomains.add(domain));
                }
            }
        });
    }

    // Filter out protected domains (localhost etc. must never be blocked)
    const domainsArray = Array.from(allDomains)
        .filter(d => !isProtectedDomain(d))
        .sort();
    const lastDomainsArray = Array.from(lastBlockedDomains).sort();
    const domainsChanged = JSON.stringify(domainsArray) !== JSON.stringify(lastDomainsArray);

    // iOS: Use Screen Time API instead of helper daemon / hosts file
    // Only clear when there are no active blocks; when there are active blocks, always apply
    // (even when domainsArray is empty — app-only blocklists must still shield apps).
    if (isIOS) {
        try {
            const manualPayload = collectActiveIOSManualBlockPayload(now);
            const hasActiveBlocks = appData.activeBlocks.some(
                block => block.startTime <= now && block.endTime > now && !block.isPaused
            );
            const hasActiveScheduleSegments = (appData.schedules || []).some(schedule => {
                if (!schedule || !schedule.segments || schedule.segments.length === 0) return false;
                if (schedule.isPaused && schedule.pauseEndTime > now) return false;
                if (schedule.repeatType === 'date' && schedule.repeatDate) {
                    const endDate = new Date(schedule.repeatDate);
                    endDate.setHours(23, 59, 59, 999);
                    if (nowDate > endDate) return false;
                }
                return isScheduleSegmentActiveNow(schedule, nowDate);
            });
            if (!hasActiveBlocks) {
                if (hasActiveScheduleSegments) {
                    // Schedule enforcement on iOS is owned by the DeviceActivityMonitor extension.
                    // Avoid clearing stores here or we can wipe an active scheduled block.
                    console.log('[updateHostsFile] iOS: no manual blocks but schedule segment is active; keeping schedule enforcement');
                    lastBlockedDomains = new Set();
                    return { success: true };
                }
                console.log('[updateHostsFile] iOS: no active blocks, clearing Screen Time');
                await tauriAPI.screentimeClearBlock();
                lastBlockedDomains = new Set();
                return { success: true };
            }
            if (manualPayload.domains.length === 0) {
                console.log('[updateHostsFile] iOS: active blocks with no domains (app-only), applying app shield');
            } else {
                console.log('[updateHostsFile] iOS: starting Screen Time block for', manualPayload.domains);
            }
            await tauriAPI.screentimeStartBlock(manualPayload);
            lastBlockedDomains = new Set(manualPayload.domains);
            return { success: true };
        } catch (err) {
            console.error('[updateHostsFile] iOS Screen Time error:', err);
            return { success: false, error: err.toString() };
        }
    }

    if (!domainsChanged) {
        return { success: true, unchanged: true };
    }

    // Try to use helper daemon first (works on all platforms)
    try {
        console.log('[updateHostsFile] Checking helper status...');
        const status = await tauriAPI.checkHelperStatus();
        console.log('[updateHostsFile] Helper status:', status);

        if (status.running && status.version_ok) {
            console.log('[updateHostsFile] Helper running with correct version, using helper to update blocks');
            helperAvailable = true;
            await syncActiveBlocksToHelper();
            await syncSchedulesToHelper();
            lastBlockedDomains = allDomains;
            await updateBlockedApps();
            return { success: true };
        } else {
            console.log('[updateHostsFile] Helper NOT running, falling back');
        }
    } catch (e) {
        console.warn('Helper not available, falling back to direct method:', e);
    }

    // For silent cleanup without the helper, defer instead of triggering an elevation prompt.
    if (silent && allDomains.size < lastBlockedDomains.size) {
        return { success: true, deferred: true };
    }

    // Fallback to direct hosts file modification (macOS)
    console.log('[updateHostsFile] Calling fallback block-websites');
    const result = await tauriAPI.blockWebsites(domainsArray);

    if (result && result.success) {
        lastBlockedDomains = allDomains;
        // Update blocked apps based on active blocks and schedules
        await updateBlockedApps();
    }

    return result || { success: true };
}

// Update blocked apps sent to the helper. Only one-off (manual) block apps are sent here.
// Schedule-based app blocking is owned solely by set_schedules via syncSchedulesToHelper();
// the helper merges manual + active schedule apps internally.
async function updateBlockedApps() {
    // iOS uses Screen Time API for app blocking - skip desktop process watcher
    if (isIOS) return;

    const allBlockedApps = new Set();
    const now = Date.now();

    // Collect apps from active one-off blocks only (skip paused). Do not include schedule-derived
    // apps here; they are synced via set_schedules and the helper computes effective list.
    appData.activeBlocks
        .filter(block => block.startTime <= now && block.endTime > now && !block.isPaused)
        .forEach(block => {
            const blocklist = appData.blocklists.find(bl => bl.id === block.blocklistId);
            if (blocklist && blocklist.apps) {
                blocklist.apps.forEach(app => allBlockedApps.add(app));
            }
        });

    // Filter out protected apps (ReDD Block must never block itself)
    const appsArray = Array.from(allBlockedApps)
        .filter(app => !isProtectedApp(app))
        .sort();

    // Send blocked apps to helper daemon
    let helperReady = helperAvailable;
    if (!helperReady && appsArray.length > 0) {
        try {
            const status = await tauriAPI.checkHelperStatus();
            helperReady = !!(status.running && status.version_ok);
            helperAvailable = helperReady;
        } catch (e) {
            console.warn('[updateBlockedApps] Helper status re-check failed:', e);
        }
    }

    if (helperReady) {
        try {
            const result = await tauriAPI.setBlockedAppsViaHelper(appsArray);
            if (result && result.success) {
                console.log('[updateBlockedApps] Apps set via helper daemon:', appsArray.length, 'apps');
            } else {
                console.warn('[updateBlockedApps] Helper failed to set blocked apps:', result?.error);
            }
        } catch (e) {
            console.warn('[updateBlockedApps] Failed to set blocked apps via helper:', e);
        }
    } else if (appsArray.length > 0) {
        console.warn('[updateBlockedApps] Helper not available - app blocking requires the helper daemon');
    }
}

// Open blocklist modal
function openBlocklistModal(blocklist = null) {
    editingBlocklistId = blocklist?.id || null;
    blocklistModalPreviewSnapshot = null;

    if (editingBlocklistId) {
        const original = appData.blocklists.find(b => b.id === editingBlocklistId);
        if (original) {
            blocklistModalPreviewSnapshot = {
                alwaysShowInSchedule: original.alwaysShowInSchedule,
                showItemDetails: original.showItemDetails
            };
        }
    }

    document.getElementById('modal-title').textContent = blocklist ? tSettings('editBlocklist') : tSettings('createBlocklist');

    document.getElementById('blocklist-name').value = blocklist?.name || '';
    document.getElementById('blocklist-name').classList.remove('input-error');
    lastBlocklistNameValue = blocklist?.name || '';

    const normalizedDifficulty = cloneOverrideDifficulty(blocklist?.overrideDifficulty, 10);
    document.getElementById('override-type').value = normalizedDifficulty.type;
    document.getElementById('override-count').value = normalizedDifficulty.count;
    document.getElementById('custom-override-text').value = normalizedDifficulty.customText || '';
    const maxDifficultyCb = document.getElementById('override-max-difficulty-checkbox');
    const maxDifficulty = normalizedDifficulty.maxDifficulty === true;
    if (maxDifficultyCb) maxDifficultyCb.checked = maxDifficulty;

    const type = normalizedDifficulty.type;
    const overrideCountField = document.getElementById('override-count');
    const customTextArea = document.getElementById('custom-override-text');
    applyOverrideTypeUi(type);
    overrideCountField.value = normalizeOverrideCount(overrideCountField.value, type);
    customTextArea.maxLength = getMaxOverrideCharsForType('custom');
    customTextArea.value = normalizeCustomOverrideText(customTextArea.value);
    lastOverrideCountValue = String(overrideCountField.value);
    lastCustomOverrideTextValue = customTextArea.value;
    lastOverrideTypeValue = document.getElementById('override-type').value;

    if (maxDifficulty) {
        lastOverrideCountValueBeforeMaxDifficulty = normalizedDifficulty.countBeforeMax ?? 50;
        lastOverrideTypeValueBeforeMaxDifficulty = normalizedDifficulty.typeBeforeMax ?? 'random-words';
        const maxCount = getMaxOverrideCharsForType(type);
        overrideCountField.value = String(maxCount);
        overrideCountField.max = String(maxCount);
        setOverrideCountMaxMode(true);
    } else {
        setOverrideCountMaxMode(false);
    }
    lastOverrideCountValue = String(overrideCountField.value);

    // Restore color swatch selection
    document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));

    let colorToSelect = blocklist?.color;

    // If creating a new blocklist (or no color set), find the first unused color
    if (!colorToSelect) {
        const usedColors = new Set(appData.blocklists.map(bl => bl.color));
        const swatches = Array.from(document.querySelectorAll('.color-swatch:not(.custom-swatch)'));

        // Find first color from the palette that isn't used
        const firstUnused = swatches.find(s => !usedColors.has(s.dataset.color));

        if (firstUnused) {
            colorToSelect = firstUnused.dataset.color;
        } else if (swatches.length > 0) {
            // If all are used, wrap around to the first one
            colorToSelect = swatches[0].dataset.color;
        } else {
            // Fallback default
            colorToSelect = 'linear-gradient(135deg, #4a00e0 0%, #8e2de2 100%)';
        }
    }

    const matchingSwatch = document.querySelector(`.color-swatch[data-color="${colorToSelect}"]:not(.custom-swatch)`);
    if (matchingSwatch) {
        matchingSwatch.classList.add('selected');
    } else {
        // Must be a custom color
        const customSwatch = document.getElementById('custom-color-swatch');
        if (customSwatch) {
            customSwatch.style.background = colorToSelect;
            customSwatch.dataset.color = colorToSelect;
            customSwatch.classList.add('selected');
        }
    }

    // Restore emoji swatch selection
    document.querySelectorAll('.emoji-swatch').forEach(s => s.classList.remove('selected'));

    let emojiToSelect = blocklist?.emoji;

    // If creating a new blocklist (or no emoji set), find the first unused emoji
    if (!emojiToSelect) {
        const usedEmojis = new Set(appData.blocklists.map(bl => bl.emoji));
        const emojiSwatches = Array.from(document.querySelectorAll('.emoji-swatch:not(.custom-emoji-swatch)'));

        // Find first emoji from the palette that isn't used
        const firstUnused = emojiSwatches.find(s => !usedEmojis.has(s.dataset.emoji));

        if (firstUnused) {
            emojiToSelect = firstUnused.dataset.emoji;
        } else if (emojiSwatches.length > 0) {
            // If all are used, wrap around to the first one
            emojiToSelect = emojiSwatches[0].dataset.emoji;
        } else {
            // Fallback default
            emojiToSelect = '🚫';
        }
    }

    const matchingEmoji = document.querySelector(`.emoji-swatch[data-emoji="${emojiToSelect}"]:not(.custom-emoji-swatch)`);
    if (matchingEmoji) {
        matchingEmoji.classList.add('selected');
    } else {
        // Must be a custom emoji
        const customEmojiSwatch = document.getElementById('custom-emoji-swatch');
        if (customEmojiSwatch) {
            customEmojiSwatch.innerHTML = emojiToSelect;
            customEmojiSwatch.dataset.emoji = emojiToSelect;
            customEmojiSwatch.classList.add('selected');
        }
    }

    // Check if active (block or schedule)
    const now = Date.now();
    const hasActiveBlock = blocklist?.id && appData.activeBlocks.some(
        b => b.blocklistId === blocklist.id && b.startTime <= now && b.endTime > now
    );
    const hasActiveSchedule = blocklist?.id && appData.schedules?.some(
        s => s.blocklistId === blocklist.id && s.segments && s.segments.length > 0
    );
    const isActive = hasActiveBlock || hasActiveSchedule;

    const warningEl = document.getElementById('active-blocklist-warning');
    const modeInputs = document.getElementById('blocklist-modal').querySelectorAll('.radio-option');
    const overrideInputs = [
        document.getElementById('override-type'),
        document.getElementById('override-count'),
        document.getElementById('custom-override-text'),
        document.getElementById('override-max-difficulty-checkbox')
    ];
    const maxDifficultyWrap = document.getElementById('override-max-difficulty-wrap');

    // Get override elements for styling
    const overrideTypeSelect = document.getElementById('override-type');
    const overrideCountInput = document.getElementById('override-count');
    const overrideCountWrapperEl = document.getElementById('override-count-wrapper');
    const inputSuffix = overrideCountWrapperEl?.querySelector('.input-suffix');

    if (isActive) {
        warningEl.classList.remove('hidden');
        modeInputs.forEach(el => el.classList.add('disabled'));
        overrideInputs.forEach(el => el.disabled = true);

        // Style override type dropdown (like repeat dropdown)
        if (overrideTypeSelect) {
            overrideTypeSelect.classList.add('form-select-disabled');
        }

        // Style override count input (like repeat dropdown)
        if (overrideCountInput) {
            overrideCountInput.classList.add('form-input-disabled');
        }

        // Style the "total characters" text (same color as Start/End labels)
        if (inputSuffix) {
            inputSuffix.classList.add('input-suffix-disabled');
        }
        if (maxDifficultyWrap) maxDifficultyWrap.classList.add('max-difficulty-disabled');

        // Pass existing items as locked
        window.setModalData(
            blocklist.websites || [],
            getBlocklistRegularApps(blocklist),
            getBlocklistIOSScreenTimeSelection(blocklist),
            blocklist.websites || [],
            getBlocklistDisplayApps(blocklist)
        );
    } else {
        warningEl.classList.add('hidden');
        modeInputs.forEach(el => el.classList.remove('disabled'));
        overrideInputs.forEach(el => el.disabled = false);

        // Remove disabled styling
        if (overrideTypeSelect) {
            overrideTypeSelect.classList.remove('form-select-disabled');
        }
        if (overrideCountInput) {
            overrideCountInput.classList.remove('form-input-disabled');
        }
        if (inputSuffix) {
            inputSuffix.classList.remove('input-suffix-disabled');
        }
        if (maxDifficultyWrap) maxDifficultyWrap.classList.remove('max-difficulty-disabled');

        window.setModalData(
            blocklist?.websites || [],
            getBlocklistRegularApps(blocklist),
            getBlocklistIOSScreenTimeSelection(blocklist),
            [],
            []
        );
    }

    // Re-apply max-difficulty grey-out for count when blocklist is not active (above else branch removes it)
    if (!isActive && document.getElementById('override-max-difficulty-checkbox')?.checked) {
        setOverrideCountMaxMode(true);
    }

    // Set advanced options - default to checked (true) if not set
    const showItemDetailsCheckbox = document.getElementById('show-item-details-checkbox');
    if (showItemDetailsCheckbox) {
        showItemDetailsCheckbox.checked = blocklist?.showItemDetails !== false;
        showItemDetailsCheckbox.onchange = () => {
            if (!editingBlocklistId) return;
            const bl = appData.blocklists.find(b => b.id === editingBlocklistId);
            if (!bl) return;
            bl.showItemDetails = showItemDetailsCheckbox.checked;
            renderBlocklists();
        };
    }

    const alwaysShowInScheduleCheckbox = document.getElementById('always-show-in-schedule-checkbox');
    if (alwaysShowInScheduleCheckbox) {
        alwaysShowInScheduleCheckbox.checked = blocklist?.alwaysShowInSchedule !== false;
        alwaysShowInScheduleCheckbox.onchange = () => {
            if (!editingBlocklistId) return;
            const bl = appData.blocklists.find(b => b.id === editingBlocklistId);
            if (!bl) return;
            bl.alwaysShowInSchedule = alwaysShowInScheduleCheckbox.checked;
            renderWeekBlocks();
        };
    }

    // Reset advanced options to collapsed state
    const blocklistAdvancedToggle = document.getElementById('blocklist-advanced-toggle');
    const blocklistAdvancedContent = document.getElementById('blocklist-advanced-content');
    if (blocklistAdvancedToggle && blocklistAdvancedContent) {
        blocklistAdvancedToggle.classList.remove('expanded');
        blocklistAdvancedContent.classList.add('hidden');
    }

    document.getElementById('blocklist-modal').classList.remove('hidden');

    // Reset scroll position after modal is shown
    const modalContent = document.querySelector('#blocklist-modal .modal-content');
    if (modalContent) modalContent.scrollTop = 0;
}

// Close blocklist modal
function closeBlocklistModal() {
    blocklistModalUndoStack.length = 0;
    blocklistModalApplyingUndo = false;
    lastBlocklistNameValue = '';
    lastOverrideCountValue = '';
    lastCustomOverrideTextValue = '';
    lastOverrideTypeValue = '';
    lastOverrideCountValueBeforeMaxDifficulty = 50;
    lastOverrideTypeValueBeforeMaxDifficulty = 'random-words';
    overridePreviewFrozenByType = { 'random-words': null, 'gibberish': null };
    lastOverridePreviewType = null;
    setOverrideCountMaxMode(false);

    // Revert temporary live-preview edits if dialog closes without save.
    if (editingBlocklistId && blocklistModalPreviewSnapshot) {
        const bl = appData.blocklists.find(b => b.id === editingBlocklistId);
        if (bl) {
            bl.alwaysShowInSchedule = blocklistModalPreviewSnapshot.alwaysShowInSchedule;
            bl.showItemDetails = blocklistModalPreviewSnapshot.showItemDetails;
            renderWeekBlocks();
            renderBlocklists();
        }
    }

    const showItemDetailsCheckbox = document.getElementById('show-item-details-checkbox');
    const alwaysShowInScheduleCheckbox = document.getElementById('always-show-in-schedule-checkbox');
    if (showItemDetailsCheckbox) showItemDetailsCheckbox.onchange = null;
    if (alwaysShowInScheduleCheckbox) alwaysShowInScheduleCheckbox.onchange = null;

    blocklistModalPreviewSnapshot = null;
    document.getElementById('blocklist-modal').classList.add('hidden');
    editingBlocklistId = null;
    document.getElementById('blocklist-name').value = '';
    window.setModalData([], [], null);
}

// Open override modal
function openOverrideModal(blockId) {
    overrideBlockId = blockId;
    const block = appData.activeBlocks.find(b => b.id === blockId);
    overrideBlocklistIdForHelper = block ? block.blocklistId : null;

    const blocklist = appData.blocklists.find(bl => bl.id === block?.blocklistId);

    if (!blocklist) return;

    // Set modal title with blocklist name
    document.getElementById('override-modal-title').textContent = `Override ${blocklist.name}?`;

    // Set summary text
    const websiteCount = blocklist.websites?.length || 0;
    const displayApps = getBlocklistDisplayApps(blocklist);
    const appCount = displayApps.length;
    const mode = blocklist.mode === 'allowlist' ? 'Allows' : 'Blocks';

    let metaParts = [];

    if (websiteCount > 0) {
        const displaySites = blocklist.websites.map(cleanUrlForDisplay);
        if (websiteCount <= 3) {
            metaParts.push(`${websiteCount} ${websiteWord(websiteCount)} (${displaySites.join(', ')})`);
        } else {
            metaParts.push(`${websiteCount} ${websiteWord(websiteCount)} (${displaySites.slice(0, 3).join(', ')}, ...)`);
        }
    }

    if (appCount > 0) {
        if (appCount <= 3) {
            metaParts.push(`${appCount} ${appCount === 1 ? 'app' : 'apps'} (${displayApps.join(', ')})`);
        } else {
            metaParts.push(`${appCount} apps (${displayApps.slice(0, 3).join(', ')}, ...)`);
        }
    }

    const itemsText = metaParts.length > 0 ? metaParts.join(` ${tSettings('andWord')} `) : tSettings('nothingWord');
    document.getElementById('override-summary').textContent = `${mode} ${itemsText}`;

    const difficulty = blocklist.overrideDifficulty || { type: 'random-words', count: 50 };

    // Generate challenge text
    if (difficulty.type === 'custom' && difficulty.customText) {
        challengeText = difficulty.customText;
    } else if (difficulty.type === 'gibberish') {
        challengeText = generateGibberish(difficulty.count);
    } else {
        challengeText = generateRandomWords(difficulty.count);
    }

    // Sanitize: remove linebreaks and collapse multiple spaces
    challengeText = challengeText.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

    document.getElementById('challenge-text').textContent = challengeText;
    document.getElementById('challenge-input').value = '';

    const progressBar = document.getElementById('challenge-progress-bar');
    progressBar.style.width = '0%';
    // Use the blocklist's color for the progress bar
    if (blocklist.color) {
        progressBar.style.background = blocklist.color;
    } else {
        progressBar.style.background = 'linear-gradient(90deg, #667eea 0%, #764ba2 100%)';
    }

    // Reset wiggle state
    document.querySelector('#override-modal .modal-content').classList.remove('wiggle');

    document.getElementById('override-modal').classList.remove('hidden');
}

// Close override modal
function closeOverrideModal() {
    document.getElementById('override-modal').classList.add('hidden');
    overrideBlockId = null;
    overrideBlocklistIdForHelper = null;
    challengeText = '';
}

// ── Pause/Resume Block ──

// Update the pause button's icon and text based on whether the block/schedule is paused
function updatePauseButtonAppearance(isPaused) {
    const pauseBtn = document.getElementById('pause-block-btn');
    if (!pauseBtn) return;

    const svg = pauseBtn.querySelector('svg');
    const span = pauseBtn.querySelector('span');

    if (isPaused) {
        // Show play icon and "Resume" text
        if (svg) {
            svg.innerHTML = '<polygon points="5 3 19 12 5 21 5 3"></polygon>';
        }
        if (span) span.textContent = 'Resume';
        pauseBtn.classList.add('resume-mode');
    } else {
        // Show pause icon and "Pause" text
        if (svg) {
            svg.innerHTML = '<rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect>';
        }
        if (span) span.textContent = 'Pause';
        pauseBtn.classList.remove('resume-mode');
    }
}

// Open the resume confirmation dialog (reuses start-block-confirm modal)
let resumeData = null; // { blocklistId, type: 'block'|'schedule', blockId }

function openResumeConfirmation(blocklistId, type, blockId) {
    const blocklist = appData.blocklists.find(bl => bl.id === blocklistId);
    if (!blocklist) return;

    resumeData = { blocklistId, type, blockId };

    // Set heading
    document.querySelector('#start-block-confirm-modal .modal-content h3').textContent = 'Resume this block?';

    // Set blocklist name
    document.getElementById('start-confirm-name').textContent = blocklist.name;

    // Set duration text
    if (type === 'block') {
        const block = appData.activeBlocks.find(b => b.id === blockId);
        if (block) {
            const remainingMs = block.endTime - Date.now();
            if (isBlockAlwaysOn(block)) {
                document.getElementById('start-confirm-duration').textContent = tSettings('alwaysUntilOff');
            } else {
                const remainingMins = Math.max(1, Math.floor(remainingMs / 60000));
                const hours = Math.floor(remainingMins / 60);
                const mins = remainingMins % 60;
                let dText = '';
                if (hours > 0 && mins > 0) dText = `${hours}h ${mins}m remaining`;
                else if (hours > 0) dText = `${hours} hour${hours > 1 ? 's' : ''} remaining`;
                else dText = `${mins} minute${mins > 1 ? 's' : ''} remaining`;
                document.getElementById('start-confirm-duration').textContent = dText;
            }
        }
    } else {
        document.getElementById('start-confirm-duration').textContent = tSettings('scheduleResumingSegment');
    }

    // Populate websites
    const websitesRow = document.getElementById('websites-row');
    const websitesEl = document.getElementById('start-confirm-websites');
    const showAllWebsites = document.getElementById('show-all-websites');
    if (blocklist.websites && blocklist.websites.length > 0) {
        websitesRow.classList.remove('hidden');
        if (blocklist.websites.length <= 3) {
            websitesEl.textContent = blocklist.websites.map(cleanUrlForDisplay).join(', ');
            showAllWebsites.classList.add('hidden');
        } else {
            websitesEl.textContent = blocklist.websites.slice(0, 3).map(cleanUrlForDisplay).join(', ') + ', ...';
            showAllWebsites.classList.remove('hidden');
            showAllWebsites.onclick = () => {
                websitesEl.textContent = blocklist.websites.map(cleanUrlForDisplay).join(', ');
                showAllWebsites.classList.add('hidden');
            };
        }
    } else {
        websitesRow.classList.add('hidden');
    }

    // Populate apps
    const appsRow = document.getElementById('apps-row');
    const appsEl = document.getElementById('start-confirm-apps');
    const showAllApps = document.getElementById('show-all-apps');
    const displayApps = getBlocklistDisplayApps(blocklist);
    if (displayApps.length > 0) {
        appsRow.classList.remove('hidden');
        if (displayApps.length <= 3) {
            appsEl.textContent = displayApps.join(', ');
            showAllApps.classList.add('hidden');
        } else {
            appsEl.textContent = displayApps.slice(0, 3).join(', ') + ', ...';
            showAllApps.classList.remove('hidden');
            showAllApps.onclick = () => {
                appsEl.textContent = displayApps.join(', ');
                showAllApps.classList.add('hidden');
            };
        }
    } else {
        appsRow.classList.add('hidden');
    }

    // Override info
    const difficulty = blocklist.overrideDifficulty || { type: 'random-words', count: 50 };
    let overrideText = '';
    let charCount = difficulty.count;

    if (difficulty.type === 'custom' && difficulty.customText) {
        charCount = difficulty.customText.length;
        const estimatedMinutes = Math.ceil(charCount / 200);
        overrideText = `Type a specific ${charCount}-character phrase exactly as shown (~${estimatedMinutes} min).`;
    } else if (difficulty.type === 'gibberish') {
        const estimatedMinutes = Math.ceil(charCount / 100);
        overrideText = `Type ${charCount} random characters exactly as shown (~${estimatedMinutes} min).`;
    } else {
        const estimatedMinutes = Math.ceil(charCount / 150);
        overrideText = `Type ${charCount} characters (displayed as random words) exactly as shown (~${estimatedMinutes} min).`;
    }
    document.getElementById('start-confirm-override-text').textContent = overrideText;

    // Change confirm button text
    document.getElementById('proceed-start-confirm-btn').textContent = tSettings('resumeBlock');

    // Show modal
    document.getElementById('start-block-confirm-modal').classList.remove('hidden');
}

// Actually resume a paused block/schedule
async function proceedWithResume() {
    if (!resumeData) return;

    // Save locally before closeStartBlockConfirmModal clears resumeData
    const { type, blockId, blocklistId } = resumeData;

    closeStartBlockConfirmModal();

    if (type === 'block') {
        const block = appData.activeBlocks.find(b => b.id === blockId);
        if (block) {
            delete block.isPaused;
            delete block.pauseEndTime;
        }
    } else if (type === 'schedule') {
        const schedule = appData.schedules?.find(s => s.blocklistId === blocklistId);
        if (schedule) {
            delete schedule.isPaused;
            delete schedule.pauseEndTime;
        }
    }

    resumeData = null;

    await saveData();
    console.log('[pause-resume] Proceeding with resume sync', { type, blockId, blocklistId });
    await syncActiveBlocksToHelper();
    await syncSchedulesToHelper();
    await updateHostsFile();
    await updateBlockedApps();
    render();

    // Update pause button back to Pause appearance
    updatePauseButtonAppearance(false);
}

// ── Pause Block Modal ──

function openPauseModal(blockId) {
    pauseBlockId = blockId;

    let block, blocklist;

    if (blockId) {
        // One-off block pause
        block = appData.activeBlocks.find(b => b.id === blockId);
        blocklist = appData.blocklists.find(bl => bl.id === block?.blocklistId);
    } else if (pauseScheduleData) {
        // Schedule pause — create a synthetic block object
        blocklist = appData.blocklists.find(bl => bl.id === pauseScheduleData.blocklistId);
        block = {
            id: null,
            blocklistId: pauseScheduleData.blocklistId,
            startTime: Date.now(),
            endTime: ALWAYS_ON_END_TIME,
            isScheduleBlock: true
        };
    }

    if (!blocklist) return;

    // Set modal title
    document.getElementById('pause-modal-title').textContent = `Pause ${blocklist.name}`;

    // Set summary (same format as override modal)
    const websiteCount = blocklist.websites?.length || 0;
    const displayApps = getBlocklistDisplayApps(blocklist);
    const appCount = displayApps.length;
    const mode = blocklist.mode === 'allowlist' ? 'Allows' : 'Blocks';

    let metaParts = [];
    if (websiteCount > 0) {
        const displaySites = blocklist.websites.map(cleanUrlForDisplay);
        if (websiteCount <= 2) {
            metaParts.push(`${websiteCount} ${websiteWord(websiteCount)} (${displaySites.join(', ')})`);
        } else {
            metaParts.push(`${websiteCount} ${websiteWord(websiteCount)} (${displaySites.slice(0, 2).join(', ')}, ...)`);
        }
    }
    if (appCount > 0) {
        if (appCount <= 2) {
            metaParts.push(`${appCount} ${appCount === 1 ? 'app' : 'apps'} (${displayApps.join(', ')})`);
        } else {
            metaParts.push(`${appCount} apps (${displayApps.slice(0, 2).join(', ')}, ...)`);
        }
    }

    const itemsText = metaParts.length > 0 ? metaParts.join(` ${tSettings('andWord')} `) : tSettings('nothingWord');
    document.getElementById('pause-summary').textContent = `${mode} ${itemsText}`;

    // Calculate remaining time and max pause duration
    const remainingInfo = document.getElementById('pause-remaining-info');
    const daysGroup = document.getElementById('pause-days').closest('.pause-time-input-group');
    const hoursGroup = document.getElementById('pause-hours').closest('.pause-time-input-group');

    if (!isBlockAlwaysOn(block)) {
        const remainingMs = block.endTime - Date.now();
        const remainingMins = Math.floor(remainingMs / 60000);
        pauseMaxMinutes = Math.max(1, remainingMins - 2); // 2 min buffer

        // Format remaining time and max pause for display
        const remDays = Math.floor(remainingMins / (24 * 60));
        const remHours = Math.floor((remainingMins % (24 * 60)) / 60);
        const remMins = remainingMins % 60;
        let remParts = [];
        if (remDays > 0) remParts.push(`${remDays}d`);
        if (remHours > 0) remParts.push(`${remHours}h`);
        if (remMins > 0 || remParts.length === 0) remParts.push(`${remMins}m`);

        remainingInfo.textContent = `Block ends in ${remParts.join(' ')}`;
        remainingInfo.classList.remove('hidden');

        // Show/hide fields based on max pause
        if (pauseMaxMinutes < 60) {
            // Less than 1 hour max: hide days and hours
            daysGroup.style.display = 'none';
            hoursGroup.style.display = 'none';
        } else if (pauseMaxMinutes < 24 * 60) {
            // Less than 1 day max: hide days
            daysGroup.style.display = 'none';
            hoursGroup.style.display = '';
        } else {
            daysGroup.style.display = '';
            hoursGroup.style.display = '';
        }
    } else {
        pauseMaxMinutes = null; // No cap for always-on blocks
        if (pauseScheduleData) {
            if (pauseScheduleData.isActiveNow) {
                remainingInfo.classList.add('hidden');
            } else {
                remainingInfo.textContent = 'No scheduled block is active now. Upcoming scheduled blocks will be paused until pause ends.';
                remainingInfo.classList.remove('hidden');
            }
        } else {
            remainingInfo.classList.add('hidden');
        }
        daysGroup.style.display = '';
        hoursGroup.style.display = '';
    }

    // Reset duration inputs
    const defaultMins = pauseMaxMinutes !== null ? Math.min(15, pauseMaxMinutes) : 15;
    document.getElementById('pause-days').value = 0;
    document.getElementById('pause-hours').value = 0;
    document.getElementById('pause-minutes').value = defaultMins;
    initPauseRestartPopovers();
    updatePauseRestartTime();

    // Generate challenge text
    const difficulty = blocklist.overrideDifficulty || { type: 'random-words', count: 50 };
    if (difficulty.type === 'custom' && difficulty.customText) {
        pauseChallengeText = difficulty.customText;
    } else if (difficulty.type === 'gibberish') {
        pauseChallengeText = generateGibberish(difficulty.count);
    } else {
        pauseChallengeText = generateRandomWords(difficulty.count);
    }

    pauseChallengeText = pauseChallengeText.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

    document.getElementById('pause-challenge-text').textContent = pauseChallengeText;
    document.getElementById('pause-challenge-input').value = '';
    document.getElementById('confirm-pause-btn').disabled = true;

    const progressBar = document.getElementById('pause-challenge-progress-bar');
    progressBar.style.width = '0%';
    if (blocklist.color) {
        progressBar.style.background = blocklist.color;
    } else {
        progressBar.style.background = 'linear-gradient(90deg, #667eea 0%, #764ba2 100%)';
    }

    // Reset wiggle
    document.querySelector('#pause-modal .modal-content').classList.remove('wiggle');

    document.getElementById('pause-modal').classList.remove('hidden');
    requestAnimationFrame(() => {
        syncPauseDurationRowLayout();
    });
}

/** Pause modal: use horizontal row only if it fits; otherwise stack (hide arrow). */
function syncPauseDurationRowLayout() {
    const modal = document.getElementById('pause-modal');
    if (!modal || modal.classList.contains('hidden')) return;
    const row = modal.querySelector('.pause-duration-row');
    if (!row) return;
    row.classList.remove('pause-duration-row--stacked');
    void row.offsetWidth;
    if (row.scrollWidth > row.clientWidth + 1) {
        row.classList.add('pause-duration-row--stacked');
    }
}

function closePauseModal() {
    document.getElementById('pause-modal').classList.add('hidden');
    pauseBlockId = null;
    pauseScheduleData = null;
    pauseChallengeText = '';
}

function updatePauseRestartTime() {
    let days = parseInt(document.getElementById('pause-days').value) || 0;
    let hours = parseInt(document.getElementById('pause-hours').value) || 0;
    let minutes = parseInt(document.getElementById('pause-minutes').value) || 0;

    let totalMinutes = days * 24 * 60 + hours * 60 + minutes;

    // Clamp to max if set
    if (pauseMaxMinutes !== null && totalMinutes > pauseMaxMinutes) {
        totalMinutes = pauseMaxMinutes;
        days = Math.floor(totalMinutes / (24 * 60));
        const rem = totalMinutes % (24 * 60);
        hours = Math.floor(rem / 60);
        minutes = rem % 60;
        document.getElementById('pause-days').value = days;
        document.getElementById('pause-hours').value = hours;
        document.getElementById('pause-minutes').value = minutes;
    }

    const restartTime = new Date(Date.now() + totalMinutes * 60 * 1000);

    // Update time-part buttons
    const hourBtn = document.getElementById('pause-restart-hour-btn');
    const minuteBtn = document.getElementById('pause-restart-minute-btn');
    if (hourBtn) hourBtn.textContent = pad(restartTime.getHours());
    if (minuteBtn) minuteBtn.textContent = pad(restartTime.getMinutes());

    // Show +N days badge if restart is not today
    const today = new Date();
    const nextDayBadge = document.getElementById('pause-next-day-indicator');
    if (nextDayBadge) {
        // Calculate day difference
        const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        const restartStart = new Date(restartTime.getFullYear(), restartTime.getMonth(), restartTime.getDate());
        const dayDiff = Math.round((restartStart - todayStart) / (24 * 60 * 60 * 1000));
        if (dayDiff > 0) {
            nextDayBadge.textContent = `+${dayDiff} ${dayDiff === 1 ? 'day' : 'days'}`;
            nextDayBadge.classList.remove('hidden');
        } else {
            nextDayBadge.classList.add('hidden');
        }
    }

    // Update selected state in popovers
    updatePauseRestartPopoverSelection(restartTime.getHours(), restartTime.getMinutes());
    syncPauseDurationRowLayout();
}

function updatePauseRestartPopoverSelection(hour, minute) {
    document.querySelectorAll('#pause-restart-hour-options .popover-option').forEach(btn => {
        btn.classList.toggle('selected', parseInt(btn.dataset.value) === hour);
    });
    document.querySelectorAll('#pause-restart-minute-options .popover-option').forEach(btn => {
        btn.classList.toggle('selected', parseInt(btn.dataset.value) === minute);
    });
}

// Initialize pause restart time popovers with hour/minute options
function initPauseRestartPopovers() {
    const hourContainer = document.getElementById('pause-restart-hour-options');
    if (hourContainer) {
        hourContainer.innerHTML = '';
        for (let h = 0; h < 24; h++) {
            const btn = document.createElement('button');
            btn.className = 'popover-option';
            btn.textContent = pad(h);
            btn.dataset.value = h;
            btn.dataset.type = 'hour';
            btn.dataset.target = 'pause-restart';
            btn.addEventListener('click', selectPauseRestartTimeOption);
            hourContainer.appendChild(btn);
        }
    }

    const minuteContainer = document.getElementById('pause-restart-minute-options');
    if (minuteContainer) {
        minuteContainer.innerHTML = '';
        for (let m = 0; m < 60; m++) {
            const btn = document.createElement('button');
            btn.className = 'popover-option';
            btn.textContent = pad(m);
            btn.dataset.value = m;
            btn.dataset.type = 'minute';
            btn.dataset.target = 'pause-restart';
            btn.addEventListener('click', selectPauseRestartTimeOption);
            minuteContainer.appendChild(btn);
        }
    }

    // Attach click handlers to the time-part buttons
    const hourBtn = document.getElementById('pause-restart-hour-btn');
    const minuteBtn = document.getElementById('pause-restart-minute-btn');
    if (hourBtn) hourBtn.addEventListener('click', handleTimePartClick);
    if (minuteBtn) minuteBtn.addEventListener('click', handleTimePartClick);
}

// When user selects a restart time, reverse-calculate the duration
function selectPauseRestartTimeOption(e) {
    e.stopPropagation();
    const btn = e.currentTarget;
    const value = parseInt(btn.dataset.value);
    const type = btn.dataset.type;

    // Get current restart time from the buttons
    const hourBtn = document.getElementById('pause-restart-hour-btn');
    const minuteBtn = document.getElementById('pause-restart-minute-btn');
    let restartHour = parseInt(hourBtn.textContent);
    let restartMinute = parseInt(minuteBtn.textContent);

    if (type === 'hour') restartHour = value;
    else restartMinute = value;

    // Update button display
    hourBtn.textContent = pad(restartHour);
    minuteBtn.textContent = pad(restartMinute);

    closeAllPopovers();

    // Calculate duration from now to selected restart time
    const now = new Date();
    const restartTime = new Date(now);
    restartTime.setHours(restartHour, restartMinute, 0, 0);

    // If restart time is in the past or within 1 minute, assume next day
    if (restartTime.getTime() <= now.getTime() + 60000) {
        restartTime.setDate(restartTime.getDate() + 1);
    }

    const diffMs = restartTime.getTime() - now.getTime();
    let diffMins = Math.round(diffMs / 60000);

    // Clamp to max if set
    if (pauseMaxMinutes !== null && diffMins > pauseMaxMinutes) {
        diffMins = pauseMaxMinutes;
        // Recalculate restart time from clamped duration
        const clampedRestart = new Date(now.getTime() + diffMins * 60000);
        restartHour = clampedRestart.getHours();
        restartMinute = clampedRestart.getMinutes();
        hourBtn.textContent = pad(restartHour);
        minuteBtn.textContent = pad(restartMinute);
    }

    const durationDays = Math.floor(diffMins / (24 * 60));
    const remainingMins = diffMins % (24 * 60);
    const durationHours = Math.floor(remainingMins / 60);
    const durationMins = remainingMins % 60;

    // Update PAUSE FOR inputs
    document.getElementById('pause-days').value = durationDays;
    document.getElementById('pause-hours').value = durationHours;
    document.getElementById('pause-minutes').value = durationMins;

    // Update +N days badge
    const nextDayBadge = document.getElementById('pause-next-day-indicator');
    if (nextDayBadge) {
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const restartStart = new Date(restartTime.getFullYear(), restartTime.getMonth(), restartTime.getDate());
        const dayDiff = Math.round((restartStart - todayStart) / (24 * 60 * 60 * 1000));
        if (dayDiff > 0) {
            nextDayBadge.textContent = `+${dayDiff} ${dayDiff === 1 ? 'day' : 'days'}`;
            nextDayBadge.classList.remove('hidden');
        } else {
            nextDayBadge.classList.add('hidden');
        }
    }

    updatePauseRestartPopoverSelection(restartHour, restartMinute);
    syncPauseDurationRowLayout();
}

async function proceedWithPause() {
    if (!pauseBlockId && !pauseScheduleData) return;

    const typed = document.getElementById('pause-challenge-input').value;
    if (typed !== pauseChallengeText) {
        // Wiggle on mismatch
        const modal = document.querySelector('#pause-modal .modal-content');
        modal.classList.add('wiggle');
        setTimeout(() => modal.classList.remove('wiggle'), 400);
        return;
    }

    const days = parseInt(document.getElementById('pause-days').value) || 0;
    const hours = parseInt(document.getElementById('pause-hours').value) || 0;
    const minutes = parseInt(document.getElementById('pause-minutes').value) || 0;
    const pauseDurationMs = (days * 24 * 60 + hours * 60 + minutes) * 60 * 1000;

    if (pauseDurationMs <= 0) {
        closePauseModal();
        return;
    }

    if (pauseScheduleData) {
        // Schedule pause — set pause state on the schedule itself
        const schedule = appData.schedules?.find(s => s.blocklistId === pauseScheduleData.blocklistId);
        if (schedule) {
            schedule.isPaused = true;
            schedule.pauseEndTime = Date.now() + pauseDurationMs;
        }
    } else {
        // One-off block pause
        const block = appData.activeBlocks.find(b => b.id === pauseBlockId);
        if (!block) {
            closePauseModal();
            return;
        }
        block.isPaused = true;
        block.pauseEndTime = Date.now() + pauseDurationMs;
    }

    await saveData();
    console.log('[pause-resume] Proceeding with pause sync', {
        pauseBlockId,
        scheduleBlocklistId: pauseScheduleData?.blocklistId || null
    });
    await syncActiveBlocksToHelper();
    await syncSchedulesToHelper();

    // Update blocking rules — updateHostsFile skips paused blocks' domains
    await updateHostsFile();
    await updateBlockedApps();

    // iOS: register one-off DeviceActivity so pause expiry re-evaluates background enforcement.
    if (isIOS) {
        if (pauseScheduleData) {
            const schedule = appData.schedules?.find(s => s.blocklistId === pauseScheduleData.blocklistId);
            if (schedule?.pauseEndTime) {
                try {
                    const res = await tauriAPI.screentimeRegisterOneOffActivity(
                        'redd-schedule-resume-' + schedule.id,
                        schedule.pauseEndTime
                    );
                    if (res && res.success === false) {
                        console.error('[iOS] Schedule pause-resume registration failed:', res.error || 'Unknown error');
                    }
                } catch (e) {
                    console.warn('[iOS] Schedule pause-resume registration threw:', e);
                }
            }
        } else if (pauseBlockId) {
            const block = appData.activeBlocks.find(b => b.id === pauseBlockId);
            if (block && block.pauseEndTime) {
                try {
                    const blocklist = appData.blocklists.find(bl => bl.id === block.blocklistId);
                    const iosPayload = getBlocklistIOSPayload(blocklist);
                    await tauriAPI.screentimeSetResumePayload({
                        blockId: pauseBlockId,
                        domains: blocklist?.websites || [],
                        appTokenData: iosPayload.appTokenData,
                        categoryTokenData: iosPayload.categoryTokenData
                    });
                    const res = await tauriAPI.screentimeRegisterOneOffActivity('redd-block-resume-' + pauseBlockId, block.pauseEndTime);
                    if (res && res.success === false) {
                        console.error('[iOS] One-off DeviceActivity registration failed:', res.error || 'Unknown error');
                    }
                } catch (e) {
                    console.warn('[iOS] One-off pause-resume registration failed:', e);
                }
            }
        }
    }

    // Re-render UI
    render();

    // Update pause button to show Resume
    updatePauseButtonAppearance(true);

    closePauseModal();
}

// Generate random words to reach target character count
// Generate random words to reach target character count exactly
function generateRandomWords(targetChars) {
    const words = [];
    let currentLength = 0;

    // Safety break to prevent infinite loops
    let attempts = 0;
    const maxAttempts = 1000;

    while (currentLength < targetChars && attempts < maxAttempts) {
        attempts++;

        const isFirstWord = words.length === 0;
        const spaceNeeded = isFirstWord ? 0 : 1;
        const remaining = targetChars - currentLength;
        const maxWordLen = remaining - spaceNeeded;

        if (maxWordLen <= 0) break;

        // Try to find exact fit first
        const exactMatches = wordList.filter(w => w.length === maxWordLen);

        if (exactMatches.length > 0) {
            // Found exact match! Finish here.
            const word = exactMatches[Math.floor(Math.random() * exactMatches.length)];
            words.push(word);
            currentLength += spaceNeeded + word.length;
            break;
        } else {
            // No exact match, pick a random word that fits and leaves room for at least 1 more char 
            // (technically min word size is 1, so space+1=2 chars required for next step)

            const validWords = wordList.filter(w => {
                const newRemaining = remaining - (spaceNeeded + w.length);
                return newRemaining >= 2;
            });

            if (validWords.length > 0) {
                const word = validWords[Math.floor(Math.random() * validWords.length)];
                words.push(word);
                currentLength += spaceNeeded + word.length;
            } else {
                // If we're stuck (cannot find a word that fits exactly AND cannot find one leaving >=2 chars),
                // it means we have e.g. 1 char left (after space) but no 1-char words? 
                // With our list containing 'a', this shouldn't happen unless we need a 0-length word.
                break;
            }
        }
    }

    return words.join(' ');
}

// Generate gibberish
function generateGibberish(count) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < count; i++) {
        result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
}

function normalizeOverrideCount(value, type = 'random-words') {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_OVERRIDE_COUNT;
    const maxChars = getMaxOverrideCharsForType(type);
    return Math.min(maxChars, Math.max(MIN_OVERRIDE_CHARS, parsed));
}

function normalizeCustomOverrideText(value) {
    const text = typeof value === 'string' ? value : '';
    const maxChars = getMaxOverrideCharsForType('custom');
    return text.slice(0, maxChars);
}

function getTypingCharsPerMinuteForType(type) {
    if (type === 'gibberish') return 150;
    if (type === 'custom') return 250; // Same assumption as random-words
    return 200; // random-words: used only for estimated time
}

function getMaxOverrideCharsForType(type) {
    if (type === 'gibberish') return 5000;
    return 7500; // random-words and custom: fixed max; estimated time uses CPM
}

/** Preview text for override difficulty (random words, gibberish, or custom). Used in blocklist modal. */
function getOverridePreviewText(type, count, customText) {
    if (type === 'custom') {
        const t = typeof customText === 'string' ? customText : '';
        const normalized = t.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
        return normalized || 'Your custom text will appear here';
    }
    const num = parseInt(count, 10);
    const countNum = Number.isFinite(num) && num >= 0 ? num : 10;

    if (type !== lastOverridePreviewType) {
        lastOverridePreviewType = type;
        overridePreviewFrozenByType[type] = null;
    }

    if (type === 'random-words' || type === 'gibberish') {
        if (countNum >= OVERRIDE_PREVIEW_TRUNCATE_AT) {
            let frozen = overridePreviewFrozenByType[type];
            if (frozen != null) return frozen;
            const generated = type === 'gibberish'
                ? generateGibberish(OVERRIDE_PREVIEW_TRUNCATE_AT)
                : generateRandomWords(OVERRIDE_PREVIEW_TRUNCATE_AT);
            frozen = generated.slice(0, OVERRIDE_PREVIEW_TRUNCATE_AT);
            overridePreviewFrozenByType[type] = frozen;
            return frozen;
        }
    }

    if (type === 'gibberish') return generateGibberish(countNum);
    return generateRandomWords(countNum);
}

/** Estimated minutes to type the override challenge (based on character count and type). */
function getOverrideEstimatedMinutes(type, count, customText) {
    const charCount = type === 'custom'
        ? (typeof customText === 'string' ? customText : '').length
        : (Number.isFinite(parseInt(count, 10)) ? parseInt(count, 10) : 0);
    if (charCount <= 0) return 0;
    const cpm = getTypingCharsPerMinuteForType(type);
    return Math.ceil(charCount / cpm);
}

function updateOverridePreview() {
    const typeSelect = document.getElementById('override-type');
    const countInput = document.getElementById('override-count');
    const customTextArea = document.getElementById('custom-override-text');
    const timeLineEl = document.getElementById('override-preview-time-line');
    const previewEl = document.getElementById('override-preview-text');
    const blockEl = document.getElementById('override-preview-block');
    if (!timeLineEl || !previewEl || !blockEl) return;

    const type = typeSelect?.value || 'random-words';
    const count = countInput?.value ?? '50';
    const customText = customTextArea?.value ?? '';

    const estimatedMins = getOverrideEstimatedMinutes(type, count, customText);
    const previewText = getOverridePreviewText(type, count, customText);

    timeLineEl.textContent = `Takes ~${estimatedMins} min${estimatedMins !== 1 ? 's' : ''} to type and will look something like:`;
    previewEl.textContent = previewText;
    previewEl.title = previewText;
}

function applyOverrideTypeUi(type) {
    const customTextArea = document.getElementById('custom-override-text');
    const overrideCountInput = document.getElementById('override-count');
    const overrideCountWrapper = document.getElementById('override-count-wrapper');
    const warningEl = document.getElementById('override-count-warning');
    const previewBlockEl = document.getElementById('override-preview-block');
    const maxDifficultyWrapEl = document.getElementById('override-max-difficulty-wrap');
    const maxChars = getMaxOverrideCharsForType(type);
    overrideCountInput.max = String(maxChars);

    if (type === 'custom') {
        customTextArea.maxLength = getMaxOverrideCharsForType('custom');
        customTextArea.classList.remove('hidden');
        overrideCountWrapper.classList.add('hidden');
        warningEl.classList.add('hidden');
        warningEl.textContent = '';
        if (previewBlockEl) previewBlockEl.classList.add('hidden');
        if (maxDifficultyWrapEl) maxDifficultyWrapEl.classList.add('hidden');
        return;
    }

    customTextArea.classList.add('hidden');
    overrideCountWrapper.classList.remove('hidden');
    warningEl.classList.add('hidden');
    warningEl.textContent = '';
    if (previewBlockEl) previewBlockEl.classList.remove('hidden');
    if (maxDifficultyWrapEl) maxDifficultyWrapEl.classList.remove('hidden');
    updateOverridePreview();
}

function setOverrideCountMaxMode(enabled) {
    const overrideCountWrapper = document.getElementById('override-count-wrapper');
    const overrideCountInput = document.getElementById('override-count');
    overrideCountWrapper.classList.toggle('override-count-max-mode', enabled);
    overrideCountInput.classList.toggle('form-input-disabled', enabled);
    overrideCountWrapper.querySelector('.input-suffix')?.classList.toggle('input-suffix-disabled', enabled);
    if (enabled) overrideCountInput.setAttribute('tabindex', '-1');
    else overrideCountInput.removeAttribute('tabindex');
}

function cloneOverrideDifficulty(raw, fallbackCount = 50) {
    if (!raw) return { type: 'random-words', count: fallbackCount, maxDifficulty: false };
    const type = raw.type || 'random-words';
    const maxDifficulty = raw.maxDifficulty === true;
    const safeType = maxDifficulty && type === 'custom' ? 'random-words' : type;
    const cloned = {
        type: safeType,
        count: maxDifficulty ? getMaxOverrideCharsForType(safeType) : normalizeOverrideCount(raw.count ?? fallbackCount, safeType),
        maxDifficulty,
        customText: normalizeCustomOverrideText(raw.customText)
    };
    if (maxDifficulty) {
        const typeBeforeMax = raw.typeBeforeMax || type;
        cloned.typeBeforeMax = typeBeforeMax;
        cloned.countBeforeMax = normalizeOverrideCount(raw.countBeforeMax ?? 50, typeBeforeMax);
    }
    return cloned;
}

// macOS-style duplicate naming: "test" -> "test copy", "test copy 2", ... gap-fill; content-based chain.

/** Returns chain root if name is "X copy" or "X copy N", else null. */
function parseCopyRoot(name) {
    const m = /^(.+?) copy(?: (\d+))?$/.exec(name);
    return m ? m[1] : null;
}

/** Comparable string for content (websites, apps only). Only these + name affect duplicate copy-number chain. */
function contentKey(blocklistId) {
    const bl = appData.blocklists.find(b => b.id === blocklistId);
    if (!bl) return '';
    const w = [...(bl.websites || [])].sort();
    const a = [...getBlocklistRegularApps(bl)].sort();
    const iosSelection = getBlocklistIOSScreenTimeSelection(bl);
    return JSON.stringify({
        w,
        a,
        iosAppTokens: [...(iosSelection?.applicationTokens || [])].sort(),
        iosCategoryTokens: [...(iosSelection?.categoryTokens || [])].sort(),
        iosSummary: iosSelection?.summaryLabel || ''
    });
}

function sameBlocklistContent(idA, idB) { return contentKey(idA) === contentKey(idB); }

/** True if name is root, "root copy", or "root copy N". */
function nameInChain(name, root) {
    if (name === root || name === root + ' copy') return true;
    const p = root + ' copy ';
    return name.startsWith(p) && /^\d+$/.test(name.slice(p.length));
}

/** Next copy name: "X copy" or "X copy N" with gap-fill; same chain if unedited, else new chain from current name. */
function getNextCopyName(blocklist) {
    const name = blocklist.name;
    const root = parseCopyRoot(name);
    let base = name;
    if (root !== null) {
        const otherInChainSameContent = appData.blocklists.some(bl =>
            bl.id !== blocklist.id && nameInChain(bl.name, root) && sameBlocklistContent(bl.id, blocklist.id)
        );
        if (otherInChainSameContent) base = root;
    }
    const used = new Set();
    const p1 = base + ' copy';
    const p2 = base + ' copy ';
    for (const bl of appData.blocklists) {
        if (bl.name === p1) used.add(1);
        else if (bl.name.startsWith(p2) && /^\d+$/.test(bl.name.slice(p2.length))) used.add(parseInt(bl.name.slice(p2.length), 10));
    }
    let n = 1;
    while (used.has(n)) n++;
    return n === 1 ? p1 : p2 + n;
}

/** True if the blocklist has an active one-off block or a schedule currently in an active segment (and not paused). */
function isBlocklistCurrentlyActive(blocklistId) {
    const now = Date.now();
    const hasActiveBlock = appData.activeBlocks.some(
        b => b.blocklistId === blocklistId && isOneOffBlockEnforced(b, now)
    );
    if (hasActiveBlock) return true;
    const schedule = appData.schedules?.find(s => s.blocklistId === blocklistId);
    if (!schedule?.segments?.length) return false;
    return isScheduleSegmentActiveNow(schedule, new Date(now));
}

function duplicateBlocklist(id) {
    const blocklist = appData.blocklists.find(bl => bl.id === id);
    if (!blocklist) return;

    const newId = generateId();
    const newName = getNextCopyName(blocklist);

    const duplicate = {
        id: newId,
        name: newName,
        mode: blocklist.mode || 'blocklist',
        color: blocklist.color ?? null,
        emoji: blocklist.emoji ?? '🚫',
        websites: [...(blocklist.websites || [])],
        apps: [...getBlocklistRegularApps(blocklist)],
        iosScreenTimeSelection: cloneIOSScreenTimeSelection(getBlocklistIOSScreenTimeSelection(blocklist)),
        showItemDetails: blocklist.showItemDetails !== false,
        alwaysShowInSchedule: blocklist.alwaysShowInSchedule !== false,
        overrideDifficulty: cloneOverrideDifficulty(blocklist.overrideDifficulty)
    };

    appData.blocklists.push(duplicate);

    // Copy schedule only when the original is not currently active, so the duplicate starts inactive.
    const originalIsActive = isBlocklistCurrentlyActive(id);
    const existingSchedule = appData.schedules?.find(s => s.blocklistId === id);
    if (!originalIsActive && existingSchedule && existingSchedule.segments && existingSchedule.segments.length > 0) {
        const newSchedule = {
            id: crypto.randomUUID(),
            blocklistId: newId,
            segments: existingSchedule.segments.map(seg => ({
                startHour: seg.startHour,
                startMinute: seg.startMinute,
                endHour: seg.endHour,
                endMinute: seg.endMinute,
                days: [...(seg.days || [])]
            })),
            repeatType: existingSchedule.repeatType || 'no',
            repeatDate: existingSchedule.repeatType === 'date' && existingSchedule.repeatDate
                ? new Date(existingSchedule.repeatDate.getTime ? existingSchedule.repeatDate.getTime() : existingSchedule.repeatDate)
                : null,
            createdAt: Date.now()
        };
        if (!appData.schedules) appData.schedules = [];
        appData.schedules.push(newSchedule);
        syncSchedulesToHelper();
    }

    saveData();
    render();

    // Only keep selection on the original blocklist if it was already selected (user had focused it).
    // If they duplicated from the card menu without having clicked the card first, don't switch focus to it.
    if (selectedBlocklistId === id) {
        const dropdown = document.getElementById('blocklist-select');
        if (dropdown) {
            dropdown.value = id;
            handleBlocklistSelect({ target: dropdown });
        }
    }
}

// Delete blocklist with undo support
let pendingDelete = null; // { blocklist, activeBlocks, timeoutId }

async function deleteBlocklist(id) {
    const blocklist = appData.blocklists.find(bl => bl.id === id);
    if (!blocklist) return;

    // Check if this blocklist has an active block or schedule running
    const now = Date.now();
    const hasActiveBlock = appData.activeBlocks.some(
        block => block.blocklistId === id && block.startTime <= now && block.endTime > now
    );
    const hasActiveSchedule = appData.schedules?.some(
        s => s.blocklistId === id && s.segments && s.segments.length > 0
    );

    if (hasActiveBlock) {
        alert(`Cannot delete "${blocklist.name}" while a block is running. Override the block first.`);
        return;
    }

    if (hasActiveSchedule) {
        alert(`Cannot delete "${blocklist.name}" while a schedule is active. Stop the schedule first.`);
        return;
    }

    // If there's already a pending delete, commit it first
    if (pendingDelete) {
        commitDelete();
    }

    // Store the blocklist and any active blocks for potential undo
    const activeBlocksToRemove = appData.activeBlocks.filter(b => b.blocklistId === id);

    // Remove from data (soft delete)
    appData.blocklists = appData.blocklists.filter(bl => bl.id !== id);
    appData.activeBlocks = appData.activeBlocks.filter(b => b.blocklistId !== id);

    // If the deleted blocklist was the selected one, reset the scheduler UI
    if (selectedBlocklistId === id) {
        selectedBlocklistId = null;
        const blocklistSelect = document.getElementById('blocklist-select');
        blocklistSelect.value = '';
        handleBlocklistSelect({ target: blocklistSelect });
    }

    // Re-render immediately
    render();

    // Show undo toast
    const toast = document.getElementById('undo-toast');
    const message = document.getElementById('undo-toast-message');
    message.textContent = `Deleted "${blocklist.name}"`;
    toast.classList.remove('hidden');

    // Set up auto-commit after 5 seconds
    const timeoutId = setTimeout(() => {
        commitDelete();
    }, 5000);

    pendingDelete = {
        blocklist,
        activeBlocks: activeBlocksToRemove,
        timeoutId
    };
}

function commitDelete() {
    if (!pendingDelete) return;

    clearTimeout(pendingDelete.timeoutId);

    // Save data permanently
    saveData();

    // Update hosts if needed
    if (pendingDelete.activeBlocks.length > 0) {
        updateHostsFile();
    }

    // Hide toast
    document.getElementById('undo-toast').classList.add('hidden');
    pendingDelete = null;
}

function undoDelete() {
    if (!pendingDelete) return;

    clearTimeout(pendingDelete.timeoutId);

    // Restore the blocklist and active blocks
    appData.blocklists.push(pendingDelete.blocklist);
    pendingDelete.activeBlocks.forEach(block => {
        appData.activeBlocks.push(block);
    });

    // Hide toast
    document.getElementById('undo-toast').classList.add('hidden');
    pendingDelete = null;

    // Re-render
    render();
}

// Main render function
function render() {
    updateOnboardingVisibility();

    // Initialize currentWeekStart if not set
    if (!currentWeekStart) {
        currentWeekStart = getWeekStart(new Date());
    }

    updateWeekCalendar();
    renderBlocklistSelector();

    // Auto-select if there's only one available (non-active) blocklist
    if (!selectedBlocklistId) {
        const activeIds = appData.activeBlocks.map(b => b.blocklistId);
        const availableBlocklists = appData.blocklists.filter(bl => !activeIds.includes(bl.id));
        if (availableBlocklists.length === 1) {
            const dropdown = document.getElementById('blocklist-select');
            dropdown.value = availableBlocklists[0].id;
            handleBlocklistSelect({ target: dropdown });
        }
    }

    renderBlocklists();
    syncSelectedControlState();

    // Hide "Select a blocklist" prompt if there are no blocklists
    const selectionPrompt = document.getElementById('selection-prompt');
    if (selectionPrompt) {
        if (appData.blocklists.length === 0) {
            selectionPrompt.classList.add('hidden');
        } else if (!selectedBlocklistId) {
            // Only show prompt if there are blocklists but none selected
            selectionPrompt.classList.remove('hidden');
        }
    }

    // Adjust window height to fit content
    updateWindowHeight();
}

function syncSelectedControlState() {
    if (!selectedBlocklistId) {
        updateOverrideAllButtonVisibility();
        updateCleanHostsBtnState();
        return;
    }
    if (isScheduleMode) {
        updateScheduleButtonState();
        updateOverrideAllButtonVisibility();
        updateCleanHostsBtnState();
        return;
    }
    const startBlockBtn = document.getElementById('start-block-btn');
    if (!startBlockBtn) {
        updateOverrideAllButtonVisibility();
        updateCleanHostsBtnState();
        return;
    }
    const blocklist = appData.blocklists.find(bl => bl.id === selectedBlocklistId);
    const now = Date.now();
    const activeBlock = appData.activeBlocks.find(b => b.blocklistId === selectedBlocklistId && b.startTime <= now && b.endTime > now);
    const btnLabel = startBlockBtn.querySelector('.btn-label');
    const btnName = startBlockBtn.querySelector('.btn-name');
    const btnIcon = startBlockBtn.querySelector('svg');
    const pauseBtn = document.getElementById('pause-block-btn');
    const alwaysOnMsg = document.getElementById('always-on-message');
    const durationToggle = document.getElementById('duration-mode-toggle');
    delete startBlockBtn.dataset.activeBlockId;
    startBlockBtn.classList.remove('stop-block');
    if (btnName) btnName.textContent = blocklist ? blocklist.name : '';
    if (activeBlock) {
        if (btnLabel) btnLabel.textContent = 'Stop Block:';
        startBlockBtn.classList.add('stop-block');
        startBlockBtn.dataset.activeBlockId = activeBlock.id;
        if (btnIcon) btnIcon.innerHTML = `<rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 9.9-1"></path>`;
        if (pauseBtn) {
            pauseBtn.classList.remove('hidden');
            updatePauseButtonAppearance(!!activeBlock.isPaused);
        }
        disableTimeControls(true);
        if (alwaysOnMsg) alwaysOnMsg.classList.toggle('hidden', !isBlockAlwaysOn(activeBlock));
        if (durationToggle) durationToggle.classList.add('hidden');
    } else {
        if (btnLabel) btnLabel.textContent = tSettings('startBlockButton');
        if (btnIcon) btnIcon.innerHTML = `<rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path>`;
        if (pauseBtn) pauseBtn.classList.add('hidden');
        disableTimeControls(false);
        if (durationToggle) durationToggle.classList.remove('hidden');
        if (alwaysOnMsg) alwaysOnMsg.classList.toggle('hidden', !isAlwaysOnMode);
    }
    startBlockBtn.disabled = !selectedBlocklistId;
    updateOverrideAllButtonVisibility();
    updateCleanHostsBtnState();
}

// Get the Monday of the week containing the given date
function getWeekStart(date) {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Adjust when day is Sunday
    d.setDate(diff);
    d.setHours(0, 0, 0, 0);
    return d;
}

// Format week display string like "Mon 26 Jan - Sun 1 Feb"
function formatWeekDisplay(start, end) {
    const locale = tSettings('locale');
    const formatDayMonth = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' });
    const startLabel = formatDayMonth.format(start);
    const endLabel = formatDayMonth.format(end);

    // Include year if different from current
    const currentYear = new Date().getFullYear();
    const startYear = start.getFullYear();
    const endYear = end.getFullYear();

    if (startYear === endYear && startYear === currentYear) return `${startLabel} - ${endLabel}`;
    if (startYear === endYear) return `${startLabel} - ${endLabel} ${startYear}`;
    return `${startLabel} ${startYear} - ${endLabel} ${endYear}`;
}

// Navigate to previous/next week
function navigateWeek(direction) {
    if (!currentWeekStart) {
        currentWeekStart = getWeekStart(new Date());
    }

    currentWeekStart.setDate(currentWeekStart.getDate() + (direction * 7));
    updateWeekCalendar();
    handleTimeChange(); // Re-render preview block after navigation
}

// Scroll to today's column and current time.
// alignment: 'left' places today flush against the time sidebar; 'center' centers it in the viewport.
function scrollToToday(smooth = true, alignment = 'center') {
    const today = new Date();
    const todayStart = getWeekStart(today);

    // If today is not in the current week, navigate to it first
    if (currentWeekStart.getTime() !== todayStart.getTime()) {
        currentWeekStart = todayStart;
        updateWeekCalendar();
        handleTimeChange(); // Re-render preview block after navigation
    }

    const scrollContainer = document.querySelector('.week-calendar-scroll');
    if (!scrollContainer) return;

    // Scroll to today's column (horizontal)
    const todayColumn = document.querySelector('.day-column.today');

    if (todayColumn) {
        // offsetLeft is relative to .week-calendar-scroll (position: relative), so day columns
        // start at 0, 160, 320, ... Left alignment lands today against the time sidebar; centered
        // alignment shifts by half the leftover viewport width.
        const scrollTargetX = alignment === 'left'
            ? todayColumn.offsetLeft
            : todayColumn.offsetLeft - (scrollContainer.clientWidth - todayColumn.offsetWidth) / 2;

        // Scroll vertically to 2 hours before current time
        // Header row is sticky at 28px, content starts below it
        const currentHour = today.getHours();
        const targetHour = Math.max(0, currentHour - 2); // 2 hours before, min 0
        const headerRowHeight = 28; // sticky header height
        const scrollTargetY = headerRowHeight + (targetHour * 40); // 40px per hour

        if (smooth) {
            scrollContainer.scrollTo({ left: scrollTargetX, top: scrollTargetY, behavior: 'smooth' });
        } else {
            scrollContainer.scrollLeft = scrollTargetX;
            scrollContainer.scrollTop = scrollTargetY;
        }
    }
}

// Used for the instant scroll on app startup — keeps today flush against the time sidebar
// so the user opens the app with "today" at the leftmost position of the calendar.
function scrollToNow(smooth = true) {
    scrollToToday(smooth, 'left');
}

// Update week calendar display
function updateWeekCalendar() {
    const timeAxis = document.getElementById('time-axis');
    const daysContainer = document.getElementById('days-container');
    const headerDays = document.getElementById('header-days');

    if (!timeAxis || !daysContainer) return;

    // Generate time axis (no header spacer - it's in the header row now)
    timeAxis.innerHTML = '';

    const now = new Date();
    const currentHour = now.getHours();

    for (let h = 0; h < 24; h++) {
        const marker = document.createElement('div');
        marker.className = h === currentHour ? 'time-marker current-hour' : 'time-marker';
        marker.textContent = `${String(h).padStart(2, '0')}:00`;
        timeAxis.appendChild(marker);
    }

    // Generate day columns - render 21 days (3 weeks) for open-ended scrolling
    // currentWeekStart represents the "anchor" week, we show 1 week before and 1 week after
    if (headerDays) headerDays.innerHTML = '';
    daysContainer.innerHTML = '';
    const dayNames = tSettings('dayAbbrev');
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Start 7 days before currentWeekStart
    const renderStart = new Date(currentWeekStart);
    renderStart.setDate(renderStart.getDate() - 7);

    for (let d = 0; d < 21; d++) {
        const dayDate = new Date(renderStart);
        dayDate.setDate(dayDate.getDate() + d);

        const isToday = dayDate.getTime() === today.getTime();
        const dayOfWeek = dayDate.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

        // Day header cell (in sticky header row)
        if (headerDays) {
            const headerCell = document.createElement('div');
            headerCell.className = 'day-header-cell';
            if (isToday) headerCell.classList.add('today');
            if (isWeekend) headerCell.classList.add('weekend');
            headerCell.textContent = `${dayNames[dayOfWeek]} ${dayDate.getDate()}`;
            headerDays.appendChild(headerCell);
        }

        // Day column (no header - headers are in separate row)
        const column = document.createElement('div');
        column.className = 'day-column';
        if (isToday) column.classList.add('today');
        if (isWeekend) column.classList.add('weekend');
        column.dataset.date = localDateKey(dayDate);

        // Hour cells
        for (let h = 0; h < 24; h++) {
            const cell = document.createElement('div');
            cell.className = 'hour-cell';
            cell.dataset.hour = h;
            column.appendChild(cell);
        }

        // Day track for blocks
        const track = document.createElement('div');
        track.className = 'day-track';
        if (isScheduleMode) {
            track.classList.add('schedule-mode');
        }
        track.dataset.date = localDateKey(dayDate);
        column.appendChild(track);

        // Now indicator for today (no header offset - starts at top of column)
        if (isToday) {
            const nowIndicator = document.createElement('div');
            nowIndicator.className = 'now-indicator';
            nowIndicator.id = 'now-indicator';
            const nowMinutes = now.getHours() * 60 + now.getMinutes();
            const topPosition = (nowMinutes / 60) * 40; // hours * 40px per hour
            nowIndicator.style.top = `${topPosition}px`;
            column.appendChild(nowIndicator);
        }

        daysContainer.appendChild(column);
    }

    // Update visible range display after render
    updateVisibleRangeDisplay();

    // Render active blocks and scheduled blocks on the calendar
    renderWeekBlocks();
}

function getCalendarRenderRange() {
    const renderStart = new Date(currentWeekStart);
    renderStart.setDate(renderStart.getDate() - 7);
    renderStart.setHours(0, 0, 0, 0);

    const renderEnd = new Date(renderStart);
    renderEnd.setDate(renderEnd.getDate() + 20);
    renderEnd.setHours(23, 59, 59, 999);

    return { renderStart, renderEnd };
}

function getCalendarSegmentLayout(segmentStartMs, segmentEndMs, dayStartMs, dayEndMs) {
    const clampedStartMs = Math.max(segmentStartMs, dayStartMs);
    const clampedEndMs = Math.min(segmentEndMs, dayEndMs);
    const segmentStartDate = new Date(clampedStartMs);
    const segmentEndDate = new Date(clampedEndMs);
    const startMinutes = segmentStartDate.getHours() * 60 + segmentStartDate.getMinutes();
    const reachesDayEnd = segmentEndMs >= dayEndMs;
    const endMinutes = reachesDayEnd
        ? 24 * 60
        : segmentEndDate.getHours() * 60 + segmentEndDate.getMinutes();

    return {
        topPosition: (startMinutes / 60) * 40,
        height: Math.max(20, ((endMinutes - startMinutes) / 60) * 40),
        segmentStartDate,
        segmentEndDate
    };
}

// Update the displayed date range based on visible columns
function updateVisibleRangeDisplay() {
    const scrollContainer = document.querySelector('.week-calendar-scroll');
    const weekDisplay = document.getElementById('week-display');
    const dayColumns = document.querySelectorAll('.day-column');

    if (!scrollContainer || !weekDisplay || dayColumns.length === 0) return;

    const scrollLeft = scrollContainer.scrollLeft;
    const containerWidth = scrollContainer.clientWidth;

    // Find first and last visible columns. offsetLeft is measured from the scroll container
    // (which is position: relative), so day columns start at 0, 120, 240, ...
    let firstVisible = null;
    let lastVisible = null;

    dayColumns.forEach(column => {
        const columnLeft = column.offsetLeft;
        const columnRight = columnLeft + column.offsetWidth;

        if (columnRight > scrollLeft && columnLeft < scrollLeft + containerWidth) {
            if (!firstVisible) firstVisible = column;
            lastVisible = column;
        }
    });

    if (firstVisible && lastVisible) {
        const startDate = parseLocalDateKey(firstVisible.dataset.date);
        const endDate = parseLocalDateKey(lastVisible.dataset.date);
        if (!startDate || !endDate) return;
        weekDisplay.textContent = formatWeekDisplay(startDate, endDate);
    }
}
// Render active blocks on week calendar
function renderWeekBlocks() {
    const noBlocksMsg = document.getElementById('no-blocks-message');
    const now = Date.now();

    // Clear existing blocks from all day tracks
    document.querySelectorAll('.day-track').forEach(track => {
        track.innerHTML = '';
    });

    // Filter blocks within the full visible calendar range (21 rendered days)
    const { renderStart, renderEnd } = getCalendarRenderRange();
    const renderStartMs = renderStart.getTime();
    const renderEndMs = renderEnd.getTime();

    const visibleBlocks = appData.activeBlocks.filter(block =>
        block.endTime > renderStartMs && block.startTime < renderEndMs
    );

    // Check if there are any schedules
    const hasSchedules = appData.schedules && appData.schedules.length > 0;

    if (visibleBlocks.length === 0 && !hasSchedules) {
        noBlocksMsg?.classList.remove('hidden');
    } else {
        noBlocksMsg?.classList.add('hidden');
    }

    // Render each block
    visibleBlocks.forEach(block => {
        const blocklist = appData.blocklists.find(bl => bl.id === block.blocklistId);
        if (!blocklist) return;

        // Skip if blocklist has "always show in schedule" unchecked and isn't currently selected
        if (blocklist.alwaysShowInSchedule === false && block.blocklistId !== selectedBlocklistId) {
            return;
        }

        const blockStart = new Date(block.startTime);
        // Clamp blockEnd to the visible calendar range to avoid infinite loops with always-on blocks
        const blockEnd = new Date(Math.min(block.endTime, renderEndMs));
        const isExpired = block.endTime <= now && !isBlockAlwaysOn(block);

        // Determine which day(s) the block spans
        const startDay = new Date(blockStart);
        startDay.setHours(0, 0, 0, 0);

        const endDay = new Date(blockEnd);
        endDay.setHours(0, 0, 0, 0);

        // For simplicity, render block in each day it spans
        let currentDay = new Date(startDay);

        while (currentDay <= endDay) {
            const dateStr = localDateKey(currentDay);
            const track = document.querySelector(`.day-track[data-date="${dateStr}"]`);

            if (track) {
                // Calculate start time for this day segment
                const dayStart = new Date(currentDay);
                dayStart.setHours(0, 0, 0, 0);
                const dayEnd = new Date(currentDay);
                dayEnd.setHours(23, 59, 59, 999);

                const {
                    topPosition,
                    height,
                    segmentStartDate,
                    segmentEndDate
                } = getCalendarSegmentLayout(block.startTime, blockEnd.getTime(), dayStart.getTime(), dayEnd.getTime());

                const blockEl = document.createElement('div');
                blockEl.className = isExpired ? 'calendar-block expired' : 'calendar-block';
                blockEl.dataset.blockId = block.id;
                blockEl.style.top = `${topPosition}px`;
                blockEl.style.height = `${height}px`;

                if (blocklist.color) {
                    blockEl.style.background = blocklist.color;
                    blockEl.style.color = getContrastTextColor(blocklist.color);
                }

                blockEl.innerHTML = `
                    <span class="block-emoji">${blocklist.emoji || '🚫'}</span>
                    <span class="block-label">${escapeHtml(blocklist.name)}</span>
                    <span class="block-time">${formatTime(segmentStartDate)} - ${formatTime(segmentEndDate)}</span>
                `;

                // Add click handler for override (only for running blocks)
                if (!isExpired) {
                    blockEl.addEventListener('click', (e) => {
                        e.stopPropagation();
                        openOverrideModal(block.id);
                    });
                }

                track.appendChild(blockEl);
            }

            // Move to next day
            currentDay.setDate(currentDay.getDate() + 1);
        }
    });

    // Render scheduled blocks
    renderScheduledCalendarBlocks();

    // Layout overlapping blocks side-by-side (Apple Calendar style)
    layoutOverlappingBlocks();

    // Wrap the header bits (emoji + name + time) in a sticky container so the label stays
    // visible when a block starts above the viewport (e.g. an overnight schedule at 00:00).
    makeCalendarBlockHeadersSticky();

    // Refresh the visibility-chip row so it stays in sync with the data.
    renderScheduleVisibilityChips();
}

function makeCalendarBlockHeadersSticky() {
    document.querySelectorAll('.calendar-block').forEach(block => {
        // Skip if already wrapped (idempotent across renders)
        if (block.querySelector(':scope > .calendar-block-sticky')) return;

        const emoji = block.querySelector(':scope > .block-emoji');
        const label = block.querySelector(':scope > .block-label');
        const time = block.querySelector(':scope > .block-time');
        if (!emoji && !label && !time) return;

        const wrapper = document.createElement('div');
        wrapper.className = 'calendar-block-sticky';
        block.insertBefore(wrapper, block.firstChild);
        if (emoji) wrapper.appendChild(emoji);
        if (label) wrapper.appendChild(label);
        if (time) wrapper.appendChild(time);
    });
}

/// Render a row of eye/eye-slash chips under the Schedule header — one per blocklist that
/// currently contributes anything to the calendar (has an active/future manual block or a
/// defined schedule). Clicking a chip toggles blocklist.alwaysShowInSchedule.
function renderScheduleVisibilityChips() {
    const container = document.getElementById('schedule-visibility-chips');
    if (!container) return;

    const now = Date.now();
    const scheduledIds = new Set((appData.schedules || []).map(s => s.blocklistId));
    const manualIds = new Set(
        (appData.activeBlocks || [])
            .filter(b => b.endTime > now)
            .map(b => b.blocklistId)
    );
    const relevantIds = new Set([...scheduledIds, ...manualIds]);

    const blocklists = (appData.blocklists || []).filter(bl => relevantIds.has(bl.id));

    if (blocklists.length === 0) {
        container.classList.add('hidden');
        container.innerHTML = '';
        return;
    }

    container.classList.remove('hidden');
    container.innerHTML = '';

    const eyeOpenSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
    const eyeClosedSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

    for (const bl of blocklists) {
        const visible = bl.alwaysShowInSchedule !== false;
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'schedule-visibility-chip';
        chip.setAttribute('aria-pressed', visible ? 'true' : 'false');
        chip.dataset.blocklistId = bl.id;
        chip.title = visible ? 'Hide from schedule' : 'Show in schedule';
        chip.innerHTML = `
            ${visible ? eyeOpenSvg : eyeClosedSvg}
            ${bl.color ? `<span class="schedule-visibility-chip-dot" style="background:${escapeHtml(bl.color)}"></span>` : ''}
            <span class="schedule-visibility-chip-name">${bl.emoji ? escapeHtml(bl.emoji) + ' ' : ''}${escapeHtml(bl.name || '')}</span>
        `;
        chip.addEventListener('click', async () => {
            const blocklist = appData.blocklists.find(b => b.id === bl.id);
            if (!blocklist) return;
            blocklist.alwaysShowInSchedule = !(blocklist.alwaysShowInSchedule !== false);
            await saveData();
            renderWeekBlocks();
            // renderWeekBlocks wipes all day tracks; re-add any in-flight preview block(s).
            handleTimeChange();
        });
        container.appendChild(chip);
    }
}

// Layout overlapping blocks side-by-side within each day track (Apple Calendar style)
function layoutOverlappingBlocks() {
    document.querySelectorAll('.day-track').forEach(track => {
        const blocks = Array.from(track.querySelectorAll('.calendar-block'));
        if (blocks.length <= 1) return;

        // Get block positions and group identifier (scheduleId or blockId)
        const blockData = blocks.map(block => {
            const top = parseFloat(block.style.top) || 0;
            const height = parseFloat(block.style.height) || 20;
            // Use the most specific logical group id available so preview blocks
            // participate in the same side-by-side layout as saved/running blocks.
            const groupId = block.dataset.scheduleId || block.dataset.blockId || block.dataset.previewGroupId || null;
            return {
                element: block,
                top: top,
                bottom: top + height,
                groupId: groupId,
                column: 0,
                totalColumns: 1
            };
        });

        // Sort by top position, then by height (taller blocks first)
        blockData.sort((a, b) => a.top - b.top || b.bottom - a.bottom);

        // First pass: assign columns to groups (blocks from same schedule get same column)
        const groupColumns = new Map(); // groupId -> column

        for (let i = 0; i < blockData.length; i++) {
            const current = blockData[i];

            // If this block's group already has a column, use it
            if (current.groupId && groupColumns.has(current.groupId)) {
                current.column = groupColumns.get(current.groupId);
                continue;
            }

            // Find all blocks that overlap with current (considering the entire group)
            const overlappingGroups = new Set();
            for (let j = 0; j < blockData.length; j++) {
                const other = blockData[j];
                // Check if they overlap
                if (!(current.bottom <= other.top || current.top >= other.bottom)) {
                    if (other.groupId !== current.groupId) {
                        overlappingGroups.add(other.groupId);
                    }
                }
            }

            // Find columns used by overlapping groups
            const usedColumns = new Set();
            overlappingGroups.forEach(gid => {
                if (groupColumns.has(gid)) {
                    usedColumns.add(groupColumns.get(gid));
                }
            });

            // Assign the first available column
            let col = 1;
            while (usedColumns.has(col)) col++;
            current.column = col;
            if (current.groupId) {
                groupColumns.set(current.groupId, col);
            }
        }

        // Second pass: calculate totalColumns for overlapping sets
        for (let i = 0; i < blockData.length; i++) {
            const current = blockData[i];
            let maxCol = current.column;

            for (let j = 0; j < blockData.length; j++) {
                const other = blockData[j];
                if (!(current.bottom <= other.top || current.top >= other.bottom)) {
                    maxCol = Math.max(maxCol, other.column);
                }
            }
            current.totalColumns = maxCol;
        }

        // Apply positioning
        blockData.forEach(data => {
            if (data.totalColumns > 1) {
                const widthPercent = 100 / data.totalColumns;
                const leftPercent = (data.column - 1) * widthPercent;
                data.element.style.left = `calc(${leftPercent}% + 2px)`;
                data.element.style.width = `calc(${widthPercent}% - 4px)`;
                data.element.style.right = 'auto';
            }
        });
    });
}

// Render scheduled blocks on the calendar (from saved schedules)
function renderScheduledCalendarBlocks() {
    console.log('renderScheduledCalendarBlocks called, schedules:', appData.schedules);
    if (!appData.schedules || appData.schedules.length === 0) return;

    const now = new Date();
    const today = now.getDay(); // 0=Sun, 1=Mon, etc.
    const todayIndex = today === 0 ? 6 : today - 1; // Convert to 0=Mon format

    // Generate all 21 visible days (7 before anchor week, anchor week, 7 after anchor week)
    // This matches the calendar's visible range
    const renderStart = new Date(currentWeekStart);
    renderStart.setDate(renderStart.getDate() - 7);

    const allVisibleDays = [];
    for (let i = 0; i < 21; i++) {
        const day = new Date(renderStart);
        day.setDate(day.getDate() + i);
        allVisibleDays.push({
            date: day,
            dateStr: localDateKey(day),
            dayIndex: (day.getDay() === 0 ? 6 : day.getDay() - 1) // Convert to 0=Mon format
        });
    }

    appData.schedules.forEach(schedule => {
        const blocklist = appData.blocklists.find(bl => bl.id === schedule.blocklistId);
        if (!blocklist) return;

        // Skip if blocklist has "always show in schedule" unchecked and isn't currently selected
        if (blocklist.alwaysShowInSchedule === false && schedule.blocklistId !== selectedBlocklistId) {
            return;
        }

        // Check if schedule has expired (for date-limited schedules)
        if (schedule.repeatType === 'date' && schedule.repeatDate) {
            const endDate = new Date(schedule.repeatDate);
            if (now > endDate) return;
        }

        if (isNonRepeatingSchedule(schedule)) {
            const occurrences = resolveOneShotOccurrences(schedule);
            occurrences.forEach(occurrence => {
                renderScheduledCalendarInterval(
                    schedule,
                    occurrence.start,
                    occurrence.end,
                    blocklist,
                    occurrence.segmentIndex
                );
            });
            return;
        }

        // Render each segment on its applicable days
        schedule.segments.forEach((segment, segmentIdx) => {
            const segmentDays = segment.days || [];

            allVisibleDays.forEach((weekDay, weekDayIdx) => {
                if (!segmentDays.includes(weekDay.dayIndex)) {
                    return;
                }

                const track = document.querySelector(`.day-track[data-date="${weekDay.dateStr}"]`);
                if (!track) return;

                // Calculate position
                const startMinutes = segment.startHour * 60 + segment.startMinute;
                const endMinutes = segment.endHour * 60 + segment.endMinute;

                // Check if this is an overnight block (end time is before start time)
                const isOvernight = endMinutes <= startMinutes;

                if (isOvernight) {
                    // Render first part: from start until midnight (end of day)
                    const topPosition1 = (startMinutes / 60) * 40;
                    const height1 = ((1440 - startMinutes) / 60) * 40; // 1440 = 24 * 60 (midnight)

                    const blockEl1 = document.createElement('div');
                    blockEl1.className = 'calendar-block scheduled';
                    blockEl1.dataset.scheduleId = schedule.id;
                    blockEl1.dataset.segmentIndex = segmentIdx;
                    blockEl1.dataset.day = weekDay.dayIndex;
                    blockEl1.style.top = `${topPosition1}px`;
                    blockEl1.style.height = `${height1}px`;

                    if (blocklist.color) {
                        blockEl1.style.background = blocklist.color;
                        blockEl1.style.opacity = '0.7';
                        blockEl1.style.color = getContrastTextColor(blocklist.color);
                    }

                    const startTimeStr = `${String(segment.startHour).padStart(2, '0')}:${String(segment.startMinute).padStart(2, '0')}`;
                    const endTimeStr = `${String(segment.endHour).padStart(2, '0')}:${String(segment.endMinute).padStart(2, '0')}`;

                    blockEl1.innerHTML = `
                        <span class="block-emoji">${blocklist.emoji || '🚫'}</span>
                        <span class="block-label">${escapeHtml(blocklist.name)}</span>
                        <span class="block-time">${startTimeStr} - ${endTimeStr}</span>
                        <span class="schedule-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/></svg></span>
                    `;

                    blockEl1.addEventListener('click', (e) => {
                        e.stopPropagation();
                        openScheduledBlockOverrideModal(schedule, segmentIdx, weekDay.dayIndex);
                    });

                    track.appendChild(blockEl1);

                    // Render second part: from midnight until end time on the next day
                    const nextDay = allVisibleDays[weekDayIdx + 1];
                    if (nextDay) {
                        const nextTrack = document.querySelector(`.day-track[data-date="${nextDay.dateStr}"]`);
                        if (nextTrack) {
                            const topPosition2 = 0;
                            const height2 = Math.max(20, (endMinutes / 60) * 40);

                            const blockEl2 = document.createElement('div');
                            blockEl2.className = 'calendar-block scheduled overnight-continuation';
                            blockEl2.dataset.scheduleId = schedule.id;
                            blockEl2.dataset.segmentIndex = segmentIdx;
                            blockEl2.dataset.day = nextDay.dayIndex;
                            blockEl2.style.top = `${topPosition2}px`;
                            blockEl2.style.height = `${height2}px`;

                            if (blocklist.color) {
                                blockEl2.style.background = blocklist.color;
                                blockEl2.style.opacity = '0.7';
                                blockEl2.style.color = getContrastTextColor(blocklist.color);
                            }

                            blockEl2.innerHTML = `
                                <span class="block-emoji">${blocklist.emoji || '🚫'}</span>
                                <span class="block-label">${escapeHtml(blocklist.name)}</span>
                                <span class="block-time">${startTimeStr} - ${endTimeStr}</span>
                                <span class="schedule-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/></svg></span>
                            `;

                            blockEl2.addEventListener('click', (e) => {
                                e.stopPropagation();
                                openScheduledBlockOverrideModal(schedule, segmentIdx, nextDay.dayIndex);
                            });

                            nextTrack.appendChild(blockEl2);
                        }
                    }
                } else {
                    // Normal same-day block
                    const topPosition = (startMinutes / 60) * 40;
                    const height = Math.max(20, ((endMinutes - startMinutes) / 60) * 40);

                    const blockEl = document.createElement('div');
                    blockEl.className = 'calendar-block scheduled';
                    blockEl.dataset.scheduleId = schedule.id;
                    blockEl.dataset.segmentIndex = segmentIdx;
                    blockEl.dataset.day = weekDay.dayIndex;
                    blockEl.style.top = `${topPosition}px`;
                    blockEl.style.height = `${height}px`;

                    if (blocklist.color) {
                        blockEl.style.background = blocklist.color;
                        blockEl.style.opacity = '0.7';
                        blockEl.style.color = getContrastTextColor(blocklist.color);
                    }

                    const startTimeStr = `${String(segment.startHour).padStart(2, '0')}:${String(segment.startMinute).padStart(2, '0')}`;
                    const endTimeStr = `${String(segment.endHour).padStart(2, '0')}:${String(segment.endMinute).padStart(2, '0')}`;

                    blockEl.innerHTML = `
                        <span class="block-emoji">${blocklist.emoji || '🚫'}</span>
                        <span class="block-label">${escapeHtml(blocklist.name)}</span>
                        <span class="block-time">${startTimeStr} - ${endTimeStr}</span>
                        <span class="schedule-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/></svg></span>
                    `;

                    blockEl.addEventListener('click', (e) => {
                        e.stopPropagation();
                        openScheduledBlockOverrideModal(schedule, segmentIdx, weekDay.dayIndex);
                    });

                    track.appendChild(blockEl);
                }
            });
        });
    });
}

// Render blocklist selector dropdown
function renderBlocklistSelector() {
    const select = document.getElementById('blocklist-select');
    const currentValue = select.value;
    const activeIds = appData.activeBlocks.map(b => b.blocklistId);

    const newHTML = `
    <option value="">${tSettings('selectionPromptOption')}</option>
    ${appData.blocklists.map(bl => {
        const isActive = activeIds.includes(bl.id);
        const disabledAttr = isActive ? 'disabled' : '';
        const activeLabel = isActive ? tSettings('runningSuffix') : '';
        return `<option value="${bl.id}" ${disabledAttr}>${escapeHtml(bl.name)}${activeLabel}</option>`;
    }).join('')}
  `;

    // Only update if changed to prevent closing dropdown
    // Normalize logic to ignore potential minor diffs if logic is sound, but direct string compare is fine
    if (select.innerHTML !== newHTML) {
        select.innerHTML = newHTML;
        select.value = currentValue;
    }
}

// Render blocklists
function renderBlocklists() {
    const container = document.getElementById('blocklists-container');

    if (appData.blocklists.length === 0) {
        container.innerHTML = `
      <div class="no-active-blocks clickable" id="empty-blocklists-cta" style="cursor: pointer;">
        <p>${tSettings('noBlocklistsYet')}</p>
        <p class="subtle">${tSettings('clickHereCreateBlocklist')}</p>
      </div>
    `;
        document.getElementById('empty-blocklists-cta').addEventListener('click', () => {
            openBlocklistModal();
        });
        return;
    }

    container.innerHTML = appData.blocklists.map(bl => {
        // Build detailed meta text
        const websiteCount = bl.websites?.length || 0;
        const regularApps = getBlocklistRegularApps(bl);
        const screenTimeSelection = getBlocklistIOSScreenTimeSelection(bl);
        const screenTimeLabel = formatIOSScreenTimeSelectionLabel(screenTimeSelection);
        const appCount = regularApps.length + (screenTimeLabel ? 1 : 0);
        const showDetails = bl.showItemDetails !== false; // Default to true
        let metaParts = [];

        if (websiteCount > 0) {
            if (showDetails) {
                const displaySites = bl.websites.map(cleanUrlForDisplay);
                const maxDisplay = appCount === 0 ? 3 : 2;
                if (websiteCount <= maxDisplay) {
                    metaParts.push(`${websiteCount} ${websiteWord(websiteCount)} (${displaySites.join(', ')})`);
                } else {
                    metaParts.push(`${websiteCount} ${websiteWord(websiteCount)} (${displaySites.slice(0, maxDisplay).join(', ')}, ...)`);
                }
            } else {
                metaParts.push(`${websiteCount} ${websiteWord(websiteCount)}`);
            }
        }

        if (appCount > 0) {
            if (screenTimeLabel) {
                const stText = `${screenTimeLabel.replace(' selected (Screen Time)', '')} via Screen Time`;
                if (regularApps.length > 0) {
                    metaParts.push(`${regularApps.length} ${regularApps.length === 1 ? 'app' : 'apps'} + ${stText}`);
                } else {
                    metaParts.push(stText);
                }
            } else if (showDetails) {
                if (appCount <= 2) {
                    metaParts.push(`${appCount} ${appCount === 1 ? 'app' : 'apps'} (${regularApps.join(', ')})`);
                } else {
                    metaParts.push(`${appCount} apps (${regularApps.slice(0, 2).join(', ')}, ...)`);
                }
            } else {
                metaParts.push(`${appCount} ${appCount === 1 ? 'app' : 'apps'}`);
            }
        }

        const metaText = metaParts.length > 0 ? metaParts.join(` ${tSettings('andWord')} `) : tSettings('noItems');

        // Get color for left border
        // Get color for left border
        const borderColor = bl.color || 'linear-gradient(135deg, #4a00e0 0%, #8e2de2 100%)';

        // Check if this blocklist has an active block
        const now = Date.now();
        const activeBlock = appData.activeBlocks.find(b => b.blocklistId === bl.id && b.startTime <= now && b.endTime > now);
        const isActive = !!activeBlock;

        // Check if this blocklist has a schedule
        const hasSchedule = appData.schedules && appData.schedules.some(s => s.blocklistId === bl.id);

        const activeClass = isActive ? ' blocklist-card-active' : (hasSchedule ? ' blocklist-card-scheduled' : '');

        // Calculate badges - show BOTH if applicable
        let oneOffBadge = '';
        let scheduleBadge = '';

        // One-off block badge (green with hourglass, or power icon for always-on)
        if (isActive && activeBlock) {
            if (activeBlock.isPaused) {
                // Paused badge — show pause icon and resume countdown
                const pauseRemaining = activeBlock.pauseEndTime - now;
                const pauseMins = Math.max(1, Math.ceil(pauseRemaining / 60000));
                const pauseTimeText = pauseMins >= 60 ? `${Math.floor(pauseMins / 60)}h ${pauseMins % 60}m` : `${pauseMins}m`;
                oneOffBadge = `<span class="active-badge paused-badge"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg> Paused ${pauseTimeText}</span>`;
            } else if (isBlockAlwaysOn(activeBlock)) {
                // Power icon for always-on blocks
                oneOffBadge = `<span class="active-badge"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path><line x1="12" y1="2" x2="12" y2="12"></line></svg> Always</span>`;
            } else {
                const remaining = activeBlock.endTime - now;
                const mins = Math.ceil(remaining / 60000);
                const timeText = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
                // Hourglass icon
                oneOffBadge = `<span class="active-badge"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/></svg> ${timeText} left</span>`;
            }
        }

        // Schedule badge (blue with calendar-sync)
        if (hasSchedule) {
            const schedule = appData.schedules.find(s => s.blocklistId === bl.id);
            let scheduleTimeText = '';
            if (schedule && schedule.segments) {
                if (schedule.isPaused && schedule.pauseEndTime > now) {
                    const pauseMins = Math.max(1, Math.ceil((schedule.pauseEndTime - now) / 60000));
                    scheduleTimeText = pauseMins >= 60 ? `Paused ${Math.floor(pauseMins / 60)}h ${pauseMins % 60}m` : `Paused ${pauseMins}m`;
                } else {
                    // Check if any segment is currently active
                    const nowDate = new Date();
                    const currentDay = nowDate.getDay() === 0 ? 6 : nowDate.getDay() - 1; // Mon=0
                    const currentMins = nowDate.getHours() * 60 + nowDate.getMinutes();

                    // Find active segment (handling cross-midnight segments)
                    const activeSegment = schedule.segments.find(seg => {
                        const startMins = seg.startHour * 60 + seg.startMinute;
                        const endMins = seg.endHour * 60 + seg.endMinute;

                        if (endMins > startMins) {
                            // Same-day segment (e.g., 09:00 - 17:00)
                            return seg.days.includes(currentDay) &&
                                currentMins >= startMins &&
                                currentMins < endMins;
                        } else {
                            // Cross-midnight segment (e.g., 22:00 - 04:00)
                            const yesterdayDay = currentDay === 0 ? 6 : currentDay - 1;
                            const inEveningPortion = seg.days.includes(currentDay) && currentMins >= startMins;
                            const inMorningPortion = seg.days.includes(yesterdayDay) && currentMins < endMins;
                            return inEveningPortion || inMorningPortion;
                        }
                    });

                    if (activeSegment) {
                        // Currently blocking - show time left
                        const startMins = activeSegment.startHour * 60 + activeSegment.startMinute;
                        const endMins = activeSegment.endHour * 60 + activeSegment.endMinute;
                        let minsLeft;

                        if (endMins > startMins) {
                            // Same-day segment
                            minsLeft = endMins - currentMins;
                        } else {
                            // Cross-midnight segment
                            if (currentMins >= startMins) {
                                // In evening portion: time until midnight + morning end
                                minsLeft = (24 * 60 - currentMins) + endMins;
                            } else {
                                // In morning portion: time until end
                                minsLeft = endMins - currentMins;
                            }
                        }
                        scheduleTimeText = minsLeft >= 60 ? `${Math.floor(minsLeft / 60)}h ${minsLeft % 60}m left` : `${minsLeft}m left`;
                    } else {
                        // Find next upcoming segment
                        let nextStart = null;
                        for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
                            const checkDay = (currentDay + dayOffset) % 7;
                            const segsForDay = schedule.segments.filter(seg => seg.days.includes(checkDay))
                                .sort((a, b) => (a.startHour * 60 + a.startMinute) - (b.startHour * 60 + b.startMinute));

                            for (const seg of segsForDay) {
                                const segStartMins = seg.startHour * 60 + seg.startMinute;
                                if (dayOffset === 0 && segStartMins <= currentMins) continue; // Already passed today

                                // Found next segment
                                const minsUntil = dayOffset === 0
                                    ? segStartMins - currentMins
                                    : (dayOffset * 24 * 60) + segStartMins - currentMins + (24 * 60 - currentMins) - (24 * 60 - segStartMins);

                                if (minsUntil < 60) {
                                    scheduleTimeText = `in ${minsUntil}m`;
                                } else if (minsUntil < 24 * 60) {
                                    scheduleTimeText = `in ${Math.floor(minsUntil / 60)}h`;
                                } else {
                                    const days = Math.floor(minsUntil / (24 * 60));
                                    scheduleTimeText = `in ${days}d`;
                                }
                                nextStart = true;
                                break;
                            }
                            if (nextStart) break;
                        }
                        if (!scheduleTimeText) scheduleTimeText = 'scheduled';
                    }
                }
            }
            // Calendar icon for scheduled blocklists
            scheduleBadge = `<span class="schedule-badge"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/></svg> ${scheduleTimeText}</span>`;
        }

        const activeBadge = oneOffBadge + scheduleBadge;

        // Check if this blocklist is selected
        const isSelected = bl.id === selectedBlocklistId;
        const selectedClass = isSelected ? ' selected' : '';
        const selectedStyle = isSelected ? `style="box-shadow: 0 0 0 2px ${bl.color || '#667eea'}, 0 4px 8px rgba(0, 0, 0, 0.1);"` : '';

        // Dim if something is selected but this one isn't
        const isDimmed = selectedBlocklistId && !isSelected;
        const dimmedClass = isDimmed ? ' dimmed' : '';

        return `
      <div class="blocklist-card${activeClass}${selectedClass}${dimmedClass}" data-id="${bl.id}" data-active="${isActive}" ${selectedStyle}>
        <div class="blocklist-stripe" style="background: ${borderColor}"></div>
        <div class="blocklist-info">
          <div class="blocklist-name"><span class="blocklist-emoji">${bl.emoji || '🚫'}</span>${escapeHtml(bl.name)}${activeBadge}</div>
          <div class="blocklist-meta">${escapeHtml(metaText)}</div>
        </div>
        <div class="blocklist-actions">
          <div class="blocklist-menu-wrapper">
            <button class="blocklist-action-btn blocklist-menu-btn" title="Blocklist options">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="1"></circle>
                <circle cx="12" cy="5" r="1"></circle>
                <circle cx="12" cy="19" r="1"></circle>
              </svg>
            </button>
            <div class="blocklist-menu hidden">
              <button class="blocklist-menu-item duplicate-blocklist-item" title="Duplicate">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="15" x2="15" y1="12" y2="18"/>
                  <line x1="12" x2="18" y1="15" y2="15"/>
                  <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
                  <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
                </svg>
                Duplicate
              </button>
              <button class="blocklist-menu-item delete-blocklist-item" title="Delete">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M3 6h18"></path>
                  <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
                  <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
                </svg>
                Delete
              </button>
            </div>
          </div>
          <button class="blocklist-action-btn edit-btn" title="Edit">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>
              <path d="m15 5 4 4"/>
            </svg>
          </button>
        </div>
      </div>
    `;
    }).join('');

    // Add event listeners
    container.querySelectorAll('.blocklist-card').forEach(card => {
        const id = card.dataset.id;
        const isActive = card.dataset.active === 'true';

        // Click card to select it in the dropdown
        card.addEventListener('click', () => {
            const dropdown = document.getElementById('blocklist-select');
            dropdown.value = id;
            handleBlocklistSelect({ target: dropdown });
        });

        card.querySelector('.edit-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            closeAllBlocklistMenus();
            const blocklist = appData.blocklists.find(bl => bl.id === id);
            openBlocklistModal(blocklist);
        });

        card.querySelector('.blocklist-menu-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            const menu = card.querySelector('.blocklist-menu');
            if (!menu) return;
            const wasHidden = menu.classList.contains('hidden');
            closeAllBlocklistMenus();
            if (wasHidden) menu.classList.remove('hidden');
        });

        card.querySelector('.duplicate-blocklist-item').addEventListener('click', (e) => {
            e.stopPropagation();
            closeAllBlocklistMenus();
            duplicateBlocklist(id);
        });

        card.querySelector('.delete-blocklist-item').addEventListener('click', (e) => {
            e.stopPropagation();
            closeAllBlocklistMenus();
            deleteBlocklist(id);
        });

        // Drag and drop using mouse events on document
        card.addEventListener('mousedown', (e) => {
            // Don't start drag if clicking on buttons
            if (e.target.closest('.edit-btn') || e.target.closest('.blocklist-menu-btn') || e.target.closest('.blocklist-menu')) return;
            if (e.target.closest('.blocklist-actions')) return;
            if (e.button !== 0) return; // Only left click

            e.preventDefault(); // Prevent text selection

            const startY = e.clientY;
            let isDragging = false;
            const container = document.getElementById('blocklists-container');


            const onMouseMove = (moveEvent) => {
                // Only start dragging after moving 5px
                if (!isDragging && Math.abs(moveEvent.clientY - startY) > 5) {
                    isDragging = true;
                    card.classList.add('dragging');
                }

                if (!isDragging) return;

                const siblings = [...container.querySelectorAll('.blocklist-card:not(.dragging)')];
                const nextSibling = siblings.find(sibling => {
                    const rect = sibling.getBoundingClientRect();
                    return moveEvent.clientY < rect.top + rect.height / 2;
                });


                if (nextSibling) {
                    container.insertBefore(card, nextSibling);
                } else {
                    container.appendChild(card);
                }
            };

            const onMouseUp = () => {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
                card.classList.remove('dragging');

                if (isDragging) {
                    saveBlocklistOrderFromDOM();
                }
            };

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    });
}

function closeAllBlocklistMenus() {
    document.querySelectorAll('.blocklist-menu:not(.hidden)').forEach(menu => {
        menu.classList.add('hidden');
    });
}

// Save blocklist order based on DOM position
function saveBlocklistOrderFromDOM() {
    const container = document.getElementById('blocklists-container');
    if (!container) return;

    const cardElements = Array.from(container.querySelectorAll('.blocklist-card'));
    const newOrder = cardElements.map(card => card.dataset.id);

    // Reorder appData.blocklists to match
    const reorderedBlocklists = [];
    newOrder.forEach(id => {
        const blocklist = appData.blocklists.find(bl => bl.id === id);
        if (blocklist) {
            reorderedBlocklists.push(blocklist);
        }
    });

    // Add any blocklists that weren't in the DOM
    appData.blocklists.forEach(bl => {
        if (!reorderedBlocklists.find(r => r.id === bl.id)) {
            reorderedBlocklists.push(bl);
        }
    });

    appData.blocklists = reorderedBlocklists;
    saveData();
}

// Start interval to update remaining time
function startTickInterval() {
    // Track which blocks have been activated (to avoid repeated password prompts)
    // Initialize activatedBlockIds with already-active blocks at startup
    activatedBlockIds = new Set(
        appData.activeBlocks
            .filter(b => b.startTime <= Date.now())
            .map(b => b.id)
    );

    // Initialize app blocking immediately at startup
    // This ensures any active blocks or schedules are enforced right away
    updateBlockedApps();
    startTickInterval._lastScheduleStateSignature = getScheduleStateSignature();

    setInterval(async () => {
        const now = Date.now();
        let shouldSyncControls = false;

        // Check for future blocks that have now become active
        const newlyActiveBlocks = appData.activeBlocks.filter(
            block => block.startTime <= now && !activatedBlockIds.has(block.id)
        );

        if (newlyActiveBlocks.length > 0) {
            // Mark as activated
            newlyActiveBlocks.forEach(b => activatedBlockIds.add(b.id));
            // Update hosts to apply the blocking rules
            await updateHostsFile();
            render();
            shouldSyncControls = true;
        }

        // Check for paused blocks that should resume
        const resumedBlocks = appData.activeBlocks.filter(
            block => block.isPaused && block.pauseEndTime && block.pauseEndTime <= now
        );

        if (resumedBlocks.length > 0) {
            // Clear pause state
            resumedBlocks.forEach(block => {
                delete block.isPaused;
                delete block.pauseEndTime;
            });

            await saveData();
            await syncActiveBlocksToHelper();
            await updateHostsFile();
            await updateBlockedApps();
            render();
            shouldSyncControls = true;
        }

        // Check for paused schedules that should resume
        if (appData.schedules) {
            const resumedSchedules = appData.schedules.filter(
                s => s.isPaused && s.pauseEndTime && s.pauseEndTime <= now
            );

            if (resumedSchedules.length > 0) {
                resumedSchedules.forEach(schedule => {
                    delete schedule.isPaused;
                    delete schedule.pauseEndTime;
                });

                await saveData();
                await syncSchedulesToHelper();
                await updateHostsFile();
                await updateBlockedApps();
                render();
                shouldSyncControls = true;
            }
        }

        // Check for schedule segment transitions every 30s (schedules are minute-granular
        // and the helper daemon handles transitions autonomously)
        if (appData.schedules && appData.schedules.length > 0) {
            if (!startTickInterval._scheduleTickCount) startTickInterval._scheduleTickCount = 0;
            startTickInterval._scheduleTickCount++;

            if (startTickInterval._scheduleTickCount >= 30) {
                startTickInterval._scheduleTickCount = 0;
                await updateHostsFile();
                await updateBlockedApps();
                shouldSyncControls = true;
            }

            // Check for expired non-repeating schedules and auto-stop them
            const expiredScheduleIds = [];
            const nowDate = new Date(now);

            for (const schedule of appData.schedules) {
                // Only check non-repeating schedules (repeatType === 'no' or undefined)
                if (schedule.repeatType === 'forever') continue;

                // For date-limited schedules, check if past the repeat date
                if (schedule.repeatType === 'date' && schedule.repeatDate) {
                    const endDate = new Date(schedule.repeatDate);
                    endDate.setHours(23, 59, 59, 999); // End of day
                    if (nowDate > endDate) {
                        expiredScheduleIds.push(schedule.id);
                        console.log('Schedule expired (past repeat date):', schedule.id);
                    }
                    continue;
                }

                // For non-repeating schedules (repeatType === 'no' or undefined)
                // Calculate when each segment was supposed to occur based on createdAt
                const createdAt = new Date(schedule.createdAt);
                const createdDayOfWeek = createdAt.getDay() === 0 ? 6 : createdAt.getDay() - 1; // Convert to Mon=0 format

                let allSegmentsExpired = true;

                for (const segment of schedule.segments) {
                    for (const segmentDay of segment.days) {
                        // Calculate the actual date this segment occurs on
                        // It should be the first occurrence of this day on or after createdAt
                        let daysUntilSegment = segmentDay - createdDayOfWeek;
                        if (daysUntilSegment < 0) daysUntilSegment += 7;

                        const segmentDate = new Date(createdAt);
                        segmentDate.setDate(segmentDate.getDate() + daysUntilSegment);
                        segmentDate.setHours(segment.endHour, segment.endMinute, 0, 0);

                        // If this segment's end time is still in the future, the schedule is not expired
                        if (segmentDate > nowDate) {
                            allSegmentsExpired = false;
                            break;
                        }
                    }
                    if (!allSegmentsExpired) break;
                }

                if (allSegmentsExpired) {
                    expiredScheduleIds.push(schedule.id);
                    console.log('Non-repeating schedule expired (all segments passed):', schedule.id);
                }
            }

            // Remove expired schedules
            if (expiredScheduleIds.length > 0) {
                const previousScheduleCount = appData.schedules.length;
                appData.schedules = appData.schedules.filter(s => !expiredScheduleIds.includes(s.id));

                if (appData.schedules.length < previousScheduleCount) {
                    console.log('Auto-stopped expired schedule(s):', expiredScheduleIds);
                    activeScheduleSegmentCount = 0;
                    await saveData();
                    // Sync updated schedules to helper daemon
                    await syncSchedulesToHelper();
                    // Update blocked apps after schedule expiration
                    await updateBlockedApps();
                    render();
                    shouldSyncControls = true;
                }
            }
        }

        // Check for expired blocks
        const previousCount = appData.activeBlocks.length;
        appData.activeBlocks = appData.activeBlocks.filter(block => block.endTime > now);

        // Clean up activated set
        activatedBlockIds = new Set(
            [...activatedBlockIds].filter(id =>
                appData.activeBlocks.some(b => b.id === id)
            )
        );

        // Only re-render if blocks actually expired
        if (appData.activeBlocks.length < previousCount) {
            saveData();
            render();

            // Sync blocking rules now that blocks have been removed.
            // On iOS this clears Screen Time settings; on desktop the helper
            // daemon handles expiry autonomously, but the call is harmless.
            await updateHostsFile();
            await updateBlockedApps();
            shouldSyncControls = true;
        }

        const scheduleStateSignature = getScheduleStateSignature(now);
        if (startTickInterval._lastScheduleStateSignature !== scheduleStateSignature) {
            startTickInterval._lastScheduleStateSignature = scheduleStateSignature;
            // Schedule segment transitioned (active↔inactive) — update blocking
            // rules immediately so iOS Screen Time enforcement fires within ~1s
            // instead of waiting up to 30s for the schedule tick counter.
            if (isIOS) {
                await syncSchedulesToHelper();
            }
            await updateHostsFile();
            await updateBlockedApps();
            render();
            shouldSyncControls = true;
        }
        if (shouldSyncControls) {
            syncSelectedControlState();
        }

        // Update remaining times in UI
        document.querySelectorAll('.entry-remaining').forEach((el, idx) => {
            const block = appData.activeBlocks[idx];
            if (block) {
                if (block.isPaused) {
                    const pauseRemaining = Math.max(0, Math.ceil((block.pauseEndTime - now) / 60000));
                    el.textContent = `Paused — resumes in ${formatDuration(pauseRemaining)}`;
                } else if (isBlockAlwaysOn(block)) {
                    el.textContent = 'Always';
                } else {
                    const remaining = Math.max(0, Math.ceil((block.endTime - now) / 60000));
                    el.textContent = `${formatDuration(remaining)} remaining`;
                }
            }
        });

        // Auto-update end time if user hasn't manually edited it (skip in always-on mode)
        if (selectedBlocklistId && !userEditedEndTime && !isAlwaysOnMode) {
            const newEndTime = new Date(now + targetDurationMinutes * 60 * 1000);
            selectedEndHour = newEndTime.getHours();
            selectedEndMinute = newEndTime.getMinutes();
            updateTimeDisplay();
            // Don't call handleTimeChange here to avoid circular updates
        }
    }, 1000);
}

function getScheduleStateSignature(now = Date.now()) {
    const nowDate = new Date(now);
    if (!appData.schedules || appData.schedules.length === 0) return '';
    return appData.schedules.map(s => `${s.id || s.blocklistId}:${s.isPaused && s.pauseEndTime > now ? 1 : 0}:${isScheduleSegmentActiveNow(s, nowDate) ? 1 : 0}`).sort().join('|');
}

// Utility functions
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function formatTime(date) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(minutes) {
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

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// Clean up URL for display (remove protocol, www, trailing slash)
function cleanUrlForDisplay(url) {
    return url
        .replace(/^https?:\/\//, '')  // Remove http:// or https://
        .replace(/^www\./, '')         // Remove www.
        .replace(/\/$/, '');           // Remove trailing slash
}

// Get contrasting text color (black or white) based on background color
function getContrastTextColor(backgroundColor) {
    if (!backgroundColor) return '#ffffff';

    // Parse color - handle hex, rgb, rgba, and named colors
    let r, g, b;

    if (backgroundColor.startsWith('#')) {
        // Hex color
        const hex = backgroundColor.slice(1);
        if (hex.length === 3) {
            r = parseInt(hex[0] + hex[0], 16);
            g = parseInt(hex[1] + hex[1], 16);
            b = parseInt(hex[2] + hex[2], 16);
        } else if (hex.length >= 6) {
            r = parseInt(hex.slice(0, 2), 16);
            g = parseInt(hex.slice(2, 4), 16);
            b = parseInt(hex.slice(4, 6), 16);
        }
    } else if (backgroundColor.startsWith('rgb')) {
        // RGB or RGBA
        const match = backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (match) {
            r = parseInt(match[1]);
            g = parseInt(match[2]);
            b = parseInt(match[3]);
        }
    }

    // If we couldn't parse, default to white text
    if (r === undefined || g === undefined || b === undefined) {
        return '#ffffff';
    }

    // Calculate relative luminance using WCAG formula
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

    // Return black for light backgrounds, white for dark backgrounds
    return luminance > 0.5 ? '#000000' : '#ffffff';
}

const SETTINGS_TRANSLATIONS = {
    en: {
        // Main shell
        updateBannerPrefix: 'Version',
        updateBannerSuffix: 'is available',
        updateBannerCta: 'Reinstall from reddfocus.org',
        mainStartBlockTitle: 'Start a Block',
        modeNow: 'Now',
        modeSchedule: 'Schedule',
        selectionPrompt: 'Select a blocklist',
        selectionPromptOption: 'Select a blocklist...',
        yourBlocklists: 'Your Blocklists',
        scheduleTitle: 'Schedule',
        today: 'Today',
        noActiveBlocks: 'No active blocks',
        madeWith: 'Made with',
        by: 'by',
        andWord: 'and',
        nothingWord: 'nothing',
        noItems: 'No items',
        noBlocklistsYet: 'No blocklists yet',
        clickHereCreateBlocklist: 'Click here to create one',
        typeHere: 'Type here...',
        placeholderNameExample: 'e.g., Social Media',
        placeholderWebsiteExample: 'e.g., facebook.com',
        placeholderAppExample: 'e.g., Safari',
        invalidDomainMsg: 'Please enter a valid domain (e.g. reddit.com)',
        cannotBlockDomainPlaceholder: '⚠️ Can\'t block this domain!',
        cannotBlockSelfAppPlaceholder: '⚠️ Can\'t block ReDD Block itself!',
        // Start/schedule controls
        durationModeAlways: 'always',
        durationModeTimed: 'for some time',
        alwaysOnMessage: 'This block will stay on until you pause it or turn it off',
        duration: 'Duration',
        durationUnitMin: 'min',
        end: 'End',
        nextDay: 'day',
        quickSelect: 'Quick Select',
        start: 'Start',
        days: 'Days',
        add: 'Add',
        repeat: 'Repeat:',
        repeatNo: 'No',
        repeatForever: 'Forever',
        repeatUntilDate: 'Until date',
        pause: 'Pause',
        startBlockButton: 'Start Block:',
        startScheduleButton: 'Start Schedule:',
        stopScheduleButton: 'Stop Schedule:',
        editScheduleButton: 'Edit Schedule:',
        // Blocklist modal
        createBlocklist: 'Create Blocklist',
        editBlocklist: 'Edit Blocklist',
        activeBlocklistWarning: 'This blocklist is active. Some settings are locked.',
        name: 'Name',
        websites: 'Websites',
        websitesTooltip: 'Blocking applies to entire domains. For example, typing "facebook.com" blocks all of Facebook, not just specific pages.',
        apps: 'Apps',
        appsTooltip: 'Enter the exact name of the application (e.g. \'Safari\'). You can also use the folder button to find the app.',
        overrideDifficulty: 'Override Difficulty',
        overrideRandomWords: 'Random Words',
        overrideGibberish: 'Random Gibberish',
        overrideCustomText: 'Custom Text',
        overrideMaxDifficulty: 'Max difficulty',
        totalCharacters: 'total characters',
        color: 'Color',
        emoji: 'Emoji',
        advancedOptions: 'Advanced options',
        listBlockedOnCard: 'List blocked websites & apps on card',
        showInSchedule: 'Show in schedule',
        cancel: 'Cancel',
        save: 'Save',
        // Override / pause / confirmation modals
        overrideBlockTitle: 'Override Block?',
        overrideInstruction: 'To cancel this block early, type the following:',
        scheduleOverrideJustThis: 'Just this block',
        scheduleOverrideStop: 'Stop schedule',
        override: 'Override',
        pauseBlockTitle: 'Pause Block',
        pauseFor: 'PAUSE FOR',
        restartsAt: 'RESTARTS AT',
        pauseInstruction: 'To pause this block, type the following:',
        helperSetupTitle: 'Setup Required',
        helperSetupText: 'To block websites when the app is closed, ReDD Block needs to install a small background service. Your computer will prompt you for your password once — after that, blocks will start instantly without asking again.',
        helperRepairTitle: 'Helper Repair Required',
        helperRepairText: 'A helper service is already installed, but it is not running right now. ReDD Block needs to reinstall or repair it before this block can start. Your computer may prompt you for your password to complete the repair.',
        helperUpdateTitle: 'Helper Update Required',
        helperUpdateText: 'A helper service is already installed, but it needs an update before this block can start. Your computer will prompt you for your password to apply the update.',
        helperOpenSourceLink: 'open source code for ReDD Block here',
        proceed: 'Proceed',
        reinstallHelper: 'Reinstall Helper',
        helperInstalling: 'Installing...',
        helperUpdating: 'Updating...',
        helperReinstalling: 'Reinstalling...',
        startThisBlock: 'Start this block?',
        blockedWebsites: 'Blocked websites:',
        blockedApps: 'Blocked apps:',
        showAll: 'show all',
        confirmDuration: 'Duration:',
        confirmOverrideNeed: 'To cancel this block early, you\'ll need to:',
        startBlock: 'Start Block',
        resumeBlock: 'Resume Block',
        alwaysUntilOff: 'Always (until turned off)',
        scheduleResumingSegment: 'Schedule (resuming current segment)',
        startThisSchedule: 'Start this schedule?',
        repeatLabel: 'Repeat:',
        confirmScheduleOverrideNeed: 'To cancel blocks in this schedule, you\'ll need to:',
        startSchedule: 'Start Schedule',
        noDaysSelected: 'No days selected',
        runningSuffix: ' (Running)',
        // Override all
        overrideAllTitle: 'Override All Blocks?',
        overrideAllWarningStrong: 'Are you sure you want to stop all running blocks?',
        overrideAllWarningBody: 'This will stop ANY currently running blocks for any website and app. It will also stop any future scheduled blocking.',
        overrideAllInstruction: 'To do this, type the following:',
        overrideAll: 'Override All',
        undo: 'Undo',
        // Settings
        settingsTitle: 'Settings',
        yourVersionPrefix: 'Your version:',
        latestVersionPrefix: 'Latest version:',
        lightDarkMode: 'Light/dark mode',
        language: 'Language',
        themeAuto: 'Auto',
        themeLight: 'Light',
        themeDark: 'Dark',
        languageEnglish: 'English',
        languageDanish: 'Dansk',
        advancedOptions: 'Advanced options',
        overrideAllBlocks: 'Stop all blocks (with challenge)',
        helperService: 'Helper service',
        helperStatusChecking: 'Checking...',
        helperStatusActive: 'Active',
        helperStatusIdle: 'Idle',
        helperStatusInstalledNotReachable: 'Installed, not reachable',
        helperStatusUpdateAvailable: 'Update available',
        helperStatusNotInstalled: 'Not installed',
        helperStatusUnknown: 'Unknown',
        updateHelper: 'Update Helper',
        uninstallHelper: 'Uninstall Helper',
        helperRemoving: 'Removing...',
        helperRemoved: 'Helper removed',
        helperRemovedSuccess: 'Helper service removed successfully.',
        helperRemovedFallback: 'Helper service removed using fallback cleanup because the installed helper was not responding normally.',
        helperRemoveStaleHint: 'Installed, but not currently running. You can remove the stale helper before reinstalling it.',
        cleanHostsFile: 'Clean hosts file',
        helperHint: 'Remove all ReDD Block entries from your system\'s hosts file. Use this if websites remain blocked after all blocks have been stopped.',
        close: 'Close',
        // Time/date words
        dayAbbrev: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
        dayAbbrevMon0: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
        locale: 'en-US',
    },
    da: {
        // Main shell
        updateBannerPrefix: 'Version',
        updateBannerSuffix: 'er tilgængelig',
        updateBannerCta: 'Geninstaller fra reddfocus.org',
        mainStartBlockTitle: 'Start en blokering',
        modeNow: 'Nu',
        modeSchedule: 'Skema',
        selectionPrompt: 'Vælg en blokliste',
        selectionPromptOption: 'Vælg en blokliste...',
        yourBlocklists: 'Dine bloklister',
        scheduleTitle: 'Skema',
        today: 'I dag',
        noActiveBlocks: 'Ingen aktive blokeringer',
        madeWith: 'Lavet med',
        by: 'af',
        andWord: 'og',
        nothingWord: 'intet',
        noItems: 'Ingen elementer',
        noBlocklistsYet: 'Ingen bloklister endnu',
        clickHereCreateBlocklist: 'Klik her for at oprette en',
        typeHere: 'Skriv her...',
        placeholderNameExample: 'f.eks. Sociale medier',
        placeholderWebsiteExample: 'f.eks. facebook.com',
        placeholderAppExample: 'f.eks. Safari',
        invalidDomainMsg: 'Indtast et gyldigt domæne (f.eks. reddit.com)',
        cannotBlockDomainPlaceholder: '⚠️ Dette domæne kan ikke blokeres!',
        cannotBlockSelfAppPlaceholder: '⚠️ ReDD Block kan ikke blokere sig selv!',
        // Start/schedule controls
        durationModeAlways: 'altid',
        durationModeTimed: 'et stykke tid',
        alwaysOnMessage: 'Denne blokering forbliver aktiv, indtil du pauser den eller slår den fra',
        duration: 'Varighed',
        durationUnitMin: 'min',
        end: 'Slut',
        nextDay: 'dag',
        quickSelect: 'Hurtigvalg',
        start: 'Start',
        days: 'Dage',
        add: 'Tilføj',
        repeat: 'Gentag:',
        repeatNo: 'Nej',
        repeatForever: 'For evigt',
        repeatUntilDate: 'Indtil dato',
        pause: 'Pause',
        startBlockButton: 'Start blokering:',
        startScheduleButton: 'Start skema:',
        stopScheduleButton: 'Stop skema:',
        editScheduleButton: 'Rediger skema:',
        // Blocklist modal
        createBlocklist: 'Opret blokliste',
        editBlocklist: 'Rediger blokliste',
        activeBlocklistWarning: 'Denne blokliste er aktiv. Nogle indstillinger er låst.',
        name: 'Navn',
        websites: 'hjemmesider',
        websitesTooltip: 'Blokering gælder hele domæner. Hvis du fx skriver "facebook.com", blokeres hele Facebook, ikke kun specifikke sider.',
        apps: 'Apps',
        appsTooltip: 'Indtast det præcise navn på appen (fx "Safari"). Du kan også bruge mappeknappen til at finde appen.',
        overrideDifficulty: 'Sværhedsgrad',
        overrideRandomWords: 'Tilfældige ord',
        overrideGibberish: 'Tilfældig gibberish',
        overrideCustomText: 'Egen tekst',
        overrideMaxDifficulty: 'Maksimal sværhedsgrad',
        totalCharacters: 'tegn i alt',
        color: 'Farve',
        emoji: 'Emoji',
        advancedOptions: 'Avancerede indstillinger',
        listBlockedOnCard: 'Vis blokerede websites og apps på kortet',
        showInSchedule: 'Vis i skema',
        cancel: 'Annuller',
        save: 'Gem',
        // Override / pause / confirmation modals
        overrideBlockTitle: 'Overstyr blokering?',
        overrideInstruction: 'For at annullere denne blokering tidligt, skriv følgende:',
        scheduleOverrideJustThis: 'Kun denne blokering',
        scheduleOverrideStop: 'Stop skema',
        override: 'Overstyr',
        pauseBlockTitle: 'Sæt blokering på pause',
        pauseFor: 'PAUSE I',
        restartsAt: 'STARTER IGEN KL.',
        pauseInstruction: 'For at pause denne blokering, skriv følgende:',
        helperSetupTitle: 'Opsætning påkrævet',
        helperSetupText: 'For at blokere websites, når appen er lukket, skal ReDD Block installere en lille baggrundstjeneste. Din computer beder om adgangskode én gang — derefter starter blokeringer med det samme uden ny prompt.',
        helperRepairTitle: 'Reparation af helper påkrævet',
        helperRepairText: 'Der er allerede installeret en helper-tjeneste, men den kører ikke lige nu. ReDD Block skal geninstallere eller reparere den, før denne blokering kan starte. Din computer kan bede om adgangskode for at fuldføre reparationen.',
        helperUpdateTitle: 'Helper-opdatering påkrævet',
        helperUpdateText: 'Der er allerede installeret en helper-tjeneste, men den skal opdateres, før denne blokering kan starte. Din computer beder om adgangskode for at gennemføre opdateringen.',
        helperOpenSourceLink: 'open source-koden til ReDD Block her',
        proceed: 'Fortsæt',
        reinstallHelper: 'Geninstaller helper',
        helperInstalling: 'Installerer...',
        helperUpdating: 'Opdaterer...',
        helperReinstalling: 'Geninstallerer...',
        startThisBlock: 'Start denne blokering?',
        blockedWebsites: 'Blokerede hjemmesider:',
        blockedApps: 'Blokerede apps:',
        showAll: 'vis alle',
        confirmDuration: 'Varighed:',
        confirmOverrideNeed: 'For at annullere denne blokering tidligt skal du:',
        startBlock: 'Start blokering',
        resumeBlock: 'Genoptag blokering',
        alwaysUntilOff: 'Altid (indtil den slås fra)',
        scheduleResumingSegment: 'Skema (genoptager nuværende segment)',
        startThisSchedule: 'Start dette skema?',
        repeatLabel: 'Gentag:',
        confirmScheduleOverrideNeed: 'For at annullere blokeringer i dette skema skal du:',
        startSchedule: 'Start skema',
        noDaysSelected: 'Ingen dage valgt',
        runningSuffix: ' (Kører)',
        // Override all
        overrideAllTitle: 'Overstyr alle blokeringer?',
        overrideAllWarningStrong: 'Er du sikker på, at du vil stoppe alle aktive blokeringer?',
        overrideAllWarningBody: 'Dette stopper ALLE nuværende blokeringer af websites og apps. Det stopper også alle fremtidige planlagte blokeringer.',
        overrideAllInstruction: 'For at gøre dette, skriv følgende:',
        overrideAll: 'Overstyr alle',
        undo: 'Fortryd',
        // Settings
        settingsTitle: 'Indstillinger',
        yourVersionPrefix: 'Din version:',
        latestVersionPrefix: 'Nyeste version:',
        lightDarkMode: 'Lys/mørk tilstand',
        language: 'Sprog',
        themeAuto: 'Auto',
        themeLight: 'Lys',
        themeDark: 'Mørk',
        languageEnglish: 'Engelsk',
        languageDanish: 'Dansk',
        overrideAllBlocks: 'Stop alle blokeringer (med udfordring)',
        helperService: 'Hjælper',
        helperStatusChecking: 'Tjekker...',
        helperStatusActive: 'Aktiv',
        helperStatusIdle: 'Inaktiv',
        helperStatusInstalledNotReachable: 'Installeret, men ikke tilgængelig',
        helperStatusUpdateAvailable: 'Opdatering tilgængelig',
        helperStatusNotInstalled: 'Ikke installeret',
        helperStatusUnknown: 'Ukendt',
        updateHelper: 'Opdater hjælper',
        uninstallHelper: 'Afinstaller hjælper',
        helperRemoving: 'Fjerner...',
        helperRemoved: 'Helper fjernet',
        helperRemovedSuccess: 'Hjælperen blev fjernet.',
        helperRemovedFallback: 'Hjælperen blev fjernet via reserveoprydning, fordi den installerede hjælper ikke svarede normalt.',
        helperRemoveStaleHint: 'Installeret, men kører ikke lige nu. Du kan fjerne den gamle hjælper her, før du geninstallerer den.',
        cleanHostsFile: 'Ryd hosts-fil',
        helperHint: 'Fjern alle ReDD Block-indsætninger fra systemets hosts-fil. Brug kun dette, hvis websites stadig er utilgængelige efter du har stoppet alle blokeringer.',
        close: 'Luk',
        // Time/date words
        dayAbbrev: ['Søn', 'Man', 'Tir', 'Ons', 'Tor', 'Fre', 'Lør'],
        dayAbbrevMon0: ['Man', 'Tir', 'Ons', 'Tor', 'Fre', 'Lør', 'Søn'],
        locale: 'da-DK',
    },
};

function getSettingsLanguage() {
    return appData.settings?.language === 'da' ? 'da' : 'en';
}

function tSettings(key) {
    const lang = getSettingsLanguage();
    return SETTINGS_TRANSLATIONS[lang][key] || SETTINGS_TRANSLATIONS.en[key] || key;
}

function websiteWord(count) {
    if (getSettingsLanguage() === 'da') {
        return count === 1 ? 'hjemmeside' : 'hjemmesider';
    }
    return count === 1 ? 'website' : 'websites';
}

function formatCurrentVersionText(version) {
    return `${tSettings('yourVersionPrefix')} ${version || 'Unknown'}`;
}

function formatLatestVersionText(version) {
    return `${tSettings('latestVersionPrefix')} ${version || 'Unknown'}`;
}

function applySettingsLanguage() {
    const setText = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    };

    // Main shell / scheduler
    setText('update-banner-prefix', tSettings('updateBannerPrefix'));
    setText('update-banner-suffix', tSettings('updateBannerSuffix'));
    setText('update-banner-link', tSettings('updateBannerCta'));
    setText('main-start-block-title', tSettings('mainStartBlockTitle'));
    setText('instant-mode-tab', tSettings('modeNow'));
    setText('schedule-mode-tab', tSettings('modeSchedule'));
    setText('selection-prompt-label', tSettings('selectionPrompt'));
    const blocklistSelect = document.getElementById('blocklist-select');
    if (blocklistSelect && blocklistSelect.options.length > 0) {
        blocklistSelect.options[0].textContent = tSettings('selectionPromptOption');
    }
    setText('main-blocklists-title', tSettings('yourBlocklists'));
    setText('main-schedule-title', tSettings('scheduleTitle'));
    setText('today-btn', tSettings('today'));
    setText('no-active-blocks-label', tSettings('noActiveBlocks'));
    setText('duration-mode-always-label', tSettings('durationModeAlways'));
    setText('duration-mode-timed-label', tSettings('durationModeTimed'));
    setText('always-on-message-text', tSettings('alwaysOnMessage'));
    setText('duration-label', tSettings('duration'));
    setText('duration-unit-label', tSettings('durationUnitMin'));
    setText('end-label', tSettings('end'));
    setText('quick-select-label', tSettings('quickSelect'));
    setText('schedule-start-label', tSettings('start'));
    setText('schedule-end-label', tSettings('end'));
    setText('schedule-days-label', tSettings('days'));
    setText('add-segment-label', tSettings('add'));
    setText('repeat-label', tSettings('repeat'));
    const repeatNo = document.querySelector('.repeat-option[data-value="no"]');
    const repeatForever = document.querySelector('.repeat-option[data-value="forever"]');
    const repeatDate = document.querySelector('.repeat-option[data-value="date"]');
    if (repeatNo) repeatNo.textContent = tSettings('repeatNo');
    if (repeatForever) repeatForever.textContent = tSettings('repeatForever');
    if (repeatDate) repeatDate.textContent = tSettings('repeatUntilDate');
    const repeatDropdownText = document.getElementById('repeat-dropdown-text');
    if (repeatDropdownText) {
        if (scheduleRepeatType === 'forever') repeatDropdownText.textContent = tSettings('repeatForever');
        else if (scheduleRepeatType === 'date') repeatDropdownText.textContent = tSettings('repeatUntilDate');
        else repeatDropdownText.textContent = tSettings('repeatNo');
    }
    setText('pause-btn-label', tSettings('pause'));
    setText('start-block-btn-label', tSettings('startBlockButton'));
    setText('start-schedule-btn-label', tSettings('startScheduleButton'));
    setText('footer-made-with', tSettings('madeWith'));
    setText('footer-by', tSettings('by'));
    const setPlaceholder = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.placeholder = text;
    };
    setPlaceholder('blocklist-name', tSettings('placeholderNameExample'));
    setPlaceholder('modal-website-input', tSettings('placeholderWebsiteExample'));
    setPlaceholder('modal-app-input', tSettings('placeholderAppExample'));
    setPlaceholder('challenge-input', tSettings('typeHere'));
    setPlaceholder('pause-challenge-input', tSettings('typeHere'));
    setPlaceholder('override-all-challenge-input', tSettings('typeHere'));
    setText('website-input-error', tSettings('invalidDomainMsg'));

    // Blocklist modal
    const modalTitle = document.getElementById('modal-title');
    if (modalTitle) {
        modalTitle.textContent = editingBlocklistId ? tSettings('editBlocklist') : tSettings('createBlocklist');
    }
    setText('active-blocklist-warning-text', tSettings('activeBlocklistWarning'));
    setText('blocklist-name-label', tSettings('name'));
    setText('blocklist-websites-label', tSettings('websites'));
    setText('blocklist-websites-tooltip', tSettings('websitesTooltip'));
    setText('blocklist-apps-label', tSettings('apps'));
    setText('blocklist-apps-tooltip', tSettings('appsTooltip'));
    setText('override-difficulty-label', tSettings('overrideDifficulty'));
    setText('override-option-random-words', tSettings('overrideRandomWords'));
    setText('override-option-gibberish', tSettings('overrideGibberish'));
    setText('override-option-custom', tSettings('overrideCustomText'));
    setText('override-max-difficulty-label', tSettings('overrideMaxDifficulty'));
    setText('override-total-characters-label', tSettings('totalCharacters'));
    setText('blocklist-color-label', tSettings('color'));
    setText('blocklist-emoji-label', tSettings('emoji'));
    setText('blocklist-advanced-options-label', tSettings('advancedOptions'));
    setText('show-item-details-label', tSettings('listBlockedOnCard'));
    setText('always-show-in-schedule-label', tSettings('showInSchedule'));
    setText('cancel-blocklist-btn', tSettings('cancel'));
    setText('save-blocklist-btn', tSettings('save'));

    // Modal copy
    setText('override-modal-title', tSettings('overrideBlockTitle'));
    setText('override-modal-instruction', tSettings('overrideInstruction'));
    setText('schedule-override-just-this-label', tSettings('scheduleOverrideJustThis'));
    setText('schedule-override-stop-label', tSettings('scheduleOverrideStop'));
    setText('cancel-override-btn', tSettings('cancel'));
    setText('confirm-override-btn', tSettings('override'));
    setText('pause-modal-title', tSettings('pauseBlockTitle'));
    setText('pause-for-label', tSettings('pauseFor'));
    setText('pause-restarts-at-label', tSettings('restartsAt'));
    setText('pause-modal-instruction', tSettings('pauseInstruction'));
    setText('cancel-pause-btn', tSettings('cancel'));
    setText('confirm-pause-btn', tSettings('pause'));
    setText('start-block-confirm-title', tSettings('startThisBlock'));
    setText('confirm-blocked-websites-label', tSettings('blockedWebsites'));
    setText('confirm-blocked-apps-label', tSettings('blockedApps'));
    setText('show-all-websites', tSettings('showAll'));
    setText('show-all-apps', tSettings('showAll'));
    setText('confirm-duration-label', tSettings('confirmDuration'));
    setText('confirm-override-header', tSettings('confirmOverrideNeed'));
    setText('cancel-start-confirm-btn', tSettings('cancel'));
    setText('proceed-start-confirm-btn', tSettings('startBlock'));
    setText('start-schedule-confirm-title', tSettings('startThisSchedule'));
    setText('schedule-confirm-blocked-websites-label', tSettings('blockedWebsites'));
    setText('schedule-confirm-blocked-apps-label', tSettings('blockedApps'));
    setText('show-all-schedule-websites', tSettings('showAll'));
    setText('show-all-schedule-apps', tSettings('showAll'));
    setText('schedule-summary-header', tSettings('scheduleTitle'));
    setText('schedule-confirm-repeat-label', tSettings('repeatLabel'));
    setText('schedule-confirm-override-header', tSettings('confirmScheduleOverrideNeed'));
    setText('cancel-schedule-confirm-btn', tSettings('cancel'));
    setText('proceed-schedule-confirm-btn', tSettings('startSchedule'));
    setText('undo-toast-btn', tSettings('undo'));
    setText('override-all-title', tSettings('overrideAllTitle'));
    setText('override-all-warning-strong', tSettings('overrideAllWarningStrong'));
    setText('override-all-warning-body', tSettings('overrideAllWarningBody'));
    setText('override-all-instruction', tSettings('overrideAllInstruction'));
    setText('cancel-override-all-btn', tSettings('cancel'));
    setText('confirm-override-all-btn', tSettings('overrideAll'));
    setText('next-day-indicator', `+1 ${tSettings('nextDay')}`);
    setText('pause-next-day-indicator', `+1 ${tSettings('nextDay')}`);

    setText('settings-modal-title', tSettings('settingsTitle'));
    setText('settings-theme-label', tSettings('lightDarkMode'));
    setText('settings-language-label', tSettings('language'));
    setText('theme-option-system', tSettings('themeAuto'));
    setText('theme-option-light', tSettings('themeLight'));
    setText('theme-option-dark', tSettings('themeDark'));
    setText('language-option-en', tSettings('languageEnglish'));
    setText('language-option-da', tSettings('languageDanish'));
    setText('settings-advanced-options-label', tSettings('advancedOptions'));
    setText('settings-override-all-label', tSettings('overrideAllBlocks'));
    setText('settings-helper-service-label', tSettings('helperService'));
    setText('settings-update-helper-label', tSettings('updateHelper'));
    setText('settings-clean-hosts-label', tSettings('cleanHostsFile'));
    setText('settings-helper-hint', tSettings('helperHint'));
    setText('close-settings-btn', tSettings('close'));

    const currentVersionEl = document.getElementById('current-app-version');
    if (currentVersionEl) {
        const raw = currentVersionEl.textContent || '';
        const version = raw.split(':').slice(1).join(':').trim() || '...';
        currentVersionEl.textContent = formatCurrentVersionText(version);
    }

    const latestVersionEl = document.getElementById('latest-app-version');
    if (latestVersionEl) {
        const raw = latestVersionEl.textContent || '';
        const version = raw.split(':').slice(1).join(':').trim() || '...';
        latestVersionEl.textContent = formatLatestVersionText(version);
    }

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

    // Re-render pieces with dynamic language-dependent text.
    renderBlocklists();
    if (document.getElementById('blocklist-select')) renderBlocklistSelector();
    if (typeof updateScheduleButtonState === 'function') updateScheduleButtonState();
    if (typeof updateWeekCalendar === 'function' && currentWeekStart) updateWeekCalendar();
}

// Theme Handling
function setupTheme() {
    // Apply initial theme from saved settings
    applyTheme();

    // Setup settings modal
    const settingsBtn = document.getElementById('settings-btn');
    const settingsModal = document.getElementById('settings-modal');
    const closeSettingsBtn = document.getElementById('close-settings-btn');
    const themeSelect = document.getElementById('theme-select');
    const languageSelect = document.getElementById('language-select');

    // Apply language immediately on startup.
    applySettingsLanguage();

    if (settingsBtn && settingsModal) {
        settingsBtn.addEventListener('click', () => {
            settingsModal.classList.remove('hidden');
            // Set current theme selection
            if (themeSelect) {
                const currentTheme = appData.settings?.themeMode || 'system';
                themeSelect.value = currentTheme;
            }
            if (languageSelect) {
                languageSelect.value = getSettingsLanguage();
            }

            void (async () => {
                applySettingsLanguage();

                // Fetch and display version info
                const currentVersionEl = document.getElementById('current-app-version');
                const latestVersionEl = document.getElementById('latest-app-version');
                const latestVersionWrap = document.getElementById('settings-latest-version-wrap');

                let currentVersion = null;

                if (currentVersionEl) {
                    try {
                        currentVersion = await tauriAPI.getAppVersion();
                        currentVersionEl.textContent = formatCurrentVersionText(currentVersion || 'Unknown');
                    } catch (e) {
                        console.error('[Version] Error fetching current version:', e);
                        currentVersionEl.textContent = formatCurrentVersionText('Unknown');
                    }
                }

                if (latestVersionEl) {
                    // Hide by default - only show if there's an update available
                    latestVersionEl.style.display = 'none';
                    if (latestVersionWrap) latestVersionWrap.style.display = 'none';

                    try {
                        const response = await fetch(`https://ulyngs.github.io/redd-block/latest-versions.json?t=${Date.now()}`);
                        const versions = await response.json();
                        // Detect platform
                        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
                        const platform = isMac ? 'macos' : 'windows';
                        const latestVersion = versions[platform];

                        // Only show if latest version is higher than current version
                        if (latestVersion && currentVersion && isVersionHigher(latestVersion, currentVersion)) {
                            latestVersionEl.textContent = formatLatestVersionText(latestVersion);
                            latestVersionEl.style.display = 'block';
                            if (latestVersionWrap) latestVersionWrap.style.display = 'block';
                        }
                    } catch (e) {
                        // Silently fail if offline - don't show anything
                        console.log('[Version] Could not check for updates (offline or error):', e.message);
                    }
                }
            })();
        });
    }

    if (closeSettingsBtn && settingsModal) {
        closeSettingsBtn.addEventListener('click', () => {
            settingsModal.classList.add('hidden');
            if (!isModalVisible('diagnostics-modal')) stopHelperUiRefreshLoop();
        });
    }

    // Close modal when clicking outside
    if (settingsModal) {
        settingsModal.addEventListener('click', (e) => {
            if (e.target === settingsModal) {
                settingsModal.classList.add('hidden');
                if (!isModalVisible('diagnostics-modal')) stopHelperUiRefreshLoop();
            }
        });
    }

    // Theme selection change
    if (themeSelect) {
        themeSelect.addEventListener('change', (e) => {
            if (!appData.settings) appData.settings = {};
            appData.settings.themeMode = e.target.value;

            // Update legacy darkMode for backwards compatibility
            if (e.target.value === 'dark') {
                appData.settings.darkMode = true;
            } else if (e.target.value === 'light') {
                appData.settings.darkMode = false;
            } else {
                // Auto/system mode - use system preference
                delete appData.settings.darkMode;
            }

            applyTheme();
            saveData();
        });
    }

    if (languageSelect) {
        languageSelect.addEventListener('change', (e) => {
            if (!appData.settings) appData.settings = {};
            appData.settings.language = e.target.value === 'da' ? 'da' : 'en';
            applySettingsLanguage();
            saveData();
        });
    }

    // Listen for system theme changes when in auto mode
    if (window.matchMedia) {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
            if (appData.settings?.themeMode === 'system' || !appData.settings?.themeMode) {
                applyTheme();
            }
        });
    }
}

function applyTheme() {
    const body = document.body;
    const themeMode = appData.settings?.themeMode || 'system';

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

function getUiZoomMax() {
    const isDesktop = document.body.classList.contains('windows') || document.body.classList.contains('mac');
    return isDesktop ? UI_ZOOM_MAX_DESKTOP : UI_ZOOM_MAX;
}

function clampUiZoom(scale) {
    return Math.min(getUiZoomMax(), Math.max(UI_ZOOM_MIN, scale));
}

function getSavedUiZoom() {
    const parsed = Number(appData.settings?.uiZoom);
    if (!Number.isFinite(parsed)) return DEFAULT_UI_ZOOM;
    return clampUiZoom(parsed);
}

function applyUiZoom(scale) {
    const clamped = clampUiZoom(scale);

    // On desktop (Windows and macOS), use native webview zoom so content scales correctly
    // and behavior matches across platforms. Fall back to CSS zoom if unavailable (e.g. permission).
    if (!isIOS && (document.body.classList.contains('windows') || document.body.classList.contains('mac'))) {
        if (nativeWebviewZoomSupported !== false) {
            getCurrentWebview().setZoom(clamped).then(() => {
                nativeWebviewZoomSupported = true;
                document.documentElement.style.zoom = '';
            }).catch(() => {
                nativeWebviewZoomSupported = false;
                document.documentElement.style.zoom = String(clamped);
            });
            return;
        }
    }

    // Fallback path (iOS or if native zoom isn't available).
    document.documentElement.style.zoom = String(clamped);
}

function showUiZoomToast(scale) {
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

function setUiZoom(scale, options = {}) {
    const clamped = clampUiZoom(scale);
    applyUiZoom(clamped);
    if (options.showToast) {
        showUiZoomToast(clamped);
    }

    if (!appData.settings) appData.settings = {};
    if (appData.settings.uiZoom === clamped) return;

    appData.settings.uiZoom = clamped;
    saveData();
}

function zoomUiIn(options = {}) {
    const current = getSavedUiZoom();
    setUiZoom(Math.round((current + UI_ZOOM_STEP) * 100) / 100, options);
}

function zoomUiOut(options = {}) {
    const current = getSavedUiZoom();
    setUiZoom(Math.round((current - UI_ZOOM_STEP) * 100) / 100, options);
}

function resetUiZoom(options = {}) {
    setUiZoom(DEFAULT_UI_ZOOM, options);
}

function setupUiZoomShortcuts() {
    applyUiZoom(getSavedUiZoom());

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

function setupHelpMenuLinks() {
    tauriAPI.onMenuHelpReportIssue(() => {
        openExternal('https://github.com/ulyngs/redd-block/issues');
    }).catch(() => { });

    tauriAPI.onMenuHelpContactUs(() => {
        openExternal('mailto:team@reddfocus.org');
    }).catch(() => { });

    tauriAPI.onMenuHelpWhoWeAre(() => {
        openExternal('https://www.reddfocus.org/#team-anchor');
    }).catch(() => { });
}

// Setup Helper Settings in the settings modal
function setupHelperSettings() {
    const statusIndicator = document.getElementById('helper-status-indicator');
    const cleanHostsBtn = document.getElementById('clean-hosts-btn');

    // Update helper status when settings modal opens
    const settingsBtn = document.getElementById('settings-btn');
    if (settingsBtn) {
        settingsBtn.addEventListener('click', () => {
            updateHelperStatusIndicator();
            updateCleanHostsBtnState();
            startHelperUiRefreshLoop();
        });
    }

    // Clean hosts file button
    if (cleanHostsBtn && !cleanHostsBtn._listenerAdded) {
        cleanHostsBtn._listenerAdded = true;
        cleanHostsBtn.addEventListener('click', async () => {
            if (cleanHostsBtn.disabled) return;

            const confirmed = await ask(
                'This will remove all ReDD Block entries from your system\'s hosts file. ' +
                'Only use this if websites remain blocked after all blocks have been stopped.\n\n' +
                'Your computer may ask for your password or show a security prompt.',
                { title: 'Clean hosts file?', kind: 'warning' }
            );
            if (!confirmed) return;

            cleanHostsBtn.disabled = true;
            const originalHTML = cleanHostsBtn.innerHTML;
            cleanHostsBtn.innerHTML = '<span class="btn-spinner"></span>Cleaning...';

            try {
                const result = await tauriAPI.cleanHostsFile();
                if (result.success) {
                    await message('Hosts file cleaned successfully. If websites were still blocked, they should now be accessible.', { title: 'Done', kind: 'info' });
                } else {
                    await message('Failed to clean hosts file: ' + (result.error || 'Unknown error'), { title: 'Error', kind: 'error' });
                }
            } catch (e) {
                console.error('Error cleaning hosts file:', e);
                await message('Error cleaning hosts file: ' + e.message, { title: 'Error', kind: 'error' });
            } finally {
                cleanHostsBtn.disabled = false;
                cleanHostsBtn.innerHTML = originalHTML;
                updateCleanHostsBtnState();
            }
        });
    }

}

function getHelperStatusDisplay(status) {
    const isRunning = !!status.running;
    const needsUpdate = isRunning && !status.version_ok;
    const installedButStopped = !!(status.installed && !isRunning);
    const enforcingNow = isRunning && status.version_ok && isDesktopBlockingEnforcedNow();

    if (isRunning && status.version_ok) {
        return {
            helperReady: true,
            indicatorClass: 'running',
            statusKey: enforcingNow ? 'helperStatusActive' : 'helperStatusIdle',
            showUpdate: false,
            showRemove: true,
            removeTitle: '',
            reachable: true,
        };
    }

    if (needsUpdate) {
        return {
            helperReady: false,
            indicatorClass: 'running',
            statusKey: 'helperStatusUpdateAvailable',
            showUpdate: true,
            showRemove: true,
            removeTitle: '',
            reachable: true,
        };
    }

    if (installedButStopped) {
        return {
            helperReady: false,
            indicatorClass: 'stopped',
            statusKey: 'helperStatusInstalledNotReachable',
            showUpdate: false,
            showRemove: true,
            removeTitle: tSettings('helperRemoveStaleHint'),
            reachable: false,
        };
    }

    return {
        helperReady: false,
        indicatorClass: 'stopped',
        statusKey: 'helperStatusNotInstalled',
        showUpdate: false,
        showRemove: false,
        removeTitle: '',
        reachable: false,
    };
}

function logHelperRemovalFallback(result) {
    if (result?.error) {
        console.warn('[helper-uninstall] Fallback cleanup used:', result.error);
    }
}


async function confirmHelperRemoved() {
    const status = await refreshDesktopHelperStatus();
    const removed = !(status?.installed || status?.running);

    await updateHelperStatusIndicator().catch(() => { });
    await checkHelperStatus().catch(() => { });

    if (!removed) {
        return {
            removed: false,
            status,
            error: 'ReDD Block could not confirm that the helper was fully removed. It still appears to be installed.'
        };
    }

    helperAvailable = false;
    return { removed: true, status };
}

async function uninstallHelperAndConfirmRemoved() {
    const result = await tauriAPI.uninstallHelper();
    if (!result.success) {
        return {
            success: false,
            error: result.error || 'Unknown error'
        };
    }

    logHelperRemovalFallback(result);

    const confirmation = await confirmHelperRemoved();
    if (!confirmation.removed) {
        return {
            success: false,
            error: confirmation.error
        };
    }

    return {
        success: true,
        usedFallback: !!result.error
    };
}

function isDesktopBlockingEnforcedNow() {
    if (isIOS) return false;
    return hasAnyEnforcedBlocks();
}

// Update helper status indicator in settings modal
async function updateHelperStatusIndicator() {
    const statusIndicator = document.getElementById('helper-status-indicator');
    if (!statusIndicator) return;

    const statusText = statusIndicator.querySelector('.status-text');
    const updateBtn = document.getElementById('update-helper-btn');

    try {
        const status = await refreshDesktopHelperStatus();
        const helperDisplay = getHelperStatusDisplay(status);
        helperAvailable = helperDisplay.helperReady;

        statusIndicator.classList.remove('running', 'stopped');
        statusIndicator.classList.add(helperDisplay.indicatorClass);
        statusText.textContent = tSettings(helperDisplay.statusKey);

        // Show/hide Update Helper button
        if (updateBtn) {
            updateBtn.style.display = helperDisplay.showUpdate ? 'flex' : 'none';

            // Wire up click handler (only once)
            if (!updateBtn._listenerAdded) {
                updateBtn._listenerAdded = true;
                updateBtn.addEventListener('click', async () => {
                    updateBtn.disabled = true;
                    const originalHTML = updateBtn.innerHTML;
                    updateBtn.innerHTML = '<span class="btn-spinner"></span>Updating...';
                    try {
                        const result = await tauriAPI.installHelper();
                        if (result.success) {
                            // Wait for helper to start up
                            await new Promise(resolve => setTimeout(resolve, 2000));
                            await updateHelperStatusIndicator();
                            await checkHelperStatus();
                        } else if (isHelperInstallCancelled(result?.error)) {
                            console.log('Helper update cancelled by user');
                        } else {
                            await message('Failed to update helper: ' + (result.error || 'Unknown error'), { title: 'Error', kind: 'error' });
                        }
                    } catch (e) {
                        console.error('Error updating helper:', e);
                        await message('Error updating helper: ' + e.message, { title: 'Error', kind: 'error' });
                    } finally {
                        updateBtn.disabled = false;
                        updateBtn.innerHTML = originalHTML;
                    }
                });
            }
        }

    } catch (e) {
        statusIndicator.classList.remove('running', 'stopped');
        statusIndicator.classList.add('stopped');
        statusText.textContent = tSettings('helperStatusUnknown');

        if (updateBtn) updateBtn.style.display = 'none';
    }

    // Also update Override All button visibility
    updateOverrideAllButtonVisibility();
}

// Update clean hosts button state (disabled when blocks are running)
function updateCleanHostsBtnState() {
    const btn = document.getElementById('clean-hosts-btn');
    if (!btn) return;
    const active = hasAnyActiveBlocks();
    btn.disabled = active;
    btn.title = active ? 'Stop all running blocks first' : '';
}

function getDiagValue(diag, ...keys) {
    for (const key of keys) {
        if (diag && diag[key] !== undefined && diag[key] !== null) {
            return diag[key];
        }
    }
    return undefined;
}

function getPrettyPrintedDiagnosticsJson(rawText) {
    if (!rawText) return '(unavailable)';
    try {
        return JSON.stringify(JSON.parse(rawText), null, 2);
    } catch (e) {
        return rawText;
    }
}

function buildDiagnosticsReport(diag) {
    const osName = getDiagValue(diag, 'os_name', 'osName')
        || (navigator.platform?.startsWith('Mac') ? 'macOS' : navigator.platform?.startsWith('Win') ? 'Windows' : 'unknown');
    const arch = getDiagValue(diag, 'arch') || 'unknown';
    const appVersion = document.getElementById('settings-version')?.textContent || '';
    const installed = !!getDiagValue(diag, 'helper_installed', 'helperInstalled');
    const running = !!getDiagValue(diag, 'helper_running', 'helperRunning');
    const version = getDiagValue(diag, 'helper_version', 'helperVersion') || 'Unknown';
    const versionOk = !!getDiagValue(diag, 'helper_version_ok', 'helperVersionOk');
    const expectedVersion = getDiagValue(diag, 'expected_helper_version', 'expectedHelperVersion') || 'unknown';
    const hostsFile = getDiagValue(diag, 'hosts_file', 'hostsFile') || '(unavailable)';
    const hostsPath = getDiagValue(diag, 'hosts_path', 'hostsPath') || '(unknown)';
    const stateFile = getDiagValue(diag, 'helper_state_file', 'helperStateFile') || '(unavailable)';
    const statePath = getDiagValue(diag, 'helper_state_path', 'helperStatePath') || '(unknown)';
    const helperLogTail = getDiagValue(diag, 'helper_log_tail', 'helperLogTail');
    const helperLogPath = getDiagValue(diag, 'helper_log_path', 'helperLogPath');
    const installLogTail = getDiagValue(diag, 'install_log_tail', 'installLogTail');
    const installLogPath = getDiagValue(diag, 'install_log_path', 'installLogPath');
    const helperDisplay = getHelperStatusDisplay({ installed, running, version_ok: versionOk });
    const helperStatusLabel = tSettings(helperDisplay.statusKey);
    const reachable = !!running;

    return {
        osName,
        arch,
        appVersion,
        installed,
        running,
        reachable,
        version,
        versionOk,
        expectedVersion,
        helperStatusLabel,
        helperDisplay,
        hostsFile,
        hostsPath,
        hasReddBlock: hostsFile.includes('BEGIN REDD BLOCK'),
        statePretty: getPrettyPrintedDiagnosticsJson(stateFile),
        statePath,
        helperLogTail,
        helperLogPath,
        installLogTail,
        installLogPath,
    };
}

function formatDiagnosticsText(diag) {
    const report = buildDiagnosticsReport(diag);
    return [
        '=== System ===',
        `OS: ${report.osName}`,
        `Architecture: ${report.arch}`,
        report.appVersion ? `App version: ${report.appVersion}` : '',
        '',
        '=== Helper Daemon ===',
        `Status: ${report.helperStatusLabel}`,
        `Installed: ${report.installed ? 'Yes' : 'No'}`,
        `Reachable: ${report.reachable ? 'Yes' : 'No'}`,
        `Running: ${report.running ? 'Yes' : 'No'}`,
        `Version OK: ${report.versionOk ? 'Yes' : 'No'}`,
        `Version: ${report.version}`,
        `Expected version: ${report.expectedVersion}`,
        '',
        '=== Paths ===',
        `Hosts file: ${report.hostsPath}`,
        `Helper state file: ${report.statePath}`,
        report.helperLogPath ? `Helper log: ${report.helperLogPath}` : '',
        report.installLogPath ? `Install log: ${report.installLogPath}` : '',
        '',
        '=== Hosts File ===',
        report.hostsFile.trim(),
        '',
        '=== Helper State File ===',
        report.statePretty.trim(),
        report.helperLogTail ? '' : undefined,
        report.helperLogTail ? '=== Helper Log Tail ===' : undefined,
        report.helperLogTail ? report.helperLogTail.trim() : undefined,
        report.installLogTail ? '' : undefined,
        report.installLogTail ? '=== Install Log Tail ===' : undefined,
        report.installLogTail ? report.installLogTail.trim() : undefined,
    ].filter(line => line !== undefined).join('\n');
}

function captureDiagnosticsScrollState(content) {
    if (!content) return null;
    return {
        contentScrollTop: content.scrollTop,
        preScrollTops: Array.from(content.querySelectorAll('.diagnostics-pre')).map(el => el.scrollTop),
    };
}

function restoreDiagnosticsScrollState(content, scrollState) {
    if (!content || !scrollState) return;
    content.scrollTop = scrollState.contentScrollTop || 0;
    const preEls = Array.from(content.querySelectorAll('.diagnostics-pre'));
    preEls.forEach((el, idx) => {
        el.scrollTop = scrollState.preScrollTops?.[idx] || 0;
    });
}

async function refreshDiagnosticsModalContent({ showLoading = false } = {}) {
    const modal = document.getElementById('diagnostics-modal');
    const content = document.getElementById('diagnostics-content');
    if (!modal || !content) return;

    const scrollState = showLoading ? null : captureDiagnosticsScrollState(content);
    if (showLoading) {
        content.innerHTML = '<div class="diagnostics-loading">Loading diagnostics...</div>';
    }

    let diag = null;
    try {
        diag = await invoke('get_system_diagnostics');
        content.innerHTML = renderSystemDiagnostics(diag);
        restoreDiagnosticsScrollState(content, scrollState);
    } catch (e) {
        content.innerHTML = `<div class="diagnostics-error">Failed to load diagnostics: ${e.message || e}</div>`;
    }

    const copyBtn = document.getElementById('diagnostics-copy-btn');
    if (copyBtn) {
        copyBtn.onclick = () => {
            if (!diag) { copyBtn.textContent = 'No data'; return; }
            const text = JSON.stringify(diag, null, 2);
            navigator.clipboard.writeText(text).then(() => {
                copyBtn.textContent = 'Copied!';
                setTimeout(() => { copyBtn.textContent = 'Copy to Clipboard'; }, 2000);
            }).catch(() => {
                copyBtn.textContent = 'Copy failed';
                setTimeout(() => { copyBtn.textContent = 'Copy to Clipboard'; }, 2000);
            });
        };
    }
}

// Render the structured SystemDiagnostics struct as collapsible
// HTML sections. Designed for both user-readable scan AND copy-as-JSON
// for filing support tickets.
function renderSystemDiagnostics(d) {
    const ok = (b) => `<span class="diagnostics-value ${b ? 'diag-ok' : 'diag-error'}">${b ? 'Yes' : 'No'}</span>`;
    const yesno = (b) => b ? '✓' : '✗';
    const fmtTs = (ms) => ms ? new Date(ms).toLocaleString() : '—';
    const e = (s) => escapeHtml(String(s));
    let html = '';

    // App
    html += '<div class="diagnostics-section">';
    html += '<div class="diagnostics-section-title">App</div>';
    html += `<div class="diagnostics-field"><span class="diagnostics-label">Version:</span> <span class="diagnostics-value">${e(d.app.version)}</span> <span class="diagnostics-badge">${e(d.app.build_mode)}</span></div>`;
    html += `<div class="diagnostics-field"><span class="diagnostics-label">OS / arch:</span> <span class="diagnostics-value">${e(d.app.os)} / ${e(d.app.arch)}</span></div>`;
    html += '</div>';

    // Migration
    const m = d.migration;
    html += '<div class="diagnostics-section">';
    html += '<div class="diagnostics-section-title">Migration from v1.x</div>';
    html += `<div class="diagnostics-field"><span class="diagnostics-label">Was a v1.x install:</span> <span class="diagnostics-value">${m.came_from_v1x ? 'Yes' : 'No'}</span></div>`;
    if (m.residue_items && m.residue_items.length > 0) {
        html += `<div class="diagnostics-field"><span class="diagnostics-label">Old version leftover files:</span></div>`;
        html += '<ul class="diagnostics-list">';
        for (const item of m.residue_items) {
            html += `<li class="diag-error">${e(item)}</li>`;
        }
        html += '</ul>';
    } else {
        html += `<div class="diagnostics-field"><span class="diagnostics-label">Old version leftover files:</span> <span class="diagnostics-value diag-ok">None — fully migrated</span></div>`;
    }
    html += `<div class="diagnostics-field"><span class="diagnostics-label">Stamped version:</span> <span class="diagnostics-value">${e(m.ran_at_version || '—')}</span></div>`;
    html += `<div class="diagnostics-field"><span class="diagnostics-label">Stamped at:</span> <span class="diagnostics-value">${e(fmtTs(m.ran_at_ms))}</span></div>`;
    html += '</div>';

    // Browsers
    html += '<div class="diagnostics-section">';
    html += '<div class="diagnostics-section-title">Browsers (extension)</div>';
    html += '<table class="diagnostics-table"><thead><tr><th>Browser</th><th>Installed</th><th>Running</th><th>Ext set up</th></tr></thead><tbody>';
    for (const key of ['chrome', 'brave', 'edge', 'firefox', 'safari']) {
        const b = d.browsers[key];
        if (!b) continue;
        const compliant = browserComplianceStatus(key, b) === 'compliant';
        html += `<tr><td>${e(key)}</td><td>${yesno(b.installed)}</td><td>${yesno(b.present)}</td><td>${b.installed ? yesno(compliant) : '—'}</td></tr>`;
    }
    html += '</tbody></table>';
    html += '</div>';

    // Enforcer + autostart
    html += '<div class="diagnostics-section">';
    html += '<div class="diagnostics-section-title">Enforcement</div>';
    html += `<div class="diagnostics-field"><span class="diagnostics-label">Grace period:</span> <span class="diagnostics-value">${e(d.enforcer.grace_seconds)} s</span></div>`;
    html += `<div class="diagnostics-field"><span class="diagnostics-label">Autostart at login:</span> ${ok(d.autostart.enabled)}</div>`;
    if (d.watchdog) {
        html += `<div class="diagnostics-field"><span class="diagnostics-label">Watchdog Scheduled Task:</span> ${ok(d.watchdog.task_present)}</div>`;
    }
    html += '</div>';

    // Recent log
    if (d.recent_log && d.recent_log.length > 0) {
        html += '<div class="diagnostics-section">';
        html += `<div class="diagnostics-section-title">Recent log (last ${d.recent_log.length} lines)</div>`;
        html += `<pre class="diagnostics-pre">${e(d.recent_log.join('\n'))}</pre>`;
        html += '</div>';
    }

    return html;
}

// Diagnostics modal
async function openDiagnosticsModal() {
    const modal = document.getElementById('diagnostics-modal');
    const content = document.getElementById('diagnostics-content');
    if (!modal || !content) return;

    modal.classList.remove('hidden');
    await refreshDiagnosticsModalContent({ showLoading: true });
    startHelperUiRefreshLoop();

    // Close button
    const closeBtn = document.getElementById('close-diagnostics-btn');
    if (closeBtn) {
        closeBtn.onclick = () => {
            modal.classList.add('hidden');
            if (!isModalVisible('settings-modal')) stopHelperUiRefreshLoop();
        };
    }

    // Close on backdrop click (outside the modal content)
    modal.onclick = (e) => {
        if (e.target === modal) {
            modal.classList.add('hidden');
            if (!isModalVisible('settings-modal')) stopHelperUiRefreshLoop();
        }
    };
}

// Setup diagnostics button
function setupDiagnosticsButton() {
    const btn = document.getElementById('diagnostics-btn');
    if (btn) {
        btn.addEventListener('click', openDiagnosticsModal);
    }
}

// Check if there are any active blocks or schedules
function hasAnyActiveBlocks() {
    return hasAnyEnforcedBlocks();
}

// No-op kept for any legacy callers — the "still not working" button
// it used to control was removed in 2.0 along with the helper-uninstall
// + manual-hosts-reset escape hatches. Override All visibility is now
// purely CSS / always-on.
function updateOverrideAllButtonVisibility() {}

// Show challenge for removing helper when blocks are active


// Variable to track override-all challenge text
let overrideAllChallengeText = '';

// Setup the configurable browser-extension grace period.
// Backend reads `settings.extensionGraceSeconds` from the data file
// on every grace-start (no app restart needed). Backend rejects
// increases when at least one block is currently active.
function setupGraceSetting() {
    const input = document.getElementById('grace-seconds-input');
    const errorEl = document.getElementById('grace-error');
    const lockedHint = document.getElementById('grace-locked-hint');
    if (!input) return;

    const showError = (msg) => {
        if (!errorEl) return;
        errorEl.textContent = msg;
        errorEl.classList.toggle('hidden', !msg);
    };

    // Load current value and reflect locked state.
    const refresh = async () => {
        try {
            const secs = await invoke('get_extension_grace_seconds');
            input.value = secs;
            // Locked-hint UX: probe by attempting to set to current+1
            // and checking the error. Cheaper alternative would be a
            // dedicated `is_locked` command, but this avoids a new
            // command for an edge-case UI nicety.
            // Skip the probe — just reset on a real failure.
            if (lockedHint) lockedHint.classList.add('hidden');
        } catch (e) {
            console.warn('[grace] read failed:', e);
        }
    };
    refresh();

    let lastGood = parseInt(input.value, 10) || 60;
    input.addEventListener('change', async () => {
        const raw = parseInt(input.value, 10);
        if (!Number.isFinite(raw)) {
            input.value = lastGood;
            return;
        }
        const clamped = Math.max(5, Math.min(300, raw));
        input.value = clamped;
        try {
            const applied = await invoke('set_extension_grace_seconds', { seconds: clamped });
            input.value = applied;
            lastGood = applied;
            showError('');
            if (lockedHint) lockedHint.classList.add('hidden');
        } catch (e) {
            // Backend rejects increases during active blocks. Revert
            // to the prior good value and surface the message.
            const msg = typeof e === 'string' ? e : (e && e.message) || 'Could not update grace period.';
            showError(msg);
            input.value = lastGood;
            if (lockedHint && /active|focus session/i.test(msg)) {
                lockedHint.classList.remove('hidden');
            }
        }
    });
}

// Setup Override All functionality in settings
function setupOverrideAll() {
    const advancedToggle = document.getElementById('advanced-options-toggle');
    const advancedContent = document.getElementById('advanced-options-content');
    const overrideAllBtn = document.getElementById('override-all-btn');
    const overrideAllModal = document.getElementById('override-all-modal');
    const cancelOverrideAllBtn = document.getElementById('cancel-override-all-btn');
    const confirmOverrideAllBtn = document.getElementById('confirm-override-all-btn');
    const overrideAllChallengeInput = document.getElementById('override-all-challenge-input');
    const overrideAllProgressBar = document.getElementById('override-all-progress-bar');

    // Toggle advanced options
    if (advancedToggle && advancedContent) {
        advancedToggle.addEventListener('click', () => {
            advancedToggle.classList.toggle('expanded');
            advancedContent.classList.toggle('hidden');
        });
    }

    // Open override all modal
    if (overrideAllBtn && overrideAllModal) {
        overrideAllBtn.addEventListener('click', () => {
            // Close settings modal first
            document.getElementById('settings-modal').classList.add('hidden');

            const challengeTextEl = document.getElementById('override-all-challenge-text');
            const instructionEl = document.getElementById('override-all-instruction');

            if (!hasAnyBlockingStateToClear()) {
                // No blocks active — show dialog but skip the typing challenge
                overrideAllChallengeText = '';
                if (challengeTextEl) challengeTextEl.style.display = 'none';
                if (overrideAllChallengeInput) overrideAllChallengeInput.style.display = 'none';
                if (instructionEl) instructionEl.style.display = 'none';
                const progressEl = overrideAllModal.querySelector('.challenge-progress');
                if (progressEl) progressEl.style.display = 'none';
                overrideAllModal.classList.remove('hidden');
                return;
            }

            // Restore challenge elements visibility
            if (challengeTextEl) challengeTextEl.style.display = '';
            if (overrideAllChallengeInput) overrideAllChallengeInput.style.display = '';
            if (instructionEl) instructionEl.style.display = '';
            const progressEl = overrideAllModal.querySelector('.challenge-progress');
            if (progressEl) progressEl.style.display = '';

            // Find the hardest challenge among active blocks and schedules
            const hardestDifficulty = findHardestChallenge();

            // Generate challenge text based on hardest difficulty
            if (hardestDifficulty.type === 'custom' && hardestDifficulty.customText) {
                overrideAllChallengeText = hardestDifficulty.customText;
            } else if (hardestDifficulty.type === 'gibberish') {
                overrideAllChallengeText = generateGibberish(hardestDifficulty.count);
            } else {
                overrideAllChallengeText = generateRandomWords(hardestDifficulty.count);
            }

            // Sanitize: remove linebreaks and collapse multiple spaces
            overrideAllChallengeText = overrideAllChallengeText.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

            // Display challenge
            document.getElementById('override-all-challenge-text').textContent = overrideAllChallengeText;
            overrideAllChallengeInput.value = '';
            overrideAllProgressBar.style.width = '0%';

            overrideAllModal.classList.remove('hidden');
        });
    }

    // Cancel override all
    if (cancelOverrideAllBtn && overrideAllModal) {
        cancelOverrideAllBtn.addEventListener('click', () => {
            overrideAllModal.classList.add('hidden');
            overrideAllChallengeText = '';
            // Re-open settings modal so user goes back to settings, not main screen
            document.getElementById('settings-modal').classList.remove('hidden');
        });
    }

    // Click outside to close
    if (overrideAllModal) {
        overrideAllModal.addEventListener('click', (e) => {
            if (e.target === overrideAllModal) {
                overrideAllModal.classList.add('hidden');
                overrideAllChallengeText = '';
                // Re-open settings modal so user goes back to settings, not main screen
                document.getElementById('settings-modal').classList.remove('hidden');
            }
        });
    }

    // Prevent paste
    if (overrideAllChallengeInput) {
        overrideAllChallengeInput.addEventListener('paste', (e) => {
            e.preventDefault();
        });

        // Update progress as user types
        overrideAllChallengeInput.addEventListener('input', () => {
            const typed = overrideAllChallengeInput.value;
            const target = overrideAllChallengeText;

            let correctChars = 0;
            for (let i = 0; i < typed.length && i < target.length; i++) {
                if (typed[i] === target[i]) {
                    correctChars++;
                } else {
                    break;
                }
            }

            const progress = (correctChars / target.length) * 100;
            overrideAllProgressBar.style.width = `${progress}%`;
        });

        // Enter key submits
        overrideAllChallengeInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                confirmOverrideAllBtn.click();
            }
        });
    }

    // Confirm override all
    if (confirmOverrideAllBtn) {
        confirmOverrideAllBtn.addEventListener('click', async () => {
            const typed = overrideAllChallengeInput.value;
            const target = overrideAllChallengeText;

            if (typed === target) {
                // Success! Clear everything
                await performOverrideAll();
                overrideAllModal.classList.add('hidden');
                overrideAllChallengeText = '';
            } else {
                // Wrong - wiggle modal
                const modalContent = overrideAllModal.querySelector('.modal-content');
                modalContent.classList.remove('wiggle');
                void modalContent.offsetWidth; // Trigger reflow
                modalContent.classList.add('wiggle');
            }
        });
    }

}


// Find the hardest challenge among all block/schedule state that could still resume later.
function findHardestChallenge() {
    const now = Date.now();
    const nowDate = new Date(now);
    let hardestDifficulty = null;

    // Check one-off blocks that still have remaining time.
    for (const block of appData.activeBlocks) {
        if (isOneOffBlockStillActive(block, now)) {
            const blocklist = appData.blocklists.find(bl => bl.id === block.blocklistId);
            if (blocklist?.overrideDifficulty) {
                hardestDifficulty = hardestDifficulty
                    ? compareDifficulties(hardestDifficulty, blocklist.overrideDifficulty)
                    : blocklist.overrideDifficulty;
            }
        }
    }

    // Check schedules that can still become active later.
    for (const schedule of appData.schedules || []) {
        if (!schedule.segments) continue;
        if (!scheduleCanStillBecomeActive(schedule, nowDate)) continue;

        const blocklist = appData.blocklists.find(bl => bl.id === schedule.blocklistId);
        if (blocklist?.overrideDifficulty) {
            hardestDifficulty = hardestDifficulty
                ? compareDifficulties(hardestDifficulty, blocklist.overrideDifficulty)
                : blocklist.overrideDifficulty;
        }
    }

    if (!hardestDifficulty) return { type: 'random-words', count: 50 };

    // Resolve effective count for maxDifficulty (handles single-block case
    // where compareDifficulties was never called)
    if (hardestDifficulty.maxDifficulty === true && hardestDifficulty.count === undefined) {
        const MAX_CHARS_RANDOM_WORDS = 7500;
        const MAX_CHARS_GIBBERISH = 5000;
        const effectiveCount = hardestDifficulty.type === 'gibberish' ? MAX_CHARS_GIBBERISH : MAX_CHARS_RANDOM_WORDS;
        return { ...hardestDifficulty, count: effectiveCount };
    }
    return hardestDifficulty;
}

// Compare two difficulties and return the harder one
function compareDifficulties(a, b) {
    if (!a) return b;
    if (!b) return a;

    const MAX_CHARS_RANDOM_WORDS = 7500;  // 250 * 30, match getMaxOverrideCharsForType
    const MAX_CHARS_GIBBERISH = 5000;     // match getMaxOverrideCharsForType

    const getEffectiveCount = (difficulty) => {
        if (difficulty.type === 'custom' && typeof difficulty.customText === 'string') {
            return difficulty.customText.length;
        }
        if (difficulty.maxDifficulty === true) {
            if (difficulty.type === 'gibberish') return MAX_CHARS_GIBBERISH;
            if (difficulty.type === 'random-words') return MAX_CHARS_RANDOM_WORDS;
        }
        const parsed = Number(difficulty.count);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
    };

    const getTypeRank = (difficulty) => {
        if (difficulty.type === 'custom') return 3;
        if (difficulty.type === 'gibberish') return 2;
        if (difficulty.type === 'random-words') return 1;
        return 0;
    };

    const aCount = getEffectiveCount(a);
    const bCount = getEffectiveCount(b);

    let winner;
    if (bCount > aCount) winner = b;
    else if (aCount > bCount) winner = a;
    else {
        // Same character count: custom > gibberish > random-words
        const aRank = getTypeRank(a);
        const bRank = getTypeRank(b);
        if (bRank > aRank) winner = b;
        else if (aRank > bRank) winner = a;
        else winner = a; // Equal, return a
    }

    // Return with effective count resolved (so maxDifficulty is reflected in .count)
    const winnerCount = getEffectiveCount(winner);
    if (winner.count !== winnerCount) {
        return { ...winner, count: winnerCount };
    }
    return winner;
}

// Perform the actual override-all operation
async function performOverrideAll() {
    try {
        // Clear all active blocks
        appData.activeBlocks = [];

        // Clear all schedules
        appData.schedules = [];

        // Save the data
        await saveData();

        // Full cleanup on the helper side
        if (isIOS) {
            await tauriAPI.screentimeClearBlock();
        } else {
            const status = await refreshDesktopHelperStatus();
            if (status.helperReady) {
                // Atomically set everything to empty — helper will know nothing should be blocked
                try { await tauriAPI.setBlocksViaHelper([]); } catch (e) { console.warn('Failed to clear blocks:', e); }
                try { await tauriAPI.setSchedulesViaHelper([]); } catch (e) { console.warn('Failed to clear schedules:', e); }
                try { await tauriAPI.setBlockedAppsViaHelper([]); } catch (e) { console.warn('Failed to clear apps:', e); }
            }
            // Always clean the hosts file as a safety net, even if the helper is stopped or stale.
            try { await tauriAPI.cleanHostsFile(); } catch (e) { console.warn('Failed to clean hosts file:', e); }
        }

        // Update blocked apps (will stop watcher if no apps to block)
        await updateBlockedApps();

        // Re-render the UI
        render();

        // Reset the blocklist selection UI
        const blocklistSelect = document.getElementById('blocklist-select');
        if (blocklistSelect) {
            handleBlocklistSelect({ target: blocklistSelect });
        }

        console.log('Override-all completed — all blocks, schedules, apps, and hosts entries cleared');
    } catch (err) {
        console.error('Error during override all:', err);
    }
}

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

// Expose additional internals for integration tests
Object.assign(window.__REDDBLOCK_INTERNALS__, {
    saveData,
    updateHostsFile,
    tauriAPI,
    render,
    isProtectedApp,
    PROTECTED_APP_NAMES,
    isProtectedDomain,
    PROTECTED_DOMAINS,
    duplicateBlocklist,
    getNextCopyName,
    getMaxOverrideCharsForType
});

console.log('💡 To run blocking tests, type: runBlockingTests() in the console');
