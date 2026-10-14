const mongoose = require('mongoose');
const Payment = require('./src/models/payment.model');
require('dotenv').config();

async function test() {
    await mongoose.connect(process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017/library-management');
    console.log("Connected to DB");
    
    // Just find one paid payment to see its structure
    const payment = await Payment.findOne({ paymentStatus: 'paid' });
    if (!payment) return console.log("No paid payment found.");
    console.log("Sample Payment Amount:", payment.amount, typeof payment.amount);
    
    // Test aggregate without filter
    const agg1 = await Payment.aggregate([
        { $match: { paymentStatus: 'paid' } },
        { $group: { _id: null, total: { $sum: "$amount" } } }
    ]);
    console.log("Agg without libraryId:", agg1);
    
    // Test aggregate with libraryId string
    const libIdStr = payment.libraryId.toString();
    const agg2 = await Payment.aggregate([
        { $match: { paymentStatus: 'paid', libraryId: new mongoose.Types.ObjectId(libIdStr) } },
        { $group: { _id: null, total: { $sum: "$amount" } } }
    ]);
    console.log("Agg with libraryId ObjectId:", agg2);
    
    process.exit(0);
}
test().catch(console.error);
