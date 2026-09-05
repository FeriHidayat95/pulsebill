const cron = require('node-cron');
const pool = require('./database'); 
const logger = require('./logger');
const whatsappNotifications = require('./whatsapp-notifications');
const billingManager = require('./billing');
const serviceSuspension = require('./serviceSuspension');
class InvoiceScheduler {
    constructor() {
        this.billingManager = billingManager;
        this.serviceSuspension = serviceSuspension;
        this.isGenerating = false;
        this.initScheduler();
    }
    async initScheduler() {
        const timezoneConfig = { timezone: "Asia/Jakarta" };
        // --- 1. AUTO-INVOICE (Jam 00:10 Pagi) ---
        cron.schedule('10 0 * * *', async () => {
            try {
                const [settings] = await pool.query("SELECT value FROM app_settings WHERE setting_key = 'auto_invoice_enabled'");
                const isEnabled = settings[0]?.value === 'true';
        
                if (isEnabled) {
                    logger.info(`[SCHEDULER] ?? Memulai Scan Tagihan & Sapu Bersih...`);
                    const count = await this.generateMonthlyInvoices(); 
        
                    if (count > 0) {
                        const adminNumber = '6281234567890'; 
                        const laporan = `?? *REPORT AUTO-INVOICE*\n\nBerhasil menerbitkan *${count}* invoice otomatis hari ini.`;
                        await whatsappNotifications.sendDirectMessage(adminNumber, laporan);
                        logger.info(`[SCHEDULER] Laporan Invoice terkirim ke Admin.`);
                    }
                }
            } catch (error) {
                logger.error('[SCHEDULER] ? Error Auto-Invoice:', error.message);
            }
        }, timezoneConfig);
        
        // --- 2. AUTO-ISOLIR (Jam 01:05 Pagi) ---
    // Synchronize subscriber account state
        cron.schedule('5 1 * * *', async () => {
            try {
                logger.info('[SCHEDULER] ?? Algojo Patroli: Mengeksekusi pelanggan jatuh tempo...');
                const result = await this.serviceSuspension.checkAndSuspendOverdueCustomers();
                logger.info(`[SCHEDULER] Algojo selesai. Total dieksekusi: ${result?.count || 0}`);
            } catch (error) {
                logger.error('[SCHEDULER] ? Error Auto-Isolir:', error.message);
            }
        }, timezoneConfig);
        // --- 3. REMINDER TAGIHAN (Jam 02:00 Pagi) ---
        // PENGHAPUSAN FITUR: Auto-Restore DIBUANG total karena bikin bocor.
        cron.schedule('0 2 * * *', async () => {
            try {
                logger.info('[SCHEDULER] ?? Mengirim Reminder Tagihan (H-7, 3, 1)...');
                
                // Panggil Reminder saja. Urusan buka isolir sudah pindah ke Tripay/Manual.
                await this.sendDueDateReminders();
                logger.info(`[SCHEDULER] Tugas Jam 02:00 Selesai (Hanya Reminder WA)`);
            } catch (error) {
                logger.error('[SCHEDULER] ? Error di Jam 02:00:', error.message);
            }
        }, timezoneConfig);
        logger.info("[SCHEDULER] Daily maintenance job scheduler initialized");
    }
    
    async sendDueDateReminders() {
        try {
            const [upcomingInvoices] = await pool.query(`
                SELECT i.*, c.name, c.phone, p.name as package_name, p.speed as package_speed
                FROM invoices i
                JOIN customers c ON i.customer_id = c.id
                LEFT JOIN packages p ON i.package_id = p.id
                WHERE i.status = 'unpaid' 
                AND i.due_date BETWEEN DATE_ADD(CURDATE(), INTERVAL 1 DAY) AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)
            `);
            const notificationDays = [7, 3, 1];
            for (const inv of upcomingInvoices) {
                try {
                    const today = new Date(); today.setHours(0, 0, 0, 0);
                    const dueDate = new Date(inv.due_date); dueDate.setHours(0, 0, 0, 0);
                    const diffDays = Math.round((dueDate - today) / (1000 * 60 * 60 * 24));
                    if (notificationDays.includes(diffDays)) {
                        await whatsappNotifications.sendDueDateReminder({
                            ...inv,
                            days_remaining: diffDays
                        });
                        logger.info(`[SCHEDULER] ?? Reminder H-${diffDays} terkirim: ${inv.invoice_number}`);
                    }
                } catch (error) {
                    logger.error(`[SCHEDULER] ? Gagal reminder ${inv.invoice_number}:`, error.message);
                }
            }
        } catch (error) { // <-- SEKARANG INI PUNYA PASANGAN
            logger.error('[SCHEDULER] ? Error Fatal Reminders:', error);
        }
    }
    // Financial ledger and transaction processing
    async generateMonthlyInvoices() {
        // 1. Distributed execution lock (Mencegah mesin jalan ganda)
        if (this.isGenerating) {
            logger.info("[SUSPENSION-ENGINE] Mesin generate masih bekerja, menolak eksekusi ganda.");
            return 0;
        }
        this.isGenerating = true;
        let totalCreated = 0;
        try {
            const [settings] = await pool.query("SELECT value FROM app_settings WHERE setting_key = 'invoice_generation_date'");
            const hDays = (settings[0] && settings[0].value) ? parseInt(settings[0].value) : 14;
            logger.info(`[SUSPENSION-ENGINE] Patroli Radar H-${hDays} dimulai...`);
            // AMBIL PELANGGAN YANG AKTIF MAUPUN NUNGGAK (SUSPENDED)
            const [customers] = await pool.query(`
                SELECT 
                    c.id, 
                    c.name, 
                    c.phone, 
                    c.package_id, 
                    c.expired_date, 
                    c.billing_day, 
                    c.installation_date, -- JANGKAR PSB: WAJIB ADA
                    p.price 
                FROM customers c 
                LEFT JOIN packages p ON c.package_id = p.id 
                WHERE (c.status = 'active' OR c.status = 'suspended') 
                AND c.expired_date IS NOT NULL
                AND (c.installation_date IS NULL OR c.installation_date <= DATE_SUB(CURDATE(), INTERVAL 10 DAY))
            `);
            
            // Waktu saat ini
            const now = new Date();
            const curYear = now.getFullYear();
            const curMonth = now.getMonth() + 1; // 1-12
            // Kalkulasi Bulan Depan
            let nextMonth = curMonth + 1;
            let nextYear = curYear;
            if (nextMonth > 12) {
                nextMonth = 1;
                nextYear++;
            }
            // Radar Jangkauan (Hari ini + H-Days)
            const radarDate = new Date();
            radarDate.setDate(radarDate.getDate() + hDays);
            radarDate.setHours(23, 59, 59);
            for (const customer of customers) {
                try {
                    if (!customer.price) continue;
                    // 2. TENTUKAN TANGGAL SIKLUS (BILLING DAY)
                    // Prioritas 1: Gunakan kolom billing_day jika sudah diset manual di database
                    let bDay = customer.billing_day;
                    
                    // Prioritas 2: Gunakan Hari dari Tanggal Pasang Baru (PSB) sebagai jangkar abadi
                    if (!bDay && customer.installation_date) {
                        bDay = new Date(customer.installation_date).getDate();
                    } 
                    
                    // Prioritas 3: Expired date (Hanya digunakan jika data PSB tidak tersedia)
                    else if (!bDay && customer.expired_date) {
                        bDay = new Date(customer.expired_date).getDate();
                    }
                    
                    bDay = bDay || 15; // Fallback terakhir jika semua data kosong
                    // 3. SUSUN TARGET JATUH TEMPO (BULAN INI & BULAN DEPAN)
                    const daysInCurMonth = new Date(curYear, curMonth, 0).getDate();
                    const safeCurDay = bDay > daysInCurMonth ? daysInCurMonth : bDay;
                    const curDueDate = new Date(curYear, curMonth - 1, safeCurDay, 23, 59, 59);
                    const daysInNextMonth = new Date(nextYear, nextMonth, 0).getDate();
                    const safeNextDay = bDay > daysInNextMonth ? daysInNextMonth : bDay;
                    const nextDueDate = new Date(nextYear, nextMonth - 1, safeNextDay, 23, 59, 59);
                    // 4. MASUKKAN KE DAFTAR PROSES JIKA MASUK RADAR
                    const cyclesToProcess = [];
                    // Jika jatuh tempo BULAN INI masuk jangkauan radar (atau sudah terlewat bagi yang nunggak)
                    if (curDueDate <= radarDate) {
                        cyclesToProcess.push({ month: curMonth, year: curYear, due_date: curDueDate });
                    }
                    // Jika jatuh tempo BULAN DEPAN masuk jangkauan radar (Kasus nyeberang bulan)
                    if (nextDueDate <= radarDate) {
                        cyclesToProcess.push({ month: nextMonth, year: nextYear, due_date: nextDueDate });
                    }
                    // 5. EKSEKUSI PEMBUATAN INVOICE
                    for (const cycle of cyclesToProcess) {
                        // A. Format Tanggal Manual yang Tepat (Mencegah Bug Timezone London/UTC)
                        const d = cycle.due_date;
                        const dueStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                        // B. CEK DATABASE: Apakah di TANGGAL ini sudah ada tagihan?
                        // (Mengecek Tiga Pilar sekaligus: Tanggal, Bulan, Tahun via due_date)
                        const [existing] = await pool.query(
                            `SELECT id FROM invoices 
                             WHERE customer_id = ? AND DATE(due_date) = ? AND status != 'cancelled'`,
                            [customer.id, dueStr]
                        );
                        // C. Jika tagihan di tanggal tersebut sudah ada, LEWATI! (Anti-Dobel)
                        if (existing.length > 0) {
                            logger.info(`[SUSPENSION-ENGINE] Skip ${customer.name}, tagihan untuk tanggal ${dueStr} sudah ada.`);
                            continue; 
                        }
                        // D. CETAK TAGIHAN BARU (Hanya dieksekusi jika benar-benar belum ada)
                        logger.info(`[SUSPENSION-ENGINE] ??? Menerbitkan tagihan siklus ${cycle.month}-${cycle.year} untuk ${customer.name}`);
                        await this.billingManager.createInvoice({
                            customer_id: customer.id,
                            package_id: customer.package_id,
                            amount: customer.price,
                            due_date: dueStr, // Kunci: Jatuh tempo tagihan = Tanggal siklus aslinya
                            month: cycle.month,
                            year: cycle.year,
                            phone: customer.phone,
                            notes: `Tagihan Otomatis Periode Bulan ${cycle.month}`
                        });
                        totalCreated++;
                    }
                } catch (e) { 
                    logger.error(`Error pada user ${customer.name}: ${e.message}`); 
                }
            }
            return totalCreated;
        } catch (error) { 
            logger.error(`Error Fatal Algojo: ${error.message}`); 
            return totalCreated; 
        } finally {
            // RELEASE MUTEX
            this.isGenerating = false;
        }
    }
}
module.exports = new InvoiceScheduler();
