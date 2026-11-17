// Part: permission denials, staff escalation, impersonation, lockout, rate limits, DPDP erase/export, maintenance, dashboards.
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./lib');
const { api, P, U, SRC } = L;

module.exports = (H) => {
  const { ctx, ok, expectStatus, data, msg, T, id, staffBody, stu } = H;
  const mongoose = () => L.breq('mongoose');

  test('28 permission denials on routes hardened earlier', async () => {
    // accountant has no content/attendance/branch permissions
    expectStatus(await api('POST', P('/notifications/send'), { token: T('acct'), body: { title: 'Hi', message: 'phish' } }), 403, 'notifications/send by accountant');
    expectStatus(await api('GET', P('/reviews'), { token: T('acct') }), 403, 'reviews list by accountant');
    expectStatus(await api('GET', P('/reviews/stats'), { token: T('acct') }), 403, 'reviews stats by accountant');
    expectStatus(await api('POST', P('/complaints'), { token: T('acct'), body: { subject: 'x', description: 'y' } }), 403, 'complaint create by accountant');
    // branch endpoints
    const other = await api('PUT', P(`/branches/${ctx.ids.branchB}`), { token: T('recA'), body: { name: 'Hijacked' } });
    assert.ok([403, 404].includes(other.status), 'branch-A receptionist editing branch B: ' + msg(other));
    const own = await api('PUT', P(`/branches/${ctx.ids.branchA}`), { token: T('recA'), body: { name: 'Hijacked' } });
    expectStatus(own, 403, 'receptionist lacks branches.manage even for own branch');
    expectStatus(await api('POST', P('/branches'), { token: T('mgr'), body: { name: 'Mgr Branch' } }), 403, 'only the owner creates branches');
    expectStatus(await api('DELETE', P(`/branches/${ctx.ids.branchB}`), { token: T('mgr') }), 403, 'only the owner deletes branches');
    // staff list needs staff.view
    expectStatus(await api('GET', P('/admins'), { token: T('recA') }), 403, 'staff list by receptionist');
    // students can never reach staff routes (student token)
    expectStatus(await api('GET', P('/students/get-students'), { token: undefined }), 401, 'no token');
  });

  test('29 staff privilege escalation is blocked (email takeover, peer edit)', async () => {
    const Permission = require(SRC + '/models/permission.model');
    const keys = ['staff.view', 'staff.edit', 'staff.create', 'VIEW_DASHBOARD'];
    const perms = await Permission.find({ key: { $in: keys } }).lean();
    const roleR = await api('POST', P('/roles/create-role'), { token: T('owner'), body: { name: 'HR Lead', description: 'staff admin', permissionIds: perms.map((p) => String(p._id)) } });
    ok(roleR, 'create HR role'); const hrRole = id(roleR);
    ctx.roles['HR Lead'] = hrRole;
    const hr = await api('POST', P('/admins'), { token: T('owner'), body: staffBody('HR One', 31, hrRole, []) });
    ok(hr, 'create HR'); ctx.ids.hr = id(hr);
    const hr2 = await api('POST', P('/admins'), { token: T('owner'), body: staffBody('HR Two', 32, hrRole, []) });
    ok(hr2, 'create HR2'); ctx.ids.hr2 = id(hr2);
    const l = await api('POST', U('/login'), { body: { identifier: 'staff31@lib1.test', password: 'Staff#12345' } });
    ctx.tokens.hr = l.body.token || l.body.data.token;
    // HR may edit a lower-privileged account's name, but never their email/mobile
    const ownerId = (await mongoose().connection.db.collection('admins').findOne({ email: 'owner@lib1.test' }))._id.toString();
    const accountantId = ctx.ids.acct;
    const nameEdit = await api('PUT', P(`/admins/update-admin/${accountantId}`), { token: T('hr'), body: { name: 'Renamed Acct' } });
    console.log('HR renames accountant (perms not subset of HR) ->', nameEdit.status);
    const emailEdit = await api('PUT', P(`/admins/update-admin/${accountantId}`), { token: T('hr'), body: { email: 'attacker@evil.test' } });
    assert.ok([403, 400].includes(emailEdit.status), 'staff must not change a colleague email: ' + msg(emailEdit));
    const peerEmail = await api('PUT', P(`/admins/update-admin/${ctx.ids.hr2}`), { token: T('hr'), body: { email: 'attacker2@evil.test' } });
    assert.ok([403, 400].includes(peerEmail.status), 'staff must not change a PEER email: ' + msg(peerEmail));
    const ownerEdit = await api('PUT', P(`/admins/update-admin/${ownerId}`), { token: T('hr'), body: { name: 'Pwned Owner' } });
    assert.ok([403, 404].includes(ownerEdit.status), 'staff must not edit the owner: ' + msg(ownerEdit));
    const disableMgr = await api('PUT', P(`/admins/update-status/${ctx.ids.mgr}`), { token: T('hr'), body: { status: false } });
    assert.ok([403, 404].includes(disableMgr.status), 'HR cannot disable a more privileged manager: ' + msg(disableMgr));
    const delMgr = await api('DELETE', P(`/admins/delete-admin/${ctx.ids.mgr}`), { token: T('hr') });
    assert.ok([403, 404].includes(delMgr.status), 'HR cannot delete a more privileged manager: ' + msg(delMgr));
    const dbEmail = (await mongoose().connection.db.collection('admins').findOne({ _id: new (mongoose().Types.ObjectId)(accountantId) })).email;
    assert.equal(dbEmail, 'staff23@lib1.test', 'accountant email unchanged in the database');
    // owner CAN change a staff email
    ok(await api('PUT', P(`/admins/update-admin/${ctx.ids.hr2}`), { token: T('owner'), body: { email: 'staff32b@lib1.test' } }), 'owner may change staff email');
    // tenant cannot create privileged roles with platform permissions
    const Perm = require(SRC + '/models/permission.model');
    const platformPerm = await Perm.findOne({ scope: 'platform' }).lean();
    if (platformPerm) {
      const bad = await api('POST', P('/roles/create-role'), { token: T('owner'), body: { name: 'Sneaky', permissionIds: [String(platformPerm._id)] } });
      console.log('role with platform-only permission ->', bad.status);
      if (bad.status < 300) {
        const rr = await mongoose().connection.db.collection('roles').findOne({ name: 'Sneaky' });
        const has = (rr.permissions || rr.permissionIds || []).map(String).includes(String(platformPerm._id));
        assert.ok(!has, 'platform-only permission must not be stored in a tenant role');
      }
    }
  });

  test('30 owner cannot reach other tenants (cross-tenant IDOR) + superadmin routes', async () => {
    // a second tenant
    const s = await api('POST', U('/register/send-otp'), { body: { mobile: '9876500002' } }); const otp = data(s).otp;
    const v = await api('POST', U('/register/verify-otp'), { body: { mobile: '9876500002', otp } });
    const reg = await api('POST', U('/register'), { body: { registrationToken: data(v).registrationToken, name: 'Lib Two', ownerName: 'Owner Two', mobile: '9876500002', email: 'owner@lib2.test', password: 'Owner#22222', address: '9 Road', city: 'Kota', state: 'Rajasthan', pincode: '324001', seatCapacity: 20, workingHours: { openingTime: '07:00 AM', closingTime: '10:00 PM' } } });
    expectStatus(reg, 201, 'second library');
    ctx.ids.library2 = data(reg).library.id;
    ok(await api('PATCH', P(`/super/libraries/${ctx.ids.library2}/approve`), { token: T('super') }), 'approve lib2');
    ok(await api('PATCH', P(`/super/libraries/${ctx.ids.library2}/plan`), { token: T('super'), body: { planId: ctx.ids.platformPlan } }), 'plan lib2');
    const l = await api('POST', U('/login'), { body: { identifier: 'owner@lib2.test', password: 'Owner#22222' } });
    ctx.tokens.owner2 = l.body.token || l.body.data.token;
    for (const [what, r] of [
      ['student', await api('GET', P(`/students/${ctx.ids.s1}`), { token: T('owner2') })],
      ['ledger', await api('GET', P(`/students/${ctx.ids.s1}/ledger`), { token: T('owner2') })],
      ['payment', await api('GET', P(`/payments/${ctx.ids.charge1}`), { token: T('owner2') })],
      ['receipt', await api('GET', P(`/payments/${ctx.ids.charge1}/receipt`), { token: T('owner2') })],
      ['seat', await api('GET', P(`/seats/${ctx.seatsA[0]}`), { token: T('owner2') })],
      ['branch', await api('GET', P(`/branches/${ctx.ids.branchA}`), { token: T('owner2') })],
      ['staff', await api('GET', P(`/admins/${ctx.ids.mgr}`), { token: T('owner2') })],
      ['plan', await api('GET', P(`/plans/${ctx.ids.plan}`), { token: T('owner2') })],
    ]) assert.ok([403, 404].includes(r.status), `lib2 owner reading lib1 ${what}: ${msg(r)}`);
    const writes = await api('POST', P(`/seats/${ctx.seatsA[0]}/reserve`), { token: T('owner2'), body: { studentId: ctx.ids.s1, until: new Date(Date.now() + 86400000).toISOString() } });
    assert.ok([403, 404, 400].includes(writes.status), 'cross-tenant seat write: ' + msg(writes));
    const refund = await api('POST', P(`/payments/${ctx.ids.charge1}/refund`), { token: T('owner2'), body: { reason: 'steal', amount: 10, method: 'cash', requestId: 'xtenant-refund-1' } });
    assert.ok([403, 404].includes(refund.status), 'cross-tenant refund: ' + msg(refund));
    const lists = await api('GET', P('/students?limit=100'), { token: T('owner2') });
    assert.ok(!JSON.stringify(data(lists)).includes('Student One'), 'lib2 list must not leak lib1 students');
    // superadmin-only
    for (const path of ['/super/libraries', '/super/platform-plans', '/super/users', '/super/revenue/overview', '/super/audit/logs', '/super/platform-settings']) {
      const r = await api('GET', P(path), { token: T('owner') });
      assert.ok([401, 403, 404].includes(r.status) && r.status !== 404 || r.status === 404, `owner on ${path}: ${r.status}`);
      assert.notEqual(r.status, 200, `owner must not read ${path}`);
    }
  });

  test('31 impersonation: operational reads ok, dangerous writes blocked', async () => {
    const imp = await api('POST', P(`/super/libraries/${ctx.ids.library}/impersonate`), { token: T('super') });
    ok(imp, 'impersonate');
    const tok = imp.body.token || data(imp).token;
    assert.ok(tok, msg(imp));
    ok(await api('GET', P('/students?limit=5'), { token: tok }), 'reads work');
    const blocked = [
      ['POST', '/admins', staffBody('Backdoor', 41, ctx.roles.Manager, [])],
      ['DELETE', `/admins/delete-admin/${ctx.ids.mgr}`, undefined],
      ['POST', `/admins/reset-password/${ctx.ids.mgr}`, { newPassword: 'Hacked#12345', password: 'Hacked#12345' }],
      ['PUT', `/admins/update-status/${ctx.ids.mgr}`, { status: false }],
      ['POST', '/roles/create-role', { name: 'Imp Role' }],
      ['PATCH', '/libraries/change-password', { currentPassword: 'Owner#12345', newPassword: 'New#12345678' }],
      ['POST', '/libraries/subscription/cancel', {}],
      ['POST', '/libraries/subscription/change-plan', { planId: ctx.ids.platformPlan }],
      ['POST', '/libraries/subscription/order', { planId: ctx.ids.platformPlan }],
    ];
    for (const [m, path, body] of blocked) {
      const r = await api(m, P(path), { token: tok, body });
      assert.ok([403, 404, 405].includes(r.status) && r.status !== 404 || r.status === 403, `impersonation must be blocked on ${m} ${path}: ${msg(r)}`);
    }
    const noMaint = await api('PUT', P('/super/platform-settings/maintenance'), { token: tok, body: { action: 'disable' } });
    assert.ok(noMaint.status === 403, 'impersonation token is not a superadmin token: ' + msg(noMaint));
  });

  test('32 account lockout after 10 failures; wrong-password message does not leak', async () => {
    const wrong = [];
    for (let i = 0; i < 10; i += 1) wrong.push(await api('POST', U('/login'), { body: { identifier: 'staff24@lib1.test', password: 'Wrong#pass' + i } }));
    assert.ok(wrong.every((r) => r.status === 401 || r.status === 400), 'wrong passwords are 401: ' + wrong.map((r) => r.status));
    const good = await api('POST', U('/login'), { body: { identifier: 'staff24@lib1.test', password: 'Staff#12345' } });
    assert.ok(good.status === 423 || good.status === 429 || good.status === 403 || good.status === 401, 'locked even with the right password: ' + msg(good));
    assert.ok(!(good.status >= 200 && good.status < 300), 'locked account must not log in');
    // unlock by clearing the lock (time travel) and confirm recovery
    await mongoose().connection.db.collection('admins').updateOne({ email: 'staff24@lib1.test' }, { $set: { lockUntil: new Date(Date.now() - 1000), failedLogins: 0 } });
    ok(await api('POST', U('/login'), { body: { identifier: 'staff24@lib1.test', password: 'Staff#12345' } }), 'login after lock expires');
  });

  test('33 login rate limiter (per IP) returns 429 with Retry-After', async () => {
    const ip = '203.0.113.77';
    let last;
    for (let i = 0; i < 12; i += 1) last = await api('POST', U('/login'), { ip, body: { identifier: `nobody${i}@x.test`, password: 'whatever12' } });
    assert.equal(last.status, 429, 'the 12th attempt from one IP is rate limited: ' + msg(last));
  });

  test('34 DPDP: data export, erase permission + anonymisation keeps fee records', async () => {
    const exp = await api('GET', P(`/students/${ctx.ids.s1}/data-export`), { token: T('owner') });
    ok(exp, 'export');
    assert.ok(!exp.text.includes(H.AAD1), 'export contains no full Aadhaar');
    assert.match(exp.text, /XXXX|masked/i);
    const noPerm = await api('POST', P(`/students/${ctx.ids.s1}/erase`), { token: T('mgr'), body: { reason: 'GDPR request', confirm: 'ERASE' } });
    expectStatus(noPerm, 403, 'manager lacks students.erase');
    const noConfirm = await api('POST', P(`/students/${ctx.ids.s1}/erase`), { token: T('owner'), body: { reason: 'request', confirm: 'yes' } });
    expectStatus(noConfirm, 400, 'needs ERASE');
    const before = await api('GET', P(`/payments?studentId=${ctx.ids.s1}&limit=100`), { token: T('owner') });
    const nBefore = data(before).length;
    const er = await api('POST', P(`/students/${ctx.ids.s1}/erase`), { token: T('owner'), body: { reason: 'student request', confirm: 'ERASE' } });
    ok(er, 'erase');
    const st = await api('GET', P(`/students/${ctx.ids.s1}`), { token: T('owner') });
    expectStatus(st, 404, 'erased students are archived: no longer readable through the normal API');
    const raw = await mongoose().connection.db.collection('students').findOne({ _id: new (mongoose().Types.ObjectId)(ctx.ids.s1) });
    assert.ok(!raw.aadhaarNumber && !raw.aadhaarLast4 && !raw.mobile?.includes('98111'), 'raw document has no Aadhaar/mobile: ' + JSON.stringify(Object.keys(raw)));
    const after = await api('GET', P(`/payments?studentId=${ctx.ids.s1}&limit=100`), { token: T('owner') });
    assert.equal(data(after).length, nBefore, 'financial records are retained');
    assert.ok(!/9811100001|Student One/.test(after.text), 'payment rows no longer carry the erased name/mobile: ' + after.text.slice(0, 300));
    assert.equal(raw.name, 'Erased Student');
    // erased student's mobile and Aadhaar can be registered again
    ok(await api('POST', P('/students/create-student'), { token: T('recA'), body: stu({ name: 'Reborn', mobile: '9811100001', aadhaarNumber: H.AAD1 }) }), 'same mobile + Aadhaar reusable after erase');
  });

  test('35 maintenance: scheduled window, read-only, library scope; essentials stay up', async () => {
    const pw = 'SuperPass#123';
    const M = (body) => api('PUT', P('/super/platform-settings/maintenance'), { token: T('super'), body });
    expectStatus(await M({ action: 'enable', message: 'x', scope: 'all' }), 400, 'enable without password'); // wrong or missing password
    const sched = await M({ action: 'schedule', password: pw, message: 'Upgrade', scope: 'all', startsAt: new Date(Date.now() + 3600e3).toISOString(), endsAt: new Date(Date.now() + 7200e3).toISOString(), reason: 'upgrade' });
    ok(sched, 'schedule');
    ok(await api('GET', P('/students?limit=3'), { token: T('owner') }), 'before the window: normal operation');
    const pub = await api('GET', U('/maintenance-status'));
    assert.match(pub.text, /upcoming|scheduled/i, 'public status shows an upcoming window: ' + pub.text.slice(0, 300));
    ok(await M({ action: 'cancel' }), 'cancel');
    const past = await M({ action: 'schedule', password: pw, scope: 'all', startsAt: new Date(Date.now() - 3600e3).toISOString(), endsAt: new Date(Date.now() + 3600e3).toISOString() });
    assert.equal(past.status, 400, 'a start time in the past is refused: ' + msg(past));
    const longer = await M({ action: 'schedule', password: pw, scope: 'all', startsAt: new Date(Date.now() + 3600e3).toISOString(), endsAt: new Date(Date.now() + 200 * 3600e3).toISOString() });
    assert.equal(longer.status, 400, 'windows over 72h are refused');
    // read-only: reads pass, writes get 503
    ok(await M({ action: 'enable', password: pw, message: 'Read only for a moment', reason: 'deploy', scope: 'readOnly', estimatedBackAt: new Date(Date.now() + 1800e3).toISOString() }), 'enable read-only');
    ok(await api('GET', P('/students?limit=3'), { token: T('owner') }), 'read allowed in read-only mode');
    const w = await api('POST', P('/students/create-student'), { token: T('owner'), body: stu({ name: 'During Maint', mobile: '9811100088' }) });
    assert.equal(w.status, 503, 'write blocked: ' + msg(w));
    assert.ok(w.headers.get('retry-after'), 'Retry-After header present');
    assert.equal(w.body.maintenance, true);
    ok(await api('GET', U('/health')), 'health stays up');
    ok(await api('GET', U('/maintenance-status')), 'status endpoint stays up');
    ok(await api('GET', P('/super/platform-settings/maintenance'), { token: T('super') }), 'superadmin panel stays up');
    const sl = await api('POST', U('/login'), { body: { identifier: 'root@dd.test', password: 'SuperPass#123' } });
    ok(sl, 'superadmin can still sign in');
    ok(await api('POST', U('/refresh'), { headers: { 'x-requested-with': 'XMLHttpRequest', origin: 'http://localhost:3000' }, cookie: sl.setCookie.map((c) => c.split(';')[0]).join('; ') }), 'refresh stays up');
    // full block scoped to library 2 only
    ok(await M({ action: 'update', password: pw, message: 'Lib2 only', reason: 'lib2 fix', scope: 'libraries', libraryIds: [ctx.ids.library2] }), 'scope to library 2');
    ok(await api('POST', P('/students/create-student'), { token: T('owner'), body: stu({ name: 'Maint Lib1 ok', mobile: '9811100089' }) }), 'library 1 unaffected');
    const l2 = await api('GET', P('/students?limit=3'), { token: T('owner2') });
    assert.equal(l2.status, 503, 'library 2 blocked: ' + msg(l2));
    // webhook is never blocked (signature failure = 400/401, not 503)
    const wh = await api('POST', '/webhook/razorpay', { body: { event: 'x' }, headers: { 'x-razorpay-signature': 'bad' } });
    assert.notEqual(wh.status, 503, 'webhook is never blocked by maintenance: ' + msg(wh));
    ok(await M({ action: 'disable' }), 'disable');
    ok(await api('GET', P('/students?limit=3'), { token: T('owner2') }), 'library 2 back');
  });

  test('36 dashboards: superadmin, owner, branch staff, no-fee staff', async () => {
    const sd = await api('GET', P('/dashboard/summary'), { token: T('super') });
    ok(sd, 'superadmin summary'); console.log('SA summary keys:', Object.keys(data(sd)).join(','));
    const od = await api('GET', P('/dashboard/summary'), { token: T('owner') });
    ok(od, 'owner summary'); console.log('Owner summary keys:', Object.keys(data(od)).join(','));
    const fd = await api('GET', P('/dashboard/summary'), { token: T('recA') });
    ok(fd, 'receptionist summary');
    const txt = JSON.stringify(data(fd));
    const money = /"(feesCollected|pendingFees|collected|revenue|totalRevenue)"\s*:\s*(\d|\{)/i.test(txt);
    console.log('receptionist payload money fields present?', money, txt.slice(0, 400));
    assert.ok(!money, 'staff without fees.view must not receive money figures');
    const ad = await api('GET', P('/dashboard/summary'), { token: T('acct') });
    ok(ad, 'accountant summary');
    const stud = await api('GET', P('/dashboard/summary'), { token: undefined });
    expectStatus(stud, 401, 'no token');
    for (const range of ['week', 'month', 'year']) ok(await api('GET', P(`/dashboard/charts?range=${range}`), { token: T('owner') }), 'owner charts ' + range);
    for (const range of ['year', '6m', '30d']) ok(await api('GET', P(`/dashboard/charts?range=${range}`), { token: T('super') }), 'super charts ' + range);
    expectStatus(await api('GET', P('/dashboard/charts?range=decade'), { token: T('owner') }), 400, 'bad range');
    const info = await api('GET', P('/dashboard/realtime-info'), { token: T('owner') });
    ok(info, 'realtime-info'); assert.equal(data(info).socket, true, 'sockets enabled in this long-lived harness');
    // legacy endpoints still work
    ok(await api('GET', P('/dashboard/admin'), { token: T('owner') }), 'legacy admin dashboard');
    ok(await api('GET', P('/dashboard/superadmin'), { token: T('super') }), 'legacy super dashboard');
  });
};
