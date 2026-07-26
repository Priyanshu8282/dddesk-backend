const Cart = require('./cart.model');
const VendorProduct = require('../vendorProducts/vendorProduct.model');

exports.getCart = async (req, res) => {
    try {
        let cart = await Cart.findOne({ customerId: req.customer._id })
            .populate({ path: 'items.vendorProductId', select: 'name images pricing status masterCategory' })
            .populate({ path: 'items.vendorId', select: 'businessName address.location' });
        if (!cart) cart = { items: [], total: 0 };

        const total = (cart.items || []).reduce((sum, item) => sum + (item.price * item.quantity), 0);
        res.json({ success: true, cart, total });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.addToCart = async (req, res) => {
    try {
        const { vendorProductId, variantId, quantity = 1 } = req.body;

        const vp = await VendorProduct.findById(vendorProductId);
        if (!vp) return res.status(404).json({ success: false, message: 'Product not found' });

        let price = vp.pricing?.sellingPrice || 0;
        let mrp = vp.pricing?.mrp || 0;
        let sku = vp.pricing?.sku || '';
        let image = vp.images?.thumbnail || '';
        let name = vp.name || '';
        let vendorId = vp.vendorId;

        if (variantId) {
            const VendorProductVariant = require('../vendorProducts/vendorProductVariant.model');
            const variant = await VendorProductVariant.findById(variantId).lean();
            if (variant) {
                price = variant.pricing?.sellingPrice || price;
                mrp = variant.pricing?.mrp || mrp;
                sku = variant.sku || sku;
            }
        }

        let cart = await Cart.findOne({ customerId: req.customer._id });
        if (!cart) cart = new Cart({ customerId: req.customer._id, items: [] });

        const existingIdx = cart.items.findIndex(i =>
            i.vendorProductId?.toString() === vendorProductId &&
            (variantId ? i.variantId?.toString() === variantId : !i.variantId)
        );

        if (existingIdx > -1) {
            cart.items[existingIdx].quantity += quantity;
        } else {
            cart.items.push({ vendorProductId, variantId, vendorId, quantity, price, mrp, name, image, sku });
        }

        await cart.save();

        let populatedCart = await Cart.findById(cart._id)
            .populate({ path: 'items.vendorProductId', select: 'name images pricing status masterCategory' })
            .populate({ path: 'items.vendorId', select: 'businessName address.location' });

        const total = populatedCart.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
        res.json({ success: true, cart: populatedCart, total, itemCount: populatedCart.items.length });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.updateCartItem = async (req, res) => {
    try {
        const { itemId, quantity } = req.body;
        const cart = await Cart.findOne({ customerId: req.customer._id });
        if (!cart) return res.status(404).json({ success: false, message: 'Cart not found' });

        const item = cart.items.id(itemId);
        if (!item) return res.status(404).json({ success: false, message: 'Item not found in cart' });

        if (quantity <= 0) {
            item.deleteOne();
        } else {
            item.quantity = quantity;
        }
        await cart.save();

        let populatedCart = await Cart.findById(cart._id)
            .populate({ path: 'items.vendorProductId', select: 'name images pricing status masterCategory' })
            .populate({ path: 'items.vendorId', select: 'businessName address.location' });

        const total = populatedCart.items.reduce((sum, i) => sum + (i.price * i.quantity), 0);
        res.json({ success: true, cart: populatedCart, total, itemCount: populatedCart.items.length });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.removeFromCart = async (req, res) => {
    try {
        const cart = await Cart.findOne({ customerId: req.customer._id });
        if (!cart) return res.status(404).json({ success: false, message: 'Cart not found' });
        cart.items = cart.items.filter(i => i._id.toString() !== req.params.itemId);
        await cart.save();

        let populatedCart = await Cart.findById(cart._id)
            .populate({ path: 'items.vendorProductId', select: 'name images pricing status masterCategory' })
            .populate({ path: 'items.vendorId', select: 'businessName address.location' });

        const total = populatedCart.items.reduce((sum, i) => sum + (i.price * i.quantity), 0);
        res.json({ success: true, cart: populatedCart, total, itemCount: populatedCart.items.length });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.clearCart = async (req, res) => {
    try {
        await Cart.findOneAndUpdate({ customerId: req.customer._id }, { items: [] });
        res.json({ success: true, message: 'Cart cleared' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};
