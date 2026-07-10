// Persistence: load/save app data via the Rust backend, plus the hosts-file
// website sync. Extracted verbatim from app.js.
import { state } from './state.js';
import { tauriAPI } from './tauri-api.js';
import { normalizeBlocklist, isProtectedDomain, collectActiveIOSManualBlockPayload } from './blocklist-utils.js';
import { isSchedulePausedNow, syncActiveBlocksToHelper, syncSchedulesToHelper, buildPersistedAppData } from './schedule-engine.js';
import { generateId } from './app.js';
import { updateBlockedApps } from './blocking-platform.js';
import { normalizeLoadedEulaState } from './onboarding.js';
import { migrateBlocklistStartOverlaysToGlobal, migrateLegacyScheduleStartOverlays } from './schedule-overlay.js';
import { isScheduleSegmentActiveNow } from './schedule-editor.js';


export async function loadData() {
    state.appData = await tauriAPI.loadData();
    let shouldSave = false;
    if (!state.appData || !state.appData.blocklists) {
        state.appData = {
            blocklists: [],
            activeBlocks: [],
            schedules: [],
            settings: {}
        };
    }
    // Ensure schedules array exists for older data
    if (!state.appData.schedules) {
        state.appData.schedules = [];
    }
    // A pre-fix bug could insert a duplicate schedule for the same blocklist when
    // saving edits (both the start-flow and edit-flow proceed handlers fired). If
    // that left two entries, keep the one with the most segments and drop the rest.
    if (state.appData.schedules.length > 1) {
        const byBlocklist = new Map();
        for (const s of state.appData.schedules) {
            const existing = byBlocklist.get(s.blocklistId);
            const segCount = Array.isArray(s.segments) ? s.segments.length : 0;
            const existingCount = existing && Array.isArray(existing.segments) ? existing.segments.length : -1;
            if (!existing || segCount > existingCount) {
                byBlocklist.set(s.blocklistId, s);
            }
        }
        if (byBlocklist.size < state.appData.schedules.length) {
            state.appData.schedules = [...byBlocklist.values()];
            shouldSave = true;
        }
    }
    // Ensure settings exists
    if (!state.appData.settings) {
        state.appData.settings = {};
    }
    if (normalizeLoadedEulaState()) {
        shouldSave = true;
    }
    state.appData.blocklists = (state.appData.blocklists || []).map(normalizeBlocklist);
    if (migrateBlocklistStartOverlaysToGlobal()) {
        shouldSave = true;
    }
    if (migrateLegacyScheduleStartOverlays()) {
        shouldSave = true;
    }


    // Create default blocklist on first launch (no blocklists yet).
    // On Android, defer until the native-schedule migration has had a chance
    // to run (migrateAndroidNativeSchedules), otherwise users upgrading from
    // the legacy app get a spurious "Distractions" default alongside their
    // imported spaces — the migration (which runs later, post-onboarding)
    // creates the default itself if there's no legacy data to import.
    const androidMigrationPending = state.isAndroid && !state.appData.settings?.androidMigrationDone;
    if (state.appData.blocklists.length === 0 && !androidMigrationPending) {
        createDefaultBlocklist();
        shouldSave = true;
    }

    if (shouldSave) {
        await saveData();
    }
}

// The first-launch default "Distractions" space. Shared by loadData and the
// Android native-schedule migration (which owns default creation on Android).
export function createDefaultBlocklist() {
    state.appData.blocklists.push({
        id: generateId(),
        name: 'Distractions',
        mode: 'blocklist',
        // First colour in the palette (matches the openBlocklistModal default).
        color: '#B8D1DE',
        emoji: '📱',
        websites: ['instagram.com', 'youtube.com', 'reddit.com'],
        apps: [],
        iosScreenTimeSelection: null,
        overrideDifficulty: {
            type: 'random-words',
            count: (state.isIOS) ? 25 : 50
        }
    });
}

// Save data to main process
export async function saveData() {
    await tauriAPI.saveData(buildPersistedAppData());
}


export async function updateHostsFile(silent = false) {
    const allDomains = new Set();
    const now = Date.now();

    // Only block domains for blocks that are currently active and not paused
    state.appData.activeBlocks
        .filter(block => block.startTime <= now && block.endTime > now && !block.isPaused)
        .forEach(block => {
            const blocklist = state.appData.blocklists.find(bl => bl.id === block.blocklistId);
            if (blocklist && blocklist.websites) {
                blocklist.websites.forEach(domain => allDomains.add(domain));
            }
        });

    // Also check scheduled blocks - add domains if a schedule segment is currently active
    const nowDate = new Date();

    if (state.appData.schedules) {
        state.appData.schedules.forEach(schedule => {
            if (!schedule.segments) return;

            // Skip paused schedules
            if (isSchedulePausedNow(schedule)) return;

            if (isScheduleSegmentActiveNow(schedule, nowDate)) {
                const blocklist = state.appData.blocklists.find(bl => bl.id === schedule.blocklistId);
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
    const lastDomainsArray = Array.from(state.lastBlockedDomains).sort();
    const domainsChanged = JSON.stringify(domainsArray) !== JSON.stringify(lastDomainsArray);

    // iOS: Use Screen Time API instead of helper daemon / hosts file
    // Only clear when there are no active blocks; when there are active blocks, always apply
    // (even when domainsArray is empty — app-only blocklists must still shield apps).
    if (state.isIOS) {
        try {
            const manualPayload = collectActiveIOSManualBlockPayload(now);
            const hasActiveBlocks = state.appData.activeBlocks.some(
                block => block.startTime <= now && block.endTime > now && !block.isPaused
            );
            const hasActiveScheduleSegments = (state.appData.schedules || []).some(schedule => {
                if (!schedule || !schedule.segments || schedule.segments.length === 0) return false;
                if (isSchedulePausedNow(schedule, now)) return false;
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
                    state.lastBlockedDomains = new Set();
                    return { success: true };
                }
                console.log('[updateHostsFile] iOS: no active blocks, clearing Screen Time');
                await tauriAPI.screentimeClearBlock();
                state.lastBlockedDomains = new Set();
                return { success: true };
            }
            if (manualPayload.domains.length === 0) {
                console.log('[updateHostsFile] iOS: active blocks with no domains (app-only), applying app shield');
            } else {
                console.log('[updateHostsFile] iOS: starting Screen Time block for', manualPayload.domains);
            }
            await tauriAPI.screentimeStartBlock(manualPayload);
            state.lastBlockedDomains = new Set(manualPayload.domains);
            return { success: true };
        } catch (err) {
            console.error('[updateHostsFile] iOS Screen Time error:', err);
            return { success: false, error: err.toString() };
        }
    }

    // Android: blocking is entirely owned by Kotlin (BlockerService +
    // Schedules' active sessions), driven by syncSchedulesToHelper /
    // androidStartManualBlock / androidStopManualBlock. There's no
    // hosts-file or helper-daemon concept here — those commands don't
    // exist on Android at all (see all_commands() in lib.rs).
    if (state.isAndroid) {
        return { success: true };
    }

    if (!domainsChanged) {
        return { success: true, unchanged: true };
    }

    // Desktop v2+: websites are blocked via the extension/native host (Windows)
    // or Automation (macOS) — not hosts-file edits. save_data already ran;
    // the native host re-pushes when redd-block-data.json changes.
    if (!state.isIOS) {
        state.lastBlockedDomains = allDomains;
        await updateBlockedApps();
        return { success: true };
    }

    // Try to use helper daemon first (legacy path; iOS-only below)
    try {
        console.log('[updateHostsFile] Checking helper status...');
        const status = await tauriAPI.checkHelperStatus();
        console.log('[updateHostsFile] Helper status:', status);

        if (status.running && status.version_ok) {
            console.log('[updateHostsFile] Helper running with correct version, using helper to update blocks');
            state.helperAvailable = true;
            await syncActiveBlocksToHelper();
            await syncSchedulesToHelper();
            state.lastBlockedDomains = allDomains;
            await updateBlockedApps();
            return { success: true };
        } else {
            console.log('[updateHostsFile] Helper NOT running, falling back');
        }
    } catch (e) {
        console.warn('Helper not available, falling back to direct method:', e);
    }

    // For silent cleanup without the helper, defer instead of triggering an elevation prompt.
    if (silent && allDomains.size < state.lastBlockedDomains.size) {
        return { success: true, deferred: true };
    }

    // Fallback to direct hosts file modification (macOS)
    console.log('[updateHostsFile] Calling fallback block-websites');
    const result = await tauriAPI.blockWebsites(domainsArray);

    if (result && result.success) {
        state.lastBlockedDomains = allDomains;
        // Update blocked apps based on active blocks and schedules
        await updateBlockedApps();
    }

    return result || { success: true };
}
