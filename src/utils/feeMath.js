// Pure fee helpers (no DB access): proration, GST split, fiscal-year key.
const { startOfDayIST, DAY_MS, IST_OFFSET_MS } = require('./time');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Indian financial year (1 Apr - 31 Mar, IST) of a date as a 4-digit key: 1 Oct 2026 -> "2627".
 */
const fiscalYearKey = (date = new Date()) => {
    const ist = new Date(new Date(date).getTime() + IST_OFFSET_MS);
    const y = ist.getUTCFullYear();
    const start = ist.getUTCMonth() >= 3 ? y : y - 1; // April = month 3
    return `${String(start % 100).padStart(2, '0')}${String((start + 1) % 100).padStart(2, '0')}`;
};

/**
 * Value of the unused part of a membership period, by whole days remaining.
 *  netAmount   : what the student is liable for on the old membership (after discount / waiver)
 *  periodStart : first day of the period, periodEnd: end of the last day
 *  asOf        : the date the old plan stops being used (start of the new plan)
 * Remaining days are rounded UP (a started day is credited in the student's favour).
 */
const computeProration = ({ netAmount, periodStart, periodEnd, asOf = new Date() }) => {
    const net = Math.max(0, r2(netAmount));
    if (!periodStart || !periodEnd) return { totalDays: 0, remainingDays: 0, credit: 0, used: net };
    const start = startOfDayIST(periodStart).getTime();
    const end = new Date(periodEnd).getTime();
    const totalDays = Math.max(1, Math.ceil((end - start) / DAY_MS));
    const at = new Date(asOf).getTime();
    let remainingDays;
    if (at <= start) remainingDays = totalDays;
    else if (at >= end) remainingDays = 0;
    else remainingDays = Math.min(totalDays, Math.max(0, Math.ceil((end - at) / DAY_MS)));
    const credit = Math.min(net, r2((net * remainingDays) / totalDays));
    return { totalDays, remainingDays, credit, used: r2(net - credit) };
};

/**
 * Split a GST-INCLUSIVE gross amount into taxable value and tax.
 * intraState (same state as the supplier) -> CGST + SGST (half each); otherwise IGST.
 */
const computeGst = ({ gross, rate, intraState = true }) => {
    const g = Math.max(0, r2(gross));
    const pct = Math.max(0, Number(rate) || 0);
    if (g === 0 || pct === 0) return { taxableValue: g, cgst: 0, sgst: 0, igst: 0, totalTax: 0 };
    const taxable = r2(g / (1 + pct / 100));
    const tax = r2(g - taxable);
    if (!intraState) return { taxableValue: taxable, cgst: 0, sgst: 0, igst: tax, totalTax: tax };
    const cgst = r2(tax / 2);
    const sgst = r2(tax - cgst);
    return { taxableValue: taxable, cgst, sgst, igst: 0, totalTax: tax };
};

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

module.exports = { r2, fiscalYearKey, computeProration, computeGst, GSTIN_RE };
