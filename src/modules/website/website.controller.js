const Category = require('../categories/category.model');
const SubCategory = require('../subcategories/subcategory.model');
const Brand = require('../brands/brand.model');
const VariantType = require('../variantTypes/variantType.model');
const VariantValue = require('../variantTypes/variantValue.model');

const unitAwareSort = (a, b) => {
    const parseValue = (str) => {
        if (!str) return { magnitude: 0, unit: '' };
        const match = str.toLowerCase().match(/^([\d.]+)\s*([a-z]+)$/);
        if (!match) return { magnitude: parseFloat(str) || 0, unit: '' };

        let magnitude = parseFloat(match[1]);
        const unit = match[2];

        const scales = {
            'kg': 1000, 'kilogram': 1000, 'kilograms': 1000,
            'g': 1, 'gram': 1, 'grams': 1,
            'mg': 0.001, 'milligram': 0.001,
            'l': 1000, 'liter': 1000, 'litre': 1000, 'liters': 1000,
            'ml': 1, 'milliliter': 1, 'millilitre': 1,
            'pcs': 1, 'pc': 1, 'unit': 1, 'units': 1
        };

        return { magnitude: magnitude * (scales[unit] || 1), unit };
    };

    const strA = a.label || '';
    const strB = b.label || '';

    const valA = parseValue(strA);
    const valB = parseValue(strB);

    if (valA.magnitude !== valB.magnitude) {
        return valA.magnitude - valB.magnitude;
    }
    return strA.localeCompare(strB, undefined, { numeric: true, sensitivity: 'base' });
};

// GET /website/categories
exports.getCategories = async (req, res) => {
    try {
        const { masterCategory } = req.query;
        const filter = { isDeleted: { $ne: true } };
        if (masterCategory) filter.masterCategory = masterCategory;
        const categories = await Category.find(filter).select('name image masterCategory').lean();
        res.json({ success: true, categories });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// GET /website/subcategories
exports.getSubcategories = async (req, res) => {
    try {
        const { categoryId, masterCategory } = req.query;
        const filter = { isDeleted: { $ne: true } };
        if (categoryId) filter.categoryId = categoryId;
        if (masterCategory) filter.masterCategory = masterCategory;
        const subcategories = await SubCategory.find(filter).populate('categoryId', 'name').lean();
        res.json({ success: true, subcategories });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// GET /website/brands
exports.getBrands = async (req, res) => {
    try {
        const { masterCategory } = req.query;
        const filter = { isDeleted: { $ne: true } };
        if (masterCategory) filter.masterCategory = masterCategory;
        const brands = await Brand.find(filter).select('name image masterCategory').lean();
        res.json({ success: true, brands });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};
