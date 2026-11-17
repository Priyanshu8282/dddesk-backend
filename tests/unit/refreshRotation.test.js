// Refresh cookie rotation: a lost reply is recovered (no surprise logout), theft is still caught.
const test = require('node:test');
const assert = require('node:assert');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);
const crypto = require('crypto');
const mongoose = require('mongoose');

const src = (p) => require.resolve('../../src/' + p);
let row;
const apply = (set, inc) => { Object.assign(row, set || {}); for (const k in inc || {}) row[k] = (row[k] || 0) + inc[k]; };
const Session = {
    findById: async () => row && { ...row },
    findOneAndUpdate: async (f, u) => { if (row.refreshHash !== f.refreshHash || row.revokedAt) return null; apply(u.$set); return row; },
    updateOne: async (f, u) => { if (f.revokedAt === null && row.revokedAt) return; apply(u.$set, u.$inc); },
};
require.cache[src('models/session.model.js')] = { exports: Session, loaded: true };
require.cache[src('models/admin.model.js')] = { exports: { findById: () => ({ select: () => ({ lean: async () => ({ status: true }) }) }) }, loaded: true };
require.cache[src('models/student.model.js')] = { exports: {}, loaded: true };
require.cache[src('utils/securityLog.js')] = { exports: { record: () => {} }, loaded: true };
require.cache[src('config/cors.js')] = { exports: { isAllowedOrigin: () => true, normalize: (o) => o }, loaded: true };
const svc = require('../../src/services/session.service');

const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const UA = 'Mozilla/5.0 Edg/156.0.0.0';
const sid = new mongoose.Types.ObjectId();
const login = () => {
    const s = 'A'.repeat(64);
    row = { _id: sid, userId: new mongoose.Types.ObjectId(), userType: 'admin', refreshHash: sha(s), prevRefreshHash: null, rotatedAt: null, persistent: true, userAgent: UA, createdAt: new Date(), expiresAt: new Date(Date.now() + 864e5), absoluteExpiresAt: new Date(Date.now() + 30 * 864e5), revokedAt: null, recoveries: 0 };
    return `${sid}.${s}`;
};
const call = async (cookie, ua = UA) => {
    const res = { c: null, cookie(n, v) { this.c = v; }, clearCookie() {}, set() {} };
    const req = { headers: { cookie: 'dd_rt=' + cookie, origin: 'http://localhost:3000', 'x-requested-with': 'X', 'user-agent': ua }, secure: false };
    try { await svc.refresh(req, res); return { ok: true, cookie: res.c }; } catch (e) { return { ok: false, revoked: !!row.revokedAt }; }
};
const age = (ms) => { row.rotatedAt = new Date(Date.now() - ms); };

test('a retry right after a lost reply gets the current cookie again', async () => {
    const A = login();
    const B = (await call(A)).cookie;
    const C = (await call(B)).cookie; // reply lost: the browser keeps B
    const r = await call(B);
    assert.ok(r.ok);
    assert.strictEqual(r.cookie, C);
});

test('a late lost reply (laptop asleep) is recovered from the same browser, even after an update', async () => {
    const A = login();
    const B = (await call(A)).cookie;
    const C = (await call(B)).cookie;
    age(2 * 3600e3);
    const r = await call(B, 'Mozilla/5.0 Edg/157.0.0.0');
    assert.ok(r.ok);
    assert.strictEqual(r.cookie, C);
    assert.strictEqual(row.recoveries, 1);
});

test('an old cookie from another client is treated as theft', async () => {
    const A = login();
    const B = (await call(A)).cookie;
    await call(B);
    age(3600e3);
    const r = await call(B, 'curl/8.0');
    assert.ok(!r.ok);
    assert.ok(r.revoked);
});

test('a thief and the owner taking turns end in a revoke after at most 3 catch-ups', async () => {
    const A = login();
    let cur = (await call(A)).cookie, old = A, n = 0;
    for (let i = 0; i < 6; i += 1) {
        age(3600e3);
        if (!(await call(old)).ok) break;
        n += 1;
        const r = await call(cur);
        if (!r.ok) break;
        old = cur; cur = r.cookie;
    }
    assert.ok(row.revokedAt);
    assert.ok(n <= 3);
});
