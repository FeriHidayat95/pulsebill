const logger = require('./logger');
const { getMikrotikConnection } = require('./mikrotik');
// const { findDeviceByPhoneNumber, findDeviceByPPPoE, setParameterValues } = require('./genieacs'); // Opsional ACS
const { getSetting } = require('./settingsManager');
const dbPool = require('./database'); // Akses Database Langsung

class ServiceSuspensionManager {
    constructor() {
        this.isRunning = false;
    }

    /**
     * Helper: Ambil Billing Manager dengan Aman
     */
    getBillingManager() {
        try {
            return require('./billing');
        } catch (e) {
            console.error("[SUSPEND] Gagal load Billing:", e.message);
            return null;
        }
    }

    /**
     * Pastikan profile isolir tersedia di Mikrotik & RADIUS (Dibuat Fleksibel)
     */
    async ensureIsolirProfile() {
        try {
            const mikrotik = await getMikrotikConnection();
            
            // --- TARIK PARAMETER DARI SETTINGS (FLEKSIBEL) ---
            const profileName = getSetting('isolir_profile', 'pool-inetku-isolir'); 
            const poolName    = getSetting('isolir_pool', 'pool-inetku-isolir');
            const localAddr   = getSetting('isolir_local_address', '10.10.10.1');
            const rateLimit   = getSetting('isolir_rate_limit', '128k/128k');

            // --- 1. SINKRONISASI KE DATABASE RADIUS (SOLUSI FRAMED-POOL) ---
            try {
                // Hapus yang lama agar tidak dobel
                await dbPool.execute("DELETE FROM radgroupreply WHERE groupname = ? AND attribute = 'Framed-Pool'", [profileName]);
                // Masukkan atribut Framed-Pool yang baru
                await dbPool.execute("INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES (?, 'Framed-Pool', '=', ?)", [profileName, poolName]);
                logger.info(`‚úÖ Atribut Framed-Pool RADIUS untuk grup '${profileName}' sukses diset ke '${poolName}'`);
            } catch (radDbErr) {
                logger.error(`‚ùå Error set Framed-Pool RADIUS: ${radDbErr.message}`);
            }

            // --- 2. SINKRONISASI KE MIKROTIK (LOGIKA ASLI BOS) ---
            // Cek apakah profile sudah ada di Mikrotik
            const profiles = await mikrotik.write('/ppp/profile/print', [`?name=${profileName}`]);
            
            if (profiles && profiles.length > 0) {
                // Opsional: Update profile jika pool atau rate limit berubah di settings
                await mikrotik.write('/ppp/profile/set', [
                    `=.id=${profiles[0]['.id']}`,
                    `=remote-address=${poolName}`,
                    `=rate-limit=${rateLimit}`
                ]);
                return profiles[0]['.id'];
            }

            // Jika belum ada, buat otomatis menggunakan variabel fleksibel
            const newProfile = await mikrotik.write('/ppp/profile/add', [
                `=name=${profileName}`,
                `=local-address=${localAddr}`,
                `=remote-address=${poolName}`,
                `=rate-limit=${rateLimit}`,
                '=comment=SUSPENDED_BY_SYSTEM_FLEXIBLE',
                '=on-up=/ip hotspot active remove [find user=$user]; /ppp active remove [find name=$user]',
                '=shared-users=1'
            ]);
            
            logger.info(`‚úÖ Profile Isolir Mikrotik '${profileName}' berhasil disinkronkan dengan Pool '${poolName}'`);
            return newProfile[0]['ret'];
        } catch (error) {
            logger.error('Error ensuring flexible isolir profile:', error.message);
            return null;
        }
    }

    /**
     * Suspend layanan pelanggan (VERSI SULTAN - ANTI LOLOS)
     */
    async suspendCustomerService(customer, reason = 'Telat bayar') {
        try {
            logger.info(`Ì†ΩÌ∫® Menjalankan Isolir Resmi: ${customer.pppoe_username || customer.name}`);
            const results = { mikrotik: false, billing: false, radius: false };
            const isolirProfile = getSetting('isolir_profile', 'pool-inetku-isolir');

            if (customer.pppoe_username) {
                // 1. UPDATE RADIUS (Gunakan pool yang sudah ada di file ini)
                try {
                    // Gunakan pool/dbPool yang didefinisikan di atas file ini
                    await dbPool.execute("DELETE FROM radcheck WHERE username = ? AND attribute = 'Expiration'", [customer.pppoe_username]);
                    await dbPool.execute("DELETE FROM radusergroup WHERE username = ?", [customer.pppoe_username]);
                    await dbPool.execute("INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, '1')", [customer.pppoe_username, isolirProfile]);
                    
                    results.radius = true;
                    logger.info(`[RADIUS] ${customer.pppoe_username} dipindah ke group ${isolirProfile}`);
                } catch (e) { 
                    logger.error(`Radius Suspend Error: ${e.message}`); 
                }

                // =========================================================
                // Ì†ΩÌª°Ô∏è 2. KICK MIKROTIK (VERSI SULTAN CoA - ANTI LOLOS v7)
                // =========================================================
                try {
                    const { exec } = require('child_process');
                    
                    // Ì†ΩÌ¥é SULTAN FIX: Tarik data sesi aktif dari radacct (Berlaku untuk PPPoE & Hotspot)
                    // Kita gunakan query() jika dbPool adalah promise pool standar MariaDB/MySQL2
                    const [nas] = await dbPool.query(`
                        SELECT r.nasipaddress, n.secret, r.framedipaddress, r.callingstationid 
                        FROM radacct r 
                        LEFT JOIN nas n ON r.nasipaddress = n.nasname 
                        WHERE r.username = ? AND r.acctstoptime IS NULL LIMIT 1
                    `, [customer.pppoe_username]);

                    if (nas.length > 0) {
                        const { nasipaddress, secret, framedipaddress, callingstationid } = nas[0];
                        
                        // Ì†ΩÌ∫Ä RAKIT PELURU LENGKAP: Anti NAK v7
                        let attr = `User-Name=${customer.pppoe_username}`;
                        if (framedipaddress && callingstationid) {
                            attr += `,Framed-IP-Address=${framedipaddress},Calling-Station-Id=${callingstationid}`;
                        }

                        // Tembak langsung via Radius CoA (Super Cepat & Ringan)
                        exec(`echo "${attr}" | radclient -x ${nasipaddress}:3799 disconnect '${secret}'`, (err) => {
                            if (err) {
                                logger.error(`‚ùå [SUSPEND-KICK-FAIL] Gagal tendang ${customer.pppoe_username}: ${err.message}`);
                            } else {
                                logger.info(`Ì†ºÌæØ [SUSPEND-KICK-SUCCESS] ${customer.pppoe_username} sukses ditendang, siap masuk Pool Isolir!`);
                            }
                        });
                    } else {
                        logger.info(`‚ÑπÔ∏è [MIKROTIK] Tidak ada sesi aktif untuk ${customer.pppoe_username}, gembok Radius Isolir sudah siaga.`);
                    }
                    results.mikrotik = true;
                } catch (e) {
                    logger.error(`‚ùå Mikrotik Suspend Kick Error (CoA): ${e.message}`);
                }
            } // <=== INI KURUNG PENUTUP "IF" YANG TADI HILANG, BOS!

            // 3. UPDATE DATABASE BILLING
            try {
                // Pastikan status jadi 'suspended'
                await dbPool.query("UPDATE customers SET status = 'suspended' WHERE id = ?", [customer.id]);
                results.billing = true;
            } catch (dbErr) {
                logger.error(`Database Update Error: ${dbErr.message}`);
            }

            // 4. KIRIM NOTIFIKASI WHATSAPP
            try {
                const whatsappNotifications = require('./whatsapp-notifications');
                await whatsappNotifications.sendServiceSuspensionNotification(customer, reason);
                logger.info(`[WA] Notifikasi isolir terkirim ke ${customer.phone}`);
            } catch (waErr) {
                logger.error(`[WA] Gagal kirim notif: ${waErr.message}`);
            }

            return { success: true, results };
        } catch (error) {
            logger.error(`Suspension Failed for ${customer.name}:`, error.message);
            return { success: false, error: error.message };
        }
    }
    
    /**
     * Restore layanan pelanggan
     */
    async restoreCustomerService(customer, reason = 'Manual restore') {
        const billingManager = this.getBillingManager();

        try {
            logger.info(`‚úÖ Restoring service for customer: ${customer.pppoe_username || customer.name}`);
            const results = { mikrotik: false, billing: false, radius: false };

            // 1. Restore via Radius & Mikrotik
            if (customer.pppoe_username) {
                // Cari Profile Asli
                let profileToUse = customer.pppoe_profile;
                if (!profileToUse && customer.package_id && billingManager) {
                    const packageData = await billingManager.getPackageById(customer.package_id);
                    profileToUse = packageData?.pppoe_profile || 'default';
                }
                if (!profileToUse) profileToUse = 'default';

                // A. Update Radius
                try {
                    await dbPool.execute("DELETE FROM radusergroup WHERE username = ?", [customer.pppoe_username]);
                    await dbPool.execute("INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, '1')", [customer.pppoe_username, profileToUse]);
                    results.radius = true;
                    logger.info(`Radius: Restored ${customer.pppoe_username} to group ${profileToUse}`);
                } catch (radErr) {
                    logger.error(`Radius Restore Failed: ${radErr.message}`);
                }

                // B. Update Mikrotik (Kick User)
                try {
                    // SULTAN FIX: Cari tahu dulu user ini nyangkut di router (NAS) mana?
                    const [nasInfo] = await dbPool.query(`
                        SELECT n.* FROM radacct r 
                        JOIN nas n ON r.nasipaddress = n.nasname 
                        WHERE r.username = ? AND r.acctstoptime IS NULL LIMIT 1
                    `, [customer.pppoe_username]);

                    // Tarik datanya, lalu kirim ke mikrotik.js
                    const targetNas = nasInfo.length > 0 ? nasInfo[0] : null;
                    const mikrotik = await getMikrotikConnection(targetNas);
                    
                    // SOLDER: Cegah error saat API Mikrotik mati atau NAS tidak ketemu
                    if (!mikrotik) {
                        logger.error(`[RESTORE] API offline atau Router tidak ditemukan. User ${customer.pppoe_username} harus putus manual.`);
                    } else {
                        // Kick user agar login ulang dapat profile baru
                        const activeSessions = await mikrotik.write('/ppp/active/print', [`?name=${customer.pppoe_username}`]);
                        if (activeSessions && activeSessions.length > 0) {
                            for (const session of activeSessions) {
                                await mikrotik.write('/ppp/active/remove', [`=.id=${session['.id']}`]);
                            }
                        }
                        
                        // Penting untuk Multi-Router: Tutup koneksi setelah nendang agar memori server tidak penuh
                        if (targetNas && typeof mikrotik.close === 'function') mikrotik.close(); 
                        
                        results.mikrotik = true;
                    }
                } catch (mikrotikErr) { // <=== PERBAIKAN: Penutup TRY Mikrotik ditambahkan di sini
                    logger.error(`Mikrotik restore failed: ${mikrotikErr.message}`);
                }
            }
            
            // 2. Update Billing Status
            if (customer.id && billingManager) {
                await billingManager.setCustomerStatusById(customer.id, 'active');
                results.billing = true;
                
                // Kirim WA
                try {
                    const whatsappNotifications = require('./whatsapp-notifications');
                    whatsappNotifications.sendServiceRestorationNotification(customer, reason).catch(() => {});
                } catch (e) {}
            }

            return { success: true, results, customer: customer.pppoe_username };

        } catch (error) {
            logger.error(`Error restoring service:`, error);
            throw error;
        }
    }
    
    /**
     * Algojo Otomatis: Patroli & Eksekusi (VERSI SULTAN - ANTI DOBEL INVOICE)
     */
    async checkAndSuspendOverdueCustomers() {
        let billingManager;
        try {
            billingManager = require('./billing');
        } catch (e) {
            logger.error("[ALGOJO] ‚ùå Gagal memanggil Kasir (Billing):", e.message);
            return { success: false, message: 'Billing Module Error' };
        }

        if (this.isRunning) return { success: false, message: 'System Busy' };
        this.isRunning = true;
        let suspendedCount = 0;

        try {
            logger.info("[ALGOJO] ‚öîÔ∏è Memulai Patroli Sultan (Cek Ketat 1 Bulan 1 Invoice)...");

            // Ambil target: Pelanggan aktif yang masa aktifnya sudah habis
            const [targets] = await dbPool.execute(`
                SELECT c.*, p.price, p.name as package_name
                FROM customers c
                LEFT JOIN packages p ON c.package_id = p.id
                WHERE c.status = 'active' 
                AND c.auto_suspension = 1 
                AND c.expired_date <= NOW()
            `);

            if (targets.length === 0) {
                logger.info("[ALGOJO] ‚úÖ Aman Bos, tidak ada pelanggan yang jatuh tempo hari ini.");
                return { success: true, count: 0 };
            }

            const sekarang = new Date();
            const bulanIni = sekarang.getMonth() + 1;
            const tahunIni = sekarang.getFullYear();

            for (const customer of targets) {
                try {
                    // --- 1. CEK RIWAYAT INVOICE (Paling Teliti) ---
                    // Cari invoice APAPUN (Paid/Unpaid) yang terbit untuk PERIODE BULAN INI
                    const [invoices] = await dbPool.execute(
                        `SELECT id, created_at, status 
                         FROM invoices 
                         WHERE customer_id = ? 
                         AND MONTH(due_date) = ? 
                         AND YEAR(due_date) = ?
                         AND status != 'cancelled'
                         ORDER BY created_at DESC LIMIT 1`,
                        [customer.id, bulanIni, tahunIni]
                    );

                    let shouldSuspend = false;

                    // KONDISI A: Benar-benar belum ada invoice bulan ini
                    if (invoices.length === 0) {
                        logger.warn(`[ALGOJO] Ì†ΩÌ≥¢ ${customer.name} telat & BELUM punya tagihan bulan ${bulanIni}. Membuatkan satu...`);
                        
                        if (customer.price) {
                            await billingManager.createInvoice({
                                customer_id: customer.id,
                                package_id: customer.package_id,
                                amount: customer.price,
                                due_date: sekarang, 
                                phone: customer.phone,
                                notes: `Tagihan Otomatis Periode ${bulanIni}/${tahunIni}`
                            });
                            logger.info(`[ALGOJO] ‚è≥ Invoice sukses dibuat. ${customer.name} diberi napas 24 jam.`);
                        }
                        // Baru dibuat = Jangan isolir dulu
                        shouldSuspend = false;
                    } 
                    
                    // KONDISI B: Sudah ada invoice di bulan ini
                    else {
                        const inv = invoices[0];

                        if (inv.status === 'unpaid') {
                            // Cek masa tenggang 24 jam dari waktu pembuatan invoice
                            const invoiceAgeMs = Date.now() - new Date(inv.created_at).getTime();
                            const gracePeriodMs = 24 * 60 * 60 * 1000; 

                            if (invoiceAgeMs >= gracePeriodMs) {
                                // Sudah nunggu 24 jam tapi belum bayar? EKSEKUSI!
                                shouldSuspend = true;
                            } else {
                                logger.info(`[ALGOJO] ‚è≥ ${customer.name} nunggu sisa waktu tenggang bayar.`);
                            }
                        } else if (inv.status === 'paid') {
                            // SUDAH BAYAR: Jangan diapa-apain!
                            logger.info(`[ALGOJO] ‚úÖ ${customer.name} sudah lunas bulan ini. Aman.`);
                            shouldSuspend = false;
                        }
                    }

                    // --- 2. EKSEKUSI AKHIR (Tarik Pedang Mikrotik) ---
                    if (shouldSuspend) {
                        logger.info(`[ALGOJO] Ì†ΩÌ≤Ä Mengeksekusi Isolir: ${customer.name} (Nunggak Tagihan)`);
                        const res = await this.suspendCustomerService(customer, "Masa aktif habis & Belum ada pembayaran");
                        if (res && res.success) suspendedCount++;
                    }

                } catch (err) {
                    logger.error(`[ALGOJO] Gagal memproses ${customer.name}:`, err.message);
                }
            }

            logger.info(`[ALGOJO] ‚úÖ Patroli Selesai. Total ${suspendedCount} user diisolir.`);
            return { success: true, count: suspendedCount };

        } catch (error) {
            logger.error('[ALGOJO] ‚ùå Error Fatal:', error.message);
            return { success: false, error: error.message };
        } finally {
            this.isRunning = false;
        }
    }
}

const serviceSuspensionManager = new ServiceSuspensionManager();
module.exports = serviceSuspensionManager;