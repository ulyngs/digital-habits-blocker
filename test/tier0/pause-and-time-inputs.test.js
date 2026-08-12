import { describe, expect, test } from 'vitest';
import {
    FALLBACK_DEFAULT_PAUSE_MINUTES,
    MAX_DEFAULT_PAUSE_MINUTES,
    clampDefaultPauseMinutes,
    getDefaultPauseMinutes,
} from '../../src/pause-default.js';
import { pad, parseEndTimeBoundedInt } from '../../src/time-inputs.js';
import { state } from '../../src/state.js';

describe('default pause length', () => {
    test('the clamp matches the Kotlin side', () => {
        // Mirrored by coerceDefaultPauseMinutes in util/Prefs.kt — the two
        // must agree or the native gate prefills a different value than the
        // settings row shows.
        expect(clampDefaultPauseMinutes(0)).toBe(1);
        expect(clampDefaultPauseMinutes(-5)).toBe(1);
        expect(clampDefaultPauseMinutes(MAX_DEFAULT_PAUSE_MINUTES + 1)).toBe(MAX_DEFAULT_PAUSE_MINUTES);
        expect(MAX_DEFAULT_PAUSE_MINUTES).toBe(24 * 60);
    });

    test('fractional input is rounded, not truncated', () => {
        expect(clampDefaultPauseMinutes(10.4)).toBe(10);
        expect(clampDefaultPauseMinutes(10.6)).toBe(11);
    });

    test('an unset or invalid setting falls back to the shared default', () => {
        const original = state.appData;
        try {
            for (const settings of [undefined, {}, { defaultPauseMinutes: 0 }, { defaultPauseMinutes: 'abc' }, { defaultPauseMinutes: -3 }]) {
                state.appData = settings === undefined ? undefined : { settings };
                expect(getDefaultPauseMinutes()).toBe(FALLBACK_DEFAULT_PAUSE_MINUTES);
            }
            expect(FALLBACK_DEFAULT_PAUSE_MINUTES).toBe(10);
        } finally {
            state.appData = original;
        }
    });

    test('a configured value is used and clamped', () => {
        const original = state.appData;
        try {
            state.appData = { settings: { defaultPauseMinutes: 45 } };
            expect(getDefaultPauseMinutes()).toBe(45);
            state.appData = { settings: { defaultPauseMinutes: 99_999 } };
            expect(getDefaultPauseMinutes()).toBe(MAX_DEFAULT_PAUSE_MINUTES);
        } finally {
            state.appData = original;
        }
    });
});

describe('time field parsing', () => {
    test('single digits are zero-padded', () => {
        expect(pad(0)).toBe('00');
        expect(pad(7)).toBe('07');
        expect(pad(23)).toBe('23');
    });

    test('typed end-time digits are clamped to their field range', () => {
        expect(parseEndTimeBoundedInt('9', 0, 23)).toBe(9);
        expect(parseEndTimeBoundedInt('99', 0, 23)).toBe(23);
        expect(parseEndTimeBoundedInt('75', 0, 59)).toBe(59);
        expect(parseEndTimeBoundedInt('0', 0, 59)).toBe(0);
    });

    test('non-digits are stripped before parsing', () => {
        expect(parseEndTimeBoundedInt('1a2', 0, 59)).toBe(12);
        expect(parseEndTimeBoundedInt('-5', 0, 23)).toBe(5);
    });

    test('empty input parses to null rather than zero', () => {
        // Returning 0 here would silently rewrite a half-typed field to
        // midnight while the user is still typing.
        expect(parseEndTimeBoundedInt('', 0, 23)).toBeNull();
        expect(parseEndTimeBoundedInt('   ', 0, 23)).toBeNull();
        expect(parseEndTimeBoundedInt('abc', 0, 23)).toBeNull();
        expect(parseEndTimeBoundedInt(null, 0, 23)).toBeNull();
        expect(parseEndTimeBoundedInt(undefined, 0, 23)).toBeNull();
    });
});
