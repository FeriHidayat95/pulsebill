const dbPool = require('../config/database');

async function logActivity(userId, action, description, req) {
    try {
        let ip = '0.0.0.0';
        let finalUser = userId || 'system';
        let finalType = 'admin'; // Default

        // 1. Deteksi otomatis dari KTP (Session) yang sedang login
        if (req && req.session) {
            ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '0.0.0.0';
            
            if (req.session.admin_username) {
                finalUser = req.session.admin_username;
                finalType = req.session.role || 'kasir'; // Membaca Hak Akses (Kasir/Superadmin)
            } else if (req.session.agentName) {
                finalUser = req.session.agentName;
                finalType = 'agent';
            }
        }

        // 2. Kirim ke Database (Tanpa Hardcoded 'admin')
        await dbPool.query(
            "INSERT INTO activity_logs (user_id, user_type, action, description, ip_address) VALUES (?, ?, ?, ?, ?)",
            [finalUser, finalType, action, description || '-', ip]
        );
    } catch (err) {
        console.error('? Logger Gagal:', err.message);
    }
}

module.exports = { logActivity };