const express = require('express');
const router = express.Router();
const { getSetting } = require('../config/settingsManager');
const { findDeviceByTag } = require('../config/addWAN');
const { 
    createTroubleReport, 
    getTroubleReportsByPhone, 
    updateTroubleReportStatus,
    getTroubleReportById
} = require('../config/troubleReport');
// ==========================================
// MIDDLEWARE AUTH PELANGGAN (Anti-Penyusup)
// ==========================================
function customerAuth(req, res, next) {
    const phone = req.session?.phone || req.session?.customer_phone;
    const username = req.session?.customer_username;
    
    if (!phone && !username) {
        return res.redirect('/customer/login');
    }
    next();
}
// ==========================================
// 1. GET: HALAMAN FORM LAPORAN
// ==========================================
router.get('/report', customerAuth, async (req, res) => {
    try {
        const phone = req.session.phone;
        const device = await findDeviceByTag(phone);
        const customerName = device?.Tags?.find(tag => tag !== phone) || '';
        const location = device?.Tags?.join(', ') || '';
        
        const categoriesString = getSetting('trouble_report.categories', 'Internet Lambat,Tidak Bisa Browsing,WiFi Tidak Muncul,Koneksi Putus-Putus,Lainnya');
        const categories = categoriesString.split(',').map(cat => cat.trim());
        const previousReports = getTroubleReportsByPhone(phone);
        
        res.render('trouble-report-form', {
            phone, customerName, location, categories, previousReports,
            companyHeader: getSetting('company_header', 'ISP Monitor'),
            footerInfo: getSetting('footer_info', '')
        });
    } catch (err) {
        res.status(500).send("Gagal memuat form. Silakan refresh halaman.");
    }
});
// Alias Pintasan
router.get('/simple', (req, res) => res.redirect('/customer/trouble/report'));
// ==========================================
// 2. GET: HALAMAN DAFTAR LAPORAN (LIST)
// ==========================================
router.get('/list', customerAuth, (req, res) => {
    const phone = req.session.phone;
    const reports = getTroubleReportsByPhone(phone);
    res.render('trouble-report-list', {
        phone,
        reports,
        companyHeader: getSetting('company_header', 'ISP Monitor'),
        footerInfo: getSetting('footer_info', '')
    });
});
// ==========================================
// 3. POST: SUBMIT LAPORAN (DI GABUNG JADI 1 RUTE SAJA!)
// ==========================================
router.post('/report', customerAuth, async (req, res) => {
    try {
        const phone = req.session.phone;
        const { name, location, category, description } = req.body;
        if (!category || !description) {
            return res.status(400).json({ success: false, message: 'Kategori dan deskripsi masalah wajib diisi' });
        }
        // Suruh Manager Bekerja! (Manager sudah kita setting otomatis kirim WA di jawaban sebelumnya)
        const report = createTroubleReport({ 
            phone, 
            name: name || req.session.customerName || 'Pelanggan', 
            location, 
            category, 
            description 
        });
        if (!report) {
            return res.status(500).json({ success: false, message: 'Sistem sedang sibuk, gagal membuat laporan.' });
        }
        // Langsung jawab pelanggan agar loading cepat
        res.json({ success: true, message: 'Laporan gangguan berhasil dibuat', reportId: report.id });
    } catch (err) {
        console.error('[ROUTER-REPORT-FATAL]:', err.message);
        if (!res.headersSent) res.status(500).json({ success: false, message: 'Terjadi kesalahan sistem' });
    }
});
// ==========================================
// 4. GET: HALAMAN DETAIL LAPORAN
// ==========================================
router.get('/detail/:id', customerAuth, (req, res) => {
    const phone = req.session.phone;
    const reportId = req.params.id;
    const report = getTroubleReportById(reportId);
    // Validasi Keamanan: Cegah intip laporan orang lain
    if (!report || report.phone !== phone) {
        return res.redirect('/customer/trouble/list');
    }
    res.render('trouble-report-detail', {
        phone,
        report,
        companyHeader: getSetting('company_header', 'ISP Monitor'),
        footerInfo: getSetting('footer_info', '')
    });
});
// ==========================================
// 5. POST: TAMBAH KOMENTAR (CHAT TIKET)
// ==========================================
router.post('/comment/:id', customerAuth, (req, res) => {
    const phone = req.session.phone;
    const reportId = req.params.id;
    const { comment } = req.body;
    const report = getTroubleReportById(reportId);
    if (!report || report.phone !== phone) {
        return res.status(403).json({ success: false, message: 'Akses ditolak atau laporan ghoib' });
    }
    // Suruh Manager Bekerja!
    const updatedReport = updateTroubleReportStatus(reportId, report.status, `[Pelanggan]: ${comment}`);
    if (!updatedReport) {
        return res.status(500).json({ success: false, message: 'Gagal menambahkan komentar' });
    }
    res.json({ success: true, message: 'Komentar berhasil ditambahkan' });
});
// ==========================================
// 6. POST: TUTUP LAPORAN OLEH PELANGGAN (CLOSE)
// ==========================================
router.post('/close/:id', customerAuth, (req, res) => {
    const phone = req.session.phone;
    const reportId = req.params.id;
    const report = getTroubleReportById(reportId);
    if (!report || report.phone !== phone) {
        return res.status(403).json({ success: false, message: 'Akses ditolak' });
    }
    // Aturan Main: Hanya tiket yang 'resolved' yang bisa di-close
    if (report.status !== 'resolved') {
        return res.status(400).json({ success: false, message: 'Hanya laporan yang sudah selesai yang dapat ditutup' });
    }
    // Suruh Manager Bekerja!
    const updatedReport = updateTroubleReportStatus(reportId, 'closed', 'Laporan ditutup oleh pelanggan');
    res.json({ success: !!updatedReport, message: 'Laporan berhasil ditutup, Terima kasih!' });
});
module.exports = router;
