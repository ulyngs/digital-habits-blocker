// Blocklist domain helpers: protected apps/domains, iOS Screen Time
// selection normalization, blocklist normalization. Extracted verbatim
// from app.js. Leaf module: imports only shared state.
import { state } from './state.js';

// Far-future timestamp used for "always on" blocks (year 9999)
export const ALWAYS_ON_END_TIME = new Date(9999, 11, 31, 23, 59, 59, 999).getTime();

// Protected app names — Digital Habits Blocker must never block itself
export const PROTECTED_APP_NAMES = [
    'digital habits blocker',
    'digital habits: blocker',
    'redd block',
    'redd blocker',
    'redd-block',
    'redd-block-helper',
    'fristed',
];

// Protected domains — blocking these would break networking or the app itself
export const PROTECTED_DOMAINS = [
    'localhost', 'localhost.localdomain',
    '127.0.0.1', '0.0.0.0', '::1',
    'broadcasthost', 'local',
    'reddfocus.org', 'www.reddfocus.org',
    'digitalhabits.org', 'www.digitalhabits.org',
    'ulyngs.github.io'
];

/**
 * Check if an app name matches a protected app (case-insensitive).
 * Returns true if the app should NOT be added to a blocklist.
 */
export function isProtectedApp(name) {
    if (!name) return false;
    const lower = name.trim().toLowerCase();
    return PROTECTED_APP_NAMES.some(p => lower === p);
}

/**
 * Check if a domain is protected (case-insensitive).
 * Returns true if the domain should NOT be added to a blocklist.
 */
export function isProtectedDomain(domain) {
    if (!domain) return false;
    const lower = domain.trim().toLowerCase();
    return PROTECTED_DOMAINS.some(p => lower === p);
}

// Helper: detect always-on blocks by flag OR far-future end time
export function isBlockAlwaysOn(block) {
    return block.isAlwaysOn === true || block.endTime >= ALWAYS_ON_END_TIME;
}

/** Canonical mode test. Anything that is not explicitly 'allowlist' is a blocklist. */
export function isAllowlistBlocklist(blocklist) {
    return blocklist?.mode === 'allowlist';
}

export function isScreenTimeSummaryEntry(appName) {
    return typeof appName === 'string' && appName.includes('selected (Screen Time)');
}

export function parseLegacyScreenTimeSummary(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const summaryLabel = entries.join(', ');
    let applicationCount = 0;
    let categoryCount = 0;
    for (const entry of entries) {
        const appMatch = entry.match(/(\d+)\s+app/);
        const categoryMatch = entry.match(/(\d+)\s+categor(?:y|ies)/);
        if (appMatch) applicationCount += Number.parseInt(appMatch[1], 10);
        if (categoryMatch) categoryCount += Number.parseInt(categoryMatch[1], 10);
    }
    return {
        applicationTokens: [],
        categoryTokens: [],
        applicationCount,
        categoryCount,
        summaryLabel,
        requiresReselection: true
    };
}

export function normalizeIOSScreenTimeSelection(selection, legacySummaryEntries = []) {
    if (!selection && legacySummaryEntries.length === 0) return null;

    const normalized = {
        applicationTokens: Array.isArray(selection?.applicationTokens) ? [...selection.applicationTokens] : [],
        categoryTokens: Array.isArray(selection?.categoryTokens) ? [...selection.categoryTokens] : [],
        applicationCount: Number.isFinite(selection?.applicationCount) ? selection.applicationCount : null,
        categoryCount: Number.isFinite(selection?.categoryCount) ? selection.categoryCount : null,
        summaryLabel: typeof selection?.summaryLabel === 'string' ? selection.summaryLabel : '',
        requiresReselection: selection?.requiresReselection === true
    };

    if (normalized.applicationCount == null) {
        normalized.applicationCount = normalized.applicationTokens.length;
    }
    if (normalized.categoryCount == null) {
        normalized.categoryCount = normalized.categoryTokens.length;
    }

    if (!selection && legacySummaryEntries.length > 0) {
        return parseLegacyScreenTimeSummary(legacySummaryEntries);
    }

    if (
        !normalized.summaryLabel &&
        (normalized.applicationCount > 0 || normalized.categoryCount > 0) &&
        normalized.applicationTokens.length === 0 &&
        normalized.categoryTokens.length === 0
    ) {
        const legacySelection = parseLegacyScreenTimeSummary(legacySummaryEntries);
        if (legacySelection?.summaryLabel) {
            normalized.summaryLabel = legacySelection.summaryLabel;
        }
        normalized.requiresReselection = true;
    }

    const hasAnySelection =
        normalized.applicationTokens.length > 0 ||
        normalized.categoryTokens.length > 0 ||
        normalized.applicationCount > 0 ||
        normalized.categoryCount > 0 ||
        !!normalized.summaryLabel;

    return hasAnySelection ? normalized : null;
}

export function cloneIOSScreenTimeSelection(selection) {
    const normalized = normalizeIOSScreenTimeSelection(selection);
    return normalized ? { ...normalized } : null;
}

export function hasUsableIOSScreenTimeSelection(selection) {
    const normalized = normalizeIOSScreenTimeSelection(selection);
    return !!normalized && (
        normalized.applicationTokens.length > 0 ||
        normalized.categoryTokens.length > 0
    );
}

export function formatIOSScreenTimeSelectionLabel(selection) {
    const normalized = normalizeIOSScreenTimeSelection(selection);
    if (!normalized) return '';
    if (normalized.summaryLabel) return normalized.summaryLabel;

    const parts = [];
    if (normalized.applicationCount > 0) parts.push(`${normalized.applicationCount} app${normalized.applicationCount > 1 ? 's' : ''}`);
    if (normalized.categoryCount > 0) parts.push(`${normalized.categoryCount} categor${normalized.categoryCount > 1 ? 'ies' : 'y'}`);
    return parts.length > 0 ? `${parts.join(', ')} selected (Screen Time)` : '';
}

export function getBlocklistRegularApps(blocklist) {
    if (!Array.isArray(blocklist?.apps)) return [];
    return blocklist.apps.filter(app => typeof app === 'string' && !isScreenTimeSummaryEntry(app));
}

export function getBlocklistIOSScreenTimeSelection(blocklist) {
    const legacySummaryEntries = Array.isArray(blocklist?.apps)
        ? blocklist.apps.filter(isScreenTimeSummaryEntry)
        : [];
    return normalizeIOSScreenTimeSelection(blocklist?.iosScreenTimeSelection, legacySummaryEntries);
}

export function getBlocklistModalLockedApps(blocklist) {
    const locked = [...getBlocklistRegularApps(blocklist)];
    const screenTimeLabel = formatIOSScreenTimeSelectionLabel(getBlocklistIOSScreenTimeSelection(blocklist));
    if (screenTimeLabel) locked.push(screenTimeLabel);
    return locked;
}

export function getBlocklistIOSPayload(blocklist) {
    const selection = getBlocklistIOSScreenTimeSelection(blocklist);
    return {
        appTokenData: selection?.applicationTokens || [],
        categoryTokenData: selection?.categoryTokens || []
    };
}

export function blocklistNeedsIOSSelectionRefresh(blocklist) {
    const selection = getBlocklistIOSScreenTimeSelection(blocklist);
    return !!selection && selection.requiresReselection === true && !hasUsableIOSScreenTimeSelection(selection);
}

/**
 * Merge a freshly-picked Screen Time selection into a saved one, keeping every
 * saved token.
 *
 * The iOS activity picker hands back a *replacement* selection, which makes it
 * the one edit surface that can unblock an app while a focus space is
 * enforcing: the edit modal's locked tags cover only the summary label ("3
 * apps"), never the tokens behind it. Unioning turns the picker additive, which
 * is the rule already in force for every other item on every other platform —
 * while enforcing you may add, never remove.
 *
 * Block mode only, and the caller is responsible for that check. In allow mode
 * the picker expands categories into their member app tokens and returns no
 * category tokens, so a union there would resurrect a saved category token the
 * allow-mode resolver cannot enforce — and adding is the loosening direction in
 * allow mode anyway.
 *
 * Counts are deliberately not carried over from either input: they describe the
 * replacement, not the merge, and the summary label is derived from them. Left
 * null, normalizeIOSScreenTimeSelection recomputes both from the merged arrays.
 *
 * @param {object|null} saved - the persisted selection, the floor to stay above.
 * @param {object|null} picked - what the picker returned (null when it came back empty).
 * @returns {object|null} normalized selection, or null when both sides are empty.
 */
export function mergeIOSScreenTimeSelectionAdditive(saved, picked) {
    const union = (a, b) => {
        const seen = new Set();
        const out = [];
        for (const token of [...(a || []), ...(b || [])]) {
            if (typeof token !== 'string' || !token || seen.has(token)) continue;
            seen.add(token);
            out.push(token);
        }
        return out;
    };

    const applicationTokens = union(saved?.applicationTokens, picked?.applicationTokens);
    const categoryTokens = union(saved?.categoryTokens, picked?.categoryTokens);
    if (applicationTokens.length === 0 && categoryTokens.length === 0) return null;

    // A merge always carries real tokens, so whatever `requiresReselection` the
    // saved side had is repaired by definition.
    return normalizeIOSScreenTimeSelection({
        applicationTokens,
        categoryTokens,
        requiresReselection: false,
    });
}

export function ensureIOSBlocklistSelectionReady(blocklist, actionLabel) {
    if (!state.isIOS || !blocklistNeedsIOSSelectionRefresh(blocklist)) {
        return true;
    }

    const blocklistName = blocklist?.name || 'This blocklist';
    alert(`${blocklistName} has an old Screen Time app selection that iOS can no longer enforce reliably. Please edit the blocklist and re-select its apps before ${actionLabel}.`);
    return false;
}

/** Soft palette matching the focus-space color swatches (sky → lilac). */
export const FOCUS_SPACE_COLOR_PALETTE = [
    '#B8D1DE',
    '#B3D2C8',
    '#BCD9B6',
    '#EBDCB6',
    '#EECAAD',
    '#E7B3A8',
    '#E1BAC3',
    '#C8B9D6',
];

/**
 * If saved colors collapsed to one shared value (or are missing), reassign
 * non–Quick start spaces in palette order so the list reads as distinct again.
 */
export function healFocusSpaceColors(blocklists) {
    const lists = (blocklists || []).filter((bl) => !isQuickStartBlocklist(bl));
    if (lists.length === 0) return false;

    const present = lists
        .map((bl) => (typeof bl.color === 'string' && bl.color.trim() ? bl.color.trim() : null))
        .filter(Boolean);
    const collapsed = present.length >= 2 && new Set(present).size === 1;

    if (collapsed) {
        lists.forEach((bl, i) => {
            bl.color = FOCUS_SPACE_COLOR_PALETTE[i % FOCUS_SPACE_COLOR_PALETTE.length];
        });
        return true;
    }

    let changed = false;
    const used = new Set(present);
    for (const bl of lists) {
        if (typeof bl.color === 'string' && bl.color.trim()) continue;
        const next = FOCUS_SPACE_COLOR_PALETTE.find((c) => !used.has(c))
            || FOCUS_SPACE_COLOR_PALETTE[used.size % FOCUS_SPACE_COLOR_PALETTE.length];
        bl.color = next;
        used.add(next);
        changed = true;
    }
    return changed;
}

/** Ephemeral Quick start spaces (id prefix `qs-` heals older saves that dropped the flag). */
export function isQuickStartBlocklist(blocklist) {
    if (!blocklist) return false;
    // Explicit false wins (after "Save as focus space").
    if (blocklist.isQuickStart === false) return false;
    if (blocklist.isQuickStart === true) return true;
    return String(blocklist.id || '').startsWith('qs-');
}

/** Color-emoji presentation (VS16) so the bolt stays yellow, not a black text glyph. */
export const QUICK_START_EMOJI = '⚡️';

export function normalizeBlocklist(blocklist) {
    const normalizedBlocklist = { ...blocklist };
    normalizedBlocklist.apps = getBlocklistRegularApps(blocklist);
    normalizedBlocklist.iosScreenTimeSelection = getBlocklistIOSScreenTimeSelection(blocklist);
    if (blocklist.isQuickStart === false) {
        normalizedBlocklist.isQuickStart = false;
    } else if (isQuickStartBlocklist(normalizedBlocklist)) {
        // Heal Quick starts whose isQuickStart flag was stripped (e.g. edit-modal save).
        normalizedBlocklist.isQuickStart = true;
        normalizedBlocklist.emoji = QUICK_START_EMOJI;
    }
    return normalizedBlocklist;
}

export function collectActiveIOSManualBlockPayload(now = Date.now()) {
    const allDomains = new Set();
    const allowedDomains = new Set();
    const allowedAppTokenData = new Set();
    const appTokenData = new Set();
    const categoryTokenData = new Set();

    let displayWinner = null;
    let allowlistDisplayWinner = null;

    for (const block of state.appData.activeBlocks || []) {
        if (block.startTime > now || block.endTime <= now || block.isPaused) continue;
        const blocklist = state.appData.blocklists.find(bl => bl.id === block.blocklistId);
        if (!blocklist) continue;

        const bid = String(block.blocklistId ?? '');
        if (
            displayWinner == null
            || block.startTime < displayWinner.block.startTime
            || (block.startTime === displayWinner.block.startTime
                && bid < String(displayWinner.block.blocklistId ?? ''))
        ) {
            displayWinner = { block, blocklist };
        }

        if (
            isAllowlistBlocklist(blocklist)
            && (
                allowlistDisplayWinner == null
                || block.startTime < allowlistDisplayWinner.block.startTime
                || (block.startTime === allowlistDisplayWinner.block.startTime
                    && bid < String(allowlistDisplayWinner.block.blocklistId ?? ''))
            )
        ) {
            allowlistDisplayWinner = { block, blocklist };
        }

        if (isAllowlistBlocklist(blocklist)) {
            // Allow-mode focus space: websites and app tokens are ALLOWED items.
            // Category tokens cannot be allowlist exceptions on iOS and are ignored.
            for (const domain of blocklist.websites || []) {
                if (!isProtectedDomain(domain)) allowedDomains.add(domain);
            }
            for (const token of getBlocklistIOSPayload(blocklist).appTokenData) {
                allowedAppTokenData.add(token);
            }
            continue;
        }

        for (const domain of blocklist.websites || []) {
            if (!isProtectedDomain(domain)) allDomains.add(domain);
        }

        const iosPayload = getBlocklistIOSPayload(blocklist);
        for (const token of iosPayload.appTokenData) appTokenData.add(token);
        for (const token of iosPayload.categoryTokenData) categoryTokenData.add(token);
    }

    // Blocklist wins on overlap: an explicitly blocked item is never an exception.
    for (const domain of allDomains) allowedDomains.delete(domain);
    for (const token of appTokenData) allowedAppTokenData.delete(token);

    const out = {
        domains: Array.from(allDomains).sort(),
        allowedDomains: Array.from(allowedDomains).sort(),
        allowedAppTokenData: Array.from(allowedAppTokenData),
        appTokenData: Array.from(appTokenData),
        categoryTokenData: Array.from(categoryTokenData)
    };
    if (displayWinner) {
        const { block, blocklist } = displayWinner;
        out.blocklistEmoji = blocklist.emoji ?? null;
        out.blocklistName = blocklist.name ?? null;
        const c = blocklist.color;
        out.blocklistColorHex = typeof c === 'string' && c.length > 0 ? c : null;
        out.blockStartMs = block.startTime;
        out.blockEndMs = block.endTime;
        out.mode = isAllowlistBlocklist(blocklist) ? 'allowlist' : null;
    }
    if (allowlistDisplayWinner) {
        // Shield attribution for "blocked because not allowed" targets: the
        // earliest-started active allow-mode block, independent of the overall
        // display winner above (which may be a blocklist block).
        const { block, blocklist } = allowlistDisplayWinner;
        out.allowlistBlocklistEmoji = blocklist.emoji ?? null;
        out.allowlistBlocklistName = blocklist.name ?? null;
        const c = blocklist.color;
        out.allowlistBlocklistColorHex = typeof c === 'string' && c.length > 0 ? c : null;
        out.allowlistBlockStartMs = block.startTime;
        out.allowlistBlockEndMs = block.endTime;
    }
    return out;
}

