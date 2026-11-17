// Part: one owner/staff mobile, one account.
//  - new duplicates are refused everywhere a mobile is set (soft-deleted accounts do not count); the error names no library
//  - accounts left over from before that rule: the library choice appears only after the password or OTP is proven
//  - scripts/report_duplicate_mobiles.js lists them, last 4 digits only, and writes nothing
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const L = require('./lib');
const { api, P, U } = L;

module.exports = (H) => {
  const { ctx, ok, expectStatus, data, msg, T, id } = H;
  const Admin = () => require(path.join(L.SRC, 'models/admin.model'));
  const Oid = (v) => new (L.state.mongoose.Types.ObjectId)(v);
  const col = (n) => L.state.mongoose.connection.collection(n);
  const roleOf = async (library) => (await col('roles').findOne({ libraryId: Oid(library), name: 'Receptionist' }))._id;
  const PASSWORD = 'Staff#12345';
  const staff = (name, mobile, roleId) => ({ name, mobile, email: `${name.replace(/\W/g, '').toLowerCase()}@mobile.test`, password: PASSWORD, confirmPassword: PASSWORD, roleId: String(roleId) });
  // what an old database holds: the API would refuse this now
  const legacyStaff = async (library, name, mobile, password = PASSWORD) => Admin().create({ name, email: `${name.replace(/\W/g, '').toLowerCase()}@legacy.test`, mobile, password, userType: 'staff', roleId: await roleOf(library), libraryId: library });
  const login = (mobile, password = PASSWORD, extra = {}) => api('POST', U('/login'), { body: { identifier: mobile, password, ...extra } });

  const TAKEN = '9822200071';
  const FREE = '9822200072';
  const DUP = '9822200073';
  const DUP_OTHER_PASSWORD = '9822200074';
  const DUP_DISABLED = '9822200075';
  const DUP_OTP = '9822200076';
  const isTaken = (r, label) => { expectStatus(r, 409, label); assert.match(r.body.message, /already used by another account/); };

  test('AM1 staff: a mobile used in another library is refused on create and edit, with no library named', async () => {
    const first = await api('POST', P('/admins'), { token: T('owner'), body: staff('Mobile One', TAKEN, await roleOf(ctx.ids.library)) });
    ok(first, 'first use');
    ctx.ids.mobileStaff = id(first);
    const role2 = await roleOf(ctx.ids.library2);
    const dup = await api('POST', P('/admins'), { token: T('owner2'), body: staff('Mobile Two', TAKEN, role2) });
    isTaken(dup, 'same mobile, other library');
    const lib = await col('libraries').findOne({ _id: Oid(ctx.ids.library) });
    assert.ok(!dup.text.includes(lib.name), 'the error does not name the other library: ' + msg(dup));

    const second = await api('POST', P('/admins'), { token: T('owner2'), body: staff('Mobile Three', FREE, role2) });
    ok(second, 'a free number');
    ctx.ids.mobileStaff2 = id(second);
    isTaken(await api('PUT', P(`/admins/update-admin/${ctx.ids.mobileStaff2}`), { token: T('owner2'), body: { mobile: TAKEN } }), 'edit to a taken number');
    ok(await api('PUT', P(`/admins/update-admin/${ctx.ids.mobileStaff2}`), { token: T('owner2'), body: { mobile: FREE, name: 'Mobile Three B' } }), 'keeping your own number is fine');
    assert.equal((await Admin().findById(ctx.ids.mobileStaff2)).mobile, FREE);
  });

  test('AM2 owners: superadmin edits and registration refuse a taken mobile, and no library is left behind', async () => {
    isTaken(await api('PUT', P(`/super/libraries/${ctx.ids.library2}`), { token: T('super'), body: { mobile: TAKEN } }), 'library edit mirrors to the owner');
    const owner2 = await Admin().findOne({ libraryId: ctx.ids.library2, userType: 'admin' });
    assert.notEqual(owner2.mobile, TAKEN, 'the owner keeps their number');
    assert.notEqual((await col('libraries').findOne({ _id: Oid(ctx.ids.library2) })).mobile, TAKEN, 'the library keeps its number');
    isTaken(await api('PUT', P(`/super/users/${owner2._id}`), { token: T('super'), body: { mobile: TAKEN } }), 'platform user edit');

    const before = await col('libraries').countDocuments({});
    const created = require(path.join(L.SRC, 'services/admin.service')).createLibraryWithAdmin({ name: 'Taken Lib', ownerName: 'Taken Owner', mobile: TAKEN, email: 'taken-owner@mobile.test', password: 'Owner#12345' }, null, null);
    await assert.rejects(created, (e) => e.status === 409 && /already used by another account/.test(e.message));
    assert.equal(await col('libraries').countDocuments({}), before, 'no orphan library');

    isTaken(await api('PUT', P('/update-profile'), { token: T('owner2'), body: { mobile: TAKEN, currentPassword: 'Brand#New123' } }), 'own profile');
  });

  test('AM3 a soft-deleted account frees its mobile', async () => {
    ok(await api('DELETE', P(`/admins/${ctx.ids.mobileStaff}`), { token: T('owner') }), 'delete');
    ok(await api('PUT', P(`/admins/update-admin/${ctx.ids.mobileStaff2}`), { token: T('owner2'), body: { mobile: TAKEN } }), 'number is free again');
  });

  test('AM4 password login with one mobile in two libraries: names only after the password is proven', async () => {
    const a = await legacyStaff(ctx.ids.library, 'Dup A', DUP);
    const b = await legacyStaff(ctx.ids.library2, 'Dup B', DUP);

    const wrong = await login(DUP, 'Wrong#12345');
    expectStatus(wrong, 401, 'wrong password');
    assert.equal(wrong.body.errorCode, undefined);
    assert.equal(wrong.body.data, undefined, 'a wrong password reveals nothing: ' + msg(wrong));
    for (const library of [ctx.ids.library, ctx.ids.library2]) {
      const row = await col('libraries').findOne({ _id: Oid(library) });
      assert.ok(!wrong.text.includes(row.name) && !wrong.text.includes(String(library)), 'no library in the 401');
    }

    const choice = await login(DUP);
    expectStatus(choice, 409, 'right password, two libraries');
    assert.equal(choice.body.errorCode, 'LIBRARY_CHOICE_REQUIRED');
    assert.equal(choice.body.token, undefined, 'no session yet');
    assert.equal(choice.setCookie.length, 0, 'no cookie yet');
    const libs = choice.body.data.libraries;
    assert.deepEqual(libs.map((l) => l.id).sort(), [ctx.ids.library, ctx.ids.library2].map(String).sort());
    assert.ok(libs.every((l) => Object.keys(l).sort().join() === 'id,name' && l.name), 'name and id only: ' + msg(choice));

    const done = await login(DUP, PASSWORD, { libraryId: ctx.ids.library2 });
    ok(done, 'after choosing');
    assert.equal(String(done.body.user.id), String(b._id), 'signed in to the chosen library');
    assert.equal(String(done.body.user.libraryId), String(ctx.ids.library2));

    const elsewhere = await login(DUP, PASSWORD, { libraryId: String(Oid()) });
    expectStatus(elsewhere, 401, 'a library this person is not in');
    expectStatus(await login(DUP, 'Wrong#12345', { libraryId: ctx.ids.library }), 401, 'choosing a library does not skip the password');
    assert.equal(String((await login(DUP, PASSWORD, { libraryId: ctx.ids.library })).body.user.id), String(a._id));
  });

  test('AM5 only accounts that hold this password and can sign in are offered', async () => {
    await legacyStaff(ctx.ids.library, 'Other Pw A', DUP_OTHER_PASSWORD, 'Different#12345');
    const b = await legacyStaff(ctx.ids.library2, 'Other Pw B', DUP_OTHER_PASSWORD);
    const direct = await login(DUP_OTHER_PASSWORD);
    ok(direct, 'one account holds this password');
    assert.equal(String(direct.body.user.id), String(b._id));

    const c = await legacyStaff(ctx.ids.library, 'Off A', DUP_DISABLED);
    const d = await legacyStaff(ctx.ids.library2, 'Off B', DUP_DISABLED);
    await Admin().updateOne({ _id: d._id }, { $set: { status: false } });
    const usable = await login(DUP_DISABLED);
    ok(usable, 'the disabled account is not a choice');
    assert.equal(String(usable.body.user.id), String(c._id));
    await Admin().updateOne({ _id: c._id }, { $set: { status: false } });
    expectStatus(await login(DUP_DISABLED), 403, 'nothing usable');
  });

  test('AM6 OTP login with one mobile in two libraries: same step, only after a correct code', async () => {
    await legacyStaff(ctx.ids.library, 'Otp A', DUP_OTP);
    const b = await legacyStaff(ctx.ids.library2, 'Otp B', DUP_OTP);
    const sent = await api('POST', U('/send-otp'), { body: { mobile: DUP_OTP } });
    ok(sent, 'send-otp no longer fails for an admin number');
    const otp = String(data(sent).otp);
    assert.match(otp, /^\d{6}$/);
    assert.equal(data(sent).libraries, undefined);

    const wrong = await api('POST', U('/verify-otp'), { body: { mobile: DUP_OTP, otp: otp === '000000' ? '111111' : '000000' } });
    expectStatus(wrong, 400, 'wrong code');
    assert.equal(wrong.body.data, undefined, 'a wrong code reveals nothing: ' + msg(wrong));

    const choice = await api('POST', U('/verify-otp'), { body: { mobile: DUP_OTP, otp } });
    expectStatus(choice, 409, 'right code');
    assert.equal(choice.body.errorCode, 'LIBRARY_CHOICE_REQUIRED');
    assert.equal(choice.body.data.libraries.length, 2);

    const done = await api('POST', U('/verify-otp'), { body: { mobile: DUP_OTP, otp, libraryId: ctx.ids.library2 } });
    ok(done, 'after choosing');
    assert.equal(String(done.body.user.id), String(b._id));
    expectStatus(await api('POST', U('/verify-otp'), { body: { mobile: DUP_OTP, otp, libraryId: ctx.ids.library2 } }), 400, 'single use');
  });

  test('AM7 the duplicate report lists live duplicates by last 4 digits and writes nothing', async () => {
    const { findDuplicates } = require(path.join(L.SRC, '../scripts/report_duplicate_mobiles'));
    const before = await col('admins').countDocuments({});
    const report = await findDuplicates(L.state.mongoose.connection.db);
    assert.equal(await col('admins').countDocuments({}), before);
    const text = JSON.stringify(report);
    const row = report.duplicates.find((d) => d.mobile === `******${DUP.slice(-4)}`);
    assert.ok(row, text);
    assert.equal(row.accounts.length, 2);
    assert.equal(row.libraries, 2);
    assert.ok(row.accounts.every((a) => a.libraryName && a.libraryId));
    for (const full of [DUP, DUP_OTP, TAKEN]) assert.ok(!text.includes(full), 'no full number in the report');
    assert.ok(!report.duplicates.some((d) => d.mobile.endsWith(TAKEN.slice(-4))), 'a soft-deleted account is not a duplicate');
  });
};
