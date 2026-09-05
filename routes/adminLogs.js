const express = require('express');
const router = express.Router();
const { adminAuth } = require('./adminAuth');
const dbPool = require('../config/database');

// ==========================================
// 1. HALAMAN UTAMA LOG (RENDERING VIEW)
// ==========================================
router.get('/', adminAuth, async (req, res) => {
    // Tambahkan 'title' di sini agar header tidak error
    res.render('adminLogs', { 
        page: 'logs', 
        title: 'Log Kegiatan Sistem' // ?? Bekal untuk admin-header.ejs
    });
});

// ==========================================
// 2. API DATA LOG (PAGINATION)
// ==========================================
router.get('/data', adminAuth, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const search = req.query.search || '';
        const limit = 50;
        const offset = (page - 1) * limit;

        // Query dengan fitur pencarian (Search user_id atau action)
        const [logs] = await dbPool.query(
            `SELECT * FROM activity_logs 
             WHERE user_id LIKE ? OR action LIKE ? OR description LIKE ?
             ORDER BY created_at DESC LIMIT ? OFFSET ?`,
            [`%${search}%`, `%${search}%`, `%${search}%`, limit, offset]
        );
        
        res.json({ success: true, logs: logs });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;