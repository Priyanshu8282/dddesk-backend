/**
 * liveVisitors.js — in-memory live visitor tracker
 *
 * Each active visitor sends a heartbeat POST /ping every 30s.
 * If no heartbeat arrives within TTL_MS (90s), they are evicted.
 *
 * Storage: Map<token, { vendorId: string|null, expiresAt: number }>
 *
 * Session token is a random UUID generated client-side and stored in sessionStorage.
 */

const TTL_MS = 90_000; // 90 seconds — 3 missed heartbeats at 30s interval

/** @type {Map<string, { vendorId: string|null, expiresAt: number }>} */
const sessions = new Map();

// Clean up expired sessions every 30s to avoid memory leaks
setInterval(() => {
    const now = Date.now();
    for (const [token, s] of sessions) {
        if (s.expiresAt < now) sessions.delete(token);
    }
}, 30_000);

/**
 * Register or refresh a visitor heartbeat.
 * @param {string} token  — unique session token from the browser
 * @param {string|null} vendorId — null for site-wide ping, ObjectId string for vendor store
 */
function heartbeat(token, vendorId = null) {
    sessions.set(token, {
        vendorId: vendorId || null,
        expiresAt: Date.now() + TTL_MS,
    });
}

/**
 * Get number of live visitors currently on the site or a specific vendor store.
 * @param {string|null} vendorId — null = site-wide count
 */
function getLiveCount(vendorId = null) {
    const now = Date.now();
    let count = 0;
    for (const s of sessions.values()) {
        if (s.expiresAt < now) continue;
        if (vendorId === null || s.vendorId === String(vendorId)) count++;
    }
    return count;
}

module.exports = { heartbeat, getLiveCount };
