/*
 * Lists mobile numbers shared by more than one live Admin account (owner, staff, super admin).
 * New duplicates are refused by the app (assertMobileFree in src/services/admin.service.js); this shows what is left from
 * before that rule, so each person can be given their own number. A unique index on Admin.mobile can only be added once
 * this report is empty.
 *
 * READ ONLY: it never writes, and it loads no Mongoose model so that connecting does not build indexes either.
 * Numbers print as their last 4 digits only. Soft-deleted accounts are left out. Numbers are compared after
 * normalizeMobile, so "+91 98765 43210" and "9876543210" count as one.
 *
 * Usage (from backend/):
 *   node scripts/report_duplicate_mobiles.js
 *   node scripts/report_duplicate_mobiles.js --json
 */
const { normalizeMobile } = require('../src/utils/mobile');

const lastFour = (mobile) => `******${String(mobile).slice(-4)}`;

// db: a connected native driver database. Only find() is used.
const findDuplicates = async (db) => {
    const accounts = await db.collection('admins')
        .find({ isDeleted: { $ne: true }, mobile: { $exists: true, $nin: [null, ''] } }, { projection: { mobile: 1, userType: 1, status: 1, libraryId: 1 } })
        .toArray();

    const byMobile = new Map();
    for (const a of accounts) {
        const key = normalizeMobile(a.mobile);
        if (!byMobile.has(key)) byMobile.set(key, []);
        byMobile.get(key).push(a);
    }
    const groups = [...byMobile.entries()].filter(([, list]) => list.length > 1);

    const libraryIds = groups.flatMap(([, list]) => list.map((a) => a.libraryId).filter(Boolean));
    const libraries = await db.collection('libraries').find({ _id: { $in: libraryIds } }, { projection: { name: 1 } }).toArray();
    const nameOf = new Map(libraries.map((l) => [String(l._id), l.name]));

    return {
        accountsScanned: accounts.length,
        duplicates: groups.map(([mobile, list]) => ({
            mobile: lastFour(mobile),
            libraries: new Set(list.map((a) => String(a.libraryId || 'none'))).size,
            accounts: list.map((a) => ({
                id: String(a._id), userType: a.userType, active: a.status !== false,
                libraryId: a.libraryId ? String(a.libraryId) : null,
                libraryName: a.libraryId ? nameOf.get(String(a.libraryId)) || '(library not found)' : '(no library)',
            })),
        })),
    };
};

const main = async () => {
    const mongoose = require('mongoose');
    require('dotenv').config();
    const config = require('../src/config/config');
    await mongoose.connect(config.mongoose.url);
    const report = await findDuplicates(mongoose.connection.db);
    if (process.argv.includes('--json')) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        console.log(`Scanned ${report.accountsScanned} live Admin accounts: ${report.duplicates.length} shared mobile number(s).`);
        for (const d of report.duplicates) {
            console.log(`\n${d.mobile}  ${d.accounts.length} accounts in ${d.libraries} librar${d.libraries === 1 ? 'y' : 'ies'}`);
            for (const a of d.accounts) console.log(`  ${a.userType.padEnd(10)} ${a.active ? 'active  ' : 'disabled'} ${a.id}  ${a.libraryName}${a.libraryId ? ` (${a.libraryId})` : ''}`);
        }
    }
    await mongoose.disconnect();
};

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { findDuplicates };
