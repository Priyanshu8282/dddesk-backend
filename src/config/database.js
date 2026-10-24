const mongoose = require("mongoose");
const config = require("./config");

let isConnected = false;

const connectDB = async () => {
    if (isConnected || mongoose.connection.readyState === 1) {
        isConnected = true;
        return;
    }

    try {
        const connectOptions = {
            minPoolSize: Number(process.env.DB_MIN_POOL || 5),   // keep connections open: a new one costs seconds on a distant cluster
            maxPoolSize: Number(process.env.DB_MAX_POOL || 20),
            compressors: ['zlib'],      // smaller payloads over a slow link
            serverSelectionTimeoutMS: 20000,
            socketTimeoutMS: 60000,
        };
        if (process.env.DB_IP_FAMILY) {
            connectOptions.family = Number(process.env.DB_IP_FAMILY);
        }

        const db = await mongoose.connect(config.mongoose.url, connectOptions);
        isConnected = db.connections[0].readyState === 1;
        console.log("Connected to MongoDB Atlas");
    } catch (e) {
        console.error("Failed to connect to DB:", e.message);
    }
};

module.exports = connectDB;
