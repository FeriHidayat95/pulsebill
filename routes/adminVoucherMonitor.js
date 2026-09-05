const express = require('express');
const router = express.Router();
const { getSettingsWithCache } = require('../config/settingsManager');
const { RadiusManager } = require('../config/RadiusManager'); // Terhubung ke Pintu Otak
const { adminAuth } = require('./adminAuth'); // [PENGAMANAN] Import middleware admin

// =============================================================
// 1. TAMPILAN MONITORING & STOK VOUCHER
// =============================================================
router.get('/', adminAuth, async (req, res) => {
    const settings = getSettingsWithCache() || {};
    try {
        // Panggil Si Otak, kirim parameter query (profile, search, status)
        const data = await RadiusManager.getVoucherMonitorData(req.query);

        res.render('adminVoucherMonitor', {
            vouchers: data.vouchers,
            stokData: data.stokData, // Data kartu dikirim secara dinamis
            currentProfile: req.query.profile || '',
            currentSearch: req.query.search || '',
            currentStatus: req.query.status || '',
            page: 'voucher-monitor', 
            company_header: settings.company_header || "pulsebill.io",
            settings
        });
    } catch (e) {
        console.error("[VOUCHER MONITOR ERROR]", e.message);
        res.send("Error Monitoring: " + e.message);
    }
});

// =============================================================
// 2. HAPUS VOUCHER MASSAL DARI MONITORING
// =============================================================
router.post('/delete-bulk', adminAuth, async (req, res) => {
    try {
        const { selectedVouchers } = req.body;
        
        // Panggil eksekutor dari Si Otak
        const result = await RadiusManager.deleteBulkMonitorVouchers(selectedVouchers);
        res.json(result);
        
    } catch (e) {
        console.error("[DELETE BULK VOUCHER ERROR]", e.message);
        // Mengembalikan properti "error" agar sesuai dengan handling EJS asli Bos
        res.json({ success: false, error: e.message }); 
    }
});

module.exports = router;