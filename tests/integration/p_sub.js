// Part: platform subscription (Razorpay stubbed): order -> verify -> finalize, webhook idempotency, repair, reinstate, lapse.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const L = require('./lib');
const { api, P, U, SRC } = L;

module.exports = (H) => {
  const { ctx, ok, expectStatus, data, msg, T } = H;
  const KEY_SECRET = 'rzp_secret_dummy_value';
  const WH_SECRET = 'whsec_dummy_value';
  const libraryDoc = async (libId = ctx.ids.library) => L.state.mongoose.connection.db.collection('libraries').findOne({ _id: new (L.state.mongoose.Types.ObjectId)(libId) });
  const sign = (orderId, paymentId) => crypto.createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
  const webhook = (event, eventId) => {
    const raw = JSON.stringify(event);
    return api('POST', '/webhook/razorpay', { headers: { 'content-type': 'application/json', 'x-razorpay-signature': crypto.createHmac('sha256', WH_SECRET).update(raw).digest('hex'), ...(eventId ? { 'x-razorpay-event-id': eventId } : {}) }, form: raw });
  };

  test('40 subscription: order, bad signature ignored, good signature extends once, replay safe', async () => {
    const before = await libraryDoc();
    const ord = await api('POST', P('/libraries/subscription/order'), { token: T('owner'), body: { platformPlanId: ctx.ids.platformPlan, period: 'monthly' } });
    ok(ord, 'order');
    const o = data(ord);
    assert.ok(o.orderId, msg(ord));
    // GST is added on top of the (ex-GST) plan price: 999 + 18% = 1178.82
    assert.equal(Number(o.taxableAmount), 999);
    assert.equal(Number(o.totalAmount), 1178.82, 'price + GST: ' + JSON.stringify(o).slice(0, 300));
    assert.equal(L.state.rzOrders.at(-1).amount, 117882, 'gateway charged in paise');
    const payId = 'pay_' + crypto.randomBytes(6).toString('hex');
    const badSig = await api('POST', P('/libraries/subscription/verify'), { token: T('owner'), body: { razorpay_order_id: o.orderId, razorpay_payment_id: payId, razorpay_signature: 'f'.repeat(64) } });
    expectStatus(badSig, 400, 'bad signature');
    const rec = await L.state.mongoose.connection.db.collection('platformpayments').findOne({ razorpayOrderId: o.orderId });
    assert.equal(rec.status, 'pending', 'a forged browser signature must not fail a real order');
    const good = await api('POST', P('/libraries/subscription/verify'), { token: T('owner'), body: { razorpay_order_id: o.orderId, razorpay_payment_id: payId, razorpay_signature: sign(o.orderId, payId) } });
    ok(good, 'verify');
    const after = await libraryDoc();
    assert.ok(new Date(after.subscriptionExpiry) > new Date(before.subscriptionExpiry || 0), 'expiry extended');
    const replay = await api('POST', P('/libraries/subscription/verify'), { token: T('owner'), body: { razorpay_order_id: o.orderId, razorpay_payment_id: payId, razorpay_signature: sign(o.orderId, payId) } });
    ok(replay, 'verify replay');
    const after2 = await libraryDoc();
    assert.equal(new Date(after2.subscriptionExpiry).getTime(), new Date(after.subscriptionExpiry).getTime(), 'replay must not extend twice');
    const diffPay = await api('POST', P('/libraries/subscription/verify'), { token: T('owner'), body: { razorpay_order_id: o.orderId, razorpay_payment_id: 'pay_other', razorpay_signature: sign(o.orderId, 'pay_other') } });
    assert.equal(diffPay.status, 409, 'same order, different payment id');
    const paid = await L.state.mongoose.connection.db.collection('platformpayments').findOne({ razorpayOrderId: o.orderId });
    assert.equal(paid.status, 'paid');
    assert.match(String(paid.invoiceNo || ''), /\d/, 'invoice number assigned: ' + paid.invoiceNo);
    assert.ok(!paid.applyPending, 'applyPending cleared');
    ctx.ids.subOrder = o.orderId; ctx.ids.subPay = payId;
  });

  test('41 invoice numbers are sequential and unique under parallel finalize', async () => {
    const orders = [];
    for (let i = 0; i < 3; i += 1) {
      const ord = await api('POST', P('/libraries/subscription/order'), { token: T('owner'), body: { platformPlanId: ctx.ids.platformPlan, period: 'monthly' } });
      ok(ord, 'order ' + i); orders.push(data(ord).orderId);
    }
    const res = await Promise.all(orders.map((oid, i) => api('POST', P('/libraries/subscription/verify'), { token: T('owner'), body: { razorpay_order_id: oid, razorpay_payment_id: `pay_par_${i}`, razorpay_signature: sign(oid, `pay_par_${i}`) } })));
    res.forEach((r, i) => ok(r, 'verify ' + i));
    const recs = await L.state.mongoose.connection.db.collection('platformpayments').find({ razorpayOrderId: { $in: orders } }).toArray();
    const nos = recs.map((r) => r.invoiceNo);
    assert.equal(new Set(nos).size, 3, 'unique invoice numbers: ' + nos.join(','));
    console.log('INVOICE NUMBERS', nos.join(', '));
  });

  test('42 webhook: bad signature rejected, captured applied once, duplicate event ignored', async () => {
    const ord = await api('POST', P('/libraries/subscription/order'), { token: T('owner'), body: { platformPlanId: ctx.ids.platformPlan, period: 'monthly' } });
    const o = data(ord);
    const bad = await api('POST', '/webhook/razorpay', { headers: { 'content-type': 'application/json', 'x-razorpay-signature': 'a'.repeat(64) }, form: JSON.stringify({ event: 'payment.captured' }) });
    expectStatus(bad, 400, 'bad signature');
    const ev = { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_wh_1', order_id: o.orderId, amount: 117882, status: 'captured', notes: { platformPaymentId: '' } } } } };
    const lib0 = await libraryDoc();
    const w1 = await webhook(ev, 'evt_wh_0001');
    ok(w1, 'webhook captured');
    const lib1 = await libraryDoc();
    assert.ok(new Date(lib1.subscriptionExpiry) > new Date(lib0.subscriptionExpiry), 'webhook settled the order and extended the period');
    const w2 = await webhook(ev, 'evt_wh_0001');
    ok(w2, 'duplicate event'); assert.match(w2.text, /Duplicate/i);
    const w3 = await webhook(ev, 'evt_wh_0002'); // same payment, new event id: the order is already paid
    ok(w3, 'second delivery for an already paid order');
    const lib2 = await libraryDoc();
    assert.equal(new Date(lib2.subscriptionExpiry).getTime(), new Date(lib1.subscriptionExpiry).getTime(), 'no double extension on re-delivery');
    const wrongAmount = await api('POST', P('/libraries/subscription/order'), { token: T('owner'), body: { platformPlanId: ctx.ids.platformPlan, period: 'monthly' } });
    const ev2 = { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_wh_2', order_id: data(wrongAmount).orderId, amount: 100, status: 'captured' } } } };
    ok(await webhook(ev2, 'evt_wh_0003'), 'amount mismatch acknowledged');
    const mismatch = await L.state.mongoose.connection.db.collection('platformpayments').findOne({ razorpayOrderId: data(wrongAmount).orderId });
    assert.notEqual(mismatch.status, 'paid', 'underpaid capture must not activate the plan');
    console.log('AMOUNT MISMATCH record:', mismatch.status, 'needsReview=', mismatch.needsReview);
  });

  test('43 half-applied payment is repaired (crash between "paid" and "extended")', async () => {
    const Lib = L.state.mongoose.connection.db.collection('libraries');
    const lib = await libraryDoc();
    const ord = await api('POST', P('/libraries/subscription/order'), { token: T('owner'), body: { platformPlanId: ctx.ids.platformPlan, period: 'monthly' } });
    const o = data(ord);
    // simulate the crash: payment marked paid with applyPending=true, library untouched
    await L.state.mongoose.connection.db.collection('platformpayments').updateOne({ razorpayOrderId: o.orderId }, { $set: { status: 'paid', razorpayPaymentId: 'pay_crash', paidAt: new Date(Date.now() - 10 * 60 * 1000), applyPending: true } });
    const stuck = await libraryDoc();
    const svc = require(SRC + '/services/subscription.service');
    const n = await svc.repairUnappliedPayments();
    console.log('repairUnappliedPayments ->', JSON.stringify(n));
    const fixed = await libraryDoc();
    assert.ok(new Date(fixed.subscriptionExpiry) > new Date(stuck.subscriptionExpiry), 'repair extended the library');
    const rec = await L.state.mongoose.connection.db.collection('platformpayments').findOne({ razorpayOrderId: o.orderId });
    assert.ok(!rec.applyPending, 'applyPending cleared after repair');
    // repeated repair is a no-op
    await svc.repairUnappliedPayments();
    const again = await libraryDoc();
    assert.equal(new Date(again.subscriptionExpiry).getTime(), new Date(fixed.subscriptionExpiry).getTime(), 'repair is idempotent');
  });

  test('44 lapse -> suspend -> reinstate is not undone by the cron; plan assign reinstates', async () => {
    const cron = require(SRC + '/services/subscriptionCron.service');
    const col = L.state.mongoose.connection.db.collection('libraries');
    const lid = new (L.state.mongoose.Types.ObjectId)(ctx.ids.library2);
    await col.updateOne({ _id: lid }, { $set: { subscriptionExpiry: new Date(Date.now() - 30 * 86400000), subscriptionIsTrial: false } });
    await cron.processLapsed();
    let l2 = await col.findOne({ _id: lid });
    console.log('after lapse: status=', l2.status, 'reason=', l2.statusReason);
    assert.equal(l2.status, 'suspended', 'a library 30 days past expiry (grace 7) is suspended');
    const login = await api('POST', U('/login'), { body: { identifier: 'owner@lib2.test', password: 'Owner#22222' } });
    assert.ok(login.status >= 400, 'suspended library owners cannot sign in: ' + msg(login));
    ok(await api('PATCH', P(`/super/libraries/${ctx.ids.library2}/reinstate`), { token: T('super') }), 'reinstate');
    l2 = await col.findOne({ _id: lid });
    assert.equal(l2.status, 'active');
    await cron.processLapsed();
    l2 = await col.findOne({ _id: lid });
    assert.equal(l2.status, 'active', 'the next cron run must not re-suspend a reinstated library');
    ok(await api('POST', U('/login'), { body: { identifier: 'owner@lib2.test', password: 'Owner#22222' } }), 'owner signs in again');
    // suspended manually, then plan assignment after payment brings it back only for non-payment suspensions
    ok(await api('PATCH', P(`/super/libraries/${ctx.ids.library2}/suspend`), { token: T('super'), body: { reason: 'policy violation' } }), 'manual suspend');
    ok(await api('PATCH', P(`/super/libraries/${ctx.ids.library2}/plan`), { token: T('super'), body: { planId: ctx.ids.platformPlan } }), 'assign plan');
    l2 = await col.findOne({ _id: lid });
    assert.equal(l2.status, 'suspended', 'a manual (non-payment) suspension survives a plan assignment');
    ok(await api('PATCH', P(`/super/libraries/${ctx.ids.library2}/reinstate`), { token: T('super') }), 'reinstate again');
  });

  test('45 reject/approve flow: failed provisioning does not strand a library', async () => {
    const s = await api('POST', U('/register/send-otp'), { body: { mobile: '9876500003' } });
    const v = await api('POST', U('/register/verify-otp'), { body: { mobile: '9876500003', otp: data(s).otp } });
    const reg = await api('POST', U('/register'), { body: { registrationToken: data(v).registrationToken, name: 'Lib Three', ownerName: 'Owner Three', mobile: '9876500003', email: 'owner@lib3.test', password: 'Owner#33333', address: '3 Lane', city: 'Ajmer', state: 'Rajasthan', pincode: '305001', seatCapacity: 10, workingHours: { openingTime: '06:00 AM', closingTime: '10:00 PM' } } });
    expectStatus(reg, 201, 'register 3');
    const id3 = data(reg).library.id;
    expectStatus(await api('PATCH', P(`/super/libraries/${id3}/reject`), { token: T('super'), body: {} }), 400, 'reject needs a reason');
    ok(await api('PATCH', P(`/super/libraries/${id3}/reject`), { token: T('super'), body: { reason: 'incomplete documents' } }), 'reject');
    const login = await api('POST', U('/login'), { body: { identifier: 'owner@lib3.test', password: 'Owner#33333' } });
    assert.ok(login.status >= 400, 'rejected library cannot sign in');
    const dupMobile = await api('POST', U('/register/send-otp'), { body: { mobile: '9876500001' } });
    console.log('send-otp for an already registered owner mobile ->', dupMobile.status);
    ctx.ids.library3 = id3;
  });
};
