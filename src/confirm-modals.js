// Confirm modals: start/pause/resume/override flows, calendar previews,
// blocklist edit modal, modal undo stack. Extracted verbatim from app.js.
import { state } from './state.js';
import { getChallengeController } from './challenge-controller.js';
import { tauriAPI } from './tauri-api.js';
import { escapeHtml, cleanUrlForDisplay, getContrastTextColor, getEnteringChipColor } from './utils.js';
import { tSettings, tSettingsFmt, getSettingsLanguage, weekdayAbbrevMon0List, weekdayLetterMon0List } from './i18n.js';
import { ALWAYS_ON_END_TIME, ensureIOSBlocklistSelectionReady, getBlocklistIOSPayload, getBlocklistIOSScreenTimeSelection, getBlocklistModalLockedApps, getBlocklistRegularApps, isAllowlistBlocklist, isBlockAlwaysOn } from './blocklist-utils.js';
import { formatOverrideMaxDifficultyHint, generateOverrideChallengeText, getMaxOverrideCharsForType, getMinOverrideCountForType, getOverrideEstimatedMinutes, getOverridePreviewText, isMobileOverrideChallengePlatform, normalizeCustomOverrideText, normalizeOverrideCount, sanitizeChallengeTargetText, usesMobileWordCountForOverrideType } from './override-challenge.js';
import { isAndroidAllowlistUnsupported, isSchedulePausedNow, resolveOneShotOccurrences, syncActiveBlocksToHelper, syncSchedulesToHelper } from './schedule-engine.js';
import { saveData, updateHostsFile } from './persistence.js';
import { getCalendarSegmentLayout, layoutOverlappingBlocks, render, renderScheduleAlwaysOnRow, renderWeekBlocks, updateWeekCalendar } from './render.js';
import { clearPendingScheduleDraft, getRunningEnforcementTarget, isBlocklistEditFrictionRequired, renderBlocklists, truncateBlocklistName } from './blocklists.js';
import { getCommittedScheduleSegmentCount, getInitialExpandedScheduleSegmentIndex, isScheduleSegmentActiveNow, rebuildScheduleSegments, setAlwaysOnMode, setScheduleMode, updateScheduleButtonState, canEditScheduleBetweenBlocks } from './schedule-editor.js';
import { getEffectiveScheduleStartOverlayId, rememberLastScheduleStartOverlayId, syncScheduleConfirmOverlaySummary } from './schedule-overlay.js';
import { closeAllPopovers, disableScheduleControls, disableTimeControls, getEndTimeAsDate, getStartTimeAsDate, initializeTimeInputs, pad, updateDurationQuickBtns, updateTimeDisplay } from './time-inputs.js';
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
    setBlocklistCreateKind,
    syncBlocklistCreateKindUi,
    setConfirmModalBlockingLabel,
    isBlocklistAllowlistMode,
} from './list-mode.js';
import {
    discardPendingQuickStart,
    settlePendingQuickStart,
    resetEmbeddedQuickStartControls,
} from './quick-start.js';

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

export function buildScheduleConfirmSegmentHtml(seg) {
    const fullDayLabels = weekdayAbbrevMon0List();
    const useCompactDayLabels = shouldUseCompactMobileScheduleDayLabels();
    const dayLabels = useCompactDayLabels ? weekdayLetterMon0List() : fullDayLabels;
    const startTime = `${String(seg.startHour).padStart(2, '0')}:${String(seg.startMinute).padStart(2, '0')}`;
    const endTime = `${String(seg.endHour).padStart(2, '0')}:${String(seg.endMinute).padStart(2, '0')}`;
    const segmentDays = Array.isArray(seg.days) ? seg.days : [];
    const dayToggles = dayLabels.map((label, dayIndex) =>
        `<span class="segment-day-toggle${segmentDays.includes(dayIndex) ? ' active' : ''}" aria-label="${fullDayLabels[dayIndex]}"${useCompactDayLabels ? ' aria-hidden="true"' : ''}>${label}</span>`,
    ).join('');

    return `
        <div class="start-confirm-time-slot">
            <div class="start-confirm-time-slot-row">
                <span class="start-confirm-time-range">${startTime} → ${endTime}</span>
                <div class="start-confirm-segment-days segment-days${useCompactDayLabels ? ' compact-day-labels' : ''}">${dayToggles}</div>
            </div>
        </div>
    `;
}

export function renderScheduleConfirmSegments(segmentsEl, segments) {
    if (!segmentsEl) return;
    segmentsEl.innerHTML = segments.map((seg) =>
        buildScheduleConfirmSegmentHtml(seg),
    ).join('');
}

export function formatScheduleConfirmRepeatText() {
    if (state.scheduleRepeatType === 'forever') {
        return tSettings('startConfirmRepeatForever');
    }
    if (state.scheduleRepeatType === 'date' && state.scheduleRepeatDate) {
        return tSettingsFmt('startConfirmRepeatUntilFmt', {
            date: state.scheduleRepeatDate.toLocaleDateString(tSettings('locale')),
        });
    }
    return tSettings('startConfirmRepeatNone');
}

/** Flexible / Committed — mirrors schedule-editor without importing it (cycle-safe). */
export function formatScheduleConfirmStrictnessText() {
    const schedule = state.selectedBlocklistId && state.appData?.schedules
        ? state.appData.schedules.find((s) => s.blocklistId === state.selectedBlocklistId)
        : null;
    const flexible = schedule
        ? !!schedule.allowEditsBetweenBlocks
        : !!state.draftAllowEditsBetweenBlocks;
    return tSettings(flexible ? 'allowEditsFlexibleLabel' : 'allowEditsStrictLabel');
}

export function formatStartBlockDurationCopy(isAlwaysOn, blockStart, blockEnd) {
    if (isAlwaysOn) {
        return `<strong>${escapeHtml(tSettings('alwaysUntilOff'))}</strong>`;
    }

    const durationMs = blockEnd.getTime() - blockStart.getTime();
    const durationMinutes = Math.max(1, Math.round(durationMs / 60000));
    const hours = Math.floor(durationMinutes / 60);
    const mins = durationMinutes % 60;
    let durationLabel;
    if (hours > 0 && mins > 0) durationLabel = `${hours}h ${mins}m`;
    else if (hours > 0) durationLabel = `${hours} hour${hours > 1 ? 's' : ''}`;
    else durationLabel = `${mins} minute${mins > 1 ? 's' : ''}`;

    const ends = blockEnd.toLocaleTimeString(tSettings('locale'), { hour: 'numeric', minute: '2-digit' });
    return tSettingsFmt('startConfirmDurationLineFmt', {
        duration: `<strong>${escapeHtml(durationLabel)}</strong>`,
        ends: escapeHtml(ends),
    });
}

export function formatStartBlockSubtitle(blocklist, isAlwaysOn, blockStart, blockEnd) {
    const isAllow = isBlocklistAllowlistMode(blocklist);
    if (isAlwaysOn) {
        return tSettings(isAllow ? 'startBlockSubtitleAllowAlways' : 'startBlockSubtitleAlways');
    }
    const durationMs = blockEnd.getTime() - blockStart.getTime();
    const durationMinutes = Math.max(1, Math.round(durationMs / 60000));
    const hours = Math.floor(durationMinutes / 60);
    const mins = durationMinutes % 60;
    let durationLabel;
    if (hours > 0 && mins > 0) durationLabel = `${hours}h ${mins}m`;
    else if (hours > 0) durationLabel = `${hours} hour${hours > 1 ? 's' : ''}`;
    else durationLabel = `${mins} minute${mins > 1 ? 's' : ''}`;
    return tSettingsFmt(
        isAllow ? 'startBlockSubtitleAllowFmt' : 'startBlockSubtitleFmt',
        { duration: durationLabel },
    );
}

export function formatStartScheduleSubtitle(blocklist) {
    return tSettings(
        isBlocklistAllowlistMode(blocklist)
            ? 'startScheduleSubtitleAllow'
            : 'startScheduleSubtitle',
    );
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

export const SCHEDULE_CONFIRM_ROOM_CHIP_IDS = {
    chipId: 'schedule-confirm-room-chip',
    emojiId: 'schedule-confirm-room-chip-emoji',
    nameId: 'schedule-confirm-room-chip-name',
};

export const SCHEDULER_ROOM_CHIP_IDS = {
    chipId: 'scheduler-room-chip',
    emojiId: 'scheduler-room-chip-emoji',
    nameId: 'scheduler-room-chip-name',
};

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

export function setSchedulerRoomChip(blocklist) {
    setStartConfirmRoomChip(blocklist, SCHEDULER_ROOM_CHIP_IDS);
    if (blocklist?.color) {
        applyRoomChipTint(document.getElementById('scheduler-room-chip'), blocklist.color);
    }
}

export function setStartConfirmOverrideDescription(options, textElId = 'start-confirm-override-text') {
    const overrideTextEl = document.getElementById(textElId);
    if (!overrideTextEl) return;

    const line = formatConfirmModalOverrideTypingLine(options);
    overrideTextEl.innerHTML = `${line} ${escapeHtml(tSettings('confirmOverrideIntentionSuffix'))}`;
}

export function getStartScheduleConfirmTitle(blocklist) {
    if (!blocklist) return tSettings('startThisSchedule');
    return tSettingsFmt('startScheduleTitleFmt', { name: blocklist.name });
}

export function getStartBlockConfirmTitle(blocklist) {
    if (!blocklist) return tSettings('startThisBlock');
    return tSettingsFmt('startBlockTitleFmt', { name: blocklist.name });
}

export function getResumeBlockConfirmTitle(blocklist) {
    if (!blocklist) return tSettings('resumeThisBlock');
    return tSettingsFmt('resumeBlockTitleFmt', { name: blocklist.name });
}

export function showScheduleConfirmModal(blocklist) {
    resetScheduleConfirmModalToStartLayout();

    const titleEl = document.getElementById('start-schedule-confirm-title');
    if (titleEl) titleEl.textContent = tSettings('startThisSchedule');

    setStartConfirmRoomChip(blocklist, SCHEDULE_CONFIRM_ROOM_CHIP_IDS);

    const subtitleEl = document.getElementById('schedule-confirm-subtitle');
    if (subtitleEl) subtitleEl.innerHTML = formatStartScheduleSubtitle(blocklist);

    setConfirmModalBlockingLabel(blocklist, 'schedule-confirm-blocking-label');

    state.pendingScheduleStartOverlayId = getEffectiveScheduleStartOverlayId();
    syncScheduleConfirmOverlaySummary();
    document.getElementById('schedule-confirm-overlay-row')?.classList.toggle('hidden', isMobileOverrideChallengePlatform());
    document.getElementById('schedule-confirm-strictness-divider')?.classList.toggle('hidden', isMobileOverrideChallengePlatform());

    renderStartConfirmBlockingDetails(
        blocklist,
        document.getElementById('schedule-confirm-blocking-list'),
        document.getElementById('schedule-confirm-show-all-blocking'),
        document.getElementById('schedule-confirm-blocking-row'),
    );

    renderScheduleConfirmSegments(document.getElementById('schedule-confirm-segments'), state.scheduleSegments);

    const repeatEl = document.getElementById('schedule-confirm-repeat');
    if (repeatEl) repeatEl.innerHTML = formatScheduleConfirmRepeatText();

    const strictnessEl = document.getElementById('schedule-confirm-strictness');
    if (strictnessEl) strictnessEl.textContent = formatScheduleConfirmStrictnessText();

    // Override info
    const difficulty = blocklist.overrideDifficulty || { type: 'random-words', count: 50 };
    const displayCount = difficulty.type === 'custom'
        ? (difficulty.customText?.length || 0)
        : normalizeOverrideCount(difficulty.count || 50, difficulty.type);
    const estimatedMinutes = getOverrideEstimatedMinutes(
        difficulty.type,
        displayCount,
        difficulty.customText || ''
    );

    const schedType =
        difficulty.type === 'custom' && difficulty.customText
            ? 'custom'
            : difficulty.type === 'gibberish'
              ? 'gibberish'
              : 'random-words';
    setStartConfirmOverrideDescription({
        type: schedType,
        count: displayCount,
        estimatedMinutes,
        customText: difficulty.customText || ''
    }, 'schedule-confirm-override-text');

    // Show modal
    document.getElementById('start-schedule-confirm-modal').classList.remove('hidden');
}

// Close schedule confirmation modal
export function resetScheduleConfirmModalToStartLayout() {
    document.querySelector('#start-schedule-confirm-modal .start-confirm-modal')
        ?.classList.remove('schedule-confirm-edit-layout');

    setStartConfirmPrimaryLabel('proceed-schedule-confirm-btn', tSettings('startSchedule'));
    const titleEl = document.getElementById('start-schedule-confirm-title');
    if (titleEl) titleEl.textContent = tSettings('startThisSchedule');
    const overrideHeader = document.getElementById('schedule-confirm-override-header');
    if (overrideHeader) overrideHeader.textContent = tSettings('startScheduleHoldHeader');
    document.getElementById('schedule-confirm-overlay-row')?.classList.toggle('hidden', isMobileOverrideChallengePlatform());
    document.getElementById('schedule-confirm-strictness-divider')?.classList.toggle('hidden', isMobileOverrideChallengePlatform());
}

export function closeScheduleConfirmModal() {
    document.getElementById('start-schedule-confirm-modal').classList.add('hidden');
    resetScheduleConfirmModalToStartLayout();
    state.pendingScheduleStartOverlayId = null;
    delete window.editScheduleData;
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

// Click handler for a scheduled block in the timeline: select the corresponding blocklist
// (so the schedule editor on the left switches to it) and open the blocklist edit dialog.
// The override flow is still reachable from the running-block actions; clicking a calendar
// block now goes straight to editing.
export function openScheduledBlockEdit(schedule) {
    const blocklist = state.appData.blocklists.find(bl => bl.id === schedule.blocklistId);
    if (!blocklist) return;

    const dropdown = document.getElementById('blocklist-select');
    if (dropdown) {
        dropdown.value = blocklist.id;
        handleBlocklistSelect({ target: dropdown });
    } else {
        state.selectedBlocklistId = blocklist.id;
    }

    openBlocklistModal(blocklist);
}


// Show confirmation modal for editing (adding segments to) an existing schedule
export function showScheduleEditConfirmModal(blocklist, existingSchedule, newSegments) {
    // Store references for the proceed function
    window.editScheduleData = {
        scheduleId: existingSchedule.id || existingSchedule.blocklistId,
        newSegments: newSegments
    };

    const modalContent = document.querySelector('#start-schedule-confirm-modal .start-confirm-modal');
    modalContent?.classList.add('schedule-confirm-edit-layout');

    const titleEl = document.getElementById('start-schedule-confirm-title');
    if (titleEl) {
        titleEl.textContent = tSettingsFmt('saveChangesTitleFmt', { name: blocklist.name });
    }

    setStartConfirmRoomChip(blocklist, SCHEDULE_CONFIRM_ROOM_CHIP_IDS);

    const overrideHeader = document.getElementById('schedule-confirm-override-header');
    if (overrideHeader) overrideHeader.textContent = tSettings('saveChangesHoldHeader');

    const segmentsEl = document.getElementById('schedule-confirm-segments');
    if (segmentsEl) {
        segmentsEl.innerHTML = `<div class="edit-schedule-notice">${tSettings('addingTheseSegments')}</div>`;
        newSegments.forEach((seg) => {
            segmentsEl.insertAdjacentHTML('beforeend', buildScheduleConfirmSegmentHtml(seg));
        });
    }

    // Populate override info — same computation as showScheduleConfirmModal so users see
    // the actual barrier, not just the header.
    const difficulty = blocklist.overrideDifficulty || { type: 'random-words', count: 50 };
    const displayCount = difficulty.type === 'custom'
        ? (difficulty.customText?.length || 0)
        : normalizeOverrideCount(difficulty.count || 50, difficulty.type);
    const estimatedMinutes = getOverrideEstimatedMinutes(
        difficulty.type,
        displayCount,
        difficulty.customText || ''
    );
    const schedType =
        difficulty.type === 'custom' && difficulty.customText
            ? 'custom'
            : difficulty.type === 'gibberish'
              ? 'gibberish'
              : 'random-words';
    setStartConfirmOverrideDescription({
        type: schedType,
        count: displayCount,
        estimatedMinutes,
        customText: difficulty.customText || ''
    }, 'schedule-confirm-override-text');

    setStartConfirmPrimaryLabel('proceed-schedule-confirm-btn', tSettings('pendingChangesSave'));

    // Show modal
    document.getElementById('start-schedule-confirm-modal').classList.remove('hidden');
}

// Add new segments to existing schedule
export async function proceedWithScheduleEdit() {
    // Grab editData BEFORE closing the modal — closeScheduleConfirmModal clears it.
    const editData = window.editScheduleData;
    closeScheduleConfirmModal();

    if (!editData) return;

    // Find the existing schedule
    const schedule = state.appData.schedules.find(s =>
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

    // Update state.activeScheduleSegmentCount to include the new segments
    state.activeScheduleSegmentCount = schedule.segments.length;
    state.scheduleSegments = schedule.segments.map(seg => ({ ...seg }));

    clearPendingScheduleDraft(state.selectedBlocklistId);

    // Save
    await saveData();

    console.log('Schedule updated with new segments:', schedule);

    resetScheduleConfirmModalToStartLayout();

    // Rebuild the DOM so it matches the new state.scheduleSegments order and locks the
    // formerly-pending segments. Without this, time-edit handlers attached to the
    // pre-save DOM nodes could write to the wrong state.scheduleSegments index.
    state.expandedScheduleSegmentIndex = getInitialExpandedScheduleSegmentIndex();
    rebuildScheduleSegments();
    disableScheduleControls(true);

    // Update UI
    updateScheduleButtonState();
    renderBlocklists();
    updateWeekCalendar();

    // If a newly committed segment covers the current moment, kick blocking on now
    // rather than waiting for the next periodic tick.
    await updateBlockedApps();
    await updateHostsFile();
    // Sync updated schedule to helper daemon so it picks up the new segments for
    // future autonomous transitions.
    await syncSchedulesToHelper();

    // Clean up
    delete window.editScheduleData;
}

// Actually create the schedule (called after confirmation)
export async function proceedWithSchedule() {
    const blocklist = state.appData.blocklists.find(bl => bl.id === state.selectedBlocklistId);
    if (!blocklist) return;
    if (isAndroidAllowlistUnsupported(blocklist)) {
        alert(tSettings('androidAllowlistUnsupported'));
        return;
    }

    const startOverlayId = getEffectiveScheduleStartOverlayId();
    rememberLastScheduleStartOverlayId(startOverlayId);
    closeScheduleConfirmModal();

    if (!ensureIOSBlocklistSelectionReady(blocklist, 'starting this schedule')) return;
    if (!await ensureIOSAllowlistStartable(blocklist)) return;

    // v2: no helper to install. The app itself is the engine; if it
    // launched, blocking works. The legacy helper-install-modal
    // branch was here.

    // Create schedule object
    const schedule = {
        id: crypto.randomUUID(),
        blocklistId: state.selectedBlocklistId,
        segments: state.scheduleSegments.map(seg => ({
            startHour: seg.startHour,
            startMinute: seg.startMinute,
            endHour: seg.endHour,
            endMinute: seg.endMinute,
            days: [...seg.days]
        })),
        repeatType: state.scheduleRepeatType,
        repeatDate: state.scheduleRepeatType === 'date' ? state.scheduleRepeatDate : null,
        createdAt: Date.now(),
        startOverlayId,
        allowEditsBetweenBlocks: !!state.draftAllowEditsBetweenBlocks,
    };

    // Save to state.appData
    state.appData.schedules.push(schedule);

    clearPendingScheduleDraft(state.selectedBlocklistId);

    await saveData();

    console.log('Schedule created:', schedule);

    // Update blocked apps if schedule is currently active
    await updateBlockedApps();
    // Update the active segment count to lock the created segments
    state.activeScheduleSegmentCount = state.scheduleSegments.length;

    // Reset schedule repeat options for next use
    state.scheduleRepeatType = 'forever';
    state.scheduleRepeatDate = null;

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
export function handleTimeChange() {
    const noBlocksMsg = document.getElementById('no-blocks-message');
    const startBtn = document.getElementById('start-block-btn');
    const nextDayIndicator = document.getElementById('next-day-indicator');

    // Remove any existing preview blocks and active-schedule blocks (for schedule mode)
    document.querySelectorAll('.calendar-block.preview, .calendar-block.active-schedule').forEach(el => el.remove());

    // Refresh the "Always on" row so any preview chip stays in sync with the current mode
    // (it shows up only when state.isAlwaysOnMode is on and a blocklist is selected).
    renderScheduleAlwaysOnRow();

    // Handle schedule mode separately
    if (state.isScheduleMode) {
        renderSchedulePreview();

        // Save pending schedule segments for this blocklist
        if (state.selectedBlocklistId) {
            if (!state.appData.settings) state.appData.settings = {};
            if (!state.appData.settings.pendingScheduleSegments) state.appData.settings.pendingScheduleSegments = {};

            const existingSchedule = state.appData.schedules?.find(s => s.blocklistId === state.selectedBlocklistId);

            if (!existingSchedule) {
                // No active schedule - save draft segments + repeat together
                const currentPending = JSON.stringify(state.appData.settings.pendingScheduleSegments[state.selectedBlocklistId] || []);
                const newPending = JSON.stringify(state.scheduleSegments);
                const nextRepeat = {
                    repeatType: state.scheduleRepeatType,
                    repeatDate:
                        state.scheduleRepeatType === 'date' && state.scheduleRepeatDate
                            ? state.scheduleRepeatDate.getTime()
                            : null
                };
                const prevRepeat = JSON.stringify(state.appData.settings.pendingScheduleRepeatOptions?.[state.selectedBlocklistId] ?? null);
                const nextRepeatJson = JSON.stringify(nextRepeat);
                if (currentPending !== newPending) {
                    state.appData.settings.pendingScheduleSegments[state.selectedBlocklistId] = state.scheduleSegments.map(seg => ({ ...seg }));
                }
                if (!state.appData.settings.pendingScheduleRepeatOptions) state.appData.settings.pendingScheduleRepeatOptions = {};
                if (prevRepeat !== nextRepeatJson) {
                    state.appData.settings.pendingScheduleRepeatOptions[state.selectedBlocklistId] = nextRepeat;
                }
                if (currentPending !== newPending || prevRepeat !== nextRepeatJson) {
                    saveData();
                }
            } else {
                // Active schedule exists - save only NEW segments (those beyond state.activeScheduleSegmentCount)
                const committedSegmentCount = getCommittedScheduleSegmentCount(existingSchedule);
                if (state.scheduleSegments.length > committedSegmentCount) {
                    const newSegments = state.scheduleSegments.slice(committedSegmentCount);
                    const currentPending = JSON.stringify(state.appData.settings.pendingScheduleSegments[state.selectedBlocklistId] || []);
                    const newPending = JSON.stringify(newSegments);
                    if (currentPending !== newPending) {
                        state.appData.settings.pendingScheduleSegments[state.selectedBlocklistId] = newSegments.map(seg => ({ ...seg }));
                        saveData();
                    }
                } else {
                    // No new segments - clear any pending segments
                    if (state.appData.settings.pendingScheduleSegments?.[state.selectedBlocklistId]) {
                        clearPendingScheduleDraft(state.selectedBlocklistId);
                        saveData();
                    }
                }
            }
        }
        return;
    }

    // --- Always-on mode: preview shows up only as a chip in the "Always on" row above the
    // calendar, not as a bar inside the timeline. The chip is added by the call to
    // renderScheduleAlwaysOnRow() at the top of this function.
    if (state.isAlwaysOnMode) {
        startBtn.disabled = !state.selectedBlocklistId;

        if (nextDayIndicator) nextDayIndicator.classList.add('hidden');

        if (noBlocksMsg) noBlocksMsg.classList.add('hidden');

        updateWindowHeight();
        return;
    }

    // --- Instant mode logic ---
    // Get times (start is always now)
    let blockStart = getStartTimeAsDate();
    let blockEnd = getEndTimeAsDate();

    // Determine block end time
    if (!state.userEditedEndTime && state.targetDurationMinutes > 0) {
        // If driving by duration, exact calculation
        blockEnd = new Date(blockStart.getTime() + state.targetDurationMinutes * 60 * 1000);
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
    const endH = document.getElementById('end-hour-input');
    const endM = document.getElementById('end-minute-input');
    const ae = document.activeElement;
    if (
        durationInput &&
        ae !== durationInput &&
        ae !== endH &&
        ae !== endM
    ) {
        durationInput.value = durationMinutes;
    }
    updateDurationQuickBtns(durationMinutes);

    // Save duration to settings per-blocklist so it persists across blocklist selections
    if (state.selectedBlocklistId) {
        if (!state.appData.settings) state.appData.settings = {};
        if (!state.appData.settings.instantBlockDuration) state.appData.settings.instantBlockDuration = {};
        if (state.appData.settings.instantBlockDuration[state.selectedBlocklistId] !== durationMinutes) {
            state.appData.settings.instantBlockDuration[state.selectedBlocklistId] = durationMinutes;
            saveData();
        }
    }

    startBtn.disabled = !state.selectedBlocklistId;
    if (noBlocksMsg) {
        noBlocksMsg.classList.add('hidden');
    }

    // Create preview block in week calendar (only if no active block for this blocklist)
    const blocklist = state.appData.blocklists.find(bl => bl.id === state.selectedBlocklistId);
    const now = Date.now();
    const hasActiveBlock = blocklist && state.appData.activeBlocks.some(b => b.blocklistId === state.selectedBlocklistId && b.startTime <= now && b.endTime > now);

    if (blocklist && !hasActiveBlock) {
        renderInstantPreviewBlock(blockStart, blockEnd, blocklist);
    }

    updateWindowHeight();
}

// Re-draw in-flight Now/Schedule preview bars after renderWeekBlocks() clears day tracks
// (e.g. window focus, blocklist colour change, or updateWeekCalendar rebuild).
export function refreshCalendarPreviews() {
    if (!state.selectedBlocklistId) return;

    if (state.isScheduleMode) {
        renderSchedulePreview();
        return;
    }

    if (state.isAlwaysOnMode) return;

    const blocklist = state.appData.blocklists.find(bl => bl.id === state.selectedBlocklistId);
    if (!blocklist) return;

    const now = Date.now();
    const hasActiveBlock = state.appData.activeBlocks.some(
        b => b.blocklistId === state.selectedBlocklistId && b.startTime <= now && b.endTime > now
    );
    if (hasActiveBlock) return;

    let blockStart = getStartTimeAsDate();
    let blockEnd = getEndTimeAsDate();
    if (!state.userEditedEndTime && state.targetDurationMinutes > 0) {
        blockEnd = new Date(blockStart.getTime() + state.targetDurationMinutes * 60 * 1000);
    } else if (blockEnd <= blockStart) {
        blockEnd.setDate(blockEnd.getDate() + 1);
    }

    const durationMinutes = Math.round((blockEnd.getTime() - blockStart.getTime()) / 60000);
    if (durationMinutes <= 0) return;

    renderInstantPreviewBlock(blockStart, blockEnd, blocklist);
}

// Render an instant-mode preview block onto the weekly calendar by projecting from
// now → blockEnd onto today's row (and onto tomorrow's row if the duration crosses
// midnight). The "head" slice on today's row gets a right-edge resize handle so the
// user can drag to adjust the block's duration. Continuation tails on later days stay
// non-interactive and are redrawn when the head is released.
export function renderInstantPreviewBlock(blockStart, blockEnd, blocklist) {
    document.querySelectorAll('.calendar-block.preview').forEach(el => el.remove());

    const startMs = blockStart.getTime();
    const endMs = blockEnd.getTime();

    let cursor = new Date(startMs);
    cursor.setHours(0, 0, 0, 0);

    let isFirstSlice = true;
    let headEl = null;
    let headTrack = null;

    while (cursor.getTime() <= endMs) {
        const dayStartMs = cursor.getTime();
        const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000 - 1;
        const sliceStartMs = Math.max(startMs, dayStartMs);
        const sliceEndMs = Math.min(endMs, dayEndMs);

        if (sliceEndMs > sliceStartMs) {
            const sliceDate = new Date(sliceStartMs);
            const jsDay = sliceDate.getDay();
            const dayIndex = jsDay === 0 ? 6 : jsDay - 1;
            const track = document.querySelector(`.day-track[data-day-index="${dayIndex}"]`);
            if (track) {
                const layout = getCalendarSegmentLayout(sliceStartMs, sliceEndMs, dayStartMs, dayEndMs);
                const previewEl = document.createElement('div');
                const isHead = isFirstSlice;
                previewEl.className = 'calendar-block preview' + (isHead ? ' interactive instant-preview' : ' overnight-continuation');
                previewEl.style.left = `${layout.leftPercent}%`;
                previewEl.style.width = `${layout.widthPercent}%`;
                previewEl.dataset.previewGroupId = 'preview-instant';
                if (!isHead) previewEl.dataset.continuation = '1';

                if (blocklist.color) {
                    previewEl.style.background = blocklist.color;
                    previewEl.style.color = getContrastTextColor(blocklist.color);
                }

                // Only the head slice gets a right-edge handle. The start is "now" so
                // there's no left-edge handle (you can't reschedule the start of an
                // instant block).
                const resizeHandle = isHead
                    ? '<div class="resize-handle resize-handle-end" data-handle="end" title="Drag to change end time"></div>'
                    : '';

                previewEl.innerHTML = `
                    ${resizeHandle}
                    <span class="block-emoji">${blocklist.emoji || '🚫'}</span>
                    <span class="block-label">${escapeHtml(blocklist.name)}</span>
                    <span class="block-time">${formatTime(layout.segmentStartDate)} - ${formatTime(layout.segmentEndDate)}</span>
                `;

                track.appendChild(previewEl);

                if (isHead) {
                    headEl = previewEl;
                    headTrack = track;
                }
            }
        }

        cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
        isFirstSlice = false;
    }

    if (headEl && headTrack) {
        attachInstantPreviewResizeHandler(headEl, headTrack);
    }

    layoutOverlappingBlocks();
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

// Attach a right-edge resize handler to the instant-mode preview's head element. Dragging
// the handle live-updates the head's width and on release commits the new total duration:
// duration = head's new width (in minutes). Tails on later days are not adjusted in
// real time; they're killed/redrawn cleanly on release via handleTimeChange().
export function attachInstantPreviewResizeHandler(headEl, headTrack) {
    const handle = headEl.querySelector('.resize-handle-end');
    if (!handle) return;

    const snapMinutes = 15;
    const minDurationMinutes = 5;
    let isResizing = false;
    let startX = 0;
    let startWidthPct = 0;

    handle.addEventListener('pointerenter', () => headEl.classList.add('resize-hover'));
    handle.addEventListener('pointerleave', () => headEl.classList.remove('resize-hover'));

    bindPointerDragSession(headEl, {
        onStart(e) {
            if (!e.target.closest('.resize-handle-end')) return false;
            isResizing = true;
            startX = e.clientX;
            startWidthPct = parseFloat(headEl.style.width) || 0;
            headEl.classList.add('resizing');
            document.body.style.cursor = 'ew-resize';
        },
        onMove: onPointerMove,
        onEnd: onPointerUp
    });

    function onPointerMove(e) {
        if (!isResizing) return;
        const trackRect = headTrack.getBoundingClientRect();
        if (trackRect.width <= 0) return;

        const deltaX = e.clientX - startX;
        const deltaPct = (deltaX / trackRect.width) * 100;
        const headLeftPct = parseFloat(headEl.style.left) || 0;
        // Clamp the head so it can't shrink to nothing or extend past end-of-day.
        // Extending past midnight would require drawing/moving tail elements, which we
        // intentionally skip to keep the live preview simple — the user can still type
        // a longer duration into the Duration input for multi-day blocks.
        const minWidthPct = (minDurationMinutes / 1440) * 100;
        const maxWidthPct = 100 - headLeftPct;
        const newWidthPct = Math.max(minWidthPct, Math.min(maxWidthPct, startWidthPct + deltaPct));
        headEl.style.width = `${newWidthPct}%`;

        // Live-update the "HH:MM - HH:MM" label so it tracks the cursor instead of
        // staying frozen at the pre-drag value until release.
        const startMins = (headLeftPct / 100) * 1440;
        const endMins = ((headLeftPct + newWidthPct) / 100) * 1440;
        const timeEl = headEl.querySelector('.block-time');
        if (timeEl) {
            timeEl.textContent = `${formatMinutesAsHHMM(startMins)} - ${formatMinutesAsHHMM(endMins)}`;
        }
    }

    function onPointerUp() {
        if (!isResizing) return;
        isResizing = false;
        headEl.classList.remove('resizing');
        headEl.classList.remove('resize-hover');
        document.body.style.cursor = '';

        const headWidthPct = parseFloat(headEl.style.width) || 0;
        // The head starts at "now" within today's row, so its width in minutes = its
        // width-as-percent-of-day × 1440. That's also the new total duration for the
        // block (any continuation tails are dropped — drag-to-resize sets the end here).
        let newDurationMinutes = Math.round((headWidthPct / 100) * 1440);
        newDurationMinutes = Math.max(minDurationMinutes, Math.round(newDurationMinutes / snapMinutes) * snapMinutes);

        const startTime = getStartTimeAsDate();
        const newEndTime = new Date(startTime.getTime() + newDurationMinutes * 60 * 1000);

        state.targetDurationMinutes = newDurationMinutes;
        state.userEditedEndTime = false;
        state.selectedEndHour = newEndTime.getHours();
        state.selectedEndMinute = newEndTime.getMinutes();

        const durationInput = document.getElementById('duration-minutes-input');
        if (durationInput) durationInput.value = newDurationMinutes;

        // If the user was on always-on mode, dragging the preview's right edge implicitly
        // switches them into timed mode (now there's a concrete end time again).
        if (state.isAlwaysOnMode) setAlwaysOnMode(false);

        updateTimeDisplay();
        handleTimeChange();
    }
}

// Render schedule preview blocks on the calendar
// Render preview blocks for the schedule the user is currently building. Previews are drawn
// for every weekday selected in the segment's `days`. For non-repeating drafts, only days
// that have a one-shot occurrence still ahead of "now" are rendered.
export function renderSchedulePreview() {
    if (!state.selectedBlocklistId) return;

    const blocklist = state.appData.blocklists.find(bl => bl.id === state.selectedBlocklistId);
    if (!blocklist) return;

    const draftCreatedAt = Date.now();
    const shouldRepeat = state.scheduleRepeatType === 'forever' || state.scheduleRepeatType === 'date';

    if (!shouldRepeat) {
        const draftOccurrences = resolveOneShotOccurrences({
            repeatType: 'no',
            createdAt: draftCreatedAt,
            segments: state.scheduleSegments
        }).filter(occurrence => occurrence.segmentIndex >= state.activeScheduleSegmentCount);

        draftOccurrences.forEach(occurrence => {
            renderPreviewSegmentOnWeekday(blocklist, state.scheduleSegments[occurrence.segmentIndex], occurrence.segmentIndex, occurrence.dayIndex);
        });

        layoutOverlappingBlocks();
        return;
    }

    state.scheduleSegments.forEach((segment, segmentIndex) => {
        const isLockedSegment = segmentIndex < state.activeScheduleSegmentCount;
        if (isLockedSegment) return;

        const segmentDays = segment.days || [];
        segmentDays.forEach(dayIndex => {
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

    if (!isContinuation && state.isScheduleMode) {
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
    const emoji = blocklist.emoji || '🎯';
    const name = blocklist.name || '';
    titleEl.textContent = name ? `${emoji} ${name}` : emoji;
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
    // Desktop-only body class: list-only home + fullscreen enter/settings/create/quick-start.
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
    if (show) {
        const blocklist = state.appData.blocklists.find((bl) => bl.id === state.selectedBlocklistId);
        setSchedulerRoomChip(blocklist);
    }
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

// Handle blocklist selection.
// Enter sheet (iPhone, or desktop ≤718px) only opens when openEnterUi is true.
export function handleBlocklistSelect(e, { openEnterUi = false } = {}) {
    if (state.suppressBlocklistSelectChange) return;
    const newBlocklistId = e.target.value || null;

    // Before switching, save pending changes for the current blocklist
    if (state.selectedBlocklistId) {
        // Save pending schedule segments if in schedule mode
        if (state.isScheduleMode) {
            const existingSchedule = state.appData.schedules?.find(s => s.blocklistId === state.selectedBlocklistId);
            if (!state.appData.settings) state.appData.settings = {};
            if (!state.appData.settings.pendingScheduleSegments) state.appData.settings.pendingScheduleSegments = {};

            if (!existingSchedule) {
                // No active schedule - save all segments
                if (state.scheduleSegments.length > 0) {
                    state.appData.settings.pendingScheduleSegments[state.selectedBlocklistId] = state.scheduleSegments.map(seg => ({ ...seg }));
                    saveData();
                }
            } else {
                // Active schedule exists - save only NEW segments (those beyond state.activeScheduleSegmentCount)
                const committedSegmentCount = getCommittedScheduleSegmentCount(existingSchedule);
                if (state.scheduleSegments.length > committedSegmentCount) {
                    const newSegments = state.scheduleSegments.slice(committedSegmentCount);
                    state.appData.settings.pendingScheduleSegments[state.selectedBlocklistId] = newSegments.map(seg => ({ ...seg }));
                    saveData();
                } else {
                    // No new segments - clear any pending segments
                    if (state.appData.settings.pendingScheduleSegments?.[state.selectedBlocklistId]) {
                        clearPendingScheduleDraft(state.selectedBlocklistId);
                        saveData();
                    }
                }
            }
        } else {
            // Save pending instant block duration if in instant mode
            if (!state.appData.settings) state.appData.settings = {};
            if (!state.appData.settings.instantBlockDuration) state.appData.settings.instantBlockDuration = {};
            if (state.targetDurationMinutes !== 60) { // Only save if different from default
                state.appData.settings.instantBlockDuration[state.selectedBlocklistId] = state.targetDurationMinutes;
                saveData();
            }
        }
    }

    state.selectedBlocklistId = newBlocklistId;
    if (newBlocklistId) state.userExplicitlyDeselected = false;

    const timePicker = document.getElementById('time-picker-container');
    const passwordHint = document.getElementById('password-hint');
    const selectionPrompt = document.getElementById('selection-prompt');
    const startBlockBtn = document.getElementById('start-block-btn');
    const startScheduleBtn = document.getElementById('start-schedule-btn');

    if (state.selectedBlocklistId) {
        // Determine which mode to show based on active blocks/schedules
        const blocklist = state.appData.blocklists.find(bl => bl.id === state.selectedBlocklistId);
        const now = Date.now();

        // Check if there's an active block (one-off)
        const hasActiveBlock = blocklist && state.appData.activeBlocks.some(b =>
            b.blocklistId === state.selectedBlocklistId && b.startTime <= now && b.endTime > now
        );

        // Check if there's an active schedule
        const existingSchedule = state.appData.schedules
            ? state.appData.schedules.find(s => s.blocklistId === state.selectedBlocklistId)
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
            const preferredSchedule = state.appData.settings?.preferredStartMode?.[state.selectedBlocklistId];
            setScheduleMode(preferredSchedule === true);
        }

        // Hide selection prompt, show time picker, hint, and appropriate button
        if (selectionPrompt) selectionPrompt.classList.add('hidden');
        timePicker.classList.remove('hidden');
        if (passwordHint) passwordHint.classList.remove('hidden');

        // Show the appropriate button based on mode
        if (state.isScheduleMode) {
            if (startBlockBtn) startBlockBtn.classList.add('hidden');
            if (startScheduleBtn) {
                startScheduleBtn.classList.remove('hidden');
                updateScheduleButtonState();
            }
        } else {
            if (startScheduleBtn) startScheduleBtn.classList.add('hidden');
            if (startBlockBtn) {
                startBlockBtn.classList.remove('hidden');

                const blocklist = state.appData.blocklists.find(bl => bl.id === state.selectedBlocklistId);
                const now = Date.now();
                // IMPORTANT: Only find active block for THIS specific blocklist
                const activeBlock = state.appData.activeBlocks.find(b =>
                    b.blocklistId === state.selectedBlocklistId &&
                    b.startTime <= now &&
                    b.endTime > now
                );

                if (blocklist) {
                    const btnLabel = startBlockBtn.querySelector('.btn-label');

                    // Always clear the activeBlockId first to prevent cross-blocklist issues
                    delete startBlockBtn.dataset.activeBlockId;
                    startBlockBtn.classList.remove('stop-block');

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
                        setBtnActionLabel(btnLabel, tSettings('startBlockButton'), { simple: true });
                        setStartBtnBlocklistInfo(startBlockBtn, blocklist);
                        setStartBlockBtnLeadingIcon(startBlockBtn, 'enter');
                        disableTimeControls(false);

                        const alwaysOnMsg = document.getElementById('always-on-message');
                        if (alwaysOnMsg) alwaysOnMsg.classList.toggle('hidden', !state.isAlwaysOnMode);
                    }
                }
                syncPauseButtonForSelectedBlocklist();
            }
        }
        initializeTimeInputs();
    } else {
        // Show selection prompt, hide time picker, hint, and both buttons
        if (selectionPrompt && !isMobilePhoneDevice()) selectionPrompt.classList.remove('hidden');
        else if (selectionPrompt) selectionPrompt.classList.add('hidden');
        timePicker.classList.add('hidden');
        if (passwordHint) passwordHint.classList.add('hidden');
        if (startBlockBtn) startBlockBtn.classList.add('hidden');
        if (startScheduleBtn) startScheduleBtn.classList.add('hidden');
        const pauseBtn = document.getElementById('pause-block-btn');
        if (pauseBtn) pauseBtn.classList.add('hidden');
    }

    syncSchedulerChromeVisibility();

    // Update visual selection state on blocklist cards
    renderBlocklists();

    handleTimeChange(); // Update button state and preview

    const selectedBlocklist = state.selectedBlocklistId
        ? state.appData.blocklists.find((bl) => bl.id === state.selectedBlocklistId)
        : null;
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
    const currentBlocklistId = state.selectedBlocklistId;
    if (state.isScheduleMode) {
        const existingSchedule = state.appData.schedules?.find(s => s.blocklistId === currentBlocklistId);
        if (!state.appData.settings) state.appData.settings = {};
        if (!state.appData.settings.pendingScheduleSegments) state.appData.settings.pendingScheduleSegments = {};

        if (!existingSchedule) {
            if (state.scheduleSegments.length > 0) {
                state.appData.settings.pendingScheduleSegments[currentBlocklistId] = state.scheduleSegments.map(seg => ({ ...seg }));
                saveData();
            }
        } else {
            const committedSegmentCount = getCommittedScheduleSegmentCount(existingSchedule);
            if (state.scheduleSegments.length > committedSegmentCount) {
                const newSegments = state.scheduleSegments.slice(committedSegmentCount);
                state.appData.settings.pendingScheduleSegments[currentBlocklistId] = newSegments.map(seg => ({ ...seg }));
                saveData();
                } else {
                    // No new segments - clear any pending segments
                    if (state.appData.settings.pendingScheduleSegments?.[currentBlocklistId]) {
                        clearPendingScheduleDraft(currentBlocklistId);
                        saveData();
                    }
                }
        }
    } else {
        if (!state.appData.settings) state.appData.settings = {};
        if (!state.appData.settings.instantBlockDuration) state.appData.settings.instantBlockDuration = {};
        if (state.targetDurationMinutes !== 60) {
            state.appData.settings.instantBlockDuration[currentBlocklistId] = state.targetDurationMinutes;
            saveData();
        }
    }
    state.selectedBlocklistId = null;
    const blocklistSelect = document.getElementById('blocklist-select');
    blocklistSelect.value = '';
    handleBlocklistSelect({ target: blocklistSelect });
}

// Show start block confirmation modal
export function startBlock() {
    if (!state.selectedBlocklistId) return;

    const blocklist = state.appData.blocklists.find(bl => bl.id === state.selectedBlocklistId);
    if (!blocklist) return;

    // Check if this is a "Stop Block" action (button is in stop mode)
    const startBlockBtn = document.getElementById('start-block-btn');
    if (startBlockBtn && startBlockBtn.dataset.activeBlockId) {
        // Verify the activeBlockId belongs to the currently selected blocklist
        const activeBlock = state.appData.activeBlocks.find(b =>
            b.id === startBlockBtn.dataset.activeBlockId &&
            b.blocklistId === state.selectedBlocklistId
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
    let blockStart = getStartTimeAsDate();
    let blockEnd = getEndTimeAsDate();
    if (!state.isAlwaysOnMode && blockEnd <= blockStart) {
        blockEnd = new Date(blockEnd);
        blockEnd.setDate(blockEnd.getDate() + 1);
    }

    setStartConfirmRoomChip(blocklist);

    const titleEl = document.getElementById('start-block-confirm-title');
    if (titleEl) titleEl.textContent = tSettings('startThisBlock');

    const subtitleEl = document.getElementById('start-confirm-subtitle');
    if (subtitleEl) {
        subtitleEl.innerHTML = formatStartBlockSubtitle(blocklist, state.isAlwaysOnMode, blockStart, blockEnd);
    }

    setConfirmModalBlockingLabel(blocklist, 'start-confirm-blocking-label');

    const durationEl = document.getElementById('start-confirm-duration');
    if (durationEl) {
        durationEl.innerHTML = formatStartBlockDurationCopy(state.isAlwaysOnMode, blockStart, blockEnd);
    }

    renderStartConfirmBlockingDetails(
        blocklist,
        document.getElementById('start-confirm-blocking-list'),
        document.getElementById('start-confirm-show-all-blocking'),
        document.getElementById('start-confirm-blocking-row'),
    );

    // Build override difficulty text with time estimate
    const difficulty = blocklist.overrideDifficulty || { type: 'random-words', count: 50 };
    const displayCount = difficulty.type === 'custom'
        ? (difficulty.customText?.length || 0)
        : normalizeOverrideCount(difficulty.count, difficulty.type);
    const estimatedMinutes = getOverrideEstimatedMinutes(
        difficulty.type,
        displayCount,
        difficulty.customText || ''
    );
    const startType =
        difficulty.type === 'custom' && difficulty.customText
            ? 'custom'
            : difficulty.type === 'gibberish'
              ? 'gibberish'
              : 'random-words';

    setStartConfirmOverrideDescription({
        type: startType,
        count: displayCount,
        estimatedMinutes,
        customText: difficulty.customText || ''
    });

    // Show modal
    document.getElementById('start-block-confirm-modal').classList.remove('hidden');
}

// Close start block confirmation modal
export function closeStartBlockConfirmModal({ keepPendingQuickStart = false } = {}) {
    document.getElementById('start-block-confirm-modal').classList.add('hidden');
    // Reset resume state and restore default text
    if (resumeData) {
        resumeData = null;
        document.getElementById('start-block-confirm-title').textContent = tSettings('startThisBlock');
        setStartConfirmPrimaryLabel('proceed-start-confirm-btn', tSettings('startBlock'));
    }
    // Cancel/backdrop/Escape: drop a Quick start draft that never started.
    // proceedWithBlock passes keepPendingQuickStart so it can settle after start.
    if (!keepPendingQuickStart) {
        void discardPendingQuickStart();
    }
}

// Actually start a block (called after confirmation)
export async function proceedWithBlock() {
    // If this is a resume action, delegate to proceedWithResume
    if (resumeData) {
        await proceedWithResume();
        return;
    }

    // Close confirmation modal (keep Quick start draft until we know if start succeeded)
    closeStartBlockConfirmModal({ keepPendingQuickStart: true });

    try {
        await runProceedWithBlock();
    } finally {
        await settlePendingQuickStart();
    }
}

async function runProceedWithBlock() {
    const startBtn = document.getElementById('start-block-btn');

    if (!state.selectedBlocklistId) return;

    // Get times from the custom time picker
    let blockStart = getStartTimeAsDate();
    let blockEnd;

    if (state.isAlwaysOnMode) {
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

    const blocklist = state.appData.blocklists.find(bl => bl.id === state.selectedBlocklistId);
    if (!blocklist) {
        startBtn.disabled = false;
        startBtn.innerHTML = getStartBlockButtonHTML();
        return;
    }
    if (isAndroidAllowlistUnsupported(blocklist)) {
        startBtn.disabled = false;
        startBtn.innerHTML = getStartBlockButtonHTML();
        alert(tSettings('androidAllowlistUnsupported'));
        return;
    }
    if (!ensureIOSBlocklistSelectionReady(blocklist, 'starting this block')) {
        startBtn.disabled = false;
        startBtn.innerHTML = getStartBlockButtonHTML();
        return;
    }
    if (!await ensureIOSAllowlistStartable(blocklist)) {
        startBtn.disabled = false;
        startBtn.innerHTML = getStartBlockButtonHTML();
        return;
    }

    const block = {
        id: generateId(),
        blocklistId: state.selectedBlocklistId,
        startTime: blockStart.getTime(),
        endTime: blockEnd.getTime()
    };

    // Mark always-on blocks with a flag for display purposes
    if (state.isAlwaysOnMode) {
        block.isAlwaysOn = true;
    }

    let result;

    if (state.isIOS) {
        // iOS: Use Screen Time API via plugin
        if (!state.screentimeAuthorized) {
            const authResult = await requestScreentimeAuth();
            if (!authResult.granted) {
                startBtn.disabled = false;
                startBtn.innerHTML = getStartBlockButtonHTML();
                if (authResult.status === 'denied') {
                    alert('Screen Time authorization was denied. Please go to Settings > Screen Time > Digital Habits: Blocker and enable access.');
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
            state.appData.activeBlocks.push(block);
            state.activatedBlockIds.add(block.id);
            const updateResult = await updateHostsFile();
            if (!updateResult.success) {
                state.appData.activeBlocks = state.appData.activeBlocks.filter(b => b.id !== block.id);
                state.activatedBlockIds.delete(block.id);
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
                            categoryTokenData: iosPayload.categoryTokenData,
                            mode: isAllowlistBlocklist(blocklist) ? 'allowlist' : null
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
            state.appData.activeBlocks = state.appData.activeBlocks.filter(b => b.id !== block.id);
            state.activatedBlockIds.delete(block.id);
            result = { success: false, error: err.toString() };
        }
    } else if (state.isAndroid) {
        // Android: push locally, sync (creates the MANUAL Schedule entity
        // in Kotlin), then explicitly start the session — set_schedules
        // alone doesn't activate a MANUAL schedule, see syncSchedulesToHelper.
        try {
            state.appData.activeBlocks.push(block);
            await saveData();
            await syncSchedulesToHelper();
            const endTimestampMs = (block.isAlwaysOn || block.endTime >= ALWAYS_ON_END_TIME) ? null : block.endTime;
            const startResult = await tauriAPI.androidStartManualBlock(block.id, endTimestampMs);
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
        // native-messaging host see it immediately (state.helperAvailable only
        // gates legacy helper-daemon wiring, not v2 extension blocking).
        state.appData.activeBlocks.push(block);
        state.activatedBlockIds.add(block.id);

        if (state.helperAvailable) {
            const status = await tauriAPI.checkHelperStatus();
            if (!status.running || !status.version_ok) {
                state.helperAvailable = false;
            }
        }
        // v2: the app process IS the helper. startBlockViaHelper is a
        // no-op shim; extension blocking follows from save_data below.
        result = await tauriAPI.startBlockViaHelper({
            domains: blocklist.websites || [],
            endTime: blockEnd.getTime(),
            blocklistId: state.selectedBlocklistId
        });
    }

    if (!result.success) {
        if (!state.isIOS) {
            state.appData.activeBlocks = state.appData.activeBlocks.filter(b => b.id !== block.id);
            state.activatedBlockIds.delete(block.id);
        }
        // Re-enable button
        startBtn.disabled = false;
        startBtn.innerHTML = getStartBlockButtonHTML();

        // Only show error if user didn't cancel
        if (!result.cancelled) {
            if (isHelperConnectionError(result.error)) {
                state.helperAvailable = false;
                alert('The block service isn\'t running. Please open Settings, remove the helper, then try starting a block again to reinstall it.');
            } else {
                alert('Could not start block: ' + (result.error || 'Unknown error'));
            }
        }
        return;
    }

    // Clear pending duration for this blocklist (it's now committed)
    if (state.appData.settings?.instantBlockDuration?.[state.selectedBlocklistId]) {
        delete state.appData.settings.instantBlockDuration[state.selectedBlocklistId];
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

    refreshSelectedBlocklistUi();
}

// Helper function for start block button HTML (includes .btn-label and .btn-blocklist-meta wrapper)
export function getStartBlockButtonHTML() {
    return `
        ${START_FOCUS_SPACE_PLAY_ICON}
        ${STOP_ACTION_SQUARE_ICON}
        <span class="btn-label">${escapeHtml(tSettings('startBlockButton'))}</span>
        <span class="btn-blocklist-meta">
            <span class="btn-blocklist-lead" aria-hidden="true"></span>
            <span class="btn-emoji" aria-hidden="true"></span>
            <span class="btn-name"></span>
        </span>
    `;
}

// Render an action label like "Stop Schedule:" / "Start blokering:" as two
// inner spans so narrow viewports can hide the trailing context (and the
// .btn-emoji + .btn-name beside it) and just show "Stop" / "Start". Splits
// at the first space so it works for any locale that follows verb-then-noun.
export function getActionLabelHTML(fullText) {
    const safe = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    let text = String(fullText ?? '').trimEnd();
    // Colon before blocklist meta is added in CSS when meta is visible (see .btn-label-context::after).
    if (text.endsWith(':')) text = text.slice(0, -1);
    const spaceIdx = text.indexOf(' ');
    if (spaceIdx <= 0) return safe(text);
    const action = text.slice(0, spaceIdx);
    const context = text.slice(spaceIdx);
    return `<span class="btn-label-action">${safe(action)}</span><span class="btn-label-context">${safe(context)}</span>`;
}

export function setBtnActionLabel(el, fullText, { simple = false } = {}) {
    if (!el) return;
    if (simple) {
        el.textContent = String(fullText ?? '').trimEnd();
        return;
    }
    el.innerHTML = getActionLabelHTML(fullText);
}

// The visible colon is added in CSS on .btn-label-context for stop-block only.
export function syncStartBtnBlocklistMetaLead(btn) {
    if (!btn) return;
    const lead = btn.querySelector('.btn-blocklist-lead');
    if (!lead) return;
    lead.textContent = '';
}

export function measureStopBtnExpandedWidth(btn) {
    if (!btn) return 0;
    const clone = btn.cloneNode(true);
    clone.classList.remove('hidden', 'stop-meta-collapsed');
    clone.style.position = 'absolute';
    clone.style.visibility = 'hidden';
    clone.style.pointerEvents = 'none';
    clone.style.width = 'auto';
    clone.style.maxWidth = 'none';
    clone.style.minWidth = '0';
    clone.style.left = '-99999px';
    clone.style.top = '0';
    document.body.appendChild(clone);
    const width = clone.getBoundingClientRect().width;
    clone.remove();
    return width;
}

export function syncStopBtnLabelFit(btn) {
    if (!btn) return;
    btn.classList.remove('stop-meta-collapsed');
    syncStartBtnBlocklistMetaLead(btn);

    const isActionBtn = btn.id === 'start-block-btn' || btn.id === 'start-schedule-btn';
    if (!isActionBtn || btn.classList.contains('hidden') || btn.clientWidth <= 0) return;

    const isStop = btn.classList.contains('stop-block') || btn.classList.contains('stop-schedule');
    if (!isStop) return;

    if (state.isIOS || state.isAndroid) {
        btn.classList.add('stop-meta-collapsed');
        return;
    }

    const buttonRow = btn.parentElement;
    const rowStyle = buttonRow ? window.getComputedStyle(buttonRow) : null;
    const rowGap = rowStyle ? (parseFloat(rowStyle.columnGap || rowStyle.gap) || 0) : 0;
    const visibleButtons = buttonRow
        ? Array.from(buttonRow.children).filter(el => el instanceof HTMLElement && !el.classList.contains('hidden') && el.getClientRects().length > 0)
        : [btn];
    const otherButtonsWidth = visibleButtons
        .filter(el => el !== btn)
        .reduce((total, el) => total + el.getBoundingClientRect().width, 0);
    const availableBtnWidth = buttonRow
        ? buttonRow.clientWidth - otherButtonsWidth - (Math.max(0, visibleButtons.length - 1) * rowGap)
        : btn.clientWidth;
    const expandedBtnWidth = measureStopBtnExpandedWidth(btn);
    const fitSlackPx = state.isIOS ? IOS_STOP_BTN_META_COLLAPSE_SLACK_PX : 1;
    const shouldCollapseForWidth = expandedBtnWidth > 0
        && expandedBtnWidth > availableBtnWidth - fitSlackPx;

    if (shouldCollapseForWidth || btn.scrollWidth > btn.clientWidth + 1) {
        btn.classList.add('stop-meta-collapsed');
    }
}

export function syncAllStopBtnLabelFits() {
    ['start-block-btn', 'start-schedule-btn'].forEach((id) => {
        const btn = document.getElementById(id);
        if (btn) syncStopBtnLabelFit(btn);
    });
}

// Update emoji and name on stop buttons only — enter/start labels stand alone.
export function setStartBtnBlocklistInfo(btn, blocklist) {
    if (!btn) return;
    const btnEmoji = btn.querySelector('.btn-emoji');
    const btnName = btn.querySelector('.btn-name');
    const isStop = btn.classList.contains('stop-block') || btn.classList.contains('stop-schedule');
    if (!isStop) {
        if (btnEmoji) btnEmoji.textContent = '';
        if (btnName) btnName.textContent = '';
        btn.classList.remove('stop-meta-collapsed');
        return;
    }
    if (btnEmoji) btnEmoji.textContent = blocklist ? (blocklist.emoji || '🚫') : '';
    if (btnName) btnName.textContent = blocklist ? blocklist.name : '';
    syncStopBtnLabelFit(btn);
}


// Update hosts file based on active blocks
// silent = true means don't prompt for password (used for cleanup)


// Blocklist modal: --blocklist-tint colours the website/app tag chips;
// --blocklist-tag-text is black or white for readable labels (from the
// picker / swatch handlers). The input well stays the normal input bg.
// Pass null on close to clear the custom properties.
export function applyModalBlocklistTint(hexColor) {
    const modal = document.getElementById('blocklist-modal');
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
function syncBlocklistEditFrictionUi(blocklist, now = Date.now(), { preserveModalItems = false } = {}) {
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
            window.setModalData(
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
        window.setModalData(
            blocklist?.websites || [],
            getBlocklistRegularApps(blocklist),
            getBlocklistIOSScreenTimeSelection(blocklist),
            [],
            []
        );
    }

    if (maxDifficultyOn) setOverrideCountMaxMode(true);
}

// Open blocklist modal
export function openBlocklistModal(blocklist = null, options = {}) {
    // Keep narrow-desktop sheet chrome in sync before showing create/edit.
    syncEnterSchedulerSheetLayout();
    // Quick Start temporarily reuses the apps/tag bridge; restore the blocklist
    // modal's own bridge every time this modal opens in case another close path
    // left the global handlers pointed elsewhere.
    window.restoreBlocklistModalTagBridges?.();

    state.editingBlocklistId = blocklist?.id || null;
    state.blocklistModalPreviewSnapshot = null;

    if (state.editingBlocklistId) {
        const original = state.appData.blocklists.find(b => b.id === state.editingBlocklistId);
        if (original) {
            state.blocklistModalPreviewSnapshot = {
                showItemDetails: original.showItemDetails
            };
        }
    }

    const mode = blocklist?.mode === 'allowlist' || options.mode === 'allowlist'
        ? 'allowlist'
        : 'blocklist';
    document.getElementById('modal-title').textContent = blocklist
        ? tSettings('editBlocklist')
        : tSettings(mode === 'allowlist' ? 'createAllowlist' : 'createBlocklist');
    setBlocklistModalMode(mode);
    setBlocklistCreateKind('new-list');
    resetEmbeddedQuickStartControls();
    syncBlocklistCreateKindUi({ isCreate: !blocklist });

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

        // Find first color from the palette that isn't used
        const firstUnused = swatches.find(s => !usedColors.has(s.dataset.color));

        if (firstUnused) {
            colorToSelect = firstUnused.dataset.color;
        } else if (swatches.length > 0) {
            // If all are used, wrap around to the first one
            colorToSelect = swatches[0].dataset.color;
        } else {
            // Fallback default — first colour in the palette.
            colorToSelect = '#B8D1DE';
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

    applyModalBlocklistTint(colorToSelect);

    // Restore emoji swatch selection
    document.querySelectorAll('.emoji-swatch').forEach(s => s.classList.remove('selected'));

    let emojiToSelect = blocklist?.emoji;

    // If creating a new blocklist (or no emoji set), find the first unused emoji
    if (!emojiToSelect) {
        const usedEmojis = new Set(state.appData.blocklists.map(bl => bl.emoji));
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
            emojiToSelect = '📱';
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

    syncBlocklistEditFrictionUi(blocklist);

    // Set advanced options - default to checked (true) if not set
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

    // Reset advanced options to collapsed state
    const blocklistAdvancedToggle = document.getElementById('blocklist-advanced-toggle');
    const blocklistAdvancedContent = document.getElementById('blocklist-advanced-content');
    if (blocklistAdvancedToggle && blocklistAdvancedContent) {
        blocklistAdvancedToggle.classList.remove('expanded');
        blocklistAdvancedContent.classList.add('hidden');
    }

    document.getElementById('blocklist-modal').classList.remove('hidden');
}

// Close blocklist modal
export function closeBlocklistModal() {
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

    // Revert temporary live-preview edits if dialog closes without save.
    if (state.editingBlocklistId && state.blocklistModalPreviewSnapshot) {
        const bl = state.appData.blocklists.find(b => b.id === state.editingBlocklistId);
        if (bl) {
            bl.showItemDetails = state.blocklistModalPreviewSnapshot.showItemDetails;
            renderWeekBlocks();
            renderBlocklists();
        }
    }

    const showItemDetailsCheckbox = document.getElementById('show-item-details-checkbox');
    if (showItemDetailsCheckbox) showItemDetailsCheckbox.onchange = null;

    // Reset the websites Import popover so it starts closed next open.
    const importMenu = document.getElementById('websites-import-menu');
    const importBtn = document.getElementById('modal-import-websites-btn');
    if (importMenu) {
        importMenu.classList.add('hidden');
        resetWebsitesImportMenuPosition();
    }
    if (importBtn) importBtn.setAttribute('aria-expanded', 'false');

    state.blocklistModalPreviewSnapshot = null;
    document.getElementById('blocklist-modal').classList.add('hidden');
    applyModalBlocklistTint(null);
    state.editingBlocklistId = null;
    document.getElementById('blocklist-name').value = '';
    window.setModalData([], [], null);
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

/** Which timer or schedule row the pause button should act on for the current mode. */
export function getPauseTargetForSelectedBlocklist(now = Date.now()) {
    if (!state.selectedBlocklistId) return null;
    const blocklistId = state.selectedBlocklistId;

    if (state.isScheduleMode) {
        const schedule = state.appData.schedules?.find(s => s.blocklistId === blocklistId);
        if (!schedule?.segments?.length) return null;
        return { type: 'schedule', schedule, blocklistId };
    }

    const block = state.appData.activeBlocks.find(b =>
        b.blocklistId === blocklistId && b.startTime <= now && b.endTime > now
    );
    if (!block) return null;
    return { type: 'block', block, blockId: block.id, blocklistId };
}

export function syncPauseButtonForSelectedBlocklist(now = Date.now()) {
    const pauseBtn = document.getElementById('pause-block-btn');
    if (!pauseBtn) return;

    const target = getPauseTargetForSelectedBlocklist(now);
    if (!target) {
        pauseBtn.classList.add('hidden');
        return;
    }

    pauseBtn.classList.remove('hidden');
    const isPaused = target.type === 'block'
        ? !!target.block.isPaused
        : isSchedulePausedNow(target.schedule, now);
    updatePauseButtonAppearance(isPaused);
}

export function handlePauseBlockButtonClick() {
    const target = getPauseTargetForSelectedBlocklist();
    if (!target) return;

    if (target.type === 'block') {
        if (target.block.isPaused) {
            openResumeConfirmation(target.blocklistId, 'block', target.blockId);
        } else {
            state.pauseScheduleData = null;
            openPauseModal(target.blockId);
        }
        return;
    }

    if (isSchedulePausedNow(target.schedule)) {
        openResumeConfirmation(target.blocklistId, 'schedule', null);
        return;
    }

    state.pauseScheduleData = {
        blocklistId: target.blocklistId,
        isActiveNow: isScheduleSegmentActiveNow(target.schedule),
        frictionless: canEditScheduleBetweenBlocks(target.schedule),
    };
    openPauseModal(null);
}

// Update the pause button's icon and text based on whether the block/schedule is paused
export function updatePauseButtonAppearance(isPaused) {
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

export function openResumeConfirmation(blocklistId, type, blockId) {
    const blocklist = state.appData.blocklists.find(bl => bl.id === blocklistId);
    if (!blocklist) return;

    resumeData = { blocklistId, type, blockId };

    setStartConfirmRoomChip(blocklist);

    document.getElementById('start-block-confirm-title').textContent = getResumeBlockConfirmTitle(blocklist);

    const subtitleEl = document.getElementById('start-confirm-subtitle');
    if (subtitleEl) subtitleEl.innerHTML = tSettings('resumeBlockSubtitle');

    setConfirmModalBlockingLabel(blocklist, 'start-confirm-blocking-label');

    const durationEl = document.getElementById('start-confirm-duration');
    if (type === 'block') {
        const block = state.appData.activeBlocks.find(b => b.id === blockId);
        if (block && durationEl) {
            const remainingMs = block.endTime - Date.now();
            if (isBlockAlwaysOn(block)) {
                durationEl.innerHTML = `<strong>${escapeHtml(tSettings('alwaysUntilOff'))}</strong>`;
            } else {
                const remainingMins = Math.max(1, Math.floor(remainingMs / 60000));
                const hours = Math.floor(remainingMins / 60);
                const mins = remainingMins % 60;
                let dText;
                if (hours > 0 && mins > 0) dText = `${hours}h ${mins}m remaining`;
                else if (hours > 0) dText = `${hours} hour${hours > 1 ? 's' : ''} remaining`;
                else dText = `${mins} minute${mins > 1 ? 's' : ''} remaining`;
                durationEl.innerHTML = `<strong>${escapeHtml(dText)}</strong>`;
            }
        }
    } else if (durationEl) {
        durationEl.innerHTML = `<strong>${escapeHtml(tSettings('scheduleResumingSegment'))}</strong>`;
    }

    renderStartConfirmBlockingDetails(
        blocklist,
        document.getElementById('start-confirm-blocking-list'),
        document.getElementById('start-confirm-show-all-blocking'),
        document.getElementById('start-confirm-blocking-row'),
    );

    // Override info
    const difficulty = blocklist.overrideDifficulty || { type: 'random-words', count: 50 };
    const displayCount = difficulty.type === 'custom'
        ? (difficulty.customText?.length || 0)
        : normalizeOverrideCount(difficulty.count, difficulty.type);
    const estimatedMinutes = getOverrideEstimatedMinutes(
        difficulty.type,
        displayCount,
        difficulty.customText || ''
    );
    const resumeType =
        difficulty.type === 'custom' && difficulty.customText
            ? 'custom'
            : difficulty.type === 'gibberish'
              ? 'gibberish'
              : 'random-words';

    setStartConfirmOverrideDescription({
        type: resumeType,
        count: displayCount,
        estimatedMinutes,
        resumeShortGibberish: resumeType === 'gibberish',
        customText: difficulty.customText || ''
    });

    setStartConfirmPrimaryLabel('proceed-start-confirm-btn', tSettings('resumeBlock'));

    // Show modal
    document.getElementById('start-block-confirm-modal').classList.remove('hidden');
}

// Actually resume a paused block/schedule
export async function proceedWithResume() {
    if (!resumeData) return;

    // Save locally before closeStartBlockConfirmModal clears resumeData
    const { type, blockId, blocklistId } = resumeData;

    closeStartBlockConfirmModal();

    if (type === 'block') {
        const block = state.appData.activeBlocks.find(b => b.id === blockId);
        if (block) {
            delete block.isPaused;
            delete block.pauseEndTime;
        }
    } else if (type === 'schedule') {
        const schedule = state.appData.schedules?.find(s => s.blocklistId === blocklistId);
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
    syncPauseButtonForSelectedBlocklist();
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
    syncPauseButtonForSelectedBlocklist();
    const editingBlocklist = state.appData.blocklists.find(bl => bl.id === state.editingBlocklistId);
    if (editingBlocklist
        && editingBlocklist.id === pausedBlocklistId
        && !document.getElementById('blocklist-modal')?.classList.contains('hidden')) {
        syncBlocklistEditFrictionUi(editingBlocklist, Date.now(), { preserveModalItems: true });
    }
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
