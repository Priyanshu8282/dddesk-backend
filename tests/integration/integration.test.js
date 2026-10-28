// End-to-end suite: real Express app + real in-memory MongoDB. Run from backend/: npm run test:integration (see README.md)
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const L = require('./lib');
const { api, P, U } = L;

const ctx = { tokens: {}, ids: {} };
const msg = (r) => `HTTP ${r.status} ${r.text ? r.text.slice(0, 400) : ''}`;
const expectStatus = (r, s, label = '') => assert.equal(r.status, s, `${label} ${msg(r)}`);
const ok = (r, label = '') => assert.ok(r.status >= 200 && r.status < 300, `${label} ${msg(r)}`);
const data = (r) => (r.body && (r.body.data !== undefined ? r.body.data : r.body));

test.before(async () => { await L.boot(); });
test.after(async () => { await L.shutdown(); });

// ---------------------------------------------------------------- 1. platform basics
test('01 health + root', async () => {
  ok(await api('GET', '/'), 'root');
  ok(await api('GET', U('/health')), 'health');
  ok(await api('GET', U('/branding')), 'branding');
  ok(await api('GET', U('/maintenance-status')), 'maintenance-status');
});

test('02 superadmin login + wrong password', async () => {
  const bad = await api('POST', U('/login'), { body: { identifier: 'root@dd.test', password: 'nope-nope' } });
  assert.ok([400, 401].includes(bad.status), msg(bad));
  const r = await api('POST', U('/login'), { body: { identifier: 'root@dd.test', password: 'SuperPass#123' } });
  ok(r, 'login');
  ctx.tokens.super = r.body.token || r.body.data.token;
  assert.ok(ctx.tokens.super);
  const me = await api('GET', P('/me'), { token: ctx.tokens.super });
  ok(me, 'me');
});

test('03 platform plan create + public plans', async () => {
  const r = await api('POST', P('/super/platform-plans'), { token: ctx.tokens.super, body: { name: 'Growth', monthlyPrice: 999, annualPrice: 9990, gstPercent: 18, trialDays: 14, graceDays: 7, maxStudents: 500, maxSeats: 300, maxStaff: 10, maxBranches: 3, isPopular: true } });
  ok(r, 'create plan');
  ctx.ids.platformPlan = data(r)._id || data(r).id;
  assert.ok(ctx.ids.platformPlan, msg(r));
  const pub = await api('GET', U('/plans'));
  ok(pub, 'public plans');
  const list = data(pub);
  assert.ok(JSON.stringify(list).includes('Growth'), msg(pub));
});

// ---------------------------------------------------------------- 2. self registration + approval
const OWNER = { mobile: '9876500001', email: 'owner@lib1.test', password: 'Owner#12345' };
test('04 registration OTP flow -> pending library', async () => {
  const s = await api('POST', U('/register/send-otp'), { body: { mobile: OWNER.mobile } });
  ok(s, 'send otp');
  const otp = data(s).otp;
  assert.match(String(otp), /^\d{6}$/, 'OTP returned in dev: ' + msg(s));
  const wrong = await api('POST', U('/register/verify-otp'), { body: { mobile: OWNER.mobile, otp: otp === '000000' ? '111111' : '000000' } });
  expectStatus(wrong, 400, 'wrong otp');
  const v = await api('POST', U('/register/verify-otp'), { body: { mobile: OWNER.mobile, otp } });
  ok(v, 'verify otp');
  const registrationToken = data(v).registrationToken;
  assert.ok(registrationToken);
  const noTok = await api('POST', U('/register'), { body: { name: 'Lib One', ownerName: 'Owner One', mobile: OWNER.mobile, email: OWNER.email, password: OWNER.password, address: '12 MG Road', city: 'Jaipur', state: 'Rajasthan', pincode: '302001', seatCapacity: 50, workingHours: { openingTime: '06:00 AM', closingTime: '11:00 PM' } } });
  assert.ok([400, 403].includes(noTok.status), 'registration without token must fail: ' + msg(noTok));
  const reg = await api('POST', U('/register'), { body: { registrationToken, name: 'Lib One', ownerName: 'Owner One', mobile: OWNER.mobile, email: OWNER.email, password: OWNER.password, address: '12 MG Road', city: 'Jaipur', state: 'Rajasthan', pincode: '302001', seatCapacity: 50, workingHours: { openingTime: '06:00 AM', closingTime: '11:00 PM' } } });
  expectStatus(reg, 201, 'register');
  ctx.ids.library = data(reg).library.id;
  assert.equal(data(reg).status, 'pending');
  // pending owner cannot sign in
  const login = await api('POST', U('/login'), { body: { identifier: OWNER.email, password: OWNER.password } });
  assert.ok(login.status >= 400, 'pending library login must be refused: ' + msg(login));
});

test('05 superadmin approves + assigns plan; owner logs in', async () => {
  const a = await api('PATCH', P(`/super/libraries/${ctx.ids.library}/approve`), { token: ctx.tokens.super });
  ok(a, 'approve');
  const p = await api('PATCH', P(`/super/libraries/${ctx.ids.library}/plan`), { token: ctx.tokens.super, body: { planId: ctx.ids.platformPlan } });
  ok(p, 'assign plan');
  const r = await api('POST', U('/login'), { body: { identifier: OWNER.email, password: OWNER.password } });
  ok(r, 'owner login');
  ctx.tokens.owner = r.body.token || r.body.data.token;
  ctx.ownerCookie = r.setCookie.map((c) => c.split(';')[0]).join('; ');
  assert.ok(ctx.tokens.owner);
  assert.match(ctx.ownerCookie, /dd_rt=/, 'refresh cookie set');
});

// ---------------------------------------------------------------- 3. sessions
test('06 refresh rotates, replay revokes, logout revokes', async () => {
  const origin = 'http://localhost:3000';
  const noCsrf = await api('POST', U('/refresh'), { cookie: ctx.ownerCookie });
  expectStatus(noCsrf, 403, 'refresh without csrf header');
  const r1 = await api('POST', U('/refresh'), { cookie: ctx.ownerCookie, headers: { 'x-requested-with': 'XMLHttpRequest', origin } });
  ok(r1, 'refresh');
  const newTok = r1.body.token;
  assert.ok(newTok);
  const newCookie = r1.setCookie.map((c) => c.split(';')[0]).join('; ');
  assert.notEqual(newCookie, ctx.ownerCookie, 'cookie rotated');
  // inside the 20 s grace window a parallel tab may present the previous cookie: allowed, but it gets no new cookie
  const parallel = await api('POST', U('/refresh'), { cookie: ctx.ownerCookie, headers: { 'x-requested-with': 'XMLHttpRequest', origin } });
  ok(parallel, 'parallel tab within grace');
  assert.equal(parallel.setCookie.length, 0, 'no cookie rotation for the parallel request');
  // after the grace window a replay of the old cookie is treated as theft and kills the session
  const Session = require(L.SRC + '/models/session.model');
  await Session.updateMany({ prevRefreshHash: { $ne: null } }, { $set: { rotatedAt: new Date(Date.now() - 120000) } });
  const replay = await api('POST', U('/refresh'), { cookie: ctx.ownerCookie, headers: { 'x-requested-with': 'XMLHttpRequest', origin } });
  assert.ok(replay.status === 401 || replay.status === 403, 'replay: ' + msg(replay));
  const after = await api('POST', U('/refresh'), { cookie: newCookie, headers: { 'x-requested-with': 'XMLHttpRequest', origin } });
  assert.ok(after.status === 401 || after.status === 403, 'session revoked after replay: ' + msg(after));
  const meOld = await api('GET', P('/me'), { token: newTok });
  assert.ok([200, 401].includes(meOld.status), msg(meOld));
  // fresh login + logout
  const l = await api('POST', U('/login'), { body: { identifier: OWNER.email, password: OWNER.password } });
  ok(l, 'login again');
  ctx.tokens.owner = l.body.token || l.body.data.token;
  const ck = l.setCookie.map((c) => c.split(';')[0]).join('; ');
  const lo = await api('POST', U('/logout'), { cookie: ck, headers: { 'x-requested-with': 'XMLHttpRequest', origin } });
  ok(lo, 'logout');
  const afterLogout = await api('POST', U('/refresh'), { cookie: ck, headers: { 'x-requested-with': 'XMLHttpRequest', origin } });
  assert.ok(afterLogout.status === 401 || afterLogout.status === 403, 'refresh after logout: ' + msg(afterLogout));
  // owner still has a valid access token only if its session is alive; re-login for later tests
  const l2 = await api('POST', U('/login'), { body: { identifier: OWNER.email, password: OWNER.password } });
  ctx.tokens.owner = l2.body.token || l2.body.data.token;
});

test('07 forged / tampered / missing tokens rejected', async () => {
  expectStatus(await api('GET', P('/me')), 401, 'no token');
  expectStatus(await api('GET', P('/me'), { token: 'abc.def.ghi' }), 401, 'garbage');
  const forged = require(L.SRC + '/../node_modules/jsonwebtoken').sign({ id: '000000000000000000000000' }, 'wrong-secret');
  expectStatus(await api('GET', P('/me'), { token: forged }), 401, 'forged');
  const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url') + '.' + Buffer.from(JSON.stringify({ id: ctx.ids.library })).toString('base64url') + '.';
  expectStatus(await api('GET', P('/me'), { token: none }), 401, 'alg none');
});

module.exports = { ctx, ok, expectStatus, data, msg };

// ---------------------------------------------------------------- 4. tenant setup: branches, roles, staff
const T = (k) => ctx.tokens[k];
const id = (r) => { const d = data(r); return d && (d._id || d.id || (d.branch && (d.branch._id || d.branch.id)) || (d.admin && (d.admin._id || d.admin.id)) || (d.student && (d.student._id || d.student.id)) || (d.plan && (d.plan._id || d.plan.id)) || (d.seat && (d.seat._id || d.seat.id))); };

test('08 branches: owner creates A and B; staff cannot create', async () => {
  const a = await api('POST', P('/branches'), { token: T('owner'), body: { name: 'Branch A', city: 'Jaipur', maxSeats: 50, maxStudents: 200 } });
  ok(a, 'branch A'); ctx.ids.branchA = id(a); assert.ok(ctx.ids.branchA, msg(a));
  const b = await api('POST', P('/branches'), { token: T('owner'), body: { name: 'Branch B', city: 'Jaipur', maxSeats: 50, maxStudents: 200 } });
  ok(b, 'branch B'); ctx.ids.branchB = id(b);
  assert.ok(ctx.ids.branchB, msg(b));
});

test('09 roles: system role templates available to the tenant', async () => {
  const r = await api('GET', P('/roles/get-roles'), { token: T('owner') });
  ok(r, 'roles');
  const list = data(r).roles || data(r).data || data(r);
  assert.ok(Array.isArray(list), msg(r));
  ctx.roles = Object.fromEntries(list.map((x) => [x.name, x._id || x.id]));
  assert.ok(ctx.roles.Receptionist || ctx.roles.Staff, 'tenant has staff roles: ' + Object.keys(ctx.roles).join(','));
});

const staffBody = (name, n, roleId, branchIds) => ({ name, mobile: `98765000${n}`, email: `staff${n}@lib1.test`, password: 'Staff#12345', confirmPassword: 'Staff#12345', roleId, branchIds });
async function mkStaff(key, n, roleName, branch) {
  const r = await api('POST', P('/admins'), { token: T('owner'), body: staffBody(key, n, ctx.roles[roleName], branch ? [branch] : []) });
  ok(r, 'create staff ' + key);
  ctx.ids[key] = id(r);
  const l = await api('POST', U('/login'), { body: { identifier: `staff${n}@lib1.test`, password: 'Staff#12345' } });
  ok(l, 'login ' + key);
  ctx.tokens[key] = l.body.token || l.body.data.token;
}
test('10 staff: receptionist A, receptionist B, accountant (no branch), manager', async () => {
  await mkStaff('recA', 21, 'Receptionist', ctx.ids.branchA);
  await mkStaff('recB', 22, 'Receptionist', ctx.ids.branchB);
  await mkStaff('acct', 23, 'Accountant', null);
  await mkStaff('mgr', 24, 'Manager', null);
});

test('11 membership plan + seats in both branches', async () => {
  const p = await api('POST', P('/plans'), { token: T('owner'), body: { name: 'Monthly 1000', durationType: 'monthly', price: 1000, depositAmount: 0, joiningFee: 0 } });
  ok(p, 'plan'); ctx.ids.plan = id(p); assert.ok(ctx.ids.plan, msg(p));
  const p2 = await api('POST', P('/plans'), { token: T('owner'), body: { name: 'Monthly 600 part', durationType: 'monthly', price: 600 } });
  ok(p2, 'plan2'); ctx.ids.plan2 = id(p2);
  for (const [k, br] of [['A', ctx.ids.branchA], ['B', ctx.ids.branchB]]) {
    const s = await api('POST', P('/seats/bulk'), { token: T('owner'), body: { prefix: `${k}-`, count: 5, startNumber: 1, branchId: br } });
    ok(s, 'seats ' + k);
  }
  const la = await api('GET', P(`/seats?branchId=${ctx.ids.branchA}&limit=50`), { token: T('owner') });
  ok(la, 'list seats');
  const seats = data(la).seats || data(la).data || data(la);
  assert.ok(Array.isArray(seats) && seats.length >= 5, msg(la));
  ctx.seatsA = seats.map((x) => x._id || x.id);
  const lb = await api('GET', P(`/seats?branchId=${ctx.ids.branchB}&limit=50`), { token: T('owner') });
  const seatsB = data(lb).seats || data(lb).data || data(lb);
  ctx.seatsB = seatsB.map((x) => x._id || x.id);
});

// ---------------------------------------------------------------- 5. students (consent, Aadhaar, isolation)
const verhoeffD = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
const verhoeffP = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
const verhoeffInv = [0,4,3,2,1,5,6,7,8,9];
const aadhaarWithCheck = (first11) => { let c = 0; const a = String(first11).split('').reverse().map(Number); for (let i = 0; i < a.length; i++) c = verhoeffD[c][verhoeffP[(i + 1) % 8][a[i]]]; return first11 + verhoeffInv[c]; };
const AAD1 = aadhaarWithCheck('23456789012');
const AAD2 = aadhaarWithCheck('34567890123');
const stu = (over = {}) => ({ name: 'Student One', mobile: '9811100001', password: 'Stud#12345', consentGiven: true, branchId: ctx.ids.branchA, ...over });

test('12 student create: consent, Aadhaar masked, duplicates, minors', async () => {
  const noConsent = await api('POST', P('/students/create-student'), { token: T('recA'), body: stu({ consentGiven: false, mobile: '9811100002' }) });
  expectStatus(noConsent, 400, 'no consent');
  const badAad = await api('POST', P('/students/create-student'), { token: T('recA'), body: stu({ mobile: '9811100003', aadhaarNumber: '234567890123' }) });
  expectStatus(badAad, 400, 'bad verhoeff');
  const minor = await api('POST', P('/students/create-student'), { token: T('recA'), body: stu({ mobile: '9811100004', dob: '2012-01-01' }) });
  expectStatus(minor, 400, 'minor without guardian');
  const minorOk = await api('POST', P('/students/create-student'), { token: T('recA'), body: stu({ name: 'Minor Kid', mobile: '9811100004', dob: '2012-01-01', guardianName: 'Parent', guardianMobile: '9811100099', guardianConsentGiven: true }) });
  ok(minorOk, 'minor with guardian'); ctx.ids.minor = id(minorOk);
  const s1 = await api('POST', P('/students/create-student'), { token: T('recA'), body: stu({ aadhaarNumber: AAD1, planId: ctx.ids.plan, seatId: ctx.seatsA[0], dob: '2000-05-05' }) });
  ok(s1, 'student 1'); ctx.ids.s1 = id(s1); assert.ok(ctx.ids.s1, msg(s1));
  assert.ok(!s1.text.includes(AAD1), 'full Aadhaar must never be echoed');
  assert.ok(!/"aadhaarNumber"/.test(s1.text), 'aadhaarNumber field not in response');
  const get = await api('GET', P(`/students/${ctx.ids.s1}`), { token: T('owner') });
  ok(get, 'get student');
  assert.ok(!get.text.includes(AAD1), 'Aadhaar not in GET');
  assert.match(get.text, /aadhaarMasked|XXXX/, 'masked Aadhaar present: ' + get.text.slice(0, 300));
  const dup = await api('POST', P('/students/create-student'), { token: T('recA'), body: stu({ mobile: '9811100005', name: 'Dup', aadhaarNumber: AAD1 }) });
  expectStatus(dup, 409, 'duplicate Aadhaar');
  const dupMobile = await api('POST', P('/students/create-student'), { token: T('recA'), body: stu({ name: 'Dup Mobile' }) });
  assert.ok(dupMobile.status >= 400, 'duplicate mobile in the same library: ' + msg(dupMobile));
  const badMobile = await api('POST', P('/students/create-student'), { token: T('recA'), body: stu({ mobile: '5811100009' }) });
  expectStatus(badMobile, 400, 'mobile must start 6-9');
});

test('13 student list/search are library + branch scoped', async () => {
  const s2 = await api('POST', P('/students/create-student'), { token: T('recB'), body: stu({ name: 'Student Two B', mobile: '9811100010', branchId: ctx.ids.branchB, planId: ctx.ids.plan, seatId: ctx.seatsB[0] }) });
  ok(s2, 'student 2'); ctx.ids.s2 = id(s2);
  const la = await api('GET', P('/students?limit=100'), { token: T('recA') });
  ok(la, 'recA list');
  const names = JSON.stringify(data(la));
  assert.ok(names.includes('Student One'), 'recA sees own branch student');
  assert.ok(!names.includes('Student Two B'), 'recA must NOT see branch B students');
  const lo = await api('GET', P('/students?limit=100'), { token: T('owner') });
  assert.ok(JSON.stringify(data(lo)).includes('Student Two B'), 'owner sees all');
});

test('14 branch isolation negatives (student/seat/ledger/receipt)', async () => {
  const getOther = await api('GET', P(`/students/${ctx.ids.s1}`), { token: T('recB') });
  assert.ok([403, 404].includes(getOther.status), 'recB reading branch A student: ' + msg(getOther));
  const assignOther = await api('PATCH', P(`/seats/${ctx.seatsB[1]}/assign`), { token: T('recB'), body: { studentId: ctx.ids.s1 } });
  assert.ok([403, 404].includes(assignOther.status), 'recB assigning branch A student to own seat: ' + msg(assignOther));
  const assignOtherSeat = await api('PATCH', P(`/seats/${ctx.seatsA[1]}/assign`), { token: T('recB'), body: { studentId: ctx.ids.s2 } });
  assert.ok([403, 404].includes(assignOtherSeat.status), 'recB assigning to branch A seat: ' + msg(assignOtherSeat));
  const tr = await api('POST', P('/seats/transfer'), { token: T('recB'), body: { studentId: ctx.ids.s1, toSeatId: ctx.seatsB[2] } });
  assert.ok([403, 404].includes(tr.status), 'recB transferring branch A student: ' + msg(tr));
  const ledger = await api('GET', P(`/students/${ctx.ids.s1}/ledger`), { token: T('recB') });
  assert.ok([403, 404].includes(ledger.status), 'ledger of other branch: ' + msg(ledger));
  const upd = await api('PUT', P(`/students/update-student/${ctx.ids.s1}`), { token: T('recB'), body: { name: 'Hacked' } });
  assert.ok([403, 404, 405].includes(upd.status) || upd.status === 400, 'update other branch student: ' + msg(upd));
});

// ---- parts (each registers more tests, in order)
const H = { ctx, ok, expectStatus, data, msg, T, id, staffBody, mkStaff, stu, AAD1, AAD2, aadhaarWithCheck };
for (const f of (process.env.DD_PARTS || 'p_fees,p_members,p_security,p_sub,p_edge,p_adv,p_receipts,p_smoke,p_ops,p_realtime,p_legal,p_modules,p_mobile,p_student_app').split(',').filter(Boolean)) require('./' + f)(H);
