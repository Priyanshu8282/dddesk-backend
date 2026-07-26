const mongoose = require('mongoose');
const Vendor = require('../src/modules/vendors/vendor.model');
const VendorProduct = require('../src/modules/vendorProducts/vendorProduct.model');
const config = require('../src/config/config');

async function checkCounts() {
    try {
        await mongoose.connect(config.mongoose.url);
        const vendor = await Vendor.findOne({ email: 'ms@g.com' });
        if (!vendor) {
            console.error("Vendor not found");
            process.exit(1);
        }
        console.log("Vendor ID:", vendor._id, "Business:", vendor.businessName);

        const products = await VendorProduct.find({ vendorId: vendor._id, isDeleted: false });
        console.log("Total VendorProducts in DB:", products.length);

        const names = products.map(p => p.name);
        console.log("Product Names:", JSON.stringify(names, null, 2));

        const uniqueNames = new Set(names.map(n => n?.toLowerCase().trim()));
        console.log("Unique Names Count (after trim/lower):", uniqueNames.size);
        console.log("Deduplicated Names:", Array.from(uniqueNames));

        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

checkCounts();
