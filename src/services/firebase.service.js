const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

// Path to the service account key
const serviceAccountPath = path.join(process.cwd(), 'firebase-adminsdk.json');

// Initialize Firebase Admin only if it hasn't been initialized
if (!admin.apps.length) {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        try {
            const serviceAccount = typeof process.env.FIREBASE_SERVICE_ACCOUNT === 'string'
                ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
                : process.env.FIREBASE_SERVICE_ACCOUNT;
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            console.log('Firebase Admin initialized successfully from environment variable.');
        } catch (error) {
            console.error('Failed to initialize Firebase Admin from FIREBASE_SERVICE_ACCOUNT env var:', error.message);
        }
    } else if (fs.existsSync(serviceAccountPath)) {
        try {
            const serviceAccount = require(serviceAccountPath);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            console.log('Firebase Admin initialized successfully from file.');
        } catch (error) {
            console.error('Failed to initialize Firebase Admin from file:', error.message);
        }
    } else {
        console.warn(`Firebase service account file not found at ${serviceAccountPath} and FIREBASE_SERVICE_ACCOUNT environment variable is not set. Push notifications will not work.`);
    }
}

const FCM_BATCH = 500; // sendEachForMulticast limit
const INVALID_TOKEN_CODES = new Set([
    'messaging/registration-token-not-registered',
    'messaging/invalid-registration-token',
    'messaging/invalid-argument'
]);

const isConfigured = () => admin.apps.length > 0;

// FCM data payload values must all be strings
const stringifyData = (data = {}) =>
    Object.fromEntries(
        Object.entries(data || {})
            .filter(([, v]) => v !== undefined && v !== null)
            .map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])
    );

const baseMessage = (title, body, data) => ({
    notification: { title, body },
    data: stringifyData(data),
    android: { priority: 'high', notification: { sound: 'default', channelId: 'dddesk_alerts' } },
    apns: { payload: { aps: { sound: 'default' } } }
});

// Remove tokens FCM reported as dead from every user that holds them
const pruneInvalidTokens = async (tokens) => {
    if (!tokens.length) return;
    try {
        const Admin = require('../models/admin.model');
        const Student = require('../models/student.model');
        await Promise.all([
            Admin.updateMany({ fcmTokens: { $in: tokens } }, { $pull: { fcmTokens: { $in: tokens } } }),
            Student.updateMany({ fcmTokens: { $in: tokens } }, { $pull: { fcmTokens: { $in: tokens } } })
        ]);
    } catch (e) {
        console.error('Failed to prune FCM tokens:', e.message);
    }
};

/**
 * Send a push notification to one token or many (batched by 500).
 * Returns { configured, successCount, failureCount, results: [{token, success, error}], invalidTokens }.
 * Dead tokens are pruned from the database automatically.
 */
const sendToTokens = async (tokens, title, body, data = {}) => {
    const list = [...new Set((Array.isArray(tokens) ? tokens : [tokens]).filter(Boolean))];
    const out = { configured: isConfigured(), successCount: 0, failureCount: 0, results: [], invalidTokens: [] };
    if (!out.configured || list.length === 0) return out;

    const message = baseMessage(title, body, data);
    for (let i = 0; i < list.length; i += FCM_BATCH) {
        const batch = list.slice(i, i + FCM_BATCH);
        try {
            const response = await admin.messaging().sendEachForMulticast({ ...message, tokens: batch });
            response.responses.forEach((r, idx) => {
                const token = batch[idx];
                const code = r.error && r.error.code;
                out.results.push({ token, success: r.success, error: code || null });
                if (r.success) out.successCount += 1;
                else {
                    out.failureCount += 1;
                    if (INVALID_TOKEN_CODES.has(code)) out.invalidTokens.push(token);
                }
            });
        } catch (error) {
            console.error('Error sending multicast batch:', error.message);
            batch.forEach((token) => out.results.push({ token, success: false, error: error.code || 'send-failed' }));
            out.failureCount += batch.length;
        }
    }
    await pruneInvalidTokens(out.invalidTokens);
    return out;
};

/**
 * Send a notification to a specific topic
 */
const sendToTopic = async (topic, title, body, data = {}) => {
    if (!isConfigured()) return false;
    try {
        return await admin.messaging().send({ ...baseMessage(title, body, data), topic });
    } catch (error) {
        console.error('Error sending message to topic:', error.message);
        return false;
    }
};

const toId = (v) => (v && typeof v === 'object' && v._id ? v._id : v);

const notifyLibraryAdmins = async (libraryId, title, body, data = {}, type = 'system_alert') => {
    try {
        const Admin = require('../models/admin.model');
        const Notification = require('../models/notification.model');
        const libId = toId(libraryId);
        if (!libId) return;

        const admins = await Admin.find({ libraryId: libId, isDeleted: false, status: true });
        const tokens = admins.flatMap((a) => a.fcmTokens || []);

        if (admins.length > 0) {
            await Notification.insertMany(admins.map((a) => ({
                recipientId: a._id, recipientType: 'Admin', libraryId: libId,
                type, title, message: body, data: data || {}
            })));
        }
        if (tokens.length > 0) await sendToTokens(tokens, title, body, data);
    } catch (error) {
        console.error('Error notifying library admins:', error.message);
    }
};

const notifyStudent = async (studentId, title, body, data = {}, type = 'system_alert') => {
    try {
        const Student = require('../models/student.model');
        const Notification = require('../models/notification.model');

        const student = await Student.findById(studentId);
        if (!student || student.isDeleted) return;

        await Notification.create({
            recipientId: student._id, recipientType: 'Student', libraryId: toId(student.libraryId),
            type, title, message: body, data: data || {}
        });
        if (student.fcmTokens && student.fcmTokens.length > 0) {
            await sendToTokens(student.fcmTokens, title, body, data);
        }
    } catch (error) {
        console.error('Error notifying student:', error.message);
    }
};

/**
 * Notify many students. Pass libraryId (6th argument) to guarantee tenant isolation:
 * ids that belong to another library are ignored.
 */
const notifyMultipleStudents = async (studentIds, title, body, data = {}, type = 'system_alert', libraryId = null) => {
    try {
        const Student = require('../models/student.model');
        const Notification = require('../models/notification.model');

        const filter = { _id: { $in: studentIds }, isDeleted: false };
        const libId = toId(libraryId);
        if (libId) filter.libraryId = libId;
        const students = await Student.find(filter);

        const tokens = students.flatMap((s) => s.fcmTokens || []);
        if (students.length > 0) {
            await Notification.insertMany(students.map((s) => ({
                recipientId: s._id, recipientType: 'Student', libraryId: toId(s.libraryId),
                type, title, message: body, data: data || {}
            })));
        }
        if (tokens.length > 0) await sendToTokens(tokens, title, body, data);
    } catch (error) {
        console.error('Error notifying multiple students:', error.message);
    }
};

module.exports = {
    sendToTokens,
    sendToTopic,
    notifyLibraryAdmins,
    notifyStudent,
    notifyMultipleStudents,
    isConfigured,
    stringifyData
};
