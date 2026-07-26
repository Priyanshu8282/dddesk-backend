const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

const Library = require('./src/modules/libraries/library.model');

const migrateLibraryCodes = async () => {
    try {
        console.log('Connecting to database...');
        await mongoose.connect(process.env.MONGODB_URL);
        console.log('Connected successfully.');

        const libraries = await Library.find({}).sort({ createdAt: 1 });
        console.log(`Found ${libraries.length} libraries to update.`);

        const year = new Date().getFullYear();
        let serial = 1;

        for (const lib of libraries) {
            const newCode = `LIB-${year}-${serial.toString().padStart(3, '0')}`;
            console.log(`Updating ${lib.name}: ${lib.libraryCode} -> ${newCode}`);
            
            lib.libraryCode = newCode;
            // Disable the pre-save hook for libraryCode by setting isNew to false if it's already saved,
            // but since we want to OVERWRITE, we just save it. 
            // Note: I updated the model to use if(this.isNew), so this save() WON'T trigger the generation again.
            await lib.save();
            
            serial++;
        }

        console.log('Migration completed successfully.');
        process.exit(0);
    } catch (error) {
        console.error('Migration failed:', error);
        process.exit(1);
    }
};

migrateLibraryCodes();
