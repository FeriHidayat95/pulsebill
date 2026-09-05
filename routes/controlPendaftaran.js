const express = require('express');
const router = express.Router();
const { adminAuth } = require('./adminAuth');
const billingManager = require('../config/billing'); // Panggil Manager Utama

// 1. HALAMAN UTAMA (DASHBOARD ADMIN) - SULTAN SYNC
router.get('/', adminAuth, async (req, res) => {
    try {
        // [SULTAN SYNC] Mengambil data dashboard dan data pelanggan yang sudah divalidasi secara paralel
        // agar performa tetap maksimal dan data sinkron dengan tab baru di EJS.
        const [data, validatedList] = await Promise.all([
            billingManager.getPendaftaranDashboardData(),
            billingManager.getValidatedRegistrations() // <--- OTOT BARU: Mengambil data hasil teknisi
        ]);

        res.render('admin/billing/pendaftaran_control', { 
            ...data,
            validatedList: validatedList, // <--- DISINKRONKAN: Mengirim data ke tab "Pelanggan Aktif"
            page: 'pendaftaran',
            
            // ? INI YANG DIGANTI BOS! (ID Card Sultan dipasang di sini)
            user: res.locals.user 
            
        });
    } catch (error) {
        // Logging error untuk memudahkan Sultan memantau kesehatan server
        console.error("?? Error loading pendaftaran control:", error.message);
        res.status(500).send("Server Error: Gagal memuat data pendaftaran.");
    }
});

// 2. MANAJEMEN TEKNISI
router.post('/api/save-tech', adminAuth, async (req, res) => {
    try {
        await billingManager.saveTechnician(req.body);
        res.json({ success: true, message: "Pasukan berhasil ditambahkan!" });
    } catch (error) {
        res.json({ success: false, message: "Gagal menyimpan: " + error.message });
    }
});

router.post('/api/delete-tech', adminAuth, async (req, res) => {
    try {
        await billingManager.deleteTechnician(req.body.id);
        res.json({ success: true, message: "Akses teknisi dicabut." });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// 3. ALARM NOTIFIKASI
router.get('/api/check-pending', async (req, res) => {
    try {
        const count = await billingManager.getPendingCount();
        res.json({ success: true, count });
    } catch (error) {
        res.json({ success: false, count: 0 });
    }
});

// 4. VALIDASI PENDAFTARAN (SINKRON RADIUS)
router.post('/api/validate', adminAuth, async (req, res) => {
    try {
        await billingManager.validateRegistration(req.body.id);
        res.json({ success: true, message: "Pelanggan Aktif & Radius Sinkron!" });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// 5. TOLAK PENDAFTARAN
router.post('/api/reject', adminAuth, async (req, res) => {
    try {
        await billingManager.rejectRegistration(req.body.id);
        res.json({ success: true, message: "Pendaftaran ditolak." });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// API UPDATE DATA DIVALIDASI (Koreksi ODP/Port dari Admin)
router.post('/api/update-validated', adminAuth, async (req, res) => {
    try {
        const { id, address, odp_data, port_data } = req.body;
        const db = require('../config/database'); 
        
        await db.execute(
            "UPDATE pending_registrations SET address = ?, odp_data = ?, port_data = ? WHERE id = ?",
            [address, odp_data, port_data, id]
        );

        res.json({ success: true, message: "Data PSB Berhasil Dikoreksi!" });
    } catch (error) {
        res.json({ success: false, message: "Gagal update: " + error.message });
    }
});

// API HAPUS DATA DIVALIDASI (Pembersih Riwayat)
router.post('/api/delete-validated', adminAuth, async (req, res) => {
    try {
        const db = require('../config/database');
        await db.execute("DELETE FROM pending_registrations WHERE id = ?", [req.body.id]);
        
        res.json({ success: true, message: "Riwayat berhasil dihapus!" });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

module.exports = router;