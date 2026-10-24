const crypto = require('crypto');

// Verhoeff checksum (the scheme UIDAI uses for the 12th digit of an Aadhaar number)
const D = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
    [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
    [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]
];
const P = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
    [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]
];
const INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

/** True when the digit string (check digit included) passes the Verhoeff checksum. */
const verhoeffValid = (digits) => {
    if (!/^\d+$/.test(digits)) return false;
    let c = 0;
    const rev = digits.split('').reverse();
    for (let i = 0; i < rev.length; i++) c = D[c][P[i % 8][+rev[i]]];
    return c === 0;
};

/** Check digit to append to a digit string so the whole string passes verhoeffValid. */
const verhoeffCheckDigit = (digits) => {
    let c = 0;
    const rev = digits.split('').reverse();
    for (let i = 0; i < rev.length; i++) c = D[c][P[(i + 1) % 8][+rev[i]]];
    return INV[c];
};

/** 12 digits, first digit 2-9, valid Verhoeff checksum. Spaces and dashes are ignored. */
const isValidAadhaar = (value) => {
    const n = String(value ?? '').replace(/[\s-]/g, '');
    return /^[2-9]\d{11}$/.test(n) && verhoeffValid(n);
};

const secret = () => process.env.AADHAAR_HASH_SECRET || process.env.JWT_SECRET || '';

/** Keyed hash used only to spot the same Aadhaar entered twice in a library; it cannot be reversed to the number. */
const hashAadhaar = (value, libraryId) => {
    const key = secret();
    if (!key) throw new Error('AADHAAR_HASH_SECRET (or JWT_SECRET) is not configured');
    const n = String(value).replace(/[\s-]/g, '');
    return crypto.createHmac('sha256', key).update(`${libraryId || ''}:${n}`).digest('hex');
};

const maskAadhaar = (last4) => (last4 ? `XXXX XXXX ${last4}` : '');

/**
 * Turn a typed Aadhaar number into what we are allowed to keep: last 4 digits + keyed hash.
 * The full number is never returned. Throws a plain Error with a user-safe message when invalid.
 */
const deriveAadhaar = (value, libraryId) => {
    const n = String(value ?? '').replace(/[\s-]/g, '');
    if (!isValidAadhaar(n)) throw new Error('Aadhaar number is not valid (12 digits, starting 2-9, with a correct check digit)');
    return { aadhaarLast4: n.slice(-4), aadhaarHash: hashAadhaar(n, libraryId) };
};

module.exports = { verhoeffValid, verhoeffCheckDigit, isValidAadhaar, hashAadhaar, maskAadhaar, deriveAadhaar };
