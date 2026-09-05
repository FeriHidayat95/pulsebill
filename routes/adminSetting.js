const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const multer = require('multer');
const { adminAuth } = require('./adminAuth'); 
const settingsManager = require('../config/settingsManager'); 
const whatsappManager = require('../config/whatsapp'); 

// --- KONFIGURASI UPLOAD LOGO ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, '../public/img')),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, 'logo' + ext); // Selalu timpa file lama dengan nama 'logo'
    }
});
const upload = multer({ 
    storage: storage, 
    limits: { fileSize: 2 * 1024 * 1024 }, // Max 2MB
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/') || file.originalname.toLowerCase().endsWith('.svg')) cb(null, true);
        else cb(new Error('Hanya file gambar yang diizinkan'), false);
    }
});

// ==========================================
// 1. TAMPILAN & DATA SETTING
// ==========================================
router.get('/', adminAuth, (req, res) => {
    res.render('adminSetting', { settings: settingsManager.getSettingsWithCache() });
});

router.get('/data', adminAuth, (req, res) => {
    try {
        const settings = settingsManager.getSettingsWithCache();
        // Fallback aman untuk Tripay agar EJS tidak error undefined
        settings.payment_gateway = settings.payment_gateway || {};
        settings.payment_gateway.tripay = settings.payment_gateway.tripay || { base_url: '' };
        res.json(settings);
    } catch (e) {
        res.status(500).json({ error: 'Gagal mengambil settings' });
    }
});

router.post('/save', adminAuth, (req, res) => {
    try {
        const newSettings = req.body;
        if (!newSettings || typeof newSettings !== 'object') {
            return res.status(400).json({ success: false, error: 'Data tidak valid' });
        }

        // Sanitasi (Ubah 'true'/'false' string jadi Boolean asli)
        for (const [key, value] of Object.entries(newSettings)) {
            if (key === null || key === undefined || key === '') continue;
            let finalVal = value;
            if (value === 'true') finalVal = true;
            else if (value === 'false') finalVal = false;
            
            settingsManager.setSetting(key, finalVal);
        }

        res.json({ success: true, message: 'Pengaturan berhasil disimpan' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/upload-logo', adminAuth, upload.single('logo'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, error: 'Tidak ada file yang dipilih' });
        
        settingsManager.setSetting('logo_filename', req.file.filename);
        res.json({ success: true, filename: req.file.filename, message: 'Logo berhasil diupload' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// 2. KONTROL WHATSAPP
// ==========================================
router.get('/wa-status', adminAuth, (req, res) => {
    try {
        const status = whatsappManager.getWhatsAppStatus();
        res.json({
            connected: status.connected || false,
            qr: status.qrCode || status.qr || null,
            phoneNumber: status.phoneNumber || null,
            status: status.status || 'disconnected'
        });
    } catch (e) { res.status(500).json({ connected: false, error: e.message }); }
});

router.post('/wa-refresh', adminAuth, async (req, res) => {
    try {
        await whatsappManager.deleteWhatsAppSession();
        setTimeout(() => res.json({ success: true, message: 'Sesi WhatsApp direset.' }), 1000);
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/wa-delete', adminAuth, async (req, res) => {
    try {
        await whatsappManager.deleteWhatsAppSession();
        res.json({ success: true, message: 'Sesi WhatsApp dihapus.' });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ==========================================
// 3. BACKUP & RESTORE DATABASE
// ==========================================
router.get('/backups', adminAuth, (req, res) => {
    try {
        res.json({ success: true, backups: settingsManager.getBackupsList() });
    } catch (error) { 
        res.status(500).json({ success: false, error: error.message }); 
    }
});

router.post('/backup', adminAuth, async (req, res) => {
    try {
        const result = await settingsManager.createDatabaseBackup(req.session?.adminUsername, req);
        res.json({ success: true, message: 'Backup Database berhasil.', backup_file: result.filename });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/restore', adminAuth, async (req, res) => {
    try {
        const { backup_file } = req.body;
        if (!backup_file) return res.status(400).json({ success: false, message: 'Pilih file backup dulu.' });

        await settingsManager.restoreDatabase(backup_file, req.session?.adminUsername, req);
        res.json({ success: true, message: 'Database Berhasil Dipulihkan! Sistem akan direstart otomatis.' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

router.get('/download-backup/:filename', adminAuth, (req, res) => {
    const filename = req.params.filename;
    const filepath = path.join(settingsManager.backupDir, filename);

    if (fs.existsSync(filepath) && filename.endsWith('.sql')) {
        res.download(filepath, filename, (err) => {
            if (err) res.status(500).send('Gagal mengunduh file.');
        });
    } else {
        res.status(404).send('File tidak ditemukan atau akses ditolak.');
    }
});

// ==========================================
// 4. ACTIVITY LOGS (REKAM JEJAK ADMIN)
// ==========================================
router.get('/activity-logs', adminAuth, async (req, res) => {
    try {
        const logs = await settingsManager.getActivityLogs();
        res.json({ success: true, logs: logs });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/clear-logs', adminAuth, async (req, res) => {
    try {
        await settingsManager.clearOldActivityLogs();
        res.json({ success: true, message: 'Log lama berhasil dibersihkan!' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;