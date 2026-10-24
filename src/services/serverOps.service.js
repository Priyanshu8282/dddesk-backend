/**
 * Safe server operations for the super admin (Platform Settings > Maintenance):
 *   - one status call (health + scheduled-job locks + payments that need a human look)
 *   - clear the in-memory caches of THIS server instance
 *   - run one named scheduled job by hand
 * Deliberately NOT here: shell commands, restarting or killing the process, editing files. Restarts and
 * deployments are done in the hosting dashboard (Vercel, a process manager, ...), outside this application.
 */
const mongoose = require('mongoose');
const CronLock = require('../models/cronLock.model');
const PaymentTransaction = require('../models/paymentTransaction.model');
const PlatformPayment = require('../models/platformPayment.model');
const settings = require('./platformSettings.service');
const system = require('./platformSystem.service');
const providerConfig = require('./notificationProviderConfig.service');
const maintenance = require('./maintenance.service');

const err = (message, status = 400) => Object.assign(new Error(message), { status });

// job key -> what it does (every one of these is idempotent; the scheduler runs them the same way)
const JOBS = {
  'subscription-lifecycle': {
    label: 'Subscription lifecycle',
    description: 'Applies scheduled plan changes, suspends lapsed libraries, sends renewal reminders and repairs half-applied payments.',
    run: () => require('./subscriptionCron.service').runSubscriptionLifecycle(),
  },
  'membership-expiry': {
    label: 'Membership expiry',
    description: 'Expires ended memberships and frees their seats, resumes long pauses, returns students from leave.',
    run: async () => {
      const core = require('./cron.service');
      return { expired: await core.expireMemberships(), resumed: await core.autoResumePaused(), returnedFromLeave: await core.autoReturnFromLeave() };
    },
  },
  'fee-jobs': {
    label: 'Fee overdue and reminders',
    description: 'Marks overdue charges and sends fee reminders to students.',
    run: () => require('./feeCron.service').runFeeJobs(),
  },
  'seat-reservations': {
    label: 'Seat reservations',
    description: 'Releases temporary seat reservations that have expired.',
    run: async () => ({ released: await require('./seat.service').expireReservations() }),
  },
};
exports.JOB_KEYS = Object.keys(JOBS);

exports.status = async () => {
  const now = new Date();
  const [health, locks, txnReview, platformReview, platformApplyPending, maint] = await Promise.all([
    system.health(),
    CronLock.find().sort({ lockedUntil: -1 }).limit(60).lean().catch(() => []),
    PaymentTransaction.countDocuments({ needsReview: true }).catch(() => null),
    PlatformPayment.countDocuments({ needsReview: true }).catch(() => null),
    PlatformPayment.countDocuments({ applyPending: true }).catch(() => null),
    maintenance.view(1).catch(() => null),
  ]);
  // lock keys look like "membership-expiry:2026-10-24T14": the first part is the job, the rest the time slot it ran for
  const byJob = new Map();
  for (const l of locks) {
    const i = String(l._id).indexOf(':');
    const job = i > 0 ? String(l._id).slice(0, i) : String(l._id);
    const slot = i > 0 ? String(l._id).slice(i + 1) : null;
    if (!byJob.has(job)) byJob.set(job, { job, lastSlot: slot, lockedUntil: l.lockedUntil, running: new Date(l.lockedUntil) > now, owner: l.owner || null });
  }
  return {
    health,
    maintenance: maint ? { phase: maint.phase, forcedOff: maint.forcedOff, mode: maint.config.mode, scope: maint.config.scope, pauseCrons: maint.config.pauseCrons } : null,
    jobs: {
      recent: [...byJob.values()].sort((a, b) => new Date(b.lockedUntil) - new Date(a.lockedUntil)),
      runnable: Object.entries(JOBS).map(([key, j]) => ({ key, label: j.label, description: j.description })),
    },
    attention: {
      studentPaymentsNeedingReview: txnReview,
      subscriptionPaymentsNeedingReview: platformReview,
      subscriptionPaymentsNotYetApplied: platformApplyPending,
    },
    process: { pid: process.pid, node: process.version, instance: process.env.VERCEL_REGION || process.env.HOSTNAME || null },
    drain: 'To drain a server before a restart or deploy: start a maintenance window in read-only mode, wait until in-flight work is done, then deploy or restart from your hosting dashboard. Restarts are not done from this panel.',
  };
};

/** Clears caches held in THIS server process. Other instances refresh by themselves within seconds. */
exports.clearCaches = () => {
  settings.invalidate();
  try { providerConfig.invalidate(); } catch (_) { /* optional */ }
  const auth = require('../middlewares/auth.middleware');
  const cleared = ['platform settings', 'notification provider settings'];
  if (typeof auth.clearAuthCache === 'function') { auth.clearAuthCache(); cleared.push('sign-in contexts'); }
  return { cleared, note: 'Only this server instance was cleared. On serverless hosting other instances refresh within a few seconds.' };
};

exports.runJob = async (key) => {
  const job = JOBS[key];
  if (!job) throw err('Unknown job');
  if (mongoose.connection.readyState !== 1) throw err('The database is not connected', 503);
  const lockKey = `manual:${key}`;
  const got = await CronLock.acquire(lockKey, 15 * 60 * 1000);
  if (!got) throw err('This job is already being run by hand. Wait for it to finish.', 409);
  const started = Date.now();
  try {
    const result = await job.run();
    return { job: key, label: job.label, ok: true, durationMs: Date.now() - started, result: result === undefined ? null : result };
  } finally {
    await CronLock.release(lockKey).catch(() => {});
  }
};
