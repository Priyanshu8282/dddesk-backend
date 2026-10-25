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
};
