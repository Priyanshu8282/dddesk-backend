/**
 * Seat sharing by shift. A shift lives on the plan (shiftStart/shiftEnd, HH:mm); a plan without both times is full day.
 * Shifts may cross midnight (22:00 to 06:00). End times are exclusive, so 06:00-14:00 and 14:00-22:00 can share a seat.
 */
const DAY = 24 * 60;
/** Gaps shorter than this (a changeover) do not make a seat "partly free". */
const MIN_FREE_MINUTES = 60;

const FULL_DAY = Object.freeze({ fullDay: true, name: '', start: null, end: null, label: 'Full day' });

/** '06:00', '6:00 AM', '11:00 PM' -> minutes since midnight, or null. */
const toMinutes = (text) => {
    const m = /^\s*(\d{1,2}):(\d{2})\s*([ap]m)?\s*$/i.exec(String(text ?? ''));
    if (!m) return null;
    let h = Number(m[1]);
    const min = Number(m[2]);
    const mer = m[3]?.toLowerCase();
    if (mer === 'pm' && h < 12) h += 12;
    if (mer === 'am' && h === 12) h = 0;
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
};

const hhmm = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

/** The shift of a plan; no plan, a plan without times, or start = end all mean full day. */
const shiftOf = (plan) => {
    const start = toMinutes(plan?.shiftStart);
    const end = toMinutes(plan?.shiftEnd);
    if (start === null || end === null || start === end) return FULL_DAY;
    const times = `${plan.shiftStart}-${plan.shiftEnd}`;
    return { fullDay: false, name: plan.shiftName || '', start: plan.shiftStart, end: plan.shiftEnd, label: plan.shiftName ? `${plan.shiftName} ${times}` : times };
};

/** [from, to) minute ranges of a shift inside one day; a shift across midnight gives two. */
const rangesOf = (shift) => {
    if (shift.fullDay) return [[0, DAY]];
    const s = toMinutes(shift.start);
    const e = toMinutes(shift.end);
    return s < e ? [[s, e]] : [[s, DAY], [0, e]];
};

const overlaps = (a, b) => rangesOf(a).some(([s1, e1]) => rangesOf(b).some(([s2, e2]) => s1 < e2 && s2 < e1));

/** Opening hours as a [from, to) range; unreadable or overnight hours fall back to the whole day. */
const hoursRange = (workingHours) => {
    const open = toMinutes(workingHours?.openingTime);
    const close = toMinutes(workingHours?.closingTime);
    return open !== null && close !== null && open < close ? [open, close] : [0, DAY];
};

/** The parts of the opening hours no shift covers, ignoring short changeover gaps. */
const freeWindows = (shifts, workingHours) => {
    const [open, close] = hoursRange(workingHours);
    if (shifts.some((s) => s.fullDay)) return [];
    const taken = shifts.flatMap(rangesOf).sort((a, b) => a[0] - b[0]);
    const free = [];
    let cursor = open;
    for (const [s, e] of taken) {
        if (s > cursor) free.push([cursor, Math.min(s, close)]);
        cursor = Math.max(cursor, e);
    }
    if (cursor < close) free.push([cursor, close]);
    return free.filter(([s, e]) => e - s >= MIN_FREE_MINUTES).map(([s, e]) => ({ start: hhmm(s), end: hhmm(e) }));
};

/** shiftState: free | partly_free | full | unavailable, plus the free windows of a partly free seat. */
const availabilityOf = (status, shifts, workingHours) => {
    if (status === 'available') return { shiftState: 'free', freeWindows: [] };
    if (status !== 'occupied') return { shiftState: 'unavailable', freeWindows: [] };
    const windows = freeWindows(shifts, workingHours);
    return { shiftState: windows.length ? 'partly_free' : 'full', freeWindows: windows };
};

module.exports = { FULL_DAY, MIN_FREE_MINUTES, toMinutes, shiftOf, overlaps, freeWindows, availabilityOf };
