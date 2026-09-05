const express = require('express');
const router = express.Router();
const billingManager = global.billingManager;
// Load settings
function loadSettings() {
    try {
        const { getSettingsWithCache } = require('../config/settingsManager');
        return getSettingsWithCache();
    } catch (error) {
        console.error('Error loading settings:', error);
        return {};
    }
}
router.post('/process-selection', async (req, res) => {
    const { invoice_number, method } = req.body;
    
    try {
        // TUGAS: Langsung panggil billingManager.
        // Kita kirim invoice_number, method, dan hostname (untuk return_url)
        const checkoutUrl = await billingManager.processTripaySelection(
            invoice_number, 
            method, 
            req.get('host')
        );
        
        // Tugas Route SELESAI, tinggal arahkan pelanggan ke Tripay
        res.redirect(checkoutUrl);
        
    } catch (e) {
        console.error("PAYMENT PROCESS ERROR:", e.message);
        const errMsg = e.response?.data?.message || e.message;
        res.send("Gagal memproses pembayaran: " + errMsg);
    }
});
// =========================================================================
// EXISTING ROUTES (DO NOT DELETE)
// =========================================================================
// Create online payment (Original API - Versi Satu Pintu)
router.post('/create', async (req, res) => {
    try {
        const { invoice_id, gateway } = req.body;
        
        // Langsung hajar satu fungsi. 
        // Biarkan billingManager yang cek invoice ada atau nggak, dan cek minimal Rp 10.000
        const result = await billingManager.initiateOnlinePayment(invoice_id, gateway);
        
        res.json({ success: true, message: 'Payment created successfully', data: result });
    } catch (error) {
        // Jika ada error (Invoice tidak ketemu atau nominal kurang), billingManager yang teriak
        console.error('Error creating payment:', error.message);
        res.status(400).json({ success: false, message: error.message });
    }
});
// Webhook Midtrans & Xendit (Sudah Bagus, Cukup begini)
router.post('/webhook/midtrans', async (req, res) => {
    try {
        const result = await billingManager.handlePaymentWebhook({ body: req.body, headers: req.headers }, 'midtrans');
        res.status(200).json(result);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});
router.post('/webhook/xendit', async (req, res) => {
    try {
        const result = await billingManager.handlePaymentWebhook({ body: req.body, headers: req.headers }, 'xendit');
        res.status(200).json(result);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});
router.post('/webhook/tripay', async (req, res) => {
    try {
        // Serahkan beban hidup ke billingManager
        const result = await billingManager.handleTripayWebhookHybrid(req.body);
        
        // Kirim respon sukses ke Tripay (Wajib 200 OK)
        res.status(200).json(result);
    } catch (error) {
        console.error('? [TRIPAY WEBHOOK ERROR]:', error.message);
        // Tetap kirim 500 jika gagal total agar Tripay mencoba kirim ulang nanti
        res.status(500).json({ success: false, message: error.message });
    }
});
// =========================================================================
// Mendukung: Tombol Dompet & Tombol Konfirmasi Lunas (Anti-Puyeng!)
// =========================================================================
// routes/payment.js
router.post('/manual-process', async (req, res) => {
    try {
        // ?? SENSOR OTOMATIS: Tangkap ID baik dari 'invoice_id' (Detail) atau 'id' (Dompet)
        const invoiceId = req.body.invoice_id || req.body.id;
        const paymentMethod = req.body.payment_method || 'Cash';
        const notes = req.body.notes || 'Pelunasan via Tombol Dompet';
        if (!invoiceId) {
            return res.status(400).json({ success: false, message: 'Invoice record not found' });
        }
        console.log(`?? [PAYMENT-ENGINE] Memproses Invoice ID: ${invoiceId}`);
        // Panggil Mesin Utama di billing.js
        const result = await billingManager.sultanManualPayment(invoiceId, req, { 
            payment_method: paymentMethod,
            notes: notes
        });
        // ?? JAWABAN WAJIB: Harus ada 'success: true' biar Centang Hijau muncul!
        return res.json({
            success: true,
            message: 'BERHASIL! Laporan Masuk & Radius Aktif.',
            ...result // Lempar semua data dari billing.js
        });
    } catch (error) {
        console.error("? ERROR DOMPET:", error.message);
        return res.status(500).json({ success: false, message: 'Sistem Error: ' + error.message });
    }
});
// Check payment status
router.get('/status/:invoice_id', async (req, res) => {
    try {
        const { invoice_id } = req.params;
        const invoice = await billingManager.getInvoiceById(invoice_id);
        if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });
        const transactions = await billingManager.getPaymentTransactions(invoice_id);
        
        res.json({
            success: true,
            data: {
                invoice: {
                    id: invoice.id,
                    invoice_number: invoice.invoice_number,
                    amount: invoice.amount,
                    status: invoice.status,
                    due_date: invoice.due_date,
                    payment_method: invoice.payment_method,
                    payment_gateway: invoice.payment_gateway,
                    payment_status: invoice.payment_status
                },
                transactions: transactions,
                is_paid: invoice.status === 'paid'
            }
        });
    } catch (error) {
        console.error('Error checking payment status:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});
// Payment callback pages
router.get('/finish', (req, res) => {
    const settings = loadSettings();
    res.render('payment/finish', { title: 'Payment Finish', appSettings: settings, status: req.query.status || 'success', order_id: req.query.order_id, transaction_status: req.query.transaction_status });
});
router.get('/error', (req, res) => {
    const settings = loadSettings();
    res.render('payment/error', { title: 'Payment Error', appSettings: settings, error_message: req.query.error_message || 'Payment failed' });
});
router.get('/pending', (req, res) => {
    const settings = loadSettings();
    res.render('payment/pending', { title: 'Payment Pending', appSettings: settings, order_id: req.query.order_id });
});
// Get payment transactions
router.get('/transactions', async (req, res) => {
    try {
        const { invoice_id } = req.query;
        const transactions = await billingManager.getPaymentTransactions(invoice_id);
        res.json({ success: true, data: transactions });
    } catch (error) {
        console.error('Error getting transactions:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});
// Get gateway status
router.get('/gateway-status', async (req, res) => {
    try {
        const status = await billingManager.getGatewayStatus();
        res.json({ success: true, data: status });
    } catch (error) {
        console.error('Error getting gateway status:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});
router.get('/select/:invNumber/:custId?', async (req, res) => {
    try {
        const { invNumber, custId } = req.params; 
        
        // 1. Ambil Setting (Wajib dikirim ke EJS agar tidak crash saat render header/footer)
        const settings = loadSettings();
        // 2. Panggil billingManager untuk tarik data dari MariaDB
        // Pastikan billingManager.getInvoiceForSelectionPage sudah menggunakan pool.query (MariaDB)
        const invoice = await billingManager.getInvoiceForSelectionPage(invNumber, custId);
        // 3. TAMPILAN JIKA TIDAK KETEMU (Sudah Lunas atau Data Salah)
        if (!invoice) {
            return res.send(`
                <!DOCTYPE html>
                <html lang="id">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Status Tagihan</title>
                    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;700;800&display=swap" rel="stylesheet">
                    <style>
                        body { background-color: #f1f5f9; font-family: 'Plus Jakarta Sans', sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; padding: 20px; }
                        .card { background: white; padding: 50px 30px; border-radius: 30px; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.1); text-align: center; max-width: 420px; width: 100%; border: 1px solid #e2e8f0; }
                        .icon-box { background: #dcfce7; width: 90px; height: 90px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 30px; }
                        .icon-box svg { color: #10b981; width: 45px; height: 45px; }
                        h2 { color: #0f172a; font-size: 28px; font-weight: 800; margin: 0 0 15px 0; letter-spacing: -0.5px; }
                        p { color: #64748b; font-size: 17px; margin: 0 0 35px 0; line-height: 1.6; }
                        .btn { background: #0f172a; color: white; text-decoration: none; padding: 16px 32px; border-radius: 16px; font-weight: 700; font-size: 16px; display: block; transition: all 0.3s ease; }
                        .btn:hover { transform: translateY(-3px); background: #334155; box-shadow: 0 10px 20px rgba(0,0,0,0.1); }
                    </style>
                </head>
                <body>
                    <div class="card">
                        <div class="icon-box">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
                            </svg>
                        </div>
                        <h2>Tagihan Selesai!</h2>
                        <p>Tidak ada tagihan aktif untuk nomor <b>${invNumber}</b>. Jika internet masih terisolir, mohon hubungi Admin.</p>
                        <a href="/" class="btn">Kembali ke Beranda</a>
                    </div>
                </body>
                </html>
            `);
        }
        // 4. JIKA KETEMU, TAMPILKAN HALAMAN PILIH PEMBAYARAN
        // WAJIB: Kirim 'appSettings' karena biasanya select.ejs butuh data logo/header
        res.render('payment/select', { 
            invoice: invoice, 
            appSettings: settings,
            title: 'Pilih Metode Pembayaran'
        });
    } catch (e) {
        console.error("? SELECT ERROR:", e.message);
        res.status(500).send(`
            <div style="padding:20px; font-family:sans-serif; background:#fff1f1; color:#c00; border:1px solid #c00;">
                <h3>Internal Server Error (500)</h3>
                <p><b>Pesan:</b> ${e.message}</p>
                <small>Cek PM2 Log untuk detail teknis.</small>
            </div>
        `);
    }
});
router.get('/print-invoice/:id', async (req, res) => {
    try {
        // 1. Minta data ke Manager
        const data = await billingManager.getInvoicePrintData(req.params.id);
        if (!data) return res.send("Tagihan tidak ditemukan");
        // 2. Render dengan data yang sudah matang
        res.render('admin/billing/print-invoice', { 
            invoice: data.invoice, 
            appSettings: data.appSettings, 
            layout: false 
        });
    } catch (e) { 
        console.error("PRINT ERROR:", e.message);
        res.send("Gagal mencetak: " + e.message); 
    }
});
module.exports = router;
