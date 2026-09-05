const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios'); // Kita pakai axios agar lebih stabil
const { getSetting, getSettingsWithCache } = require('./settingsManager');

class PaymentGatewayManager {

    constructor() {
        this.settings = this.loadSettings();
        this.gateways = {};
        this.initGateways();
    }

    initGateways() {
        // --- 1. AMBIL CONFIG TRIPAY (DARI TRIPAY_CONFIG) ---
        let tripayData = null;
        if (this.settings.tripay_config) {
            try {
                // Bongkar data JSON dari database Bos
                tripayData = typeof this.settings.tripay_config === 'string' 
                    ? JSON.parse(this.settings.tripay_config) : this.settings.tripay_config;
            } catch (e) {
                console.error('[PAYMENT] Gagal bongkar JSON tripay_config');
            }
        }

        // --- 2. INIT TRIPAY (PRIORITAS) ---
        if (tripayData && tripayData.enabled) {
            try {
                this.gateways.tripay = new TripayGateway(tripayData);
                console.log('[PAYMENT_GATEWAY] Tripay berhasil dimuat dari tripay_config');
            } catch (error) {
                console.error('[PAYMENT_GATEWAY] Tripay Error:', error.message);
            }
        }
        
        // --- 3. INIT MIDTRANS & XENDIT (FALLBACK) ---
        const pg = this.settings.payment_gateway || {};
        if (pg.midtrans?.enabled) this.gateways.midtrans = new MidtransGateway(pg.midtrans);
        if (pg.xendit?.enabled) this.gateways.xendit = new XenditGateway(pg.xendit);
        
        this.activeGateway = pg.active || 'tripay';
    }

    loadSettings() {
        try { return getSettingsWithCache(); } catch (error) { return {}; }
    }

    // Support untuk ambil daftar bank di portal
    async getAvailablePaymentMethods() {
        const methods = [];
        if (this.gateways.tripay) {
            try {
                const tripayMethods = await this.gateways.tripay.getAvailablePaymentMethods();
                methods.push(...tripayMethods);
            } catch (error) {
                console.error('[PAYMENT] Gagal tarik bank Tripay:', error.message);
            }
        }
        // Tambahkan gateway lain jika aktif
        return methods;
    }

    async createPayment(invoice, gateway = null) {
        const target = gateway || this.activeGateway;
        if (!this.gateways[target]) throw new Error(`Gateway ${target} belum siap.`);
        return await this.gateways[target].createPayment(invoice);
    }

    async createPaymentWithMethod(invoice, gateway = null, method = null) {
        const target = gateway || this.activeGateway;
        if (target === 'tripay' && this.gateways.tripay) {
            return await this.gateways.tripay.createPaymentWithMethod(invoice, method);
        }
        return this.createPayment(invoice, target);
    }

    async handleWebhook(payload, gateway) {
        if (!this.gateways[gateway]) throw new Error(`Gateway ${gateway} tidak dikenal.`);
        const body = payload?.body || payload;
        const headers = payload?.headers || {};
        return await this.gateways[gateway].handleWebhook(body, headers);
    }
}

// ================================================================
// TRIPAY GATEWAY CLASS
// ================================================================
class TripayGateway {
    constructor(config) {
        this.config = config || {};
        // Paksa ke Production sesuai gambar Dashboard Bos
        this.baseUrl = 'https://tripay.co.id/api'; 
        
        // Bersihkan data kunci
        this.apiKey = (this.config.api_key || '').trim();
        this.privateKey = (this.config.private_key || '').trim();
        this.merchantCode = (this.config.merchant_code || '').trim();

        console.log(`[TRIPAY] Merchant Code: ${this.merchantCode} terpantau standby.`);
    }

    async getAvailablePaymentMethods() {
        try {
            const url = `${this.baseUrl}/merchant/payment-channel`;
            const response = await axios.get(url, {
                headers: { 'Authorization': `Bearer ${this.apiKey}` }
            });

            if (response.data && response.data.success) {
                return response.data.data.map(c => ({
                    gateway: 'tripay',
                    method: c.code,
                    name: c.name,
                    icon: c.code === 'QRIS' ? 'bi-qr-code' : 'bi-bank',
                    color: 'info',
                    active: c.active
                })).filter(c => c.active);
            }
            return [];
        } catch (e) {
            console.error('[TRIPAY_API_ERROR] Gagal ambil bank:', e.response?.data?.message || e.message);
            return [];
        }
    }

    async createPayment(invoice) {
        return this.createPaymentWithMethod(invoice, 'DIRECT');
    }

    async createPaymentWithMethod(invoice, method) {
        const merchantRef = invoice.invoice_number.startsWith('INV-') ? invoice.invoice_number : `INV-${invoice.invoice_number}`;
        const amount = Math.floor(invoice.amount);
        
        // Signature sesuai aturan Tripay: MerchantCode + MerchantRef + Amount
        const signature = crypto.createHmac('sha256', this.privateKey)
            .update(this.merchantCode + merchantRef + amount)
            .digest('hex');

        const payload = {
            'method': method || 'DIRECT',
            'merchant_ref': merchantRef,
            'amount': amount,
            'customer_name': invoice.customer_name,
            'customer_email': invoice.customer_email || 'customer@ali-jaya.net',
            'order_items': [{ 'name': invoice.package_name || 'Internet', 'price': amount, 'quantity': 1 }],
            'signature': signature
        };

        const res = await axios.post(`${this.baseUrl}/transaction/create`, payload, {
            headers: { 'Authorization': `Bearer ${this.apiKey}` }
        });

        if (res.data.success) {
            return {
                payment_url: res.data.data.checkout_url,
                token: res.data.data.reference,
                order_id: merchantRef
            };
        }
        throw new Error(res.data.message);
    }

    async handleWebhook(payload, headers) {
        const sig = headers['x-callback-signature'];
        const verify = crypto.createHmac('sha256', this.privateKey)
            .update(JSON.stringify(payload)).digest('hex');
        if (sig !== verify) throw new Error('Invalid signature');
        return {
            order_id: payload.merchant_ref,
            status: payload.status === 'PAID' ? 'success' : 'failed',
            amount: payload.total_amount
        };
    }
}

// ================================================================
// XENDIT GATEWAY CLASS (TAMBAHAN - AMAN)
// ================================================================
class XenditGateway {
    constructor(config) {
        this.config = config || {};
        // Ambil apiKey dari config (mendukung apiKey atau api_key)
        this.apiKey = (this.config.apiKey || this.config.api_key || '').trim();
        // Xendit butuh auth Basic Base64 (apiKey + titik dua)
        this.tokenBase64 = Buffer.from(this.apiKey + ':').toString('base64');
    }

    async createPayment(invoice) {
        const merchantRef = invoice.invoice_number.startsWith('INV-') ? invoice.invoice_number : `INV-${invoice.invoice_number}`;
        
        // Payload sesuai standar API Xendit Invoices
        const payload = {
            external_id: `XND-${invoice.id || Date.now()}-${merchantRef}`,
            amount: Math.floor(invoice.amount),
            payer_email: invoice.customer_email || 'billing@pulsebill.io',
            description: `Tagihan Internet: ${invoice.package_name || merchantRef}`,
            customer: {
                given_names: invoice.customer_name || 'Pelanggan',
                mobile_number: invoice.customer_phone || ''
            }
        };

        const res = await axios.post('https://api.xendit.co/v2/invoices', payload, {
            headers: { 
                'Authorization': `Basic ${this.tokenBase64}`,
                'Content-Type': 'application/json'
            }
        });

        // Kembalikan URL pembayaran untuk ditangkap oleh rute Admin/Pelanggan
        return {
            gateway: 'xendit',
            payment_url: res.data.invoice_url,
            token: res.data.id,
            order_id: payload.external_id
        };
    }

    async handleWebhook(payload, headers) {
        // =========================================================
        // ??? SOLDER ANTI-HACKER XENDIT (VERIFIKASI TOKEN)
        // =========================================================
        const incomingToken = headers['x-callback-token'];
        
        // Ambil token rahasia Xendit dari config/database Bos
        const secretToken = (this.config.webhook_token || '').trim();

        // 1. TENDANG JIKA TOKEN DI SISTEM BOS KOSONG
        if (!secretToken) {
             throw new Error('Sistem Bos belum di-setting Xendit Webhook Token-nya!');
        }
        
        // 2. TENDANG JIKA HACKER KIRIM TOKEN PALSU
        if (incomingToken !== secretToken) {
             console.error("?? [HACKER DETECTED] Tembakan Webhook Xendit Palsu Diblokir!");
             throw new Error('Invalid Xendit Webhook Token');
        }

        // 3. JIKA ASLI, LANJUTKAN PROSES
        return {
            order_id: payload.external_id,
            status: payload.status === 'PAID' ? 'success' : 'failed',
            amount: payload.amount
        };
    }
}

module.exports = new PaymentGatewayManager();