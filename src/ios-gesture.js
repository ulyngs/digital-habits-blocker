export const IOS_EDGE_SWIPE_START_MAX_PX = 32;
export const IOS_EDGE_SWIPE_MIN_TRAVEL_PX = 64;
export const IOS_EDGE_SWIPE_HORIZONTAL_RATIO = 1.2;

/**
 * Classify the completed touch geometry used to dismiss an iPhone modal.
 * Keeping this separate from DOM event handling makes the edge/direction gate
 * testable without pretending that a desktop browser has iOS touch events.
 */
export function isIOSLeftEdgeBackSwipe({
    startX,
    endX,
    startY = 0,
    endY = 0,
    touchCount = 1,
    cancelled = false,
} = {}) {
    if (cancelled || touchCount !== 1) return false;
    if (![startX, endX, startY, endY].every(Number.isFinite)) return false;
    if (startX < 0 || startX > IOS_EDGE_SWIPE_START_MAX_PX) return false;

    const travelX = endX - startX;
    const travelY = endY - startY;
    return travelX >= IOS_EDGE_SWIPE_MIN_TRAVEL_PX
        && travelX > Math.abs(travelY) * IOS_EDGE_SWIPE_HORIZONTAL_RATIO;
}
