// Unit tests (no DB, no network): request validation rules of the admin-panel modules.
// Each schema is parsed exactly like validate.middleware does: { body, query, params }.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const V = require(path.join(__dirname, '..', '..', 'src', 'validations'));
const ID = '64b7f0c2a1b2c3d4e5f60718';
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

const parse = (schema, parts) => schema.safeParse({ body: {}, query: {}, params: {}, ...parts });
const ok = (schema, parts, label) => {
  const r = parse(schema, parts);
  assert.ok(r.success, `${label || 'valid input'}: ${r.success ? '' : JSON.stringify(r.error.issues.map((i) => i.path.join('.') + ' ' + i.message))}`);
  return r.data;
};
const bad = (schema, parts, label) => assert.ok(!parse(schema, parts).success, `${label}: must be refused`);

test('notices', () => {
  const s = V.noticeValidation.createNotice;
  const d = ok(s, { body: { title: 'Holiday', description: 'Closed on Friday' } });
  assert.equal(d.body.type, 'general', 'type defaults to general');
  assert.equal(d.body.sendTo, 'all', 'audience defaults to all');
  bad(s, { body: { title: 'x', description: 'ok' } }, 'one-letter title');
  bad(s, { body: { title: 'Holiday', description: '' } }, 'empty description');
  bad(s, { body: { title: 'Holiday', description: 'ok', type: 'spam' } }, 'unknown type');
  bad(s, { body: { title: 'Holiday', description: 'x'.repeat(3001) } }, 'description over 3000');
  assert.equal(ok(s, { body: { title: 'Holiday', description: 'ok', sendTo: 'specific' } }).body.sendTo, 'selected', 'legacy "specific" maps to "selected"');
  assert.deepEqual(ok(s, { body: { title: 'Holiday', description: 'ok', targetStudents: `${ID},${ID}` } }).body.targetStudents, [ID, ID], 'comma list is parsed');
  bad(s, { body: { title: 'Holiday', description: 'ok', targetStudents: ['nope'] } }, 'bad id in audience');
  assert.equal(ok(s, { body: { title: 'Holiday', description: 'ok', isPinned: 'true' } }).body.isPinned, true, 'multipart "true"');
  bad(V.noticeValidation.idParam, { params: { id: 'abc' } }, 'bad id');
  ok(V.noticeValidation.idParam, { params: { id: ID } });
});

test('stories', () => {
  const s = V.storyValidation.createStory;
  ok(s, { body: { title: 'New batch', type: 'text', textContent: 'Join', expiresInHours: 24 } });
  bad(s, { body: { title: 'x' } }, 'short title');
  bad(s, { body: { title: 'New batch', expiresInHours: 169 } }, 'over 7 days');
  bad(s, { body: { title: 'New batch', expiresInHours: 0 } }, 'zero hours');
  bad(s, { body: { title: 'New batch', type: 'gif' } }, 'unknown type');
  bad(s, { body: { title: 'New batch', textContent: 'x'.repeat(501) } }, 'text over 500');
  bad(V.storyValidation.reply, { params: { id: ID }, body: { message: '' } }, 'empty reply');
  ok(V.storyValidation.reply, { params: { id: ID }, body: { message: 'Nice' } });
  bad(V.storyValidation.listStories, { query: { limit: '500' } }, 'limit over 100');
  bad(V.storyValidation.listStories, { query: { status: 'deleted' } }, 'unknown status filter');
});

test('banners', () => {
  const s = V.bannerValidation.createBanner;
  const base = { title: 'Admission open', startDate: day(-1), endDate: day(30) };
  const d = ok(s, { body: base });
  assert.equal(d.body.bannerType, 'OTHER');
  assert.equal(d.body.displayLocation, 'both');
  bad(s, { body: { ...base, startDate: '' } }, 'start date required');
  bad(s, { body: { ...base, startDate: day(10), endDate: day(1) } }, 'end before start');
  bad(s, { body: { ...base, ctaUrl: 'javascript:alert(1)' } }, 'javascript: URL');
  bad(s, { body: { ...base, ctaUrl: 'data:text/html,x' } }, 'data: URL');
  ok(s, { body: { ...base, ctaUrl: 'https://example.com/join' } }, 'https URL');
  ok(s, { body: { ...base, ctaUrl: '/dashboard/plans' } }, 'relative URL');
  bad(s, { body: { ...base, bannerType: 'PROMO' } }, 'unknown banner type');
  bad(s, { body: { ...base, priority: 5000 } }, 'priority out of range');
  bad(V.bannerValidation.updateBanner, { params: { id: ID }, body: { startDate: day(5), endDate: day(1) } }, 'update with end before start');
});

test('coupons / offers', () => {
  const s = V.couponValidation.createCoupon;
  const base = { title: 'Festival', code: 'fest10', discountType: 'percentage', discountValue: 10, endDate: day(30) };
  const d = ok(s, { body: base });
  assert.equal(d.body.code, 'FEST10', 'code is upper-cased');
  assert.equal(d.body.offerType, 'general');
  assert.equal(d.body.perStudentLimit, 1);
  bad(s, { body: { ...base, discountValue: 0 } }, 'zero discount');
  bad(s, { body: { ...base, discountType: 'bogus' } }, 'unknown discount type');
  bad(s, { body: { ...base, code: 'A' } }, 'one-letter code');
  bad(s, { body: { ...base, endDate: '' } }, 'expiry required');
  bad(s, { body: { ...base, offerType: 'mystery' } }, 'unknown offer type');
  assert.equal(ok(V.couponValidation.validateCoupon, { body: { code: 'abc', amount: '500' } }).body.code, 'ABC');
  bad(V.couponValidation.validateCoupon, { body: { code: 'abc', amount: 0 } }, 'zero amount');
  bad(V.couponValidation.queryCoupons, { query: { limit: '1000' } }, 'limit over 100');
});

test('enquiries', () => {
  const s = V.enquiryValidation.createEnquiry;
  const d = ok(s, { body: { name: 'Rohit Verma', mobile: '+91 98222-00001', source: 'Walk-In' } });
  assert.equal(d.body.mobile, '9822200001', '+91 and dashes are removed');
  assert.equal(d.body.source, 'walk-in', 'source is lower-cased');
  bad(s, { body: { name: 'A', mobile: '9822200001' } }, 'one-letter name');
  bad(s, { body: { name: 'Rohit', mobile: '5822200001' } }, 'mobile must start 6-9');
  bad(s, { body: { name: 'Rohit', mobile: '98222' } }, 'short mobile');
  bad(s, { body: { name: 'Rohit', mobile: '9822200001', email: 'not-an-email' } }, 'bad email');
  bad(s, { body: { name: 'Rohit', mobile: '9822200001', source: 'telepathy' } }, 'unknown source');
  assert.equal(ok(V.enquiryValidation.updateEnquiry, { params: { id: ID }, body: { status: 'Contacted' } }).body.status, 'contacted');
  bad(V.enquiryValidation.updateEnquiry, { params: { id: ID }, body: { status: 'flying' } }, 'unknown status');
  bad(V.enquiryValidation.addNote, { params: { id: ID }, body: { text: '' } }, 'empty note');
  ok(V.enquiryValidation.addNote, { params: { id: ID }, body: { text: 'Called' } });
});

test('expenses', () => {
  const s = V.expenseValidation.createExpense;
  const d = ok(s, { body: { title: 'Electricity', amount: '2500.50' } });
  assert.equal(d.body.amount, 2500.5, 'string amount is coerced');
  assert.equal(d.body.paymentMethod, 'cash');
  assert.equal(d.body.category, 'other');
  bad(s, { body: { title: 'Electricity', amount: 0 } }, 'zero');
  bad(s, { body: { title: 'Electricity', amount: -5 } }, 'negative');
  bad(s, { body: { title: 'Electricity', amount: 10.123 } }, 'three decimals');
  bad(s, { body: { title: 'Electricity', amount: 1e9 } }, 'too large');
  bad(s, { body: { title: 'E', amount: 10 } }, 'short title');
  bad(s, { body: { title: 'Electricity', amount: 10, paymentMethod: 'barter' } }, 'unknown method');
  bad(V.expenseValidation.updateExpense, { params: { id: 'xyz' }, body: { amount: 10 } }, 'bad id');
});

test('complaints', () => {
  const s = V.complaintValidation.createComplaint;
  const d = ok(s, { body: { title: 'AC not cooling', description: 'Hall 2 AC is not cooling' } });
  assert.equal(d.body.category, 'other');
  assert.equal(d.body.priority, 'medium');
  bad(s, { body: { title: 'x', description: 'long enough' } }, 'short title');
  bad(s, { body: { title: 'AC not cooling', description: 'x' } }, 'short description');
  bad(s, { body: { title: 'AC not cooling', description: 'long enough', priority: 'asap' } }, 'unknown priority');
  bad(s, { body: { title: 'AC not cooling', description: 'long enough', category: 'ghosts' } }, 'unknown category');
  ok(V.complaintValidation.updateStatus, { params: { id: ID }, body: { status: 'resolved', resolutionNote: 'Fixed', cost: '800' } });
  bad(V.complaintValidation.updateStatus, { params: { id: ID }, body: { status: 'exploded' } }, 'unknown status');
  bad(V.complaintValidation.updateStatus, { params: { id: ID }, body: { status: 'resolved', cost: -1 } }, 'negative cost');
  bad(V.complaintValidation.assignComplaint, { params: { id: ID }, body: { assignedTo: 'nobody' } }, 'bad staff id');
  bad(V.complaintValidation.addNote, { params: { id: ID }, body: { message: '' } }, 'empty note');
});
