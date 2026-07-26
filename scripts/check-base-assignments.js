const mongoose = require('mongoose');
const BaseProduct = require('../src/modules/products/product.model');
const VendorProduct = require('../src/modules/vendorProducts/vendorProduct.model');
const Vendor = require('../src/modules/vendors/vendor.model');
const config = require('../src/config/config');

async function checkBase() {
    try {
        await mongoose.connect(config.mongoose.url);
        const vendor = await Vendor.findOne({ email: 'ms@g.com' });

        const baseGrocery = await BaseProduct.find({ masterCategory: 'Grocery', isDeleted: false });
        console.log("Total Master Grocery Products:", baseGrocery.length);

        const vProducts = await VendorProduct.find({ vendorId: vendor._id, isDeleted: false });
        const vNames = new Set(vProducts.map(p => p.name.toLowerCase().trim()));

        baseGrocery.forEach(bp => {
            const hasIt = vNames.has(bp.name.toLowerCase().trim());
            console.log(`- ${bp.name}: ${hasIt ? 'YES' : 'NO'}`);
        });

        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

checkBase();
