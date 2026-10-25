// Part: financial-year receipt numbering - legacy counter continues, new FY restarts, parallel first-of-year is unique.
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./lib');

module.exports = (H) => {
  const { ctx } = H;
  const col = (n) => L.state.mongoose.connection.db.collection(n);
  const Oid = (v) => new (L.state.mongoose.Types.ObjectId)(v);

  test('76 receipt numbers: legacy sequence continues, new FY restarts at 1, parallel init is unique', async () => {
    const ledger = require(L.SRC + '/services/feeLedger.service');
    const libId = Oid(ctx.ids.library2);
    await col('receiptcounters').deleteMany({ libraryId: libId });
    // a library that issued 41 receipts before financial-year numbering existed
    await col('receiptcounters').insertOne({ libraryId: libId, seq: 41, createdAt: new Date(), updatedAt: new Date() });
    const first = await ledger.nextReceiptNo(libId, 'receipt', new Date('2026-10-25T10:00:00+05:30'));
    assert.equal(first, 'RCPT-2627-000042', 'continues the old counter in the first financial year after the upgrade');
    const refund = await ledger.nextReceiptNo(libId, 'refund', new Date('2026-10-26T10:00:00+05:30'));
    assert.equal(refund, 'RCPT-R-2627-000043', 'refund receipts share the sequence');
    // IST boundaries: 31 Mar 23:59 IST is still FY 26-27; 1 Apr 00:00 IST starts FY 27-28
    assert.match(await ledger.nextReceiptNo(libId, 'receipt', new Date('2027-03-31T23:59:00+05:30')), /^RCPT-2627-000044$/);
    assert.equal(await ledger.nextReceiptNo(libId, 'receipt', new Date('2027-04-01T00:00:00+05:30')), 'RCPT-2728-000001', 'new financial year restarts at 1');
    // utc 31 Mar 19:00 = 1 Apr 00:30 IST -> already the new year
    assert.equal(await ledger.nextReceiptNo(libId, 'receipt', new Date('2027-03-31T19:00:00Z')), 'RCPT-2728-000002');
    // 30 parallel first receipts of a brand-new year: unique, gap-free 1..30
    const all = await Promise.all(Array.from({ length: 30 }, () => ledger.nextReceiptNo(libId, 'receipt', new Date('2028-05-01T10:00:00+05:30'))));
    assert.equal(new Set(all).size, 30, 'unique under a parallel first-of-year initialisation: ' + all.join(','));
    const nums = all.map((x) => Number(x.split('-').pop())).sort((a, b) => a - b);
    assert.deepEqual(nums, Array.from({ length: 30 }, (_, i) => i + 1), 'no gaps, starts at 1');
    // a library with a configured starting number
    const libCfg = Oid(ctx.ids.library);
    await col('receiptcounters').deleteMany({ libraryId: libCfg });
    await col('libraries').updateOne({ _id: libCfg }, { $set: { 'receipt.nextNumber': 500, 'receipt.prefix': 'DD' } });
    assert.equal(await ledger.nextReceiptNo(libCfg, 'receipt', new Date('2026-10-25T10:00:00+05:30')), 'DD-2627-000500', 'configured start number and prefix honoured');
    await col('libraries').updateOne({ _id: libCfg }, { $set: { 'receipt.nextNumber': 1, 'receipt.prefix': 'RCPT' } });
  });
};
