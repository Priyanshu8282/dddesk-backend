const mongoose = require('mongoose');

const expenseSchema = new mongoose.Schema({
    libraryId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Library',
        required: true,
        index: true
    },
    title: { type: String, required: true, trim: true },
    category: {
        type: String,
        enum: ['rent', 'electricity', 'internet', 'salary', 'maintenance', 'supplies', 'furniture', 'equipment', 'cleaning', 'other'],
        default: 'other'
    },
    amount: { type: Number, required: true },
    date: { type: Date, required: true, default: Date.now },
    paymentMethod: {
        type: String,
        enum: ['cash', 'upi', 'bank_transfer', 'other'],
        default: 'cash'
    },
    notes: { type: String },
    receiptImage: { type: String },
    isDeleted: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
}, { timestamps: true });

expenseSchema.pre(['find', 'findOne', 'countDocuments'], function () {
    this.where({ isDeleted: false });
});

module.exports = mongoose.model('Expense', expenseSchema);
