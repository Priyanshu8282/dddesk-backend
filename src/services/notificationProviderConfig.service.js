/**
 * Notification provider configuration (spec 5.4) stored in GlobalSetting key `notification_providers`
 * (isPublic:false, superadmin only). SECRETS ARE NEVER STORED: the document keeps the NAMES of environment
 * variables (passwordEnvVar, apiKeyEnvVar, accessTokenEnvVar) and the values are read from process.env at use time.
 *
 * Shape:
 *  email:    { enabled, host, port, secure, user, from, passwordEnvVar }
 *  sms:      { enabled, provider, senderId, apiKeyEnvVar }
 *  whatsapp: { enabled, provider, phoneNumberId, accessTokenEnvVar }
 */
const GlobalSetting = require('../models/setting.model');

const KEY = 'notification_providers';
const TTL_MS = 60 * 1000;

let cache = { value: {}, at: 0 };

const loadProviderConfig = async () => {
    const doc = await GlobalSetting.findOne({ key: KEY }).lean();
    cache = { value: (doc && doc.value) || {}, at: Date.now() };
    return cache.value;
};

/** Refresh the in-memory copy when older than the TTL. Never throws. */
const ensureFresh = async () => {
    if (Date.now() - cache.at < TTL_MS) return cache.value;
    try { return await loadProviderConfig(); } catch (_) { cache.at = Date.now(); return cache.value; }
};

const invalidate = () => { cache = { value: cache.value, at: 0 }; };

const getStoredConfig = () => cache.value || {};

const envValue = (name) => (name && process.env[name] ? process.env[name] : undefined);

/**
 * Effective configuration used by the notification service (contains resolved secrets - internal use only,
 * never send it to a client). Falls back to the legacy SMTP_* env variables.
 */
// SMTP_* and the older EMAIL_* names are both accepted. TLS-on-connect only works on 465; 587 upgrades with STARTTLS,
// so "secure" set on 587 (a common slip) would fail every send with an SSL version error.
const smtpFromEnv = (env) => {
    const host = env.SMTP_HOST || env.EMAIL_HOST;
    const port = parseInt(env.SMTP_PORT || env.EMAIL_PORT, 10) || 587;
    const user = env.SMTP_USER || env.EMAIL_USER;
    return {
        source: host ? 'env' : 'none', host, port, secure: port === 465,
        user, pass: env.SMTP_PASS || env.EMAIL_PASSWORD, from: env.SMTP_FROM || env.EMAIL_FROM || user
    };
};

const effectiveConfig = () => {
    const s = getStoredConfig();
    const e = s.email || {};
    const useStored = e.enabled !== false && !!e.host;
    const email = useStored ? {
        source: 'settings', host: e.host, port: e.port || 587, secure: !!e.secure,
        user: e.user || undefined, pass: envValue(e.passwordEnvVar), from: e.from || e.user
    } : {
        ...smtpFromEnv(process.env)
    };
    const sms = s.sms || {};
    const wa = s.whatsapp || {};
    return {
        email,
        sms: { enabled: sms.enabled !== false && !!sms.provider, provider: sms.provider, senderId: sms.senderId, apiKey: envValue(sms.apiKeyEnvVar) },
        whatsapp: { enabled: wa.enabled !== false && !!wa.provider, provider: wa.provider, phoneNumberId: wa.phoneNumberId, accessToken: envValue(wa.accessTokenEnvVar) }
    };
};

const maskEmailUser = (u) => {
    if (!u) return null;
    const [name, domain] = String(u).split('@');
    if (!domain) return `${String(u).slice(0, 2)}***`;
    return `${name.slice(0, 2)}***@${domain}`;
};

/** Safe view for GET: no secret values; says whether each referenced env var is set */
const maskForResponse = (stored = {}) => {
    const e = stored.email || {};
    const sms = stored.sms || {};
    const wa = stored.whatsapp || {};
    return {
        email: {
            enabled: e.enabled !== false && !!e.host, host: e.host || null, port: e.port || null, secure: !!e.secure,
            user: maskEmailUser(e.user), from: e.from || null,
            passwordEnvVar: e.passwordEnvVar || null, passwordSet: !!envValue(e.passwordEnvVar),
            transportAvailable: (() => { try { require.resolve('nodemailer'); return true; } catch (_) { return false; } })()
        },
        sms: {
            enabled: sms.enabled !== false && !!sms.provider, provider: sms.provider || null, senderId: sms.senderId || null,
            apiKeyEnvVar: sms.apiKeyEnvVar || null, apiKeySet: !!envValue(sms.apiKeyEnvVar)
        },
        whatsapp: {
            enabled: wa.enabled !== false && !!wa.provider, provider: wa.provider || null,
            phoneNumberId: wa.phoneNumberId ? `${'*'.repeat(Math.max(0, String(wa.phoneNumberId).length - 4))}${String(wa.phoneNumberId).slice(-4)}` : null,
            accessTokenEnvVar: wa.accessTokenEnvVar || null, accessTokenSet: !!envValue(wa.accessTokenEnvVar)
        }
    };
};

/** Deep-merge channel sections from an update; keeps previous values for omitted fields, null clears a field */
const mergeConfig = (previous = {}, update = {}) => {
    const out = { ...previous };
    for (const ch of ['email', 'sms', 'whatsapp']) {
        if (!update[ch]) continue;
        const merged = { ...(previous[ch] || {}) };
        for (const [k, v] of Object.entries(update[ch])) {
            if (v === null) delete merged[k]; else merged[k] = v;
        }
        out[ch] = merged;
    }
    return out;
};

const saveConfig = async (next) => {
    await GlobalSetting.findOneAndUpdate(
        { key: KEY },
        { $set: { value: next, isPublic: false, description: 'Notification provider configuration (env var names only, no secrets)' } },
        { upsert: true, new: true }
    );
    cache = { value: next, at: Date.now() };
    return next;
};

module.exports = {
    KEY, loadProviderConfig, ensureFresh, invalidate, getStoredConfig, effectiveConfig, maskForResponse, mergeConfig, saveConfig
};
