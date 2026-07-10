// Blocklist CRUD: duplication, import/export, delete-undo, list rendering.
// Extracted verbatim from app.js.
import { state } from './state.js';
import { ask, message, open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { escapeHtml, getEnteringChipColor } from './utils.js';
import { tSettings, tSettingsFmt } from './i18n.js';
import { cloneIOSScreenTimeSelection, getBlocklistIOSScreenTimeSelection, getBlocklistRegularApps, isBlockAlwaysOn, isScreenTimeSummaryEntry, normalizeBlocklist } from './blocklist-utils.js';
import { isOneOffBlockEnforced, isSchedulePausedNow } from './schedule-engine.js';
import { saveData, updateHostsFile } from './persistence.js';
import { render, renderNowBlockingRow, renderScheduleVisibilityChips } from './render.js';
import { isScheduleSegmentActiveNow } from './schedule-editor.js';
import {
    BLOCKLIST_CARD_COMPACT_SCHEDULE_UPCOMING_CHARS,
    BLOCKLIST_NAME_MAX_LENGTH,
    formatBlockTimeRemainingShort,
    generateId,
} from './app.js';
import { buildBlocklistCardMetaHtml, buildBlocklistCardDetailsHtml, blocklistCardHasExpandableSummary } from './list-presentation.js';
import { cloneOverrideDifficulty, deselectBlocklist, handleBlocklistSelect, openBlocklistModal } from './confirm-modals.js';
import { APP_BLOCKING_SNOOZE_ICON_IMG_12, appBlockingWarningSnoozedUntilMs, formatAppBlockingSnoozeStartsIn, getActiveAppBlockingSnoozeBlocklistId } from './blocking-platform.js';

/** Focus-space cards whose Sites/Apps summary is expanded (survives re-render). */
const expandedBlocklistCardIds = new Set();

function setBlocklistCardExpanded(card, id, expanded) {
    if (expanded) expandedBlocklistCardIds.add(id);
    else expandedBlocklistCardIds.delete(id);

    card.classList.toggle('blocklist-card-expanded', expanded);
    const details = card.querySelector('.blocklist-card-details');
    if (details) {
        details.classList.toggle('hidden', !expanded);
        details.setAttribute('aria-hidden', expanded ? 'false' : 'true');
    }
    const btn = card.querySelector('.blocklist-meta-items-btn');
    if (btn) btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
}

function toggleBlocklistCardExpanded(card, id) {
    setBlocklistCardExpanded(card, id, !expandedBlocklistCardIds.has(id));
}

const BLOCKLIST_RUNNING_DOT = '<span class="badge-running-dot" aria-hidden="true"></span>';

function blocklistStatusIcon(innerHtml) {
    return `<span class="blocklist-status-icon" aria-hidden="true">${innerHtml}</span>`;
}

const BLOCKLIST_STATUS_ICON_PAUSE = blocklistStatusIcon(
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>',
);
const BLOCKLIST_STATUS_ICON_POWER = blocklistStatusIcon(
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path><line x1="12" y1="2" x2="12" y2="12"></line></svg>',
);
const BLOCKLIST_STATUS_ICON_HOURGLASS = blocklistStatusIcon(
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/></svg>',
);
const BLOCKLIST_STATUS_ICON_CALENDAR = blocklistStatusIcon(
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/></svg>',
);
const BLOCKLIST_STATUS_ICON_SNOOZE = blocklistStatusIcon(APP_BLOCKING_SNOOZE_ICON_IMG_12);

function buildBlocklistStatusSegment(text, { showDot = false, iconHtml = '', textClass = 'blocklist-status-text' } = {}) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) return '';
    const parts = [];
    if (showDot) parts.push(BLOCKLIST_RUNNING_DOT);
    if (iconHtml) parts.push(iconHtml);
    parts.push(`<span class="${textClass}">${escapeHtml(trimmed)}</span>`);
    return `<span class="blocklist-name-status-segment">${parts.join('')}</span>`;
}

export function truncateBlocklistName(raw) {
    const s = String(raw ?? '');
    return s.length <= BLOCKLIST_NAME_MAX_LENGTH ? s : s.slice(0, BLOCKLIST_NAME_MAX_LENGTH);
}

// Duplicate naming (localized suffix): EN "copy", DA "kopi"; parses both so chains gap-fill correctly.

/** Returns chain root if name ends with localized or legacy "copy" / "kopi" (+ optional number), else null. */
export function parseCopyRoot(name) {
    let m = /^(.+?) copy(?: (\d+))?$/.exec(name);
    if (m) return m[1];
    m = /^(.+?) kopi(?: (\d+))?$/i.exec(name);
    return m ? m[1] : null;
}

export function getBlocklistDuplicateSuffix() {
    return tSettings('blocklistDuplicateSuffix');
}

/** Slot numbers already used for base (counts both "copy" and "kopi" names — one chain per base). */
export function collectUsedDuplicateSuffixSlots(base) {
    const used = new Set();
    const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${esc} (copy|kopi)(?: (\\d+))?$`, 'i');
    for (const bl of state.appData.blocklists) {
        const m = re.exec(bl.name);
        if (!m) continue;
        used.add(m[2] ? parseInt(m[2], 10) : 1);
    }
    return used;
}

/** Comparable string for content (websites, apps only). Only these + name affect duplicate copy-number chain. */
export function contentKey(blocklistId) {
    const bl = state.appData.blocklists.find(b => b.id === blocklistId);
    if (!bl) return '';
    const w = [...(bl.websites || [])].sort();
    const a = [...getBlocklistRegularApps(bl)].sort();
    const iosSelection = getBlocklistIOSScreenTimeSelection(bl);
    return JSON.stringify({
        w,
        a,
        iosAppTokens: [...(iosSelection?.applicationTokens || [])].sort(),
        iosCategoryTokens: [...(iosSelection?.categoryTokens || [])].sort(),
        iosSummary: iosSelection?.summaryLabel || ''
    });
}

export function sameBlocklistContent(idA, idB) { return contentKey(idA) === contentKey(idB); }

/** True if name is root, "root copy|kopi", or "root copy|kopi N". */
export function nameInChain(name, root) {
    if (name === root) return true;
    const esc = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${esc} (copy|kopi)(?: (\\d+))?$`, 'i');
    return re.test(name);
}

/** Next duplicate name using current locale suffix; gap-fill; same chain if unedited, else new chain from current name. */
export function getNextCopyName(blocklist) {
    const suffix = getBlocklistDuplicateSuffix();
    const name = blocklist.name;
    const root = parseCopyRoot(name);
    let base = name;
    if (root !== null) {
        const otherInChainSameContent = state.appData.blocklists.some(bl =>
            bl.id !== blocklist.id && nameInChain(bl.name, root) && sameBlocklistContent(bl.id, blocklist.id)
        );
        if (otherInChainSameContent) base = root;
    }
    const used = collectUsedDuplicateSuffixSlots(base);
    let n = 1;
    while (used.has(n)) n++;
    return truncateBlocklistName(n === 1 ? `${base} ${suffix}` : `${base} ${suffix} ${n}`);
}

/** True if the blocklist has an active one-off block or a schedule currently in an active segment (and not paused). */
export function isBlocklistCurrentlyActive(blocklistId) {
    const now = Date.now();
    const hasActiveBlock = state.appData.activeBlocks.some(
        b => b.blocklistId === blocklistId && isOneOffBlockEnforced(b, now)
    );
    if (hasActiveBlock) return true;
    const schedule = state.appData.schedules?.find(s => s.blocklistId === blocklistId);
    if (!schedule?.segments?.length) return false;
    return isScheduleSegmentActiveNow(schedule, new Date(now));
}

export function clearPendingScheduleDraft(blocklistId) {
    if (!blocklistId || !state.appData.settings) return;
    if (state.appData.settings.pendingScheduleSegments?.[blocklistId]) {
        delete state.appData.settings.pendingScheduleSegments[blocklistId];
    }
    if (state.appData.settings.pendingScheduleRepeatOptions?.[blocklistId]) {
        delete state.appData.settings.pendingScheduleRepeatOptions[blocklistId];
    }
}

export function cloneScheduleSegment(seg) {
    return {
        startHour: seg.startHour,
        startMinute: seg.startMinute,
        endHour: seg.endHour,
        endMinute: seg.endMinute,
        days: [...(seg.days || [])]
    };
}

export function normalizeScheduleRepeatFromSchedule(schedule) {
    const repeatType = schedule?.repeatType || 'no';
    let repeatDate = null;
    if (repeatType === 'date' && schedule?.repeatDate) {
        const rd = schedule.repeatDate;
        repeatDate = typeof rd === 'number' ? rd : new Date(rd.getTime ? rd.getTime() : rd).getTime();
    }
    return { repeatType, repeatDate };
}

/** Committed or draft schedule config for a blocklist (segments + repeat, no active state). */
export function getBlocklistScheduleDraft(blocklistId) {
    const existingSchedule = state.appData.schedules?.find((s) => s.blocklistId === blocklistId);
    const pendingSegs = state.appData.settings?.pendingScheduleSegments?.[blocklistId];
    const pendingRepeat = state.appData.settings?.pendingScheduleRepeatOptions?.[blocklistId];

    if (existingSchedule?.segments?.length) {
        return {
            segments: existingSchedule.segments.map(cloneScheduleSegment),
            repeat: normalizeScheduleRepeatFromSchedule(existingSchedule)
        };
    }

    if (pendingSegs?.length) {
        return {
            segments: pendingSegs.map((seg) => ({ ...seg })),
            repeat:
                pendingRepeat && typeof pendingRepeat.repeatType === 'string'
                    ? {
                          repeatType: pendingRepeat.repeatType,
                          repeatDate:
                              pendingRepeat.repeatType === 'date' && pendingRepeat.repeatDate != null
                                  ? pendingRepeat.repeatDate
                                  : null
                      }
                    : { repeatType: 'forever', repeatDate: null }
        };
    }

    return null;
}

export function saveBlocklistScheduleDraft(blocklistId, draft) {
    if (!blocklistId || !draft?.segments?.length) return;
    if (!state.appData.settings) state.appData.settings = {};
    if (!state.appData.settings.pendingScheduleSegments) state.appData.settings.pendingScheduleSegments = {};
    if (!state.appData.settings.pendingScheduleRepeatOptions) state.appData.settings.pendingScheduleRepeatOptions = {};
    state.appData.settings.pendingScheduleSegments[blocklistId] = draft.segments.map(cloneScheduleSegment);
    state.appData.settings.pendingScheduleRepeatOptions[blocklistId] = draft.repeat || {
        repeatType: 'forever',
        repeatDate: null
    };
}

export function duplicateBlocklist(id) {
    const blocklist = state.appData.blocklists.find(bl => bl.id === id);
    if (!blocklist) return;

    const newId = generateId();
    const newName = getNextCopyName(blocklist);

    const duplicate = {
        id: newId,
        name: newName,
        mode: blocklist.mode || 'blocklist',
        color: blocklist.color ?? null,
        emoji: blocklist.emoji ?? '🚫',
        websites: [...(blocklist.websites || [])],
        apps: [...getBlocklistRegularApps(blocklist)],
        iosScreenTimeSelection: cloneIOSScreenTimeSelection(getBlocklistIOSScreenTimeSelection(blocklist)),
        showItemDetails: blocklist.showItemDetails !== false,
        alwaysShowInSchedule: blocklist.alwaysShowInSchedule !== false,
        overrideDifficulty: cloneOverrideDifficulty(blocklist.overrideDifficulty)
    };

    state.appData.blocklists.push(duplicate);

    const scheduleDraft = getBlocklistScheduleDraft(id);
    if (scheduleDraft) {
        saveBlocklistScheduleDraft(newId, scheduleDraft);
    }

    saveData();
    render();

    // Only keep selection on the original blocklist if it was already selected (user had focused it).
    // If they duplicated from the card menu without having clicked the card first, don't switch focus to it.
    if (state.selectedBlocklistId === id) {
        const dropdown = document.getElementById('blocklist-select');
        if (dropdown) {
            dropdown.value = id;
            handleBlocklistSelect({ target: dropdown });
        }
    }
}

export const BLOCKLIST_EXPORT_FORMAT = 'redd-block-rules';
export const BLOCKLIST_EXPORT_FORMAT_VERSION = 2;

export function serializeBlocklistForExport(blocklist) {
    const payload = {
        name: blocklist.name,
        mode: blocklist.mode || 'blocklist',
        color: blocklist.color ?? null,
        emoji: blocklist.emoji ?? '🚫',
        websites: [...(blocklist.websites || [])],
        apps: [...getBlocklistRegularApps(blocklist)],
        iosScreenTimeSelection: cloneIOSScreenTimeSelection(getBlocklistIOSScreenTimeSelection(blocklist)),
        showItemDetails: blocklist.showItemDetails !== false,
        alwaysShowInSchedule: blocklist.alwaysShowInSchedule !== false,
        overrideDifficulty: cloneOverrideDifficulty(blocklist.overrideDifficulty)
    };

    const scheduleDraft = getBlocklistScheduleDraft(blocklist.id);
    if (scheduleDraft) {
        payload.schedule = {
            segments: scheduleDraft.segments.map(cloneScheduleSegment),
            repeatType: scheduleDraft.repeat.repeatType,
            repeatDate: scheduleDraft.repeat.repeatDate
        };
    }

    return payload;
}

export function buildBlocklistsExportPayload() {
    return {
        format: BLOCKLIST_EXPORT_FORMAT,
        formatVersion: BLOCKLIST_EXPORT_FORMAT_VERSION,
        exportedAt: new Date().toISOString(),
        blocklists: (state.appData.blocklists || []).map(serializeBlocklistForExport)
    };
}

export function normalizeImportedScheduleSegment(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const startHour = Number(raw.startHour);
    const startMinute = Number(raw.startMinute);
    const endHour = Number(raw.endHour);
    const endMinute = Number(raw.endMinute);
    const days = Array.isArray(raw.days)
        ? raw.days.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
        : [];
    if (
        !Number.isFinite(startHour)
        || !Number.isFinite(startMinute)
        || !Number.isFinite(endHour)
        || !Number.isFinite(endMinute)
        || days.length === 0
    ) {
        return null;
    }
    return { startHour, startMinute, endHour, endMinute, days: [...days] };
}

export function normalizeImportedSchedule(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const segments = (Array.isArray(raw.segments) ? raw.segments : [])
        .map(normalizeImportedScheduleSegment)
        .filter(Boolean);
    if (segments.length === 0) return null;

    const repeatType = typeof raw.repeatType === 'string' ? raw.repeatType : 'forever';
    let repeatDate = null;
    if (repeatType === 'date' && raw.repeatDate != null) {
        repeatDate = typeof raw.repeatDate === 'number'
            ? raw.repeatDate
            : new Date(raw.repeatDate).getTime();
        if (!Number.isFinite(repeatDate)) repeatDate = null;
    }

    return {
        segments,
        repeat: { repeatType, repeatDate }
    };
}

export function normalizeImportedBlocklist(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

    const websites = Array.isArray(raw.websites)
        ? raw.websites.filter((entry) => typeof entry === 'string' && entry.trim())
        : [];
    const apps = Array.isArray(raw.apps)
        ? raw.apps.filter((entry) => typeof entry === 'string' && entry.trim() && !isScreenTimeSummaryEntry(entry))
        : [];
    const schedule = normalizeImportedSchedule(raw.schedule);

    if (
        typeof raw.name !== 'string'
        && websites.length === 0
        && apps.length === 0
        && !raw.iosScreenTimeSelection
        && !schedule
    ) {
        return null;
    }

    const imported = {
        name: typeof raw.name === 'string' ? raw.name : tSettings('importBlocklistDefaultName'),
        mode: typeof raw.mode === 'string' && raw.mode.trim() ? raw.mode : 'blocklist',
        color: typeof raw.color === 'string' && raw.color.trim() ? raw.color : null,
        emoji: typeof raw.emoji === 'string' && raw.emoji.trim() ? raw.emoji : '🚫',
        websites,
        apps,
        iosScreenTimeSelection: cloneIOSScreenTimeSelection(
            getBlocklistIOSScreenTimeSelection({
                apps: raw.apps,
                iosScreenTimeSelection: raw.iosScreenTimeSelection
            })
        ),
        showItemDetails: raw.showItemDetails !== false,
        alwaysShowInSchedule: raw.alwaysShowInSchedule !== false,
        overrideDifficulty: cloneOverrideDifficulty(raw.overrideDifficulty),
        schedule
    };

    return normalizeBlocklist(imported);
}

export function parseBlocklistsImportPayload(text) {
    const parsed = JSON.parse(text);
    const rawList = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.blocklists)
            ? parsed.blocklists
            : null;
    if (!rawList) {
        throw new Error('missing blocklists array');
    }
    return rawList.map(normalizeImportedBlocklist).filter(Boolean);
}

export function uniqueImportedBlocklistName(desiredName) {
    let name = truncateBlocklistName(String(desiredName || '').trim() || tSettings('importBlocklistDefaultName'));
    if (!state.appData.blocklists.some((bl) => bl.name === name)) return name;
    return getNextCopyName({
        id: generateId(),
        name,
        websites: [],
        apps: []
    });
}

export function blocklistFromImportedEntry(entry) {
    return {
        id: generateId(),
        name: uniqueImportedBlocklistName(entry.name),
        mode: entry.mode || 'blocklist',
        color: entry.color ?? null,
        emoji: entry.emoji ?? '🚫',
        websites: [...(entry.websites || [])],
        apps: [...getBlocklistRegularApps(entry)],
        iosScreenTimeSelection: cloneIOSScreenTimeSelection(getBlocklistIOSScreenTimeSelection(entry)),
        showItemDetails: entry.showItemDetails !== false,
        alwaysShowInSchedule: entry.alwaysShowInSchedule !== false,
        overrideDifficulty: cloneOverrideDifficulty(entry.overrideDifficulty)
    };
}

export async function exportBlocklistsToFile() {
    const blocklists = state.appData.blocklists || [];
    if (blocklists.length === 0) {
        await message(tSettings('exportBlocklistsEmpty'), { title: tSettings('exportBlocklistsFailedTitle'), kind: 'info' });
        return;
    }

    try {
        const selectedPath = await saveDialog({
            title: tSettings('exportBlocklistsSaveTitle'),
            defaultPath: 'redd-block-rules.json',
            filters: [{ name: 'JSON', extensions: ['json'] }]
        });
        if (!selectedPath || typeof selectedPath !== 'string') return;

        const payload = buildBlocklistsExportPayload();
        await writeTextFile(selectedPath, `${JSON.stringify(payload, null, 2)}\n`);
        await message(
            tSettingsFmt('exportBlocklistsSuccessFmt', { n: blocklists.length, path: selectedPath }),
            { title: tSettings('exportBlocklistsSuccessTitle'), kind: 'info' }
        );
    } catch (err) {
        console.warn('[export] blocklists:', err);
        await message(tSettings('exportBlocklistsFailed'), { title: tSettings('exportBlocklistsFailedTitle'), kind: 'error' });
    }
}

export async function importBlocklistsFromFile() {
    try {
        const selectedPath = await openDialog({
            multiple: false,
            title: tSettings('importBlocklistsOpenTitle'),
            filters: [
                { name: 'JSON', extensions: ['json'] },
                { name: 'All files', extensions: ['*'] }
            ]
        });
        if (!selectedPath || typeof selectedPath !== 'string') return;

        let importedEntries;
        try {
            importedEntries = parseBlocklistsImportPayload(await readTextFile(selectedPath));
        } catch (err) {
            console.warn('[import] parse blocklists:', err);
            await message(tSettings('importBlocklistsParseFailed'), { title: tSettings('importBlocklistsFailedTitle'), kind: 'error' });
            return;
        }

        if (importedEntries.length === 0) {
            await message(tSettings('importBlocklistsInvalidFile'), { title: tSettings('importBlocklistsFailedTitle'), kind: 'warning' });
            return;
        }

        const confirmed = await ask(
            tSettingsFmt('importBlocklistsConfirmFmt', { n: importedEntries.length }),
            { title: tSettings('importBlocklistsDialogTitle'), kind: 'warning' }
        );
        if (!confirmed) return;

        for (const entry of importedEntries) {
            const blocklist = blocklistFromImportedEntry(entry);
            state.appData.blocklists.push(blocklist);
            if (entry.schedule) {
                saveBlocklistScheduleDraft(blocklist.id, entry.schedule);
            }
        }

        await saveData();
        render();

        await message(
            tSettingsFmt('importBlocklistsSuccessFmt', { n: importedEntries.length }),
            { title: tSettings('importBlocklistsSuccessTitle'), kind: 'info' }
        );
    } catch (err) {
        console.warn('[import] blocklists:', err);
        await message(tSettings('importBlocklistsFailed'), { title: tSettings('importBlocklistsFailedTitle'), kind: 'error' });
    }
}

export function setupBlocklistsImportExportButtons() {
    const exportBtn = document.getElementById('settings-export-blocklists-btn');
    const importBtn = document.getElementById('settings-import-blocklists-btn');
    if (exportBtn && !exportBtn._listenerAdded) {
        exportBtn._listenerAdded = true;
        exportBtn.addEventListener('click', () => {
            void exportBlocklistsToFile();
        });
    }
    if (importBtn && !importBtn._listenerAdded) {
        importBtn._listenerAdded = true;
        importBtn.addEventListener('click', () => {
            void importBlocklistsFromFile();
        });
    }
}

// Delete blocklist with undo support
export let pendingDelete = null; // { blocklist, activeBlocks, timeoutId }

export async function deleteBlocklist(id) {
    const blocklist = state.appData.blocklists.find(bl => bl.id === id);
    if (!blocklist) return;

    // Check if this blocklist has an active block or schedule running
    const now = Date.now();
    const hasActiveBlock = state.appData.activeBlocks.some(
        block => block.blocklistId === id && block.startTime <= now && block.endTime > now
    );
    const hasActiveSchedule = state.appData.schedules?.some(
        s => s.blocklistId === id && s.segments && s.segments.length > 0
    );

    if (hasActiveBlock) {
        alert(tSettingsFmt('deleteBlocklistDeniedActiveBlockFmt', { name: blocklist.name }));
        return;
    }

    if (hasActiveSchedule) {
        alert(tSettingsFmt('deleteBlocklistDeniedActiveScheduleFmt', { name: blocklist.name }));
        return;
    }

    // If there's already a pending delete, commit it first
    if (pendingDelete) {
        commitDelete();
    }

    // Store the blocklist and any active blocks for potential undo
    const activeBlocksToRemove = state.appData.activeBlocks.filter(b => b.blocklistId === id);

    // Remove from data (soft delete)
    state.appData.blocklists = state.appData.blocklists.filter(bl => bl.id !== id);
    state.appData.activeBlocks = state.appData.activeBlocks.filter(b => b.blocklistId !== id);
    expandedBlocklistCardIds.delete(id);

    // If the deleted blocklist was the selected one, reset the scheduler UI
    if (state.selectedBlocklistId === id) {
        state.selectedBlocklistId = null;
        const blocklistSelect = document.getElementById('blocklist-select');
        blocklistSelect.value = '';
        handleBlocklistSelect({ target: blocklistSelect });
    }

    // Re-render immediately
    render();

    // Show undo toast
    const toast = document.getElementById('undo-toast');
    const message = document.getElementById('undo-toast-message');
    message.textContent = tSettingsFmt('deleteUndoToastFmt', { name: blocklist.name });
    toast.classList.remove('hidden');

    // Set up auto-commit after 5 seconds
    const timeoutId = setTimeout(() => {
        commitDelete();
    }, 5000);

    pendingDelete = {
        blocklist,
        activeBlocks: activeBlocksToRemove,
        timeoutId
    };
}

export function commitDelete() {
    if (!pendingDelete) return;

    clearTimeout(pendingDelete.timeoutId);

    // Save data permanently
    saveData();

    // Update hosts if needed
    if (pendingDelete.activeBlocks.length > 0) {
        updateHostsFile();
    }

    // Hide toast
    document.getElementById('undo-toast').classList.add('hidden');
    pendingDelete = null;
}

export function undoDelete() {
    if (!pendingDelete) return;

    clearTimeout(pendingDelete.timeoutId);

    // Restore the blocklist and active blocks
    state.appData.blocklists.push(pendingDelete.blocklist);
    pendingDelete.activeBlocks.forEach(block => {
        state.appData.activeBlocks.push(block);
    });

    // Hide toast
    document.getElementById('undo-toast').classList.add('hidden');
    pendingDelete = null;

    // Re-render
    render();
}

// Main render function

// Render blocklists
export function renderBlocklists() {
    closeAllBlocklistMenus();
    const container = document.getElementById('blocklists-container');

    if (state.appData.blocklists.length === 0) {
        container.innerHTML = `
      <div class="no-active-blocks clickable" id="empty-blocklists-cta" style="cursor: pointer;">
        <p>${tSettings('noBlocklistsYet')}</p>
        <p class="subtle">${tSettings('clickHereCreateBlocklist')}</p>
      </div>
    `;
        document.getElementById('empty-blocklists-cta').addEventListener('click', () => {
            openBlocklistModal();
        });
        return;
    }

    container.innerHTML = state.appData.blocklists.map(bl => {
        const metaHtml = buildBlocklistCardMetaHtml(bl);
        const isExpanded = expandedBlocklistCardIds.has(bl.id);
        const showDetails = blocklistCardHasExpandableSummary(bl);
        const detailsHtml = showDetails ? buildBlocklistCardDetailsHtml(bl, { expanded: isExpanded }) : '';

        // Get color for left border
        const borderColor = bl.color || 'linear-gradient(135deg, #4a00e0 0%, #8e2de2 100%)';

        // Check if this blocklist has an active block
        const now = Date.now();
        const activeBlock = state.appData.activeBlocks.find(b => b.blocklistId === bl.id && b.startTime <= now && b.endTime > now);
        const isActive = !!activeBlock;

        // Check if this blocklist has a schedule
        const hasSchedule = state.appData.schedules && state.appData.schedules.some(s => s.blocklistId === bl.id);

        const activeClass = isActive ? ' blocklist-card-active' : (hasSchedule ? ' blocklist-card-scheduled' : '');

        // Calculate badges - show BOTH if applicable
        let oneOffBadge = '';
        let scheduleBadge = '';

        // Green "live" dot prefixed onto badges for blocks that are
        // currently running (one-off active or active schedule segment).
        // Same colour treatment as the BLOCKING NOW row dot.

        // One-off block badge
        if (isActive && activeBlock) {
            if (activeBlock.isPaused) {
                const pauseRemaining = activeBlock.pauseEndTime - now;
                const pauseMins = Math.max(1, Math.ceil(pauseRemaining / 60000));
                const pauseTimeText = pauseMins >= 60 ? `${Math.floor(pauseMins / 60)}h ${pauseMins % 60}m` : `${pauseMins}m`;
                oneOffBadge = buildBlocklistStatusSegment(`Paused ${pauseTimeText}`, {
                    iconHtml: BLOCKLIST_STATUS_ICON_PAUSE,
                    textClass: 'blocklist-status-text paused-badge',
                });
            } else if (isBlockAlwaysOn(activeBlock)) {
                oneOffBadge = buildBlocklistStatusSegment('Always', {
                    showDot: true,
                    iconHtml: BLOCKLIST_STATUS_ICON_POWER,
                    textClass: 'blocklist-status-text active-badge',
                });
            } else {
                const remaining = activeBlock.endTime - now;
                const mins = Math.ceil(remaining / 60000);
                oneOffBadge = buildBlocklistStatusSegment(formatBlockTimeRemainingShort(mins), {
                    showDot: true,
                    iconHtml: BLOCKLIST_STATUS_ICON_HOURGLASS,
                    textClass: 'blocklist-status-text active-badge',
                });
            }
        }

        // Schedule badge (blue with calendar-sync)
        let scheduleSegmentRunning = false;
        if (hasSchedule) {
            const compactScheduleUpcomingLabel =
                (bl.name || '').trim().length > BLOCKLIST_CARD_COMPACT_SCHEDULE_UPCOMING_CHARS;
            const schedule = state.appData.schedules.find(s => s.blocklistId === bl.id);
            let scheduleTimeText = '';
            if (schedule && schedule.segments) {
                if (isSchedulePausedNow(schedule, now)) {
                    if (schedule.pauseEndTime) {
                        const pauseMins = Math.max(1, Math.ceil((schedule.pauseEndTime - now) / 60000));
                        scheduleTimeText = pauseMins >= 60 ? `Paused ${Math.floor(pauseMins / 60)}h ${pauseMins % 60}m` : `Paused ${pauseMins}m`;
                    } else {
                        scheduleTimeText = 'Paused';
                    }
                } else {
                    // Check if any segment is currently active
                    const nowDate = new Date();
                    const currentDay = nowDate.getDay() === 0 ? 6 : nowDate.getDay() - 1; // Mon=0
                    const currentMins = nowDate.getHours() * 60 + nowDate.getMinutes();

                    // Find active segment (handling cross-midnight segments)
                    const activeSegment = schedule.segments.find(seg => {
                        const startMins = seg.startHour * 60 + seg.startMinute;
                        const endMins = seg.endHour * 60 + seg.endMinute;

                        if (endMins > startMins) {
                            // Same-day segment (e.g., 09:00 - 17:00)
                            return seg.days.includes(currentDay) &&
                                currentMins >= startMins &&
                                currentMins < endMins;
                        } else {
                            // Cross-midnight segment (e.g., 22:00 - 04:00)
                            const yesterdayDay = currentDay === 0 ? 6 : currentDay - 1;
                            const inEveningPortion = seg.days.includes(currentDay) && currentMins >= startMins;
                            const inMorningPortion = seg.days.includes(yesterdayDay) && currentMins < endMins;
                            return inEveningPortion || inMorningPortion;
                        }
                    });

                    if (activeSegment) {
                        // Currently blocking - show time left (or snooze countdown)
                        scheduleSegmentRunning = true;
                        const snoozedBlocklistId = getActiveAppBlockingSnoozeBlocklistId(now);
                        if (snoozedBlocklistId === bl.id) {
                            scheduleTimeText = formatAppBlockingSnoozeStartsIn(
                                appBlockingWarningSnoozedUntilMs - now,
                            );
                        } else {
                            const startMins = activeSegment.startHour * 60 + activeSegment.startMinute;
                            const endMins = activeSegment.endHour * 60 + activeSegment.endMinute;
                            let minsLeft;

                            if (endMins > startMins) {
                                // Same-day segment
                                minsLeft = endMins - currentMins;
                            } else {
                                // Cross-midnight segment
                                if (currentMins >= startMins) {
                                    // In evening portion: time until midnight + morning end
                                    minsLeft = (24 * 60 - currentMins) + endMins;
                                } else {
                                    // In morning portion: time until end
                                    minsLeft = endMins - currentMins;
                                }
                            }
                            scheduleTimeText = formatBlockTimeRemainingShort(minsLeft);
                        }
                    } else {
                        // Find next upcoming segment
                        let nextStart = null;
                        for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
                            const checkDay = (currentDay + dayOffset) % 7;
                            const segsForDay = schedule.segments.filter(seg => seg.days.includes(checkDay))
                                .sort((a, b) => (a.startHour * 60 + a.startMinute) - (b.startHour * 60 + b.startMinute));

                            for (const seg of segsForDay) {
                                const segStartMins = seg.startHour * 60 + seg.startMinute;
                                if (dayOffset === 0 && segStartMins <= currentMins) continue; // Already passed today

                                // Found next segment. minsUntil = (full days) + (start-of-segment minutes) - (current minutes).
                                // Same formula works whether dayOffset is 0 (today) or further out.
                                const minsUntil = (dayOffset * 24 * 60) + segStartMins - currentMins;

                                const nMinutes = String(minsUntil);
                                const nHours = String(Math.floor(minsUntil / 60));
                                const nDays = String(Math.floor(minsUntil / (24 * 60)));
                                if (minsUntil < 60) {
                                    scheduleTimeText = compactScheduleUpcomingLabel
                                        ? tSettingsFmt('blocklistScheduleCompactMinutesFmt', { n: nMinutes })
                                        : tSettingsFmt('blocklistScheduleStartsInMinutesFmt', { n: nMinutes });
                                } else if (minsUntil < 24 * 60) {
                                    scheduleTimeText = compactScheduleUpcomingLabel
                                        ? tSettingsFmt('blocklistScheduleCompactHoursFmt', { n: nHours })
                                        : tSettingsFmt('blocklistScheduleStartsInHoursFmt', { n: nHours });
                                } else {
                                    scheduleTimeText = compactScheduleUpcomingLabel
                                        ? tSettingsFmt('blocklistScheduleCompactDaysFmt', { n: nDays })
                                        : tSettingsFmt('blocklistScheduleStartsInDaysFmt', { n: nDays });
                                }
                                nextStart = true;
                                break;
                            }
                            if (nextStart) break;
                        }
                        if (!scheduleTimeText) scheduleTimeText = tSettings('blocklistScheduleFallback');
                    }
                }
            }
            const isSnoozedCard = getActiveAppBlockingSnoozeBlocklistId(now) === bl.id;
            if (isSnoozedCard) {
                scheduleBadge = buildBlocklistStatusSegment(scheduleTimeText, {
                    iconHtml: BLOCKLIST_STATUS_ICON_SNOOZE,
                    textClass: 'blocklist-status-text schedule-badge schedule-badge-snoozed',
                });
            } else {
                scheduleBadge = buildBlocklistStatusSegment(scheduleTimeText, {
                    showDot: scheduleSegmentRunning,
                    iconHtml: BLOCKLIST_STATUS_ICON_CALENDAR,
                    textClass: 'blocklist-status-text schedule-badge',
                });
            }
        }

        const activeBadge = oneOffBadge + scheduleBadge;
        const badgesHtml = activeBadge
            ? `<span class="blocklist-name-badges">${activeBadge}</span>`
            : '';

        // Check if this blocklist is selected
        const isSelected = bl.id === state.selectedBlocklistId;
        const selectedClass = isSelected ? ' selected' : '';
        const expandedClass = isExpanded ? ' blocklist-card-expanded' : '';
        const accent = bl.color || '#667eea';
        const selectedStyle = isSelected
            ? `style="border-top-color: ${accent}; border-right-color: ${accent}; border-bottom-color: ${accent}; border-left-width: 0; box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);"`
            : '';
        const enteringChipColor = getEnteringChipColor(accent);
        const enteringChip = isSelected
            ? `<span class="blocklist-entering-chip" style="background-color: ${enteringChipColor}">${tSettings('blocklistEnteringChip')}</span>`
            : '';

        return `
      <div class="blocklist-card${activeClass}${selectedClass}${expandedClass}" data-id="${bl.id}" data-active="${isActive}" ${selectedStyle}>
        ${enteringChip}
        <div class="blocklist-stripe" style="background: ${borderColor}"></div>
        <div class="blocklist-card-body">
          <div class="blocklist-card-header">
            <div class="blocklist-card-title-row">
              <div class="blocklist-name">
                <span class="blocklist-emoji">${bl.emoji || '🚫'}</span>
                <span class="blocklist-title-text">${escapeHtml(bl.name)}</span>
                ${badgesHtml}
              </div>
              <div class="blocklist-actions">
                <div class="blocklist-menu-wrapper">
                  <button class="blocklist-action-btn blocklist-menu-btn" title="${tSettings('blocklistCardMenuTitle')}" aria-label="${tSettings('blocklistCardMenuTitle')}">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <circle cx="12" cy="5" r="1"></circle>
                      <circle cx="12" cy="12" r="1"></circle>
                      <circle cx="12" cy="19" r="1"></circle>
                    </svg>
                  </button>
                  <div class="blocklist-menu hidden">
                    <button class="blocklist-menu-item duplicate-blocklist-item" title="${tSettings('blocklistCardDuplicate')}" aria-label="${tSettings('blocklistCardDuplicate')}">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="15" x2="15" y1="12" y2="18"/>
                        <line x1="12" x2="18" y1="15" y2="15"/>
                        <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
                        <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
                      </svg>
                      ${tSettings('blocklistCardDuplicate')}
                    </button>
                    <button class="blocklist-menu-item delete-blocklist-item" title="${tSettings('blocklistCardDelete')}" aria-label="${tSettings('blocklistCardDelete')}">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M3 6h18"></path>
                        <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
                        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
                      </svg>
                      ${tSettings('blocklistCardDelete')}
                    </button>
                  </div>
                </div>
                <button class="blocklist-action-btn edit-btn" title="${tSettings('blocklistCardEditTooltip')}" aria-label="${tSettings('blocklistCardEditTooltip')}">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>
                    <path d="m15 5 4 4"/>
                  </svg>
                </button>
              </div>
            </div>
            <div class="blocklist-meta">${metaHtml}</div>
          </div>
          ${detailsHtml}
        </div>
      </div>
    `;
    }).join('');

    // Add event listeners
    container.querySelectorAll('.blocklist-card').forEach(card => {
        const id = card.dataset.id;
        const isActive = card.dataset.active === 'true';

        // Everywhere on the card except the summary button selects/deselects.
        card.addEventListener('click', (e) => {
            if (e.target.closest('.blocklist-meta-items-btn')) return;
            if (e.target.closest('.blocklist-actions') || e.target.closest('.blocklist-menu')) return;

            if (state.selectedBlocklistId === id) {
                deselectBlocklist();
                return;
            }

            const dropdown = document.getElementById('blocklist-select');
            dropdown.value = id;
            handleBlocklistSelect({ target: dropdown });
        });

        card.querySelector('.edit-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            closeAllBlocklistMenus();
            const blocklist = state.appData.blocklists.find(bl => bl.id === id);
            openBlocklistModal(blocklist);
        });

        const summaryBtn = card.querySelector('.blocklist-meta-items-btn');
        if (summaryBtn) {
            summaryBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                toggleBlocklistCardExpanded(card, id);
            });
        }

        const menuBtn = card.querySelector('.blocklist-menu-btn');
        const menu = card.querySelector('.blocklist-menu');
        const menuWrapper = menuBtn?.closest('.blocklist-menu-wrapper');

        menuBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!menu || !menuWrapper) return;
            const wasHidden = menu.classList.contains('hidden');
            closeAllBlocklistMenus();
            if (wasHidden) positionBlocklistMenu(menuBtn, menu, menuWrapper);
        });

        card.querySelector('.duplicate-blocklist-item')?.addEventListener('click', (e) => {
            e.stopPropagation();
            closeAllBlocklistMenus();
            duplicateBlocklist(id);
        });

        card.querySelector('.delete-blocklist-item').addEventListener('click', (e) => {
            e.stopPropagation();
            closeAllBlocklistMenus();
            deleteBlocklist(id);
        });

        // Drag and drop using mouse events on document
        card.addEventListener('mousedown', (e) => {
            // Don't start drag if clicking on buttons
            if (e.target.closest('.edit-btn') || e.target.closest('.blocklist-menu-btn') || e.target.closest('.blocklist-menu')) return;
            if (e.target.closest('.blocklist-meta-items-btn')) return;
            if (e.target.closest('.blocklist-actions')) return;
            if (e.button !== 0) return; // Only left click

            e.preventDefault(); // Prevent text selection

            const startY = e.clientY;
            let isDragging = false;
            const container = document.getElementById('blocklists-container');


            const onMouseMove = (moveEvent) => {
                // Only start dragging after moving 5px
                if (!isDragging && Math.abs(moveEvent.clientY - startY) > 5) {
                    isDragging = true;
                    card.classList.add('dragging');
                }

                if (!isDragging) return;

                const siblings = [...container.querySelectorAll('.blocklist-card:not(.dragging)')];
                const nextSibling = siblings.find(sibling => {
                    const rect = sibling.getBoundingClientRect();
                    return moveEvent.clientY < rect.top + rect.height / 2;
                });


                if (nextSibling) {
                    container.insertBefore(card, nextSibling);
                } else {
                    container.appendChild(card);
                }
            };

            const onMouseUp = () => {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
                card.classList.remove('dragging');

                if (isDragging) {
                    saveBlocklistOrderFromDOM();
                }
            };

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    });
}

/// Pre-select the sole blocklist as the default state. Skipped if the
/// user has explicitly deselected this session (so click-outside / ESC
/// stay sticky). Pass `force: true` to clear that flag — used when the
/// user just *created* a new blocklist, which is a strong "I want to
/// use this" signal.
export function autoSelectSoleBlocklist({ force = false } = {}) {
    if (state.appData.blocklists.length !== 1) return;
    if (state.selectedBlocklistId) return;
    if (force) state.userExplicitlyDeselected = false;
    if (state.userExplicitlyDeselected) return;
    const dropdown = document.getElementById('blocklist-select');
    if (!dropdown) return;
    dropdown.value = state.appData.blocklists[0].id;
    handleBlocklistSelect({ target: dropdown });
}

const BLOCKLIST_MENU_Z_INDEX = 1000;

function restoreBlocklistMenu(menu) {
    menu.classList.add('hidden');
    menu.classList.remove('blocklist-menu-portaled');
    menu.style.position = '';
    menu.style.left = '';
    menu.style.top = '';
    menu.style.right = '';
    menu.style.transform = '';
    menu.style.zIndex = '';

    const wrapper = menu._blocklistMenuWrapper;
    if (wrapper && menu.parentElement !== wrapper) {
        wrapper.appendChild(menu);
    }
    delete menu._blocklistMenuWrapper;
    delete menu._blocklistMenuScrollParent;
}

function positionBlocklistMenu(menuBtn, menu, wrapper) {
    if (menu.parentElement !== document.body) {
        document.body.appendChild(menu);
    }

    menu._blocklistMenuWrapper = wrapper;
    menu.classList.add('blocklist-menu-portaled');
    menu.classList.remove('hidden');

    const padding = 8;
    const menuRect = menu.getBoundingClientRect();
    const anchorRect = wrapper.getBoundingClientRect();
    const card = menuBtn.closest('.blocklist-card');
    const menuAnchorOffset = card
        ? (parseFloat(getComputedStyle(card).getPropertyValue('--blocklist-menu-anchor-offset')) || 30)
        : 30;

    let left = anchorRect.right - menuAnchorOffset - menuRect.width;
    let top = anchorRect.top + (anchorRect.height / 2) - (menuRect.height / 2);

    left = Math.max(padding, Math.min(left, window.innerWidth - menuRect.width - padding));
    top = Math.max(padding, Math.min(top, window.innerHeight - menuRect.height - padding));

    menu.style.position = 'fixed';
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.right = 'auto';
    menu.style.transform = 'none';
    menu.style.zIndex = String(BLOCKLIST_MENU_Z_INDEX);

    const scrollParent = document.getElementById('blocklists-container');
    if (scrollParent) {
        menu._blocklistMenuScrollParent = scrollParent;
        scrollParent.addEventListener('scroll', closeAllBlocklistMenus, { once: true });
    }
}

export function closeAllBlocklistMenus() {
    document.querySelectorAll('.blocklist-menu').forEach(menu => {
        if (!menu.classList.contains('hidden') || menu.classList.contains('blocklist-menu-portaled')) {
            restoreBlocklistMenu(menu);
        }
    });
}

// Save blocklist order based on DOM position
export function saveBlocklistOrderFromDOM() {
    const container = document.getElementById('blocklists-container');
    if (!container) return;

    const cardElements = Array.from(container.querySelectorAll('.blocklist-card'));
    const newOrder = cardElements.map(card => card.dataset.id);

    // Reorder state.appData.blocklists to match
    const reorderedBlocklists = [];
    newOrder.forEach(id => {
        const blocklist = state.appData.blocklists.find(bl => bl.id === id);
        if (blocklist) {
            reorderedBlocklists.push(blocklist);
        }
    });

    // Add any blocklists that weren't in the DOM
    state.appData.blocklists.forEach(bl => {
        if (!reorderedBlocklists.find(r => r.id === bl.id)) {
            reorderedBlocklists.push(bl);
        }
    });

    state.appData.blocklists = reorderedBlocklists;
    saveData();

    // Re-render the bits of UI that mirror blocklist order. Don't call full render() —
    // the cards are already in the right order in the DOM (the user just dropped them
    // there), and a full re-render would briefly flicker.
    renderNowBlockingRow();
    renderScheduleVisibilityChips();
}