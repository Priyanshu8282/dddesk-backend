const mongoose = require('mongoose');
const audit = require('./audit');

// Actor id used for audit rows written by cron jobs / webhooks (no logged-in user)
const SYSTEM_ACTOR_ID = new mongoose.Types.ObjectId('000000000000000000000002');

/** systemAudit(libraryId, 'subscription.suspended', 'Library', libraryId, { ... }) */
module.exports = (libraryId, action, resource, resourceId = null, metadata = {}) =>
    audit({ libraryId: libraryId || null, user: { _id: SYSTEM_ACTOR_ID }, userType: 'system', ip: 'system', headers: {} },
        action, resource, resourceId, { ...metadata, system: true });

module.exports.SYSTEM_ACTOR_ID = SYSTEM_ACTOR_ID;
