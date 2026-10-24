// DPDP Act 2023 helpers: consent record, minors, retention defaults.
// Bump PRIVACY_POLICY_VERSION whenever the privacy notice shown at admission changes.
const PRIVACY_POLICY_VERSION = '1.0';
const CONSENT_PURPOSE = 'Library membership administration, attendance, fee collection and service notifications';
const DEFAULT_RETENTION_DAYS = Number(process.env.STUDENT_RETENTION_DAYS) > 0 ? Number(process.env.STUDENT_RETENTION_DAYS) : 365;

const ageOn = (dob, now = new Date()) => {
    const d = new Date(dob);
    if (!dob || isNaN(d.getTime())) return null;
    let age = now.getUTCFullYear() - d.getUTCFullYear();
    const m = now.getUTCMonth() - d.getUTCMonth();
    if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age--;
    return age;
};

const isMinor = (dob, now) => {
    const a = ageOn(dob, now);
    return a !== null && a < 18;
};

// multipart bodies deliver booleans as 'true' / 'false' strings
const toBool = (v) => v === true || v === 'true' || v === 'on' || v === '1' || v === 1;

/** Problems with the guardian block for a minor; [] when fine. `g` = { name, mobile, consentGiven }. */
const minorGuardianIssues = (g) => {
    const out = [];
    if (!g.name || !String(g.name).trim()) out.push({ path: 'guardianName', message: 'Guardian name is required for a student under 18' });
    if (!g.mobile || !/^[6-9]\d{9}$/.test(String(g.mobile))) out.push({ path: 'guardianMobile', message: 'A valid guardian mobile is required for a student under 18' });
    if (!g.consentGiven) out.push({ path: 'guardianConsentGiven', message: "Guardian's consent is required for a student under 18" });
    return out;
};

module.exports = { PRIVACY_POLICY_VERSION, CONSENT_PURPOSE, DEFAULT_RETENTION_DAYS, ageOn, isMinor, toBool, minorGuardianIssues };
