const crypto = require('crypto');
const Library = require('../models/library.model');
const Admin = require('../models/admin.model');
const PlatformPlan = require('../models/platformPlan.model');
const Notification = require('../models/notification.model');
const { generateUniqueSlug } = require('../utils/slug');
const { DEFAULT_TRIAL_DAYS, DAY } = require('./subscriptionState.service');

// Assigns a unique slug if the library has none. Safe against concurrent approvals (E11000 retry).
exports.ensureSlug = async (library) => {
  if (library.slug) return library;
  for (let attempt = 0; attempt < 6; attempt++) {
    let slug = await generateUniqueSlug(library.name, { excludeId: library._id });
    if (attempt > 2) slug = `${slug}-${crypto.randomBytes(2).toString('hex')}`;
    try {
      const updated = await Library.findOneAndUpdate(
        { _id: library._id, $or: [{ slug: null }, { slug: { $exists: false } }] },
        { $set: { slug } },
        { new: true }
      );
      if (updated) return updated;
      return (await Library.findById(library._id)) || library; // someone else provisioned it
    } catch (e) {
      if (e.code !== 11000) throw e;
    }
  }
  throw Object.assign(new Error('Could not provision a unique slug, please retry'), { status: 500 });
};

/**
 * Provisioning when a library becomes active: slug/subdomain, trial window, in-app notification for the owner.
 * No external delivery happens here. Returns onboarding data for the caller to relay.
 */
exports.provisionLibrary = async (library, { approvedBy = null } = {}) => {
  let lib = await exports.ensureSlug(library);

  const plan = lib.subscriptionPlanId ? await PlatformPlan.findById(lib.subscriptionPlanId) : null;
  const trialDays = plan?.trialDays ?? DEFAULT_TRIAL_DAYS;
  const set = {};
  if (!lib.trialEndsAt && !lib.subscriptionExpiry && trialDays > 0) {
    set.trialEndsAt = new Date(Date.now() + trialDays * DAY);
    set.subscriptionIsTrial = true;
  }
  if (!lib.approvedAt) { set.approvedAt = new Date(); if (approvedBy) set.approvedBy = approvedBy; }
  if (Object.keys(set).length) lib = (await Library.findByIdAndUpdate(lib._id, { $set: set }, { new: true })) || lib;

  const owner = await Admin.findOne({ libraryId: lib._id, userType: 'admin' }).select('name email');
  const onboarding = {
    libraryId: lib._id,
    slug: lib.slug,
    subdomain: lib.subdomain,
    websiteUrl: lib.websiteUrl,
    ownerEmail: owner?.email || lib.email || null,
    trialEndsAt: lib.trialEndsAt,
    nextSteps: [
      'Log in with the e-mail and password used at registration',
      'Complete the library profile, working hours and facilities',
      'Create seats and membership plans',
      'Configure fee policy, attendance rules and receipt numbering',
      'Add staff and publish your library website',
    ],
  };

  if (owner) {
    try {
      // approval event (inbox + push + email) with the onboarding hints attached
      await require('./notification.service').notifyLibraryStatus(lib, 'approved',
        `Your website: ${lib.websiteUrl || lib.slug}. Complete your profile, seats and plans to get started.`,
        { ownerId: owner._id, data: { onboarding } });
    } catch (_) { /* notification failure must not block approval */ }
  }
  return { library: lib, onboarding };
};
