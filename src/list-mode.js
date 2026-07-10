// Blocklist vs allowlist mode helpers for the focus-space edit modal.
// Extracted from app.js during allowlist-refactoring phase 2.
import { tSettings } from './i18n.js';

export function isBlocklistAllowlistMode(blocklist) {
    return blocklist?.mode === 'allowlist';
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
    const selected = document.querySelector('#blocklist-mode-toggle .mode-btn.active');
    return selected?.dataset?.mode === 'allowlist' ? 'allowlist' : 'blocklist';
}

export function setBlocklistModalMode(mode) {
    const normalized = mode === 'allowlist' ? 'allowlist' : 'blocklist';
    document.querySelectorAll('#blocklist-mode-toggle .mode-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.mode === normalized);
    });
    updateBlocklistModalModeLabels(normalized);
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
    assignText('blocklist-mode-hint', tSettings(isAllow ? 'allowlistModeHint' : 'blocklistModeHint'));
    assignText(
        'show-item-details-label',
        tSettings(isAllow ? 'listAllowedOnCard' : 'listBlockedOnCard'),
    );
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
