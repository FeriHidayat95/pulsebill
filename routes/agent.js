const express = require('express');
const router = express.Router();
const moment = require('moment');

// PANGGIL SANG MANAGER (SATU PINTU)
const billingManager = require('../config/billing'); 

// ==========================================
// ??? MIDDLEWARE KHUSUS AGEN (SATPAM)
// ==========================================
const agentAuth = (req, res, next) => {
    if (req.session && req.session.isAgent) return next();
    res.redirect('/agent/login');
};

// ==========================================
// 1. HALAMAN LOGIN
// ==========================================
router.get('/agent/login', (req, res) => {
    if (req.session.isAgent) return res.redirect('/agent/dashboard');
    res.render('agent/login', { error: null });
});

// ==========================================
// 1. PROSES LOGIN (SUDAH ANTI-LOGOUT 1 TAHUN)
// ==========================================
router.post('/agent/login', async (req, res) => {
    try {
        const agent = await billingManager.verifyAgentLogin(req.body.username, req.body.password);
        
        // 1. Simpan data agen di session
        req.session.isAgent = true;
        req.session.agentId = agent.id;
        req.session.agentName = agent.name;
        req.session.agentUsername = agent.username;

        // 2. STEMPEL MASA AKTIF 1 TAHUN (Agar awet di HP)
        const satuTahun = 31536000000;
        req.session.cookie.maxAge = satuTahun;
        req.session.cookie.expires = new Date(Date.now() + satuTahun);

        // 3. Paksa simpan ke database sebelum pindah halaman
        req.session.save((err) => {
            if (err) console.error("Session Save Error:", err);
            res.redirect('/agent/dashboard');
        });

    } catch (err) {
        res.render('agent/login', { error: err.message });
    }
});

// ==========================================
// 2. DASHBOARD UTAMA
// ==========================================
router.get('/agent/dashboard', agentAuth, async (req, res) => {
    try {
        const data = await billingManager.getAgentDashboard(req.session.agentId);
        res.render('agent/dashboard', { ...data, moment });
    } catch (err) {
        res.status(500).send("Error System: " + err.message);
    }
});

// ==========================================
// 3. LOGOUT
// ==========================================
router.get('/agent/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/agent/login'));
});

// ==========================================
// 4. BELI VOUCHER
// ==========================================
router.get('/agent/buy-voucher', agentAuth, async (req, res) => {
    try {
        const data = await billingManager.getAgentBuyVoucherData(req.session.agentId);
        res.render('agent/buy_voucher', { ...data, error: null, success: null });
    } catch (err) {
        res.status(500).send("Error: " + err.message);
    }
});

router.post('/agent/buy-voucher', agentAuth, async (req, res) => {
    try {
        const newVouchers = await billingManager.processAgentBuyVoucher(req.session.agentId, req.body.package_id, req.body.qty);
        const data = await billingManager.getAgentBuyVoucherData(req.session.agentId);
        
        res.render('agent/buy_voucher', { 
            ...data, 
            error: null, 
            success: `Berhasil mencetak ${req.body.qty} voucher!`, 
            newVouchers 
        });
    } catch (err) {
        const data = await billingManager.getAgentBuyVoucherData(req.session.agentId);
        res.render('agent/buy_voucher', { ...data, error: err.message, success: null });
    }
});

// ==========================================
// 5. HALAMAN CETAK (PRINT PREVIEW)
// ==========================================
router.post('/agent/print-preview', agentAuth, (req, res) => {
    try {
        const voucherData = JSON.parse(req.body.vouchers);
        res.render('agent/print_template', {
            vouchers: voucherData,
            agent_name: req.body.agent_name,
            profile: voucherData.length > 0 ? voucherData[0].profile : 'Voucher',
            moment
        });
    } catch (e) {
        res.send("Error parsing voucher data");
    }
});

// ==========================================
// 6. MENU ISI SALDO (TOPUP)
// ==========================================
router.get('/agent/topup', agentAuth, async (req, res) => {
    try {
        const data = await billingManager.getAgentTopupData(req.session.agentId);
        res.render('agent/topup', { ...data, moment, msg: req.query.msg });
    } catch (err) {
        res.status(500).send("Error: " + err.message);
    }
});

router.post('/agent/topup/process', agentAuth, async (req, res) => {
    try {
        const checkoutUrl = await billingManager.createAgentTripayTopup(req.session.agentId, req.body.amount, req.body.method, req.get('host'));
        res.redirect(checkoutUrl);
    } catch (err) {
        res.send(`<script>alert("Gagal: ${err.message}"); window.location.href="/agent/topup";</script>`);
    }
});

router.post('/agent/topup-manual', agentAuth, async (req, res) => {
    try {
        await billingManager.createManualTopupRequest(req.session.agentId, req.body.amount, req.body.bank_name, req.body.sender_name);
        res.redirect('/agent/topup?msg=sent');
    } catch (err) {
        res.redirect('/agent/topup?msg=error');
    }
});

// ==========================================
// 7. MENU STOK VOUCHER
// ==========================================
router.get('/agent/my-vouchers', agentAuth, async (req, res) => {
    try {
        const vouchers = await billingManager.getAgentMyVouchers(req.session.agentId);
        res.render('agent/my_vouchers', { vouchers, moment });
    } catch (err) {
        res.status(500).send("Error: " + err.message);
    }
});

// ==========================================
// 8. MENU LAPORAN CUAN (REPORT)
// ==========================================
router.get('/agent/report', agentAuth, async (req, res) => {
    try {
        const stats = await billingManager.getAgentReport(req.session.agentId);
        res.render('agent/report', { stats });
    } catch (err) {
        res.status(500).send("Error: " + err.message);
    }
});

// ==========================================
// 9. MENU RIWAYAT TRANSAKSI (HISTORY)
// ==========================================
router.get('/agent/history', agentAuth, async (req, res) => {
    try {
        const logs = await billingManager.getAgentHistory(req.session.agentId);
        res.render('agent/history', { logs, moment });
    } catch (err) {
        res.status(500).send("Error: " + err.message);
    }
});

// =========================================================================
// 10. WEBHOOK TRIPAY (SATPAM PINTU BELAKANG UNTUK TOPUP OTOMATIS)
// =========================================================================
router.post('/webhook/tripay', async (req, res) => {
    try {
        // Kita oper sepenuhnya ke Jantung Sultan yang sudah kita buat sebelumnya!
        await billingManager.handleTripayWebhookHybrid(req.body);
        return res.json({ success: true });
    } catch (error) {
        console.error("?? WEBHOOK ERROR SERVER:", error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;