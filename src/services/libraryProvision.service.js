const Library = require('../models/library.model');
const Admin = require('../models/admin.model');
const PlatformPlan = require('../models/platformPlan.model');
const Notification = require('../models/notification.model');
const { DEFAULT_TRIAL_DAYS, DAY } = require('./subscriptionState.service');

/**
 * Provisioning when a library becomes active: trial window, approval notice to the owner (inbox, push, email, SMS).
 * The notice is best effort and not awaited, so a failing or slow provider never holds up or fails the approval.
 * Returns onboarding data for the caller to relay.
 */
exports.provisionLibrary = async (library, { approvedBy = null } = {}) => {
  let lib = library;

  const plan = lib.subscriptionPlanId ? await PlatformPlan.findById(lib.subscriptionPlanId) : null;
  await require('./platformSettings.service').ensureFresh();
  const trialDays = plan?.trialDays ?? require('./platformSettings.service').defaultTrialDays() ?? DEFAULT_TRIAL_DAYS;
  const set = {};
  if (!lib.trialEndsAt && !lib.subscriptionExpiry && trialDays > 0) {
    set.trialEndsAt = new Date(Date.now() + trialDays * DAY);
    set.subscriptionIsTrial = true;
  }
  if (!lib.approvedAt) { set.approvedAt = new Date(); if (approvedBy) set.approvedBy = approvedBy; }
  if (Object.keys(set).length) lib = (await Library.findByIdAndUpdate(lib._id, { $set: set }, { new: true })) || lib;

  const owner = await Admin.findOne({ libraryId: lib._id, userType: 'admin' }).select('name email emailIsPlaceholder');
  const onboarding = {
    libraryId: lib._id,
    ownerEmail: (owner?.emailIsPlaceholder ? null : owner?.email) || lib.email || null,
    trialEndsAt: lib.trialEndsAt,
    nextSteps: [
      owner?.emailIsPlaceholder ? 'Log in with the mobile number and password used at registration' : 'Log in with the e-mail and password used at registration',
      'Complete the library profile, working hours and facilities',
      'Create seats and membership plans',
      'Configure fee policy, attendance rules and receipt numbering',
      'Add staff and invite your students',
    ],
  };

  if (owner) {
    try {
      // approval event with the onboarding hints attached
      require('./notification.service').notifyLibraryStatus(lib, 'approved', '', { ownerId: owner._id, data: { onboarding } }).catch(() => {});
    } catch (_) { /* notification failure must not block approval */ }
  }
  return { library: lib, onboarding };
};
