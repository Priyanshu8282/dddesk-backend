// Student online renewal: server-side price, one bill at a time, activated exactly once and only when paid.
const test = require('node:test');
const assert = require('node:assert');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);
const mongoose = require('mongoose');
const { endOfDayIST } = require('../../src/utils/time');

const Payment = require('../../src/models/payment.model');
const Plan = require('../../src/models/plan.model');
const Student = require('../../src/models/student.model');
const couponService = require('../../src/services/coupon.service');
const studentService = require('../../src/services/student.service');
const ledger = require('../../src/services/feeLedger.service');
const svc = require('../../src/services/selfRenewal.service');

const id = () => new mongoose.Types.ObjectId();
const LIB = id(), STU = id(), PLAN = id(), PLAN2 = id();
const plan = { _id: PLAN, libraryId: LIB, name: 'Monthly', price: 1000, discount: 0, finalPrice: 1000, durationType: 'monthly', durationDays: 30, allowRenewal: true, status: true };
const plan2 = { ...plan, _id: PLAN2, name: 'Quarterly', price: 2700, finalPrice: 2700, durationDays: 90 };
let student;
let charges;
const calls = { activate: 0, rollback: [] };

const reset = () => {
    student = { _id: STU, libraryId: LIB, name: 'Asha', status: 'active', planStatus: 'active', planId: PLAN, expiryDate: endOfDayIST(new Date(Date.now() + 5 * 864e5)) }; // stored as the end of the day, like real data
    charges = [];
    calls.activate = 0; calls.rollback = [];
};
const asDoc = (c) => (c ? { ...c, toObject: () => c } : null);
const matchCharge = (c, q) => Object.entries(q).every(([k, v]) => {
    const got = k.split('.').reduce((a, p) => (a == null ? undefined : a[p]), c);
    if (v && typeof v === 'object' && !(v instanceof mongoose.Types.ObjectId) && !(v instanceof Date)) {
        if ('$in' in v) return v.$in.includes(got);
        if ('$lte' in v) return (got || 0) <= v.$lte;
        if ('$lt' in v) return got < v.$lt;
        return true;
    }
    if (v === null) return got == null;
    return String(got) === String(v);
});

// in-memory stand-ins
studentService._internal.loadStudent = async () => ({ ...student });
studentService._internal.loadPlan = async (pid) => (String(pid) === String(PLAN2) ? plan2 : plan);
studentService._internal.notifyMembership = () => {};
studentService._internal.createPlanCharge = async ({ amount, couponCode }) => {
    const disc = couponCode === 'SAVE10' ? 100 : 0;
    const c = { _id: id(), libraryId: LIB, studentId: STU, totalAmount: amount - disc, dueAmount: amount - disc, paidAmount: 0, discountAmount: disc, couponCode, paymentStatus: 'credit', createdAt: new Date() };
    charges.push(c);
    return { pendingCharge: true, charge: c };
};
studentService.activateMembership = async (s) => { calls.activate += 1; student.expiryDate = new Date(Date.now() + 35 * 864e5); return { student: { ...s, expiryDate: student.expiryDate } }; };
couponService.validateCoupon = async ({ code, amount }) => {
    if (code !== 'SAVE10') { const e = new Error('This coupon is not valid'); e.statusCode = 400; throw e; }
    return { coupon: { code: 'SAVE10', title: '10% off' }, discountAmount: Math.min(100, amount) };
};
ledger.rollbackCharge = async (libraryId, chargeId) => { calls.rollback.push(String(chargeId)); const c = charges.find((x) => String(x._id) === String(chargeId)); if (c) c.paymentStatus = 'cancelled'; };
Plan.find = () => ({ sort: () => ({ lean: async () => [plan, plan2] }) });
Plan.findOne = (q) => {
    const p = String(q._id) === String(PLAN2) ? plan2 : plan;
    return Object.assign(Promise.resolve(p), { lean: async () => p });
};
Student.findOne = async () => ({ ...student });
Payment.findOne = (q) => {
    const found = charges.filter((c) => matchCharge(c, q)).sort((a, b) => b.createdAt - a.createdAt)[0];
    return Object.assign(Promise.resolve(asDoc(found)), { sort: () => Promise.resolve(asDoc(found)) });
};
Payment.findById = async (cid) => asDoc(charges.find((c) => String(c._id) === String(cid)));
Payment.updateOne = async (q, u) => {
    const c = charges.find((x) => String(x._id) === String(q._id));
    if (!c) return;
    for (const [k, v] of Object.entries(u.$set || {})) { const ks = k.split('.'); let o = c; ks.slice(0, -1).forEach((p) => { o[p] = o[p] || {}; o = o[p]; }); o[ks.at(-1)] = v; }
    for (const k of Object.keys(u.$unset || {})) delete c[k];
};
Payment.find = (q) => ({ select: () => ({ limit: () => ({ lean: async () => charges.filter((c) => matchCharge(c, q)) }) }) });
Payment.findOneAndUpdate = async (q, u) => {
    const c = charges.find((x) => matchCharge(x, q));
    if (!c) return null;
    for (const [k, v] of Object.entries(u.$set || {})) { const ks = k.split('.'); let o = c; ks.slice(0, -1).forEach((p) => { o[p] = o[p] || {}; o = o[p]; }); o[ks.at(-1)] = v; }
    return c;
};

test('the price comes from the plan and the offer on the server', async () => {
    reset();
    const q = await svc.quote(STU, LIB, { planId: PLAN, couponCode: 'save10' });
    assert.deepStrictEqual([q.price, q.discount, q.payable, q.coupon.code], [1000, 100, 900, 'SAVE10']);
    assert.ok(q.startDate > student.expiryDate, 'a running membership is renewed from the day after it ends');
    await assert.rejects(() => svc.quote(STU, LIB, { planId: PLAN, couponCode: 'NOPE' }), /not valid/);
});

test('a paused membership cannot be renewed online', async () => {
    reset();
    student.planStatus = 'paused';
    await assert.rejects(() => svc.quote(STU, LIB, { planId: PLAN }), /paused/);
});

test('starting twice with the same choice reuses the bill; another choice replaces it', async () => {
    reset();
    const a = await svc.start(STU, LIB, { planId: PLAN, couponCode: 'SAVE10' });
    assert.strictEqual(a.charge.due, 900);
    const again = await svc.start(STU, LIB, { planId: PLAN, couponCode: 'SAVE10' });
    assert.strictEqual(again.reused, true);
    assert.strictEqual(again.charge.chargeId, a.charge.chargeId);
    const other = await svc.start(STU, LIB, { planId: PLAN2 });
    assert.notStrictEqual(other.charge.chargeId, a.charge.chargeId);
    assert.deepStrictEqual(calls.rollback, [a.charge.chargeId]);
});

test('nothing is renewed until the bill is fully paid, and then exactly once', async () => {
    reset();
    const { charge } = await svc.start(STU, LIB, { planId: PLAN });
    assert.strictEqual(await svc.activatePaid(LIB, STU), 0);
    assert.strictEqual(calls.activate, 0);
    const c = charges.find((x) => String(x._id) === charge.chargeId);
    Object.assign(c, { paymentStatus: 'paid', paidAmount: c.totalAmount, dueAmount: 0 });
    assert.strictEqual(await svc.activatePaid(LIB, STU), 1);
    assert.strictEqual(await svc.activatePaid(LIB, STU), 0, 'a second run never renews again');
    assert.strictEqual(calls.activate, 1);
    assert.strictEqual(c.pendingActivation, undefined);
    assert.ok(c.activatedAt);
});

test('cancel drops an unpaid renewal; the sweep drops ones older than two days', async () => {
    reset();
    const { charge } = await svc.start(STU, LIB, { planId: PLAN });
    assert.deepStrictEqual(await svc.cancel(STU, LIB), { cancelled: true });
    assert.ok(calls.rollback.includes(charge.chargeId));
    reset();
    const second = await svc.start(STU, LIB, { planId: PLAN });
    charges[0].pendingActivation.requestedAt = new Date(Date.now() - 3 * 864e5);
    const r = await svc.sweep();
    assert.strictEqual(r.dropped, 1);
    assert.ok(calls.rollback.includes(second.charge.chargeId));
});
