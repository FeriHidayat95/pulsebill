const { getSetting } = require('./settingsManager');
const billingManager = require('./billing');
const logger = require('./logger');
const fs = require('fs');
const path = require('path');

class WhatsAppNotificationManager {
    constructor() {
        this.sock = null;
        this.templatesFile = path.join(__dirname, '../data/whatsapp-templates.json');
        this.templates = this.loadTemplates() || this.getDefaultTemplates();
    }

    // Default template (hanya dipakai jika file JSON hilang)
    getDefaultTemplates() {
        return {
            invoice_created: { enabled: true, template: "Tagihan Baru: {invoice_number} sebesar Rp {amount}" },
            payment_received: { enabled: true, template: "Terima kasih, pembayaran Rp {amount} diterima." },
            due_date_reminder: { enabled: true, template: "Tagihan Anda jatuh tempo pada {due_date}." },
            service_suspension: { enabled: true, template: "Layanan diisolir. Mohon bayar tagihan." },
            service_restoration: { enabled: true, template: "Layanan aktif kembali." },
            service_disruption: { enabled: true, template: "Gangguan jaringan di area {affected_area}." },
            service_announcement: { enabled: true, template: "{announcement_content}" },
            welcome_message: { enabled: true, template: "Selamat datang {customer_name}." }
        };
    }

    setSock(sockInstance) {
        this.sock = sockInstance;
    }

    // --- HELPER FUNCTIONS (FORMATTER) ---

    formatPhoneNumber(number) {
        if (!number) return '';
        let cleaned = number.toString().replace(/\D/g, '');
        if (cleaned.startsWith('0')) cleaned = '62' + cleaned.slice(1);
        if (!cleaned.startsWith('62')) cleaned = '62' + cleaned;
        return cleaned;
    }

    formatCurrency(amount) {
        if (amount == null) return 'Rp 0';
        return 'Rp ' + parseInt(amount).toLocaleString('id-ID');
    }

    formatDate(date) {
        if (!date) return '-';
        return new Date(date).toLocaleDateString('id-ID', {
            day: 'numeric',
            month: 'long',
            year: 'numeric'
        });
    }

    formatDateTime(date) {
        if (!date) return '-';
        return new Date(date).toLocaleDateString('id-ID', {
            day: 'numeric', month: 'long', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });
    }

    getInvoiceImagePath() {
        const imagePaths = [
            path.resolve(__dirname, '../public/img/tagihan.jpg'),
            path.resolve(__dirname, '../public/img/tagihan.png'), 
            path.resolve(__dirname, '../public/img/invoice.jpg'),
            path.resolve(__dirname, '../public/img/invoice.png'),
            path.resolve(__dirname, '../public/img/logo.png')
        ];
        
        for (const imagePath of imagePaths) {
            if (fs.existsSync(imagePath)) return imagePath;
        }
        return null;
    }

    replaceTemplateVariables(template, data) {
        let message = template || '';
        for (const [key, value] of Object.entries(data)) {
            // Replace semua kemunculan {key}
            message = message.replace(new RegExp(`{${key}}`, 'g'), value || '');
        }
        return message;
    }

    isTemplateEnabled(templateKey) {
        // Cek memory saat ini
        return this.templates[templateKey] && this.templates[templateKey].enabled !== false;
    }

    // Fungsi Wajib: Baca Ulang File JSON (Supaya Sinkron 100%)
    reloadTemplates() {
        const fresh = this.loadTemplates();
        if (fresh) {
            this.templates = fresh;
            return true;
        }
        return false;
    }

    // --- CORE SENDING FUNCTION ---

    async sendNotification(phoneNumber, message, options = {}) {
        try {
            if (!this.sock) {
                console.error('[WA] WhatsApp belum terkoneksi!');
                return { success: false, error: 'WhatsApp not connected' };
            }

            const formattedNumber = this.formatPhoneNumber(phoneNumber);
            const jid = `${formattedNumber}@s.whatsapp.net`;

            // Footer otomatis
            const companyHeader = getSetting('company_header', '');
            const footerInfo = '\n\n' + getSetting('footer_info', 'Powered by Alijaya Digital Network');
            
            // Gabungkan Header (opsional) + Pesan + Footer
            const fullMessage = (companyHeader ? `*${companyHeader}*\n\n` : '') + message + footerInfo;
            
            // Kirim Gambar jika ada
            if (options.imagePath && fs.existsSync(options.imagePath)) {
                await this.sock.sendMessage(jid, { 
                    image: { url: options.imagePath }, 
                    caption: fullMessage 
                });
                return { success: true, withImage: true };
            }

            // Kirim Teks Biasa
            await this.sock.sendMessage(jid, { text: fullMessage });
            return { success: true, withImage: false };

        } catch (error) {
            console.error(`[WA ERROR] Gagal kirim ke ${phoneNumber}:`, error.message);
            return { success: false, error: error.message };
        }
    }
    
    async sendDirectMessage(phoneNumber, message) {
        return await this.sendNotification(phoneNumber, message);
    }
    
    // ?? SUNTIKAN SULTAN: FUNGSI KHUSUS UNTUK KIRIM WA KE TEKNISI (TEKS MURNI) ??
    async sendText(phoneNumber, message) {
        try {
            if (!this.sock) {
                console.log('?? [WA-TEKNISI] Gagal: WhatsApp belum terhubung!');
                return { success: false, error: 'WhatsApp not connected' };
            }

            // Normalisasi nomor ke format JID WhatsApp
            const formattedNumber = this.formatPhoneNumber(phoneNumber);
            const jid = `${formattedNumber}@s.whatsapp.net`;

            // Eksekusi tembak pesan TEKS MURNI
            await this.sock.sendMessage(jid, { text: message });
            
            console.log(`? [WA-TEKNISI] Alarm WA berhasil meluncur ke: ${formattedNumber}`);
            return { success: true };

        } catch (error) {
            console.error(`? [WA-TEKNISI] Gagal kirim ke ${phoneNumber}:`, error.message);
            return { success: false, error: error.message };
        }
    }

    // 1. TAGIHAN BARU (Invoice Created) - VERSI SULTAN SINKRON
    async sendInvoiceCreatedNotification(data) {
        try {
            // Wajib reload agar perubahan di Dashboard Web langsung terasa
            this.reloadTemplates();
            
            if (!this.isTemplateEnabled('invoice_created')) return { success: true, skipped: true };
            
            // MAPPING: Menjodohkan data dari Billing ke variabel di Template JSON
            const templateData = {
                customer_name: data.name || 'Pelanggan',      // Mengisi {customer_name}
                invoice_number: data.invoice_number || '-',  // Mengisi {invoice_number}
                amount: data.amount || '0',                   // Mengisi {amount} - Rp sudah ada di JSON
                due_date: data.due_date || '-',               // Mengisi {due_date}
                package_name: data.package_name || '-',       // Mengisi {package_name}
                package_speed: data.package_speed || '-',     // Mengisi {package_speed}
                notes: data.notes || '-',                     // Mengisi {notes}
                // URL Pembayaran Otomatis
                payment_url: `https://billing.pulsebill.io/payment/select/${data.invoice_number || '-'}/${data.customer_id || ''}`
            };

            // PROSES INJECT: Mengganti {variabel} di template dengan data di atas
            const message = this.replaceTemplateVariables(this.templates.invoice_created.template, templateData);
            
            const imagePath = this.getInvoiceImagePath();
            
            // KIRIM!
            const res = await this.sendNotification(data.phone, message, { imagePath });
            
            if(res.success) {
                console.log(`[WA] ? Invoice Sultan Terkirim ke: ${templateData.customer_name}`);
            }
            return res;

        } catch (error) {
            console.error('[WA] ? Error Invoice Notification:', error.message);
            return { success: false, error: error.message };
        }
    }

    // 2. PENGINGAT JATUH TEMPO (Meticulous Version)
    async sendDueDateReminder(data) {
        try {
            this.reloadTemplates(); 
            if (!this.isTemplateEnabled('due_date_reminder')) return { success: true, skipped: true };

            const phoneNumber = data.phone || data.customer_phone;
            if (!phoneNumber) return { success: false, error: 'No phone number' };

            // --- LOGIKA SINKRONISASI HARI ---
            // Kita pakai data.days_remaining dari Scheduler jika ada. 
            // Jika tidak ada (misal ditrigger manual), baru kita hitung ulang pakai logika Normalisasi.
            let daysRemaining = data.days_remaining;

            if (daysRemaining === undefined && data.due_date) {
                const today = new Date(); today.setHours(0, 0, 0, 0);
                const dueDate = new Date(data.due_date); dueDate.setHours(0, 0, 0, 0);
                daysRemaining = Math.round((dueDate - today) / (1000 * 60 * 60 * 24));
            }

            // --- BAGIAN KERAMAT: PENYESUAIAN PESAN ---
            // Kita bisa sisipkan kata-kata khusus berdasarkan sisa hari agar lebih persuasif
            let peringatanTambahan = "";
            if (daysRemaining <= 1) {
                peringatanTambahan = "\n\n?? *PERINGATAN:* Besok adalah batas terakhir pembayaran sebelum isolir otomatis!";
            } else if (daysRemaining === 3) {
                peringatanTambahan = "\n\nMohon segera selesaikan pembayaran untuk menghindari gangguan layanan.";
            }

            const templateData = {
                customer_name: data.name || data.customer_name || 'Pelanggan',
                invoice_number: data.invoice_number || '-',
                amount: data.amount_formatted || this.formatCurrency(data.amount),
                due_date: this.formatDate(data.due_date),
                days_remaining: daysRemaining,
                package_name: data.package_name || '-',
                package_speed: data.package_speed || '-',
                peringatan_khusus: peringatanTambahan, // Variabel baru buat di template
                payment_url: `https://billing.pulsebill.io/payment/select/${data.invoice_number || '-'}/${data.customer_id || ''}`
            };

            // Ambil template dari Database
            let rawTemplate = this.templates.due_date_reminder.template;
            
            // Tips: Tambahkan variabel {peringatan_khusus} di dashboard template WA Bos 
            // agar pesan H-1 lebih "galak" daripada H-7.
            const message = this.replaceTemplateVariables(rawTemplate, templateData);
            
            const imagePath = this.getInvoiceImagePath();
            
            logger.info(`[WA] Mengirim Reminder H-${daysRemaining} ke ${templateData.customer_name}`);
            return await this.sendNotification(phoneNumber, message, { imagePath });

        } catch (error) {
            console.error('[WA] Error Reminder:', error.message);
            return { success: false, error: error.message };
        }
    }
    
    // 4. ISOLIR LAYANAN (Service Suspension)
    async sendServiceSuspensionNotification(customer, reason) {
        try {
            this.reloadTemplates(); 
            if (!this.isTemplateEnabled('service_suspension')) return { success: true, skipped: true };

            if (!customer.phone) return { success: false, error: 'No phone number' };
            const rawTemplate = this.templates.service_suspension.template;

            const data = {
                customer_name: customer.name,
                name: customer.name,
                amount: this.formatCurrency(customer.amount),
                due_date: this.formatDate(customer.due_date),
                invoice_number: customer.invoice_number || '-',
                reason: reason || 'Tagihan jatuh tempo',
                payment_url: `https://billing.pulsebill.io/payment/select/${customer.invoice_number || '-'}/${customer.id || ''}`
            };

            const message = this.replaceTemplateVariables(rawTemplate, data);
            return await this.sendNotification(customer.phone, message);
        } catch (error) {
            console.error(`[WA ERROR] Isolir:`, error.message);
            return { success: false, error: error.message };
        }
    }

    // 3. PEMBAYARAN DITERIMA (Update: Tambahkan Package Info)
    async sendPaymentReceivedNotification(data) {
        try {
            this.reloadTemplates(); 
            if (!this.isTemplateEnabled('payment_received')) return { success: true, skipped: true };

            const templateData = {
                customer_name: data.name || data.customer_name || 'Pelanggan',
                invoice_number: data.invoice_number || '-',
                amount: data.amount, // Sudah format Rp dari Billing
                payment_method: data.payment_method || 'Online',
                payment_date: data.payment_date || this.formatDate(new Date()),
                reference_number: data.reference_number || '-',
                package_name: data.package_name || '-',
                package_speed: data.package_speed || '-'
            };

            const message = this.replaceTemplateVariables(this.templates.payment_received.template, templateData);
            const imagePath = this.getInvoiceImagePath(); 

            const res = await this.sendNotification(data.phone, message, { imagePath });
            if(res.success) console.log(`[WA] Bukti Bayar terkirim ke ${templateData.customer_name}`);
            return res;

        } catch (error) {
            console.error('[WA] Error Payment Notification:', error.message);
            return { success: false, error: error.message };
        }
    }

    // 5. LAYANAN AKTIF KEMBALI (Update: Pastikan variabel sinkron)
    async sendServiceRestorationNotification(data, reason) {
        try {
            this.reloadTemplates(); 
            if (!this.isTemplateEnabled('service_restoration')) return { success: true, skipped: true };
            
            const phoneNumber = data.phone || data.customer_phone;
            if (!phoneNumber) return { success: false, error: 'No phone number' };

            const templateData = {
                customer_name: data.name || data.customer_name || 'Pelanggan',
                package_name: data.package_name || '-', // Pastikan kuncinya sama dengan di JSON
                package_speed: data.package_speed || '-',
                invoice_number: data.invoice_number || '-',
                reason: reason || 'Pembayaran diterima'
            };

            const message = this.replaceTemplateVariables(this.templates.service_restoration.template, templateData);
            return await this.sendNotification(phoneNumber, message);

        } catch (error) {
            console.error('[WA] Error Restoration:', error.message);
            return { success: false, error: error.message };
        }
    }

    // 5. LAYANAN AKTIF KEMBALI (Hanya bagian ini yang diperbaiki)
    async sendServiceRestorationNotification(data, reason) {
        try {
            this.reloadTemplates(); 
            if (!this.isTemplateEnabled('service_restoration')) return { success: true, skipped: true };
            
            // Pastikan kita punya nomor HP
            const phoneNumber = data.phone || data.customer_phone;
            if (!phoneNumber) return { success: false, error: 'No phone number' };

            // mapping variabel agar template {package_name} dan {package_speed} terisi
            const templateData = {
                customer_name: data.name || data.customer_name,
                package_name: data.package_name || '-',
                package_speed: data.package_speed || '-',
                reason: reason || 'Pembayaran diterima'
            };

            const message = this.replaceTemplateVariables(this.templates.service_restoration.template, templateData);
            return await this.sendNotification(phoneNumber, message);

        } catch (error) {
            console.error('[WA] Error Restoration:', error.message);
            return { success: false, error: error.message };
        }
    }

    // 6. GANGGUAN (Broadcast)
    async sendServiceDisruptionNotification(disruptionData) {
        try {
            this.reloadTemplates(); // <--- WAJIB
            if (!this.isTemplateEnabled('service_disruption')) return { success: true, skipped: true };
            
            const customers = await billingManager.getCustomers();
            const activeCustomers = customers.filter(c => c.status === 'active' && c.phone);

            const data = {
                disruption_type: disruptionData.type || 'Gangguan Jaringan',
                affected_area: disruptionData.area || 'Seluruh Area',
                estimated_resolution: disruptionData.estimatedTime || 'Sedang dalam penanganan',
                support_phone: getSetting('support_phone', '081234567890')
            };

            const message = this.replaceTemplateVariables(this.templates.service_disruption.template, data);
            
            let successCount = 0;
            for (const customer of activeCustomers) {
                const res = await this.sendNotification(customer.phone, message);
                if (res.success) successCount++;
            }
            return { success: true, sent: successCount, total: activeCustomers.length };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // 7. PENGUMUMAN (Broadcast)
    async sendServiceAnnouncement(announcementData) {
        try {
            this.reloadTemplates(); // <--- WAJIB
            if (!this.isTemplateEnabled('service_announcement')) return { success: true, skipped: true };

            const customers = await billingManager.getCustomers();
            const activeCustomers = customers.filter(c => c.status === 'active' && c.phone);

            const data = { announcement_content: announcementData.content || '-' };
            const message = this.replaceTemplateVariables(this.templates.service_announcement.template, data);

            let successCount = 0;
            for (const customer of activeCustomers) {
                const res = await this.sendNotification(customer.phone, message);
                if (res.success) successCount++;
            }
            return { success: true, sent: successCount, total: activeCustomers.length };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
    
    // 8. WELCOME MESSAGE
    async sendWelcomeMessage(customer) {
        try {
            this.reloadTemplates(); // <--- WAJIB
            if (!this.isTemplateEnabled('welcome_message')) return { success: true, skipped: true };
            if (!customer.phone) return { success: false, error: 'No phone number' };

            const data = {
                customer_name: customer.name,
                package_name: customer.package_name || '-',
                package_speed: customer.package_speed || '-',
                wifi_password: customer.wifi_password || '-',
                support_phone: getSetting('support_phone', '081234567890')
            };

            const message = this.replaceTemplateVariables(this.templates.welcome_message.template, data);
            return await this.sendNotification(customer.phone, message);
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // --- TEMPLATE MANAGEMENT ---

    loadTemplates() {
        try {
            if (fs.existsSync(this.templatesFile)) {
                return JSON.parse(fs.readFileSync(this.templatesFile, 'utf8'));
            }
        } catch (error) {
            console.error('Error loading templates:', error);
        }
        return null;
    }

    saveTemplates() {
        try {
            const dataDir = path.dirname(this.templatesFile);
            if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
            fs.writeFileSync(this.templatesFile, JSON.stringify(this.templates, null, 2));
            return true;
        } catch (error) {
            console.error('Error saving templates:', error);
            return false;
        }
    }

    getTemplates() { return this.templates; }

    updateTemplates(templatesData) {
        let updated = 0;
        Object.keys(templatesData).forEach(key => {
            if (this.templates[key]) {
                this.templates[key] = templatesData[key];
                updated++;
            }
        });
        if (updated > 0) this.saveTemplates();
        return updated;
    }

    // Test Notification (Testing dari Web)
    async testNotification(phoneNumber, templateKey, testData = {}) {
        try {
            this.reloadTemplates(); // <--- WAJIB: Biar tes di Web langsung berubah
            
            if (!this.templates[templateKey]) return { success: false, error: 'Template not found' };
            
            // Format data dummy untuk testing agar terlihat real
            if(testData.amount) testData.amount = this.formatCurrency(testData.amount.replace(/\D/g,''));
            if(testData.due_date) testData.due_date = this.formatDate(testData.due_date);

            const message = this.replaceTemplateVariables(this.templates[templateKey].template, testData);
            return await this.sendNotification(phoneNumber, message);
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
}

module.exports = new WhatsAppNotificationManager();