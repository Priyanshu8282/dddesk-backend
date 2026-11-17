// Part: attendance rules - Late measured from the plan shift, today never counted as missed, one record per day, Inside count, DailyCode gone.
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./lib');
const { api, P, SRC } = L;

module.exports = (H) => {
  const { ctx, ok, data, msg, T, id, stu } = H;
  const DAY = 86400000;
  const { startOfDayIST, istDateKey } = require(SRC + '/utils/time');
  const svc = () => require(SRC + '/services/attendance.service');
  const Library = () => require(SRC + '/models/library.model');
  const Student = () => require(SRC + '/models/student.model');
  const Attendance = () => require(SRC + '/models/attendance.model');
  const owner = () => ({ token: T('owner') });
  const ist = (daysAgo, h, m = 0) => new Date(startOfDayIST(new Date()).getTime() - daysAgo * DAY + (h * 60 + m) * 60000);

  let shifted; let plain; let n = 0;
  const mkStudent = async (name, over = {}) => {
    const r = await api('POST', P('/students/create-student'), { ...owner(), body: stu({ name, mobile: `98112000${String(10 + n++)}`, ...over }) });
    ok(r, 'create ' + name);
    const sid = id(r);
    // planStatus is irrelevant to the staff check-in; started today so only today is in the reports
    await Student().collection.updateOne({ _id: new (L.breq('mongoose').Types.ObjectId)(sid) }, { $set: { joiningDate: startOfDayIST(new Date()) } });
    return sid;
  };
  const punch = async (studentId, type, time) => {
    const r = await api('POST', P('/attendance/manual'), { ...owner(), body: { studentId, type, ...(time ? { time: time.toISOString() } : {}) } });
    ok(r, 'manual ' + type);
    return data(r).attendance;
  };
  const dayRows = (studentId, date) => Attendance().find({ studentId, date: startOfDayIST(date) }).lean();
  const percentRow = async (sid) => {
    const r = await api('GET', P('/attendance/percentage?limit=500&sort=name'), owner());
    ok(r, 'percentage');
    return data(r).results.find((x) => String(x.studentId) === String(sid));
  };
  const todayTrend = async () => {
    const r = await api('GET', P('/attendance/trend?days=3'), owner());
    ok(r, 'trend');
    return data(r).results[2];
  };

  test('140 attendance setup: known hours, no holidays, a plan with a shift', async () => {
    await Library().updateOne({ _id: ctx.ids.library }, { $set: {
      'workingHours.openingTime': '06:00 AM', 'workingHours.closingTime': '11:00 PM', 'workingHours.weeklyHoliday': 'None', weeklyHolidays: [],
      'attendanceRules.lateAfterMinutes': 15, 'attendanceRules.graceMinutes': 10
    } });
    const p = await api('POST', P('/plans'), { ...owner(), body: { name: 'Morning shift', durationType: 'monthly', price: 800, shiftName: 'Morning', shiftStart: '09:00', shiftEnd: '13:00' } });
    ok(p, 'shift plan');
    shifted = await mkStudent('Shift Sia', { planId: id(p) });
    plain = await mkStudent('Plain Pia', { planId: ctx.ids.plan });
  });

  test('141 Late is measured from the plan shift start, else from opening time', async () => {
    const a = await punch(shifted, 'in', ist(2, 9, 10));
    assert.equal(a.isLate, false, 'inside the allowance after shift start, though 3 h after opening: ' + JSON.stringify(a));
    await punch(shifted, 'out', ist(2, 10));
    const b = await punch(shifted, 'in', ist(1, 9, 20));
    assert.equal(b.isLate, true, 'past shift start + allowance');
    assert.equal(b.lateByMinutes, 5);
    await punch(shifted, 'out', ist(1, 10));

    const c = await punch(plain, 'in', ist(2, 6, 10));
    assert.equal(c.isLate, false, 'no shift: opening time + allowance');
    await punch(plain, 'out', ist(2, 7));
    const d = await punch(plain, 'in', ist(1, 6, 20));
    assert.equal(d.isLate, true);
    assert.equal(d.lateByMinutes, 5);
    await punch(plain, 'out', ist(1, 7));
  });

  test('142 a corrected check-in is re-judged against the shift too', async () => {
    const att = await Attendance().findOne({ studentId: shifted, date: startOfDayIST(ist(1, 9)) }).lean();
    const fix = await api('PATCH', P(`/attendance/${att._id}/correct`), { ...owner(), body: { reason: 'wrong time entered', checkIn: ist(1, 9, 5).toISOString() } });
    ok(fix, 'correct');
    assert.equal(data(fix).isLate, false, 'within the allowance after shift start');
    const fix2 = await api('PATCH', P(`/attendance/${att._id}/correct`), { ...owner(), body: { reason: 'wrong time entered', checkIn: ist(1, 9, 30).toISOString() } });
    ok(fix2, 'correct back');
    assert.equal(data(fix2).lateByMinutes, 15);
  });

  test('143 overnight and round-the-clock shifts', () => {
    const { computeFlags } = svc();
    const rules = { lateAfterMinutes: 15, graceMinutes: 10 };
    const hours = { open: 6 * 60, close: 23 * 60 };
    const night = { start: 22 * 60, end: 6 * 60 };
    const at = (h, m = 0) => new Date(startOfDayIST(new Date()).getTime() + (h * 60 + m) * 60000);
    assert.equal(computeFlags({ checkIn: at(22, 10), rules, hours, shift: night }).isLate, false);
    assert.equal(computeFlags({ checkIn: at(23), rules, hours, shift: night }).lateByMinutes, 45);
    assert.equal(computeFlags({ checkIn: at(1), rules, hours, shift: night }).lateByMinutes, 165, 'after midnight: the shift began the evening before');
    assert.equal(computeFlags({ checkIn: at(10), rules, hours, shift: { start: 0, end: 0 } }).lateByMinutes, 225, 'a 24 h plan falls back to opening time');
  });

  test('144 today is never missed: not counted until the student comes, in report, summary and trend', async () => {
    const sid = await mkStudent('Today Tia');
    const before = await percentRow(sid);
    assert.deepEqual([before.workingDays, before.presentDays, before.percentage], [0, 0, 0], JSON.stringify(before));
    const sum = await api('GET', P(`/attendance/student/${sid}/summary`), owner());
    ok(sum, 'summary');
    assert.deepEqual([data(sum).workingDays, data(sum).absentDays], [0, 0], msg(sum));
    const t = await todayTrend();
    assert.equal(t.absent, 0, 'nobody is absent before the day ends: ' + JSON.stringify(t));
    assert.ok(t.notYet >= 1, 'waiting students are "not yet"');

    await punch(sid, 'in');
    const after = await percentRow(sid);
    assert.deepEqual([after.workingDays, after.presentDays, after.percentage], [1, 1, 100], JSON.stringify(after));
    const sum2 = await api('GET', P(`/attendance/student/${sid}/summary`), owner());
    assert.deepEqual([data(sum2).workingDays, data(sum2).presentDays, data(sum2).absentDays, data(sum2).percentage], [1, 1, 0, 100], msg(sum2));
    const t2 = await todayTrend();
    assert.equal(t2.notYet, t.notYet - 1);
    assert.equal(t2.present, t.present + 1);
    await punch(sid, 'out', new Date(Date.now() + 60000));
  });

  test('145 leave today is neither missed nor subtracted twice', async () => {
    const sid = await mkStudent('Leave Lia');
    ok(await api('POST', P('/attendance/leave'), { ...owner(), body: { studentId: sid, date: new Date().toISOString(), reason: 'exam' } }), 'leave');
    const r = await percentRow(sid);
    assert.deepEqual([r.workingDays, r.leaveDays, r.presentDays], [1, 1, 0], JSON.stringify(r));
    const sum = await api('GET', P(`/attendance/student/${sid}/summary`), owner());
    assert.equal(data(sum).absentDays, 0, msg(sum));
  });

  test('146 finished days still count as missed', async () => {
    const sid = await mkStudent('Past Pam');
    await Student().collection.updateOne({ _id: new (L.breq('mongoose').Types.ObjectId)(sid) }, { $set: { joiningDate: ist(3, 0) } });
    const r = await percentRow(sid);
    assert.equal(r.workingDays, 3, JSON.stringify(r));
  });

  test('147 the student report does not count today against a student who has not come', async () => {
    const sid = await mkStudent('Report Rae');
    await punch(sid, 'in', ist(1, 8));
    await punch(sid, 'out', ist(1, 9));
    const q = new URLSearchParams({ startDate: istDateKey(ist(2, 8)), endDate: istDateKey(new Date()), view: 'student', limit: '100' });
    const find = async () => {
      const r = await api('GET', P(`/reports/attendance?${q}`), owner());
      ok(r, 'report');
      return data(r).topStudents.concat(data(r).rows || data(r).list || []).find((x) => x.name === 'Report Rae');
    };
    const row = await find();
    assert.ok(row, 'student in the report');
    assert.equal(row.attendancePct, 50, 'one of two finished days attended, today not held against them: ' + JSON.stringify(row));
    await punch(sid, 'in');
    await punch(sid, 'out', new Date(Date.now() + 60000));
    assert.equal((await find()).attendancePct, 66.7, 'came today: today now counts, 2 of 3');
  });

  test('148 check-in on a leave day leaves one present record, History shows one row', async () => {
    const sid = await mkStudent('Merge Mia');
    const leave = await api('POST', P('/attendance/leave'), { ...owner(), body: { studentId: sid, date: new Date().toISOString(), reason: 'wedding' } });
    ok(leave, 'leave');
    const at = await punch(sid, 'in');
    assert.equal(String(at._id), String(data(leave)._id), 'the leave record became the check-in');
    const list = await api('GET', P(`/attendance/list?studentId=${sid}&date=${istDateKey(new Date())}`), owner());
    ok(list, 'history');
    assert.equal(data(list).totalResults, 1, msg(list));
    const [r] = data(list).results;
    assert.equal(r.status, 'present');
    assert.ok(!r.leaveReason && r.checkIn && !r.checkOut, JSON.stringify(r));
    assert.equal(r.corrections[0].before.leaveReason, 'wedding', 'the replaced leave stays on the record');
    const out = await punch(sid, 'out', new Date(Date.now() + 60000));
    assert.ok(out.duration >= 1, 'an open session built from a leave row closes normally');
    // the second visit of the day is another session, and still no leave/absent row
    assert.ok((await dayRows(sid, new Date())).every((x) => x.status === 'present'));
  });

  test('149 check-in on an absent day (and over duplicate rows) leaves one record', async () => {
    const sid = await mkStudent('Merge Max');
    const base = { studentId: sid, libraryId: ctx.ids.library, date: startOfDayIST(new Date()) };
    await Attendance().create([{ ...base, status: 'absent', source: 'system' }, { ...base, status: 'leave', leaveReason: 'old' }]);
    await punch(sid, 'in');
    const rows = await dayRows(sid, new Date());
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.equal(rows[0].status, 'present');
    await punch(sid, 'out', new Date(Date.now() + 60000));
  });

  test('150 a refused check-in keeps the leave; correcting to present removes it', async () => {
    const lib = await Library().findById(ctx.ids.library).lean();
    const sid = await mkStudent('Merge Mo', { planId: (await Student().findById(shifted).lean()).planId });
    const day = ist(1, 0);
    ok(await api('POST', P('/attendance/leave'), { ...owner(), body: { studentId: sid, date: day.toISOString(), reason: 'trip' } }), 'leave');
    const student = await Student().findById(sid);
    await assert.rejects(svc().checkIn({
      student, library: { ...lib, attendanceRules: { ...lib.attendanceRules, enforceShift: true } }, source: 'qr', at: ist(1, 20)
    }), /shift/);
    assert.equal((await dayRows(sid, day))[0].status, 'leave', 'nothing changed by the refused check-in');

    const other = await Attendance().create({ studentId: sid, libraryId: ctx.ids.library, date: startOfDayIST(ist(2, 9)), status: 'present', checkIn: ist(2, 9), checkOut: ist(2, 10), duration: 60 });
    const fix = await api('PATCH', P(`/attendance/${other._id}/correct`), { ...owner(), body: { reason: 'was the day after', checkIn: ist(1, 9).toISOString(), checkOut: ist(1, 10).toISOString() } });
    ok(fix, 'correct');
    const rows = await dayRows(sid, day);
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.equal(rows[0].status, 'present');
  });

  test('151 Inside counts only active students', async () => {
    const sid = await mkStudent('Inside Ira');
    await punch(sid, 'in');
    const has = async () => { const r = await api('GET', P('/attendance/active'), owner()); ok(r, 'active'); return { d: data(r), found: data(r).results.some((x) => String(x.studentId) === sid) }; };
    const on = await has();
    assert.ok(on.found);
    await Student().updateOne({ _id: sid }, { $set: { status: 'inactive' } });
    const off = await has();
    assert.ok(!off.found, 'inactive student is not inside');
    assert.equal(off.d.count, on.d.count - 1);
    assert.equal(off.d.count, off.d.results.length);
    await Student().updateOne({ _id: sid }, { $set: { status: 'active' } });
    await punch(sid, 'out', new Date(Date.now() + 60000));
  });

  test('152 DailyCode model is gone', () => {
    assert.equal(require(SRC + '/models').DailyCode, undefined);
    assert.ok(!L.breq('mongoose').modelNames().includes('DailyCode'));
  });
};
