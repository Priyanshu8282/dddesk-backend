// Part: what reaches the library owner outside the app (library status, subscription reminders) through stubbed email and
// SMS providers, plus the one-time receipt tax backfill. The real transports are never touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const L = require('./lib');
const { api, P, SRC } = L;

module.exports = (H) => {
  const { ctx, ok, T } = H;
  const svc = (n) => require(`${SRC}/services/${n}`);
  const model = (n) => require(`${SRC}/models/${n}.model`);
  const DAY = 24 * 60 * 60 * 1000;

  // Providers are restored after every test: other parts run with none registered
  const withProviders = async (send, fn) => {
    const { registerProvider } = svc('notification.service');
    registerProvider('email', { send: send('email') });
    registerProvider('sms', { send: send('sms') });
    try { await fn(); } finally { registerProvider('email', null); registerProvider('sms', null); }
  };
  const recording = async (fn) => {
    const sent = { email: [], sms: [] };
    await withProviders((ch) => async (m) => { sent[ch].push(m); }, () => fn(sent));
  };

  let serial = 0;
  const registerLibrary = async ({ email = true } = {}) => {
    serial += 1;
    const n = String(serial).padStart(3, '0');
    const mobile = `9876600${n}`;
    const { library, admin } = await svc('admin.service').createLibraryWithAdmin({
      name: `Notice Lib ${n}`, ownerName: `Owner ${n}`, mobile, ...(email ? { email: `notice${n}@lib.test` } : {}),
      password: 'Owner#12345', address: '1 Road', city: 'Jaipur', state: 'Rajasthan', pincode: '302001', seatCapacity: 10,
    }, null, null);
    return { id: String(library._id), mobile, email: admin.email, placeholder: admin.emailIsPlaceholder };
  };

  const act = (lib, verb, body) => api('PATCH', P(`/super/libraries/${lib.id}/${verb}`), { token: T('super'), ...(body ? { body } : {}) });
  const update = (lib, set) => model('library').updateOne({ _id: lib.id }, { $set: set });

  // Status notices are sent after the response on purpose, so the test waits for the inbox row written once delivery is done
  const notice = async (lib, status) => {
    const Notification = model('notification');
    for (let i = 0; i < 100; i += 1) {
      const row = await Notification.findOne({ libraryId: lib.id, event: 'library-status', 'data.type': `library_${status}` }).lean();
      if (row) return row;
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.fail(`no ${status} notice for ${lib.id}`);
  };
  const deliveryOf = (row, channel) => row.deliveries.find((d) => d.channel === channel);
  const to = (list, addr) => list.filter((m) => m.to === addr);

  test('owner notice: approval reaches email and SMS with next steps, with the library SMS switch at its default', () => recording(async (sent) => {
    const lib = await registerLibrary();
    ok(await act(lib, 'approve'), 'approve');
    const row = await notice(lib, 'approved');
    assert.equal(deliveryOf(row, 'email').status, 'sent');
    assert.equal(deliveryOf(row, 'sms').status, 'sent', 'an account notice is not subject to the library SMS switch');
    const [mail] = to(sent.email, lib.email);
    const [sms] = to(sent.sms, lib.mobile);
    assert.ok(mail && sms, 'one email and one SMS');
    assert.equal(mail.title, 'Library approved');
    assert.match(mail.message, /has been approved\. Next: log in .*profile, seats and plans/);
    assert.doesNotMatch(mail.message, /Reason:/, 'next steps are not presented as a reason');
    assert.equal(sms.message, mail.message);
  }));

  test('owner notice: rejection and suspension carry the reason and send the owner to support', () => recording(async (sent) => {
    const general = (supportEmail) => api('PUT', P('/super/platform-settings/section/general'), { token: T('super'), body: { supportEmail } });
    ok(await general('help@dd.test'), 'set support email');
    try {
      const lib = await registerLibrary();
      ok(await act(lib, 'reject', { reason: 'Address proof is unreadable' }), 'reject');
      await notice(lib, 'rejected');
      assert.match(to(sent.email, lib.email)[0].message, /has been rejected\. Reason: Address proof is unreadable\. Next: .*contact support at help@dd\.test/);
      assert.match(to(sent.sms, lib.mobile)[0].message, /Reason: Address proof is unreadable\./);

      const active = await registerLibrary();
      ok(await act(active, 'approve'), 'approve');
      ok(await act(active, 'suspend', { reason: 'Terms breach.' }), 'suspend');
      await notice(active, 'suspended');
      const mail = to(sent.email, active.email).find((m) => m.title === 'Library suspended');
      assert.match(mail.message, /Reason: Terms breach\. Next: contact support at help@dd\.test/);
    } finally { ok(await general(''), 'clear support email'); }
  }));

  test('owner notice: reinstating tells the owner what is next, including a renewal deadline after a lapse', () => recording(async (sent) => {
    const lib = await registerLibrary();
    ok(await act(lib, 'approve'), 'approve');
    ok(await act(lib, 'suspend', { reason: 'Review' }), 'suspend');
    ok(await act(lib, 'reinstate'), 'reinstate');
    await notice(lib, 'reinstated');
    assert.match(to(sent.sms, lib.mobile).find((m) => /reinstated/.test(m.message)).message, /Next: log in/);

    const lapsed = await registerLibrary();
    await update(lapsed, { status: 'suspended', statusReason: 'Review', trialEndsAt: new Date(Date.now() - 60 * DAY) });
    ok(await act(lapsed, 'reinstate'), 'reinstate lapsed');
    await notice(lapsed, 'reinstated');
    assert.match(to(sent.email, lapsed.email).find((m) => /reinstated/.test(m.message)).message, /Next: renew your plan by \d{4}-\d{2}-\d{2}/);
  }));

  test('owner notice: a plan assignment that lifts a non-payment suspension is announced too', () => recording(async (sent) => {
    const { SUSPEND_REASON } = require(`${SRC}/utils/subscriptionLifecycle`);
    const lib = await registerLibrary();
    await update(lib, { status: 'suspended', statusReason: SUSPEND_REASON });
    ok(await act(lib, 'plan', { planId: ctx.ids.platformPlan }), 'assign plan');
    await notice(lib, 'reinstated');
    assert.equal(to(sent.email, lib.email).length, 1);
  }));

  test('owner notice: a placeholder email is never mailed and SMS still goes out; a real address replaces it', () => recording(async (sent) => {
    const lib = await registerLibrary({ email: false });
    assert.ok(lib.placeholder && /\.invalid$/.test(lib.email), 'mobile-only owner has a generated address');
    const res = await act(lib, 'approve');
    ok(res, 'approve');
    const row = await notice(lib, 'approved');
    assert.equal(to(sent.email, lib.email).length, 0, 'nothing sent to the placeholder');
    assert.equal(deliveryOf(row, 'email').status, 'skipped');
    assert.equal(to(sent.sms, lib.mobile).length, 1);
    assert.equal(res.body.data?.onboarding?.ownerEmail ?? res.body.onboarding?.ownerEmail ?? null, null, 'the placeholder is not offered as the owner address');

    await svc('superLibrary.service').updateLibrary(lib.id, { email: 'real.owner@lib.test' }, null, '127.0.0.1');
    const owner = await model('admin').findOne({ libraryId: lib.id, userType: 'admin' }).lean();
    assert.equal(owner.emailIsPlaceholder, false, 'a real address is mailed from now on');
    await svc('notification.service').notifyLibraryStatus(lib.id, 'reinstated', '', { ownerId: owner._id });
    assert.equal(to(sent.email, 'real.owner@lib.test').length, 1);
  }));

  test('owner notice: failing or hanging providers never fail the approval or a status change', async () => {
    await withProviders(() => async () => { throw new Error('provider down'); }, async () => {
      const lib = await registerLibrary();
      ok(await act(lib, 'approve'), 'approve with failing providers');
      const row = await notice(lib, 'approved');
      assert.equal(deliveryOf(row, 'email').status, 'failed');
      assert.equal(deliveryOf(row, 'sms').status, 'failed');
      assert.equal((await model('library').findById(lib.id).lean()).status, 'active');
    });
    await withProviders(() => () => new Promise(() => {}), async () => {
      const lib = await registerLibrary();
      ok(await act(lib, 'approve'), 'approve with hanging providers');
      ok(await act(lib, 'suspend', { reason: 'Review' }), 'suspend with hanging providers');
      assert.equal((await model('library').findById(lib.id).lean()).status, 'suspended');
    });
  });

  test('owner notice: renewal and trial-ending reminders reach email and SMS, once per stage', () => recording(async (sent) => {
    const { sendRenewalReminders } = svc('subscriptionCron.service');
    const trial = await registerLibrary();
    await update(trial, { status: 'active', trialEndsAt: new Date(Date.now() + 2.5 * DAY), subscriptionIsTrial: true });
    const paid = await registerLibrary();
    await update(paid, { status: 'active', subscriptionExpiry: new Date(Date.now() + 6.5 * DAY), subscriptionPlan: 'Growth' });

    await sendRenewalReminders();
    await sendRenewalReminders();

    for (const lib of [trial, paid]) {
      assert.equal(to(sent.email, lib.email).length, 1, 'one reminder email');
      assert.equal(to(sent.sms, lib.mobile).length, 1, 'one reminder SMS');
      const row = await model('notification').findOne({ libraryId: lib.id, event: 'subscription-expiring' }).lean();
      assert.equal(deliveryOf(row, 'email').status, 'sent');
      assert.equal(deliveryOf(row, 'sms').status, 'sent');
    }
    assert.match(to(sent.email, paid.email)[0].message, /Your Growth subscription ends on/);
  }));

  test('receipt tax backfill: dry run writes nothing, apply snapshots issued receipts once', async () => {
    const { backfill } = require(path.join(SRC, '..', 'scripts', 'backfill_receipt_tax.js'));
    const Txn = model('paymentTransaction');
    const Oid = L.state.mongoose.Types.ObjectId;
    const quiet = { log: () => {} };

    const gst = await registerLibrary();
    await update(gst, { gstNumber: '08ABCDE1234F1Z5', state: 'Rajasthan', feeTax: { gstEnabled: true, gstRate: 18, sacCode: '999293' } });
    const plain = await registerLibrary();
    await update(plain, { gstNumber: '08ZZZZZ1234F1Z5' });

    // 1000 charge of which 200 is a refundable deposit: only 800 is taxable
    const chargeId = new Oid();
    await L.state.mongoose.connection.db.collection('payments').insertOne({ _id: chargeId, libraryId: new Oid(gst.id), totalAmount: 1000, items: [{ kind: 'deposit', amount: 200 }, { kind: 'plan', amount: 800 }], isDeleted: false });
    const txn = (lib, over) => Txn.create({ libraryId: lib.id, studentId: new Oid(), amount: 1000, allocations: [{ paymentId: chargeId, amount: 1000 }], ...over });
    const legacy = await txn(gst, { receiptNumber: 'OLD-1' });
    const legacyPlain = await txn(plain, { receiptNumber: 'OLD-2' });
    const attempt = await txn(gst, { status: 'pending' });
    const issued = await txn(gst, { receiptNumber: 'NEW-1', taxSnapshot: { enabled: false, gstin: 'KEPT' } });

    const dry = await backfill({ libraryId: gst.id, ...quiet });
    assert.equal(dry.found, 1);
    assert.equal(dry.withGst, 1);
    assert.equal(dry.written, 0);
    assert.equal((await Txn.findById(legacy._id).lean()).taxSnapshot, undefined, 'a dry run writes nothing');

    const applied = await backfill({ apply: true, libraryId: gst.id, ...quiet });
    assert.equal(applied.written, 1);
    const stored = await Txn.findById(legacy._id).lean();
    assert.equal(stored.taxSnapshot.enabled, true);
    assert.equal(stored.taxSnapshot.rate, 18);
    assert.equal(stored.taxSnapshot.gstin, '08ABCDE1234F1Z5');
    assert.equal(stored.taxSnapshot.taxableAmount, 800, 'the deposit stays out of the tax');
    assert.equal(stored.updatedAt.getTime(), legacy.updatedAt.getTime(), 'the transaction does not look edited');
    assert.equal((await Txn.findById(attempt._id).lean()).taxSnapshot, undefined, 'an unconfirmed attempt is left alone');
    assert.equal((await Txn.findById(issued._id).lean()).taxSnapshot.gstin, 'KEPT', 'an existing snapshot is never replaced');

    assert.equal((await backfill({ apply: true, libraryId: gst.id, ...quiet })).found, 0, 'running it again finds nothing');

    await backfill({ apply: true, libraryId: plain.id, ...quiet });
    const off = (await Txn.findById(legacyPlain._id).lean()).taxSnapshot;
    assert.equal(off.enabled, false);
    assert.equal(off.gstin, '08ZZZZZ1234F1Z5');

    const orphan = new Oid();
    await Txn.create({ libraryId: orphan, studentId: new Oid(), amount: 10, receiptNumber: 'GONE-1' });
    const skipped = await backfill({ apply: true, libraryId: orphan, ...quiet });
    assert.equal(skipped.libraryMissing, 1);
    assert.equal(skipped.written, 0, 'no snapshot is invented without a library');
  });
};
