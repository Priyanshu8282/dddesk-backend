// Offline test (no DB, no network): node tests/razorpayRefund.test.js
// Models are replaced by a tiny in-memory store; the Razorpay client is a mock injected via razorpayClient.__setClient.
process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test';
const assert = require('assert');
const path = require('path');
const mongoose = require('mongoose');

const src = (p) => path.join(__dirname, '..', 'src', p);
const stubModule = (p, exp) => { const f = require.resolve(src(p)); require.cache[f] = { id: f, filename: f, loaded: true, exports: exp }; };
stubModule('utils/audit.js', () => {});
stubModule('services/firebase.service.js', { notifyStudent: async () => {}, notifyLibraryAdmins: async () => {} });
stubModule('services/notification.service.js', { notifyEvent: async () => {} });

const PaymentTransaction = require(src('models/paymentTransaction.model.js'));
const Payment = require(src('models/payment.model.js'));
const Library = require(src('models/library.model.js'));
const ReceiptCounter = require(src('models/receiptCounter.model.js'));
const WebhookEvent = require(src('models/webhookEvent.model.js'));

// ---------- in-memory fakes ----------
const same = (a, b) => String(a) === String(b);
const matches = (doc, q) => Object.entries(q).every(([k, cond]) => {
    const v = doc[k];
    if (cond && typeof cond === 'object' && !(cond instanceof mongoose.Types.ObjectId) && !(cond instanceof Date)) {
        if (cond.$in) return cond.$in.some((x) => same(x, v));
        if (cond.$ne !== undefined) return !same(cond.$ne, v);
        if (cond.$lt) return v < cond.$lt;
        return true;
    }
    return same(cond, v);
});
class FDoc {
    constructor(o) { Object.assign(this, o); this.$locals = {}; if (!this._id) this._id = new mongoose.Types.ObjectId(); this.createdAt = this.createdAt || new Date(); }
    set(o) { Object.assign(this, o); return this; }
    async save() { return this; }
}
const txns = [];
PaymentTransaction.create = async (o) => {
    for (const d of txns) {
        if (o.refundRequestId && d.refundRequestId === o.refundRequestId && same(d.libraryId, o.libraryId)) throw Object.assign(new Error('dup'), { code: 11000 });
        if (o.razorpayRefundId && d.razorpayRefundId === o.razorpayRefundId) throw Object.assign(new Error('dup'), { code: 11000 });
    }
    const d = new FDoc({ allocations: [], ...o }); txns.push(d); return d;
};
PaymentTransaction.findOne = async (q) => txns.find((d) => matches(d, q)) || null;
PaymentTransaction.find = async (q) => txns.filter((d) => matches(d, q));
PaymentTransaction.exists = async (q) => !!txns.find((d) => matches(d, q));
PaymentTransaction.findOneAndUpdate = async (q, upd) => { const d = txns.find((x) => matches(x, q)); if (!d) return null; Object.assign(d, upd.$set || {}); return d; };
PaymentTransaction.updateOne = async (q, upd, opts) => {
    const d = txns.find((x) => matches(x, q)); if (!d) return { matchedCount: 0 };
    if (upd.$set) Object.assign(d, upd.$set);
    if (upd.$inc) {
        for (const [k, n] of Object.entries(upd.$inc)) {
            if (k === 'allocations.$[a].refunded') {
                const flt = opts.arrayFilters[0]['a.paymentId'];
                d.allocations.filter((a) => same(a.paymentId, flt)).forEach((a) => { a.refunded = (a.refunded || 0) + n; });
            }
        }
    }
    return { matchedCount: 1 };
};
let seq = 0;
// receipt numbers are per financial year now: fySeq[<yyyy>] holds the last number used
ReceiptCounter.findOneAndUpdate = async () => { seq += 1; return { seq, fySeq: new Proxy({}, { get: () => seq }) }; };
Library.findById = () => ({ select: () => ({ lean: async () => ({ receipt: { prefix: 'RCPT' } }) }) });
WebhookEvent.create = async () => ({});
WebhookEvent.deleteOne = async () => ({});

const libraryId = new mongoose.Types.ObjectId();
const studentId = new mongoose.Types.ObjectId();
const charges = [];
Payment.findOne = async (q) => charges.find((c) => matches(c, q)) || null;
const mkCharge = (paid) => {
    const c = new FDoc({ libraryId, studentId, paymentStatus: 'paid', paidAmount: paid, refundAmount: 0, allocations: [], adjustments: [] });
    charges.push(c); return c;
};
const mkSuccessTxn = (charge, amt, method, razorpayPaymentId) => {
    const t = new FDoc({ libraryId, studentId, type: 'collection', status: 'success', amount: amt, method, razorpayPaymentId, allocations: [{ paymentId: charge._id, amount: amt, refunded: 0 }] });
    txns.push(t);
    charge.allocations.push({ transactionId: t._id, allocatedAmount: amt, refundedAmount: 0 });
    return t;
};

// Student model is not needed by refundPayment; Payment fake replaces DB access.
const ledger = require(src('services/feeLedger.service.js'));
const ApiError = require(src('utils/ApiError.js'));
const { __setClient } = require(src('services/razorpayClient.js'));
const rzCtl = require(src('controllers/razorpay.controller.js'));

// ---------- mock Razorpay ----------
let calls = [];
let refundImpl;
let listImpl = async () => ({ items: [] });
__setClient({ payments: { refund: async (id, body) => { calls.push({ id, body }); return refundImpl(id, body); }, fetchMultipleRefund: async (id) => listImpl(id) } });
let rfCount = 0;
refundImpl = async (id, body) => ({ id: `rfnd_${++rfCount}`, payment_id: id, amount: body.amount, notes: body.notes });

const admin = { userType: 'admin', permissions: [], user: { _id: new mongoose.Types.ObjectId() } };
const staffNoAdjust = { userType: 'staff', permissions: ['fees.refund'], user: { _id: new mongoose.Types.ObjectId() } };
const R = (extra) => ledger.refundPayment({ libraryId, reason: 'Student left', req: admin, ...extra });
const rejects = async (p, status, msgRx) => {
    try { await p; } catch (e) {
        assert(e instanceof ApiError, `expected ApiError, got ${e && e.stack}`);
        assert.strictEqual(e.statusCode, status, `status ${e.statusCode}: ${e.message}`);
        if (msgRx) assert(msgRx.test(e.message), `message "${e.message}"`);
        return e;
    }
    assert.fail('expected rejection');
};
const results = [];
const test = async (name, fn) => { await fn(); results.push(name); console.log('ok -', name); };

(async () => {
    const charge = mkCharge(1000);
    const online = mkSuccessTxn(charge, 1000, 'online', 'pay_ONLINE1');

    await test('success: partial refund in paise, ledger + R- receipt + refund id stored', async () => {
        calls = [];
        const t = await R({ transactionId: online._id, paymentId: charge._id, amount: 400.5, requestId: 'req-00000001' });
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].id, 'pay_ONLINE1');
        assert.strictEqual(calls[0].body.amount, 40050);
        assert.strictEqual(calls[0].body.speed, 'normal');
        assert.strictEqual(calls[0].body.notes.refundRequestId, 'req-00000001');
        assert.strictEqual(t.status, 'success');
        assert(/-R-\d{4}-\d{6}$/.test(t.receiptNumber), t.receiptNumber); // RCPT-R-<financial year>-<sequence>
        assert.strictEqual(t.razorpayRefundId, 'rfnd_1');
        assert.strictEqual(t.method, 'online');
        assert.strictEqual(charge.refundAmount, 400.5);
        assert.strictEqual(online.allocations[0].refunded, 400.5);
    });

    await test('duplicate request id is idempotent (no second gateway call, no second ledger change)', async () => {
        calls = [];
        const t = await R({ transactionId: online._id, paymentId: charge._id, amount: 400.5, requestId: 'req-00000001' });
        assert.strictEqual(calls.length, 0);
        assert.strictEqual(t.$locals.replay, true);
        assert.strictEqual(charge.refundAmount, 400.5);
        await rejects(R({ transactionId: online._id, paymentId: charge._id, amount: 10, requestId: 'req-00000001' }), 409);
    });

    await test('paise rounding for odd amounts (10.07 -> 1007)', async () => {
        calls = [];
        await R({ transactionId: online._id, paymentId: charge._id, amount: 10.07, requestId: 'req-00000002' });
        assert.strictEqual(calls[0].body.amount, 1007);
        assert.strictEqual(charge.refundAmount, 410.57);
    });

    await test('refund exceeding remaining/captured amount rejected before the gateway', async () => {
        calls = [];
        await rejects(R({ transactionId: online._id, paymentId: charge._id, amount: 600, requestId: 'req-00000003' }), 400, /exceeds/);
        assert.strictEqual(calls.length, 0);
        assert.strictEqual(charge.refundAmount, 410.57);
        // captured guard: receipt lies about allocations vs amount
        const c2 = mkCharge(2000);
        const t2 = mkSuccessTxn(c2, 500, 'online', 'pay_SMALL');
        t2.allocations[0].amount = 2000; // inconsistent data: allocation larger than the captured amount
        await rejects(R({ transactionId: t2._id, paymentId: c2._id, amount: 1500, requestId: 'req-00000004' }), 400, /captured/);
        assert.strictEqual(calls.length, 0);
    });

    await test('gateway rejection: 502, dues unchanged, attempt failed; retry with same id then succeeds', async () => {
        calls = [];
        refundImpl = async () => { throw { statusCode: 400, error: { code: 'BAD_REQUEST_ERROR', description: 'secret internal detail' } }; };
        const e = await rejects(R({ transactionId: online._id, paymentId: charge._id, amount: 50, requestId: 'req-00000005' }), 502);
        assert(!/secret/.test(e.message), 'gateway detail must not leak');
        assert.strictEqual(charge.refundAmount, 410.57);
        const att = txns.find((t) => t.refundRequestId === 'req-00000005');
        assert.strictEqual(att.status, 'failed');
        assert.strictEqual(att.gatewayUnknown, false);
        refundImpl = async (id, body) => ({ id: `rfnd_${++rfCount}`, payment_id: id, amount: body.amount, notes: body.notes });
        const t = await R({ transactionId: online._id, paymentId: charge._id, amount: 50, requestId: 'req-00000005' });
        assert.strictEqual(t.status, 'success');
        assert.strictEqual(t._id, att._id);
        assert.strictEqual(charge.refundAmount, 460.57);
    });

    await test('ambiguous gateway failure: retry verifies at gateway and adopts the existing refund (no double refund)', async () => {
        calls = [];
        refundImpl = async () => { throw new Error('socket hang up'); };
        await rejects(R({ transactionId: online._id, paymentId: charge._id, amount: 20, requestId: 'req-00000006' }), 502);
        const att = txns.find((t) => t.refundRequestId === 'req-00000006');
        assert.strictEqual(att.status, 'failed');
        assert.strictEqual(att.gatewayUnknown, true);
        assert.strictEqual(charge.refundAmount, 460.57);
        const before = calls.length;
        listImpl = async () => ({ items: [{ id: 'rfnd_existing', notes: { refundRequestId: 'req-00000006' } }] });
        const t = await R({ transactionId: online._id, paymentId: charge._id, amount: 20, requestId: 'req-00000006' });
        assert.strictEqual(calls.length, before, 'must not call refund again');
        assert.strictEqual(t.razorpayRefundId, 'rfnd_existing');
        assert.strictEqual(charge.refundAmount, 480.57);
        listImpl = async () => ({ items: [] });
        refundImpl = async (id, body) => ({ id: `rfnd_${++rfCount}`, payment_id: id, amount: body.amount, notes: body.notes });
    });

    await test('webhook refund.processed after success is a no-op (matched on razorpayRefundId)', async () => {
        const send = async (rf, eventId) => {
            const body = { event: 'refund.processed', payload: { refund: { entity: rf } } };
            const raw = Buffer.from(JSON.stringify(body));
            const res = { code: 0, status(c) { this.code = c; return this; }, json(j) { this.body = j; return this; } };
            await rzCtl.webhookHandler({ headers: { 'x-razorpay-signature': rzCtl.hmac('whsec_test', raw), 'x-razorpay-event-id': eventId }, rawBody: raw, body }, res);
            return res;
        };
        const nBefore = txns.filter((t) => t.type === 'refund').length;
        const r1 = await send({ id: 'rfnd_1', payment_id: 'pay_ONLINE1', amount: 40050, notes: { refundRequestId: 'req-00000001' } }, 'ev1');
        assert.strictEqual(r1.code, 200);
        assert.strictEqual(txns.filter((t) => t.type === 'refund').length, nBefore);
        assert.strictEqual(charge.refundAmount, 480.57);
        // webhook racing the API (pending record with that request id, no gateway id yet) is also a no-op
        txns.push(new FDoc({ libraryId, studentId, type: 'refund', status: 'processing', amount: 5, refundRequestId: 'req-inflight-1', method: 'online' }));
        await send({ id: 'rfnd_race', payment_id: 'pay_ONLINE1', amount: 500, notes: { refundRequestId: 'req-inflight-1' } }, 'ev2');
        assert.strictEqual(charge.refundAmount, 480.57);
        // dashboard refund (unknown to us): applied exactly once, replay ignored
        await send({ id: 'rfnd_dash', payment_id: 'pay_ONLINE1', amount: 1000, notes: {} }, 'ev3');
        assert.strictEqual(charge.refundAmount, 490.57);
        const dash = txns.find((t) => t.razorpayRefundId === 'rfnd_dash');
        assert(dash && dash.status === 'success');
        calls = [];
        await send({ id: 'rfnd_dash', payment_id: 'pay_ONLINE1', amount: 1000, notes: {} }, 'ev4');
        assert.strictEqual(charge.refundAmount, 490.57);
        assert.strictEqual(calls.length, 0, 'webhook must never call the gateway');
    });

    await test('cash / non-online payments stay bookkeeping-only', async () => {
        calls = [];
        const c3 = mkCharge(300);
        const cash = mkSuccessTxn(c3, 300, 'cash');
        const t = await R({ transactionId: cash._id, paymentId: c3._id, amount: 100 });
        assert.strictEqual(calls.length, 0);
        assert.strictEqual(t.status, 'success');
        assert.strictEqual(t.method, 'cash');
        assert.strictEqual(c3.refundAmount, 100);
    });

    await test('refundToGateway=false: needs fees.adjust + reason noting manual refund', async () => {
        calls = [];
        const c4 = mkCharge(200);
        const on = mkSuccessTxn(c4, 200, 'online', 'pay_MANUAL');
        await rejects(R({ transactionId: on._id, paymentId: c4._id, amount: 50, refundToGateway: false }), 400, /manual/i);
        await rejects(R({ transactionId: on._id, paymentId: c4._id, amount: 50, refundToGateway: false, reason: 'manual cash refund', req: staffNoAdjust }), 403);
        const t = await R({ transactionId: on._id, paymentId: c4._id, amount: 50, refundToGateway: false, reason: 'Manual refund done in bank' });
        assert.strictEqual(calls.length, 0);
        assert.strictEqual(t.status, 'success');
        assert.strictEqual(c4.refundAmount, 50);
    });

    console.log(`\nALL REFUND TESTS PASSED (${results.length})`);
    process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
