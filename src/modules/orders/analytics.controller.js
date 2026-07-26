const Order = require('./order.model');
// Removed VendorProduct
const Customer = require('../customers/customer.model');
const Admin = require('../admins/admin.model');
const mongoose = require('mongoose');
const PageVisit = require('../analytics/pageVisit.model');
const { getLiveCount } = require('../analytics/liveVisitors');

/**
 * Get Real-time Vendor Dashboard Analytics
 * Optimized using MongoDB Aggregation Pipeline ($facet)
 */
exports.getVendorAnalytics = async (req, res) => {
    try {
        const userId = req.user._id;
        const userType = req.user.userType; // Assuming userType is available in req.user

        // Determine Match Condition: Admin sees all, Vendor sees own
        const matchCondition = userType === 'admin'
            ? {}
            : { 
                $or: [
                    { vendorId: new mongoose.Types.ObjectId(userId) },
                    { vendorId: String(userId) }
                ]
            };

        // Date range for Today's analytics
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);

        const endOfDay = new Date();
        endOfDay.setHours(23, 59, 59, 999);

        // 1. ORDERS & CUSTOMER ANALYTICS (Single Aggregation)
        const orderStats = await Order.aggregate([
            { $match: matchCondition },
            {
                $facet: {
                    // Today's Analytics
                    today: [
                        { $match: { createdAt: { $gte: startOfDay, $lte: endOfDay } } },
                        {
                            $group: {
                                _id: null,
                                totalOrders: { $sum: 1 },
                                totalSales: { $sum: "$totalAmount" },
                                pending: { $sum: { $cond: [{ $eq: ["$status", "placed"] }, 1, 0] } },
                                inProgress: { $sum: { $cond: [{ $in: ["$status", ["confirmed", "preparing", "out_for_delivery"]] }, 1, 0] } },
                                completed: { $sum: { $cond: [{ $eq: ["$status", "delivered"] }, 1, 0] } }
                            }
                        }
                    ],
                    // Latest 5 orders from Today
                    latestOrders: [
                        { $match: { createdAt: { $gte: startOfDay, $lte: endOfDay } } },
                        { $sort: { createdAt: -1 } },
                        { $limit: 5 },
                        {
                            $project: {
                                orderNumber: 1,
                                totalAmount: 1,
                                status: 1,
                                createdAt: 1
                            }
                        }
                    ],
                    // Lifetime Analytics
                    lifetime: [
                        {
                            $group: {
                                _id: null,
                                totalOrders: { $sum: 1 },
                                totalSales: { $sum: "$totalAmount" },
                                pending: { $sum: { $cond: [{ $eq: ["$status", "placed"] }, 1, 0] } },
                                completed: { $sum: { $cond: [{ $eq: ["$status", "delivered"] }, 1, 0] } }
                            }
                        }
                    ],
                    // Customer Analytics
                    customers: [
                        { $group: { _id: "$customerId", orderCount: { $sum: 1 } } },
                        {
                            $group: {
                                _id: null,
                                totalUniqueCustomers: { $sum: 1 },
                                repeatCustomers: { $sum: { $cond: [{ $gt: ["$orderCount", 1] }, 1, 0] } }
                            }
                        }
                    ]
                }
            }
        ]);

        // Removed Product Analytics
        const productStats = [{ totalProducts: 0, grocery: 0, food: 0 }];

        // 3. VISITOR ANALYTICS
        const vendorIdStr = userType !== 'admin' ? String(userId) : null;
        const [liveNow, lifetimeUnique] = await Promise.all([
            Promise.resolve(getLiveCount(vendorIdStr)),
            PageVisit.countDocuments(
                userType !== 'admin' 
                ? { 
                    $or: [
                        { vendorId: new mongoose.Types.ObjectId(userId) },
                        { vendorId: String(userId) }
                    ]
                  } 
                : { vendorId: null }
            ),
        ]);

        // Format and clean the response
        const oData = orderStats[0] || {};
        const pData = productStats[0] || { totalProducts: 0, grocery: 0, food: 0 };

        const response = {
            today: {
                totalOrders: oData.today[0]?.totalOrders || 0,
                pending: oData.today[0]?.pending || 0,
                inProgress: oData.today[0]?.inProgress || 0,
                completed: oData.today[0]?.completed || 0,
                totalSales: oData.today[0]?.totalSales || 0,
                latestOrders: oData.latestOrders || []
            },
            lifetime: {
                totalOrders: oData.lifetime[0]?.totalOrders || 0,
                pending: oData.lifetime[0]?.pending || 0,
                completed: oData.lifetime[0]?.completed || 0,
                totalSales: oData.lifetime[0]?.totalSales || 0
            },
            customers: {
                totalUniqueCustomers: oData.customers[0]?.totalUniqueCustomers || 0,
                repeatCustomers: oData.customers[0]?.repeatCustomers || 0
            },
            products: {
                totalProducts: pData.totalProducts,
                grocery: pData.grocery,
                food: pData.food
            },
            visitors: {
                liveNow,
                lifetimeUnique
            }
        };

        res.status(200).json({
            success: true,
            data: response
        });

    } catch (error) {
        console.error('[ANALYTICS_ERR]', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch dashboard analytics',
            error: error.message
        });
    }
};

/**
 * Super Admin Analytics – Platform-wide metrics (Admin only)
 */
exports.getSuperAdminAnalytics = async (req, res) => {
    try {
        // Date helpers
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);

        const endOfDay = new Date();
        endOfDay.setHours(23, 59, 59, 999);

        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        // Run all aggregations in parallel
        const [
            vendorStats,
            productStats,
            customerTotal,
            activeCustomers,
            todayOrderStats,
            lifetimeOrderStats,
            pendingOrders,
            completedOrders,
            staffCount,
            repeatCustomerData,
            sevenDayTrend,
            latestOrders
        ] = await Promise.all([
            // 1. Vendor stats removed
            Promise.resolve([]),

            // 2. Product stats removed
            Promise.resolve([]),

            // 3. Total customers
            Customer.countDocuments({}),

            // 4. Active customers (last 30 days)
            Customer.countDocuments({ lastLogin: { $gte: thirtyDaysAgo } }),

            // 5. Today's order aggregation
            Order.aggregate([
                { $match: { createdAt: { $gte: startOfDay, $lte: endOfDay } } },
                {
                    $group: {
                        _id: null,
                        totalOrders: { $sum: 1 },
                        totalSales: { $sum: '$totalAmount' }
                    }
                }
            ]),

            // 6. Lifetime order stats
            Order.aggregate([
                {
                    $group: {
                        _id: null,
                        totalOrders: { $sum: 1 },
                        totalRevenue: { $sum: '$totalAmount' }
                    }
                }
            ]),

            // 7. Pending orders
            Order.countDocuments({ status: 'placed' }),

            // 8. Completed orders
            Order.countDocuments({ status: 'delivered' }),

            // 9. Internal staff count
            Admin.countDocuments({ isDeleted: false }),

            // 10. Repeat customers (customers with > 1 order)
            Order.aggregate([
                { $group: { _id: '$customerId', count: { $sum: 1 } } },
                { $match: { count: { $gt: 1 } } },
                { $count: 'repeatCustomers' }
            ]),

            // 11. 7-day orders trend
            Order.aggregate([
                { $match: { createdAt: { $gte: sevenDaysAgo } } },
                {
                    $group: {
                        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                        orders: { $sum: 1 },
                        revenue: { $sum: '$totalAmount' }
                    }
                },
                { $sort: { _id: 1 } }
            ]),

            // 12. Latest 8 platform-wide orders
            Order.find({})
                .sort({ createdAt: -1 })
                .limit(8)
                .populate('vendorId', 'businessName')
                .populate('customerId', 'name phone')
                .select('orderNumber totalAmount platformFee vendorPayout status createdAt vendorId customerId')
                .lean()
        ]);

        // Format vendor stats
        const vData = vendorStats[0] || { total: 0, active: 0 };

        // Format product stats
        const pData = productStats[0] || { total: 0, grocery: 0, food: 0 };

        // Fill in missing days for 7-day trend
        const trendMap = {};
        sevenDayTrend.forEach(d => { trendMap[d._id] = d; });
        const trendData = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const key = d.toISOString().split('T')[0];
            const dayName = d.toLocaleDateString('en-IN', { weekday: 'short' });
            trendData.push({
                day: dayName,
                date: key,
                orders: trendMap[key]?.orders || 0,
                revenue: trendMap[key]?.revenue || 0
            });
        }

        // Visitor analytics
        const [liveOnWebsite, lifetimeUniqueWebsite] = await Promise.all([
            Promise.resolve(getLiveCount(null)),
            PageVisit.countDocuments({ vendorId: null }),
        ]);

        res.json({
            success: true,
            data: {
                vendors: {
                    total: vData.total,
                    active: vData.active,
                    inactive: vData.total - vData.active
                },
                products: {
                    total: pData.total,
                    grocery: pData.grocery,
                    food: pData.food
                },
                customers: {
                    total: customerTotal,
                    active30Days: activeCustomers,
                    repeat: repeatCustomerData[0]?.repeatCustomers || 0
                },
                orders: {
                    todayOrders: todayOrderStats[0]?.totalOrders || 0,
                    todaySales: todayOrderStats[0]?.totalSales || 0,
                    lifetimeOrders: lifetimeOrderStats[0]?.totalOrders || 0,
                    lifetimeRevenue: lifetimeOrderStats[0]?.totalRevenue || 0,
                    pending: pendingOrders,
                    completed: completedOrders
                },
                staff: {
                    total: staffCount
                },
                visitors: {
                    liveOnWebsite,
                    lifetimeUniqueWebsite
                },
                charts: {
                    sevenDayTrend: trendData,
                    vendorStatus: [
                        { name: 'Active', value: vData.active },
                        { name: 'Inactive', value: Math.max(0, vData.total - vData.active) }
                    ],
                    productMix: [
                        { name: 'Grocery', value: pData.grocery },
                        { name: 'Food', value: pData.food }
                    ]
                },
                latestOrders
            }
        });

    } catch (error) {
        console.error('[SUPER_ADMIN_ANALYTICS_ERR]', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch super admin analytics',
            error: error.message
        });
    }
};

/**
 * Get Detailed Vendor Analytics for Admin View
 */
exports.getVendorAnalyticsForAdmin = async (req, res) => {
    try {
        const { id } = req.params;
        const { startDate, endDate } = req.query;

        const vendorId = id.trim();
        const matchCondition = { 
            $or: [
                { vendorId: new mongoose.Types.ObjectId(vendorId) },
                { vendorId: vendorId }
            ]
        };

        if (startDate || endDate) {
            matchCondition.createdAt = {};
            if (startDate) matchCondition.createdAt.$gte = new Date(startDate);
            if (endDate) {
                const end = new Date(endDate);
                end.setHours(23, 59, 59, 999);
                matchCondition.createdAt.$lte = end;
            }
        }

        const [analytics, orders] = await Promise.all([
            Order.aggregate([
                { $match: matchCondition },
                {
                    $group: {
                        _id: null,
                        totalOrders: { $sum: 1 },
                        completedOrders: { $sum: { $cond: { if: { $eq: ["$status", "delivered"] }, then: 1, else: 0 } } },
                        totalSales: { 
                            $sum: { $cond: { if: { $eq: ["$status", "delivered"] }, then: { $ifNull: ["$totalAmount", 0] }, else: 0 } }
                        },
                        totalCommission: { 
                            $sum: { $cond: { if: { $eq: ["$status", "delivered"] }, then: { $ifNull: ["$platformFee", 0] }, else: 0 } }
                        },
                        totalNetIncome: { 
                            $sum: { $cond: { if: { $eq: ["$status", "delivered"] }, then: { $ifNull: ["$vendorPayout", 0] }, else: 0 } }
                        }
                    }
                }
            ]),
            Order.find(matchCondition)
                .sort({ createdAt: -1 })
                .populate('customerId', 'name phone')
                .lean()
        ]);

        const stats = analytics[0] || {
            totalOrders: 0,
            completedOrders: 0,
            totalSales: 0,
            totalCommission: 0,
            totalNetIncome: 0
        };

        res.json({
            success: true,
            data: {
                stats: {
                    totalOrders: stats.totalOrders,
                    completedOrders: stats.completedOrders,
                    totalSales: stats.totalSales,
                    totalCommission: stats.totalCommission,
                    totalNetIncome: stats.totalNetIncome
                },
                orders
            }
        });
    } catch (error) {
        console.error('[VENDOR_ADMIN_ANALYTICS_ERR]', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch vendor analytics',
            error: error.message
        });
    }
};
