const express = require('express');
const router = express.Router();
const { adminAuth, onlyAdmin } = require('./adminAuth'); // Pagar Sultan tetap wajib
const { getSetting } = require('../config/settingsManager');
const userManager = require('../config/adminUserManager'); // ?? INI DIA JALUR SATU PINTUNYA

// [READ] Halaman Daftar User
router.get('/', adminAuth, onlyAdmin, async (req, res) => {
    try {
        // Router menyuruh Manager mengambil data
        const users = await userManager.getAllUsers();
        
        res.render('adminUsers', {
            title: 'Manajemen Hak Akses',
            page: 'users',
            usersList: users,
            user: res.locals.user,
            settings: { 
                company_name: getSetting('company_name', 'PulseBill Networks'),
                logo_filename: getSetting('logo_filename', 'logo.png')
            }
        });
    } catch (err) {
        console.error('Gagal ambil data user:', err);
        res.status(500).send('Database Error');
    }
});

// [CREATE] Tangkap Form Tambah User
router.post('/add', adminAuth, onlyAdmin, async (req, res) => {
    try {
        // Router melempar data form (req.body) ke Manager
        await userManager.addUser(req.body);
        res.redirect('/admin/users');
    } catch (err) {
        console.error('Gagal tambah user:', err);
        res.status(500).send('Gagal Menyimpan Akun');
    }
});

// [UPDATE] Tangkap Form Edit User
router.post('/edit', adminAuth, onlyAdmin, async (req, res) => {
    try {
        await userManager.updateUser(req.body);
        res.redirect('/admin/users');
    } catch (err) {
        console.error('Gagal edit user:', err);
        res.status(500).send('Gagal Update Akun');
    }
});

// [DELETE] Tangkap Perintah Hapus
router.get('/delete/:id', adminAuth, onlyAdmin, async (req, res) => {
    try {
        // Validasi lapis pertama di router
        if (req.params.id == 1) {
            return res.send("<script>alert('SULTAN UTAMA tidak boleh dihapus!'); window.location.href='/admin/users';</script>");
        }
        await userManager.deleteUser(req.params.id);
        res.redirect('/admin/users');
    } catch (err) {
        console.error('Gagal hapus user:', err);
        res.status(500).send('Gagal Hapus Akun');
    }
});

module.exports = router;