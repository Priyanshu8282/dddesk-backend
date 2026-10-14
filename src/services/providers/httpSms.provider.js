/**
 * Notification provider interface
 * -------------------------------
 * A provider is a plain object: { send: async ({ to, title, message }) => void }
 * It must throw on failure. Register with
 *   notification.service.registerProvider('sms' | 'whatsapp' | 'email', provider)
 * Adapters in this folder auto-register from notification.service when their env is set:
 *   httpSms.provider.js    SMS_API_URL, SMS_API_KEY, SMS_SENDER_ID, (SMS_TIMEOUT_MS)
 *   httpEmail.provider.js  EMAIL_API_URL, EMAIL_API_KEY, EMAIL_FROM, (EMAIL_TIMEOUT_MS)
 * Secrets are never logged.
 *
 * Generic SMS adapter: POST JSON { to, message, sender } with
 * Authorization: Bearer <SMS_API_KEY> (and x-api-key). Any 2xx is success.
 */
const create = (env = process.env, fetchImpl = (...a) => globalThis.fetch(...a)) => ({
    name: 'http-sms',
    async send({ to, message }) {
        const url = env.SMS_API_URL;
        if (!url) throw new Error('SMS_API_URL not set');
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), parseInt(env.SMS_TIMEOUT_MS, 10) || 8000);
        try {
            const headers = { 'Content-Type': 'application/json' };
            if (env.SMS_API_KEY) { headers.Authorization = `Bearer ${env.SMS_API_KEY}`; headers['x-api-key'] = env.SMS_API_KEY; }
            const res = await fetchImpl(url, {
                method: 'POST', headers, signal: ctrl.signal,
                body: JSON.stringify({ to, message, sender: env.SMS_SENDER_ID || undefined })
            });
            if (!res.ok) throw new Error(`SMS provider responded ${res.status}`);
        } catch (e) {
            throw new Error(e.name === 'AbortError' ? 'SMS provider timeout' : (e.message || 'SMS send failed'));
        } finally { clearTimeout(timer); }
    }
});

module.exports = { create };
