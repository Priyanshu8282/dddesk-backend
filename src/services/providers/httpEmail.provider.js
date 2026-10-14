/**
 * Generic HTTP e-mail adapter (see httpSms.provider.js for the provider interface).
 * POSTs JSON { from, to, subject, text } with Authorization: Bearer <EMAIL_API_KEY>.
 * Fits Resend-style APIs directly (set EMAIL_API_URL=https://api.resend.com/emails) and
 * SendGrid/Brevo-style APIs through a small gateway or by adjusting buildBody via
 * EMAIL_BODY_FORMAT=resend (default) | simple ({ from, to, subject, message }).
 * Env: EMAIL_API_URL, EMAIL_API_KEY, EMAIL_FROM, EMAIL_TIMEOUT_MS. Secrets are never logged.
 */
const create = (env = process.env, fetchImpl = (...a) => globalThis.fetch(...a)) => ({
    name: 'http-email',
    async send({ to, title, message }) {
        const url = env.EMAIL_API_URL;
        if (!url) throw new Error('EMAIL_API_URL not set');
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), parseInt(env.EMAIL_TIMEOUT_MS, 10) || 10000);
        try {
            const headers = { 'Content-Type': 'application/json' };
            if (env.EMAIL_API_KEY) headers.Authorization = `Bearer ${env.EMAIL_API_KEY}`;
            const body = env.EMAIL_BODY_FORMAT === 'simple'
                ? { from: env.EMAIL_FROM, to, subject: title, message }
                : { from: env.EMAIL_FROM, to: [to], subject: title, text: message };
            const res = await fetchImpl(url, { method: 'POST', headers, signal: ctrl.signal, body: JSON.stringify(body) });
            if (!res.ok) throw new Error(`Email provider responded ${res.status}`);
        } catch (e) {
            throw new Error(e.name === 'AbortError' ? 'Email provider timeout' : (e.message || 'Email send failed'));
        } finally { clearTimeout(timer); }
    }
});

module.exports = { create };
