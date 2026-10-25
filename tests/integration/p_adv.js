// Part: adversarial checks - mass assignment, NoSQL injection, immediate revocation, plan limits.
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./lib');
const { api, P, U } = L;

module.exports = (H) => {
  const { ctx, ok, expectStatus, data, msg, T, id, stu, staffBody } = H;
  const col = (n) => L.state.mongoose.connection.db.collection(n);
  const Oid = (v) => new (L.state.mongoose.Types.ObjectId)(v);

  test('80 plan limits: students, staff, seats and branches are enforced (lib 2 on a tiny plan)', async () => {
    const tiny = await api('POST', P('/super/platform-plans'), { token: T('super'), body: { name: 'Tiny2', monthlyPrice: 100, maxStudents: 2, maxSeats: 3, maxStaff: 1, maxBranches: 1 } });
    ok(tiny, 'plan'); const tinyId = id(tiny);
    ok(await api('PATCH', P(`/super/libraries/${ctx.ids.library2}/plan`), { token: T('super'), body: { planId: tinyId } }), 'assign tiny');
    const lib = await col('libraries').findOne({ _id: Oid(ctx.ids.library2) });
    console.log('LIB2 limits after assign:', JSON.stringify({ maxStudents: lib.maxStudents, maxSeats: lib.maxSeats, maxStaff: lib.maxStaff, maxBranches: lib.maxBranches, status: lib.status }));
    const mk = (i) => api('POST', P('/students/create-student'), { token: T('owner2'), body: { name: `L2 Student ${i}`, mobile: `98111108${String(i).padStart(2, '0')}`, password: 'Stud#12345', consentGiven: true } });
    const first = await mk(0);
    ok(first, 'first student in library 2: ' + msg(first));
    const tries = await Promise.all([1, 2, 3, 4].map(mk));
    const count = await col('students').countDocuments({ libraryId: Oid(ctx.ids.library2), isDeleted: { $ne: true } });
    console.log('LIMIT RACE messages:', [first, ...tries].map((r) => r.status + ' ' + String((r.body && r.body.message) || '').slice(0, 90)).join(' || '));
    console.log('LIMIT RACE: statuses', [first, ...tries].map((r) => r.status).join(','), 'in db', count);
    assert.ok(count <= 2, `maxStudents=2 must hold under parallel creates (db has ${count})`);
    // a burst may lose more requests than strictly necessary (safe side); fill the remaining slot one by one
    for (let i = 20; (await col('students').countDocuments({ libraryId: Oid(ctx.ids.library2), isDeleted: { $ne: true } })) < 2 && i < 25; i += 1) ok(await mk(i), 'fill slot');
    const over = await mk(9);
    assert.ok(over.status >= 400, 'beyond the limit: ' + msg(over));
    assert.match(over.text, /limit|plan|upgrade/i, 'message explains the plan limit: ' + over.text.slice(0, 200));
    // staff limit
    const s1 = await api('POST', P('/admins'), { token: T('owner2'), body: staffBody('L2 Staff 1', 51, (await col('roles').findOne({ libraryId: Oid(ctx.ids.library2), name: 'Receptionist' }))._id.toString(), []) });
    console.log('first staff in lib2 ->', s1.status);
    const s2 = await api('POST', P('/admins'), { token: T('owner2'), body: staffBody('L2 Staff 2', 52, (await col('roles').findOne({ libraryId: Oid(ctx.ids.library2), name: 'Receptionist' }))._id.toString(), []) });
    const staffCount = await col('admins').countDocuments({ libraryId: Oid(ctx.ids.library2), userType: 'staff', isDeleted: { $ne: true } });
    console.log('STAFF LIMIT: maxStaff=1, staff in db =', staffCount, 'second create ->', s2.status);
    assert.ok(staffCount <= 1, 'maxStaff=1 enforced');
    // seats + branches
    const seats = await api('POST', P('/seats/bulk'), { token: T('owner2'), body: { prefix: 'X-', count: 10 } });
    const seatCount = await col('seats').countDocuments({ libraryId: Oid(ctx.ids.library2), isDeleted: { $ne: true } });
    console.log('SEAT LIMIT: maxSeats=3, seats in db =', seatCount, 'bulk ->', seats.status);
    assert.ok(seatCount <= 3, 'maxSeats=3 enforced');
    const b1 = await api('POST', P('/branches'), { token: T('owner2'), body: { name: 'L2 Main' } });
    const b2 = await api('POST', P('/branches'), { token: T('owner2'), body: { name: 'L2 Second' } });
    const brCount = await col('branches').countDocuments({ libraryId: Oid(ctx.ids.library2), isDeleted: { $ne: true } });
    console.log('BRANCH LIMIT: maxBranches=1, branches in db =', brCount, b1.status, b2.status);
    assert.ok(brCount <= 1 || b2.status >= 400, 'maxBranches=1 enforced');
    ok(await api('PATCH', P(`/super/libraries/${ctx.ids.library2}/plan`), { token: T('super'), body: { planId: ctx.ids.platformPlan } }), 'restore');
  });

  test('81 mass assignment: privileged fields in bodies are ignored', async () => {
    const before = await col('libraries').findOne({ _id: Oid(ctx.ids.library) });
    const up = await api('PUT', P('/libraries/profile'), { token: T('owner'), body: { description: 'hello', status: 'suspended', subscriptionExpiry: '2099-01-01', subscriptionPlanId: ctx.ids.platformPlan, isDeleted: true, libraryCode: 'HACKED', maxStudents: 999999, subscriptionStatus: 'active' } });
    console.log('profile update with privileged keys ->', up.status);
    const after = await col('libraries').findOne({ _id: Oid(ctx.ids.library) });
    for (const k of ['status', 'subscriptionExpiry', 'isDeleted', 'libraryCode', 'maxStudents', 'subscriptionPlanId']) assert.deepEqual(after[k], before[k], `library.${k} must not be writable by the owner`);
    // staff cannot make themselves superadmin / move tenants / widen permissions
    const hrDoc = await col('admins').findOne({ email: 'staff31@lib1.test' });
    const superRole = await col('roles').findOne({ name: 'Super Admin', libraryId: null });
    const evil = await api('PUT', P(`/admins/update-admin/${hrDoc._id}`), { token: T('owner'), body: { name: 'HR One', userType: 'superadmin', libraryId: ctx.ids.library2, roleId: String(superRole._id), permissions: ['*'] } });
    console.log('owner assigning superadmin role / userType ->', evil.status, evil.text.slice(0, 160));
    const hrAfter = await col('admins').findOne({ _id: hrDoc._id });
    assert.equal(hrAfter.userType, 'staff', 'userType unchanged');
    assert.equal(String(hrAfter.libraryId), String(hrDoc.libraryId), 'libraryId unchanged');
    assert.notEqual(String(hrAfter.roleId), String(superRole._id), 'a tenant cannot assign the platform Super Admin role');
    const mk = await api('POST', P('/admins'), { token: T('owner'), body: { ...staffBody('Sneaky Super', 61, ctx.roles.Manager, []), userType: 'superadmin' } });
    if (mk.status < 300) assert.equal((await col('admins').findOne({ email: 'staff61@lib1.test' })).userType, 'staff', 'creating staff with userType=superadmin yields a normal staff');
    // students: status / library / password via update
    const sdoc = await col('students').findOne({ mobile: '9811100031' });
    const su = await api('PUT', P(`/students/${sdoc._id}`), { token: T('mgr'), body: { name: 'Prorate Pat', libraryId: ctx.ids.library2, planStatus: 'active', isDeleted: true, password: 'Changed#12345', tokensValidAfter: '2000-01-01' } });
    console.log('student update with privileged keys ->', su.status);
    const sa = await col('students').findOne({ _id: sdoc._id });
    assert.equal(String(sa.libraryId), String(sdoc.libraryId), 'student libraryId immutable');
    assert.notEqual(sa.isDeleted, true, 'isDeleted not writable via update');
    assert.equal(sa.password, sdoc.password, 'password not writable via profile update');
  });

  test('82 NoSQL operator injection and odd inputs', async () => {
    const inj = await api('POST', U('/login'), { body: { identifier: { $ne: null }, password: { $ne: null } } });
    assert.ok([400, 401].includes(inj.status), 'operator object as identifier: ' + msg(inj));
    const inj2 = await api('POST', U('/login'), { body: { identifier: 'staff23@lib1.test', password: { $gt: '' } } });
    assert.ok([400, 401].includes(inj2.status), 'operator object as password: ' + msg(inj2));
    const otpInj = await api('POST', U('/verify-otp'), { body: { mobile: { $ne: '' }, otp: { $ne: '' } } });
    assert.ok([400, 401, 403].includes(otpInj.status), 'otp verify operator injection: ' + msg(otpInj));
    const q = await api('GET', P('/students?search[$ne]=zzz&limit=5'), { token: T('owner') });
    assert.ok(q.status === 200 || q.status === 400, 'operator in query string: ' + q.status);
    if (q.status === 200) assert.ok(data(q).length >= 0);
    const rx = await api('GET', P('/students?search=.*(a+)+$&limit=5'), { token: T('owner') });
    assert.ok(rx.status === 200 || rx.status === 400, 'regex metacharacters are escaped, no ReDoS/500: ' + rx.status);
    const proto = await api('POST', P('/expenses'), { token: T('acct'), body: JSON.parse('{"title":"proto","amount":5,"__proto__":{"isAdmin":true},"constructor":{"prototype":{"x":1}}}') });
    assert.ok(proto.status < 500, 'prototype keys do not crash: ' + proto.status);
    assert.equal({}.isAdmin, undefined, 'Object.prototype not polluted');
    for (const bad of ['not-an-id', '123', '%00', '{}']) {
      const r = await api('GET', P(`/students/${bad}`), { token: T('owner') });
      assert.ok([400, 404].includes(r.status), `invalid id "${bad}" must be 400/404 not 500: ${r.status}`);
    }
    const huge = await api('GET', P('/students?limit=100000&page=-5'), { token: T('owner') });
    assert.ok(huge.status === 400 || huge.status === 200, 'huge limit handled: ' + huge.status);
    if (huge.status === 200) assert.ok((data(huge).length || 0) <= 500, 'limit is capped');
    const big = await api('POST', P('/expenses'), { token: T('acct'), body: { title: 'x'.repeat(2 * 1024 * 1024), amount: 1 } });
    assert.equal(big.status, 413, 'oversized JSON body refused: ' + big.status);
    const badJson = await fetch(L.state.base + P('/expenses'), { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + T('acct') }, body: '{"title": ' });
    assert.equal(badJson.status, 400, 'malformed JSON is a 400');
  });

  test('83 revocation is immediate: disabled staff, suspended library, deleted staff', async () => {
    const staff = await api('POST', P('/admins'), { token: T('owner'), body: staffBody('Temp Staff', 71, ctx.roles.Receptionist, [ctx.ids.branchA]) });
    ok(staff, 'create'); const sid = id(staff);
    const l = await api('POST', U('/login'), { body: { identifier: 'staff71@lib1.test', password: 'Staff#12345' } }); ok(l, 'login');
    const tok = l.body.token || l.body.data.token;
    ok(await api('GET', P('/students?limit=1'), { token: tok }), 'works before');
    ok(await api('PUT', P(`/admins/update-status/${sid}`), { token: T('owner'), body: { status: false } }), 'disable');
    const after = await api('GET', P('/students?limit=1'), { token: tok });
    assert.ok([401, 403].includes(after.status), 'a disabled staff token stops working immediately: ' + msg(after));
    const refresh = await api('POST', U('/refresh'), { cookie: l.setCookie.map((c) => c.split(';')[0]).join('; '), headers: { 'x-requested-with': 'XMLHttpRequest', origin: 'http://localhost:3000' } });
    assert.ok([401, 403].includes(refresh.status), 'and cannot refresh: ' + msg(refresh));
    // suspended library: every tenant token dies at once
    const o2 = await api('POST', U('/login'), { body: { identifier: 'owner@lib2.test', password: 'Brand#New123' } }); ok(o2, 'owner2 login');
    const t2 = o2.body.token || o2.body.data.token;
    ok(await api('GET', P('/students?limit=1'), { token: t2 }), 'owner2 works');
    ok(await api('PATCH', P(`/super/libraries/${ctx.ids.library2}/suspend`), { token: T('super'), body: { reason: 'test suspension' } }), 'suspend');
    const blocked = await api('GET', P('/students?limit=1'), { token: t2 });
    assert.ok([401, 403].includes(blocked.status), 'suspended library token refused immediately: ' + msg(blocked));
    ok(await api('PATCH', P(`/super/libraries/${ctx.ids.library2}/reinstate`), { token: T('super') }), 'reinstate');
    ok(await api('POST', U('/login'), { body: { identifier: 'owner@lib2.test', password: 'Brand#New123' } }), 'back in');
    // deleting a staff member
    ok(await api('DELETE', P(`/admins/delete-admin/${sid}`), { token: T('owner') }), 'delete staff');
    assert.ok((await api('POST', U('/login'), { body: { identifier: 'staff71@lib1.test', password: 'Staff#12345' } })).status >= 400, 'deleted staff cannot log in');
  });
};
