const express = require('express');
const router = express.Router();
const { getSettingsWithCache } = require('../config/settingsManager'); // Pastikan path ini benar sesuai struktur folder Bos
const mysql = require('mysql2/promise');

// 1. DATABASE POOL CONFIGURATION
const dbPool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost', 
    user: process.env.DB_USER || 'root', 
    password: process.env.DB_PASSWORD || '', 
    database: process.env.DB_NAME || 'pulsebill_db', 
    connectionLimit: 10
});

// ==================================================================
// HALAMAN UTAMA: LAPORAN KEUANGAN & MEDIATOR
// ==================================================================
router.get('/', async (req, res) => {
    try {
        const settings = getSettingsWithCache() || {}; 
        
        // --- TAMBAHAN SULTAN: TANGKAP FILTER ---
        const filterMediator = req.query.mediator_id || null;
        const filterBulan = req.query.bulan || null;
        const tahunSekarang = new Date().getFullYear();
        
        // --- PERBAIKAN SULTAN: Kueri Dinamis Berdasarkan Filter ---
        let sql = `
            SELECT 
                f.*, 
                m.name as mediator_name, 
                COALESCE(c.name, 'TRANSAKSI UMUM') as customer_name, 
                COALESCE(c.address, '-') as customer_address,
                COALESCE((SELECT payment_method FROM payments WHERE invoice_id = f.invoice_id LIMIT 1), 'Cash/Manual') as metode_bayar
            FROM finance_reports f 
            LEFT JOIN mediators m ON f.mediator_id = m.id
            LEFT JOIN invoices i ON f.invoice_id = i.id
            LEFT JOIN customers c ON i.customer_id = c.id
            WHERE 1=1
        `;
        
        let params = [];

        // 1. Logika Filter Mediator
        if (filterMediator && filterMediator !== "") {
            sql += ` AND f.mediator_id = ?`;
            params.push(filterMediator);
        }

        // 2. Logika Filter Bulan (Atau Default 2 Bulan Terakhir)
        if (filterBulan && filterBulan !== "") {
            sql += ` AND MONTH(f.payment_date) = ? AND YEAR(f.payment_date) = ?`;
            params.push(filterBulan, tahunSekarang);
        } else {
            sql += ` AND f.payment_date >= DATE_SUB(CURDATE(), INTERVAL 2 MONTH)`;
        }

        sql += ` ORDER BY f.payment_date DESC LIMIT 1000`;
        const [laporan] = await dbPool.execute(sql, params);
        
        // 2. Ambil Data Master Mediator (Untuk Dropdown Pilihan)
        const [mediators] = await dbPool.execute("SELECT * FROM mediators ORDER BY name ASC");

        // 3. Hitung Statistik untuk Kartu di Atas Dashboard
        let totalKomisi = 0;
        let totalUangMasuk = 0;

        laporan.forEach(row => {
            // Pastikan angka tidak null/NaN
            totalKomisi += parseFloat(row.commission_amount || 0);
            // Tambahkan hanya jika ini pendapatan (+)
            if (parseFloat(row.amount || row.total_price || 0) > 0) {
                 totalUangMasuk += parseFloat(row.amount || row.total_price || 0);
            }
        });

        // 4. RENDER KE FILE EJS
        res.render('admin/billing/mediator-report', { 
            settings,           // Settingan Header/Judul ISP
            laporan,            // Data Tabel Transaksi
            mediators,          // Data Dropdown Mediator
            totalKomisi,        // Data Kartu Statistik
            totalUangMasuk,     // Data Kartu Statistik
            totalTrx: laporan.length, // Jumlah Transaksi
            filterMediator,     // Kirim ke EJS untuk set selected dropdown
            filterBulan         // Kirim ke EJS untuk set selected dropdown
        });

    } catch (error) {
        console.error("Error di Halaman Finance:", error);
        res.status(500).send("Terjadi kesalahan pada database: " + error.message);
    }
});

// ==================================================================
// API 1: SIMPAN / EDIT MASTER MEDIATOR
// ==================================================================
router.post('/api/mediator-save', async (req, res) => {
    const { id, name, commission } = req.body;
    try {
        if(id && id != 0) {
            // Update Mediator Lama
            await dbPool.execute(
                "UPDATE mediators SET name=?, commission=? WHERE id=?", 
                [name, commission, id]
            );
        } else {
            // Insert Mediator Baru
            await dbPool.execute(
                "INSERT INTO mediators (name, commission) VALUES (?, ?)", 
                [name, commission]
            );
        }
        res.json({ success: true });
    } catch(e) { 
        res.json({ success: false, message: e.message }); 
    }
});

// ==================================================================
// API 2: HAPUS MEDIATOR
// ==================================================================
router.post('/api/mediator-delete', async (req, res) => {
    try {
        await dbPool.execute("DELETE FROM mediators WHERE id=?", [req.body.id]);
        res.json({ success: true });
    } catch(e) { 
        res.json({ success: false, message: e.message }); 
    }
});

// ==================================================================
// API 3: BULK UPDATE (VERSI ASLI SULTAN - ANTI CRASH LOCK) ???
// ==================================================================
router.post('/api/bulk-update', async (req, res) => {
    const data = req.body; 
    const conn = await dbPool.getConnection(); 
    
    try {
        await conn.beginTransaction();

        for(let item of data) {
            // Ambil data ID mediator apa adanya dari browser
            let medId = item.mediator_id;

            // Jika datanya kosong, string kosong, atau angka 0, paksa jadi null objek asli database
            if (medId === "" || medId === "null" || medId === 0 || !medId) {
                medId = null;
            } else {
                medId = parseInt(medId); // Pastikan dikirim sebagai angka murni
            }

            // Gunakan query execute asli bawaan Bos, tanpa trik "|| null" di dalam array parameter
            await conn.execute(
                "UPDATE finance_reports SET mediator_id = ?, commission_amount = ? WHERE id = ?",
                [medId, item.comm || 0, item.id]
            );
        }

        await conn.commit();
        res.json({ success: true });

    } catch (e) {
        await conn.rollback();
        console.error("Error Bulk Update:", e);
        res.status(500).json({ success: false, message: e.message });
    } finally {
        conn.release();
    }
});

// ==========================================
// [FINAL] FUNGSI HAPUS MASAL LAPORAN
// ==========================================
router.post('/api/bulk-delete-reports', async (req, res) => {
    const { ids } = req.body;

    // Cek apakah ada data yang dikirim
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.json({ success: false, message: 'Pilih data yang ingin dihapus dulu, Bos!' });
    }

    try {
        // Eksekusi Hapus Permanen
        const [result] = await dbPool.query(
            "DELETE FROM finance_reports WHERE id IN (?)", 
            [ids]
        );

        console.log(`[BULK DELETE] ${result.affectedRows} laporan dibersihkan oleh Admin.`);

        res.json({ 
            success: true, 
            message: `${result.affectedRows} data laporan berhasil dihapus selamanya!` 
        });

    } catch (error) {
        console.error("? Database Error (Bulk Delete):", error.message);
        res.status(500).json({ 
            success: false, 
            message: 'Gagal menghapus: ' + error.message 
        });
    }
});

module.exports = router;