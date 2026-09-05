const express = require('express');
const router = express.Router();
const db = require('../config/database');
// --- MIDDLEWARE CEK LOGIN KHUSUS TEKNISI ---
const cekLoginTeknisi = (req, res, next) => {
    if (req.session.teknisi) {
        next();
    } else {
        res.redirect('/teknisi/login');
    }
};
// 1. HALAMAN LOGIN
router.get('/login', (req, res) => {
    if (req.session.teknisi) return res.redirect('/teknisi/form');
    res.render('teknisi/login', { error: null });
});
// 2. PROSES LOGIN (SUDAH ANTI-LOGOUT 1 TAHUN)
router.post('/login', async (req, res) => {
    const { phone, password } = req.body;
    try {
        const [rows] = await db.query("SELECT * FROM technicians WHERE phone = ? AND password = ? AND status = 'active'", [phone, password]);
        
        if (rows.length > 0) {
            // 1. Simpan data teknisi di session
            req.session.teknisi = rows[0];
            // 2. STEMPEL MASA AKTIF 1 TAHUN (Anti-Logout saat aplikasi ditutup)
            const satuTahun = 31536000000;
            req.session.cookie.maxAge = satuTahun;
            req.session.cookie.expires = new Date(Date.now() + satuTahun);
            // 3. Paksa simpan ke database (MariaDB) sebelum pindah halaman
            req.session.save((err) => {
                if (err) console.error("Session Save Error:", err);
                res.redirect('/teknisi/form');
            });
        } else {
            res.render('teknisi/login', { error: 'No WA atau Password Salah!' });
        }
    } catch (err) {
        console.error(err);
        res.render('teknisi/login', { error: 'Server Error' });
    }
});
// 3. HALAMAN FORMULIR (DASHBOARD TEKNISI)
router.get('/form', cekLoginTeknisi, async (req, res) => {
    try {
        // AMBIL DAFTAR PAKET DARI RADIUS (Biar Sinkron)
        // Kita ambil unique groupname dari radusergroup atau radgroupcheck
        const [paketList] = await db.query("SELECT * FROM packages WHERE type = 'pppoe' ORDER BY price ASC");
        
        // Ambil riwayat inputan teknisi ini (5 terakhir)
        const [history] = await db.query(`
            SELECT * FROM pending_registrations 
            WHERE technician_id = ? 
            ORDER BY created_at DESC LIMIT 5`, 
            [req.session.teknisi.id]
        );
        res.render('teknisi/form', { 
            teknisi: req.session.teknisi,
            paketList,
            history
        });
    } catch (err) {
        console.error(err);
        res.send("Gagal memuat data paket.");
    }
});
router.post('/submit', cekLoginTeknisi, async (req, res) => {
    // 1. Ambil semua data yang diketik teknisi di HP
    const { 
        customer_name, address, whatsapp_no, 
        pppoe_user, pppoe_pass, package_name,
        odp_data, port_data 
    } = req.body;
    const finalOdp = odp_data || '-';
    const finalPort = port_data || '0';
    try {
        const sql = `
            INSERT INTO pending_registrations 
            (technician_id, customer_name, address, whatsapp_no, pppoe_user, pppoe_pass, package_name, odp_data, port_data, status) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
        `;
        // 4. Eksekusi ke Database
        await db.execute(sql, [
            req.session.teknisi.id,
            customer_name,          
            address,                
            whatsapp_no,            
            pppoe_user,             
            pppoe_pass,             
            package_name,           
            finalOdp,               
            finalPort              
        ]);
        
        // 5. Beri jawaban sukses ke HP teknisi
        res.json({ success: true, message: "Data & Lokasi ODP terkirim ke Admin!" });
    } catch (err) {
        // Jika kueri gagal (misal kolom ODP belum dibuat di DB), catat di terminal
        console.error("? Submit Teknisi Error:", err.message);
        res.json({ success: false, message: "Gagal kirim data: " + err.message });
    }
});
// 5. LOGOUT
router.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/teknisi/login');
});
module.exports = router;
