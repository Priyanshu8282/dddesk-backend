const Order = require('./order.model');
const Cart = require('../cart/cart.model');
const Notification = require('../notifications/notification.model');
const Admin = require('../admins/admin.model');
const mongoose = require('mongoose');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const Wallet = require('../wallet/wallet.model');
const WalletTransaction = require('../wallet/walletTransaction.model');
const GlobalSetting = require('../settings/setting.model');
// Vendor models removed

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_SLWE0S1jEZmoga',
    key_secret: process.env.RAZORPAY_KEY_SECRET || 'lwwf9lUvG4AVfSpgprKZozKg',
});

// Helper to emit and save notifications after an order placement
async function notifyOrderPlaced(order, io) {
    try {
        const activeAdmins = await Admin.find({ status: true, isDeleted: false });

        await Notification.create({
            recipientId: order.vendorId,
            recipientType: 'Vendor',
            orderId: order._id,
            type: 'new_order',
            title: 'New Order Received!',
            message: `Order #${order.orderNumber || order._id} for ₹${order.totalAmount} has been placed.`
        });

        const adminNotifications = activeAdmins.map(admin => ({
            recipientId: admin._id,
            recipientType: 'Admin',
            orderId: order._id,
            type: 'new_order',
            title: 'New Order Placed!',
            message: `Order #${order.orderNumber || order._id} for ₹${order.totalAmount} was placed on the platform.`
        }));
        if (adminNotifications.length > 0) {
            await Notification.insertMany(adminNotifications);
        }

        if (io) {
            const vendorIdStr = order.vendorId._id ? order.vendorId._id.toString() : order.vendorId.toString();
            const eventData = {
                orderId: order._id,
                title: 'New Order!',
                message: `A new order has been placed for ₹${order.totalAmount}.`,
                amount: order.totalAmount,
                vendorId: vendorIdStr
            };
            io.to(`vendor_${vendorIdStr}`).emit('new_order', eventData);
            io.to('admin_room').emit('new_order', eventData);
        }
    } catch (notifyErr) {
        console.error('[NOTIFY_ERR] Failed to send notification:', notifyErr);
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// POST /private/website/orders/place  (Wallet Only)
// ──────────────────────────────────────────────────────────────────────────────
exports.placeOrder = async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const { addressId, notes } = req.body;
        if (!addressId) throw new Error('Address is required');

        const cart = await Cart.findOne({ customerId: req.customer._id });
        if (!cart || cart.items.length === 0) throw new Error('Cart is empty');

        let totalOrderAmount = 0;
        const vendorGroups = {};
        cart.items.forEach(item => {
            const vid = item.vendorId?.toString();
            if (!vendorGroups[vid]) vendorGroups[vid] = [];
            vendorGroups[vid].push(item);
            totalOrderAmount += (item.price * item.quantity);
        });

        // Deduct from wallet atomically
        const wallet = await Wallet.findOne({ customerId: req.customer._id }).session(session);
        if (!wallet) throw new Error('Wallet not found. Please contact support.');
        if (wallet.balance < totalOrderAmount) {
            throw new Error(`Insufficient wallet balance. You need ₹${totalOrderAmount}`);
        }

        const Customer = mongoose.model('Customer');
        const customerDoc = await Customer.findById(req.customer._id).lean();
        const deliveryAddress = customerDoc?.savedAddresses?.find(a => a._id.toString() === addressId.toString()) || null;

        // Fetch Global Settings for Commissions
        const settings = await GlobalSetting.find({ key: { $in: ['groceryCommissionPercentage', 'foodCommissionPercentage'] } }).session(session);
        const groceryCommission = Number(settings.find(s => s.key === 'groceryCommissionPercentage')?.value || 5);
        const foodCommission = Number(settings.find(s => s.key === 'foodCommissionPercentage')?.value || 7);

        // Generate a Master Order Number that binds all vendor sub-orders logically
        const orderCountCount = await mongoose.model('Order').countDocuments();
        const masterOrderNumber = `ORD-${Date.now().toString().slice(-6)}-${String(orderCountCount + 1).padStart(4, '0')}`;

        const orders = [];
        for (const [vendorId, items] of Object.entries(vendorGroups)) {
            const subtotal = items.reduce((s, i) => s + (i.price * i.quantity), 0);
            
            // Deduce Commission Math
            // Formula: Commission is exactly equal to Platform Fee. Vendor Payout is remainder.
            const platformFee = 0; // Number(((subtotal * commissionRate) / 100).toFixed(2));
            const vendorPayout = subtotal; // Number((subtotal - platformFee).toFixed(2));

            const orderData = {
                customerId: req.customer._id,
                vendorId,
                items: items.map(i => ({
                    vendorProductId: i.vendorProductId,
                    variantId: i.variantId,
                    name: i.name,
                    image: i.image,
                    sku: i.sku,
                    quantity: i.quantity,
                    price: i.price,
                    mrp: i.mrp,
                    subtotal: i.price * i.quantity,
                })),
                addressId,
                orderNumber: masterOrderNumber,
                deliveryAddress,
                subtotal,
                totalAmount: subtotal,
                platformFee,
                vendorPayout,
                paymentMethod: 'wallet',
                paymentStatus: 'paid',
                notes,
            };

            const orderArr = await Order.create([orderData], { session });
            const order = orderArr[0];
            orders.push(order);

            const balanceBefore = wallet.balance;
            wallet.balance -= subtotal;

            // Record Wallet Transaction for this vendor's order
            await WalletTransaction.create([{
                customerId: req.customer._id,
                walletId: wallet._id,
                transactionType: 'debit',
                transactionFor: 'order_payment',
                amount: subtotal,
                balanceBefore: balanceBefore,
                balanceAfter: wallet.balance,
                referenceId: order._id.toString(),
                paymentMethod: 'wallet',
                paymentStatus: 'success',
                description: `Order Payment #${order.orderNumber || order._id}`,
            }], { session });
        }

        await wallet.save({ session });
        
        cart.items = [];
        await cart.save({ session });

        await session.commitTransaction();
        session.endSession();

        // Populate vendor details for the response
        const populatedOrders = await Promise.all(orders.map(order =>
            Order.findById(order._id).populate('vendorId', 'businessName').lean()
        ));

        // Trigger Notifications
        const io = req.app.get('io');
        for (const order of populatedOrders) {
            await notifyOrderPlaced(order, io);
        }

        res.status(201).json({ success: true, message: 'Order placed successfully!', orders: populatedOrders });
    } catch (err) {
        await session.abortTransaction();
        session.endSession();
        res.status(err.message.includes('Insufficient') ? 400 : 500).json({ success: false, message: err.message });
    }
};

// ──────────────────────────────────────────────────────────────────────────────
// POST /private/website/orders/razorpay/create-order
// Creates a Razorpay order and returns order_id + key_id to the frontend
// ──────────────────────────────────────────────────────────────────────────────
exports.createRazorpayOrder = async (req, res) => {
    try {
        const { amount } = req.body; // amount in rupees
        if (!amount || amount <= 0) {
            return res.status(400).json({ success: false, message: 'Valid amount is required' });
        }

        const razorpayOrder = await razorpay.orders.create({
            amount: Math.round(amount * 100), // convert to paise
            currency: 'INR',
            receipt: `mgi_${Date.now()}`,
            notes: {
                customerId: req.customer._id.toString(),
            }
        });

        res.json({
            success: true,
            razorpayOrderId: razorpayOrder.id,
            amount: razorpayOrder.amount,
            currency: razorpayOrder.currency,
            keyId: process.env.RAZORPAY_KEY_ID || 'rzp_test_SLWE0S1jEZmoga',
        });
    } catch (err) {
        console.error('[RAZORPAY] Create order error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
};

// ──────────────────────────────────────────────────────────────────────────────
// POST /private/website/orders/razorpay/verify-payment
// Verifies the HMAC signature of the payment and marks order as paid
// ──────────────────────────────────────────────────────────────────────────────
exports.verifyRazorpayPayment = async (req, res) => {
    try {
        const { razorpayOrderId, razorpayPaymentId, razorpaySignature, orderId } = req.body;

        const keySecret = process.env.RAZORPAY_KEY_SECRET || 'lwwf9lUvG4AVfSpgprKZozKg';
        const body = `${razorpayOrderId}|${razorpayPaymentId}`;
        const expectedSignature = crypto
            .createHmac('sha256', keySecret)
            .update(body)
            .digest('hex');

        if (expectedSignature !== razorpaySignature) {
            return res.status(400).json({ success: false, message: 'Payment verification failed — invalid signature' });
        }

        // If an existing orderId was passed, update it
        if (orderId) {
            const order = await Order.findByIdAndUpdate(orderId, {
                razorpayOrderId,
                razorpayPaymentId,
                razorpaySignature,
                paymentStatus: 'paid',
            }, { new: true });
            return res.json({ success: true, message: 'Payment verified', order });
        }

        res.json({ success: true, message: 'Payment verified', razorpayPaymentId });
    } catch (err) {
        console.error('[RAZORPAY] Verify payment error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.getMyOrders = async (req, res) => {
    try {
        const orders = await Order.find({ customerId: req.customer._id })
            .sort({ createdAt: -1 })
            .populate('vendorId', 'businessName address.addressLine1')
            .lean();
        res.json({ success: true, orders });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.getOrderById = async (req, res) => {
    try {
        const order = await Order.findOne({ _id: req.params.id, customerId: req.customer._id })
            .populate('vendorId', 'businessName phone address email serviceType');
        if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
        res.json({ success: true, order });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.getOrdersByOrderNumber = async (req, res) => {
    try {
        const orders = await Order.find({ orderNumber: req.params.orderNumber, customerId: req.customer._id })
            .sort({ createdAt: -1 })
            .populate('vendorId', 'businessName phone address email serviceType');
        if (!orders || orders.length === 0) return res.status(404).json({ success: false, message: 'Orders not found' });
        res.json({ success: true, orders });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.cancelOrder = async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const order = await Order.findOne({ _id: req.params.id, customerId: req.customer._id }).session(session);
        if (!order) throw new Error('Order not found');
        if (!['placed', 'confirmed'].includes(order.status)) {
            throw new Error('Order cannot be cancelled at this stage');
        }

        order.status = 'cancelled';
        order.cancelReason = req.body.reason || 'Cancelled by customer';
        await order.save({ session });

        // Refund to wallet if it was paid
        if (order.paymentStatus === 'paid') {
            const wallet = await Wallet.findOne({ customerId: order.customerId }).session(session);
            if (wallet) {
                const balanceBefore = wallet.balance;
                wallet.balance += order.totalAmount;
                await wallet.save({ session });

                await WalletTransaction.create([{
                    customerId: order.customerId,
                    walletId: wallet._id,
                    transactionType: 'credit',
                    transactionFor: 'order_refund',
                    amount: order.totalAmount,
                    balanceBefore: balanceBefore,
                    balanceAfter: wallet.balance,
                    referenceId: order._id.toString(),
                    paymentMethod: 'wallet',
                    paymentStatus: 'success',
                    description: `Order Refund #${order.orderNumber || order._id}`,
                }], { session });
            }
        }

        await session.commitTransaction();
        session.endSession();

        res.json({ success: true, message: 'Order cancelled. Amount refunded to wallet.', order });
    } catch (err) {
        await session.abortTransaction();
        session.endSession();
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.getVendorOrders = async (req, res) => {
    try {
        const { status, page = 1, limit = 10, search, vendorId: queryVendorId } = req.query;

        console.log("[DEBUG_ORDER_API] User ID:", req.user?._id, "User Type:", req.user?.userType, "Query VendorId:", queryVendorId);

        const query = {};

        if (req.user?.userType === 'admin') {
            if (queryVendorId) {
                query.vendorId = new mongoose.Types.ObjectId(queryVendorId.toString());
            }
        } else {
            let vId = req.user._id;
            if (!vId) return res.status(400).json({ success: false, message: 'Vendor context missing' });
            query.vendorId = new mongoose.Types.ObjectId(vId.toString());
        }

        if (status && status !== 'undefined' && status !== 'null') {
            if (status === 'pending') query.status = 'placed';
            else if (status === 'in_progress') query.status = { $in: ['confirmed', 'preparing', 'out_for_delivery'] };
            else if (status === 'completed') query.status = 'delivered';
            else if (status === 'cancelled') query.status = 'cancelled';
        }

        if (search) {
            query.$or = [
                { orderNumber: { $regex: search, $options: 'i' } },
                { 'items.name': { $regex: search, $options: 'i' } }
            ];
        }

        const [orders, total, totalForVendor] = await Promise.all([
            Order.find(query)
                .sort({ createdAt: -1 })
                .skip((page - 1) * limit)
                .limit(Number(limit))
                .populate('customerId', 'name phone email')
                .populate('vendorId', 'businessName'),
            Order.countDocuments(query),
            Order.countDocuments(query.vendorId ? { vendorId: query.vendorId } : {})
        ]);

        res.json({
            success: true,
            orders,
            pagination: {
                total,
                page: Number(page),
                limit: Number(limit),
                pages: Math.ceil(total / limit)
            },
            diagnostics: {
                vendorIdFilter: query.vendorId || 'ALL',
                totalForVendor,
                userType: req.user?.userType
            }
        });
    } catch (err) {
        console.error('[DEBUG_ORDER_API] Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.updateVendorOrderStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        console.log(`[DEBUG_ORDER_STATUS] Updating ${id} to ${status} for user: ${req.user?._id}`);

        const allowedStatues = ['confirmed', 'preparing', 'out_for_delivery', 'delivered', 'cancelled'];
        if (!allowedStatues.includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid status' });
        }

        const query = { _id: id };
        if (req.user?.userType !== 'admin') {
            query.vendorId = req.user._id;
        } else if (req.query.vendorId) {
            query.vendorId = req.query.vendorId;
        }

        const order = await Order.findOne(query);
        if (!order) {
            return res.status(404).json({ success: false, message: 'Order not found or access denied' });
        }

        const oldStatus = order.status;
        order.status = status;
        await order.save();

        // Reduce inventory if confirmed from placed
        if (status === 'confirmed' && oldStatus === 'placed') {
            // Inventory logic removed
        }

        // Trigger Real-time Notification for Customer
        const io = req.app.get('io');
        if (io) {
            try {
                const statusMessages = {
                    confirmed: 'Your order has been accepted by the vendor!',
                    preparing: 'Your order is being prepared.',
                    out_for_delivery: 'Your order is out for delivery!',
                    delivered: 'Your order has been delivered. Enjoy!',
                    cancelled: 'Your order has been cancelled.'
                };

                const msg = statusMessages[status] || `Your order status changed to ${status}.`;

                await Notification.create({
                    recipientId: order.customerId,
                    recipientType: 'Customer',
                    orderId: id,
                    type: 'status_update',
                    title: 'Order Status Update',
                    message: msg
                });

                io.to(`customer_${order.customerId}`).emit('order_status_update', {
                    orderId: id,
                    status,
                    message: msg
                });
            } catch (notifyErr) {
                console.error('[NOTIFY_ERR] Failed to notify customer:', notifyErr);
            }
        }

        // ==========================================
        // VENDOR PAYOUT TRIGGER (RAZORPAY ROUTE API)
        // ==========================================
        if (status === 'delivered' && oldStatus !== 'delivered') {
            try {
                // Vendor Data Fetch Removed
                const fundAccountId = null; // vendorData?.razorpayFundAccountId;

                if (!fundAccountId) {
                    console.error(`[PAYOUT_ERR] Cannot execute payout. Vendor ${order.vendorId} KYC is incomplete.`);
                } else if (order.vendorPayout > 0) {
                    // Execute Razorpay Transfer!
                    console.log(`[PAYOUT_START] Transferring ₹${order.vendorPayout} to Fund Account ${fundAccountId}`);

                    const transferPayload = {
                        account: fundAccountId,
                        amount: Math.round(order.vendorPayout * 100), // Razorpay wants Paisa
                        currency: "INR",
                        notes: {
                            orderId: order._id.toString(),
                            orderNumber: order.orderNumber,
                            platformFee: String(order.platformFee)
                        }
                    };

                    const transferRecord = await razorpay.transfers.create(transferPayload);
                    console.log(`[PAYOUT_SUCCESS] Transferred via PRN: ${transferRecord.id}`);
                }
            } catch (payoutErr) {
                // We do not fail the overall status update request if the payout system glitches,
                // but we must log it for the admin to retry manually later.
                console.error('[PAYOUT_CRITICAL] Transfer Failed:', payoutErr);
            }
        }

        res.json({ success: true, message: `Order status updated to ${status}`, order });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.getVendorOrderById = async (req, res) => {
    try {
        const { id } = req.params;
        const query = { _id: id };
        if (req.user?.userType !== 'admin') {
            query.vendorId = req.user._id;
        } else if (req.query.vendorId) {
            query.vendorId = req.query.vendorId;
        }

        const order = await Order.findOne(query)
            .populate('customerId', 'name phone email savedAddresses')
            .populate('vendorId', 'businessName ownerName phone address email');

        if (!order) {
            return res.status(404).json({
                success: false,
                message: 'Order not found or access denied. Please ensure you have the correct vendor context selected in the dashboard.'
            });
        }

        const orderObj = order.toObject();
        if (orderObj.customerId && orderObj.customerId.savedAddresses) {
            const deliveryAddress = orderObj.customerId.savedAddresses.find(
                addr => addr._id.toString() === order.addressId.toString()
            );
            orderObj.shippingAddress = deliveryAddress;
        }

        res.json({ success: true, order: orderObj });
    } catch (err) {
        console.error('[CRITICAL_BACKEND_ERR] Order Details Fetch Failed:', err);
        res.status(500).json({ success: false, message: `System Error: ${err.message}` });
    }
};
