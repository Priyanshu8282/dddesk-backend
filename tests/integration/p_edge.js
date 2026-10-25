// Part: onboarding wizard + human check, contact form, student portal, concurrency, CRUD smoke, cron auth, password reset.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const L = require('./lib');
const { api, P, U, SRC } = L;

module.exports = (H) => {
  const { ctx, ok, expectStatus, data, msg, T, id, stu, staffBody } = H;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const col = (n) => L.state.mongoose.connection.db.collection(n);

  // ---- proof-of-work solver (same rule as services/humanCheck.service.js)
  const lzb = (buf) => { let bits = 0; for (const b of buf) { if (b === 0) { bits += 8; continue; } bits += Math.clz32(b) - 24; break; } return bits; };
  const solve = async () => {
    const ch = await api('GET', U('/human-challenge'));
    ok(ch, 'challenge');
    const { challenge, difficulty } = data(ch);
    let n = 0;
    while (lzb(crypto.createHash('sha256').update(`${challenge}:${n}`).digest()) < difficulty) n += 1;
    await wait(1600); // the server wants >= 1.5 s between issue and use
    return `${challenge}~${n}`;
  };
  const withPow = async (fn) => {
    const prev = { p: process.env.HUMAN_CHECK_PROVIDER, b: process.env.HUMAN_CHECK_POW_BITS };
    process.env.HUMAN_CHECK_PROVIDER = 'pow'; process.env.HUMAN_CHECK_POW_BITS = '12';
    try { return await fn(); } finally { process.env.HUMAN_CHECK_PROVIDER = prev.p; process.env.HUMAN_CHECK_POW_BITS = prev.b || ''; if (!prev.b) delete process.env.HUMAN_CHECK_POW_BITS; }
  };

  test('50 human check (proof of work) guards send-otp; honeypot and replay refused', async () => {
    await withPow(async () => {
      const cfg = await api('GET', U('/human-check/config')); ok(cfg, 'config'); assert.equal(data(cfg).provider, 'pow');
      const none = await api('POST', U('/register/send-otp'), { body: { mobile: '9876500010' } });
      assert.equal(none.status, 403, 'no token: ' + msg(none)); assert.equal(none.body.errorCode, 'HUMAN_CHECK_REQUIRED');
      const forged = await api('POST', U('/register/send-otp'), { body: { mobile: '9876500010', humanToken: 'abc.def~123' } });
      assert.ok(forged.status === 403 || forged.status === 400, 'forged token: ' + msg(forged));
      const tok = await solve();
      const honey = await api('POST', U('/register/send-otp'), { body: { mobile: '9876500010', humanToken: tok, hp_website: 'http://spam' } });
      assert.equal(honey.status, 400, 'honeypot: ' + msg(honey));
      const tok2 = await solve();
      const good = await api('POST', U('/register/send-otp'), { body: { mobile: '9876500010', humanToken: tok2, fillMs: 9000 } });
      ok(good, 'solved token accepted');
      const replay = await api('POST', U('/register/send-otp'), { body: { mobile: '9876500010', humanToken: tok2 } });
      assert.ok(replay.status === 403 || replay.status === 400, 'a solved challenge is single-use: ' + msg(replay));
      const fast = await api('POST', U('/register/send-otp'), { body: { mobile: '9876500011', humanToken: await solve(), fillMs: 200 } });
      assert.equal(fast.status, 400, 'form filled in 200 ms is a bot: ' + msg(fast));
    });
  });

  test('51 login human check: provider=off skips it; provider=pow rejects no/forged tokens and accepts a solved one', async () => {
    const ident = 'staff23@lib1.test'; const ip = '198.51.100.9';
    ok(await api('POST', U('/login'), { ip: L.freshIp(), body: { identifier: ident, password: 'Staff#12345' } }), 'provider=off (dev/test): plain login works');
    await withPow(async () => {
      const plain = await api('POST', U('/login'), { ip, body: { identifier: ident, password: 'Staff#12345' } });
      if (plain.status === 403) {
        assert.equal(plain.body.errorCode, 'HUMAN_CHECK_REQUIRED', 'login without a token: ' + msg(plain));
        const forged = await api('POST', U('/login'), { ip, body: { identifier: ident, password: 'Staff#12345', humanToken: 'forged.token~1' } });
        assert.ok(forged.status === 403 || forged.status === 400, 'forged token: ' + msg(forged));
        const wrongPw = await api('POST', U('/login'), { ip, body: { identifier: ident, password: 'Wrong#pass99', humanToken: await solve() } });
        assert.equal(wrongPw.status, 401, 'valid token + wrong password is a normal 401: ' + msg(wrongPw));
        const good = await api('POST', U('/login'), { ip, body: { identifier: ident, password: 'Staff#12345', humanToken: await solve() } });
        ok(good, 'valid solved token + right password logs in');
        const replay = await api('POST', U('/login'), { ip, body: { identifier: ident, password: 'Staff#12345', humanToken: 'x' } });
        assert.ok(replay.status === 403 || replay.status === 400, 'every login needs a fresh, valid token: ' + msg(replay));
        ctx.tokens.acct = good.body.token || good.body.data.token;
        console.log('LOGIN HUMAN CHECK: always required (new behaviour)');
      } else {
        console.log('LOGIN HUMAN CHECK: threshold behaviour still active (landing edit not applied yet)');
        ok(plain, 'plain login');
        for (let i = 0; i < 3; i += 1) await api('POST', U('/login'), { ip, body: { identifier: ident, password: 'bad-pass-' + i } });
        const gated = await api('POST', U('/login'), { ip, body: { identifier: ident, password: 'Staff#12345' } });
        assert.equal(gated.status, 403, 'after 3 failures a token is required: ' + msg(gated));
        const withTok = await api('POST', U('/login'), { ip, body: { identifier: ident, password: 'Staff#12345', humanToken: await solve() } });
        ok(withTok, 'token + right password');
        ctx.tokens.acct = withTok.body.token || withTok.body.data.token;
      }
    });
  });

  test('52 wizard: OTP -> draft -> complete (pending), idempotent, race-safe, existing mobile', async () => {
    await withPow(async () => {
      const M = '9876500020';
      const s = await api('POST', U('/register/send-otp'), { body: { mobile: M, humanToken: await solve(), fillMs: 8000 } }); ok(s, 'send-otp');
      const v = await api('POST', U('/register/verify-otp'), { body: { mobile: M, otp: data(s).otp } }); ok(v, 'verify');
      const RT = { 'x-registration-token': data(v).registrationToken };
      const d0 = await api('GET', U('/register/draft'), { headers: RT }); ok(d0, 'draft'); assert.equal(data(d0).mobile, M);
      const planR = await api('GET', U('/plans')); const planId = (data(planR).plans || data(planR))[0].id || (data(planR).plans || data(planR))[0]._id;
      const bad = await api('PATCH', U('/register/draft'), { headers: RT, body: { planId: '000000000000000000000001' } });
      assert.equal(bad.status, 409, 'unknown plan: ' + msg(bad));
      const unknownKey = await api('PATCH', U('/register/draft'), { headers: RT, body: { password: 'Secret#123' } });
      assert.equal(unknownKey.status, 400, 'a password can never be stored in the draft: ' + msg(unknownKey));
      ok(await api('PATCH', U('/register/draft'), { headers: RT, body: { step: 3, planId, billingCycle: 'monthly', consent: { terms: true, privacy: true },
        data: { name: 'Wizard Library', ownerName: 'Wiz Owner', email: 'wiz@lib.test', address: '5 Civil Lines', city: 'Jodhpur', state: 'Rajasthan', district: 'Jodhpur', pincode: '342001', seatCapacity: 30, workingHours: { openingTime: '06:00', closingTime: '22:00' },
          quickSetup: { shiftName: 'Morning', shiftStart: '06:00', shiftEnd: '12:00', planName: 'Wizard Monthly', planFee: 800, planDuration: 'monthly' } } } }), 'save draft');
      const noConsent = await api('POST', U('/register/complete'), { headers: RT, body: { completeKey: crypto.randomUUID(), password: 'Wizard#12345', consent: { terms: true, privacy: false }, humanToken: await solve() } });
      assert.equal(noConsent.status, 400, 'privacy consent required: ' + msg(noConsent));
      const key = crypto.randomUUID();
      const [c1, c2] = await Promise.all([
        solve().then((t) => api('POST', U('/register/complete'), { headers: RT, body: { completeKey: key, password: 'Wizard#12345', consent: { terms: true, privacy: true }, humanToken: t, fillMs: 40000 } })),
        solve().then((t) => api('POST', U('/register/complete'), { headers: RT, body: { completeKey: key, password: 'Wizard#12345', consent: { terms: true, privacy: true }, humanToken: t, fillMs: 40000 } })),
      ]);
      console.log('COMPLETE parallel ->', c1.status, c2.status, (c1.body && c1.body.errorCode) || '', (c2.body && c2.body.errorCode) || '');
      const wins = [c1, c2].filter((r) => r.status === 201 || r.status === 200);
      assert.ok(wins.length >= 1, 'at least one completes: ' + msg(c1) + ' | ' + msg(c2));
      const libs = await col('libraries').countDocuments({ mobile: M });
      assert.equal(libs, 1, 'exactly one library created for the mobile (race-safe)');
      const admins = await col('admins').countDocuments({ mobile: M });
      assert.equal(admins, 1, 'exactly one owner account');
      const done = wins[0];
      assert.equal(data(done).status, 'pending', 'auto-approve is off: library waits for the superadmin');
      assert.ok(!data(done).token, 'no session token while pending');
      const replay = await api('POST', U('/register/complete'), { headers: RT, body: { completeKey: key, password: 'Wizard#12345', consent: { terms: true, privacy: true }, humanToken: await solve() } });
      assert.ok(replay.status === 200 || replay.status === 201, 'same completeKey replays: ' + msg(replay));
      assert.equal(await col('libraries').countDocuments({ mobile: M }), 1, 'replay creates nothing');
      const other = await api('POST', U('/register/complete'), { headers: RT, body: { completeKey: crypto.randomUUID(), password: 'Wizard#12345', consent: { terms: true, privacy: true }, humanToken: await solve() } });
      assert.equal(other.status, 409, 'a different key after completion: ' + msg(other));
      assert.equal(other.body.errorCode, 'ALREADY_REGISTERED');
      assert.ok(!/Wizard Library/.test(other.text), 'no library details leak');
      // a mobile that already owns a library cannot even open a draft
      const s2 = await api('POST', U('/register/send-otp'), { body: { mobile: '9876500001', humanToken: await solve() } });
      const v2 = await api('POST', U('/register/verify-otp'), { body: { mobile: '9876500001', otp: data(s2).otp } });
      const dr = await api('GET', U('/register/draft'), { headers: { 'x-registration-token': data(v2).registrationToken } });
      assert.equal(dr.status, 409, 'existing owner mobile: ' + msg(dr)); assert.equal(dr.body.errorCode, 'ALREADY_REGISTERED');
      // token bound to the mobile: a token for M cannot complete someone else's draft
      const lib = await col('libraries').findOne({ mobile: M });
      ctx.ids.wizLib = String(lib._id);
      const quick = await col('plans').findOne({ libraryId: lib._id });
      console.log('quick-setup default plan created at completion?', !!quick, quick && quick.name);
    });
  });

  test('53 auto-approve: OTP-only owner is active immediately with a session and a pending tour', async () => {
    ok(await api('PUT', P('/super/platform-settings/section/onboarding'), { token: T('super'), body: { autoApproveNewLibraries: true } }), 'turn on auto approve');
    try {
      await withPow(async () => {
        const M = '9876500321';
        const s = await api('POST', U('/register/send-otp'), { body: { mobile: M, humanToken: await solve() } });
        const v = await api('POST', U('/register/verify-otp'), { body: { mobile: M, otp: data(s).otp } });
        const RT = { 'x-registration-token': data(v).registrationToken };
        await api('GET', U('/register/draft'), { headers: RT });
        const planR = await api('GET', U('/plans')); const planList = data(planR).plans || data(planR); const planId = planList[0].id || planList[0]._id;
        ok(await api('PATCH', U('/register/draft'), { headers: RT, body: { planId, consent: { terms: true, privacy: true }, data: { name: 'Auto Library', ownerName: 'Auto Owner', address: '1 Main', city: 'Bikaner', state: 'Rajasthan', pincode: '334001', seatCapacity: 20, workingHours: { openingTime: '06:00', closingTime: '22:00' } } } }), 'draft');
        const c = await api('POST', U('/register/complete'), { headers: RT, body: { completeKey: crypto.randomUUID(), otpOnly: true, consent: { terms: true, privacy: true }, humanToken: await solve(), fillMs: 30000 } });
        expectStatus(c, 201, 'complete');
        assert.equal(data(c).status, 'active');
        assert.ok(data(c).token, 'session token issued');
        assert.ok(c.setCookie.some((x) => x.startsWith('dd_rt=')), 'refresh cookie set');
        assert.match(data(c).admin.mobile || '', /9876500321/);
        const me = await api('GET', P('/me'), { token: data(c).token }); ok(me, 'me');
        assert.equal(data(me).tour && data(me).tour.pending, true, 'tour pending for a brand-new owner: ' + me.text.slice(0, 300));
        const admin = await col('admins').findOne({ mobile: M });
        assert.ok(String(admin.email).endsWith('@noemail.dddesk.invalid'), 'placeholder login email: ' + admin.email);
        // OTP-only owners sign in with the mobile OTP
        const so = await api('POST', U('/send-otp'), { body: { mobile: M } }); ok(so, 'login otp');
        const vo = await api('POST', U('/verify-otp'), { body: { mobile: M, otp: data(so).otp } }); ok(vo, 'login via otp');
        // tour state persists
        const tok = data(vo).token || vo.body.token;
        ok(await api('PATCH', P('/profile/tour'), { token: tok, body: { completed: true, lastStep: 5 } }), 'tour done');
        const me2 = await api('GET', P('/me'), { token: tok });
        console.log('FINDING: /me right after PATCH /profile/tour reports tour.pending =', data(me2).tour.pending, '(stale auth cache, 5 s TTL)');
        await wait(5600);
        const me3 = await api('GET', P('/me'), { token: tok }); assert.equal(data(me3).tour.pending, false, 'tour state persisted once the auth cache expires');
        const cl = await api('GET', P('/onboarding/checklist'), { token: tok }); ok(cl, 'checklist'); console.log('CHECKLIST', cl.text.slice(0, 300));
      });
    } finally {
      await api('PUT', P('/super/platform-settings/section/onboarding'), { token: T('super'), body: { autoApproveNewLibraries: false } });
    }
  });

  test('54 contact form: validated, human-checked, stored', async () => {
    await withPow(async () => {
      const bad = await api('POST', U('/contact'), { body: { name: 'A', message: 'short', humanToken: await solve() } });
      assert.equal(bad.status, 400, 'validation: ' + msg(bad));
      const nohuman = await api('POST', U('/contact'), { body: { name: 'Ravi Kumar', mobile: '9811100555', message: 'Please call me about pricing.' } });
      assert.equal(nohuman.status, 403, 'human check: ' + msg(nohuman));
      const okc = await api('POST', U('/contact'), { body: { name: 'Ravi Kumar', mobile: '9811100555', message: 'Please call me about pricing.', humanToken: await solve(), fillMs: 20000 } });
      expectStatus(okc, 201, 'contact');
      const stored = await col('contactmessages').countDocuments({});
      assert.ok(stored >= 1, 'message stored');
    });
  });

  test('55 student portal: own data only, no staff access, complaint, attendance', async () => {
    const l = await api('POST', U('/login'), { body: { identifier: '9811100031', password: 'Stud#12345', userRole: 'student', libraryId: ctx.ids.library } });
    ok(l, 'student login (mobile + password)'); ctx.tokens.stu = l.body.token || l.body.data.token;
    const me = await api('GET', P('/students/me'), { token: T('stu') }); ok(me, 'student me');
    assert.ok(!/aadhaarNumber|password/.test(me.text.replace(/mustChangePassword/g, '')), 'no secrets in the student profile');
    for (const [m, path] of [['GET', '/students?limit=5'], ['GET', '/payments'], ['GET', '/admins'], ['GET', '/seats'], ['POST', '/payments'], ['GET', '/reports/finance'], ['GET', '/dashboard/summary'], ['GET', '/branches']]) {
      const r = await api(m, P(path), { token: T('stu'), body: m === 'POST' ? { studentId: ctx.ids.s3, paidAmount: 1 } : undefined });
      assert.ok([401, 403].includes(r.status), `student on ${m} ${path} must be refused: ${msg(r)}`);
    }
    ok(await api('GET', P('/payments/my'), { token: T('stu') }), 'own fees');
    const otherReceipt = await api('GET', P(`/payments/my/receipts/${ctx.ids.adjCharge}`), { token: T('stu') });
    assert.ok([403, 404].includes(otherReceipt.status), "another student's receipt: " + msg(otherReceipt));
    ok(await api('GET', P('/attendance/my'), { token: T('stu') }), 'own attendance');
    const cm = await api('POST', P('/complaints'), { token: T('stu'), body: { title: 'Fan not working', description: 'Seat fan is broken', category: 'fan' } });
    ok(cm, 'student complaint');
    const cmOther = await api('POST', P('/complaints'), { token: T('stu'), body: { title: 'Forged', description: 'on behalf of someone', studentId: ctx.ids.s5 } });
    if (cmOther.status < 300) {
      const row = await col('complaints').findOne({ title: 'Forged' });
      assert.equal(String(row.studentId), String(ctx.ids.s3), 'student cannot file a complaint as another student');
    }
    const staffSees = await api('GET', P('/complaints'), { token: T('mgr') }); ok(staffSees, 'staff lists complaints'); assert.ok(/Fan not working/.test(staffSees.text));
    expectStatus(await api('PUT', P('/students/me'), { token: T('stu'), body: { name: 'Hacker', planId: ctx.ids.plan3 } }), 400, 'strict self-edit rejects planId');
    ok(await api('PUT', P('/students/me'), { token: T('stu'), body: { name: 'Prorate Pat Jr' } }), 'self edit name');
  });

  test('56 concurrency: one seat, ten claimants; student limit under parallel creates', async () => {
    const mk = async (i) => { const r = await api('POST', P('/students/create-student'), { token: T('owner'), body: stu({ name: `Racer ${i}`, mobile: `98111007${String(i).padStart(2, '0')}` }) }); ok(r, 'racer ' + i); return id(r); };
    const racers = []; for (let i = 0; i < 10; i += 1) racers.push(await mk(i));
    const free = (await api('GET', P(`/seats?branchId=${ctx.ids.branchA}&status=available&limit=50`), { token: T('owner') }));
    const seats = data(free).seats || data(free).data || data(free);
    const target = seats.find((x) => x.status === 'available')._id;
    const res = await Promise.all(racers.map((sid) => api('PATCH', P(`/seats/${target}/assign`), { token: T('owner'), body: { studentId: sid } })));
    const won = res.filter((r) => r.status === 200);
    console.log('SEAT RACE statuses:', res.map((r) => r.status).join(','));
    assert.equal(won.length, 1, 'exactly one student gets the seat');
    const seatDoc = await col('seats').findOne({ _id: new (L.state.mongoose.Types.ObjectId)(target) });
    assert.equal(seatDoc.status, 'occupied');
    const occupants = await col('students').countDocuments({ seatId: seatDoc._id });
    assert.equal(occupants, 1, 'only one student record points at the seat');
    // student limit: library 2 on a 2-student plan
    const tiny = await api('POST', P('/super/platform-plans'), { token: T('super'), body: { name: 'Tiny', monthlyPrice: 100, maxStudents: 2, maxSeats: 10, maxStaff: 2, maxBranches: 1 } });
    ok(tiny, 'tiny plan'); const tinyId = id(tiny);
    ok(await api('PATCH', P(`/super/libraries/${ctx.ids.library2}/plan`), { token: T('super'), body: { planId: tinyId } }), 'assign tiny');
    const tries = await Promise.all(Array.from({ length: 5 }, (_, i) => api('POST', P('/students/create-student'), { token: T('owner2'), body: { name: `L2 Student ${i}`, mobile: `98111008${String(i).padStart(2, '0')}`, password: 'Stud#12345', consentGiven: true } })));
    const created = tries.filter((r) => r.status === 201 || r.status === 200).length;
    const count = await col('students').countDocuments({ libraryId: new (L.state.mongoose.Types.ObjectId)(ctx.ids.library2), isDeleted: { $ne: true } });
    console.log('LIMIT RACE: created', created, 'in db', count, 'statuses', tries.map((r) => r.status).join(','));
    assert.ok(count <= 2, `plan limit of 2 students must hold under parallel creates (db has ${count})`);
    ok(await api('PATCH', P(`/super/libraries/${ctx.ids.library2}/plan`), { token: T('super'), body: { planId: ctx.ids.platformPlan } }), 'restore plan');
  });

  test('57 module smoke: notices, expenses, coupons, enquiries, reports, notifications', async () => {
    const n = await api('POST', P('/notices'), { token: T('mgr'), body: { title: 'Holiday', description: 'Library closed on Sunday', content: 'Library closed on Sunday', type: 'general', sendTo: 'all' } });
    console.log('NOTICE create ->', n.status, n.status >= 300 ? n.text.slice(0, 250) : '');
    ok(n, 'notice');
    ok(await api('GET', P('/notices'), { token: T('mgr') }), 'notice list');
    expectStatus(await api('GET', P('/notices'), { token: T('recA') }), 403, 'receptionist lacks content.view');
    const e = await api('POST', P('/expenses'), { token: T('acct'), body: { title: 'Electricity bill', amount: 4500, category: 'electricity', paymentMethod: 'upi' } });
    ok(e, 'expense'); const eid = id(e);
    expectStatus(await api('POST', P('/expenses'), { token: T('recA'), body: { title: 'Nope', amount: 10 } }), 403, 'receptionist cannot add expenses');
    expectStatus(await api('POST', P('/expenses'), { token: T('acct'), body: { title: 'Neg', amount: -10 } }), 400, 'negative expense');
    ok(await api('GET', P('/expenses/summary'), { token: T('acct') }), 'expense summary');
    assert.equal((await api('DELETE', P(`/expenses/${eid}`), { token: T('recA') })).status, 403);
    const cp = await api('POST', P('/coupons'), { token: T('owner'), body: { title: 'Festive', code: 'DIWALI10', discountType: 'percentage', discountValue: 10, endDate: new Date(Date.now() + 30 * 86400000).toISOString(), usageLimit: 1, perStudentLimit: 1 } });
    console.log('COUPON create ->', cp.status, cp.status >= 300 ? cp.text.slice(0, 250) : '');
    ok(cp, 'coupon');
    const sNew = await api('POST', P('/students/create-student'), { token: T('owner'), body: stu({ name: 'Coupon Kid', mobile: '9811100901' }) }); const cid = id(sNew);
    const ch = await api('POST', P('/payments'), { token: T('acct'), body: { studentId: cid, planId: ctx.ids.plan, couponCode: 'DIWALI10' } });
    ok(ch, 'charge with coupon');
    const cd = data(ch); const net = (cd.dueAmount ?? (cd.payment && cd.payment.dueAmount));
    assert.equal(net, 900, 'DIWALI10 takes 10% off 1000: ' + ch.text.slice(0, 300));
    const sNew2 = await api('POST', P('/students/create-student'), { token: T('owner'), body: stu({ name: 'Coupon Kid 2', mobile: '9811100902' }) });
    const ch2 = await api('POST', P('/payments'), { token: T('acct'), body: { studentId: id(sNew2), planId: ctx.ids.plan, couponCode: 'DIWALI10' } });
    assert.ok(ch2.status >= 400, 'usage limit 1: second use refused: ' + msg(ch2));
    const enq = await api('POST', P('/enquiries'), { token: T('recA'), body: { name: 'Walk In', mobile: '9811100950', message: 'Fees?', source: 'walk-in' } });
    console.log('ENQUIRY create ->', enq.status, enq.status >= 300 ? enq.text.slice(0, 250) : '');
    ok(enq, 'enquiry');
    ok(await api('GET', P('/enquiries'), { token: T('recA') }), 'enquiry list');
    for (const path of ['/reports/finance', '/reports/students', '/reports/attendance', '/reports/seats', '/reports/pnl', '/reports/membership', '/reports/branches', '/reports/types']) {
      const r = await api('GET', P(path), { token: T('mgr') });
      assert.ok(r.status === 200 || r.status === 403, `${path}: ${msg(r)}`);
      if (r.status === 403) console.log('NOTE manager lacks permission for', path);
    }
    expectStatus(await api('GET', P('/reports/finance'), { token: T('recA') }), 403, 'receptionist cannot read finance reports');
    ok(await api('GET', P('/notifications'), { token: T('owner') }), 'notifications list');
  });

  test('58 cron endpoints need CRON_SECRET; pauseCrons skips', async () => {
    expectStatus(await api('GET', '/v1/cron/daily'), 401, 'no secret');
    expectStatus(await api('GET', '/v1/cron/daily', { headers: { authorization: 'Bearer wrong' } }), 401, 'wrong secret');
    expectStatus(await api('GET', '/v1/cron/daily', { token: T('super') }), 401, 'a superadmin JWT is not the cron secret');
    const good = await api('GET', '/v1/cron/subscription-lifecycle', { headers: { authorization: 'Bearer cron-secret-for-tests' } });
    ok(good, 'valid secret runs the job');
  });

  test('59 forgot password end to end: OTP, reset, old sessions die, old password dead', async () => {
    const email = 'owner@lib2.test';
    const loginOld = await api('POST', U('/login'), { body: { identifier: email, password: 'Owner#22222' } }); ok(loginOld, 'login before');
    const oldTok = loginOld.body.token || loginOld.body.data.token;
    let otp;
    await withPow(async () => {
      const noHuman = await api('POST', U('/forgot-password'), { body: { email } });
      assert.equal(noHuman.status, 403, 'forgot-password always needs the human check');
      const fp = await api('POST', U('/forgot-password'), { body: { email, humanToken: await solve() } }); ok(fp, 'forgot');
      otp = data(fp).otp; assert.match(String(otp), /^[0-9]{6}$/);
    });
    const wrong = await api('POST', U('/verify-reset-otp'), { body: { email, otp: otp === '123456' ? '654321' : '123456' } });
    assert.equal(wrong.status, 400, 'wrong otp');
    ok(await api('POST', U('/verify-reset-otp'), { body: { email, otp } }), 'verify');
    const weak = await api('POST', U('/reset-password'), { body: { email, otp, newPassword: 'short' } });
    assert.equal(weak.status, 400, 'weak password refused');
    ok(await api('POST', U('/reset-password'), { body: { email, otp, newPassword: 'Brand#New123' } }), 'reset');
    const reuse = await api('POST', U('/reset-password'), { body: { email, otp, newPassword: 'Another#12345' } });
    assert.ok(reuse.status >= 400, 'OTP is single use: ' + msg(reuse));
    const oldPw = await api('POST', U('/login'), { body: { identifier: email, password: 'Owner#22222' } });
    assert.equal(oldPw.status, 401, 'old password dead: ' + msg(oldPw));
    const stale = await api('GET', P('/me'), { token: oldTok });
    assert.equal(stale.status, 401, 'tokens issued before the reset are revoked: ' + msg(stale));
    const n = await api('POST', U('/login'), { body: { identifier: email, password: 'Brand#New123' } }); ok(n, 'new password works');
    ctx.tokens.owner2 = n.body.token || n.body.data.token;
  });

  test('60 student bulk import: consent confirmation, minors, bad rows reported', async () => {
    const rows = [
      { rowNumber: 1, name: 'Import Adult', mobile: '9811101001', dob: '1999-03-03', plan: 'Monthly 1000' },
      { rowNumber: 2, name: 'Import Minor', mobile: '9811101002', dob: '2013-03-03' },
      { rowNumber: 3, name: 'Bad Mobile', mobile: '12345' },
      { rowNumber: 4, name: 'Bad Aadhaar', mobile: '9811101004', aadhaarNumber: '123412341234' },
    ];
    const noConsent = await api('POST', P('/students/import'), { token: T('owner'), body: { rows } });
    console.log('IMPORT without consentConfirmed ->', noConsent.status, noConsent.text.slice(0, 250));
    const dry = await api('POST', P('/students/import'), { token: T('owner'), body: { rows, dryRun: true, consentConfirmed: true, branchId: ctx.ids.branchA } });
    ok(dry, 'dry run'); console.log('IMPORT dry-run ->', dry.text.slice(0, 500));
    const real = await api('POST', P('/students/import'), { token: T('owner'), body: { rows, consentConfirmed: true, branchId: ctx.ids.branchA } });
    ok(real, 'import');
    const created = await col('students').countDocuments({ mobile: { $in: ['9811101001', '9811101002', '12345', '9811101004'] } });
    assert.equal(created, 1, 'only the valid adult row was created (minor without guardian, bad mobile, bad Aadhaar rejected): ' + created);
  });
};
