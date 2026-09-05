const express = require('express');
const router = express.Router();
const { adminAuth } = require('./adminAuth');
const nasManager = require('../config/nasManager');
const { getSettingsWithCache, saveSettings } = require('../config/settingsManager');
const net = require('net');

/**
 * FUNGSI HELPER: Sinkronisasi data NAS ke Settings JSON
 * Menjadikan database NAS sebagai sumber data untuk API MikroTik
 */
 
async function syncNasToSettings() {
    // Kita matikan total fungsinya agar tidak mengisi settings.json dengan IP MikroTik
    console.log("[INFO] Sync NAS ke Settings dinonaktifkan (Mode Full RADIUS).");
    return; 
}

// ROUTE UTAMA
router.get('/nas', adminAuth, async (req, res) => {
    try {
        const nasList = await nasManager.getAllNAS();
        res.render('nas', {
            nasList,
            settings: getSettingsWithCache(),
            page: 'nas',
            title: 'Manajemen NAS Radius'
        });
    } catch (err) {
        res.status(500).send("Error: " + err.message);
    }
});

// CEK STATUS PORT DINAMIS
router.get('/nas/check-status/:id', adminAuth, async (req, res) => {
    try {
        const nas = await nasManager.getNASById(req.params.id);
        if (!nas) return res.json({ online: false });

        const client = new net.Socket();
        client.setTimeout(2500);
        
        // Menggunakan port dinamis dari database (api_port)
        const targetPort = parseInt(nas.api_port) || 8728;
        
        client.connect(targetPort, nas.nasname, () => {
            client.end();
            res.json({ online: true });
        });

        client.on('error', () => { client.destroy(); res.json({ online: false }); });
        client.on('timeout', () => { client.destroy(); res.json({ online: false }); });
    } catch (err) { res.json({ online: false }); }
});

// TAMBAH NAS + SYNC
router.post('/nas/add', adminAuth, async (req, res) => {
    try {
        await nasManager.addNAS(req.body);
        await syncNasToSettings(); // <--- Update settings.json otomatis
        res.redirect('/admin/nas');
    } catch (err) { res.status(500).send("Gagal: " + err.message); }
});

// EDIT NAS + SYNC
router.post('/nas/edit', adminAuth, async (req, res) => {
    try {
        await nasManager.updateNAS(req.body.id, req.body);
        await syncNasToSettings(); // <--- Update settings.json otomatis
        res.redirect('/admin/nas');
    } catch (err) { res.status(500).send("Gagal: " + err.message); }
});

// DELETE NAS + SYNC
router.post('/nas/delete', adminAuth, async (req, res) => {
    try {
        await nasManager.deleteNAS(req.body.id);
        await syncNasToSettings(); // <--- Update settings.json otomatis
        res.redirect('/admin/nas');
    } catch (err) { res.status(500).send("Gagal: " + err.message); }
});

module.exports = router;