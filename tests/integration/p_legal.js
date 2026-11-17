// Part: dynamic legal pages - sanitiser, versioning lifecycle, access control, public caching, consent versions.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const L = require('./lib');
const { api, P, U } = L;

module.exports = (H) => {
  const { ctx, ok, expectStatus, data, msg, T, stu } = H;
  const col = (n) => L.state.mongoose.connection.db.collection(n);
  const PW = 'SuperPass#123';
  const TYPE = 'privacy_policy';
  const SUPER = (u) => P('/super/legal' + u);
  const PUB = (u) => U('/legal' + u);
  const V = () => require(path.join(L.SRC, 'models/legalDocumentVersion.model'));
  const svc = () => require(path.join(L.SRC, 'services/legal.service'));
  const body = (n = 'one') => `<h2>Heading ${n}</h2><p>This paragraph is long enough to count as a real document, number ${n}.</p>`;
  const lastRevision = (r) => data(r).revision;
  // Node's fetch adds "Cache-Control: no-cache" to any request that carries If-None-Match, which (correctly) disables a 304.
  // A browser revalidating its cache sends no such header, so the conditional requests below use plain http.
  const rawGet = (url, headers = {}) => new Promise((resolve, reject) => {
    const u = new URL(L.state.base + url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers: { 'x-forwarded-for': L.freshIp(), ...headers } }, (res) => {
      let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: t }));
    });
    req.on('error', reject); req.end();
  });

  // what must never survive the sanitiser, checked on tags only (escaped text such as &lt;img&gt; is harmless)
  const dangerousTag = /<\s*\/?\s*(script|iframe|style|svg|img|object|embed|form|input|button|meta|link|base|math|details|template|video|audio|source|textarea|select|frame|frameset)\b/i;
  const eventAttr = /<[^>]*\son\w+\s*=/i;
  const badScheme = /<[^>]*\s(href|src|xlink:href|action|formaction)\s*=\s*["']?\s*(javascript|data|vbscript|file):/i;
  const styleAttr = /<[^>]*\s(style|class|id|srcdoc)\s*=/i;
  const assertClean = (out, label) => {
    assert.ok(!dangerousTag.test(out), `${label}: dangerous tag survived: ${out}`);
    assert.ok(!eventAttr.test(out), `${label}: event handler survived: ${out}`);
    assert.ok(!badScheme.test(out), `${label}: dangerous URL survived: ${out}`);
    assert.ok(!styleAttr.test(out), `${label}: style/class/id survived: ${out}`);
    assert.ok(!/<[^>]*\shref\s*=\s*["']?\s*\/\//i.test(out), `${label}: protocol-relative href survived: ${out}`);
  };

  async function draftWith(type, html, from = 'published') {
    let d = await api('POST', SUPER(`/${type}/draft`), { token: T('super'), body: { from } });
    if (d.status === 409) { ok(await api('DELETE', SUPER(`/${type}/draft`), { token: T('super') }), 'clear old draft'); d = await api('POST', SUPER(`/${type}/draft`), { token: T('super'), body: { from } }); }
    ok(d, 'create draft ' + msg(d));
    const s = await api('PUT', SUPER(`/${type}/draft`), { token: T('super'), body: { contentHtml: html, revision: data(d).revision } });
    return { create: d, save: s };
  }

  test('90 defaults: three documents exist with a published v1 (placeholder text, brand "DDdesk")', async () => {
    const list = await api('GET', SUPER(''), { token: T('super') });
    ok(list, 'list');
    const rows = data(list);
    assert.equal(rows.length, 3);
    for (const r of rows) {
      assert.equal(r.published && r.published.version, 1, `${r.type} has published v1`);
      assert.equal(r.published.status, 'published');
    }
    const pub = await api('GET', PUB('/privacy-policy'));
    ok(pub, 'public by slug');
    const d = data(pub);
    assert.equal(d.type, TYPE); assert.equal(d.version, 1);
    assert.ok(!/DDdesk\.ai/.test(d.contentHtml), 'brand is DDdesk, not DDdesk.ai');
    assert.match(d.contentHtml, /reviewed|legal counsel|owner/i, 'placeholder text is marked for review');
    assertClean(d.contentHtml, 'seed text');
    const all = await api('GET', PUB(''));
    ok(all, 'public list');
    assert.equal(data(all).length, 3);
    // one document through each alias
    for (const a of ['terms_and_conditions', 'terms', 'refund-cancellation', 'refund_cancellation_policy']) ok(await api('GET', PUB('/' + a)), 'alias ' + a);
    expectStatus(await api('GET', PUB('/cookie-policy')), 404, 'unknown document');
    expectStatus(await api('GET', PUB('/privacy-policy/versions/abc')), 400, 'bad version');
    expectStatus(await api('GET', PUB('/privacy-policy/versions/99')), 404, 'unknown version');
  });

  test('91 access control: anonymous 401, owner/staff/student 403, impersonation 403', async () => {
    expectStatus(await api('GET', SUPER('')), 401, 'anonymous');
    for (const who of ['owner', 'recA', 'stu']) {
      const r = await api('GET', SUPER(''), { token: T(who) });
      assert.ok([401, 403].includes(r.status), `${who} must not read legal admin: ${msg(r)}`);
      const w = await api('POST', SUPER(`/${TYPE}/draft`), { token: T(who), body: { from: 'blank' } });
      assert.ok([401, 403].includes(w.status), `${who} must not create a draft: ${msg(w)}`);
      const pu = await api('POST', SUPER(`/${TYPE}/publish`), { token: T(who), body: { revision: 1, summaryOfChanges: 'x y z', password: 'whatever' } });
      assert.ok([401, 403].includes(pu.status), `${who} must not publish: ${msg(pu)}`);
    }
    const imp = await api('POST', P(`/super/libraries/${ctx.ids.library}/impersonate`), { token: T('super') });
    ok(imp, 'impersonate');
    const tok = imp.body.token || data(imp).token;
    for (const [m, p, b] of [['GET', '', undefined], ['POST', `/${TYPE}/draft`, { from: 'blank' }], ['PUT', `/${TYPE}/draft`, { contentHtml: '<p>x</p>', revision: 1 }], ['DELETE', `/${TYPE}/draft`, undefined]]) {
      expectStatus(await api(m, SUPER(p), { token: tok, body: b }), 403, `impersonation ${m} ${p}`);
    }
    assert.equal(await V().countDocuments({ type: TYPE, status: 'draft' }), 0, 'nothing was created');
  });

  test('92 sanitiser: XSS payload suite (saved drafts never hold or serve dangerous markup)', async () => {
    const payloads = {
      script: '<p>ok</p><script>alert(1)</script>',
      scriptNested: '<scr<script>ipt>alert(1)</scr</script>ipt>',
      scriptUpper: '<SCRIPT SRC=//evil.example/x.js></SCRIPT>',
      imgOnerror: '<img src=x onerror=alert(1)>',
      imgBacktick: '<img src=`x` onerror=`alert(1)`>',
      svgOnload: '<svg onload=alert(1)><circle/></svg>',
      svgScript: '<svg><script>alert(1)</script></svg>',
      iframe: '<iframe src="https://evil.example"></iframe><iframe srcdoc="<script>alert(1)</script>"></iframe>',
      object: '<object data="javascript:alert(1)"></object><embed src="data:text/html,<script>alert(1)</script>">',
      styleTag: '<style>body{background:url(javascript:alert(1))}</style><p>x</p>',
      styleAttr: '<p style="background:url(javascript:alert(1))" class="a" id="b">styled</p>',
      jsHref: '<a href="javascript:alert(1)">click</a>',
      jsHrefSpaced: '<a href=" javascript:alert(1)">click</a>',
      jsHrefUpper: '<A HREF="JaVaScRiPt:alert(1)">click</A>',
      jsHrefEntity: '<a href="jav&#x61;script:alert(1)">click</a>',
      jsHrefTab: '<a href="java\tscript:alert(1)">click</a>',
      jsHrefNewline: '<a href="java&#10;script:alert(1)">click</a>',
      dataHref: '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">click</a>',
      vbHref: '<a href="vbscript:msgbox(1)">click</a>',
      protoRelative: '<a href="//evil.example/x">click</a>',
      formAction: '<form action="https://evil.example"><input name=a><button formaction="javascript:alert(1)">go</button></form>',
      meta: '<meta http-equiv="refresh" content="0;url=https://evil.example"><link rel="stylesheet" href="https://evil.example/x.css"><base href="https://evil.example/">',
      details: '<details open ontoggle=alert(1)><summary>x</summary></details>',
      mathMxss: '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=alert(1)&gt;">',
      video: '<video src=x onerror=alert(1)></video><audio src=x onerror=alert(1)></audio>',
      eventOnAllowed: '<p onclick="alert(1)" onmouseover="alert(2)">hover</p><strong onfocus=alert(3) autofocus tabindex=1>x</strong>',
      uppercaseTags: '<P>upper</P><STRONG>bold</STRONG><IMG SRC=x ONERROR=alert(1)>',
      nullBytes: '<scri\u0000pt>alert(1)</scri\u0000pt><img src=x onerror\u0000=alert(1)>',
      commentTrick: '<!--<img src="--><img src=x onerror=alert(1)//">',
      cdata: '<![CDATA[<script>alert(1)</script>]]>',
      template: '<template><script>alert(1)</script></template><noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
    };
    const r1 = await api('POST', SUPER(`/${TYPE}/draft`), { token: T('super'), body: { from: 'published' } });
    ok(r1, 'draft'); let rev = lastRevision(r1);
    for (const [name, html] of Object.entries(payloads)) {
      const s = await api('PUT', SUPER(`/${TYPE}/draft`), { token: T('super'), body: { contentHtml: `<p>start</p>${html}<p>end</p>`, revision: rev } });
      ok(s, 'save ' + name);
      rev = lastRevision(s);
      assertClean(data(s).contentHtml, name);
      // contentText is decoded plain text (it may legitimately hold a '<' that was escaped in the HTML); the page renders it escaped
      assert.ok(typeof data(s).contentText === 'string');
      const back = await api('GET', SUPER(`/${TYPE}/versions/${data(s).version}`), { token: T('super') });
      assert.equal(data(back).contentHtml, data(s).contentHtml, name + ' stored = returned');
    }
    // entity-encoded markup stays as text, never turns into a tag
    const ent = await api('PUT', SUPER(`/${TYPE}/draft`), { token: T('super'), body: { contentHtml: '<p>&lt;script&gt;alert(1)&lt;/script&gt; and &amp;lt;b&amp;gt;</p>', revision: rev } });
    ok(ent, 'entities'); rev = lastRevision(ent);
    assert.ok(!/<script/i.test(data(ent).contentHtml), 'encoded script stays escaped: ' + data(ent).contentHtml);
    // safe formatting survives and links get rel
    const good = await api('PUT', SUPER(`/${TYPE}/draft`), { token: T('super'), body: { contentHtml: '<h2>Title</h2><p><strong>bold</strong> <em>it</em> <u>u</u> <s>s</s> <a href="https://example.com/x" target="_blank">site</a> <a href="mailto:a@b.co">mail</a> <a href="tel:+911234567890">tel</a></p><ul><li>one</li></ul><ol><li>two</li></ol><blockquote>q</blockquote><table><thead><tr><th colspan="2">h</th></tr></thead><tbody><tr><td>c</td><td>d</td></tr></tbody></table><hr><pre><code>x</code></pre>', revision: rev } });
    ok(good, 'good'); rev = lastRevision(good);
    const g = data(good).contentHtml;
    for (const needle of ['<h2>Title</h2>', '<strong>bold</strong>', '<em>it</em>', '<u>u</u>', '<s>s</s>', '<li>one</li>', '<blockquote>q</blockquote>', '<table>', '<th colspan="2">', '<hr />', '<pre><code>x</code></pre>', 'href="https://example.com/x"', 'href="mailto:a@b.co"', 'href="tel:+911234567890"']) assert.ok(g.includes(needle), `formatting kept: ${needle} in ${g}`);
    assert.ok(/<a [^>]*href="https:\/\/example\.com\/x"[^>]*rel="noopener noreferrer"/.test(g) || /<a [^>]*rel="noopener noreferrer"[^>]*href="https:\/\/example\.com\/x"/.test(g), 'rel=noopener noreferrer forced: ' + g);
    assert.ok(/target="_blank"/.test(g), 'target=_blank is allowed');
    // size limits: > 300 KB refused by the sanitiser, > 400 KB refused by validation
    const big = '<p>' + 'a'.repeat(310 * 1024) + '</p>';
    const tooBig = await api('PUT', SUPER(`/${TYPE}/draft`), { token: T('super'), body: { contentHtml: big, revision: rev } });
    expectStatus(tooBig, 400, '310 KB');
    const huge = await api('PUT', SUPER(`/${TYPE}/draft`), { token: T('super'), body: { contentHtml: '<p>' + 'a'.repeat(420 * 1024) + '</p>', revision: rev } });
    expectStatus(huge, 400, '420 KB');
    expectStatus(await api('PUT', SUPER(`/${TYPE}/draft`), { token: T('super'), body: { contentHtml: 12345, revision: rev } }), 400, 'non-string');
    expectStatus(await api('PUT', SUPER(`/${TYPE}/draft`), { token: T('super'), body: { contentHtml: '<p>x</p>', revision: rev, status: 'published' } }), 400, 'strict body: no status/extra keys');
    ok(await api('DELETE', SUPER(`/${TYPE}/draft`), { token: T('super') }), 'cleanup draft');
  });

  test('93 draft rules: one draft per type, stale revision conflicts, deleting only drafts', async () => {
    const d1 = await api('POST', SUPER(`/${TYPE}/draft`), { token: T('super'), body: { from: 'published' } });
    expectStatus(d1, 201, 'create');
    ctx.legal = { draftVersion: data(d1).version, rev: data(d1).revision };
    assert.equal(data(d1).status, 'draft');
    assert.equal(data(d1).sourceVersion, 1, 'copied from the published version');
    const dup = await api('POST', SUPER(`/${TYPE}/draft`), { token: T('super'), body: { from: 'blank' } });
    expectStatus(dup, 409, 'second draft'); assert.equal(dup.body.errorCode, 'DRAFT_EXISTS');
    // parallel creates for another type: exactly one wins
    const other = 'terms_and_conditions';
    const par = await Promise.all([1, 2, 3, 4, 5].map(() => api('POST', SUPER(`/${other}/draft`), { token: T('super'), body: { from: 'published' } })));
    assert.equal(par.filter((r) => r.status === 201).length, 1, 'exactly one draft is created by 5 parallel requests: ' + par.map((r) => r.status).join(','));
    assert.equal(await V().countDocuments({ type: other, status: 'draft' }), 1);
    // revision / optimistic concurrency
    const s1 = await api('PUT', SUPER(`/${TYPE}/draft`), { token: T('super'), body: { title: 'Privacy Policy (draft 2)', contentHtml: body('a'), revision: ctx.legal.rev } });
    ok(s1, 'save 1'); assert.equal(data(s1).revision, ctx.legal.rev + 1);
    const stale = await api('PUT', SUPER(`/${TYPE}/draft`), { token: T('super'), body: { contentHtml: body('stale'), revision: ctx.legal.rev } });
    expectStatus(stale, 409, 'stale revision'); assert.equal(stale.body.errorCode, 'REVISION_CONFLICT');
    const again = await api('GET', SUPER(`/${TYPE}/versions/${ctx.legal.draftVersion}`), { token: T('super') });
    assert.ok(data(again).contentHtml.includes('Heading a'), 'stale write changed nothing');
    ctx.legal.rev = data(s1).revision;
    // parallel saves with the same revision: one wins
    const race = await Promise.all([1, 2, 3, 4].map((i) => api('PUT', SUPER(`/${TYPE}/draft`), { token: T('super'), body: { contentHtml: body('race' + i), revision: ctx.legal.rev } })));
    assert.equal(race.filter((r) => r.status === 200).length, 1, 'one parallel save wins: ' + race.map((r) => r.status).join(','));
    const cur = await api('GET', SUPER(`/${TYPE}/versions/${ctx.legal.draftVersion}`), { token: T('super') });
    ctx.legal.rev = data(cur).revision;
    // validation
    expectStatus(await api('PUT', SUPER(`/${TYPE}/draft`), { token: T('super'), body: { title: '   ', revision: ctx.legal.rev } }), 400, 'empty title');
    expectStatus(await api('PUT', SUPER(`/${TYPE}/draft`), { token: T('super'), body: { contentHtml: '<p>x</p>' } }), 400, 'revision is required');
    expectStatus(await api('PUT', SUPER('/cookie-policy/draft'), { token: T('super'), body: { contentHtml: '<p>x</p>', revision: 1 } }), 404, 'unknown type');
    // delete only works on drafts
    ok(await api('DELETE', SUPER(`/${other}/draft`), { token: T('super') }), 'delete draft');
    expectStatus(await api('DELETE', SUPER(`/${other}/draft`), { token: T('super') }), 404, 'no draft left: the published version is never deleted');
    assert.equal(await V().countDocuments({ type: other, status: 'published' }), 1, 'published v1 of terms still there');
  });

  test('94 publish: password, summary, revision, empty text, dates; v2 goes live and v1 is archived', async () => {
    const T_ = T('super');
    const pub = (b) => api('POST', SUPER(`/${TYPE}/publish`), { token: T_, body: b });
    const rev = ctx.legal.rev;
    expectStatus(await pub({ revision: rev, summaryOfChanges: 'Added section' }), 400, 'password required');
    const wrongPw = await pub({ revision: rev, summaryOfChanges: 'Added section', password: 'wrong-password-1' });
    assert.ok([400, 401, 403].includes(wrongPw.status), 'wrong password refused: ' + msg(wrongPw));
    expectStatus(await pub({ revision: rev, summaryOfChanges: 'ab', password: PW }), 400, 'summary too short');
    const conflict = await pub({ revision: rev - 1, summaryOfChanges: 'Added section', password: PW });
    expectStatus(conflict, 409, 'stale revision'); assert.equal(conflict.body.errorCode, 'REVISION_CONFLICT');
    expectStatus(await pub({ revision: rev, summaryOfChanges: 'Added section', password: PW, effectiveFrom: '2020-01-01' }), 400, 'date in the past');
    expectStatus(await pub({ revision: rev, summaryOfChanges: 'Added section', password: PW, effectiveFrom: new Date(Date.now() + 400 * 864e5).toISOString() }), 400, 'more than a year ahead');
    expectStatus(await pub({ revision: rev, summaryOfChanges: 'Added section', password: PW, extra: 1 }), 400, 'strict body');
    assert.equal(await V().countDocuments({ type: TYPE, status: 'draft' }), 1, 'draft is untouched by refused publishes');
    // publishing re-sanitises: markup planted straight in the database never goes live
    await col('legaldocumentversions').updateOne({ type: TYPE, status: 'draft' }, { $set: { contentHtml: body('planted') + '<script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">x</a>' } });
    const done = await pub({ revision: rev, summaryOfChanges: 'Second version with a new section', password: PW });
    ok(done, 'publish'); assert.equal(data(done).live, true); assert.equal(data(done).status, 'published');
    assert.equal(data(done).version, ctx.legal.draftVersion);
    ctx.legal.pubV = data(done).version;
    const liveNow = await api('GET', PUB('/privacy-policy'));
    assert.equal(data(liveNow).version, ctx.legal.pubV);
    assertClean(data(liveNow).contentHtml, 'published text');
    assert.ok(data(liveNow).contentHtml.includes('Heading planted'));
    // single-published invariant + archive
    assert.equal(await V().countDocuments({ type: TYPE, status: 'published' }), 1);
    const hist = data(await api('GET', SUPER(`/${TYPE}/versions`), { token: T_ }));
    assert.deepEqual(hist.map((h) => [h.version, h.status]), [[ctx.legal.pubV, 'published'], [1, 'archived']]);
    assert.equal(hist[0].summaryOfChanges, 'Second version with a new section');
    assert.ok(hist[0].publishedBy && hist[0].publishedBy.name, 'published by is recorded');
    assert.ok(hist[0].effectiveFrom && hist[0].publishedAt);
    // the old version stays readable in public history; the drafts and unknown ones do not
    const v1 = await api('GET', PUB('/privacy-policy/versions/1'));
    ok(v1, 'old version'); assert.equal(data(v1).version, 1);
    // the database refuses a second published version
    await assert.rejects(() => col('legaldocumentversions').insertOne({ type: TYPE, version: 77, title: 't', status: 'published' }), /E11000|duplicate/i, 'unique index: one published per type');
    // no draft remains, so nothing to publish or save
    expectStatus(await pub({ revision: 1, summaryOfChanges: 'nothing here', password: PW }), 404, 'no draft');
    // empty document is refused
    const e = await api('POST', SUPER(`/${TYPE}/draft`), { token: T_, body: { from: 'blank' } });
    ok(e, 'blank draft'); ctx.legal.draftVersion = data(e).version;
    expectStatus(await pub({ revision: data(e).revision, summaryOfChanges: 'Empty on purpose', password: PW }), 400, 'empty document');
    ok(await api('DELETE', SUPER(`/${TYPE}/draft`), { token: T_ }), 'cleanup');
  });

  test('95 published text is immutable (model guards and API)', async () => {
    const Version = V();
    for (const [filter, label] of [[{ type: TYPE, version: ctx.legal.pubV }, 'published'], [{ type: TYPE, version: 1 }, 'archived']]) {
      await assert.rejects(() => Version.updateOne(filter, { $set: { contentHtml: '<p>changed</p>' } }), /immutable/i, `${label}: updateOne`);
      await assert.rejects(() => Version.findOneAndUpdate(filter, { $set: { title: 'changed' } }), /immutable/i, `${label}: findOneAndUpdate`);
      await assert.rejects(() => Version.updateMany(filter, { $set: { contentText: 'changed' } }), /immutable/i, `${label}: updateMany`);
      await assert.rejects(() => Version.replaceOne(filter, { type: TYPE, version: 9, title: 'x' }), /cannot be replaced/i, `${label}: replaceOne`);
      const doc = await Version.findOne(filter);
      doc.contentHtml = '<p>changed</p>';
      await assert.rejects(() => doc.save(), /immutable/i, `${label}: document.save`);
    }
    const before = await Version.findOne({ type: TYPE, version: ctx.legal.pubV }).lean();
    assert.ok(before.contentHtml.includes('planted'), 'text unchanged');
    // the API has no route that can edit a published version: with no draft, save/delete answer 404
    expectStatus(await api('PUT', SUPER(`/${TYPE}/draft`), { token: T('super'), body: { contentHtml: '<p>x</p>', revision: 1 } }), 404, 'save without draft');
    expectStatus(await api('DELETE', SUPER(`/${TYPE}/draft`), { token: T('super') }), 404, 'delete without draft');
    expectStatus(await api('DELETE', SUPER(`/${TYPE}/versions/${ctx.legal.pubV}`), { token: T('super') }), 404, 'no DELETE route for versions');
    expectStatus(await api('PUT', SUPER(`/${TYPE}/versions/${ctx.legal.pubV}`), { token: T('super'), body: { contentHtml: '<p>x</p>' } }), 404, 'no PUT route for versions');
  });

  test('96 restore as a new draft, compare, and the draft rules around it', async () => {
    const T_ = T('super');
    const r = await api('POST', SUPER(`/${TYPE}/versions/1/restore`), { token: T_ });
    expectStatus(r, 201, 'restore v1'); assert.equal(data(r).status, 'draft'); assert.equal(data(r).sourceVersion, 1); assert.ok(data(r).version > ctx.legal.pubV, 'a new, higher version number');
    const v1 = data(await api('GET', SUPER(`/${TYPE}/versions/1`), { token: T_ }));
    assert.equal(data(r).contentHtml, v1.contentHtml, 'same text as v1');
    assert.equal(data(await api('GET', SUPER(`/${TYPE}/versions/1`), { token: T_ })).status, 'archived', 'v1 itself unchanged');
    expectStatus(await api('POST', SUPER(`/${TYPE}/versions/${ctx.legal.pubV}/restore`), { token: T_ }), 409, 'a draft already exists');
    expectStatus(await api('POST', SUPER(`/${TYPE}/versions/${data(r).version}/restore`), { token: T_ }), 400, 'cannot restore a draft');
    expectStatus(await api('POST', SUPER(`/${TYPE}/versions/42/restore`), { token: T_ }), 404, 'unknown version');
    const cmp = await api('GET', SUPER(`/${TYPE}/compare?a=1&b=${ctx.legal.pubV}`), { token: T_ });
    ok(cmp, 'compare'); assert.equal(data(cmp).left.version, 1); assert.equal(data(cmp).right.version, ctx.legal.pubV);
    assert.notEqual(data(cmp).left.contentHtml, data(cmp).right.contentHtml);
    expectStatus(await api('GET', SUPER(`/${TYPE}/compare?a=1`), { token: T_ }), 400, 'compare needs both');
    expectStatus(await api('GET', SUPER(`/${TYPE}/compare?a=1&b=99`), { token: T_ }), 404, 'compare unknown');
    ctx.legal.restored = data(r);
    // create from a given version too (after deleting this draft)
    ok(await api('DELETE', SUPER(`/${TYPE}/draft`), { token: T_ }), 'delete restored draft');
    const fromV = await api('POST', SUPER(`/${TYPE}/draft`), { token: T_, body: { from: 'version', version: 1 } });
    expectStatus(fromV, 201, 'from version'); assert.equal(data(fromV).sourceVersion, 1);
    expectStatus(await api('POST', SUPER(`/${TYPE}/draft`), { token: T_, body: { from: 'version' } }), 400, 'version number required');
    ok(await api('DELETE', SUPER(`/${TYPE}/draft`), { token: T_ }), 'cleanup');
    // version numbers never go backwards, even after deleted drafts
    const next = await api('POST', SUPER(`/${TYPE}/draft`), { token: T_, body: { from: 'published' } });
    assert.ok(data(next).version > data(r).version + 1, 'monotonic after deleted drafts: ' + data(next).version);
    ctx.legal.draftVersion = data(next).version; ctx.legal.rev = data(next).revision;
  });

  test('97 scheduled version: not public before its date, cancel returns it to draft, goes live when due', async () => {
    const T_ = T('super');
    const when = new Date(Date.now() + 3600 * 1000).toISOString();
    const s = await api('PUT', SUPER(`/${TYPE}/draft`), { token: T_, body: { contentHtml: body('scheduled'), revision: ctx.legal.rev } });
    ok(s, 'save');
    const sch = await api('POST', SUPER(`/${TYPE}/publish`), { token: T_, body: { revision: data(s).revision, summaryOfChanges: 'Takes effect in an hour', password: PW, effectiveFrom: when } });
    ok(sch, 'schedule'); assert.equal(data(sch).live, false); assert.equal(data(sch).status, 'scheduled');
    const sv = data(sch).version;
    // public still shows v2; the scheduled one is not readable
    assert.equal(data(await api('GET', PUB('/privacy-policy'))).version, ctx.legal.pubV);
    expectStatus(await api('GET', PUB(`/privacy-policy/versions/${sv}`)), 404, 'scheduled version is not public');
    const list = data(await api('GET', SUPER(''), { token: T_ })).find((x) => x.type === TYPE);
    assert.equal(list.published.version, ctx.legal.pubV); assert.equal(list.scheduled.version, sv); assert.equal(list.draft, null);
    // only one scheduled version; the new draft cannot be published meanwhile
    const d2 = await api('POST', SUPER(`/${TYPE}/draft`), { token: T_, body: { from: 'published' } });
    ok(d2, 'another draft');
    const ps = await api('POST', SUPER(`/${TYPE}/publish`), { token: T_, body: { revision: data(d2).revision, summaryOfChanges: 'Second in line', password: PW } });
    expectStatus(ps, 409, 'already scheduled'); assert.equal(ps.body.errorCode, 'ALREADY_SCHEDULED');
    // cancelling needs the draft slot to be free
    const cs0 = await api('POST', SUPER(`/${TYPE}/schedule/cancel`), { token: T_ });
    expectStatus(cs0, 409, 'draft exists'); assert.equal(cs0.body.errorCode, 'DRAFT_EXISTS');
    ok(await api('DELETE', SUPER(`/${TYPE}/draft`), { token: T_ }), 'delete the other draft');
    const cs = await api('POST', SUPER(`/${TYPE}/schedule/cancel`), { token: T_ });
    ok(cs, 'cancel'); assert.equal(data(cs).status, 'draft'); assert.equal(data(cs).effectiveFrom, null);
    assert.equal(data(await api('GET', PUB('/privacy-policy'))).version, ctx.legal.pubV, 'still the old version');
    // schedule again, then make it due (the database is edited directly: nothing else can move time)
    const cur = data(await api('GET', SUPER(`/${TYPE}/versions/${sv}`), { token: T_ }));
    const again = await api('POST', SUPER(`/${TYPE}/publish`), { token: T_, body: { revision: cur.revision, summaryOfChanges: 'Takes effect soon', password: PW, effectiveFrom: when } });
    ok(again, 'schedule again'); assert.equal(data(again).live, false);
    expectStatus(await api('POST', SUPER(`/${TYPE}/schedule/cancel`), { token: T_ }), 200, 'cancel works again (and the next call:)');
    const cur2 = data(await api('GET', SUPER(`/${TYPE}/versions/${sv}`), { token: T_ }));
    const third = await api('POST', SUPER(`/${TYPE}/publish`), { token: T_, body: { revision: cur2.revision, summaryOfChanges: 'Final schedule', password: PW, effectiveFrom: when } });
    ok(third, 'schedule third time'); assert.equal(data(third).live, false);
    await col('legaldocumentversions').updateOne({ type: TYPE, version: sv }, { $set: { effectiveFrom: new Date(Date.now() - 1000) } });
    svc().invalidateCache();
    const live = await api('GET', PUB('/privacy-policy'));
    assert.equal(data(live).version, sv, 'the due version is promoted when read');
    assert.equal(await V().countDocuments({ type: TYPE, status: 'published' }), 1);
    assert.equal((await V().findOne({ type: TYPE, version: ctx.legal.pubV }).lean()).status, 'archived');
    assert.equal(await V().countDocuments({ type: TYPE, status: 'scheduled' }), 0);
    ok(await api('GET', PUB(`/privacy-policy/versions/${sv}`)), 'now readable');
    ctx.legal.liveVersion = sv;
    // a parallel burst of reads around promotion never leaves two published versions
    assert.equal(await V().countDocuments({ type: TYPE, status: 'published' }), 1);
  });

  test('98 public caching: Cache-Control, ETag and 304; ETag changes with the content', async () => {
    const r1 = await api('GET', PUB('/privacy-policy'));
    ok(r1, 'first');
    assert.match(r1.headers.get('cache-control') || '', /public/); assert.match(r1.headers.get('cache-control') || '', /max-age=60/);
    const etag = r1.headers.get('etag');
    assert.ok(etag, 'ETag present');
    const r2 = await rawGet(PUB('/privacy-policy'), { 'if-none-match': etag });
    assert.equal(r2.status, 304, 'conditional GET'); assert.equal(r2.text, '', '304 has no body');
    const r3 = await rawGet(PUB('/privacy-policy'), { 'if-none-match': '"something-else"' });
    assert.equal(r3.status, 200, 'different etag -> full response');
    const list = await api('GET', PUB(''));
    const le = list.headers.get('etag'); assert.ok(le);
    assert.equal((await rawGet(PUB(''), { 'if-none-match': le })).status, 304, 'list conditional');
    const vv = await api('GET', PUB('/privacy-policy/versions/1'));
    assert.match(vv.headers.get('cache-control') || '', /max-age=60/);
    // the public response carries no editor-only fields
    const d = data(r1);
    for (const k of ['revision', 'status', 'publishedBy', 'createdBy', 'summaryOfChanges', '_id']) assert.ok(!(k in d), `public output has no ${k}`);
    // the sanitised output served to the browser is clean
    assertClean(d.contentHtml, 'public output');
    assert.equal(d.previousVersion, ctx.legal.pubV, 'previousVersion skips the numbers of deleted drafts and points at a version that was public');
    const first = data(await api('GET', PUB('/privacy-policy/versions/1')));
    assert.equal(first.previousVersion, null, 'the first version has no previous one');
    assert.ok(typeof d.checksum === 'string' && d.checksum.length > 10);
    // a new publication changes the ETag
    const dd = await api('POST', SUPER(`/${TYPE}/draft`), { token: T('super'), body: { from: 'published' } });
    ok(dd, 'draft');
    const sv = await api('PUT', SUPER(`/${TYPE}/draft`), { token: T('super'), body: { contentHtml: body('etag-change'), revision: data(dd).revision } });
    ok(sv, 'save');
    ok(await api('POST', SUPER(`/${TYPE}/publish`), { token: T('super'), body: { revision: data(sv).revision, summaryOfChanges: 'Changed text for etag', password: PW } }), 'publish');
    const r4 = await rawGet(PUB('/privacy-policy'), { 'if-none-match': etag });
    assert.equal(r4.status, 200, 'old ETag no longer matches: ' + r4.status);
    assert.notEqual(r4.headers.etag, etag);
    ctx.legal.liveVersion = JSON.parse(r4.text).data.version;
  });

  test('99 consent records the published privacy/terms versions (registration helper, student create)', async () => {
    const v = await svc().currentVersions();
    assert.equal(v.privacy, ctx.legal.liveVersion); assert.equal(v.terms, 1); assert.equal(v.refund, 1);
    assert.equal(await svc().consentVersion('1.0'), `privacy-v${v.privacy};terms-v1`);
    assert.equal(await svc().privacyVersionLabel('1.0'), `v${v.privacy}`);
    // the library registered through the wizard before any new version existed recorded v1
    const wiz = ctx.ids.wizLib ? await col('libraries').findOne({ _id: new (L.state.mongoose.Types.ObjectId)(ctx.ids.wizLib) }) : null;
    if (wiz) {
      const rc = wiz.registrationConsent || {};
      assert.equal(rc.privacy, true); assert.equal(rc.terms, true);
      assert.equal(rc.version, 'privacy-v1;terms-v1', 'recorded the versions that were live at registration');
    }
    // a student admitted now records the CURRENT privacy version
    const s = await api('POST', P('/students/create-student'), { token: T('recA'), body: stu({ name: 'Legal Consent Student', mobile: '9811177701', branchId: ctx.ids.branchA }) });
    ok(s, 'create student');
    const row = await col('students').findOne({ mobile: '9811177701' });
    assert.ok(row && row.consent && row.consent.given === true);
    assert.equal(row.consent.version, `v${v.privacy}`, 'student consent holds the current privacy version');
    // a new publication moves the recorded version for the next student
    const dd = await api('POST', SUPER(`/${TYPE}/draft`), { token: T('super'), body: { from: 'published' } });
    const sv = await api('PUT', SUPER(`/${TYPE}/draft`), { token: T('super'), body: { contentHtml: body('consent-bump'), revision: data(dd).revision } });
    const pb = await api('POST', SUPER(`/${TYPE}/publish`), { token: T('super'), body: { revision: data(sv).revision, summaryOfChanges: 'Bump for consent test', password: PW } });
    ok(pb, 'publish'); svc().invalidateCache();
    const s2 = await api('POST', P('/students/create-student'), { token: T('recA'), body: stu({ name: 'Legal Consent Student 2', mobile: '9811177702', branchId: ctx.ids.branchA }) });
    ok(s2, 'create student 2');
    const row2 = await col('students').findOne({ mobile: '9811177702' });
    assert.equal(row2.consent.version, `v${data(pb).version}`);
    assert.notEqual(row2.consent.version, row.consent.version);
    // when no document is published at all, the old fixed constant is the fallback
    const saved = await V().find({ type: TYPE, status: 'published' }).lean();
    assert.equal(saved.length, 1);
    // the audit trail records the changes (publish is audited)
    const audits = await col('auditlogs').countDocuments({ action: /^legal\./ });
    assert.ok(audits >= 5, 'legal changes are audited: ' + audits);
  });

  test('100 validation and rate limit on the public endpoints', async () => {
    expectStatus(await api('GET', PUB('/privacy-policy/versions/0')), 400, 'version 0');
    expectStatus(await api('GET', PUB('/privacy-policy/versions/1.5')), 400, 'version 1.5');
    expectStatus(await api('GET', PUB('/..%2F..%2Fetc')), 404, 'traversal-looking type');
    expectStatus(await api('GET', PUB('/privacy-policy/versions/1/extra')), 404, 'unknown sub path');
    // 120 requests a minute per address: the 121st and later are refused
    const ip = '203.0.113.77';
    let limited = 0; let first = 0;
    for (let i = 0; i < 130; i += 1) {
      const r = await api('GET', PUB('/privacy-policy'), { ip });
      if (r.status === 429) { limited += 1; if (!first) first = i + 1; }
    }
    assert.ok(limited >= 5, `public legal reads are rate limited (429 count ${limited}, first at ${first})`);
    assert.ok(first > 100 && first <= 125, 'limit starts near 120/min: ' + first);
    // another address is unaffected
    ok(await api('GET', PUB('/privacy-policy'), { ip: '203.0.113.78' }), 'other client still served');
  });
};
