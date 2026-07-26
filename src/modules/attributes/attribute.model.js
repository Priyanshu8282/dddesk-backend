const mongoose = require('mongoose');

const attributeSchema = new mongoose.Schema({
    name: { type: String, required: true },
    type: {
        type: String,
        enum: ['text', 'number', 'dropdown', 'boolean', 'multi-select'],
        default: 'text'
    },
    options: [String], // Available options if type is dropdown/multi-select
    status: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },
    tenantId: { type: mongoose.Schema.Types.ObjectId },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
}, {
    timestamps: true
});

attributeSchema.pre('find', function () { this.where({ isDeleted: false }); });
attributeSchema.pre('findOne', function () { this.where({ isDeleted: false }); });

module.exports = mongoose.model('Attribute', attributeSchema);
