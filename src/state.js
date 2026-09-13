// Shared mutable application state.
//
// ES module import bindings are read-only, so every variable that is
// REASSIGNED from more than one module lives here as a property of the
// exported `state` object (`state.foo = x` works from any importer).
// Module-private state stays as plain `let` inside its own module.
// Leaf module: must not import from any other app module.
export const state = {
    appData: {
        blocklists: [],
        activeBlocks: [],
        schedules: [],
        startOverlays: [],
        settings: {}
    },
    selectedBlocklistId: null,
    /** Session flag set when the user actively deselects (click-outside / ESC).
     *  Read by the sole-blocklist auto-selector so it stops fighting an
     *  intentional deselect — cleared again when the user picks anything via
     *  the dropdown or creates a new blocklist. */
    userExplicitlyDeselected: false,
    /** True while the hidden blocklist <select> is being rebuilt programmatically. */
    suppressBlocklistSelectChange: false,
    helperAvailable: false, // Track if the privileged helper daemon is running
    isIOS: false, // Track if running on iOS
    isAndroid: false, // Track if running on Android
    // True on macOS desktop (i.e. Mac platform AND not the iOS Tauri
    // runtime). Set in `detectPlatform`. Used to gate macOS-only Tauri
    // commands and onboarding copy.
    isMacOSDesktop: false,
    /** MSIX / Microsoft Store install — updates come from the Store, not GitHub. */
    isMicrosoftStorePackage: null,
    screentimeAuthorized: false, // Track if Screen Time is authorized (iOS)
    // null = not checked yet. Avoid showing the Android Accessibility
    // onboarding screen during startup before the native permission check
    // has had a chance to answer.
    androidPermissionsGranted: null,
    // The returning Android UI is rendered optimistically from persisted data
    // before the asynchronous Accessibility IPC completes. If that check says
    // access was revoked, updateOnboardingVisibility immediately replaces it
    // with the native-permissions gate.
    androidFirstFrameCommitted: false,
    /** When character count >= OVERRIDE_PREVIEW_TRUNCATE_AT, preview text is frozen (no more regeneration) for random words and gibberish. */
    overridePreviewFrozenByType: { 'random-words': null, 'gibberish': null },
    lastOverridePreviewType: null,
    installedAppsCache: null, // Cache the installed-apps list so we don't re-scan every open
    /** Focus-space editor: Daily / Weekly / Manual choice shown in the form. */
    editorKind: 'manual',
    /** Serialized form contents at the last populate/save; null = nothing loaded. */
    editorSnapshot: null,
    /** Which accordion section of the editor is open (null = all collapsed). */
    openEditorSection: null,
    scheduleRepeatType: 'forever', // 'forever' (Until: when I stop it) or 'date'
    activeScheduleSegmentCount: 0, // Number of segments locked in the active schedule (new segments can be added)
    /** Draft for allowEditsBetweenBlocks before a schedule is started (opt-in, default off). */
    draftAllowEditsBetweenBlocks: false,
    lastBlockedDomains: new Set(), // Track what's currently blocked to avoid re-prompting
    activatedBlockIds: new Set(), // Track blocks that have already triggered host updates
    pauseScheduleData: null, // Track schedule-specific pause data { blocklistId, segmentEndTime }
    scheduleSegments: null, // Array of time segments with per-segment days (set at startup)
    expandedScheduleSegmentIndex: 0, // Which segment shows the full editor when multiple exist (-1 = all collapsed)
    scheduleRepeatDate: null, // Date object when repeatType is 'date'
    mobileCompactScheduleDayLabelsActive: null,
    appBlockingActiveStartOverlay: null, // Custom start-overlay config for the active schedule warning session
    pendingScheduleStartOverlayId: null,
    scheduleOverlayCustomiseSelection: null,
    editingBlocklistId: null,
    blocklistModalPreviewSnapshot: null,
    blocklistModalUndoStack: [],
    blocklistModalApplyingUndo: false,
    lastBlocklistNameValue: '',
    lastOverrideCountValue: '',
    lastCustomOverrideTextValue: '',
    lastOverrideTypeValue: '',
    lastOverrideCountValueBeforeMaxDifficulty: 50,
    lastOverrideTypeValueBeforeMaxDifficulty: 'random-words',
    overrideBlockId: null,
    overrideBlocklistIdForHelper: null,
    pauseBlockId: null, // Track which block is being paused
    pauseMaxMinutes: null, // Maximum pause duration in minutes (null = unlimited)
    startupInitializationComplete: false, // Track whether post-onboarding startup already ran
    migrationOnboardingActive: false,
    migrationOnboardingDismissed: false,
    firstRunExtensionSetupPending: false,
    migrationPollIntervalId: null,
    migrationShowMeHowExpandedKeys: new Set(),
    migrationSafariDuplicateHelpExpanded: false,
    lastMigrationBrowserState: null,
    lastMigrationBrowserRenderSignature: '',
    lastMigrationHeaderCopyKey: '',
    lastMigrationHowtoCopyKey: '',
    extensionSetupPausedForBackNavigation: false,
    forceShowEulaThisSession: false,
};

// Alias for use inside functions whose local parameter is also named `state`
// (onboarding/migration browser-state objects).
export const appState = state;
