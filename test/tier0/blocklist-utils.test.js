import { describe, expect, test } from 'vitest';
import {
    ALWAYS_ON_END_TIME,
    FOCUS_SPACE_COLOR_PALETTE,
    QUICK_START_EMOJI,
    healFocusSpaceColors,
    hasUsableIOSScreenTimeSelection,
    isBlockAlwaysOn,
    isProtectedApp,
    isProtectedDomain,
    isQuickStartBlocklist,
    normalizeBlocklist,
    normalizeIOSScreenTimeSelection,
    parseLegacyScreenTimeSummary,
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

describe('quick start blocklists', () => {
    test('an explicit false flag wins over the id prefix', () => {
        // This is what "Save as focus space" produces: the id keeps its
        // `qs-` prefix but the space is now permanent.
        expect(isQuickStartBlocklist({ id: 'qs-1', isQuickStart: false })).toBe(false);
        expect(isQuickStartBlocklist({ id: 'qs-1' })).toBe(true);
        expect(isQuickStartBlocklist({ id: 'abc', isQuickStart: true })).toBe(true);
        expect(isQuickStartBlocklist({ id: 'abc' })).toBe(false);
        expect(isQuickStartBlocklist(null)).toBe(false);
    });

    test('normalizing heals a quick start that lost its flag', () => {
        const normalized = normalizeBlocklist({ id: 'qs-9', apps: [] });
        expect(normalized.isQuickStart).toBe(true);
        expect(normalized.emoji).toBe(QUICK_START_EMOJI);
    });

    test('normalizing leaves a saved focus space alone', () => {
        const normalized = normalizeBlocklist({ id: 'qs-9', isQuickStart: false, emoji: '📚', apps: [] });
        expect(normalized.isQuickStart).toBe(false);
        expect(normalized.emoji).toBe('📚');
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

    test('quick starts are excluded from colour healing', () => {
        const lists = [{ id: 'qs-1' }];
        expect(healFocusSpaceColors(lists)).toBe(false);
        expect(lists[0].color).toBeUndefined();
        expect(healFocusSpaceColors([])).toBe(false);
        expect(healFocusSpaceColors(null)).toBe(false);
    });
});
