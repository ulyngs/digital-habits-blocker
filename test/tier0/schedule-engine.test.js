import { describe, expect, test } from 'vitest';
import {
    ANDROID_DAY_NAMES_MON0,
    ANDROID_DEFAULT_FRICTION_WORD_COUNT,
    androidDayNamesFromMon0,
    androidFrictionChallengeFields,
    dayIndexMonday0FromDate,
    getRepeatScheduleLastDayInclusiveMs,
    isNonRepeatingSchedule,
    isOneOffBlockEnforced,
    isOneOffBlockStillActive,
    isSchedulePausedNow,
} from '../../src/schedule-engine.js';

describe('Android payload mapping', () => {
    // These build the payload the Kotlin plugin enforces from. A wrong day
    // index or word count does not error — the block just fires on the wrong
    // day, or the friction gate asks for the wrong thing.

    test('Monday-zero day indices map to Kotlin DayOfWeek names', () => {
        expect(androidDayNamesFromMon0([0, 6])).toEqual(['MONDAY', 'SUNDAY']);
        expect(androidDayNamesFromMon0([0, 1, 2, 3, 4, 5, 6])).toEqual(ANDROID_DAY_NAMES_MON0);
    });

    test('out-of-range and non-integer days are dropped', () => {
        expect(androidDayNamesFromMon0([-1, 7, 1.5, null, '2', 3])).toEqual(['THURSDAY']);
        expect(androidDayNamesFromMon0(null)).toEqual([]);
        expect(androidDayNamesFromMon0('MONDAY')).toEqual([]);
    });

    test('custom friction text is sent verbatim with a matching word count', () => {
        const fields = androidFrictionChallengeFields({ type: 'custom', customText: '  I choose to focus  ' });
        expect(fields.frictionCustomText).toBe('I choose to focus');
        expect(fields.frictionWordCount).toBe(4);
    });

    test('a blank custom text falls back to the default word count', () => {
        // Regression guard: a custom difficulty with no usable text must not
        // send frictionCustomText, or the gate asks the user to type nothing.
        const fields = androidFrictionChallengeFields({ type: 'custom', customText: '   ' });
        expect(fields.frictionCustomText).toBeNull();
        expect(fields.frictionWordCount).toBe(ANDROID_DEFAULT_FRICTION_WORD_COUNT);
    });

    test('a word-count difficulty passes its count through', () => {
        expect(androidFrictionChallengeFields({ type: 'words', count: 30 })).toEqual({
            frictionWordCount: 30,
            frictionCustomText: null,
        });
        expect(androidFrictionChallengeFields({ type: 'words', count: '25' }).frictionWordCount).toBe(25);
    });

    test('a missing or nonsensical count falls back to the default', () => {
        for (const difficulty of [undefined, {}, { type: 'words' }, { type: 'words', count: 0 }, { type: 'words', count: 'abc' }]) {
            expect(androidFrictionChallengeFields(difficulty).frictionWordCount)
                .toBe(ANDROID_DEFAULT_FRICTION_WORD_COUNT);
        }
    });
});

describe('schedule repeat classification', () => {
    test('forever and dated repeats are repeating', () => {
        expect(isNonRepeatingSchedule({ repeatType: 'forever' })).toBe(false);
        expect(isNonRepeatingSchedule({ repeatType: 'date', repeatDate: '2026-01-01' })).toBe(false);
    });

    test('everything else is a one-shot', () => {
        expect(isNonRepeatingSchedule({})).toBe(true);
        expect(isNonRepeatingSchedule({ repeatType: 'once' })).toBe(true);
        // A dated repeat with no date cannot recur.
        expect(isNonRepeatingSchedule({ repeatType: 'date' })).toBe(true);
        expect(isNonRepeatingSchedule(null)).toBe(false);
    });

    test('a dated repeat runs to the end of its final day', () => {
        const end = getRepeatScheduleLastDayInclusiveMs({ repeatType: 'date', repeatDate: '2026-03-05' });
        const endDate = new Date(end);
        expect(endDate.getHours()).toBe(23);
        expect(endDate.getMinutes()).toBe(59);
        expect(getRepeatScheduleLastDayInclusiveMs({ repeatType: 'forever' })).toBeNull();
        expect(getRepeatScheduleLastDayInclusiveMs({ repeatType: 'date' })).toBeNull();
    });
});

describe('one-off block enforcement window', () => {
    const now = 1_000_000;

    test('a block is enforced only inside its half-open window', () => {
        expect(isOneOffBlockEnforced({ startTime: now, endTime: now + 1 }, now)).toBe(true);
        // Start is inclusive, end is exclusive.
        expect(isOneOffBlockEnforced({ startTime: now + 1, endTime: now + 2 }, now)).toBe(false);
        expect(isOneOffBlockEnforced({ startTime: now - 2, endTime: now }, now)).toBe(false);
    });

    test('a paused block is not enforced but is still alive', () => {
        const block = { startTime: now - 1, endTime: now + 1, isPaused: true };
        expect(isOneOffBlockEnforced(block, now)).toBe(false);
        // Still active, so resuming brings it back rather than dropping it.
        expect(isOneOffBlockStillActive(block, now)).toBe(true);
    });

    test('an elapsed block is neither enforced nor active', () => {
        const block = { startTime: now - 10, endTime: now - 1 };
        expect(isOneOffBlockEnforced(block, now)).toBe(false);
        expect(isOneOffBlockStillActive(block, now)).toBe(false);
    });

    test('a missing block is handled', () => {
        expect(isOneOffBlockEnforced(null, now)).toBe(false);
        expect(isOneOffBlockStillActive(undefined, now)).toBe(false);
    });
});

describe('schedule pause state', () => {
    const now = 1_000_000;

    test('a pause holds until its end time', () => {
        expect(isSchedulePausedNow({ isPaused: true, pauseEndTime: now + 1 }, now)).toBe(true);
        expect(isSchedulePausedNow({ isPaused: true, pauseEndTime: now }, now)).toBe(false);
    });

    test('a pause with no end time is indefinite', () => {
        // Legacy Android-imported schedules land here; they must stay paused
        // rather than silently resuming on the next sync.
        expect(isSchedulePausedNow({ isPaused: true }, now)).toBe(true);
        expect(isSchedulePausedNow({ isPaused: true, pauseEndTime: 0 }, now)).toBe(true);
    });

    test('an unpaused schedule is never paused', () => {
        expect(isSchedulePausedNow({ isPaused: false, pauseEndTime: now + 1000 }, now)).toBe(false);
        expect(isSchedulePausedNow(null, now)).toBe(false);
    });
});

describe('weekday indexing', () => {
    test('JS Sunday-zero dates convert to Monday-zero indices', () => {
        // 2026-03-02 is a Monday; the JS getDay() Sunday-zero convention is
        // off by one from the Monday-zero arrays used everywhere else.
        expect(dayIndexMonday0FromDate(new Date(2026, 2, 2, 12))).toBe(0);
        expect(dayIndexMonday0FromDate(new Date(2026, 2, 7, 12))).toBe(5);
        expect(dayIndexMonday0FromDate(new Date(2026, 2, 8, 12))).toBe(6);
    });
});
