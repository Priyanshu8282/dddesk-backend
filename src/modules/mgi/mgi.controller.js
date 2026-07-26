/**
 * mgi.controller.js
 *
 * Express controllers for the MGI Affiliate API bridge.
 * All methods validate input, call mgi.service.js, handle errors,
 * and return clean JSON responses.
 */

const mgiService = require('./mgi.service');
const MgiOrder = require('./mgi.model');

// ─── Helper: Format date to MGI's expected format "DD/Mon/YYYY" ──────────────
function formatDateForMgi(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return dateStr; // return as-is if already formatted
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const dd = String(date.getDate()).padStart(2, '0');
    const mon = months[date.getMonth()];
    const yyyy = date.getFullYear();
    return `${dd}/${mon}/${yyyy}`;
}

// ─── 1. POST /mgi/validate-customer ──────────────────────────────────────────
exports.validateCustomer = async (req, res) => {
    try {
        const { mobile, customerCode } = req.body;

        if (!mobile || !customerCode) {
            return res.status(400).json({
                success: false,
                message: 'Both mobile number and customer code are required.',
            });
        }

        const customer = await mgiService.validateCustomer(
            mobile.trim(),
            customerCode.trim()
        );

        return res.json({
            success: true,
            message: 'Customer validated successfully.',
            customer,
        });
    } catch (err) {
        console.error('[MGI_CTRL] validateCustomer error:', err.message);
        return res.status(400).json({
            success: false,
            message: err.message || 'Customer validation failed.',
            errorCode: err.errorNo || null,
        });
    }
};

// ─── 2. GET /mgi/categories ───────────────────────────────────────────────────
exports.getCategories = async (req, res) => {
    try {
        const categories = await mgiService.getCategories();

        return res.json({
            success: true,
            categories,
        });
    } catch (err) {
        console.error('[MGI_CTRL] getCategories error:', err.message);
        return res.status(500).json({
            success: false,
            message: err.message || 'Failed to fetch MGI categories.',
            errorCode: err.errorNo || null,
        });
    }
};

// ─── 3. POST /mgi/add-order ───────────────────────────────────────────────────
exports.addOrder = async (req, res) => {
    try {
        const {
            customerCode,
            customerMobile,
            customerName,
            billNo,
            billDate,
            remark,
            orderDetails,
        } = req.body;

        // ─── Input Validation ──────────────────────────────────────────────
        if (!customerCode) {
            return res.status(400).json({ success: false, message: 'customerCode is required.' });
        }
        if (!billNo) {
            return res.status(400).json({ success: false, message: 'billNo is required.' });
        }
        if (!billDate) {
            return res.status(400).json({ success: false, message: 'billDate is required.' });
        }
        if (!Array.isArray(orderDetails) || orderDetails.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'orderDetails must be a non-empty array.',
            });
        }
        for (const detail of orderDetails) {
            if (!detail.categoryCode || !detail.amount || Number(detail.amount) <= 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Each order detail must have a valid categoryCode and positive amount.',
                });
            }
        }

        // ─── Format date for MGI ───────────────────────────────────────────
        const formattedBillDate = formatDateForMgi(billDate);

        // ─── Call MGI SOAP ─────────────────────────────────────────────────
        const mgiResult = await mgiService.addOrder({
            customerCode: customerCode.trim(),
            billNo: billNo.trim(),
            billDate: formattedBillDate,
            remark: remark || 'Order Placed',
            orderDetails: orderDetails.map(d => ({
                categoryCode: d.categoryCode,
                amount: Number(d.amount),
            })),
        });

        // ─── Save to MongoDB ───────────────────────────────────────────────
        const savedOrder = await MgiOrder.create({
            customerId: req.customer?._id || null,
            mgiCustomerCode: customerCode.trim(),
            mgiCustomerMobile: customerMobile || '',
            mgiCustomerName: customerName || '',
            mgiOrderNo: mgiResult.orderNo,
            billNo: billNo.trim(),
            billDate: formattedBillDate,
            remark: remark || 'Order Placed',
            totalPsAmount: mgiResult.totalPsAmount,
            totalCommissionAmount: mgiResult.totalCommissionAmount,
            totalBvPointAmount: mgiResult.totalBvPointAmount,
            orderDetails: mgiResult.orderDetails.map(d => ({
                productServiceCategoryCode: d.categoryCode,
                psAmount: d.psAmount,
                commissionAmount: d.commissionAmount,
                bvPointAmount: d.bvPointAmount,
            })),
            status: 'success',
            rawMgiResponse: mgiResult.rawResponse,
        });

        return res.status(201).json({
            success: true,
            message: 'Order booked successfully with MGI!',
            order: {
                ...mgiResult,
                _id: savedOrder._id,
            },
        });
    } catch (err) {
        console.error('[MGI_CTRL] addOrder error:', err.message);

        // Log failed attempt to MongoDB as well
        try {
            await MgiOrder.create({
                customerId: req.customer?._id || null,
                mgiCustomerCode: req.body.customerCode || 'unknown',
                mgiCustomerMobile: req.body.customerMobile || '',
                mgiCustomerName: req.body.customerName || '',
                billNo: req.body.billNo || 'unknown',
                billDate: req.body.billDate || '',
                remark: req.body.remark || '',
                totalPsAmount: 0,
                totalCommissionAmount: 0,
                totalBvPointAmount: 0,
                orderDetails: [],
                status: 'failed',
                errorCode: err.errorNo || null,
                errorDescription: err.message,
            });
        } catch (logErr) {
            console.error('[MGI_CTRL] Failed to log failed order:', logErr.message);
        }

        return res.status(400).json({
            success: false,
            message: err.message || 'Order booking failed.',
            errorCode: err.errorNo || null,
        });
    }
};

// ─── 4. GET /mgi/order-history ────────────────────────────────────────────────
exports.getOrderHistory = async (req, res) => {
    try {
        const {
            orderNo,
            customerCode,
            billNo,
            orderFromDate,
            orderToDate,
            billFromDate,
            billToDate,
        } = req.query;

        const orders = await mgiService.getOrderHistory({
            orderNo: orderNo || '',
            customerCode: customerCode || '',
            billNo: billNo || '',
            orderFromDate: orderFromDate ? formatDateForMgi(orderFromDate) : '',
            orderToDate: orderToDate ? formatDateForMgi(orderToDate) : '',
            billFromDate: billFromDate ? formatDateForMgi(billFromDate) : '',
            billToDate: billToDate ? formatDateForMgi(billToDate) : '',
        });

        return res.json({
            success: true,
            count: orders.length,
            orders,
        });
    } catch (err) {
        console.error('[MGI_CTRL] getOrderHistory error:', err.message);
        return res.status(500).json({
            success: false,
            message: err.message || 'Failed to fetch MGI order history.',
            errorCode: err.errorNo || null,
        });
    }
};

// ─── 5. GET /mgi/ledger ───────────────────────────────────────────────────────
exports.getLedger = async (req, res) => {
    try {
        const { fromDate, toDate } = req.query;

        if (!fromDate || !toDate) {
            return res.status(400).json({
                success: false,
                message: 'fromDate and toDate query parameters are required.',
            });
        }

        const ledgerEntries = await mgiService.getLedger(
            formatDateForMgi(fromDate),
            formatDateForMgi(toDate)
        );

        return res.json({
            success: true,
            count: ledgerEntries.length,
            ledger: ledgerEntries,
        });
    } catch (err) {
        console.error('[MGI_CTRL] getLedger error:', err.message);
        return res.status(500).json({
            success: false,
            message: err.message || 'Failed to fetch ledger.',
            errorCode: err.errorNo || null,
        });
    }
};

// ─── 6. GET /mgi/my-orders ───────────────────────────────────────────────────
// Returns MGI orders from OUR MongoDB (not from MGI's server)
exports.getMyLocalOrders = async (req, res) => {
    try {
        const page = parseInt(req.query.page || '1', 10);
        const limit = parseInt(req.query.limit || '10', 10);

        const query = {
            customerId: req.customer._id,
            status: 'success',
        };

        const [orders, total] = await Promise.all([
            MgiOrder.find(query)
                .sort({ createdAt: -1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .lean(),
            MgiOrder.countDocuments(query),
        ]);

        return res.json({
            success: true,
            orders,
            pagination: {
                total,
                page,
                limit,
                pages: Math.ceil(total / limit),
            },
        });
    } catch (err) {
        console.error('[MGI_CTRL] getMyLocalOrders error:', err.message);
        return res.status(500).json({
            success: false,
            message: err.message || 'Failed to fetch your MGI orders.',
        });
    }
};
