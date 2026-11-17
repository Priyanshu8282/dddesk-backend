/**
 * One-off migration for the tenant-scoped roles + deferred slug changes.
 * NOT run automatically. Usage (from backend/):  node scripts/migrate_tenant_roles_slugs.js
 *
 *  1. roles: drop the old unique index on `name` (names are now unique per library: {libraryId, name})
 *  2. roles: assign libraryId to legacy owner-created roles (from the creating admin's library)
 *  3. libraries: drop the old non-sparse unique `slug_1` index so libraries without a slug (pending) can coexist;
 *     mongoose recreates it as a sparse unique index on next start
 *  4. libraries: initialise previousSlugs-safe state (no data change needed)
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const config = require('../src/config/config');

const dropIndex = async (coll, name) => {
  try { await coll.dropIndex(name); console.log(`dropped ${coll.collectionName}.${name}`); }
  catch (e) { console.log(`skip ${coll.collectionName}.${name}: ${e.codeName || e.message}`); }
};

(async () => {
  await mongoose.connect(config.mongoose.url);
  const db = mongoose.connection.db;

  await dropIndex(db.collection('roles'), 'name_1');

  const roles = db.collection('roles');
  const admins = db.collection('admins');
  const legacy = await roles.find({ libraryId: { $exists: false }, isDefault: { $ne: true }, createdBy: { $ne: null } }).toArray();
  let fixed = 0;
  for (const r of legacy) {
    const creator = await admins.findOne({ _id: r.createdBy });
    if (creator?.libraryId) { await roles.updateOne({ _id: r._id }, { $set: { libraryId: creator.libraryId } }); fixed++; }
  }
  console.log(`legacy roles scoped to a library: ${fixed}/${legacy.length}`);
  // system roles explicitly get libraryId: null
  const r2 = await roles.updateMany({ libraryId: { $exists: false }, isDefault: true }, { $set: { libraryId: null } });
  console.log(`system roles normalised: ${r2.modifiedCount}`);

  await dropIndex(db.collection('libraries'), 'slug_1');
  // mobile uniqueness is now partial (non-deleted libraries only); mongoose recreates it as mobile_1 with the filter
  await dropIndex(db.collection('libraries'), 'mobile_1');

  await mongoose.disconnect();
  console.log('Done. Restart the API so mongoose rebuilds the new indexes, then run: node src/seed/rbacSync.js');
})().catch((e) => { console.error(e); process.exit(1); });
