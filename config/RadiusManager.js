const mysql = require('mysql2/promise');
const logger = require('./logger');
const { exec } = require('child_process');
const { adminAuth } = require('../routes/adminAuth');
// 1. DATABASE POOL CONFIGURATION
const dbPool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'pulsebill_db',
    connectionLimit: 15
});
const RadiusManager = {
    /**
     * Mengambil daftar Profile PPPoE murni dari Radius (radgroupreply)
     * digabung dengan data Paket Billing
     */
    async getPPPoEProfiles() {
        const sql = `
            SELECT r.groupname, r.attribute, r.value, p.billing_type, p.active_period, p.price as pkg_price
            FROM radgroupreply r
            LEFT JOIN packages p ON r.groupname = p.name
            WHERE r.groupname IN (
                SELECT groupname FROM radgroupreply 
                WHERE attribute = 'Framed-Protocol' AND value = 'PPP'
            )
            ORDER BY r.groupname
        `;
        
        const [rows] = await dbPool.execute(sql);
        
        const profiles = {};
        rows.forEach(row => {
            const gName = row.groupname;
            if (!profiles[gName]) {
                profiles[gName] = { 
                    name: gName, 
                    rateLimit: '-', 
                    localAddress: '-', 
                    remoteAddress: '-', 
                    price: row.pkg_price || '0', 
                    billing_type: row.billing_type || 'unlinked', 
                    active_period: row.active_period || '-',
                    '.id': gName 
                };
            }
            if (row.attribute === 'Mikrotik-Rate-Limit') profiles[gName].rateLimit = row.value;
            if (row.attribute === 'Framed-IP-Address') profiles[gName].localAddress = row.value;
            if (row.attribute === 'Framed-Pool') profiles[gName].remoteAddress = row.value;
        });
        return Object.values(profiles);
    },
    /**
     * Synchronize RADIUS profile attributes
     * Radius hanya mengirimkan "LABEL" (Mikrotik-Group).
     * MikroTik akan menentukan Pool & Jalur secara lokal berdasarkan PPPoE Server/VLAN.
     */
     async saveProfile(d) {
        let conn;
        try {
            conn = await dbPool.getConnection();
            await conn.beginTransaction();
            // Bersihkan data lama
            await conn.execute("DELETE FROM radgroupreply WHERE groupname = ?", [d.oldName || d.name]);
            
            const radQueries = [
                [d.name, 'Framed-Protocol', ':=', 'PPP'],
                [d.name, 'Service-Type', ':=', 'Framed-User'],
                // Radius menyuruh Mikrotik pakai PPP Profile lokal yang namanya SAMA
                // [d.name, 'Mikrotik-Group', ':=', d.name] 
            ];
            // Kirim limitasi kecepatan jika ada
            if (d.rateLimit && d.rateLimit !== '-') {
                radQueries.push([d.name, 'Mikrotik-Rate-Limit', ':=', d.rateLimit]);
            }
            for (const q of radQueries) { 
                await conn.execute("INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES (?, ?, ?, ?)", q); 
            }
            await conn.commit();
            return { success: true };
        } catch (error) {
            if (conn) await conn.rollback();
            throw error;
        } finally {
            if (conn) conn.release();
        }
    },
    
    /**
     * ADD PPPOE USER (Smart & Flexible Mode)
     * Radius hanya mengelola Identitas (User/Pass) & Label Group.
     */
    async addPppoeUser(d) {
        const { username, password, profile, name, phone, address, expired_date, billing_day, installation_date } = d;
        const conn = await dbPool.getConnection();
        try {
            await conn.beginTransaction();
            // 1. Radius Auth: Hanya masukkan Password (Tanpa Expiration)
            await conn.execute("INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Cleartext-Password', ':=', ?)", [username, password]);
            
            // 2. Radius Group: Masukkan Label Profil (agar Mikrotik tahu ini grup apa)
            await conn.execute("INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, '1')", [username, profile]);
            // 3. Simpan ke Billing Web
            const sqlBilling = `
                INSERT INTO customers 
                (name, username, password, pppoe_username, pppoe_password, pppoe_profile, phone, address, 
                join_date, installation_date, created_at, expired_date, billing_day, status) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, NOW(), ?, ?, 'active')
            `;
            await conn.execute(sqlBilling, [name, username, password, username, password, profile, phone, address, installation_date || null, expired_date, billing_day]);
            await conn.commit();
            return { success: true, message: "Pelanggan PPPoE berhasil didaftarkan ke jalur Fleksibel!" };
        } catch (e) {
            if (conn) await conn.rollback();
            throw e;
        } finally {
            if (conn) conn.release();
        }
    },
    
    async deleteProfile(profileName, adminUsername, req) {
        let conn;
        try {
            conn = await dbPool.getConnection();
            // --- 1. CEK APAKAH PROFILE SEDANG DIPAKAI (Pagar Keamanan) ---
            const [cekUser] = await conn.execute(
                "SELECT COUNT(*) as total FROM radusergroup WHERE groupname = ?", 
                [profileName]
            );
            if (cekUser[0].total > 0) {
                return { 
                    success: false, 
                    message: `Gagal! Profile '${profileName}' masih dipakai oleh ${cekUser[0].total} pelanggan. Pindahkan dulu pelanggannya!` 
                };
            }
            // --- 2. JALANKAN PROSES HAPUS (SINKRON SEMUA TABEL) ---
            await conn.beginTransaction();
            // A. Hapus dari Tabel "KTP" PPPoE (Packages)
            await conn.execute("DELETE FROM packages WHERE name = ?", [profileName]);
            // B. Hapus Atribut Mikrotik (Reply)
            await conn.execute("DELETE FROM radgroupreply WHERE groupname = ?", [profileName]);
            
            // C. Hapus PulseBill Telecom (Check)
            await conn.execute("DELETE FROM radgroupcheck WHERE groupname = ?", [profileName]);
            await conn.commit();
            
            // --- 3. CATAT DI LOG ---
            const { logActivity } = require('../utils/logger');
            await logActivity(
                adminUsername, 
                'DELETE_PROFILE', 
                `Menghapus Profile PPPoE: ${profileName} (Status: Bersih Total)`, 
                req
            );
            return { success: true, message: `Profile '${profileName}' berhasil dihapus dari sistem.` };
        } catch (err) {
            if (conn) await conn.rollback();
            throw err;
        } finally {
            if (conn) conn.release();
        }
    },
    async getHotspotProfiles() {
        const [rows] = await dbPool.execute(`
            SELECT * FROM radgroupreply 
            WHERE 
                (
                    -- Syarat 1: TIDAK PUNYA atribut Framed-Protocol = PPP
                    groupname NOT IN (
                        SELECT groupname FROM radgroupreply WHERE attribute = 'Framed-Protocol' AND value = 'PPP'
                    )
                    -- Syarat 2: ATAU namanya MURNI ANGKA (Kasus voucher 2000, 5000, dll)
                    OR groupname REGEXP '^[0-9 ]+$'
                )
                -- ??? TEMBOK PENAHAN BARU: Wajib tendang profil sistem ini dari UI Web!
                AND groupname NOT IN ('EXPIRED', 'isolir', 'default')
            ORDER BY groupname
        `);
        const profiles = {};
        rows.forEach(row => {
            const gName = row.groupname;
            if (!profiles[gName]) {
                profiles[gName] = { 
                    name: gName, rateLimit: '-', sharedUsers: '1', validity: '-', price: '0', '.id': gName 
                };
            }
            if (row.attribute === 'Mikrotik-Rate-Limit') profiles[gName].rateLimit = row.value;
            if (row.attribute === 'Port-Limit') profiles[gName].sharedUsers = row.value;
            if (row.attribute === 'Max-All-Session') {
                let val = row.value;
                const mapping = {'3600': '1h', '7200':'2h', '86400':'1d', '2592000': '30d'};
                profiles[gName].validity = mapping[val] || val;
            }
            if (row.attribute === 'Mikrotik-Group') profiles[gName].price = row.value;
        });
        return Object.values(profiles);
    },
    
    async deletePppoeUser(customerId, adminUsername, req) {
        let conn;
        try {
            conn = await dbPool.getConnection();
            await conn.beginTransaction();
            // --- 1. AMBIL INFO USERNAME DULU ---
            const [rows] = await conn.query(
                "SELECT pppoe_username FROM customers WHERE id = ?", 
                [customerId]
            );
            if (rows.length === 0) {
                return { success: false, message: "Data pelanggan tidak ditemukan!" };
            }
            const username = rows[0].pppoe_username;
            // --- 2. BERSIHKAN DARI TABEL RADIUS (AUTH & GROUP) ---
            if (username) {
                await conn.execute("DELETE FROM radcheck WHERE username = ?", [username]);
                await conn.execute("DELETE FROM radusergroup WHERE username = ?", [username]);
                await conn.execute("DELETE FROM radreply WHERE username = ?", [username]);
            }
            // --- 3. UPDATE TABEL CUSTOMERS (Kosongkan Info PPPoE) ---
            await conn.execute(`
                UPDATE customers SET 
                    pppoe_username = NULL, 
                    pppoe_password = NULL, 
                    pppoe_profile = NULL 
                WHERE id = ?
            `, [customerId]);
            await conn.commit();
            // =========================================================
            // =========================================================
            if (username) {
                // ?? Tarik data IP NAS, Secret, IP User, dan MAC User sekaligus
                const [nasInfo] = await conn.query(`
                    SELECT r.nasipaddress, n.secret, r.framedipaddress, r.callingstationid 
                    FROM radacct r
                    JOIN nas n ON r.nasipaddress = n.nasname
                    WHERE r.username = ? AND r.acctstoptime IS NULL LIMIT 1
                `, [username]);
                if (nasInfo.length > 0) {
                    const { nasipaddress, secret, framedipaddress, callingstationid } = nasInfo[0];
                    
                    // ?? Rakit Peluru Lengkap (Anti-NAK)
                    let attr = `User-Name=${username}`;
                    if (framedipaddress && callingstationid) {
                        attr += `,Framed-IP-Address=${framedipaddress},Calling-Station-Id=${callingstationid}`;
                    }
                    const command = `echo "${attr}" | radclient -x ${nasipaddress}:3799 disconnect ${secret}`;
                    
                    // Eksekusi background dengan log hasil
                    const { exec } = require('child_process');
                    exec(command, (err) => {
                        if (err) {
                            console.error(`? [DELETE-PPPOE-FAIL] Gagal tendang ${username}: ${err.message}`);
                        } else {
                            console.log(`?? [DELETE-PPPOE-SUCCESS] ${username} sukses ditendang dari router v7!`);
                        }
                    });
                }
            }
            // --- 5. CATAT LOG ---
            const { logActivity } = require('../utils/logger');
            await logActivity(adminUsername, 'DELETE_PPPOE_USER', `Menghapus akun PPPoE user: ${username}`, req);
            return { success: true, message: "Akun PPPoE berhasil dihapus total dan koneksi diputus!" };
        } catch (err) {
            if (conn) await conn.rollback();
            throw err;
        } finally {
            if (conn) conn.release();
        }
    },
    async expireUser(customerId, adminUsername, req) {
        const expiredProfile = "EXPIRED";
        let conn;
        try {
            conn = await dbPool.getConnection();
            await conn.beginTransaction();
            // 1. Ambil Username (LOGIKA ASLI TETAP)
            const [rows] = await conn.query("SELECT pppoe_username FROM customers WHERE id = ?", [customerId]);
            if (rows.length === 0 || !rows[0].pppoe_username) {
                return { success: false, message: "Username PPPoE tidak ditemukan!" };
            }
            const username = rows[0].pppoe_username;
            // 2. Update Kelompok Paket di Radius (LOGIKA ASLI TETAP)
            await conn.execute("UPDATE radusergroup SET groupname = ? WHERE username = ?", [expiredProfile, username]);
            // 3. Update Status di Tabel Customers (LOGIKA ASLI TETAP)
            await conn.execute("UPDATE customers SET pppoe_profile = ? WHERE id = ?", [expiredProfile, customerId]);
            await conn.commit();
            // =========================================================
            // =========================================================
            // SOLDERAN: Kita tarik juga framedipaddress dan callingstationid dari radacct
            const [nasInfo] = await conn.query(`
                SELECT r.nasipaddress, n.secret, n.mikrotik_version, n.shortname, 
                       r.framedipaddress, r.callingstationid 
                FROM radacct r
                JOIN nas n ON r.nasipaddress = n.nasname
                WHERE r.username = ? AND r.acctstoptime IS NULL LIMIT 1
            `, [username]);
            if (nasInfo.length > 0) {
                const { nasipaddress, secret, mikrotik_version, shortname, framedipaddress, callingstationid } = nasInfo[0];
                
                // RAKIT PELURU LENGKAP: Agar v7 tidak balas NAK
                let attr = `User-Name=${username}`;
                if (framedipaddress && callingstationid) {
                    attr += `,Framed-IP-Address=${framedipaddress},Calling-Station-Id=${callingstationid}`;
                }
                const command = `echo "${attr}" | radclient -t 1 -r 1 -x ${nasipaddress}:3799 disconnect '${secret}'`;
                
                exec(command, (err) => {
                    if (err) {
                        logger.error(`? [EXPIRE-FAIL] Gagal tendang ${username} di ${shortname}: ${err.message}`);
                    } else {
                        logger.info(`?? [EXPIRE-SUCCESS] ${username} di-kick di ${shortname} (Mikrotik ${mikrotik_version})`);
                    }
                });
            }
            // 5. CATAT LOG (LOGIKA ASLI TETAP)
            const { logActivity } = require('../utils/logger');
            await logActivity(adminUsername, 'EXPIRE_USER', `User ${username} diisolasi ke EXPIRED`, req);
            return { success: true, message: `User ${username} berhasil dipindah ke EXPIRED!` };
        } catch (err) {
            if (conn) await conn.rollback();
            console.error("? [RadiusManager] Expire User Error:", err.message);
            throw err;
        } finally {
            if (conn) conn.release();
        }
    },
    
    // --- JALUR PENYEMBUHAN: AKTIFKAN USER SETELAH LUNAS ---
    async activateUser(customerId, adminUsername, req) {
        let conn;
        try {
            conn = await dbPool.getConnection();
            await conn.beginTransaction();
            // 1. Ambil info Username, Paket, Tipe Paket, dan Tanggal Expired
            // (WAJIB DITAMBAH: p.type dan c.expired_date untuk deteksi kasta)
            const sql = `
                SELECT c.pppoe_username, p.name as package_name, p.type as package_type, c.expired_date 
                FROM customers c
                JOIN packages p ON c.package_id = p.id
                WHERE c.id = ?
            `;
            const [rows] = await conn.query(sql, [customerId]);
            if (rows.length === 0 || !rows[0].pppoe_username) {
                throw new Error("Data pelanggan atau paket tidak ditemukan!");
            }
            const { pppoe_username, package_name, package_type, expired_date } = rows[0];
            
            // SENSOR KASTA: Tentukan apakah dia Hotspot atau PPPoE
            const isHotspot = (package_type === 'voucher' || package_name.toUpperCase().includes('MEMBER'));
            // 2. Kembalikan grup di Radius ke Paket Aslinya (Berlaku untuk semua)
            await conn.execute(
                "UPDATE radusergroup SET groupname = ? WHERE username = ?", 
                [package_name, pppoe_username]
            );
            // 3. LOGIKA PINTAR PENYEMBUHAN (Pemisahan PPPoE vs Hotspot)
            if (!isHotspot) {
                // JIKA PPPOE: Sapu bersih Expiration attribute dan data Pool Lama
                // Biar Radius kasih "ACCEPT" dan MikroTik yang kasih IP Lokal
                await conn.execute("DELETE FROM radcheck WHERE username = ? AND attribute = 'Expiration'", [pppoe_username]);
                await conn.execute("DELETE FROM radreply WHERE username = ?", [pppoe_username]); 
            } else {
                // JIKA HOTSPOT: Pasang lagi Expiration attribute-nya sesuai tanggal di Web
                if (expired_date) {
                    const formattedExp = this.formatDateForRadius(new Date(expired_date));
                    await conn.execute("DELETE FROM radcheck WHERE username = ? AND attribute = 'Expiration'", [pppoe_username]);
                    await conn.execute("INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Expiration', ':=', ?)", [pppoe_username, formattedExp]);
                }
            }
            // 4. Update status di tabel Customers jadi Active
            await conn.execute(
                "UPDATE customers SET status = 'active', pppoe_profile = ? WHERE id = ?", 
                [package_name, customerId]
            );
            await conn.commit();
            console.log(`? [RadiusManager] User ${pppoe_username} kembali AKTIF ke paket ${package_name}`);
            // 5. TENDANG USER (Kick) agar profil di MikroTik langsung berubah detik itu juga
            await this.disconnectSession(pppoe_username);
            return { success: true, message: "Layanan telah diaktifkan kembali!" };
        } catch (err) {
            if (conn) await conn.rollback();
            console.error("? [RadiusManager] Gagal aktivasi:", err.message);
            throw err;
        } finally {
            if (conn) conn.release();
        }
    },
    async disconnectSession(username) {
        try {
            const [session] = await dbPool.query(`
                SELECT r.nasipaddress, n.secret, r.framedipaddress, r.callingstationid 
                FROM radacct r
                LEFT JOIN nas n ON r.nasipaddress = n.nasname
                WHERE r.username = ? AND r.acctstoptime IS NULL
                LIMIT 1
            `, [username]);
            if (session.length > 0) {
                const { nasipaddress, secret, framedipaddress, callingstationid } = session[0];
                
                // ?? RAKIT PELURU LENGKAP: Mikrotik v7 wajib pakai IP & MAC agar dapat ACK
                let attr = `User-Name=${username}`;
                if (framedipaddress && callingstationid) {
                    attr += `,Framed-IP-Address=${framedipaddress},Calling-Station-Id=${callingstationid}`;
                }
                
                // Gunakan shell command radclient (jalur RADIUS, bukan API)
                const command = `echo "${attr}" | radclient -x ${nasipaddress}:3799 disconnect ${secret}`;
                
                return new Promise((resolve) => {
                    const { exec } = require('child_process'); 
                    exec(command, (err, stdout, stderr) => {
                        if (err) {
                            console.error(`? [DISCONNECT-SESSION] Gagal kick ${username}: ${err.message}`);
                            resolve({ success: false, message: "Gagal kick via Radius (Ditolak Mikrotik)" });
                        } else {
                            console.log(`?? [DISCONNECT-SESSION] ${username} berhasil di-kick (Full Identity)!`);
                            resolve({ success: true, message: "User berhasil di-kick!" });
                        }
                    });
                });
            } else {
                return { success: false, message: 'User sudah offline di database.' };
            }
        } catch (err) {
            console.error(`? [DISCONNECT-SESSION-ERROR] ${err.message}`);
            return { success: false, message: err.message };
        }
    },
    // --- HELPER: KONVERSI WAKTU (ROBUST VERSION) ---
    convertToSeconds(validity) {
        if (!validity || validity === '-' || validity === '0') return null;
        let val = validity.toString().trim(); 
        let numericValue = parseInt(val);
        if (isNaN(numericValue)) return null;
        if (val.toLowerCase().endsWith('d')) return (numericValue * 86400).toString(); 
        if (val.toLowerCase().endsWith('h')) return (numericValue * 3600).toString(); 
        if (val.toLowerCase().endsWith('m')) return (numericValue * 60).toString(); 
        if (val.endsWith('M')) return (numericValue * 2592000).toString();
        return numericValue.toString();
    },
    // --- HELPER: DETIK JADI HARI/JAM/MENIT ---
    secondsToReadable(seconds) {
        if (!seconds || seconds === '-' || seconds === '0' || seconds === 0) return '-';
        let s = parseInt(seconds);
        if (isNaN(s)) return seconds;
        const days = Math.floor(s / 86400);
        const hours = Math.floor((s % 86400) / 3600);
        const mins = Math.floor((s % 3600) / 60);
        let parts = [];
        if (days > 0) parts.push(days + 'd');
        if (hours > 0) parts.push(hours + 'h');
        if (mins > 0 && days === 0) parts.push(mins + 'm'); 
        return parts.length > 0 ? parts.join(' ') : s + 's';
    },
    // --- HELPER: FORMAT TANGGAL RADIUS ---
    formatDateForRadius(date) {
        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const day = date.getDate();
        const month = months[date.getMonth()];
        const year = date.getFullYear();
        return `${month} ${day} ${year} 23:59:59`;
    },
    /**
     * Mengambil Nama Profile PPPoE yang Unik
     * Digunakan untuk Dropdown/Select di Web
     */
    async getUniquePppoeProfiles() {
        const [rows] = await dbPool.execute(`
            SELECT DISTINCT groupname FROM radgroupreply 
            WHERE groupname IN (
                SELECT groupname FROM radgroupreply 
                WHERE attribute = 'Framed-Protocol' AND value = 'PPP'
            )
            AND groupname NOT REGEXP '^[0-9 ]+$'
            AND groupname NOT LIKE '%hotspot%'
        `);
        return rows.map(r => ({ name: r.groupname }));
    },
    
    /**
     * FUNGSI HELPER: Konversi Uptime (Detik ke Jam/Menit/Detik)
     */
    formatUptime(startTime) {
        const diffMs = new Date() - startTime;
        const diffSec = Math.floor(diffMs / 1000);
        const h = Math.floor(diffSec / 3600);
        const m = Math.floor((diffSec % 3600) / 60);
        const s = diffSec % 60;
        return `${h}j ${m}m ${s}d`;
    },
    /**
     * 1. MONITORING USER HOTSPOT AKTIF (Murni Non-PPP)
     */
    async getActiveHotspotUsers() {
        const sql = `
            SELECT 
                r.radacctid as id, 
                r.username as name, 
                r.framedipaddress as ip, 
                r.callingstationid as mac, 
                r.acctstarttime, 
                r.acctinputoctets as bytes_in, 
                r.acctoutputoctets as bytes_out, 
                n.shortname as router_name,
                (SELECT groupname FROM radusergroup WHERE username = r.username LIMIT 1) as profile
            FROM radacct r
            LEFT JOIN nas n ON r.nasipaddress = n.nasname
            WHERE r.acctstoptime IS NULL 
            AND (r.framedprotocol IS NULL OR r.framedprotocol != 'PPP')
            ORDER BY r.acctstarttime DESC
        `;
        const [rows] = await dbPool.query(sql);
        return rows.map(row => ({
            ...row,
            uptime: this.formatUptime(new Date(row.acctstarttime)),
            bytes_in: row.bytes_in || 0,
            bytes_out: row.bytes_out || 0,
            router_name: row.router_name || 'Mikrotik',
            profile: row.profile || 'Default'
        }));
    },
    
    /**
     * Terminate active Hotspot session
     * Otomatis pilih jalur: CoA untuk v7, API untuk v6.
     */
    async kickHotspotUser(routerName, username) {
        try {
            // 1. Ambil Info NAS (Router)
            const [nasList] = await dbPool.execute(
                "SELECT * FROM nas WHERE shortname = ? OR nasname = ?", 
                [routerName, routerName]
            );
            if (nasList.length === 0) throw new Error("Router tidak ditemukan!");
            const nas = nasList[0];
            // ---------------------------------------------------------
            // ?? LANGKAH 1.5: CARI "KTP" SESSION (IP & MAC)
            // Agar Mikrotik v7 tidak balas NAK (Unsupported-Extension)
            // ---------------------------------------------------------
            const [session] = await dbPool.execute(`
                SELECT framedipaddress, callingstationid 
                FROM radacct 
                WHERE username = ? AND acctstoptime IS NULL 
                ORDER BY acctstarttime DESC LIMIT 1
            `, [username]);
            // =========================================================
            // ??? JALUR KHUSUS V7 (PAKAI PELURU LENGKAP)
            // =========================================================
            if (nas.mikrotik_version === 'v7') {
                logger.info(`?? [V7-SAFETY] Menendang ${username} via CoA...`);
                
                let attributes = `User-Name=${username}`;
                
                // Jika data sesi ketemu di DB, tambahkan IP & MAC ke peluru
                if (session.length > 0) {
                    const { framedipaddress, callingstationid } = session[0];
                    attributes += `,Framed-IP-Address=${framedipaddress},Calling-Station-Id=${callingstationid}`;
                }
                const coaCommand = `echo "${attributes}" | radclient -x ${nas.nasname}:3799 disconnect ${nas.secret}`;
                exec(coaCommand); 
                // Update database agar status di web langsung offline
                await dbPool.execute(
                    "UPDATE radacct SET acctstoptime = NOW(), acctterminatecause = 'Admin-Kick' WHERE username = ? AND acctstoptime IS NULL", 
                    [username]
                );
                return { success: true, method: 'Radius-CoA-v7' };
            }
            // =========================================================
            // ?? JALUR STANDAR V6 (PAKAI API NORMAL)
            // =========================================================
            const { connectToMikrotik } = require('./mikrotik');
            const conn = await connectToMikrotik(nas);
            
            if (conn) {
                const activeSess = await conn.write('/ip/hotspot/active/print', ['?user=' + username]);
                for (const sess of activeSess) {
                    await conn.write('/ip/hotspot/active/remove', ['=.id=' + sess['.id']]);
                }
                conn.close();
            } else {
                // FALLBACK: Jika API v6 gagal, tembak pakai CoA standard
                exec(`echo "User-Name=${username}" | radclient -x ${nas.nasname}:3799 disconnect ${nas.secret}`);
            }
            // B. UPDATE DATABASE RADIUS
            await dbPool.execute(
                "UPDATE radacct SET acctstoptime = NOW(), acctterminatecause = 'Admin-Kick' WHERE username = ? AND acctstoptime IS NULL", 
                [username]
            );
            return { success: true };
        } catch (error) {
            console.error(`[RadiusManager] Kick Error: ${error.message}`);
            throw error;
        }
    },
    
    /**
     * Mengambil jumlah Profile Hotspot unik (untuk tampilan Dashboard)
     */
    async getHotspotProfileCount() {
        const [rows] = await dbPool.execute(`
            SELECT DISTINCT groupname FROM radgroupreply 
            WHERE (groupname NOT IN (SELECT groupname FROM radgroupreply WHERE attribute = 'Framed-Protocol' AND value = 'PPP'))
            OR (groupname REGEXP '^[0-9 ]+$')
            UNION
            SELECT DISTINCT groupname FROM radgroupcheck 
            WHERE attribute IN ('Max-All-Session', 'Access-Period')
            AND (groupname NOT IN (SELECT groupname FROM radgroupreply WHERE attribute = 'Framed-Protocol' AND value = 'PPP'))
        `);
        return rows.length;
    },
    /**
     * Mengambil detail Profile Hotspot (untuk API / JSON)
     * Menggabungkan radgroupreply dan radgroupcheck secara presisi.
     */
    async getDetailedHotspotProfiles() {
        const [rows] = await dbPool.execute(`
            SELECT groupname, attribute, value FROM radgroupreply 
            WHERE 
                (
                    groupname NOT IN (SELECT groupname FROM radgroupreply WHERE attribute = 'Framed-Protocol' AND value = 'PPP')
                    OR groupname REGEXP '^[0-9 ]+$'
                )
                -- ??? BLOKADE ATAS: Tolak dari radgroupreply
                AND groupname NOT IN ('EXPIRED', 'isolir', 'default')
            UNION ALL
            SELECT groupname, attribute, value FROM radgroupcheck 
            WHERE 
                attribute IN ('Max-All-Session', 'Access-Period')
                AND (
                    groupname NOT IN (SELECT groupname FROM radgroupreply WHERE attribute = 'Framed-Protocol' AND value = 'PPP')
                    OR groupname REGEXP '^[0-9 ]+$'
                )
                -- ??? BLOKADE BAWAH: Tolak dari radgroupcheck
                AND groupname NOT IN ('EXPIRED', 'isolir', 'default')
            ORDER BY groupname
        `);
        const profiles = {};
        rows.forEach(row => {
            const gName = row.groupname;
            if (!profiles[gName]) {
                profiles[gName] = { 
                    name: gName, rateLimit: '', sharedUsers: '1', 
                    validity: '-', validityPeriod: '-', price: '0', '.id': gName 
                };
            }
            
            if (row.attribute === 'Mikrotik-Rate-Limit') {
                profiles[gName].rateLimit = row.value.split(' ')[0] || '';
            }
            if (row.attribute === 'Port-Limit') {
                profiles[gName].sharedUsers = row.value;
            }
            if (row.attribute === 'Max-All-Session') {
                profiles[gName].validity = this.secondsToReadable(row.value);
            }
            if (row.attribute === 'Access-Period') {
                profiles[gName].validityPeriod = this.secondsToReadable(row.value);
            }
            if (row.attribute === 'Mikrotik-Group') {
                profiles[gName].price = row.value;
            }
        });
        return Object.values(profiles);
    },
    
    /**
     * SAVE HOTSPOT PROFILE (Transaction Based)
     * Mengelola penyimpanan atribut profile hotspot secara menyeluruh.
     */
    async saveHotspotProfile(d) {
        const { 
            oldName, name, rateLimit, burstLimit, burstThreshold, burstTime, 
            sharedUsers, validity, validityPeriod, price, localAddress, remoteAddress, 
            idleTimeout 
        } = d;
        const conn = await dbPool.getConnection();
        try {
            await conn.beginTransaction();
            
            // 1. Bersihkan entri lama (Clean Slate)
            await conn.execute("DELETE FROM radgroupreply WHERE groupname = ?", [oldName || name]);
            await conn.execute("DELETE FROM radgroupcheck WHERE groupname = ?", [oldName || name]);
            // 2. Jika ganti nama, update relasi user agar tidak terputus
            if (oldName && oldName !== name) {
                await conn.execute("UPDATE radusergroup SET groupname = ? WHERE groupname = ?", [name, oldName]);
            }
            const replyQueries = [];
            const checkQueries = [];
            // 3. Rakit Rate Limit (Logic Burst MikroTik)
            let finalRate = rateLimit;
            if (burstLimit && burstThreshold && burstTime) {
                finalRate = `${rateLimit} ${burstLimit} ${burstThreshold} ${burstTime}`;
            }
            
            if (finalRate) replyQueries.push(['Mikrotik-Rate-Limit', ':=', finalRate]);
            if (sharedUsers) replyQueries.push(['Port-Limit', ':=', sharedUsers]);
            if (localAddress?.trim()) replyQueries.push(['Framed-IP-Address', ':=', localAddress.trim()]);
            if (remoteAddress?.trim()) replyQueries.push(['Framed-Pool', ':=', remoteAddress.trim()]);
            if (price) replyQueries.push(['Mikrotik-Group', ':=', price]);
            
            // Standar Interval & Timeout
            replyQueries.push(['Acct-Interim-Interval', ':=', '60']);
            replyQueries.push(['Idle-Timeout', ':=', idleTimeout ? this.convertToSeconds(idleTimeout) : '300']);
            // 4. Konversi & Rakit Batasan Waktu (Check)
            const seconds = this.convertToSeconds(validity);
            if (seconds) checkQueries.push(['Max-All-Session', ':=', seconds]);
            const activeSeconds = this.convertToSeconds(validityPeriod);
            if (activeSeconds) checkQueries.push(['Access-Period', ':=', activeSeconds]);
            // 5. Eksekusi Batch Insert (Reply)
            for (const q of replyQueries) {
                await conn.execute(
                    "INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES (?, ?, ?, ?)", 
                    [name, q[0], q[1], q[2]]
                );
            }
            
            // 6. Eksekusi Batch Insert (Check)
            for (const q of checkQueries) {
                await conn.execute(
                    "INSERT INTO radgroupcheck (groupname, attribute, op, value) VALUES (?, ?, ?, ?)", 
                    [name, q[0], q[1], q[2]]
                );
            }
            
            await conn.commit();
            return { success: true };
        } catch (error) {
            await conn.rollback();
            console.error("[RadiusManager] Save Hotspot Profile Error:", error.message);
            throw error;
        } finally {
            conn.release();
        }
    },
    /**
     * DELETE HOTSPOT PROFILE
     * Menghapus seluruh atribut profile dari Radius.
     */
    async deleteHotspotProfile(name) {
        const conn = await dbPool.getConnection();
        try {
            await conn.beginTransaction();
            await conn.execute("DELETE FROM radgroupreply WHERE groupname = ?", [name]);
            await conn.execute("DELETE FROM radgroupcheck WHERE groupname = ?", [name]);
            await conn.commit();
            return { success: true };
        } catch (error) {
            await conn.rollback();
            throw error;
        } finally {
            conn.release();
        }
    },
    
    /**
     * Mengambil Statistik Voucher & Daftar Profile Hotspot
     * Digunakan untuk memuat halaman utama Voucher.
     */
    async getVoucherStatsAndProfiles() {
        try {
            // 1. Hitung Total Voucher (Murni Hotspot/Non-PPP)
            const [countVoucher] = await dbPool.execute(`
                SELECT COUNT(DISTINCT rc.username) as total 
                FROM radcheck rc
                LEFT JOIN radusergroup rug ON rc.username = rug.username
                WHERE rc.attribute = 'Cleartext-Password'
                AND (rug.groupname IS NULL OR rug.groupname NOT IN (SELECT groupname FROM radgroupreply WHERE attribute = 'Framed-Protocol') OR rug.groupname REGEXP '^[0-9]+$')
            `);
            // 2. Hitung Total Profile Hotspot
            const [countProfile] = await dbPool.execute(`
                SELECT COUNT(DISTINCT groupname) as total FROM radgroupreply 
                WHERE groupname NOT IN (SELECT groupname FROM radgroupreply WHERE attribute = 'Framed-Protocol') OR groupname REGEXP '^[0-9]+$'
            `);
            // 3. Ambil Daftar Profile untuk Dropdown
            const [profiles] = await dbPool.execute(`
                SELECT DISTINCT groupname as name 
                FROM radgroupreply 
                WHERE (groupname NOT IN (SELECT groupname FROM radgroupreply WHERE attribute = 'Framed-Protocol' AND value = 'PPP'))
                OR (groupname REGEXP '^[0-9 ]+$')
                ORDER BY groupname ASC
            `);
            return {
                stats: {
                    totalVouchers: countVoucher[0]?.total || 0,
                    totalProfiles: countProfile[0]?.total || 0
                },
                profiles: profiles
            };
        } catch (error) {
            console.error("[RadiusManager] getVoucherStats Error:", error.message);
            throw error;
        }
    },
    /**
     * Query voucher transaction history
     * Mencari voucher berdasarkan profile, limit, atau keyword (Username/Phone).
     */
    async searchVouchers(filters) {
        const { profile, limit, search } = filters;
        try {
            let sql = `
                SELECT rc.username, rc.value as password, rug.groupname as profile, 
                       c.phone, c.address, c.expired_date, rc.id 
                FROM radcheck rc 
                LEFT JOIN radusergroup rug ON rc.username = rug.username 
                LEFT JOIN customers c ON rc.username = c.username
                WHERE rc.attribute = 'Cleartext-Password' 
                AND (rug.groupname IS NULL OR rug.groupname NOT IN (SELECT groupname FROM radgroupreply WHERE attribute = 'Framed-Protocol') OR rug.groupname REGEXP '^[0-9]+$')
            `;
            const params = [];
            if (profile && profile !== 'all') {
                sql += " AND rug.groupname = ?";
                params.push(profile);
            }
            if (search) {
                sql += " AND (rc.username LIKE ? OR c.phone LIKE ?)";
                params.push(`%${search}%`, `%${search}%`);
            }
            sql += ` ORDER BY rc.id DESC LIMIT ?`;
            params.push(parseInt(limit) || 50);
            const [rows] = await dbPool.execute(sql, params);
            return rows;
        } catch (error) {
            console.error("[RadiusManager] searchVouchers Error:", error.message);
            throw error;
        }
    },
    
    /**
     * GENERATE HOTSPOT VOUCHER (Transaction & Fallback Logic)
     * Menghasilkan voucher dalam jumlah banyak dengan login mode dan limit tertentu.
     */
    async generateHotspotVouchers(d) {
        const { 
            count, prefix, profile, price, charLength, 
            charType, login_mode, timeLimit, validityLimit 
        } = d;
        const conn = await dbPool.getConnection();
        try {
            await conn.beginTransaction();
            // 1. Konversi Waktu Input
            let finalSeconds = this.convertToSeconds(timeLimit);
            let finalAccess = this.convertToSeconds(validityLimit);
            
            // Jika limit kosong, ambil default dari radgroupcheck milik profil terpilih
            if (!finalSeconds || !finalAccess) {
                const [profLimits] = await conn.execute(
                    "SELECT attribute, value FROM radgroupcheck WHERE groupname = ? AND attribute IN ('Max-All-Session', 'Access-Period')", 
                    [profile]
                );
                profLimits.forEach(limit => {
                    if (limit.attribute === 'Max-All-Session' && !finalSeconds) {
                        finalSeconds = limit.attribute === 'Max-All-Session' ? limit.value : finalSeconds;
                    }
                    if (limit.attribute === 'Access-Period' && !finalAccess) {
                        finalAccess = limit.value;
                    }
                });
            }
            const vouchers = [];
            const length = parseInt(charLength) || 6;
            const chars = {
                'alphanumeric': 'abcdefhkmnpqrstuvwxyz23456789',
                'alphanumeric_upper': 'ABCDEFHKMNPQRSTUVWXYZ23456789',
                'alphabetic': 'abcdefhkmnpqrstuvwxyz',
                'alphabetic_upper': 'ABCDEFHKMNPQRSTUVWXYZ',
                'numeric': '23456789'
            };
            const dict = chars[charType] || chars.alphanumeric;
            const generateCode = () => {
                let str = '';
                for (let j = 0; j < length; j++) {
                    str += dict.charAt(Math.floor(Math.random() * dict.length));
                }
                return str;
            };
            // 3. LOOPING INSERSI MASSAL
            for(let i = 0; i < parseInt(count); i++) {
                const randomStr = generateCode();
                const username = (prefix || '') + randomStr;
                let password = (login_mode === 'different') ? generateCode() : username;
                // Insert Auth (Cleartext-Password)
                await conn.execute(
                    "INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Cleartext-Password', ':=', ?)", 
                    [username, password]
                );
                
                // Insert Profile (radusergroup)
                await conn.execute(
                    "INSERT INTO radusergroup (username, groupname) VALUES (?, ?)", 
                    [username, profile]
                );
                
                // Insert Time Limit (Jika ada)
                if(finalSeconds) {
                    await conn.execute(
                        "INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Max-All-Session', ':=', ?)", 
                        [username, finalSeconds]
                    );
                }
                
                // Insert Validity Limit (Jika ada)
                if(finalAccess) {
                    await conn.execute(
                        "INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Access-Period', ':=', ?)", 
                        [username, finalAccess]
                    );
                }
                
                vouchers.push({ username, password, profile, price });
            }
            await conn.commit();
            return { vouchers, profile, price };
        } catch (error) {
            if (conn) await conn.rollback();
            console.error("[RadiusManager] Generate Voucher Error:", error.message);
            throw error;
        } finally {
            if (conn) conn.release();
        }
    },
    
    /**
     * ADD USER HOTSPOT (Manual Entry)
     * Menambahkan user ke radcheck dan radusergroup dengan validasi limit profil.
     */
    async addUser(d) {
        const { username, password, profile, timeLimit, validityLimit } = d;
        const conn = await dbPool.getConnection();
        
        try {
            await conn.beginTransaction();
            // 1. VERIFIKASI: Pastikan username belum ada (Pagar Keamanan)
            const [exist] = await conn.execute(
                "SELECT id FROM radcheck WHERE username = ?", 
                [username]
            );
            if (exist.length > 0) throw new Error("Username sudah digunakan!");
            // 2. KONVERSI WAKTU: Ubah input form ke detik
            let finalSeconds = this.convertToSeconds(timeLimit);
            let finalAccess = this.convertToSeconds(validityLimit);
            // Jika input manual kosong, ambil limit dari profil di radgroupcheck
            if (!finalSeconds || !finalAccess) {
                const [profLimits] = await conn.execute(
                    "SELECT attribute, value FROM radgroupcheck WHERE groupname = ? AND attribute IN ('Max-All-Session', 'Access-Period')", 
                    [profile]
                );
                profLimits.forEach(limit => {
                    if (limit.attribute === 'Max-All-Session' && !finalSeconds) {
                        finalSeconds = limit.value;
                    }
                    if (limit.attribute === 'Access-Period' && !finalAccess) {
                        finalAccess = limit.value;
                    }
                });
            }
            // 4. EKSEKUSI INSERT: Autentikasi & Profil
            await conn.execute(
                "INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Cleartext-Password', ':=', ?)", 
                [username, password]
            );
            
            await conn.execute(
                "INSERT INTO radusergroup (username, groupname) VALUES (?, ?)", 
                [username, profile]
            );
            // 5. EKSEKUSI INSERT: Atribut Limit (Jika ada/didapat dari fallback)
            if (finalSeconds) {
                await conn.execute(
                    "INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Max-All-Session', ':=', ?)", 
                    [username, finalSeconds]
                );
            }
            
            if (finalAccess) {
                await conn.execute(
                    "INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Access-Period', ':=', ?)", 
                    [username, finalAccess]
                );
            }
            await conn.commit();
            return { success: true };
        } catch (e) {
            if (conn) await conn.rollback();
            console.error("[RadiusManager] Add User Error:", e.message);
            throw e;
        } finally {
            if (conn) conn.release();
        }
    },
    
    /**
     * Synchronize full subscriber profile across RADIUS
     * Mengupdate Password, Profil, Data Diri, dan RE-SET WAKTU FRESH DARI DETIK INI.
     * Jaminan: Semua fungsi (Auth, Billing, Kick) Terjaga 100%!
     */
    async updateMemberFull(d) {
        const { username, password, profile, phone, address, expired_date } = d;
        const conn = await dbPool.getConnection();
        
        try {
            await conn.beginTransaction();
            // --- 1. LOGIKA WAKTU (Murni Detik Ini s/d Tanggal Tujuan) ---
            let finalExpiredDate = null;
            let radiusExpString = null;
            let bDay = null; 
            let selisihDetikBaru = null;
            if (expired_date) {
                const now = new Date(); // Titik awal (SEKARANG)
                const dateObj = new Date(expired_date);
                
                // Kunci Jam ke 23:59:59 agar pelanggan tidak putus di siang hari
                dateObj.setHours(23, 59, 59, 999);
                finalExpiredDate = dateObj;
                // Sinkronisasi Hari Jatuh Tempo (billing_day)
                bDay = dateObj.getDate(); 
                // HITUNG JATAH DETIK BARU: (Target - Sekarang)
                selisihDetikBaru = Math.max(0, Math.floor((dateObj.getTime() - now.getTime()) / 1000));
                // Format Expiration untuk tabel radcheck (DD MMM YYYY)
                const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
                const rMonth = months[dateObj.getMonth()];
                const rDay = String(dateObj.getDate()).padStart(2, '0');
                const rYear = dateObj.getFullYear();
                radiusExpString = `${rDay} ${rMonth} ${rYear} 23:59:59`;
            }
            // --- 2. UPDATE AUTH & PROFIL (RADIUS) ---
            // Update Password (Cleartext-Password)
            await conn.execute(
                "UPDATE radcheck SET value = ? WHERE username = ? AND attribute = 'Cleartext-Password'", 
                [password, username]
            );
            
            // Update Group/Paket
            await conn.execute(
                "UPDATE radusergroup SET groupname = ? WHERE username = ?", 
                [profile, username]
            );
            // --- 3. RESET TOTAL PEMAKAIAN (PENGHANCUR MASALAH ANNA1122) ---
            if (selisihDetikBaru !== null) {
                // A. Hapus riwayat radacct agar SUM(sessiontime) kembali ke NOL
                // Tanpa ini, user akan langsung "Expired" jika pemakaian lamanya sudah banyak.
                await conn.execute("DELETE FROM radacct WHERE username = ?", [username]);
                // B. Suntik Max-All-Session (PulseBill Telecom)
                await conn.execute("DELETE FROM radcheck WHERE username = ? AND attribute IN ('Max-All-Session', 'Access-Period')", [username]);
                await conn.execute(
                    "INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Max-All-Session', ':=', ?)", 
                    [username, selisihDetikBaru]
                );
                // C. Suntik Session-Timeout (Instruksi langsung ke MikroTik)
                await conn.execute("DELETE FROM radreply WHERE username = ? AND attribute = 'Session-Timeout'", [username]);
                await conn.execute(
                    "INSERT INTO radreply (username, attribute, op, value) VALUES (?, 'Session-Timeout', ':=', ?)", 
                    [username, selisihDetikBaru]
                );
            }
            // Update Expiration Date
            if (radiusExpString) {
                await conn.execute("DELETE FROM radcheck WHERE username = ? AND attribute = 'Expiration'", [username]);
                await conn.execute(
                    "INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Expiration', ':=', ?)", 
                    [username, radiusExpString]
                );
            }
            // --- 4. UPDATE DATABASE BILLING (CUSTOMERS) ---
            // Cari ID Paket & Tipe Billing agar sinkron
            const [pkg] = await conn.execute("SELECT id, billing_type FROM packages WHERE name = ?", [profile]);
            let pkgId = pkg.length > 0 ? pkg[0].id : null;
            let pkgBillingType = pkg.length > 0 ? pkg[0].billing_type : 'fixed';
            // Update Full: Pass, Phone, Alamat, Expired, BDay, Paket, & PAKSA STATUS ACTIVE
            await conn.execute(`
                UPDATE customers SET 
                password = ?, pppoe_password = ?, phone = ?, address = ?, 
                expired_date = ?, billing_day = ?, billing_type = ?, package_id = ?, status = 'active'
                WHERE username = ?`, 
                [password, password, phone || '', address || '', finalExpiredDate, bDay, pkgBillingType, pkgId, username]
            );
            await conn.commit();
            // --- 5. JALUR KICK V7 (CoA DISCONNECT - FULL IDENTITY) ---
            // Kita bungkus di setImmediate agar Web tidak Loading lama
            setImmediate(async () => {
                try {
                    const { exec } = require('child_process');
                    // Cari Identitas NAS, IP, dan MAC agar Kick sukses (ACK)
                    const [nas] = await dbPool.query(`
                        SELECT r.nasipaddress, n.secret, r.framedipaddress, r.callingstationid 
                        FROM radacct r 
                        LEFT JOIN nas n ON r.nasipaddress = n.nasname 
                        WHERE r.username = ? AND r.acctstoptime IS NULL LIMIT 1
                    `, [username]);
                    
                    if (nas.length > 0) {
                        const { nasipaddress, secret, framedipaddress, callingstationid } = nas[0];
                        let attr = `User-Name=${username}`;
                        if (framedipaddress && callingstationid) {
                            attr += `,Framed-IP-Address=${framedipaddress},Calling-Station-Id=${callingstationid}`;
                        }
                        exec(`echo "${attr}" | radclient -x ${nasipaddress}:3799 disconnect ${secret}`, (err) => {
                            if (err) console.log(`? [RadiusManager] Kick Error: ${err.message}`);
                            else console.log(`? [RadiusManager] ${username} Berhasil Di-reset & Di-kick!`);
                        });
                    }
                } catch (err) {
                    console.log("? [RadiusManager] Background Kick Fail:", err.message);
                }
            });
            return { success: true, message: "Update Operation successful Waktu dihitung segar dari detik ini." };
        } catch (e) {
            if (conn) await conn.rollback();
            console.error("[RadiusManager] FATAL ERROR updateMemberFull:", e.message);
            throw e;
        } finally {
            if (conn) conn.release();
        }
    },
    
    /**
     * DELETE SINGLE VOUCHER
     * Menghapus satu data voucher/member dari tabel Radius utama.
     */
    async deleteSingleVoucher(username) {
        const conn = await dbPool.getConnection();
        try {
            // =========================================================
            // ?? 1. AMBIL DATA SESI (Cari identitas buat nendang)
            // =========================================================
            const [session] = await conn.query(`
                SELECT r.nasipaddress, n.secret, r.framedipaddress, r.callingstationid 
                FROM radacct r 
                JOIN nas n ON r.nasipaddress = n.nasname 
                WHERE r.username = ? AND r.acctstoptime IS NULL LIMIT 1
            `, [username]);
            // Jika orangnya lagi online, kita KICK dulu sekarang!
            if (session.length > 0) {
                const { nasipaddress, secret, framedipaddress, callingstationid } = session[0];
                const { exec } = require('child_process');
                
                const attr = `User-Name=${username},Framed-IP-Address=${framedipaddress},Calling-Station-Id=${callingstationid}`;
                const cmd = `echo "${attr}" | radclient -x ${nasipaddress}:3799 disconnect ${secret}`;
                
                exec(cmd); // User langsung mental dari WiFi
                console.log(`?? [RadiusManager] User ${username} ditendang dari router sebelum dihapus.`);
            }
            // =========================================================
    // Database initialization routine
            // =========================================================
            await conn.beginTransaction();
            
            await conn.execute("DELETE FROM radcheck WHERE username = ?", [username]);
            await conn.execute("DELETE FROM radusergroup WHERE username = ?", [username]);
            await conn.execute("DELETE FROM radreply WHERE username = ?", [username]); // Tambahkan radreply agar makin bersih
            await conn.execute("DELETE FROM radacct WHERE username = ?", [username]);
            await conn.execute("DELETE FROM customers WHERE username = ?", [username]); // Hapus juga dari tabel billing web
            await conn.commit();
            return { success: true };
        } catch (error) {
            if (conn) await conn.rollback();
            console.error("[RadiusManager] Delete Single Voucher Error:", error.message);
            throw error;
        } finally {
            if (conn) conn.release();
        }
    },
    /**
     * DELETE VOUCHER BATCH (Transaction Based)
     * Menghapus banyak data sekaligus dari seluruh tabel terkait termasuk tabel Customers.
     */
    async deleteVouchersBatch(usernames) {
        if (!usernames || !Array.isArray(usernames) || usernames.length === 0) {
            throw new Error("Tidak ada data username yang dipilih untuk dihapus.");
        }
        const conn = await dbPool.getConnection();
        try {
            // =========================================================
            // ?? LANGKAH 1: AMBIL "PELURU" UNTUK TENDANG USER (KICK)
            // Kita cari siapa saja yang lagi online dari daftar username ini
            // =========================================================
            const placeholders = usernames.map(() => '?').join(',');
            const [onlineUsers] = await conn.query(`
                SELECT r.username, r.nasipaddress, n.secret, r.framedipaddress, r.callingstationid 
                FROM radacct r 
                JOIN nas n ON r.nasipaddress = n.nasname 
                WHERE r.username IN (${placeholders}) 
                AND r.acctstoptime IS NULL
            `, usernames);
            // Tembak mati koneksinya di MikroTik (CoA Disconnect)
            if (onlineUsers.length > 0) {
                const { exec } = require('child_process');
                onlineUsers.forEach(user => {
                    const attr = `User-Name=${user.username},Framed-IP-Address=${user.framedipaddress},Calling-Station-Id=${user.callingstationid}`;
                    const cmd = `echo "${attr}" | radclient -x ${user.nasipaddress}:3799 disconnect ${user.secret}`;
                    exec(cmd); // Jalankan perintah tendang
                });
                console.log(`?? [RadiusManager] Berhasil menendang ${onlineUsers.length} user hantu sebelum dihapus.`);
            }
            // =========================================================
            // =========================================================
            await conn.beginTransaction();
            // 1. Hapus dari tabel Utama Radius (RADIUS check and reply tables)
            await conn.execute(`DELETE FROM radcheck WHERE username IN (${placeholders})`, usernames);
            await conn.execute(`DELETE FROM radusergroup WHERE username IN (${placeholders})`, usernames);
            
            // 2. Hapus dari tabel Tambahan (Atribut & Jejak Sesi)
            await conn.execute(`DELETE FROM radreply WHERE username IN (${placeholders})`, usernames);
            await conn.execute(`DELETE FROM radacct WHERE username IN (${placeholders})`, usernames);
            
            // 3. Hapus dari tabel Billing (Data Pelanggan Web)
            await conn.execute(`DELETE FROM customers WHERE username IN (${placeholders})`, usernames);
            await conn.commit();
            return { success: true };
        } catch (error) {
            if (conn) await conn.rollback();
            console.error("[RadiusManager] Batch Delete Error:", error.message);
            throw error;
        } finally {
            if (conn) conn.release();
        }
    },
    
    /**
     * ADD HOTSPOT MEMBER (Full Integration Radius + Billing)
     * Calculate expiration window and grace period
     */
    async addHotspotMember(d) {
        const { username, password, phone, profile, address, expired_date } = d; 
        const conn = await dbPool.getConnection();
        
        try {
            await conn.beginTransaction();
            let cleanPhone = String(phone).replace(/[^0-9]/g, '');
            if (cleanPhone.startsWith('628')) {
                cleanPhone = '0' + cleanPhone.substring(2);
            } else if (cleanPhone.startsWith('8')) {
                cleanPhone = '0' + cleanPhone;
            }
            // --- 2. VALIDASI GANDA (Sesuai Prosedur) ---
            const [existRad] = await conn.execute("SELECT id FROM radcheck WHERE username = ?", [username]);
            if (existRad.length > 0) throw new Error("Username sudah ada di Radius!");
            const [existBill] = await conn.execute("SELECT id FROM customers WHERE phone = ?", [cleanPhone]);
            if (existBill.length > 0) throw new Error(`Nomor ${cleanPhone} sudah terdaftar!`);
            // --- 3. AMBIL DATA PAKET ---
            const [packageData] = await conn.execute("SELECT id, price FROM packages WHERE name = ? LIMIT 1", [profile]);
            if (packageData.length === 0) throw new Error("Paket tidak ditemukan!");
            const pkg = packageData[0];
            // --- 4. INSERT RADIUS AUTH & GROUP ---
            await conn.execute("INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Cleartext-Password', ':=', ?)", [username, password]);
            await conn.execute("INSERT INTO radusergroup (username, groupname) VALUES (?, ?)", [username, profile]);
            // --- 5. LOGIKA KALENDER & TEMBAKAN SESSION-TIMEOUT (FIX 34 HARI) ---
            const now = new Date();
            // Pecah expired_date (YYYY-MM-DD) agar tidak error timezone
            const p = expired_date.split('-'); 
            const targetDate = new Date(parseInt(p[0]), parseInt(p[1]) - 1, parseInt(p[2]), 23, 59, 59);
            const bDay = targetDate.getDate();
            // HITUNG SELISIH DETIK (Hasilnya pasti 34 hari ke depan)
            const selisihDetik = Math.max(0, Math.floor((targetDate.getTime() - now.getTime()) / 1000));
            
            // A. Pasang Max-All-Session di radcheck (Data Internal Radius)
            await conn.execute("DELETE FROM radcheck WHERE username = ? AND attribute = 'Max-All-Session'", [username]);
            await conn.execute("INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Max-All-Session', ':=', ?)", [username, selisihDetik]);
            // B. Pasang Session-Timeout di radreply (KUNCI: Paksa MikroTik Bypass Limit Profile)
            await conn.execute("DELETE FROM radreply WHERE username = ? AND attribute = 'Session-Timeout'", [username]);
            await conn.execute("INSERT INTO radreply (username, attribute, op, value) VALUES (?, 'Session-Timeout', ':=', ?)", [username, selisihDetik]);
            // C. Gembok Expiration (Visual Kalender)
            const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
            const radiusExpFormat = `${String(bDay).padStart(2, '0')} ${months[targetDate.getMonth()]} ${targetDate.getFullYear()} 23:59:59`;
            await conn.execute("DELETE FROM radcheck WHERE username = ? AND attribute = 'Expiration'", [username]);
            await conn.execute("INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Expiration', ':=', ?)", [username, radiusExpFormat]);
            // --- 6. INSERT TABEL CUSTOMERS (SEKARANG TGL PASANG TERISI!) ---
            // Sesuai Describe: join_date (datetime), installation_date (date), created_at (timestamp)
            const sqlBilling = `
                INSERT INTO customers 
                (name, username, password, pppoe_username, pppoe_password, phone, address, package_id, status, 
                 join_date, installation_date, created_at, expired_date, billing_day, billing_type, auto_suspension) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NOW(), CURDATE(), NOW(), ?, ?, 'fixed', 1)
            `;
            const [regResult] = await conn.execute(sqlBilling, [
                username,      // name
                username,      // username
                password,      // password
                username,      // pppoe_username
                password,      // pppoe_password 
                cleanPhone,    // phone
                address || 'Area Hotspot Member', 
                pkg.id,        
                targetDate,    // expired_date (Obyek Date)
                bDay           // billing_day (Angka 20)
            ]);
            const newCustomerId = regResult.insertId;
            // --- 7. AUTOMATION: CREATE INVOICE (Utuh) ---
            const billingManager = require('./billing'); 
            if (billingManager && typeof billingManager.createInvoice === 'function') {
                try { await billingManager.createInvoice(newCustomerId); } catch (invErr) {}
            }
            await conn.commit();
            logger.info([RADIUS] Synchronized expiration for );
            return { success: true, message: `Member ${username} berhasil didaftarkan!` };
        } catch (e) {
            if (conn) await conn.rollback();
            console.error("[RadiusManager] Add Member Error:", e.message);
            throw e;
        } finally {
            if (conn) conn.release();
        }
    },
    
    /**
     * VOUCHER MONITORING: Ambil Stok Dinamis & Daftar Voucher sesuai filter
     * PPPoE session enforcement
     */
    async getVoucherMonitorData(filters) {
        const { profile = '', search = '', status = '' } = filters;
        const hotspotFilter = `
            rg.groupname NOT IN (
                SELECT DISTINCT groupname 
                FROM radgroupreply 
                WHERE attribute = 'Framed-Protocol' AND value = 'PPP'
            )
            AND rg.groupname NOT LIKE 'VLAN%'
            AND rg.groupname NOT LIKE 'PAKET%'
        `;
        // 1. Kueri Stok DINAMIS
        const [stokData] = await dbPool.execute(`
            SELECT rg.groupname, COUNT(rg.username) as total 
            FROM radusergroup rg
            WHERE ${hotspotFilter}
            GROUP BY rg.groupname
            ORDER BY CAST(rg.groupname AS UNSIGNED) ASC, rg.groupname ASC
        `);
        // 2. Kueri Tabel Data (Ditambah saringan Username @net dan Filter Global)
        let sql = `
            SELECT 
                rg.username, 
                rg.groupname,
                rc.value as password,
                (SELECT COUNT(radacctid) FROM radacct WHERE username = rg.username) as is_used
            FROM radusergroup rg 
            INNER JOIN radcheck rc ON rg.username = rc.username 
            WHERE rc.attribute = 'Cleartext-Password'
            AND ${hotspotFilter}
            AND rg.username NOT LIKE '%@net' 
        `;
        
        let params = [];
        if (profile) {
            sql += " AND rg.groupname = ?";
            params.push(profile);
        }
        if (search) {
            sql += " AND (rg.username LIKE ? OR rc.value LIKE ?)";
            params.push(`%${search}%`, `%${search}%`);
        }
        if (status === 'used') {
            sql += " AND (SELECT COUNT(radacctid) FROM radacct WHERE username = rg.username) > 0";
        } else if (status === 'ready') {
            sql += " AND (SELECT COUNT(radacctid) FROM radacct WHERE username = rg.username) = 0";
        }
        sql += " ORDER BY rg.username ASC LIMIT 2500"; 
        const [vouchers] = await dbPool.execute(sql, params);
        return { stokData, vouchers };
    },
    
    /**
     * VOUCHER MONITORING: Hapus Voucher Massal (Khusus Monitoring)
     */
    async deleteBulkMonitorVouchers(selectedVouchers) {
        if (!selectedVouchers || !selectedVouchers.length) {
            throw new Error("Tidak ada data voucher yang dipilih.");
        }
        const conn = await dbPool.getConnection();
        try {
            // =========================================================
            // ?? 1. AMBIL "PELURU" UNTUK TENDANG USER (KICK)
            // Cari data sesi bagi voucher yang sedang online saja
            // =========================================================
            const placeholders = selectedVouchers.map(() => '?').join(',');
            const [onlineSessions] = await conn.query(`
                SELECT r.username, r.nasipaddress, n.secret, r.framedipaddress, r.callingstationid 
                FROM radacct r 
                JOIN nas n ON r.nasipaddress = n.nasname 
                WHERE r.username IN (${placeholders}) 
                AND r.acctstoptime IS NULL
            `, selectedVouchers);
            // Jika ada yang online, tendang sekarang juga!
            if (onlineSessions.length > 0) {
                const { exec } = require('child_process');
                onlineSessions.forEach(user => {
                    const attr = `User-Name=${user.username},Framed-IP-Address=${user.framedipaddress},Calling-Station-Id=${user.callingstationid}`;
                    const cmd = `echo "${attr}" | radclient -x ${user.nasipaddress}:3799 disconnect ${user.secret}`;
                    exec(cmd); // Eksekusi Kick via Radius CoA
                });
                console.log(`?? [RadiusManager] Membasmi ${onlineSessions.length} sesi aktif sebelum dihapus.`);
            }
            // =========================================================
            // =========================================================
            await conn.beginTransaction();
            await conn.execute(`DELETE FROM radcheck WHERE username IN (${placeholders})`, selectedVouchers);
            await conn.execute(`DELETE FROM radusergroup WHERE username IN (${placeholders})`, selectedVouchers);
            await conn.execute(`DELETE FROM radreply WHERE username IN (${placeholders})`, selectedVouchers);
            await conn.execute(`DELETE FROM radacct WHERE username IN (${placeholders})`, selectedVouchers);
            await conn.commit();
            return { success: true, message: `${selectedVouchers.length} Voucher dibasmi total & sesi diputus!` };
        } catch (e) {
            if (conn) await conn.rollback();
            console.error("[RadiusManager] Monitor Delete Error:", e.message);
            throw e;
        } finally {
            if (conn) conn.release();
        }
    },
        
};
// EXPORT DENGAN BENAR
module.exports = { dbPool, RadiusManager };
