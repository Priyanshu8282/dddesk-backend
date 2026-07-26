const mongoose = require('mongoose');
const Vendor = require('../src/modules/vendors/vendor.model');
const VendorProduct = require('../src/modules/vendorProducts/vendorProduct.model');
const config = require('../src/config/config');

async function checkAll() {
    try {
        await mongoose.connect(config.mongoose.url);
        const vendor = await Vendor.findOne({ email: 'ms@g.com' });
        console.log("Vendor ID:", vendor._id);

        const allProducts = await VendorProduct.find({ vendorId: vendor._id });
        console.log("Total Products (ALL):", allProducts.length);

        allProducts.forEach(p => {
            console.log(`- ${p.name}: status=${p.status}, isDeleted=${p.isDeleted}`);
        });

        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

checkAll();
