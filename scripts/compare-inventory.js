const mongoose = require('mongoose');
const BaseProduct = require('../src/modules/products/product.model');
const VendorProduct = require('../src/modules/vendorProducts/vendorProduct.model');
const Vendor = require('../src/modules/vendors/vendor.model');
const config = require('../src/config/config');

async function compare() {
    try {
        await mongoose.connect(config.mongoose.url);
        const vendor = await Vendor.findOne({ email: 'ms@g.com' });

        const baseProducts = await BaseProduct.find({ isDeleted: false });
        const vProducts = await VendorProduct.find({ vendorId: vendor._id, isDeleted: false });

        const vProductNames = new Set(vProducts.map(p => p.name.toLowerCase().trim()));

        console.log("Base Products NOT in Vendor Inventory:");
        baseProducts.forEach(bp => {
            if (!vProductNames.has(bp.name.toLowerCase().trim())) {
                console.log(`- ${bp.name}`);
            }
        });

        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

compare();
