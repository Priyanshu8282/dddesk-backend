const mongoose = require('mongoose');
const VendorProduct = require('../src/modules/vendorProducts/vendorProduct.model');
const config = require('../src/config/config');

async function checkGrocery() {
    try {
        await mongoose.connect(config.mongoose.url);

        const groceryProducts = await VendorProduct.find({ masterCategory: 'Grocery', isDeleted: false, status: true });
        console.log("Total Grocery Products (Active):", groceryProducts.length);

        const nameMap = {};
        groceryProducts.forEach(p => {
            const name = p.name.toLowerCase().trim();
            if (!nameMap[name]) nameMap[name] = [];
            nameMap[name].push(p.vendorId);
        });

        console.log("Unique Names Count:", Object.keys(nameMap).length);

        console.log("\nDuplicate Names (showing vendors):");
        for (const [name, vendors] of Object.entries(nameMap)) {
            if (vendors.length > 1) {
                console.log(`- ${name} (x${vendors.length})`);
            }
        }

        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

checkGrocery();
