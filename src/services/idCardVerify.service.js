const crypto = require('crypto');
const mongoose = require('mongoose');
const config = require('../config/config');
const Student = require('../models/student.model');
const Library = require('../models/library.model');

/**
 * Student ID card verification.
 *
 * The QR on a printed card holds a link /verify/<code>. The code is the student id plus a signature, so it cannot be
 * guessed or edited (changing one character makes it invalid). Anyone who scans it sees the LIVE status from the
 * server: a card printed months ago still shows "Expired" once the plan has ended. Nothing private is returned.
 *
 * The signing key comes from ID_CARD_SECRET, else is derived from the JWT secret. Changing either one makes every
 * printed card show "not valid", so set ID_CARD_SECRET once in production and keep it.
 */
const secret = () => process.env.ID_CARD_SECRET || crypto.createHmac('sha256', config.jwt.secret).update('id-card-verify').digest('hex');
const SIG_BYTES = 12;

const sign = (idHex) => crypto.createHmac('sha256', secret()).update(idHex).digest().subarray(0, SIG_BYTES);

/** 24-hex student id -> 32-char url-safe code */
const makeCode = (studentId) => {
    const idHex = String(studentId).toLowerCase();
    return Buffer.concat([Buffer.from(idHex, 'hex'), sign(idHex)]).toString('base64url');
};

/** code -> student id hex, or null when it was not issued by this server */
const readCode = (code) => {
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{30,40}$/.test(code)) return null;
    const buf = Buffer.from(code, 'base64url');
    if (buf.length !== 12 + SIG_BYTES) return null;
    const idHex = buf.subarray(0, 12).toString('hex');
    const given = buf.subarray(12);
    const expected = sign(idHex);
    return crypto.timingSafeEqual(given, expected) ? idHex : null;
};

/** Staff: the code for one of their own library's students. */
exports.codeFor = async (libraryId, studentId) => {
    if (!mongoose.isValidObjectId(studentId)) return null;
    const s = await Student.findOne({ _id: studentId, libraryId, isDeleted: { $ne: true }, erasedAt: null }).select('_id').lean();
    return s ? makeCode(s._id) : null;
};

/** Public: what a scanner sees. Only what is already printed on the card, plus the live status. */
exports.verify = async (code) => {
    const id = readCode(code);
    if (!id) return { valid: false, reason: 'not_issued' };
    const s = await Student.findOne({ _id: id, isDeleted: { $ne: true }, erasedAt: null })
        .select('name profileImage registrationNumber rollNumber status expiryDate libraryId').lean();
    if (!s) return { valid: false, reason: 'not_found' };
    const lib = await Library.findById(s.libraryId).select('name logo city isDeleted').lean();
    if (!lib || lib.isDeleted) return { valid: false, reason: 'not_found' };

    const expired = !!s.expiryDate && new Date(s.expiryDate).getTime() < Date.now();
    const state = expired ? 'expired' : s.status === 'active' ? 'active' : 'inactive';
    return {
        valid: true,
        state,
        checkedAt: new Date().toISOString(),
        student: { name: s.name, photo: s.profileImage || null, idNo: s.registrationNumber || s.rollNumber || null },
        validTill: s.expiryDate || null,
        library: { name: lib.name, logo: lib.logo || null, city: lib.city || null },
    };
};

exports._test = { makeCode, readCode };
