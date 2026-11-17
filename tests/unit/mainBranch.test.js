// Every new library gets a main branch named after its city; students and seats default to it, content does not.
const test = require('node:test');
const assert = require('node:assert');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);
const mongoose = require('mongoose');

const Branch = require('../../src/models/branch.model');
const made = [];
let existing = false;
Branch.exists = async () => existing;
Branch.create = async (d) => { made.push(d); return d; };
Branch.findOne = () => ({ select: () => ({ lean: async () => ({ _id: 'MAIN' }) }) });

const svc = require('../../src/services/branch.service');
const { branchForCreate } = require('../../src/utils/branchScope');
const lib = {
    _id: new mongoose.Types.ObjectId(), city: 'Udaipur', address: '12 Lake Rd', state: 'Rajasthan', pincode: '313001',
    mobile: '9876543210', email: 'm9876543210@noemail.dddesk.invalid', workingHours: { openingTime: '07:00 AM', closingTime: '10:00 PM' },
};

test('main branch: named after the city, with the library details', async () => {
    existing = false; made.length = 0;
    await svc.createMainBranch(lib);
    const b = made[0];
    assert.strictEqual(b.name, 'Udaipur');
    assert.strictEqual(b.isMain, true);
    assert.deepStrictEqual([b.address, b.pincode, b.mobile, b.openingTime, b.closingTime], ['12 Lake Rd', '313001', '9876543210', '07:00 AM', '10:00 PM']);
    assert.strictEqual(b.email, '', 'the placeholder login e-mail is not copied');
});

test('main branch: fallbacks and never twice', async () => {
    existing = false; made.length = 0;
    await svc.createMainBranch({ ...lib, city: '' });
    assert.strictEqual(made[0].name, 'Main branch');
    await svc.createMainBranch({ ...lib, workingHours: { openingTime: 'bad', closingTime: 'x' } });
    assert.strictEqual(made[1].openingTime, undefined, 'unreadable hours keep the branch defaults');
    existing = true;
    assert.strictEqual(await svc.createMainBranch(lib), null);
    assert.strictEqual(made.length, 2);
});

test('students/seats default to the main branch; notices stay for every branch', async () => {
    const owner = { userType: 'admin', user: {} };
    assert.strictEqual(await branchForCreate(owner, lib._id, undefined, { mainByDefault: true }), 'MAIN');
    assert.strictEqual(await branchForCreate(owner, lib._id, undefined), null);
});
