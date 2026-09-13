import { describe, expect, test } from 'vitest';
import {
    DEFAULT_OVERRIDE_WORDS,
    MAX_OVERRIDE_WORDS_DESKTOP,
    MAX_OVERRIDE_WORDS_MOBILE,
    getDifficultyTypingCharCount,
    getMaxOverrideWords,
    getOverrideEstimatedMinutes,
    migrateOverrideDifficultyToWords,
    normalizeOverrideCount,
} from '../../src/override-challenge.js';

describe('word-count limits', () => {
    test('desktop allows 300 words, phones 100', () => {
        expect(getMaxOverrideWords(false)).toBe(MAX_OVERRIDE_WORDS_DESKTOP);
        expect(getMaxOverrideWords(true)).toBe(MAX_OVERRIDE_WORDS_MOBILE);
        expect(MAX_OVERRIDE_WORDS_DESKTOP).toBe(300);
        expect(MAX_OVERRIDE_WORDS_MOBILE).toBe(100);
    });

    test('a count is clamped to [1, max] and nonsense falls back to the default', () => {
        expect(normalizeOverrideCount(0, 'random-words', 300)).toBe(1);
        expect(normalizeOverrideCount(-4, 'random-words', 300)).toBe(1);
        expect(normalizeOverrideCount(999, 'random-words', 300)).toBe(300);
        expect(normalizeOverrideCount('42', 'random-words', 300)).toBe(42);
        expect(normalizeOverrideCount('abc', 'random-words', 300)).toBe(DEFAULT_OVERRIDE_WORDS);
        expect(normalizeOverrideCount(undefined, 'random-words', 100)).toBe(DEFAULT_OVERRIDE_WORDS);
    });

    test('estimates are typed letters at 200 per minute', () => {
        // 15 five-letter words = 75 letters → 1 minute; 300 words = 1500 letters → 8 minutes
        expect(getOverrideEstimatedMinutes('random-words', 15, '')).toBe(1);
        expect(getOverrideEstimatedMinutes('random-words', 300, '')).toBe(8);
        expect(getOverrideEstimatedMinutes('custom', 0, 'x'.repeat(400))).toBe(2);
    });

    test('difficulty workload is letters, so 10 words tie with 50 characters of custom text', () => {
        expect(getDifficultyTypingCharCount({ type: 'random-words', count: 10 })).toBe(50);
        expect(getDifficultyTypingCharCount({ type: 'custom', customText: 'x'.repeat(50) })).toBe(50);
    });
});

describe('migrateOverrideDifficultyToWords', () => {
    // Desktop used to store a character target; iOS/Android already stored
    // words. Gibberish and Max difficulty are gone. The failure must fall
    // toward blocking: a max-difficulty space becomes the platform maximum,
    // and a count above the maximum is clamped, never dropped.
    test('desktop character counts become words (six characters per word)', () => {
        expect(migrateOverrideDifficultyToWords({ type: 'random-words', count: 50 }, { maxWords: 300, countsAreChars: true }))
            .toEqual({ type: 'random-words', count: 8, customText: '' });
        expect(migrateOverrideDifficultyToWords({ type: 'random-words', count: 7500 }, { maxWords: 300, countsAreChars: true }))
            .toEqual({ type: 'random-words', count: 300, customText: '' });
        expect(migrateOverrideDifficultyToWords({ type: 'random-words', count: 3 }, { maxWords: 300, countsAreChars: true }).count).toBe(1);
    });

    test('phone word counts are kept, only clamped to the new maximum', () => {
        expect(migrateOverrideDifficultyToWords({ type: 'random-words', count: 25 }, { maxWords: 100, countsAreChars: false }).count).toBe(25);
        expect(migrateOverrideDifficultyToWords({ type: 'random-words', count: 500 }, { maxWords: 100, countsAreChars: false }).count).toBe(100);
    });

    test('gibberish becomes random words and max difficulty becomes the maximum', () => {
        expect(migrateOverrideDifficultyToWords({ type: 'gibberish', count: 120 }, { maxWords: 300, countsAreChars: true }))
            .toEqual({ type: 'random-words', count: 20, customText: '' });
        expect(migrateOverrideDifficultyToWords(
            { type: 'random-words', count: 7500, maxDifficulty: true, countBeforeMax: 40, typeBeforeMax: 'random-words' },
            { maxWords: 300, countsAreChars: true },
        )).toEqual({ type: 'random-words', count: 300, customText: '' });
        expect(migrateOverrideDifficultyToWords({ type: 'gibberish', maxDifficulty: true }, { maxWords: 100, countsAreChars: false }).count).toBe(100);
    });

    test('custom text survives untouched and gets a sane word count', () => {
        const out = migrateOverrideDifficultyToWords({ type: 'custom', customText: ' I choose focus ', count: 999 }, { maxWords: 300, countsAreChars: true });
        expect(out.type).toBe('custom');
        expect(out.customText).toBe('I choose focus');
        expect(out.count).toBe(DEFAULT_OVERRIDE_WORDS);
    });

    test('missing or malformed input yields the default', () => {
        expect(migrateOverrideDifficultyToWords(null, { maxWords: 300, countsAreChars: true }))
            .toEqual({ type: 'random-words', count: DEFAULT_OVERRIDE_WORDS, customText: '' });
        expect(migrateOverrideDifficultyToWords({ type: 'bogus' }, { maxWords: 300, countsAreChars: false }).type).toBe('random-words');
    });
});
