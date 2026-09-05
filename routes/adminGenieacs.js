const express = require('express');
const router = express.Router();
const { adminAuth } = require('./adminAuth');
const genieacsManager = require('../config/genieacsManager');
const { getSettingsWithCache } = require('../config/settingsManager');

// --- SISTEM CACHE SEDERHANA UNTUK MENGHILANGKAN LOADING ---
let deviceCache = null;
let lastCacheTime = 0;
const CACHE_DURATION = 60 * 1000; // Cache bertahan 60 detik (1 menit)

// 1. TAMPILAN UTAMA LIST DEVICE (SISTEM AUDIT)
router.get('/genieacs', adminAuth, async (req, res) => {
    try {
        const settings = getSettingsWithCache();
        let data;

        if (deviceCache && (Date.now() - lastCacheTime < CACHE_DURATION)) {
            data = deviceCache;
        } else {
            data = await genieacsManager.getDeviceList();
            deviceCache = data;
            lastCacheTime = Date.now();
        }

        // --- SISTEM AUDIT DATA (CEK LOG PM2 SETELAH REFRESH) ---
        console.log("==========================================");
        console.log("AUDIT DEVICE MANAGER:");
        console.log("1. Data Terdefinisi:", !!data);
        console.log("2. Jumlah Device di Objek:", data?.devices ? data.devices.length : "KOSONG");
        console.log("3. Total dari Manager:", data?.genieacsTotal);
        console.log("==========================================");

        res.render('adminGenieacs', { ...data, settings });
    } catch (err) {
        // Tampilkan error asli di terminal agar tidak menebak
        console.error(">>> ERROR TERDETEKSI DI ROUTER:", err.message);
        console.error(err.stack);
        res.render('adminGenieacs', { devices: [], error: 'Gagal mengambil data dari GenieACS.' });
    }
});

// 2. EDIT SSID ATAU PASSWORD
router.post('/genieacs/edit', adminAuth, async (req, res) => {
    try {
        const { id, ssid, password } = req.body;
        
        // Tambahan Validasi: Pastikan ID Device selalu ada sebelum mengeksekusi perintah
        if (!id) {
            return res.status(400).json({ success: false, message: 'ID Device tidak boleh kosong' });
        }
        
        if (ssid !== undefined) {
            // Kirim respon cepat
            res.json({ success: true, field: 'ssid', message: 'Memproses update SSID...' });
            // Eksekusi dibelakang layar
            genieacsManager.updateSSIDOptimized(id, ssid).catch(e => console.log('Error update SSID:', e.message));
        } else if (password !== undefined) {
            res.json({ success: true, field: 'password', message: 'Memproses update Password...' });
            genieacsManager.updatePasswordOptimized(id, password).catch(e => console.log('Error update Password:', e.message));
        } else {
            res.status(400).json({ success: false, message: 'Tidak ada data yang dirubah' });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: 'Sistem error: ' + err.message });
    }
});

// 3. EDIT TAG / NOMOR PELANGGAN
router.post('/genieacs/edit-tag', adminAuth, async (req, res) => {
    try {
        const { id, tag } = req.body;
        if (!id || tag === undefined) return res.status(400).json({ success: false, message: 'Data tidak lengkap' });

        await genieacsManager.updateTag(id, tag);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Gagal update tag' });
    }
});

// 4. RESTART ONU
router.post('/genieacs/restart-onu', adminAuth, async (req, res) => {
    try {
        if (!req.body.id) return res.status(400).json({ success: false, message: 'ID Kosong' });

        await genieacsManager.restartDevice(req.body.id);
        res.json({ success: true, message: 'Perintah restart dikirim' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Gagal restart: ' + err.message });
    }
});

module.exports = router;