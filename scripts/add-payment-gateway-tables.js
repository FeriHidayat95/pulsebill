const mysql = require('mysql2/promise');

// Database Configuration
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'pulsebill_db',
    connectionLimit: 5
};

async function setupPaymentDatabase() {
    console.log('Memulai sinkronisasi tabel Payment Gateway ke MariaDB...');
    let dbPool;

    try {
        dbPool = mysql.createPool(dbConfig);

        // 1. CREATE TABLE payment_gateway_transactions
        const createTableQuery = `
            CREATE TABLE IF NOT EXISTS payment_gateway_transactions (
                id INT AUTO_INCREMENT PRIMARY KEY,
                invoice_id INT,
                gateway VARCHAR(50),
                order_id VARCHAR(100),
                payment_url TEXT,
                token VARCHAR(255),
                amount DECIMAL(10,2),
                status VARCHAR(50),
                payment_type VARCHAR(50),
                fraud_status VARCHAR(50),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
            )
        `;
        await dbPool.query(createTableQuery);
        console.log('? Tabel payment_gateway_transactions berhasil dicek/dibuat');

        // Helper Function untuk menambah kolom tanpa error jika sudah ada
        async function addColumnIfNotExists(table, column, definition) {
            try {
                await dbPool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
                console.log(`? Kolom '${column}' berhasil ditambahkan ke tabel '${table}'`);
            } catch (err) {
                // ER_DUP_FIELDNAME adalah kode error MariaDB jika kolom sudah ada
                if (err.code === 'ER_DUP_FIELDNAME') {
                    console.log(`?? Kolom '${column}' sudah ada di tabel '${table}', diabaikan.`);
                } else {
                    console.error(`? Error menambahkan kolom ${column}:`, err.message);
                }
            }
        }

        // 2. ADD COLUMNS TO invoices
        await addColumnIfNotExists('invoices', 'payment_gateway', 'VARCHAR(50)');
        await addColumnIfNotExists('invoices', 'payment_token', 'VARCHAR(255)');
        await addColumnIfNotExists('invoices', 'payment_url', 'TEXT');
        await addColumnIfNotExists('invoices', 'payment_status', "VARCHAR(50) DEFAULT 'pending'");

        // Helper Function untuk membuat Index tanpa error jika sudah ada
        async function createIndexIfNotExists(indexName, table, column) {
            try {
                await dbPool.query(`CREATE INDEX ${indexName} ON ${table}(${column})`);
                console.log(`? Index '${indexName}' berhasil dibuat`);
            } catch (err) {
                // ER_DUP_KEYNAME adalah kode error MariaDB jika index sudah ada
                if (err.code === 'ER_DUP_KEYNAME') {
                    console.log(`?? Index '${indexName}' sudah ada, diabaikan.`);
                } else {
                    console.error(`? Error membuat index ${indexName}:`, err.message);
                }
            }
        }

        // 3. CREATE INDEXES (Untuk performa pencarian tagihan yang cepat)
        await createIndexIfNotExists('idx_payment_gateway_transactions_invoice_id', 'payment_gateway_transactions', 'invoice_id');
        await createIndexIfNotExists('idx_payment_gateway_transactions_order_id', 'payment_gateway_transactions', 'order_id');

        console.log('?? Setup Database Payment Gateway Selesai!');

    } catch (error) {
        console.error('? Terjadi kesalahan fatal saat setup database:', error.message);
    } finally {
        if (dbPool) {
            await dbPool.end(); // Tutup koneksi agar script bisa berhenti dengan sempurna
        }
    }
}

// Jalankan fungsi
setupPaymentDatabase();