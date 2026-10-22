const mongoose = require('mongoose');

// Single document holding the VAPID key pair used to sign web push messages.
// Generated automatically the first time it is needed (or set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in .env to use your own).
const webPushConfigSchema = new mongoose.Schema({
    key: { type: String, default: 'default', unique: true },
    publicKey: { type: String, required: true },
    privateKey: { type: String, required: true, select: false }
}, { timestamps: true });

module.exports = mongoose.model('WebPushConfig', webPushConfigSchema);
