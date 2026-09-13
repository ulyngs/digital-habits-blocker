// The on/off switch on every focus-space card.
//
//   Manual space   ON  = an always-on block exists and is not paused
//                  OFF = no block, or the block is paused
//   Daily/Weekly   ON  = its schedule record exists and is not paused
//                  OFF = the schedule is paused (open-ended = switched off,
//                        timed = temporary unlock, chunk 4)
//
// Turning ON never asks anything: it falls toward blocking. Turning OFF goes
// through the override challenge; the `#confirm-override-btn` handler in
// app.js then pauses the schedule open-ended or removes the manual block.
//
// Declarations only at module top level (hub import cycle).
import { state } from './state.js';
import { isSchedulePausedNow } from './schedule-engine.js';
import { isOneOffPauseActive } from './blocklists.js';
import {
    openOverrideModal,
    openScheduleOverrideModal,
    resumePausedBlock,
    resumePausedSchedule,
    startManualBlock,
} from './confirm-modals.js';

function scheduleFor(blocklistId) {
    return (state.appData.schedules || []).find(
        (s) => s.blocklistId === blocklistId && s.segments?.length > 0,
    ) || null;
}

function liveBlockFor(blocklistId, now) {
    return (state.appData.activeBlocks || []).find(
        (b) => b.blocklistId === blocklistId && b.startTime <= now && b.endTime > now,
    ) || null;
}

/** What the switch should show for this space right now. */
export function isFocusSpaceOn(blocklistId, now = Date.now()) {
    const schedule = scheduleFor(blocklistId);
    if (schedule) return !isSchedulePausedNow(schedule, now);
    const block = liveBlockFor(blocklistId, now);
    return !!block && !isOneOffPauseActive(block, now);
}

/** The pause end time that currently keeps this space off, or null when off open-ended / on. */
export function getFocusSpaceOffUntil(blocklistId, now = Date.now()) {
    const schedule = scheduleFor(blocklistId);
    if (schedule) {
        return isSchedulePausedNow(schedule, now) ? (schedule.pauseEndTime || null) : null;
    }
    const block = liveBlockFor(blocklistId, now);
    if (block && isOneOffPauseActive(block, now)) return block.pauseEndTime || null;
    return null;
}

/**
 * Flip the switch. Returns true when the change was applied immediately;
 * false when the override challenge was opened instead (the user still has to
 * pass it) or nothing could be done.
 */
export async function setFocusSpaceEnabled(blocklistId, on, now = Date.now()) {
    const blocklist = state.appData.blocklists.find((bl) => bl.id === blocklistId);
    if (!blocklist) return false;
    const schedule = scheduleFor(blocklistId);
    const block = liveBlockFor(blocklistId, now);

    if (on) {
        if (schedule) {
            if (!isSchedulePausedNow(schedule, now)) return false;
            await resumePausedSchedule(schedule);
            return true;
        }
        if (block) {
            if (!isOneOffPauseActive(block, now)) return false;
            await resumePausedBlock(block);
            return true;
        }
        return startManualBlock(blocklistId);
    }

    if (schedule && !isSchedulePausedNow(schedule, now)) {
        openScheduleOverrideModal(schedule);
        return false;
    }
    if (block && !isOneOffPauseActive(block, now)) {
        openOverrideModal(block.id);
        return false;
    }
    return false;
}
