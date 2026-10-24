// Pure helpers for the dashboards: IST buckets, percentages, series filling. No database access here.
const { IST_OFFSET_MS } = require('./time');

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TZ = 'Asia/Kolkata';

const pad = (n) => String(n).padStart(2, '0');
const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

// Calendar parts of an instant as seen in IST
const istParts = (date = new Date()) => {
  const s = new Date(new Date(date).getTime() + IST_OFFSET_MS);
  return { y: s.getUTCFullYear(), m: s.getUTCMonth(), d: s.getUTCDate(), dow: s.getUTCDay() };
};
// First instant of IST day (y, m, d). Month/day overflow is normalised by Date.UTC.
const istInstant = (y, m, d = 1) => new Date(Date.UTC(y, m, d) - IST_OFFSET_MS);

const monthKey = (y, m) => `${y}-${pad(m + 1)}`;
const dayKey = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;

/** Percent change cur vs prev, one decimal. null when prev is 0 and cur is not (no base to compare). */
const pctChange = (cur, prev) => {
  const c = Number(cur) || 0, p = Number(prev) || 0;
  if (p === 0) return c === 0 ? 0 : null;
  return round1(((c - p) / Math.abs(p)) * 100);
};

/** Share of `part` in `total` as a percent with one decimal (0 when total is 0). */
const percentOf = (part, total) => (total > 0 ? round1((part / total) * 100) : 0);

/** Shares for a list of counts; the last non-zero item absorbs rounding so the list adds to 100. */
const shares = (items, total) => items.map((it) => ({ ...it, percent: percentOf(it.count, total) }));

/**
 * Buckets for a range. Each: { key, label, start, end } (start inclusive, end exclusive, UTC instants cut at IST midnight).
 * kind 'month' -> key YYYY-MM, kind 'day' -> key YYYY-MM-DD.
 * Ranges: year (Jan..current month), 6m (last 6 months), 12m (last 12 months), 30d (last 30 days),
 *         week (Mon..Sun of this week), month (every day of this month), yearFull (Jan..Dec)
 */
const buildBuckets = (range, now = new Date()) => {
  const { y, m, d, dow } = istParts(now);
  const out = [];
  const addMonth = (yy, mm) => {
    const start = istInstant(yy, mm, 1), end = istInstant(yy, mm + 1, 1);
    const norm = istParts(start);
    out.push({ key: monthKey(norm.y, norm.m), label: MONTHS[norm.m], start, end });
  };
  const addDay = (yy, mm, dd, label) => {
    const start = istInstant(yy, mm, dd), end = istInstant(yy, mm, dd + 1);
    const p = istParts(start);
    out.push({ key: dayKey(p.y, p.m, p.d), label: label || String(p.d), start, end });
  };
  let kind = 'month';
  switch (range) {
    case 'year': for (let i = 0; i <= m; i++) addMonth(y, i); break;
    case 'yearFull': for (let i = 0; i < 12; i++) addMonth(y, i); break;
    case '6m': for (let i = 5; i >= 0; i--) addMonth(y, m - i); break;
    case '12m': for (let i = 11; i >= 0; i--) addMonth(y, m - i); break;
    case '7m': for (let i = 6; i >= 0; i--) addMonth(y, m - i); break;
    case '30d': kind = 'day'; for (let i = 29; i >= 0; i--) addDay(y, m, d - i); break;
    case 'week': {
      kind = 'day';
      const mondayOffset = (dow + 6) % 7; // Monday = 0
      for (let i = 0; i < 7; i++) {
        const dayIdx = d - mondayOffset + i;
        const p = istParts(istInstant(y, m, dayIdx));
        addDay(y, m, dayIdx, WEEKDAYS[p.dow]);
      }
      break;
    }
    case 'month': {
      kind = 'day';
      const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      for (let i = 1; i <= daysInMonth; i++) addDay(y, m, i);
      break;
    }
    default: return null;
  }
  return { kind, buckets: out };
};

/** Mongo expression turning a date field into the bucket key in IST. */
const bucketKeyExpr = (field, kind) => ({
  $dateToString: { format: kind === 'day' ? '%Y-%m-%d' : '%Y-%m', date: field, timezone: TZ },
});

/** Align aggregate rows ({_id: key, v: number}) to buckets; missing buckets become 0. Never returns an empty list. */
const fillSeries = (buckets, rows, valueKey = 'v') => {
  const map = new Map((rows || []).map((r) => [r._id, Number(r[valueKey]) || 0]));
  return buckets.map((b) => ({ key: b.key, label: b.label, value: round2(map.get(b.key) || 0) }));
};

/** Running total at the end of each bucket, given the total before the first bucket. */
const cumulative = (series, base = 0) => {
  let run = Number(base) || 0;
  return series.map((p) => { run += p.value; return { ...p, value: run }; });
};

/** KPI card from a monthly series (value = last point of cumulative series or the supplied current value). */
const kpiFromSeries = (series, { value, prev } = {}) => {
  const last = series.length ? series[series.length - 1].value : 0;
  const before = series.length > 1 ? series[series.length - 2].value : 0;
  const cur = value !== undefined ? value : last;
  const pv = prev !== undefined ? prev : before;
  return { value: cur, changePct: pctChange(cur, pv), spark: series };
};

/** Days left until `date` counted in IST calendar days (today = 0, past = negative). */
const daysLeftIST = (date, now = new Date()) => {
  const a = istParts(date), b = istParts(now);
  return Math.round((Date.UTC(a.y, a.m, a.d) - Date.UTC(b.y, b.m, b.d)) / DAY_MS);
};

const SEAT_STATUS = { available: 'available', occupied: 'occupied', reserved: 'reserved', blocked: 'maintenance', maintenance: 'maintenance' };
const normalizeSeatStatus = (s) => SEAT_STATUS[s] || 'available';

/** Group seats ({_id, seatNumber, status}) into rows by alphabetic prefix. Rows and seats sorted naturally. */
const groupSeatsIntoRows = (seats) => {
  const rows = new Map();
  for (const s of seats) {
    const num = String(s.seatNumber || '');
    const mt = /^\s*([A-Za-z]+)\s*[-_ ]?\s*(\d+)\s*$/.exec(num);
    const row = mt ? mt[1].toUpperCase() : '#';
    const n = mt ? Number(mt[2]) : Number.MAX_SAFE_INTEGER;
    if (!rows.has(row)) rows.set(row, []);
    rows.get(row).push({ id: String(s._id), number: num, status: normalizeSeatStatus(s.status), _n: n });
  }
  const collator = new Intl.Collator('en', { numeric: true });
  return [...rows.entries()]
    .sort(([a], [b]) => (a === '#') - (b === '#') || collator.compare(a, b))
    .map(([row, list]) => ({
      row,
      seats: list.sort((x, y) => x._n - y._n || collator.compare(x.number, y.number)).map(({ _n, ...rest }) => rest),
    }));
};

/**
 * Hide sections the user may not see: returns null for sections whose permission is missing.
 * `perm` is { students, seats, attendance, fees, notices } booleans.
 */
const gate = (allowed, build) => (allowed ? build() : null);

module.exports = {
  MONTHS, WEEKDAYS, TZ, pad, round1, round2, istParts, istInstant, monthKey, dayKey,
  pctChange, percentOf, shares, buildBuckets, bucketKeyExpr, fillSeries, cumulative, kpiFromSeries,
  daysLeftIST, groupSeatsIntoRows, normalizeSeatStatus, gate,
};
