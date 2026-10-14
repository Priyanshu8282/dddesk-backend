const mongoose = require('mongoose');

const permissionSchema = new mongoose.Schema({
    name: { type: String, required: true },
    key: { type: String, required: true, unique: true }, // e.g., "CREATE_USER" or "students.view"
    module: { type: String, required: true }, // e.g., "USER", "ROLE", "PRODUCT"
    route: { type: String }, // e.g., "products", "staff", "roles"
    description: String,
    // 'platform' permissions can only be granted by the superadmin (never to tenant roles)
    scope: { type: String, enum: ['tenant', 'platform'], default: 'tenant' }
}, {
    timestamps: true
});

module.exports = mongoose.model('Permission', permissionSchema);
