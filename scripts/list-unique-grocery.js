const mongoose = require('mongoose');
const VendorProduct = require('../src/modules/vendorProducts/vendorProduct.model');
const Vendor = require('../src/modules/vendors/vendor.model');
const config = require('../src/config/config');

async function listNames() {
    try {
        await mongoose.connect(config.mongoose.url);
        const vendor = await Vendor.findOne({ email: 'ms@g.com' });

        const allGrocery = await VendorProduct.find({ masterCategory: 'Grocery', isDeleted: false, status: true });
        const uniqueNames = Array.from(new Set(allGrocery.map(p => p.name.toLowerCase().trim())));
        console.log("All Unique Grocery Names in System:", uniqueNames);

        const vProducts = await VendorProduct.find({ vendorId: vendor._id, isDeleted: false });
        const vNames = new Set(vProducts.map(p => p.name.toLowerCase().trim()));

        console.log("\nProducts NOT in ms@g.com Inventory:");
        uniqueNames.forEach(name => {
            if (!vNames.has(name)) {
                console.log(`- ${name}`);
            }
        });

        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

listNames();
