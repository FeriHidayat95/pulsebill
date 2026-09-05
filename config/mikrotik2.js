// Modul untuk koneksi dan operasi Mikrotik
const { RouterOSAPI } = require('node-routeros');
const logger = require('./logger');
const { getSetting } = require('./settingsManager');

let sock = null;
let mikrotikConnection = null;
let monitorInterval = null;

// Fungsi untuk set instance sock
function setSock(sockInstance) {
    sock = sockInstance;
}

// Fungsi untuk koneksi ke Mikrotik
async function connectToMikrotik() {
    try {
        // Dapatkan konfigurasi Mikrotik
        const host = getSetting('mikrotik_host', '192.168.8.1');
        const port = parseInt(getSetting('mikrotik_port', '8728'));
        const user = getSetting('mikrotik_user', 'admin');
        const password = getSetting('mikrotik_password', 'admin');
        
        if (!host || !user || !password) {
            logger.error('Mikrotik configuration is incomplete');
            return null;
        }
        
        // Buat koneksi ke Mikrotik
        const conn = new RouterOSAPI({
            host,
            port,
            user,
            password,
            keepalive: true,
            timeout: 10 // Tambahkan timeout agar tidak nunggu selamanya
        });

        // --- TAMBAHKAN INI (TAMENG V7) ---
        // Menangkap error sebelum meledak ke sistem utama (app.js)
        conn.on('error', (err) => {
            if (err.message.includes('!empty') || err.errno === 'UNKNOWNREPLY') {
                logger.warn(`??? [SOCKET-SAFE] Menangkap respon v7 dari ${host}: ${err.message}`);
            } else {
                logger.error(`? [SOCKET-ERROR] pada ${host}: ${err.message}`);
                mikrotikConnection = null; // Reset koneksi jika error fatal (kabel putus, dll)
            }
        });
        // ---------------------------------
        
        // Connect ke Mikrotik
        await conn.connect();
        logger.info(`? Connected to Mikrotik at ${host}:${port}`);
        
        // Set global connection
        mikrotikConnection = conn;
        
        return conn;
    } catch (error) {
        logger.error(`? Error connecting to Mikrotik: ${error.message}`);
        mikrotikConnection = null;
        return null;
    }
}

// Fungsi untuk mendapatkan koneksi Mikrotik
async function getMikrotikConnection() {
    if (!mikrotikConnection) {
        return await connectToMikrotik();
    }
    return mikrotikConnection;
}

// Fungsi untuk mendapatkan daftar koneksi PPPoE aktif
async function getActivePPPoEConnections() {
    try {
        const conn = await getMikrotikConnection();
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal', data: [] };
        }
        // Dapatkan daftar koneksi PPPoE aktif
        const pppConnections = await conn.write('/ppp/active/print');
        return {
            success: true,
            message: `Ditemukan ${pppConnections.length} koneksi PPPoE aktif`,
            data: pppConnections
        };
    } catch (error) {
        logger.error(`Error getting active PPPoE connections: ${error.message}`);
        return { success: false, message: `Gagal ambil data PPPoE: ${error.message}`, data: [] };
    }
}


function safeNumber(val) {
    if (val === undefined || val === null) return 0;
    const n = Number(val);
    return isNaN(n) ? 0 : n;
}

// Fungsi untuk mendapatkan daftar user hotspot aktif
async function getActiveHotspotUsers() {
    try {
        const conn = await getMikrotikConnection();
        if (!conn) {
            logger.error('No Mikrotik connection available');
            return { success: false, message: 'Koneksi ke Mikrotik gagal', data: [] };
        }
        // Dapatkan daftar user hotspot aktif
        const hotspotUsers = await conn.write('/ip/hotspot/active/print');
        return {
            success: true,
            message: `Ditemukan ${hotspotUsers.length} user hotspot aktif`,
            data: hotspotUsers
        };
    } catch (error) {
        logger.error(`Error getting active hotspot users: ${error.message}`);
        return { success: false, message: `Gagal ambil data hotspot: ${error.message}`, data: [] };
    }
}

// Fungsi untuk mendapatkan traffic interface
async function getInterfaceTraffic(interfaceName = 'ether1') {
    try {
        const conn = await getMikrotikConnection();
        if (!conn) return { rx: 0, tx: 0 };
        const res = await conn.write('/interface/monitor-traffic', [
            `=interface=${interfaceName}`,
            '=once='
        ]);
        if (!res || !res[0]) return { rx: 0, tx: 0 };
        // RX/TX dalam bps
        return {
            rx: res[0]['rx-bits-per-second'] || 0,
            tx: res[0]['tx-bits-per-second'] || 0
        };
    } catch (error) {
        logger.error('Error getting interface traffic:', error.message, error);
        return { rx: 0, tx: 0 };
    }
}

// Fungsi untuk kick user PPPoE
async function kickPPPoEUser(username) {
    try {
        const conn = await getMikrotikConnection();
        if (!conn) return { success: false, message: 'Koneksi ke Mikrotik gagal' };
        // Cari sesi aktif user
        const activeSessions = await conn.write('/ppp/active/print', [
            '?name=' + username
        ]);
        if (activeSessions.length === 0) {
            return { success: false, message: 'User tidak sedang online' };
        }
        // Hapus semua sesi aktif user ini
        for (const session of activeSessions) {
            await conn.write('/ppp/active/remove', [
                '=.id=' + session['.id']
            ]);
        }
        return { success: true, message: `User ${username} berhasil di-kick dari PPPoE` };
    } catch (error) {
        return { success: false, message: `Gagal kick user: ${error.message}` };
    }
}

// ...
module.exports = {
    setSock,
    connectToMikrotik,
    getMikrotikConnection,
    getActivePPPoEConnections,
    getActiveHotspotUsers,
    kickPPPoEUser
};
