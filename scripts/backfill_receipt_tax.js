/*
 * One-time backfill: gives every issued receipt and refund note that predates tax snapshots a taxSnapshot.
 *
 * Without a snapshot a receipt follows the library's live GST settings, so its figures move whenever those settings
 * change. This freezes each one at what it prints today, using the same snapshotTax the ledger uses when issuing:
 * the library's CURRENT settings, not the ones in force on the receipt's date (those were never recorded).
 * Review a dry run first, and fix any library whose GST settings are wrong BEFORE applying: this cannot be undone
 * by a later settings change.
 *
 * Idempotent: only successful transactions with no snapshot are touched, so it is safe to run again. Pending and
 * failed online attempts are left alone (they get their snapshot when they succeed). updatedAt is not changed.
 *
 * Usage (from backend/):
 *   node scripts/backfill_receipt_tax.js            # DRY RUN: only prints what would change
 *   node scripts/backfill_receipt_tax.js --apply    # writes the changes
 *   node scripts/backfill_receipt_tax.js --apply --library=<libraryId>   # one library only
 */
const mongoose = require('mongoose');
require('dotenv').config();
const config = require('../src/config/config');

const Library = require('../src/models/library.model');
const PaymentTransaction = require('../src/models/paymentTransaction.model');
const { snapshotTax } = require('../src/services/feeLedger.service');

const BATCH = 500;
const NO_SNAPSHOT = { $or: [{ taxSnapshot: null }, { taxSnapshot: { $exists: false } }] };

const backfill = async ({ apply = false, libraryId = null, log = console.log } = {}) => {
    const filter = { status: 'success', ...NO_SNAPSHOT, ...(libraryId ? { libraryId } : {}) };
    const totals = { found: 0, withGst: 0, withoutGst: 0, libraryMissing: 0, failed: 0, written: 0 };
    const known = new Map();
    const libraryExists = async (id) => {
        const k = String(id);
        if (!known.has(k)) known.set(k, !!(await Library.exists({ _id: id })));
        return known.get(k);
    };

    let last = null;
    for (;;) {
        const q = last ? { ...filter, _id: { $gt: last } } : filter;
        const batch = await PaymentTransaction.find(q).select('libraryId studentId allocations').sort({ _id: 1 }).limit(BATCH).lean();
        if (!batch.length) break;
        last = batch[batch.length - 1]._id;
        for (const txn of batch) {
            totals.found += 1;
            try {
                // no library, no settings to snapshot: a "GST off" record here would be invented
                if (!(await libraryExists(txn.libraryId))) { totals.libraryMissing += 1; continue; }
                const taxSnapshot = await snapshotTax({ libraryId: txn.libraryId, studentId: txn.studentId, allocations: txn.allocations || [] });
                totals[taxSnapshot.enabled ? 'withGst' : 'withoutGst'] += 1;
                if (!apply) continue;
                // compare-and-set: a snapshot written since this batch was read wins
                const r = await PaymentTransaction.updateOne({ _id: txn._id, ...NO_SNAPSHOT }, { $set: { taxSnapshot } }, { timestamps: false });
                totals.written += r.modifiedCount;
            } catch (e) {
                totals.failed += 1;
                log(`  failed ${txn._id}: ${e.message}`);
            }
        }
    }

    log(`\n${apply ? 'Updated' : 'Would update'} (successful transactions with no tax snapshot):`);
    Object.entries(totals).forEach(([k, v]) => log(`  ${k.padEnd(16)} ${v}`));
    if (!apply) log('\nDry run only. Re-run with --apply to write these changes.');
    return totals;
};

const main = async () => {
    const apply = process.argv.includes('--apply');
    const only = (process.argv.find((a) => a.startsWith('--library=')) || '').split('=')[1];
    if (only && !mongoose.isValidObjectId(only)) throw new Error('--library must be a library id');

    await mongoose.connect(config.mongoose.url);
    console.log(`Connected. Mode: ${apply ? 'APPLY (writing)' : 'DRY RUN (no writes)'}`);
    const totals = await backfill({ apply, libraryId: only || null });
    await mongoose.disconnect();
    process.exit(totals.failed ? 1 : 0);
};

if (require.main === module) {
    main().catch(async (e) => {
        console.error('Backfill failed:', e.message);
        try { await mongoose.disconnect(); } catch (_) { /* ignore */ }
        process.exit(1);
    });
}

module.exports = { backfill };
