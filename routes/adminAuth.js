const express = require('express');
const router = express.Router();
const pool = require('../config/database'); // Pastikan path database Bos benar
const { getSetting } = require('../config/settingsManager');

/**
 * ??? MIDDLEWARE 1: Cek Login Umum
 * Digunakan di semua rute admin agar tidak bisa diakses tanpa login
 */
function adminAuth(req, res, next) {
    if (req.session && req.session.isAdmin) {
        // JURUS SULTAN: Masukkan data user ke res.locals agar EJS bisa baca otomatis
        res.locals.user = {
            username: req.session.adminUser,
            name: req.session.adminName,
            role: req.session.role // 'superadmin' atau 'kasir'
        };
        next();
    } else {
        res.redirect('/admin/login');
    }
}

/**
 * ??? MIDDLEWARE 2: Khusus Raja (Superadmin)
 * Pasang ini di rute NAS, Setting, dan Hapus Data
 */
function onlyAdmin(req, res, next) {
    if (req.session.role === 'superadmin') {
        next();
    } else {
        // Jika Kasir nekat masuk, tendang ke halaman error atau dashboard
        res.status(403).render('error', { 
            message: 'AKSES DITOLAK: Maaf Bos, Kasir dilarang masuk area ini!', 
            error: 'Hak Akses Tidak Mencukupi',
            appSettings: { logo_filename: getSetting('logo_filename', 'logo.png') }
        });
    }
}

// GET: Halaman login
router.get('/login', (req, res) => {
    const settings = { logo_filename: getSetting('logo_filename', 'logo.png') };
    res.render('adminLogin', { error: null, settings: settings });
});

// POST: Proses Login Multi-User
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const settings = { logo_filename: getSetting('logo_filename', 'logo.png') };

        if (!username || !password) {
            return res.status(400).json({ success: false, message: 'Username & Password wajib diisi!' });
        }

        // ?? CARI USER DI DATABASE
        const [rows] = await pool.query("SELECT * FROM admins WHERE username = ?", [username]);

        if (rows.length > 0) {
            const user = rows[0];

            // Verifikasi Password (Sesuai sistem Bos saat ini pakai plain text)
            if (password === user.password) {
                req.session.isAdmin = true;
                req.session.adminUser = user.username;
                req.session.adminName = user.name;
                req.session.role = user.role; // SIMPAN ROLE DI SESSION

                return req.session.save((err) => {
                    if (err) return res.status(500).json({ success: false, message: 'Gagal simpan sesi!' });
                    res.json({ success: true, message: 'Login Berhasil, Selamat Datang!' });
                });
            }
        }

        res.status(401).json({ success: false, message: 'Username atau Password salah!' });

    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ success: false, message: 'Server Gembok Sedang Gangguan!' });
    }
});

router.get('/', (req, res) => {
    if (req.session && req.session.isAdmin) return res.redirect('/admin/dashboard');
    res.redirect('/admin/login');
});

router.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/admin/login'));
});

module.exports = { router, adminAuth, onlyAdmin };