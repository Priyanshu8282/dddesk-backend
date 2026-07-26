const mongoose = require('mongoose');

async function check() {
    const mongoURI = 'mongodb+srv://mgi_basket:76IcLMwawjgs89la@cluster0.iww448g.mongodb.net/mgibasket?retryWrites=true&w=majority';
    try {
        await mongoose.connect(mongoURI);
        const Product = mongoose.model('Product', new mongoose.Schema({ name: String, isDeleted: Boolean, status: Boolean }, { strict: false }));
        const productsCount = await Product.countDocuments({});
        console.log('Total Products in DB:', productsCount);
        
        const products = await Product.find({}).limit(2).lean();
        console.log('Sample Products:', JSON.stringify(products, null, 2));
    } catch (err) {
        console.error('Error:', err);
    } finally {
        await mongoose.disconnect();
    }
}
check();
