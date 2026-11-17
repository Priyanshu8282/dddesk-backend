// Receipt and refund numbers: two separate per-financial-year series, so receipts never get gaps.
const test = require('node:test');
const assert = require('node:assert');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);

const RC = require('../../src/models/receiptCounter.model');
const Library = require('../../src/models/library.model');
const PT = require('../../src/models/paymentTransaction.model');

let doc = null; // the library's counter document
const get = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
const put = (o, p, v) => { const ks = p.split('.'); let a = o; ks.slice(0, -1).forEach((k) => { a[k] = a[k] || {}; a = a[k]; }); a[ks.at(-1)] = v; };
const match = (q) => doc && Object.entries(q).every(([k, v]) => k === 'libraryId' || (v && v.$exists !== undefined ? (get(doc, k) !== undefined) === v.$exists : true));
RC.exists = async (q) => match(q);
RC.findOne = () => ({ lean: async () => doc });
RC.updateOne = async (q, u, o = {}) => {
    if (!match(q)) { if (!o.upsert) return; doc = doc || {}; }
    for (const [k, v] of Object.entries(u.$set || {})) put(doc, k, v);
    for (const [k, v] of Object.entries(u.$max || {})) put(doc, k, Math.max(get(doc, k) ?? -Infinity, v));
};
RC.findOneAndUpdate = async (q, u, o = {}) => {
    if (!match(q)) { if (!o.upsert) return null; doc = doc || {}; }
    for (const [k, v] of Object.entries(u.$inc || {})) put(doc, k, (get(doc, k) || 0) + v);
    return JSON.parse(JSON.stringify(doc));
};
Library.findById = () => ({ select: () => ({ lean: async () => ({ receipt: { prefix: 'RCPT' } }) }) });
let oldRefunds = [];
PT.find = () => ({ select: () => ({ lean: async () => oldRefunds }) });

const { nextReceiptNo } = require('../../src/services/feeLedger.service');
const when = new Date('2026-11-10T10:00:00+05:30'); // financial year 2026-27

test('refunds take nothing out of the receipt series', async () => {
    doc = null; oldRefunds = [];
    const out = [];
    for (const k of ['receipt', 'receipt', 'refund', 'receipt', 'refund', 'receipt']) out.push(await nextReceiptNo('L', k, when));
    assert.deepStrictEqual(out.filter((s) => !s.includes('-R-')).map((s) => s.slice(-2)), ['01', '02', '03', '04']);
    assert.deepStrictEqual(out.filter((s) => s.includes('-R-')).map((s) => s.slice(-2)), ['01', '02']);
    assert.match(out[2], /^RCPT-R-2627-000001$/);
});

test('the refund series continues after refunds numbered from the old shared counter', async () => {
    doc = { fySeq: { 2627: 9 } };
    oldRefunds = [{ receiptNumber: 'RCPT-R-2627-000004' }, { receiptNumber: 'RCPT-R-2627-000007' }];
    assert.strictEqual(await nextReceiptNo('L', 'refund', when), 'RCPT-R-2627-000008');
    assert.strictEqual(await nextReceiptNo('L', 'receipt', when), 'RCPT-2627-000010');
});
