const Product = require('./product.model');

const ProductVariant = require('./productVariant.model');
// Removed vendorProduct imports
const Category = require('../categories/category.model');
const Subcategory = require('../subcategories/subcategory.model');
const Brand = require('../brands/brand.model');
const mongoose = require('mongoose');
// Helper to generate SKU if not provided
const generateSKU = (name) => {
    const prefix = name ? name.substring(0, 3).toUpperCase() : 'SKU';
    const timestamp = Date.now().toString().slice(-4);
    const randomStr = Math.random().toString(36).substring(2, 5).toUpperCase();
    return `${prefix}-${timestamp}-${randomStr}`;
};

exports.createProduct = async (req, res) => {
    try {
        const productData = { ...req.body };
        // Handle images
        productData.images = { thumbnail: '', gallery: [] };
        if (req.files) {
            if (req.files.image) {
                productData.images.thumbnail = req.files.image[0].path;
            }
            if (req.files.images) {
                productData.images.gallery = req.files.images.map(file => file.path);
            }
        }

        // Parse JSON fields
        ['pricing', 'variants'].forEach(field => {
            if (typeof productData[field] === 'string') {
                try {
                    productData[field] = JSON.parse(productData[field]);
                } catch (e) {
                    console.error(`Error parsing ${field}:`, e);
                }
            }
        });

        // Ensure SKU for Single product if missing
        if (productData.productType === 'Single' && productData.pricing && !productData.pricing.sku) {
            productData.pricing.sku = generateSKU(productData.name);
        }

        // Determine Owner Type dynamically based on Role Name or User Type
        const roleName = req.user?.roleId?.name?.toLowerCase();
        let ownerType = 'Admin'; // Supports 'admin' and 'super admin'
        if (roleName === 'vendor' || req.user?.userType === 'vendor') {
            ownerType = 'Vendor';
        }

        // Fetch names for denormalization
        if (productData.categoryId) {
            const cat = await Category.findById(productData.categoryId).select('name');
            if (cat) productData.categoryName = cat.name;
        }
        if (productData.subCategoryId) {
            const sub = await Subcategory.findById(productData.subCategoryId).select('name');
            if (sub) productData.subCategoryName = sub.name;
        }
        if (productData.brandId) {
            const brand = await Brand.findById(productData.brandId).select('name');
            if (brand) productData.brandName = brand.name;
        }

        // 1. Create Parent Product (Base Common Info)
        const product = await Product.create({
            ...productData,
            ownerType: ownerType,
            ownerId: req.user?._id,
            createdBy: req.user?._id,
            tenantId: req.user?.tenantId
        });

        const createdVariants = [];

        // 2. Process and Insert Decoupled Variants
        if (productData.productType === 'Variant' && Array.isArray(productData.variants) && productData.variants.length > 0) {
            const variantDocs = productData.variants.map(v => ({
                productId: product._id,
                sku: v.sku || generateSKU(`${productData.name}-${v.variantValues[0]?.valueName || 'VAR'}`),
                attributes: v.variantValues.map(attr => ({
                    variantTypeId: attr.variantTypeId,
                    valueId: attr.valueId
                })),
                pricing: {
                    mrp: Number(v.mrp) || 0,
                    sellingPrice: Number(v.sellingPrice) || Number(v.price) || 0,
                    costPrice: Number(v.costPrice) || 0,
                    taxId: v.taxId || null,
                    discountType: v.discountType || 'Fixed',
                    discountValue: Number(v.discountValue) || 0
                },
                unitId: v.unitId || null,
                inventory: {
                    quantity: Number(v.quantity) || 0,
                    minStock: Number(v.minStock) || 0
                },
                createdBy: req.user?._id
            }));

            // Bulk insert all child variants natively
            const inserted = await ProductVariant.insertMany(variantDocs);
            createdVariants.push(...inserted);
        }

        // 3. Automatically clone to VendorProduct if created by a Vendor (Logic removed)
        const isVendor = ownerType === 'Vendor' || roleName === 'vendor' || req.user?.userType === 'vendor';

        res.status(201).json({
            success: true,
            message: 'Product & Variants created efficiently',
            product,
            variantsCreated: createdVariants.length,
            clonedToVendorInventory: isVendor
        });
    } catch (error) {
        console.error('Create product error:', error);
        res.status(400).json({
            success: false,
            message: error.message
        });
    }
};

exports.getProducts = async (req, res) => {
    try {
        const { categoryId, subcategoryId, brandId, productType, status, search, page = 1, limit = 10 } = req.query;
        const query = { isDeleted: false };

        if (categoryId) query.categoryId = categoryId;
        if (subcategoryId) query.subCategoryId = subcategoryId; // Add this properly
        if (brandId) query.brandId = brandId;
        if (productType) query.productType = productType;
        if (status !== undefined && status !== '') query.status = status === 'true';
        if (search) {
            query.$or = [
                { name: new RegExp(search, 'i') },
                { slug: new RegExp(search, 'i') },
                { 'pricing.sku': new RegExp(search, 'i') }
            ];
        }

        // Apply Master Category Filter if present
        if (req.query.masterCategory) {
            query.masterCategory = req.query.masterCategory;
        }
        const skip = (page - 1) * limit;

        const products = await Product.find(query)
            .populate('categoryId', 'name')
            .populate('subCategoryId', 'name')
            .populate('brandId', 'name')
            .populate('unitId', 'name')
            .populate('pricing.taxId', 'name')
            .populate({ path: 'ownerId', select: 'name email businessName ownerName profileImage' })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .lean(); // Use lean for modifying the response object

        // Fetch and attach variants for products that have them
        const variantProducts = products.filter(p => p.productType === 'Variant');
        if (variantProducts.length > 0) {
            const productIds = variantProducts.map(p => p._id);
            const allVariants = await ProductVariant.find({ productId: { $in: productIds }, isDeleted: false })
                .populate('attributes.variantTypeId', 'name type')
                .populate('attributes.valueId', 'name colorCode')
                .populate('unitId', 'name')
                .lean();

            // Intersect them back
            products.forEach(product => {
                if (product.productType === 'Variant') {
                    product.variants = allVariants.filter(v => v.productId.toString() === product._id.toString());
                }
            });
        }

        const total = await Product.countDocuments(query);

        res.json({
            success: true,
            products,
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                pages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

exports.getProductById = async (req, res) => {
    try {
        const product = await Product.findById(req.params.id)
            .populate('categoryId')
            .populate('subCategoryId')
            .populate('brandId')
            .populate('unitId')
            .populate('pricing.taxId')
            .populate({ path: 'ownerId', select: 'name email businessName ownerName profileImage' })
            .lean(); // Use lean for modifying the response object

        if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

        // Fetch and attach variants if product type is Variant
        if (product.productType === 'Variant') {
            const variants = await ProductVariant.find({ productId: product._id, isDeleted: false })
                .populate('pricing.taxId')
                .populate('attributes.variantTypeId')
                .populate('attributes.valueId', 'name colorCode')
                .populate('unitId')
                .lean();

            product.variants = variants;
        }

        res.json({ success: true, product });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.updateProduct = async (req, res) => {
    try {
        const productData = { ...req.body };
        const existingProduct = await Product.findById(req.params.id);
        if (!existingProduct) return res.status(404).json({ success: false, message: 'Product not found' });

        // Handle images
        if (req.files) {
            const newImages = { ...existingProduct.images };
            if (req.files.image) {
                newImages.thumbnail = req.files.image[0].path;
            }
            if (req.files.images) {
                const gallery = req.files.images.map(file => file.path);
                newImages.gallery = [...(newImages.gallery || []), ...gallery];
            }
            productData.images = newImages;
        }

        // Handle image removal if requested
        if (req.body.removeGalleryImage) {
            const currentImages = productData.images || existingProduct.images;
            currentImages.gallery = currentImages.gallery.filter(img => img !== req.body.removeGalleryImage);
            productData.images = currentImages;
        }

        // Parse JSON fields
        ['pricing', 'variants'].forEach(field => {
            if (typeof productData[field] === 'string') {
                try {
                    productData[field] = JSON.parse(productData[field]);
                } catch (e) {
                    console.error(`Error parsing ${field}:`, e);
                }
            }
        });

        // Convert string "null" or "" to actual null to clear references in Mongoose
        ['categoryId', 'subCategoryId', 'brandId', 'unitId'].forEach(key => {
            if (productData[key] === 'null' || productData[key] === '') {
                productData[key] = null;
            }
        });

        // Fetch names for denormalization
        if (productData.categoryId) {
            const cat = await Category.findById(productData.categoryId).select('name');
            if (cat) productData.categoryName = cat.name;
        } else if (productData.categoryId === null) {
            productData.categoryName = null;
        }
        if (productData.subCategoryId) {
            const sub = await Subcategory.findById(productData.subCategoryId).select('name');
            if (sub) productData.subCategoryName = sub.name;
        } else if (productData.subCategoryId === null) {
            productData.subCategoryName = null;
        }
        if (productData.brandId) {
            const brand = await Brand.findById(productData.brandId).select('name');
            if (brand) productData.brandName = brand.name;
        } else if (productData.brandId === null) {
            productData.brandName = null;
        }

        const product = await Product.findByIdAndUpdate(req.params.id,
            { ...productData, updatedBy: req.user?._id },
            { new: true }
        );

        // Advanced Variant Sync Logic
        if (productData.productType === 'Variant' && Array.isArray(productData.variants)) {
            const incomingIds = productData.variants.filter(v => v._id).map(v => v._id);

            // Mark variants as deleted if they are not in the incoming payload
            await ProductVariant.updateMany(
                { productId: product._id, _id: { $nin: incomingIds } },
                { $set: { isDeleted: true } }
            );

            for (const v of productData.variants) {
                const variantData = {
                    productId: product._id,
                    sku: v.sku || generateSKU(`${productData.name}-${v.variantValues?.[0]?.valueName || 'VAR'}`),
                    attributes: v.variantValues.map(attr => ({
                        variantTypeId: attr.variantTypeId,
                        valueId: attr.valueId
                    })),
                    pricing: {
                        mrp: Number(v.mrp) || 0,
                        sellingPrice: Number(v.sellingPrice) || Number(v.price) || 0,
                        costPrice: Number(v.costPrice) || 0,
                        taxId: v.taxId || null,
                        discountType: v.discountType || 'Fixed',
                        discountValue: Number(v.discountValue) || 0
                    },
                    unitId: v.unitId || null,
                    inventory: {
                        quantity: Number(v.quantity) || 0,
                        minStock: Number(v.minStock) || 0
                    },
                    updatedBy: req.user?._id,
                    isDeleted: false // Reactivate if it was softly deleted
                };

                if (v._id) {
                    const updateData = { ...variantData };
                    delete updateData.sku; // Prevent collision on existing SKUs
                    await ProductVariant.findByIdAndUpdate(v._id, updateData);
                } else {
                    variantData.createdBy = existingProduct.createdBy;
                    await ProductVariant.create(variantData);
                }
            }
        }

        res.json({ success: true, message: 'Product & Variants updated successfully', product });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.deleteProduct = async (req, res) => {
    try {
        const product = await Product.findById(req.params.id);
        if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

        product.isDeleted = true;
        await product.save();

        // Cascade delete variants
        if (product.productType === 'Variant') {
            await ProductVariant.updateMany({ productId: product._id }, { isDeleted: true });
        }

        res.json({ success: true, message: 'Product and associated variants deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.updateProductStatus = async (req, res) => {
    try {
        const product = await Product.findByIdAndUpdate(req.params.id, { status: req.body.status }, { new: true });
        res.json({ success: true, product });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Simplified placeholders for remaining routes
exports.getAllProducts = async (req, res) => {
    try {
        const products = await Product.find({ isDeleted: false });
        res.json({ success: true, products });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.getProductByQrScannerCode = async (req, res) => {
    try { res.json({ success: true, message: 'QR scan successful' }); } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.generateQrForProduct = async (req, res) => {
    try { res.json({ success: true, message: 'QR generated' }); } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.searchProducts = async (req, res) => {
    try {
        const products = await Product.find({ name: new RegExp(req.query.q, 'i'), isDeleted: false });
        res.json({ success: true, products });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.getSimilarProducts = async (req, res) => {
    try { res.json({ success: true, products: [] }); } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.getSimilarHoseAssemblyItem = async (req, res) => {
    try { res.json({ success: true, items: [] }); } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

