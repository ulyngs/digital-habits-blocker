// Schedule engine: occurrence math, native-helper schedule/block sync,
// desktop helper status cache. Extracted verbatim from app.js.
import { state } from './state.js';
import { tauriAPI } from './tauri-api.js';
import { message } from '@tauri-apps/plugin-dialog';
import { tSettings } from './i18n.js';
import { getBlocklistIOSPayload, isAllowlistBlocklist } from './blocklist-utils.js';
import { formatDateForDisplay, isScheduleSegmentActiveNow } from './schedule-editor.js';
import { formatTime } from './app.js';
import { getDefaultPauseMinutes } from './pause-default.js';

let hasShownIOSScheduleSyncError = false;

export const HELPER_STATUS_CACHE_TTL_MS = 3000;
let lastDesktopHelperStatus = null;
let lastDesktopHelperStatusAt = 0;

export function isNonRepeatingSchedule(schedule) {
    return !!schedule && schedule.repeatType !== 'forever' && !(schedule.repeatType === 'date' && schedule.repeatDate);
}

export const ANDROID_DAY_NAMES_MON0 = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];

export const ANDROID_DEFAULT_FRICTION_WORD_COUNT = 15;

/** Android cannot enforce allow-mode focus spaces yet. */
export function isAndroidAllowlistUnsupported(blocklist, isAndroid = state.isAndroid) {
    return isAndroid === true && isAllowlistBlocklist(blocklist);
}

/**
 * Friction-gate challenge fields for the Android plugin payload.
 *
 * `custom` difficulties send the literal text; the native gate (UnlockActivity)
 * makes the user type it word by word instead of generating random words.
 * Without this the gate silently fell back to 15 random words for every
 * custom-text blocklist.
 */
export function androidFrictionChallengeFields(difficulty) {
    const customText = difficulty?.type === 'custom' && typeof difficulty.customText === 'string'
        ? difficulty.customText.trim()
        : '';
    if (customText) {
        // Word count is what the gate renders progress against; Kotlin derives
        // it from the text itself, this keeps the payload self-consistent.
        return {
            frictionWordCount: customText.split(/\s+/).length,
            frictionCustomText: customText
        };
    }
    const count = Number.parseInt(difficulty?.count, 10);
    return {
        frictionWordCount: (difficulty?.type !== 'custom' && Number.isFinite(count) && count > 0)
            ? count
            : ANDROID_DEFAULT_FRICTION_WORD_COUNT,
        frictionCustomText: null
    };
}

export function androidDayNamesFromMon0(days) {
    if (!Array.isArray(days)) return [];
    return days
        .filter(day => Number.isInteger(day) && day >= 0 && day <= 6)
        .map(day => ANDROID_DAY_NAMES_MON0[day]);
}

// Resolve concrete one-shot occurrences for non-repeating schedules.
export function resolveOneShotSegmentOccurrences(schedule, segment, segmentIndex = 0) {
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

export function resolveOneShotOccurrences(schedule) {
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

function buildResolvedOneShotSegment(occurrence) {
    return {
        startHour: occurrence.start.getHours(),
        startMinute: occurrence.start.getMinutes(),
        endHour: occurrence.end.getHours(),
        endMinute: occurrence.end.getMinutes(),
        days: [],
        activeFromTimestampMs: occurrence.start.getTime(),
        activeUntilTimestampMs: occurrence.end.getTime()
    };
}

function buildResolvedOneShotSegments(schedule) {
    return resolveOneShotOccurrences(schedule).map(buildResolvedOneShotSegment);
}

function buildPersistedSchedule(schedule) {
    if (!schedule || !Array.isArray(schedule.segments)) return schedule;

    const { resolvedSegments: _oldResolvedSegments, ...baseSchedule } = schedule;
    if (!isNonRepeatingSchedule(schedule)) {
        return baseSchedule;
    }

    return {
        ...baseSchedule,
        resolvedSegments: buildResolvedOneShotSegments(schedule)
    };
}

export function buildPersistedAppData() {
    return {
        ...state.appData,
        schedules: Array.isArray(state.appData.schedules)
            ? state.appData.schedules.map(buildPersistedSchedule)
            : []
    };
}

export function getIOSScheduleEntryWindow(schedule, seg) {
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

export function getSingleOccurrenceSegmentDates(schedule, segment) {
    const [firstOccurrence] = resolveOneShotSegmentOccurrences(schedule, segment);
    if (!firstOccurrence) return null;

    return {
        start: new Date(firstOccurrence.start),
        end: new Date(firstOccurrence.end)
    };
}

/**
 * Flatten schedules and running one-off blocks into the Android plugin payload.
 *
 * Extracted from syncSchedulesToHelper so the allow-mode skip below can be
 * tested — the sync itself is async and talks to Tauri, this is just data.
 *
 * IMPORTANT: allow-mode focus spaces are deliberately omitted. The Kotlin side
 * has no notion of mode at any layer (no `mode` in ScheduleEntry, Schedule.kt,
 * or the matchers in Schedules.kt), so `blockedApps` is always treated as a
 * denylist. Sending an allow-mode space would therefore block precisely the
 * apps it is meant to permit. Omitting it means such a space enforces nothing
 * on Android, which is inert rather than actively wrong. The start flows reject
 * new activations with a user-visible message; this omission remains a safety
 * net for legacy data that was already persisted before the guard existed.
 *
 * Real allow-mode enforcement is a separate, much larger change: with
 * everything-but-the-list blocked, the launcher, Settings and the dialer would
 * all be blocked by default, and cancelling the friction gate sends the user
 * home — straight back into a blocked launcher, with no route to Settings to
 * turn the service off. The app picker cannot even list those packages
 * (getInstalledApps only enumerates CATEGORY_LAUNCHER resolvers), so a user
 * could not allowlist their way out. It needs a Kotlin-side always-allowed set
 * before it is safe to ship.
 */
export function buildAndroidScheduleEntries(now = Date.now()) {
    const flatEntries = [];
    const skippedAllowlistNames = [];
    for (const schedule of state.appData.schedules || []) {
        if (!schedule.segments || schedule.segments.length === 0) continue;
        const blocklist = state.appData.blocklists.find(bl => bl.id === schedule.blocklistId);
        // This builder is Android-specific even when Tier 1 invokes it outside
        // the platform branch, so keep the capability check explicit here.
        if (isAndroidAllowlistUnsupported(blocklist, true)) {
            skippedAllowlistNames.push(blocklist.name || schedule.blocklistId);
            continue;
        }
        const blockedApps = blocklist?.apps || [];
        const blockedWebsites = blocklist?.websites || [];
        const difficulty = blocklist?.overrideDifficulty;
        const { frictionWordCount, frictionCustomText } = androidFrictionChallengeFields(difficulty);
        // Paused entries stay in the payload: Kotlin stores them
        // disabled and arms a WorkManager re-enable at the expiry,
        // so blocking resumes on time even if this app process is
        // dead by then (mirrors iOS's one-off DeviceActivity).
        // No pauseEndTime (legacy-disabled schedules imported by
        // migrateAndroidNativeSchedules) = paused indefinitely.
        const isPaused = !!(schedule.isPaused && (!schedule.pauseEndTime || schedule.pauseEndTime > now));

        // One-shot (non-repeating) schedules become entries with an
        // absolute [activeFrom, activeUntil) window, same as iOS.
        // Kotlin checks the window instead of time-of-day + days;
        // runExpiryOnce removes them from state.appData once past, and the
        // next sync deletes the Kotlin entity.
        if (isNonRepeatingSchedule(schedule)) {
            const occurrences = resolveOneShotOccurrences(schedule);
            occurrences.forEach((occurrence, occurrenceIdx) => {
                if (occurrence.end.getTime() <= now) return;
                flatEntries.push({
                    id: `${schedule.id}-${occurrence.segmentIndex}-${occurrenceIdx}`,
                    name: blocklist?.name || 'Schedule',
                    enabled: true,
                    type: 'DAILY',
                    startHour: occurrence.start.getHours(),
                    startMinute: occurrence.start.getMinutes(),
                    endHour: occurrence.end.getHours(),
                    endMinute: occurrence.end.getMinutes(),
                    days: [],
                    blockedApps,
                    blockedWebsites,
                    frictionWordCount,
                    frictionCustomText,
                    emoji: blocklist?.emoji || null,
                    color: blocklist?.color || null,
                    isPaused,
                    pauseEndTimestampMs: (isPaused && schedule.pauseEndTime) ? schedule.pauseEndTime : null,
                    activeFromTimestampMs: occurrence.start.getTime(),
                    activeUntilTimestampMs: occurrence.end.getTime(),
                });
            });
            continue;
        }

        for (let segIdx = 0; segIdx < schedule.segments.length; segIdx++) {
            const seg = schedule.segments[segIdx];
            flatEntries.push({
                id: `${schedule.id}-${segIdx}`,
                name: blocklist?.name || 'Schedule',
                enabled: true,
                type: (seg.days && seg.days.length > 0) ? 'WEEKLY' : 'DAILY',
                startHour: seg.startHour,
                startMinute: seg.startMinute,
                endHour: seg.endHour,
                endMinute: seg.endMinute,
                days: androidDayNamesFromMon0(seg.days),
                blockedApps,
                blockedWebsites,
                frictionWordCount,
                frictionCustomText,
                emoji: blocklist?.emoji || null,
                color: blocklist?.color || null,
                isPaused,
                pauseEndTimestampMs: (isPaused && schedule.pauseEndTime) ? schedule.pauseEndTime : null,
            });
        }
    }

    // Instant ("start block now") blocks map to MANUAL Kotlin
    // schedules — set_schedules only creates/updates the Schedule
    // entity; proceedWithBlock() separately calls
    // androidStartManualBlock to actually start the session (and
    // arm the auto-stop timer for non-always-on blocks).
    for (const block of state.appData.activeBlocks || []) {
        if (block.endTime <= now) continue;
        const blocklist = state.appData.blocklists.find(bl => bl.id === block.blocklistId);
        if (!blocklist) continue;
        if (isAllowlistBlocklist(blocklist)) {
            skippedAllowlistNames.push(blocklist.name || block.blocklistId);
            continue;
        }
        const difficulty = blocklist.overrideDifficulty;
        const { frictionWordCount, frictionCustomText } = androidFrictionChallengeFields(difficulty);
        const isPaused = !!(block.isPaused && (!block.pauseEndTime || block.pauseEndTime > now));
        flatEntries.push({
            id: block.id,
            name: blocklist.name || 'Block',
            enabled: true,
            type: 'MANUAL',
            days: [],
            blockedApps: blocklist.apps || [],
            blockedWebsites: blocklist.websites || [],
            frictionWordCount,
            frictionCustomText,
            emoji: blocklist.emoji || null,
            color: blocklist.color || null,
            isPaused,
            pauseEndTimestampMs: (isPaused && block.pauseEndTime) ? block.pauseEndTime : null,
        });
    }

    if (skippedAllowlistNames.length > 0) {
        console.warn(
            '[android] Allow-mode focus spaces are not enforced on Android and were omitted from the payload:',
            skippedAllowlistNames.join(', '),
        );
    }
    return flatEntries;
}

/**
 * Flatten schedules into the iOS Screen Time plugin payload.
 *
 * Extracted from syncSchedulesToHelper so the per-entry `mode` below can be
 * tested; the sync itself is async and talks to Tauri.
 *
 * Each entry carries `mode` so Swift knows whether its domains/tokens are
 * ALLOWED or BLOCKED items — IOSPolicyResolver unions the allow-mode entries
 * and subtracts the blocked ones. Without it every entry defaulted to blocked
 * semantics, so an allow-mode focus space on a *schedule* blocked exactly the
 * sites and apps it was meant to permit. (The manual/one-off path already sent
 * mode via collectActiveIOSManualBlockPayload, so only schedules were affected.)
 *
 * Category tokens are deliberately still sent on allow-mode entries: Swift
 * ignores them there (it collects categories only from non-allowlist entries),
 * and keeping the data means nothing is lost if the space switches back.
 */
export function buildIOSScheduleEntries() {
    const flatEntries = [];
    for (const schedule of state.appData.schedules || []) {
        if (!schedule.segments || schedule.segments.length === 0) continue;
        const blocklist = state.appData.blocklists.find(bl => bl.id === schedule.blocklistId);
        const domains = blocklist?.websites || [];
        const iosPayload = getBlocklistIOSPayload(blocklist);
        const blocklistEmoji = blocklist?.emoji ?? null;
        const blocklistName = blocklist?.name ?? null;
        const bc = blocklist?.color;
        const blocklistColorHex = typeof bc === 'string' && bc.length > 0 ? bc : null;
        // Tells Swift whether these domains/tokens are ALLOWED or BLOCKED items.
        // Same convention as the manual payload: 'allowlist' or null.
        const mode = isAllowlistBlocklist(blocklist) ? 'allowlist' : null;
        if (isNonRepeatingSchedule(schedule)) {
            const occurrences = resolveOneShotOccurrences(schedule);
            occurrences.forEach((occurrence, occurrenceIdx) => {
                flatEntries.push({
                    id: `${schedule.id}-${occurrence.segmentIndex}-${occurrenceIdx}`,
                    ...buildResolvedOneShotSegment(occurrence),
                    domains,
                    appTokenData: iosPayload.appTokenData,
                    categoryTokenData: iosPayload.categoryTokenData,
                    repeats: false,
                    isPaused: !!schedule.isPaused,
                    pauseEndTimestampMs: schedule.pauseEndTime || null,
                    blocklistEmoji,
                    blocklistName,
                    blocklistColorHex,
                    mode
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
                pauseEndTimestampMs: schedule.pauseEndTime || null,
                blocklistEmoji,
                blocklistName,
                blocklistColorHex,
                mode
            });
        }
    }

    return flatEntries;
}

export async function syncSchedulesToHelper() {
    if (state.isIOS) {
        try {
            const flatEntries = buildIOSScheduleEntries();
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
    if (state.isAndroid) {
        try {
            const flatEntries = buildAndroidScheduleEntries();
            console.log('[syncSchedulesToHelper] Android: Sending', flatEntries.length, 'segment entries to plugin');
            // Mirrored into Kotlin prefs on every sync so the native friction
            // gate prefills the user's configured pause length.
            const result = await tauriAPI.androidSetSchedules(flatEntries, getDefaultPauseMinutes());
            if (!result.success) {
                console.warn('[syncSchedulesToHelper] Android plugin failed:', result.error);
            }
        } catch (e) {
            console.warn('[syncSchedulesToHelper] Android error:', e);
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
        const helperSchedules = (state.appData.schedules || []).map(schedule => {
            const blocklist = state.appData.blocklists.find(bl => bl.id === schedule.blocklistId);
            const helperSegments = isNonRepeatingSchedule(schedule)
                ? buildResolvedOneShotSegments(schedule)
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

export async function syncActiveBlocksToHelper() {
    if (state.isIOS || state.isAndroid) return;
    try {
        const status = await tauriAPI.checkHelperStatus();
        if (!status.running || !status.version_ok) return;
        const now = Date.now();
        console.log('[syncActiveBlocksToHelper] Total activeBlocks:', state.appData.activeBlocks.length,
            'blocks:', state.appData.activeBlocks.map(b => ({
                id: b.id, blocklistId: b.blocklistId, startTime: b.startTime, endTime: b.endTime,
                isPaused: b.isPaused, isAlwaysOn: b.isAlwaysOn,
                startOk: b.startTime <= now, endOk: b.endTime > now, pauseOk: !b.isPaused
            })));
        const activeBlocks = state.appData.activeBlocks.filter(block => block.startTime <= now && block.endTime > now);
        console.log('[syncActiveBlocksToHelper] Filtered activeBlocks:', activeBlocks.length);

        // Build the blocks array for the atomic set-blocks command.
        // Paused blocks are included so the helper can auto-resume them when the pause expires,
        // even if the frontend isn't running.
        const helperBlocks = activeBlocks.map(block => {
            const blocklist = state.appData.blocklists.find(bl => bl.id === block.blocklistId);
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

export function isOneOffBlockEnforced(block, now = Date.now()) {
    return !!(block && block.startTime <= now && block.endTime > now && !block.isPaused);
}

export function isOneOffBlockStillActive(block, now = Date.now()) {
    return !!(block && block.endTime > now);
}

// No pauseEndTime = paused indefinitely (legacy-disabled schedules imported
// by migrateAndroidNativeSchedules); stays paused until the user resumes it.
export function isSchedulePausedNow(schedule, now = Date.now()) {
    return !!(schedule && schedule.isPaused && (!schedule.pauseEndTime || schedule.pauseEndTime > now));
}

export function hasAnyEnforcedBlocks(now = Date.now(), nowDate = new Date(now)) {
    const hasActiveOneOff = state.appData.activeBlocks.some(block => isOneOffBlockEnforced(block, now));
    if (hasActiveOneOff) return true;
    return !!state.appData.schedules?.some(schedule => isScheduleSegmentActiveNow(schedule, nowDate));
}

export function scheduleHasFutureRecurringOccurrence(schedule, nowDate = new Date()) {
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

export function scheduleHasFutureSingleOccurrence(schedule, nowDate = new Date()) {
    if (!schedule || !Array.isArray(schedule.segments) || schedule.segments.length === 0) return false;
    return resolveOneShotOccurrences(schedule).some(occurrence => occurrence.end > nowDate);
}

export function scheduleCanStillBecomeActive(schedule, nowDate = new Date()) {
    if (!schedule || !Array.isArray(schedule.segments) || schedule.segments.length === 0) return false;
    if (schedule.repeatType === 'forever' || (schedule.repeatType === 'date' && schedule.repeatDate)) {
        return scheduleHasFutureRecurringOccurrence(schedule, nowDate);
    }
    return scheduleHasFutureSingleOccurrence(schedule, nowDate);
}

export function getTitleBarScheduleSearchFloorMs(schedule, nowMs = Date.now()) {
    if (!schedule) return nowMs;
    if (schedule.isPaused && schedule.pauseEndTime > nowMs) {
        return Math.max(nowMs, schedule.pauseEndTime);
    }
    return nowMs;
}

export function dayIndexMonday0FromDate(dt) {
    const d = dt.getDay();
    return d === 0 ? 6 : d - 1;
}

export function getRepeatScheduleLastDayInclusiveMs(schedule) {
    if (schedule.repeatType === 'date' && schedule.repeatDate) {
        const endDate = new Date(schedule.repeatDate);
        endDate.setHours(23, 59, 59, 999);
        return endDate.getTime();
    }
    return null;
}

export function computeNextOneShotOccurrenceMs(schedule, floorMs) {
    let best = null;
    for (const occ of resolveOneShotOccurrences(schedule)) {
        const s = occ.start.getTime();
        const e = occ.end.getTime();
        if (e <= floorMs) continue;
        if (s > floorMs) {
            if (best === null || s < best) best = s;
        }
    }
    return best;
}

export function computeNextRepeatingOccurrenceMs(schedule, floorMs) {
    if (!schedule.segments || schedule.segments.length === 0) return null;
    const lastMs = getRepeatScheduleLastDayInclusiveMs(schedule);
    const floorDate = new Date(floorMs);

    let best = null;
    const y0 = floorDate.getFullYear();
    const m0 = floorDate.getMonth();
    const d0 = floorDate.getDate();

    for (let i = 0; i < 370; i++) {
        const calMidnight = new Date(y0, m0, d0 + i, 0, 0, 0, 0);
        if (lastMs !== null && calMidnight.getTime() > lastMs) break;

        const dayIx = dayIndexMonday0FromDate(calMidnight);

        for (const seg of schedule.segments) {
            const segmentDays = Array.isArray(seg.days) && seg.days.length > 0 ? seg.days : null;
            if (!segmentDays || !segmentDays.includes(dayIx)) continue;

            const startMins = seg.startHour * 60 + seg.startMinute;
            const endMins = seg.endHour * 60 + seg.endMinute;

            if (startMins === endMins) {
                const candMs = calMidnight.getTime();
                if (candMs > floorMs && (lastMs === null || candMs <= lastMs)) {
                    if (best === null || candMs < best) best = candMs;
                }
                continue;
            }

            const cand = new Date(calMidnight);
            cand.setHours(seg.startHour, seg.startMinute, 0, 0);
            const candMs = cand.getTime();
            if (candMs > floorMs && (lastMs === null || candMs <= lastMs)) {
                if (best === null || candMs < best) best = candMs;
            }
        }
    }

    return best;
}

/**
 * Among schedules that can still run, earliest segment start strictly after pause/search floor.
 */
export function pickEarliestUpcomingScheduledBlock(nowMs = Date.now()) {
    let best = null;
    for (const schedule of state.appData.schedules || []) {
        if (!schedule.segments || schedule.segments.length === 0) continue;
        if (!scheduleCanStillBecomeActive(schedule, new Date(nowMs))) continue;
        // Indefinitely paused (no pauseEndTime): no upcoming start to show.
        if (schedule.isPaused && !schedule.pauseEndTime) continue;

        const floorMs = getTitleBarScheduleSearchFloorMs(schedule, nowMs);
        let nextMs;

        if (isNonRepeatingSchedule(schedule)) {
            nextMs = computeNextOneShotOccurrenceMs(schedule, floorMs);
        } else {
            nextMs = computeNextRepeatingOccurrenceMs(schedule, floorMs);
        }

        if (nextMs == null) continue;

        const blocklist = state.appData.blocklists.find(bl => bl.id === schedule.blocklistId);
        if (!blocklist) continue;

        if (best === null || nextMs < best.startMs) {
            best = { startMs: nextMs, blocklist, schedule };
        }
    }
    return best;
}

export function formatTitleBarScheduleStartWhen(date, nowMs = Date.now()) {
    const n = new Date(nowMs);
    const dMid = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
    const targetMid = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const dd = Math.round((targetMid - dMid) / 86400000);
    const timeStr = formatTime(date);
    if (dd === 0) return `${tSettings('scheduleStartsToday')} ${timeStr}`;
    if (dd === 1) return `${tSettings('scheduleStartsTomorrow')} ${timeStr}`;
    return `${formatDateForDisplay(date)} · ${timeStr}`;
}

export function hasAnyBlockingStateToClear(now = Date.now(), nowDate = new Date(now)) {
    const hasOneOffState = state.appData.activeBlocks.some(block => isOneOffBlockStillActive(block, now));
    if (hasOneOffState) return true;
    return !!state.appData.schedules?.some(schedule => scheduleCanStillBecomeActive(schedule, nowDate));
}

export async function refreshDesktopHelperStatus() {
    if (state.isIOS || state.isAndroid) {
        return { installed: false, running: false, version: null, version_ok: false, helperReady: false };
    }
    try {
        const status = await tauriAPI.checkHelperStatus();
        const helperReady = !!(status.running && status.version_ok);
        const nextStatus = { ...status, helperReady };
        state.helperAvailable = helperReady;
        lastDesktopHelperStatus = nextStatus;
        lastDesktopHelperStatusAt = Date.now();
        return nextStatus;
    } catch (err) {
        console.error('Error checking helper status:', err);
        state.helperAvailable = false;
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

export function getCachedDesktopHelperStatus(maxAgeMs = HELPER_STATUS_CACHE_TTL_MS) {
    if (!lastDesktopHelperStatus) return null;
    if ((Date.now() - lastDesktopHelperStatusAt) > maxAgeMs) return null;
    return lastDesktopHelperStatus;
}
