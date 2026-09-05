const express = require('express');
const router = express.Router();
const billingManager = require('../config/billing');
// =============================================================
// ?? MIDDLEWARE INTERNAL: Ambil Pengaturan (Logo, Nama ISP)
// =============================================================
const getAppSettings = async (req, res, next) => {
    try {
        req.appSettings = await billingManager.getSultanAppSettings();
        next();
    } catch (e) {
        req.appSettings = {}; 
        next();
    }
};
// ==========================================
// 1. HALAMAN UTAMA MANAJEMEN AGEN
// ==========================================
router.get('/admin/agents', getAppSettings, async (req, res) => {
    try {
        const data = await billingManager.getSultanAgentControlData();
        res.render('admin/billing/agent-control', { 
            layout: false, 
            title: 'Manajemen Agen',
            page: 'agents',
            ...data, 
            appSettings: req.appSettings,
            moment: require('moment'),
            msg: req.query.msg,
            detail: req.query.detail
        });
    } catch (e) { 
        console.error("? Halaman Agen Error:", e.message);
        res.status(500).send("Gagal memuat data Agen: " + e.message); 
    }
});
// ==========================================
// 2. KELOLA AGEN (ADD, UPDATE, ACTION)
// ==========================================
router.post('/admin/agent/add', async (req, res) => {
    try {
        await billingManager.createSultanAgent(req.body);
        res.redirect('/admin/agents?msg=success_add');
    } catch (err) {
        res.redirect(`/admin/agents?msg=error&detail=${encodeURIComponent(err.message)}`);
    }
});
router.post('/admin/agent/update', async (req, res) => {
    try {
        await billingManager.updateSultanAgent(req.body.agent_id, req.body);
        res.redirect('/admin/agents?msg=updated');
    } catch (err) { 
        res.redirect(`/admin/agents?msg=error&detail=${encodeURIComponent(err.message)}`);
    }
});
router.post('/admin/agent/action', async (req, res) => {
    try {
        const { agent_id, action } = req.body;
        if (action === 'delete') {
            await billingManager.deleteSultanAgent(agent_id);
        } else {
            await billingManager.updateAgentStatus(agent_id, action);
        }
        res.redirect('/admin/agents?msg=success');
    } catch (err) { 
        res.redirect(`/admin/agents?msg=error&detail=${encodeURIComponent(err.message)}`);
    }
});
// ==========================================
// 3. KELOLA TOPUP (MANUAL, APPROVE, DELETE)
// ==========================================
router.post('/admin/agent/topup-manual', async (req, res) => {
    try {
        await billingManager.manualTopupAgent(req.body.agent_id, req.body.amount);
        res.redirect('/admin/agents?msg=success_topup');
    } catch (err) { 
        res.redirect(`/admin/agents?msg=error&detail=${encodeURIComponent(err.message)}`);
    }
});
router.post('/admin/agent/approve-topup', async (req, res) => {
    try {
        await billingManager.approveSultanTopup(req.body.request_id);
        res.redirect('/admin/agents?msg=approved');
    } catch (err) { 
        res.redirect(`/admin/agents?msg=error&detail=${encodeURIComponent(err.message)}`);
    }
});
router.post('/admin/agent/delete-topup', async (req, res) => {
    try {
        await billingManager.deleteTopupRequest(req.body.request_id);
        res.redirect('/admin/agents?msg=deleted');
    } catch (err) { 
        res.redirect(`/admin/agents?msg=error&detail=${encodeURIComponent(err.message)}`);
    }
});
// ==========================================
// 4. SETTING HARGA PAKET VOUCHER (One Door Style)
// ==========================================
router.post('/admin/agent/package/add', async (req, res) => {
    try {
        // Biarkan billingManager yang mengurus kueri INSERT-nya
        await billingManager.manageAgentPackage('add', req.body);
        res.redirect('/admin/agents?msg=success_pkg_add');
    } catch (err) {
        console.error("? Gagal Simpan Paket:", err.message);
        res.redirect('/admin/agents?msg=error');
    }
});
router.post('/admin/agent/package/update', async (req, res) => {
    try {
        await billingManager.manageAgentPackage('update', req.body);
        res.redirect('/admin/agents?msg=success_pkg');
    } catch (err) {
        res.redirect('/admin/agents?msg=error');
    }
});
router.post('/admin/agent/package/delete', async (req, res) => {
    try {
        await billingManager.manageAgentPackage('delete', req.body);
        res.redirect('/admin/agents?msg=deleted');
    } catch (err) {
        res.redirect('/admin/agents?msg=error');
    }
});
// ==========================================
// 5. KELOLA VOUCHER (DELETE)
// ==========================================
router.post('/admin/agent/voucher/delete', async (req, res) => {
    try {
        await billingManager.deleteSultanVoucher(req.body.voucher_code, req.body.log_id);
        res.redirect('/admin/agents?msg=deleted');
    } catch (err) { 
        res.redirect(`/admin/agents?msg=error&detail=${encodeURIComponent(err.message)}`);
    }
});
router.post('/admin/agent/deduct-balance', async (req, res) => {
    try {
        const { agent_id, amount } = req.body;
        if (!agent_id || !amount) throw new Error("Data tidak lengkap!");
        
        // Panggil fungsi penarik saldo di billing manager
        await billingManager.deductSultanAgentBalance(agent_id, amount);
        res.redirect('/admin/agents?msg=success_deduct');
    } catch (err) {
        console.error("? Gagal Tarik Saldo:", err.message);
        res.redirect(`/admin/agents?msg=error_insufficient_balance`);
    }
});
module.exports = router;
