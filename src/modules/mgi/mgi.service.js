/**
 * mgi.service.js
 * 
 * SOAP client singleton for the MGI Affiliate API.
 * Translates all SOAP XML communication into clean JavaScript objects.
 * 
 * Production WSDL: http://mgicard.in/AffiliateAPI.asmx?wsdl
 */

const soap = require('soap');

// ─── SOAP Client Singleton ───────────────────────────────────────────────────

let _soapClient = null;

/**
 * Returns a cached SOAP client or creates one.
 * Auth header is attached automatically on every call.
 */
async function getClient() {
    if (_soapClient) return _soapClient;

    const wsdlUrl = process.env.MGI_SOAP_URL;
    if (!wsdlUrl) {
        throw new Error('MGI_SOAP_URL is not configured in environment variables.');
    }

    try {
        _soapClient = await soap.createClientAsync(wsdlUrl, {
            wsdl_options: { timeout: 15000 },
        });

        // Attach authentication SOAP header — sent on every request
        const affiliateId = parseInt(process.env.MGI_AFFILIATE_ID || '1', 10);
        const affiliateKey = process.env.MGI_AFFILIATE_KEY || 'dummy_key';

        _soapClient.addSoapHeader(
            {
                Authenticate: {
                    AffiliateID: affiliateId,
                    AffiliateAuthKey: affiliateKey,
                },
            },
            '',
            'tns',
            'http://tempuri.org/'
        );

        console.log('[MGI_SERVICE] SOAP client initialized successfully.');
        return _soapClient;
    } catch (err) {
        _soapClient = null; // Reset so next call retries
        console.error('[MGI_SERVICE] Failed to initialize SOAP client:', err.message);
        throw new Error(`MGI SOAP client initialization failed: ${err.message}`);
    }
}

// ─── Helper: Parse MGI Error Block ──────────────────────────────────────────

function parseError(response) {
    const errorBlock = response?.Error || response?.error;
    if (!errorBlock) return null;

    const status = errorBlock.Status || errorBlock.status;
    const errorNo = parseInt(errorBlock.ErrorNo || errorBlock.errorNo || '0', 10);
    const errorDesc = errorBlock.ErrorDesc || errorBlock.errorDesc || '';

    if (status === 'Fail' || errorNo !== 0) {
        return { errorNo, errorDesc };
    }
    return null;
}

// ─── Helper: Safely convert to array ────────────────────────────────────────
function toArray(val) {
    if (!val) return [];
    return Array.isArray(val) ? val : [val];
}

// ─── Method 1: ValidateCustomer ─────────────────────────────────────────────

/**
 * Validates whether a customer exists in the MGI system.
 * @param {string} mobile   Customer mobile number
 * @param {string} customerCode   MGI customer code (card number)
 * @returns {{ firstName, middleName, lastName, mobile, customerCode }}
 */
async function validateCustomer(mobile, customerCode) {
    const client = await getClient();

    const args = {
        Mobile: mobile,
        CustomerCode: customerCode,
    };

    const [result] = await client.ValidateCustomerAsync(args);
    const response = result?.ValidateCustomerResult || result;

    const mgiError = parseError(response);
    if (mgiError) {
        const err = new Error(mgiError.errorDesc || 'Customer validation failed.');
        err.errorNo = mgiError.errorNo;
        throw err;
    }

    const details = response?.Details || {};
    return {
        customerCode: details.CustomerCode || customerCode,
        firstName: details.FirstName || '',
        middleName: details.MiddleName || '',
        lastName: details.LastName || '',
        mobile: details.Mobile || mobile,
        fullName: [details.FirstName, details.MiddleName, details.LastName]
            .filter(Boolean).join(' ').trim(),
    };
}

// ─── Method 2: GetAffiliateCategoryDetail ───────────────────────────────────

/**
 * Returns all cashback categories configured for this affiliate.
 * @returns {Array} List of category objects
 */
async function getCategories() {
    const client = await getClient();

    const [result] = await client.GetAffiliateCategoryDetailAsync({});
    const response = result?.GetAffiliateCategoryDetailResult || result;

    const mgiError = parseError(response);
    if (mgiError) {
        const err = new Error(mgiError.errorDesc || 'Failed to fetch categories.');
        err.errorNo = mgiError.errorNo;
        throw err;
    }

    const detailsRaw = response?.Details;
    const detailsArr = toArray(detailsRaw);

    return detailsArr.map(d => ({
        code: d.ProductServiceCategoryCode || '',
        name: d.ProductServiceCategoryName || '',
        commissionToMGI: parseFloat(d.CommPercentageToMGI || '0'),
        bvPointPercentage: parseFloat(d.BVPointPercentageOnOrderAmt || '0'),
        isActive: d.IsActive === 'True' || d.IsActive === true,
        slabs: toArray(d.Slab).map(s => ({
            fromAmount: parseFloat(s.FromAmount || '0'),
            toAmount: parseFloat(s.ToAmount || '0'),
            commPerToMGI: parseFloat(s.CommPerToMGI || '0'),
        })),
    }));
}

// ─── Method 3: AddOrder ─────────────────────────────────────────────────────

/**
 * Books an order with MGI.
 * @param {Object} payload
 * @param {string} payload.customerCode
 * @param {string} payload.billNo
 * @param {string} payload.billDate   e.g. "23/Sep/2021"
 * @param {string} payload.remark
 * @param {Array}  payload.orderDetails  [{ categoryCode, amount }]
 * @returns Confirmed order details from MGI
 */
async function addOrder({ customerCode, billNo, billDate, remark = 'Order Placed', orderDetails }) {
    const client = await getClient();

    const args = {
        Orders: {
            CustomerCode: customerCode,
            BillNo: billNo,
            BillDate: billDate,
            Remark: remark,
            OrderDetail: orderDetails.map(d => ({
                ProductServiceCategoryCode: d.categoryCode,
                PSCategoryAmt: d.amount,
            })),
        },
    };

    const [result] = await client.AddOrderAsync(args);
    const response = result?.AddOrderResult || result;

    const mgiError = parseError(response);
    if (mgiError) {
        const err = new Error(mgiError.errorDesc || 'Order booking failed.');
        err.errorNo = mgiError.errorNo;
        throw err;
    }

    const detailsRaw = toArray(response?.OrderDetail?.Detail || response?.OrderDetail);

    return {
        orderNo: response?.OrderNo ? parseInt(response.OrderNo, 10) : null,
        billNo: response?.BillNo || billNo,
        billDate: response?.BillDate || billDate,
        remark: response?.Remark || remark,
        totalPsAmount: parseFloat(response?.TotalPSCategoryAmt || '0'),
        totalCommissionAmount: parseFloat(response?.TotalCommAmt || '0'),
        totalBvPointAmount: parseFloat(response?.TotalBVPointAmt || '0'),
        orderDetails: detailsRaw.map(d => ({
            categoryCode: d.ProductServiceCategoryCode || '',
            psAmount: parseFloat(d.PSCategoryAmt || '0'),
            commissionAmount: parseFloat(d.CommAmt || '0'),
            bvPointAmount: parseFloat(d.BVPointAmt || '0'),
        })),
        rawResponse: response,
    };
}

// ─── Method 4: OrderHistory ──────────────────────────────────────────────────

/**
 * Fetches order history. All params are optional — pass empty string to skip.
 * @param {Object} filters
 * @param {string} filters.orderNo
 * @param {string} filters.customerCode
 * @param {string} filters.billNo
 * @param {string} filters.orderFromDate
 * @param {string} filters.orderToDate
 * @param {string} filters.billFromDate
 * @param {string} filters.billToDate
 * @returns {Array} List of order history objects
 */
async function getOrderHistory({
    orderNo = '',
    customerCode = '',
    billNo = '',
    orderFromDate = '',
    orderToDate = '',
    billFromDate = '',
    billToDate = '',
} = {}) {
    const client = await getClient();

    const args = {
        OrderHistory: {
            OrderNo: orderNo,
            CustomerCode: customerCode,
            BillNo: billNo,
            OrderFromDate: orderFromDate,
            OrderToDate: orderToDate,
            BillFromDate: billFromDate,
            BillToDate: billToDate,
        },
    };

    const [result] = await client.OrderHistoryAsync(args);
    const response = result?.OrderHistoryResult || result;

    const mgiError = parseError(response);
    if (mgiError) {
        const err = new Error(mgiError.errorDesc || 'Failed to fetch order history.');
        err.errorNo = mgiError.errorNo;
        throw err;
    }

    const ordersRaw = toArray(response?.Orders);

    return ordersRaw.map(o => ({
        orderNo: o.OrderNo ? parseInt(o.OrderNo, 10) : null,
        billNo: o.BillNo || '',
        billDate: o.BillDate || '',
        remark: o.Remark || '',
        customerCode: o.CustomerCode || '',
        customerName: [o.FirstName, o.MiddleName, o.LastName].filter(Boolean).join(' ').trim(),
        customerMobile: o.CustomerMobile || '',
        statusDescription: o.StatusDescription || '',
        orderDate: o.OrderDate || '',
        totalPsAmount: parseFloat(o.TotalPSCategoryAmt || '0'),
        totalCommissionAmount: parseFloat(o.TotalCommissionAmt || '0'),
        totalBvPointAmount: parseFloat(o.TotalBVPointAmt || '0'),
        orderDetails: toArray(o.OrderDetail).map(d => ({
            categoryCode: d.ProductServiceCategoryCode || '',
            psAmount: parseFloat(d.PSCategoryAmt || '0'),
            commPercentage: d.CommPercentage || '0%',
            commissionAmount: parseFloat(d.CommissionAmt || '0'),
            bvPointPercentage: d.BVPointPercentage || '0%',
            bvPointAmount: parseFloat(d.BVPointAmt || '0'),
        })),
    }));
}

// ─── Method 5: GetLedgerDetails ─────────────────────────────────────────────

/**
 * Fetches the affiliate's financial ledger for a date range.
 * @param {string} fromDate  e.g. "23/Sep/2021"
 * @param {string} toDate    e.g. "23/Sep/2021"
 * @returns {Array} Ledger entries
 */
async function getLedger(fromDate, toDate) {
    const client = await getClient();

    const args = {
        GetLedgerDetails: {
            FromDate: fromDate,
            ToDate: toDate,
        },
    };

    const [result] = await client.GetLedgerDetailsAsync(args);
    const response = result?.GetLedgerDetailsResult || result;

    const mgiError = parseError(response);
    if (mgiError) {
        const err = new Error(mgiError.errorDesc || 'Failed to fetch ledger.');
        err.errorNo = mgiError.errorNo;
        throw err;
    }

    const detailsRaw = toArray(response?.Details);

    return detailsRaw.map(d => ({
        remark: d.Remark || '',
        voucherOrOrderNo: d.VoucherOrOrderNo || '',
        paymentType: d.PaymentType || '',
        billNo: d.BillNo || '',
        transactionType: d.TransactionType || '',
        affiliateUserName: d.AffiliateUserName || '',
        transactionDate: d.TranDate || '',
        transactionAmount: parseFloat(d.TranAmount || '0'),
        balanceBefore: parseFloat(d.BalanceBefore || '0'),
        balanceAfter: parseFloat(d.BalanceAfter || '0'),
        creditOrDebit: d.CreditDebit || '',
    }));
}

module.exports = {
    validateCustomer,
    getCategories,
    addOrder,
    getOrderHistory,
    getLedger,
};
