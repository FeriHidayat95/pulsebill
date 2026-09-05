// =============================================================
// SETTING ZONA WAKTU: JAKARTA (WIB) - WAJIB DI BARIS 1
// =============================================================
process.env.TZ = 'Asia/Jakarta'; 
const express = require('express');
const router = express.Router();
const multer = require('multer');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const dbPool = require('../config/database');
const { adminAuth } = require('./adminAuth');
const serviceSuspension = require('../config/serviceSuspension');
const { getSetting, getSettingsWithCache, setSetting } = require('../config/settingsManager');
const { exec } = require('child_process');
const { logActivity } = require('../utils/logger');
const whatsappManager = require('../config/whatsapp-notifications'); 
const billingManager = global.billingManager;
// =============================================================
// KONFIGURASI PENYIMPANAN FILE (MULTER)
// =============================================================
// 1. Pastikan folder uploads ada biar gak error saat nulis file
const uploadDir = 'uploads/';
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}
// 2. Seting Disk Storage agar req.file.path tersedia untuk library XLSX
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        // Nama file: timestamp-namaasli.xlsx
        cb(null, Date.now() + '-' + file.originalname);
    }
});
// 3. INISIALISASI VARIABEL 'upload' (Ini yang tadi bikin ReferenceError)
const upload = multer({ storage: storage });
// =============================================================
// HELPER FUNCTIONS
// =============================================================
function formatRadiusDate(date) {
    // Sesuai patokan config/billing.js: Tanggal dulu baru Bulan (DD MMM YYYY)
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const d = String(date.getDate()).padStart(2, '0'); // Tanggal (01, 02...)
    const m = months[date.getMonth()];               // Bulan (Jan, Feb...)
    const y = date.getFullYear();                    // Tahun (2026)
    
    // Hasilnya format Mikrotik/Radius: 21 Feb 2026 23:59:59
    return `${d} ${m} ${y} 23:59:59`;
}
async function kickUser(username) {
    if (!username) return;
    try {
    // RouterOS and RADIUS policy synchronization
        await billingManager.kickUserRadius(username);
    } catch (e) {
        console.error('? [API-KICK-ERROR]', e.message);
    }
}
// Middleware App Settings
const getAppSettings = (req, res, next) => {
    req.appSettings = {
        companyHeader: getSetting('company_header', 'ISP Monitor'),
        footerInfo: getSetting('footer_info', ''),
        logoFilename: getSetting('logo_filename', 'logo.png'),
        contact_whatsapp: getSetting('contact_whatsapp', '')
    };
    next();
};
router.use(express.json());
router.use(express.urlencoded({ extended: true }));
router.use(adminAuth);
// ==========================================
// ==========================================
router.get('/payments', adminAuth, getAppSettings, async (req, res) => {
    try {
        const [payments, unpaidInvoices] = await Promise.all([
            billingManager.getPaymentHistory(),
            billingManager.getUnpaidInvoices()
        ]);
        // 2. Render dengan tenang
        res.render('admin/billing/payments', { 
            title: 'Riwayat Pembayaran', 
            payments,
            unpaidInvoices,
            appSettings: req.appSettings 
        });
    } catch (e) { 
        console.error("? Riwayat Pembayaran Error:", e.message);
        res.status(500).send("Gagal memuat data: " + e.message); 
    }
});
router.get('/dashboard', getAppSettings, async (req, res) => {
    try {
        // 1. Panggil Asisten: Ambil semua data dalam satu tarikan napas
        const data = await billingManager.getSultanDashboardData();
        // 2. Kirim ke Kamar EJS
        res.render('admin/billing/dashboard', { 
            title: 'Dashboard Billing', 
            stats: data.stats, 
            recentInvoices: data.recentInvoices, 
            overdueInvoices: data.overdueInvoices, 
            appSettings: req.appSettings 
        });
    } catch (e) { 
        console.error("? Dashboard Error:", e.message);
        res.status(500).render('error', { 
            message: "Gagal memuat dashboard: " + e.message, 
            error: '', 
            appSettings: req.appSettings 
        }); 
    }
});
    // Synchronize subscriber account state
router.get('/customers', getAppSettings, async (req, res) => {
    try {
        // 1. Ambil 3 data sekaligus dalam satu tarikan napas (Paralel)
        const [customers, packages, nasList] = await Promise.all([
            billingManager.getAllCustomers(),
            billingManager.getAvailablePackages(),
            billingManager.getNasList()
        ]);
        // 2. Render dengan data yang sudah matang
        res.render('admin/billing/customers', { 
            title: 'Kelola Pelanggan', 
            customers: customers, 
            packages: packages, 
            nasList: nasList, 
            appSettings: req.appSettings 
        });
    } catch (e) { 
        console.error("? Kelola Pelanggan Error:", e.message);
        res.status(500).render('error', { 
            message: "Gagal muat halaman pelanggan: " + e.message, 
            error: '', 
            appSettings: req.appSettings 
        }); 
    }
});
router.get('/customers/:phone', adminAuth, getAppSettings, async (req, res) => {
    try {
        const data = await billingManager.getCustomerFullDetail(req.params.phone);
        if (!data) return res.status(404).render('error', { message: 'Pelanggan tidak ditemukan!' });
        res.render('admin/billing/customer-detail', { 
            title: `Profil - ${data.customer.name}`, 
            ...data, // Ini otomatis ngirim customer, packages, & invoices
            appSettings: req.appSettings 
        });
    } catch (e) { 
        res.status(500).send("Gagal muat profil: " + e.message); 
    }
});
// ==================================================================
// ROUTE TAMBAH PELANGGAN (VERSI FULL PERSI: AUTO-DATE & AUTO-USERNAME)
// ==================================================================
router.post('/customers', async (req, res) => {
    try {
        console.log('[ROUTE] Memproses tambah pelanggan baru (Manual Web Form)...');
        // 1. AMBIL DATA FORM (Sekarang installation_date ditangkap di sini)
        const { 
            name, phone, pppoe_username, email, address, 
            package_id, pppoe_profile, auto_suspension, billing_day, 
            pppoe_password, wifi_password,
            join_date,
            installation_date // <--- [SINKRON] Ditangkap dari Frontend EJS
        } = req.body;
        // 2. LOGIKA AUTO-USERNAME (Username = No HP)
        const finalUsername = phone.replace(/[^0-9]/g, ''); 
        
        // 3. Validasi Wajib
        if (!name || !finalUsername || !package_id) {
            return res.status(400).json({
                success: false,
                message: 'Nama, No HP, dan Paket WAJIB diisi!'
            });
        }
        // 4. Tentukan Profile Radius
        let profileToUse = pppoe_profile;
        if (!profileToUse) {
            const packageData = await billingManager.getPackageById(package_id);
            profileToUse = packageData?.pppoe_profile || 'default';
        }
        // 5. SIAPKAN DATA KE MANAGER (Full Parameter)
        const customerData = {
            name,
            username: finalUsername,
            phone,
            pppoe_username,
            pppoe_password: pppoe_password, 
            wifi_password: wifi_password || pppoe_password, 
            email,
            address,
            package_id,
            pppoe_profile: profileToUse,
            status: 'active',
            auto_suspension: auto_suspension !== undefined ? parseInt(auto_suspension) : 1,
            // --- DATA KRUSIAL UNTUK TANGGAL ---
            billing_day: billing_day,       // Kirim apa adanya, biar Mesin yang ngolah
            join_date: join_date,           // Kirim apa adanya, biar Mesin yang ngolah
            installation_date: installation_date // <--- [SINKRON] Dikirim ke BillingManager.js
        };
        // 6. EKSEKUSI SIMPAN KE MESIN PINTAR (billingManager.createCustomer)
        const result = await billingManager.createCustomer(customerData);
        // 7. Respon Hasil
        if (result.success) {
            res.json({
                success: true,
                message: 'Pelanggan berhasil ditambahkan!',
                customer: result
            });
        } else {
            // Cek error duplikat
            let msg = result.message;
            if (msg.includes('Duplicate') || msg.includes('terdaftar')) {
                msg = 'No HP atau Username PPPoE sudah terdaftar!';
            }
            res.status(400).json({ success: false, message: msg });
        }
    } catch (error) {
        console.error('[ROUTE ERROR]:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan server: ' + error.message
        });
    }
});
    // Financial ledger and transaction processing
router.get('/invoices', getAppSettings, async (req, res) => {
    try {
        // 1. Ambil 3 data secara paralel (Data Tagihan, List Pelanggan, & List Paket)
        const [invoices, customers, packages] = await Promise.all([
            billingManager.getAllInvoicesWithRadius(),
            billingManager.getCustomerListForDropdown(),
            billingManager.getAvailablePackages()
        ]);
        // 2. Kirim ke Kamar EJS
        res.render('admin/billing/invoices', { 
            title: 'Kelola Tagihan', 
            invoices, 
            customers, 
            packages, 
            appSettings: req.appSettings 
        });
    } catch (e) { 
        console.error("? Kelola Tagihan Error:", e.message);
        res.status(500).render('error', { 
            message: "Gagal muat halaman tagihan: " + e.message, 
            error: '', 
            appSettings: req.appSettings 
        }); 
    }
});
// ==========================================
    // Financial ledger and transaction processing
// ==========================================
router.post('/invoices', adminAuth, async (req, res) => {
    try {
        // 1. Serahkan data form ke Koki Utama
        const result = await billingManager.createManualInvoice(req.body);
        // 2. Beri kabar gembira ke Admin
        res.json({
            success: true,
            message: `Invoice ${result.invoice_number} Berhasil Nongol!`,
            data: result
        });
    } catch (e) {
        console.error("? EROR SIMPAN:", e.message);
    // Synchronize subscriber account state
        res.json({ 
            success: false, 
            message: e.message 
        });
    }
});
// ==========================================
    // Financial ledger and transaction processing
// ==========================================
router.get('/invoices/:id/print', adminAuth, async (req, res) => {
    try {
        const data = await billingManager.getInvoicePrintData(req.params.id);
        if (!data) return res.status(404).send("Invoice not found");
        // 2. Render langsung kirim objek 'data' (isinya invoice & appSettings)
        res.render('admin/billing/invoice-print', { 
            layout: false, 
            title: `Invoice #${data.invoice.invoice_number}`, 
            ...data // Otomatis mengirim invoice dan appSettings ke EJS
        });
    } catch (e) { 
        console.error("? Print Error:", e.message);
        res.status(500).send("Gagal mencetak: " + e.message); 
    }
});
    // Financial ledger and transaction processing
router.get('/invoices/:id/edit', adminAuth, getAppSettings, async (req, res) => {
    try {
        const data = await billingManager.getInvoiceEditData(req.params.id);
    // Financial ledger and transaction processing
        if (!data) {
            return res.status(404).render('error', { 
                message: 'Invoice not found', 
                error: '', 
                appSettings: req.appSettings 
            });
        }
        // 3. Render dengan data lengkap (Otomatis ngirim invoice, customers, & packages)
        res.render('admin/billing/invoice-edit', { 
            title: `Edit Invoice #${data.invoice.invoice_number}`, 
            ...data, 
            appSettings: req.appSettings 
        });
    } catch (e) {
        console.error("? Form Edit Error:", e.message);
        res.status(500).render('error', { 
            message: "Gagal buka form edit: " + e.message, 
            error: '', 
            appSettings: req.appSettings 
        });
    }
});
// =============================================================
    // Synchronize subscriber account state
// =============================================================
router.post('/invoices/update', adminAuth, async (req, res) => {
    try {
        // 1. Eksekusi Sinkronisasi Total
        const result = await billingManager.syncInvoiceAndUpdateRadius(req.body);
        // 2. Kick User (Jika ada username-nya) agar session baru aktif
        if (result.pppoe_username) {
            await kickUser(result.pppoe_username);
        }
        res.json({ 
            success: true, 
            message: 'Sinkronisasi Berhasil! Web & Mikrotik sudah Salim.' 
        });
    } catch (e) {
        console.error("? Update Error:", e.message);
        res.status(500).json({ success: false, message: "Gagal Update: " + e.message });
    }
});
// ==========================================
// ==========================================
router.post('/invoices/:id/restore', adminAuth, async (req, res) => {
    try {
    // Database initialization routine
        const result = await billingManager.restoreServiceSOP(req.params.id);
        // 2. Background Process (Tanpa mengganggu response user)
        // Kita gunakan 'then' supaya admin gak nunggu loading WA/Kick kelamaan
        (async () => {
            try {
                // Kirim WA Notif
                await billingManager.sendPaymentSuccessNotification(req.params.id);
                // Tendang di MikroTik agar dapet profile kecepatan terbaru
                if (result.pppoe_username) {
                    const mikrotik = require('../config/mikrotik');
                    await mikrotik.disconnectUser(result.pppoe_username);
                }
            } catch (err) { console.error("?? Background task failed:", err.message); }
        })();
        res.json({ 
            success: true, 
            message: `Layanan ${result.customer_name} Aktif & Kas Tercatat!` 
        });
    } catch (e) {
        console.error("? Restore Error:", e.message);
        res.status(500).json({ success: false, message: "Error SOP: " + e.message });
    }
});
// ==========================================
    // Financial ledger and transaction processing
// ==========================================
router.get('/export/payments', adminAuth, async (req, res) => {
    try {
        const ExcelJS = require('exceljs'); // Pastikan library sudah terpasang
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Riwayat Pembayaran');
        worksheet.columns = [
            { header: 'No Invoice', key: 'inv', width: 25 },
            { header: 'Pelanggan', key: 'name', width: 30 },
            { header: 'Jumlah (Rp)', key: 'amount', width: 15 },
            { header: 'Metode', key: 'method', width: 15 },
            { header: 'Tanggal Bayar', key: 'date', width: 20 }
        ];
        const payments = await billingManager.getPaymentReportData();
        // 3. Masukkan Data ke Baris Excel
        payments.forEach(p => {
            worksheet.addRow({ 
                inv: p.invoice_number || 'INV-MANUAL', 
                name: p.customer_name || 'Hamba Allah', 
                amount: p.amount, 
                method: p.payment_method, 
                date: p.payment_date 
            });
        });
        // 4. Pengaturan Header Response (Agar Browser Langsung Download)
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=Laporan_Pembayaran_Sultan.xlsx');
        // 5. Tulis dan Kirim!
        await workbook.xlsx.write(res);
        res.end();
    } catch (e) {
        console.error("? Export Error:", e.message);
        res.status(500).send("Gagal menarik laporan: " + e.message);
    }
});
router.get('/service-suspension', getAppSettings, async (req, res) => {
    try {
        const data = await billingManager.getSuspensionPageData();
        // 2. Kirim ke Kamar EJS
        res.render('admin/billing/service-suspension', { 
            title: 'Service Suspension', 
            suspendedUsers: data.suspendedUsers, 
            radiusProfiles: data.radiusProfiles, 
            settings: data.settings, 
            appSettings: data.settings, // Fallback untuk sidebar/header
            stats: data.stats,
            user: res.locals.user
        });
    } catch (e) { 
        console.error("? Algojo Route Error:", e.message);
        res.status(500).render('error', { 
            message: "Gagal muat sistem isolir: " + e.message, 
            error: '', 
            appSettings: req.appSettings 
        }); 
    }
});
// =============================================================
    // Synchronize subscriber account state
// =============================================================
router.post('/service-suspension/isolir-profile', adminAuth, async (req, res) => {
    try {
        const { isolir_profile } = req.body;
        if (!isolir_profile) {
            return res.status(400).json({ 
                success: false, 
                message: 'Nama profil isolir tidak boleh kosong!' 
            });
        }
        // 2. Simpan ke Database via Manager
        // setSetting biasanya sudah mengurus update app_settings
        await setSetting('isolir_profile', isolir_profile);
        // 3. Beri Laporan Sukses
        res.json({ 
            success: true, 
            message: `Suspension profile successfully set to: ${isolir_profile}` 
        });
    } catch (e) {
        console.error("? Failed to update suspension profile:", e.message);
        res.status(500).json({ 
            success: false, 
            message: "Gagal menyimpan: " + e.message 
        });
    }
});
router.get('/packages', adminAuth, getAppSettings, async (req, res) => {
    try {
        const data = await billingManager.getPackagesPageData();
        // 2. Render ke Dashboard Paket
        res.render('admin/billing/packages', { 
            title: 'Kelola Paket', 
            packages: data.packages, 
            usedPackageIds: data.usedPackageIds, // Tambahan untuk proteksi di EJS
            radiusProfiles: data.radiusProfiles, 
            appSettings: req.appSettings 
        });
    } catch (e) { 
        console.error("? Packages Route Error:", e.message);
        res.status(500).render('error', { 
            message: "Gagal muat daftar paket: " + e.message, 
            error: '', 
            appSettings: req.appSettings 
        }); 
    }
});
// 1. TAMBAH PAKET
router.post('/packages', adminAuth, async (req, res) => {
    try {
        const pelaksana = req.session?.user?.name || req.session?.user?.username || 'admin';
        
        // ?? Lempar ke manager: (data_form, id_paket_null, nama_pelaksana)
        await billingManager.savePackage(req.body, null, pelaksana);
        
        res.json({ success: true, message: 'Paket Operation successful Ditambahkan!' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
// 2. UPDATE PAKET
router.put('/packages/:id', adminAuth, async (req, res) => {
    try {
        const pelaksana = req.session?.user?.name || req.session?.user?.username || 'admin';
        
        // ?? Lempar ke manager: (data_form, id_paket, nama_pelaksana)
        await billingManager.savePackage(req.body, req.params.id, pelaksana);
        
        res.json({ success: true, message: 'Paket Berhasil Diupdate!' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
// 3. HAPUS PAKET
router.delete('/packages/:id', adminAuth, async (req, res) => {
    try {
    // RouterOS and RADIUS policy synchronization
        const pelaksana = req.session?.user?.name || req.session?.user?.username || 'admin';
        
        // ?? LEMPAR ID PAKET SEKALIGUS NAMA PELAKSANANYA KE MANAGER
        await billingManager.deletePackage(req.params.id, pelaksana);
        
        res.json({ success: true, message: 'Paket Berhasil Dilenyapkan!' });
    } catch (e) { 
        res.json({ success: false, message: e.message }); 
    } 
});
// 4. API AMBIL DATA PAKET (UNTUK MODAL EDIT)
router.get('/api/packages/:id', adminAuth, async (req, res) => {
    try {
        const pkg = await billingManager.getPackageById(req.params.id);
        res.json({ success: true, package: pkg });
    } catch (e) { res.status(500).json({ success: false }); }
});
    // Financial ledger and transaction processing
router.get('/auto-invoice', adminAuth, getAppSettings, async (req, res) => {
    try {
        const data = await billingManager.getAutoInvoiceStatusData();
        // 2. Kirim ke Kamar EJS (Lengkap & Matang)
        res.render('admin/billing/auto-invoice', { 
            title: 'Auto Invoice', 
            ...data, // Otomatis mengirim all stats & dates
            appSettings: req.appSettings 
        });
    } catch (e) {
        console.error("? Auto Invoice Error:", e.message);
        res.status(500).render('error', { 
            message: "Gagal memuat pusat komando: " + e.message, 
            error: '', 
            appSettings: req.appSettings 
        });
    }
});
// ==========================================
// ==========================================
router.get('/api/stats', adminAuth, async (req, res) => {
    try {
        // Panggil sensor statistik kilat
        const stats = await billingManager.getQuickStats();
        
        // Kirim hasil sebagai JSON
        res.json(stats);
    } catch (e) { 
        res.status(500).json({ 
            success: false, 
            message: "Gagal mengambil sensor data: " + e.message 
        }); 
    }
});
// =============================================================
// ROUTE WHATSAPP SETTINGS & STATUS (DIPERBAIKI)
// =============================================================
// GANTI BAGIAN INI SAJA:
router.get('/whatsapp-settings', adminAuth, async (req, res) => {
    const settings = await getSettingsWithCache(); 
    res.render('admin/billing/whatsapp-settings', { 
        title: 'WhatsApp Settings', 
        settings: settings, 
        user: res.locals.user // ? INI YANG DITAMBAHKAN
    }); 
});
    // Synchronize subscriber account state
router.get('/whatsapp-settings/status', adminAuth, async (req, res) => {
    try {
        // A. Ambil Status WA Global
        const wa = global.whatsappStatus || { connected: false, qr: null };
        // B. Hitung Pelanggan Aktif (Pakai dbPool)
        const [activeRows] = await dbPool.query("SELECT COUNT(*) as count FROM customers WHERE status = 'active'");
        const activeCount = activeRows[0]?.count || 0;
        // C. Hitung Tagihan Pending/Unpaid (Pakai dbPool)
        const [pendingRows] = await dbPool.query("SELECT COUNT(*) as count FROM invoices WHERE status = 'unpaid'");
        const pendingCount = pendingRows[0]?.count || 0;
        // D. Kirim JSON Lengkap
        res.json({
            success: true,
            connected: wa.connected,
            qr: wa.qr || wa.qrCode,
            info: {
                activeCustomers: activeCount, // Data ini yang ditunggu Frontend
                pendingInvoices: pendingCount // Data ini yang ditunggu Frontend
            }
        });
    } catch (e) {
        console.error("[WA STATUS ERROR]:", e.message);
        res.json({ success: false, connected: false });
    }
});
// ==========================================
// ==========================================
// 3. Route Get Templates (Ambil daftar template yang ada)
router.get('/whatsapp-settings/templates', adminAuth, async (req, res) => { 
    try { 
        const wa = require('../config/whatsapp-notifications'); 
        const templates = wa.getTemplates();
        
        res.json({ 
            success: true, 
            templates: templates || {},
            message: 'Template berhasil dimuat'
        }); 
    } catch (e) { 
        console.error("? Gagal muat template WA:", e.message);
        res.json({ success: false, message: 'Gagal memuat daftar template' }); 
    } 
});
// 4. Route Save Templates (Simpan perubahan tulisan pesan)
router.post('/whatsapp-settings/templates', adminAuth, async (req, res) => { 
    try { 
        const wa = require('../config/whatsapp-notifications'); 
        
        // Pastikan ada data yang dikirim
        if (!req.body || Object.keys(req.body).length === 0) {
            return res.status(400).json({ success: false, message: 'Data template kosong!' });
        }
        const result = await wa.updateTemplates(req.body); 
        
        res.json({ 
            success: true, 
            message: 'Notification template successfully updated.' 
        }); 
    } catch (e) { 
        console.error("? Gagal simpan template WA:", e.message);
        res.status(500).json({ success: false, message: e.message }); 
    } 
});
// 5. Route Test Kirim Pesan (Uji coba sebelum sebar tagihan massal)
router.post('/whatsapp-settings/test', adminAuth, async (req, res) => { 
    try { 
        const wa = require('../config/whatsapp-notifications'); 
        const { phoneNumber, templateKey } = req.body;
        if (!phoneNumber || !templateKey) {
            return res.json({ success: false, message: 'No HP dan Jenis Template wajib ada!' });
        }
        // Data dummy untuk simulasi isi variabel {{customer_name}}, dll.
        const dummyData = { 
            customer_name: 'Jane Doe', 
            invoice_number: 'INV-2026-TEST', 
            amount: '150.000',
            due_date: '28 Februari 2026',
            package_name: 'Fiber Enterprise 50M',
            days_remaining: '3',
            login_url: 'https://pulsebill.io/login'
        };
        
        console.log(`?? Mengirim pesan test (${templateKey}) ke: ${phoneNumber}`);
        const r = await wa.testNotification(phoneNumber, templateKey, dummyData); 
        
        res.json({ 
            success: r.success, 
            message: r.success ? 'Test notification sent successfully.' : `Gagal: ${r.error}` 
        }); 
    } catch (e) { 
        console.error("? Test WA Error:", e.message);
        res.json({ success: false, message: 'Terjadi kesalahan sistem: ' + e.message }); 
    } 
});
// ======================= API INVOICE DETAIL (V2) =======================
router.get('/api/invoices/:id', adminAuth, async (req, res) => {
    try { 
        const invoice = await billingManager.getInvoiceDetailById(req.params.id);
        if(!invoice) return res.json({ success: false, message: 'Record not found' });
        res.json({ success: true, invoice }); 
    } catch(e) { 
        res.json({ success: false, message: e.message }); 
    }
});
// ======================= PAYMENT SETTINGS (V2) =======================
router.get('/payment-settings', adminAuth, getAppSettings, async (req, res) => {
    try {
        // Ambil konfigurasi yang sudah matang dari Manager
        const pgConfig = await billingManager.getPaymentGatewayConfig();
        
        // Simpan ke appSettings agar bisa diakses global di EJS
        req.appSettings.payment_gateway = pgConfig;
        
        res.render('admin/billing/payment-settings', { 
            title: 'Pengaturan Payment Gateway', 
            settings: req.appSettings, 
            appSettings: req.appSettings 
        });
    } catch (e) { 
        console.error("? PG Settings Error:", e.message);
        res.status(500).send("Failed to load settings: " + e.message); 
    }
});
// ==========================================
// ==========================================
router.post('/payment-settings/:gateway', adminAuth, async (req, res) => {
    try {
        const targetGateway = req.params.gateway;
        // Serahkan semua urusan rakit-merakit ke Manager
        await billingManager.savePaymentGatewayConfig(targetGateway, req.body);
        res.json({ 
            success: true, 
            message: `Konfigurasi ${targetGateway.toUpperCase()} Berhasil Disimpan!` 
        });
    } catch (e) {
        console.error("? Save Setting Error:", e.message);
        res.status(500).json({ 
            success: false, 
            message: "Gagal menyimpan konfigurasi: " + e.message 
        });
    }
});
// ==========================================
// ==========================================
router.post('/invoices/:id/generate-tripay', adminAuth, async (req, res) => {
    try {
        // Ambil hostname otomatis (Misal: billing.pulsebill.io)
        const hostname = req.get('host'); 
        // Serahkan ke Arsitek Link
        const payUrl = await billingManager.generatePaymentSelectionLink(req.params.id, hostname);
        res.json({ 
            success: true, 
            pay_url: payUrl,
            message: 'Link Pembayaran Berhasil Diracik!'
        });
    } catch (e) { 
        console.error("? Generate Link Error:", e.message);
        res.json({ success: false, message: "Gagal meracik link: " + e.message }); 
    }
});
// ==========================================
// ==========================================
router.post('/invoices/:id/reminder', adminAuth, async (req, res) => {
    try {
        // 1. Perintahkan asisten untuk kirim reminder
        const result = await billingManager.sendInvoiceReminder(req.params.id);
        // 2. Jika data tidak ada
        if (!result) {
            return res.json({ success: false, message: 'Invoice data not found' });
        }
        // 3. Beri respon instan ke Admin
        res.json({ 
            success: true, 
            message: `Notification queued for ${result.name}...` 
        });
    } catch (e) {
        console.error('[REMINDER-ROUTE-ERR]:', e.message);
        res.status(500).json({ success: false, message: "Gagal memproses reminder: " + e.message });
    }
});
// ==========================================
// ==========================================
router.post('/invoices/:id/resend-wa', adminAuth, async (req, res) => {
    try {
        // Serahkan perintah kirim ulang ke Manager
        const result = await billingManager.resendInvoiceWA(req.params.id);
        if (result.success) {
            res.json({ 
                success: true, 
                message: `Berhasil dikirim ulang ke ${result.customer_name}!` 
            });
        } else {
            res.json({ 
                success: false, 
                message: result.message 
            });
        }
    } catch (e) { 
        console.error('[WA-RESEND-ROUTE-ERR]:', e.message);
        res.status(500).json({ success: false, message: 'Server Error: ' + e.message }); 
    }
});
// 1. Rute Khusus Refund (TARUH PALING ATAS di antara rute POST invoice lainnya)
router.post('/invoices/:id/refund', adminAuth, async (req, res) => {
    try {
        const result = await billingManager.refundInvoiceSOP(req.params.id);
        res.json({ 
            success: true, 
            message: `Tagihan ${result.invoice_number} dibatalkan. Uang kas berhasil ditarik!` 
        });
    } catch (e) {
        console.error("? REFUND ERROR:", e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});
// =============================================================
// =============================================================
router.post('/invoices/:id/:action', adminAuth, async (req, res) => {
    const { id, action } = req.params;
    
    try {
        // Serahkan perintah ke Kontroller Utama
        const result = await billingManager.executeServiceAction(id, action);
        res.json({ 
            success: true, 
            message: `Layanan ${result.name} telah BERHASIL ${result.status}!` 
        });
    } catch (e) {
        // Jika MikroTik RTO, Error Database, atau Aksi Salah, Admin dapat info jelas
        console.error(`[ERR ROUTE ${action.toUpperCase()}]:`, e.message);
        res.status(500).json({ 
            success: false, 
            message: "Gagal eksekusi: " + e.message 
        });
    }
});
// =============================================================
    // Financial ledger and transaction processing
// =============================================================
router.get('/settings/invoice', adminAuth, async (req, res) => {
    try {
        // 1. Minta data dashboard ke asisten
        const dashData = await billingManager.getAutoInvoiceSettingsDashboard();
        // 2. Kirim ke View EJS
        res.render('admin/billing/settings_invoice', { 
            title: 'Pengaturan Invoice Otomatis',
            settings: getSettingsWithCache(),
            appSettings: req.appSettings,
            ...dashData // Spread operator: memasukkan semua stats & date secara otomatis
        });
    } catch (e) { 
        console.error("? Auto Invoice Settings Route Error:", e.message);
        res.status(500).render('error', { 
            message: "Gagal memuat pusat kontrol: " + e.message, 
            error: '', 
            appSettings: req.appSettings 
        }); 
    }
});
// ==========================================
    // Financial ledger and transaction processing
// ==========================================
router.get('/auto-invoice/preview', adminAuth, async (req, res) => {
    try {
    // Financial ledger and transaction processing
        const customers = await billingManager.getAutoInvoicePreview();
        res.json({ 
            success: true, 
            count: customers.length,
            customers: customers 
        });
    } catch (e) { 
        console.error("? Preview Error:", e.message);
        res.status(500).json({ 
            success: false, 
            message: "Gagal memindai pelanggan: " + e.message 
        }); 
    }
});
// ==========================================
    // Financial ledger and transaction processing
// ==========================================
router.post('/auto-invoice/generate', adminAuth, async (req, res) => {
    try {
        // Panggil mesin cetak duit massal
        const count = await billingManager.bulkGenerateInvoices();
        res.json({ 
            success: true, 
            count: count,
            message: count > 0 
                ? `Berhasil menerbitkan ${count} invoice secara massal!` 
                : 'All monthly invoices have already been issued.'
        });
    } catch (e) { 
        console.error("? Bulk Generate Error:", e.message);
        res.status(500).json({ 
            success: false, 
            message: "Gagal memproses tagihan massal: " + e.message 
        }); 
    }
});
// ==========================================
// API SIMPAN SETTING AUTO-INVOICE (V2 + SOCKET)
// ==========================================
router.post('/auto-invoice/settings', adminAuth, async (req, res) => {
    try {
        // 1. Serahkan urusan database ke Manager
        const result = await billingManager.updateAutoInvoiceSettings(req.body);
        const io = req.app.get('socketio');
        if (io) {
            io.emit('autoInvoiceStatusUpdate', { 
                enabled: result.isEnabled 
            });
            console.log(`?? [SOCKET] Broadcast: Auto-Invoice is now ${result.isEnabled ? 'ON' : 'OFF'}`);
        }
        res.json({ 
            success: true, 
            message: 'Konfigurasi Operation successful Disinkronkan!' 
        });
    } catch (e) { 
        logger.error("Failed to save settings:", e.message);
        res.status(500).json({ 
            success: false, 
            message: "Gagal update frekuensi: " + e.message 
        }); 
    }
});
// ==========================================
// ==========================================
router.post('/payment-gateway/test', adminAuth, async (req, res) => {
    try {
        const result = await billingManager.testGatewayConnection(req.body);
        res.json({ 
            success: true, 
            message: result.message 
        });
    } catch (e) {
        // Jika data tidak valid, berikan alasan yang jelas ke Admin
        console.error("? Payment Test Error:", e.message);
        res.json({ 
            success: false, 
            message: e.message 
        });
    }
});
// =============================================================
// =============================================================
router.post('/payment-gateway/save', adminAuth, async (req, res) => {
    try {
        console.log(`[ADMIN] Menyimpan Perubahan Konfigurasi Gateway...`);
        // Serahkan perintah simpan massal ke Manager
        const result = await billingManager.saveFullGatewayConfig(req.body);
        res.json({ 
            success: true, 
            message: `Operation successful Konfigurasi ${result.active.toUpperCase()} telah diperbarui.` 
        });
    } catch (e) {
        console.error("? Save Gateway Error:", e.message);
        res.status(500).json({ 
            success: false, 
            message: "Gagal menyimpan konfigurasi: " + e.message 
        });
    }
});
// ==========================================
// ?? MENU DARURAT: FIX DATABASE SETTINGS (V2)
// ==========================================
router.get('/fix-database-settings', adminAuth, async (req, res) => {
    try {
        // Panggil Arsitek Database
        await billingManager.initializeSettingsTable();
        res.send(`
            <div style="font-family: 'Segoe UI', sans-serif; text-align: center; padding: 100px; background: #f8f9fa;">
                <div style="background: white; padding: 40px; border-radius: 15px; box-shadow: 0 10px 30px rgba(0,0,0,0.1); display: inline-block;">
                    <h1 style="color: #28a745; margin-bottom: 10px;">? PONDASI BERHASIL DIBANGUN!</h1>
                    <p style="color: #6c757d; font-size: 18px;">Tabel <b>app_settings</b> sudah siap tempur di database MariaDB.</p>
                    <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
                    <a href="/admin/billing/payment-settings" 
                       style="display: inline-block; padding: 15px 30px; background: #007bff; color: white; text-decoration: none; border-radius: 50px; font-weight: bold; transition: 0.3s;">
                       Return to System Settings
                    </a>
                </div>
            </div>
        `);
    } catch (e) {
        console.error("? Emergency Route Error:", e.message);
        res.status(500).send(`<h1 style="color: red; text-align: center; padding-top: 50px;">GAGAL MEMBANGUN PONDASI: ${e.message}</h1>`);
    }
});
// =============================================================
// =============================================================
router.get('/api/suspension-stats', adminAuth, async (req, res) => {
    try {
        const stats = await billingManager.getSuspensionStats();
        
        // Kirim hasil murni sebagai JSON
        res.json(stats);
    } catch (e) {
        console.error("? Stats Route Error:", e.message);
        res.status(500).json({ 
            success: false, 
            message: "Gagal mengambil data sensor: " + e.message 
        });
    }
});
// =============================================================
// =============================================================
// B. Ambil Data Tabel Pelanggan Terisolir
router.get('/service-suspension/data', adminAuth, async (req, res) => {
    try {
        const data = await billingManager.getSuspendedData();
        res.json({ success: true, data });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});
// C. Simpan Profile Isolir (Setting Radius Mikrotik)
router.post('/service-suspension/isolir-profile', adminAuth, async (req, res) => {
    try {
        await dbPool.execute(
            "UPDATE app_settings SET value = ? WHERE setting_key = 'isolir_profile'", 
            [req.body.isolir_profile]
        );
        res.json({ success: true, message: 'Profile Isolir diperbarui!' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});
// D. Batch Overdue Suspension (Scan Nunggak)
router.post('/service-suspension/check-overdue', adminAuth, async (req, res) => {
    try {
        console.log("[ADMIN] ?? Executing batch overdue suspension...");
        const result = await serviceSuspension.checkAndSuspendOverdueCustomers();
        res.json({ 
            success: true, 
            suspended: result?.count || 0,
            message: `Operation successful ${result?.count || 0} subscribers suspended.` 
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});
// ROUTE RESTORE MASSAL (Scan Lunas)
router.post('/service-suspension/check-paid', adminAuth, async (req, res) => {
    try {
        console.log("[ADMIN] ?? Eksekusi Restore Massal...");
        const count = await serviceSuspension.checkAndRestorePaidCustomers();
        res.json({ 
            success: true, 
            restored: count,
            message: `Berhasil memulihkan ${count} layanan pelanggan lunas.` 
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});
// E. Restore Pelanggan Manual (Target Spesifik)
router.post('/service-suspension/restore/:username', adminAuth, async (req, res) => {
    try {
        const username = req.params.username;
        
        // Eksekusi via Manager (Sudah termasuk Transaksi Database)
        const customer = await billingManager.restoreManualByUsername(username);
        // Tendang User (Kick) agar speed kembali normal secara instan
        if (typeof kickUser === 'function') kickUser(username); 
        res.json({ success: true, message: `Layanan ${customer.pppoe_username} kembali mengudara!` });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});
// ==========================================
    // Financial ledger and transaction processing
// ==========================================
router.delete('/invoices/:id', adminAuth, async (req, res) => {
    try {
        const invId = req.params.id;
        
        // Serahkan tugas penghancuran ke asisten
        const result = await billingManager.deleteInvoiceById(invId);
        console.log(`[HAPUS] ??? Invoice ${result.number} berhasil dimusnahkan.`);
        
        res.json({ 
            success: true, 
            message: `Invoice ${result.number} berhasil dihapus selamanya!` 
        });
    } catch (e) {
        console.error("? Delete Route Error:", e.message);
        res.status(400).json({ 
            success: false, 
            message: "Gagal memusnahkan invoice: " + e.message 
        });
    }
});
// ==========================================
// API HAPUS CUSTOMER (PASTI BERSIH & SINKRON)
// ==========================================
router.delete('/customers/:id', adminAuth, async (req, res) => {
    const customerId = req.params.id;
    console.log(`=== MEMULAI PROSES HAPUS CUSTOMER ID: ${customerId} ===`);
    
    let conn;
    try {
        conn = await dbPool.getConnection();
        // 1. CEK DATA: Ambil pppoe_username sebelum data dihapus
        const [rows] = await conn.query(
            "SELECT name, pppoe_username FROM customers WHERE id = ?", 
            [customerId]
        );
        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: "Pelanggan tidak ditemukan." });
        }
        const pppoeUser = rows[0].pppoe_username;
        const customerName = rows[0].name;
        // 2. MULAI TRANSAKSI: Biar kalau gagal, data nggak berantakan
        await conn.beginTransaction();
        try {
            // MATIKAN CHECKS: Agar MySQL tidak cerewet soal relasi tabel (Foreign Key)
            await conn.query("SET FOREIGN_KEY_CHECKS = 0");
            // --- A. BERSIHKAN RADIUS (Berdasarkan pppoe_username) ---
            if (pppoeUser) {
                console.log(`Membersihkan data Radius untuk user: ${pppoeUser}`);
                await conn.execute("DELETE FROM radcheck WHERE username = ?", [pppoeUser]);
                await conn.execute("DELETE FROM radusergroup WHERE username = ?", [pppoeUser]);
                await conn.execute("DELETE FROM radreply WHERE username = ?", [pppoeUser]);
                await conn.execute("DELETE FROM radacct WHERE username = ?", [pppoeUser]);
            }
            // --- B. BERSIHKAN BILLING (Berdasarkan customer_id) ---
            // Hapus Payment yang nyangkut di Invoice milik customer ini
            console.log("Membersihkan data Invoice & Payments...");
            await conn.execute(`
                DELETE FROM payments 
                WHERE invoice_id IN (SELECT id FROM invoices WHERE customer_id = ?)
            `, [customerId]);
            
            // Baru hapus Invoices-nya
            await conn.execute("DELETE FROM invoices WHERE customer_id = ?", [customerId]);
            
            // --- C. HAPUS DATA UTAMA (Berdasarkan id) ---
            console.log(`Menghapus data utama pelanggan: ${customerName}`);
            await conn.execute("DELETE FROM customers WHERE id = ?", [customerId]);
            await logActivity(
                req.session?.adminUsername, 
                'CUSTOMER_DELETE', 
                `Hapus Total Pelanggan: ${customerName} | PPPoE: ${pppoeUser || '-'} (ID: ${customerId})`, 
                req
            );
            // HIDUPKAN KEMBALI CHECKS
            await conn.query("SET FOREIGN_KEY_CHECKS = 1");
            
            await conn.commit();
            
            // 3. PUTUS KONEKSI MIKROTIK (Kick)
            if (pppoeUser && typeof kickUser === 'function') {
                try {
                    await kickUser(pppoeUser);
                } catch (kickErr) {
                    console.log("Pesan: Data DB terhapus, tapi gagal kick user dari Mikrotik.");
                }
            }
            res.json({ 
                success: true, 
                message: `Data ${customerName} berhasil dihapus total dari Billing dan Radius.` 
            });
        } catch (innerError) {
            // Jika ada satu saja perintah di atas yang gagal, batalkan semua!
            await conn.rollback();
            await conn.query("SET FOREIGN_KEY_CHECKS = 1");
            throw innerError;
        }
    } catch (e) {
        console.error("CRITICAL DELETE ERROR:", e.message);
        res.status(500).json({ 
            success: false, 
            message: "Sistem Gagal Menghapus: " + e.message 
        });
    } finally {
        if (conn) conn.release();
    }
});
// ==========================================
    // Synchronize subscriber account state
// ==========================================
router.post('/customers/update', adminAuth, async (req, res) => {
    try {
    // RouterOS and RADIUS policy synchronization
        const pelaksana = req.session?.user?.name || req.session?.user?.username || 'admin';
        // ?? LEMPAR NAMA PELAKSANA SEBAGAI PARAMETER KEDUA KE MANAGER
        const result = await billingManager.updateCustomerFullSync(req.body, pelaksana);
        // Kick user secara asinkron agar dapet session baru tanpa nunggu response.
        if (typeof kickUser === 'function') {
            kickUser(result.username);
        }
        res.json({ 
            success: true, 
            message: 'Berhasil! Data Pelanggan & Mikrotik sudah sinkron 100%.' 
        });
    } catch (e) {
        logger.error("Failed to update record:", e.message);
        res.status(500).json({ 
            success: false, 
            message: "Gagal Update: " + e.message 
        });
    }
});
// =============================================================
    // Financial ledger and transaction processing
// =============================================================
router.get('/invoices/:id/print', adminAuth, async (req, res) => {
    try {
        // Minta asisten meracik data lengkap
        const data = await billingManager.getInvoicePrintData(req.params.id);
        if (!data) {
            return res.status(404).send("Invoice ghoib, tidak ditemukan di database!");
        }
        // Tampilkan ke EJS khusus Print
        res.render('admin/billing/invoice-print', { 
            invoice: data.invoice,
            appSettings: data.appSettings,
            layout: false // Penting: Agar header/sidebar dashboard tidak ikut tercetak
        });
    } catch (e) {
        console.error("? Gagal Cetak Route:", e.message);
        res.status(500).send("Gagal memproses cetakan: " + e.message);
    }
});
// ==========================================
    // Financial ledger and transaction processing
// ==========================================
router.get('/invoices/:id', adminAuth, async (req, res) => {
    try {
        const invoiceData = await billingManager.getInvoiceDetails(req.params.id);
        if (!invoiceData) {
            return res.status(404).render('error', { 
                message: "Invoice ghoib, tidak ditemukan!", 
                appSettings: req.appSettings 
            });
        }
        // Tampilkan ke Dashboard Detail
        res.render('admin/billing/invoice-detail', { 
            invoice: invoiceData, 
            settings: req.appSettings || {} 
        });
    } catch (e) {
        console.error("? Error Detail Invoice:", e.message);
        res.status(500).send("Terjadi gangguan radar: " + e.message);
    }
});
// ==========================================
    // Financial ledger and transaction processing
// ==========================================
router.post('/invoices/create', adminAuth, async (req, res) => {
    try {
        console.log(`[ADMIN] Menerbitkan Tagihan Manual untuk Customer ID: ${req.body.customer_id}`);
        // Serahkan tugas pencetakan ke Manager
        const result = await billingManager.createManualInvoice(req.body);
        res.json({
            success: true,
            message: `Operation successful Tagihan ${result.invoice_number} telah diterbitkan.`,
            invoice_number: result.invoice_number
        });
    } catch (e) {
        console.error("? Error Create Invoice Route:", e.message);
    // Synchronize subscriber account state
        res.json({
            success: false,
            message: e.message
        });
    }
});
// ==========================================
// ==========================================
router.get('/template-excel', adminAuth, async (req, res) => {
    try {
        // Minta asisten menyiapkan berkas Excel
        const buffer = await billingManager.generateCustomerImportTemplate();
        // Set Header untuk Download Otomatis
        res.setHeader('Content-Disposition', 'attachment; filename=PulseBill_Customer_Import_Template.xlsx');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        console.log(`[TEMPLATE] ?? Admin mendownload template import pelanggan.`);
        res.send(buffer);
    } catch (e) {
        console.error('[TEMPLATE-ROUTE-ERR]:', e.message);
        res.status(500).send("Gagal membuat template: " + e.message);
    }
});
// =============================================================
// =============================================================
router.post('/import-excel', upload.single('excelFile'), adminAuth, async (req, res) => {
    const fs = require('fs');
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'File Excel tidak ditemukan!' });
        // 1. Baca File
        const workbook = xlsx.readFile(req.file.path);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = xlsx.utils.sheet_to_json(sheet);
        const report = await billingManager.processExcelImport(data);
        // 3. Bersihkan File Sampah di Server
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.json({ 
            success: true, 
            message: `Import Selesai! ${report.sukses} Berhasil, ${report.gagal} Gagal.`, 
            errors: report.logGagal 
        });
    } catch (err) {
        console.error('[IMPORT-ROUTE-ERR]:', err);
        res.status(500).json({ success: false, message: 'Gagal memproses file: ' + err.message });
    }
});
// =============================================================
    // RouterOS and RADIUS policy synchronization
// =============================================================
router.post('/sync-user/:id', adminAuth, async (req, res) => {
    try {
        const customerId = req.params.id;
        // 1. Jalankan Sinkronisasi via Manager
        const result = await billingManager.syncRadiusUser(customerId);
        // 2. Tendang User (Kick) di Background (Anti-Blocking)
        if (typeof kickUser === 'function') {
            kickUser(result.username).catch(err => 
                console.log(`[KICK-OFFLINE] ${result.username} sedang tidak aktif.`)
            );
        }
        if (typeof logActivity === 'function') {
            logActivity(req.user?.id || 0, 'SYNC_RADIUS', `Sync manual: ${result.customerName}`);
        }
        res.json({ 
            success: true, 
            message: `Berhasil! User ${result.username} sudah sinkron 100% ke Radius.` 
        });
    } catch (e) {
        console.error("[SYNC-ROUTE-ERR]:", e.message);
        res.status(500).json({ 
            success: false, 
            message: 'Gagal Sinkron: ' + e.message 
        });
    }
});
// routes/adminBilling.js
router.post('/payments', adminAuth, async (req, res) => {
    // Financial ledger and transaction processing
    res.redirect(307, '/payment/manual-process'); 
});
// =============================================================
// =============================================================
router.post('/void-payment', adminAuth, async (req, res) => {
    try {
        const { id } = req.body;
        if (!id) throw new Error("ID Pembayaran tidak valid!");
        // Serahkan eksekusi pembatalan ke Manager
        await billingManager.voidPayment(id);
        console.log(`[VOID] ? Admin membatalkan pembayaran dengan ID: ${id}`);
        
        res.json({ 
            success: true, 
            message: 'Operation successful Transaksi dibatalkan dan Tagihan kembali Unpaid.' 
        });
    } catch (e) {
        console.error("? VOID ERROR:", e.message);
        res.status(500).json({ 
            success: false, 
            message: 'Gagal membatalkan transaksi: ' + e.message 
        });
    }
});
// =========================================================================
// ?? PROSES TRANSAKSI BEBAS (PEMBUKUAN MANUAL - PLN DLL)
// =========================================================================
router.post('/custom-transaction', adminAuth, async (req, res) => {
    try {
        const sessionData = req.session || {};
        let pelaksana = sessionData.adminName || sessionData.adminUser || sessionData.user?.name || req.user?.name || 'KASIR';
        // Panggil fungsi baru di billingManager
        await billingManager.createCustomTransaction(req.body, pelaksana);
        return res.json({ success: true, message: 'Transaksi berhasil dicatat ke pembukuan!' });
    } catch (error) {
        console.error("?? ERROR CUSTOM TRX:", error.message);
        return res.status(500).json({ success: false, message: 'Error: ' + error.message });
    }
});
// =========================================================================
    // Synchronize subscriber account state
// =========================================================================
router.post('/customers/datatable', adminAuth, async (req, res) => {
    try {
        // RESEPSIONIS: Hanya menangkap data form, lalu lempar ke Koki Utama (Manager)
        const datatableResult = await billingManager.getCustomersDatatable(req.body);
        
        // Kembalikan hasil masakan ke Frontend
        res.json(datatableResult);
    } catch (e) {
        console.error("? Datatable Route Error:", e.message);
        res.status(500).json({ error: "Gagal memuat data: " + e.message });
    }
});
// =========================================================================
    // Financial ledger and transaction processing
// =========================================================================
router.post('/invoices/datatable', adminAuth, async (req, res) => {
    try {
        // 1. Resepsionis menangkap pesanan (Parameter dari DataTables EJS)
        const datatableParams = req.body;
        
        // 2. Serahkan pesanan ke Chef Utama di Dapur (BillingManager)
        const datatableResult = await billingManager.getInvoicesDatatable(datatableParams);
        
        // 3. Hidangkan ke Frontend
        res.json(datatableResult);
    } catch (e) {
        console.error("? Invoice Datatable Route Error:", e.message);
        res.status(500).json({ error: "Gagal memuat data tagihan: " + e.message });
    }
});
// =========================================================================
    // Financial ledger and transaction processing
// =========================================================================
router.post('/payments/datatable', adminAuth, async (req, res) => {
    try {
        // 1. Resepsionis menangkap parameter (termasuk filter tanggal & metode)
        const datatableParams = req.body;
        
        // 2. Serahkan ke Koki Utama di Manager
        const datatableResult = await billingManager.getPaymentsDatatable(datatableParams);
        
        // 3. Kembalikan data yang sudah matang ke Frontend
        res.json(datatableResult);
    } catch (e) {
        console.error("? Payments Datatable Route Error:", e.message);
        res.status(500).json({ error: "Gagal memuat data transaksi: " + e.message });
    }
});
// =====================================================================
// MENU BARU: DAFTAR CUSTOMER NUNGGAK
// =====================================================================
// ?? Hapus kata /billing di sini, cukup /customer-nunggak saja
router.get('/customer-nunggak', adminAuth, async (req, res) => {
    try {
        const dataNunggak = await billingManager.getPelangganNunggak();
        const settings = await billingManager.getSultanAppSettings(); 
        
        // Di res.render tetap pakai folder lengkapnya
        res.render('admin/billing/customerNunggak', {
            title: 'Customer Nunggak',
            page: 'customer-nunggak',
            settings: settings,
            pelanggan: dataNunggak
        });
    } catch (e) {
        console.error('? Gagal muat halaman Customer Nunggak:', e);
        res.status(500).send("Terjadi kesalahan sistem.");
    }
});
module.exports = router;
