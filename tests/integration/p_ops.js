// Part: protected uploads, one-off scripts (Aadhaar mask migration, seed idempotency) run as real child processes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const L = require('./lib');
const { api, P, SRC } = L;

module.exports = (H) => {
  const { ctx, ok, expectStatus, data, msg, T, id } = H;
  const col = (n) => L.state.mongoose.connection.db.collection(n);
  const BACKEND = path.join(SRC, '..');
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
  const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

  const childEnv = () => ({ ...process.env, MONGODB_URL: process.env.MONGODB_URL });
  const runScript = (rel, args = []) => spawnSync(process.execPath, [path.join(BACKEND, rel), ...args], { cwd: process.cwd(), env: childEnv(), encoding: 'utf8', timeout: 90000 });

  test('73 uploads: magic bytes enforced, documents released only to the right people', async () => {
    const mkForm = (extra, files) => {
      const f = new FormData();
      Object.entries({ name: 'Doc Dev', mobile: '9811101501', password: 'Stud#12345', consentGiven: 'true', branchId: ctx.ids.branchA, ...extra }).forEach(([k, v]) => f.append(k, v));
      for (const [field, buf, name, type] of files) f.append(field, new Blob([buf], { type }), name);
      return f;
    };
    const fake = await api('POST', P('/students/create-student'), { token: T('recA'), form: mkForm({ mobile: '9811101502' }, [['aadhaarCardImage', Buffer.from('<?php echo 1; ?>'), 'card.png', 'image/png']]) });
    assert.ok(fake.status >= 400 && fake.status < 500, 'a script renamed .png is refused (magic-byte check): ' + msg(fake));
    const exe = await api('POST', P('/students/create-student'), { token: T('recA'), form: mkForm({ mobile: '9811101503' }, [['documents', Buffer.from('MZ\x90\x00 fake exe'), 'proof.pdf', 'application/pdf']]) });
    assert.ok(exe.status >= 400 && exe.status < 500, 'an executable renamed .pdf is refused: ' + msg(exe));
    const good = await api('POST', P('/students/create-student'), { token: T('recA'), form: mkForm({}, [['aadhaarCardImage', PNG, 'card.png', 'image/png'], ['documents', PDF, 'proof.pdf', 'application/pdf']]) });
    ok(good, 'genuine png + pdf accepted');
    const sid = id(good);
    const raw = await col('students').findOne({ _id: new (L.state.mongoose.Types.ObjectId)(sid) });
    const img = (raw.aadhaarCardImage || [])[0]; const doc = ((raw.documents || [])[0] || {}).url;
    assert.ok(img && doc, 'stored paths: ' + JSON.stringify({ img, doc }));
    console.log('STORED PATHS', img, doc);
    assert.ok(!/proof\.pdf|card\.png/.test(img + doc), 'file names are randomised, the client name is not reused');
    const fileName = (p) => p.split('/').pop();
    const folder = (p) => p.split('/').slice(-2)[0];
    // static route must not serve identity documents
    const stat = await api('GET', `/uploads/${folder(img)}/${fileName(img)}`);
    assert.equal(stat.status, 404, 'identity documents are not served statically: ' + stat.status);
    // authenticated route
    const own = await api('GET', P(`/files/${folder(img)}/${fileName(img)}`), { token: T('owner') }); assert.equal(own.status, 200, 'owner: ' + own.status);
    const same = await api('GET', P(`/files/${folder(img)}/${fileName(img)}`), { token: T('recA') }); assert.equal(same.status, 200, 'branch staff with students.view: ' + same.status);
    const otherBranch = await api('GET', P(`/files/${folder(img)}/${fileName(img)}`), { token: T('recB') });
    assert.ok([403, 404].includes(otherBranch.status), 'other-branch staff refused: ' + otherBranch.status);
    const otherLib = await api('GET', P(`/files/${folder(img)}/${fileName(img)}`), { token: T('owner2') });
    assert.equal(otherLib.status, 404, 'another library: ' + otherLib.status);
    assert.equal((await api('GET', P(`/files/${folder(img)}/${fileName(img)}`))).status, 401, 'anonymous');
    const noPerm = await api('GET', P(`/files/${folder(img)}/${fileName(img)}`), { token: T('acct') });
    console.log('accountant (students.view) reading Aadhaar image ->', noPerm.status);
    for (const bad of ['..%2f..%2fpackage.json', '..%5c..%5cpackage.json', '%2e%2e%2fsecret', 'x.png%00.txt']) {
      const t = await api('GET', P(`/files/documents/${bad}`), { token: T('owner') });
      assert.ok([400, 404].includes(t.status), `path traversal ${bad}: ${t.status}`);
    }
  });

  test('74 Aadhaar migration script: dry run writes nothing, --apply masks, re-run is a no-op', async () => {
    const Oid = L.state.mongoose.Types.ObjectId;
    const AAD = H.aadhaarWithCheck('45678901234');
    const libId = new Oid(ctx.ids.library);
    const base = { libraryId: libId, status: 'active', isDeleted: false, mobile: '', createdAt: new Date(), updatedAt: new Date() };
    await col('students').insertMany([
      { ...base, name: 'Legacy Valid', mobile: '9811109001', aadhaarNumber: AAD },
      { ...base, name: 'Legacy Invalid', mobile: '9811109002', aadhaarNumber: '123456789012' },
    ]);
    const dry = runScript('scripts/migrate_aadhaar_mask.js');
    console.log('MIGRATION dry-run:', (dry.stdout || '').trim().split('\n').slice(-6).join(' | '), dry.stderr ? 'STDERR ' + dry.stderr.slice(0, 200) : '');
    assert.equal(dry.status, 0, 'dry run exits 0: ' + dry.stderr);
    let v = await col('students').findOne({ mobile: '9811109001' });
    assert.equal(v.aadhaarNumber, AAD, 'dry run changed nothing');
    const apply = runScript('scripts/migrate_aadhaar_mask.js', ['--apply']);
    console.log('MIGRATION apply:', (apply.stdout || '').trim().split('\n').slice(-6).join(' | '));
    assert.equal(apply.status, 0, 'apply exits 0: ' + apply.stderr);
    v = await col('students').findOne({ mobile: '9811109001' });
    assert.equal(v.aadhaarNumber, undefined, 'full number removed');
    assert.equal(v.aadhaarLast4, AAD.slice(-4));
    assert.match(String(v.aadhaarHash), /^[0-9a-f]{32,}$/, 'keyed hash stored');
    assert.ok(!JSON.stringify(v).includes(AAD), 'the full number appears nowhere in the document');
    const inv = await col('students').findOne({ mobile: '9811109002' });
    assert.equal(inv.aadhaarNumber, undefined, 'invalid numbers are removed too');
    const again = runScript('scripts/migrate_aadhaar_mask.js', ['--apply']);
    assert.equal(again.status, 0);
    const v2 = await col('students').findOne({ mobile: '9811109001' });
    assert.equal(v2.aadhaarHash, v.aadhaarHash, 'idempotent');
    // duplicate detection works against migrated rows
    const dup = await api('POST', P('/students/create-student'), { token: T('recA'), body: H.stu({ name: 'Dup After Migration', mobile: '9811109003', aadhaarNumber: AAD }) });
    assert.equal(dup.status, 409, 'a migrated Aadhaar still blocks a duplicate admission: ' + msg(dup));
  });

  test('75 seed script is idempotent (runs as a child process against the same database)', async () => {
    // the harness only synced library menus; the first real seed also adds the student-portal menus
    assert.equal(runScript('src/seed/masterSeed.js').status, 0, 'first run');
    const before = { perms: await col('permissions').countDocuments({}), menus: await col('sidebarmenus').countDocuments({}), supers: await col('admins').countDocuments({ userType: 'superadmin' }), roles: await col('roles').countDocuments({}) };
    const run = runScript('src/seed/masterSeed.js');
    console.log('SEED run:', (run.stdout || '').trim().split('\n').slice(-4).join(' | '), run.stderr ? 'STDERR ' + run.stderr.slice(0, 300) : '');
    assert.equal(run.status, 0, 'seed exits 0: ' + (run.stderr || '').slice(0, 400));
    const after = { perms: await col('permissions').countDocuments({}), menus: await col('sidebarmenus').countDocuments({}), supers: await col('admins').countDocuments({ userType: 'superadmin' }), roles: await col('roles').countDocuments({}) };
    assert.deepEqual(after, before, 'seeding twice changes nothing');
    ok(await api('POST', '/v1/public/login', { body: { identifier: 'root@dd.test', password: 'SuperPass#123' } }), 'existing superadmin untouched');
  });
};
