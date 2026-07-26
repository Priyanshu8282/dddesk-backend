const express = require('express');
const productsController = require('./product.controller');
const multerUpload = require('../../middlewares/upload.middleware');
const Authentication = require('../../middlewares/auth.middleware');
const Authorization = require('../../middlewares/authorization.middleware');

const router = express.Router();

// Wrapper for upload to match user's 'upload' naming in snippet
// Product image upload configuration
const upload = multerUpload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'images', maxCount: 10 }
]);

// Routes for Product Operations
router.post("/create-product", upload, Authentication, productsController.createProduct);
router.get("/get-products", Authentication, productsController.getProducts);
router.get("/get-all-products", Authentication, productsController.getAllProducts);
router.get("/get-products/:id", Authentication, productsController.getProductById);
router.get("/get-product-details/:id", productsController.getProductByQrScannerCode);

router.patch("/edit-product/:id", upload, Authentication, productsController.updateProduct);
router.delete("/delete-product/:id", Authentication, productsController.deleteProduct);
router.patch("/update-product-status/:id", Authentication, productsController.updateProductStatus);
router.get('/generateqr/:id', productsController.generateQrForProduct);
router.get("/search", productsController.searchProducts);
router.get("/simibrands", productsController.getSimilarProducts);
router.get("/hoseassembly", productsController.getSimilarHoseAssemblyItem);

module.exports = router;
