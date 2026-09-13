// Blocklist vs allowlist mode helpers for the focus-space edit modal.
// Extracted from app.js during allowlist-refactoring phase 2.
import { tSettings, tSettingsFmt } from './i18n.js';
import { isAllowlistBlocklist } from './blocklist-utils.js';

const ALLOWLIST_SCOPE_LOCK_ICON = `<svg class="allowlist-scope-hint-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`;
const ALLOWLIST_SCOPE_CHECK_ICON = `<svg class="allowlist-scope-hint-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M8.5 12.5l2.5 2.5 4.5-5"></path></svg>`;

/** Create/edit modal mode — set by entry point (New space vs Allow only) or existing list. */
let selectedBlocklistModalMode = 'blocklist';

/**
 * Show/hide the parts of the focus-space modal that only apply when creating.
 * @param {{ isCreate?: boolean }} [opts]
 */
export function syncBlocklistCreateUi(opts = {}) {
    const creating = opts.isCreate === true;

    const modeDesc = document.getElementById('blocklist-modal-mode-desc');
    if (modeDesc) modeDesc.classList.toggle('hidden', !creating);

    const saveBtn = document.getElementById('save-blocklist-btn');
    if (saveBtn) saveBtn.textContent = tSettings('save');
}

export function isBlocklistAllowlistMode(blocklist) {
    return isAllowlistBlocklist(blocklist);
}

export function getStartConfirmBlockingLabel(blocklist) {
    return tSettings(
        isBlocklistAllowlistMode(blocklist)
            ? 'startConfirmAllowingLabel'
            : 'startConfirmBlockingLabel',
    );
}

export function setConfirmModalBlockingLabel(blocklist, labelId) {
    const el = document.getElementById(labelId);
    if (el) el.textContent = getStartConfirmBlockingLabel(blocklist);
}

export function getSelectedBlocklistModalMode() {
    return selectedBlocklistModalMode === 'allowlist' ? 'allowlist' : 'blocklist';
}

export function setBlocklistModalMode(mode) {
    selectedBlocklistModalMode = mode === 'allowlist' ? 'allowlist' : 'blocklist';
    updateBlocklistModalModeLabels(selectedBlocklistModalMode);
}

/**
 * Under websites/apps inputs: explain allow-mode empty vs restricted scope.
 * Hidden for blocklists. Counts should match listed items (Screen Time apps included).
 */
export function updateAllowlistScopeHints(websiteCount = 0, appCount = 0) {
    const isAllow = getSelectedBlocklistModalMode() === 'allowlist';
    const sites = Math.max(0, Number(websiteCount) || 0);
    const apps = Math.max(0, Number(appCount) || 0);

    const update = (id, count, emptyKey, activeKey) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.classList.toggle('hidden', !isAllow);
        if (!isAllow) {
            el.innerHTML = '';
            return;
        }
        const empty = count <= 0;
        el.classList.toggle('allowlist-scope-hint--empty', empty);
        el.classList.toggle('allowlist-scope-hint--active', !empty);
        const text = empty
            ? tSettings(emptyKey)
            : tSettingsFmt(activeKey, { count });
        el.innerHTML = `${empty ? ALLOWLIST_SCOPE_CHECK_ICON : ALLOWLIST_SCOPE_LOCK_ICON}<span class="allowlist-scope-hint-text">${text}</span>`;
    };

    update(
        'blocklist-websites-allow-hint',
        sites,
        'allowlistScopeWebsitesEmptyHtml',
        'allowlistScopeWebsitesActiveHtml',
    );
    update(
        'blocklist-apps-allow-hint',
        apps,
        'allowlistScopeAppsEmptyHtml',
        'allowlistScopeAppsActiveHtml',
    );
}

export function updateBlocklistModalModeLabels(mode) {
    const isAllow = mode === 'allowlist';
    const assignText = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    };
    assignText('blocklist-websites-label', tSettings(isAllow ? 'websitesAllow' : 'websites'));
    assignText('blocklist-apps-label', tSettings(isAllow ? 'appsAllow' : 'apps'));
    assignText(
        'blocklist-websites-tooltip',
        tSettings(isAllow ? 'websitesAllowTooltip' : 'websitesTooltip'),
    );
    assignText(
        'blocklist-apps-tooltip',
        tSettings(isAllow ? 'appsAllowTooltip' : 'appsTooltip'),
    );
    assignText(
        'show-item-details-label',
        tSettings(isAllow ? 'listAllowedOnCard' : 'listBlockedOnCard'),
    );
    const modeDesc = document.getElementById('blocklist-modal-mode-desc');
    if (modeDesc) {
        modeDesc.innerHTML = tSettings(
            isAllow ? 'createAllowlistDescHtml' : 'createBlocklistDescHtml',
        );
    }
    if (typeof window.getModalAllowlistScopeCounts === 'function') {
        const counts = window.getModalAllowlistScopeCounts();
        updateAllowlistScopeHints(counts?.websites ?? 0, counts?.apps ?? 0);
    } else {
        updateAllowlistScopeHints(0, 0);
    }
    const websiteInput = document.getElementById('modal-website-input');
    if (websiteInput) {
        syncModalWebsitePlaceholder();
    }
    const appInput = document.getElementById('modal-app-input');
    if (appInput) {
        syncModalAppPlaceholder();
    }
}

/** Blocklist modal: always show the example placeholder in the websites input row. */
export function syncModalWebsitePlaceholder() {
    const el = document.getElementById('modal-website-input');
    if (!el || el.classList.contains('input-error')) return;
    el.placeholder = tSettings('placeholderWebsiteExample');
}

/** Blocklist modal: always show the example placeholder in the apps input row. */
export function syncModalAppPlaceholder() {
    const el = document.getElementById('modal-app-input');
    if (!el || el.classList.contains('input-error')) return;
    el.placeholder = tSettings('placeholderAppExample');
}
