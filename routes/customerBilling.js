const dbPool = require('../config/database');
const express = require('express');
const router = express.Router();
const billingManager = require('../config/billing');
const logger = require('../config/logger');
const { getSetting } = require('../config/settingsManager');

// Middleware untuk memastikan session consistency
const ensureCustomerSession = async (req, res, next) => {
    try {
        // Prioritas 1: cek customer_username
        let username = req.session?.customer_username;
        const phone = req.session?.phone || req.session?.customer_phone;

        // Jika tidak ada customer_username tapi ada phone, ambil dari billing
        if (!username && phone) {
            console.log(`ðŸ”„ [SESSION_FIX] No customer_username but phone exists: ${phone}, fetching from billing`);
            try {
                const customer = await billingManager.getCustomerByPhone(phone);
                if (customer) {
                    req.session.customer_username = customer.username;
                    req.session.customer_phone = phone;
                    username = customer.username;
                    console.log(`âœ… [SESSION_FIX] Set customer_username: ${username} for phone: ${phone}`);
                } else {
                    // Customer tidak ada di billing, buat temporary username
                    req.session.customer_username = `temp_${phone}`;
                    req.session.customer_phone = phone;
                    username = `temp_${phone}`;
                    console.log(`âš ï¸ [SESSION_FIX] Customer not in billing, created temp username: ${username} for phone: ${phone}`);
                }
            } catch (error) {
                console.error(`âŒ [SESSION_FIX] Error getting customer from billing:`, error);
                // Fallback ke temporary username
                req.session.customer_username = `temp_${phone}`;
                req.session.customer_phone = phone;
                username = `temp_${phone}`;
            }
        }

        // Jika masih tidak ada customer_username atau phone, redirect ke login
        if (!username && !phone) {
            console.log(`âŒ [SESSION_FIX] No session found, redirecting to login`);
            return res.redirect('/customer/login');
        }

        next();
    } catch (error) {
        console.error('Error in ensureCustomerSession middleware:', error);
        return res.redirect('/customer/login');
    }
};

// Middleware untuk mendapatkan pengaturan aplikasi
const getAppSettings = (req, res, next) => {
    req.appSettings = {
        companyHeader: getSetting('company_header', 'ISP Monitor'),
        footerInfo: getSetting('footer_info', ''),
        logoFilename: getSetting('logo_filename', 'logo.png'),
        payment_bank_name: getSetting('payment_bank_name', 'BCA'),
        payment_account_number: getSetting('payment_account_number', '1234567890'),
        payment_account_holder: getSetting('payment_account_holder', 'ALIJAYA DIGITAL NETWORK'),
        payment_cash_address: getSetting('payment_cash_address', 'Jl. Contoh No. 123'),
        payment_cash_hours: getSetting('payment_cash_hours', '08:00 - 17:00'),
        contact_whatsapp: getSetting('contact_whatsapp', '081234567890'),
        contact_phone: getSetting('contact_phone', '0812-3456-7890')
    };
    next();
};

// Dashboard Billing Customer - VERSI FIX TOTAL (ANTI BOCOR)
router.get('/dashboard', ensureCustomerSession, getAppSettings, async (req, res) => {
    try {
        const username = req.session.customer_username;
        const phone = req.session.customer_phone || req.session.phone;
        
        if (!username) return res.redirect('/customer/login');

        // 1. Tetap simpan pengecekan temporary customer
        if (username.startsWith('temp_')) {
            return res.render('customer/billing/dashboard', {
                title: 'Dashboard Billing',
                customer: null,
                username: username,
                invoices: [],
                payments: [],
                stats: { totalInvoices: 0, paidInvoices: 0, unpaidInvoices: 0, overdueInvoices: 0, totalPaid: 0, totalUnpaid: 0 },
                appSettings: req.appSettings,
                phone: phone
            });
        }

        // 2. Ambil objek customer dasar
        const customer = await billingManager.getCustomerByUsername(username);
        if (!customer) return res.status(404).render('error', { message: 'Pelanggan tidak ditemukan', appSettings: req.appSettings });

        // =============================================================
        // KODINGAN BOS DIMULAI DISINI (MENIMPA BAGIAN LAMA)
        // =============================================================
        
        // 1. Ambil Invoice yang beneran punya dia (Tembak Langsung ke DB)
        const [invoices] = await dbPool.query(`
            SELECT i.*, p.name as package_name 
            FROM invoices i
            JOIN customers c ON i.customer_id = c.id
            LEFT JOIN packages p ON c.package_id = p.id
            WHERE c.username = ? 
            ORDER BY i.created_at DESC
        `, [username]);

        // 2. Ambil Payment yang beneran punya dia saja
        const [customerPayments] = await dbPool.query(`
            SELECT p.* FROM payments p
            JOIN invoices i ON p.invoice_id = i.id
            JOIN customers c ON i.customer_id = c.id
            WHERE c.username = ?
            ORDER BY p.payment_date DESC
            LIMIT 10
        `, [username]);

        // 3. Hitung Statistik (Data sudah pasti milik user yang login)
        const totalInvoices = invoices.length;
        const paidInvoices = invoices.filter(inv => inv.status === 'paid').length;
        const unpaidInvoices = invoices.filter(inv => inv.status === 'unpaid').length;
        const overdueInvoices = invoices.filter(inv => 
            inv.status === 'unpaid' && new Date(inv.due_date) < new Date()
        ).length;
        
        const totalPaid = invoices
            .filter(inv => inv.status === 'paid')
            .reduce((sum, inv) => sum + parseFloat(inv.amount || 0), 0);
        const totalUnpaid = invoices
            .filter(inv => inv.status === 'unpaid')
            .reduce((sum, inv) => sum + parseFloat(inv.amount || 0), 0);

        // 4. Kirim ke Tampilan
        res.render('customer/billing/dashboard', {
            title: 'Dashboard Billing',
            customer,
            username,
            invoices: invoices.slice(0, 5), 
            payments: customerPayments.slice(0, 5),
            stats: {
                totalInvoices,
                paidInvoices,
                unpaidInvoices,
                overdueInvoices,
                totalPaid,
                totalUnpaid
            },
            appSettings: req.appSettings
        });

        // =============================================================
        // KODINGAN BOS SELESAI DISINI
        // =============================================================

    } catch (error) {
        logger.error('Error loading customer billing dashboard:', error);
        res.status(500).render('error', { 
            message: 'Error loading billing dashboard', 
            error: error.message, 
            appSettings: req.appSettings 
        });
    }
});

// Halaman Tagihan Customer - VERSI ANTI BOCOR
router.get('/invoices', ensureCustomerSession, getAppSettings, async (req, res) => {
    try {
        const username = req.session.customer_username;
        if (!username) return res.redirect('/customer/login');

        // 1. Ambil data customer (termasuk ID-nya)
        const customer = await billingManager.getCustomerByUsername(username);
        if (!customer) {
            return res.status(404).render('error', { 
                message: 'Pelanggan tidak ditemukan', 
                appSettings: req.appSettings 
            });
        }

        // 2. QUERY TOKCER: Tarik invoice cuma buat ID pelanggan ini!
        // Pastikan dbPool sudah di-require di bagian atas file
        const [invoices] = await dbPool.query(`
            SELECT i.*, p.name as package_name 
            FROM invoices i
            LEFT JOIN customers c ON i.customer_id = c.id
            LEFT JOIN packages p ON c.package_id = p.id
            WHERE i.customer_id = ? 
            ORDER BY i.created_at DESC
        `, [customer.id]); // <-- Ini kuncinya, Bos! Cuma buat si ID ini.

        res.render('customer/billing/invoices', {
            title: 'Tagihan Saya',
            customer,
            invoices, // Sekarang isinya cuma punya si pelanggan ini saja
            appSettings: req.appSettings
        });

    } catch (error) {
        logger.error('Error loading customer invoices:', error);
        res.status(500).render('error', { 
            message: 'Error loading invoices', 
            error: error.message, 
            appSettings: req.appSettings 
        });
    }
});

// =====================================================================
// RUTE JEMBATAN: Arahkan pelanggan ke halaman pilih metode pembayaran
// =====================================================================
router.get('/pay-online/:id', ensureCustomerSession, async (req, res) => {
    try {
        const { id } = req.params;
        const invoice = await billingManager.getInvoiceById(id);
        
        if (!invoice) {
            return res.status(404).send('Tagihan tidak ditemukan');
        }

        // PASTIKAN MENUJU KE LINK SELEKSI BANK
        console.log(`?? [REDIRECT] Mengarahkan Invoice ${invoice.invoice_number} ke halaman seleksi bank`);
        res.redirect(`/payment/select/${invoice.invoice_number}`);
        
    } catch (error) {
        console.error('Error redirecting to payment selection:', error);
        res.redirect('/customer/billing/invoices');
    }
});

// Detail Tagihan Customer - VERSI FIX ANTI BLOKIR
router.get('/invoices/:id', ensureCustomerSession, getAppSettings, async (req, res) => {
    try {
        const username = req.session.customer_username;
        if (!username) return res.redirect('/customer/login');

        const { id } = req.params;

        // QUERY SAKTI: Menyediakan semua label nama (Alias) agar tidak melongpong
        const [invoiceRows] = await dbPool.query(`
            SELECT 
                i.*, 
                c.name AS name,
                c.name AS customer_name,
                c.phone AS phone,
                c.phone AS customer_phone,
                c.username AS username,
                c.username AS customer_username,
                p.name AS package_name, 
                p.speed AS speed
            FROM invoices i 
            LEFT JOIN customers c ON i.customer_id = c.id 
            LEFT JOIN packages p ON p.id = COALESCE(i.package_id, c.package_id)
            WHERE i.id = ?
        `, [id]);
        
        const invoice = invoiceRows[0]; 

        if (!invoice) {
            return res.status(404).render('error', {
                message: 'Tagihan tidak ditemukan',
                appSettings: req.appSettings,
                req: req
            });
        }

        // DEBUG: Cek bentrokan username di terminal Bos
        console.log(`?? [SECURITY CHECK] Invoice User: "${invoice.username}" | Session User: "${username}"`);

        // CEK KEAMANAN: Gunakan invoice.username agar cocok dengan login
        if (invoice.username !== username) {
            return res.status(403).render('error', {
                message: 'Akses ditolak',
                error: 'Anda tidak memiliki akses ke tagihan ini.',
                appSettings: req.appSettings,
                req: req
            });
        }

        const payments = await billingManager.getPayments(id);
        
        res.render('customer/billing/invoice-detail', {
            title: `Tagihan ${invoice.invoice_number}`,
            invoice, 
            payments,
            appSettings: req.appSettings
        });

    } catch (error) {
        console.error('? Error fatal detail invoice:', error);
        res.status(500).render('error', { 
            message: 'Error sistem',
            error: error.message,
            appSettings: req.appSettings
        });
    }
});

// Halaman Riwayat Pembayaran - VERSI JEMPUT BOLA (TEMBAK SELECT)
router.get('/payments', ensureCustomerSession, getAppSettings, async (req, res) => {
    try {
        const username = req.session.customer_username;
        const customer = await billingManager.getCustomerByUsername(username);
        const invoices = await billingManager.getInvoices(username);
        const allPayments = await billingManager.getPayments();
        
        // Filter payments milik customer ini
        const customerPayments = allPayments.filter(p => invoices.some(i => i.id === p.invoice_id));

        // 1. CEK TAGIHAN: Cari yang statusnya masih 'unpaid'
        const unpaidInvoices = invoices.filter(inv => inv.status === 'unpaid');

        if (unpaidInvoices.length > 0) {
            // --- TEMBAK KE SELECT.EJS (Mewah Bos) ---
            const invoiceToPay = unpaidInvoices[0];
            invoiceToPay.name = customer.name; // Titip nama buat tampilan di select.ejs

            return res.render('payment/select', {
                title: 'Pilih Metode Pembayaran',
                invoice: invoiceToPay,
                appSettings: req.appSettings
            });
        }

        // 2. JIKA SUDAH LUNAS: Baru tampilkan halaman 'finish' (Ikon Centang Ijo)
        const lastPayment = customerPayments.length > 0 ? customerPayments[0] : null;

        res.render('payment/finish', { 
            title: 'Status Pembayaran',
            customer,
            payments: customerPayments,
            appSettings: req.appSettings,
            status: lastPayment ? 'success' : 'pending',
            transaction_status: lastPayment ? 'settlement' : 'pending',
            order_id: lastPayment ? (lastPayment.reference_number || lastPayment.invoice_id) : 'LUNAS'
        });
        
    } catch (error) {
        console.error('Error loading payments:', error);
        res.status(500).render('payment/error', { 
            message: 'Dapur Pembayaran Macet', 
            error: error.message, 
            appSettings: req.appSettings 
        });
    }
});

// Halaman Profil Customer - PERBAIKAN LASER
router.get('/profile', getAppSettings, async (req, res) => {
    try {
        const username = req.session.customer_username;
        if (!username) return res.redirect('/customer/login');

        const customer = await billingManager.getCustomerByUsername(username);
        
        // 1. FIX: Jangan panggil getPackages() biar gak TypeError. Kita kasih array kosong.
        const packages = []; 

        // Baris 375 di customerBilling.js
        res.render('customer/billing/profile', { // Balikin alamatnya ke sini
            title: 'Profil Saya',
            customer,
            packages: [], 
            appSettings: req.appSettings
        });
    } catch (error) {
        console.error('Error loading profile:', error);
        res.status(500).send("Error di baris profil: " + error.message);
    }
});

// API Routes untuk AJAX
router.get('/api/invoices', async (req, res) => {
    try {
        const username = req.session.customer_username;
        if (!username) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const invoices = await billingManager.getInvoices(username);
        res.json(invoices);
    } catch (error) {
        logger.error('Error getting customer invoices API:', error);
        res.status(500).json({ error: error.message });
    }
});

router.get('/api/payments', async (req, res) => {
    try {
        const username = req.session.customer_username;
        if (!username) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const invoices = await billingManager.getInvoices(username);
        const allPayments = await billingManager.getPayments();
        
        // Filter payments untuk customer ini
        const customerPayments = allPayments.filter(payment => {
            return invoices.some(invoice => invoice.id === payment.invoice_id);
        });

        res.json(customerPayments);
    } catch (error) {
        logger.error('Error getting customer payments API:', error);
        res.status(500).json({ error: error.message });
    }
});

router.get('/api/profile', async (req, res) => {
    try {
        const username = req.session.customer_username;
        if (!username) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const customer = await billingManager.getCustomerByUsername(username);
        if (!customer) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        res.json(customer);
    } catch (error) {
        logger.error('Error getting customer profile API:', error);
        res.status(500).json({ error: error.message });
    }
});

// Download Invoice PDF (placeholder)
router.get('/invoices/:id/download', getAppSettings, async (req, res) => {
    try {
        const username = req.session.customer_username;
        if (!username) {
            return res.redirect('/customer/login');
        }

        const { id } = req.params;
        const invoice = await billingManager.getInvoiceById(id);
        
        if (!invoice || invoice.customer_username !== username) {
            return res.status(404).render('error', {
                message: 'Tagihan tidak ditemukan',
                error: 'Terjadi kesalahan. Silakan coba lagi.',
                appSettings: req.appSettings,
                req: req
            });
        }

        // TODO: Implement PDF generation
        res.json({
            success: true,
            message: 'Fitur download PDF akan segera tersedia',
            invoice_number: invoice.invoice_number
        });
    } catch (error) {
        logger.error('Error downloading invoice:', error);
        res.status(500).json({ error: error.message });
    }
});

// Print Invoice
router.get('/invoices/:id/print', ensureCustomerSession, getAppSettings, async (req, res) => {
    try {
        const username = req.session.customer_username;
        console.log(`ðŸ“„ [PRINT] Print request - username: ${username}, invoice_id: ${req.params.id}`);
        
        if (!username) {
            console.log(`âŒ [PRINT] No customer_username in session`);
            return res.redirect('/customer/login');
        }

        const { id } = req.params;
        const invoice = await billingManager.getInvoiceById(id);
        
        console.log(`ðŸ“„ [PRINT] Invoice found:`, invoice ? {
            id: invoice.id,
            customer_username: invoice.customer_username,
            invoice_number: invoice.invoice_number,
            status: invoice.status
        } : 'null');
        
        if (!invoice || invoice.customer_username !== username) {
            console.log(`âŒ [PRINT] Access denied - invoice.customer_username: ${invoice?.customer_username}, session username: ${username}`);
            return res.status(404).render('error', {
                message: 'Tagihan tidak ditemukan',
                error: 'Terjadi kesalahan. Silakan coba lagi.',
                appSettings: req.appSettings,
                req: req
            });
        }

        const payments = await billingManager.getPayments(id);
        
        res.render('customer/billing/invoice-print', {
            title: `Print Tagihan ${invoice.invoice_number}`,
            invoice,
            payments,
            appSettings: req.appSettings
        });
    } catch (error) {
        logger.error('Error printing invoice:', error);
        res.status(500).render('error', { 
            message: 'Error printing invoice',
            error: error.message,
            appSettings: req.appSettings
        });
    }
});

// Get available payment methods for customer
router.get('/api/payment-methods', async (req, res) => {
    try {
        const username = req.session.customer_username;
        if (!username) {
            return res.status(401).json({
                success: false,
                message: 'Unauthorized'
            });
        }

        const PaymentGatewayManager = require('../config/paymentGateway');
        const paymentGateway = new PaymentGatewayManager();
        
        const methods = await paymentGateway.getAvailablePaymentMethods();
        
        res.json({
            success: true,
            methods: methods
        });
    } catch (error) {
        logger.error('Error getting payment methods:', error);
        res.status(500).json({
            success: false,
            message: 'Error getting payment methods',
            error: error.message
        });
    }
});

// Create online payment for customer
router.post('/create-payment', async (req, res) => {
    try {
        const username = req.session.customer_username;
        if (!username) {
            return res.status(401).json({
                success: false,
                message: 'Unauthorized'
            });
        }

        const { invoice_id, gateway, method } = req.body;
        
        // Process customer payment request
        
        if (!invoice_id) {
            return res.status(400).json({
                success: false,
                message: 'Invoice ID is required'
            });
        }

        // Get invoice and verify ownership
        const invoice = await billingManager.getInvoiceById(invoice_id);
        if (!invoice) {
            return res.status(404).json({
                success: false,
                message: 'Invoice not found'
            });
        }

        if (invoice.customer_username !== username) {
            return res.status(403).json({
                success: false,
                message: 'Access denied'
            });
        }

        if (invoice.status === 'paid') {
            return res.status(400).json({
                success: false,
                message: 'Invoice sudah dibayar'
            });
        }

        // Validate Tripay minimum amount
        if (gateway === 'tripay' && Number(invoice.amount) < 10000) {
            return res.status(400).json({
                success: false,
                message: 'Minimal nominal pembayaran adalah Rp 10.000'
            });
        }

        // Create online payment with specific method for Tripay
        const result = await billingManager.createOnlinePaymentWithMethod(invoice_id, gateway, method);
        
        logger.info(`Customer ${username} created payment for invoice ${invoice_id} using ${gateway}${method && method !== 'all' ? ' - ' + method : ''}`);
        
        res.json({
            success: true,
            message: 'Payment created successfully',
            data: result
        });
    } catch (error) {
        console.error(`[CUSTOMER_PAYMENT] Error:`, error);
        logger.error('Error creating customer payment:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to create payment'
        });
    }
});

// --- RUTE BARU: CEK STATUS PEMBAYARAN MEWAH ---
router.get('/payment-status', ensureCustomerSession, getAppSettings, async (req, res) => {
    try {
        const username = req.session.customer_username;
        const invoices = await billingManager.getInvoices(username);
        const allPayments = await billingManager.getPayments();

        // Cari transaksi terakhir pelanggan ini
        const customerPayments = allPayments.filter(p => invoices.some(inv => inv.id === p.invoice_id));
        const lastTrx = customerPayments.length > 0 ? customerPayments[0] : null;

        // --- TEMBAK LANGSUNG KE POLDER PAYMENT ---
        res.render('payment/finish', { // <--- Ganti ke sini, Bos!
            title: 'Status Pembayaran',
            appSettings: req.appSettings,
            // SUNTIKAN DATA: Supaya "status is not defined" HILANG
            status: lastTrx ? 'success' : 'pending',
            transaction_status: lastTrx ? 'settlement' : 'pending',
            order_id: lastTrx ? (lastTrx.reference_number || lastTrx.invoice_id) : 'TIDAK-DITEMUKAN',
            payments: customerPayments
        });
    } catch (error) {
        res.status(500).send("Error: " + error.message);
    }
});

module.exports = router; 