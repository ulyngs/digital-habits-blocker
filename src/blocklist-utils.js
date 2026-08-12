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
 * Stable serialization of an iOS Screen Time selection, for equality checks.
 *
 * Deliberately excludes `applicationCount` / `categoryCount` (derived — see
 * normalizeIOSScreenTimeSelection), `summaryLabel` (display metadata), and
 * `requiresReselection` (a health flag that can flip on read, which would make
 * a no-op edit look like a change).
 */
export function iosScreenTimeSelectionKey(selection) {
    return JSON.stringify({
        app: [...(selection?.applicationTokens || [])].sort(),
        cat: [...(selection?.categoryTokens || [])].sort()
    });
}

/** Reason codes emitted by compareBlocklistStrictness. */
export const BLOCKLIST_LOOSEN_REASONS = Object.freeze({
    MODE_CHANGED: 'mode-changed',
    WEBSITES_REMOVED: 'websites-removed',
    APPS_REMOVED: 'apps-removed',
    WEBSITES_ALLOWED_ADDED: 'websites-allowed-added',
    APPS_ALLOWED_ADDED: 'apps-allowed-added',
    WEBSITES_ALLOW_SCOPE_OPENED: 'websites-allow-scope-opened',
    APPS_ALLOW_SCOPE_OPENED: 'apps-allow-scope-opened',
    IOS_SELECTION_CHANGED: 'ios-selection-changed',
    DIFFICULTY_CHANGED: 'difficulty-changed',
});

/** Most severe → least, for picking which reason the hint names. */
const LOOSEN_REASON_SEVERITY = [
    BLOCKLIST_LOOSEN_REASONS.MODE_CHANGED,
    BLOCKLIST_LOOSEN_REASONS.WEBSITES_ALLOW_SCOPE_OPENED,
    BLOCKLIST_LOOSEN_REASONS.APPS_ALLOW_SCOPE_OPENED,
    BLOCKLIST_LOOSEN_REASONS.WEBSITES_REMOVED,
    BLOCKLIST_LOOSEN_REASONS.APPS_REMOVED,
    BLOCKLIST_LOOSEN_REASONS.WEBSITES_ALLOWED_ADDED,
    BLOCKLIST_LOOSEN_REASONS.APPS_ALLOWED_ADDED,
    BLOCKLIST_LOOSEN_REASONS.IOS_SELECTION_CHANGED,
    BLOCKLIST_LOOSEN_REASONS.DIFFICULTY_CHANGED,
];

/**
 * Case/whitespace-insensitive item key. Matches how enforcement compares app
 * names (see blocking-platform.js) and how cleanDomainInput normalizes domains,
 * so the comparator agrees with what actually gets blocked.
 */
function normStrictnessItem(value) {
    return String(value ?? '').trim().toLowerCase();
}

function strictnessItemSet(items) {
    const set = new Set();
    for (const item of items || []) {
        const key = normStrictnessItem(item);
        if (key) set.add(key);
    }
    return set;
}

/** Original-cased entries of `items` whose normalized key is absent from `otherSet`. */
function itemsMissingFrom(items, otherSet) {
    const seen = new Set();
    const out = [];
    for (const item of items || []) {
        const key = normStrictnessItem(item);
        if (!key || otherSet.has(key) || seen.has(key)) continue;
        seen.add(key);
        out.push(item);
    }
    return out;
}

function normalizeBlocklistMode(blocklist) {
    return blocklist?.mode === 'allowlist' ? 'allowlist' : 'blocklist';
}

/**
 * Size of the "allowed apps" scope. On iOS the allowed apps are Screen Time
 * tokens rather than the `apps` array, so an empty `apps` list does not by
 * itself mean "every app is allowed".
 */
function allowedAppsScopeSize(blocklist) {
    const selection = getBlocklistIOSScreenTimeSelection(blocklist);
    return getBlocklistRegularApps(blocklist).length
        + (selection?.applicationTokens?.length || 0)
        + (selection?.categoryTokens?.length || 0);
}

function difficultyComparable(difficulty) {
    // countBeforeMax / typeBeforeMax are UI-restore bookkeeping, not behaviour.
    return JSON.stringify({
        type: difficulty?.type ?? 'random-words',
        count: Number(difficulty?.count ?? 50) || 0,
        maxDifficulty: difficulty?.maxDifficulty === true,
        customText: String(difficulty?.customText ?? ''),
    });
}

/**
 * Does saving `next` over `prev` make the block *easier to get around*?
 *
 * Pure — no DOM, no state reads — so it can run against an unsaved candidate and
 * be unit-tested directly (exposed via window.__REDDBLOCK_INTERNALS__).
 *
 * The rules invert with mode: a blocklist gets looser when items are *removed*,
 * an allowlist when items are *added*. The one non-obvious case is an allowlist
 * category going non-empty → empty: an empty allow list means "everything in
 * this category is permitted" (see allowlistModeHint / updateAllowlistScopeHints),
 * so it is the *maximum* loosening even though the empty set is trivially a
 * subset. Websites and apps are evaluated independently, matching the UI.
 *
 * @returns {{loosens: boolean, reasons: Array<{code: string, category: string, items?: string[]}>, primaryReasonCode: string|null}}
 */
export function compareBlocklistStrictness(prev, next) {
    const reasons = [];
    const result = () => {
        // Most severe first, so the hint names the biggest problem when an edit
        // loosens in several ways at once.
        reasons.sort((a, b) => LOOSEN_REASON_SEVERITY.indexOf(a.code) - LOOSEN_REASON_SEVERITY.indexOf(b.code));
        return {
            loosens: reasons.length > 0,
            reasons,
            primaryReasonCode: reasons[0]?.code ?? null,
        };
    };

    if (!prev || !next) return result();

    const prevMode = normalizeBlocklistMode(prev);
    const nextMode = normalizeBlocklistMode(next);
    if (prevMode !== nextMode) {
        // Comparing an allow set against a block set is meaningless — stop here.
        reasons.push({ code: BLOCKLIST_LOOSEN_REASONS.MODE_CHANGED, category: 'mode' });
        return result();
    }

    if (difficultyComparable(prev.overrideDifficulty) !== difficultyComparable(next.overrideDifficulty)) {
        reasons.push({ code: BLOCKLIST_LOOSEN_REASONS.DIFFICULTY_CHANGED, category: 'difficulty' });
    }

    const prevWebsites = prev.websites || [];
    const nextWebsites = next.websites || [];
    const prevApps = getBlocklistRegularApps(prev);
    const nextApps = getBlocklistRegularApps(next);
    const prevWebsiteSet = strictnessItemSet(prevWebsites);
    const nextWebsiteSet = strictnessItemSet(nextWebsites);
    const prevAppSet = strictnessItemSet(prevApps);
    const nextAppSet = strictnessItemSet(nextApps);

    if (nextMode === 'allowlist') {
        // An empty allow category means "everything here is permitted", so the
        // empty set is the *widest* scope, not the narrowest. Both branches below
        // depend on prev being non-empty: going empty → restricted is a
        // tightening, and every item in it would otherwise read as an addition.
        if (prevWebsiteSet.size > 0) {
            if (nextWebsiteSet.size === 0) {
                reasons.push({ code: BLOCKLIST_LOOSEN_REASONS.WEBSITES_ALLOW_SCOPE_OPENED, category: 'websites' });
            } else {
                const added = itemsMissingFrom(nextWebsites, prevWebsiteSet);
                if (added.length) {
                    reasons.push({ code: BLOCKLIST_LOOSEN_REASONS.WEBSITES_ALLOWED_ADDED, category: 'websites', items: added });
                }
            }
        }

        // Apps: the scope includes iOS Screen Time tokens, not just `apps`.
        if (allowedAppsScopeSize(prev) > 0) {
            if (allowedAppsScopeSize(next) === 0) {
                reasons.push({ code: BLOCKLIST_LOOSEN_REASONS.APPS_ALLOW_SCOPE_OPENED, category: 'apps' });
            } else {
                const added = itemsMissingFrom(nextApps, prevAppSet);
                if (added.length) {
                    reasons.push({ code: BLOCKLIST_LOOSEN_REASONS.APPS_ALLOWED_ADDED, category: 'apps', items: added });
                }
            }
        }
    } else {
        const removedWebsites = itemsMissingFrom(prevWebsites, nextWebsiteSet);
        if (removedWebsites.length) {
            reasons.push({ code: BLOCKLIST_LOOSEN_REASONS.WEBSITES_REMOVED, category: 'websites', items: removedWebsites });
        }
        const removedApps = itemsMissingFrom(prevApps, nextAppSet);
        if (removedApps.length) {
            reasons.push({ code: BLOCKLIST_LOOSEN_REASONS.APPS_REMOVED, category: 'apps', items: removedApps });
        }
    }

    // A selection the OS can no longer enforce is not protecting anything, so
    // re-selecting it is a repair rather than a loosening.
    if (!blocklistNeedsIOSSelectionRefresh(prev)) {
        const prevKey = iosScreenTimeSelectionKey(getBlocklistIOSScreenTimeSelection(prev));
        const nextKey = iosScreenTimeSelectionKey(getBlocklistIOSScreenTimeSelection(next));
        if (prevKey !== nextKey) {
            reasons.push({ code: BLOCKLIST_LOOSEN_REASONS.IOS_SELECTION_CHANGED, category: 'ios' });
        }
    }

    return result();
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
