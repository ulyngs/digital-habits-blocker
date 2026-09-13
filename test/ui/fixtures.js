// Fixture app data for the UI screenshot harness (scripts/ui/shoot.mjs).
//
// These are whole `appData` documents, the same shape `load_data` returns, because
// the harness feeds them to the app through the stubbed Tauri transport and then
// through the `__REDDBLOCK_INTERNALS__.appData` setter. Keep them literal and
// obvious — a fixture that computes its own times is a fixture whose screenshot
// changes meaning depending on when you ran it.
//
// Domains use `.invalid` (RFC 2606) for the same reason the Tier 2 suite does:
// nothing here should ever resolve.

const seg = (startHour, startMinute, endHour, endMinute, days) =>
    ({ startHour, startMinute, endHour, endMinute, days });

// Days are Mon=0 … Sun=6, matching the calendar's internal order.
const MON = 0, TUE = 1, WED = 2, THU = 3, FRI = 4, SAT = 5, SUN = 6;

/**
 * Overlap depth climbs across the week — Mon 2, Tue 3, Wed 4, Fri 5 — with Sat
 * left at a single block as the control, so one screenshot shows every branch of
 * the lane layout at once and you can see where it stops being readable.
 *
 * The five focus spaces deliberately include three similar greens: once a lane
 * is too short for its label, colour is the only remaining identifier, and this
 * is where you find out whether it actually identifies anything.
 */
export const crowdedWeek = {
    blocklists: [
        { id: 'bl-mail', name: 'Mail', emoji: '📬', color: '#7BA05B', websites: ['mail.invalid'], apps: [] },
        { id: 'bl-news', name: 'Morning News', emoji: '📰', color: '#2E8B57', websites: ['news.invalid'], apps: [] },
        { id: 'bl-distract', name: 'Distractions', emoji: '🎯', color: '#4A90D9', websites: ['distract.invalid'], apps: [] },
        { id: 'bl-weekend', name: 'Weekend', emoji: '🌤', color: '#6BAF92', websites: ['weekend.invalid'], apps: [] },
        { id: 'bl-social', name: 'Social Media', emoji: '💬', color: '#E8836A', websites: ['social.invalid'], apps: [] },
    ],
    activeBlocks: [],
    schedules: [
        { id: 's1', blocklistId: 'bl-mail', repeatType: 'forever', segments: [seg(9, 0, 17, 0, [MON, TUE, WED, FRI, SUN])] },
        { id: 's2', blocklistId: 'bl-news', repeatType: 'forever', segments: [seg(7, 30, 18, 30, [MON, TUE, WED, FRI, SUN])] },
        { id: 's3', blocklistId: 'bl-distract', repeatType: 'forever', segments: [seg(10, 0, 16, 0, [TUE, WED, FRI, SUN])] },
        { id: 's4', blocklistId: 'bl-weekend', repeatType: 'forever', segments: [seg(11, 0, 14, 0, [WED, FRI]), seg(12, 0, 15, 0, [SAT])] },
        { id: 's5', blocklistId: 'bl-social', repeatType: 'forever', segments: [seg(12, 0, 13, 30, [FRI])] },
    ],
    startOverlays: [],
    settings: {},
};

/** The uncrowded case, as the baseline the crowded one is judged against. */
export const singleSchedule = {
    blocklists: [
        { id: 'bl-focus', name: 'Deep Work', emoji: '🎯', color: '#4A90D9', websites: ['distract.invalid'], apps: [] },
    ],
    activeBlocks: [],
    schedules: [
        { id: 's1', blocklistId: 'bl-focus', repeatType: 'forever', segments: [seg(9, 0, 12, 30, [MON, TUE, WED, THU, FRI])] },
    ],
    startOverlays: [],
    settings: {},
};

/** A Manual space that is running (always-on block) — the editor's Manual state, locked. */
export const manualRunning = {
    blocklists: [
        { id: 'bl-manual', name: 'No Twitter', emoji: '🎯', color: '#B8D1DE', websites: ['twitter.invalid', 'x.invalid'], apps: ['Slack'] },
    ],
    activeBlocks: [
        { id: 'b1', blocklistId: 'bl-manual', startTime: Date.now() - 60_000, endTime: 253402300799999, isAlwaysOn: true },
    ],
    schedules: [],
    startOverlays: [],
    settings: {},
};

/** Every switch state at once: manual on, manual paused, schedule on, schedule off, idle. */
export const cardStates = {
    blocklists: [
        { id: 'bl-on', name: 'Manual on', emoji: '🎯', color: '#B8D1DE', websites: ['a.invalid'], apps: [] },
        { id: 'bl-paused', name: 'Manual paused', emoji: '💪', color: '#B3D2C8', websites: ['b.invalid'], apps: [] },
        { id: 'bl-sched', name: 'Scheduled', emoji: '📚', color: '#BCD9B6', websites: ['c.invalid'], apps: [] },
        { id: 'bl-sched-off', name: 'Scheduled off', emoji: '📱', color: '#EBDCB6', websites: ['d.invalid'], apps: [] },
        { id: 'bl-idle', name: 'Idle', emoji: '🌳', color: '#EECAAD', websites: ['e.invalid'], apps: [] },
    ],
    activeBlocks: [
        { id: 'b-on', blocklistId: 'bl-on', startTime: Date.now() - 60_000, endTime: 253402300799999, isAlwaysOn: true },
        { id: 'b-paused', blocklistId: 'bl-paused', startTime: Date.now() - 60_000, endTime: 253402300799999, isAlwaysOn: true, isPaused: true, pauseEndTime: Date.now() + 25 * 60_000 },
    ],
    schedules: [
        { id: 's-on', blocklistId: 'bl-sched', repeatType: 'forever', segments: [seg(9, 0, 17, 0, [MON, TUE, WED, THU, FRI])] },
        { id: 's-off', blocklistId: 'bl-sched-off', repeatType: 'forever', isPaused: true, segments: [seg(20, 0, 22, 0, [SAT, SUN])] },
    ],
    startOverlays: [],
    settings: {},
};

export const fixtures = { crowdedWeek, singleSchedule, manualRunning, cardStates };
