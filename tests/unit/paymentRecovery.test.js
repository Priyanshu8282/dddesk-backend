// Crash recovery: a desk payment left "processing" is undone and flagged; stuck refunds are only flagged.
const test = require('node:test');
const assert = require('node:assert');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);
const mongoose = require('mongoose');

const PT = require('../../src/models/paymentTransaction.model');
const Payment = require('../../src/models/payment.model');
const id = () => new mongoose.Types.ObjectId();

test('an interrupted collection is taken off the charge, marked failed and for review', async () => {
    const LIB = id(), T1 = id(), T2 = id(), CH = id();
    const txns = [
        { _id: T1, libraryId: LIB, type: 'collection', status: 'processing' }, // half applied when the server stopped
        { _id: T2, libraryId: LIB, type: 'collection', status: 'processing' }, // another server already claimed it
    ];
    const charge = { _id: CH, libraryId: LIB, paidAmount: 800, allocations: [{ transactionId: T1, allocatedAmount: 500 }, { transactionId: id(), allocatedAmount: 300 }] };
    let refundUpdate = null;
    PT.find = () => ({ select: () => ({ limit: () => ({ lean: async () => txns }) }) });
    PT.findOneAndUpdate = async (q, u) => {
        if (String(q._id) === String(T2)) return null;
        const t = txns.find((x) => String(x._id) === String(q._id)); Object.assign(t, u.$set); return t;
    };
    PT.updateMany = async (q, u) => { refundUpdate = { q, u }; return { modifiedCount: 1 }; };
    Payment.find = (q) => ({ select: () => ({ lean: async () => (String(q['allocations.transactionId']) === String(T1) ? [charge] : []) }) });
    Payment.findOne = async () => ({
        ...charge, allocations: [...charge.allocations],
        save: async function () { Object.assign(charge, { paidAmount: this.paidAmount, allocations: this.allocations }); },
    });

    const { reconcileStuckTransactions } = require('../../src/services/feeLedger.service');
    const r = await reconcileStuckTransactions(new Date());

    assert.strictEqual(r.rolledBack, 1);
    assert.strictEqual(charge.paidAmount, 300);
    assert.strictEqual(charge.allocations.length, 1);
    assert.strictEqual(txns[0].status, 'failed');
    assert.strictEqual(txns[0].needsReview, true);
    assert.strictEqual(refundUpdate.q.type, 'refund');
    assert.strictEqual(refundUpdate.u.$set.needsReview, true);
    assert.strictEqual(r.refundsFlagged, 1);
});
