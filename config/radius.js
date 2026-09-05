const dgram = require('dgram');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
 
const dbPool = require('./database'); 
const logger = require('./logger');

class RadiusServer {
    constructor() {
        this.isRunning = false;
        this.startTime = new Date();
        // Socket dummy agar module lain tidak error
        this.authSocket = dgram.createSocket('udp4');
        this.acctSocket = dgram.createSocket('udp4');
    }

    // 1. CEK STATUS (Biar Lampu Merah jadi HIJAU & Port Terisi)
    async getStatus() {
        try {
            // Tanya Linux: "FreeRADIUS bangun gak?"
            const { stdout } = await execAsync('sudo systemctl is-active freeradius');
            const isActive = stdout.trim() === 'active';
            
            // Hitung sesi aktif dari database
            const [rows] = await dbPool.execute("SELECT COUNT(*) as total FROM radacct WHERE acctstoptime IS NULL");
            
            return {
                running: isActive, 
                uptime: isActive ? 'Systemd Active' : 'Offline',
                port: '1812',      // Dipakai di Kotak Oranye
                acctPort: '1813',  // Dipakai di Kotak Oranye
                type: 'FreeRADIUS External',
                activeSessions: rows[0].total
            };
        } catch (e) {
            return { running: false, port: '1812', acctPort: '1813', activeSessions: 0, type: 'Error' };
        }
    }

    // 2. DAFTAR NAS (Biar Angka 0 jadi isi & Tanggal Muncul)
    async getNASClients() {
        try {
            // Kita ambil data NAS dan gunakan 'nasname' sebagai IP
            const [rows] = await dbPool.execute("SELECT id, nasname as ip, secret, shortname as name FROM nas");
            return rows.map(r => ({
                ...r,
                createdAt: new Date() // Fallback agar kolom tanggal di web tidak kosong
            }));
        } catch (e) {
            return [];
        }
    }

    // 3. SESI AKTIF (Realtime Traffic & Duration)
    async getActiveSessions() { 
        try {
            const sql = `
                SELECT 
                    username, 
                    framedipaddress AS ip_address, 
                    nasipaddress AS router, 
                    acctstarttime AS login_time,
                    acctinputoctets,
                    acctoutputoctets
                FROM radacct 
                WHERE acctstoptime IS NULL 
                ORDER BY acctstarttime DESC
            `;
            const [rows] = await dbPool.execute(sql);
            return rows.map(s => {
                const startTime = new Date(s.login_time);
                const diffSec = Math.floor((new Date() - startTime) / 1000);
                
                // Format Durasi: Jam, Menit, Detik
                const h = Math.floor(diffSec / 3600);
                const m = Math.floor((diffSec % 3600) / 60);
                const sec = diffSec % 60;

                // Format Traffic: Penjumlahan Input + Output (MB)
                const totalTraffic = ((parseInt(s.acctinputoctets || 0) + parseInt(s.acctoutputoctets || 0)) / (1024 * 1024)).toFixed(2);

                return {
                    username: s.username,
                    ip_address: s.ip_address || '-',
                    router: s.router || '-',
                    login_time: startTime.toLocaleTimeString('id-ID'),
                    duration: `${h}j ${m}m ${sec}d`,
                    traffic: totalTraffic + ' MB'
                };
            });
        } catch (e) {
            return [];
        }
    }
    // 4. KONTROL TOMBOL (Biar Klik Start/Stop di Web Beneran Kerja)
    async startAuthServer() {
        try {
            await execAsync('sudo systemctl start freeradius');
            return true;
        } catch (e) { return false; }
    }

    async stop() {
        try {
            await execAsync('sudo systemctl stop freeradius');
            return true;
        } catch (e) { return false; }
    }

    // Fungsi tambahan agar sistem tidak error
    async initialize() { return true; }
    async addNASClient(ip, secret, name) {
        await dbPool.execute("INSERT INTO nas (nasname, shortname, secret, type) VALUES (?, ?, ?, 'other')", [ip, name, secret]);
    }
    
    async updateNASClient(oldIp, newIp, secret, name) {
        try {
            // Kita gunakan oldIp sebagai kunci (WHERE) agar IP baru bisa disimpan
            await dbPool.execute(
                "UPDATE nas SET nasname = ?, secret = ?, shortname = ? WHERE nasname = ?", 
                [newIp, secret, name, oldIp]
            );
            return true;
        } catch (e) {
            console.error('Gagal update NAS:', e.message);
            return false;
        }
    }
    
    async removeNASClient(ip) {
        await dbPool.execute("DELETE FROM nas WHERE nasname = ?", [ip]);
        return true;
    }
}

const radiusServer = new RadiusServer();
module.exports = { radiusServer };