const mongoose = require('mongoose');
const VendorProduct = require('../src/modules/vendorProducts/vendorProduct.model');
const Vendor = require('../src/modules/vendors/vendor.model');
const config = require('../src/config/config');

async function findMissing() {
    try {
        await mongoose.connect(config.mongoose.url);
        const missingNames = [
            'amul fresh curd',
            'amul fresh paneer',
            'amul butter',
            'amul masti buttermilk'
        ];

        for (const name of missingNames) {
            const regex = new RegExp('^' + name + '$', 'i');
            const vps = await VendorProduct.find({ name: regex, isDeleted: false, status: true }).populate('vendorId', 'businessName');
            console.log(`\nProduct: ${name}`);
            if (vps.length === 0) {
                console.log("- Not found in system");
            } else {
                vps.forEach(vp => {
                    console.log(`- Vendor: ${vp.vendorId?.businessName} (${vp.masterCategory})`);
                });
            }
        }

        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

findMissing();
