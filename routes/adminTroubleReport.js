const express = require('express');
const router = express.Router();
const { adminAuth } = require('./adminAuth');
const { getSetting } = require('../config/settingsManager');
const { 
  getAllTroubleReports, 
  getTroubleReportById, 
  updateTroubleReportStatus,
  deleteTroubleReport
} = require('../config/troubleReport');
// Middleware admin auth untuk semua route
router.use(adminAuth);
// --- FUNGSI BANTUAN: AGAR MENU SIDEBAR LENGKAP ---
function getFullSettings() {
    return {
        logo_filename: getSetting('logo_filename', 'logo.png'),
        company_name: getSetting('company_name', 'PULSEBILL NETWORKS'),
        
        // --- JURUS PAKSA MUNCUL (FORCE TRUE) ---
        // Kita tidak pakai getSetting, tapi langsung 'true' (boolean)
        // supaya menu PASTI muncul, tidak peduli settingan database.
        enable_billing: true,
        enable_radius: true,
        enable_hotspot: true,
        enable_voucher: true,
        enable_ppp: true,
        enable_olt: true,
        enable_map: true,
        enable_wa: true,
        enable_finance: true,
        enable_log: true,       // Tambahan buat menu Log
        enable_mitra: true      // Tambahan buat menu Mitra
    };
}
// GET: Halaman daftar semua laporan gangguan
router.get('/', (req, res) => {
    const reports = getAllTroubleReports();
    
    const stats = {
        total: reports.length,
        open: reports.filter(r => r.status === 'open').length,
        inProgress: reports.filter(r => r.status === 'in_progress').length,
        resolved: reports.filter(r => r.status === 'resolved').length,
        closed: reports.filter(r => r.status === 'closed').length
    };
  
    // PANGGIL SETTING LENGKAP
    const settings = getFullSettings();
    res.render('admin/trouble-reports', {
        reports,
        stats,
        title: 'Manajemen Laporan Gangguan',
        settings: settings,
        adminUser: req.session.adminUser,
        page: 'trouble'
    });
});
// GET: Halaman detail laporan gangguan
router.get('/detail/:id', (req, res) => {
    const reportId = req.params.id;
    const report = getTroubleReportById(reportId);
    
    if (!report) {
        return res.redirect('/admin/trouble');
    }
    // PANGGIL SETTING LENGKAP
    const settings = getFullSettings();
  
    res.render('admin/trouble-report-detail', {
        report,
        title: `Detail Laporan #${reportId}`,
        settings: settings,
        adminUser: req.session.adminUser,
        page: 'trouble'
    });
});
// POST: Update status laporan gangguan
router.post('/update-status/:id', (req, res) => {
    const reportId = req.params.id;
    const { status, notes, sendNotification } = req.body;
    
    const validStatuses = ['open', 'in_progress', 'resolved', 'closed'];
    if (!validStatuses.includes(status)) {
        return res.status(400).json({ success: false, message: 'Status tidak valid' });
    }
    
    const updatedReport = updateTroubleReportStatus(reportId, status, notes, sendNotification);
    
    if (!updatedReport) {
        return res.status(500).json({ success: false, message: 'Gagal mengupdate status laporan' });
    }
    
    res.json({
        success: true,
        message: 'Status laporan berhasil diupdate',
        report: updatedReport
    });
});
// POST: Tambah catatan pada laporan tanpa mengubah status
router.post('/add-note/:id', (req, res) => {
    const reportId = req.params.id;
    const { notes } = req.body;
    
    const report = getTroubleReportById(reportId);
    
    if (!report) {
        return res.status(404).json({ success: false, message: 'Laporan tidak ditemukan' });
    }
    
    const updatedReport = updateTroubleReportStatus(reportId, report.status, notes);
    
    if (!updatedReport) {
        return res.status(500).json({ success: false, message: 'Gagal menambahkan catatan' });
    }
    
    res.json({
        success: true,
        message: 'Catatan berhasil ditambahkan',
        report: updatedReport
    });
});
// GET: API untuk menghitung tiket yang masih 'open' (Untuk Alarm Dashboard)
router.get('/api/unresolved-count', (req, res) => {
    try {
        const reports = getAllTroubleReports();
        const count = reports.filter(r => r.status === 'open').length;
        res.json({ success: true, count: count });
    } catch (e) {
        res.status(500).json({ success: false, count: 0 });
    }
});
// DELETE: Hapus laporan gangguan permanen
router.delete('/delete/:id', (req, res) => {
    const reportId = req.params.id;
    const isDeleted = deleteTroubleReport(reportId);
    if (isDeleted) {
        res.json({ success: true, message: 'Laporan berhasil dimusnahkan!' });
    } else {
        res.status(404).json({ success: false, message: 'Gagal menghapus (ID tidak ditemukan).' });
    }
});
module.exports = router;
