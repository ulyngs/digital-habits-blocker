// Schedule editor: segment editor, repeat dropdown, schedule start flow.
// Extracted verbatim from app.js.
import { state } from './state.js';
import { tSettings, weekdayAbbrevMon0List, weekdayLetterMon0List } from './i18n.js';
import { isBlockAlwaysOn, ensureIOSBlocklistSelectionReady } from './blocklist-utils.js';
import { ensureIOSAllowlistStartable } from './allowlist-ios.js';
import { isNonRepeatingSchedule, isSchedulePausedNow, resolveOneShotOccurrences } from './schedule-engine.js';
import { saveData } from './persistence.js';
import { clearPendingScheduleDraft } from './blocklists.js';
import { handleTimeChange } from './confirm-modals.js';
import { disableScheduleControls, disableTimeControls, pad, parseEndTimeBoundedInt, scrollPopoverOptionIntoView, updateDurationQuickBtns } from './time-inputs.js';
import { syncSchedulePanelOverlayControls } from './schedule-overlay.js';
import {
    shouldUseCompactMobileScheduleDayLabels,
} from './app.js';
import { updateWindowHeight } from './blocking-platform.js';
import { openScheduleOverrideModal, setBtnActionLabel, setStartBlockBtnLeadingIcon, setStartBtnBlocklistInfo, showScheduleConfirmModal, showScheduleEditConfirmModal, syncPauseButtonForSelectedBlocklist, syncStopBtnLabelFit } from './confirm-modals.js';

export const TIME_SEPARATOR_ARROW_HTML = '<span class="time-separator" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"></path><path d="M13 6l6 6-6 6"></path></svg></span>';
export const SEGMENT_SUMMARY_CLOCK_ICON = '<svg class="segment-summary-clock" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>';
export const SEGMENT_SUMMARY_CHEVRON_ICON = '<svg class="segment-summary-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>';

// ========================================
// SCHEDULE MODE FUNCTIONS
// ========================================

// Get default schedule segments based on current time
// Start at the current hour (floor), end 2 hours later, selected on every day of the week.
export function getDefaultScheduleSegments() {
    const now = new Date();
    const startHour = now.getHours();
    const endHour = (startHour + 2) % 24;
    return [
        { startHour, startMinute: 0, endHour, endMinute: 0, days: [0, 1, 2, 3, 4, 5, 6] }
    ];
}

// Switch between timed and always-on modes for instant blocks
export function setAlwaysOnMode(alwaysOn) {
    state.isAlwaysOnMode = alwaysOn;

    // Show/hide timed controls vs always-on message
    const timedControls = document.getElementById('timed-controls');
    const alwaysOnMessage = document.getElementById('always-on-message');
    if (timedControls) timedControls.classList.toggle('hidden', alwaysOn);
    if (alwaysOnMessage) alwaysOnMessage.classList.toggle('hidden', !alwaysOn);

    // Reflect the mode change in the quick-select row (highlight "Always" or the matching duration).
    updateDurationQuickBtns(state.targetDurationMinutes);

    // Save preference per blocklist
    if (state.selectedBlocklistId) {
        if (!state.appData.settings) state.appData.settings = {};
        if (!state.appData.settings.alwaysOnMode) state.appData.settings.alwaysOnMode = {};
        if (state.appData.settings.alwaysOnMode[state.selectedBlocklistId] !== alwaysOn) {
            state.appData.settings.alwaysOnMode[state.selectedBlocklistId] = alwaysOn;
            saveData();
        }
    }

    // Update calendar preview and button state
    handleTimeChange();

    // Update window height after layout change
    setTimeout(() => updateWindowHeight(), 50);
}

// Switch between instant and schedule modes
export function setScheduleMode(isSchedule) {
    state.isScheduleMode = isSchedule;

    // Persist this tab choice per blocklist so it restores when switching back
    if (state.selectedBlocklistId && state.appData.settings) {
        if (!state.appData.settings.preferredStartMode) state.appData.settings.preferredStartMode = {};
        if (state.appData.settings.preferredStartMode[state.selectedBlocklistId] !== isSchedule) {
            state.appData.settings.preferredStartMode[state.selectedBlocklistId] = isSchedule;
            saveData();
        }
    }

    // Update tab active states
    document.getElementById('instant-mode-tab').classList.toggle('active', !isSchedule);
    document.getElementById('schedule-mode-tab').classList.toggle('active', isSchedule);

    // Update section heading
    const heading = document.getElementById('main-start-block-title');
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
        const existingSchedule = state.selectedBlocklistId && state.appData.schedules
            ? state.appData.schedules.find(s => s.blocklistId === state.selectedBlocklistId)
            : null;

        if (existingSchedule && existingSchedule.segments) {
            // Load existing schedule segments (locked)
            state.scheduleSegments = existingSchedule.segments.map(seg => ({ ...seg }));
            state.activeScheduleSegmentCount = getCommittedScheduleSegmentCount(existingSchedule);
            state.scheduleRepeatType = existingSchedule.repeatType || 'no';
            state.scheduleRepeatDate = existingSchedule.repeatDate;

            // Also load any pending (new) segments that were added but not yet committed
            const pendingSegments = state.appData.settings?.pendingScheduleSegments?.[state.selectedBlocklistId];
            if (pendingSegments && pendingSegments.length > 0) {
                const cleanedPendingSegments = pendingSegments.filter(seg =>
                    !existingSchedule.segments.some(existingSeg => areSegmentsEqual(existingSeg, seg))
                );
                if (cleanedPendingSegments.length > 0) {
                    // Append pending segments to the existing locked segments
                    state.scheduleSegments.push(...cleanedPendingSegments.map(seg => ({ ...seg })));
                    const currentPending = JSON.stringify(state.appData.settings.pendingScheduleSegments[state.selectedBlocklistId] || []);
                    const nextPending = JSON.stringify(cleanedPendingSegments);
                    if (currentPending !== nextPending) {
                        state.appData.settings.pendingScheduleSegments[state.selectedBlocklistId] = cleanedPendingSegments.map(seg => ({ ...seg }));
                        saveData();
                    }
                } else {
                    if (state.appData.settings.pendingScheduleSegments?.[state.selectedBlocklistId]) {
                        clearPendingScheduleDraft(state.selectedBlocklistId);
                        saveData();
                    }
                }
            }
        } else {
            // Check for pending (unsaved) segments for this blocklist
            const pendingSegments = state.appData.settings?.pendingScheduleSegments?.[state.selectedBlocklistId];
            if (pendingSegments && pendingSegments.length > 0) {
                state.scheduleSegments = pendingSegments.map(seg => ({ ...seg }));
                const repeatOpts = state.appData.settings?.pendingScheduleRepeatOptions?.[state.selectedBlocklistId];
                if (repeatOpts && typeof repeatOpts.repeatType === 'string') {
                    state.scheduleRepeatType = repeatOpts.repeatType;
                    state.scheduleRepeatDate =
                        repeatOpts.repeatType === 'date' && repeatOpts.repeatDate != null
                            ? new Date(repeatOpts.repeatDate)
                            : null;
                } else {
                    state.scheduleRepeatType = 'forever';
                    state.scheduleRepeatDate = null;
                }
            } else {
                // Reset schedule segments to fresh default times
                state.scheduleSegments = getDefaultScheduleSegments();
                state.scheduleRepeatType = 'forever';
                state.scheduleRepeatDate = null;
            }
            state.activeScheduleSegmentCount = 0;
        }
        state.expandedScheduleSegmentIndex = getInitialExpandedScheduleSegmentIndex();
        rebuildScheduleSegments();

        instantPanel.classList.add('hidden');
        schedulePanel.classList.remove('hidden');
        startBlockBtn.classList.add('hidden');
        if (state.selectedBlocklistId) {
            startScheduleBtn.classList.remove('hidden');
            updateScheduleButtonState();
        }
    } else {
        instantPanel.classList.remove('hidden');
        schedulePanel.classList.add('hidden');
        startScheduleBtn.classList.add('hidden');
        if (state.selectedBlocklistId) {
            startBlockBtn.classList.remove('hidden');
            const blocklist = state.appData.blocklists.find(bl => bl.id === state.selectedBlocklistId);
            const btnLabel = startBlockBtn.querySelector('.btn-label');
            const now = Date.now();
            const activeBlock = state.appData.activeBlocks.find(b =>
                b.blocklistId === state.selectedBlocklistId &&
                b.startTime <= now &&
                b.endTime > now
            );
            if (activeBlock) {
                startBlockBtn.classList.add('stop-block');
                setBtnActionLabel(btnLabel, tSettings('stopBlock'));
                setStartBtnBlocklistInfo(startBlockBtn, blocklist);
                startBlockBtn.disabled = false;
                startBlockBtn.dataset.activeBlockId = activeBlock.id;
                setStartBlockBtnLeadingIcon(startBlockBtn, 'stop');
                disableTimeControls(true);

                const alwaysOnMsg = document.getElementById('always-on-message');
                if (alwaysOnMsg) alwaysOnMsg.classList.toggle('hidden', !isBlockAlwaysOn(activeBlock));
            } else {
                startBlockBtn.classList.remove('stop-block');
                delete startBlockBtn.dataset.activeBlockId;
                setBtnActionLabel(btnLabel, tSettings('startBlockButton'), { simple: true });
                setStartBtnBlocklistInfo(startBlockBtn, blocklist);
                setStartBlockBtnLeadingIcon(startBlockBtn, 'enter');
            }
            syncPauseButtonForSelectedBlocklist(now);
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
export function closeSchedulePanelDropdownMenus(exceptMenuId = null) {
    for (const menuId of ['repeat-dropdown-menu', 'schedule-panel-overlay-dropdown-menu']) {
        if (menuId !== exceptMenuId) {
            document.getElementById(menuId)?.classList.add('hidden');
        }
    }
}

export function toggleRepeatDropdown(e) {
    e.stopPropagation();

    // Don't allow opening dropdown when schedule is active
    if (state.activeScheduleSegmentCount > 0) return;

    // Also check if button is disabled
    const repeatDropdownBtn = document.getElementById('repeat-dropdown-btn');
    if (repeatDropdownBtn && repeatDropdownBtn.disabled) {
        return;
    }

    const menu = document.getElementById('repeat-dropdown-menu');
    if (!menu) return;

    const isHidden = menu.classList.contains('hidden');
    if (isHidden) closeSchedulePanelDropdownMenus('repeat-dropdown-menu');
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
export function handleRepeatOptionClick(e) {
    e.stopPropagation();

    // Don't allow changing repeat options when schedule is active
    if (state.activeScheduleSegmentCount > 0) {
        // Close dropdown silently
        const menu = document.getElementById('repeat-dropdown-menu');
        if (menu) menu.classList.add('hidden');
        return;
    }

    const value = e.target.dataset.value;
    const menu = document.getElementById('repeat-dropdown-menu');
    const btnText = document.getElementById('repeat-dropdown-text');
    const dateInput = document.getElementById('repeat-date-input');

    state.scheduleRepeatType = value;

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
            if (!state.scheduleRepeatDate) {
                const defaultDate = new Date();
                defaultDate.setDate(defaultDate.getDate() + 6);
                state.scheduleRepeatDate = defaultDate;
                dateInput.value = formatDateForInput(defaultDate);
            }
            // Update overlay with formatted date
            if (dateOverlay) {
                dateOverlay.textContent = formatDateForDisplay(state.scheduleRepeatDate);
            }
        } else {
            dateWrapper.classList.add('hidden');
            state.scheduleRepeatDate = null;
        }
    }

    // Close menu
    if (menu) menu.classList.add('hidden');

    // Update preview
    handleTimeChange();
}

// Handle Repeat date change
export function handleRepeatDateChange(e) {
    const dateStr = e.target.value;
    if (dateStr) {
        state.scheduleRepeatDate = new Date(dateStr + 'T23:59:59');
        // Update the overlay with formatted date
        const dateOverlay = document.getElementById('repeat-date-overlay');
        if (dateOverlay) {
            dateOverlay.textContent = formatDateForDisplay(state.scheduleRepeatDate);
        }
        // Update preview
        handleTimeChange();
    }
}

// Format date for input element (YYYY-MM-DD)
export function formatDateForInput(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export function localDateKey(date) {
    return formatDateForInput(date);
}

export function parseLocalDateKey(dateKey) {
    if (!dateKey) return null;
    const [year, month, day] = dateKey.split('-').map(Number);
    if (![year, month, day].every(Number.isFinite)) return null;
    return new Date(year, month - 1, day);
}

// Format date for display (e.g., "3 Feb 2026")
export function formatDateForDisplay(date) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const day = date.getDate();
    const month = months[date.getMonth()];
    const year = date.getFullYear();
    return `${day} ${month} ${year}`;
}

export function isScheduleSegmentActiveNow(schedule, nowDate = new Date()) {
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

export function getCommittedScheduleSegmentCount(schedule) {
    return schedule && schedule.segments ? schedule.segments.length : 0;
}

export function areSegmentsEqual(a, b) {
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
export function updateScheduleButtonState() {
    const startScheduleBtn = document.getElementById('start-schedule-btn');
    if (!startScheduleBtn) return;

    // Check if selected blocklist has an active schedule
    const activeSchedule = state.selectedBlocklistId && state.appData.schedules
        ? state.appData.schedules.find(s => s.blocklistId === state.selectedBlocklistId)
        : null;
    const now = Date.now();
    const scheduleIsPaused = isSchedulePausedNow(activeSchedule, now);
    const scheduleIsActiveNow = !!(activeSchedule && isScheduleSegmentActiveNow(activeSchedule));
    const scheduleIsFunctionallyActive = scheduleIsPaused || scheduleIsActiveNow;

    const blocklist = state.selectedBlocklistId
        ? state.appData.blocklists.find(bl => bl.id === state.selectedBlocklistId)
        : null;

    const btnLabel = startScheduleBtn.querySelector('.btn-label');

    // Check if there are new segments (beyond the locked count)
    const committedSegmentCount = getCommittedScheduleSegmentCount(activeSchedule);
    const hasNewSegments = activeSchedule && state.scheduleSegments.length > committedSegmentCount;

    syncPauseButtonForSelectedBlocklist(now);

    if (activeSchedule) {
        // Active schedule - keep Stop button visible regardless of pending changes.
        // Pending segments are committed/discarded via the pending-changes bar.
        startScheduleBtn.classList.add('stop-schedule');
        setBtnActionLabel(btnLabel, tSettings('stopScheduleButton'));
        setStartBtnBlocklistInfo(startScheduleBtn, blocklist);
        startScheduleBtn.classList.remove('edit-schedule');
        startScheduleBtn.disabled = false;
        startScheduleBtn.dataset.activeScheduleId = activeSchedule.id || activeSchedule.blocklistId;

        setStartBlockBtnLeadingIcon(startScheduleBtn, 'stop');

        // Disable controls for existing (committed) segments; new ones stay editable
        disableScheduleControls(true);
    } else {
        // No active schedule - show Start button (normal)
        startScheduleBtn.classList.remove('stop-schedule');
        setBtnActionLabel(btnLabel, tSettings('startScheduleButton'));
        setStartBtnBlocklistInfo(startScheduleBtn, blocklist);
        startScheduleBtn.classList.remove('edit-schedule');
        delete startScheduleBtn.dataset.activeScheduleId;

        setStartBlockBtnLeadingIcon(startScheduleBtn, 'enter');

        // Enable all controls
        disableScheduleControls(false);
    }

    // Enable button if blocklist is selected
    const isValid = state.selectedBlocklistId;
    startScheduleBtn.disabled = !isValid;

    // Show pending-changes bar only when an active schedule has unsaved new segments
    updateSchedulePendingBar(!!(activeSchedule && hasNewSegments), activeSchedule);
    syncSchedulePanelOverlayControls();
    syncStopBtnLabelFit(startScheduleBtn);
}

// Show or hide the pending-changes bar at the bottom of the schedule panel.
export function updateSchedulePendingBar(visible, activeSchedule) {
    const bar = document.getElementById('schedule-pending-bar');
    if (!bar) return;

    if (!visible) {
        bar.classList.add('hidden');
        return;
    }

    const label = document.getElementById('schedule-pending-label');
    if (label) label.textContent = tSettings('pendingChangesLabel');

    const saveBtn = document.getElementById('schedule-pending-save');
    if (saveBtn) saveBtn.textContent = tSettings('pendingChangesSave');
    const discardBtn = document.getElementById('schedule-pending-discard');
    if (discardBtn) discardBtn.textContent = tSettings('pendingChangesDiscard');

    bar.classList.remove('hidden');
}

// Commit any unsaved new segments to the active schedule (Save changes from pending bar).
export async function saveSchedulePendingChanges() {
    if (!state.selectedBlocklistId) return;
    const blocklist = state.appData.blocklists.find(bl => bl.id === state.selectedBlocklistId);
    const activeSchedule = state.appData.schedules
        ? state.appData.schedules.find(s => s.blocklistId === state.selectedBlocklistId)
        : null;
    if (!blocklist || !activeSchedule) return;

    const committedCount = getCommittedScheduleSegmentCount(activeSchedule);
    const newSegments = state.scheduleSegments.slice(committedCount);
    if (newSegments.length === 0) return;

    // Require at least one day per new segment, matching startSchedule's validation.
    const allHaveDays = newSegments.every(seg => Array.isArray(seg.days) && seg.days.length > 0);
    if (!allHaveDays) return;

    showScheduleEditConfirmModal(blocklist, activeSchedule, newSegments);
}

// Discard any unsaved new segments and revert the panel to the committed schedule.
export function discardSchedulePendingChanges() {
    if (!state.selectedBlocklistId) return;
    const activeSchedule = state.appData.schedules
        ? state.appData.schedules.find(s => s.blocklistId === state.selectedBlocklistId)
        : null;
    if (!activeSchedule) return;

    const committedCount = getCommittedScheduleSegmentCount(activeSchedule);
    if (state.scheduleSegments.length <= committedCount) return;

    // Truncate to committed segments only
    state.scheduleSegments = state.scheduleSegments.slice(0, committedCount).map(seg => ({ ...seg }));

    // Clear persisted pending draft so a reload doesn't resurrect them
    clearPendingScheduleDraft(state.selectedBlocklistId);
    saveData();

    rebuildScheduleSegments();
    disableScheduleControls(true);
    handleTimeChange();
    updateScheduleButtonState();
}

// Add a new time segment
export function addScheduleSegment() {
    // Get the previous segment's end time, round up to next full hour for new start
    const prevSegment = state.scheduleSegments[state.scheduleSegments.length - 1];
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

    const defaultDays =
        prevSegment && Array.isArray(prevSegment.days) && prevSegment.days.length > 0
            ? [...prevSegment.days]
            : [0, 1, 2, 3, 4, 5, 6];

    state.scheduleSegments.push({
        startHour: newStartHour,
        startMinute: newStartMinute,
        endHour: newEndHour,
        endMinute: newEndMinute,
        days: defaultDays
    });

    state.expandedScheduleSegmentIndex = state.scheduleSegments.length - 1;

    // Rebuild all segments to ensure consistent rendering
    rebuildScheduleSegments();

    // Re-apply disabled state to locked segments (if schedule is active)
    if (state.activeScheduleSegmentCount > 0) {
        disableScheduleControls(true);
    }

    // Update calendar preview and button state
    handleTimeChange();
    updateScheduleButtonState();
}

// Handle clicking a day toggle within a segment
export function handleSegmentDayToggle(segmentIndex, dayIndex, btn) {
    // Don't allow toggling days on locked segments (part of active schedule)
    if (segmentIndex < state.activeScheduleSegmentCount) return;

    const segment = state.scheduleSegments[segmentIndex];
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
    syncSegmentDayPresetButtons(segmentIndex);
    handleTimeChange();
    updateScheduleButtonState();
}

export function syncSegmentDayPresetButtons(segmentIndex) {
    const segment = document.querySelector(`.schedule-segment[data-segment-index="${segmentIndex}"]`);
    const segmentDays = state.scheduleSegments[segmentIndex]?.days;
    if (!segment || !segmentDays) return;

    const presetMap = {
        weekdays: [0, 1, 2, 3, 4],
        weekends: [5, 6],
        everyday: [0, 1, 2, 3, 4, 5, 6],
    };

    segment.querySelectorAll('.segment-day-preset').forEach(btn => {
        const presetDays = presetMap[btn.dataset.preset];
        btn.classList.toggle('active', presetDays ? arraysEqual(
            [...segmentDays].sort((a, b) => a - b),
            presetDays,
        ) : false);
    });
}

// Remove a time segment
export function removeScheduleSegment(index) {
    // Don't allow removing locked segments (part of active schedule)
    if (index < state.activeScheduleSegmentCount) return;

    if (state.scheduleSegments.length <= 1) return; // Always keep at least one

    // Remove from state
    state.scheduleSegments.splice(index, 1);

    if (state.expandedScheduleSegmentIndex === index) {
        state.expandedScheduleSegmentIndex = usesScheduleSegmentCollapse() ? -1 : 0;
    } else if (state.expandedScheduleSegmentIndex > index) {
        state.expandedScheduleSegmentIndex -= 1;
    }

    // Rebuild DOM (simpler than updating indices)
    rebuildScheduleSegments();

    // Re-apply disabled state to locked segments if a schedule is active
    if (state.activeScheduleSegmentCount > 0) {
        disableScheduleControls(true);
    }

    // Update calendar preview and pending-bar visibility
    handleTimeChange();
    updateScheduleButtonState();
}

// Sort schedule segments chronologically by start time.
// When a schedule is running, the committed/pending split is tracked by array index
// (segments before `state.activeScheduleSegmentCount` are committed, the rest are unsaved).
// Sort within each partition independently so that invariant survives the sort —
// otherwise a pending segment with an early time could swap places with a committed
// one and corrupt subsequent saves.
export function sortScheduleSegments() {
    const cmp = (a, b) => (a.startHour * 60 + a.startMinute) - (b.startHour * 60 + b.startMinute);
    if (state.activeScheduleSegmentCount > 0 && state.scheduleSegments.length > state.activeScheduleSegmentCount) {
        const committed = state.scheduleSegments.slice(0, state.activeScheduleSegmentCount).sort(cmp);
        const pending = state.scheduleSegments.slice(state.activeScheduleSegmentCount).sort(cmp);
        state.scheduleSegments = [...committed, ...pending];
    } else {
        state.scheduleSegments.sort(cmp);
    }
}

export function usesScheduleSegmentCollapse() {
    return state.scheduleSegments.length > 1 || state.activeScheduleSegmentCount > 0;
}

export function scheduleHasPendingSegments() {
    return state.activeScheduleSegmentCount > 0 && state.scheduleSegments.length > state.activeScheduleSegmentCount;
}

export function getInitialExpandedScheduleSegmentIndex() {
    if (!usesScheduleSegmentCollapse()) return 0;
    if (scheduleHasPendingSegments()) return state.activeScheduleSegmentCount;
    if (state.scheduleSegments.length > 1) return -1;
    if (state.activeScheduleSegmentCount > 0) return -1;
    return 0;
}

export function normalizeExpandedScheduleSegmentIndex() {
    if (!usesScheduleSegmentCollapse()) {
        state.expandedScheduleSegmentIndex = 0;
        return;
    }

    const allCommitted = state.activeScheduleSegmentCount >= state.scheduleSegments.length && state.activeScheduleSegmentCount > 0;
    if (allCommitted) {
        state.expandedScheduleSegmentIndex = -1;
        return;
    }

    // -1 = accordion fully collapsed; any other in-range index is an explicit user choice
    // (e.g. summary tap or a newly added segment) — do not reset it on every rebuild.
    if (scheduleHasPendingSegments()) {
        if (state.expandedScheduleSegmentIndex >= 0 && state.expandedScheduleSegmentIndex < state.activeScheduleSegmentCount) {
            state.expandedScheduleSegmentIndex = state.activeScheduleSegmentCount;
        }
    }

    if (state.expandedScheduleSegmentIndex >= state.scheduleSegments.length) {
        state.expandedScheduleSegmentIndex = state.scheduleSegments.length - 1;
    }
}

export function formatScheduleSegmentTimeRange(seg) {
    const start = `${String(seg.startHour).padStart(2, '0')}:${String(seg.startMinute).padStart(2, '0')}`;
    const end = `${String(seg.endHour).padStart(2, '0')}:${String(seg.endMinute).padStart(2, '0')}`;
    return `${start} – ${end}`;
}

export function formatScheduleSegmentDaysSummary(days) {
    const selected = Array.isArray(days) ? [...days].sort((a, b) => a - b) : [];
    if (selected.length === 0) return tSettings('segmentDaysNone');
    const labels = weekdayAbbrevMon0List();
    return selected.map((dayIndex) => labels[dayIndex]).join(', ');
}

export function arraysEqual(a, b) {
    return Array.isArray(a) && Array.isArray(b)
        && a.length === b.length
        && a.every((value, index) => value === b[index]);
}

export function getSegmentDayPresetActiveClass(segmentDays, presetDays) {
    const selected = Array.isArray(segmentDays) ? [...segmentDays].sort((a, b) => a - b) : [];
    return arraysEqual(selected, presetDays) ? ' active' : '';
}

export function expandScheduleSegment(index) {
    if (index < state.activeScheduleSegmentCount) return;
    if (state.scheduleSegments.length <= 1) return;
    state.expandedScheduleSegmentIndex = index;
    rebuildScheduleSegments();
}

export function collapseExpandedScheduleSegment() {
    if (state.scheduleSegments.length <= 1) return;
    state.expandedScheduleSegmentIndex = -1;
    rebuildScheduleSegments();
}

export function applySegmentDayPreset(segmentIndex, preset) {
    if (segmentIndex < state.activeScheduleSegmentCount) return;
    const segment = state.scheduleSegments[segmentIndex];
    if (!segment) return;

    const presetDays = {
        weekdays: [0, 1, 2, 3, 4],
        weekends: [5, 6],
        everyday: [0, 1, 2, 3, 4, 5, 6],
    }[preset];

    if (!presetDays) return;
    segment.days = [...presetDays];

    const segmentEl = document.querySelector(`.schedule-segment[data-segment-index="${segmentIndex}"]`);
    if (segmentEl) {
        segmentEl.querySelectorAll('.segment-day-toggle').forEach(btn => {
            const dayIndex = parseInt(btn.dataset.day, 10);
            btn.classList.toggle('active', segment.days.includes(dayIndex));
        });
        syncSegmentDayPresetButtons(segmentIndex);
    }

    handleTimeChange();
    updateScheduleButtonState();
}

export function buildScheduleSegmentEditorHtml(seg, index, {
    showLabels,
    showMultiSegmentChrome,
    dayLabels,
    fullDayLabels,
    useCompactDayLabels,
    labelStart,
    labelEnd,
    labelDays,
}) {
    const segmentDays = seg.days || [];
    const dayTogglesHtml = dayLabels.map((label, i) =>
        `<button type="button" class="segment-day-toggle${segmentDays.includes(i) ? ' active' : ''}" data-day="${i}" aria-label="${fullDayLabels[i]}">${label}</button>`
    ).join('');

    const dayPresetsHtml = showMultiSegmentChrome ? `
        <div class="segment-day-presets">
            <button type="button" class="segment-day-preset${getSegmentDayPresetActiveClass(segmentDays, [0, 1, 2, 3, 4])}" data-preset="weekdays">${tSettings('segmentDaysWeekdays')}</button>
            <button type="button" class="segment-day-preset${getSegmentDayPresetActiveClass(segmentDays, [5, 6])}" data-preset="weekends">${tSettings('segmentDaysWeekends')}</button>
            <button type="button" class="segment-day-preset${getSegmentDayPresetActiveClass(segmentDays, [0, 1, 2, 3, 4, 5, 6])}" data-preset="everyday">${tSettings('segmentDaysEveryDay')}</button>
        </div>
    ` : '';

    const footerHtml = showMultiSegmentChrome ? `
        <div class="segment-editor-footer">
            <button type="button" class="segment-delete-btn" data-segment-index="${index}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M3 6h18"></path>
                    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
                    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
                </svg>
                ${tSettings('segmentDelete')}
            </button>
            <button type="button" class="segment-done-btn" data-segment-index="${index}">${tSettings('segmentDone')}</button>
        </div>
    ` : '';

    return `
        <div class="segment-editor">
            <div class="segment-row">
                <div class="time-pickers-row">
                    <div class="time-picker-group">
                        ${showLabels ? `<label class="time-label">${labelStart}</label>` : ''}
                        <div class="time-picker-row">
                            <div class="time-display schedule-start-display">
                                <div class="time-part-wrapper">
                                    <input type="text" class="time-part schedule-hour-btn"
                                        data-type="hour" data-target="schedule-start-${index}"
                                        inputmode="numeric" maxlength="2" autocomplete="off"
                                        value="${String(seg.startHour).padStart(2, '0')}"
                                        aria-label="Schedule start hour" />
                                </div>
                                <span class="time-colon">:</span>
                                <div class="time-part-wrapper">
                                    <input type="text" class="time-part schedule-minute-btn"
                                        data-type="minute" data-target="schedule-start-${index}"
                                        inputmode="numeric" maxlength="2" autocomplete="off"
                                        value="${String(seg.startMinute).padStart(2, '0')}"
                                        aria-label="Schedule start minute" />
                                </div>
                            </div>
                        </div>
                    </div>
                    ${TIME_SEPARATOR_ARROW_HTML}
                    <div class="time-picker-group">
                        ${showLabels ? `<label class="time-label">${labelEnd}</label>` : ''}
                        <div class="time-picker-row">
                            <div class="time-display schedule-end-display">
                                <div class="time-part-wrapper">
                                    <input type="text" class="time-part schedule-hour-btn"
                                        data-type="hour" data-target="schedule-end-${index}"
                                        inputmode="numeric" maxlength="2" autocomplete="off"
                                        value="${String(seg.endHour).padStart(2, '0')}"
                                        aria-label="Schedule end hour" />
                                </div>
                                <span class="time-colon">:</span>
                                <div class="time-part-wrapper">
                                    <input type="text" class="time-part schedule-minute-btn"
                                        data-type="minute" data-target="schedule-end-${index}"
                                        inputmode="numeric" maxlength="2" autocomplete="off"
                                        value="${String(seg.endMinute).padStart(2, '0')}"
                                        aria-label="Schedule end minute" />
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="segment-days-group">
                    ${showLabels ? `<label class="time-label">${labelDays}</label>` : ''}
                    <div class="segment-days${useCompactDayLabels ? ' compact-day-labels' : ''}" data-segment-index="${index}">
                        ${dayTogglesHtml}
                    </div>
                </div>
            </div>
            ${dayPresetsHtml}
            ${footerHtml}
        </div>
    `;
}

export function buildScheduleSegmentSummaryHtml(seg, index) {
    return `
        <button type="button" class="segment-summary-btn" data-segment-index="${index}" aria-expanded="false">
            ${SEGMENT_SUMMARY_CLOCK_ICON}
            <span class="segment-summary-time">${formatScheduleSegmentTimeRange(seg)}</span>
            <span class="segment-summary-days">${formatScheduleSegmentDaysSummary(seg.days)}</span>
            ${SEGMENT_SUMMARY_CHEVRON_ICON}
        </button>
    `;
}

export function wireScheduleSegmentElement(segment, index) {
    attachScheduleSegmentTimeInteractions(segment);

    segment.querySelectorAll('.segment-day-toggle').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const dayIndex = parseInt(btn.dataset.day, 10);
            handleSegmentDayToggle(index, dayIndex, btn);
        });
    });

    segment.querySelectorAll('.segment-day-preset').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            applySegmentDayPreset(index, btn.dataset.preset);
        });
    });

    const deleteBtn = segment.querySelector('.segment-delete-btn');
    if (deleteBtn) {
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            removeScheduleSegment(index);
        });
    }

    const doneBtn = segment.querySelector('.segment-done-btn');
    if (doneBtn) {
        doneBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            collapseExpandedScheduleSegment();
        });
    }

    const summaryBtn = segment.querySelector('.segment-summary-btn');
    if (summaryBtn) {
        summaryBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            expandScheduleSegment(index);
        });
    }

    const removeBtn = segment.querySelector('.remove-segment-btn');
    if (removeBtn) {
        removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            removeScheduleSegment(index);
        });
    }
}

// Rebuild schedule segments DOM from state
export function rebuildScheduleSegments() {
    // Sort chronologically before rebuilding
    sortScheduleSegments();
    normalizeExpandedScheduleSegmentIndex();

    const container = document.getElementById('schedule-segments');
    container.innerHTML = '';

    const fullDayLabels = weekdayAbbrevMon0List();
    const useCompactDayLabels = shouldUseCompactMobileScheduleDayLabels();
    const dayLabels = useCompactDayLabels ? weekdayLetterMon0List() : fullDayLabels;
    const labelStart = tSettings('start');
    const labelEnd = tSettings('end');
    const labelDays = tSettings('days');
    const multiSegment = state.scheduleSegments.length > 1;
    const useCollapse = usesScheduleSegmentCollapse();

    state.mobileCompactScheduleDayLabelsActive = useCompactDayLabels;

    state.scheduleSegments.forEach((seg, index) => {
        const segment = document.createElement('div');
        const isExpanded = !useCollapse || index === state.expandedScheduleSegmentIndex;
        segment.className = `schedule-segment${
            isExpanded ? ' schedule-segment-expanded' : ' schedule-segment-collapsed'
        }`;
        segment.dataset.segmentIndex = index;

        if (isExpanded) {
            const showLabels = !multiSegment || index === 0 || state.expandedScheduleSegmentIndex === index;
            segment.innerHTML = buildScheduleSegmentEditorHtml(seg, index, {
                showLabels: multiSegment ? true : showLabels,
                showMultiSegmentChrome: multiSegment,
                dayLabels,
                fullDayLabels,
                useCompactDayLabels,
                labelStart,
                labelEnd,
                labelDays,
            });
        } else {
            segment.innerHTML = buildScheduleSegmentSummaryHtml(seg, index);
        }

        container.appendChild(segment);
        wireScheduleSegmentElement(segment, index);
    });
}

/** Parse `schedule-start-0` → { isStart, segmentIndex }. */
export function parseScheduleTimeTarget(target) {
    const parts = String(target || '').split('-');
    return {
        isStart: parts[1] === 'start',
        segmentIndex: parseInt(parts[2], 10)
    };
}

/** Editable schedule HH:MM — same UX as instant end: click opens list; type to edit. */
export function bindScheduleTimePartInput(el) {
    el.addEventListener('input', () => {
        document.querySelectorAll('.schedule-time-popover').forEach(p => p.remove());
        const next = el.value.replace(/\D/g, '').slice(0, 2);
        if (next !== el.value) el.value = next;
    });
    el.addEventListener('blur', () => commitScheduleTimePart(el));
    el.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const type = el.dataset.type;
        const target = el.dataset.target;
        const segmentEl = el.closest('.schedule-segment');
        if (type === 'hour') {
            const minIn = segmentEl
                ? segmentEl.querySelector(`[data-target="${target}"][data-type="minute"]`)
                : null;
            el.blur();
            if (minIn) {
                minIn.focus({ preventScroll: true });
                if (typeof minIn.select === 'function') minIn.select();
            }
        } else {
            el.blur();
        }
    });
}

export function commitScheduleTimePart(input) {
    const type = input.dataset.type;
    const target = input.dataset.target;
    if (!type || !target || (type !== 'hour' && type !== 'minute')) return;
    const { isStart, segmentIndex } = parseScheduleTimeTarget(target);
    const seg = state.scheduleSegments[segmentIndex];
    if (!seg) return;

    const max = type === 'hour' ? 23 : 59;
    const v = parseEndTimeBoundedInt(input.value, 0, max);
    let current;
    if (type === 'hour') {
        current = isStart ? seg.startHour : seg.endHour;
    } else {
        current = isStart ? seg.startMinute : seg.endMinute;
    }
    if (v === null) {
        input.value = pad(current);
        return;
    }
    if (type === 'hour') {
        if (isStart) seg.startHour = v;
        else seg.endHour = v;
    } else {
        if (isStart) seg.startMinute = v;
        else seg.endMinute = v;
    }
    input.value = pad(v);
    handleTimeChange();
}

export function attachScheduleSegmentTimeInteractions(segment) {
    segment
        .querySelectorAll('.schedule-start-display input.time-part, .schedule-end-display input.time-part')
        .forEach(el => {
            if (el.dataset.scheduleUiBound === '1') return;
            el.dataset.scheduleUiBound = '1';
            el.addEventListener('click', handleScheduleTimeClick);
            bindScheduleTimePartInput(el);
        });
}

export function wireAllScheduleSegmentTimeControls() {
    document.querySelectorAll('#schedule-segments .schedule-segment').forEach(attachScheduleSegmentTimeInteractions);
}

// Handle schedule time control click (show popover)
export function handleScheduleTimeClick(e) {
    e.stopPropagation();
    const el = e.currentTarget;
    const type = el.dataset.type; // 'hour' or 'minute'
    const target = el.dataset.target; // e.g., 'schedule-start-0' or 'schedule-end-1'

    // Parse target
    const parts = target.split('-');
    const isStart = parts[1] === 'start';
    const segmentIndex = parseInt(parts[2]);

    document.querySelectorAll('.schedule-time-popover').forEach(p => p.remove());

    // Create and show popover for time selection
    showScheduleTimePopover(el, type, isStart, segmentIndex);
}

// Show time popover for schedule time selection (anchored to editable time pill)
export function showScheduleTimePopover(field, type, isStart, segmentIndex) {
    // Remove any existing schedule popovers
    document.querySelectorAll('.schedule-time-popover').forEach(p => p.remove());

    const popover = document.createElement('div');
    popover.className = 'time-popover schedule-time-popover';

    const scroll = document.createElement('div');
    scroll.className = 'popover-scroll';

    const segment = state.scheduleSegments[segmentIndex];
    const currentValue = type === 'hour'
        ? (isStart ? segment.startHour : segment.endHour)
        : (isStart ? segment.startMinute : segment.endMinute);

    /** Nearest slot in the 5-minute list for scroll/highlight when value was typed freely. */
    let listHighlightValue = currentValue;
    if (type === 'minute' && currentValue % 5 !== 0) {
        const rounded = Math.round(currentValue / 5) * 5;
        listHighlightValue = rounded >= 60 ? 55 : rounded;
    }

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
        option.className = 'popover-option' + (i === listHighlightValue ? ' selected' : '');
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

            // Update field display
            field.value = String(i).padStart(2, '0');

            // Close popover
            popover.remove();

            // Update calendar preview
            handleTimeChange();
        });
        scroll.appendChild(option);
    }

    popover.appendChild(scroll);
    field.parentElement.appendChild(popover);

    // Scroll to current value inside the popover only
    const activeOption = scroll.querySelector('.selected');
    scrollPopoverOptionIntoView(scroll, activeOption);

    // Close on outside click
    setTimeout(() => {
        document.addEventListener('click', function closePopover(e) {
            if (!popover.contains(e.target) && e.target !== field) {
                popover.remove();
                document.removeEventListener('click', closePopover);
            }
        });
    }, 10);
}

// Start a schedule - show confirmation modal first.
// When a schedule is already active this acts as Stop; the persistent Stop button
// behaves identically whether or not pending edits exist (those are committed/discarded
// via the pending-changes bar, never via this button).
export async function startSchedule() {
    if (!state.selectedBlocklistId) return;

    const blocklist = state.appData.blocklists.find(bl => bl.id === state.selectedBlocklistId);
    if (!blocklist) return;

    const activeSchedule = state.appData.schedules
        ? state.appData.schedules.find(s => s.blocklistId === state.selectedBlocklistId)
        : null;

    if (activeSchedule) {
        // Stop mode - open override dialog for the schedule
        openScheduleOverrideModal(activeSchedule);
        return;
    }

    if (!ensureIOSBlocklistSelectionReady(blocklist, 'starting this schedule')) return;
    if (!await ensureIOSAllowlistStartable(blocklist)) return;

    // Normal start mode - check that at least one segment has days
    const hasAnyDays = state.scheduleSegments.some(seg => seg.days && seg.days.length > 0);
    if (!hasAnyDays) return;

    // Show confirmation modal for new schedule
    showScheduleConfirmModal(blocklist);
}