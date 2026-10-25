// Part: route-guard smoke table (every registered route, unauthenticated + student token), index sync, startup warnings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const L = require('./lib');
const { api, SRC } = L;

module.exports = (H) => {
  const { ctx } = H;
  const SAMPLE = '000000000000000000000000';
  const WRITE = ['POST', 'PUT', 'PATCH'];

  // Express 5 keeps no mount path on a layer, so candidate prefixes come from the source text and are probed with the layer's own matcher
  const harvest = () => {
    const app = require(SRC + '/app');
    const root = (app.router || app._router).stack;
    const prefixes = new Set();
    for (const f of ['routes/private/index.js', 'routes/public/index.js', 'routes/public/onboarding.routes.js']) {
      const src = fs.readFileSync(path.join(SRC, f), 'utf8');
      for (const m of src.matchAll(/\.use\(\s*'(\/[^']*)'/g)) prefixes.add(m[1]);
    }
    for (const m of fs.readFileSync(path.join(SRC, 'app.js'), 'utf8').matchAll(/app\.use\(\s*'(\/[^']*)'/g)) prefixes.add(m[1]);
    const cands = [...prefixes].filter((c) => c !== '/').sort((a, b) => b.length - a.length);
    const out = [];
    const walk = (stack, base) => {
      for (const l of stack) {
        if (l.route) {
          const rp = l.route.path;
          if (typeof rp !== 'string') continue;
          for (const m of Object.keys(l.route.methods)) if (l.route.methods[m] === true) out.push({ method: m.toUpperCase(), path: (base + (rp === '/' ? '' : rp)) || '/' });
        } else if (l.handle && l.handle.stack && l.matchers && l.matchers[0]) {
          let hit = '';
          for (const c of cands) { const r = l.matchers[0](c); if (r && r.path === c) { hit = c; break; } }
          walk(l.handle.stack, base + hit);
        }
      }
    };
    walk(root, '');
    const seen = new Set();
    return out.filter((r) => { const k = r.method + ' ' + r.path; if (seen.has(k)) return false; seen.add(k); return true; })
      .map((r) => ({ ...r, url: r.path.replace(/:[A-Za-z]+(\([^)]*\))?\??/g, SAMPLE) }));
  };

  const PUBLIC_OK = [
    /^\/v1\/public\//, /^\/v1\/cron\//, /^\/webhook\/razorpay$/, /^\/$/,
    /^\/v1\/(legal|login|refresh|logout|send-otp|verify-otp|forgot-password|verify-reset-otp|reset-password|register|plans|human|contact|health|branding|locations|maintenance-status|razorpay|website|admin-image|library-image)/,
  ];
  const STUDENT_OK = /\/(students\/(dashboard|me|change-password)|payments\/(my|razorpay)|attendance\/(my|self-check|scan-qr)|notices\/(student|view)|notifications|me$|profile|logout|reviews|feedback|complaints|sidebar|settings|library|files|stories|banners|offers|coupons|announcements|support|branches|plans|seats|website|dashboard|ai|assistant|onboarding)/;

  test('70 route-guard smoke: every private route refuses anonymous callers; student tokens are logged', async () => {
    const routes = harvest();
    const priv = routes.filter((r) => r.path.startsWith('/v1/private'));
    assert.ok(priv.length > 200, `enumerated ${priv.length} private routes`);
    const rows = [];
    const problems = [];
    for (const r of priv) {
      const body = WRITE.includes(r.method) ? {} : undefined;
      const anon = await api(r.method, r.url, { body });
      const stud = ctx.tokens.stu ? await api(r.method, r.url, { token: ctx.tokens.stu, body }) : { status: '-' };
      rows.push({ method: r.method, path: r.path, anon: anon.status, student: stud.status });
      if (anon.status !== 401) problems.push(`ANON ${r.method} ${r.path} -> ${anon.status}`);
      if (anon.status >= 500 || stud.status >= 500) problems.push(`5xx ${r.method} ${r.path} anon=${anon.status} student=${stud.status}`);
      if ((stud.status === 200 || stud.status === 201) && !STUDENT_OK.test(r.path)) problems.push(`STUDENT allowed ${r.method} ${r.path}`);
    }
    const md = ['| Method | Route | Anonymous | Student token |', '|---|---|---|---|', ...rows.map((x) => `| ${x.method} | ${x.path} | ${x.anon} | ${x.student} |`)].join('\n');
    fs.writeFileSync(path.join(process.cwd(), 'route-smoke-private.md'), md);
    console.log(`SMOKE private: ${priv.length} routes; anonymous 401: ${rows.filter((x) => x.anon === 401).length}; student 401/403: ${rows.filter((x) => [401, 403].includes(x.student)).length}; student 2xx: ${rows.filter((x) => x.student >= 200 && x.student < 300).length}`);
    if (problems.length) console.log('SMOKE PROBLEMS:\n' + problems.join('\n'));
    assert.deepEqual(problems.filter((p) => p.startsWith('ANON') || p.startsWith('5xx')), [], 'anonymous callers must get 401 and no route may 5xx');
  });

  test('71 public routes: only the intended ones exist; none 5xx', async () => {
    const routes = harvest().filter((r) => !r.path.startsWith('/v1/private'));
    const rows = [];
    const problems = [];
    for (const r of routes) {
      const res = await api(r.method, r.url, { body: WRITE.includes(r.method) ? {} : undefined });
      rows.push({ method: r.method, path: r.path, status: res.status });
      if (res.status >= 500) problems.push(`5xx ${r.method} ${r.path} -> ${res.status}: ${res.text.slice(0, 120)}`);
      if (!PUBLIC_OK.some((re) => re.test(r.path))) problems.push(`UNEXPECTED PUBLIC ${r.method} ${r.path} -> ${res.status}`);
    }
    fs.writeFileSync(path.join(process.cwd(), 'route-smoke-public.md'), ['| Method | Route | Status (empty body, no auth) |', '|---|---|---|', ...rows.map((x) => `| ${x.method} | ${x.path} | ${x.status} |`)].join('\n'));
    console.log(`SMOKE public: ${routes.length} routes; ` + (problems.length ? 'PROBLEMS: ' + problems.join(' | ') : 'none'));
    assert.deepEqual(problems, []);
  });

  test('72 mongoose indexes build cleanly; duplicate-index warnings listed', async () => {
    const mongoose = L.state.mongoose;
    const bad = [];
    for (const name of mongoose.modelNames()) {
      try { await mongoose.model(name).syncIndexes(); } catch (e) { bad.push(`${name}: ${e.message}`); }
    }
    console.log('INDEX SYNC models:', mongoose.modelNames().length, 'failures:', bad.length ? bad.join(' | ') : 'none');
    const dups = L.state.warnings.filter((w) => /Duplicate schema index/i.test(w));
    console.log('DUPLICATE INDEX WARNINGS:', dups.length, dups.slice(0, 20).join(' || '));
    const other = L.state.warnings.filter((w) => !/Duplicate schema index|the `new` option|returnDocument/i.test(w));
    console.log('OTHER WARNINGS:', other.length, [...new Set(other)].slice(0, 12).join(' || '));
    assert.deepEqual(bad, [], 'every index must build');
  });
};
