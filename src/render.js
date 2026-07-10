// Main render cycle: week calendar, now-blocking chips, blocklist selector
// sync, and the 1s tick loop. Extracted verbatim from app.js.
import { state } from './state.js';
import { escapeHtml, getContrastTextColor } from './utils.js';
import { tSettings, weekdayAbbrevMon0List } from './i18n.js';
import { isBlockAlwaysOn } from './blocklist-utils.js';
import { isNonRepeatingSchedule, isSchedulePausedNow, pickEarliestUpcomingScheduledBlock, resolveOneShotOccurrences, syncActiveBlocksToHelper, syncSchedulesToHelper, formatTitleBarScheduleStartWhen } from './schedule-engine.js';
import { saveData, updateHostsFile } from './persistence.js';
import { disableTimeControls, updateTimeDisplay } from './time-inputs.js';
import { isScheduleSegmentActiveNow, updateScheduleButtonState } from './schedule-editor.js';
import { autoSelectSoleBlocklist, renderBlocklists } from './blocklists.js';
import { updateBlockedApps, updateOnboardingVisibility, updateWindowHeight } from './blocking-platform.js';
import { handleBlocklistSelect, openBlocklistModal, openOverrideModal, openPauseModal, openScheduleOverrideModal, setBtnActionLabel, setStartBlockBtnLeadingIcon, setStartBtnBlocklistInfo, syncPauseButtonForSelectedBlocklist, syncSchedulerChromeVisibility, syncStopBtnLabelFit, openScheduledBlockEdit, refreshCalendarPreviews, handleTimeChange } from './confirm-modals.js';
import { scheduleSelectionPromptLayout } from './theme.js';
import { updateCleanHostsBtnState, updateOverrideAllButtonVisibility } from './settings.js';
import {
    formatBlockTimeRemainingShort, formatDuration, formatTime,
    syncNowBlockingChipsScrollability,
} from './app.js';

export function render() {
    updateOnboardingVisibility();

    renderNowBlockingRow();
    updateWeekCalendar();
    renderBlocklistSelector();

    // Auto-select when the choice is unambiguous, but respect a user
    // deselect so they can return to the empty "Select a blocklist"
    // state if they want.
    //   - Exactly one blocklist exists → default-select it.
    //   - Otherwise, if nothing is selected, fall back to selecting
    //     the lone non-active blocklist if there's exactly one.
    if (state.appData.blocklists.length === 1) {
        autoSelectSoleBlocklist();
    } else if (!state.selectedBlocklistId && !state.userExplicitlyDeselected) {
        const activeIds = state.appData.activeBlocks.map(b => b.blocklistId);
        const availableBlocklists = state.appData.blocklists.filter(bl => !activeIds.includes(bl.id));
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
        if (state.appData.blocklists.length === 0) {
            selectionPrompt.classList.add('hidden');
        } else if (!state.selectedBlocklistId) {
            // Only show prompt if there are blocklists but none selected
            selectionPrompt.classList.remove('hidden');
        }
    }

    syncSchedulerChromeVisibility();

    scheduleSelectionPromptLayout();

    // Adjust window height to fit content
    updateWindowHeight();
}

export function syncSelectedControlState() {
    if (!state.selectedBlocklistId) {
        updateOverrideAllButtonVisibility();
        updateCleanHostsBtnState();
        return;
    }
    if (state.isScheduleMode) {
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
    const blocklist = state.appData.blocklists.find(bl => bl.id === state.selectedBlocklistId);
    const now = Date.now();
    const activeBlock = state.appData.activeBlocks.find(b => b.blocklistId === state.selectedBlocklistId && b.startTime <= now && b.endTime > now);
    const btnLabel = startBlockBtn.querySelector('.btn-label');
    const alwaysOnMsg = document.getElementById('always-on-message');
    delete startBlockBtn.dataset.activeBlockId;
    startBlockBtn.classList.remove('stop-block');
    if (activeBlock) {
        startBlockBtn.classList.add('stop-block');
        setBtnActionLabel(btnLabel, tSettings('stopBlock'));
        setStartBtnBlocklistInfo(startBlockBtn, blocklist);
        startBlockBtn.dataset.activeBlockId = activeBlock.id;
        setStartBlockBtnLeadingIcon(startBlockBtn, 'stop');
        disableTimeControls(true);
        if (alwaysOnMsg) alwaysOnMsg.classList.toggle('hidden', !isBlockAlwaysOn(activeBlock));
    } else {
                setBtnActionLabel(btnLabel, tSettings('startBlockButton'), { simple: true });
                setStartBtnBlocklistInfo(startBlockBtn, blocklist);
        setStartBlockBtnLeadingIcon(startBlockBtn, 'enter');
        disableTimeControls(false);
        if (alwaysOnMsg) alwaysOnMsg.classList.toggle('hidden', !state.isAlwaysOnMode);
    }
    syncPauseButtonForSelectedBlocklist(now);
    startBlockBtn.disabled = !state.selectedBlocklistId;
    syncStopBtnLabelFit(startBlockBtn);
    updateOverrideAllButtonVisibility();
    updateCleanHostsBtnState();
}

// Render the generic weekly schedule: fixed Mon..Sun rows with a horizontal time axis.
// The view is dateless — every row represents a weekday, and today's row is highlighted.
export function updateWeekCalendar() {
    const dayRows = document.getElementById('day-rows');
    const hourMarkers = document.getElementById('hour-markers');

    if (!dayRows || !hourMarkers) return;

    // Hour markers across the timeline (every 3 hours: 00, 03, 06, 09, 12, 15, 18, 21).
    hourMarkers.innerHTML = '';
    for (let h = 0; h <= 21; h += 3) {
        const marker = document.createElement('div');
        marker.className = 'hour-marker';
        marker.style.left = `${(h / 24) * 100}%`;
        marker.textContent = String(h).padStart(2, '0');
        hourMarkers.appendChild(marker);
    }

    dayRows.innerHTML = '';
    // Day names in our internal order: 0=Mon, 1=Tue, ... 6=Sun.
    const dayNamesMon0 = weekdayAbbrevMon0List();
    const todayJsDay = new Date().getDay(); // 0=Sun..6=Sat
    const todayDayIndex = todayJsDay === 0 ? 6 : todayJsDay - 1;

    for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
        const isToday = dayIndex === todayDayIndex;
        const isWeekend = dayIndex === 5 || dayIndex === 6; // Sat, Sun

        const row = document.createElement('div');
        row.className = 'day-row';
        if (isToday) row.classList.add('today');
        if (isWeekend) row.classList.add('weekend');
        row.dataset.dayIndex = dayIndex;

        const label = document.createElement('div');
        label.className = 'day-label';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'day-name';
        nameSpan.textContent = dayNamesMon0[dayIndex];
        label.appendChild(nameSpan);

        if (isToday) {
            const todaySpan = document.createElement('span');
            todaySpan.className = 'day-date';
            todaySpan.textContent = tSettings('today');
            label.appendChild(todaySpan);
        }

        const track = document.createElement('div');
        track.className = 'day-track';
        if (state.isScheduleMode) track.classList.add('schedule-mode');
        track.dataset.dayIndex = dayIndex;

        if (isToday) {
            const now = new Date();
            const nowMinutes = now.getHours() * 60 + now.getMinutes();
            const nowIndicator = document.createElement('div');
            nowIndicator.className = 'now-indicator';
            nowIndicator.id = 'now-indicator';
            nowIndicator.style.left = `${(nowMinutes / 1440) * 100}%`;
            track.appendChild(nowIndicator);
        }

        row.append(label, track);
        dayRows.appendChild(row);
    }

    renderWeekBlocks();
}

// Convert a time interval (clamped to a single day) into horizontal positioning for the
// row-based timeline (left%/width% of the day track) and also keep top/height as legacy
// values for any callers still using them.
export function getCalendarSegmentLayout(segmentStartMs, segmentEndMs, dayStartMs, dayEndMs) {
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
        leftPercent: (startMinutes / 1440) * 100,
        widthPercent: Math.max(0.5, ((endMinutes - startMinutes) / 1440) * 100),
        topPosition: (startMinutes / 60) * 40,
        height: Math.max(20, ((endMinutes - startMinutes) / 60) * 40),
        startMinutes,
        endMinutes,
        segmentStartDate,
        segmentEndDate
    };
}

// Render active manual blocks on the weekly calendar by projecting their concrete
// timestamps onto the matching weekday(s). Overnight blocks render two halves on
// consecutive weekdays. Fully-past blocks are not drawn.
export function renderWeekBlocks() {
    const noBlocksMsg = document.getElementById('no-blocks-message');
    const now = Date.now();

    // Clear existing blocks from all day tracks (preserve the now-indicator on today).
    document.querySelectorAll('.day-track').forEach(track => {
        const nowIndicator = track.querySelector('#now-indicator');
        track.innerHTML = '';
        if (nowIndicator) track.appendChild(nowIndicator);
    });

    // Always-on active blocks are represented in the "Always on" pill row instead of
    // being drawn as bars across the timeline.
    const visibleBlocks = state.appData.activeBlocks.filter(block =>
        !isBlockAlwaysOn(block) && block.endTime > now
    );

    const hasSchedules = state.appData.schedules && state.appData.schedules.length > 0;
    const hasAlwaysOnBlocks = state.appData.activeBlocks.some(b => isBlockAlwaysOn(b));

    // Hide the "No active blocks" overlay — empty calendar is self-explanatory.
    noBlocksMsg?.classList.add('hidden');

    visibleBlocks.forEach(block => {
        const blocklist = state.appData.blocklists.find(bl => bl.id === block.blocklistId);
        if (!blocklist) return;

        // The eye chip above the schedule is authoritative — hidden means hidden,
        // even if the blocklist is currently selected.
        if (blocklist.alwaysShowInSchedule === false) {
            return;
        }

        const isRunning = block.startTime <= now;
        renderManualBlockOnWeekdays(block, blocklist, isRunning);
    });

    renderScheduledCalendarBlocks();
    layoutOverlappingBlocks();
    renderScheduleAlwaysOnRow();
    renderScheduleVisibilityChips();
    refreshCalendarPreviews();
}

// Build a calendar block element for a manual one-off block on a specific weekday slice.
export function buildManualBlockElement(block, blocklist, leftPct, widthPct, segmentStartDate, segmentEndDate, isRunning) {
    const blockEl = document.createElement('div');
    blockEl.className = 'calendar-block';
    if (isRunning) blockEl.classList.add('running');
    blockEl.dataset.blockId = block.id;
    blockEl.style.left = `${leftPct}%`;
    blockEl.style.width = `${widthPct}%`;

    if (blocklist.color) {
        blockEl.style.background = blocklist.color;
        blockEl.style.color = getContrastTextColor(blocklist.color);
    }

    // Show "until HH:MM" for currently-running blocks; otherwise show the block's range.
    const timeLabel = isRunning
        ? `until ${formatTime(segmentEndDate)}`
        : `${formatTime(segmentStartDate)} - ${formatTime(segmentEndDate)}`;

    blockEl.innerHTML = `
        <span class="block-emoji">${blocklist.emoji || '🚫'}</span>
        <span class="block-label">${escapeHtml(blocklist.name)}</span>
        <span class="block-time">${timeLabel}</span>
    `;

    blockEl.addEventListener('click', (e) => {
        e.stopPropagation();
        openOverrideModal(block.id);
    });

    return blockEl;
}

// Render a manual block onto the weekly grid by computing the weekday(s) it spans.
// Multi-day blocks are split per weekday; today's slice is clamped to start at "now" so
// running blocks visually begin at the now-indicator.
export function renderManualBlockOnWeekdays(block, blocklist, isRunning) {
    const startDate = new Date(block.startTime);
    const endDate = new Date(block.endTime);
    const now = Date.now();

    const startDay = new Date(startDate);
    startDay.setHours(0, 0, 0, 0);
    const endDay = new Date(endDate);
    endDay.setHours(0, 0, 0, 0);

    let cursor = new Date(startDay);
    while (cursor.getTime() <= endDay.getTime()) {
        const sliceDayStartMs = cursor.getTime();
        const sliceDayEndMs = sliceDayStartMs + 24 * 60 * 60 * 1000 - 1;

        let sliceStartMs = Math.max(block.startTime, sliceDayStartMs);
        const sliceEndMs = Math.min(block.endTime, sliceDayEndMs);

        // For the currently-running slice, clamp the visible start to "now" so the bar
        // doesn't draw over time that has already elapsed.
        if (isRunning && now > sliceStartMs && now < sliceEndMs) {
            sliceStartMs = now;
        }

        // Skip past slices entirely.
        if (sliceEndMs <= now) {
            cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
            continue;
        }

        const sliceDate = new Date(sliceStartMs);
        const jsDay = sliceDate.getDay();
        const dayIndex = jsDay === 0 ? 6 : jsDay - 1;
        const track = document.querySelector(`.day-track[data-day-index="${dayIndex}"]`);
        if (track) {
            const layout = getCalendarSegmentLayout(sliceStartMs, sliceEndMs, sliceDayStartMs, sliceDayEndMs);
            const blockEl = buildManualBlockElement(
                block, blocklist,
                layout.leftPercent, layout.widthPercent,
                layout.segmentStartDate, layout.segmentEndDate,
                isRunning && sliceStartMs <= now && now < sliceEndMs
            );
            track.appendChild(blockEl);
        }

        cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    }
}


// Compute when the schedule's currently-active segment ends, returning a Date.
// Returns null if no segment is active right now. Handles repeating, overnight, and
// non-repeating schedules. Used by the "BLOCKING NOW" row to show "until HH:MM".
export function getScheduleCurrentSegmentEnd(schedule, nowDate = new Date()) {
    if (!isScheduleSegmentActiveNow(schedule, nowDate)) return null;

    if (isNonRepeatingSchedule(schedule)) {
        const nowMs = nowDate.getTime();
        const occurrence = resolveOneShotOccurrences(schedule).find(occ =>
            nowMs >= occ.start.getTime() && nowMs < occ.end.getTime()
        );
        return occurrence ? new Date(occurrence.end) : null;
    }

    const currentDay = nowDate.getDay() === 0 ? 6 : nowDate.getDay() - 1; // Mon=0
    const currentMins = nowDate.getHours() * 60 + nowDate.getMinutes();
    const yesterdayDay = currentDay === 0 ? 6 : currentDay - 1;

    for (const seg of schedule.segments) {
        const startMins = seg.startHour * 60 + seg.startMinute;
        const endMins = seg.endHour * 60 + seg.endMinute;
        const days = Array.isArray(seg.days) ? seg.days : [];

        // 24/7 segment: use end-of-day for the "until" label so we have something concrete.
        if (startMins === endMins && days.includes(currentDay)) {
            const end = new Date(nowDate);
            end.setHours(23, 59, 0, 0);
            return end;
        }
        // Same-day window matching now.
        if (endMins > startMins && days.includes(currentDay) && currentMins >= startMins && currentMins < endMins) {
            const end = new Date(nowDate);
            end.setHours(seg.endHour, seg.endMinute, 0, 0);
            return end;
        }
        // Overnight head: started yesterday-evening side, but it's stored on `currentDay`.
        if (endMins < startMins && days.includes(currentDay) && currentMins >= startMins) {
            const end = new Date(nowDate);
            end.setDate(end.getDate() + 1);
            end.setHours(seg.endHour, seg.endMinute, 0, 0);
            return end;
        }
        // Overnight tail: today is the morning side of yesterday's segment.
        if (endMins < startMins && days.includes(yesterdayDay) && currentMins < endMins) {
            const end = new Date(nowDate);
            end.setHours(seg.endHour, seg.endMinute, 0, 0);
            return end;
        }
    }
    return null;
}

// Build the list of items to show in the "BLOCKING NOW" row: every one-off block that's
// currently running (and not paused) plus every schedule whose segment is active now.
export function collectNowBlockingEntries(now = Date.now()) {
    const nowDate = new Date(now);
    const entries = [];

    for (const block of state.appData.activeBlocks || []) {
        if (block.startTime > now || block.endTime <= now || block.isPaused) continue;
        const blocklist = state.appData.blocklists.find(bl => bl.id === block.blocklistId);
        if (!blocklist) continue;
        entries.push({
            kind: 'block',
            id: block.id,
            blocklistId: block.blocklistId,
            blocklist,
            until: isBlockAlwaysOn(block) ? null : new Date(block.endTime),
            isAlwaysOn: isBlockAlwaysOn(block)
        });
    }

    for (const schedule of state.appData.schedules || []) {
        if (!isScheduleSegmentActiveNow(schedule, nowDate)) continue;
        const blocklist = state.appData.blocklists.find(bl => bl.id === schedule.blocklistId);
        if (!blocklist) continue;
        // A schedule and a one-off for the same blocklist could both be active; keep both
        // (they're independent rules) so the user can act on whichever they intend.
        entries.push({
            kind: 'schedule',
            id: schedule.id || schedule.blocklistId,
            blocklistId: schedule.blocklistId,
            blocklist,
            schedule,
            until: getScheduleCurrentSegmentEnd(schedule, nowDate),
            isAlwaysOn: false
        });
    }

    // Sort to match the visual order of the "My Blocklists" section, which iterates
    // `state.appData.blocklists` in array order. Entries whose blocklist isn't found in that
    // array (shouldn't happen, but be safe) sort to the end. Within a single blocklist,
    // one-off blocks come before schedules so explicit user-started actions read first.
    const order = new Map(state.appData.blocklists.map((bl, i) => [bl.id, i]));
    const kindRank = { block: 0, schedule: 1 };
    entries.sort((a, b) => {
        const ai = order.has(a.blocklistId) ? order.get(a.blocklistId) : Number.MAX_SAFE_INTEGER;
        const bi = order.has(b.blocklistId) ? order.get(b.blocklistId) : Number.MAX_SAFE_INTEGER;
        if (ai !== bi) return ai - bi;
        return (kindRank[a.kind] ?? 9) - (kindRank[b.kind] ?? 9);
    });

    return entries;
}

// Close any currently-open chip menu popover. Called from outside-click handlers and
// before opening a new menu (so only one is ever visible).
export function closeNowBlockingChipMenus() {
    document.querySelectorAll('.now-blocking-chip-menu-btn[aria-expanded="true"]').forEach(btn => {
        if (btn._chipMenuOutsideClick) {
            document.removeEventListener('click', btn._chipMenuOutsideClick, true);
            delete btn._chipMenuOutsideClick;
        }
        btn.setAttribute('aria-expanded', 'false');
    });
    document.querySelectorAll('.now-blocking-chip-menu').forEach(el => el.remove());
}

// Open a small Edit / Pause / Stop popover anchored to `triggerBtn` for the given entry.
export function openNowBlockingChipMenu(triggerBtn, entry) {
    closeNowBlockingChipMenus();

    const menu = document.createElement('div');
    menu.className = 'now-blocking-chip-menu';
    menu.setAttribute('role', 'menu');

    // square = Stop focus space button (matches the Lucide icon on the main action button).
    const editIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>';
    const pauseIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
    const stopIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>';

    const items = [
        { label: tSettings('nowBlockingMenuEdit'), icon: editIcon, action: () => handleNowBlockingEdit(entry) },
        { label: tSettings('nowBlockingMenuPause'), icon: pauseIcon, action: () => handleNowBlockingPause(entry) },
        { label: tSettings('nowBlockingMenuStop'), icon: stopIcon, action: () => handleNowBlockingStop(entry), danger: true }
    ];

    items.forEach(item => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'now-blocking-chip-menu-item' + (item.danger ? ' danger' : '');
        btn.setAttribute('role', 'menuitem');
        btn.innerHTML = `${item.icon}<span>${escapeHtml(item.label)}</span>`;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeNowBlockingChipMenus();
            item.action();
        });
        menu.appendChild(btn);
    });

    document.body.appendChild(menu);

    // Position the menu just below the trigger, keeping it on-screen horizontally.
    const rect = triggerBtn.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    let left = rect.right - menuRect.width;
    if (left < 8) left = 8;
    const maxLeft = window.innerWidth - menuRect.width - 8;
    if (left > maxLeft) left = maxLeft;
    menu.style.left = `${left + window.scrollX}px`;
    menu.style.top = `${rect.bottom + window.scrollY + 4}px`;

    triggerBtn.setAttribute('aria-expanded', 'true');

    // Outside-click closes the menu. Escape is handled by dismissTopmostEscapeLayer()
    // (chip menu is checked first). Delay so the opening click doesn't close immediately.
    setTimeout(() => {
        const onDocClick = (e) => {
            if (!menu.contains(e.target) && !triggerBtn.contains(e.target)) {
                closeNowBlockingChipMenus();
                document.removeEventListener('click', onDocClick, true);
                delete triggerBtn._chipMenuOutsideClick;
            }
        };
        triggerBtn._chipMenuOutsideClick = onDocClick;
        document.addEventListener('click', onDocClick, true);
    }, 0);
}

// Edit action: select the chip's blocklist and open the blocklist edit dialog.
export function handleNowBlockingEdit(entry) {
    const blocklist = entry.blocklist;
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

// Pause action: open the pause modal for the corresponding block or schedule.
export function handleNowBlockingPause(entry) {
    if (entry.kind === 'block') {
        state.pauseScheduleData = null;
        openPauseModal(entry.id);
        return;
    }
    if (entry.kind === 'schedule') {
        state.pauseScheduleData = {
            blocklistId: entry.blocklistId,
            isActiveNow: true
        };
        openPauseModal(null);
    }
}

// Stop action: open the override modal so the user has to type the challenge to stop.
export function handleNowBlockingStop(entry) {
    if (entry.kind === 'block') {
        openOverrideModal(entry.id);
        return;
    }
    if (entry.kind === 'schedule' && entry.schedule) {
        openScheduleOverrideModal(entry.schedule);
    }
}

export function buildNowBlockingIdleMessage(nowMs = Date.now()) {
    const upcoming = pickEarliestUpcomingScheduledBlock(nowMs);
    if (!upcoming) {
        return tSettings('titleBarNoActiveBlocks');
    }
    const whenPhrase = formatTitleBarScheduleStartWhen(new Date(upcoming.startMs), nowMs);
    const emojiRaw = upcoming.blocklist.emoji != null ? String(upcoming.blocklist.emoji).trim() : '';
    const emoji = emojiRaw || '🚫';
    return tSettings('titleBarNextScheduleStarts')
        .replace('{emoji}', emoji)
        .replace('{name}', upcoming.blocklist.name || '')
        .replace('{when}', whenPhrase);
}

/** True when the idle title-bar row already shows `idleMessage` with the expected DOM shape. */
export function isNowBlockingIdleDisplayCurrent(row, chipsEl, idleMessage) {
    if (!row?.classList.contains('idle')) return false;
    const existingIdle = document.getElementById('now-blocking-idle-msg');
    if (!existingIdle || existingIdle.parentElement !== chipsEl) return false;
    if (chipsEl.childElementCount !== 1) return false;
    if (existingIdle.textContent !== idleMessage) return false;
    if (row.getAttribute('aria-labelledby') !== 'now-blocking-idle-msg') return false;
    return true;
}

export function buildNowBlockingUntilText(entry, nowMs = Date.now()) {
    if (entry.isAlwaysOn) {
        return tSettings('nowBlockingAlways');
    }
    if (!entry.until) return '';
    const remainMs = entry.until - nowMs;
    if (remainMs <= 0) return '';
    const totalMins = Math.ceil(remainMs / 60000);
    return formatBlockTimeRemainingShort(totalMins);
}

/** True when active chips already match `entries` in order, shape, and static labels. */
export function isNowBlockingActiveChipsCurrent(row, chipsEl, entries) {
    if (row.classList.contains('idle')) return false;
    if (row.getAttribute('aria-labelledby') !== 'now-blocking-label-text') return false;
    const manyActive = entries.length > 2;
    if (row.classList.contains('many-active-chips') !== manyActive) return false;
    const chips = chipsEl.querySelectorAll('.now-blocking-chip');
    if (chips.length !== entries.length) return false;

    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const chip = chips[i];
        if (chip.dataset.kind !== entry.kind || chip.dataset.id !== String(entry.id)) {
            return false;
        }
        const emojiEl = chip.querySelector('.now-blocking-chip-emoji');
        const nameEl = chip.querySelector('.now-blocking-chip-name');
        const menuBtn = chip.querySelector('.now-blocking-chip-menu-btn');
        if (!emojiEl || !nameEl || !menuBtn) return false;
        const emoji = entry.blocklist.emoji || '🚫';
        const name = entry.blocklist.name || '';
        if (emojiEl.textContent !== emoji || nameEl.textContent !== name) return false;
    }
    return true;
}

/** Patch countdown copy on existing chips — skips DOM rebuild and menu listener churn. */
export function updateNowBlockingActiveChipTexts(chipsEl, entries, nowMs = Date.now()) {
    const chips = chipsEl.querySelectorAll('.now-blocking-chip');
    const manyActive = entries.length > 2;
    chips.forEach((chip, i) => {
        const entry = entries[i];
        const untilText = buildNowBlockingUntilText(entry, nowMs);
        let untilEl = chip.querySelector('.now-blocking-chip-until');
        if (untilText) {
            if (!untilEl) {
                untilEl = document.createElement('span');
                untilEl.className = 'now-blocking-chip-until';
                const menuBtn = chip.querySelector('.now-blocking-chip-menu-btn');
                chip.insertBefore(untilEl, menuBtn);
            }
            if (untilEl.textContent !== untilText) {
                untilEl.textContent = untilText;
            }
        } else if (untilEl) {
            untilEl.remove();
        }

        if (manyActive) {
            const name = entry.blocklist.name || '';
            const emoji = entry.blocklist.emoji || '🚫';
            const namePart = String(name || '').trim() || emoji;
            const labelBits = untilText ? [namePart, untilText] : [namePart];
            const nextLabel = labelBits.join('. ');
            if (chip.getAttribute('aria-label') !== nextLabel) {
                chip.setAttribute('aria-label', nextLabel);
            }
        } else {
            chip.removeAttribute('aria-label');
        }
    });
}

export const NOW_BLOCKING_CHIP_MENU_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>';

export function appendNowBlockingChip(chipsEl, entry, entries, nowMs) {
    const chip = document.createElement('div');
    chip.className = 'now-blocking-chip';
    chip.dataset.kind = entry.kind;
    chip.dataset.id = String(entry.id);

    const emoji = entry.blocklist.emoji || '🚫';
    const name = entry.blocklist.name || '';
    const untilText = buildNowBlockingUntilText(entry, nowMs);

    chip.innerHTML = `
        <span class="now-blocking-chip-emoji">${escapeHtml(emoji)}</span>
        <span class="now-blocking-chip-name">${escapeHtml(name)}</span>
        ${untilText ? `<span class="now-blocking-chip-until">${escapeHtml(untilText)}</span>` : ''}
    `;

    if (entries.length > 2) {
        const namePart = String(name || '').trim() || emoji;
        const labelBits = untilText ? [namePart, untilText] : [namePart];
        chip.setAttribute('aria-label', labelBits.join('. '));
    }

    const menuBtn = document.createElement('button');
    menuBtn.type = 'button';
    menuBtn.className = 'now-blocking-chip-menu-btn';
    menuBtn.setAttribute('aria-haspopup', 'menu');
    menuBtn.setAttribute('aria-expanded', 'false');
    menuBtn.setAttribute('aria-label', tSettings('nowBlockingMenuAria'));
    menuBtn.title = tSettings('nowBlockingMenuAria');
    menuBtn.innerHTML = NOW_BLOCKING_CHIP_MENU_ICON;
    menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = menuBtn.getAttribute('aria-expanded') === 'true';
        if (isOpen) {
            closeNowBlockingChipMenus();
        } else {
            openNowBlockingChipMenu(menuBtn, entry);
        }
    });
    chip.appendChild(menuBtn);

    chipsEl.appendChild(chip);
}

// Render the title-bar status row: active chips — or idle copy showing the next scheduled start when applicable.
export function renderNowBlockingRow(nowMs = Date.now()) {
    const row = document.getElementById('now-blocking-row');
    const chipsEl = document.getElementById('now-blocking-chips');
    if (!row || !chipsEl) return;

    row.classList.remove('hidden');

    const entries = collectNowBlockingEntries(nowMs);

    if (entries.length === 0) {
        const idleMessage = buildNowBlockingIdleMessage(nowMs);
        // Idle copy is day-granular ("today", "tomorrow", or a date) — not a per-second
        // countdown — so skip clearing/rebuilding the row when nothing changed.
        if (isNowBlockingIdleDisplayCurrent(row, chipsEl, idleMessage)) {
            return;
        }

        closeNowBlockingChipMenus();
        row.classList.add('idle');
        row.classList.remove('many-active-chips');
        row.setAttribute('aria-labelledby', 'now-blocking-idle-msg');

        chipsEl.innerHTML = '';
        const idleSpan = document.createElement('span');
        idleSpan.id = 'now-blocking-idle-msg';
        idleSpan.className = 'now-blocking-idle-msg';
        idleSpan.setAttribute('data-tauri-drag-region', '');
        idleSpan.textContent = idleMessage;

        chipsEl.appendChild(idleSpan);
        requestAnimationFrame(() => syncNowBlockingChipsScrollability());
        return;
    }

    row.classList.remove('idle');
    row.classList.toggle('many-active-chips', entries.length > 2);
    row.setAttribute('aria-labelledby', 'now-blocking-label-text');

    // Countdown text is minute-granular — patch existing chips when structure is unchanged.
    if (isNowBlockingActiveChipsCurrent(row, chipsEl, entries)) {
        updateNowBlockingActiveChipTexts(chipsEl, entries, nowMs);
        return;
    }

    closeNowBlockingChipMenus();
    chipsEl.innerHTML = '';
    entries.forEach((entry) => appendNowBlockingChip(chipsEl, entry, entries, nowMs));
    requestAnimationFrame(() => syncNowBlockingChipsScrollability());
}


/// Render the "Always on (not shown in timeline): <chip> <chip>" row above the calendar.
/// Always-on active blocks aren't drawn as bars in the timeline because they would cover
/// every day in full; this row makes their existence clear instead.
export function renderScheduleAlwaysOnRow() {
    const row = document.getElementById('schedule-always-on-row');
    const chips = document.getElementById('schedule-always-on-chips');
    if (!row || !chips) return;

    const alwaysOnBlocks = (state.appData.activeBlocks || []).filter(b => isBlockAlwaysOn(b));

    // When the user has the "always" tab selected and picked a blocklist that isn't already
    // running, show a faded preview chip alongside the real ones. This replaces the timeline
    // preview bar that always-on mode used to draw across every day.
    let previewBlocklist = null;
    if (state.isAlwaysOnMode && !state.isScheduleMode && state.selectedBlocklistId) {
        const candidate = state.appData.blocklists.find(bl => bl.id === state.selectedBlocklistId);
        const now = Date.now();
        const alreadyActive = (state.appData.activeBlocks || []).some(b =>
            b.blocklistId === state.selectedBlocklistId && b.startTime <= now && b.endTime > now
        );
        if (candidate && !alreadyActive) {
            previewBlocklist = candidate;
        }
    }

    if (alwaysOnBlocks.length === 0 && !previewBlocklist) {
        row.classList.add('hidden');
        chips.innerHTML = '';
        return;
    }

    chips.innerHTML = '';

    alwaysOnBlocks.forEach(block => {
        const blocklist = state.appData.blocklists.find(bl => bl.id === block.blocklistId);
        if (!blocklist) return;

        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'always-on-chip';
        chip.dataset.blockId = block.id;
        chip.title = blocklist.name;

        const emoji = blocklist.emoji
            ? `<span class="always-on-chip-emoji">${escapeHtml(blocklist.emoji)}</span>`
            : '';

        chip.innerHTML = `${emoji}<span class="always-on-chip-name">${escapeHtml(blocklist.name)}</span>`;

        // Clicking the chip opens the override modal so the user can stop the always-on block.
        chip.addEventListener('click', (e) => {
            e.stopPropagation();
            openOverrideModal(block.id);
        });

        chips.appendChild(chip);
    });

    if (previewBlocklist) {
        const chip = document.createElement('div');
        chip.className = 'always-on-chip preview';
        chip.title = previewBlocklist.name;

        const emoji = previewBlocklist.emoji
            ? `<span class="always-on-chip-emoji">${escapeHtml(previewBlocklist.emoji)}</span>`
            : '';

        chip.innerHTML = `${emoji}<span class="always-on-chip-name">${escapeHtml(previewBlocklist.name)}</span>`;
        chips.appendChild(chip);
    }

    row.classList.remove('hidden');
}

/// Render a row of eye/eye-slash chips under the Schedule header — one per blocklist that
/// currently contributes anything to the calendar (has an active/future manual block or a
/// defined schedule). Clicking a chip toggles blocklist.alwaysShowInSchedule.
export function renderScheduleVisibilityChips() {
    const container = document.getElementById('schedule-visibility-chips');
    if (!container) return;

    const now = Date.now();
    const scheduledIds = new Set((state.appData.schedules || []).map(s => s.blocklistId));
    // Always-on blocks aren't drawn in the timeline (they're surfaced by the "Always on"
    // row above instead), so don't add a visibility chip for them either.
    const manualIds = new Set(
        (state.appData.activeBlocks || [])
            .filter(b => b.endTime > now && !isBlockAlwaysOn(b))
            .map(b => b.blocklistId)
    );
    const relevantIds = new Set([...scheduledIds, ...manualIds]);

    const blocklists = (state.appData.blocklists || []).filter(bl => relevantIds.has(bl.id));

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
            <span class="schedule-visibility-chip-name">${bl.emoji ? escapeHtml(bl.emoji) + ' ' : ''}${escapeHtml(bl.name || '')}</span>
        `;
        chip.addEventListener('click', async () => {
            const blocklist = state.appData.blocklists.find(b => b.id === bl.id);
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

// Layout overlapping blocks within a day row.
//
// In the row-based layout, blocks already use left%/width% to position by time, so blocks
// that overlap in time would visually overlap horizontally. We resolve this by stacking
// overlapping blocks vertically *within* the row: the row is divided into N horizontal
// lanes (where N is the maximum overlap depth), each block sits in one lane.
export function layoutOverlappingBlocks() {
    document.querySelectorAll('.day-track').forEach(track => {
        const blocks = Array.from(track.querySelectorAll('.calendar-block'));
        // Reset any previous lane styling so single-block rows render at full height.
        blocks.forEach(b => {
            b.style.top = '';
            b.style.bottom = '';
            b.style.height = '';
        });
        if (blocks.length <= 1) return;

        // Compute time-extents (in % of day width) from current left/width styles.
        const blockData = blocks.map(block => {
            const left = parseFloat(block.style.left) || 0;
            const width = parseFloat(block.style.width) || 0;
            const groupId = block.dataset.scheduleId || block.dataset.blockId || block.dataset.previewGroupId || null;
            return {
                element: block,
                left,
                right: left + width,
                groupId,
                lane: 0,
                totalLanes: 1
            };
        });

        // Sort by left edge so we assign lanes greedily from earliest start.
        blockData.sort((a, b) => a.left - b.left || a.right - b.right);

        const groupLanes = new Map();

        for (let i = 0; i < blockData.length; i++) {
            const current = blockData[i];

            if (current.groupId && groupLanes.has(current.groupId)) {
                current.lane = groupLanes.get(current.groupId);
                continue;
            }

            const overlappingGroups = new Set();
            for (let j = 0; j < blockData.length; j++) {
                if (i === j) continue;
                const other = blockData[j];
                if (!(current.right <= other.left || current.left >= other.right)) {
                    if (other.groupId !== current.groupId) {
                        overlappingGroups.add(other.groupId);
                    }
                }
            }

            const usedLanes = new Set();
            overlappingGroups.forEach(gid => {
                if (groupLanes.has(gid)) usedLanes.add(groupLanes.get(gid));
            });

            let lane = 1;
            while (usedLanes.has(lane)) lane++;
            current.lane = lane;
            if (current.groupId) groupLanes.set(current.groupId, lane);
        }

        for (let i = 0; i < blockData.length; i++) {
            const current = blockData[i];
            let maxLane = current.lane;
            for (let j = 0; j < blockData.length; j++) {
                if (i === j) continue;
                const other = blockData[j];
                if (!(current.right <= other.left || current.left >= other.right)) {
                    maxLane = Math.max(maxLane, other.lane);
                }
            }
            current.totalLanes = maxLane;
        }

        blockData.forEach(data => {
            if (data.totalLanes > 1) {
                const lanePercent = 100 / data.totalLanes;
                const topPercent = (data.lane - 1) * lanePercent;
                data.element.style.top = `calc(${topPercent}% + 2px)`;
                data.element.style.height = `calc(${lanePercent}% - 4px)`;
                data.element.style.bottom = 'auto';
            }
        });
    });
}

// Render saved schedules onto the weekly calendar by weekday. Each segment lays out on
// every weekday listed in its `days` array; overnight segments split into a tail on the
// next weekday (wrapping Sun → Mon). One-shot non-repeating schedules render onto the
// weekday of each resolved occurrence.
export function renderScheduledCalendarBlocks() {
    if (!state.appData.schedules || state.appData.schedules.length === 0) return;

    const now = new Date();

    state.appData.schedules.forEach(schedule => {
        const blocklist = state.appData.blocklists.find(bl => bl.id === schedule.blocklistId);
        if (!blocklist) return;

        // The eye chip above the schedule is authoritative — hidden means hidden,
        // even if the blocklist is currently selected.
        if (blocklist.alwaysShowInSchedule === false) {
            return;
        }

        // Date-limited schedules drop off the calendar once their end date has passed.
        if (schedule.repeatType === 'date' && schedule.repeatDate) {
            const endDate = new Date(schedule.repeatDate);
            if (now > endDate) return;
        }

        if (isNonRepeatingSchedule(schedule)) {
            // One-shot occurrences carry an explicit dayIndex (Mon=0..Sun=6). Render on
            // that weekday using the segment's clock-times.
            const occurrences = resolveOneShotOccurrences(schedule);
            occurrences.forEach(occurrence => {
                if (occurrence.end.getTime() <= now.getTime()) return; // already finished
                const segment = schedule.segments[occurrence.segmentIndex];
                if (!segment) return;
                renderScheduleSegmentOnWeekday(schedule, segment, occurrence.segmentIndex, occurrence.dayIndex, blocklist);
            });
            return;
        }

        schedule.segments.forEach((segment, segmentIdx) => {
            const segmentDays = segment.days || [];
            segmentDays.forEach(dayIndex => {
                renderScheduleSegmentOnWeekday(schedule, segment, segmentIdx, dayIndex, blocklist);
            });
        });
    });
}

// Render a single schedule segment onto the day-track for a specific weekday.
// Overnight segments split: head from start..24:00 on this weekday, tail from 00:00..end
// on the next weekday (wrapping Sun → Mon).
export function renderScheduleSegmentOnWeekday(schedule, segment, segmentIdx, dayIndex, blocklist) {
    const track = document.querySelector(`.day-track[data-day-index="${dayIndex}"]`);
    if (!track) return;

    const startMinutes = segment.startHour * 60 + segment.startMinute;
    const endMinutes = segment.endHour * 60 + segment.endMinute;
    const isOvernight = endMinutes <= startMinutes;

    const startTimeStr = `${String(segment.startHour).padStart(2, '0')}:${String(segment.startMinute).padStart(2, '0')}`;
    const endTimeStr = `${String(segment.endHour).padStart(2, '0')}:${String(segment.endMinute).padStart(2, '0')}`;

    const buildBlock = (leftPct, widthPct, hostDayIndex, isContinuation) => {
        const el = document.createElement('div');
        el.className = `calendar-block scheduled${isContinuation ? ' overnight-continuation' : ''}`;
        el.dataset.scheduleId = schedule.id;
        el.dataset.segmentIndex = segmentIdx;
        el.dataset.day = hostDayIndex;
        el.style.left = `${leftPct}%`;
        el.style.width = `${widthPct}%`;

        if (blocklist.color) {
            el.style.background = blocklist.color;
            el.style.opacity = '0.7';
            el.style.color = getContrastTextColor(blocklist.color);
        }

        el.innerHTML = `
            <span class="block-emoji">${blocklist.emoji || '🚫'}</span>
            <span class="block-label">${escapeHtml(blocklist.name)}</span>
            <span class="block-time">${startTimeStr} - ${endTimeStr}</span>
        `;

        el.addEventListener('click', (e) => {
            e.stopPropagation();
            openScheduledBlockEdit(schedule);
        });

        return el;
    };

    if (isOvernight) {
        const left1 = (startMinutes / 1440) * 100;
        const width1 = Math.max(0.5, ((1440 - startMinutes) / 1440) * 100);
        track.appendChild(buildBlock(left1, width1, dayIndex, false));

        const nextDayIndex = (dayIndex + 1) % 7;
        const nextTrack = document.querySelector(`.day-track[data-day-index="${nextDayIndex}"]`);
        if (nextTrack) {
            const width2 = Math.max(0.5, (endMinutes / 1440) * 100);
            nextTrack.appendChild(buildBlock(0, width2, nextDayIndex, true));
        }
    } else {
        const left = (startMinutes / 1440) * 100;
        const width = Math.max(0.5, ((endMinutes - startMinutes) / 1440) * 100);
        track.appendChild(buildBlock(left, width, dayIndex, false));
    }
}

// Render blocklist selector dropdown
export function renderBlocklistSelector() {
    const select = document.getElementById('blocklist-select');
    const currentValue = select.value;
    const activeIds = state.appData.activeBlocks.map(b => b.blocklistId);

    const newHTML = `
    <option value="">${tSettings('selectionPromptOption')}</option>
    ${state.appData.blocklists.map(bl => {
        const isActive = activeIds.includes(bl.id);
        const activeLabel = isActive ? tSettings('runningSuffix') : '';
        return `<option value="${bl.id}">${escapeHtml(bl.name)}${activeLabel}</option>`;
    }).join('')}
  `;

    // Only update if changed to prevent closing dropdown
    // Normalize logic to ignore potential minor diffs if logic is sound, but direct string compare is fine
    if (select.innerHTML !== newHTML) {
        select.innerHTML = newHTML;
        select.value = currentValue;
    }
}

export function startTickInterval() {
    // Track which blocks have been activated (to avoid repeated password prompts)
    // Initialize state.activatedBlockIds with already-active blocks at startup
    state.activatedBlockIds = new Set(
        state.appData.activeBlocks
            .filter(b => b.startTime <= Date.now())
            .map(b => b.id)
    );

    // Initialize app blocking immediately at startup
    // This ensures any active blocks or schedules are enforced right away
    updateBlockedApps();
    startTickInterval._lastScheduleStateSignature = getScheduleStateSignature();

    startTickInterval._tickFn = async () => {
        const now = Date.now();
        let shouldSyncControls = false;

        // Check for future blocks that have now become active
        const newlyActiveBlocks = state.appData.activeBlocks.filter(
            block => block.startTime <= now && !state.activatedBlockIds.has(block.id)
        );

        if (newlyActiveBlocks.length > 0) {
            // Mark as activated
            newlyActiveBlocks.forEach(b => state.activatedBlockIds.add(b.id));
            // Update hosts to apply the blocking rules
            await updateHostsFile();
            render();
            shouldSyncControls = true;
        }

        // Check for paused blocks that should resume
        const resumedBlocks = state.appData.activeBlocks.filter(
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
        if (state.appData.schedules) {
            const resumedSchedules = state.appData.schedules.filter(
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
        if (state.appData.schedules && state.appData.schedules.length > 0) {
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

            for (const schedule of state.appData.schedules) {
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
                const previousScheduleCount = state.appData.schedules.length;
                state.appData.schedules = state.appData.schedules.filter(s => !expiredScheduleIds.includes(s.id));

                if (state.appData.schedules.length < previousScheduleCount) {
                    console.log('Auto-stopped expired schedule(s):', expiredScheduleIds);
                    state.activeScheduleSegmentCount = 0;
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
        const previousCount = state.appData.activeBlocks.length;
        state.appData.activeBlocks = state.appData.activeBlocks.filter(block => block.endTime > now);

        // Clean up activated set
        state.activatedBlockIds = new Set(
            [...state.activatedBlockIds].filter(id =>
                state.appData.activeBlocks.some(b => b.id === id)
            )
        );

        // Only re-render if blocks actually expired
        if (state.appData.activeBlocks.length < previousCount) {
            await saveData();
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
            if (state.isIOS) {
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

        // Periodic re-render so the schedule "now" line and blocklist
        // countdowns ("starts in Xh") don't go stale when no state has
        // changed. Without this, after the WebView is idle for a while
        // (e.g. system sleep) those displays remain frozen at the last
        // render's timestamp until something else triggers render().
        // Skip while hidden (tray / background) — kickClockNow() renders on focus.
        if (document.visibilityState === 'visible') {
            if (!startTickInterval._uiRefreshTickCount) startTickInterval._uiRefreshTickCount = 0;
            startTickInterval._uiRefreshTickCount++;
            if (startTickInterval._uiRefreshTickCount >= 60) {
                startTickInterval._uiRefreshTickCount = 0;
                render();
            }
        }

        if (collectNowBlockingEntries(now).length === 0) {
            renderNowBlockingRow(now);
        }

        // Update remaining times in UI
        document.querySelectorAll('.entry-remaining').forEach((el, idx) => {
            const block = state.appData.activeBlocks[idx];
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
        if (state.selectedBlocklistId && !state.userEditedEndTime && !state.isAlwaysOnMode) {
            const newEndTime = new Date(now + state.targetDurationMinutes * 60 * 1000);
            state.selectedEndHour = newEndTime.getHours();
            state.selectedEndMinute = newEndTime.getMinutes();
            updateTimeDisplay();
            // Don't call handleTimeChange here to avoid circular updates
        }
    };
    startTickInterval._intervalId = setInterval(startTickInterval._tickFn, 1000);
}

// Force an immediate re-render and restart the per-second tick. Called when
// the window becomes visible or regains focus — macOS can pause/throttle
// WKWebView's JS timers while the window is hidden or the system sleeps,
// and the existing setInterval may not resume cleanly. Without this hook
// the title-bar countdown and schedule "now" line could sit frozen on the
// last-rendered timestamp until the process was killed.
export function kickClockNow() {
    try { render(); } catch (e) { console.error('kickClockNow render failed', e); }
    if (typeof startTickInterval._tickFn === 'function') {
        if (startTickInterval._intervalId) {
            clearInterval(startTickInterval._intervalId);
        }
        startTickInterval._intervalId = setInterval(startTickInterval._tickFn, 1000);
    }
}

export function getScheduleStateSignature(now = Date.now()) {
    const nowDate = new Date(now);
    if (!state.appData.schedules || state.appData.schedules.length === 0) return '';
    return state.appData.schedules.map(s => `${s.id || s.blocklistId}:${isSchedulePausedNow(s, now) ? 1 : 0}:${isScheduleSegmentActiveNow(s, nowDate) ? 1 : 0}`).sort().join('|');
}