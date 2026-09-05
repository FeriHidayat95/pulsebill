const express = require('express');
const router = express.Router();
const { adminAuth } = require('./adminAuth');
const dashboardManager = require('../config/dashboardManager'); 
const { getSettingsWithCache } = require('../config/settingsManager');

// 1. PINTU DEPAN: Buka halaman secepat kilat (Tanpa nunggu database)
router.get('/dashboard', adminAuth, (req, res) => {
    try {
        const settings = getSettingsWithCache();
        res.render('adminDashboard', {
            title: 'Monitoring Dashboard',
            page: 'dashboard',
            settings: settings
            // Sengaja tidak bawa data berat di sini biar instan!
        });
    } catch (e) {
        res.status(500).send("Error render frame.");
    }
});

// 2. JALUR BELAKANG: Kurir AJAX untuk kirim data
router.get('/api/dashboard-stats', adminAuth, async (req, res) => {
    try {
        const data = await dashboardManager.getDashboardStats();
        res.json({ success: true, data: data });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

module.exports = router;