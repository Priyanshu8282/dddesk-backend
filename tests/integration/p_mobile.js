// Part: what the native student app needs from the auth layer.
//  - "X-Client-Type: mobile" mode: refresh token in the JSON body (no cookie jar in a native app), rotated on every refresh
//  - the web cookie flow is unchanged and still protected by the Origin check
//  - one student mobile registered in several libraries: the library list is shown only after the OTP is proven
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./lib');
const { api, P, U } = L;

module.exports = (H) => {
  const { ctx, ok, expectStatus, data, msg, T, id } = H;
  const MOBILE = '9811100031'; // student created earlier in library 1 (password Stud#12345)
  const mobileHdr = { 'x-client-type': 'mobile' };

  const otpFor = async (body) => {
    const s = await api('POST', U('/send-otp'), { body: { userRole: 'STUDENT', mobile: MOBILE, ...body } });
    ok(s, 'send-otp');
    const otp = data(s).otp || s.body.otp;
    assert.match(String(otp), /^\d{6}$/, 'the test server returns the OTP: ' + msg(s));
    return String(otp);
  };

  test('120 mobile mode: OTP login returns a refresh token in the body and sets no cookie', async () => {
    const otp = await otpFor({ libraryId: ctx.ids.library });
    const v = await api('POST', U('/verify-otp'), { headers: mobileHdr, body: { userRole: 'STUDENT', mobile: MOBILE, otp, libraryId: ctx.ids.library } });
    ok(v, 'verify-otp (mobile)');
    assert.ok(v.body.token && v.body.data.token, 'access token present');
    assert.match(String(v.body.refreshToken), /^[a-f0-9]{24}\.[\w-]{40,}$/, 'refresh token is "<sessionId>.<secret>"');
    assert.ok(v.body.refreshExpiresAt && !Number.isNaN(Date.parse(v.body.refreshExpiresAt)), 'expiry is given');
    assert.equal(v.setCookie.filter((c) => c.startsWith('dd_rt=')).length, 0, 'no refresh cookie in mobile mode');
    assert.match(String(v.headers.get('cache-control')), /no-store/, 'token responses are never cached');
    ctx.mobile = { access: v.body.token, refresh: v.body.refreshToken };
    ok(await api('GET', P('/students/me'), { token: ctx.mobile.access }), 'the access token works');
  });

  test('121 web mode is unchanged: cookie only, no refresh token in the body', async () => {
    const otp = await otpFor({ libraryId: ctx.ids.library });
    const v = await api('POST', U('/verify-otp'), { body: { userRole: 'STUDENT', mobile: MOBILE, otp, libraryId: ctx.ids.library } });
    ok(v, 'verify-otp (web)');
    assert.equal(v.body.refreshToken, undefined, 'a browser never gets the refresh token in JSON');
    assert.equal(v.body.data.refreshToken, undefined);
    assert.ok(v.setCookie.some((c) => c.startsWith('dd_rt=') && /HttpOnly/i.test(c)), 'HttpOnly cookie is set');
  });

  test('122 mobile refresh rotates the token; the web Origin check is not weakened', async () => {
    const first = ctx.mobile.refresh;
    const r = await api('POST', U('/refresh'), { headers: mobileHdr, body: { refreshToken: first } });
    ok(r, 'refresh');
    assert.ok(r.body.token, 'new access token');
    assert.ok(r.body.refreshToken && r.body.refreshToken !== first, 'a new refresh token replaces the old one');
    assert.ok(r.body.expiresIn > 0);
    assert.equal(r.setCookie.length, 0, 'no cookie in mobile mode');
    ok(await api('GET', P('/students/me'), { token: r.body.token }), 'the refreshed access token works');
    ctx.mobile.refresh = r.body.refreshToken;

    const bogus = await api('POST', U('/refresh'), { headers: mobileHdr, body: { refreshToken: first.split('.')[0] + '.' + 'x'.repeat(64) } });
    expectStatus(bogus, 401, 'right session id, wrong secret');
    expectStatus(await api('POST', U('/refresh'), { headers: mobileHdr, body: { refreshToken: 'garbage' } }), 401, 'garbage');
    expectStatus(await api('POST', U('/refresh'), { headers: mobileHdr, body: {} }), 401, 'missing');
    // the body token is NOT accepted by the browser path: without the mobile header the Origin check still applies
    expectStatus(await api('POST', U('/refresh'), { body: { refreshToken: ctx.mobile.refresh } }), 403, 'no mobile header, no Origin');
  });

  test('123 mobile logout needs the real secret, then the session is dead', async () => {
    const sid = ctx.mobile.refresh.split('.')[0];
    // knowing the session id alone must not sign anyone out
    await api('POST', U('/logout'), { headers: mobileHdr, body: { refreshToken: `${sid}.${'y'.repeat(64)}` } });
    ok(await api('POST', U('/refresh'), { headers: mobileHdr, body: { refreshToken: ctx.mobile.refresh } }), 'session still alive after a wrong-secret logout');
    // use the token that refresh just rotated to
    const cur = await api('POST', U('/refresh'), { headers: mobileHdr, body: { refreshToken: ctx.mobile.refresh } });
    const token = cur.body.refreshToken || ctx.mobile.refresh;
    ok(await api('POST', U('/logout'), { headers: mobileHdr, body: { refreshToken: token } }), 'logout');
    expectStatus(await api('POST', U('/refresh'), { headers: mobileHdr, body: { refreshToken: token } }), 401, 'refresh after logout');
  });

  test('124 one mobile in two libraries: library choice appears only after a correct OTP', async () => {
    const lib2Student = await api('POST', P('/students/create-student'), { token: T('owner2'), body: { name: 'Same Mobile Two', mobile: MOBILE, password: 'Stud#12345', consentGiven: true } });
    ok(lib2Student, 'same mobile in library 2');

    const noHint = await api('POST', U('/send-otp'), { body: { userRole: 'STUDENT', mobile: MOBILE } });
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
    assert.ok(done.body.refreshToken);

    // the same code cannot be used a second time
    expectStatus(await api('POST', U('/verify-otp'), { headers: mobileHdr, body: { userRole: 'STUDENT', mobile: MOBILE, otp, libraryId: ctx.ids.library } }), 400, 'OTP is single use');
  });
};
