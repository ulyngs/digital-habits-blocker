import { describe, expect, test } from 'vitest';
import {
    isIOSLeftEdgeBackSwipe,
    IOS_EDGE_SWIPE_MIN_TRAVEL_PX,
    IOS_EDGE_SWIPE_START_MAX_PX,
} from '../../src/ios-gesture.js';

describe('iOS handset modal back swipe classification', () => {
    test('accepts a deliberate rightward swipe from the left edge', () => {
        expect(isIOSLeftEdgeBackSwipe({
            startX: IOS_EDGE_SWIPE_START_MAX_PX,
            endX: IOS_EDGE_SWIPE_START_MAX_PX + IOS_EDGE_SWIPE_MIN_TRAVEL_PX,
            startY: 200,
            endY: 210,
            touchCount: 1,
        })).toBe(true);
    });

    test.each([
        ['an interior-origin swipe', { startX: IOS_EDGE_SWIPE_START_MAX_PX + 1, endX: 180, startY: 100, endY: 100 }],
        ['a short swipe', { startX: 0, endX: IOS_EDGE_SWIPE_MIN_TRAVEL_PX - 1, startY: 100, endY: 100 }],
        ['a vertical swipe', { startX: 0, endX: 90, startY: 100, endY: 220 }],
        ['a right-to-left swipe', { startX: 0, endX: -90, startY: 100, endY: 100 }],
        ['a cancelled gesture', { startX: 0, endX: 90, startY: 100, endY: 100, cancelled: true }],
        ['a multi-touch gesture', { startX: 0, endX: 90, startY: 100, endY: 100, touchCount: 2 }],
    ])('ignores %s', (_description, gesture) => {
        expect(isIOSLeftEdgeBackSwipe(gesture)).toBe(false);
    });
});
