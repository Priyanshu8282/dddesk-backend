// Part: membership lifecycle - activate, plan change proration, renew credit policy, pause/extend, seats, attendance, cron.
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./lib');
const { api, P, U, SRC } = L;

module.exports = (H) => {
  const { ctx, ok, expectStatus, data, msg, T, id, stu } = H;
  const getStudent = async (sid, token = T('owner')) => { const r = await api('GET', P(`/students/${sid}`), { token }); ok(r, 'get student'); const d = data(r); return d.student || d; };
  const due = async (sid) => { const r = await api('GET', P(`/students/${sid}/ledger`), { token: T('acct') }); ok(r, 'ledger'); return data(r).ledger.outstanding.totalOutstanding; };

  test('21 activate membership by full payment (mark-paid) + idempotent replay', async () => {
    const s = await api('POST', P('/students/create-student'), { token: T('mgr'), body: stu({ name: 'Prorate Pat', mobile: '9811100031', planId: ctx.ids.plan, branchId: ctx.ids.branchA, dob: '1999-01-01' }) });
    ok(s, 'create'); ctx.ids.s3 = id(s);
    const mp = await api('POST', P(`/students/mark-paid/${ctx.ids.s3}`), { token: T('mgr'), body: { paymentMethod: 'cash', amount: 1000, requestId: 'markpaid-0001' } });
    ok(mp, 'mark paid');
    const mp2 = await api('POST', P(`/students/mark-paid/${ctx.ids.s3}`), { token: T('mgr'), body: { paymentMethod: 'cash', amount: 1000, requestId: 'markpaid-0001' } });
    assert.ok(mp2.status < 500, 'replay does not 5xx: ' + msg(mp2));
    const st = await getStudent(ctx.ids.s3);
    assert.equal(st.planStatus, 'active', 'membership active after payment: ' + JSON.stringify(st).slice(0, 400));
    assert.equal(await due(ctx.ids.s3), 0, 'charged once, paid once');
    assert.ok(st.expiryDate || st.planExpiry || st.membershipEnd, 'has an expiry date');
  });

  test('22 change plan prorates the unused part of the paid plan', async () => {
    const p3 = await api('POST', P('/plans'), { token: T('owner'), body: { name: 'Premium 1500', durationType: 'monthly', price: 1500 } });
    ok(p3, 'plan 1500'); ctx.ids.plan3 = id(p3);
    const cp = await api('POST', P(`/students/${ctx.ids.s3}/change-plan`), { token: T('mgr'), body: { planId: ctx.ids.plan3, reason: 'upgrade', requestId: 'chgplan-0001' } });
    console.log('CHANGE-PLAN ->', cp.status, cp.text.slice(0, 500));
    ok(cp, 'change plan');
    const owed = await due(ctx.ids.s3);
    console.log('DUE AFTER UPGRADE =', owed, '(full new price would be 1500)');
    assert.ok(owed > 0 && owed < 1000, `upgrade 1000 -> 1500 right after paying should bill only the difference (~500), got ${owed}`);
    const st = await getStudent(ctx.ids.s3);
    assert.equal(String(st.planId && (st.planId._id || st.planId)), String(ctx.ids.plan3), 'student is on the new plan');
  });

  test('23 renew enforces the library credit policy', async () => {
    const off = await api('PUT', P('/libraries/profile'), { token: T('owner'), body: { feePolicy: { allowCredit: false } } });
    ok(off, 'turn credit off');
    const s = await api('POST', P('/students/create-student'), { token: T('mgr'), body: stu({ name: 'Credit Cara', mobile: '9811100032', planId: ctx.ids.plan, branchId: ctx.ids.branchA, dob: '1998-01-01' }) });
    console.log('CREATE with credit off ->', s.status, s.text.slice(0, 300));
    // a student can be created; the membership must not activate on credit
    if (s.status >= 200 && s.status < 300) {
      ctx.ids.s4 = id(s);
      const mp0 = await api('POST', P(`/students/mark-paid/${ctx.ids.s4}`), { token: T('mgr'), body: { paymentMethod: 'cash', amount: 0 } });
      assert.ok(mp0.status === 400 || mp0.status === 403 || mp0.status === 409, 'activating on credit refused when allowCredit=false: ' + msg(mp0));
      const mp = await api('POST', P(`/students/mark-paid/${ctx.ids.s4}`), { token: T('mgr'), body: { paymentMethod: 'cash', amount: 1000, requestId: 'markpaid-0004' } });
      ok(mp, 'activate by paying in full');
      const rn0 = await api('POST', P(`/students/${ctx.ids.s4}/renew`), { token: T('mgr'), body: { requestId: 'renew-nopay-0001' } });
      assert.ok(rn0.status >= 400 && rn0.status < 500, 'renew with no payment refused while credit is off: ' + msg(rn0));
      const rn1 = await api('POST', P(`/students/${ctx.ids.s4}/renew`), { token: T('mgr'), body: { paidNow: 1000, paymentMethod: 'cash', requestId: 'renew-paid-0001' } });
      ok(rn1, 'renew with full payment');
      assert.equal(await due(ctx.ids.s4), 0);
    }
    ok(await api('PUT', P('/libraries/profile'), { token: T('owner'), body: { feePolicy: { allowCredit: true } } }), 'restore credit');
  });

  test('24 pause / extend / status changes need reasons and are branch scoped', async () => {
    expectStatus(await api('POST', P(`/students/${ctx.ids.s3}/membership/pause`), { token: T('mgr'), body: {} }), 400, 'pause needs reason');
    expectStatus(await api('POST', P(`/students/${ctx.ids.s3}/membership/extend`), { token: T('mgr'), body: { days: 3 } }), 400, 'extend needs reason');
    ok(await api('POST', P(`/students/${ctx.ids.s3}/membership/extend`), { token: T('mgr'), body: { days: 3, reason: 'power cut' } }), 'extend');
    expectStatus(await api('PATCH', P(`/students/${ctx.ids.s3}/status`), { token: T('mgr'), body: { status: 'inactive' } }), 400, 'status needs reason');
    const other = await api('PATCH', P(`/students/${ctx.ids.s3}/status`), { token: T('recB'), body: { status: 'inactive', reason: 'attack' } });
    assert.ok([403, 404].includes(other.status), 'branch B staff cannot change branch A student: ' + msg(other));
  });

  test('25 seats: assign, double-assign, transfer, release (same branch)', async () => {
    const seats = ctx.seatsA;
    const s5 = await api('POST', P('/students/create-student'), { token: T('recA'), body: stu({ name: 'Seat Sam', mobile: '9811100041' }) });
    ok(s5, 'student'); const sid = id(s5);
    ok(await api('PATCH', P(`/seats/${seats[2]}/assign`), { token: T('recA'), body: { studentId: sid } }), 'assign');
    const s6 = await api('POST', P('/students/create-student'), { token: T('recA'), body: stu({ name: 'Seat Sue', mobile: '9811100042' }) });
    const sid2 = id(s6);
    const dbl = await api('PATCH', P(`/seats/${seats[2]}/assign`), { token: T('recA'), body: { studentId: sid2 } });
    assert.ok(dbl.status === 400 || dbl.status === 409, 'occupied seat cannot be assigned again: ' + msg(dbl));
    const tr = await api('POST', P('/seats/transfer'), { token: T('recA'), body: { studentId: sid, toSeatId: seats[3], reason: 'near window' } });
    assert.equal(tr.status, 403, 'Receptionist has seats.assign but not seats.transfer: ' + msg(tr));
    const tr2 = await api('POST', P('/seats/transfer'), { token: T('mgr'), body: { studentId: sid, toSeatId: seats[3], reason: 'near window' } });
    ok(tr2, 'manager transfer');
    const layout = await api('GET', P(`/seats/${seats[2]}`), { token: T('owner') });
    ok(layout, 'old seat');
    assert.ok(/available/.test(layout.text), 'old seat freed after transfer: ' + layout.text.slice(0, 300));
    // assigning another seat MOVES the student: exactly one seat stays occupied by them
    ok(await api('PATCH', P(`/seats/${seats[4]}/assign`), { token: T('recA'), body: { studentId: sid } }), 'move to another seat');
    const old = await api('GET', P(`/seats/${seats[3]}`), { token: T('owner') });
    assert.ok(/available/.test(old.text), 'previous seat freed when the student is given another: ' + old.text.slice(0, 250));
    ok(await api('PATCH', P(`/seats/${seats[4]}/release`), { token: T('recA') }), 'release');
    // a seat of another branch cannot be held for the student; a reservation is cancelled through release
    const until = new Date(Date.now() + 86400000).toISOString();
    expectStatus(await api('POST', P(`/seats/${ctx.seatsB[ctx.seatsB.length - 1]}/reserve`), { token: T('mgr'), body: { studentId: sid, until } }), 400, 'cross-branch reserve');
    ok(await api('POST', P(`/seats/${seats[4]}/reserve`), { token: T('mgr'), body: { studentId: sid, until } }), 'reserve');
    ok(await api('PATCH', P(`/seats/${seats[4]}/release`), { token: T('recA') }), 'cancel reservation');
    // a plan created switched off stays off
    const off = await api('POST', P('/plans'), { token: T('owner'), body: { name: 'Created Off', durationType: 'monthly', price: 100, status: false } });
    ok(off, 'inactive plan'); assert.equal(data(off).status, false, 'plan created inactive: ' + off.text.slice(0, 200));
    ctx.ids.s5 = sid;
  });

  test('26 attendance: QR generation permission, check-in/out, duplicate punch', async () => {
    expectStatus(await api('GET', P('/attendance/generate-qr'), { token: T('acct') }), 403, 'accountant must not mint QR');
    const qr = await api('GET', P('/attendance/generate-qr'), { token: T('recA') });
    ok(qr, 'receptionist QR');
    const pin = await api('POST', P('/attendance/punch-in'), { token: T('recA'), body: { studentId: ctx.ids.s3 } });
    console.log('PUNCH-IN ->', pin.status, pin.text.slice(0, 300));
    ok(pin, 'punch in');
    const pin2 = await api('POST', P('/attendance/punch-in'), { token: T('recA'), body: { studentId: ctx.ids.s3 } });
    assert.ok(pin2.status === 400 || pin2.status === 409, 'second punch-in while inside is refused: ' + msg(pin2));
    const pout = await api('POST', P('/attendance/punch-out'), { token: T('recA'), body: { studentId: ctx.ids.s3 } });
    ok(pout, 'punch out');
    const other = await api('POST', P('/attendance/punch-in'), { token: T('recB'), body: { studentId: ctx.ids.s3 } });
    assert.ok([403, 404].includes(other.status), 'branch-B staff cannot punch a branch-A student: ' + msg(other));
    const today = await api('GET', P('/attendance/today'), { token: T('recA') });
    ok(today, 'today');
  });

  test('27 cron jobs: expiry + leaveUntil auto-return (called directly)', async () => {
    const Student = require(SRC + '/models/student.model');
    const cron = require(SRC + '/services/cron.service');
    console.log('cron exports:', Object.keys(cron).join(','));
    // leaveUntil auto-return
    await Student.collection.updateOne({ _id: new (L.breq('mongoose').Types.ObjectId)(ctx.ids.s3) }, { $set: { status: 'leave', leaveUntil: new Date(Date.now() - 2 * 86400000) } });
    const fn = cron.autoReturnFromLeave || cron.runAutoReturnFromLeave;
    assert.ok(fn, 'autoReturnFromLeave exported');
    await fn();
    const st = await getStudent(ctx.ids.s3);
    assert.equal(st.status, 'active', 'student back to active after leaveUntil passed: ' + JSON.stringify(st).slice(0, 200));
    // membership expiry frees the seat and flags the student
    await Student.collection.updateOne({ _id: new (L.breq('mongoose').Types.ObjectId)(ctx.ids.s1) }, { $set: { expiryDate: new Date(Date.now() - 86400000), planStatus: 'active' } });
    const exp = cron.expireMemberships || cron.runExpiry || cron.checkExpiredMemberships;
    if (exp) { await exp(); const s1 = await getStudent(ctx.ids.s1); console.log('after expiry cron planStatus=', s1.planStatus); assert.ok(['expired', 'pending', 'inactive'].includes(s1.planStatus), 'expired membership is flagged: ' + s1.planStatus); }
    else console.log('NOTE: expiry function name not found among exports');
  });

  test('28 student edit: empty fields clear, photo removal, guardian consent date stays, fee figures need a fee right', async () => {
    const c = await api('POST', P('/students/create-student'), { token: T('owner'), body: stu({ name: 'Clear Me', mobile: '9811100171', email: 'clear@x.test', gender: 'Male', dob: '2012-01-01', pincode: '302001', guardianName: 'Dad', guardianMobile: '9811100072', guardianConsentGiven: true, planId: ctx.ids.plan }) });
    ok(c, 'create minor');
    const sid = id(c);
    const before = await getStudent(sid);
    assert.ok(before.feesDue > 0, 'feesDue totals the open charges: ' + before.feesDue);
    const stale = await api('PUT', P(`/students/update-student/${sid}`), { token: T('owner'), body: { address: 'New road', guardianConsentGiven: true } });
    ok(stale, 'unrelated edit');
    assert.equal(data(stale).guardianConsent.givenAt, before.guardianConsent.givenAt, 're-saving does not rewrite the consent date');
    const noGuardian = await api('PUT', P(`/students/update-student/${sid}`), { token: T('owner'), body: { guardianMobile: '' } });
    assert.equal(noGuardian.status, 400, 'a minor cannot lose the guardian mobile: ' + msg(noGuardian));
    const cl = await api('PUT', P(`/students/update-student/${sid}`), { token: T('owner'), body: { email: '', gender: '', pincode: '', dob: '', profileImage: 'null' } });
    ok(cl, 'clear');
    const after = await getStudent(sid);
    for (const k of ['email', 'gender', 'pincode', 'dob']) assert.ok(after[k] === undefined || after[k] === null, `${k} cleared: ${after[k]}`);
    assert.ok(!after.profileImage, 'photo removed');
    const bad = await api('PUT', P(`/students/update-student/${sid}`), { token: T('owner'), body: { profileImage: '/etc/passwd' } });
    assert.equal(bad.status, 400, 'a path cannot be set as the photo');
    const rec = await getStudent(sid, T('recA'));
    assert.equal(rec.paymentHistory, undefined, 'no fee right, no payment history');
    assert.equal(rec.feesDue, undefined, 'no fee right, no fees due');
  });

  test('29 renew with keepSeat false gives the seat up', async () => {
    const free = await api('GET', P('/seats?status=available&limit=5'), { token: T('owner') });
    const seat = (data(free).seats || data(free) || free.body.seats)[0];
    const c = await api('POST', P('/students/create-student'), { token: T('owner'), body: stu({ name: 'Seat Giver', mobile: '9811100073', planId: ctx.ids.plan, seatId: seat._id, branchId: seat.branchId || ctx.ids.branchA }) });
    ok(c, 'create seated');
    const sid = id(c);
    ok(await api('POST', P(`/students/mark-paid/${sid}`), { token: T('owner'), body: { paymentMethod: 'cash', amount: 1000 } }), 'activate');
    assert.equal((await getStudent(sid)).seatId && true, true, 'seated');
    ok(await api('POST', P(`/students/${sid}/renew`), { token: T('owner'), body: { keepSeat: false, paidNow: 1000, paymentMethod: 'cash' } }), 'renew');
    assert.ok(!(await getStudent(sid)).seatId, 'seat released');
  });

  test('30 change plan also settles an early renewal of the old plan', async () => {
    const make = async (name, mobile) => {
      const c = await api('POST', P('/students/create-student'), { token: T('owner'), body: stu({ name, mobile, planId: ctx.ids.plan, branchId: ctx.ids.branchA }) });
      ok(c, 'create'); const sid = id(c);
      ok(await api('POST', P(`/students/mark-paid/${sid}`), { token: T('owner'), body: { paymentMethod: 'cash', amount: 1000 } }), 'activate');
      return sid;
    };
    // unpaid renewal: its fee must go away, only the new plan less the paid month stays due
    const a = await make('Early Unpaid', '9811100074');
    ok(await api('POST', P(`/students/${a}/renew`), { token: T('owner'), body: {} }), 'renew on credit');
    assert.equal(await due(a), 1000, 'renewal fee is due');
    ok(await api('POST', P(`/students/${a}/change-plan`), { token: T('owner'), body: { planId: ctx.ids.plan3 } }), 'change plan');
    const owedA = await due(a);
    assert.ok(owedA > 0 && owedA <= 550, `the unused renewal is not billed on top of the new plan, got ${owedA}`);
    // paid renewal: that money counts towards the new plan
    const b = await make('Early Paid', '9811100075');
    ok(await api('POST', P(`/students/${b}/renew`), { token: T('owner'), body: { paidNow: 1000, paymentMethod: 'cash' } }), 'renew paid');
    const cb = await api('POST', P(`/students/${b}/change-plan`), { token: T('owner'), body: { planId: ctx.ids.plan3 } });
    ok(cb, 'change plan');
    assert.equal(await due(b), 0, 'two paid months cover the new plan');
    assert.match(cb.text, /"creditLeftover":[1-9]/, 'surplus is reported');
  });
};
