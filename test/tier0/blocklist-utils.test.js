import { describe, expect, test } from 'vitest';
import {
    ALWAYS_ON_END_TIME,
    FOCUS_SPACE_COLOR_PALETTE,
    healFocusSpaceColors,
    hasUsableIOSScreenTimeSelection,
    isBlockAlwaysOn,
    isProtectedApp,
    isProtectedDomain,
    mergeIOSScreenTimeSelectionAdditive,
    migrateLegacyQuickStartBlocklists,
    normalizeIOSScreenTimeSelection,
    parseLegacyScreenTimeSummary,
    resolveIOSScreenTimeSelectionForSave,
} from '../../src/blocklist-utils.js';

describe('protected apps and domains', () => {
    test('the app can never be added to a blocklist', () => {
        // Blocking the blocker is the one self-inflicted way to lose
        // enforcement entirely.
        for (const name of [
            'Digital Habits Blocker',
            'digital habits: blocker',
            'ReDD Blocker',
            'redd-block',
            'redd-block-helper',
            'Fristed',
        ]) {
            expect(isProtectedApp(name), name).toBe(true);
        }
    });

    test('protection is case- and whitespace-insensitive', () => {
        expect(isProtectedApp('  REDD BLOCKER  ')).toBe(true);
        expect(isProtectedDomain('  LocalHost ')).toBe(true);
    });

    test('ordinary apps and domains stay blockable', () => {
        // Over-broad protection silently drops entries the user added.
        for (const name of ['Safari', 'Slack', 'Redd', 'Blocker', '']) {
            expect(isProtectedApp(name), name).toBe(false);
        }
        for (const domain of ['reddit.com', 'localhost.example.com', 'example.org', '']) {
            expect(isProtectedDomain(domain), domain).toBe(false);
        }
    });

    test('matching is exact, not substring, in either direction', () => {
        // A third-party app whose name merely contains ours is still the
        // user's to block; and our own name with a suffix is not us.
        for (const name of [
            'ReDD Blocker Companion',
            'Digital Habits Blocker Helper',
            'Not Fristed',
        ]) {
            expect(isProtectedApp(name), name).toBe(false);
        }
        expect(isProtectedDomain('my-localhost')).toBe(false);
        expect(isProtectedDomain('digitalhabits.org.example.com')).toBe(false);
    });

    test('loopback and project domains are protected', () => {
        for (const domain of ['localhost', '127.0.0.1', '0.0.0.0', '::1', 'digitalhabits.org']) {
            expect(isProtectedDomain(domain), domain).toBe(true);
        }
    });

    test('nullish input is not treated as protected', () => {
        expect(isProtectedApp(null)).toBe(false);
        expect(isProtectedApp(undefined)).toBe(false);
        expect(isProtectedDomain(null)).toBe(false);
    });
});

describe('always-on blocks', () => {
    test('an always-on block is recognised by flag or sentinel end time', () => {
        expect(isBlockAlwaysOn({ isAlwaysOn: true, endTime: 0 })).toBe(true);
        expect(isBlockAlwaysOn({ endTime: ALWAYS_ON_END_TIME })).toBe(true);
        expect(isBlockAlwaysOn({ endTime: ALWAYS_ON_END_TIME + 1 })).toBe(true);
    });

    test('an ordinary timed block is not always-on', () => {
        expect(isBlockAlwaysOn({ endTime: Date.now() + 60_000 })).toBe(false);
        expect(isBlockAlwaysOn({ isAlwaysOn: false, endTime: 0 })).toBe(false);
    });
});

describe('iOS Screen Time selection normalization', () => {
    test('an empty selection normalizes to null', () => {
        expect(normalizeIOSScreenTimeSelection(null)).toBeNull();
        expect(normalizeIOSScreenTimeSelection(undefined)).toBeNull();
        expect(normalizeIOSScreenTimeSelection({})).toBeNull();
        expect(normalizeIOSScreenTimeSelection({ applicationTokens: [], categoryTokens: [] })).toBeNull();
    });

    test('counts default to the token array lengths', () => {
        const normalized = normalizeIOSScreenTimeSelection({
            applicationTokens: ['a', 'b'],
            categoryTokens: ['c'],
        });
        expect(normalized.applicationCount).toBe(2);
        expect(normalized.categoryCount).toBe(1);
        expect(normalized.requiresReselection).toBe(false);
    });

    test('token arrays are copied, not aliased', () => {
        // The caller mutating its own array must not retroactively change a
        // stored blocklist's selection.
        const source = { applicationTokens: ['a'], categoryTokens: [] };
        const normalized = normalizeIOSScreenTimeSelection(source);
        source.applicationTokens.push('b');
        expect(normalized.applicationTokens).toEqual(['a']);
    });

    test('a legacy summary with no selection object demands reselection', () => {
        const normalized = normalizeIOSScreenTimeSelection(null, ['3 apps selected (Screen Time)']);
        expect(normalized.requiresReselection).toBe(true);
        expect(normalized.applicationCount).toBe(3);
        expect(normalized.applicationTokens).toEqual([]);
    });

    test('counts without tokens are flagged for reselection', () => {
        // Tokens are what actually enforce; a count alone cannot block
        // anything, so the user has to pick again.
        const normalized = normalizeIOSScreenTimeSelection(
            { applicationCount: 4, categoryCount: 0, applicationTokens: [], categoryTokens: [] },
            ['4 apps selected (Screen Time)'],
        );
        expect(normalized.requiresReselection).toBe(true);
        expect(normalized.summaryLabel).toBe('4 apps selected (Screen Time)');
    });

    test('only real tokens count as usable', () => {
        expect(hasUsableIOSScreenTimeSelection({ applicationTokens: ['a'] })).toBe(true);
        expect(hasUsableIOSScreenTimeSelection({ categoryTokens: ['c'] })).toBe(true);
        expect(hasUsableIOSScreenTimeSelection({ applicationCount: 5 })).toBe(false);
        expect(hasUsableIOSScreenTimeSelection(null)).toBe(false);
    });

    test('legacy summaries add up apps and categories across entries', () => {
        const parsed = parseLegacyScreenTimeSummary([
            '2 apps selected (Screen Time)',
            '3 categories selected (Screen Time)',
        ]);
        expect(parsed.applicationCount).toBe(2);
        expect(parsed.categoryCount).toBe(3);
        expect(parsed.requiresReselection).toBe(true);
    });

    test('a singular category entry parses too', () => {
        expect(parseLegacyScreenTimeSummary(['1 category selected (Screen Time)']).categoryCount).toBe(1);
    });

    test('no legacy entries parse to null', () => {
        expect(parseLegacyScreenTimeSummary([])).toBeNull();
        expect(parseLegacyScreenTimeSummary(null)).toBeNull();
    });
});

describe('legacy quick start blocklists', () => {
    // Quick start was removed in v3.9. Saved data from earlier versions can
    // still hold its hidden `isQuickStart` spaces (or `qs-` ids from saves
    // that dropped the flag). The failure must fall towards blocking: a
    // quick start that is enforcing right now becomes an ordinary focus space
    // so its block keeps running; the rest were never meant to be visible and
    // are dropped along with any stale blocks that point at them.
    const now = 1_000_000;

    test('drops quick starts that are not enforcing right now', () => {
        const appData = {
            blocklists: [
                { id: 'qs-1', isQuickStart: true, apps: [] },
                { id: 'qs-2', apps: [] },
                { id: 'keep', apps: [] },
            ],
            activeBlocks: [
                { blocklistId: 'qs-1', startTime: 0, endTime: now - 1 },
                { blocklistId: 'keep', startTime: 0, endTime: now + 1 },
            ],
            schedules: [{ blocklistId: 'qs-2', segments: [] }],
        };
        expect(migrateLegacyQuickStartBlocklists(appData, now)).toBe(true);
        expect(appData.blocklists.map((bl) => bl.id)).toEqual(['keep']);
        expect(appData.activeBlocks.map((b) => b.blocklistId)).toEqual(['keep']);
        expect(appData.schedules).toEqual([]);
    });

    test('promotes a running quick start into an ordinary focus space', () => {
        const appData = {
            blocklists: [{ id: 'qs-1', isQuickStart: true, alwaysShowInSchedule: false, apps: [] }],
            activeBlocks: [{ blocklistId: 'qs-1', startTime: 0, endTime: now + 1 }],
            schedules: [],
        };
        expect(migrateLegacyQuickStartBlocklists(appData, now)).toBe(true);
        expect(appData.blocklists).toHaveLength(1);
        expect('isQuickStart' in appData.blocklists[0]).toBe(false);
        expect(appData.blocklists[0].alwaysShowInSchedule).toBe(true);
        expect(appData.activeBlocks).toHaveLength(1);
    });

    test('a quick start already saved as a focus space is kept, flag stripped', () => {
        const appData = {
            blocklists: [{ id: 'qs-1', isQuickStart: false, emoji: '📚', apps: [] }],
            activeBlocks: [],
            schedules: [],
        };
        expect(migrateLegacyQuickStartBlocklists(appData, now)).toBe(true);
        expect(appData.blocklists).toHaveLength(1);
        expect('isQuickStart' in appData.blocklists[0]).toBe(false);
        expect(appData.blocklists[0].emoji).toBe('📚');
    });

    test('is a no-op on data with no quick starts', () => {
        const appData = {
            blocklists: [{ id: 'abc', apps: [] }],
            activeBlocks: [{ blocklistId: 'abc', startTime: 0, endTime: now + 1 }],
            schedules: [],
        };
        expect(migrateLegacyQuickStartBlocklists(appData, now)).toBe(false);
        expect(appData.blocklists).toHaveLength(1);
        expect(appData.activeBlocks).toHaveLength(1);
    });
});

describe('focus space colours', () => {
    test('collapsed colours are respread across the palette', () => {
        const lists = [
            { id: 'a', color: '#B8D1DE' },
            { id: 'b', color: '#B8D1DE' },
            { id: 'c', color: '#B8D1DE' },
        ];
        expect(healFocusSpaceColors(lists)).toBe(true);
        expect(new Set(lists.map((l) => l.color)).size).toBe(3);
        expect(lists[0].color).toBe(FOCUS_SPACE_COLOR_PALETTE[0]);
    });

    test('missing colours are filled without disturbing existing ones', () => {
        const lists = [{ id: 'a', color: '#B3D2C8' }, { id: 'b' }];
        expect(healFocusSpaceColors(lists)).toBe(true);
        expect(lists[0].color).toBe('#B3D2C8');
        expect(lists[1].color).toBeTruthy();
        expect(lists[1].color).not.toBe('#B3D2C8');
    });

    test('distinct colours are left untouched', () => {
        const lists = [{ id: 'a', color: '#B8D1DE' }, { id: 'b', color: '#B3D2C8' }];
        expect(healFocusSpaceColors(lists)).toBe(false);
    });

    test('empty or missing input is a no-op', () => {
        expect(healFocusSpaceColors([])).toBe(false);
        expect(healFocusSpaceColors(null)).toBe(false);
    });
});

describe('additive Screen Time merge (picker cannot remove while enforcing)', () => {
    const sel = (apps = [], cats = []) => normalizeIOSScreenTimeSelection({
        applicationTokens: apps,
        categoryTokens: cats,
        requiresReselection: false,
    });

    test('a picker result that drops a saved app keeps it', () => {
        // Issue #81: the activity picker returns a *replacement* selection, so
        // deselecting inside it is the one way to unblock an app mid-session.
        const merged = mergeIOSScreenTimeSelectionAdditive(
            sel(['tok-instagram', 'tok-tiktok']),
            sel(['tok-tiktok']),
        );
        expect(merged.applicationTokens).toEqual(
            expect.arrayContaining(['tok-instagram', 'tok-tiktok']),
        );
    });

    test('deselecting everything falls back to the saved selection', () => {
        // The fastest form of the bypass: open Browse, clear it, Done.
        const merged = mergeIOSScreenTimeSelectionAdditive(sel(['tok-instagram']), null);
        expect(merged.applicationTokens).toEqual(['tok-instagram']);
    });

    test('genuinely new picks are still added', () => {
        // Tightening stays free — that is the rule everywhere else.
        const merged = mergeIOSScreenTimeSelectionAdditive(
            sel(['tok-instagram']),
            sel(['tok-instagram', 'tok-x']),
        );
        expect(merged.applicationTokens).toEqual(
            expect.arrayContaining(['tok-instagram', 'tok-x']),
        );
        expect(merged.applicationTokens).toHaveLength(2);
    });

    test('category tokens merge on the same terms', () => {
        const merged = mergeIOSScreenTimeSelectionAdditive(
            sel([], ['cat-social']),
            sel([], ['cat-games']),
        );
        expect(merged.categoryTokens).toEqual(
            expect.arrayContaining(['cat-social', 'cat-games']),
        );
    });

    test('counts describe the merge, not the picker result', () => {
        // A count carried over from the replacement would label "1 app" over a
        // two-token selection, and the summary label is what the modal shows.
        const merged = mergeIOSScreenTimeSelectionAdditive(
            sel(['tok-instagram']),
            normalizeIOSScreenTimeSelection({
                applicationTokens: ['tok-x'],
                applicationCount: 1,
                categoryCount: 0,
                requiresReselection: false,
            }),
        );
        expect(merged.applicationCount).toBe(2);
        expect(merged.categoryCount).toBe(0);
    });

    test('repeated tokens do not accumulate', () => {
        const merged = mergeIOSScreenTimeSelectionAdditive(
            sel(['tok-x', 'tok-x']),
            sel(['tok-x']),
        );
        expect(merged.applicationTokens).toEqual(['tok-x']);
    });

    test('an empty merge is null, not an empty selection', () => {
        // Callers treat null as "no Screen Time selection"; an empty object
        // would render a stray tag.
        expect(mergeIOSScreenTimeSelectionAdditive(null, null)).toBeNull();
        expect(mergeIOSScreenTimeSelectionAdditive(sel([], []), sel([], []))).toBeNull();
    });

    test('a selection needing reselection is repaired by a fresh pick', () => {
        // Tokens the OS can no longer resolve protect nothing, so there is
        // nothing to preserve underneath the new pick.
        const stale = normalizeIOSScreenTimeSelection({
            applicationTokens: [],
            categoryTokens: [],
            applicationCount: 3,
            categoryCount: 0,
            requiresReselection: true,
        });
        const merged = mergeIOSScreenTimeSelectionAdditive(stale, sel(['tok-x']));
        expect(merged.applicationTokens).toEqual(['tok-x']);
        expect(merged.requiresReselection).toBe(false);
    });
});

describe('Screen Time selection at the save boundary', () => {
    const sel = (apps = [], cats = []) => normalizeIOSScreenTimeSelection({
        applicationTokens: apps,
        categoryTokens: cats,
        requiresReselection: false,
    });

    test('a schedule starting after the picker closes preserves the persisted floor', () => {
        const saved = sel(['tok-instagram', 'tok-tiktok']);
        const narrowedBeforeScheduleStarted = sel(['tok-tiktok']);

        const resolved = resolveIOSScreenTimeSelectionForSave(
            saved,
            narrowedBeforeScheduleStarted,
            { mode: 'blocklist', editFrictionRequired: true },
        );

        expect(resolved.applicationTokens).toEqual(['tok-instagram', 'tok-tiktok']);
    });

    test('save rejects an empty selection restored by undo once enforcement resumes', () => {
        const saved = sel(['tok-instagram']);

        const resolved = resolveIOSScreenTimeSelectionForSave(
            saved,
            null,
            { mode: 'blocklist', editFrictionRequired: true },
        );

        expect(resolved.applicationTokens).toEqual(['tok-instagram']);
    });

    test('removal remains allowed while edit friction is not required', () => {
        const resolved = resolveIOSScreenTimeSelectionForSave(
            sel(['tok-instagram', 'tok-tiktok']),
            sel(['tok-tiktok']),
            { mode: 'blocklist', editFrictionRequired: false },
        );

        expect(resolved.applicationTokens).toEqual(['tok-tiktok']);
    });

    test('allow mode remains replacement-based', () => {
        const resolved = resolveIOSScreenTimeSelectionForSave(
            sel(['tok-instagram', 'tok-tiktok']),
            sel(['tok-tiktok']),
            { mode: 'allowlist', editFrictionRequired: true },
        );

        expect(resolved.applicationTokens).toEqual(['tok-tiktok']);
    });
});
