// Use as: express.json({ verify }) so signature checks (payment webhooks) can see the exact bytes.
// app.js already wires an equivalent inline verify; this is the shared, named version.
const verify = (req, res, buf) => {
    req.rawBody = buf;
};

module.exports = { verify };
