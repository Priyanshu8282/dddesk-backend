// Part: fee accounting. Registered by e2e.test.js after the student tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./lib');
const { api, P, U } = L;

module.exports = (H) => {
  const { ctx, ok, expectStatus, data, msg, T, id, staffBody } = H;
  const rnum = (r) => { if (r.body && r.body.receipt && r.body.receipt.receiptNo) return r.body.receipt.receiptNo; const d = data(r); return d.receiptNumber || (d.transaction && d.transaction.receiptNumber) || (d.receipt && d.receipt.receiptNumber) || (d.payment && d.payment.receiptNumber); };
  const chargeIdOf = (r) => id(r) || (data(r).payment && data(r).payment._id) || (data(r).charge && data(r).charge._id);
  const getCharge = async (paymentId, token = T('owner')) => { const r = await api('GET', P(`/payments/${paymentId}`), { token }); ok(r, 'get payment'); const d = data(r); return d.payment || d; };
  const outstanding = async (studentId, token = T('acct')) => { const r = await api('GET', P(`/students/${studentId}/ledger`), { token }); ok(r, 'ledger'); return data(r).ledger.outstanding.totalOutstanding; };

  test('15 fee permissions: receptionist denied, accountant allowed', async () => {
    const ac = await api('POST', P('/admins'), { token: T('owner'), body: staffBody('acctB', 25, ctx.roles.Accountant, [ctx.ids.branchB]) });
    ok(ac, 'create acctB');
    const l = await api('POST', U('/login'), { body: { identifier: 'staff25@lib1.test', password: 'Staff#12345' } });
    ctx.tokens.acctB = l.body.token || l.body.data.token;
    expectStatus(await api('POST', P('/payments'), { token: T('recA'), body: { studentId: ctx.ids.s1, paidAmount: 100 } }), 403, 'receptionist collecting');
    expectStatus(await api('GET', P('/payments'), { token: T('recA') }), 403, 'receptionist viewing payments');
  });

  test('16 collect: partial, idempotent replay, overpay, decimals, receipt format', async () => {
    const key = 'idem-collect-0001';
    const r1 = await api('POST', P('/payments'), { token: T('acct'), body: { studentId: ctx.ids.s1, paidAmount: 400, paymentMethod: 'cash', requestId: key } });
    ok(r1, 'collect 400');
    const rec1 = rnum(r1);
    assert.match(String(rec1), /^RCPT-2627-\d{6}$/, 'FY receipt format (Oct 2026 = FY 26-27): ' + msg(r1));
    const replay = await api('POST', P('/payments'), { token: T('acct'), body: { studentId: ctx.ids.s1, paidAmount: 400, paymentMethod: 'cash', requestId: key } });
    ok(replay, 'replay');
    assert.equal(rnum(replay), rec1, 'replay returns the original receipt: r1=' + r1.text.slice(0, 500) + ' replay=' + replay.text.slice(0, 500));
    assert.equal(await outstanding(ctx.ids.s1), 600, 'only one 400 collected after replay');
    const over = await api('POST', P('/payments'), { token: T('acct'), body: { studentId: ctx.ids.s1, paidAmount: 5000, paymentMethod: 'cash', requestId: 'idem-collect-over-1' } });
    assert.ok(over.status === 400 || over.status === 409, 'overpay refused: ' + msg(over));
    expectStatus(await api('POST', P('/payments'), { token: T('acct'), body: { studentId: ctx.ids.s1, paidAmount: -5, paymentMethod: 'cash' } }), 400, 'negative');
    const frac = await api('POST', P('/payments'), { token: T('acct'), body: { studentId: ctx.ids.s1, paidAmount: 10.555, paymentMethod: 'cash', requestId: 'idem-frac-00001' } });
    assert.equal(frac.status, 400, 'three decimals refused: ' + msg(frac));
    const r2 = await api('POST', P('/payments'), { token: T('acct'), body: { studentId: ctx.ids.s1, paidAmount: 600, paymentMethod: 'upi', requestId: 'idem-collect-0002', reference: 'UPI123' } });
    ok(r2, 'collect remaining 600');
    assert.notEqual(rnum(r2), rec1);
    assert.equal(await outstanding(ctx.ids.s1), 0);
    const again = await api('POST', P('/payments'), { token: T('acct'), body: { studentId: ctx.ids.s1, paidAmount: 1, paymentMethod: 'cash', requestId: 'idem-collect-0003' } });
    assert.ok(again.status >= 400, 'nothing due: ' + msg(again));
  });

  test('17 receipt: branch isolation incl. transaction id', async () => {
    const pays = await api('GET', P(`/payments?studentId=${ctx.ids.s1}`), { token: T('acct') });
    const charge = data(pays)[0];
    ctx.ids.charge1 = charge._id;
    const rc = await api('GET', P(`/payments/${charge._id}/receipt`), { token: T('acct') });
    ok(rc, 'receipt via charge');
    const d = data(rc);
    const txn = (d.transactions && d.transactions[0]) || d.transaction || null;
    const txnId = d.transactionId || (txn && (txn._id || txn.id));
    const bB = await api('GET', P(`/payments/${charge._id}/receipt`), { token: T('acctB') });
    assert.ok([403, 404].includes(bB.status), 'branch-B accountant reading branch-A receipt: ' + msg(bB));
    if (txnId) {
      const bB2 = await api('GET', P(`/payments/${txnId}/receipt`), { token: T('acctB') });
      assert.ok([403, 404].includes(bB2.status), 'branch-B accountant reading branch-A receipt by TRANSACTION id: ' + msg(bB2));
      const okTxn = await api('GET', P(`/payments/${txnId}/receipt`), { token: T('acct') });
      ok(okTxn, 'same-library accountant can read by txn id');
    } else console.log('NOTE: receipt payload exposes no transaction id; txn-id path not exercised. keys=' + Object.keys(d).join(','));
  });

  test('18 parallel collects: 20 at once, no lost update, unique receipts', async () => {
    const ch = await api('POST', P('/payments'), { token: T('acct'), body: { studentId: ctx.ids.s1, amount: 2000, description: 'Parallel test' } });
    ok(ch, 'new charge 2000'); assert.ok(chargeIdOf(ch), msg(ch));
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => api('POST', P('/payments'), { token: T('acct'), body: { studentId: ctx.ids.s1, paidAmount: 100, paymentMethod: 'cash', requestId: `par-collect-${String(i).padStart(4, '0')}` } })));
    const good = results.filter((r) => r.status >= 200 && r.status < 300);
    const bad = results.filter((r) => !(r.status >= 200 && r.status < 300));
    const rcpts = good.map(rnum);
    assert.equal(new Set(rcpts).size, rcpts.length, 'receipt numbers unique: ' + rcpts.join(','));
    const out = await outstanding(ctx.ids.s1);
    console.log(`PARALLEL: ${good.length}/20 succeeded; failures: ${bad.map((f) => f.status + ':' + (f.body && f.body.message)).join(' | ') || 'none'}`);
    assert.equal(out, 2000 - 100 * good.length, `ledger must equal successes (ok=${good.length}) outstanding=${out}`);
    assert.equal(bad.length, 0, 'all 20 independent collects should succeed: ' + bad.map((f) => msg(f)).join(' || ').slice(0, 800));
  });

  test('19 adjust (waive/discount), refund permissions + idempotency', async () => {
    const ch = await api('POST', P('/payments'), { token: T('acct'), body: { studentId: ctx.ids.s1, amount: 500, description: 'Adjust test' } });
    ok(ch, 'charge 500'); const cid = chargeIdOf(ch); ctx.ids.adjCharge = cid;
    expectStatus(await api('POST', P(`/payments/${cid}/adjust`), { token: T('owner'), body: { waiveAmount: 50 } }), 400, 'reason required');
    assert.equal((await api('POST', P(`/payments/${cid}/adjust`), { token: T('acct'), body: { reason: 'goodwill waiver', waiveAmount: 50 } })).status, 403, 'Accountant template lacks fees.adjust');
    ok(await api('POST', P(`/payments/${cid}/adjust`), { token: T('owner'), body: { reason: 'goodwill waiver', waiveAmount: 50 } }), 'owner waive');
    { const c = await getCharge(cid); assert.equal(c.dueAmount, 450, 'after waive 50: ' + JSON.stringify(c).slice(0, 700)); }
    ok(await api('POST', P(`/payments/${cid}/adjust`), { token: T('owner'), body: { reason: 'festival discount', discountAmount: 50 } }), 'discount');
    assert.equal((await getCharge(cid)).dueAmount, 400, 'due after waive 50 + discount 50');
    ok(await api('PATCH', P(`/payments/${cid}/collect`), { token: T('acct'), body: { amount: 400, paymentMethod: 'cash', requestId: 'refund-src-0001' } }), 'settle');
    assert.equal((await getCharge(cid)).dueAmount, 0);
    const ref = { reason: 'student left', amount: 100, method: 'cash', requestId: 'refund-idem-0001' };
    assert.equal((await api('POST', P(`/payments/${cid}/refund`), { token: T('acct'), body: ref })).status, 403, 'Accountant lacks fees.refund');
    ok(await api('POST', P(`/payments/${cid}/refund`), { token: T('owner'), body: ref }), 'refund 100');
    ok(await api('POST', P(`/payments/${cid}/refund`), { token: T('owner'), body: ref }), 'refund replay');
    assert.equal((await getCharge(cid)).refundAmount, 100, 'replay must not refund twice');
    const tooMuch = await api('POST', P(`/payments/${cid}/refund`), { token: T('owner'), body: { reason: 'too much', amount: 5000, method: 'cash', requestId: 'refund-idem-0002' } });
    assert.ok(tooMuch.status >= 400, 'refund beyond paid refused: ' + msg(tooMuch));
  });

  test('19b adjust and cancel: a repeat with the same key changes nothing', async () => {
    const newCharge = async (description, amount = 500) => { const r = await api('POST', P('/payments'), { token: T('acct'), body: { studentId: ctx.ids.s1, amount, description } }); ok(r, description); return chargeIdOf(r); };
    const adjust = (cid, body, extra = {}) => api('POST', P(`/payments/${cid}/adjust`), { token: T('owner'), body, ...extra });
    const cancel = (cid, body, extra = {}) => api('POST', P(`/payments/${cid}/cancel`), { token: T('owner'), body, ...extra });
    const waive = { reason: 'goodwill waiver', waiveAmount: 50, requestId: 'adjust-idem-0001' };

    const cid = await newCharge('Idempotent waive');
    const first = await adjust(cid, waive);
    ok(first, 'waive');
    assert.equal(first.body.replay, false, 'the first request is not a replay');
    const again = await adjust(cid, waive);
    ok(again, 'waive replay');
    assert.equal(again.body.replay, true, 'the retry says it is a replay');
    let c = await getCharge(cid);
    assert.equal(c.waivedAmount, 50, 'a replay must not waive twice');
    assert.equal(c.dueAmount, 450);
    assert.equal(c.adjustments.filter((a) => a.type === 'waive').length, 1, 'one history entry');

    // the key may come as the header, and a changed reason is still the same request
    ok(await adjust(cid, { reason: 'typed again', waiveAmount: 50 }, { headers: { 'Idempotency-Key': waive.requestId } }), 'replay by header');
    assert.equal((await getCharge(cid)).waivedAmount, 50, 'the header key counts as the same request');

    // one key cannot mean two changes, and a new key is a new change
    expectStatus(await adjust(cid, { ...waive, waiveAmount: 60 }), 409, 'same key, different amount');
    expectStatus(await cancel(cid, { reason: 'wrong action', requestId: waive.requestId }), 409, 'same key, different action');
    ok(await adjust(cid, { ...waive, requestId: 'adjust-idem-0002' }), 'second waive');
    assert.equal((await getCharge(cid)).waivedAmount, 100, 'a new key is a new waiver');

    // no key: nothing changes for callers that do not send one
    ok(await adjust(cid, { reason: 'no key sent', waiveAmount: 10 }), 'waive without a key');
    ok(await adjust(cid, { reason: 'no key sent', waiveAmount: 10 }), 'waive without a key again');
    assert.equal((await getCharge(cid)).waivedAmount, 120, 'without a key each request applies');
    expectStatus(await adjust(cid, { reason: 'bad key', waiveAmount: 1 }, { headers: { 'Idempotency-Key': 'short' } }), 400, 'a malformed header key');
    expectStatus(await adjust(cid, { reason: 'bad key', waiveAmount: 1, requestId: 'short' }), 400, 'a malformed body key');

    // parallel double submits apply once
    const race = await newCharge('Parallel waive');
    const results = await Promise.all(Array.from({ length: 8 }, () => adjust(race, { reason: 'double tap', waiveAmount: 25, requestId: 'adjust-race-0001' })));
    results.forEach((r) => ok(r, 'parallel waive'));
    assert.equal(results.filter((r) => r.body.replay === false).length, 1, 'exactly one request did the work');
    assert.equal((await getCharge(race)).waivedAmount, 25, 'parallel repeats waive once');

    // a late fee replayed after the charge moved on, and after it was cancelled
    const moved = await newCharge('Replay after cancel');
    const fee = { reason: 'paid late', lateFee: 30, requestId: 'adjust-late-0001' };
    ok(await adjust(moved, fee), 'late fee');
    const stop = { reason: 'joined by mistake', requestId: 'cancel-idem-0001' };
    const cancelled = await cancel(moved, stop);
    ok(cancelled, 'cancel');
    assert.equal(cancelled.body.replay, false);
    const cancelledAt = (await getCharge(moved)).cancelledAt;
    const twice = await cancel(moved, stop);
    ok(twice, 'cancel replay answers success, not "already cancelled"');
    assert.equal(twice.body.replay, true);
    ok(await adjust(moved, fee), 'adjust replay on a cancelled charge');
    c = await getCharge(moved);
    assert.equal(c.paymentStatus, 'cancelled');
    assert.equal(c.cancelledAt, cancelledAt, 'a replay must not move the cancel date');
    assert.equal(c.adjustments.filter((a) => a.type === 'cancel').length, 1, 'one cancel entry');
    expectStatus(await cancel(moved, { reason: 'joined by mistake', requestId: 'cancel-idem-0002' }), 400, 'a new key on a cancelled charge is refused');
    expectStatus(await cancel(moved, { reason: 'joined by mistake' }), 400, 'no key on a cancelled charge is refused');

    // a refused cancel stores nothing; a charge that holds money is refunded first, then cancelled to close any unpaid balance
    const held = await newCharge('Cancel with money held', 300);
    ok(await api('PATCH', P(`/payments/${held}/collect`), { token: T('acct'), body: { amount: 100, paymentMethod: 'cash', requestId: 'cancel-src-0001' } }), 'collect');
    const refused = { reason: 'student left', requestId: 'cancel-idem-0003' };
    expectStatus(await cancel(held, refused), 400, 'money is held');
    expectStatus(await cancel(held, refused), 400, 'still refused, not a replay');
    assert.ok(!(await getCharge(held)).adjustments.some((a) => a.requestId === refused.requestId), 'a refused request leaves no key');
    ok(await api('POST', P(`/payments/${held}/refund`), { token: T('owner'), body: { reason: 'student left', amount: 100, method: 'cash', requestId: 'cancel-ref-0001' } }), 'refund');
    c = await getCharge(held);
    assert.equal(c.dueAmount, 200, 'refunding what was paid keeps the 200 never paid: it is not silently written off');
    assert.equal(c.paymentStatus, 'partial');
    ok(await cancel(held, { reason: 'student left', requestId: 'cancel-idem-0004' }), 'with the money returned, cancelling closes the unpaid balance');
    assert.equal((await getCharge(held)).dueAmount, 0);
  });

  test('19c late fee and discount SET the figure; history keeps before/after; a refund without method follows the receipt', async () => {
    const r = await api('POST', P('/payments'), { token: T('acct'), body: { studentId: ctx.ids.s1, amount: 500, description: 'Set semantics' } });
    ok(r, 'charge 500'); const cid = chargeIdOf(r);
    const adjust = (body) => api('POST', P(`/payments/${cid}/adjust`), { token: T('owner'), body });
    ok(await adjust({ reason: 'late once', lateFee: 30 }), 'late fee 30');
    assert.equal((await getCharge(cid)).dueAmount, 530);
    ok(await adjust({ reason: 'late again', lateFee: 50 }), 'late fee 50');
    let c = await getCharge(cid);
    assert.equal(c.lateFee, 50, 'a second late fee REPLACES the first (50, not 80)');
    assert.equal(c.dueAmount, 550);
    ok(await adjust({ reason: 'offer', discountAmount: 20 }), 'discount 20');
    ok(await adjust({ reason: 'bigger offer', discountAmount: 70 }), 'discount 70');
    c = await getCharge(cid);
    assert.equal(c.discountAmount, 70, 'a second discount REPLACES the first');
    assert.equal(c.dueAmount, 480);
    const hist = (t) => c.adjustments.filter((a) => a.type === t).map((a) => [a.previous, a.amount]);
    assert.deepEqual(hist('late_fee'), [[0, 30], [30, 50]], 'late fee history: previous -> new');
    assert.deepEqual(hist('discount'), [[0, 20], [20, 70]], 'discount history: previous -> new');
    ok(await adjust({ reason: 'cleared', lateFee: 0 }), 'late fee back to 0');
    c = await getCharge(cid);
    assert.equal(c.lateFee, 0); assert.equal(c.dueAmount, 430);

    // refund with no method: stored with the method of the receipt, so reports net it against the right method
    ok(await api('PATCH', P(`/payments/${cid}/collect`), { token: T('acct'), body: { amount: 100, paymentMethod: 'upi', requestId: 'setsem-collect-01' } }), 'collect upi');
    ok(await api('POST', P(`/payments/${cid}/refund`), { token: T('owner'), body: { reason: 'no method sent', amount: 40, requestId: 'setsem-refund-0001' } }), 'refund without method');
    const Txn = require(L.SRC + '/models/paymentTransaction.model');
    const refund = await Txn.findOne({ type: 'refund', refundRequestId: 'setsem-refund-0001' }).lean();
    assert.equal(refund.method, 'upi', 'refund method follows the upi receipt, not a blind cash');
  });

  test('20 GST on receipts when enabled (CGST/SGST), absent when disabled', async () => {
    const before = await api('GET', P(`/payments/${ctx.ids.charge1}/receipt`), { token: T('acct') });
    ok(before, 'receipt');
    assert.ok(!/cgst|sgst|igst/i.test(before.text), 'no tax lines while GST is off');
    const bad = await api('PUT', P('/libraries/profile'), { token: T('owner'), body: { feeTax: { gstEnabled: true, gstRate: 18, sacCode: '999293' } } });
    console.log('GST enable without GSTIN ->', bad.status, (bad.body && bad.body.message) || '');
    const en = await api('PUT', P('/libraries/profile'), { token: T('owner'), body: { gstNumber: '08ABCDE1234F1Z5', feeTax: { gstEnabled: true, gstRate: 18, sacCode: '999293' } } });
    ok(en, 'enable GST with GSTIN');
    const badG = await api('PUT', P('/libraries/profile'), { token: T('owner'), body: { gstNumber: 'NOTAGSTIN' } });
    expectStatus(badG, 400, 'invalid GSTIN');
    const noGstin = await api('PUT', P('/libraries/profile'), { token: T('owner'), body: { gstNumber: '' } });
    expectStatus(noGstin, 400, 'GSTIN cannot be removed while GST on receipts is on');
    const pinOk = await api('PUT', P('/libraries/profile'), { token: T('owner'), body: { pincode: '302001' } });
    ok(pinOk, 'set pincode');
    const pinClear = await api('PUT', P('/libraries/profile'), { token: T('owner'), body: { pincode: '' } });
    ok(pinClear, 'clear pincode');
    assert.equal(pinClear.body.data.pincode, '', 'pincode cleared');
    expectStatus(await api('PUT', P('/libraries/profile'), { token: T('owner'), body: { pincode: '123' } }), 400, 'short pincode');
    const kept = await api('GET', P(`/payments/${ctx.ids.charge1}/receipt`), { token: T('acct') });
    ok(kept, 'receipt issued with GST off');
    assert.ok(!/cgst|sgst|igst/i.test(kept.text), 'enabling GST adds no tax to a receipt issued without it');
    // a transaction from before tax snapshots has none: it still follows the live settings
    const Txn = require(L.SRC + '/models/paymentTransaction.model');
    await Txn.updateOne({ _id: data(before).transactionId }, { $unset: { taxSnapshot: 1 } });
    const after = await api('GET', P(`/payments/${ctx.ids.charge1}/receipt`), { token: T('acct') });
    ok(after, 'receipt with GST');
    assert.match(after.text, /cgst/i, 'CGST present: ' + after.text.slice(0, 700));
    assert.match(after.text, /sgst/i, 'SGST present');
    const d = data(after); const t = d.tax || d.gst || (d.receipt && (d.receipt.tax || d.receipt.gst));
    if (t) {
      const sum = Number(t.taxableValue) + Number(t.cgst) + Number(t.sgst);
      assert.ok(Math.abs(sum - Number(t.taxableAmount)) < 0.02, `taxable value + CGST + SGST must equal the GST-inclusive amount ${t.taxableAmount}, got ${sum}: ${JSON.stringify(t)}`);
      assert.ok(Math.abs(Number(t.taxableValue) - Number(t.taxableAmount) / 1.18) < 0.02, 'taxable value = inclusive / 1.18');
    }
  });

  test('20b a receipt keeps the tax it was issued with when the GST settings change', async () => {
    // acctB has made no payment writes yet (the 40 a minute limit is per user), and s2 still owes the plan fee from test 13
    const collect = async (paidAmount, requestId) => {
      const r = await api('POST', P('/payments'), { token: T('acctB'), body: { studentId: ctx.ids.s2, paidAmount, paymentMethod: 'cash', requestId } });
      ok(r, 'collect ' + paidAmount);
      return r.body.receipt.transactionId;
    };
    const receipt = async (txnId) => { const r = await api('GET', P(`/payments/${txnId}/receipt`), { token: T('acctB') }); ok(r, 'receipt'); return data(r); };
    const settings = async (body) => ok(await api('PUT', P('/libraries/profile'), { token: T('owner'), body }), 'GST settings');

    const taxedId = await collect(590, 'gst-keep-collect-1');
    const taxed = await receipt(taxedId);
    const issued = { enabled: true, gstin: '08ABCDE1234F1Z5', sacCode: '999293', rate: 18, inclusive: true, intraState: true, placeOfSupply: 'Rajasthan', taxableAmount: 590, taxableValue: 500, cgst: 45, sgst: 45, igst: 0, totalTax: 90 };
    assert.deepEqual(taxed.tax, issued, 'the tax as issued');
    const unchanged = async (label) => {
      const now = await receipt(taxedId);
      assert.deepEqual(now.tax, issued, label);
      assert.equal(now.library.gstNumber, issued.gstin, label + ': the GSTIN the mobile receipts print');
    };

    await settings({ gstNumber: '27ABCDE1234F1Z5', state: 'Maharashtra', feeTax: { gstEnabled: true, gstRate: 5, sacCode: '999999' } });
    await unchanged('rate, SAC, GSTIN and state changed');

    await settings({ feeTax: { gstEnabled: false } });
    await unchanged('GST turned off');
    const plainId = await collect(295, 'gst-keep-collect-2');
    const plain = await receipt(plainId);
    assert.equal(plain.tax, null, 'a receipt issued with GST off has no tax');
    assert.equal(plain.totals.amountReceived, 295);

    await settings({ feeTax: { gstEnabled: true, gstRate: 12 } });
    await unchanged('GST back on at another rate');
    assert.equal((await receipt(plainId)).tax, null, 'turning GST back on adds no tax to a receipt issued without it');

    // refund notes still show no tax, keep their own snapshot, and leave the source receipt alone
    // straight to the service: every staff token that may refund has used up its payment writes by now
    const ledger = require(L.SRC + '/services/feeLedger.service');
    const rf = await ledger.refundPayment({ libraryId: ctx.ids.library, transactionId: taxedId, amount: 59, reason: 'gst snapshot', method: 'cash', requestId: 'gst-keep-refund-1' });
    const note = await receipt(rf._id);
    assert.equal(note.type, 'refund');
    assert.equal(note.tax, null, 'a refund note carries no tax block');
    assert.equal(note.library.gstNumber, '27ABCDE1234F1Z5', 'the GSTIN at the time of the refund');
    const Txn = require(L.SRC + '/models/paymentTransaction.model');
    const stored = (await Txn.findById(rf._id).lean()).taxSnapshot;
    assert.equal(stored.enabled, true);
    assert.equal(stored.rate, 12);
    assert.equal(stored.taxableAmount, 59);
    await unchanged('after a refund');
    assert.equal((await receipt(taxedId)).totals.refunded, 59);

    await settings({ gstNumber: issued.gstin, state: 'Rajasthan', feeTax: { gstEnabled: true, gstRate: 18, sacCode: '999293' } });
  });
};
