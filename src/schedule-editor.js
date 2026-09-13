// Schedule editor: segment editor, repeat dropdown, schedule start flow.
// Extracted verbatim from app.js.
import { state } from './state.js';
import { tSettings, weekdayAbbrevMon0List, weekdayLetterMon0List } from './i18n.js';
import { isNonRepeatingSchedule, isSchedulePausedNow, resolveOneShotOccurrences } from './schedule-engine.js';
import { saveData } from './persistence.js';
import { commitDelete, dismissUndoToast, pendingDelete, showUndoToast, undoDelete } from './blocklists.js';
import { handleTimeChange } from './confirm-modals.js';
import { pad, parseEndTimeBoundedInt, scrollPopoverOptionIntoView } from './time-inputs.js';
import { syncSchedulePanelOverlayControls } from './schedule-overlay.js';
import {
    saveFocusSpaceEditor,
    shouldUseCompactMobileScheduleDayLabels,
} from './app.js';
import { openScheduleOverrideModal, resumePausedSchedule, setBtnActionLabel, setStartBlockBtnLeadingIcon, setStartBtnBlocklistInfo, syncStopBtnLabelFit } from './confirm-modals.js';

export const TIME_SEPARATOR_ARROW_HTML = '<span class="time-separator" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"></path><path d="M13 6l6 6-6 6"></path></svg></span>';

export let pendingSegmentDelete = null;

export function commitSegmentDelete() {
    if (!pendingSegmentDelete) return;
    dismissUndoToast();
    pendingSegmentDelete = null;
}

export function undoSegmentDelete() {
    if (!pendingSegmentDelete) return;
    const { segment, index } = pendingSegmentDelete;
    pendingSegmentDelete = null;
    dismissUndoToast();

    const restored = {
        ...segment,
        days: Array.isArray(segment.days) ? [...segment.days] : segment.days,
    };
    state.scheduleSegments.splice(index, 0, restored);
    sortScheduleSegments();
    const restoredIndex = findScheduleSegmentIndex(restored);

    if (restoredIndex >= 0) {
        expandScheduleSegment(restoredIndex);
    } else {
        rebuildScheduleSegments();
    }

    handleTimeChange();
}

export function handleUndoToastClick() {
    if (pendingSegmentDelete) {
        undoSegmentDelete();
        return;
    }
    undoDelete();
}

function showSegmentDeleteUndoToast(segment, index) {
    showUndoToast(
        tSettings('deleteSegmentUndoToastPrefix'),
        tSettings('deleteSegmentUndoToastEmphasis'),
        '',
        () => commitSegmentDelete(),
    );
    pendingSegmentDelete = { segment, index };
}

function scheduleSegmentsMatch(a, b) {
    return a.startHour === b.startHour
        && a.startMinute === b.startMinute
        && a.endHour === b.endHour
        && a.endMinute === b.endMinute
        && arraysEqual(
            [...(a.days || [])].sort((x, y) => x - y),
            [...(b.days || [])].sort((x, y) => x - y),
        );
}

function findScheduleSegmentIndex(segment) {
    return state.scheduleSegments.findIndex((seg) => scheduleSegmentsMatch(seg, segment));
}
export const SEGMENT_SUMMARY_CLOCK_ICON = '<svg class="segment-summary-clock" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>';
export const SEGMENT_SUMMARY_CHEVRON_ICON = '<svg class="segment-summary-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>';

/** The schedule record of the focus space the editor is showing (none while creating). */
export function getSelectedSchedule() {
    return state.editingBlocklistId && state.appData.schedules
        ? state.appData.schedules.find(s => s.blocklistId === state.editingBlocklistId) || null
        : null;
}

/**
 * Per-schedule opt-in (default off). The editor holds it as a draft until
 * Save writes it onto the schedule record.
 */
export function isAllowEditsBetweenBlocksOn() {
    return !!state.draftAllowEditsBetweenBlocks;
}

/**
 * Turning the opt-in ON is only allowed before the schedule is started, or after
 * it is fully stopped. Pausing is not enough. Turning OFF is always allowed
 * (including mid-enforcement).
 */
export function canEnableAllowEditsBetweenBlocks(schedule = getSelectedSchedule()) {
    return !schedule;
}

/**
 * Active schedule with the opt-in on, and not currently enforcing a time segment
 * (paused schedules count as not enforcing).
 */
export function canEditScheduleBetweenBlocks(schedule = getSelectedSchedule(), nowDate = new Date()) {
    if (!schedule || !schedule.allowEditsBetweenBlocks) return false;
    return !isScheduleSegmentActiveNow(schedule, nowDate);
}

export function isScheduleSegmentMutationBlocked(segmentIndex) {
    if (canEditScheduleBetweenBlocks()) return false;
    return segmentIndex < state.activeScheduleSegmentCount;
}

/** Keep the right-aligned menu fully inside the viewport (nudge only when clipped). */
function positionScheduleStrictnessDropdownMenu(menu) {
    if (!menu || menu.classList.contains('hidden')) return;
    menu.style.transform = '';
    const rect = menu.getBoundingClientRect();
    const pad = 8;
    let dx = 0;
    if (rect.left < pad) dx = pad - rect.left;
    else if (rect.right > window.innerWidth - pad) dx = window.innerWidth - pad - rect.right;
    if (dx) menu.style.transform = `translateX(${dx}px)`;
}

export function syncAllowEditsBetweenBlocksToggle() {
    const btn = document.getElementById('schedule-strictness-dropdown-btn');
    if (!btn) return;
    const flexible = isAllowEditsBetweenBlocksOn();
    const btnText = document.getElementById('schedule-strictness-dropdown-text');
    if (btnText) btnText.textContent = tSettings(flexible ? 'allowEditsFlexibleLabel' : 'allowEditsStrictLabel');
    const menu = document.getElementById('schedule-strictness-dropdown-menu');
    menu?.querySelectorAll('.strictness-option').forEach(opt => {
        opt.classList.toggle('active', (opt.dataset.value === 'flexible') === flexible);
    });
    // Committed + schedule running: switching to flexible needs a full stop first,
    // and "committed" is already selected — so the whole dropdown is locked.
    const locked = !flexible && !canEnableAllowEditsBetweenBlocks();
    // Class-only greying (no native `disabled`) so focus is not stolen.
    btn.classList.toggle('repeat-dropdown-disabled', locked);
    if (locked) menu?.classList.add('hidden');
    const wrapper = document.getElementById('schedule-strictness-dropdown-wrapper');
    if (wrapper) wrapper.title = locked ? tSettings('allowEditsBetweenBlocksLockedTooltip') : '';
}

export function setupAllowEditsBetweenBlocksToggle() {
    const btn = document.getElementById('schedule-strictness-dropdown-btn');
    const menu = document.getElementById('schedule-strictness-dropdown-menu');
    if (!btn || !menu || btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (btn.classList.contains('repeat-dropdown-disabled')) return;
        const isHidden = menu.classList.contains('hidden');
        if (isHidden) closeSchedulePanelDropdownMenus('schedule-strictness-dropdown-menu');
        menu.classList.toggle('hidden');
        if (isHidden) {
            requestAnimationFrame(() => positionScheduleStrictnessDropdownMenu(menu));
            setTimeout(() => {
                document.addEventListener('click', function closeMenu(evt) {
                    if (!menu.contains(evt.target)) {
                        menu.classList.add('hidden');
                        document.removeEventListener('click', closeMenu);
                    }
                });
            }, 10);
        }
    });

    window.addEventListener('resize', () => positionScheduleStrictnessDropdownMenu(menu));

    menu.querySelectorAll('.strictness-option').forEach(opt => {
        opt.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.classList.add('hidden');
            const desired = opt.dataset.value === 'flexible';
            if (desired === isAllowEditsBetweenBlocksOn()) return;
            if (desired && !canEnableAllowEditsBetweenBlocks()) {
                syncAllowEditsBetweenBlocksToggle();
                return;
            }
            state.draftAllowEditsBetweenBlocks = desired;
            syncAllowEditsBetweenBlocksToggle();
            handleTimeChange();
        });
    });
}

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

export function closeSchedulePanelDropdownMenus(exceptMenuId = null) {
    for (const menuId of ['schedule-panel-overlay-dropdown-menu', 'schedule-strictness-dropdown-menu']) {
        if (menuId !== exceptMenuId) {
            document.getElementById(menuId)?.classList.add('hidden');
        }
    }
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
        // Update preview + section summary
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

/**
 * Footer button for Daily / Weekly spaces. A schedule that exists and is not
 * paused shows Stop; otherwise Start (which saves the form, or resumes a
 * paused schedule). The pending-changes bar is owned by focus-space-editor.
 */
export function updateScheduleButtonState() {
    const startScheduleBtn = document.getElementById('start-schedule-btn');
    if (!startScheduleBtn) return;

    const schedule = getSelectedSchedule();
    const paused = isSchedulePausedNow(schedule, Date.now());
    const blocklist = state.editingBlocklistId
        ? state.appData.blocklists.find(bl => bl.id === state.editingBlocklistId)
        : null;
    const btnLabel = startScheduleBtn.querySelector('.btn-label');

    if (schedule && !paused) {
        startScheduleBtn.classList.add('stop-schedule');
        setBtnActionLabel(btnLabel, tSettings('stopScheduleButton'));
        setStartBtnBlocklistInfo(startScheduleBtn, blocklist);
        startScheduleBtn.dataset.activeScheduleId = schedule.id || schedule.blocklistId;
        setStartBlockBtnLeadingIcon(startScheduleBtn, 'stop');
    } else {
        startScheduleBtn.classList.remove('stop-schedule');
        setBtnActionLabel(btnLabel, tSettings('startScheduleButton'));
        setStartBtnBlocklistInfo(startScheduleBtn, blocklist);
        delete startScheduleBtn.dataset.activeScheduleId;
        setStartBlockBtnLeadingIcon(startScheduleBtn, 'enter');
    }
    startScheduleBtn.classList.remove('edit-schedule');
    startScheduleBtn.disabled = !state.editingBlocklistId;

    syncAllowEditsBetweenBlocksToggle();
    syncSchedulePanelOverlayControls();
    syncStopBtnLabelFit(startScheduleBtn);
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

    // Update calendar preview and section summary
    handleTimeChange();
}

// Handle clicking a day toggle within a segment
export function handleSegmentDayToggle(segmentIndex, dayIndex, btn) {
    if (isScheduleSegmentMutationBlocked(segmentIndex)) return;

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

    syncSegmentDayPresetButtons(segmentIndex);
    handleTimeChange();
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
    if (isScheduleSegmentMutationBlocked(index)) return;

    if (state.scheduleSegments.length <= 1) return; // Always keep at least one

    if (pendingSegmentDelete) commitSegmentDelete();
    if (pendingDelete) commitDelete();

    const deletedSegment = {
        ...state.scheduleSegments[index],
        days: [...(state.scheduleSegments[index].days || [])],
    };

    // Remove from state
    state.scheduleSegments.splice(index, 1);

    if (state.expandedScheduleSegmentIndex === index) {
        state.expandedScheduleSegmentIndex = usesScheduleSegmentCollapse() ? -1 : 0;
    } else if (state.expandedScheduleSegmentIndex > index) {
        state.expandedScheduleSegmentIndex -= 1;
    }

    // Rebuild DOM (simpler than updating indices)
    rebuildScheduleSegments();

    handleTimeChange();

    showSegmentDeleteUndoToast(deletedSegment, index);
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

    const betweenBlocksEditable = canEditScheduleBetweenBlocks();
    const allCommitted = state.activeScheduleSegmentCount >= state.scheduleSegments.length && state.activeScheduleSegmentCount > 0;
    // When between-blocks editing is on, keep segments expandable (don't force the
    // locked summary-pill collapse) — but do not auto-open any segment.
    if (allCommitted && !betweenBlocksEditable) {
        state.expandedScheduleSegmentIndex = -1;
        return;
    }

    // -1 = accordion fully collapsed; any other in-range index is an explicit user choice
    // (e.g. summary tap or a newly added segment) — do not reset it on every rebuild.
    if (scheduleHasPendingSegments() && !betweenBlocksEditable) {
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
    if (isScheduleSegmentMutationBlocked(index)) return;
    if (!usesScheduleSegmentCollapse()) return;
    state.expandedScheduleSegmentIndex = index;
    rebuildScheduleSegments();
}

export function collapseExpandedScheduleSegment() {
    if (state.scheduleSegments.length <= 1) return;
    state.expandedScheduleSegmentIndex = -1;
    rebuildScheduleSegments();
}

export function applySegmentDayPreset(segmentIndex, preset) {
    if (isScheduleSegmentMutationBlocked(segmentIndex)) return;
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
    hideDays = false,
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
                ${hideDays ? '' : `<div class="segment-days-group">
                    ${showLabels ? `<label class="time-label">${labelDays}</label>` : ''}
                    <div class="segment-days${useCompactDayLabels ? ' compact-day-labels' : ''}" data-segment-index="${index}">
                        ${dayTogglesHtml}
                    </div>
                </div>`}
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

/**
 * Lock the committed prefix of segments while the schedule is enforcing:
 * `state.activeScheduleSegmentCount` is the number of segments that may only
 * be added to, never changed, until the space is stopped or paused.
 */
export function applyScheduleSegmentLocks(container = document.getElementById('schedule-segments')) {
    if (!container) return;
    const unlocked = canEditScheduleBetweenBlocks();
    container.querySelectorAll('.schedule-segment').forEach((segment, index) => {
        const locked = !unlocked && index < state.activeScheduleSegmentCount;
        segment.classList.toggle('segment-locked', locked);
        segment.querySelectorAll(
            '.time-part, .segment-day-toggle, .remove-segment-btn, .segment-delete-btn, .segment-done-btn, .segment-day-preset, .segment-summary-btn'
        ).forEach(el => { el.disabled = locked; });
    });
}

// Rebuild schedule segments DOM from state. In Daily mode there is exactly one
// segment, rendered without the days row or the multi-segment chrome.
export function rebuildScheduleSegments(container = document.getElementById('schedule-segments')) {
    if (!container) return;
    // Sort chronologically before rebuilding
    sortScheduleSegments();
    normalizeExpandedScheduleSegmentIndex();

    const daily = state.editorKind === 'daily';
    container.innerHTML = '';

    const fullDayLabels = weekdayAbbrevMon0List();
    const useCompactDayLabels = shouldUseCompactMobileScheduleDayLabels();
    const dayLabels = useCompactDayLabels ? weekdayLetterMon0List() : fullDayLabels;
    const labelStart = tSettings('start');
    const labelEnd = tSettings('end');
    const labelDays = tSettings('days');
    const multiSegment = !daily && state.scheduleSegments.length > 1;
    const useCollapse = !daily && usesScheduleSegmentCollapse();

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
                hideDays: daily,
            });
        } else {
            segment.innerHTML = buildScheduleSegmentSummaryHtml(seg, index);
        }

        container.appendChild(segment);
        wireScheduleSegmentElement(segment, index);
    });
    applyScheduleSegmentLocks(container);
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
    if (isScheduleSegmentMutationBlocked(segmentIndex)) return;
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
    if (isScheduleSegmentMutationBlocked(segmentIndex)) return;

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

/**
 * Footer Start / Stop for Daily and Weekly spaces.
 *  - schedule exists and runs  → Stop (override challenge, then paused until turned on again)
 *  - schedule exists, paused   → turn it back on (no challenge: falls toward blocking)
 *  - no schedule yet           → Save the form, which creates and activates it
 */
export async function startSchedule() {
    if (!state.editingBlocklistId) return;
    const schedule = getSelectedSchedule();
    if (schedule) {
        if (isSchedulePausedNow(schedule, Date.now())) {
            await resumePausedSchedule(schedule);
        } else {
            openScheduleOverrideModal(schedule);
        }
        return;
    }
    await saveFocusSpaceEditor();
}
