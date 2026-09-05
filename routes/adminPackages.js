const express = require('express');
const router = express.Router();
const billingManager = require('../config/billing'); // Pastikan Manager sudah ada fungsi-fungsinya
const { adminAuth } = require('./adminAuth');

router.use(adminAuth);

// 1. TAMPILAN UTAMA (GET)
router.get('/', async (req, res) => {
    try {
        const data = await billingManager.getPackageList();
        res.render('admin/packages/list', { 
            title: 'Kelola Paket Billing', 
            ...data,
            user: req.session.user 
        });
    } catch (e) {
        console.error("Error Loading Packages:", e.message);
        res.status(500).send('Sistem Error: ' + e.message);
    }
});

// 2. API GET SINGLE (Untuk Modal Edit - Disesuaikan dengan URL Frontend Anda)
router.get('/api/packages/:id', async (req, res) => {
    try {
        const pkg = await billingManager.getPackageById(req.params.id);
        if (!pkg) return res.json({ success: false, message: 'Paket tidak ditemukan' });
        res.json({ success: true, package: pkg });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// 3. TAMBAH PAKET (POST - Anti Stuck)
router.post('/', async (req, res) => {
    try {
        await billingManager.savePackage(req.body);
        res.json({ success: true, message: 'Paket berhasil ditambahkan' });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Gagal tambah: ' + e.message });
    }
});

// 4. EDIT PAKET (PUT - Anti Stuck & Sinkron dengan AJAX)
router.put('/:id', async (req, res) => {
    try {
        await billingManager.savePackage(req.body, req.params.id);
        res.json({ success: true, message: 'Paket berhasil diperbarui' });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Gagal update: ' + e.message });
    }
});

// 5. HAPUS PAKET (DELETE - Anti Stuck & Sinkron dengan AJAX)
router.delete('/:id', async (req, res) => {
    try {
        await billingManager.deletePackage(req.params.id);
        res.json({ success: true, message: 'Paket berhasil dihapus' });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Gagal hapus: ' + e.message });
    }
});

module.exports = router;