// Part: contract of everything the student mobile app calls (DDdesk-app/src/features/student/api). If a field the app reads
// disappears or changes type, this fails before a student ever sees a broken screen.
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./lib');
const { api, P, U } = L;

module.exports = (H) => {
  const { ctx, ok, expectStatus, data, msg, id } = H;
  const MOBILE = '9811100031'; // student in library 1 (see the student-portal test)
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const isStr = (v) => typeof v === 'string';
  let token;
  const GET = (path, query) => api('GET', P(path) + (query ? '?' + new URLSearchParams(query) : ''), { token });

  test('130 student sign-in (the app sends the mobile marker) and own profile', async () => {
    const l = await api('POST', U('/login'), { headers: { 'x-client-type': 'mobile' }, body: { userRole: 'STUDENT', identifier: MOBILE, password: 'Stud#12345', libraryId: ctx.ids.library } });
    ok(l, 'login');
    token = l.body.token;
    assert.ok(token && l.body.refreshToken, 'access + refresh token for the app');
    const me = await GET('/students/me');
    ok(me, 'me');
    const p = data(me);
    for (const k of ['_id', 'name', 'mobile', 'status', 'planStatus']) assert.ok(isStr(p[k]), `profile.${k} is a string: ${msg(me)}`);
    assert.equal(typeof p.mustChangePassword, 'boolean', 'mustChangePassword is read by the forced-password gate');
    assert.ok(p.library === null || (p.library && isStr(p.library.name)), 'library is an object with a name, or null');
    assert.ok(!/"password"|"otp"|aadhaarNumber"/.test(me.text), 'no secrets in the profile');
  });

  test('131 dashboard has every number the Home screen shows', async () => {
    const r = await GET('/students/dashboard');
    ok(r, 'dashboard');
    const d = data(r);
    for (const k of ['presentPercentage', 'presentDays', 'absentDays', 'totalDays', 'feesDue', 'overdueCount']) assert.ok(isNum(d.metrics[k]), `metrics.${k} is a number: ${msg(r)}`);
    assert.ok(isStr(d.metrics.planStatus));
    assert.equal(typeof d.metrics.mustChangePassword, 'boolean');
    for (const k of ['notices', 'stories', 'banners', 'recentPayments']) assert.ok(Array.isArray(d[k]), `${k} is an array`);
  });

  test('132 attendance history: list + summary for a month', async () => {
    const month = new Date().toISOString().slice(0, 7);
    const r = await GET('/attendance/my', { month, limit: '100' });
    ok(r, 'attendance/my');
    const d = data(r);
    assert.ok(Array.isArray(d.results), 'results[]');
    for (const k of ['page', 'limit', 'totalPages', 'totalResults']) assert.ok(isNum(d[k]), `${k} is a number`);
    assert.ok(d.summary && isNum(d.summary.percentage) && isNum(d.summary.presentDays) && isNum(d.summary.workingDays), 'summary numbers: ' + msg(r));
    expectStatus(await GET('/attendance/my', { month: 'nonsense' }), 400, 'bad month is refused, not a 500');
  });

  test('133 QR check-in: forged QR refused, the real staff QR is understood, a QR works once per student', async () => {
    const bad = await api('POST', P('/attendance/scan-qr'), { token, body: { token: 'DDDESK-ATT:not-a-jwt' } });
    assert.ok([400, 403].includes(bad.status) && isStr(bad.body.message), 'a forged QR is refused with a message: ' + msg(bad));
    expectStatus(await api('POST', P('/attendance/scan-qr'), { token, body: {} }), 400, 'missing token');
    // a student cannot make the QR themselves
    assert.ok([401, 403].includes((await GET('/attendance/generate-qr')).status), 'only staff can generate the QR');

    // the library shows the QR; the app sends exactly the scanned text
    const qr = await api('GET', P('/attendance/generate-qr'), { token: H.T('owner') });
    ok(qr, 'staff QR');
    const qrText = data(qr).qrText;
    assert.match(qrText, /^DDDESK-ATT:/, 'the QR text starts with the prefix the app looks for');
    const scan = await api('POST', P('/attendance/scan-qr'), { token, body: { token: qrText } });
    if (scan.status === 200) {
      assert.ok(['check-in', 'check-out'].includes(data(scan).action) && isStr(data(scan).attendance._id) && Array.isArray(data(scan).warnings || []), 'result fields the scan screen reads');
      const again = await api('POST', P('/attendance/scan-qr'), { token, body: { token: qrText } });
      expectStatus(again, 409, 'the same QR window cannot be used twice');
    } else {
      // this test student may have no active membership: the app then shows the server's reason
      assert.ok([400, 403, 409].includes(scan.status) && isStr(scan.body.message), 'a clear reason is returned: ' + msg(scan));
    }
  });

  test('134 fees ledger and receipts', async () => {
    const r = await GET('/payments/my');
    ok(r, 'ledger');
    const d = data(r);
    assert.ok(isNum(d.outstanding.totalOutstanding) && isNum(d.outstanding.overdueCount), 'outstanding numbers');
    assert.ok(Array.isArray(d.outstanding.charges) && Array.isArray(d.charges) && Array.isArray(d.transactions), 'lists');
    assert.ok(isNum(d.summary.totalBilled) && isNum(d.summary.totalPaid) && isNum(d.summary.totalOutstanding), 'summary numbers');
    for (const c of d.charges.slice(0, 5)) {
      assert.ok(isStr(c._id) && isNum(c.totalAmount) && isNum(c.paidAmount) && isNum(c.dueAmount) && isStr(c.paymentStatus), 'charge fields the Fees screen reads');
    }
    const first = d.transactions[0];
    if (first) {
      const rc = await GET(`/payments/my/receipts/${first._id}`);
      ok(rc, 'receipt');
      const x = data(rc);
      assert.ok(isStr(x.receiptNo) && isStr(x.library.name) && Array.isArray(x.items) && isNum(x.totals.netReceived), 'receipt fields the Receipt screen reads');
    }
    expectStatus(await GET('/payments/my/receipts/000000000000000000000000'), 404, 'unknown receipt');
    expectStatus(await GET('/payments/my/receipts/not-an-id'), 400, 'bad id');
  });

  test('135 paying online: the order is computed on the server, never from the client', async () => {
    const dues = data(await GET('/payments/my')).outstanding;
    if (!dues.totalOutstanding) {
      expectStatus(await api('POST', P('/payments/razorpay/create-order'), { token, body: {} }), 400, 'nothing due: no order');
      return;
    }
    const o = await api('POST', P('/payments/razorpay/create-order'), { token, body: { amount: 999999999 } });
    assert.ok(o.status >= 400 && o.status < 500, 'an amount above the dues is refused: ' + msg(o));
    const good = await api('POST', P('/payments/razorpay/create-order'), { token, body: {} });
    ok(good, 'order for all dues');
    const d = data(good);
    assert.ok(isStr(d.orderId) && isStr(d.key) && isNum(d.amount) && d.currency === 'INR' && isNum(d.payable), 'fields the checkout needs');
    assert.equal(d.amount, Math.round(d.payable * 100), 'amount is in paise');
    const forged = await api('POST', P('/payments/razorpay/verify'), { token, body: { razorpayOrderId: d.orderId, razorpayPaymentId: 'pay_forged', razorpaySignature: 'f'.repeat(64) } });
    assert.ok(forged.status >= 400 && forged.status < 500, 'a forged signature is refused: ' + msg(forged));
  });

  test('136 notices, stories, banners and offers are arrays under data', async () => {
    for (const [path, q] of [['/notices/student'], ['/stories/student'], ['/banners/active', { location: 'app' }], ['/coupons/active']]) {
      const r = await GET(path, q);
      ok(r, path);
      assert.ok(Array.isArray(data(r)), `${path} returns an array: ${msg(r)}`);
    }
  });

  test('137 complaints: create (as the app does, multipart), list, read, reply, and forged fields are ignored', async () => {
    const form = new FormData();
    form.append('title', 'Fan not working');
    form.append('description', 'The fan at my seat is broken');
    form.append('category', 'fan');
    form.append('priority', 'medium');
    const c = await api('POST', P('/complaints'), { token, form });
    ok(c, 'create');
    const t = data(c);
    assert.ok(isStr(t._id) && isStr(t.ticketId) && t.status === 'open' && isStr(t.createdAt), 'ticket fields the list reads');
    const list = await GET('/complaints/my');
    ok(list, 'my complaints');
    assert.ok(Array.isArray(list.body.data) && isNum(list.body.total) && isNum(list.body.totalPages), 'list + paging fields');
    assert.ok(list.body.data.some((x) => x._id === t._id));
    ok(await GET(`/complaints/${t._id}`), 'detail');
    const note = await api('POST', P(`/complaints/${t._id}/notes`), { token, body: { message: 'Any update?' } });
    ok(note, 'note');
    assert.ok(Array.isArray(data(note).notes) && data(note).notes.some((n) => n.message === 'Any update?'), 'the reply is in the thread');
    expectStatus(await api('POST', P(`/complaints/${t._id}/notes`), { token, body: { message: '' } }), 400, 'empty reply');
    expectStatus(await api('POST', P('/complaints'), { token, body: { title: 'x', description: '' } }), 400, 'too short');
  });

  test('138 reviews: write, list mine, edit rules, delete', async () => {
    const w = await api('POST', P('/reviews'), { token, body: { rating: 5, review: 'A calm and well kept study hall', type: 'public' } });
    ok(w, 'review');
    const rv = data(w);
    assert.ok(isStr(rv._id) && rv.rating === 5 && isStr(rv.status), 'review fields the app reads');
    expectStatus(await api('POST', P('/reviews'), { token, body: { rating: 9, review: 'Too high a rating here' } }), 400, 'rating out of range');
    expectStatus(await api('POST', P('/reviews'), { token, body: { rating: 4, review: 'short' } }), 400, 'review too short');
    const mine = await GET('/reviews/my');
    ok(mine, 'my reviews');
    assert.ok(Array.isArray(data(mine)) && data(mine).some((x) => x._id === rv._id));
    ok(await api('DELETE', P(`/reviews/${rv._id}`), { token }), 'delete own review');
  });

  test('139 notifications: list with unread count, read, read-all, delete', async () => {
    const r = await GET('/notifications', { limit: '50' });
    ok(r, 'list');
    assert.ok(Array.isArray(r.body.notifications || r.body.data), 'notifications[]');
    assert.ok(isNum(r.body.unreadCount) && isNum(r.body.total) && isNum(r.body.totalPages), 'counts the app reads');
    const first = (r.body.notifications || r.body.data)[0];
    if (first) {
      assert.ok(isStr(first._id) && isStr(first.title) && isStr(first.message) && typeof first.isRead === 'boolean', 'notification fields');
      ok(await api('PATCH', P(`/notifications/${first._id}/read`), { token }), 'mark one read');
    }
    ok(await api('PATCH', P('/notifications/read-all'), { token }), 'mark all read');
    expectStatus(await api('POST', P('/notifications/delete'), { token, body: {} }), 400, 'delete needs ids');
  });

  test('140 profile edit is strict, renewal is a request, devices list works', async () => {
    const up = await api('PUT', P('/students/me'), { token, body: { name: 'Student Portal', address: '12 Library Road', emergencyContact: { name: 'Parent', mobile: '9811100099', relation: 'Father' } } });
    ok(up, 'edit profile');
    assert.equal(data(up).name, 'Student Portal');
    expectStatus(await api('PUT', P('/students/me'), { token, body: { mobile: '9999999999' } }), 400, 'a student cannot change their mobile');
    expectStatus(await api('PUT', P('/students/me'), { token, body: { status: 'active', planId: '64b7f0c2a1b2c3d4e5f60718' } }), 400, 'nor the plan or status');
    expectStatus(await api('PUT', P('/students/me'), { token, body: {} }), 400, 'nothing to update');
    const sessions = await GET('/sessions');
    ok(sessions, 'sessions');
    assert.ok(Array.isArray(data(sessions)) && data(sessions).some((s) => s.current), 'this phone is marked current');
    const renew = await api('POST', P('/students/me/renew-request'), { token, body: { note: 'Same seat please' } });
    assert.ok([202, 400, 404].includes(renew.status), 'renewal is accepted or refused with a reason: ' + msg(renew));
  });

  test('141 push token registration and removal, then logout-all ends the session', async () => {
    const fcm = 'fcm_test_token_' + 'x'.repeat(40);
    ok(await api('PUT', P('/fcm-token'), { token, body: { fcmToken: fcm } }), 'register token');
    ok(await api('DELETE', P('/fcm-token'), { token, body: { fcmToken: fcm } }), 'remove token');
    ok(await api('POST', P('/logout-all'), { token }), 'logout-all');
    expectStatus(await GET('/students/me'), 401, 'the old token no longer works');
  });
};
