// Confirm modals: start/pause/resume/override flows, calendar previews,
// blocklist edit modal, modal undo stack. Extracted verbatim from app.js.
import { state } from './state.js';
import { getChallengeController } from './challenge-controller.js';
import { tauriAPI } from './tauri-api.js';
import { escapeHtml, cleanUrlForDisplay, getContrastTextColor, getEnteringChipColor } from './utils.js';
import { tSettings, tSettingsFmt, getSettingsLanguage, weekdayAbbrevMon0List, weekdayLetterMon0List } from './i18n.js';
import { ALWAYS_ON_END_TIME, ensureIOSBlocklistSelectionReady, getBlocklistIOSPayload, getBlocklistIOSScreenTimeSelection, getBlocklistModalLockedApps, getBlocklistRegularApps, isAllowlistBlocklist, isBlockAlwaysOn } from './blocklist-utils.js';
import { formatOverrideMaxDifficultyHint, generateOverrideChallengeText, getMaxOverrideCharsForType, getMinOverrideCountForType, getOverrideEstimatedMinutes, getOverridePreviewText, isMobileOverrideChallengePlatform, normalizeCustomOverrideText, normalizeOverrideCount, sanitizeChallengeTargetText, usesMobileWordCountForOverrideType } from './override-challenge.js';
import { isAndroidAllowlistUnsupported, isSchedulePausedNow, syncActiveBlocksToHelper, syncSchedulesToHelper } from './schedule-engine.js';
import { saveData, updateHostsFile } from './persistence.js';
import { getCalendarSegmentLayout, layoutOverlappingBlocks, render, renderScheduleAlwaysOnRow, renderWeekBlocks, updateWeekCalendar } from './render.js';
import { getRunningEnforcementTarget, isBlocklistEditFrictionRequired, renderBlocklists, truncateBlocklistName } from './blocklists.js';
import { areSegmentsEqual, getSelectedSchedule, isScheduleSegmentActiveNow, canEditScheduleBetweenBlocks } from './schedule-editor.js';
import { closeAllPopovers, pad } from './time-inputs.js';
import { getWhenToBlockKind, isEditorInCreateModal, mountFocusSpaceEditor, notifyEditorChanged, populateFocusSpaceEditor, resyncEditorLockState, returnFocusSpaceEditorToPanel } from './focus-space-editor.js';
import { resetModalScrollPosition, updateBlockedApps, updateOnboardingVisibility, updateWindowHeight, requestScreentimeAuth, isHelperConnectionError } from './blocking-platform.js';
import { resetWebsitesImportMenuPosition } from './website-input.js';
import { bindUiZoomLayoutObserver, scheduleSelectionPromptLayout, scheduleUiZoomResponsiveLayout, usesStackSettingsPlacement } from './theme.js';
import { ensureIOSAllowlistStartable } from './allowlist-ios.js';
import {
    IOS_STOP_BTN_META_COLLAPSE_SLACK_PX, MINUTES_PER_DAY, MAX_SAME_DAY_END_MINUTES,
    clampSameDayMinutes, formatConfirmModalOverrideTypingLine,
    formatMinutesAsHHMM, formatTime, generateId,
    shouldUseCompactMobileScheduleDayLabels, snapMinutesToInterval,
} from './app.js';
import { getDefaultPauseMinutes } from './pause-default.js';
import { getBlocklistDisplayApps, websiteWord } from './list-presentation.js';
import {
    setBlocklistModalMode,
    syncBlocklistCreateUi,
    setConfirmModalBlockingLabel,
    isBlocklistAllowlistMode,
} from './list-mode.js';

export const START_CONFIRM_ICON_GLOBE = `<svg class="start-confirm-blocking-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>`;
export const START_CONFIRM_ICON_APP = `<svg class="start-confirm-blocking-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2"></rect><path d="M10 4v4"></path><path d="M2 8h20"></path><path d="M6 4v4"></path></svg>`;
export const START_FOCUS_SPACE_PLAY_ICON = `<svg class="start-block-btn-play-icon start-block-btn-leading" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
export const STOP_ACTION_SQUARE_ICON = `<svg class="start-block-btn-stop-icon start-block-btn-leading hidden" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"></rect></svg>`;

export function setStartBlockBtnLeadingIcon(btn, mode) {
    if (!btn || (btn.id !== 'start-block-btn' && btn.id !== 'start-schedule-btn')) return;
    const playIcon = btn.querySelector('.start-block-btn-play-icon');
    const appIcon = btn.querySelector('.start-block-btn-app-icon');
    const stopIcon = btn.querySelector('.start-block-btn-stop-icon');
    const isStop = mode === 'stop';
    const startIcon = playIcon || appIcon;
    if (startIcon) startIcon.classList.toggle('hidden', isStop);
    if (stopIcon) stopIcon.classList.toggle('hidden', !isStop);
}

export function setStartConfirmPrimaryLabel(buttonId, text) {
    const btn = document.getElementById(buttonId);
    const label = btn?.querySelector('.start-confirm-primary-label');
    if (label) label.textContent = text;
}

export function buildStartConfirmBlockingLineHtml(type, labels) {
    const icon = type === 'website' ? START_CONFIRM_ICON_GLOBE : START_CONFIRM_ICON_APP;
    const text = labels.map((label) => escapeHtml(label)).join(', ');
    return `<div class="start-confirm-blocking-line">${icon}<span class="start-confirm-blocking-text">${text}</span></div>`;
}

export function formatStartConfirmBlockingListLabels(items, type, maxShow) {
    const labels = type === 'website'
        ? items.map((item) => cleanUrlForDisplay(item))
        : items.slice();
    if (labels.length <= maxShow) return labels;
    return [...labels.slice(0, maxShow), '...'];
}

export function renderStartConfirmBlockingListHtml(blocklist, maxShow) {
    const websites = blocklist?.websites || [];
    const apps = getBlocklistDisplayApps(blocklist);
    const lines = [];

    if (websites.length > 0) {
        lines.push(buildStartConfirmBlockingLineHtml(
            'website',
            formatStartConfirmBlockingListLabels(websites, 'website', maxShow),
        ));
    }
    if (apps.length > 0) {
        lines.push(buildStartConfirmBlockingLineHtml(
            'app',
            formatStartConfirmBlockingListLabels(apps, 'app', maxShow),
        ));
    }

    return lines.join('');
}

export function renderStartConfirmBlockingDetails(blocklist, listEl, showAllBtn, rowEl) {
    if (!listEl || !rowEl) return;

    const websites = blocklist?.websites || [];
    const apps = getBlocklistDisplayApps(blocklist);
    const maxShow = 3;
    const hasOverflow = websites.length > maxShow || apps.length > maxShow;

    if (websites.length === 0 && apps.length === 0) {
        rowEl.classList.add('hidden');
        listEl.innerHTML = '';
        showAllBtn?.classList.add('hidden');
        return;
    }

    rowEl.classList.remove('hidden');
    listEl.innerHTML = renderStartConfirmBlockingListHtml(blocklist, maxShow);

    if (!hasOverflow) {
        showAllBtn?.classList.add('hidden');
        return;
    }

    showAllBtn?.classList.remove('hidden');
    if (showAllBtn) {
        showAllBtn.onclick = () => {
            listEl.innerHTML = renderStartConfirmBlockingListHtml(blocklist, Number.MAX_SAFE_INTEGER);
            showAllBtn.classList.add('hidden');
        };
    }
}

export function setStartConfirmRoomChip(blocklist, {
    chipId = 'start-confirm-room-chip',
    emojiId = 'start-confirm-room-chip-emoji',
    nameId = 'start-confirm-room-chip-name',
} = {}) {
    const chip = document.getElementById(chipId);
    const emojiEl = document.getElementById(emojiId);
    const nameEl = document.getElementById(nameId);
    if (!chip) return;

    if (emojiEl) emojiEl.textContent = blocklist?.emoji || '🎯';
    if (nameEl) nameEl.textContent = blocklist?.name || '';

    chip.style.background = '';
    chip.style.backgroundColor = '';
    chip.style.color = '';
    chip.style.borderColor = '';
}

export const OVERRIDE_CONFIRM_ROOM_CHIP_IDS = {
    chipId: 'override-confirm-room-chip',
    emojiId: 'override-confirm-room-chip-emoji',
    nameId: 'override-confirm-room-chip-name',
};

export const PAUSE_CONFIRM_ROOM_CHIP_IDS = {
    chipId: 'pause-confirm-room-chip',
    emojiId: 'pause-confirm-room-chip-emoji',
    nameId: 'pause-confirm-room-chip-name',
};

export function formatRemainingDurationLabel(remainingMs) {
    const remainingMins = Math.max(1, Math.floor(remainingMs / 60000));
    const hours = Math.floor(remainingMins / 60);
    const mins = remainingMins % 60;
    if (hours > 0 && mins > 0) return `${hours}h ${mins}m`;
    if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''}`;
    return `${mins} minute${mins > 1 ? 's' : ''}`;
}

export function formatStopBlockSubtitle(block) {
    if (!block || isBlockAlwaysOn(block)) return tSettings('stopBlockSubtitleAlways');
    const remaining = formatRemainingDurationLabel(block.endTime - Date.now());
    return tSettingsFmt('stopBlockSubtitleFmt', { remaining });
}

export function populateOverrideConfirmModalContent(blocklist, { block = null, isSchedule = false } = {}) {
    if (!blocklist) return;

    setStartConfirmRoomChip(blocklist, OVERRIDE_CONFIRM_ROOM_CHIP_IDS);

    const titleEl = document.getElementById('override-modal-title');
    if (titleEl) titleEl.textContent = tSettings('stopFocusSpaceTitle');

    const subtitleEl = document.getElementById('override-confirm-subtitle');
    if (subtitleEl) {
        subtitleEl.innerHTML = isSchedule
            ? tSettings('stopScheduleSubtitle')
            : formatStopBlockSubtitle(block);
    }

    setConfirmModalBlockingLabel(blocklist, 'override-confirm-blocking-label');

    renderStartConfirmBlockingDetails(
        blocklist,
        document.getElementById('override-confirm-blocking-list'),
        document.getElementById('override-confirm-show-all-blocking'),
        document.getElementById('override-confirm-blocking-row'),
    );

    setStartConfirmPrimaryLabel('confirm-override-btn', tSettings('stopBlock'));
}

export function formatPauseBlockSubtitle(blocklist, block, { isSchedule = false, isScheduleInactive = false } = {}) {
    const isAllow = isBlocklistAllowlistMode(blocklist);
    if (isScheduleInactive) return tSettings('pauseScheduleInactiveSubtitle');
    if (isSchedule) {
        return tSettings(isAllow ? 'pauseScheduleSubtitleAllow' : 'pauseScheduleSubtitle');
    }
    if (!block || isBlockAlwaysOn(block)) {
        return tSettings(isAllow ? 'pauseBlockSubtitleAllowAlways' : 'pauseBlockSubtitleAlways');
    }
    const remaining = formatRemainingDurationLabel(block.endTime - Date.now());
    return tSettingsFmt('pauseBlockSubtitleFmt', { remaining });
}

export function populatePauseConfirmModalContent(blocklist, {
    block = null,
    isSchedule = false,
    isScheduleInactive = false,
} = {}) {
    if (!blocklist) return;

    setStartConfirmRoomChip(blocklist, PAUSE_CONFIRM_ROOM_CHIP_IDS);

    const titleEl = document.getElementById('pause-modal-title');
    if (titleEl) titleEl.textContent = tSettings('pauseFocusSpaceTitle');

    const subtitleEl = document.getElementById('pause-confirm-subtitle');
    if (subtitleEl) {
        subtitleEl.innerHTML = formatPauseBlockSubtitle(blocklist, block, { isSchedule, isScheduleInactive });
    }

    setConfirmModalBlockingLabel(blocklist, 'pause-confirm-blocking-label');

    renderStartConfirmBlockingDetails(
        blocklist,
        document.getElementById('pause-confirm-blocking-list'),
        document.getElementById('pause-confirm-show-all-blocking'),
        document.getElementById('pause-confirm-blocking-row'),
    );

    setStartConfirmPrimaryLabel('confirm-pause-btn', tSettings('pauseBlock'));
}

export function applyRoomChipTint(chip, accentColor) {
    if (!chip || !accentColor) return;
    if (chip.classList.contains('scheduler-room-chip')) {
        chip.style.backgroundColor = getEnteringChipColor(accentColor);
        chip.style.borderColor = 'transparent';
        chip.style.color = '#ffffff';
        return;
    }
    chip.style.background = `color-mix(in srgb, ${accentColor} 16%, var(--redd-card))`;
    chip.style.borderColor = `color-mix(in srgb, ${accentColor} 32%, var(--redd-border))`;
    chip.style.color = getEnteringChipColor(accentColor);
}

export function setStartConfirmOverrideDescription(options, textElId = 'start-confirm-override-text') {
    const overrideTextEl = document.getElementById(textElId);
    if (!overrideTextEl) return;

    const line = formatConfirmModalOverrideTypingLine(options);
    overrideTextEl.innerHTML = `${line} ${escapeHtml(tSettings('confirmOverrideIntentionSuffix'))}`;
}

// Open override modal for stopping a schedule. Schedules now stop wholesale, identically
// to one-off blocks (no per-instance skip).
export function openScheduleOverrideModal(schedule) {
    window.overrideScheduleId = schedule.id || schedule.blocklistId;

    const blocklist = state.appData.blocklists.find(bl => bl.id === schedule.blocklistId);
    if (!blocklist) return;

    const difficulty = blocklist.overrideDifficulty || { type: 'random-words', count: 50 };
    state.overrideBlockId = null;
    state.overrideBlocklistIdForHelper = null;

    populateOverrideConfirmModalContent(blocklist, { isSchedule: true });
    initializeOverrideModalChallenge(difficulty, blocklist.color);
}

// Something in the When to block section changed: redraw the calendar preview
// for the draft, keep the Always-on row honest, and let the editor refresh its
// summary line and Save / Discard footer.
export function handleTimeChange() {
    document.querySelectorAll('.calendar-block.preview, .calendar-block.active-schedule').forEach(el => el.remove());
    renderScheduleAlwaysOnRow();
    refreshCalendarPreviews();
    notifyEditorChanged();
    updateWindowHeight();
}

// Re-draw the in-flight schedule preview after renderWeekBlocks() clears day
// tracks (window focus, colour change, calendar rebuild).
export function refreshCalendarPreviews() {
    if (!state.selectedBlocklistId || isEditorInCreateModal()) return;
    if (getWhenToBlockKind() === 'manual') return;
    renderSchedulePreview();
}

// Pointer-based drag session for calendar preview blocks (mouse + touch on iPad).
export function bindPointerDragSession(element, { onStart, onMove, onEnd }) {
    element.addEventListener('pointerdown', (e) => {
        if (!e.isPrimary || e.button !== 0) return;
        if (onStart(e) === false) return;

        const captureEl = e.currentTarget;
        try {
            captureEl.setPointerCapture?.(e.pointerId);
        } catch (_) { /* ignore */ }

        e.preventDefault();

        const onPointerMove = (moveEvent) => {
            if (moveEvent.pointerId !== e.pointerId) return;
            moveEvent.preventDefault();
            onMove(moveEvent);
        };

        const endSession = (endEvent) => {
            if (endEvent.pointerId !== e.pointerId) return;
            document.removeEventListener('pointermove', onPointerMove);
            document.removeEventListener('pointerup', endSession);
            document.removeEventListener('pointercancel', endSession);
            try {
                if (captureEl.hasPointerCapture?.(e.pointerId)) {
                    captureEl.releasePointerCapture(e.pointerId);
                }
            } catch (_) { /* ignore */ }
            onEnd(endEvent);
        };

        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', endSession);
        document.addEventListener('pointercancel', endSession);
    });
}

// Preview the draft segments of the selected space on the calendar. Segments
// that already exist on the saved schedule are drawn by
// renderScheduledCalendarBlocks, so only the ones that differ are previewed.
export function renderSchedulePreview() {
    if (!state.selectedBlocklistId) return;

    const blocklist = state.appData.blocklists.find(bl => bl.id === state.selectedBlocklistId);
    if (!blocklist) return;

    const committed = getSelectedSchedule()?.segments || [];
    (state.scheduleSegments || []).forEach((segment, segmentIndex) => {
        if (committed.some(seg => areSegmentsEqual(seg, segment))) return;
        (segment.days || []).forEach(dayIndex => {
            renderPreviewSegmentOnWeekday(blocklist, segment, segmentIndex, dayIndex);
        });
    });

    layoutOverlappingBlocks();
}

// Build a preview block element for a schedule segment on a specific weekday.
// Overnight segments split: head from start..24:00 on this weekday, tail from 00:00..end
// on the next weekday (wrapping Sun → Mon).
export function renderPreviewSegmentOnWeekday(blocklist, segment, segmentIndex, dayIndex) {
    const track = document.querySelector(`.day-track[data-day-index="${dayIndex}"]`);
    if (!track) return;

    const startMinutes = segment.startHour * 60 + segment.startMinute;
    const endMinutes = segment.endHour * 60 + segment.endMinute;
    const isOvernight = endMinutes <= startMinutes;

    const startTimeStr = `${String(segment.startHour).padStart(2, '0')}:${String(segment.startMinute).padStart(2, '0')}`;
    const endTimeStr = `${String(segment.endHour).padStart(2, '0')}:${String(segment.endMinute).padStart(2, '0')}`;

    if (isOvernight) {
        const left1 = (startMinutes / 1440) * 100;
        const width1 = Math.max(0.5, ((1440 - startMinutes) / 1440) * 100);
        track.appendChild(buildPreviewBlockElement({
            blocklist, segmentIndex, dayIndex,
            leftPct: left1, widthPct: width1,
            startTimeStr, endTimeStr,
            isContinuation: false
        }));

        const nextDayIndex = (dayIndex + 1) % 7;
        const nextTrack = document.querySelector(`.day-track[data-day-index="${nextDayIndex}"]`);
        if (nextTrack) {
            const width2 = Math.max(0.5, (endMinutes / 1440) * 100);
            nextTrack.appendChild(buildPreviewBlockElement({
                blocklist, segmentIndex, dayIndex: nextDayIndex,
                leftPct: 0, widthPct: width2,
                startTimeStr, endTimeStr,
                isContinuation: true
            }));
        }
    } else {
        const left = (startMinutes / 1440) * 100;
        const width = Math.max(0.5, ((endMinutes - startMinutes) / 1440) * 100);
        track.appendChild(buildPreviewBlockElement({
            blocklist, segmentIndex, dayIndex,
            leftPct: left, widthPct: width,
            startTimeStr, endTimeStr,
            isContinuation: false
        }));
    }
}

// Construct a single preview block element for one weekday slot. Drag/resize handlers are
// only attached to the head element (not the overnight tail) so that a drag operates on
// the original anchor weekday.
export function buildPreviewBlockElement({ blocklist, segmentIndex, dayIndex, leftPct, widthPct, startTimeStr, endTimeStr, isContinuation }) {
    const previewEl = document.createElement('div');
    previewEl.className = `calendar-block preview interactive${isContinuation ? ' overnight-continuation' : ''}`;
    previewEl.style.left = `${leftPct}%`;
    previewEl.style.width = `${widthPct}%`;
    previewEl.dataset.previewGroupId = `preview-segment-${segmentIndex}`;
    previewEl.dataset.segmentIndex = segmentIndex;
    previewEl.dataset.dayIndex = dayIndex;
    if (isContinuation) previewEl.dataset.continuation = '1';

    if (blocklist.color) {
        previewEl.style.background = blocklist.color;
        previewEl.style.color = getContrastTextColor(blocklist.color);
    }

    // Resize handles run vertically along the start/end edges. Continuation (tail) blocks
    // don't get handles — the user adjusts the segment by dragging the head block.
    const resizeHandles = !isContinuation ? `
        <div class="resize-handle resize-handle-start" data-handle="start" title="Drag to change start time"></div>
        <div class="resize-handle resize-handle-end" data-handle="end" title="Drag to change end time"></div>
    ` : '';

    previewEl.innerHTML = `
        ${resizeHandles}
        <span class="block-emoji">${blocklist.emoji || '🚫'}</span>
        <span class="block-label">${escapeHtml(blocklist.name)}</span>
        <span class="block-time">${startTimeStr} - ${endTimeStr}</span>
    `;

    if (!isContinuation) {
        const track = document.querySelector(`.day-track[data-day-index="${dayIndex}"]`);
        if (track) attachPreviewBlockDragHandlers(previewEl, segmentIndex, track);
    }

    return previewEl;
}

// Attach drag and resize handlers to a preview block.
//
// In the row-based layout time flows horizontally and days stack vertically:
//   - dragging the body of the block: horizontal motion changes start/end time, vertical
//     motion (cursor over a different row) changes the day(s) of the segment.
//   - dragging the .resize-handle-start: adjusts start time (left edge).
//   - dragging the .resize-handle-end: adjusts end time (right edge).
export function attachPreviewBlockDragHandlers(previewEl, segmentIndex, track) {
    let isDragging = false;
    let isResizing = false;
    let resizeHandle = null;
    let startX = 0;
    let startY = 0;
    let startLeftPct = 0;
    let startWidthPct = 0;
    let startDayIndex = null;
    let currentHoverTrack = track;
    let clickOffsetY = 0; // Offset from row center where user clicked (helps day-boundary detection)
    const snapMinutes = 15;
    const minDurationMinutes = 15;

    function getDayIndexFromTrack(trackEl) {
        if (!trackEl) return null;
        const raw = trackEl.dataset.dayIndex;
        if (raw === undefined || raw === null || raw === '') return null;
        const idx = parseInt(raw, 10);
        return Number.isInteger(idx) && idx >= 0 && idx <= 6 ? idx : null;
    }

    startDayIndex = getDayIndexFromTrack(track);

    function snapToInterval(minutes) {
        return snapMinutesToInterval(minutes, snapMinutes);
    }

    function minutesToTime(totalMinutes) {
        const clamped = clampSameDayMinutes(totalMinutes);
        return {
            hours: Math.floor(clamped / 60),
            minutes: clamped % 60,
        };
    }

    function updateSegmentTimesAndDays(newStartMinutes, newEndMinutes, dayShift = 0) {
        if (newEndMinutes - newStartMinutes < minDurationMinutes) return;

        const startTime = minutesToTime(newStartMinutes);
        const endTime = minutesToTime(newEndMinutes);

        state.scheduleSegments[segmentIndex].startHour = startTime.hours;
        state.scheduleSegments[segmentIndex].startMinute = startTime.minutes;
        state.scheduleSegments[segmentIndex].endHour = endTime.hours;
        state.scheduleSegments[segmentIndex].endMinute = endTime.minutes;

        if (dayShift !== 0) {
            const segment = state.scheduleSegments[segmentIndex];
            const oldDays = segment.days || [];
            const newDays = oldDays.map(d => {
                let newDay = d + dayShift;
                if (newDay < 0) newDay += 7;
                if (newDay > 6) newDay -= 7;
                return newDay;
            });
            segment.days = newDays;
            updateDayToggleUI(segmentIndex);
        }

        updateTimePickerUI(segmentIndex);

        document.querySelectorAll('.calendar-block.preview').forEach(el => el.remove());
        renderSchedulePreview();
    }

    function updateTimePickerUI(index) {
        const segment = state.scheduleSegments[index];
        const startHourEl = document.querySelector(`[data-target="schedule-start-${index}"][data-type="hour"]`);
        const startMinEl = document.querySelector(`[data-target="schedule-start-${index}"][data-type="minute"]`);
        const endHourEl = document.querySelector(`[data-target="schedule-end-${index}"][data-type="hour"]`);
        const endMinEl = document.querySelector(`[data-target="schedule-end-${index}"][data-type="minute"]`);

        if (startHourEl && document.activeElement !== startHourEl) {
            startHourEl.value = pad(segment.startHour);
        }
        if (startMinEl && document.activeElement !== startMinEl) {
            startMinEl.value = pad(segment.startMinute);
        }
        if (endHourEl && document.activeElement !== endHourEl) {
            endHourEl.value = pad(segment.endHour);
        }
        if (endMinEl && document.activeElement !== endMinEl) {
            endMinEl.value = pad(segment.endMinute);
        }
    }

    function updateDayToggleUI(index) {
        const segment = state.scheduleSegments[index];
        const days = segment.days || [];
        const segmentContainer = document.querySelector(`.schedule-segment[data-segment-index="${index}"]`);
        if (!segmentContainer) return;

        const dayButtons = segmentContainer.querySelectorAll('.segment-day-toggle');
        dayButtons.forEach(btn => {
            const dayIndex = parseInt(btn.dataset.day);
            btn.classList.toggle('active', days.includes(dayIndex));
        });
    }

    // Cursor hover hint on resize handles (pointer events work for mouse; touch skips hover)
    previewEl.querySelectorAll('.resize-handle').forEach(handle => {
        handle.addEventListener('pointerenter', () => previewEl.classList.add('resize-hover'));
        handle.addEventListener('pointerleave', () => previewEl.classList.remove('resize-hover'));
    });

    // Recompute "HH:MM - HH:MM" from the head's current left%/width% and write it onto
    // every preview block belonging to this segment (head + overnight tails). Matches the
    // formula used on mouseup so what the user sees mid-drag is what gets committed.
    function updateLiveTimeText() {
        const headBlocks = getHeadPreviewBlocks();
        if (headBlocks.length === 0) return;
        const head = headBlocks[0];
        const leftPct = parseFloat(head.style.left) || 0;
        const widthPct = parseFloat(head.style.width) || 0;
        const startMins = (leftPct / 100) * 1440;
        const endMins = ((leftPct + widthPct) / 100) * 1440;
        const text = `${formatMinutesAsHHMM(startMins)} - ${formatMinutesAsHHMM(endMins)}`;
        document.querySelectorAll(
            `.calendar-block.preview[data-segment-index="${segmentIndex}"] .block-time`
        ).forEach(el => { el.textContent = text; });
    }

    bindPointerDragSession(previewEl, {
        onStart(e) {
            const handle = e.target.closest('.resize-handle');
            if (handle) {
                isResizing = true;
                resizeHandle = handle.dataset.handle;
                previewEl.classList.add('resizing');
                document.body.style.cursor = 'ew-resize';
            } else {
                isDragging = true;
                previewEl.classList.add('dragging');
                document.body.style.cursor = 'grabbing';
            }

            startX = e.clientX;
            startY = e.clientY;
            startLeftPct = parseFloat(previewEl.style.left) || 0;
            startWidthPct = parseFloat(previewEl.style.width) || 0;
            currentHoverTrack = track;

            const trackRect = track.getBoundingClientRect();
            const trackCenterY = trackRect.top + trackRect.height / 2;
            clickOffsetY = e.clientY - trackCenterY;
        },
        onMove: handlePointerMove,
        onEnd: handlePointerUp
    });

    // Only "head" preview blocks (not overnight tails) are manipulated during a drag —
    // tails are redrawn from the segment's new times on mouseup via renderSchedulePreview.
    function getHeadPreviewBlocks() {
        return document.querySelectorAll(
            `.calendar-block.preview[data-segment-index="${segmentIndex}"]:not([data-continuation])`
        );
    }

    function handlePointerMove(e) {
        const trackRect = track.getBoundingClientRect();
        if (trackRect.width <= 0) return;

        const deltaX = e.clientX - startX;
        const deltaPct = (deltaX / trackRect.width) * 100;
        const headBlocks = getHeadPreviewBlocks();

        if (isDragging) {
            // Move horizontally — clamp so the block stays within [0, 100]%
            const maxLeftPct = 100 - startWidthPct;
            const newLeftPct = Math.max(0, Math.min(maxLeftPct, startLeftPct + deltaPct));

            headBlocks.forEach(block => {
                block.style.left = `${newLeftPct}%`;
                block.classList.add('dragging');
            });

            // Move vertically (across day rows)
            const allTracks = Array.from(document.querySelectorAll('.day-track'));
            const effectiveY = e.clientY - clickOffsetY;
            let targetTrackIndex = -1;
            for (let i = 0; i < allTracks.length; i++) {
                const rect = allTracks[i].getBoundingClientRect();
                if (effectiveY >= rect.top && effectiveY <= rect.bottom) {
                    targetTrackIndex = i;
                    currentHoverTrack = allTracks[i];
                    break;
                }
            }

            if (targetTrackIndex >= 0) {
                const originalTrackIndex = allTracks.indexOf(track);
                const dayShiftDuringDrag = targetTrackIndex - originalTrackIndex;

                headBlocks.forEach(block => {
                    if (!block.dataset.originalTrackIndex) {
                        block.dataset.originalTrackIndex = allTracks.indexOf(block.parentElement);
                    }
                    const blockOriginalIndex = parseInt(block.dataset.originalTrackIndex);
                    const newTrackIndex = blockOriginalIndex + dayShiftDuringDrag;
                    if (newTrackIndex >= 0 && newTrackIndex < allTracks.length) {
                        if (allTracks[newTrackIndex] !== block.parentElement) {
                            allTracks[newTrackIndex].appendChild(block);
                        }
                    }
                });
            }
        } else if (isResizing) {
            if (resizeHandle === 'start') {
                const newLeftPct = Math.max(0, startLeftPct + deltaPct);
                const newWidthPct = startWidthPct - (newLeftPct - startLeftPct);
                if (newWidthPct >= 0.5) {
                    headBlocks.forEach(block => {
                        block.style.left = `${newLeftPct}%`;
                        block.style.width = `${newWidthPct}%`;
                    });
                }
            } else if (resizeHandle === 'end') {
                const maxEndPct = (MAX_SAME_DAY_END_MINUTES / MINUTES_PER_DAY) * 100;
                const maxWidthPct = Math.max(0.5, maxEndPct - startLeftPct);
                const newWidthPct = Math.max(0.5, Math.min(maxWidthPct, startWidthPct + deltaPct));
                headBlocks.forEach(block => {
                    block.style.width = `${newWidthPct}%`;
                });
            }
        }

        updateLiveTimeText();
    }

    function handlePointerUp() {
        getHeadPreviewBlocks().forEach(block => {
            block.classList.remove('dragging');
            block.classList.remove('resizing');
            delete block.dataset.originalTrackIndex;
        });
        document.body.style.cursor = '';

        if (isDragging || isResizing) {
            const finalLeftPct = parseFloat(previewEl.style.left) || 0;
            const finalWidthPct = parseFloat(previewEl.style.width) || 0;

            const newStartMinutes = snapToInterval((finalLeftPct / 100) * 1440);
            const newEndMinutes = snapToInterval(((finalLeftPct + finalWidthPct) / 100) * 1440);

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

function usesMobilePhoneEnterSchedulerModal() {
    return document.body.classList.contains('mobile-phone-home');
}

/**
 * Full-screen enter sheet: mobile phones always; desktop when the grid is
 * single-column (≤718px). iPad keeps its existing inline enter UI.
 */
export function usesEnterSchedulerSheet() {
    if (usesMobilePhoneEnterSchedulerModal()) return true;
    if (
        document.body.classList.contains('ios')
        || document.body.classList.contains('android')
        || document.body.classList.contains('handset-device')
    ) {
        return false;
    }
    return usesStackSettingsPlacement();
}

export function isMobilePhoneDevice() {
    return usesMobilePhoneEnterSchedulerModal();
}

// Keep the old export name for callers outside the main render path.
export function isIOSPhoneDevice() {
    return isMobilePhoneDevice();
}

/** Selected border + entering chip on the card; never while enter lives in a full-screen sheet. */
export function isBlocklistCardVisuallySelected(blocklistId) {
    if (usesEnterSchedulerSheet()) return false;
    return blocklistId === state.selectedBlocklistId;
}

export function isEnterSchedulerModalOpen() {
    return usesEnterSchedulerSheet()
        && document.body.classList.contains('enter-scheduler-modal-open');
}

/** Live enter-tab root — modal sheet when sheet mode is active, inline scheduler elsewhere. */
export function getLiveTimePickerContainer() {
    const inModal = document.querySelector('#enter-scheduler-modal .mobile-modal-scroll-body #time-picker-container');
    if (inModal) return inModal;
    return document.querySelector('#scheduler-section .scheduler-content #time-picker-container');
}

function clearSchedulerPlaceholderMeasurer() {
    const measurer = document.getElementById('scheduler-placeholder-measurer');
    if (measurer) measurer.innerHTML = '';
}

function getEnterSchedulerModal() {
    return document.getElementById('enter-scheduler-modal');
}

function getTimePickerHome() {
    return document.querySelector('#scheduler-section .scheduler-content');
}

function getEnterSchedulerScrollBody() {
    return getEnterSchedulerModal()?.querySelector('.mobile-modal-scroll-body');
}

function syncEnterSchedulerModalTitle(blocklist) {
    const titleEl = document.getElementById('enter-scheduler-modal-title');
    if (!titleEl || !blocklist) return;
    titleEl.textContent = tSettings('editFocusSpace');
}

function ensureEnterSchedulerModalChrome() {
    const modal = getEnterSchedulerModal();
    const content = modal?.querySelector('.modal-content');
    const titleSource = content?.querySelector('h3');
    if (!modal || !content || !titleSource) return null;

    modal.classList.add('mobile-fullscreen-modal');
    titleSource.classList.add('mobile-modal-title-source');

    let header = content.querySelector('.mobile-modal-header');
    if (!header) {
        header = document.createElement('div');
        header.className = 'mobile-modal-header';

        const backButton = document.createElement('button');
        backButton.type = 'button';
        backButton.className = 'mobile-modal-back-btn';
        backButton.setAttribute('aria-label', 'Back');
        backButton.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M15 18l-6-6 6-6"></path>
            </svg>
        `;
        backButton.addEventListener('click', () => {
            const dismissButton = modal.querySelector('#cancel-enter-scheduler-btn');
            if (dismissButton) dismissButton.click();
            else deselectBlocklist();
        });

        const headerTitle = document.createElement('div');
        headerTitle.className = 'mobile-modal-header-title';
        const syncHeaderTitle = () => {
            const nextTitle = titleSource.textContent?.trim() || '';
            headerTitle.textContent = nextTitle;
            backButton.setAttribute('aria-label', nextTitle ? `Back from ${nextTitle}` : 'Back');
        };
        syncHeaderTitle();
        new MutationObserver(syncHeaderTitle).observe(titleSource, {
            childList: true,
            characterData: true,
            subtree: true,
        });

        header.append(backButton, headerTitle);
        content.prepend(header);
    }

    let scrollBody = content.querySelector('.mobile-modal-scroll-body');
    if (!scrollBody) {
        scrollBody = document.createElement('div');
        scrollBody.className = 'mobile-modal-scroll-body';
        while (header.nextSibling) {
            scrollBody.appendChild(header.nextSibling);
        }
        content.appendChild(scrollBody);
    }

    return scrollBody;
}

function openEnterSchedulerModal() {
    const modal = getEnterSchedulerModal();
    const home = getTimePickerHome();
    if (!modal || !home) return;

    // Desktop sheet must always paint as the mobile full-screen chrome (not a dialog).
    if (!usesMobilePhoneEnterSchedulerModal()) {
        document.body.classList.add('desktop-compact-layout', 'enter-scheduler-sheet-layout');
    }

    const scrollBody = ensureEnterSchedulerModalChrome();
    const timePicker = getLiveTimePickerContainer();
    if (!scrollBody || !timePicker) return;

    clearSchedulerPlaceholderMeasurer();

    if (timePicker.parentElement !== scrollBody) {
        scrollBody.appendChild(timePicker);
    }
    modal.classList.remove('hidden');
    document.body.classList.add('enter-scheduler-modal-open');
    resetModalScrollPosition(modal);
}

function closeEnterSchedulerModal() {
    const modal = getEnterSchedulerModal();
    const timePicker = getLiveTimePickerContainer();
    const home = getTimePickerHome();
    if (!modal || !timePicker || !home) return;

    if (timePicker.parentElement !== home) {
        home.appendChild(timePicker);
    }
    modal.classList.add('hidden');
    document.body.classList.remove('enter-scheduler-modal-open');
}

function syncEnterSchedulerModal(blocklist, { openEnterUi = false } = {}) {
    if (!usesEnterSchedulerSheet()) {
        if (document.body.classList.contains('enter-scheduler-modal-open')) {
            closeEnterSchedulerModal();
        }
        return;
    }
    if (state.selectedBlocklistId && blocklist && openEnterUi) {
        syncEnterSchedulerModalTitle(blocklist);
        openEnterSchedulerModal();
    } else {
        closeEnterSchedulerModal();
    }
}

/** Keep desktop single-column on the same sheet/modal path as iPhone when crossing 718px. */
let lastEnterSchedulerSheetMode = null;
export function syncEnterSchedulerSheetLayout() {
    const sheet = usesEnterSchedulerSheet();
    // Desktop-only body class: list-only home + fullscreen enter/settings/create.
    document.body.classList.toggle(
        'desktop-compact-layout',
        sheet && !usesMobilePhoneEnterSchedulerModal(),
    );
    // Legacy alias kept for any interim selectors.
    document.body.classList.toggle(
        'enter-scheduler-sheet-layout',
        sheet && !usesMobilePhoneEnterSchedulerModal(),
    );

    const changed = lastEnterSchedulerSheetMode !== null && lastEnterSchedulerSheetMode !== sheet;
    lastEnterSchedulerSheetMode = sheet;

    if (!sheet) {
        if (document.body.classList.contains('enter-scheduler-modal-open')) {
            closeEnterSchedulerModal();
        }
        if (changed) renderBlocklists();
        return;
    }

    if (changed) {
        renderBlocklists();
        if (state.selectedBlocklistId) {
            const blocklist = state.appData.blocklists.find((bl) => bl.id === state.selectedBlocklistId);
            if (blocklist) {
                syncEnterSchedulerModalTitle(blocklist);
                openEnterSchedulerModal();
            }
        }
    }
}

/** Start-a-block heading + Now/Schedule tabs — only meaningful once a blocklist is chosen. */
export function syncSchedulerChromeVisibility() {
    const gridTopRow = document.querySelector('.grid-top-row');
    const hasLists = (state.appData.blocklists?.length || 0) > 0;
    const show = hasLists && !!state.selectedBlocklistId;
    if (gridTopRow) gridTopRow.classList.toggle('grid-top-row--blocklist-selected', show);
    bindUiZoomLayoutObserver();
    scheduleUiZoomResponsiveLayout();
    scheduleSelectionPromptLayout();
}

/** Re-sync the hidden dropdown and scheduler chrome from a focus-space id.
 *  Use after render() when pause/stop/start may have rebuilt the <select>. */
export function refreshSelectedBlocklistUi(blocklistId = state.selectedBlocklistId) {
    if (!blocklistId) return;
    if (!state.appData.blocklists.some((bl) => bl.id === blocklistId)) return;
    state.selectedBlocklistId = blocklistId;
    const blocklistSelect = document.getElementById('blocklist-select');
    if (!blocklistSelect) return;
    blocklistSelect.value = blocklistId;
    handleBlocklistSelect({ target: blocklistSelect });
}

// Handle blocklist selection: the panel shows the editor for the selected
// space. Re-selecting the space already loaded only refreshes its lock state,
// so in-flight edits survive a pause / stop; selecting another space drops them.
// Enter sheet (iPhone, or desktop ≤718px) only opens when openEnterUi is true.
export function handleBlocklistSelect(e, { openEnterUi = false } = {}) {
    if (state.suppressBlocklistSelectChange) return;
    const newBlocklistId = e.target.value || null;

    state.selectedBlocklistId = newBlocklistId;
    if (newBlocklistId) state.userExplicitlyDeselected = false;

    const timePicker = document.getElementById('time-picker-container');
    const passwordHint = document.getElementById('password-hint');
    const selectionPrompt = document.getElementById('selection-prompt');
    const selectedBlocklist = state.selectedBlocklistId
        ? state.appData.blocklists.find((bl) => bl.id === state.selectedBlocklistId) || null
        : null;

    if (selectedBlocklist) {
        if (selectionPrompt) selectionPrompt.classList.add('hidden');
        timePicker?.classList.remove('hidden');
        if (passwordHint) passwordHint.classList.remove('hidden');
        // While the create modal borrows the editor, leave it alone; closing the
        // modal repopulates it for the selection.
        if (!isEditorInCreateModal()) {
            if (state.editingBlocklistId === selectedBlocklist.id) {
                resyncEditorLockState(selectedBlocklist);
            } else {
                populateFocusSpaceEditor(selectedBlocklist);
            }
        }
    } else {
        if (selectionPrompt && !isMobilePhoneDevice()) selectionPrompt.classList.remove('hidden');
        else if (selectionPrompt) selectionPrompt.classList.add('hidden');
        timePicker?.classList.add('hidden');
        if (passwordHint) passwordHint.classList.add('hidden');
        if (!isEditorInCreateModal()) state.editingBlocklistId = null;
    }

    syncSchedulerChromeVisibility();

    // Update visual selection state on blocklist cards
    renderBlocklists();

    handleTimeChange(); // Calendar preview + editor footer

    syncEnterSchedulerModal(selectedBlocklist, { openEnterUi });

    // Wait for DOM reflow to capture the correct height after showing/hiding elements
    setTimeout(() => {
        updateWindowHeight();
    }, 50);
}

// Deselect current blocklist (same behavior as clicking on background).
// Used by click-outside handler and ESC key.
export function deselectBlocklist() {
    if (!state.selectedBlocklistId) return;
    state.userExplicitlyDeselected = true;
    state.selectedBlocklistId = null;
    const blocklistSelect = document.getElementById('blocklist-select');
    blocklistSelect.value = '';
    handleBlocklistSelect({ target: blocklistSelect });
}

/**
 * Turn a Manual space on: create its always-on block and enforce it. No
 * confirmation step — the effort barrier is on the way out, not in. Returns
 * true on success; failures alert and leave the data untouched.
 */
export async function startManualBlock(blocklistId) {
    const blocklist = state.appData.blocklists.find(bl => bl.id === blocklistId);
    if (!blocklist) return false;
    if (isAndroidAllowlistUnsupported(blocklist)) {
        alert(tSettings('androidAllowlistUnsupported'));
        return false;
    }
    if (!ensureIOSBlocklistSelectionReady(blocklist, 'starting this block')) return false;
    if (!await ensureIOSAllowlistStartable(blocklist)) return false;

    const block = {
        id: generateId(),
        blocklistId,
        startTime: Date.now(),
        endTime: ALWAYS_ON_END_TIME,
        isAlwaysOn: true,
    };

    let result;

    if (state.isIOS) {
        if (!state.screentimeAuthorized) {
            const authResult = await requestScreentimeAuth();
            if (!authResult.granted) {
                if (authResult.status === 'denied') {
                    alert('Screen Time authorization was denied. Please go to Settings > Screen Time > Digital Habits: Blocker and enable access.');
                } else if (authResult.error) {
                    alert('Screen Time authorization failed: ' + authResult.error);
                } else {
                    alert('Screen Time authorization is required to block websites. Please try again.');
                }
                updateOnboardingVisibility();
                return false;
            }
            updateOnboardingVisibility();
        }
        try {
            state.appData.activeBlocks.push(block);
            state.activatedBlockIds.add(block.id);
            const updateResult = await updateHostsFile();
            if (!updateResult.success) {
                state.appData.activeBlocks = state.appData.activeBlocks.filter(b => b.id !== block.id);
                state.activatedBlockIds.delete(block.id);
                result = { success: false, error: updateResult.error || 'Failed to update blocking' };
            } else {
                result = { success: true };
            }
        } catch (err) {
            state.appData.activeBlocks = state.appData.activeBlocks.filter(b => b.id !== block.id);
            state.activatedBlockIds.delete(block.id);
            result = { success: false, error: err.toString() };
        }
    } else if (state.isAndroid) {
        // Android: push locally, sync (creates the MANUAL Schedule entity in
        // Kotlin), then explicitly start the session — set_schedules alone
        // doesn't activate a MANUAL schedule, see syncSchedulesToHelper.
        try {
            state.appData.activeBlocks.push(block);
            await saveData();
            await syncSchedulesToHelper();
            const startResult = await tauriAPI.androidStartManualBlock(block.id, null);
            if (!startResult.success) {
                state.appData.activeBlocks = state.appData.activeBlocks.filter(b => b.id !== block.id);
                await saveData();
                result = { success: false, error: startResult.error || 'Failed to start block' };
            } else {
                result = { success: true };
            }
        } catch (err) {
            state.appData.activeBlocks = state.appData.activeBlocks.filter(b => b.id !== block.id);
            await saveData();
            result = { success: false, error: err.toString() };
        }
    } else {
        // Desktop: persist the block locally first so save_data and the
        // native-messaging host see it immediately.
        state.appData.activeBlocks.push(block);
        state.activatedBlockIds.add(block.id);
        if (state.helperAvailable) {
            const status = await tauriAPI.checkHelperStatus();
            if (!status.running || !status.version_ok) {
                state.helperAvailable = false;
            }
        }
        // v2: the app process IS the helper. startBlockViaHelper is a no-op
        // shim; extension blocking follows from save_data below.
        result = await tauriAPI.startBlockViaHelper({
            domains: blocklist.websites || [],
            endTime: block.endTime,
            blocklistId,
        });
    }

    if (!result.success) {
        if (!state.isIOS) {
            state.appData.activeBlocks = state.appData.activeBlocks.filter(b => b.id !== block.id);
            state.activatedBlockIds.delete(block.id);
        }
        if (!result.cancelled) {
            if (isHelperConnectionError(result.error)) {
                state.helperAvailable = false;
                alert('The block service isn\'t running. Please open Settings, remove the helper, then try starting a block again to reinstall it.');
            } else {
                alert('Could not start block: ' + (result.error || 'Unknown error'));
            }
        }
        return false;
    }

    await saveData();
    await updateBlockedApps();
    render();
    refreshSelectedBlocklistUi();
    return true;
}

export function applyModalBlocklistTint(hexColor) {
    const modal = document.getElementById('focus-space-editor');
    if (!modal) return;
    if (typeof hexColor === 'string' && hexColor.startsWith('#')) {
        modal.style.setProperty('--blocklist-tint', hexColor);
        modal.style.setProperty('--blocklist-tag-text', getContrastTextColor(hexColor));
    } else {
        modal.style.removeProperty('--blocklist-tint');
        modal.style.removeProperty('--blocklist-tag-text');
    }
}

export function openBlocklistEditPauseModal(blocklistId = state.editingBlocklistId) {
    const target = getRunningEnforcementTarget(blocklistId);
    if (!target) return;

    if (target.type === 'block') {
        state.pauseScheduleData = null;
        openPauseModal(target.block.id);
        return;
    }

    state.pauseScheduleData = {
        blocklistId,
        isActiveNow: isScheduleSegmentActiveNow(target.schedule),
        frictionless: canEditScheduleBetweenBlocks(target.schedule),
    };
    openPauseModal(null);
}

/**
 * Swap the modal's locked-item sets without touching what the user has typed
 * into it. setModalData rebuilds the working lists from saved data, which is
 * right when the modal opens and wrong when we re-sync an already-open modal:
 * an item added before hitting Pause would vanish with no message.
 */
function applyModalLockedItems(lockedWebsitesList, lockedAppsList) {
    window.lockedWebsites = lockedWebsitesList;
    window.lockedApps = lockedAppsList;
    window.renderModalTags?.();
}

/**
 * @param {object|null} blocklist
 * @param {number} now
 * @param {{ preserveModalItems?: boolean }} options - set when re-syncing a
 *   modal that is already open, so in-progress edits survive the refresh.
 */
export function syncBlocklistEditFrictionUi(blocklist, now = Date.now(), { preserveModalItems = false } = {}) {
    const isActive = isBlocklistEditFrictionRequired(blocklist?.id, now);
    const warningEl = document.getElementById('active-blocklist-warning');
    const pauseBtn = document.getElementById('active-blocklist-pause-btn');
    const overrideInputs = [
        document.getElementById('override-type'),
        document.getElementById('override-count'),
        document.getElementById('custom-override-text'),
        document.getElementById('override-max-difficulty-checkbox')
    ];
    const maxDifficultyWrap = document.getElementById('override-max-difficulty-wrap');
    const overrideTypeSelect = document.getElementById('override-type');
    const overrideCountInput = document.getElementById('override-count');
    const overrideCountWrapperEl = document.getElementById('override-count-wrapper');
    const overrideMethodRowEl = document.getElementById('override-method-row');
    const overridePreviewBlockEl = document.getElementById('override-preview-block');
    const overrideTimeEstimateEl = document.getElementById('override-count-time-estimate');

    const runningTarget = getRunningEnforcementTarget(blocklist?.id, now);

    const canPauseToEdit = isActive && !!runningTarget;
    pauseBtn?.classList.toggle('hidden', !canPauseToEdit);
    if (pauseBtn) {
        pauseBtn.onclick = canPauseToEdit
            ? () => openBlocklistEditPauseModal(blocklist.id)
            : null;
    }

    if (isActive) {
        warningEl.classList.remove('hidden');
        overrideInputs.forEach(el => el.disabled = true);
        overrideTypeSelect?.classList.add('form-select-disabled');
        overrideCountInput?.classList.add('form-input-disabled');
        overrideTimeEstimateEl?.classList.add('time-estimate-disabled');
        overrideMethodRowEl?.classList.add('blocklist-active-locked');
        overrideCountWrapperEl?.classList.add('blocklist-active-locked');
        maxDifficultyWrap?.classList.add('max-difficulty-disabled', 'blocklist-active-locked');
        overridePreviewBlockEl?.classList.add('blocklist-active-locked');
        document.getElementById('override-count-minus')?.setAttribute('disabled', '');
        document.getElementById('override-count-plus')?.setAttribute('disabled', '');

        if (preserveModalItems) {
            applyModalLockedItems(blocklist.websites || [], getBlocklistModalLockedApps(blocklist));
        } else {
            window.setModalData?.(
                blocklist.websites || [],
                getBlocklistRegularApps(blocklist),
                getBlocklistIOSScreenTimeSelection(blocklist),
                blocklist.websites || [],
                getBlocklistModalLockedApps(blocklist)
            );
        }
        return;
    }

    warningEl.classList.add('hidden');
    overrideInputs.forEach(el => el.disabled = false);
    overrideTypeSelect?.classList.remove('form-select-disabled');
    overrideCountInput?.classList.remove('form-input-disabled');
    overrideTimeEstimateEl?.classList.remove('time-estimate-disabled');
    overrideMethodRowEl?.classList.remove('blocklist-active-locked');
    overrideCountWrapperEl?.classList.remove('blocklist-active-locked');
    maxDifficultyWrap?.classList.remove('max-difficulty-disabled', 'blocklist-active-locked');
    overridePreviewBlockEl?.classList.remove('blocklist-active-locked');
    const maxDifficultyOn = document.getElementById('override-max-difficulty-checkbox')?.checked;
    document.getElementById('override-count-minus')?.toggleAttribute('disabled', !!maxDifficultyOn);
    document.getElementById('override-count-plus')?.toggleAttribute('disabled', !!maxDifficultyOn);

    if (preserveModalItems) {
        applyModalLockedItems([], []);
    } else {
        window.setModalData?.(
            blocklist?.websites || [],
            getBlocklistRegularApps(blocklist),
            getBlocklistIOSScreenTimeSelection(blocklist),
            [],
            []
        );
    }

    if (maxDifficultyOn) setOverrideCountMaxMode(true);
}

/**
 * Clear the per-form transient state (undo stack, last-value trackers, preview
 * freeze) before the editor is (re)populated.
 */
export function resetBlocklistFormState() {
    state.blocklistModalUndoStack.length = 0;
    state.blocklistModalApplyingUndo = false;
    state.lastBlocklistNameValue = '';
    state.lastOverrideCountValue = '';
    state.lastCustomOverrideTextValue = '';
    state.lastOverrideTypeValue = '';
    state.lastOverrideCountValueBeforeMaxDifficulty = 50;
    state.lastOverrideTypeValueBeforeMaxDifficulty = 'random-words';
    state.overridePreviewFrozenByType = { 'random-words': null, 'gibberish': null };
    state.lastOverridePreviewType = null;
    setOverrideCountMaxMode(false);

    // Revert the "show names on card" live preview of whatever was loaded before.
    if (state.blocklistModalPreviewSnapshot?.id) {
        const bl = state.appData.blocklists.find(b => b.id === state.blocklistModalPreviewSnapshot.id);
        if (bl && bl.showItemDetails !== state.blocklistModalPreviewSnapshot.showItemDetails) {
            bl.showItemDetails = state.blocklistModalPreviewSnapshot.showItemDetails;
            renderWeekBlocks();
            renderBlocklists();
        }
    }
    state.blocklistModalPreviewSnapshot = null;

    const importMenu = document.getElementById('websites-import-menu');
    const importBtn = document.getElementById('modal-import-websites-btn');
    if (importMenu) {
        importMenu.classList.add('hidden');
        resetWebsitesImportMenuPosition();
    }
    if (importBtn) importBtn.setAttribute('aria-expanded', 'false');
}

/**
 * Fill the name / stop-method / emoji / colour / items / "show names" fields
 * from `blocklist` (null = blank form for a new space). The When to block part
 * is populated by focus-space-editor.
 */
export function populateBlocklistFormFields(blocklist) {
    if (blocklist) {
        state.blocklistModalPreviewSnapshot = { id: blocklist.id, showItemDetails: blocklist.showItemDetails };
    }

    const modalName = truncateBlocklistName(blocklist?.name || '');
    document.getElementById('blocklist-name').value = modalName;
    document.getElementById('blocklist-name').classList.remove('input-error');
    state.lastBlocklistNameValue = modalName;

    const normalizedDifficulty = cloneOverrideDifficulty(blocklist?.overrideDifficulty, 10);
    document.getElementById('override-type').value = normalizedDifficulty.type;
    document.getElementById('override-count').value = normalizedDifficulty.count;
    document.getElementById('custom-override-text').value = normalizedDifficulty.customText || '';
    document.getElementById('custom-override-text').classList.remove('input-error');
    document.getElementById('custom-override-text-error')?.classList.add('hidden');
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
    state.lastOverrideCountValue = String(overrideCountField.value);
    state.lastCustomOverrideTextValue = customTextArea.value;
    state.lastOverrideTypeValue = document.getElementById('override-type').value;

    if (maxDifficulty) {
        state.lastOverrideCountValueBeforeMaxDifficulty = normalizedDifficulty.countBeforeMax ?? 50;
        state.lastOverrideTypeValueBeforeMaxDifficulty = normalizedDifficulty.typeBeforeMax ?? 'random-words';
        const maxCount = getMaxOverrideCharsForType(type);
        overrideCountField.value = String(maxCount);
        overrideCountField.max = String(maxCount);
        setOverrideCountMaxMode(true);
    } else {
        setOverrideCountMaxMode(false);
    }
    state.lastOverrideCountValue = String(overrideCountField.value);

    // Restore color swatch selection
    document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));

    let colorToSelect = blocklist?.color;

    // If creating a new blocklist (or no color set), find the first unused color
    if (!colorToSelect) {
        const usedColors = new Set(state.appData.blocklists.map(bl => bl.color));
        const swatches = Array.from(document.querySelectorAll('.color-swatch:not(.custom-swatch)'));
        const firstUnused = swatches.find(s => !usedColors.has(s.dataset.color));
        if (firstUnused) {
            colorToSelect = firstUnused.dataset.color;
        } else if (swatches.length > 0) {
            colorToSelect = swatches[0].dataset.color;
        } else {
            colorToSelect = '#B8D1DE';
        }
    }

    const matchingSwatch = document.querySelector(`.color-swatch[data-color="${colorToSelect}"]:not(.custom-swatch)`);
    if (matchingSwatch) {
        matchingSwatch.classList.add('selected');
    } else {
        const customSwatch = document.getElementById('custom-color-swatch');
        if (customSwatch) {
            customSwatch.style.background = colorToSelect;
            customSwatch.dataset.color = colorToSelect;
            customSwatch.classList.add('selected');
        }
    }

    applyModalBlocklistTint(colorToSelect);

    // Restore emoji swatch selection
    document.querySelectorAll('.emoji-swatch').forEach(s => s.classList.remove('selected'));

    let emojiToSelect = blocklist?.emoji;
    if (!emojiToSelect) {
        const usedEmojis = new Set(state.appData.blocklists.map(bl => bl.emoji));
        const emojiSwatches = Array.from(document.querySelectorAll('.emoji-swatch:not(.custom-emoji-swatch)'));
        const firstUnused = emojiSwatches.find(s => !usedEmojis.has(s.dataset.emoji));
        if (firstUnused) {
            emojiToSelect = firstUnused.dataset.emoji;
        } else if (emojiSwatches.length > 0) {
            emojiToSelect = emojiSwatches[0].dataset.emoji;
        } else {
            emojiToSelect = '📱';
        }
    }

    const matchingEmoji = document.querySelector(`.emoji-swatch[data-emoji="${emojiToSelect}"]:not(.custom-emoji-swatch)`);
    if (matchingEmoji) {
        matchingEmoji.classList.add('selected');
    } else {
        const customEmojiSwatch = document.getElementById('custom-emoji-swatch');
        if (customEmojiSwatch) {
            customEmojiSwatch.innerHTML = emojiToSelect;
            customEmojiSwatch.dataset.emoji = emojiToSelect;
            customEmojiSwatch.classList.add('selected');
        }
    }

    syncBlocklistEditFrictionUi(blocklist);

    // "Show names on card" previews live on the card while editing; Discard reverts it.
    const showItemDetailsCheckbox = document.getElementById('show-item-details-checkbox');
    if (showItemDetailsCheckbox) {
        showItemDetailsCheckbox.checked = blocklist?.showItemDetails !== false;
        showItemDetailsCheckbox.onchange = () => {
            if (!state.editingBlocklistId) return;
            const bl = state.appData.blocklists.find(b => b.id === state.editingBlocklistId);
            if (!bl) return;
            bl.showItemDetails = showItemDetailsCheckbox.checked;
            renderBlocklists();
        };
    }
}

// Open the create modal. The editor node is borrowed from the panel and put
// back by closeBlocklistModal. Legacy callers that pass a blocklist get the
// panel instead: editing happens there now.
export function openBlocklistModal(blocklist = null, options = {}) {
    if (blocklist) {
        const dropdown = document.getElementById('blocklist-select');
        if (dropdown) {
            dropdown.value = blocklist.id;
            handleBlocklistSelect({ target: dropdown }, { openEnterUi: true });
        }
        return;
    }

    // Keep narrow-desktop sheet chrome in sync before showing create.
    syncEnterSchedulerSheetLayout();
    window.restoreBlocklistModalTagBridges?.();

    mountFocusSpaceEditor(document.getElementById('blocklist-modal-editor-slot'));
    populateFocusSpaceEditor(null, { mode: options.mode === 'allowlist' ? 'allowlist' : 'blocklist' });
    syncBlocklistCreateUi({ isCreate: true });

    const modal = document.getElementById('blocklist-modal');
    modal.classList.remove('hidden');
    resetModalScrollPosition(modal);
}

// Close the create modal and hand the editor back to the panel, showing the
// selected space again (or a blank, hidden panel when nothing is selected).
export function closeBlocklistModal() {
    resetBlocklistFormState();
    document.getElementById('blocklist-modal').classList.add('hidden');
    applyModalBlocklistTint(null);
    returnFocusSpaceEditorToPanel();

    const selected = state.selectedBlocklistId
        ? state.appData.blocklists.find(b => b.id === state.selectedBlocklistId) || null
        : null;
    if (selected) {
        populateFocusSpaceEditor(selected);
    } else {
        state.editingBlocklistId = null;
        document.getElementById('blocklist-name').value = '';
        window.setModalData?.([], [], null);
    }
    handleTimeChange();
}

/** Override / pause modal summary, e.g. "Blocks 3 websites (a.com, b.com, c.com)". */
export function formatBlocklistModalSummary(blocklist) {
    const websiteCount = blocklist.websites?.length || 0;
    const displayApps = getBlocklistDisplayApps(blocklist);
    const appCount = displayApps.length;
    const mode = tSettings(
        isAllowlistBlocklist(blocklist)
            ? 'blocklistModalSummaryAllows'
            : 'blocklistModalSummaryBlocks'
    );
    const metaParts = [];

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
    return `${mode} ${itemsText}`;
}

// Open override modal
export function openOverrideModal(blockId) {
    delete window.overrideScheduleId;
    state.overrideBlockId = blockId;
    const block = state.appData.activeBlocks.find(b => b.id === blockId);
    state.overrideBlocklistIdForHelper = block ? block.blocklistId : null;

    const blocklist = state.appData.blocklists.find(bl => bl.id === block?.blocklistId);

    if (!blocklist) return;

    populateOverrideConfirmModalContent(blocklist, { block });
    const difficulty = blocklist.overrideDifficulty || { type: 'random-words', count: 50 };
    initializeOverrideModalChallenge(difficulty, blocklist?.color);
}

// Close override modal
export function closeOverrideModal() {
    document.getElementById('override-modal').classList.add('hidden');
    state.overrideBlockId = null;
    state.overrideBlocklistIdForHelper = null;
    getChallengeController('override').reset();
    delete window.overrideScheduleId;
    setStartConfirmPrimaryLabel('confirm-override-btn', tSettings('stopBlock'));
    const confirmBtn = document.getElementById('confirm-override-btn');
    if (confirmBtn) confirmBtn.disabled = false;
}

export function initializeOverrideModalChallenge(difficulty, progressColor = null) {
    // Signature preserved: the Android friction gate deliberately bypasses
    // openOverrideModal and calls this directly (blocking-platform.js), setting
    // state.overrideBlockId itself.
    const controller = getChallengeController('override');
    controller.open({ difficulty, progressColor });
    document.getElementById('override-modal').classList.remove('hidden');
    requestAnimationFrame(() => controller.focus());
}

// ── Pause/Resume Block ──

/** Turn a paused Manual space back on. No challenge: this falls toward blocking. */
export async function resumePausedBlock(block) {
    if (!block) return;
    delete block.isPaused;
    delete block.pauseEndTime;
    await saveData();
    await syncActiveBlocksToHelper();
    await syncSchedulesToHelper();
    await updateHostsFile();
    await updateBlockedApps();
    render();
    refreshSelectedBlocklistUi();
}

/** Turn a paused Daily / Weekly space back on. No challenge: this falls toward blocking. */
export async function resumePausedSchedule(schedule) {
    if (!schedule) return;
    delete schedule.isPaused;
    delete schedule.pauseEndTime;
    await saveData();
    await syncSchedulesToHelper();
    await updateHostsFile();
    await updateBlockedApps();
    render();
    refreshSelectedBlocklistUi();
}

// ── Pause Block Modal ──

export function openPauseModal(blockId) {
    state.pauseBlockId = blockId;

    let block, blocklist;

    if (blockId) {
        // One-off block pause
        block = state.appData.activeBlocks.find(b => b.id === blockId);
        blocklist = state.appData.blocklists.find(bl => bl.id === block?.blocklistId);
    } else if (state.pauseScheduleData) {
        // Schedule pause — create a synthetic block object
        blocklist = state.appData.blocklists.find(bl => bl.id === state.pauseScheduleData.blocklistId);
        block = {
            id: null,
            blocklistId: state.pauseScheduleData.blocklistId,
            startTime: Date.now(),
            endTime: ALWAYS_ON_END_TIME,
            isScheduleBlock: true
        };
    }

    if (!blocklist) return;

    const isSchedule = !blockId && !!state.pauseScheduleData;
    const isScheduleInactive = isSchedule && !state.pauseScheduleData.isActiveNow;
    const frictionless = isSchedule && !!state.pauseScheduleData.frictionless;
    const pauseModal = document.getElementById('pause-modal');
    pauseModal?.classList.toggle('pause-frictionless', frictionless);

    populatePauseConfirmModalContent(blocklist, {
        block,
        isSchedule,
        isScheduleInactive,
    });

    // Calculate remaining time and max pause duration
    const remainingInfo = document.getElementById('pause-remaining-info');
    const daysGroup = document.getElementById('pause-days').closest('.pause-time-input-group');
    const hoursGroup = document.getElementById('pause-hours').closest('.pause-time-input-group');

    if (!isBlockAlwaysOn(block)) {
        const remainingMs = block.endTime - Date.now();
        const remainingMins = Math.floor(remainingMs / 60000);
        state.pauseMaxMinutes = Math.max(1, remainingMins - 2); // 2 min buffer

        remainingInfo.classList.add('hidden');

        // Show/hide fields based on max pause
        if (state.pauseMaxMinutes < 60) {
            // Less than 1 hour max: hide days and hours
            daysGroup.style.display = 'none';
            hoursGroup.style.display = 'none';
        } else if (state.pauseMaxMinutes < 24 * 60) {
            // Less than 1 day max: hide days
            daysGroup.style.display = 'none';
            hoursGroup.style.display = '';
        } else {
            daysGroup.style.display = '';
            hoursGroup.style.display = '';
        }
    } else {
        state.pauseMaxMinutes = null; // No cap for always-on blocks
        remainingInfo.classList.add('hidden');
        daysGroup.style.display = '';
        hoursGroup.style.display = '';
    }

    // Reset duration inputs
    const configuredDefaultMins = getDefaultPauseMinutes();
    const defaultMins = state.pauseMaxMinutes !== null
        ? Math.min(configuredDefaultMins, state.pauseMaxMinutes)
        : configuredDefaultMins;
    // Split across the three inputs — the configured default can exceed an
    // hour, and each field only accepts its own unit's range.
    document.getElementById('pause-days').value = Math.floor(defaultMins / (24 * 60));
    document.getElementById('pause-hours').value = Math.floor((defaultMins % (24 * 60)) / 60);
    document.getElementById('pause-minutes').value = defaultMins % 60;
    initPauseRestartPopovers();
    updatePauseRestartTime();

    const instructionEl = document.getElementById('pause-modal-instruction');
    if (instructionEl) {
        instructionEl.textContent = tSettings(frictionless
            ? 'pauseDifficultyLiftedByAllowEdits'
            : 'pauseInstruction');
    }

    // A flexible schedule between segments pauses without friction. The
    // challenge stack is hidden by #pause-modal.pause-frictionless in CSS;
    // skipChallenge clears both inputs so nothing stale can be submitted.
    getChallengeController('pause').open({
        difficulty: blocklist.overrideDifficulty || { type: 'random-words', count: 50 },
        progressColor: blocklist.color,
        skipChallenge: frictionless,
    });

    document.getElementById('pause-modal').classList.remove('hidden');
    requestAnimationFrame(() => {
        syncPauseDurationRowLayout();
        getChallengeController('pause').focus();
    });
}

/** Pause modal: use horizontal row only if it fits; otherwise stack (hide arrow). */
export function syncPauseDurationRowLayout() {
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

export function closePauseModal() {
    const pauseModal = document.getElementById('pause-modal');
    pauseModal?.classList.add('hidden');
    pauseModal?.classList.remove('pause-frictionless');
    state.pauseBlockId = null;
    state.pauseScheduleData = null;
    getChallengeController('pause').reset();
    // Pause re-disables its confirm button on close; the challenge re-enables it
    // on the next open. (The other two modals leave theirs enabled.)
    document.getElementById('confirm-pause-btn').disabled = true;
}

export function updatePauseRestartTime() {
    let days = parseInt(document.getElementById('pause-days').value) || 0;
    let hours = parseInt(document.getElementById('pause-hours').value) || 0;
    let minutes = parseInt(document.getElementById('pause-minutes').value) || 0;

    let totalMinutes = days * 24 * 60 + hours * 60 + minutes;

    // Clamp to max if set
    if (state.pauseMaxMinutes !== null && totalMinutes > state.pauseMaxMinutes) {
        totalMinutes = state.pauseMaxMinutes;
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

export function updatePauseRestartPopoverSelection(hour, minute) {
    document.querySelectorAll('#pause-restart-hour-options .popover-option').forEach(btn => {
        btn.classList.toggle('selected', parseInt(btn.dataset.value) === hour);
    });
    document.querySelectorAll('#pause-restart-minute-options .popover-option').forEach(btn => {
        btn.classList.toggle('selected', parseInt(btn.dataset.value) === minute);
    });
}

// Initialize pause restart time popovers with hour/minute options
export function initPauseRestartPopovers() {
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

    // Popover triggers use `.time-popover-anchor` — wired once at DOMContentLoaded.
}

// When user selects a restart time, reverse-calculate the duration
export function selectPauseRestartTimeOption(e) {
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
    if (state.pauseMaxMinutes !== null && diffMins > state.pauseMaxMinutes) {
        diffMins = state.pauseMaxMinutes;
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

export async function proceedWithPause() {
    if (!state.pauseBlockId && !state.pauseScheduleData) return;

    const pausedBlocklistId = state.pauseScheduleData?.blocklistId
        || state.appData.activeBlocks.find(b => b.id === state.pauseBlockId)?.blocklistId
        || null;

    // The controller already knows whether this open was frictionless, so the
    // frictionless short-circuit lives there rather than being re-derived here.
    const result = getChallengeController('pause').handleConfirm();
    // 'advanced' = a correct but non-final word; the user keeps typing.
    if (result.status !== 'ok') return;

    const days = parseInt(document.getElementById('pause-days').value) || 0;
    const hours = parseInt(document.getElementById('pause-hours').value) || 0;
    const minutes = parseInt(document.getElementById('pause-minutes').value) || 0;
    const pauseDurationMs = (days * 24 * 60 + hours * 60 + minutes) * 60 * 1000;

    if (pauseDurationMs <= 0) {
        closePauseModal();
        return;
    }

    if (state.pauseScheduleData) {
        // Schedule pause — set pause state on the schedule itself
        const schedule = state.appData.schedules?.find(s => s.blocklistId === state.pauseScheduleData.blocklistId);
        if (schedule) {
            schedule.isPaused = true;
            schedule.pauseEndTime = Date.now() + pauseDurationMs;
        }
    } else {
        // One-off block pause
        const block = state.appData.activeBlocks.find(b => b.id === state.pauseBlockId);
        if (!block) {
            closePauseModal();
            return;
        }
        block.isPaused = true;
        block.pauseEndTime = Date.now() + pauseDurationMs;
    }

    await saveData();
    console.log('[pause-resume] Proceeding with pause sync', {
        pauseBlockId: state.pauseBlockId,
        scheduleBlocklistId: state.pauseScheduleData?.blocklistId || null
    });
    await syncActiveBlocksToHelper();
    await syncSchedulesToHelper();

    // Update blocking rules — updateHostsFile skips paused blocks' domains
    await updateHostsFile();
    await updateBlockedApps();

    // iOS: register one-off DeviceActivity so pause expiry re-evaluates background enforcement.
    if (state.isIOS) {
        if (state.pauseScheduleData) {
            const schedule = state.appData.schedules?.find(s => s.blocklistId === state.pauseScheduleData.blocklistId);
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
        } else if (state.pauseBlockId) {
            const block = state.appData.activeBlocks.find(b => b.id === state.pauseBlockId);
            if (block && block.pauseEndTime) {
                try {
                    const blocklist = state.appData.blocklists.find(bl => bl.id === block.blocklistId);
                    const iosPayload = getBlocklistIOSPayload(blocklist);
                    await tauriAPI.screentimeSetResumePayload({
                        blockId: state.pauseBlockId,
                        domains: blocklist?.websites || [],
                        appTokenData: iosPayload.appTokenData,
                        categoryTokenData: iosPayload.categoryTokenData,
                        // Without this the re-applied state treats an allow-mode
                        // block's allowed items as blocked ones.
                        mode: isAllowlistBlocklist(blocklist) ? 'allowlist' : null
                    });
                    const res = await tauriAPI.screentimeRegisterOneOffActivity('redd-block-resume-' + state.pauseBlockId, block.pauseEndTime);
                    if (res && res.success === false) {
                        console.error('[iOS] One-off DeviceActivity registration failed:', res.error || 'Unknown error');
                    }
                } catch (e) {
                    console.warn('[iOS] One-off pause-resume registration failed:', e);
                }
            }
        }
    }

    const keepSelectedId = state.selectedBlocklistId;
    render();
    refreshSelectedBlocklistUi(keepSelectedId);
    // refreshSelectedBlocklistUi above re-synced the editor's lock state for
    // pausedBlocklistId without discarding in-flight edits.
    closePauseModal();
}
export function updateOverridePreview() {
    const typeSelect = document.getElementById('override-type');
    const countInput = document.getElementById('override-count');
    const customTextArea = document.getElementById('custom-override-text');
    const timeEstimateEl = document.getElementById('override-count-time-estimate');
    const previewEl = document.getElementById('override-preview-text');
    const blockEl = document.getElementById('override-preview-block');
    if (!previewEl || !blockEl) return;

    const type = typeSelect?.value || 'random-words';
    const count = countInput?.value ?? '50';
    const customText = customTextArea?.value ?? '';

    const estimatedMins = getOverrideEstimatedMinutes(type, count, customText);
    const previewText = getOverridePreviewText(type, count, customText);

    const lang = getSettingsLanguage();
    if (timeEstimateEl && type !== 'custom') {
        if (lang === 'da') {
            const unit = estimatedMins === 1 ? 'minut' : 'minutter';
            timeEstimateEl.textContent = tSettingsFmt('overrideCountTimeEstimateDa', { minutes: estimatedMins, unit });
        } else {
            timeEstimateEl.textContent = tSettingsFmt('overrideCountTimeEstimate', { minutes: estimatedMins });
        }
    }

    previewEl.textContent = previewText;
    previewEl.title = previewText;
}

export function syncOverrideCountUi(type) {
    const countLabelEl = document.getElementById('override-count-label');
    const maxHintEl = document.getElementById('override-max-difficulty-hint');
    const countInput = document.getElementById('override-count');
    if (countLabelEl) {
        countLabelEl.textContent = usesMobileWordCountForOverrideType(type)
            ? tSettings('overrideWordsToType')
            : tSettings('overrideCharsToType');
    }
    if (maxHintEl) {
        maxHintEl.textContent = formatOverrideMaxDifficultyHint(type);
    }
    if (countInput) {
        countInput.max = String(getMaxOverrideCharsForType(type));
        countInput.min = String(getMinOverrideCountForType(type));
    }
}

export function applyOverrideTypeUi(type) {
    const customTextArea = document.getElementById('custom-override-text');
    const customErrorEl = document.getElementById('custom-override-text-error');
    const overrideCountInput = document.getElementById('override-count');
    const overrideCountWrapper = document.getElementById('override-count-wrapper');
    const warningEl = document.getElementById('override-count-warning');
    const previewBlockEl = document.getElementById('override-preview-block');
    const maxDifficultyWrapEl = document.getElementById('override-max-difficulty-wrap');
    const maxChars = getMaxOverrideCharsForType(type);
    syncOverrideCountUi(type);
    overrideCountInput.max = String(maxChars);

    customTextArea?.classList.remove('input-error');
    customErrorEl?.classList.add('hidden');

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

export function setOverrideCountMaxMode(enabled) {
    const overrideCountWrapper = document.getElementById('override-count-wrapper');
    const overrideCountInput = document.getElementById('override-count');
    const overrideCountStepper = document.getElementById('override-count-stepper');
    const minusBtn = document.getElementById('override-count-minus');
    const plusBtn = document.getElementById('override-count-plus');
    overrideCountWrapper?.classList.toggle('override-count-max-mode', enabled);
    overrideCountStepper?.classList.toggle('override-count-max-mode', enabled);
    overrideCountInput?.classList.toggle('form-input-disabled', enabled);
    minusBtn?.toggleAttribute('disabled', enabled);
    plusBtn?.toggleAttribute('disabled', enabled);
    if (enabled) overrideCountInput?.setAttribute('tabindex', '-1');
    else overrideCountInput?.removeAttribute('tabindex');
}

export function cloneOverrideDifficulty(raw, fallbackCount = 50) {
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
