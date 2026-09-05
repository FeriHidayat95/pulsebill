const express = require('express');
const router = express.Router();
const { exec } = require('child_process');
const { adminAuth } = require('./adminAuth');
const nasManager = require('../config/nasManager');
const { logActivity } = require('../utils/logger');
const { getSettingsWithCache, getSetting } = require('../config/settingsManager');

// IMPORT KONEKSI DARI SI OTAK (RadiusManager)
const { dbPool, RadiusManager } = require('../config/RadiusManager');

// Middleware untuk Sidebar & Logo (Agar Lonceng & Menu Muncul)
const getAppSettings = (req, res, next) => {
    res.locals.settings = {
        logo_filename: getSetting('logo_filename', 'logo.png'),
        company_name: getSetting('company_name', 'INETKU NETWORK'),
        enable_billing: true, enable_radius: true, enable_hotspot: true,
        enable_voucher: true, enable_ppp: true, enable_olt: true,
        enable_map: true, enable_wa: true, enable_finance: true,
        enable_log: true, enable_mitra: true
    };
    next();
};

// =============================================================
// HALAMAN LIST USER (FULL RADIUS - MONITORING PRO)
// =============================================================
router.get('/mikrotik', adminAuth, getAppSettings, async (req, res) => {
    let nasList = [];
    try {
        nasList = await nasManager.getAllNAS() || [];
        const selectedNasId = req.query.nasId || (nasList.length > 0 ? nasList[0].id : null);

        // QUERY SAKTI BOS: Monitoring Murni dari Database Radius
        const sql = `
            SELECT 
                c.id, c.name as display_name, c.pppoe_username as username,
                c.pppoe_password as password, c.pppoe_profile as profile,
                (SELECT COUNT(*) FROM radacct r WHERE r.username = c.pppoe_username AND r.acctstoptime IS NULL) as online_status,
                (SELECT r.nasipaddress FROM radacct r WHERE r.username = c.pppoe_username AND r.acctstoptime IS NULL LIMIT 1) as connected_nas
            FROM customers c
            WHERE c.pppoe_username IS NOT NULL AND c.pppoe_username != ''
            ORDER BY c.name ASC
        `;

        const [rows] = await dbPool.query(sql);

        const users = rows.map(u => ({
            id: u.id,
            name: u.username,
            displayName: u.display_name,
            password: u.password,
            profile: u.profile,
            active: u.online_status > 0,
            nas: u.connected_nas || '-'
        }));

        res.render('adminMikrotik', { 
            users, nasList, selectedNasId, 
            settings: res.locals.settings, 
            error: null 
        });

    } catch (err) {
        console.error("[ERROR MIKROTIK PAGE]", err.message);
        res.render('adminMikrotik', { 
            users: [], nasList: [], selectedNasId: null, 
            settings: res.locals.settings, 
            error: "Gagal memuat data RADIUS: " + err.message 
        });
    }
});

// =============================================================
// 2. HALAMAN PROFILE PPPoE (DENGAN DUAL LOCK)
// =============================================================
router.get('/mikrotik/profiles', adminAuth, async (req, res) => {
    const settings = getSettingsWithCache() || {};
    try {
        // Panggil Si Otak untuk ambil data profile yang sudah jadi
        const profiles = await RadiusManager.getPPPoEProfiles();

        const nasList = await nasManager.getAllNAS() || [];
        const selectedNasId = req.query.nasId || (nasList.length > 0 ? nasList[0].id : null);

        res.render('adminMikrotikProfiles', { 
            profiles, 
            nasList, 
            selectedNasId, 
            settings,
            company_header: settings.company_header || "pulsebill.io"
        });

    } catch (err) {
        console.error("[PPPoE PROFILE ERROR]", err.message);
        res.render('adminMikrotikProfiles', { profiles: [], settings, error: err.message });
    }
});

// ==========================================
// API SAVE PROFILE - VERSI 1 PINTU
// ==========================================
router.post('/mikrotik/save-profile', adminAuth, async (req, res) => {
    const d = req.body;
    
    if (!d.name || !d.rateLimit) {
        return res.status(400).json({ success: false, message: "Nama Paket dan Rate Limit Wajib Diisi!" });
    }

    try {
        // Panggil Si Otak untuk memproses logika "Kereta Api" dan Database
        const result = await RadiusManager.saveProfile(d);
        
        res.json({ 
            success: true, 
            message: `Profile ${d.name} Berhasil Disinkronkan ke: ${result.autoPool}` 
        });

    } catch (err) {
        console.error("DEBUG ERROR:", err);
        res.status(500).json({ success: false, message: "Gagal Simpan: " + err.message });
    }
});

// ==========================================
// 3. API HAPUS PROFILE (BERSIH TOTAL)
// ==========================================
router.post('/mikrotik/delete-profile', adminAuth, async (req, res) => {
    const profileName = req.body.id; 
    
    try {
        // Ambil username admin dari session untuk keperluan logging
        const adminUsername = req.session?.adminUsername;

        // Serahkan tugas berat ke Si Otak (RadiusManager)
        const result = await RadiusManager.deleteProfile(profileName, adminUsername, req);
        
        // Kirim hasil ke Frontend
        res.json(result);

    } catch (err) {
        console.error("[DELETE PROFILE ERROR]", err.message);
        res.json({ success: false, message: "Gagal menghapus profile: " + err.message });
    }
});

// ==========================================
// 3. HALAMAN HOTSPOT PROFILES (FULL RADIUS)
// ==========================================
router.get('/mikrotik/hotspot-profiles', adminAuth, async (req, res) => {
    const settings = getSettingsWithCache() || {}; 
    try {
        // Panggil Si Otak untuk mengambil data profile hotspot yang sudah difilter
        const profiles = await RadiusManager.getHotspotProfiles();

        const nasList = await nasManager.getAllNAS() || [];
        const selectedNasId = req.query.nasId || (nasList.length > 0 ? nasList[0].id : null);

        res.render('adminMikrotikHotspotProfiles', { 
            profiles, 
            nasList, 
            selectedNasId, 
            settings: settings,
            company_header: settings.company_header || "pulsebill.io" 
        });

    } catch (err) {
        console.error("[HOTSPOT PROFILE ERROR]", err.message);
        res.render('adminMikrotikHotspotProfiles', { 
            profiles: [], 
            nasList: [], 
            selectedNasId: null, 
            settings: settings, 
            company_header: settings.company_header || "pulsebill.io", 
            error: err.message 
        });
    }
});

// ==========================================
// 4. API HAPUS USER PPPoE (FULL RADIUS MODE)
// ==========================================
router.post('/mikrotik/delete-user', adminAuth, async (req, res) => {
    const customerId = req.body.id; 
    
    try {
        const adminUsername = req.session?.adminUsername;

        // Panggil Si Otak untuk eksekusi penghapusan total
        const result = await RadiusManager.deletePppoeUser(customerId, adminUsername, req);
        
        res.json(result);

    } catch (err) {
        console.error("[DELETE USER ERROR]", err.message);
        res.json({ success: false, message: "Gagal menghapus user: " + err.message });
    }
});

// ==========================================
// 4. API PINDAH USER KE EXPIRED (ISOLASI)
// ==========================================
router.post('/mikrotik/expire-user', adminAuth, async (req, res) => {
    const customerId = req.body.id; 
    
    try {
        const adminUsername = req.session?.adminUsername;

        // Serahkan tugas isolasi ke Si Otak (RadiusManager)
        const result = await RadiusManager.expireUser(customerId, adminUsername, req);
        
        res.json(result);

    } catch (err) {
        console.error("[EXPIRE USER ERROR]", err.message);
        res.json({ success: false, message: err.message });
    }
});

// ==========================================
// 2. DISCONNECT SESSION (KICK USER) - VIA RADIUS
// ==========================================
router.post('/mikrotik/disconnect-session', adminAuth, async (req, res) => {
    try {
        const { username } = req.body;

        // Panggil Si Otak (RadiusManager) untuk urusan radclient
        const result = await RadiusManager.disconnectSession(username);
        
        // Kirim hasil akhir ke Web
        res.json(result);

    } catch (err) {
        res.json({ success: false, message: err.message });
    }
});

// ==========================================
// API UNTUK MENGHITUNG & MENAMPILKAN PROFILE
// ==========================================
router.get('/mikrotik/profiles/api', adminAuth, async (req, res) => {
    try {
        // Panggil Si Otak (RadiusManager) untuk ambil profile yang sudah difilter
        const profiles = await RadiusManager.getUniquePppoeProfiles();

        // Kirim datanya dalam format JSON agar diterima oleh script di EJS
        res.json({ 
            success: true, 
            profiles: profiles 
        });

    } catch (err) {
        console.error("[API PROFILE ERROR]", err.message);
        res.json({ success: false, profiles: [], message: err.message });
    }
});

module.exports = router;