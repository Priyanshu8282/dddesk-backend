/*
 * DPDP / UIDAI: stop keeping full Aadhaar numbers.
 *
 * Converts every student that still has the legacy plain-text `aadhaarNumber` into
 * `aadhaarLast4` + `aadhaarHash` (keyed HMAC, see src/utils/aadhaar.js) and REMOVES the full number.
 * Idempotent: students without a legacy number are skipped, so it is safe to run again.
 * Numbers that are not valid Aadhaar numbers (wrong length / checksum) cannot be hashed for duplicate
 * detection; their last 4 digits are kept for display (when at least 4 digits exist) and the raw value is
 * removed anyway. They are counted as "invalid" in the report.
 *
 * It is never run automatically. Usage (from backend/):
 *   node scripts/migrate_aadhaar_mask.js            # DRY RUN (default): prints what would change, writes nothing
 *   node scripts/migrate_aadhaar_mask.js --apply    # writes the changes
 *   node scripts/migrate_aadhaar_mask.js --apply --library=<libraryId>
 * Back up the database before using --apply: the full numbers cannot be recovered afterwards.
 */
const mongoose = require('mongoose');
require('dotenv').config();
const config = require('../src/config/config');
const { isValidAadhaar, deriveAadhaar } = require('../src/utils/aadhaar');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const libArg = (args.find((a) => a.startsWith('--library=')) || '').split('=')[1];

(async () => {
    await mongoose.connect(config.mongoose.url);
    const col = mongoose.connection.collection('students');
    const filter = { aadhaarNumber: { $exists: true, $nin: [null, ''] } };
    if (libArg) filter.libraryId = new mongoose.Types.ObjectId(libArg);

    const stats = { scanned: 0, converted: 0, invalid: 0, duplicates: 0, cleared: 0 };
    const seen = new Map(); // libraryId:hash -> first student id
    console.log(`${APPLY ? 'APPLY' : 'DRY RUN'}: students with a legacy aadhaarNumber${libArg ? ` in library ${libArg}` : ''}`);

    const cursor = col.find(filter, { projection: { aadhaarNumber: 1, libraryId: 1, isDeleted: 1 } });
    for await (const s of cursor) {
        stats.scanned++;
        const raw = String(s.aadhaarNumber).replace(/[\s-]/g, '');
        const $set = {};
        if (isValidAadhaar(raw)) {
            const d = deriveAadhaar(raw, s.libraryId);
            $set.aadhaarLast4 = d.aadhaarLast4;
            $set.aadhaarHash = d.aadhaarHash;
            const key = `${s.libraryId}:${d.aadhaarHash}`;
            if (seen.has(key) && !s.isDeleted) stats.duplicates++;
            else if (!s.isDeleted) seen.set(key, s._id);
            stats.converted++;
        } else {
            stats.invalid++;
            const last4 = raw.replace(/\D/g, '').slice(-4);
            if (last4.length === 4) $set.aadhaarLast4 = last4;
        }
        if (APPLY) {
            await col.updateOne({ _id: s._id }, { ...(Object.keys($set).length && { $set }), $unset: { aadhaarNumber: '' } });
            stats.cleared++;
        }
    }
    console.log(stats);
    if (!APPLY) console.log('Nothing was written. Re-run with --apply to convert.');
    await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
