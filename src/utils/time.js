// Asia/Kolkata (UTC+05:30, no DST) day-boundary helpers
const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const startOfDayIST = (date = new Date()) => {
    const t = new Date(date).getTime() + IST_OFFSET_MS;
    return new Date(Math.floor(t / DAY_MS) * DAY_MS - IST_OFFSET_MS);
};

const endOfDayIST = (date = new Date()) => new Date(startOfDayIST(date).getTime() + DAY_MS - 1);

const todayRangeIST = () => {
    const now = new Date();
    return { start: startOfDayIST(now), end: endOfDayIST(now) };
};

// Start of the IST day that is `n` days after (or before, if negative) the IST day of `date`
const addDaysIST = (date = new Date(), n = 0) => new Date(startOfDayIST(date).getTime() + n * DAY_MS);

// 'YYYY-MM-DD' for the IST calendar day of `date`
const istDateKey = (date = new Date()) => new Date(new Date(date).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

// 'YYYY-MM-DD HH:mm' IST wall-clock string
const toISTString = (date = new Date()) => new Date(new Date(date).getTime() + IST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');

// { start, end } of the IST calendar month containing `date`
const monthRangeIST = (date = new Date()) => {
    const shifted = new Date(new Date(date).getTime() + IST_OFFSET_MS);
    const y = shifted.getUTCFullYear();
    const m = shifted.getUTCMonth();
    const start = new Date(Date.UTC(y, m, 1) - IST_OFFSET_MS);
    const end = new Date(Date.UTC(y, m + 1, 1) - IST_OFFSET_MS - 1);
    return { start, end };
};

module.exports = {
    startOfDayIST, endOfDayIST, todayRangeIST, addDaysIST, istDateKey, toISTString, monthRangeIST,
    IST_OFFSET_MS, DAY_MS
};
