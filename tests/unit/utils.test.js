// Unit tests (no DB, no network): pure helpers used by the fee, student, entitlement and security modules.
process.env.AADHAAR_HASH_SECRET = 'unit-test-secret-not-used-anywhere-else';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const src = (p) => require(path.join(__dirname, '..', '..', 'src', p));
const { r2, fiscalYearKey, computeProration, computeGst, GSTIN_RE } = src('utils/feeMath');
const { isValidAadhaar, verhoeffCheckDigit, maskAadhaar, hashAadhaar } = src('utils/aadhaar');
const { ageOn, isMinor, toBool, minorGuardianIssues } = src('utils/dpdp');
const { normalizeMobile } = src('utils/mobile');
const { planAllowsFeature, effectiveLimit, FEATURE_KEYS } = src('utils/features');
const escapeRegex = src('utils/escapeRegex');

test('r2 rounds money to 2 decimals and treats junk as 0', () => {
  assert.equal(r2(10.005), 10.01);
  assert.equal(r2('12.345'), 12.35);
  assert.equal(r2(undefined), 0);
  assert.equal(r2('abc'), 0);
});

test('fiscalYearKey follows the Indian financial year (1 Apr - 31 Mar, IST)', () => {
  assert.equal(fiscalYearKey(new Date('2026-10-01T00:00:00Z')), '2627');
  assert.equal(fiscalYearKey(new Date('2027-03-31T10:00:00Z')), '2627');
  assert.equal(fiscalYearKey(new Date('2027-04-01T10:00:00Z')), '2728');
  // 31 Mar 20:00 UTC is already 1 Apr 01:30 in India
  assert.equal(fiscalYearKey(new Date('2027-03-31T20:00:00Z')), '2728');
});

test('computeGst splits a GST-inclusive amount (CGST+SGST in state, IGST outside)', () => {
  const intra = computeGst({ gross: 1180, rate: 18, intraState: true });
  assert.deepEqual(intra, { taxableValue: 1000, cgst: 90, sgst: 90, igst: 0, totalTax: 180 });
  const inter = computeGst({ gross: 1180, rate: 18, intraState: false });
  assert.deepEqual(inter, { taxableValue: 1000, cgst: 0, sgst: 0, igst: 180, totalTax: 180 });
  assert.equal(inter.taxableValue + inter.totalTax, 1180, 'taxable + tax always equals the gross');
  assert.deepEqual(computeGst({ gross: 500, rate: 0 }), { taxableValue: 500, cgst: 0, sgst: 0, igst: 0, totalTax: 0 });
  assert.deepEqual(computeGst({ gross: -50, rate: 18 }), { taxableValue: 0, cgst: 0, sgst: 0, igst: 0, totalTax: 0 });
});

test('computeGst odd paise: CGST + SGST add up to the total tax exactly', () => {
  const g = computeGst({ gross: 100.01, rate: 18, intraState: true });
  assert.equal(r2(g.cgst + g.sgst), g.totalTax);
});

test('computeProration credits whole unused days, rounded up in the student\'s favour', () => {
  const periodStart = new Date('2026-10-01T00:00:00+05:30');
  const periodEnd = new Date('2026-10-30T23:59:59.999+05:30'); // 30 days
  const full = computeProration({ netAmount: 3000, periodStart, periodEnd, asOf: new Date('2026-09-20T00:00:00Z') });
  assert.equal(full.credit, 3000, 'plan not started: everything is credited');
  const over = computeProration({ netAmount: 3000, periodStart, periodEnd, asOf: new Date('2026-12-01T00:00:00Z') });
  assert.equal(over.credit, 0, 'period over: nothing left');
  const half = computeProration({ netAmount: 3000, periodStart, periodEnd, asOf: new Date('2026-10-16T00:00:00+05:30') });
  assert.ok(half.credit > 1400 && half.credit < 1600, 'about half is left: ' + half.credit);
  assert.equal(r2(half.credit + half.used), 3000, 'credit + used = amount');
  assert.deepEqual(computeProration({ netAmount: 500 }), { totalDays: 0, remainingDays: 0, credit: 0, used: 500 });
});

test('GSTIN pattern accepts a valid number and refuses bad ones', () => {
  assert.ok(GSTIN_RE.test('29ABCDE1234F1Z5'));
  assert.ok(!GSTIN_RE.test('29abcde1234f1z5'), 'lower case');
  assert.ok(!GSTIN_RE.test('29ABCDE1234F1Z'), 'too short');
  assert.ok(!GSTIN_RE.test('XX ABCDE1234F1Z5'));
});

test('Aadhaar: Verhoeff checksum, first digit and formatting rules', () => {
  const base = '23456789012';
  const good = base + verhoeffCheckDigit(base);
  assert.ok(isValidAadhaar(good), 'checksum built by the same algorithm is accepted');
  assert.ok(isValidAadhaar(good.replace(/(\d{4})(\d{4})(\d{4})/, '$1 $2 $3')), 'spaces are ignored');
  const wrong = good.slice(0, 11) + String((Number(good[11]) + 1) % 10);
  assert.ok(!isValidAadhaar(wrong), 'a wrong last digit is refused');
  assert.ok(!isValidAadhaar('123456789012'), 'cannot start with 1');
  assert.ok(!isValidAadhaar('0' + good.slice(1)), 'cannot start with 0');
  assert.ok(!isValidAadhaar('2345678901'), 'too short');
  assert.ok(!isValidAadhaar(''));
});

test('Aadhaar: masking shows only the last 4 and hashes are per library', () => {
  assert.equal(maskAadhaar('1234'), 'XXXX XXXX 1234');
  assert.equal(maskAadhaar(''), '');
  const a = hashAadhaar('234567890124', 'lib1');
  assert.equal(a, hashAadhaar('234567890124', 'lib1'), 'stable');
  assert.notEqual(a, hashAadhaar('234567890124', 'lib2'), 'different library, different hash');
  assert.ok(!String(a).includes('234567890124'), 'the number is never stored in clear');
  delete process.env.AADHAAR_HASH_SECRET;
  const jwt = process.env.JWT_SECRET;
  delete process.env.JWT_SECRET;
  assert.throws(() => hashAadhaar('234567890124', 'lib1'), /not configured/, 'no secret configured: refuses to hash instead of using a weak default');
  process.env.AADHAAR_HASH_SECRET = 'unit-test-secret-not-used-anywhere-else';
  if (jwt !== undefined) process.env.JWT_SECRET = jwt;
});

test('DPDP: age, minors and guardian rules', () => {
  const now = new Date('2026-10-26T00:00:00Z');
  assert.equal(ageOn('2008-10-26', now), 18, 'turns 18 today');
  assert.equal(ageOn('2008-10-27', now), 17, 'one day short of 18');
  assert.equal(ageOn('', now), null);
  assert.equal(ageOn('not-a-date', now), null);
  assert.equal(isMinor('2012-01-01', now), true);
  assert.equal(isMinor('2000-01-01', now), false);
  assert.equal(isMinor(undefined, now), false, 'unknown age is not treated as a minor');
  assert.deepEqual(minorGuardianIssues({ name: 'P', mobile: '9811100099', consentGiven: true }), []);
  const issues = minorGuardianIssues({ name: ' ', mobile: '12345', consentGiven: false }).map((i) => i.path);
  assert.deepEqual(issues, ['guardianName', 'guardianMobile', 'guardianConsentGiven']);
  assert.equal(toBool('true'), true);
  assert.equal(toBool('on'), true);
  assert.equal(toBool('false'), false);
  assert.equal(toBool(undefined), false);
});

test('normalizeMobile strips +91, 0 and separators', () => {
  for (const v of ['+91 98765 43210', '09876543210', '98765-43210', '919876543210', ' 9876543210 ', '+919876543210']) {
    assert.equal(normalizeMobile(v), '9876543210', v);
  }
  assert.equal(normalizeMobile(undefined), undefined);
  assert.equal(normalizeMobile('12345'), '12345', 'unrecognised numbers are only cleaned');
});

test('entitlements: feature list and limits (0 = unlimited only for staff and branches)', () => {
  assert.equal(planAllowsFeature([], FEATURE_KEYS.exports), true, 'a plan with no entitlement keys allows everything');
  assert.equal(planAllowsFeature(['custom marketing text'], FEATURE_KEYS.exports), true);
  assert.equal(planAllowsFeature([FEATURE_KEYS.whatsapp], FEATURE_KEYS.exports), false);
  assert.equal(planAllowsFeature([FEATURE_KEYS.whatsapp.toUpperCase()], FEATURE_KEYS.whatsapp), true, 'case-insensitive');
  assert.equal(effectiveLimit({ maxStudents: 100 }, 'maxStudents'), 100);
  assert.equal(effectiveLimit({ maxStudents: 0 }, 'maxStudents'), 0, 'students: 0 is a real limit');
  assert.equal(effectiveLimit({ maxStaff: 0 }, 'maxStaff'), null, 'staff: 0 means unlimited');
  assert.equal(effectiveLimit({ maxBranches: 0 }, 'maxBranches'), null);
  assert.equal(effectiveLimit({}, 'maxSeats'), null, 'missing means no limit');
  assert.equal(effectiveLimit(null, 'maxSeats'), null);
  assert.equal(effectiveLimit({ maxSeats: 5 }, 'notAKey'), null);
});

test('escapeRegex neutralises search input used in $regex queries', () => {
  const evil = '.*(a+)+$';
  const re = new RegExp(escapeRegex(evil));
  assert.ok(re.test(evil));
  assert.ok(!re.test('anything else'));
  assert.equal(escapeRegex(), '');
});
