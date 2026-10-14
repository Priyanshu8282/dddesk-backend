/*
 * Multi-branch backfill (spec 30 / PRD 35).
 *
 * Gives every existing record that has no branch yet a branchId, so branch-scoped staff and
 * the per-branch reports can see legacy data. Idempotent: only records whose branchId is
 * null/missing are touched, so it is safe to run again.
 *
 * Rules (per library that has at least one live branch):
 *   1. students, seats, expenses, enquiries, complaints with no branch -> the library's MAIN branch
 *      (isMain, else the oldest live branch).
 *   2. records that belong to a student (attendance, payments/charges, payment transactions,
 *      membership history) -> that student's branch (after step 1 every student has one).
 *   3. seat history -> the branch of its seat.
 *   Notices / stories / banners are NOT touched: null already means "all branches".
 * Libraries with no branches are skipped (everything stays null = single-branch behaviour).
 *
 * Usage (from backend/):
 *   node scripts/backfill_branch.js            # DRY RUN: only prints what would change
 *   node scripts/backfill_branch.js --apply    # writes the changes
 *   node scripts/backfill_branch.js --apply --library=<libraryId>   # one library only
 */
const mongoose = require('mongoose');
require('dotenv').config();
const config = require('../src/config/config');

const Branch = require('../src/models/branch.model');
const Student = require('../src/models/student.model');
const Seat = require('../src/models/seat.model');
const Attendance = require('../src/models/attendance.model');
const Payment = require('../src/models/payment.model');
const PaymentTransaction = require('../src/models/paymentTransaction.model');
const Expense = require('../src/models/expense.model');
const Enquiry = require('../src/models/enquiry.model');
const Complaint = require('../src/models/complaint.model');
const MembershipHistory = require('../src/models/membershipHistory.model');
const SeatHistory = require('../src/models/seatHistory.model');

const APPLY = process.argv.includes('--apply');
const ONLY = (process.argv.find((a) => a.startsWith('--library=')) || '').split('=')[1];
const CHUNK = 2000;

const NO_BRANCH = { $or: [{ branchId: null }, { branchId: { $exists: false } }] };

// Raw collection access so soft-delete hooks do not hide deleted/archived rows from the backfill
const col = (Model) => Model.collection;

const count = (Model, filter) => col(Model).countDocuments(filter);
const setBranch = async (Model, filter, branchId) => {
    const n = await count(Model, filter);
    if (APPLY && n) await col(Model).updateMany(filter, { $set: { branchId } });
    return n;
};

const run = async () => {
    await mongoose.connect(config.mongoose.url);
    console.log(`Connected. Mode: ${APPLY ? 'APPLY (writing)' : 'DRY RUN (no writes)'}`);

    const libFilter = ONLY ? { _id: new mongoose.Types.ObjectId(ONLY) } : {};
    const libraries = await mongoose.connection.collection('libraries').find(libFilter, { projection: { _id: 1, name: 1 } }).toArray();

    const totals = {};
    const add = (k, n) => { totals[k] = (totals[k] || 0) + n; };

    for (const lib of libraries) {
        const branches = await Branch.find({ libraryId: lib._id, isDeleted: false }).sort({ isMain: -1, createdAt: 1 }).lean();
        if (!branches.length) { console.log(`- ${lib.name || lib._id}: no branches, skipped`); continue; }
        const main = branches[0];
        console.log(`- ${lib.name || lib._id}: main branch "${main.name}" (${main._id})`);

        // 1. entities with no student link -> main branch
        for (const [label, Model] of [['students', Student], ['seats', Seat], ['expenses', Expense], ['enquiries', Enquiry], ['complaints', Complaint]]) {
            add(label, await setBranch(Model, { libraryId: lib._id, ...NO_BRANCH }, main._id));
        }

        // 2. student-linked records -> the student's branch
        const students = await col(Student).find({ libraryId: lib._id, branchId: { $ne: null } }, { projection: { _id: 1, branchId: 1 } }).toArray();
        const byBranch = new Map();
        for (const s of students) {
            const k = String(s.branchId);
            if (!byBranch.has(k)) byBranch.set(k, []);
            byBranch.get(k).push(s._id);
        }
        for (const [bid, ids] of byBranch) {
            const branchId = new mongoose.Types.ObjectId(bid);
            for (let i = 0; i < ids.length; i += CHUNK) {
                const slice = ids.slice(i, i + CHUNK);
                for (const [label, Model] of [['attendance', Attendance], ['payments', Payment], ['transactions', PaymentTransaction], ['membershipHistory', MembershipHistory]]) {
                    add(label, await setBranch(Model, { libraryId: lib._id, studentId: { $in: slice }, ...NO_BRANCH }, branchId));
                }
            }
        }
        // Anything still without a branch (e.g. records of students that no longer exist) -> main branch
        for (const [label, Model] of [['attendance', Attendance], ['payments', Payment], ['transactions', PaymentTransaction], ['membershipHistory', MembershipHistory]]) {
            add(label, await setBranch(Model, { libraryId: lib._id, ...NO_BRANCH }, main._id));
        }

        // 3. seat history -> branch of the seat
        const seats = await col(Seat).find({ libraryId: lib._id, branchId: { $ne: null } }, { projection: { _id: 1, branchId: 1 } }).toArray();
        const seatByBranch = new Map();
        for (const s of seats) {
            const k = String(s.branchId);
            if (!seatByBranch.has(k)) seatByBranch.set(k, []);
            seatByBranch.get(k).push(s._id);
        }
        for (const [bid, ids] of seatByBranch) {
            const branchId = new mongoose.Types.ObjectId(bid);
            for (let i = 0; i < ids.length; i += CHUNK) {
                add('seatHistory', await setBranch(SeatHistory, { libraryId: lib._id, seatId: { $in: ids.slice(i, i + CHUNK) }, ...NO_BRANCH }, branchId));
            }
        }
        add('seatHistory', await setBranch(SeatHistory, { libraryId: lib._id, ...NO_BRANCH }, main._id));
    }

    console.log(`\n${APPLY ? 'Updated' : 'Would update'} (records without a branch):`);
    Object.entries(totals).forEach(([k, v]) => console.log(`  ${k.padEnd(18)} ${v}`));
    if (!APPLY) console.log('\nDry run only. Re-run with --apply to write these changes.');
    await mongoose.disconnect();
};

run().catch(async (e) => {
    console.error('Backfill failed:', e.message);
    try { await mongoose.disconnect(); } catch (_) { /* ignore */ }
    process.exit(1);
});
