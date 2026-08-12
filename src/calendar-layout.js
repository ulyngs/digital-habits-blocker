const COMPACT_CALENDAR_LANE_THRESHOLD = 3;

// Keep dense calendar rows short enough to scan. At three or more overlapping
// schedules, a 38 px row cannot fit readable labels, so the bars become a
// colour-coded overview and expose their full details through their tooltip.
export function getCalendarLanePresentation(lane, totalLanes) {
    const safeTotalLanes = Math.max(1, Math.trunc(totalLanes) || 1);
    const safeLane = Math.min(safeTotalLanes, Math.max(1, Math.trunc(lane) || 1));
    const lanePercent = 100 / safeTotalLanes;

    return {
        top: `calc(${(safeLane - 1) * lanePercent}% + 2px)`,
        height: `calc(${lanePercent}% - 4px)`,
        compact: safeTotalLanes >= COMPACT_CALENDAR_LANE_THRESHOLD,
    };
}
