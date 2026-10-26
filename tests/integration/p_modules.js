// Part: admin-panel modules that had no functional tests (notices, stories, banners, offers/coupons, enquiries, expenses,
// complaints, reviews, notifications, settings, sidebar). Each module: create -> read -> update -> toggle -> delete,
// validation errors, permission denial (accountant has no content rights) and cross-library isolation (owner2).
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./lib');
const { api, P } = L;

module.exports = (H) => {
  const { ok, expectStatus, data, msg, T, id } = H;
  const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
  const denied = (r, label) => assert.ok([401, 403].includes(r.status), `${label}: expected 401/403, got ${msg(r)}`);
  const hidden = (r, label) => assert.ok([403, 404].includes(r.status), `${label}: another library must not reach it, got ${msg(r)}`);

  test('110 notices: create, list, update, publish/unpublish, delete, validation and isolation', async () => {
    const bad = await api('POST', P('/notices'), { token: T('owner'), body: { title: 'x', description: '' } });
    expectStatus(bad, 400, 'short title + empty description');
    const c = await api('POST', P('/notices'), { token: T('owner'), body: { title: 'Holiday on Friday', description: 'Library closed for Diwali.', type: 'holiday', sendTo: 'all' } });
    ok(c, 'create notice');
    const nid = id(c); assert.ok(nid, msg(c));
    const list = await api('GET', P('/notices'), { token: T('owner') });
    ok(list, 'list'); assert.ok(JSON.stringify(data(list)).includes('Holiday on Friday'), 'created notice is listed');
    ok(await api('GET', P(`/notices/${nid}`), { token: T('owner') }), 'get one');
    const up = await api('PUT', P(`/notices/${nid}`), { token: T('owner'), body: { title: 'Holiday on Saturday' } });
    ok(up, 'update'); assert.ok(JSON.stringify(data(up)).includes('Saturday'), 'title changed: ' + msg(up));
    ok(await api('PATCH', P(`/notices/${nid}/unpublish`), { token: T('owner') }), 'unpublish');
    ok(await api('PATCH', P(`/notices/${nid}/publish`), { token: T('owner') }), 'publish');
    ok(await api('PUT', P(`/notices/toggle/${nid}`), { token: T('owner') }), 'toggle');
    expectStatus(await api('GET', P('/notices/not-an-id'), { token: T('owner') }), 400, 'bad id');
    denied(await api('POST', P('/notices'), { token: T('acct'), body: { title: 'Nope nope', description: 'no rights' } }), 'accountant create');
    denied(await api('GET', P('/notices')), 'anonymous list');
    hidden(await api('GET', P(`/notices/${nid}`), { token: T('owner2') }), 'owner2 reading notice');
    hidden(await api('DELETE', P(`/notices/${nid}`), { token: T('owner2') }), 'owner2 deleting notice');
    ok(await api('DELETE', P(`/notices/${nid}`), { token: T('owner') }), 'delete');
    expectStatus(await api('GET', P(`/notices/${nid}`), { token: T('owner') }), 404, 'gone after delete');
  });

  test('111 stories: create, list, update, toggle, analytics, delete, validation and isolation', async () => {
    expectStatus(await api('POST', P('/stories'), { token: T('owner'), body: { title: 'x' } }), 400, 'short title');
    expectStatus(await api('POST', P('/stories'), { token: T('owner'), body: { title: 'Valid title', expiresInHours: 999 } }), 400, 'expiry over 168h');
    const c = await api('POST', P('/stories'), { token: T('owner'), body: { title: 'New batch starts Monday', type: 'text', textContent: 'Join the morning batch', expiresInHours: 24 } });
    ok(c, 'create story');
    const sid = id(c); assert.ok(sid, msg(c));
    ok(await api('GET', P('/stories'), { token: T('owner') }), 'list');
    ok(await api('GET', P(`/stories/${sid}`), { token: T('owner') }), 'get one');
    ok(await api('PUT', P(`/stories/${sid}`), { token: T('owner'), body: { title: 'New batch starts Tuesday' } }), 'update');
    const s1 = await api('PUT', P(`/stories/toggle/${sid}`), { token: T('owner') });
    ok(s1, 'toggle off');
    const s2 = await api('PUT', P(`/stories/toggle/${sid}`), { token: T('owner') });
    ok(s2, 'toggle on');
    assert.notEqual(JSON.stringify(data(s1).isActive), JSON.stringify(data(s2).isActive), 'two toggles flip the flag each time');
    ok(await api('GET', P('/stories/analytics'), { token: T('owner') }), 'analytics');
    denied(await api('POST', P('/stories'), { token: T('acct'), body: { title: 'Nope nope' } }), 'accountant create');
    hidden(await api('GET', P(`/stories/${sid}`), { token: T('owner2') }), 'owner2 reading story');
    hidden(await api('DELETE', P(`/stories/${sid}`), { token: T('owner2') }), 'owner2 deleting story');
    ok(await api('DELETE', P(`/stories/${sid}`), { token: T('owner') }), 'delete');
    expectStatus(await api('GET', P(`/stories/${sid}`), { token: T('owner') }), 404, 'gone after delete');
  });

  test('112 banners: create, dates validated, list, update, toggle, delete and isolation', async () => {
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
    const mk = (over = {}, withImage = true) => {
      const f = new FormData();
      Object.entries({ title: 'Admission open', description: 'Seats filling fast', bannerType: 'OFFER', displayLocation: 'both', startDate: day(-1), endDate: day(30), ...over }).forEach(([k, v]) => f.append(k, v));
      if (withImage) f.append('image', new Blob([PNG], { type: 'image/png' }), 'banner.png');
      return f;
    };
    expectStatus(await api('POST', P('/banners'), { token: T('owner'), form: mk({}, false) }), 400, 'image required');
    expectStatus(await api('POST', P('/banners'), { token: T('owner'), form: mk({ startDate: '' }) }), 400, 'start date required');
    expectStatus(await api('POST', P('/banners'), { token: T('owner'), form: mk({ startDate: day(10), endDate: day(1) }) }), 400, 'end before start');
    expectStatus(await api('POST', P('/banners'), { token: T('owner'), form: mk({ ctaUrl: 'javascript:alert(1)' }) }), 400, 'unsafe URL refused');
    const c = await api('POST', P('/banners'), { token: T('owner'), form: mk() });
    ok(c, 'create banner');
    const bid = id(c); assert.ok(bid, msg(c));
    const list = await api('GET', P('/banners'), { token: T('owner') });
    ok(list, 'list'); assert.ok(JSON.stringify(data(list)).includes('Admission open'), 'listed');
    ok(await api('PUT', P(`/banners/${bid}`), { token: T('owner'), body: { title: 'Admission open now' } }), 'update');
    const t1 = await api('PATCH', P(`/banners/${bid}/toggle`), { token: T('owner') });
    ok(t1, 'toggle off');
    const t2 = await api('PATCH', P(`/banners/${bid}/toggle`), { token: T('owner') });
    ok(t2, 'toggle on');
    assert.notEqual(JSON.stringify(data(t1).isActive), JSON.stringify(data(t2).isActive), 'two toggles flip the flag each time');
    denied(await api('POST', P('/banners'), { token: T('acct'), form: mk() }), 'accountant create');
    hidden(await api('GET', P(`/banners/${bid}`), { token: T('owner2') }), 'owner2 reading banner');
    hidden(await api('DELETE', P(`/banners/${bid}`), { token: T('owner2') }), 'owner2 deleting banner');
    ok(await api('DELETE', P(`/banners/${bid}`), { token: T('owner') }), 'delete');
    expectStatus(await api('GET', P(`/banners/${bid}`), { token: T('owner') }), 404, 'gone after delete');
  });

  test('113 offers / coupons: create, duplicate code, validate, update, toggle, delete and isolation', async () => {
    const mk = (over = {}) => ({ title: 'Festival 10%', code: 'FEST10', discountType: 'percentage', discountValue: 10, endDate: day(30), ...over });
    expectStatus(await api('POST', P('/coupons'), { token: T('owner'), body: mk({ discountValue: 0 }) }), 400, 'zero discount');
    expectStatus(await api('POST', P('/coupons'), { token: T('owner'), body: mk({ discountType: 'bogus' }) }), 400, 'bad type');
    const c = await api('POST', P('/coupons'), { token: T('owner'), body: mk() });
    ok(c, 'create coupon');
    const cid = id(c); assert.ok(cid, msg(c));
    const dup = await api('POST', P('/coupons'), { token: T('owner'), body: mk() });
    assert.ok(dup.status >= 400 && dup.status < 500, 'a duplicate code in the same library is refused: ' + msg(dup));
    const list = await api('GET', P('/coupons'), { token: T('owner') });
    ok(list, 'list'); assert.ok(JSON.stringify(data(list)).includes('FEST10'), 'listed');
    ok(await api('PUT', P(`/coupons/${cid}`), { token: T('owner'), body: { title: 'Festival 15%', discountValue: 15 } }), 'update');
    ok(await api('PATCH', P(`/coupons/${cid}/toggle`), { token: T('owner') }), 'toggle');
    ok(await api('GET', P('/offers'), { token: T('owner') }), 'the /offers alias works');
    denied(await api('POST', P('/coupons'), { token: T('acct'), body: mk({ code: 'ACCT1' }) }), 'accountant create');
    hidden(await api('GET', P(`/coupons/${cid}`), { token: T('owner2') }), 'owner2 reading coupon');
    hidden(await api('DELETE', P(`/coupons/${cid}`), { token: T('owner2') }), 'owner2 deleting coupon');
    ok(await api('DELETE', P(`/coupons/${cid}`), { token: T('owner') }), 'delete');
  });

  test('114 enquiries: create, validate, list, status, notes, delete and isolation', async () => {
    expectStatus(await api('POST', P('/enquiries'), { token: T('owner'), body: { name: 'A', mobile: '12345' } }), 400, 'bad name + mobile');
    const c = await api('POST', P('/enquiries'), { token: T('owner'), body: { name: 'Rohit Verma', mobile: '9822200001', source: 'walk-in', message: 'Wants a morning seat' } });
    ok(c, 'create enquiry');
    const eid = id(c); assert.ok(eid, msg(c));
    const list = await api('GET', P('/enquiries'), { token: T('owner') });
    ok(list, 'list'); assert.ok(JSON.stringify(data(list)).includes('Rohit Verma'), 'listed');
    ok(await api('PATCH', P(`/enquiries/${eid}`), { token: T('owner'), body: { status: 'contacted' } }), 'status -> contacted');
    expectStatus(await api('PATCH', P(`/enquiries/${eid}`), { token: T('owner'), body: { status: 'flying' } }), 400, 'unknown status');
    ok(await api('POST', P(`/enquiries/${eid}/notes`), { token: T('owner'), body: { text: 'Called, will visit Sunday' } }), 'add note');
    ok(await api('GET', P('/enquiries/stats/conversion'), { token: T('owner') }), 'conversion stats');
    hidden(await api('GET', P(`/enquiries/${eid}`), { token: T('owner2') }), 'owner2 reading enquiry');
    hidden(await api('DELETE', P(`/enquiries/${eid}`), { token: T('owner2') }), 'owner2 deleting enquiry');
    ok(await api('DELETE', P(`/enquiries/${eid}`), { token: T('owner') }), 'delete');
  });

  test('115 expenses: create, amount rules, list, summary, update, delete and isolation', async () => {
    expectStatus(await api('POST', P('/expenses'), { token: T('owner'), body: { title: 'Electricity', amount: -5 } }), 400, 'negative amount');
    expectStatus(await api('POST', P('/expenses'), { token: T('owner'), body: { title: 'Electricity', amount: 10.123 } }), 400, 'three decimals');
    const c = await api('POST', P('/expenses'), { token: T('owner'), body: { title: 'Electricity bill', amount: 2500.5, category: 'utilities', paymentMethod: 'upi' } });
    ok(c, 'create expense');
    const xid = id(c); assert.ok(xid, msg(c));
    const list = await api('GET', P('/expenses'), { token: T('owner') });
    ok(list, 'list'); assert.ok(JSON.stringify(data(list)).includes('Electricity bill'), 'listed');
    ok(await api('GET', P('/expenses/summary'), { token: T('owner') }), 'summary');
    const up = await api('PUT', P(`/expenses/${xid}`), { token: T('owner'), body: { amount: 2600 } });
    ok(up, 'update'); assert.ok(JSON.stringify(data(up)).includes('2600'), 'amount changed: ' + msg(up));
    hidden(await api('GET', P(`/expenses/${xid}`), { token: T('owner2') }), 'owner2 reading expense');
    hidden(await api('DELETE', P(`/expenses/${xid}`), { token: T('owner2') }), 'owner2 deleting expense');
    ok(await api('DELETE', P(`/expenses/${xid}`), { token: T('owner') }), 'delete');
    expectStatus(await api('GET', P(`/expenses/${xid}`), { token: T('owner') }), 404, 'gone after delete');
  });

  test('116 complaints: create, validate, status flow, notes, stats, delete and isolation', async () => {
    expectStatus(await api('POST', P('/complaints'), { token: T('owner'), body: { title: 'x', description: '' } }), 400, 'too short');
    const c = await api('POST', P('/complaints'), { token: T('owner'), body: { title: 'AC not cooling', description: 'The AC in hall 2 is not cooling', category: 'ac', priority: 'high' } });
    ok(c, 'create complaint');
    const cid = id(c); assert.ok(cid, msg(c));
    const list = await api('GET', P('/complaints'), { token: T('owner') });
    ok(list, 'list'); assert.ok(JSON.stringify(data(list)).includes('AC not cooling'), 'listed');
    ok(await api('POST', P(`/complaints/${cid}/notes`), { token: T('owner'), body: { message: 'Technician called' } }), 'add note');
    ok(await api('PATCH', P(`/complaints/${cid}/status`), { token: T('owner'), body: { status: 'in_progress' } }), 'in_progress');
    ok(await api('PATCH', P(`/complaints/${cid}/status`), { token: T('owner'), body: { status: 'resolved', resolutionNote: 'Gas refilled', cost: 800 } }), 'resolved');
    expectStatus(await api('PATCH', P(`/complaints/${cid}/status`), { token: T('owner'), body: { status: 'exploded' } }), 400, 'unknown status');
    ok(await api('GET', P('/complaints/stats'), { token: T('owner') }), 'stats');
    hidden(await api('GET', P(`/complaints/${cid}`), { token: T('owner2') }), 'owner2 reading complaint');
    hidden(await api('DELETE', P(`/complaints/${cid}`), { token: T('owner2') }), 'owner2 deleting complaint');
    ok(await api('DELETE', P(`/complaints/${cid}`), { token: T('owner') }), 'delete');
  });

  test('117 reviews: staff list and stats, student-only submit, anonymous refused', async () => {
    ok(await api('GET', P('/reviews'), { token: T('owner') }), 'list');
    ok(await api('GET', P('/reviews/stats'), { token: T('owner') }), 'stats');
    ok(await api('GET', P('/feedback'), { token: T('owner') }), 'the /feedback alias works');
    denied(await api('GET', P('/reviews')), 'anonymous list');
    const staffPost = await api('POST', P('/reviews'), { token: T('owner'), body: { rating: 5, comment: 'Great' } });
    denied(staffPost, 'staff cannot post a student review');
    hidden(await api('GET', P('/reviews/000000000000000000000000'), { token: T('owner2') }), 'unknown review id');
  });

  test('118 notifications: list, read-all, broadcast validation, push key, anonymous refused', async () => {
    ok(await api('GET', P('/notifications'), { token: T('owner') }), 'list');
    ok(await api('PATCH', P('/notifications/read-all'), { token: T('owner') }), 'read-all');
    expectStatus(await api('POST', P('/notifications/send'), { token: T('owner'), body: { audience: 'everyone', title: 'Hi', message: 'x' } }), 400, 'bad audience + short text');
    const send = await api('POST', P('/notifications/send'), { token: T('owner'), body: { audience: 'all', title: 'Library timing', message: 'We open at 6 AM from tomorrow.', channels: ['inapp'] } });
    ok(send, 'broadcast to students');
    denied(await api('POST', P('/notifications/send'), { token: T('acct'), body: { audience: 'all', title: 'Nope nope', message: 'no rights here' } }), 'accountant broadcast');
    ok(await api('GET', P('/notifications/push/key'), { token: T('owner') }), 'push key');
    denied(await api('GET', P('/notifications')), 'anonymous list');
  });

  test('119 settings and sidebar: read for owner, write only for superadmin, menu follows the role', async () => {
    ok(await api('GET', P('/settings'), { token: T('owner') }), 'owner reads settings');
    denied(await api('POST', P('/settings'), { token: T('owner'), body: { key: 'site.name', value: 'hack' } }), 'owner cannot write platform settings');
    denied(await api('PUT', P('/settings/site.name'), { token: T('owner'), body: { value: 'hack' } }), 'owner cannot put platform settings');
    const own = await api('GET', P('/sidebar/get-menus'), { token: T('owner') });
    ok(own, 'owner menu');
    const ownerMenu = JSON.stringify(data(own));
    assert.ok(ownerMenu.includes('Students') && ownerMenu.includes('Settings'), 'owner sees the full menu');
    const acct = await api('GET', P('/sidebar/get-menus'), { token: T('acct') });
    ok(acct, 'accountant menu');
    assert.ok(!JSON.stringify(data(acct)).includes('Roles & Access'), 'accountant must not see Roles & Access');
    denied(await api('POST', P('/sidebar/create-menu'), { token: T('owner'), body: { title: 'Evil', to: 'evil' } }), 'owner cannot create menus');
    denied(await api('DELETE', P('/sidebar/delete-menu/000000000000000000000000'), { token: T('owner') }), 'owner cannot delete menus');
  });
};
