import { describe, expect, it } from 'vitest';

import { getCalendarLanePresentation } from '../../src/calendar-layout.js';

describe('calendar overlap presentation', () => {
    it('keeps labels for one or two overlapping schedules', () => {
        expect(getCalendarLanePresentation(1, 1).compact).toBe(false);
        expect(getCalendarLanePresentation(2, 2).compact).toBe(false);
    });

    it('uses label-free color bands once three schedules overlap', () => {
        expect(getCalendarLanePresentation(1, 3)).toMatchObject({
            compact: true,
            top: 'calc(0% + 2px)',
            height: 'calc(33.333333333333336% - 4px)',
        });
    });
});
