// Focus-space editor: the one form used both to create a focus space (hosted in
// #blocklist-modal) and to edit the selected one (hosted in the scheduler panel,
// which on phones and narrow desktop windows is itself moved into the enter
// sheet). It is a single DOM node, #focus-space-editor, moved between the two
// hosts so that every id-based listener in setupModalListeners keeps working.
//
// Sections mirror the Android app: name, What to block, When to block
// (Daily / Weekly / Manual + Until), To stop early, Advanced options.
//
// Nothing here runs at module top level — the hub modules import this file and
// this file imports them back; every cross-module call is made at runtime.
import { state } from './state.js';
import { tSettings, tSettingsFmt, weekdayAbbrevMon0List } from './i18n.js';
import {
    WHEN_TO_BLOCK_KINDS,
    deriveWhenToBlockKind,
    formatWhenToBlockSummary,
    segmentsForKind,
} from './when-to-block.js';
import {
    formatDateForDisplay,
    formatDateForInput,
    getDefaultScheduleSegments,
    getInitialExpandedScheduleSegmentIndex,
    getSelectedSchedule,
    isAllowEditsBetweenBlocksOn,
    rebuildScheduleSegments,
    syncAllowEditsBetweenBlocksToggle,
} from './schedule-editor.js';
import {
    getEffectiveScheduleStartOverlayId,
    getLastScheduleStartOverlayId,
    rememberLastScheduleStartOverlayId,
    syncSchedulePanelOverlayControls,
} from './schedule-overlay.js';
import { deleteBlocklist, duplicateBlocklist, isBlocklistEditFrictionRequired } from './blocklists.js';
import { getOverrideEstimatedMinutes, normalizeOverrideCount, normalizeOverrideType } from './override-challenge.js';
import { getSelectedBlocklistModalMode, setBlocklistModalMode } from './list-mode.js';
import { handleTimeChange, populateBlocklistFormFields, resetBlocklistFormState, syncBlocklistEditFrictionUi } from './confirm-modals.js';
import { syncSelectedControlState } from './render.js';
import { updateWindowHeight } from './blocking-platform.js';

const SECTION_KEYS = ['what', 'when', 'stop', 'advanced'];

let editorWired = false;
let notifyFrame = null;

export function getFocusSpaceEditor() {
    return document.getElementById('focus-space-editor');
}

/** True while the editor node lives in the create modal rather than the panel. */
export function isEditorInCreateModal() {
    const slot = document.getElementById('blocklist-modal-editor-slot');
    const editor = getFocusSpaceEditor();
    return !!(slot && editor && slot.contains(editor));
}

export function mountFocusSpaceEditor(host) {
    const editor = getFocusSpaceEditor();
    if (!editor || !host || editor.parentElement === host) return;
    host.appendChild(editor);
}

/** Put the editor back between the panel header and footer. */
export function returnFocusSpaceEditorToPanel() {
    const editor = getFocusSpaceEditor();
    const header = document.getElementById('editor-panel-header');
    if (!editor || !header) return;
    if (editor.previousElementSibling === header) return;
    header.insertAdjacentElement('afterend', editor);
}

// ── Sections (accordion) ──────────────────────────────────────────────────

export function setOpenEditorSection(key) {
    const next = SECTION_KEYS.includes(key) ? key : null;
    state.openEditorSection = next;
    SECTION_KEYS.forEach((k) => {
        const open = k === next;
        document.getElementById(`editor-section-${k}`)?.classList.toggle('editor-section-open', open);
        document.getElementById(`editor-section-${k}-header`)?.setAttribute('aria-expanded', open ? 'true' : 'false');
        document.getElementById(`editor-section-${k}-body`)?.classList.toggle('hidden', !open);
    });
    setTimeout(() => updateWindowHeight(), 50);
}

function toggleEditorSection(key) {
    setOpenEditorSection(state.openEditorSection === key ? null : key);
}

// ── When to block ─────────────────────────────────────────────────────────

export function getWhenToBlockKind() {
    return WHEN_TO_BLOCK_KINDS.includes(state.editorKind) ? state.editorKind : 'manual';
}

/**
 * Switch the Daily / Weekly / Manual choice. Segments are reshaped for the new
 * kind (Daily keeps one segment on every day); Manual leaves them in place so
 * flipping back restores what was there.
 */
export function setWhenToBlockKind(kind, { fromUser = false } = {}) {
    const next = WHEN_TO_BLOCK_KINDS.includes(kind) ? kind : 'manual';
    state.editorKind = next;

    document.querySelectorAll('#when-kind-toggle .editor-segmented-btn').forEach((btn) => {
        const active = btn.dataset.kind === next;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    if (next !== 'manual') {
        state.scheduleSegments = segmentsForKind(next, state.scheduleSegments, getDefaultScheduleSegments);
        if (next === 'daily') state.expandedScheduleSegmentIndex = 0;
        rebuildScheduleSegments();
    }

    const isManual = next === 'manual';
    document.getElementById('when-times')?.classList.toggle('hidden', isManual);
    document.getElementById('when-manual-hint')?.classList.toggle('hidden', !isManual);
    document.getElementById('add-segment-btn')?.classList.toggle('hidden', next !== 'weekly');
    document.getElementById('editor-advanced-schedule')?.classList.toggle('hidden', isManual);

    if (fromUser) {
        handleTimeChange();
    } else {
        updateEditorSummaries();
    }
}

export function getUntilMode() {
    return state.scheduleRepeatType === 'date' ? 'date' : 'forever';
}

export function setUntilMode(mode, { fromUser = false } = {}) {
    const next = mode === 'date' ? 'date' : 'forever';
    state.scheduleRepeatType = next;

    document.querySelectorAll('#until-toggle .editor-segmented-btn').forEach((btn) => {
        const active = btn.dataset.until === next;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    const dateWrapper = document.getElementById('repeat-date-wrapper');
    const dateInput = document.getElementById('repeat-date-input');
    const dateOverlay = document.getElementById('repeat-date-overlay');
    if (next === 'date') {
        if (!state.scheduleRepeatDate) {
            // Default to a week from today, matching the old Repeat dropdown.
            const defaultDate = new Date();
            defaultDate.setDate(defaultDate.getDate() + 6);
            state.scheduleRepeatDate = defaultDate;
        }
        if (dateInput) dateInput.value = formatDateForInput(state.scheduleRepeatDate);
        if (dateOverlay) dateOverlay.textContent = formatDateForDisplay(state.scheduleRepeatDate);
        dateWrapper?.classList.remove('hidden');
    } else {
        state.scheduleRepeatDate = null;
        dateWrapper?.classList.add('hidden');
    }

    if (fromUser) {
        handleTimeChange();
    } else {
        updateEditorSummaries();
    }
}

/**
 * While a focus space is enforcing (and not paused / flexible-between-blocks),
 * its schedule can only be made stricter: committed segments are locked by
 * `isScheduleSegmentMutationBlocked`, and the kind / Until choices are frozen.
 */
export function setWhenToBlockLocked(locked) {
    document.getElementById('when-kind-toggle')?.classList.toggle('editor-segmented--locked', locked);
    document.querySelectorAll('#when-kind-toggle .editor-segmented-btn').forEach((btn) => { btn.disabled = locked; });
    document.getElementById('until-toggle')?.classList.toggle('editor-segmented--locked', locked);
    document.querySelectorAll('#until-toggle .editor-segmented-btn').forEach((btn) => { btn.disabled = locked; });
    const dateWrapper = document.getElementById('repeat-date-wrapper');
    const dateInput = document.getElementById('repeat-date-input');
    dateWrapper?.classList.toggle('repeat-date-disabled', locked);
    if (dateInput) dateInput.disabled = locked;
}

/** The schedule config the form currently describes. */
export function readEditorWhenToBlock() {
    const kind = getWhenToBlockKind();
    const untilMode = getUntilMode();
    const repeatDate = untilMode === 'date' && state.scheduleRepeatDate
        ? new Date(state.scheduleRepeatDate).getTime()
        : null;
    return {
        kind,
        segments: segmentsForKind(kind, state.scheduleSegments, getDefaultScheduleSegments),
        repeatType: untilMode,
        repeatDate,
        allowEditsBetweenBlocks: isAllowEditsBetweenBlocksOn(editorSchedule()),
        startOverlayId: isEditorInCreateModal()
            ? getLastScheduleStartOverlayId()
            : getEffectiveScheduleStartOverlayId(),
    };
}

function editorSchedule() {
    if (isEditorInCreateModal() || !state.editingBlocklistId) return null;
    return getSelectedSchedule();
}

/**
 * Create, replace or remove the schedule record for `blocklistId` from the
 * form. Returns true when `appData.schedules` changed. The caller saves and
 * runs the native sync chain.
 */
export function applyEditorScheduleForBlocklist(blocklistId) {
    const when = readEditorWhenToBlock();
    if (!Array.isArray(state.appData.schedules)) state.appData.schedules = [];
    const existingIndex = state.appData.schedules.findIndex((s) => s.blocklistId === blocklistId);
    const existing = existingIndex >= 0 ? state.appData.schedules[existingIndex] : null;

    if (when.kind === 'manual') {
        if (!existing) return false;
        state.appData.schedules.splice(existingIndex, 1);
        return true;
    }

    if (existing) {
        existing.segments = when.segments;
        existing.repeatType = when.repeatType;
        existing.repeatDate = when.repeatDate;
        existing.allowEditsBetweenBlocks = !!when.allowEditsBetweenBlocks;
        existing.startOverlayId = when.startOverlayId || null;
        return true;
    }

    state.appData.schedules.push({
        id: crypto.randomUUID(),
        blocklistId,
        segments: when.segments,
        repeatType: when.repeatType,
        repeatDate: when.repeatDate,
        createdAt: Date.now(),
        startOverlayId: when.startOverlayId || null,
        allowEditsBetweenBlocks: !!when.allowEditsBetweenBlocks,
    });
    rememberLastScheduleStartOverlayId(when.startOverlayId || null);
    return true;
}

// ── Populate / read / dirty ───────────────────────────────────────────────

function selectedEmojiValue() {
    return document.querySelector('.emoji-swatch.selected')?.dataset.emoji || null;
}

function selectedColorValue() {
    return document.querySelector('.color-swatch.selected')?.dataset.color || null;
}

function serializeEditor() {
    return JSON.stringify({
        name: document.getElementById('blocklist-name')?.value.trim() || '',
        mode: getSelectedBlocklistModalMode(),
        websites: window.getModalWebsites?.() || [],
        apps: window.getModalApps?.() || [],
        ios: window.getModalIOSScreenTimeSelection?.() || null,
        when: readEditorWhenToBlock(),
        override: {
            type: document.getElementById('override-type')?.value || '',
            count: document.getElementById('override-count')?.value || '',
            customText: document.getElementById('custom-override-text')?.value || '',
        },
        emoji: selectedEmojiValue(),
        color: selectedColorValue(),
        showItemDetails: !!document.getElementById('show-item-details-checkbox')?.checked,
    });
}

export function isEditorDirty() {
    if (!state.editorSnapshot) return false;
    return serializeEditor() !== state.editorSnapshot;
}

export function markEditorClean() {
    state.editorSnapshot = serializeEditor();
    syncEditorFooter();
}

/**
 * Fill every field from `blocklist` (null = a brand-new space in the create
 * modal). Also decides the When to block kind from the schedule record and
 * whether the schedule part is locked.
 */
export function populateFocusSpaceEditor(blocklist, { mode = null } = {}) {
    const isCreate = !blocklist;
    const resolvedMode = blocklist?.mode === 'allowlist' || mode === 'allowlist' ? 'allowlist' : 'blocklist';

    state.editingBlocklistId = blocklist?.id || null;
    resetBlocklistFormState();
    setBlocklistModalMode(resolvedMode);
    populateBlocklistFormFields(blocklist);

    const schedule = blocklist
        ? (state.appData.schedules || []).find((s) => s.blocklistId === blocklist.id) || null
        : null;
    const locked = blocklist ? isBlocklistEditFrictionRequired(blocklist.id) : false;

    if (schedule?.segments?.length) {
        state.scheduleSegments = schedule.segments.map((seg) => ({ ...seg, days: [...(seg.days || [])] }));
        state.activeScheduleSegmentCount = locked ? schedule.segments.length : 0;
        state.scheduleRepeatType = schedule.repeatType === 'date' ? 'date' : 'forever';
        state.scheduleRepeatDate = schedule.repeatType === 'date' && schedule.repeatDate
            ? new Date(schedule.repeatDate)
            : null;
        state.draftAllowEditsBetweenBlocks = !!schedule.allowEditsBetweenBlocks;
    } else {
        state.scheduleSegments = getDefaultScheduleSegments();
        state.activeScheduleSegmentCount = 0;
        state.scheduleRepeatType = 'forever';
        state.scheduleRepeatDate = null;
        state.draftAllowEditsBetweenBlocks = false;
    }
    state.expandedScheduleSegmentIndex = getInitialExpandedScheduleSegmentIndex();

    setWhenToBlockKind(deriveWhenToBlockKind(schedule));
    setUntilMode(state.scheduleRepeatType);
    setWhenToBlockLocked(locked);
    syncAllowEditsBetweenBlocksToggle();
    syncSchedulePanelOverlayControls();

    updateEditorTitles(isCreate, resolvedMode);
    setOpenEditorSection(isCreate ? 'what' : null);

    state.editorSnapshot = serializeEditor();
    updateEditorSummaries();
    syncEditorFooter();
    handleTimeChange();
}

/**
 * The space already loaded changed state underneath the form (paused, stopped,
 * resumed): refresh what is locked without discarding in-flight edits.
 */
export function resyncEditorLockState(blocklist) {
    if (!blocklist || blocklist.id !== state.editingBlocklistId || isEditorInCreateModal()) return;
    const schedule = (state.appData.schedules || []).find((s) => s.blocklistId === blocklist.id) || null;
    const locked = isBlocklistEditFrictionRequired(blocklist.id);
    state.activeScheduleSegmentCount = locked ? (schedule?.segments?.length || 0) : 0;
    if (getWhenToBlockKind() !== 'manual') rebuildScheduleSegments();
    setWhenToBlockLocked(locked);
    syncAllowEditsBetweenBlocksToggle();
    syncBlocklistEditFrictionUi(blocklist, Date.now(), { preserveModalItems: true });
    updateEditorSummaries();
    syncEditorFooter();
}

/** Throw away unsaved edits: reload the selected space (or a blank form). */
export function discardFocusSpaceEditor() {
    const blocklist = state.editingBlocklistId
        ? state.appData.blocklists.find((bl) => bl.id === state.editingBlocklistId) || null
        : null;
    populateFocusSpaceEditor(blocklist, { mode: getSelectedBlocklistModalMode() });
}

function updateEditorTitles(isCreate, mode) {
    const modalTitle = document.getElementById('modal-title');
    if (modalTitle) {
        modalTitle.textContent = tSettings(mode === 'allowlist' ? 'newFocusSpaceAllow' : 'newFocusSpaceBlock');
    }
    const panelTitle = document.getElementById('editor-panel-title');
    if (panelTitle) panelTitle.textContent = tSettings('editFocusSpace');
    const sheetTitle = document.getElementById('enter-scheduler-modal-title');
    if (sheetTitle && !isCreate) sheetTitle.textContent = tSettings('editFocusSpace');
}

// ── Summaries + footer ────────────────────────────────────────────────────

function currentItemCounts() {
    const counts = window.getModalAllowlistScopeCounts?.();
    if (counts) return { websites: counts.websites ?? 0, apps: counts.apps ?? 0 };
    // Before the form listeners are wired (harness boots), count the saved record.
    const bl = state.editingBlocklistId
        ? state.appData.blocklists.find((b) => b.id === state.editingBlocklistId)
        : null;
    return { websites: bl?.websites?.length || 0, apps: bl?.apps?.length || 0 };
}

export function updateEditorSummaries() {
    const counts = currentItemCounts();
    setSummary('what', tSettingsFmt('whatToBlockSummaryFmt', counts));
    document.getElementById('what-empty-hint')?.classList.toggle('hidden', counts.websites + counts.apps > 0);

    const kind = getWhenToBlockKind();
    let whenText = formatWhenToBlockSummary(kind, state.scheduleSegments, {
        manual: tSettings('whenManualSummary'),
        dailyFmt: (range) => tSettingsFmt('whenDailySummaryFmt', { range }),
        weeklyFmt: (days, range) => tSettingsFmt('whenWeeklySummaryFmt', { days, range }),
        dayNames: weekdayAbbrevMon0List(),
        everyDay: tSettings('segmentDaysEveryDay'),
        noDays: tSettings('segmentDaysNone'),
    });
    if (kind !== 'manual' && getUntilMode() === 'date' && state.scheduleRepeatDate) {
        whenText += ` · ${tSettingsFmt('untilDateSummaryFmt', { date: formatDateForDisplay(new Date(state.scheduleRepeatDate)) })}`;
    }
    setSummary('when', whenText);

    setSummary('stop', formatStopEarlySummary());
}

function formatStopEarlySummary() {
    const type = normalizeOverrideType(document.getElementById('override-type')?.value);
    if (type === 'custom') return tSettings('stopEarlySummaryCustom');
    const count = normalizeOverrideCount(document.getElementById('override-count')?.value, 'random-words');
    const minutes = getOverrideEstimatedMinutes(type, count, '');
    return tSettingsFmt('stopEarlySummaryWordsFmt', { count: String(count), minutes: String(minutes) });
}

function setSummary(key, text) {
    const el = document.getElementById(`editor-section-${key}-summary`);
    if (el) el.textContent = text;
}

/**
 * Panel footer: Discard / Save changes while there are unsaved edits. Starting
 * and stopping live on the card switch, and the create modal has its own
 * Cancel / Save.
 */
export function syncEditorFooter() {
    const pendingBar = document.getElementById('editor-pending-bar');
    if (!pendingBar) return;
    const dirty = !isEditorInCreateModal() && !!state.editingBlocklistId && isEditorDirty();
    pendingBar.classList.toggle('hidden', !dirty);
}

/** Coalesced "something in the form changed" — summaries and footer. */
export function notifyEditorChanged() {
    if (notifyFrame != null) return;
    notifyFrame = requestAnimationFrame(() => {
        notifyFrame = null;
        updateEditorSummaries();
        syncEditorFooter();
    });
}

// ── Wiring ────────────────────────────────────────────────────────────────

export function setupFocusSpaceEditor({ onSave } = {}) {
    if (editorWired) return;
    editorWired = true;

    SECTION_KEYS.forEach((key) => {
        document.getElementById(`editor-section-${key}-header`)?.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleEditorSection(key);
        });
    });

    document.querySelectorAll('#when-kind-toggle .editor-segmented-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (btn.disabled) return;
            setWhenToBlockKind(btn.dataset.kind, { fromUser: true });
        });
    });

    document.querySelectorAll('#until-toggle .editor-segmented-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (btn.disabled) return;
            setUntilMode(btn.dataset.until, { fromUser: true });
        });
    });

    const editor = getFocusSpaceEditor();
    if (editor) {
        ['input', 'change', 'click'].forEach((type) => {
            editor.addEventListener(type, () => notifyEditorChanged());
        });
    }

    document.getElementById('editor-discard-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        discardFocusSpaceEditor();
    });
    document.getElementById('editor-duplicate-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.editingBlocklistId && !isEditorInCreateModal()) duplicateBlocklist(state.editingBlocklistId);
    });
    document.getElementById('editor-delete-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.editingBlocklistId && !isEditorInCreateModal()) void deleteBlocklist(state.editingBlocklistId);
    });
    document.getElementById('editor-save-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        void onSave?.();
    });
}

/** Called after a save or an external state change so the footer reflects it. */
export function refreshEditorAfterDataChange() {
    updateEditorSummaries();
    syncEditorFooter();
    syncSelectedControlState();
}

/** Re-apply translated labels (called from the language switcher). */
export function applyFocusSpaceEditorLanguage() {
    const setText = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    };
    setText('blocklist-name-label', tSettings('focusSpaceName'));
    setText('editor-section-what-title', tSettings('whatToBlock'));
    setText('what-empty-hint', tSettings('nothingAddedYet'));
    setText('editor-section-when-title', tSettings('whenToBlock'));
    setText('editor-section-stop-title', tSettings('toStopEarly'));
    setText('editor-section-advanced-title', tSettings('advancedOptions'));
    setText('when-kind-daily', tSettings('whenDaily'));
    setText('when-kind-weekly', tSettings('whenWeekly'));
    setText('when-kind-manual', tSettings('whenManual'));
    setText('when-manual-hint', tSettings('whenManualHint'));
    setText('add-segment-label', tSettings('add'));
    setText('until-label', tSettings('untilLabel'));
    setText('until-forever', tSettings('untilWhenIStop'));
    setText('until-date', tSettings('untilDate'));
    setText('editor-pending-label', tSettings('pendingChangesLabel'));
    ['editor-duplicate-btn', 'editor-delete-btn'].forEach((id, i) => {
        const el = document.getElementById(id);
        if (!el) return;
        const label = tSettings(i === 0 ? 'blocklistCardDuplicate' : 'blocklistCardDelete');
        el.title = label;
        el.setAttribute('aria-label', label);
    });
    setText('editor-discard-btn', tSettings('pendingChangesDiscard'));
    setText('editor-save-btn', tSettings('pendingChangesSave'));
    document.getElementById('when-kind-toggle')?.setAttribute('aria-label', tSettings('whenToBlock'));
    updateEditorTitles(!state.editingBlocklistId, getSelectedBlocklistModalMode());
    updateEditorSummaries();
}
