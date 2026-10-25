// Part: socket.io auth, room isolation, events.
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./lib');
const { api, P } = L;

module.exports = (H) => {
  const { ctx, ok, data, msg, T, stu } = H;
  const { io } = require('socket.io-client');
  const connect = (token, opts = {}) => new Promise((resolve) => {
    const s = io(L.state.base, { path: '/socket.io', transports: ['websocket'], auth: token === undefined ? {} : { token }, reconnection: false, forceNew: true, extraHeaders: { 'x-forwarded-for': L.freshIp() }, ...opts });
    const events = [];
    s.onAny((name, payload) => events.push({ name, payload }));
    s.on('connect', () => resolve({ s, events, ok: true }));
    s.on('connect_error', (e) => resolve({ s, events, ok: false, error: e.message }));
  });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const names = (c) => c.events.map((e) => e.name);

  test('46 socket auth: no token / garbage / forged rejected, valid accepted', async () => {
    const a = await connect(undefined); assert.equal(a.ok, false, 'no token'); a.s.close();
    const b = await connect('not.a.jwt'); assert.equal(b.ok, false, 'garbage token'); b.s.close();
    const jwt = require(L.SRC + '/../node_modules/jsonwebtoken');
    const c = await connect(jwt.sign({ id: '6add6c3cbfe08127400b2a06', type: 'admin' }, 'wrong-secret')); assert.equal(c.ok, false, 'forged'); c.s.close();
    const d = await connect(T('owner')); assert.equal(d.ok, true, 'valid owner token: ' + d.error); d.s.close();
    const e = await connect(T('super')); assert.equal(e.ok, true, 'valid superadmin token: ' + e.error); e.s.close();
    const cors = await connect(T('owner'), { extraHeaders: { origin: 'https://evil.example', 'x-forwarded-for': L.freshIp() } });
    assert.equal(cors.ok, false, 'browser origin not on the allow-list is refused'); cors.s.close();
  });

  test('47 room isolation: library, branch and fee-permission scoping of events', async () => {
    const owner = await connect(T('owner')); const recA = await connect(T('recA')); const recB = await connect(T('recB'));
    const acct = await connect(T('acct')); const owner2 = await connect(T('owner2')); const sup = await connect(T('super'));
    for (const c of [owner, recA, recB, acct, owner2, sup]) assert.ok(c.ok, 'connected: ' + c.error);
    // a student is created in branch A by the branch-A receptionist
    ok(await api('POST', P('/students/create-student'), { token: T('recA'), body: stu({ name: 'Live Lena', mobile: '9811100071' }) }), 'create');
    await wait(700);
    console.log('EVENTS owner:', names(owner).join(','), '| recA:', names(recA).join(','), '| recB:', names(recB).join(','), '| owner2:', names(owner2).join(','), '| super:', names(sup).join(','));
    assert.ok(names(owner).length > 0, 'library owner is told');
    assert.ok(names(recA).length > 0, 'branch-A staff is told');
    assert.equal(names(recB).length, 0, 'branch-B staff must not receive branch-A events');
    assert.equal(names(owner2).length, 0, 'another library must receive nothing');
    const blob = JSON.stringify([...owner.events, ...recA.events]);
    assert.ok(!/Live Lena|9811100071/.test(blob), 'events carry counters/ids only, never personal data');
    // a payment: only people with fee visibility hear about money
    const st = await api('GET', P('/students?search=Live%20Lena'), { token: T('owner') });
    const sid = (data(st)[0] || {})._id;
    ok(await api('POST', P('/payments'), { token: T('acct'), body: { studentId: sid, amount: 500, description: 'live charge' } }), 'charge 500');
    const before = { recA: recA.events.length, acct: acct.events.length, owner: owner.events.length };
    ok(await api('POST', P('/payments'), { token: T('acct'), body: { studentId: sid, paidAmount: 250, paymentMethod: 'cash', requestId: 'live-pay-0001' } }), 'collect');
    await wait(700);
    const got = (c, from) => c.events.slice(from).map((e) => e.name + (e.payload && e.payload.amount ? `(${e.payload.amount})` : ''));
    console.log('PAYMENT EVENTS owner:', got(owner, before.owner).join(','), '| acct:', got(acct, before.acct).join(','), '| recA:', got(recA, before.recA).join(','));
    assert.ok(got(owner, before.owner).some((n) => n.startsWith('payment:received')), 'owner hears the payment');
    assert.ok(!got(recA, before.recA).some((n) => n.startsWith('payment:received')), 'receptionist without fees.view must not hear payment amounts');
    // platform events for the superadmin
    const sup0 = sup.events.length;
    const s = await api('POST', L.state.base ? '/v1/public/register/send-otp' : '', { body: { mobile: '9876500004' } });
    const v = await api('POST', '/v1/public/register/verify-otp', { body: { mobile: '9876500004', otp: data(s).otp } });
    ok(await api('POST', '/v1/public/register', { body: { registrationToken: data(v).registrationToken, name: 'Lib Four', ownerName: 'Owner Four', mobile: '9876500004', email: 'owner@lib4.test', password: 'Owner#44444', address: '4 Lane', city: 'Sikar', state: 'Rajasthan', pincode: '332001', seatCapacity: 10, workingHours: { openingTime: '06:00 AM', closingTime: '10:00 PM' } } }), 'register 4');
    await wait(700);
    console.log('SUPER EVENTS after a registration:', sup.events.slice(sup0).map((e) => e.name).join(','));
    assert.ok(sup.events.length > sup0, 'superadmin is told about a new registration');
    assert.ok(!names(owner).includes('library:registered'), 'library owners do not receive platform events');
    ctx.sockets = { owner, recA, recB, acct, owner2, sup };
  });

  test('48 sockets are dropped when the session is revoked', async () => {
    const l = await api('POST', '/v1/public/login', { body: { identifier: 'staff22@lib1.test', password: 'Staff#12345' } });
    const tok = l.body.token || l.body.data.token;
    const c = await connect(tok); assert.ok(c.ok);
    const closed = new Promise((r) => c.s.on('disconnect', (reason) => r(reason)));
    ok(await api('POST', P('/logout-all'), { token: tok }), 'logout-all');
    const reason = await Promise.race([closed, wait(4000).then(() => 'still-connected')]);
    console.log('socket after logout-all ->', reason);
    assert.notEqual(reason, 'still-connected', 'revoked session loses its socket within the check interval');
    for (const c2 of Object.values(ctx.sockets || {})) c2.s.close();
  });
};
