// Tauri API compatibility layer wrapping @tauri-apps/* plugin invokes.
// Extracted verbatim from app.js — leaf module, imports only Tauri APIs.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

export const tauriAPI = {
    // Core data operations
    loadData: () => invoke('load_data'),
    saveData: (data) => invoke('save_data', { data }),
    getAppVersion: () => invoke('get_app_version'),
    isMicrosoftStorePackage: () => invoke('is_microsoft_store_package'),
    downloadAndRunUpdate: (version) => invoke('download_and_run_update', { version }),

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
    // Routes through the Rust `hide_main_window` command so the macOS
    // activation policy can flip back to Accessory at the same time
    // (Dock icon + global menu bar disappear when the window closes).
    closeWindow: () => invoke('hide_main_window').catch(() => getCurrentWindow().hide()),

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
    getSystemDiagnostics: () => invoke('get_system_diagnostics'),
    setBlocksViaHelper: (blocks) => invoke('set_blocks_via_helper', { blocks }),

    // App operations
    openAppPicker: () => invoke('open_app_picker'),
    listInstalledApps: () => invoke('list_installed_apps'),
    blockWebsites: (domains) => invoke('block_websites', { domains }),

    // App blocking via helper daemon (persistent, survives app close)
    setBlockedAppsViaHelper: (
        apps,
        newlyAdded = [],
        { allowedApps = [], allowlistActive = false, allowlistNewlyStarted = false } = {},
    ) => invoke('set_blocked_apps_via_helper', {
        apps,
        newlyAdded,
        allowedApps,
        allowlistActive,
        allowlistNewlyStarted,
    }),

    // Schedule management via helper daemon (persistent, handles transitions autonomously)
    setSchedulesViaHelper: (schedules) => invoke('set_schedules_via_helper', { schedules }),

    // Screen Time API (iOS only - provided by tauri-plugin-screentime)
    screentimeRequestAuth: () => invoke('plugin:screentime|request_authorization'),
    screentimeCheckAuth: () => invoke('plugin:screentime|check_authorization'),
    screentimeBlockWebsites: (domains) => invoke('plugin:screentime|block_websites', { domains }),
    screentimeUnblockWebsites: () => invoke('plugin:screentime|unblock_websites'),
    screentimeStartBlock: (payload) =>
        invoke('plugin:screentime|screentime_start_block', { payload }),
    screentimeClearBlock: () => invoke('plugin:screentime|screentime_clear_block'),
    showActivityPicker: (payload = {}) => invoke('plugin:screentime|show_activity_picker', payload),
    setSchedulesPlugin: (schedules) => invoke('plugin:screentime|set_schedules', { schedules }),
    screentimeRegisterOneOffActivity: (activityName, startTimestampMs) =>
        invoke('plugin:screentime|register_one_off_activity', { activityName, startTimestampMs }),
    screentimeSetResumePayload: (payload) =>
        invoke('plugin:screentime|set_resume_payload', payload),
    screentimeSetBlockEndState: (payload) =>
        invoke('plugin:screentime|set_block_end_state', payload),

    // Android blocking API (Android only - provided by tauri-plugin-android-blocker).
    // All blocking logic runs in Kotlin (AccessibilityService + WorkManager);
    // these just marshal to it. See tauri-plugin-android-blocker/src/commands.rs.
    androidCheckPermissions: () => invoke('plugin:android-blocker|check_blocker_permissions'),
    androidOpenAccessibilitySettings: () => invoke('plugin:android-blocker|open_accessibility_settings'),
    androidSetSchedules: (schedules) => invoke('plugin:android-blocker|set_schedules', { schedules }),
    androidStartManualBlock: (id, endTimestampMs) =>
        invoke('plugin:android-blocker|start_manual_block', { id, endTimestampMs }),
    androidStopManualBlock: (id) => invoke('plugin:android-blocker|stop_manual_block', { id }),
    androidReadNativeSchedules: () => invoke('plugin:android-blocker|read_native_schedules'),
    androidGetScheduleStates: () => invoke('plugin:android-blocker|get_schedule_states'),
    // Android keeps the most recently scanned launcher labels in
    // device-protected preferences. Reading that cache is cheap enough for
    // post-startup display-name hydration; refreshing it is reserved for the
    // app picker, where an up-to-date list is actually needed.
    androidGetCachedInstalledApps: () => invoke('plugin:android-blocker|get_cached_installed_apps'),
    androidRefreshInstalledApps: () => invoke('plugin:android-blocker|get_installed_apps'),
    androidSetEventHandler: (handler) => invoke('plugin:android-blocker|set_event_handler', { handler }),

    // Event listening
    onBlocksUpdated: (callback) => listen('blocks-updated', callback),
    onMenuZoomIn: (callback) => listen('menu-zoom-in', callback),
    onMenuZoomOut: (callback) => listen('menu-zoom-out', callback),
    onMenuZoomReset: (callback) => listen('menu-zoom-reset', callback),
    onMenuHelpReportIssue: (callback) => listen('menu-help-report-issue', callback),
    onMenuHelpContactUs: (callback) => listen('menu-help-contact-us', callback),
    onMenuHelpWhoWeAre: (callback) => listen('menu-help-who-we-are', callback),

    // Enforcer events (desktop only)
    onEnforcerGraceUpdate: (callback) => listen('enforcer://grace-update', callback),
    onEnforcerGraceResolved: (callback) => listen('enforcer://grace-resolved', callback),
    onEnforcerBrowserClosed: (callback) => listen('enforcer://browser-closed', callback),

    // Website automation (macOS only): JOMO-style Safari/Chromium
    // blocking via Apple Events. The watcher fires permission-needed when
    // a browser denies the Automation grant; resolved when it's granted.
    onWebAutomationPermissionNeeded: (callback) => listen('web-automation://permission-needed', callback),
    onWebAutomationPermissionResolved: (callback) => listen('web-automation://permission-resolved', callback),
    webAutomationStart: () => invoke('web_automation_start'),
    webAutomationPermissionStatus: (opts) => invoke('web_automation_permission_status', {
        launchProbe: opts?.launchProbe ?? false,
        launchProbeBrowser: opts?.launchProbeBrowser ?? null,
        launchProbeBrowsers: opts?.launchProbeBrowsers ?? null,
    }),
    getBlockingMethods: () => invoke('get_blocking_methods'),
    setBlockingMethod: (browser, method) => invoke('set_blocking_method', { browser, method }),
    requestAutomationPermission: (browser) => invoke('request_automation_permission', { browser }),
    openAutomationSettings: () => invoke('open_automation_settings'),

    // App blocking: force-quit warning overlay (desktop)
    onAppBlockingWarningShow: (callback) => listen('app-blocking://warning-show', callback),
    onAppBlockingWarningHide: (callback) => listen('app-blocking://warning-hide', callback),
    onUpdateDownloadProgress: (callback) => listen('update-download-progress', callback),
    appBlockingBringForwardThenQuitAgain: (pids) =>
        invoke('app_blocking_bring_forward_then_quit_again', { pids }),
    /// User clicked "Let's go!" on the app-blocking warning — the
    /// watcher transitions every awaiting PID to the 30-second
    /// PreQuit phase before sending the polite Cmd-Q.
    letsGoAcknowledge: () => invoke('lets_go_acknowledge'),
    /// Dismiss the warning overlay without starting the PreQuit countdown
    /// (schedule-block snooze).
    snoozeBlockingWarning: () => invoke('snooze_blocking_warning'),
    /// Restore compact-window warning chrome after a snooze expires.
    reshowBlockingWarning: (pids) => invoke('reshow_blocking_warning', { pids }),
    reconcileBlockingWarningShell: () => invoke('reconcile_blocking_warning_shell'),

    saveOverlayImageAsset: (blocklistId, assetId, sourcePath) =>
        invoke('save_overlay_image_asset', { blocklistId, assetId, sourcePath }),
    saveOverlayImageAssetBytes: (blocklistId, assetId, extension, data) =>
        invoke('save_overlay_image_asset_bytes', { blocklistId, assetId, extension, data: [...data] }),
    saveOverlayVoiceAsset: (blocklistId, assetId, extension, data) =>
        invoke('save_overlay_voice_asset', { blocklistId, assetId, extension, data: [...data] }),
    resolveOverlayAssetPath: (relativePath) =>
        invoke('resolve_overlay_asset_path', { relativePath }),
    deleteOverlayAsset: (relativePath) =>
        invoke('delete_overlay_asset', { relativePath }),
    readOverlaySourceBytes: (sourcePath) =>
        invoke('read_overlay_source_bytes', { sourcePath }),

    // macOS-only in-app uninstall. Disables launch-at-login, scrubs
    // browser native-messaging manifests, and schedules a delayed
    // self-delete of /Applications/ReDD Blocker.app. Caller is responsible
    // for confirming with the user and refusing to invoke while blocks
    // are running. See src-tauri/src/commands/uninstall.rs.
    uninstallSelfMacos: (deleteUserData = false) =>
        invoke('uninstall_self_macos', { deleteUserData }),
};

export async function openUrl(url, openWith) {
    return invoke('plugin:opener|open_url', {
        url,
        with: openWith,
    });
}
