// Schedule start-overlay customisation: global presets, image/voice assets,
// mic recording, customise modal. Extracted verbatim from app.js.
import { state } from './state.js';
import { convertFileSrc } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { message, open as openDialog } from '@tauri-apps/plugin-dialog';
import { tauriAPI } from './tauri-api.js';
import { escapeHtml } from './utils.js';
import { tSettings, tSettingsFmt } from './i18n.js';
import { getBlocklistDisplayApps } from './list-presentation.js';
import { isMobileOverrideChallengePlatform } from './override-challenge.js';
import { saveData } from './persistence.js';
import { disableScheduleControls } from './time-inputs.js';
import { closeSchedulePanelDropdownMenus, canEditScheduleBetweenBlocks } from './schedule-editor.js';
import { findResponsibleBlocklistForWarningApps, joinAppListWithLimit } from './blocking-platform.js';
import {
    initScheduleOverlayMessageEditor,
    getScheduleOverlayMessageEditorHtml,
    setScheduleOverlayMessageEditorHtml,
    setScheduleOverlayMessageEditorPlaceholder,
    setScheduleOverlayMessageEditorEnabled,
    sanitizeOverlayMessageHtml,
    escapeHtmlForOverlay,
    normalizeStoredOverlayMessage,
    isOverlayMessageEmpty,
} from './schedule-overlay-message-editor.js';

/** Custom start-overlay config for the active schedule warning session. */
let appBlockingLetsGoVoiceAudio = null;
/** Selected start-overlay preset id for the pending schedule (null = default). */
let scheduleOverlayCustomiseDraft = null;
let scheduleOverlayCustomiseBlocklist = null;
/** Preset id being edited in the customise modal (null = new). */
let scheduleOverlayCustomisePresetId = null;
/** Saved form state when the customise modal loaded the current selection. */
let scheduleOverlayCustomiseBaseline = null;
export const SCHEDULE_OVERLAY_DEFAULT_PRESET_VALUE = '__default__';
const SCHEDULE_OVERLAY_NEW_PRESET_VALUE = '__new__';
let scheduleOverlayMediaRecorder = null;
let scheduleOverlayRecordChunks = [];
let scheduleOverlayRecordStream = null;
let scheduleOverlayRecordedMimeType = 'audio/webm';
let scheduleOverlayRecordAudioContext = null;
let scheduleOverlayRecordAnalyser = null;
let scheduleOverlayRecordMeterStream = null;
let scheduleOverlayRecordLevelRaf = null;
let scheduleOverlayRecordStartCancelled = false;
const SCHEDULE_OVERLAY_RECORD_LEVEL_BAR_COUNT = 12;
/** Blob URLs created for overlay asset previews — revoked when the modal closes. */
const overlayAssetBlobUrls = new Set();

// ---- Schedule start-overlay customisation --------------------------------

export const GLOBAL_OVERLAY_ASSET_NAMESPACE = 'global';

export function ensureGlobalStartOverlays() {
    if (!Array.isArray(state.appData.startOverlays)) {
        state.appData.startOverlays = [];
    }
    return state.appData.startOverlays;
}

export function getGlobalStartOverlays() {
    return ensureGlobalStartOverlays();
}

export function getNamedStartOverlayById(overlayId) {
    if (!overlayId) return null;
    return getGlobalStartOverlays().find((preset) => preset.id === overlayId) || null;
}

export function getUniqueNewScheduleStartOverlayName() {
    const base = tSettings('scheduleOverlaySelectNew');
    const existingNames = new Set(
        getGlobalStartOverlays().map((preset) => preset.name.trim().toLowerCase()),
    );
    if (!existingNames.has(base.toLowerCase())) return base;

    let n = 2;
    while (existingNames.has(`${base} ${n}`.toLowerCase())) n += 1;
    return `${base} ${n}`;
}

export function syncScheduleOverlayCustomiseSelectorDisplayName() {
    const select = document.getElementById('schedule-overlay-select');
    if (!select) return;

    const selection = state.scheduleOverlayCustomiseSelection;
    const name = document.getElementById('schedule-overlay-name-input')?.value?.trim() || '';

    if (selection === SCHEDULE_OVERLAY_NEW_PRESET_VALUE) {
        const newOption = select.querySelector(`option[value="${SCHEDULE_OVERLAY_NEW_PRESET_VALUE}"]`);
        if (newOption) {
            newOption.textContent = name || tSettings('scheduleOverlaySelectNew');
        }
        return;
    }

    if (selection && selection !== SCHEDULE_OVERLAY_DEFAULT_PRESET_VALUE) {
        const option = select.querySelector(`option[value="${CSS.escape(selection)}"]`);
        if (option && name) option.textContent = name;
    }
}

export function upsertGlobalStartOverlay(preset) {
    const overlays = ensureGlobalStartOverlays();
    const index = overlays.findIndex((item) => item.id === preset.id);
    if (index >= 0) overlays[index] = preset;
    else overlays.push(preset);
}

export async function deleteGlobalStartOverlay(presetId) {
    const preset = getNamedStartOverlayById(presetId);
    if (!preset) return false;

    if (preset.imageAsset) await removeScheduleOverlayAsset(preset.imageAsset);
    if (preset.voiceAsset) await removeScheduleOverlayAsset(preset.voiceAsset);

    state.appData.startOverlays = getGlobalStartOverlays().filter((item) => item.id !== presetId);

    for (const schedule of state.appData.schedules || []) {
        if (schedule.startOverlayId === presetId) {
            schedule.startOverlayId = null;
        }
    }

    if (state.appData.settings?.lastScheduleStartOverlayId === presetId) {
        delete state.appData.settings.lastScheduleStartOverlayId;
    }

    if (state.pendingScheduleStartOverlayId === presetId) {
        state.pendingScheduleStartOverlayId = null;
    }

    await saveData();
    return true;
}

export function getLastScheduleStartOverlayId() {
    const stored = state.appData.settings?.lastScheduleStartOverlayId;
    if (!stored) return null;
    return getNamedStartOverlayById(stored) ? stored : null;
}

export function rememberLastScheduleStartOverlayId(overlayId) {
    if (!state.appData.settings) state.appData.settings = {};
    const normalized = overlayId || null;
    if (normalized && !getNamedStartOverlayById(normalized)) return;
    if (normalized) state.appData.settings.lastScheduleStartOverlayId = normalized;
    else delete state.appData.settings.lastScheduleStartOverlayId;
}

export function migrateBlocklistStartOverlaysToGlobal() {
    let changed = false;
    ensureGlobalStartOverlays();
    const knownIds = new Set(state.appData.startOverlays.map((preset) => preset.id));

    for (const blocklist of state.appData.blocklists || []) {
        const legacyPresets = blocklist.startOverlays;
        if (!Array.isArray(legacyPresets) || legacyPresets.length === 0) {
            if (legacyPresets != null) {
                delete blocklist.startOverlays;
                changed = true;
            }
            continue;
        }

        for (const preset of legacyPresets) {
            if (!preset?.id || knownIds.has(preset.id)) continue;
            state.appData.startOverlays.push({ ...preset });
            knownIds.add(preset.id);
        }
        delete blocklist.startOverlays;
        changed = true;
    }

    return changed;
}

export function namedPresetToDraft(preset) {
    if (!preset) return getDefaultScheduleStartOverlay();
    return {
        custom: true,
        heading: preset.heading?.trim() ? preset.heading.trim() : null,
        message: preset.message?.trim() ? preset.message.trim() : null,
        letsGoLabel: preset.letsGoLabel?.trim() ? preset.letsGoLabel.trim() : null,
        imageAsset: preset.imageAsset || null,
        voiceAsset: preset.voiceAsset || null,
    };
}

export function namedPresetToRuntime(preset) {
    return normalizeScheduleStartOverlay(namedPresetToDraft(preset));
}

export function buildNamedStartOverlayPreset({ id, name, draft }) {
    const normalized = normalizeScheduleStartOverlay(draft);
    return {
        id,
        name: name.trim(),
        heading: normalized.heading,
        message: normalized.message,
        letsGoLabel: normalized.letsGoLabel,
        imageAsset: normalized.imageAsset,
        voiceAsset: normalized.voiceAsset,
    };
}

export function resolveScheduleStartOverlay(schedule) {
    if (!schedule) return null;
    if (schedule.startOverlayId) {
        const preset = getNamedStartOverlayById(schedule.startOverlayId);
        if (preset) return namedPresetToRuntime(preset);
    }
    if (schedule.startOverlay?.custom) {
        return normalizeScheduleStartOverlay(schedule.startOverlay);
    }
    return null;
}

export function migrateLegacyScheduleStartOverlays() {
    let changed = false;
    for (const schedule of state.appData.schedules || []) {
        if (schedule.startOverlayId || !schedule.startOverlay?.custom) continue;
        const presetId = crypto.randomUUID();
        upsertGlobalStartOverlay({
            id: presetId,
            name: tSettings('scheduleOverlayLegacyPresetName'),
            heading: schedule.startOverlay.heading || null,
            message: schedule.startOverlay.message || null,
            letsGoLabel: schedule.startOverlay.letsGoLabel || null,
            imageAsset: schedule.startOverlay.imageAsset || null,
            voiceAsset: schedule.startOverlay.voiceAsset || null,
        });
        schedule.startOverlayId = presetId;
        delete schedule.startOverlay;
        changed = true;
    }
    return changed;
}

export function getDefaultScheduleStartOverlay() {
    return {
        custom: false,
        heading: null,
        message: null,
        letsGoLabel: null,
        imageAsset: null,
        voiceAsset: null,
    };
}

export function cloneScheduleStartOverlay(overlay) {
    if (!overlay) return getDefaultScheduleStartOverlay();
    return {
        custom: !!overlay.custom,
        heading: overlay.heading?.trim() ? overlay.heading.trim() : null,
        message: overlay.message?.trim() ? overlay.message.trim() : null,
        letsGoLabel: overlay.letsGoLabel?.trim() ? overlay.letsGoLabel.trim() : null,
        imageAsset: overlay.imageAsset || null,
        voiceAsset: overlay.voiceAsset || null,
    };
}

export function scheduleStartOverlayHasCustomContent(overlay) {
    if (!overlay) return false;
    return !!(overlay.heading || overlay.message || overlay.letsGoLabel || overlay.imageAsset || overlay.voiceAsset);
}

export function normalizeScheduleStartOverlay(overlay) {
    const clone = cloneScheduleStartOverlay(overlay);
    clone.custom = scheduleStartOverlayHasCustomContent(clone);
    if (!clone.custom) {
        clone.heading = null;
        clone.message = null;
        clone.letsGoLabel = null;
        clone.imageAsset = null;
        clone.voiceAsset = null;
    }
    return clone;
}

export function getScheduleStartOverlayForBlocklistId(blocklistId) {
    const schedule = state.appData.schedules?.find((s) => s.blocklistId === blocklistId);
    if (!schedule) return null;
    return resolveScheduleStartOverlay(schedule);
}

export function getScheduleStartOverlayForWarningApps(appNames) {
    const blocklist = findResponsibleBlocklistForWarningApps(appNames);
    if (!blocklist) return null;
    return getScheduleStartOverlayForBlocklistId(blocklist.id);
}

export function pickOverlayRecordingMimeType() {
    const candidates = [
        'audio/mp4',
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
    ];
    for (const candidate of candidates) {
        if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(candidate)) {
            return candidate;
        }
    }
    return '';
}

export function overlayMimeTypeToExtension(mimeType) {
    const mime = (mimeType || '').toLowerCase();
    if (mime.includes('mp4') || mime.includes('mpeg4')) return 'mp4';
    if (mime.includes('ogg')) return 'ogg';
    if (mime.includes('wav')) return 'wav';
    if (mime.includes('webm')) return 'webm';
    return 'webm';
}

export function overlayExtensionToMimeType(ext) {
    const extension = (ext || '').toLowerCase();
    const mimeTypes = {
        webm: 'audio/webm',
        ogg: 'audio/ogg',
        wav: 'audio/wav',
        mp4: 'audio/mp4',
        m4a: 'audio/mp4',
    };
    return mimeTypes[extension] || 'audio/webm';
}

export function trackOverlayAssetBlobUrl(url) {
    if (url?.startsWith('blob:')) overlayAssetBlobUrls.add(url);
    return url;
}

export function revokeOverlayAssetBlobUrls() {
    overlayAssetBlobUrls.forEach((url) => URL.revokeObjectURL(url));
    overlayAssetBlobUrls.clear();
}

export async function resolveOverlayImageAssetUrl(relativePath) {
    if (!relativePath || state.isIOS || state.isAndroid) return null;
    try {
        const fullPath = await tauriAPI.resolveOverlayAssetPath(relativePath);
        const ext = relativePath.split('.').pop()?.toLowerCase() || 'png';
        const mimeTypes = {
            png: 'image/png',
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            gif: 'image/gif',
            webp: 'image/webp',
        };
        const bytes = await tauriAPI.readOverlaySourceBytes(fullPath);
        return trackOverlayAssetBlobUrl(URL.createObjectURL(new Blob(
            [new Uint8Array(bytes)],
            { type: mimeTypes[ext] || 'image/png' },
        )));
    } catch (err) {
        console.warn('[schedule-overlay] image asset resolve failed:', err);
        return null;
    }
}

export async function resolveOverlayAudioAssetUrl(relativePath) {
    if (!relativePath || state.isIOS || state.isAndroid) return null;
    try {
        const fullPath = await tauriAPI.resolveOverlayAssetPath(relativePath);
        const ext = relativePath.split('.').pop()?.toLowerCase() || 'webm';
        const bytes = await tauriAPI.readOverlaySourceBytes(fullPath);
        return trackOverlayAssetBlobUrl(URL.createObjectURL(new Blob(
            [new Uint8Array(bytes)],
            { type: overlayExtensionToMimeType(ext) },
        )));
    } catch (err) {
        console.warn('[schedule-overlay] audio asset resolve failed:', err);
        return null;
    }
}

export async function resolveOverlayAssetUrl(relativePath) {
    if (!relativePath || state.isIOS || state.isAndroid) return null;
    if (/\.(png|jpe?g|gif|webp)$/i.test(relativePath)) {
        return resolveOverlayImageAssetUrl(relativePath);
    }
    if (/\.(webm|ogg|wav|mp4|m4a)$/i.test(relativePath)) {
        return resolveOverlayAudioAssetUrl(relativePath);
    }
    try {
        const fullPath = await tauriAPI.resolveOverlayAssetPath(relativePath);
        return convertFileSrc(fullPath);
    } catch (err) {
        console.warn('[schedule-overlay] asset resolve failed:', err);
        return null;
    }
}

export async function applyOverlayMediaToElements({
    overlay,
    blocklistEmoji,
    emojiWrapEl,
    emojiEl,
    imageEl,
}) {
    if (!emojiWrapEl || !emojiEl || !imageEl) return;

    const useImage = !!(overlay?.custom && overlay.imageAsset);
    if (useImage) {
        const url = await resolveOverlayAssetUrl(overlay.imageAsset);
        if (url) {
            imageEl.src = url;
            imageEl.classList.remove('hidden');
            emojiWrapEl.classList.add('hidden');
            return;
        }
    }

    imageEl.removeAttribute('src');
    imageEl.classList.add('hidden');
    emojiWrapEl.classList.remove('hidden');
    if (emojiEl) emojiEl.textContent = blocklistEmoji || '🎯';
}

export function buildDefaultWarningSummaryHtml(names, blocklistName, letsGoLabel) {
    const apps = joinAppListWithLimit(names, 3);
    const bl = escapeHtml(blocklistName);
    const letsGo = escapeHtml(letsGoLabel || tSettings('appBlockingLetsGo'));
    const summaryKey = names.length === 1
        ? 'appBlockingWarningSummarySingleHtml'
        : 'appBlockingWarningSummaryMultiHtml';
    return tSettingsFmt(summaryKey, { blocklist: bl, letsGo, apps });
}

export function getScheduleOverlayAppsPreviewList(blocklist) {
    const apps = getBlocklistDisplayApps(blocklist);
    return joinAppListWithLimit(apps, 3, { bold: false });
}

export function syncScheduleOverlayMessageFieldHints(blocklist) {
    const noteEl = document.getElementById('schedule-overlay-no-apps-note');
    const apps = getBlocklistDisplayApps(blocklist);
    const appsPreview = getScheduleOverlayAppsPreviewList(blocklist);
    const placeholder = apps.length === 0
        ? tSettings('scheduleOverlayMessagePlaceholderNoApps')
        : tSettingsFmt('scheduleOverlayMessagePlaceholderFmt', { apps: appsPreview });

    if (noteEl) {
        noteEl.textContent = apps.length === 0
            ? tSettings('scheduleOverlayNoBlockedAppsHint')
            : '';
        noteEl.classList.toggle('hidden', apps.length > 0);
    }

    setScheduleOverlayMessageEditorPlaceholder(placeholder);
}

export function syncScheduleOverlayLetsGoCounter() {
    const input = document.getElementById('schedule-overlay-lets-go-input');
    const counter = document.getElementById('schedule-overlay-lets-go-count');
    if (!input || !counter) return;
    const max = Number(input.maxLength) || 24;
    const length = input.value.length;
    counter.textContent = tSettingsFmt('scheduleOverlayCharCountFmt', { count: length, max });
}

export function normalizeScheduleOverlayMessageForCompare(message) {
    const normalized = normalizeStoredOverlayMessage(message);
    return isOverlayMessageEmpty(normalized) ? null : normalized;
}

export function normalizeScheduleOverlayLetsGoForCompare(letsGoLabel) {
    const defaultLabel = tSettings('appBlockingLetsGo');
    const value = letsGoLabel?.trim() || '';
    if (!value || value === defaultLabel) return null;
    return value;
}

export function scheduleOverlayDraftFieldForCompare(draft, field) {
    if (!draft) return null;
    switch (field) {
        case 'heading':
            return draft.heading?.trim() || null;
        case 'message':
            return normalizeScheduleOverlayMessageForCompare(draft.message);
        case 'letsGoLabel':
            return normalizeScheduleOverlayLetsGoForCompare(draft.letsGoLabel);
        case 'imageAsset':
            return draft.imageAsset || null;
        case 'voiceAsset':
            return draft.voiceAsset || null;
        default:
            return null;
    }
}

export function isScheduleOverlayDraftFieldUnsaved(field, currentDraft, baselineDraft) {
    return scheduleOverlayDraftFieldForCompare(currentDraft, field)
        !== scheduleOverlayDraftFieldForCompare(baselineDraft, field);
}

export function readScheduleOverlayCustomiseFormState() {
    return {
        name: document.getElementById('schedule-overlay-name-input')?.value?.trim() || '',
        draft: readScheduleOverlayCustomiseDraftFromForm(),
    };
}

export function captureScheduleOverlayCustomiseBaseline() {
    scheduleOverlayCustomiseBaseline = {
        selectionValue: state.scheduleOverlayCustomiseSelection,
        ...readScheduleOverlayCustomiseFormState(),
    };
}

export function hasUnsavedScheduleOverlayCustomiseChanges() {
    if (state.scheduleOverlayCustomiseSelection === SCHEDULE_OVERLAY_DEFAULT_PRESET_VALUE) return false;
    if (!scheduleOverlayCustomiseBaseline) return false;

    const current = readScheduleOverlayCustomiseFormState();
    if (current.name !== scheduleOverlayCustomiseBaseline.name) return true;

    const fields = ['heading', 'message', 'letsGoLabel', 'imageAsset', 'voiceAsset'];
    return fields.some((field) => isScheduleOverlayDraftFieldUnsaved(
        field,
        current.draft,
        scheduleOverlayCustomiseBaseline.draft,
    ));
}

export function setScheduleOverlaySectionUnsavedBadge(badgeEl, isUnsaved) {
    if (!badgeEl) return;
    badgeEl.textContent = tSettings('scheduleOverlayUnsavedBadge');
    badgeEl.classList.toggle('hidden', !isUnsaved);
}

export function syncScheduleOverlaySectionBadges() {
    if (state.scheduleOverlayCustomiseSelection === SCHEDULE_OVERLAY_DEFAULT_PRESET_VALUE) {
        [
            'schedule-overlay-heading-badge',
            'schedule-overlay-message-badge',
            'schedule-overlay-button-badge',
            'schedule-overlay-image-badge',
            'schedule-overlay-voice-badge',
        ].forEach((id) => document.getElementById(id)?.classList.add('hidden'));
        return;
    }

    const current = readScheduleOverlayCustomiseFormState();
    const baselineDraft = scheduleOverlayCustomiseBaseline?.draft || getDefaultScheduleStartOverlay();
    const defaultLetsGo = tSettings('appBlockingLetsGo');
    const letsGoValue = document.getElementById('schedule-overlay-lets-go-input')?.value?.trim() || '';
    const headingValue = document.getElementById('schedule-overlay-heading-input')?.value?.trim() || '';
    const messageCustom = !isOverlayMessageEmpty(getScheduleOverlayMessageEditorHtml());
    const headingCustom = !!headingValue;
    const buttonCustom = !!(letsGoValue && letsGoValue !== defaultLetsGo);
    const imageCustom = !!current.draft.imageAsset;
    const voiceCustom = !!current.draft.voiceAsset;

    setScheduleOverlaySectionUnsavedBadge(
        document.getElementById('schedule-overlay-heading-badge'),
        isScheduleOverlayDraftFieldUnsaved('heading', current.draft, baselineDraft),
    );
    document.getElementById('schedule-overlay-reset-heading-btn')
        ?.classList.toggle('hidden', !headingCustom);

    setScheduleOverlaySectionUnsavedBadge(
        document.getElementById('schedule-overlay-message-badge'),
        isScheduleOverlayDraftFieldUnsaved('message', current.draft, baselineDraft),
    );
    document.getElementById('schedule-overlay-reset-message-btn')
        ?.classList.toggle('hidden', !messageCustom);

    setScheduleOverlaySectionUnsavedBadge(
        document.getElementById('schedule-overlay-button-badge'),
        isScheduleOverlayDraftFieldUnsaved('letsGoLabel', current.draft, baselineDraft),
    );
    document.getElementById('schedule-overlay-reset-button-btn')
        ?.classList.toggle('hidden', !buttonCustom);

    setScheduleOverlaySectionUnsavedBadge(
        document.getElementById('schedule-overlay-image-badge'),
        isScheduleOverlayDraftFieldUnsaved('imageAsset', current.draft, baselineDraft),
    );
    document.getElementById('schedule-overlay-reset-image-btn')
        ?.classList.toggle('hidden', !imageCustom);

    setScheduleOverlaySectionUnsavedBadge(
        document.getElementById('schedule-overlay-voice-badge'),
        isScheduleOverlayDraftFieldUnsaved('voiceAsset', current.draft, baselineDraft),
    );
    document.getElementById('schedule-overlay-reset-voice-btn')
        ?.classList.toggle('hidden', !voiceCustom);
}

export function syncScheduleOverlayCustomiseDirtyState() {
    const unsavedBadge = document.getElementById('schedule-overlay-select-unsaved-badge');
    if (unsavedBadge) {
        unsavedBadge.textContent = tSettings('scheduleOverlayUnsavedBadge');
        unsavedBadge.classList.toggle('hidden', !hasUnsavedScheduleOverlayCustomiseChanges());
    }
    syncScheduleOverlaySectionBadges();
}

export function syncScheduleOverlayImageDropzone(normalized, blocklistEmoji) {
    const statusEl = document.getElementById('schedule-overlay-image-status');
    const defaultIconEl = document.getElementById('schedule-overlay-image-default-icon');
    const imagePreview = document.getElementById('schedule-overlay-image-preview');
    if (defaultIconEl) defaultIconEl.textContent = blocklistEmoji || '📚';
    if (!statusEl || !imagePreview) return;

    if (normalized.imageAsset && !imagePreview.classList.contains('hidden') && imagePreview.src) {
        statusEl.textContent = tSettings('scheduleOverlayImageCustomStatus');
        defaultIconEl?.classList.add('hidden');
    } else {
        statusEl.textContent = tSettings('scheduleOverlayImageDefaultStatus');
        imagePreview.classList.add('hidden');
        imagePreview.removeAttribute('src');
        defaultIconEl?.classList.remove('hidden');
    }
}

export function formatScheduleOverlayCustomMessageHtml(message, appNames, letsGoLabel) {
    const appsPreview = escapeHtmlForOverlay(joinAppListWithLimit(appNames, 3, { bold: false }));
    const letsGo = escapeHtmlForOverlay(letsGoLabel || tSettings('appBlockingLetsGo'));
    const normalized = normalizeStoredOverlayMessage(message) || '';
    const html = normalized
        .replace(/\{apps\}/gi, appsPreview)
        .replace(/\{letsGo\}/gi, letsGo);
    return sanitizeOverlayMessageHtml(html);
}

export function formatScheduleOverlayHeadingHtml(heading, blocklistName) {
    const nameHtml = `<strong>${escapeHtmlForOverlay(blocklistName)}</strong>`;
    const normalized = (heading || '').trim();
    if (!normalized) {
        return tSettingsFmt('appBlockingWarningHeadingHtml', {
            name: escapeHtmlForOverlay(blocklistName),
        });
    }
    const html = normalized.replace(/\{name\}/gi, nameHtml);
    return sanitizeOverlayMessageHtml(html);
}

export async function applyScheduleStartOverlayPresentation({
    overlay,
    blocklistName,
    blocklistEmoji,
    appNames,
    headingEl,
    summaryEl,
    emojiWrapEl,
    emojiEl,
    imageEl,
    letsGoLabelEl,
    letsGoVoiceIconEl,
}) {
    const defaultLetsGo = tSettings('appBlockingLetsGo');
    const useCustom = !!(overlay?.custom && scheduleStartOverlayHasCustomContent(overlay));
    const letsGoText = useCustom && overlay.letsGoLabel ? overlay.letsGoLabel : defaultLetsGo;

    if (headingEl) {
        if (useCustom && overlay.heading) {
            headingEl.innerHTML = formatScheduleOverlayHeadingHtml(overlay.heading, blocklistName);
        } else {
            headingEl.innerHTML = tSettingsFmt('appBlockingWarningHeadingHtml', {
                name: escapeHtml(blocklistName),
            });
        }
    }

    if (summaryEl) {
        if (useCustom && overlay.message) {
            summaryEl.innerHTML = formatScheduleOverlayCustomMessageHtml(
                overlay.message,
                appNames,
                letsGoText,
            );
        } else {
            summaryEl.innerHTML = buildDefaultWarningSummaryHtml(appNames, blocklistName, letsGoText);
        }
    }

    await applyOverlayMediaToElements({
        overlay: useCustom ? overlay : null,
        blocklistEmoji,
        emojiWrapEl,
        emojiEl,
        imageEl,
    });

    if (letsGoLabelEl) letsGoLabelEl.textContent = letsGoText;
    if (letsGoVoiceIconEl) {
        letsGoVoiceIconEl.classList.toggle('hidden', !(useCustom && overlay.voiceAsset));
    }

    return useCustom ? overlay : null;
}

export async function playAppBlockingLetsGoVoice() {
    if (!state.appBlockingActiveStartOverlay?.voiceAsset || state.isIOS || state.isAndroid) return;
    try {
        const url = await resolveOverlayAssetUrl(state.appBlockingActiveStartOverlay.voiceAsset);
        if (!url) return;
        if (!appBlockingLetsGoVoiceAudio) {
            appBlockingLetsGoVoiceAudio = new Audio();
        }
        appBlockingLetsGoVoiceAudio.pause();
        appBlockingLetsGoVoiceAudio.src = url;
        await appBlockingLetsGoVoiceAudio.play();
    } catch (err) {
        console.warn('[schedule-overlay] voice playback failed:', err);
    }
}

export function getActiveScheduleForSelectedBlocklist() {
    if (!state.selectedBlocklistId || !state.appData.schedules) return null;
    return state.appData.schedules.find((s) => s.blocklistId === state.selectedBlocklistId) || null;
}

export function getEffectiveScheduleStartOverlayId() {
    const activeSchedule = getActiveScheduleForSelectedBlocklist();
    if (activeSchedule) return activeSchedule.startOverlayId || null;
    return getLastScheduleStartOverlayId();
}

export function setEffectiveScheduleStartOverlayId(overlayId) {
    const normalized = overlayId || null;
    const activeSchedule = getActiveScheduleForSelectedBlocklist();
    if (activeSchedule) {
        activeSchedule.startOverlayId = normalized;
    } else {
        rememberLastScheduleStartOverlayId(normalized);
    }
    state.pendingScheduleStartOverlayId = normalized;
    void saveData();
    syncAllStartOverlaySelectors();
}

export function getSchedulePanelOverlayLabel(selectedId) {
    if (!selectedId) return tSettings('scheduleConfirmOverlayDefaultTitle');
    const preset = getNamedStartOverlayById(selectedId);
    return preset?.name || tSettings('scheduleConfirmOverlayDefaultTitle');
}

export function renderSchedulePanelOverlayDropdown(selectedId) {
    const btnText = document.getElementById('schedule-panel-overlay-dropdown-text');
    const menu = document.getElementById('schedule-panel-overlay-dropdown-menu');
    const btn = document.getElementById('schedule-panel-overlay-dropdown-btn');
    if (!btnText || !menu || !btn) return;

    const presets = getGlobalStartOverlays();
    const hasPresets = presets.length > 0;

    btnText.textContent = getSchedulePanelOverlayLabel(selectedId);
    menu.innerHTML = '';
    menu.classList.add('hidden');

    if (!hasPresets) {
        btn.disabled = true;
        btn.classList.add('repeat-dropdown-disabled');
        return;
    }

    btn.disabled = false;
    btn.classList.remove('repeat-dropdown-disabled');
    btn.style.pointerEvents = 'auto';
    btn.style.cursor = 'pointer';

    const defaultOption = document.createElement('button');
    defaultOption.type = 'button';
    defaultOption.className = `repeat-option${selectedId ? '' : ' active'}`;
    defaultOption.dataset.value = '';
    defaultOption.textContent = tSettings('scheduleConfirmOverlayDefaultTitle');
    menu.appendChild(defaultOption);

    presets.forEach((preset) => {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = `repeat-option${preset.id === selectedId ? ' active' : ''}`;
        option.dataset.value = preset.id;
        option.textContent = preset.name;
        menu.appendChild(option);
    });
}

export function toggleSchedulePanelOverlayDropdown(e) {
    e.stopPropagation();

    const btn = document.getElementById('schedule-panel-overlay-dropdown-btn');
    if (!btn || btn.disabled || btn.classList.contains('repeat-dropdown-disabled')) return;

    const menu = document.getElementById('schedule-panel-overlay-dropdown-menu');
    if (!menu) return;

    const isHidden = menu.classList.contains('hidden');
    if (isHidden) closeSchedulePanelDropdownMenus('schedule-panel-overlay-dropdown-menu');
    menu.classList.toggle('hidden');

    if (isHidden) {
        setTimeout(() => {
            document.addEventListener('click', function closeMenu(evt) {
                if (!menu.contains(evt.target) && evt.target !== btn) {
                    menu.classList.add('hidden');
                    document.removeEventListener('click', closeMenu);
                }
            });
        }, 10);
    }
}

export function handleSchedulePanelOverlayOptionClick(e) {
    const option = e.target.closest('.repeat-option');
    if (!option || !option.dataset) return;

    e.stopPropagation();

    const btn = document.getElementById('schedule-panel-overlay-dropdown-btn');
    if (btn?.disabled || btn?.classList.contains('repeat-dropdown-disabled')) {
        document.getElementById('schedule-panel-overlay-dropdown-menu')?.classList.add('hidden');
        return;
    }

    const value = option.dataset.value || null;
    document.getElementById('schedule-panel-overlay-dropdown-menu')?.classList.add('hidden');

    // Rebuild the menu after this click finishes — clearing it synchronously
    // detaches the target and breaks `.closest('.scheduler-section')` guards.
    requestAnimationFrame(() => {
        setEffectiveScheduleStartOverlayId(value);
        syncScheduleConfirmOverlaySummary();
    });
}

export function populateStartOverlaySelectOptions(select, selectedId) {
    if (!select) return;
    select.innerHTML = '';
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = tSettings('scheduleConfirmOverlayDefaultTitle');
    select.appendChild(defaultOption);

    getGlobalStartOverlays().forEach((preset) => {
        const option = document.createElement('option');
        option.value = preset.id;
        option.textContent = preset.name;
        select.appendChild(option);
    });

    select.value = selectedId || '';
}

export function syncAllStartOverlaySelectors() {
    const selectedId = getEffectiveScheduleStartOverlayId();
    const hasPresets = getGlobalStartOverlays().length > 0;
    const defaultTitle = tSettings('scheduleConfirmOverlayDefaultTitle');

    const confirmTitle = document.getElementById('schedule-confirm-overlay-value');
    const confirmSelect = document.getElementById('schedule-confirm-overlay-select');

    renderSchedulePanelOverlayDropdown(selectedId);
    confirmTitle?.classList.toggle('hidden', hasPresets);
    confirmSelect?.classList.toggle('hidden', !hasPresets);

    if (hasPresets) {
        populateStartOverlaySelectOptions(confirmSelect, selectedId);
    } else if (confirmTitle) {
        confirmTitle.textContent = defaultTitle;
    }

    state.pendingScheduleStartOverlayId = selectedId;

    const activeSchedule = getActiveScheduleForSelectedBlocklist();
    // Don't re-lock when between-blocks editing is allowed — updateScheduleButtonState
    // already applied the correct lock state before calling into overlay sync.
    const shouldLock = !!activeSchedule && !canEditScheduleBetweenBlocks(activeSchedule);
    disableScheduleControls(shouldLock);
}

export function syncSchedulePanelOverlayControls() {
    const section = document.getElementById('schedule-panel-overlay-section');
    if (!section) return;

    if (isMobileOverrideChallengePlatform()) {
        section.classList.add('hidden');
        return;
    }

    section.classList.remove('hidden');
    syncAllStartOverlaySelectors();
}

export function syncScheduleConfirmOverlaySummary() {
    const descEl = document.getElementById('schedule-confirm-overlay-desc');
    syncAllStartOverlaySelectors();

    const isCustom = !!getEffectiveScheduleStartOverlayId();
    if (descEl) {
        descEl.textContent = isCustom
            ? tSettings('scheduleConfirmOverlayCustomDesc')
            : tSettings('scheduleConfirmOverlayDefaultDesc');
    }
}

export async function renderScheduleOverlayCustomisePreview(blocklist, draft) {
    const names = getBlocklistDisplayApps(blocklist);
    const previewNames = names.length > 0 ? names : [tSettings('appBlockingUnknownApp')];
    const normalized = normalizeScheduleStartOverlay(draft);

    await applyScheduleStartOverlayPresentation({
        overlay: normalized,
        blocklistName: blocklist.name,
        blocklistEmoji: blocklist.emoji || '🎯',
        appNames: previewNames,
        headingEl: document.getElementById('schedule-overlay-preview-heading'),
        summaryEl: document.getElementById('schedule-overlay-preview-summary'),
        emojiWrapEl: document.getElementById('schedule-overlay-preview-emoji-wrap'),
        emojiEl: document.getElementById('schedule-overlay-preview-emoji'),
        imageEl: document.getElementById('schedule-overlay-preview-image'),
        letsGoLabelEl: document.getElementById('schedule-overlay-preview-lets-go-label'),
        letsGoVoiceIconEl: document.getElementById('schedule-overlay-preview-voice-icon'),
    });

    const imagePreview = document.getElementById('schedule-overlay-image-preview');
    if (imagePreview) {
        if (normalized.imageAsset) {
            const url = await resolveOverlayAssetUrl(normalized.imageAsset);
            if (url) {
                imagePreview.src = url;
                imagePreview.classList.remove('hidden');
            } else {
                imagePreview.classList.add('hidden');
                imagePreview.removeAttribute('src');
            }
        } else {
            imagePreview.removeAttribute('src');
            imagePreview.classList.add('hidden');
        }
    }
    syncScheduleOverlayImageDropzone(normalized, blocklist.emoji || '📚');

    const voicePreview = document.getElementById('schedule-overlay-voice-preview');
    if (voicePreview) {
        if (normalized.voiceAsset) {
            const url = await resolveOverlayAssetUrl(normalized.voiceAsset);
            if (url) {
                voicePreview.src = url;
                voicePreview.load();
                voicePreview.classList.remove('hidden');
            } else {
                voicePreview.classList.add('hidden');
                voicePreview.removeAttribute('src');
            }
        } else {
            voicePreview.removeAttribute('src');
            voicePreview.classList.add('hidden');
        }
    }

    syncScheduleOverlayCustomiseDirtyState();
    syncScheduleOverlayLetsGoCounter();
}

export function readScheduleOverlayCustomiseDraftFromForm() {
    const heading = document.getElementById('schedule-overlay-heading-input')?.value?.trim() || null;
    const message = getScheduleOverlayMessageEditorHtml();
    const letsGoLabel = document.getElementById('schedule-overlay-lets-go-input')?.value?.trim() || null;
    const draft = cloneScheduleStartOverlay(scheduleOverlayCustomiseDraft);
    draft.heading = heading;
    draft.message = message;
    draft.letsGoLabel = letsGoLabel;
    return normalizeScheduleStartOverlay(draft);
}

export async function refreshScheduleOverlayCustomisePreview() {
    if (!scheduleOverlayCustomiseBlocklist) return;
    scheduleOverlayCustomiseDraft = readScheduleOverlayCustomiseDraftFromForm();
    await renderScheduleOverlayCustomisePreview(
        scheduleOverlayCustomiseBlocklist,
        scheduleOverlayCustomiseDraft,
    );
}

export async function removeScheduleOverlayAsset(relativePath) {
    if (!relativePath || state.isIOS || state.isAndroid) return;
    try {
        await tauriAPI.deleteOverlayAsset(relativePath);
    } catch (err) {
        console.warn('[schedule-overlay] delete asset failed:', err);
    }
}

export async function acquireScheduleOverlayMicStream() {
    // Default constraints on purpose: disabling autoGainControl leaves the
    // raw hardware input gain, which records far too quietly on many Macs.
    // The output-muting capture teardown is handled by holding the stream
    // until the modal closes — see finishScheduleOverlayRecorderKeepMic().
    return navigator.mediaDevices.getUserMedia({ audio: true });
}

export function setScheduleOverlayRecordingUi(state) {
    const isStarting = state === 'starting';
    const isRecording = state === 'recording';
    const isActive = isStarting || isRecording;

    document.getElementById('schedule-overlay-record-voice-btn')?.classList.toggle('hidden', isActive);
    document.getElementById('schedule-overlay-stop-record-voice-btn')?.classList.toggle('hidden', !isActive);
    document.getElementById('schedule-overlay-choose-voice-btn')?.toggleAttribute('disabled', isActive);
    document.getElementById('schedule-overlay-voice-card')?.classList.toggle('is-starting', isStarting);
    document.getElementById('schedule-overlay-voice-card')?.classList.toggle('is-recording', isRecording);

    const stopLabel = document.getElementById('schedule-overlay-stop-record-voice-btn-label');
    if (stopLabel) {
        stopLabel.textContent = isStarting
            ? tSettings('scheduleOverlayStartingRecording')
            : tSettings('scheduleOverlayStopRecording');
    }

    const meter = document.getElementById('schedule-overlay-record-level');
    if (isActive) {
        meter?.classList.remove('hidden');
    } else {
        meter?.classList.add('hidden');
        meter?.setAttribute('aria-valuenow', '0');
        meter?.querySelectorAll('.schedule-overlay-record-level-bar').forEach((bar) => {
            bar.classList.remove('is-active');
        });
    }
}

export function teardownScheduleOverlayRecordLevelAnalyser() {
    if (scheduleOverlayRecordLevelRaf != null) {
        cancelAnimationFrame(scheduleOverlayRecordLevelRaf);
        scheduleOverlayRecordLevelRaf = null;
    }
    if (scheduleOverlayRecordAudioContext) {
        const ctx = scheduleOverlayRecordAudioContext;
        scheduleOverlayRecordAudioContext = null;
        scheduleOverlayRecordAnalyser = null;
        void ctx.close().catch(() => {});
    }
    if (scheduleOverlayRecordMeterStream) {
        scheduleOverlayRecordMeterStream.getTracks().forEach((track) => track.stop());
        scheduleOverlayRecordMeterStream = null;
    }
}

export function stopScheduleOverlayRecordLevelMeter() {
    teardownScheduleOverlayRecordLevelAnalyser();
    setScheduleOverlayRecordingUi('idle');
}

export async function startScheduleOverlayRecordLevelMeter(stream) {
    teardownScheduleOverlayRecordLevelAnalyser();
    const meter = document.getElementById('schedule-overlay-record-level');
    if (!meter || !stream) return;

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    try {
        scheduleOverlayRecordAudioContext = new AudioCtx();
        if (scheduleOverlayRecordAudioContext.state === 'suspended') {
            await scheduleOverlayRecordAudioContext.resume();
        }
        // Analyse a clone so the WebAudio tap can't glitch the MediaRecorder's
        // capture path (WKWebView misbehaves when both consume the same stream).
        scheduleOverlayRecordMeterStream = stream.clone();
        const source = scheduleOverlayRecordAudioContext.createMediaStreamSource(scheduleOverlayRecordMeterStream);
        scheduleOverlayRecordAnalyser = scheduleOverlayRecordAudioContext.createAnalyser();
        scheduleOverlayRecordAnalyser.fftSize = 256;
        scheduleOverlayRecordAnalyser.smoothingTimeConstant = 0.8;
        source.connect(scheduleOverlayRecordAnalyser);

        const bars = meter.querySelectorAll('.schedule-overlay-record-level-bar');
        const samples = new Uint8Array(scheduleOverlayRecordAnalyser.fftSize);

        const tick = () => {
            if (!scheduleOverlayRecordAnalyser) return;
            scheduleOverlayRecordAnalyser.getByteTimeDomainData(samples);
            let sumSquares = 0;
            let peak = 0;
            for (let i = 0; i < samples.length; i += 1) {
                const sample = (samples[i] - 128) / 128;
                sumSquares += sample * sample;
                peak = Math.max(peak, Math.abs(sample));
            }
            const rms = Math.sqrt(sumSquares / samples.length);
            const level = Math.min(1, Math.max(0, (rms * 3.2 + peak * 0.55) - 0.03));
            const activeCount = Math.round(level * bars.length);
            bars.forEach((bar, index) => {
                bar.classList.toggle('is-active', index < activeCount);
            });
            meter.setAttribute('aria-valuenow', String(Math.round(level * 100)));
            scheduleOverlayRecordLevelRaf = requestAnimationFrame(tick);
        };
        scheduleOverlayRecordLevelRaf = requestAnimationFrame(tick);
    } catch (err) {
        console.warn('[schedule-overlay] level meter failed:', err);
        teardownScheduleOverlayRecordLevelAnalyser();
    }
}

/// Retire the recorder but deliberately KEEP the mic stream open. WebKit
/// tears down its shared capture unit on a delayed schedule after the last
/// track stops, and on macOS that teardown reconfigures the *output* device —
/// audibly muting the first preview playback for a couple of seconds. Holding
/// the stream until the customise modal closes moves that teardown to a
/// moment when nothing is playing.
function finishScheduleOverlayRecorderKeepMic() {
    stopScheduleOverlayRecordLevelMeter();
    if (scheduleOverlayMediaRecorder && scheduleOverlayMediaRecorder.state !== 'inactive') {
        scheduleOverlayMediaRecorder.stop();
    }
    scheduleOverlayMediaRecorder = null;
}

export function stopScheduleOverlayRecording() {
    stopScheduleOverlayRecordLevelMeter();
    if (scheduleOverlayMediaRecorder && scheduleOverlayMediaRecorder.state !== 'inactive') {
        scheduleOverlayMediaRecorder.stop();
    }
    if (scheduleOverlayRecordStream) {
        scheduleOverlayRecordStream.getTracks().forEach((track) => track.stop());
        scheduleOverlayRecordStream = null;
    }
    scheduleOverlayMediaRecorder = null;
}

export function syncScheduleOverlayCustomiseTitle(selectionValue = state.scheduleOverlayCustomiseSelection) {
    const titleEl = document.getElementById('schedule-overlay-customise-title');
    if (!titleEl) return;

    if (selectionValue === SCHEDULE_OVERLAY_DEFAULT_PRESET_VALUE) {
        titleEl.textContent = tSettings('scheduleOverlayCustomiseDefaultTitle');
        return;
    }

    const name = document.getElementById('schedule-overlay-name-input')?.value?.trim() || '';
    titleEl.textContent = name
        ? tSettingsFmt('scheduleOverlayCustomiseTitleFmt', { name })
        : tSettings('scheduleOverlayCustomiseTitleDefault');
}

export function syncScheduleOverlayCustomiseEditorState(selectionValue) {
    const isDefault = selectionValue === SCHEDULE_OVERLAY_DEFAULT_PRESET_VALUE;
    const settings = document.querySelector('.schedule-overlay-customise-settings');
    settings?.classList.toggle('schedule-overlay-customise-settings--readonly', isDefault);

    const noticeEl = document.getElementById('schedule-overlay-default-notice');
    if (noticeEl) {
        noticeEl.textContent = tSettings('scheduleOverlayDefaultNotice');
        noticeEl.classList.toggle('hidden', !isDefault);
    }

    const saveBtn = document.getElementById('schedule-overlay-customise-save-btn');
    if (saveBtn) saveBtn.classList.toggle('hidden', isDefault);

    const canDelete = !!scheduleOverlayCustomisePresetId
        && selectionValue !== SCHEDULE_OVERLAY_DEFAULT_PRESET_VALUE
        && selectionValue !== SCHEDULE_OVERLAY_NEW_PRESET_VALUE;
    document.getElementById('schedule-overlay-delete-btn')?.classList.toggle('hidden', !canDelete);

    setScheduleOverlayMessageEditorEnabled(!isDefault);

    const editableFields = document.getElementById('schedule-overlay-editable-fields');
    editableFields?.querySelectorAll('input, button, select, textarea').forEach((el) => {
        el.disabled = isDefault;
    });
}

export function populateScheduleOverlayCustomiseSelector(selectionValue) {
    const select = document.getElementById('schedule-overlay-select');
    if (!select) return;

    select.innerHTML = '';

    const defaultOption = document.createElement('option');
    defaultOption.value = SCHEDULE_OVERLAY_DEFAULT_PRESET_VALUE;
    defaultOption.textContent = tSettings('scheduleConfirmOverlayDefaultTitle');
    select.appendChild(defaultOption);

    getGlobalStartOverlays().forEach((preset) => {
        const option = document.createElement('option');
        option.value = preset.id;
        option.textContent = preset.name;
        select.appendChild(option);
    });

    if (selectionValue === SCHEDULE_OVERLAY_NEW_PRESET_VALUE) {
        const newOption = document.createElement('option');
        newOption.value = SCHEDULE_OVERLAY_NEW_PRESET_VALUE;
        const name = document.getElementById('schedule-overlay-name-input')?.value?.trim();
        newOption.textContent = name || tSettings('scheduleOverlaySelectNew');
        select.appendChild(newOption);
    }

    if (selectionValue === SCHEDULE_OVERLAY_DEFAULT_PRESET_VALUE) {
        select.value = SCHEDULE_OVERLAY_DEFAULT_PRESET_VALUE;
    } else if (selectionValue === SCHEDULE_OVERLAY_NEW_PRESET_VALUE) {
        select.value = SCHEDULE_OVERLAY_NEW_PRESET_VALUE;
    } else if (getNamedStartOverlayById(selectionValue)) {
        select.value = selectionValue;
    } else {
        select.value = SCHEDULE_OVERLAY_DEFAULT_PRESET_VALUE;
    }
}

export async function loadScheduleOverlayCustomiseSelection(selectionValue) {
    const blocklist = scheduleOverlayCustomiseBlocklist;
    if (!blocklist) return;

    state.scheduleOverlayCustomiseSelection = selectionValue;
    const isDefault = selectionValue === SCHEDULE_OVERLAY_DEFAULT_PRESET_VALUE;
    const isNew = selectionValue === SCHEDULE_OVERLAY_NEW_PRESET_VALUE;
    const existingPreset = (!isDefault && !isNew) ? getNamedStartOverlayById(selectionValue) : null;

    scheduleOverlayCustomisePresetId = existingPreset ? selectionValue : null;
    scheduleOverlayCustomiseDraft = cloneScheduleStartOverlay(
        existingPreset ? namedPresetToDraft(existingPreset) : getDefaultScheduleStartOverlay(),
    );

    syncScheduleOverlayCustomiseEditorState(selectionValue);

    const nameInput = document.getElementById('schedule-overlay-name-input');
    const headingInput = document.getElementById('schedule-overlay-heading-input');
    const letsGoInput = document.getElementById('schedule-overlay-lets-go-input');

    if (isDefault) {
        if (nameInput) nameInput.value = tSettings('scheduleConfirmOverlayDefaultTitle');
        if (headingInput) headingInput.value = '';
        setScheduleOverlayMessageEditorHtml('', { silent: true });
        if (letsGoInput) letsGoInput.value = tSettings('appBlockingLetsGo');
    } else if (isNew) {
        if (nameInput) nameInput.value = getUniqueNewScheduleStartOverlayName();
        if (headingInput) headingInput.value = '';
        setScheduleOverlayMessageEditorHtml('', { silent: true });
        if (letsGoInput) letsGoInput.value = tSettings('appBlockingLetsGo');
    } else {
        if (nameInput) nameInput.value = existingPreset?.name || '';
        if (headingInput) {
            headingInput.value = scheduleOverlayCustomiseDraft.heading || '';
        }
        setScheduleOverlayMessageEditorHtml(scheduleOverlayCustomiseDraft.message || '', { silent: true });
        if (letsGoInput) {
            letsGoInput.value = scheduleOverlayCustomiseDraft.letsGoLabel || tSettings('appBlockingLetsGo');
        }
    }

    populateScheduleOverlayCustomiseSelector(selectionValue);

    syncScheduleOverlayCustomiseTitle(selectionValue);
    syncScheduleOverlayMessageFieldHints(blocklist);
    captureScheduleOverlayCustomiseBaseline();
    syncScheduleOverlayLetsGoCounter();
    await renderScheduleOverlayCustomisePreview(blocklist, scheduleOverlayCustomiseDraft);
}

export async function handleDeleteScheduleOverlayCustomise() {
    const presetId = scheduleOverlayCustomisePresetId;
    if (!presetId
        || state.scheduleOverlayCustomiseSelection === SCHEDULE_OVERLAY_DEFAULT_PRESET_VALUE
        || state.scheduleOverlayCustomiseSelection === SCHEDULE_OVERLAY_NEW_PRESET_VALUE) {
        return;
    }

    const preset = getNamedStartOverlayById(presetId);
    if (!preset) return;

    const confirmed = await showScheduleOverlayDeleteConfirmModal(preset.name);
    if (!confirmed) return;

    await deleteGlobalStartOverlay(presetId);
    syncAllStartOverlaySelectors();
    syncScheduleConfirmOverlaySummary();
    closeScheduleOverlayCustomiseModal();
}

let scheduleOverlayDeleteConfirmResolver = null;
let scheduleOverlayDiscardConfirmResolver = null;

export function showScheduleOverlayDiscardConfirmModal() {
    const modal = document.getElementById('schedule-overlay-discard-modal');
    if (!modal) return Promise.resolve(false);

    const strongEl = document.getElementById('schedule-overlay-discard-warning-strong');
    const bodyEl = document.getElementById('schedule-overlay-discard-warning-body');
    if (strongEl) {
        strongEl.textContent = tSettings('scheduleOverlayDiscardConfirmStrong');
    }
    if (bodyEl) {
        bodyEl.textContent = tSettings('scheduleOverlayDiscardConfirmBody');
    }

    return new Promise((resolve) => {
        scheduleOverlayDiscardConfirmResolver = resolve;
        modal.classList.remove('hidden');
    });
}

export function closeScheduleOverlayDiscardConfirmModal(confirmed) {
    document.getElementById('schedule-overlay-discard-modal')?.classList.add('hidden');
    if (scheduleOverlayDiscardConfirmResolver) {
        scheduleOverlayDiscardConfirmResolver(!!confirmed);
        scheduleOverlayDiscardConfirmResolver = null;
    }
}

export async function requestCloseScheduleOverlayCustomiseModal() {
    if (!hasUnsavedScheduleOverlayCustomiseChanges()) {
        closeScheduleOverlayCustomiseModal();
        return;
    }
    const confirmed = await showScheduleOverlayDiscardConfirmModal();
    if (confirmed) closeScheduleOverlayCustomiseModal();
}

export async function requestLoadScheduleOverlayCustomiseSelection(selectionValue) {
    if (selectionValue === state.scheduleOverlayCustomiseSelection) return;
    if (hasUnsavedScheduleOverlayCustomiseChanges()) {
        const confirmed = await showScheduleOverlayDiscardConfirmModal();
        if (!confirmed) {
            populateScheduleOverlayCustomiseSelector(state.scheduleOverlayCustomiseSelection);
            return;
        }
    }
    await loadScheduleOverlayCustomiseSelection(selectionValue);
}

export function showScheduleOverlayDeleteConfirmModal(presetName) {
    const modal = document.getElementById('schedule-overlay-delete-modal');
    if (!modal) return Promise.resolve(false);

    const strongEl = document.getElementById('schedule-overlay-delete-warning-strong');
    const bodyEl = document.getElementById('schedule-overlay-delete-warning-body');
    if (strongEl) {
        strongEl.textContent = tSettingsFmt('scheduleOverlayDeleteConfirmStrongFmt', { name: presetName });
    }
    if (bodyEl) {
        bodyEl.textContent = tSettings('scheduleOverlayDeleteConfirmBody');
    }

    return new Promise((resolve) => {
        scheduleOverlayDeleteConfirmResolver = resolve;
        modal.classList.remove('hidden');
    });
}

export function closeScheduleOverlayDeleteConfirmModal(confirmed) {
    document.getElementById('schedule-overlay-delete-modal')?.classList.add('hidden');
    if (scheduleOverlayDeleteConfirmResolver) {
        scheduleOverlayDeleteConfirmResolver(!!confirmed);
        scheduleOverlayDeleteConfirmResolver = null;
    }
}

export async function openScheduleOverlayCustomiseModal(blocklist) {
    if (!blocklist || state.isIOS || state.isAndroid) return;
    scheduleOverlayCustomiseBlocklist = blocklist;

    const messageEditorEl = document.getElementById('schedule-overlay-message-editor');
    if (messageEditorEl) {
        await initScheduleOverlayMessageEditor(messageEditorEl, {
            onChange: () => {
                void refreshScheduleOverlayCustomisePreview();
            },
        });
    }

    let initialPresetId = getEffectiveScheduleStartOverlayId();
    if (initialPresetId && !getNamedStartOverlayById(initialPresetId)) {
        initialPresetId = null;
    }

    const subtitleEl = document.getElementById('schedule-overlay-customise-subtitle');
    if (subtitleEl) {
        subtitleEl.textContent = tSettings('scheduleOverlayCustomiseSubtitle');
    }

    await loadScheduleOverlayCustomiseSelection(
        initialPresetId || SCHEDULE_OVERLAY_DEFAULT_PRESET_VALUE,
    );
    document.getElementById('schedule-overlay-customise-modal')?.classList.remove('hidden');
}

export async function resetScheduleOverlayImageAsset() {
    const prev = scheduleOverlayCustomiseDraft?.imageAsset;
    if (prev) await removeScheduleOverlayAsset(prev);
    scheduleOverlayCustomiseDraft = readScheduleOverlayCustomiseDraftFromForm();
    scheduleOverlayCustomiseDraft.imageAsset = null;
    scheduleOverlayCustomiseDraft = normalizeScheduleStartOverlay(scheduleOverlayCustomiseDraft);
    if (scheduleOverlayCustomiseBlocklist) {
        await renderScheduleOverlayCustomisePreview(
            scheduleOverlayCustomiseBlocklist,
            scheduleOverlayCustomiseDraft,
        );
    }
}

export async function resetScheduleOverlayVoiceAsset() {
    const prev = scheduleOverlayCustomiseDraft?.voiceAsset;
    if (prev) await removeScheduleOverlayAsset(prev);
    scheduleOverlayCustomiseDraft = readScheduleOverlayCustomiseDraftFromForm();
    scheduleOverlayCustomiseDraft.voiceAsset = null;
    scheduleOverlayCustomiseDraft = normalizeScheduleStartOverlay(scheduleOverlayCustomiseDraft);
    if (scheduleOverlayCustomiseBlocklist) {
        await renderScheduleOverlayCustomisePreview(
            scheduleOverlayCustomiseBlocklist,
            scheduleOverlayCustomiseDraft,
        );
    }
}

export function closeScheduleOverlayCustomiseModal() {
    stopScheduleOverlayRecording();
    revokeOverlayAssetBlobUrls();
    document.getElementById('schedule-overlay-customise-modal')?.classList.add('hidden');
    document.getElementById('schedule-overlay-image-dropzone')?.classList.remove('is-dragover');
    scheduleOverlayCustomiseBlocklist = null;
    scheduleOverlayCustomiseDraft = null;
    scheduleOverlayCustomiseBaseline = null;
    scheduleOverlayCustomisePresetId = null;
    state.scheduleOverlayCustomiseSelection = null;
}

export const OVERLAY_IMAGE_FILE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

export function isScheduleOverlayCustomiseModalOpen() {
    const modal = document.getElementById('schedule-overlay-customise-modal');
    return modal != null && !modal.classList.contains('hidden');
}

export function isOverlayImagePath(path) {
    const ext = path.split('.').pop()?.toLowerCase();
    return ext != null && OVERLAY_IMAGE_FILE_EXTENSIONS.has(ext);
}

/** Map Tauri drag-drop physical coords to a DOM hit-test (OS drops bypass HTML5 DnD). */
export function isPhysicalPointOverElement(physicalX, physicalY, element) {
    if (!element) return false;
    const scale = window.devicePixelRatio || 1;
    const target = document.elementFromPoint(physicalX / scale, physicalY / scale);
    return target != null && element.contains(target);
}

export function setupScheduleOverlayCustomiseModal() {
    if (isMobileOverrideChallengePlatform()) {
        document.getElementById('schedule-confirm-overlay-row')?.classList.add('hidden');
        document.getElementById('schedule-panel-overlay-section')?.classList.add('hidden');
        return;
    }

    document.getElementById('schedule-confirm-overlay-customise-btn')
        ?.addEventListener('click', () => {
            const blocklist = state.appData.blocklists.find((bl) => bl.id === state.selectedBlocklistId);
            if (blocklist) void openScheduleOverlayCustomiseModal(blocklist);
        });

    document.getElementById('schedule-panel-overlay-customise-btn')
        ?.addEventListener('click', () => {
            const blocklist = state.appData.blocklists.find((bl) => bl.id === state.selectedBlocklistId);
            if (blocklist) void openScheduleOverlayCustomiseModal(blocklist);
        });

    document.getElementById('schedule-confirm-overlay-select')
        ?.addEventListener('change', (event) => {
            setEffectiveScheduleStartOverlayId(event.target.value || null);
            syncScheduleConfirmOverlaySummary();
        });

    document.getElementById('schedule-overlay-customise-close-btn')
        ?.addEventListener('click', () => { void requestCloseScheduleOverlayCustomiseModal(); });
    document.getElementById('schedule-overlay-customise-cancel-btn')
        ?.addEventListener('click', () => { void requestCloseScheduleOverlayCustomiseModal(); });
    document.getElementById('schedule-overlay-customise-modal')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) void requestCloseScheduleOverlayCustomiseModal();
    });
    document.getElementById('schedule-overlay-select')?.addEventListener('change', (event) => {
        void requestLoadScheduleOverlayCustomiseSelection(event.target.value);
    });
    document.getElementById('schedule-overlay-add-new-btn')?.addEventListener('click', () => {
        void requestLoadScheduleOverlayCustomiseSelection(SCHEDULE_OVERLAY_NEW_PRESET_VALUE);
    });
    document.getElementById('schedule-overlay-delete-btn')
        ?.addEventListener('click', () => { void handleDeleteScheduleOverlayCustomise(); });
    document.getElementById('cancel-schedule-overlay-delete-btn')
        ?.addEventListener('click', () => closeScheduleOverlayDeleteConfirmModal(false));
    document.getElementById('confirm-schedule-overlay-delete-btn')
        ?.addEventListener('click', () => closeScheduleOverlayDeleteConfirmModal(true));
    document.getElementById('schedule-overlay-delete-modal')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeScheduleOverlayDeleteConfirmModal(false);
    });
    document.getElementById('cancel-schedule-overlay-discard-btn')
        ?.addEventListener('click', () => closeScheduleOverlayDiscardConfirmModal(false));
    document.getElementById('confirm-schedule-overlay-discard-btn')
        ?.addEventListener('click', () => closeScheduleOverlayDiscardConfirmModal(true));
    document.getElementById('schedule-overlay-discard-modal')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeScheduleOverlayDiscardConfirmModal(false);
    });
    document.getElementById('schedule-overlay-customise-save-btn')?.addEventListener('click', async () => {
        const blocklist = scheduleOverlayCustomiseBlocklist;
        if (!blocklist || state.scheduleOverlayCustomiseSelection === SCHEDULE_OVERLAY_DEFAULT_PRESET_VALUE) return;

        scheduleOverlayCustomiseDraft = readScheduleOverlayCustomiseDraftFromForm();
        const normalized = normalizeScheduleStartOverlay(scheduleOverlayCustomiseDraft);
        const name = document.getElementById('schedule-overlay-name-input')?.value?.trim() || '';

        if (scheduleStartOverlayHasCustomContent(normalized)) {
            if (!name) {
                await message(tSettings('scheduleOverlayNameRequired'), {
                    title: tSettings('errorTitle'),
                    kind: 'error',
                });
                return;
            }
            const presetId = scheduleOverlayCustomisePresetId || crypto.randomUUID();
            upsertGlobalStartOverlay(
                buildNamedStartOverlayPreset({ id: presetId, name, draft: normalized }),
            );
            setEffectiveScheduleStartOverlayId(presetId);
            scheduleOverlayCustomisePresetId = presetId;
            await saveData();
        } else {
            setEffectiveScheduleStartOverlayId(null);
            await saveData();
        }

        syncScheduleConfirmOverlaySummary();
        closeScheduleOverlayCustomiseModal();
    });

    document.getElementById('schedule-overlay-reset-message-btn')?.addEventListener('click', () => {
        setScheduleOverlayMessageEditorHtml('', { silent: true });
        void refreshScheduleOverlayCustomisePreview();
    });
    document.getElementById('schedule-overlay-reset-heading-btn')?.addEventListener('click', () => {
        const headingInput = document.getElementById('schedule-overlay-heading-input');
        if (headingInput) headingInput.value = '';
        void refreshScheduleOverlayCustomisePreview();
    });
    document.getElementById('schedule-overlay-reset-button-btn')?.addEventListener('click', () => {
        const letsGoInput = document.getElementById('schedule-overlay-lets-go-input');
        if (letsGoInput) letsGoInput.value = tSettings('appBlockingLetsGo');
        void refreshScheduleOverlayCustomisePreview();
    });
    document.getElementById('schedule-overlay-reset-image-btn')
        ?.addEventListener('click', () => { void resetScheduleOverlayImageAsset(); });
    document.getElementById('schedule-overlay-reset-voice-btn')
        ?.addEventListener('click', () => { void resetScheduleOverlayVoiceAsset(); });

    document.getElementById('schedule-overlay-lets-go-input')?.addEventListener('input', () => {
        syncScheduleOverlayLetsGoCounter();
        syncScheduleOverlayCustomiseDirtyState();
        void refreshScheduleOverlayCustomisePreview();
    });

    document.getElementById('schedule-overlay-heading-input')?.addEventListener('input', () => {
        syncScheduleOverlayCustomiseDirtyState();
        void refreshScheduleOverlayCustomisePreview();
    });

    document.getElementById('schedule-overlay-name-input')?.addEventListener('input', () => {
        syncScheduleOverlayCustomiseTitle(state.scheduleOverlayCustomiseSelection);
        syncScheduleOverlayCustomiseSelectorDisplayName();
        syncScheduleOverlayCustomiseDirtyState();
    });

    const saveOverlayImageFromPath = async (path) => {
        if (!scheduleOverlayCustomiseBlocklist || !path) return;
        try {
            const ext = path.split('.').pop()?.toLowerCase() || 'png';
            const bytes = new Uint8Array(await tauriAPI.readOverlaySourceBytes(path));
            if (!bytes.length) return;
            const assetId = crypto.randomUUID();
            const relative = await tauriAPI.saveOverlayImageAssetBytes(
                GLOBAL_OVERLAY_ASSET_NAMESPACE,
                assetId,
                ext,
                bytes,
            );
            const prev = scheduleOverlayCustomiseDraft?.imageAsset;
            if (prev && prev !== relative) await removeScheduleOverlayAsset(prev);
            scheduleOverlayCustomiseDraft = readScheduleOverlayCustomiseDraftFromForm();
            scheduleOverlayCustomiseDraft.imageAsset = relative;
            scheduleOverlayCustomiseDraft.custom = true;
            await renderScheduleOverlayCustomisePreview(
                scheduleOverlayCustomiseBlocklist,
                scheduleOverlayCustomiseDraft,
            );
        } catch (err) {
            console.error('[schedule-overlay] image save failed:', err);
            await message(String(err), { title: tSettings('errorTitle'), kind: 'error' });
        }
    };

    const getOverlayImageExtension = (file) => {
        const fromName = file.name?.split('.').pop()?.toLowerCase();
        if (fromName && ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(fromName)) return fromName;
        const mime = file.type?.split('/')?.[1]?.toLowerCase();
        if (mime === 'jpeg') return 'jpg';
        if (mime && ['png', 'jpg', 'gif', 'webp'].includes(mime)) return mime;
        return null;
    };

    const saveOverlayImageFromFile = async (file) => {
        if (!scheduleOverlayCustomiseBlocklist || !file) return;
        const ext = getOverlayImageExtension(file);
        if (!ext) {
            await message(tSettings('scheduleOverlayUnsupportedImage'), {
                title: tSettings('errorTitle'),
                kind: 'error',
            });
            return;
        }
        const assetId = crypto.randomUUID();
        try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            if (!bytes.length) return;
            const relative = await tauriAPI.saveOverlayImageAssetBytes(
                GLOBAL_OVERLAY_ASSET_NAMESPACE,
                assetId,
                ext,
                bytes,
            );
            const prev = scheduleOverlayCustomiseDraft?.imageAsset;
            if (prev && prev !== relative) await removeScheduleOverlayAsset(prev);
            scheduleOverlayCustomiseDraft = readScheduleOverlayCustomiseDraftFromForm();
            scheduleOverlayCustomiseDraft.imageAsset = relative;
            scheduleOverlayCustomiseDraft.custom = true;
            await renderScheduleOverlayCustomisePreview(
                scheduleOverlayCustomiseBlocklist,
                scheduleOverlayCustomiseDraft,
            );
        } catch (err) {
            console.error('[schedule-overlay] image save failed:', err);
            await message(String(err), { title: tSettings('errorTitle'), kind: 'error' });
        }
    };

    document.getElementById('schedule-overlay-choose-image-btn')?.addEventListener('click', async () => {
        if (!scheduleOverlayCustomiseBlocklist) return;
        const selected = await openDialog({
            multiple: false,
            filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
        });
        const path = Array.isArray(selected) ? selected[0] : selected;
        if (path) await saveOverlayImageFromPath(path);
    });

    const imageDropzone = document.getElementById('schedule-overlay-image-dropzone');
    if (imageDropzone) {
        imageDropzone.addEventListener('dragenter', (event) => {
            event.preventDefault();
            imageDropzone.classList.add('is-dragover');
        });
        imageDropzone.addEventListener('dragover', (event) => {
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
            imageDropzone.classList.add('is-dragover');
        });
        imageDropzone.addEventListener('dragleave', (event) => {
            if (!imageDropzone.contains(event.relatedTarget)) {
                imageDropzone.classList.remove('is-dragover');
            }
        });
        imageDropzone.addEventListener('drop', async (event) => {
            event.preventDefault();
            imageDropzone.classList.remove('is-dragover');
            // OS file drops in Tauri are handled by onDragDropEvent below.
            const file = event.dataTransfer?.files?.[0];
            if (!file || !file.type.startsWith('image/')) return;
            await saveOverlayImageFromFile(file);
        });

        // Tauri intercepts Finder/Explorer file drops before the webview sees HTML5 drop.
        void getCurrentWebview().onDragDropEvent((event) => {
            if (!isScheduleOverlayCustomiseModalOpen()) {
                imageDropzone.classList.remove('is-dragover');
                return;
            }

            const { payload } = event;
            if (payload.type === 'leave') {
                imageDropzone.classList.remove('is-dragover');
                return;
            }

            if (payload.type === 'enter' || payload.type === 'over') {
                const { x, y } = payload.position;
                imageDropzone.classList.toggle(
                    'is-dragover',
                    isPhysicalPointOverElement(x, y, imageDropzone),
                );
                return;
            }

            if (payload.type === 'drop') {
                imageDropzone.classList.remove('is-dragover');
                const { x, y } = payload.position;
                if (!isPhysicalPointOverElement(x, y, imageDropzone)) return;
                const imagePath = payload.paths?.find(isOverlayImagePath);
                if (!imagePath && payload.paths?.length) {
                    void message(tSettings('scheduleOverlayUnsupportedImage'), {
                        title: tSettings('errorTitle'),
                        kind: 'error',
                    });
                    return;
                }
                if (imagePath) void saveOverlayImageFromPath(imagePath);
            }
        });
    }

    document.getElementById('schedule-overlay-choose-voice-btn')?.addEventListener('click', async () => {
        if (!scheduleOverlayCustomiseBlocklist) return;
        const selected = await openDialog({
            multiple: false,
            filters: [{ name: 'Audio', extensions: ['webm', 'ogg', 'wav', 'mp4', 'm4a'] }],
        });
        const path = Array.isArray(selected) ? selected[0] : selected;
        if (!path) return;

        try {
            const ext = path.split('.').pop()?.toLowerCase() || 'webm';
            const bytes = await tauriAPI.readOverlaySourceBytes(path);
            const assetId = crypto.randomUUID();
            const relative = await tauriAPI.saveOverlayVoiceAsset(
                GLOBAL_OVERLAY_ASSET_NAMESPACE,
                assetId,
                ext,
                new Uint8Array(bytes),
            );
            const prev = scheduleOverlayCustomiseDraft?.voiceAsset;
            if (prev && prev !== relative) await removeScheduleOverlayAsset(prev);
            scheduleOverlayCustomiseDraft = readScheduleOverlayCustomiseDraftFromForm();
            scheduleOverlayCustomiseDraft.voiceAsset = relative;
            scheduleOverlayCustomiseDraft.custom = true;
            await renderScheduleOverlayCustomisePreview(
                scheduleOverlayCustomiseBlocklist,
                scheduleOverlayCustomiseDraft,
            );
        } catch (err) {
            console.error('[schedule-overlay] voice import failed:', err);
            await message(String(err), { title: tSettings('errorTitle'), kind: 'error' });
        }
    });

    const recordLevelMeter = document.getElementById('schedule-overlay-record-level');
    if (recordLevelMeter && recordLevelMeter.childElementCount === 0) {
        for (let i = 0; i < SCHEDULE_OVERLAY_RECORD_LEVEL_BAR_COUNT; i += 1) {
            const bar = document.createElement('span');
            bar.className = 'schedule-overlay-record-level-bar';
            recordLevelMeter.appendChild(bar);
        }
    }

    document.getElementById('schedule-overlay-record-voice-btn')?.addEventListener('click', async () => {
        if (!scheduleOverlayCustomiseBlocklist || !navigator.mediaDevices?.getUserMedia) {
            await message(tSettings('scheduleOverlayMicUnavailable'), {
                title: tSettings('errorTitle'),
                kind: 'error',
            });
            return;
        }
        try {
            stopScheduleOverlayRecording();
            scheduleOverlayRecordStartCancelled = false;
            setScheduleOverlayRecordingUi('starting');
            scheduleOverlayRecordChunks = [];
            scheduleOverlayRecordStream = await acquireScheduleOverlayMicStream();
            if (scheduleOverlayRecordStartCancelled) {
                scheduleOverlayRecordStream.getTracks().forEach((track) => track.stop());
                scheduleOverlayRecordStream = null;
                setScheduleOverlayRecordingUi('idle');
                return;
            }
            const recordingMimeType = pickOverlayRecordingMimeType();
            scheduleOverlayRecordedMimeType = recordingMimeType || 'audio/webm';
            scheduleOverlayMediaRecorder = recordingMimeType
                ? new MediaRecorder(scheduleOverlayRecordStream, { mimeType: recordingMimeType })
                : new MediaRecorder(scheduleOverlayRecordStream);
            scheduleOverlayMediaRecorder.ondataavailable = (event) => {
                if (event.data?.size > 0) scheduleOverlayRecordChunks.push(event.data);
            };
            scheduleOverlayMediaRecorder.onstop = async () => {
                stopScheduleOverlayRecordLevelMeter();
                const mimeType = scheduleOverlayMediaRecorder?.mimeType
                    || scheduleOverlayRecordedMimeType
                    || 'audio/webm';
                const blob = new Blob(scheduleOverlayRecordChunks, { type: mimeType });
                scheduleOverlayRecordChunks = [];
                if (!blob.size) {
                    await message(tSettings('scheduleOverlayEmptyRecording'), {
                        title: tSettings('errorTitle'),
                        kind: 'error',
                    });
                    finishScheduleOverlayRecorderKeepMic();
                    return;
                }
                const buffer = await blob.arrayBuffer();
                try {
                    const assetId = crypto.randomUUID();
                    const ext = overlayMimeTypeToExtension(mimeType);
                    const relative = await tauriAPI.saveOverlayVoiceAsset(
                        GLOBAL_OVERLAY_ASSET_NAMESPACE,
                        assetId,
                        ext,
                        new Uint8Array(buffer),
                    );
                    const prev = scheduleOverlayCustomiseDraft?.voiceAsset;
                    if (prev && prev !== relative) await removeScheduleOverlayAsset(prev);
                    scheduleOverlayCustomiseDraft = readScheduleOverlayCustomiseDraftFromForm();
                    scheduleOverlayCustomiseDraft.voiceAsset = relative;
                    scheduleOverlayCustomiseDraft.custom = true;
                    await renderScheduleOverlayCustomisePreview(
                        scheduleOverlayCustomiseBlocklist,
                        scheduleOverlayCustomiseDraft,
                    );
                } catch (err) {
                    console.error('[schedule-overlay] voice save failed:', err);
                    await message(String(err), { title: tSettings('errorTitle'), kind: 'error' });
                } finally {
                    finishScheduleOverlayRecorderKeepMic();
                }
            };
            // No timeslice: WKWebView records audio/mp4, and its timeslice chunks
            // don't concatenate cleanly (audible gaps at chunk boundaries). A single
            // final dataavailable on stop() yields one properly finalized file.
            scheduleOverlayMediaRecorder.start();
            setScheduleOverlayRecordingUi('recording');
            void startScheduleOverlayRecordLevelMeter(scheduleOverlayRecordStream);
        } catch (err) {
            console.error('[schedule-overlay] mic access failed:', err);
            stopScheduleOverlayRecording();
            await message(tSettings('scheduleOverlayMicUnavailable'), {
                title: tSettings('errorTitle'),
                kind: 'error',
            });
        }
    });

    document.getElementById('schedule-overlay-stop-record-voice-btn')
        ?.addEventListener('click', () => {
            const voiceCard = document.getElementById('schedule-overlay-voice-card');
            if (voiceCard?.classList.contains('is-starting')) {
                scheduleOverlayRecordStartCancelled = true;
                stopScheduleOverlayRecording();
                setScheduleOverlayRecordingUi('idle');
                return;
            }
            if (scheduleOverlayMediaRecorder && scheduleOverlayMediaRecorder.state === 'recording') {
                // stop() flushes remaining data itself; requestData() beforehand would
                // force an extra fragment, which glitches WKWebView's mp4 output.
                scheduleOverlayMediaRecorder.stop();
            } else {
                stopScheduleOverlayRecording();
            }
        });
}
