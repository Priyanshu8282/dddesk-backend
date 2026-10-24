/**
 * Fee cron jobs (Asia/Kolkata):
 *  1. mark charges Overdue once dueDate + graceDays has passed
 *  2. send fee-reminder notifications honoring library.feePolicy.reminderFrequencyDays
 * Safe to run twice / on several instances: reminders are claimed atomically per charge
 * through lastReminderAt.
 */
const cron = require('node-cron');
const Payment = require('../models/payment.model');
const Library = require('../models/library.model');
const { startOfDayIST, DAY_MS } = require('../utils/time');

const TZ = 'Asia/Kolkata';

const policyOf = (lib) => ({
    graceDays: 0,
    reminderFrequencyDays: 3,
    ...((lib && lib.feePolicy && lib.feePolicy.toObject ? lib.feePolicy.toObject() : lib && lib.feePolicy) || {})
});

const markOverdueForLibrary = async (library, now) => {
    const p = policyOf(library);
    const cutoff = startOfDayIST(new Date(now.getTime() - (p.graceDays || 0) * DAY_MS));
    const charges = await Payment.find({
        libraryId: library._id,
        paymentStatus: { $in: ['credit', 'partial'] },
        dueAmount: { $gt: 0 },
        dueDate: { $lt: cutoff }
    }).limit(2000);

    let marked = 0;
    for (const c of charges) {
        c.paymentStatus = 'overdue';
        c.overdueSince = c.overdueSince || now;
        try {
            await c.save(); // hook keeps 'overdue' while dues remain
            marked += 1;
        } catch (e) {
            if (e.name !== 'VersionError') console.error('[feeCron] overdue save failed:', e.message);
        }
    }
    return marked;
};

const sendRemindersForLibrary = async (library, now) => {
    const { notifyEvent } = require('./notification.service');
    const p = policyOf(library);
    const freqMs = Math.max(1, p.reminderFrequencyDays || 3) * DAY_MS;
    const threshold = new Date(now.getTime() - freqMs + 60 * 1000); // 1 min tolerance for scheduling jitter
    const soon = new Date(now.getTime() + 2 * DAY_MS); // also nudge for dues in the next 2 days

    const candidates = await Payment.find({
        libraryId: library._id,
        paymentStatus: { $in: ['credit', 'partial', 'overdue'] },
        dueAmount: { $gt: 0 },
        dueDate: { $lte: soon },
        $or: [{ lastReminderAt: null }, { lastReminderAt: { $exists: false } }, { lastReminderAt: { $lte: threshold } }]
    }).select('_id studentId dueAmount dueDate paymentStatus').limit(5000).lean();

    const perStudent = new Map();
    for (const c of candidates) {
        // atomic claim: only the run that flips lastReminderAt sends the message
        const claim = await Payment.updateOne(
            {
                _id: c._id,
                $or: [{ lastReminderAt: null }, { lastReminderAt: { $exists: false } }, { lastReminderAt: { $lte: threshold } }]
            },
            { $set: { lastReminderAt: now }, $inc: { reminderCount: 1 } }
        );
        if (claim.modifiedCount !== 1) continue;
        const key = String(c.studentId);
        const agg = perStudent.get(key) || { total: 0, overdue: 0, count: 0 };
        agg.total += c.dueAmount;
        agg.count += 1;
        if (c.paymentStatus === 'overdue') agg.overdue += 1;
        perStudent.set(key, agg);
    }

    let sent = 0;
    for (const [studentId, a] of perStudent) {
        const total = Math.round(a.total * 100) / 100;
        const title = a.overdue ? 'Fee overdue' : 'Fee reminder';
        const body = a.overdue
            ? `You have an overdue balance of Rs ${total}. Please pay at the earliest.`
            : `A fee payment of Rs ${total} is due soon.`;
        try {
            // The atomic lastReminderAt claim above is the dedupe guard; notifyEvent honours the library's feeReminders opt-out
            await notifyEvent('fee-due', library._id, {
                studentId, title, message: body, variables: { amount: total },
                data: { type: 'fee_reminder', amount: String(total) }
            });
            sent += 1;
        } catch (e) {
            console.error('[feeCron] notify failed:', e.message);
        }
    }
    return sent;
};

const runFeeJobs = async () => {
    const now = new Date();
    const summary = { libraries: 0, overdue: 0, reminders: 0 };
    const libraries = await Library.find({ status: 'active', isDeleted: false }).select('_id feePolicy');
    for (const lib of libraries) {
        try {
            summary.libraries += 1;
            summary.overdue += await markOverdueForLibrary(lib, now);
            summary.reminders += await sendRemindersForLibrary(lib, now);
        } catch (e) {
            console.error(`[feeCron] library ${lib._id} failed:`, e.message);
        }
    }
    return summary;
};

let started = false;
const initFeeCronJobs = () => {
    if (started) return;
    started = true;
    // 09:30 IST daily
    cron.schedule('30 9 * * *', async () => {
        try {
            if (await require('./maintenance.service').cronsPaused()) { console.log('[cron] skipped fee-jobs: maintenance window active (jobs paused)'); return; }
            const s = await runFeeJobs();
            console.log('[feeCron] done', JSON.stringify(s));
        } catch (e) {
            console.error('[feeCron] run failed:', e.message);
        }
    }, { timezone: TZ });
    console.log('[feeCron] scheduled daily 09:30 Asia/Kolkata');
};

module.exports = { initFeeCronJobs, runFeeJobs };
