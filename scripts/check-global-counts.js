const mongoose = require('mongoose');
const BaseProduct = require('../src/modules/products/product.model');
const VendorProduct = require('../src/modules/vendorProducts/vendorProduct.model');
const Vendor = require('../src/modules/vendors/vendor.model');
const config = require('../src/config/config');

async function checkGlobal() {
    try {
        await mongoose.connect(config.mongoose.url);

        const baseProducts = await BaseProduct.find({ isDeleted: false });
        console.log("Total Base Products in DB:", baseProducts.length);

        const vendors = await Vendor.find({ isDeleted: false });
        console.log("Total Vendors in DB:", vendors.length);

        for (const v of vendors) {
            const vProducts = await VendorProduct.countDocuments({ vendorId: v._id, isDeleted: false });
            console.log(`- Vendor: ${v.businessName} (${v.email}): ${vProducts} products`);
        }

        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

checkGlobal();
