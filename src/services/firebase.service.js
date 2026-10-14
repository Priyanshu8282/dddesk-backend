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
            console.error('Failed to initialize Firebase Admin from FIREBASE_SERVICE_ACCOUNT env var:', error);
        }
    } else if (fs.existsSync(serviceAccountPath)) {
        try {
            const serviceAccount = require(serviceAccountPath);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            console.log('Firebase Admin initialized successfully from file.');
        } catch (error) {
            console.error('Failed to initialize Firebase Admin from file:', error);
        }
    } else {
        console.warn(`Firebase service account file not found at ${serviceAccountPath} and FIREBASE_SERVICE_ACCOUNT environment variable is not set. Push notifications will not work.`);
    }
}

/**
 * Send a notification to a specific token or array of tokens
 * @param {string|string[]} tokens - FCM token(s)
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {object} data - Optional data payload
 */
const sendToTokens = async (tokens, title, body, data = {}) => {
    if (!admin.apps.length) return false;
    
    try {
        const message = {
            notification: { title, body },
            data: data,
            android: {
                priority: 'high',
                notification: {
                    sound: 'default',
                    channelId: 'dddesk_alerts',
                }
            },
            apns: {
                payload: {
                    aps: {
                        sound: 'default',
                    }
                }
            }
        };

        if (Array.isArray(tokens)) {
            if (tokens.length === 0) return false;
            const response = await admin.messaging().sendMulticast({ ...message, tokens });
            console.log('Successfully sent multicast message:', response.successCount, 'successes');
            return response;
        } else {
            if (!tokens) return false;
            const response = await admin.messaging().send({ ...message, token: tokens });
            console.log('Successfully sent message:', response);
            return response;
        }
    } catch (error) {
        console.error('Error sending message to tokens:', error);
        return false;
    }
};

/**
 * Send a notification to a specific topic
 * @param {string} topic - The topic name (e.g., 'admin_library_12345')
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {object} data - Optional data payload
 */
const sendToTopic = async (topic, title, body, data = {}) => {
    if (!admin.apps.length) return false;

    try {
        const message = {
            notification: { title, body },
            data: data,
            topic: topic,
            android: {
                priority: 'high',
                notification: {
                    sound: 'default',
                    channelId: 'dddesk_alerts',
                }
            },
            apns: {
                payload: {
                    aps: {
                        sound: 'default',
                    }
                }
            }
        };

        const response = await admin.messaging().send(message);
        return response;
    } catch (error) {
        console.error('Error sending message to topic:', error);
        return false;
    }
};

const notifyLibraryAdmins = async (libraryId, title, body, data = {}, type = 'system_alert') => {
    try {
        console.log(`[FIREBASE DEBUG] notifyLibraryAdmins called. libraryId:`, libraryId, `title: ${title}`);
        const Admin = require('../models/admin.model');
        const Notification = require('../models/notification.model');
        
        // If libraryId is a populated object, extract the _id
        const libIdStr = (libraryId && typeof libraryId === 'object' && libraryId._id) ? libraryId._id.toString() : libraryId;
        console.log(`[FIREBASE DEBUG] Extracted libIdStr:`, libIdStr);

        const admins = await Admin.find({ libraryId: libIdStr, isDeleted: false });
        console.log(`[FIREBASE DEBUG] Found ${admins.length} admins for library ${libIdStr}`);

        let allTokens = [];
        let dbNotifications = [];

        for (const adminUser of admins) {
            // Collect tokens
            if (adminUser.fcmTokens && adminUser.fcmTokens.length > 0) {
                allTokens.push(...adminUser.fcmTokens);
            }

            // Prepare DB Notification
            dbNotifications.push({
                recipientId: adminUser._id,
                recipientType: 'Admin',
                type: type,
                title: title,
                message: body,
            });
        }

        console.log(`[FIREBASE DEBUG] Preparing to insert ${dbNotifications.length} DB notifications.`);
        // Insert into DB
        if (dbNotifications.length > 0) {
            await Notification.insertMany(dbNotifications);
            console.log(`[FIREBASE DEBUG] Successfully inserted ${dbNotifications.length} DB notifications.`);
        }

        // Send Push Notifications
        if (allTokens.length > 0) {
            await sendToTokens(allTokens, title, body, data);
        } else {
            console.log(`No FCM tokens found for admins of library ${libraryId}`);
        }
    } catch (error) {
        console.error('Error notifying library admins:', error);
    }
};

const notifyStudent = async (studentId, title, body, data = {}, type = 'system_alert') => {
    try {
        const Student = require('../models/student.model');
        const Notification = require('../models/notification.model');
        
        const student = await Student.findById(studentId);
        if (!student || student.isDeleted) return;

        await Notification.create({
            recipientId: student._id,
            recipientType: 'Student',
            type: type,
            title: title,
            message: body,
        });

        if (student.fcmTokens && student.fcmTokens.length > 0) {
            await sendToTokens(student.fcmTokens, title, body, data);
        }
    } catch (error) {
        console.error('Error notifying student:', error);
    }
};

const notifyMultipleStudents = async (studentIds, title, body, data = {}, type = 'system_alert') => {
    try {
        const Student = require('../models/student.model');
        const Notification = require('../models/notification.model');
        
        const students = await Student.find({ _id: { $in: studentIds }, isDeleted: false });
        
        let allTokens = [];
        let dbNotifications = [];

        for (const student of students) {
            if (student.fcmTokens && student.fcmTokens.length > 0) {
                allTokens.push(...student.fcmTokens);
            }
            dbNotifications.push({
                recipientId: student._id,
                recipientType: 'Student',
                type: type,
                title: title,
                message: body,
            });
        }

        if (dbNotifications.length > 0) {
            await Notification.insertMany(dbNotifications);
        }
        if (allTokens.length > 0) {
            await sendToTokens(allTokens, title, body, data);
        }
    } catch (error) {
        console.error('Error notifying multiple students:', error);
    }
};

module.exports = {
    sendToTokens,
    sendToTopic,
    notifyLibraryAdmins,
    notifyStudent,
    notifyMultipleStudents
};
