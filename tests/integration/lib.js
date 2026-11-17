// Integration harness: the real Express app against a real (in-memory) MongoDB. It pre-sets every variable the backend's
// dotenv would load from backend/.env (dotenv never overrides), so the real database and real keys are never used.
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

const BACKEND = process.env.DD_BACKEND || path.join(__dirname, '..', '..');
const SRC = path.join(BACKEND, 'src');
const breq = (p) => require(path.join(BACKEND, 'node_modules', p));

const state = { warnings: [], mongod: null, server: null, base: '', mongoose: null, ipCounter: 1, blockedFetches: [] };
const TEST_ENV = {
  NODE_ENV: 'development',
  PORT: '0',
  JWT_SECRET: crypto.randomBytes(32).toString('hex'),
  JWT_EXPIRATION: '30m',
  RAZORPAY_KEY_ID: 'rzp_test_dummy',
  RAZORPAY_KEY_SECRET: 'rzp_secret_dummy_value',
  RAZORPAY_WEBHOOK_SECRET: 'whsec_dummy_value',
  EMAIL_HOST: '', EMAIL_PORT: '', EMAIL_SECURE: '', EMAIL_USER: '', EMAIL_PASSWORD: '', EMAIL_FROM: '', EMAIL_FROM_NAME: '',
  GEMINI_API_KEY: '',
  OTP_IN_RESPONSE: 'true',
  REQUIRE_REGISTRATION_OTP: 'true',
  CRON_SECRET: 'cron-secret-for-tests',
  HUMAN_CHECK_PROVIDER: process.env.HUMAN_CHECK_PROVIDER || 'off',
  API_RATE_LIMIT_PER_MIN: '100000',
  MAINTENANCE_CACHE_TTL_MS: '0',
  FRONTEND_URL: 'http://localhost:3000',
  RATE_LIMIT_STORE: 'memory',
  SOCKET_SESSION_CHECK_MS: '400',
};

// No test may depend on the internet: any fetch to a host other than this machine is refused at once (and recorded).
function blockOutbound() {
  if (globalThis.fetch.__ddBlocked) return;
  const real = globalThis.fetch;
  const guarded = function (input, init) {
    const raw = typeof input === 'string' ? input : (input && input.url) || String(input);
    let host = '';
    try { host = new URL(raw).hostname; } catch (_) { /* relative */ }
    if (host && !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
      state.blockedFetches.push(raw);
      return Promise.reject(new TypeError('network disabled in tests: ' + raw));
    }
    return real(input, init);
  };
  guarded.__ddBlocked = true;
  globalThis.fetch = guarded;
}

async function boot() {
  blockOutbound();
  process.on('warning', (w) => { state.warnings.push(String(w.message || w)); });
  const { MongoMemoryServer } = require('mongodb-memory-server');
  process.env.MONGOMS_VERSION = process.env.MONGOMS_VERSION || '6.0.14';
  state.mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 90000 } });
  // uploads and report files of the run go to a throw-away folder, never into the repository
  const runDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'dddesk-it-'));
  fs.mkdirSync(runDir, { recursive: true });
  process.chdir(runDir);
  // Pre-set EVERY variable the backend's dotenv would otherwise load from backend/.env (dotenv never overrides).
  Object.assign(process.env, TEST_ENV, { MONGODB_URL: state.mongod.getUri() + 'ddtest' });
  delete process.env.MONGODB_URI;
  // Fake Razorpay (no network): orders.create just echoes an order id. Must be in place before the app loads.
  const rzPath = require.resolve(path.join(BACKEND, 'node_modules', 'razorpay'));
  require(rzPath);
  state.rzOrders = [];
  class FakeRazorpay { constructor() { this.orders = { create: async (o) => { const order = { id: 'order_' + crypto.randomBytes(7).toString('hex'), amount: o.amount, currency: o.currency, receipt: o.receipt, notes: o.notes }; state.rzOrders.push(order); return order; } }; this.payments = { fetch: async () => ({}), refund: async () => ({ id: 'rfnd_test', status: 'processed' }) }; } }
  require.cache[rzPath].exports = FakeRazorpay;
  const mongoose = breq('mongoose');
  state.mongoose = mongoose;
  const connectDB = require(path.join(SRC, 'config/database'));
  await connectDB();
  if (mongoose.connection.readyState !== 1) throw new Error('mongo not connected');
  const app = require(path.join(SRC, 'app'));
  const settings = require(path.join(SRC, 'services/platformSettings.service'));
  await settings.ensureFresh();
  const { syncLibrarySidebar } = require(path.join(SRC, 'seed/librarySidebar'));
  const { syncRBAC } = require(path.join(SRC, 'seed/rbacSync'));
  await syncLibrarySidebar({ apply: true });
  await syncRBAC();
  const Role = require(path.join(SRC, 'models/role.model'));
  const Admin = require(path.join(SRC, 'models/admin.model'));
  const superRole = await Role.findOne({ name: 'Super Admin', libraryId: null });
  await Admin.create({ name: 'Super Admin', email: 'root@dd.test', password: 'SuperPass#123', userType: 'superadmin', roleId: superRole._id, mobile: '9000000000', status: true });
  state.server = http.createServer(app);
  require(path.join(SRC, 'realtime')).init(state.server);
  await new Promise((r) => state.server.listen(0, '127.0.0.1', r));
  state.base = `http://127.0.0.1:${state.server.address().port}`;
  return state;
}

async function shutdown() {
  try { require(path.join(SRC, 'realtime')).close(); } catch (_) { /* */ }
  if (state.server) await new Promise((r) => state.server.close(r));
  if (state.mongoose) await state.mongoose.disconnect();
  if (state.mongod) await state.mongod.stop();
}

const freshIp = () => { const n = state.ipCounter++; return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`; };

async function api(method, url, { token, body, ip, headers = {}, cookie, form } = {}) {
  const h = { 'x-forwarded-for': ip || freshIp(), ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (cookie) h.cookie = cookie;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  // redirect: 'manual' - the test client must never follow a redirect off the box (e.g. /admin-image redirects to ui-avatars.com)
  const res = await fetch(state.base + url, { method, headers: h, body: payload, redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not json */ }
  const setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return { status: res.status, body: json, text, headers: res.headers, setCookie };
}
const P = (u) => '/v1/private' + u;
const U = (u) => '/v1/public' + u;

module.exports = { state, boot, shutdown, api, P, U, SRC, breq, freshIp, TEST_ENV };
