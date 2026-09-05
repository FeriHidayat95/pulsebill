const dbPool = require('../config/database');
async function run() {
    const conn = await dbPool.getConnection();
    try {
        // Cek kolom
        const [cols] = await conn.query("SHOW COLUMNS FROM invoices LIKE 'tripay_url'");
        if (cols.length === 0) {
            await conn.query("ALTER TABLE invoices ADD COLUMN tripay_url TEXT DEFAULT NULL AFTER status");
            console.log("✅ Kolom 'tripay_url' berhasil ditambahkan.");
        } else {
            console.log("ℹ️ Kolom 'tripay_url' sudah ada.");
        }
    } catch(e) { console.error(e); }
    finally { conn.release(); process.exit(); }
}
run();
