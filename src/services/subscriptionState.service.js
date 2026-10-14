// Subscription lifecycle for a library: trial -> active -> grace -> expired
const DAY = 24 * 60 * 60 * 1000;
const DEFAULT_TRIAL_DAYS = 14;
const DEFAULT_GRACE_DAYS = 7;

/**
 * @param lib   Library doc/object (subscriptionExpiry, trialEndsAt, subscriptionIsTrial, subscriptionPlanId)
 * @param plan  PlatformPlan doc/object (optional; supplies graceDays). Falls back to lib.subscriptionPlanId when populated.
 * @returns {{state:'trial'|'active'|'grace'|'expired', isExpired:boolean, expiresAt:Date|null, graceEndsAt:Date|null,
 *            daysLeft:number|null, graceDaysLeft:number|null, canWrite:boolean}}
 */
exports.getSubscriptionState = (lib, plan = null, now = new Date()) => {
  const p = plan || (lib.subscriptionPlanId && lib.subscriptionPlanId.graceDays !== undefined ? lib.subscriptionPlanId : null);
  const graceDays = p?.graceDays ?? DEFAULT_GRACE_DAYS;
  const expiresAt = lib.subscriptionExpiry || lib.trialEndsAt || null;
  const isTrial = !lib.subscriptionExpiry && !!lib.trialEndsAt ? true : !!lib.subscriptionIsTrial;

  if (!expiresAt) {
    // Legacy / free tenants with no dates configured stay active
    return { state: 'active', isExpired: false, expiresAt: null, graceEndsAt: null, daysLeft: null, graceDaysLeft: null, canWrite: true };
  }
  const exp = new Date(expiresAt);
  const graceEndsAt = new Date(exp.getTime() + graceDays * DAY);
  const t = now.getTime();
  if (t <= exp.getTime()) {
    return {
      state: isTrial ? 'trial' : 'active', isExpired: false, expiresAt: exp, graceEndsAt,
      daysLeft: Math.ceil((exp.getTime() - t) / DAY), graceDaysLeft: null, canWrite: true,
    };
  }
  if (t <= graceEndsAt.getTime()) {
    return {
      state: 'grace', isExpired: false, expiresAt: exp, graceEndsAt,
      daysLeft: 0, graceDaysLeft: Math.ceil((graceEndsAt.getTime() - t) / DAY), canWrite: true,
    };
  }
  return { state: 'expired', isExpired: true, expiresAt: exp, graceEndsAt, daysLeft: 0, graceDaysLeft: 0, canWrite: false };
};

exports.DEFAULT_TRIAL_DAYS = DEFAULT_TRIAL_DAYS;
exports.DEFAULT_GRACE_DAYS = DEFAULT_GRACE_DAYS;
exports.DAY = DAY;
