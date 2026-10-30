// Native apps identify themselves with "X-Client-Platform: mobile" (the older "X-Client-Type: mobile" is still understood).
// The header is NOT a credential: it only selects the mobile variants of sign-in (proof-of-work human check, long-lived
// revocable access token). Everything else (permissions, rate limits, lockouts) applies to mobile requests unchanged.
const isMobileClient = (req) => {
    const h = (req && req.headers) || {};
    const v = String(h['x-client-platform'] || h['x-client-type'] || '').trim().toLowerCase();
    return v === 'mobile';
};

const appVersion = (req) => String(((req && req.headers) || {})['x-app-version'] || '').replace(/[^\w.\-+]/g, '').slice(0, 20);

module.exports = { isMobileClient, appVersion };
