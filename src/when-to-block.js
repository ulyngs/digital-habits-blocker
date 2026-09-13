// "When to block" — the Daily / Weekly / Manual choice in the focus-space editor.
//
// Nothing is stored for the choice itself. A focus space either has a schedule
// record (Daily or Weekly) or it does not (Manual), and Daily is just the
// special case of one segment on every day of the week. Deriving the kind from
// the record means data written by any earlier version lands on the right tab.
//
// Pure helpers only (Tier 0). No DOM, no `state`.
import { resolveOneShotOccurrences } from './schedule-engine.js';

/** Monday-first weekday indices, matching `segment.days`. */
export const ALL_DAYS = Object.freeze([0, 1, 2, 3, 4, 5, 6]);

export const WHEN_TO_BLOCK_KINDS = Object.freeze(['daily', 'weekly', 'manual']);

function cloneSegment(seg) {
    return {
        startHour: seg.startHour,
        startMinute: seg.startMinute,
        endHour: seg.endHour,
        endMinute: seg.endMinute,
        days: Array.isArray(seg.days) ? [...seg.days] : [],
    };
}

function coversEveryDay(days) {
    if (!Array.isArray(days) || days.length !== ALL_DAYS.length) return false;
    const sorted = [...days].sort((a, b) => a - b);
    return sorted.every((day, i) => day === ALL_DAYS[i]);
}

/** @returns {'manual'|'daily'|'weekly'} */
export function deriveWhenToBlockKind(schedule) {
    const segments = Array.isArray(schedule?.segments) ? schedule.segments : [];
    if (segments.length === 0) return 'manual';
    if (segments.length === 1 && coversEveryDay(segments[0].days)) return 'daily';
    return 'weekly';
}

/**
 * The segments a schedule record should carry for `kind`. Daily keeps only the
 * first segment and forces every day; Manual has none; Weekly keeps what it is
 * given. `getDefaults()` supplies segments when there are none to keep.
 * Always returns fresh copies.
 */
export function segmentsForKind(kind, segments, getDefaults) {
    if (kind === 'manual') return [];
    const source = Array.isArray(segments) && segments.length > 0
        ? segments
        : (typeof getDefaults === 'function' ? getDefaults() : []);
    const copies = source.map(cloneSegment);
    if (kind === 'daily') {
        const first = copies[0];
        if (!first) return [];
        first.days = [...ALL_DAYS];
        return [first];
    }
    return copies;
}

/**
 * "Until" offers only "When I stop it" (`forever`) and "Date". Older data can
 * carry `repeatType: 'no'` (one-shot: each segment fires once), or no
 * repeatType at all, which the engine also reads as one-shot. Map that onto a
 * date so the schedule still ends when it was going to; with nothing left
 * ahead it simply repeats. Returns true when the record changed.
 */
export function migrateLegacyRepeatType(schedule, now = Date.now()) {
    if (!schedule || typeof schedule !== 'object') return false;
    if (schedule.repeatType === 'forever' || schedule.repeatType === 'date') return false;

    const occurrences = resolveOneShotOccurrences(schedule)
        .filter((occurrence) => occurrence.end.getTime() > now);
    if (occurrences.length > 0) {
        const last = occurrences[occurrences.length - 1].end;
        const endOfDay = new Date(last.getFullYear(), last.getMonth(), last.getDate(), 23, 59, 59, 999);
        schedule.repeatType = 'date';
        schedule.repeatDate = endOfDay.getTime();
    } else {
        schedule.repeatType = 'forever';
        schedule.repeatDate = null;
    }
    return true;
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

export function formatSegmentRange(seg) {
    return `${pad2(seg.startHour)}:${pad2(seg.startMinute)} – ${pad2(seg.endHour)}:${pad2(seg.endMinute)}`;
}

/**
 * One-line summary for the "When to block" section header.
 * `labels`: { manual, dailyFmt(range), weeklyFmt(days, range), dayNames: string[7], noDays }
 */
export function formatWhenToBlockSummary(kind, segments, labels) {
    if (kind === 'manual' || !Array.isArray(segments) || segments.length === 0) {
        return labels.manual;
    }
    if (kind === 'daily') {
        return labels.dailyFmt(formatSegmentRange(segments[0]));
    }
    const first = segments[0];
    const days = Array.isArray(first.days) ? [...first.days].sort((a, b) => a - b) : [];
    const dayText = days.length === 0
        ? labels.noDays
        : (coversEveryDay(days) ? labels.everyDay : days.map((d) => labels.dayNames[d]).join(', '));
    const range = segments.length > 1
        ? `${formatSegmentRange(first)} +${segments.length - 1}`
        : formatSegmentRange(first);
    return labels.weeklyFmt(dayText, range);
}
