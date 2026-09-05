const express = require('express');
const router = express.Router();
const { adminAuth } = require('./adminAuth');
const { radiusServer } = require('../config/radius');
const { getSettingsWithCache } = require('../config/settingsManager');
const logger = require('../config/logger');
// ==========================================
// 1. DASHBOARD RADIUS (SOLDERED: FIXED AWAIT)
// ==========================================
router.get('/radius', adminAuth, async (req, res) => {
  try {
    const settings = getSettingsWithCache();
    
    const radiusStatus = await radiusServer.getStatus();
    const nasClients = await radiusServer.getNASClients();
    const activeSessions = await radiusServer.getActiveSessions();
   
    res.render('adminRadius', {
      settings,
      radiusStatus,
      nasClients,
      activeSessions,
      title: 'RADIUS Server Management'
    });
  } catch (error) {
    logger.error(`Error loading RADIUS dashboard: ${error.message}`);
    const settings = getSettingsWithCache();
    res.render('adminRadius', {
      settings,
      radiusStatus: { running: false, port: '1812', acctPort: '1813' },
      nasClients: [],
      activeSessions: [],
      error: 'Gagal memuat data RADIUS server.',
      title: 'RADIUS Server Management'
    });
  }
});
// ==========================================
// 2. KONTROL SERVER (START/STOP)
// ==========================================
router.post('/radius/start', adminAuth, async (req, res) => {
  try {
    await radiusServer.initialize();
    const started = await radiusServer.startAuthServer();
   
    if (started) {
      logger.info('RADIUS server started by admin');
      res.json({ success: true, message: 'RADIUS server berhasil dijalankan.' });
    } else {
      res.json({ success: false, message: 'Gagal menjalankan RADIUS server.' });
    }
  } catch (error) {
    logger.error(`Error starting RADIUS server: ${error.message}`);
    res.json({ success: false, message: `Error: ${error.message}` });
  }
});
router.post('/radius/stop', adminAuth, async (req, res) => {
  try {
    const stopped = await radiusServer.stop();
    if (stopped) {
      logger.info('RADIUS server stopped by admin');
      res.json({ success: true, message: 'RADIUS server berhasil dihentikan.' });
    } else {
      res.json({ success: false, message: 'RADIUS server tidak sedang berjalan.' });
    }
  } catch (error) {
    logger.error(`Error stopping RADIUS server: ${error.message}`);
    res.json({ success: false, message: `Error: ${error.message}` });
  }
});
// ==========================================
// 3. MANAJEMEN NAS (MIKROTIK CLIENT)
// ==========================================
router.post('/radius/nas/add', adminAuth, async (req, res) => {
  try {
    const { ip, secret, name } = req.body;
   
    if (!ip || !secret) {
      return res.json({ success: false, message: 'IP address dan secret wajib diisi.' });
    }
    const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    if (!ipRegex.test(ip)) {
      return res.json({ success: false, message: 'Format IP address tidak valid.' });
    }
    // Pakai AWAIT karena menulis ke database
    await radiusServer.addNASClient(ip, secret, name || '');
    logger.info(`NAS client added: ${ip} by admin`);
    res.json({ success: true, message: 'NAS client berhasil ditambahkan.' });
  } catch (error) {
    logger.error(`Error adding NAS client: ${error.message}`);
    res.json({ success: false, message: `Error: ${error.message}` });
  }
});
router.post('/radius/nas/update', adminAuth, async (req, res) => {
    try {
        const { oldIp, ip, secret, name } = req.body;
        
        // 1. Validasi Input Dasar
        if (!ip || !secret) return res.json({ success: false, message: 'IP dan Secret tidak boleh kosong.' });
        // 2. Tambahkan Validasi Format IP (Biar Aman)
        const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
        if (!ipRegex.test(ip)) {
            return res.json({ success: false, message: 'Format IP baru tidak valid.' });
        }
        // 3. Eksekusi Update
        const updated = await radiusServer.updateNASClient(oldIp, ip, secret, name);
        
        if (updated) {
            logger.info(`NAS client updated: ${oldIp} -> ${ip} by admin`); // Tambahkan log sukses
            res.json({ success: true, message: 'NAS Client berhasil diupdate.' });
        } else {
            res.json({ success: false, message: 'Gagal mengupdate database.' });
        }
    } catch (error) {
        logger.error(`Error updating NAS client: ${error.message}`);
        res.json({ success: false, message: error.message });
    }
});
router.post('/radius/nas/remove', adminAuth, async (req, res) => {
  try {
    const { ip } = req.body;
    if (!ip) return res.json({ success: false, message: 'IP address wajib diisi.' });
    // Pakai AWAIT karena menghapus di database
    const removed = await radiusServer.removeNASClient(ip);
   
    if (removed) {
      logger.info(`NAS client removed: ${ip} by admin`);
      res.json({ success: true, message: 'NAS client berhasil dihapus.' });
    } else {
      res.json({ success: false, message: 'NAS client tidak ditemukan.' });
    }
  } catch (error) {
    logger.error(`Error removing NAS client: ${error.message}`);
    res.json({ success: false, message: `Error: ${error.message}` });
  }
});
// ==========================================
// 4. API STATUS & SESSIONS (UNTUK AJAX)
// ==========================================
router.get('/radius/status', adminAuth, async (req, res) => {
  try {
    const status = await radiusServer.getStatus();
    const activeSessions = await radiusServer.getActiveSessions();
    res.json({
      success: true,
      status: status,
      activeSessions: activeSessions.length,
      sessions: activeSessions
    });
  } catch (error) {
    res.json({ success: false, message: `Error: ${error.message}` });
  }
});
router.get('/radius/sessions', adminAuth, async (req, res) => {
  try {
    const sessions = await radiusServer.getActiveSessions();
    res.json({ success: true, sessions: sessions });
  } catch (error) {
    res.json({ success: false, message: `Error: ${error.message}` });
  }
});
router.get('/radius/nas', adminAuth, async (req, res) => {
  try {
    const clients = await radiusServer.getNASClients();
    res.json({ success: true, clients: clients });
  } catch (error) {
    logger.error(`Error API NAS: ${error.message}`);
    res.json({ success: false, message: `Error: ${error.message}` });
  }
});
// ==========================================
// 5. SCRIPT GENERATOR (MIKROTIK CONFIG)
// ==========================================
router.get('/radius/mikrotik-script/:type', adminAuth, async (req, res) => {
  try {
    const { type } = req.params;
    const { serverIP, mikrotikIP, secret } = req.query;
   
    // Fallback nilai default jika admin lupa isi di form
    const sIP = serverIP || '192.168.1.100';
    const mIP = mikrotikIP || '192.168.1.1';
    const sec = secret || '123456';
   
    let script = '';
   
    // Logika pemilihan jenis script
    switch (type) {
      case 'basic':
        script = generatePPPoEScript(sIP, mIP, sec);
        break;
      case 'hotspot':
        script = generateHotspotScript(sIP, mIP, sec);
        break;
      case 'complete':
        script = generateCompleteScript(sIP, mIP, sec);
        break;
      default:
        script = generatePPPoEScript(sIP, mIP, sec);
    }
   
    res.json({ success: true, script: script });
  } catch (error) {
    logger.error(`Error generating script: ${error.message}`);
    res.json({ success: false, message: `Error: ${error.message}` });
  }
});
// --- FUNGSI GENERATOR SCRIPT (STANDALONE) ---
function generatePPPoEScript(serverIP, mikrotikIP, secret) {
  return `# --- GEMBOK RADIUS: PPPoE CONFIG ---
# Generated: ${new Date().toLocaleString('id-ID')}
/radius remove [find comment="GEMBOK-PPPoE"]
/radius add address=${serverIP} secret="${secret}" service=ppp src-address=${mikrotikIP} timeout=3000ms comment="GEMBOK-PPPoE"
/radius incoming set accept=yes port=3799
/interface pppoe-server server set [find] use-radius=yes default-profile=default
/ppp aaa set use-radius=yes accounting=yes interim-update=10m
/ip firewall filter add chain=input protocol=udp dst-port=1812,1813,3799 action=accept comment="Allow-GEMBOK-Radius" place-before=0
# Selesai! Tempel di Terminal Mikrotik.`;
}
function generateHotspotScript(serverIP, mikrotikIP, secret) {
  return `# --- GEMBOK RADIUS: HOTSPOT CONFIG ---
# Generated: ${new Date().toLocaleString('id-ID')}
/radius remove [find comment="GEMBOK-Hotspot"]
/radius add address=${serverIP} secret="${secret}" service=hotspot src-address=${mikrotikIP} timeout=3000ms comment="GEMBOK-Hotspot"
/radius incoming set accept=yes port=3799
/ip hotspot profile add name="profile-radius" use-radius=yes login-by=http-chap,http-pap,mac-cookie
/ip hotspot set [find] profile=profile-radius
/ip hotspot aaa set use-radius=yes accounting=yes interim-update=10m
/ip firewall filter add chain=input protocol=udp dst-port=1812,1813,3799 action=accept comment="Allow-GEMBOK-Radius" place-before=0
# Selesai!`;
}
function generateCompleteScript(serverIP, mikrotikIP, secret) {
  return `# --- GEMBOK RADIUS: COMPLETE (PPPoE + Hotspot) ---
/radius remove [find comment="GEMBOK-All"]
/radius add address=${serverIP} secret="${secret}" service=ppp,hotspot src-address=${mikrotikIP} timeout=3000ms comment="GEMBOK-All"
/radius incoming set accept=yes port=3799
/interface pppoe-server server set [find] use-radius=yes
/ppp aaa set use-radius=yes accounting=yes interim-update=10m
/ip hotspot profile add name="radius-profile" use-radius=yes login-by=http-chap,http-pap,mac-cookie
/ip hotspot set [find] profile=radius-profile
/ip hotspot aaa set use-radius=yes accounting=yes interim-update=10m
/ip firewall filter add chain=input protocol=udp dst-port=1812,1813,3799 action=accept comment="Allow-GEMBOK-Radius" place-before=0
# Selesai!`;
}
module.exports = router;
