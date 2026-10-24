// Socket authentication: runs the REAL HTTP Authentication middleware on a fake request, so a socket is accepted
// only when the same checks pass (live session, user active, library active, tokensValidAfter, impersonation issuer).
// Maintenance is not applied here (the connection stays open and the client is told with `maintenance:changed`).
const jwt = require('jsonwebtoken');
const Authentication = require('../middlewares/auth.middleware');
const maintenance = require('../services/maintenance.service');

const MAX_TOKEN_LENGTH = 4096;

const reasonFor = (status, body) => {
  if (status === 403) return body && body.libraryStatus ? 'library_inactive' : 'forbidden';
  if (status === 402) return 'forbidden';
  return 'unauthorized';
};

/** Resolve a handshake token to { ctx, exp, sid, userId, blocked } or throw Error(message = reason). */
const authenticate = async (token, ip) => {
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_LENGTH) throw new Error('unauthorized');
  const req = {
    headers: { authorization: `Bearer ${token}` }, method: 'GET', path: '/realtime', originalUrl: '/realtime', url: '/realtime',
    query: {}, ip, secure: false, skipMaintenanceCheck: true,
  };
  const outcome = await new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ ok: false, status: this.statusCode, body }); return this; },
      set() { return this; }, setHeader() { return this; }, send() { resolve({ ok: false, status: this.statusCode, body: null }); return this; },
    };
    Promise.resolve(Authentication(req, res, () => resolve({ ok: true }))).catch(() => resolve({ ok: false, status: 401, body: null }));
  });
  if (!outcome.ok) throw new Error(reasonFor(outcome.status, outcome.body));

  const decoded = jwt.decode(token) || {};
  const userId = String(req.user._id);
  const ctx = {
    userType: req.userType, userId, libraryId: req.libraryId ? String(req.libraryId) : null,
    permissions: req.permissions || [], branchIds: (req.user && req.user.branchIds) || [],
  };
  // Would maintenance block a normal GET for this user? Then the client is told right after connect.
  let blocked = false;
  try {
    blocked = !!(await maintenance.check({ method: 'GET', userType: req.userType, userId, libraryId: ctx.libraryId || '', ip }));
  } catch (_) { blocked = false; }
  return { ctx, exp: decoded.exp ? decoded.exp * 1000 : null, sid: req.sessionId, userId, blocked };
};

module.exports = { authenticate, reasonFor, MAX_TOKEN_LENGTH };
