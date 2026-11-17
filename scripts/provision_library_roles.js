/**
 * One-time migration: give every library its own copy of the basic roles (Staff, Receptionist, Accountant, Manager),
 * move staff from the shared platform roles onto their library's copy, and remove the stray duplicate "staff" role.
 *
 *   node scripts/provision_library_roles.js            (dry run: only reports)
 *   node scripts/provision_library_roles.js --apply    (writes)
 *
 * Safe to run again: roles that exist are kept and staff already on a library role are not touched.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../src/config/config');
const Role = require('../src/models/role.model');
const Admin = require('../src/models/admin.model');
const Library = require('../src/models/library.model');
const { provisionDefaultRoles, BASIC_ROLES } = require('../src/services/libraryRoles.service');

const apply = process.argv.includes('--apply');
const BASIC_LOWER = new Map(BASIC_ROLES.map((r) => [r.name.toLowerCase(), r.name]));

(async () => {
  await mongoose.connect(config.mongoose.url);
  const libraries = await Library.find({ isDeleted: { $ne: true } }).select('name').lean();
  const globals = await Role.find({ libraryId: null }).select('name').lean();
  const globalName = new Map(globals.map((r) => [String(r._id), r.name]));
  const report = { libraries: libraries.length, rolesToCreate: 0, staffToMove: 0, moved: [] };

  for (const lib of libraries) {
    const have = new Set((await Role.find({ libraryId: lib._id }).select('name').lean()).map((r) => r.name.toLowerCase()));
    const missing = BASIC_ROLES.filter((r) => !have.has(r.name.toLowerCase())).map((r) => r.name);
    report.rolesToCreate += missing.length;

    const staff = await Admin.find({ libraryId: lib._id, userType: 'staff' }).select('name roleId isDeleted').lean();
    const movers = staff.filter((s) => globalName.has(String(s.roleId)) && BASIC_LOWER.has(globalName.get(String(s.roleId)).toLowerCase()));
    report.staffToMove += movers.length;

    if (!apply) {
      console.log(`${lib.name}: would create [${missing.join(', ') || 'nothing'}], move ${movers.length} staff`);
      continue;
    }
    const { created, roles } = await provisionDefaultRoles(lib._id);
    for (const s of movers) {
      const target = roles[BASIC_LOWER.get(globalName.get(String(s.roleId)).toLowerCase())];
      if (!target) continue;
      await Admin.updateOne({ _id: s._id }, { $set: { roleId: target._id } });
      report.moved.push(`${s.name}: ${globalName.get(String(s.roleId))} -> ${target.name} (${lib.name})`);
    }
    console.log(`${lib.name}: created [${created.join(', ') || 'nothing'}], moved ${movers.length} staff`);
  }

  // the lowercase duplicate "staff" platform role goes away once nobody uses it
  const dup = await Role.findOne({ libraryId: null, name: 'staff' });
  if (dup) {
    const users = await Admin.countDocuments({ roleId: dup._id });
    if (!apply) console.log(`duplicate role "staff": ${users} account(s) still use it${users ? '' : ' (would delete)'}`);
    else if (users === 0) { await Role.deleteOne({ _id: dup._id }); console.log('deleted duplicate role "staff"'); }
    else console.log(`kept duplicate role "staff": ${users} account(s) still use it`);
  }

  console.log(apply ? 'DONE' : 'DRY RUN (add --apply to write)', JSON.stringify(report, null, 2));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
