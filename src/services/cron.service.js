const cron = require('node-cron');
const mongoose = require('mongoose');
const Student = require('../models/student.model');
const Seat = require('../models/seat.model');
const Attendance = require('../models/attendance.model');
const Library = require('../models/library.model');
const MembershipHistory = require('../models/membershipHistory.model');
const CronLock = require('../models/cronLock.model');
const seatService = require('./seat.service');
const { notifyLibraryAdmins, notifyMultipleStudents } = require('./firebase.service');
const { notifyEvent } = require('./notification.service');
const { startOfDayIST, DAY_MS } = require('../utils/time');

const TZ = { timezone: 'Asia/Kolkata' };
const MIN = 60 * 1000;

/** Run `fn` only if this instance wins the lock for the given slot (guards duplicate runs). */
const withLock = async (key, ttlMs, fn) => {
    if (mongoose.connection.readyState !== 1) return;
    let got = false;
    try {
        got = await CronLock.acquire(key, ttlMs);
    } catch (e) {
        console.error(`[cron] lock error for ${key}:`, e.message);
        return;
    }
    if (!got) return;
    try {
        await fn();
    } catch (err) {
        console.error(`[cron] ${key} failed:`, err);
    }
};

const slot = (d = new Date()) => new Date(d.getTime() + 330 * MIN).toISOString(); // IST wall clock

// ---------------------------------------------------------------------------
// Job bodies (exported for tests / manual runs)
// ---------------------------------------------------------------------------

/** Mark ended memberships as expired, close their history and release the seat. */
const expireMemberships = async (now = new Date()) => {
    let total = 0;
    const perLibrary = new Map();
    for (; ;) {
        const due = await Student.find({ planStatus: 'active', expiryDate: { $lt: now }, isDeleted: false })
            .select('_id libraryId seatId').limit(500).lean();
        if (!due.length) break;
        let progressed = 0;
        for (const s of due) {
            const updated = await Student.findOneAndUpdate(
                { _id: s._id, planStatus: 'active', expiryDate: { $lt: now } },
                { $set: { planStatus: 'expired' } },
                { new: true }
            );
            if (!updated) continue;
            progressed++;
            await MembershipHistory.updateMany(
                { studentId: s._id, libraryId: s.libraryId, status: { $in: ['active', 'paused'] } },
                { $set: { status: 'expired', closedReason: 'expired', ...(s.seatId ? { seatId: s.seatId } : {}) } }
            );
            try {
                await seatService.releaseSeatForStudent(s._id, s.libraryId, { reason: 'Membership expired', action: 'auto_released' });
            } catch (e) {
                console.error('[cron] seat release failed for student', String(s._id), e.message);
            }
            const key = String(s.libraryId);
            if (!perLibrary.has(key)) perLibrary.set(key, []);
            perLibrary.get(key).push(s._id);
        }
        total += progressed;
        if (!progressed) break; // avoid spinning if nothing could be updated
    }

    for (const [, ids] of perLibrary) {
        try {
            await notifyMultipleStudents(ids, '❌ Membership Expired', 'Please renew your membership', {}, 'plan_alert');
        } catch (e) { console.error('[cron] expiry notify failed:', e.message); }
    }
    return total;
};

/** Resume memberships that stayed paused beyond the library's max pause window. */
const autoResumePaused = async (now = new Date()) => {
    const studentService = require('./student.service'); // lazy: avoids load-order cycles
    const libraries = await Library.find({ status: 'active', isDeleted: false }).select('membershipPolicy');
    let resumed = 0;
    for (const lib of libraries) {
        const policy = await studentService.getPolicy(lib._id, { library: lib });
        const cutoff = new Date(now.getTime() - policy.maxPauseDays * DAY_MS);
        const stale = await Student.find({ libraryId: lib._id, planStatus: 'paused', membershipPausedAt: { $lte: cutoff } }).select('_id').lean();
        for (const s of stale) {
            try {
                await studentService.resumeMembership(s._id, lib._id, { reason: 'Auto-resumed: maximum pause period reached' }, null, { policy });
                resumed++;
            } catch (e) { console.error('[cron] auto-resume failed:', e.message); }
        }
    }
    return resumed;
};

/** Daily alerts: plans expiring within 3 days, and students absent for 2 days. */
const sendDailyAlerts = async (now = new Date()) => {
    const threeDaysFromNow = new Date(now.getTime() + 3 * DAY_MS);
    const twoDaysAgo = new Date(startOfDayIST(now).getTime() - 2 * DAY_MS);

    const libraries = await Library.find({ status: 'active', isDeleted: false }).select('_id');
    for (const library of libraries) {
        try {
            // 1. Plan expiry alert
            const expiring = await Student.find({
                libraryId: library._id, planStatus: 'active', status: 'active',
                expiryDate: { $gte: now, $lte: threeDaysFromNow }
            }).select('_id expiryDate').lean();
            if (expiring.length) {
                notifyLibraryAdmins(library._id, '⚠ Plan Expiry Alert', `${expiring.length} student(s) plans expire within 3 days`);
                // One membership-expiry event per student (own expiry date); dedupeKey stops the 3 daily runs repeating it
                for (const s of expiring) {
                    const day = new Date(s.expiryDate).toISOString().slice(0, 10);
                    await notifyEvent('membership-expiry', library._id, {
                        studentId: s._id, variables: { expiryDate: day },
                        data: { type: 'membership_expiry', expiryDate: day }, dedupeKey: `expiry:${day}`
                    });
                }
            }

            // 2. Attendance alert: one aggregate instead of a query per student
            const active = await Student.find({ libraryId: library._id, status: 'active', planStatus: 'active' }).select('_id name').lean();
            if (active.length) {
                const present = await Attendance.aggregate([
                    { $match: { libraryId: library._id, studentId: { $in: active.map((s) => s._id) }, date: { $gte: twoDaysAgo } } },
                    { $group: { _id: '$studentId' } }
                ]);
                const presentSet = new Set(present.map((p) => String(p._id)));
                const absent = active.filter((s) => !presentSet.has(String(s._id)));
                if (absent.length) {
                    const names = absent.slice(0, 3).map((s) => s.name).join(', ');
                    notifyLibraryAdmins(
                        library._id, '📅 Attendance Alert',
                        `${absent.length} student(s) absent for 2 days${names ? `: ${names}${absent.length > 3 ? '...' : ''}` : ''}`
                    );
                }
            }
        } catch (e) {
            console.error('[cron] daily alerts failed for library', String(library._id), e.message);
        }
    }
};

/**
 * Release seats of active members who never showed up: library.attendanceRules.autoReleaseNoShow
 * must be on. A no-show is a seated student with no attendance since their membership/seat
 * start, once a full day plus `noShowGraceMinutes` has elapsed. The membership itself is kept.
 */
const releaseNoShowSeats = async (now = new Date()) => {
    const libraries = await Library.find({ status: 'active', isDeleted: false, 'attendanceRules.autoReleaseNoShow': true })
        .select('attendanceRules');
    const todayStart = startOfDayIST(now);
    let released = 0;

    for (const lib of libraries) {
        const graceMs = (lib.attendanceRules?.noShowGraceMinutes ?? 60) * MIN;
        const seats = await Seat.find({ libraryId: lib._id, status: 'occupied', studentId: { $ne: null }, assignedAt: { $lt: todayStart } })
            .populate('studentId', 'planStatus planStartDate status').lean();
        const candidates = seats.filter((s) => {
            const st = s.studentId;
            if (!st || st.planStatus !== 'active' || st.status !== 'active') return false;
            const since = new Date(Math.max(new Date(s.assignedAt).getTime(), st.planStartDate ? new Date(st.planStartDate).getTime() : 0));
            return since.getTime() + graceMs < now.getTime() && since < todayStart;
        });
        if (!candidates.length) continue;

        const attended = await Attendance.aggregate([
            { $match: { libraryId: lib._id, studentId: { $in: candidates.map((s) => s.studentId._id) } } },
            { $group: { _id: '$studentId', last: { $max: '$checkIn' } } }
        ]);
        const lastMap = new Map(attended.map((a) => [String(a._id), a.last]));

        for (const s of candidates) {
            const since = new Date(Math.max(new Date(s.assignedAt).getTime(), s.studentId.planStartDate ? new Date(s.studentId.planStartDate).getTime() : 0));
            const last = lastMap.get(String(s.studentId._id));
            if (last && new Date(last) >= since) continue; // has attended since start
            try {
                await seatService.releaseSeat(s._id, lib._id, null, { reason: 'No-show: auto released', action: 'auto_released' });
                released++;
                await notifyMultipleStudents([s.studentId._id], 'Seat released', 'Your seat was released because you have not visited yet. Contact the library to get a seat again.', {}, 'plan_alert');
            } catch (e) { console.error('[cron] no-show release failed:', e.message); }
        }
    }
    return released;
};

// ---------------------------------------------------------------------------
// One-time index migration (global unique mobile / seatNumber -> per-library)
// ---------------------------------------------------------------------------
const migrateLegacyIndexes = async () => {
    const targets = [
        { model: Student, legacy: ['mobile_1'] },
        { model: Seat, legacy: ['libraryId_1_seatNumber_1'] }
    ];
    for (const { model, legacy } of targets) {
        try {
            const indexes = await model.collection.indexes();
            for (const name of legacy) {
                const idx = indexes.find((i) => i.name === name && i.unique && !i.partialFilterExpression);
                if (idx) {
                    await model.collection.dropIndex(name);
                    console.log(`[migration] dropped legacy index ${model.collection.name}.${name}`);
                }
            }
            await model.createIndexes();
        } catch (e) {
            console.error(`[migration] index migration failed for ${model.modelName}:`, e.message);
        }
    }
};

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------
const initCronJobs = () => {
    // Index migration once the DB connection is ready
    if (mongoose.connection.readyState === 1) migrateLegacyIndexes();
    else mongoose.connection.once('open', migrateLegacyIndexes);

    // Every 10 minutes: expire temporary seat reservations
    cron.schedule('*/10 * * * *', () => {
        const now = new Date();
        const bucket = Math.floor(now.getTime() / (10 * MIN));
        return withLock(`seat-reservations:${bucket}`, 9 * MIN, async () => {
            const n = await seatService.expireReservations();
            if (n) console.log(`[cron] expired ${n} seat reservation(s)`);
        });
    }, TZ);

    // Hourly (at :05): expire memberships, free seats, close history, auto-resume long pauses
    cron.schedule('5 * * * *', () => {
        const hour = slot().slice(0, 13);
        return withLock(`membership-expiry:${hour}`, 50 * MIN, async () => {
            const expired = await expireMemberships();
            const resumed = await autoResumePaused();
            if (expired || resumed) console.log(`[cron] expired ${expired} membership(s), auto-resumed ${resumed}`);
        });
    }, TZ);

    // Every 30 minutes: no-show seat release (per-library opt-in)
    cron.schedule('*/30 * * * *', () => {
        const bucket = Math.floor(Date.now() / (30 * MIN));
        return withLock(`seat-no-show:${bucket}`, 25 * MIN, async () => {
            const n = await releaseNoShowSeats();
            if (n) console.log(`[cron] released ${n} no-show seat(s)`);
        });
    }, TZ);

    // Daily at 10:00 IST: plan expiry + attendance alerts
    cron.schedule('0 10 * * *', () => {
        const day = slot().slice(0, 10);
        return withLock(`daily-alerts:${day}`, 23 * 60 * MIN, async () => {
            console.log('Running daily cron job: Plan Expiry & Attendance Alerts');
            await sendDailyAlerts();
        });
    }, TZ);

    // Attendance: close forgotten sessions every 30 min, mark absentees near day end (IST)
    cron.schedule('*/30 * * * *', () => {
        const bucket = Math.floor(Date.now() / (30 * MIN));
        return withLock(`attendance-autoclose:${bucket}`, 25 * MIN, async () => {
            const n = await require('./attendance.service').autoCloseStaleSessions();
            if (n) console.log(`[cron] auto-closed stale attendance sessions: ${n.closed ?? n}`);
        });
    }, TZ);
    cron.schedule('30 23 * * *', () => {
        const day = slot().slice(0, 10);
        return withLock(`attendance-absentees:${day}`, 23 * 60 * MIN, async () => {
            await require('./attendance.service').markAbsentees({ date: new Date() });
        });
    }, TZ);

    // Content: publish scheduled stories/notices every 5 min, archive expired stories hourly
    cron.schedule('*/5 * * * *', () => {
        const bucket = Math.floor(Date.now() / (5 * MIN));
        return withLock(`content-publish:${bucket}`, 4 * MIN, async () => {
            await require('./story.service').publishDueStories();
            await require('./notice.service').publishDueNotices();
        });
    }, TZ);
    cron.schedule('15 * * * *', () => {
        const hour = slot().slice(0, 13);
        return withLock(`story-archive:${hour}`, 50 * MIN, async () => {
            await require('./story.service').archiveExpiredStories();
        });
    }, TZ);


    // SaaS subscription lifecycle (trial/grace/suspend, scheduled downgrades, renewal reminders), 02:00 IST
    try {
        require('./subscriptionCron.service').initSubscriptionCronJobs();
    } catch (e) {
        console.error('[cron] failed to start subscription cron:', e.message);
    }

    // Fee-overdue / reminder jobs
    try {
        const fee = require('./feeCron.service');
        const init = fee.initFeeCronJobs || fee.initCronJobs || fee.init;
        if (typeof init === 'function') init();
    } catch (e) {
        if (!(e && e.code === 'MODULE_NOT_FOUND' && /feeCron/.test(e.message))) {
            console.error('[cron] failed to start fee cron jobs:', e.message);
        }
    }
};

module.exports = { initCronJobs, expireMemberships, autoResumePaused, sendDailyAlerts, releaseNoShowSeats, migrateLegacyIndexes };
