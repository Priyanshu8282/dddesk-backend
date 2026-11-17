// Part: what the native apps (owner + student) need from the auth layer.
//  - "X-Client-Platform: mobile" (older "X-Client-Type: mobile" is still understood):
//      * one long-lived ACCESS token bound to a revocable session row; no refresh token, no cookie
//      * revoked at once by logout (bearer), logout-all, password change, account/session revocation
//      * sliding renewal in the X-New-Access-Token header once half of the lifetime is used
//      * the human check is the proof-of-work puzzle (higher difficulty) whatever web provider is configured
//  - the web cookie flow is unchanged and still protected by the Origin check
//  - one student mobile registered in several libraries: the library list is shown only after the OTP is proven
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const L = require('./lib');
const { api, P, U } = L;

module.exports = (H) => {
  const { ctx, ok, expectStatus, data, msg, T, id } = H;
  const MOBILE = '9811100031'; // student created earlier in library 1 (password Stud#12345); used by the multi-library test
  const M2 = '9811100052'; // fresh students for these tests so the per-account rate limits (5 OTP / 20 logins) of one never starve another
  const M3 = '9811100053';
  const mobileHdr = { 'x-client-platform': 'mobile', 'x-app-version': '1.0.0' };
  const legacyHdr = { 'x-client-type': 'mobile' };
  const jwt = L.breq('jsonwebtoken');
  const decode = (t) => jwt.decode(t);
  const Session = () => require(require('path').join(L.SRC, 'models/session.model'));
  const SecurityEvent = () => require(require('path').join(L.SRC, 'models/securityEvent.model'));

  const H_stu = H.stu;
  const otpFor = async (body, headers = {}) => {
    const s = await api('POST', U('/send-otp'), { headers, body: { userRole: 'STUDENT', mobile: M2, ...body } });
    ok(s, 'send-otp');
    const otp = data(s).otp || s.body.otp;
    assert.match(String(otp), /^\d{6}$/, 'the test server returns the OTP: ' + msg(s));
    return String(otp);
  };

  const mobileLogin = async (extraHeaders = {}) => {
    const r = await api('POST', U('/login'), { headers: { ...mobileHdr, ...extraHeaders }, body: { userRole: 'STUDENT', identifier: M2, password: 'Stud#12345', libraryId: ctx.ids.library } });
    ok(r, 'mobile login');
    return r;
  };

  test('119 setup: two fresh students for the mobile-auth tests', async () => {
    for (const mobile of [M2, M3]) {
      ok(await api('POST', P('/students/create-student'), { token: T('owner'), body: H_stu({ name: 'Mobile Auth ' + mobile.slice(-2), mobile }) }), 'create ' + mobile);
    }
  });

  test('120 mobile OTP login: one long-lived access token, no refresh token, no cookie', async () => {
    const otp = await otpFor({ libraryId: ctx.ids.library }, mobileHdr);
    const v = await api('POST', U('/verify-otp'), { headers: mobileHdr, body: { userRole: 'STUDENT', mobile: M2, otp, libraryId: ctx.ids.library } });
    ok(v, 'verify-otp (mobile)');
    assert.ok(v.body.token && v.body.data.token, 'access token present');
    assert.equal(v.body.refreshToken, undefined, 'mobile never gets a refresh token');
    assert.equal(v.body.data.refreshToken, undefined);
    assert.equal(v.setCookie.filter((c) => c.startsWith('dd_rt=')).length, 0, 'no refresh cookie in mobile mode');
    assert.match(String(v.headers.get('cache-control')), /no-store/, 'token responses are never cached');
    const p = decode(v.body.token);
    assert.equal(p.cl, 'm', 'the token is marked as a mobile token');
    assert.ok(p.sid, 'the token names a revocable session');
    const life = p.exp - p.iat;
    assert.ok(life > 29 * 86400 && life <= 30 * 86400, 'default lifetime is 30 days: ' + life);
    assert.equal(v.body.expiresIn, life, 'expiresIn matches the token');
    const row = await Session().findById(p.sid).lean();
    assert.ok(row && !row.revokedAt && row.refreshHash === null, 'a session row with no refresh secret exists');
    assert.match(String(row.device), /Mobile app v1\.0\.0/, 'the device list shows the app: ' + row.device);
    ctx.mobile = { access: v.body.token, sid: p.sid };
    ok(await api('GET', P('/students/me'), { token: ctx.mobile.access }), 'the access token works');
  });

  test('121 web mode is unchanged: short token + HttpOnly cookie, no mobile claim', async () => {
    const otp = await otpFor({ libraryId: ctx.ids.library });
    const v = await api('POST', U('/verify-otp'), { body: { userRole: 'STUDENT', mobile: M2, otp, libraryId: ctx.ids.library } });
    ok(v, 'verify-otp (web)');
    assert.equal(v.body.refreshToken, undefined, 'a browser never gets the refresh token in JSON');
    assert.equal(v.body.expiresIn, undefined, 'no expiresIn field for browsers');
    assert.ok(v.setCookie.some((c) => c.startsWith('dd_rt=') && /HttpOnly/i.test(c)), 'HttpOnly cookie is set');
    const p = decode(v.body.token);
    assert.equal(p.cl, undefined, 'no mobile claim');
    assert.ok(p.exp - p.iat <= 3600, 'web access tokens stay short: ' + (p.exp - p.iat));
  });

  test('122 the legacy X-Client-Type header is understood; mobile has no refresh endpoint; the web Origin check is intact', async () => {
    const l = await mobileLogin(legacyHdr);
    assert.equal(decode(l.body.token).cl, 'm', 'old header still selects the mobile path');
    assert.equal(l.body.refreshToken, undefined);
    // a native client cannot refresh: it holds no refresh token
    const r = await api('POST', U('/refresh'), { headers: mobileHdr, body: { refreshToken: 'abc.def' } });
    expectStatus(r, 401, 'mobile refresh');
    assert.equal(r.body.errorCode, 'MOBILE_NO_REFRESH');
    // and the browser path still needs its custom header + known Origin
    expectStatus(await api('POST', U('/refresh'), { body: { refreshToken: 'abc.def' } }), 403, 'no mobile header, no Origin');
  });

  test('123 mobile logout uses the bearer token: only the real holder ends the session, even when the token expired', async () => {
    const l = await mobileLogin();
    const tok = l.body.token;
    const sid = decode(tok).sid;
    // a token for this session signed with another secret must not sign anyone out
    const forged = jwt.sign({ id: decode(tok).id, type: 'student', sid, cl: 'm' }, 'not-the-server-secret', { expiresIn: 600 });
    await api('POST', U('/logout'), { headers: mobileHdr, token: forged });
    ok(await api('GET', P('/students/me'), { token: tok }), 'session still alive after a forged logout');
    // an anonymous logout does nothing either
    await api('POST', U('/logout'), { headers: mobileHdr });
    ok(await api('GET', P('/students/me'), { token: tok }), 'session still alive after an anonymous logout');
    // a genuine but EXPIRED token for the same session can still log it out
    const expired = jwt.sign({ id: decode(tok).id, type: 'student', sid, cl: 'm', iat: Math.floor(Date.now() / 1000) - 7200 }, L.TEST_ENV.JWT_SECRET, { expiresIn: 60 });
    ok(await api('POST', U('/logout'), { headers: mobileHdr, token: expired }), 'logout');
    const row = await Session().findById(sid).lean();
    assert.ok(row.revokedAt && row.revokedReason === 'logout', 'the session row is revoked');
    expectStatus(await api('GET', P('/students/me'), { token: tok }), 401, 'token after logout');
  });

  test('124 one mobile in two libraries: library choice appears only after a correct OTP', async () => {
    const lib2Student = await api('POST', P('/students/create-student'), { token: T('owner2'), body: { name: 'Same Mobile Two', mobile: MOBILE, password: 'Stud#12345', consentGiven: true } });
    ok(lib2Student, 'same mobile in library 2');

    const noHint = await api('POST', U('/send-otp'), { headers: mobileHdr, body: { userRole: 'STUDENT', mobile: MOBILE } });
    ok(noHint, 'send-otp without a library no longer fails');
    const otp = String(data(noHint).otp || noHint.body.otp);
    assert.match(otp, /^\d{6}$/);

    const wrong = await api('POST', U('/verify-otp'), { headers: mobileHdr, body: { userRole: 'STUDENT', mobile: MOBILE, otp: otp === '000000' ? '111111' : '000000' } });
    expectStatus(wrong, 400, 'a wrong code');
    assert.ok(!/libraries|Library/i.test(wrong.text.replace(/library\s*not/i, '')) || !wrong.body.data, 'a wrong code reveals no library names: ' + msg(wrong));

    const choice = await api('POST', U('/verify-otp'), { headers: mobileHdr, body: { userRole: 'STUDENT', mobile: MOBILE, otp } });
    expectStatus(choice, 409, 'correct code, several libraries');
    assert.equal(choice.body.errorCode, 'LIBRARY_CHOICE_REQUIRED');
    const libs = choice.body.data.libraries;
    assert.equal(libs.length, 2, 'both libraries are offered: ' + msg(choice));
    assert.ok(libs.every((l) => /^[a-f0-9]{24}$/.test(l.id) && l.name), 'each has an id and a name');
    assert.ok(libs.some((l) => l.id === ctx.ids.library));

    // the code was not consumed: repeat with the chosen library
    const done = await api('POST', U('/verify-otp'), { headers: mobileHdr, body: { userRole: 'STUDENT', mobile: MOBILE, otp, libraryId: ctx.ids.library } });
    ok(done, 'login after choosing a library');
    assert.equal(String(done.body.user.libraryId?._id || done.body.user.libraryId), String(ctx.ids.library));
    assert.equal(done.body.refreshToken, undefined, 'no refresh token for the app');
    assert.equal(decode(done.body.token).cl, 'm');

    // the same code cannot be used a second time
    expectStatus(await api('POST', U('/verify-otp'), { headers: mobileHdr, body: { userRole: 'STUDENT', mobile: MOBILE, otp, libraryId: ctx.ids.library } }), 400, 'OTP is single use');
  });

  test('125 sliding renewal: past half of its life the app gets a fresh token in X-New-Access-Token; idle sessions are not renewed', async () => {
    const l = await mobileLogin();
    const p0 = decode(l.body.token);
    // a young token (just issued) is not renewed
    const young = await api('GET', P('/students/me'), { token: l.body.token });
    ok(young, 'me');
    assert.equal(young.headers.get('x-new-access-token'), null, 'no renewal for a fresh token');
    // age the token: same session, issued 20 days ago, 30-day life => 10 days left (< half)
    const now = Math.floor(Date.now() / 1000);
    const old = jwt.sign({ id: p0.id, type: 'student', sid: p0.sid, cl: 'm', iat: now - 20 * 86400 }, L.TEST_ENV.JWT_SECRET, { expiresIn: 30 * 86400 });
    const res = await api('GET', P('/students/me'), { token: old });
    ok(res, 'old token still valid');
    const fresh = res.headers.get('x-new-access-token');
    assert.ok(fresh, 'a fresh token is offered');
    const pf = decode(fresh);
    assert.equal(pf.sid, p0.sid, 'same session');
    assert.equal(pf.cl, 'm');
    assert.ok(pf.exp - pf.iat > 29 * 86400, 'full lifetime again');
    assert.ok(Number(res.headers.get('x-new-access-token-expires-in')) > 29 * 86400);
    ok(await api('GET', P('/students/me'), { token: fresh }), 'the renewed token works');
    // the session's idle expiry moved forward but never beyond the 90-day hard cap
    const row = await Session().findById(p0.sid).lean();
    assert.ok(row.expiresAt.getTime() > Date.now() + 29 * 86400 * 1000, 'idle expiry extended');
    assert.ok(row.expiresAt.getTime() <= row.absoluteExpiresAt.getTime(), 'never past the absolute cap');
    // renewal needs a live session: revoked => 401 and no new token
    await Session().updateOne({ _id: p0.sid }, { $set: { revokedAt: new Date() } });
    require(require('path').join(L.SRC, 'services/session.service')).forgetActive(p0.sid);
    const dead = await api('GET', P('/students/me'), { token: old });
    expectStatus(dead, 401, 'revoked session');
    assert.equal(dead.headers.get('x-new-access-token'), null, 'no token for a dead session');
    // web tokens are never renewed this way
    const web = await api('POST', U('/login'), { body: { userRole: 'STUDENT', identifier: M2, password: 'Stud#12345', libraryId: ctx.ids.library } });
    ok(web, 'web login');
    const webMe = await api('GET', P('/students/me'), { token: web.body.token });
    assert.equal(webMe.headers.get('x-new-access-token'), null, 'browsers never get X-New-Access-Token');
  });

  test('126 a mobile session is revoked by logout-all, password change, and the 90-day absolute cap', async () => {
    const a = await mobileLogin();
    const b = await mobileLogin();
    ok(await api('GET', P('/students/me'), { token: a.body.token }), 'a works');
    ok(await api('POST', P('/logout-all'), { token: a.body.token }), 'logout-all');
    expectStatus(await api('GET', P('/students/me'), { token: a.body.token }), 401, 'a after logout-all');
    expectStatus(await api('GET', P('/students/me'), { token: b.body.token }), 401, 'b after logout-all');

    // a password change ends every OTHER device's session (mobile ones included); the device that changed it keeps working
    const c = await mobileLogin();
    const d2 = await mobileLogin();
    ok(await api('PUT', P('/students/change-password'), { token: c.body.token, body: { currentPassword: 'Stud#12345', newPassword: 'Stud#12345b' } }), 'change password');
    ok(await api('GET', P('/students/me'), { token: c.body.token }), 'the device that changed the password stays signed in');
    expectStatus(await api('GET', P('/students/me'), { token: d2.body.token }), 401, 'another device after the password change');
    ok(await api('PUT', P('/students/change-password'), { token: c.body.token, body: { currentPassword: 'Stud#12345b', newPassword: 'Stud#12345' } }), 'change it back');
    const login2 = await api('POST', U('/login'), { headers: mobileHdr, body: { userRole: 'STUDENT', identifier: M2, password: 'Stud#12345', libraryId: ctx.ids.library } });
    ok(login2, 'login with the restored password');
    // absolute cap: a session row past its hard cap is dead even if the JWT has not expired
    const d = decode(login2.body.token);
    await Session().updateOne({ _id: d.sid }, { $set: { absoluteExpiresAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() - 1000) } });
    require(require('path').join(L.SRC, 'services/session.service')).forgetActive(d.sid);
    expectStatus(await api('GET', P('/students/me'), { token: login2.body.token }), 401, 'session past its absolute cap');
  });

  test('127 sessions list shows the app and lets the account see its devices', async () => {
    const l = await mobileLogin();
    const list = await api('GET', P('/sessions'), { token: l.body.token });
    ok(list, 'sessions');
    const rows = data(list);
    assert.ok(Array.isArray(rows) && rows.some((r) => r.current && /Mobile app/.test(r.device)), 'the current device is listed as the app: ' + JSON.stringify(rows));
  });

  // ---- human check for native apps: proof-of-work puzzle at a higher difficulty, whatever the web provider is
  const solve = async (headers, bitsOverride) => {
    const ch = await api('GET', U('/human-challenge'), { headers });
    ok(ch, 'challenge');
    const { challenge, difficulty } = data(ch);
    const need = bitsOverride || difficulty;
    const lz = (buf) => { let bits = 0; for (const b of buf) { if (b === 0) { bits += 8; continue; } bits += Math.clz32(b) - 24; break; } return bits; };
    let nonce = 0;
    for (;; nonce += 1) {
      if (lz(crypto.createHash('sha256').update(`${challenge}:${nonce}`).digest()) >= need) break;
    }
    await new Promise((r) => setTimeout(r, 1600)); // the server rejects an answer that arrives too fast
    return { token: `${challenge}~${nonce}`, difficulty };
  };

  const withProvider = async (provider, fn) => {
    const prev = { p: process.env.HUMAN_CHECK_PROVIDER, b: process.env.HUMAN_CHECK_POW_BITS, m: process.env.HUMAN_CHECK_MOBILE_POW_BITS, t: process.env.HUMAN_CHECK_MOBILE_ABUSE_THRESHOLD };
    process.env.HUMAN_CHECK_PROVIDER = provider; process.env.HUMAN_CHECK_POW_BITS = '12'; process.env.HUMAN_CHECK_MOBILE_ABUSE_THRESHOLD = '3';
    delete process.env.HUMAN_CHECK_MOBILE_POW_BITS;
    try { return await fn(); } finally {
      process.env.HUMAN_CHECK_PROVIDER = prev.p;
      for (const [k, v] of [['HUMAN_CHECK_POW_BITS', prev.b], ['HUMAN_CHECK_MOBILE_POW_BITS', prev.m], ['HUMAN_CHECK_MOBILE_ABUSE_THRESHOLD', prev.t]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  };

  const loginBody = (extra = {}) => ({ userRole: 'STUDENT', identifier: M3, password: 'Stud#12345', libraryId: ctx.ids.library, ...extra });

  test('128 mobile login with the proof-of-work token works even when the web provider is reCAPTCHA; no token is refused', async () => {
    await withProvider('recaptcha', async () => {
      const none = await api('POST', U('/login'), { headers: mobileHdr, body: loginBody() });
      expectStatus(none, 403, 'mobile login without a token');
      assert.equal(none.body.errorCode, 'HUMAN_CHECK_REQUIRED');
      const { token } = await solve(mobileHdr);
      const good = await api('POST', U('/login'), { headers: mobileHdr, body: loginBody({ humanToken: token }) });
      ok(good, 'mobile login with a solved puzzle');
      assert.equal(decode(good.body.token).cl, 'm');
      // the puzzle token is single use
      const replay = await api('POST', U('/login'), { headers: mobileHdr, body: loginBody({ humanToken: token }) });
      expectStatus(replay, 400, 'replayed puzzle');
      assert.equal(replay.body.errorCode, 'HUMAN_CHECK_FAILED');
      // a bogus token is refused without asking any captcha provider
      const forged = await api('POST', U('/login'), { headers: mobileHdr, body: loginBody({ humanToken: 'forged.token~1' }) });
      expectStatus(forged, 400, 'forged token');
    });
  });

  test('129 mobile puzzles are harder than web ones; an easy (web-difficulty) puzzle is refused for mobile', async () => {
    await withProvider('pow', async () => {
      const web = await api('GET', U('/human-challenge'));
      const mob = await api('GET', U('/human-challenge'), { headers: mobileHdr });
      assert.equal(data(web).difficulty, 12, 'web difficulty from HUMAN_CHECK_POW_BITS');
      assert.equal(data(mob).difficulty, 13, 'mobile difficulty is one bit higher by default');
      // solve a WEB challenge and present it from a mobile client
      const easy = await solve({}, 12);
      const refused = await api('POST', U('/login'), { headers: mobileHdr, body: loginBody({ humanToken: easy.token }) });
      expectStatus(refused, 400, 'web-difficulty token on a mobile request');
      // the same token on a web request is fine
      const web2 = await solve({}, 12);
      ok(await api('POST', U('/login'), { body: loginBody({ humanToken: web2.token }) }), 'web login with a web puzzle');
    });
  });

  test('130 send-otp needs the puzzle from mobile clients (web unchanged); verify-otp accepts but does not require it; forgot-password works with it', async () => {
    await withProvider('pow', async () => {
      const noTok = await api('POST', U('/send-otp'), { headers: mobileHdr, body: { userRole: 'STUDENT', mobile: M3, libraryId: ctx.ids.library } });
      expectStatus(noTok, 403, 'mobile send-otp without a token');
      const { token } = await solve(mobileHdr);
      const sent = await api('POST', U('/send-otp'), { headers: mobileHdr, body: { userRole: 'STUDENT', mobile: M3, libraryId: ctx.ids.library, humanToken: token } });
      ok(sent, 'mobile send-otp with a solved puzzle');
      const otp = String(data(sent).otp || sent.body.otp);
      // verify-otp: no token required
      const v = await api('POST', U('/verify-otp'), { headers: mobileHdr, body: { userRole: 'STUDENT', mobile: M3, otp, libraryId: ctx.ids.library } });
      ok(v, 'verify-otp without a token');
      // web send-otp keeps its old behaviour (rate limits only)
      ok(await api('POST', U('/send-otp'), { body: { userRole: 'STUDENT', mobile: M3, libraryId: ctx.ids.library } }), 'web send-otp needs no token');
      // forgot-password from the app uses the same puzzle
      const fp = await solve(mobileHdr);
      ok(await api('POST', U('/forgot-password'), { headers: mobileHdr, body: { userRole: 'STUDENT', mobile: M3, libraryId: ctx.ids.library, humanToken: fp.token } }), 'forgot-password with the puzzle');
    });
  });

  test('131 repeated failed mobile human checks from one address raise ONE security alert', async () => {
    await withProvider('pow', async () => {
      const ip = L.freshIp();
      for (let i = 0; i < 5; i += 1) {
        expectStatus(await api('POST', U('/login'), { ip, headers: mobileHdr, body: loginBody({ identifier: '98111009' + String(10 + i), humanToken: `forged.token~${i}` }) }), 400, 'bad token ' + i);
      }
      await new Promise((r) => setTimeout(r, 400));
      const events = await SecurityEvent().find({ type: 'human_check', reason: 'mobile_pow_abuse' }).lean();
      assert.equal(events.length >= 1, true, 'an abuse event was written');
      assert.equal(events.filter((e) => e.ip === ip || String(e.ip).includes(ip)).length <= 1, true, 'only once for that address in the window');
    });
  });

  test('132 login still honours provider=off for mobile (development)', async () => {
    await withProvider('off', async () => {
      ok(await api('POST', U('/login'), { headers: mobileHdr, body: loginBody() }), 'mobile login with the check switched off');
    });
  });
};
