// Part: seat sharing by shift - non-overlapping plans share a seat, overlaps and full-day occupants are refused.
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./lib');
const { api, P } = L;

module.exports = (H) => {
  const { ctx, ok, data, msg, T, id, stu } = H;
  const { overlaps, shiftOf, freeWindows, toMinutes } = require(L.SRC + '/utils/seatShift');
  const col = (name) => L.state.mongoose.connection.db.collection(name);
  const S = {};
  let n = 0;
  const assign = (seat, sid) => api('PATCH', P(`/seats/${seat}/assign`), { token: T('owner'), body: { studentId: sid } });
  const release = (seat, body) => api('PATCH', P(`/seats/${seat}/release`), { token: T('owner'), ...(body ? { body } : {}) });
  const getSeat = async (seat) => { const r = await api('GET', P(`/seats/${seat}`), { token: T('owner') }); ok(r, 'get seat'); return data(r); };
  const seatDoc = (seat) => col('seats').findOne({ _id: new (L.state.mongoose.Types.ObjectId)(seat) });
  const mkPlan = async (name, shiftStart, shiftEnd) => {
    const r = await api('POST', P('/plans'), { token: T('owner'), body: { name, durationType: 'monthly', price: 700, ...(shiftStart ? { shiftName: name, shiftStart, shiftEnd } : {}) } });
    ok(r, 'plan ' + name); return id(r);
  };
  const mkStudent = async (name, planId, extra = {}) => {
    n += 1;
    const r = await api('POST', P('/students/create-student'), { token: T('mgr'), body: stu({ name, mobile: `98119${String(n).padStart(5, '0')}`, planId, branchId: ctx.ids.branchA, ...extra }) });
    ok(r, 'student ' + name); return id(r);
  };
  const mkSeats = async (prefix, count) => {
    ok(await api('POST', P('/seats/bulk'), { token: T('owner'), body: { prefix, count, startNumber: 1, branchId: ctx.ids.branchA } }), 'seats');
    const r = await api('GET', P(`/seats?branchId=${ctx.ids.branchA}&limit=500`), { token: T('owner') });
    return (data(r).seats || data(r)).filter((s) => s.seatNumber.startsWith(prefix)).map((s) => s._id);
  };
  const refused = (r, text) => { assert.equal(r.status, 400, msg(r)); assert.match(msg(r), text); };

  test('S1 shift maths: touching ends do not overlap, overnight shifts wrap, short gaps are not free', () => {
    const sh = (a, b) => shiftOf({ shiftStart: a, shiftEnd: b });
    assert.equal(overlaps(sh('06:00', '14:00'), sh('14:00', '22:00')), false);
    assert.equal(overlaps(sh('06:00', '14:00'), sh('13:59', '22:00')), true);
    assert.equal(overlaps(sh('22:00', '06:00'), sh('05:00', '07:00')), true, 'wraps past midnight');
    assert.equal(overlaps(sh('22:00', '06:00'), sh('06:00', '22:00')), false);
    assert.equal(overlaps(shiftOf(null), sh('06:00', '14:00')), true, 'no plan is full day');
    assert.equal(shiftOf({ shiftName: 'Any' }).fullDay, true, 'a name without times is full day');
    assert.equal(toMinutes('11:00 PM'), 23 * 60);
    const hours = { openingTime: '06:00 AM', closingTime: '10:00 PM' };
    assert.deepEqual(freeWindows([sh('06:00', '14:00'), sh('14:00', '22:00')], hours), [], 'covers the opening hours');
    assert.deepEqual(freeWindows([sh('06:00', '14:00'), sh('14:30', '22:00')], hours), [], 'a changeover gap is not free');
    assert.deepEqual(freeWindows([sh('06:00', '14:00')], hours), [{ start: '14:00', end: '22:00' }]);
    assert.deepEqual(freeWindows([shiftOf(null)], hours), []);
  });

  test('S2 morning and evening share one seat; studentId stays the first occupant', async () => {
    S.morning = await mkPlan('Shift Morning', '06:00', '14:00');
    S.evening = await mkPlan('Shift Evening', '14:00', '22:00');
    S.mid = await mkPlan('Shift Mid', '12:00', '18:00');
    S.full = await mkPlan('Shift Full');
    S.seats = await mkSeats('SH-', 8);
    S.m1 = await mkStudent('Mohan Morning', S.morning);
    S.e1 = await mkStudent('Esha Evening', S.evening);

    ok(await assign(S.seats[0], S.m1), 'morning takes it');
    let seat = await getSeat(S.seats[0]);
    assert.equal(seat.shiftState, 'partly_free');
    assert.deepEqual(seat.freeWindows, [{ start: '14:00', end: '23:00' }]);
    assert.equal(seat.studentId._id, S.m1);

    ok(await assign(S.seats[0], S.e1), 'evening shares it');
    seat = await getSeat(S.seats[0]);
    assert.equal(seat.status, 'occupied');
    assert.equal(seat.studentId._id, S.m1, 'first occupant unchanged for every existing reader');
    assert.deepEqual(seat.occupants.map((o) => o.student.name), ['Mohan Morning', 'Esha Evening']);
    assert.deepEqual(seat.occupants.map((o) => o.shift.label), ['Shift Morning 06:00-14:00', 'Shift Evening 14:00-22:00']);
    assert.deepEqual(seat.freeWindows, [{ start: '22:00', end: '23:00' }], 'the last hour of a 6 am to 11 pm library is still free');
    const st = await col('students').findOne({ _id: new (L.state.mongoose.Types.ObjectId)(S.e1) });
    assert.equal(String(st.seatId), S.seats[0]);
    assert.ok(st.seatNumber.startsWith('SH-'));

    const again = await assign(S.seats[0], S.e1);
    ok(again, 'idempotent for someone already sharing');
    assert.equal((await seatDoc(S.seats[0])).coOccupants.length, 1);

    const stats = await api('GET', P(`/seats/stats?branchId=${ctx.ids.branchA}`), { token: T('owner') });
    ok(stats, 'stats');
    assert.ok(data(stats).shared >= 1 && data(stats).partlyFree >= 1, JSON.stringify(data(stats)));
    const list = await api('GET', P(`/seats?branchId=${ctx.ids.branchA}&limit=500`), { token: T('owner') });
    assert.equal((data(list).seats || data(list)).find((s) => s._id === S.seats[0]).occupants.length, 2, 'the list carries occupants too');
    const layout = await api('GET', P(`/seats/layout?branchId=${ctx.ids.branchA}`), { token: T('owner') });
    ok(layout, 'layout');
    assert.ok(data(layout)[0].summary.partlyFree >= 1, 'layout counts partly free seats');
  });

  test('S3 an overlapping shift is refused naming the shift; full day blocks everything', async () => {
    S.mid1 = await mkStudent('Mira Mid', S.mid);
    refused(await assign(S.seats[0], S.mid1), /Mohan Morning \(Shift Morning 06:00-14:00\), which overlaps Mira Mid's shift \(Shift Mid 12:00-18:00\)/);

    S.f1 = await mkStudent('Farhan Full', S.full);
    refused(await assign(S.seats[0], S.f1), /Farhan Full has a full-day plan/);

    ok(await assign(S.seats[1], S.f1), 'full day takes an empty seat as today');
    const seat = await getSeat(S.seats[1]);
    assert.equal(seat.shiftState, 'full');
    assert.deepEqual(seat.occupants.map((o) => o.shift.fullDay), [true]);
    refused(await assign(S.seats[1], S.mid1), /Farhan Full for the full day/);

    const noPlan = await mkStudent('Nita Noplan', undefined);
    refused(await assign(S.seats[0], noPlan), /full-day plan/);
    ok(await release(S.seats[1]), 'one occupant needs no student id, as today');
    assert.equal((await seatDoc(S.seats[1])).status, 'available');
  });

  test('S4 two overlapping students racing to share: exactly one gets in', async () => {
    const m = await mkStudent('Race Morning', S.morning);
    const e1 = await mkStudent('Race Evening One', S.evening);
    const e2 = await mkStudent('Race Evening Two', S.evening);
    ok(await assign(S.seats[2], m), 'first');
    const [a, b] = await Promise.all([assign(S.seats[2], e1), assign(S.seats[2], e2)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 400], `${a.status} ${b.status}: ${msg(a)} ${msg(b)}`);
    assert.equal((await seatDoc(S.seats[2])).coOccupants.length, 1);
    assert.equal(await col('students').countDocuments({ seatId: (await seatDoc(S.seats[2]))._id }), 2);
  });

  test('S5 release: a shared seat asks who leaves, the other stays, the seat frees with the last one', async () => {
    refused(await release(S.seats[0]), /shared by 2 students/);
    const other = await mkStudent('Otto Other', S.morning);
    refused(await release(S.seats[0], { studentId: other }), /not on this seat/);

    ok(await release(S.seats[0], { studentId: S.m1 }), 'first occupant leaves');
    let d = await seatDoc(S.seats[0]);
    assert.equal(d.status, 'occupied');
    assert.equal(String(d.studentId), S.e1, 'the sharer becomes the first occupant');
    assert.equal(d.coOccupants.length, 0);
    assert.equal((await col('students').findOne({ _id: new (L.state.mongoose.Types.ObjectId)(S.m1) })).seatId, null);
    assert.ok((await col('students').findOne({ _id: new (L.state.mongoose.Types.ObjectId)(S.e1) })).seatId, 'sharer keeps the seat');

    ok(await assign(S.seats[0], S.m1), 'back on');
    ok(await api('PATCH', P(`/students/${S.m1}/status`), { token: T('owner'), body: { status: 'inactive', reason: 'left', releaseSeat: true } }), 'set inactive frees only that student');
    d = await seatDoc(S.seats[0]);
    assert.equal(d.coOccupants.length, 0);
    assert.equal(String(d.studentId), S.e1);

    ok(await release(S.seats[0]), 'last one out');
    d = await seatDoc(S.seats[0]);
    assert.equal(d.status, 'available');
    assert.equal(d.studentId, null);
  });

  test('S6 admission, transfer, plan change and plan edit all respect shifts', async () => {
    const a = await mkStudent('Asha Admit Morning', S.morning, { seatId: S.seats[3] });
    const b = await mkStudent('Bina Admit Evening', S.evening, { seatId: S.seats[3] });
    assert.equal((await seatDoc(S.seats[3])).coOccupants.length, 1, 'an admission can join on a free shift');
    const clash = await api('POST', P('/students/create-student'), { token: T('mgr'), body: stu({ name: 'Clash Admit', mobile: '9811999999', planId: S.mid, branchId: ctx.ids.branchA, seatId: S.seats[3] }) });
    assert.equal(clash.status, 400, msg(clash));
    assert.match(msg(clash), /overlaps/);
    assert.equal(await col('students').countDocuments({ mobile: '9811999999' }), 0, 'a refused admission leaves no student behind');

    refused(await api('POST', P(`/students/${b}/change-plan`), { token: T('owner'), body: { planId: S.mid, requestId: 'shift-chg-0001' } }), /overlaps/);
    const late = await api('PUT', P(`/plans/${S.evening}`), { token: T('owner'), body: { shiftStart: '13:00', shiftEnd: '22:00' } });
    assert.equal(late.status, 400, msg(late));
    assert.match(msg(late), /overlaps/);
    const clear = await api('PUT', P(`/plans/${S.evening}`), { token: T('owner'), body: { shiftStart: '', shiftEnd: '' } });
    assert.equal(clear.status, 400, 'going full day on a shared seat: ' + msg(clear));
    ok(await api('PUT', P(`/plans/${S.evening}`), { token: T('owner'), body: { shiftStart: '14:30', shiftEnd: '22:00' } }), 'a change that still fits');
    ok(await api('PUT', P(`/plans/${S.evening}`), { token: T('owner'), body: { shiftStart: '14:00', shiftEnd: '22:00' } }), 'and back');

    const c = await mkStudent('Chetan Mover', S.morning);
    ok(await assign(S.seats[4], c), 'seated');
    const e = await mkStudent('Deepa Mover', S.evening);
    ok(await assign(S.seats[5], e), 'seated');
    refused(await api('POST', P('/seats/transfer'), { token: T('owner'), body: { studentId: c, toSeatId: S.seats[3] } }), /overlaps/);
    assert.equal(String((await seatDoc(S.seats[4])).studentId), c, 'a refused move changes nothing');
    ok(await api('POST', P('/seats/transfer'), { token: T('owner'), body: { studentId: c, toSeatId: S.seats[5] } }), 'moves onto a free shift');
    assert.equal((await seatDoc(S.seats[4])).status, 'available');
    assert.equal(String((await seatDoc(S.seats[5])).coOccupants[0].studentId), c);
    ok(await api('POST', P('/seats/transfer'), { token: T('owner'), body: { studentId: c, toSeatId: S.seats[4] } }), 'a sharer can move out');
    assert.equal((await seatDoc(S.seats[5])).coOccupants.length, 0);
    assert.equal(String((await seatDoc(S.seats[5])).studentId), e);

    // Seated first occupant moved to another seat while the seat was shared: reassigning releases only them
    ok(await assign(S.seats[6], a), 'reassign the first occupant');
    const d = await seatDoc(S.seats[3]);
    assert.equal(String(d.studentId), b);
    assert.equal(d.status, 'occupied');
  });

  test('S7 recovery, reports and old single-seat responses', async () => {
    const r = await api('GET', P('/seats/recovery?days=7'), { token: T('owner') });
    ok(r, 'recovery');
    const rep = await api('GET', P('/reports/seats'), { token: T('owner') });
    ok(rep, 'seat report');
    assert.equal(typeof data(rep).partlyFreeSeats, 'number');
    const raw = await seatDoc(ctx.seatsA[0]);
    assert.ok(raw.studentId, 'a seat from before this feature');
    const seat = await getSeat(ctx.seatsA[0]);
    assert.equal(seat.occupants.length, 1, 'an old seat with no coOccupants field still lists its occupant');
    assert.equal(seat.occupants[0].shift.fullDay, true);
    assert.equal(seat.shiftState, 'full');
  });
};
