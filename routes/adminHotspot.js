const express = require('express');
const router = express.Router();
const { getSettingsWithCache } = require('../config/settingsManager');
const { RadiusManager } = require('../config/RadiusManager'); // Pintu Otak
const { adminAuth } = require('../routes/adminAuth');

// =============================================================
// 1. HALAMAN MONITORING USER HOTSPOT AKTIF
// =============================================================
router.get('/', adminAuth, async (req, res) => {
    const settings = getSettingsWithCache() || {};
    try {
        // Memanggil fungsi dari Si Otak
        const cleanUsers = await RadiusManager.getActiveHotspotUsers();

        res.render('adminHotspot', {
            users: cleanUsers, 
            onlineCount: cleanUsers.length,
            company_header: settings.company_header || "pulsebill.io",
            settings: settings
        });

    } catch (e) {
        console.error('[HOTSPOT ERROR]', e.message);
        res.render('adminHotspot', { 
            users: [], 
            onlineCount: 0, 
            company_header: "Error", 
            settings: settings 
        });
    }
});

// =============================================================
// 2. API KICK USER (VERSI ANTI MAMPET)
// =============================================================
router.get('/kick/:router/:user', adminAuth, async (req, res) => {
    const { router: routerName, user } = req.params;
    
    try {
        // Serahkan instruksi tendang ke Si Otak
        await RadiusManager.kickHotspotUser(routerName, user);
        
        // Kembalikan ke halaman dashboard hotspot
        res.redirect('/admin/hotspot');
        
    } catch (e) { 
        console.error("[KICK FATAL ERROR]", e.message);
        // Tetap redirect agar admin tidak melihat halaman error putih
        res.redirect('/admin/hotspot'); 
    }
});

// =============================================================
// 3. PROFILE MANAGER
// =============================================================

// Tampilan Halaman Profile
router.get('/profiles', adminAuth, async (req, res) => {
    const settings = getSettingsWithCache() || {};
    try {
        // Panggil Si Otak untuk menghitung jumlah profile unik
        const profileCount = await RadiusManager.getHotspotProfileCount();
        
        res.render('adminHotspotProfile', { 
            profileCount, 
            company_header: settings.company_header, 
            settings, 
            nasList: [], 
            selectedNasId: '' 
        });
    } catch (e) { 
        console.error("[HOTSPOT PROFILE PAGE ERROR]", e.message);
        res.render('adminHotspotProfile', { 
            profileCount: 0, 
            company_header: "Error", 
            settings: {}, 
            nasList: [], 
            selectedNasId: '' 
        }); 
    }
});

// Endpoint API Profile (JSON)
router.get('/api/profiles', adminAuth, async (req, res) => {
    try {
        // Panggil Si Otak untuk mendapatkan data detail profile
        const profiles = await RadiusManager.getDetailedHotspotProfiles();
        
        res.json({ success: true, data: profiles });
    } catch (e) { 
        console.error("[API HOTSPOT PROFILES ERROR]", e.message);
        res.json({ success: false, message: e.message }); 
    }
});

// ==========================================
// API SAVE PROFILE HOTSPOT
// ==========================================
router.post('/api/save-profile', adminAuth, async (req, res) => {
    // Validasi input wajib sebelum masuk ke database
    if (!req.body.name || !req.body.rateLimit) {
        return res.status(400).json({ 
            success: false, 
            message: "Nama Paket dan Rate Limit Wajib Diisi!" 
        });
    }

    try {
        // Teruskan data payload utuh ke Si Otak
        const result = await RadiusManager.saveHotspotProfile(req.body);
        res.json(result);
    } catch (e) { 
        res.status(500).json({ success: false, message: e.message }); 
    }
});

// ==========================================
// API DELETE PROFILE HOTSPOT
// ==========================================
router.post('/api/delete-profile', adminAuth, async (req, res) => {
    try {
        const { name } = req.body;
        const result = await RadiusManager.deleteHotspotProfile(name);
        res.json(result);
    } catch (e) { 
        res.status(500).json({ success: false, message: e.message }); 
    }
});

// =============================================================
// 4. VOUCHER LIST & PENCARIAN (SULTAN ENGINE INTEGRATED)
// =============================================================

router.get('/voucher', adminAuth, async (req, res) => {
    try {
        const settings = getSettingsWithCache() || {};
        
        // Panggil Si Otak untuk ambil data statistik dan daftar profil
        const data = await RadiusManager.getVoucherStatsAndProfiles();
        
        res.render('adminVoucher', { 
            settings, 
            profiles: data.profiles, 
            voucherHistory: [],
            company_header: settings.company_header || "pulsebill.io",
            stats: data.stats
        });
    } catch (e) { 
        console.error("[VOUCHER PAGE ERROR]", e.message); 
        res.send("Error Database: " + e.message); 
    }
});

// Endpoint API untuk Pencarian Voucher
router.post('/api/voucher-history', adminAuth, async (req, res) => {
    try {
        // Eksekusi pencarian melalui Si Otak
        const vouchers = await RadiusManager.searchVouchers(req.body);
        
        res.json({ 
            success: true, 
            vouchers: vouchers, 
            namaHotspot: getSettingsWithCache().company_header || "pulsebill.io" 
        });
    } catch (e) {
        console.error("[API VOUCHER HISTORY ERROR]", e.message);
        res.json({ success: false, message: e.message });
    }
});

// =============================================================
// 5. GENERATE VOUCHER & TAMBAH MANUAL
// =============================================================
router.post('/generate-voucher', adminAuth, async (req, res) => {
    const { count, profile } = req.body;
    
    // 1. Pagar Keamanan: Limit Maksimal Generate
    if(parseInt(count) > 750) {
        return res.json({ 
            success: false, 
            message: "Limit maksimal 750 voucher!" 
        });
    }

    try {
        // 2. Eksekusi Generate Melalui Si Otak
        const result = await RadiusManager.generateHotspotVouchers(req.body);
        
        // 3. Respon ke Frontend
        res.json({ 
            success: true, 
            vouchers: result.vouchers, 
            profile: result.profile, 
            price: result.price, 
            namaHotspot: getSettingsWithCache().company_header || "pulsebill.io" 
        });

    } catch (e) {
        console.error("[GENERATE VOUCHER ERROR]", e.message);
        res.json({ success: false, message: e.message });
    }
});

// ==========================================
// API TAMBAH USER HOTSPOT (MANUAL)
// ==========================================
router.post('/add-user', adminAuth, async (req, res) => {
    try {
        // Serahkan data pendaftaran ke Si Otak (RadiusManager)
        const result = await RadiusManager.addUser(req.body);
        
        // Kirim respon sukses ke Frontend
        res.json(result);

    } catch (e) {
        console.error("[ADD USER ROUTE ERROR]", e.message);
        // Kirim pesan error asli agar admin tahu penyebab kegagalan (misal: user duplikat)
        res.json({ 
            success: false, 
            message: e.message 
        });
    }
});

// ==========================================
// 6. API EDIT FULL MEMBER (SULTAN VERSION)
// ==========================================
router.post('/api/update-member-full', adminAuth, async (req, res) => {
    try {
        // Serahkan seluruh payload data ke Si Otak (RadiusManager)
        const result = await RadiusManager.updateMemberFull(req.body);
        
        // Berikan respon sukses ke Dashboard
        res.json(result);

    } catch (e) {
        console.error("[ROUTE UPDATE MEMBER ERROR]", e.message);
        res.json({ 
            success: false, 
            message: "Gagal Update Member: " + e.message 
        });
    }
});

// =============================================================
// 7. HAPUS VOUCHER & MEMBER (INTEGRATED)
// =============================================================

// Hapus Single Voucher (Redirect Mode)
router.post('/delete-voucher', adminAuth, async (req, res) => {
    const { username } = req.body;
    try {
        // Serahkan eksekusi ke Si Otak
        await RadiusManager.deleteSingleVoucher(username);
        
        // Sesuai alur asli Bos: Redirect kembali ke daftar voucher
        res.redirect('/admin/hotspot/voucher'); 
    } catch (e) { 
        console.error("[ROUTE DELETE VOUCHER ERROR]", e.message);
        res.status(500).send("Gagal hapus: " + e.message); 
    }
});

// Hapus Voucher Batch (JSON Mode)
router.post('/delete-voucher-batch', adminAuth, async (req, res) => {
    try {
        const { usernames } = req.body;
        
        // Serahkan eksekusi massal ke Si Otak
        const result = await RadiusManager.deleteVouchersBatch(usernames);
        
        res.json(result);
    } catch (e) {
        console.error("[ROUTE BATCH DELETE ERROR]", e.message);
        res.json({ 
            success: false, 
            message: "Gagal hapus batch: " + e.message 
        });
    }
});

// =============================================================
// 8. API HOTSPOT MEMBER (INTEGRASI RADIUS + BILLING)
// =============================================================
router.post('/add-member', adminAuth, async (req, res) => {
    try {
        // Serahkan instruksi registrasi ke Si Otak (RadiusManager)
        const result = await RadiusManager.addHotspotMember(req.body);
        
        // Berikan respon hasil akhir ke Frontend
        res.json(result);

    } catch (e) {
        console.error("[ROUTE ADD MEMBER ERROR]", e.message);
        res.json({ 
            success: false, 
            message: e.message 
        });
    }
});

module.exports = router;