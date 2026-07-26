const mongoose = require('mongoose');
const Order = require('../src/modules/orders/order.model');
const VendorProduct = require('../src/modules/vendorProducts/vendorProduct.model');
const VendorProductVariant = require('../src/modules/vendorProducts/vendorProductVariant.model');
const config = require('../src/config/config');

async function verifyInventoryReduction() {
    try {
        console.log("Connecting to:", config.mongoose.url);
        await mongoose.connect(config.mongoose.url);
        console.log("Connected to DB");

        // 1. Create a dummy single product
        const product = await VendorProduct.create({
            name: "Test Reduction Product",
            slug: "test-reduction-" + Date.now(),
            categoryId: new mongoose.Types.ObjectId(),
            vendorId: new mongoose.Types.ObjectId(),
            productType: 'Single',
            pricing: {
                mrp: 100,
                sellingPrice: 80,
                quantity: 10
            }
        });
        console.log("Created Single Product with initial quantity 10");

        // 2. Create a dummy variant product
        const baseProductForVariant = await VendorProduct.create({
            name: "Test Variant Product",
            slug: "test-variant-" + Date.now(),
            categoryId: product.categoryId,
            vendorId: product.vendorId,
            productType: 'Variant'
        });

        const variant = await VendorProductVariant.create({
            productId: baseProductForVariant._id,
            sku: "SKU-TEST-" + Date.now(),
            attributes: [],
            pricing: {
                mrp: 100,
                sellingPrice: 80
            },
            inventory: {
                quantity: 20
            }
        });
        console.log("Created Variant Product with initial quantity 20");

        // 3. Create a dummy order containing both
        const order = await Order.create({
            customerId: new mongoose.Types.ObjectId(),
            vendorId: product.vendorId,
            items: [
                {
                    vendorProductId: product._id,
                    name: product.name,
                    quantity: 2,
                    price: 80
                },
                {
                    vendorProductId: baseProductForVariant._id,
                    variantId: variant._id,
                    name: "Variant Item",
                    quantity: 3,
                    price: 80
                }
            ],
            addressId: new mongoose.Types.ObjectId(),
            totalAmount: 400,
            status: 'placed'
        });

        console.log("Created Order in 'placed' status");

        // 4. Simulate Logic from controller (exactly as written in controller)
        const oldStatus = order.status;
        const newStatus = 'confirmed';

        console.log(`Updating status from ${oldStatus} to ${newStatus}`);

        if (newStatus === 'confirmed' && oldStatus === 'placed') {
            for (const item of order.items) {
                if (item.variantId) {
                    await VendorProductVariant.findByIdAndUpdate(item.variantId, {
                        $inc: { 'inventory.quantity': -item.quantity }
                    });
                } else if (item.vendorProductId) {
                    await VendorProduct.findByIdAndUpdate(item.vendorProductId, {
                        $inc: { 'pricing.quantity': -item.quantity }
                    });
                }
            }
        }

        order.status = newStatus;
        await order.save();

        // 5. Verify Single Product
        const updatedProduct = await VendorProduct.findById(product._id);
        console.log("Single Product Quantity:", updatedProduct.pricing.quantity);

        // 6. Verify Variant Product
        const updatedVariant = await VendorProductVariant.findById(variant._id);
        console.log("Variant Product Quantity:", updatedVariant.inventory.quantity);

        let success = true;
        if (updatedProduct.pricing.quantity !== 8) {
            console.error("FAILED: Single product quantity should be 8, got", updatedProduct.pricing.quantity);
            success = false;
        }
        if (updatedVariant.inventory.quantity !== 17) {
            console.error("FAILED: Variant product quantity should be 17, got", updatedVariant.inventory.quantity);
            success = false;
        }

        if (success) {
            console.log("ALL TESTS PASSED: Inventory reduced correctly for both types.");
        }

        // Cleanup
        await VendorProduct.deleteOne({ _id: product._id });
        await VendorProduct.deleteOne({ _id: baseProductForVariant._id });
        await VendorProductVariant.deleteOne({ _id: variant._id });
        await Order.deleteOne({ _id: order._id });

        console.log("Cleanup done.");
        process.exit(0);
    } catch (err) {
        console.error("VERIFICATION ERROR:", err);
        process.exit(1);
    }
}

verifyInventoryReduction();
