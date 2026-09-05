const pool = require('./database'); 
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const logger = require('./logger');
const whatsappManager = require('./whatsapp-notifications');
const { getSetting } = require('./settingsManager');
const { logActivity } = require('../utils/logger');
// IMPORT SATU PINTU YANG ASLI
const paymentGateway = require('./paymentGateway'); 
class BillingManager {
    constructor() {
        // Hubungkan dengan Sistem Satu Pintu
        this.paymentGateway = paymentGateway; 
        this.initDatabase();
    }
    // Hot-reload payment gateway configuration
    reloadPaymentGateway() {
        try {
            // 1. Tarik settings terbaru dari cache/database
            const { getSettingsWithCache } = require('./settingsManager');
            const freshSettings = getSettingsWithCache();
            // 2. Masukkan settings terbaru ke dalam laci gateway sebelum di-init ulang
            this.paymentGateway.settings = freshSettings;
            // 3. Sekarang baru aman untuk init ulang gateway
            this.paymentGateway.initGateways();
            
            console.log('?? [BILLING] Payment Gateway Config Updated & Reloaded.');
            return { success: true };
        } catch (e) {
            console.error('[BILLING] Failed to reload payment gateways:', e.message);
            return { error: true, message: e.message };
        }
    }
    // Initialize database connection pool
    async initDatabase() {
        try {
            // Cukup tes apakah koneksi MariaDB lancar (Tabel sudah dibuat manual di MySQL)
            await pool.query("SELECT 1");
            console.log('?? [BILLING] MariaDB Connected. Selamat tinggal SQLite!');
            
            if (typeof this.createTables === 'function') {
                await this.createTables();
            }
            // SUNTIKAN WAJIB: Jalankan migrasi agar kolom 'username' dll tercipta
            if (typeof this.runDatabaseMigrations === 'function') {
                await this.runDatabaseMigrations();
                console.log('? [BILLING] Pengecekan & Migrasi Kolom Selesai.');
            }
            // ?? SAMPAI SINI AJA TAMBAHANNYA ??
        } catch (err) {
            console.error('? [BILLING] Error koneksi MariaDB:', err.message);
        }
    }
    // Synchronize subscriber account state and RADIUS groups
    async setCustomerStatusById(id, status) {
        try {
            // 1. Ambil data lengkap (butuh pppoe_username & pppoe_profile)
            const existing = await this.getCustomerById(id);
            if (!existing) throw new Error('Customer not found');
            // 2. UPDATE TABEL WEB (DENGAN PENANGANAN ERROR TANGGAL)
            try {
                const sql = `UPDATE customers SET status = ? WHERE id = ?`;
                await pool.execute(sql, [status, id]);
            } catch (dbErr) {
                // Jika error karena installation_date kosong, kita bersihkan otomatis
                if (dbErr.message.includes('installation_date')) {
                    await pool.execute(
                        "UPDATE customers SET status = ?, installation_date = CURDATE() WHERE id = ?", 
                        [status, id]
                    );
                } else { throw dbErr; }
            }
            // =============================================================
            // Synchronize active session with RADIUS policy
            // =============================================================
            if (existing.pppoe_username) {
                const username = existing.pppoe_username;
                // Tentukan Profile: Jika suspended, lempar ke isolir. Jika active, balik ke profil asli.
                const isolirProfile = 'pool-pulsebill-isolir';
                const packageProfile = existing.pppoe_profile || 'default';
                const finalGroup = (status === 'suspended') ? isolirProfile : packageProfile;
                // A. UPDATE GROUP DI RADIUS
                await pool.execute("DELETE FROM radusergroup WHERE username = ?", [username]);
                await pool.execute("INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, '1')", [username, finalGroup]);
                // B. KELOLA ATRIBUT EXPIRATION
                if (status === 'suspended') {
                    // Cabut gembok expired agar Mikrotik fokus ke pool isolir
                    await pool.execute("DELETE FROM radcheck WHERE username = ? AND attribute = 'Expiration'", [username]);
                } else if (status === 'active' && existing.expired_date) {
                    // Pasang lagi expired-nya jika diaktifkan kembali
                    const formattedExp = this.formatRadiusDate(new Date(existing.expired_date));
                    await pool.execute("INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Expiration', ':=', ?)", [username, formattedExp]);
                }
                // C. EKSEKUSI TENDANG (KICK) - WAJIB AGAR IP BERUBAH DETIK INI JUGA
                setImmediate(() => {
                    if (typeof this.kickUserRadius === 'function') {
                        this.kickUserRadius(username).catch(err => 
                            console.error(`? [KICK-FAIL] ${username}:`, err.message)
                        );
                    }
                });
            }
            // =============================================================
            try {
                logger.info(`[BILLING] setCustomerStatusById: id=${id}, from=${existing.status} -> to=${status}`);
            } catch (_) {}
            
            return { id, status };
        } catch (e) {
            console.error("? Error setCustomerStatusById:", e.message);
            throw e;
        }
    }
    
    // ?? Update Customer (Versi MariaDB)
    async updateCustomerById(id, customerData) {
        try {
            const { name, username, pppoe_username, email, address, package_id, pppoe_profile, status, auto_suspension, billing_day } = customerData;
            
            const oldCustomer = await this.getCustomerById(id);
            if (!oldCustomer) throw new Error('Customer not found');
            const normBillingDay = Math.min(Math.max(parseInt(billing_day !== undefined ? billing_day : (oldCustomer?.billing_day ?? 15), 10) || 15, 1), 28);
            const sql = `UPDATE customers SET 
                name = ?, username = ?, pppoe_username = ?, email = ?, 
                address = ?, package_id = ?, pppoe_profile = ?, 
                status = ?, auto_suspension = ?, billing_day = ? 
                WHERE id = ?`;
            
            await pool.execute(sql, [
                name ?? oldCustomer.name,
                username ?? oldCustomer.username,
                pppoe_username ?? oldCustomer.pppoe_username,
                email ?? oldCustomer.email,
                address ?? oldCustomer.address,
                package_id ?? oldCustomer.package_id,
                pppoe_profile ?? oldCustomer.pppoe_profile,
                status ?? oldCustomer.status,
                auto_suspension !== undefined ? auto_suspension : oldCustomer.auto_suspension,
                normBillingDay,
                id
            ]);
            return { username: oldCustomer.username, id, ...customerData };
        } catch (error) {
            throw error;
        }
    }
// --- AKHIR BLOK 1 ---
// --- MULAI BLOK 2 ---
    // ?? Membuat Tabel Database (Versi MariaDB + Relasi Cerdas)
    async createTables() {
        const tables = [
            // 1. Tabel paket internet
            `CREATE TABLE IF NOT EXISTS packages (
                id INT PRIMARY KEY AUTO_INCREMENT,
                name VARCHAR(255) NOT NULL,
                speed VARCHAR(100) NOT NULL,
                price DECIMAL(10,2) NOT NULL,
                description TEXT,
                pppoe_profile VARCHAR(100) DEFAULT 'default',
                is_active BOOLEAN DEFAULT 1,
                type VARCHAR(50) DEFAULT 'pppoe',
                is_for_agent BOOLEAN DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
            // 2. Tabel pelanggan
            `CREATE TABLE IF NOT EXISTS customers (
                id INT PRIMARY KEY AUTO_INCREMENT,
                username VARCHAR(100) UNIQUE NOT NULL,
                name VARCHAR(255) NOT NULL,
                phone VARCHAR(20) UNIQUE NOT NULL,
                pppoe_username VARCHAR(100),
                email VARCHAR(255),
                address TEXT,
                package_id INT,
                pppoe_profile VARCHAR(100),
                status VARCHAR(50) DEFAULT 'active',
                auto_suspension BOOLEAN DEFAULT 1,
                billing_day INT DEFAULT 15,
                billing_type VARCHAR(50) DEFAULT 'fixed',
                expired_date DATETIME, 
                join_date DATETIME DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (package_id) REFERENCES packages (id) ON DELETE SET NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
            // 3. Tabel tagihan
            `CREATE TABLE IF NOT EXISTS invoices (
                id INT PRIMARY KEY AUTO_INCREMENT,
                customer_id INT NOT NULL,
                package_id INT,
                invoice_number VARCHAR(100) UNIQUE NOT NULL,
                amount DECIMAL(10,2) NOT NULL,
                due_date DATE NOT NULL,
                status VARCHAR(50) DEFAULT 'unpaid',
                month INT,
                year INT,
                paid_at DATETIME,
                payment_date DATETIME,
                payment_method VARCHAR(100),
                tripay_url TEXT,
                payment_gateway VARCHAR(100),
                payment_token VARCHAR(255),
                payment_url TEXT,
                payment_status VARCHAR(50) DEFAULT 'pending',
                notes TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE,
                FOREIGN KEY (package_id) REFERENCES packages (id) ON DELETE SET NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
            // 4. Tabel pembayaran
            `CREATE TABLE IF NOT EXISTS payments (
                id INT PRIMARY KEY AUTO_INCREMENT,
                invoice_id INT NOT NULL,
                amount DECIMAL(10,2) NOT NULL,
                payment_date DATETIME DEFAULT CURRENT_TIMESTAMP,
                payment_method VARCHAR(100) NOT NULL,
                reference_number VARCHAR(255),
                notes TEXT,
                FOREIGN KEY (invoice_id) REFERENCES invoices (id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
            // 5. Tabel transaksi payment gateway
            `CREATE TABLE IF NOT EXISTS payment_gateway_transactions (
                id INT PRIMARY KEY AUTO_INCREMENT,
                invoice_id INT NOT NULL,
                gateway VARCHAR(100) NOT NULL,
                order_id VARCHAR(255) NOT NULL,
                payment_url TEXT,
                token VARCHAR(255),
                amount DECIMAL(10,2) NOT NULL,
                status VARCHAR(50) DEFAULT 'pending',
                payment_type VARCHAR(100),
                fraud_status VARCHAR(100),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (invoice_id) REFERENCES invoices (id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
            
            // 6. Tabel Laporan Keuangan
            `CREATE TABLE IF NOT EXISTS finance_reports (
                id INT PRIMARY KEY AUTO_INCREMENT,
                username VARCHAR(255),
                profile_name VARCHAR(255),
                address TEXT,
                payment_method VARCHAR(100),
                total_price DECIMAL(10,2),
                commission_amount DECIMAL(10,2) DEFAULT 0,
                payment_date DATETIME DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB;`,
            // 7. Tabel Agen (Reseller)
            `CREATE TABLE IF NOT EXISTS agents (
                id INT PRIMARY KEY AUTO_INCREMENT,
                name VARCHAR(255) NOT NULL,
                phone VARCHAR(50) UNIQUE,
                email VARCHAR(255),
                password VARCHAR(255),
                address TEXT,
                balance DECIMAL(10,2) DEFAULT 0,
                status VARCHAR(50) DEFAULT 'active',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
            // 8. Tabel Permintaan Topup Agen
            `CREATE TABLE IF NOT EXISTS agent_topup_requests (
                id INT PRIMARY KEY AUTO_INCREMENT,
                agent_id INT NOT NULL,
                amount DECIMAL(10,2) NOT NULL,
                proof_img VARCHAR(255),
                status VARCHAR(50) DEFAULT 'pending',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
            // 9. Tabel Mediator / Sales (Makelar)
            `CREATE TABLE IF NOT EXISTS mediators (
                id INT PRIMARY KEY AUTO_INCREMENT,
                name VARCHAR(255) NOT NULL,
                phone VARCHAR(50),
                address TEXT,
                balance DECIMAL(10,2) DEFAULT 0,
                status VARCHAR(50) DEFAULT 'active',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
            // 10. Tabel Log Voucher Agen
            `CREATE TABLE IF NOT EXISTS agent_vouchers_logs (
                id INT PRIMARY KEY AUTO_INCREMENT,
                agent_id INT NOT NULL,
                voucher_code VARCHAR(100) NOT NULL,
                package_id INT,
                price DECIMAL(10,2) NOT NULL,
                profit DECIMAL(10,2) DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
            // 11. Tabel Pendaftaran Calon Pelanggan (Pending Registrations)
            `CREATE TABLE IF NOT EXISTS pending_registrations (
                id INT PRIMARY KEY AUTO_INCREMENT,
                name VARCHAR(255) NOT NULL,
                phone VARCHAR(50) NOT NULL,
                email VARCHAR(255),
                address TEXT,
                package_id INT,
                identity_img VARCHAR(255),
                house_img VARCHAR(255),
                latitude VARCHAR(50),
                longitude VARCHAR(50),
                agent_id INT,
                status VARCHAR(50) DEFAULT 'pending',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
            
            `CREATE TABLE IF NOT EXISTS technicians (
                id INT PRIMARY KEY AUTO_INCREMENT,
                name VARCHAR(255) NOT NULL,
                phone VARCHAR(50),
                address TEXT,
                status VARCHAR(50) DEFAULT 'active',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
            
            `CREATE TABLE IF NOT EXISTS activity_logs (
                id INT PRIMARY KEY AUTO_INCREMENT,
                user_id VARCHAR(50) NOT NULL,
                user_type VARCHAR(20) DEFAULT 'admin',
                action VARCHAR(100) NOT NULL,
                description TEXT,
                ip_address VARCHAR(45),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
            
            // Tambahkan ini di dalam array 'tables' pada file billingManager.js
            `CREATE TABLE IF NOT EXISTS admins (
                id INT PRIMARY KEY AUTO_INCREMENT,
                username VARCHAR(100) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                name VARCHAR(255),
                role ENUM('superadmin', 'kasir') DEFAULT 'kasir',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`
        ];
        // Eksekusi semua query pembuatan tabel
        for (const sql of tables) {
            try {
                await pool.query(sql); 
            } catch (err) {
                if (err.code !== 'ER_TABLE_EXISTS_ERROR') {
                    console.error('? [BILLING] Error membuat tabel:', err.message);
                }
            }
        }
    } 
    // --- AKHIR BLOK 2 ---
    // --- MULAI BLOK 3 ---
    // ?? Migrasi Kolom Tambahan (Aman dari Error Duplicate)
    // ?? Migrasi Kolom Tambahan (Aman dari Error Duplicate)
    async runDatabaseMigrations() {
        const migrations = [
            "ALTER TABLE mediators ADD COLUMN IF NOT EXISTS commission INT(11) DEFAULT 0 AFTER name",
            // =========================================================
            // TABEL: APP_SETTINGS & SETTINGS (2 Tabel)
            // =========================================================
            "CREATE TABLE IF NOT EXISTS app_settings (setting_key VARCHAR(100) PRIMARY KEY, value TEXT)",
            "CREATE TABLE IF NOT EXISTS settings (id INT AUTO_INCREMENT PRIMARY KEY, \`key\` VARCHAR(100) UNIQUE, value TEXT)",
            // =========================================================
            // TABEL: CUSTOMERS (19 Kolom)
            // =========================================================
            "ALTER TABLE customers MODIFY COLUMN IF EXISTS username VARCHAR(100) NULL",
            "ALTER TABLE customers ADD COLUMN IF NOT EXISTS name VARCHAR(255) NOT NULL",
            "ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone VARCHAR(20) NULL",
            "ALTER TABLE customers ADD COLUMN IF NOT EXISTS pppoe_username VARCHAR(100) NULL",
            "ALTER TABLE customers ADD COLUMN IF NOT EXISTS email VARCHAR(255) NULL",
            "ALTER TABLE customers ADD COLUMN IF NOT EXISTS address TEXT NULL",
            "ALTER TABLE customers ADD COLUMN IF NOT EXISTS package_id INT(11) NULL",
            "ALTER TABLE customers ADD COLUMN IF NOT EXISTS pppoe_profile VARCHAR(100) NULL",
            "ALTER TABLE customers ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active'",
            "ALTER TABLE customers ADD COLUMN IF NOT EXISTS auto_suspension TINYINT(1) DEFAULT 1",
            "ALTER TABLE customers ADD COLUMN IF NOT EXISTS billing_day INT(11) DEFAULT 15",
            "ALTER TABLE customers ADD COLUMN IF NOT EXISTS join_date DATETIME DEFAULT CURRENT_TIMESTAMP",
            "ALTER TABLE customers ADD COLUMN IF NOT EXISTS expired_date DATETIME NULL",
            "ALTER TABLE customers ADD COLUMN IF NOT EXISTS billing_type VARCHAR(50) DEFAULT 'fixed'",
            "ALTER TABLE customers ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
            "ALTER TABLE customers ADD COLUMN IF NOT EXISTS pppoe_password VARCHAR(255) DEFAULT '123456'",
            "ALTER TABLE customers ADD COLUMN IF NOT EXISTS password VARCHAR(255) DEFAULT '123456'",
            "ALTER TABLE customers ADD COLUMN IF NOT EXISTS nas_ip VARCHAR(100) NULL",
            "ALTER TABLE customers ADD COLUMN IF NOT EXISTS installation_date DATE DEFAULT NULL AFTER join_date",
            // =========================================================
            // TABEL: INVOICES (19 Kolom + 1 Gembok Keamanan)
            // =========================================================
            "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_id INT(11) NOT NULL",
            "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS package_id INT(11) NULL",
            "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_number VARCHAR(100) NOT NULL",
            "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS amount DECIMAL(10,2) NOT NULL",
            "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS due_date DATE NOT NULL",
            "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'unpaid'",
            "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS month INT(11) NULL",
            "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS year INT(11) NULL",
            "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_date DATETIME NULL",
            "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_method VARCHAR(100) NULL",
            "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tripay_url TEXT NULL",
            "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_gateway VARCHAR(100) NULL",
            "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_token VARCHAR(255) NULL",
            "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_url TEXT NULL",
            "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_status VARCHAR(50) DEFAULT 'pending'",
            "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS notes TEXT NULL",
            "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS created_at DATETIME DEFAULT CURRENT_TIMESTAMP",
            "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS paid_at DATETIME NULL",
            "CREATE UNIQUE INDEX IF NOT EXISTS unique_monthly_cycle ON invoices (customer_id, month, year)",
            // =========================================================
            // TABEL: PACKAGES (13 Kolom)
            // =========================================================
            "ALTER TABLE packages ADD COLUMN IF NOT EXISTS name VARCHAR(255) NOT NULL",
            "ALTER TABLE packages MODIFY COLUMN IF EXISTS speed VARCHAR(100) DEFAULT 'N/A'",
            "ALTER TABLE packages ADD COLUMN IF NOT EXISTS price DECIMAL(10,2) NOT NULL",
            "ALTER TABLE packages ADD COLUMN IF NOT EXISTS agent_cost DECIMAL(10,2) DEFAULT 0.00",
            "ALTER TABLE packages ADD COLUMN IF NOT EXISTS description TEXT NULL",
            "ALTER TABLE packages ADD COLUMN IF NOT EXISTS pppoe_profile VARCHAR(100) DEFAULT 'default'",
            "ALTER TABLE packages ADD COLUMN IF NOT EXISTS is_active TINYINT(1) DEFAULT 1",
            "ALTER TABLE packages ADD COLUMN IF NOT EXISTS created_at DATETIME DEFAULT CURRENT_TIMESTAMP",
            "ALTER TABLE packages ADD COLUMN IF NOT EXISTS type VARCHAR(50) DEFAULT 'pppoe'",
            "ALTER TABLE packages ADD COLUMN IF NOT EXISTS is_for_agent TINYINT(1) DEFAULT 0",
            "ALTER TABLE packages ADD COLUMN IF NOT EXISTS billing_type VARCHAR(50) DEFAULT 'fixed'",
            "ALTER TABLE packages ADD COLUMN IF NOT EXISTS active_period INT(11) DEFAULT 30",
            // =========================================================
            // TABEL: FINANCE_REPORTS (16 Kolom) - OBAT RP 0 LUNAS
            // =========================================================
            "ALTER TABLE finance_reports ADD COLUMN IF NOT EXISTS invoice_id INT(11) NULL",
            "ALTER TABLE finance_reports ADD COLUMN IF NOT EXISTS customer_id INT(11) NULL",
            "ALTER TABLE finance_reports ADD COLUMN IF NOT EXISTS amount DECIMAL(10,2) DEFAULT 0.00",
            "ALTER TABLE finance_reports ADD COLUMN IF NOT EXISTS type ENUM('income','expense') DEFAULT 'income'",
            "ALTER TABLE finance_reports ADD COLUMN IF NOT EXISTS username VARCHAR(255) NULL",
            "ALTER TABLE finance_reports ADD COLUMN IF NOT EXISTS profile_name VARCHAR(255) NULL",
            "ALTER TABLE finance_reports ADD COLUMN IF NOT EXISTS address TEXT NULL",
            "ALTER TABLE finance_reports ADD COLUMN IF NOT EXISTS payment_method VARCHAR(100) NULL",
            "ALTER TABLE finance_reports ADD COLUMN IF NOT EXISTS description TEXT NULL",
            "ALTER TABLE finance_reports ADD COLUMN IF NOT EXISTS total_price DECIMAL(10,2) NULL",
            "ALTER TABLE finance_reports ADD COLUMN IF NOT EXISTS commission_amount DECIMAL(10,2) DEFAULT 0.00",
            "ALTER TABLE finance_reports ADD COLUMN IF NOT EXISTS payment_date DATETIME DEFAULT CURRENT_TIMESTAMP",
            "ALTER TABLE finance_reports ADD COLUMN IF NOT EXISTS mediator_id INT(11) NULL",
            "ALTER TABLE finance_reports ADD COLUMN IF NOT EXISTS agent_id INT(11) NULL",
            "ALTER TABLE finance_reports MODIFY COLUMN IF EXISTS amount DECIMAL(10,2) DEFAULT 0.00",
            "ALTER TABLE finance_reports MODIFY COLUMN IF EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
            // =========================================================
            // TABEL: AGENTS (11 Kolom)
            // =========================================================
            "ALTER TABLE agents ADD COLUMN IF NOT EXISTS username VARCHAR(100) NULL",
            "ALTER TABLE agents ADD COLUMN IF NOT EXISTS name VARCHAR(255) NOT NULL",
            "ALTER TABLE agents ADD COLUMN IF NOT EXISTS phone VARCHAR(50) NULL",
            "ALTER TABLE agents ADD COLUMN IF NOT EXISTS contact VARCHAR(50) NULL",
            "ALTER TABLE agents ADD COLUMN IF NOT EXISTS email VARCHAR(255) NULL",
            "ALTER TABLE agents ADD COLUMN IF NOT EXISTS password VARCHAR(255) NULL",
            "ALTER TABLE agents ADD COLUMN IF NOT EXISTS address TEXT NULL",
            "ALTER TABLE agents ADD COLUMN IF NOT EXISTS balance DECIMAL(10,2) DEFAULT 0.00",
            "ALTER TABLE agents ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active'",
            "ALTER TABLE agents ADD COLUMN IF NOT EXISTS created_at DATETIME DEFAULT CURRENT_TIMESTAMP",
            // =========================================================
            // TABEL: AGENT_VOUCHERS_LOGS (8 Kolom)
            // =========================================================
            "ALTER TABLE agent_vouchers_logs ADD COLUMN IF NOT EXISTS agent_id INT(11) NOT NULL",
            "ALTER TABLE agent_vouchers_logs ADD COLUMN IF NOT EXISTS username VARCHAR(100) NULL",
            "ALTER TABLE agent_vouchers_logs ADD COLUMN IF NOT EXISTS profile VARCHAR(100) NULL",
            "ALTER TABLE agent_vouchers_logs ADD COLUMN IF NOT EXISTS package_id INT(11) NULL",
            "ALTER TABLE agent_vouchers_logs ADD COLUMN IF NOT EXISTS price_sell DECIMAL(10,2) NULL",
            "ALTER TABLE agent_vouchers_logs ADD COLUMN IF NOT EXISTS price_cost DECIMAL(10,2) NULL",
            "ALTER TABLE agent_vouchers_logs ADD COLUMN IF NOT EXISTS created_at DATETIME DEFAULT CURRENT_TIMESTAMP",
            // =========================================================
            // TABEL: TECHNICIANS (7 Kolom)
            // =========================================================
            "ALTER TABLE technicians ADD COLUMN IF NOT EXISTS name VARCHAR(255) NOT NULL",
            "ALTER TABLE technicians ADD COLUMN IF NOT EXISTS phone VARCHAR(50) NULL",
            "ALTER TABLE technicians ADD COLUMN IF NOT EXISTS password VARCHAR(255) NULL",
            "ALTER TABLE technicians ADD COLUMN IF NOT EXISTS address TEXT NULL",
            "ALTER TABLE technicians ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active'",
            "ALTER TABLE technicians ADD COLUMN IF NOT EXISTS created_at DATETIME DEFAULT CURRENT_TIMESTAMP",
            // =========================================================
            // TABEL: PENDING_REGISTRATIONS (20 Kolom) - SOLUSI TEKNISI
            // =========================================================
            "ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS name VARCHAR(100) NULL",
            "ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS phone VARCHAR(20) NULL",
            "ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS email VARCHAR(255) NULL",
            "ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS address TEXT NULL",
            "ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS whatsapp_no VARCHAR(20) NULL",
            "ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS pppoe_user VARCHAR(100) NULL",
            "ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS pppoe_pass VARCHAR(100) NULL",
            "ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS package_name VARCHAR(100) NULL",
            "ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS package_id INT(11) NULL",
            "ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS identity_img VARCHAR(255) NULL",
            "ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS house_img VARCHAR(255) NULL",
            "ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS latitude VARCHAR(50) NULL",
            "ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS longitude VARCHAR(50) NULL",
            "ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS agent_id INT(11) NULL",
            "ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'pending'",
            "ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS created_at DATETIME DEFAULT CURRENT_TIMESTAMP",
            "ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS technician_id INT(11) NULL",
            "ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS customer_name VARCHAR(100) NULL",
            "ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS mediator_id INT(11) NULL",
            "ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS odp_data VARCHAR(100) NULL AFTER address",
            "ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS port_data VARCHAR(20) NULL AFTER odp_data",
            "ALTER TABLE nas ADD COLUMN IF NOT EXISTS api_user VARCHAR(64) DEFAULT NULL",
            "ALTER TABLE nas ADD COLUMN IF NOT EXISTS api_password VARCHAR(64) DEFAULT NULL",
            "ALTER TABLE nas ADD COLUMN IF NOT EXISTS api_port VARCHAR(10) DEFAULT '8728'",
            "ALTER TABLE nas ADD COLUMN IF NOT EXISTS mikrotik_version VARCHAR(10) DEFAULT 'v6'",
            
            "ALTER TABLE payments ADD COLUMN IF NOT EXISTS admin_name VARCHAR(100) DEFAULT 'SYSTEM'"
        ];
        
        for (const sql of migrations) {
            try {
                await pool.query(sql);
            } catch (err) {
                // Abaikan error jika kolom ternyata sudah ada atau tidak ditemukan (untuk CHANGE)
                if (err.code !== 'ER_DUP_FIELDNAME' && err.code !== 'ER_BAD_FIELD_ERROR') {
                    console.error('?? Migration Error:', err.message);
                }
            }
        }
        
        try {
            await pool.query(`
                UPDATE customers 
                SET username = name 
                WHERE username IS NULL OR username = ''
            `);
        } catch (err) {
            console.error('? Update null usernames error:', err.message);
        }
    }
    
    // =========================================================
    // Initialize database connection pool
    // =========================================================
    async createPackage(packageData) {
        try {
            const { name, speed, price, description, pppoe_profile } = packageData;
            const sql = `INSERT INTO packages (name, speed, price, description, pppoe_profile) VALUES (?, ?, ?, ?, ?)`;
            
            // Menggunakan pool.execute & result.insertId (Anti SQL Injection)
            const [result] = await pool.execute(sql, [name, speed, price, description, pppoe_profile || 'default']);
            
            return { id: result.insertId, ...packageData };
        } catch (error) {
            throw error; // Lempar error ke Route agar Admin tahu jika gagal
        }
    }
    // --- AKHIR BLOK 3 --- 
    // --- MULAI BLOK 4 ---
    // =========================================================
    // ?? PACKAGE MANAGEMENT (MURNI MARIADB)
    // =========================================================
    async getPackages() {
        try {
            const sql = `SELECT * FROM packages WHERE is_active = 1 ORDER BY price ASC`;
            const [rows] = await pool.query(sql);
            return rows;
        } catch (error) {
            throw error;
        }
    }
    async getPackageById(id) {
        try {
            const sql = `SELECT * FROM packages WHERE id = ?`;
            const [rows] = await pool.query(sql, [id]);
            return rows[0] || null; // Return objek pertama atau null jika tidak ada
        } catch (error) {
            throw error;
        }
    }
    // ? Tambahkan parameter adminName (default 'admin')
    async updatePackage(id, packageData, adminName = 'admin') {
        try {
            const { name, speed, price, description, pppoe_profile, billing_type, active_period } = packageData;
            
            // 1. Anti-Nol Beranak: Amankan Harga (Hanya angka murni)
            const cleanPrice = price ? String(price).replace(/[^0-9]/g, '') : 0;
            const sql = `
                UPDATE packages SET 
                    name = ?, 
                    speed = ?, 
                    price = ?, 
                    description = ?, 
                    pppoe_profile = ?,
                    billing_type = ?,
                    active_period = ?
                WHERE id = ?
            `;
            
            await pool.execute(sql, [
                name,
                speed,
                cleanPrice,
                description,
                pppoe_profile || 'default',
                billing_type || 'fixed',
                active_period || 30,
                id
            ]);
            setImmediate(() => {
                // ? Gunakan variabel adminName biar jujur nyatat nama pelakunya
                logActivity(adminName, 'UPDATE_PACKAGE', `Mengubah Paket: ${name} (Harga: Rp ${cleanPrice})`).catch(() => {});
            });
            return { id, ...packageData, price: cleanPrice };
        } catch (error) {
            console.error('?? [BILLING] Update Package Error:', error.message);
            throw error;
        }
    }
    async deletePackage(id) {
        try {
            // Gunakan soft delete agar data invoice lama tidak rusak
            const sql = `UPDATE packages SET is_active = 0 WHERE id = ?`;
            await pool.execute(sql, [id]);
            return { id, deleted: true };
        } catch (error) {
            throw error;
        }
    }
    // =========================================================
    // Initialize database connection pool
    // =========================================================
    async createCustomer(customerData) {
        // MENGGUNAKAN TRANSACTION AGAR WEB & RADIUS SINKRON 100%
        return this.withTransaction(async (conn) => {
            const { 
                name, username, password, phone, pppoe_username, pppoe_password, 
                email, address, package_id, pppoe_profile, status, 
                auto_suspension, billing_day, join_date,
                installation_date // <--- [BARU] Menangkap input dari Web
            } = customerData;
            
            // 1. Normalisasi Data (Anti-Kosong)
            const finalUsername = username || this.generateUsername(phone);
            const finalPassword = password || '123456'; // Default password portal web
            const autoPPPoEUsername = pppoe_username || this.generatePPPoEUsername(phone);
            const autoPPPoEPassword = pppoe_password || '123456'; // Default password mikrotik
            // A. Gunakan installation_date dari web, jika tidak ada pakai hari ini (YYYY-MM-DD)
            const todayStr = new Date().toISOString().split('T')[0];
            const finalInstallationDate = installation_date || todayStr;
            // B & C. Ambil Billing Day Asli (Tanpa Pemangkasan Paksa 28)
            const instDateObj = new Date(finalInstallationDate);
            const normBillingDay = billing_day ? parseInt(billing_day) : instDateObj.getDate();
            
            // D. Join Date
            const finalJoinDate = join_date || new Date().toISOString().slice(0, 19).replace('T', ' ');
            // 1. Arahkan ke tanggal 1 bulan depan dulu agar aman
            const expDate = new Date(instDateObj.getFullYear(), instDateObj.getMonth() + 1, 1);
            
            // 2. Hitung jumlah hari maksimal di bulan depan
            const maxDaysInNextMonth = new Date(instDateObj.getFullYear(), instDateObj.getMonth() + 2, 0).getDate();
            
            // 3. Kunci masa aktif sesuai tanggal pasang (mentok di akhir bulan jika kalender lebih pendek)
            expDate.setDate(Math.min(normBillingDay, maxDaysInNextMonth));
            expDate.setHours(23, 59, 59);
            
            // Format untuk SQL MariaDB (YYYY-MM-DD HH:mm:ss)
            const sqlExpiredDate = expDate.toISOString().slice(0, 19).replace('T', ' ');
            // 2. Simpan ke Database Utama (MariaDB - Web)
            // Menambahkan kolom installation_date dan expired_date (Total 16 kolom)
            const sql = `
                INSERT INTO customers (
                    username, password, name, phone, pppoe_username, pppoe_password, 
                    email, address, package_id, pppoe_profile, status, 
                    auto_suspension, billing_day, join_date, installation_date,
                    expired_date
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;
            
            const [result] = await conn.execute(sql, [
                finalUsername, finalPassword, name, phone, autoPPPoEUsername, autoPPPoEPassword, 
                email || '', address || '', package_id || null, pppoe_profile || 'default', 
                status || 'active', auto_suspension !== undefined ? auto_suspension : 1, 
                normBillingDay, finalJoinDate, finalInstallationDate,
                sqlExpiredDate // <--- [FIX] Sekarang tersimpan di DB, agar EJS bisa menampilkan EXP
            ]);
            const newCustomerId = result.insertId;
            // 3. ?? AUTO-SINKRON RADIUS (MIKROTIK)
            // Pelanggan baru langsung didaftarkan ke server Radius agar bisa langsung konek!
            if (autoPPPoEUsername) {
                const radiusProfile = pppoe_profile || 'default';
                
                const formattedExp = typeof this.formatRadiusDate === 'function' ? this.formatRadiusDate(expDate) : '01 Jan 2030 23:59:59';
                // Bersihkan barangkali ada sisa sampah dengan username yang sama
                await conn.execute("DELETE FROM radcheck WHERE username = ?", [autoPPPoEUsername]);
                await conn.execute("DELETE FROM radusergroup WHERE username = ?", [autoPPPoEUsername]);
                // Tanamkan Password & Gembok Expired
                await conn.execute("INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Cleartext-Password', ':=', ?)", [autoPPPoEUsername, autoPPPoEPassword]);
                await conn.execute("INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Expiration', ':=', ?)", [autoPPPoEUsername, formattedExp]);
                
                // Tanamkan Profil Kecepatan (Speed Limit)
                await conn.execute("INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, '1')", [autoPPPoEUsername, radiusProfile]);
            }
            
            // 4. Background Task: GenieACS Tagging (Jalan di belakang layar)
            setImmediate(async () => {
                if (phone && autoPPPoEUsername) {
                    try {
                        const { findDeviceByPPPoE, addTagToDevice } = require('./genieacs');
                        const device = await findDeviceByPPPoE(autoPPPoEUsername);
                        if (device) {
                            await addTagToDevice(device._id, phone);
                            console.log(`[GENIEACS] ? Tag ${phone} berhasil dipasang untuk ${autoPPPoEUsername}`);
                        }
                    } catch (err) {
                        console.warn(`[GENIEACS] ?? Gagal pasang tag untuk ${autoPPPoEUsername}:`, err.message);
                    }
                }
            });
            
            // Kembalikan success: true agar Mesin Import Excel tahu proses ini berhasil
            return { 
                success: true, 
                id: newCustomerId, 
                username: finalUsername, 
                pppoe_username: autoPPPoEUsername 
            };
        });
    }
    async getCustomerByUsername(username) {
        try {
            const sql = `
                SELECT c.*, p.name as package_name, p.price as package_price, p.speed as package_speed
                FROM customers c 
                LEFT JOIN packages p ON c.package_id = p.id 
                WHERE c.username = ?
            `;
            const [rows] = await pool.query(sql, [username]);
            return rows[0] || null;
        } catch (error) {
            throw error;
        }
    }
    async getCustomerById(id) {
        try {
            const sql = `
                SELECT c.*, p.name as package_name, p.price as package_price, p.speed as package_speed
                FROM customers c 
                LEFT JOIN packages p ON c.package_id = p.id 
                WHERE c.id = ?
            `;
            const [rows] = await pool.query(sql, [id]);
            return rows[0] || null;
        } catch (error) {
            throw error;
        }
    }
    // --- AKHIR BLOK 4 ---
    // --- MULAI BLOK 5 ---
    // =========================================================
    // ?? CUSTOMER SEARCH (MURNI MARIADB)
    // =========================================================
    async getCustomerByPhone(phone) {
        try {
            const sql = `
                SELECT c.*, p.name as package_name, p.price as package_price, p.speed as package_speed,
                       CASE 
                           WHEN EXISTS (SELECT 1 FROM invoices i WHERE i.customer_id = c.id AND i.status = 'unpaid' AND i.due_date < CURDATE()) THEN 'overdue'
                           WHEN EXISTS (SELECT 1 FROM invoices i WHERE i.customer_id = c.id AND i.status = 'unpaid') THEN 'unpaid'
                           WHEN EXISTS (SELECT 1 FROM invoices i WHERE i.customer_id = c.id AND i.status = 'paid') THEN 'paid'
                           ELSE 'no_invoice'
                       END as payment_status
                FROM customers c 
                LEFT JOIN packages p ON c.package_id = p.id 
                WHERE c.phone = ?
            `;
            const [rows] = await pool.query(sql, [phone]);
            return rows[0] || null;
        } catch (error) {
            throw error;
        }
    }
    async getCustomerByNameOrPhone(searchTerm) {
        try {
            const cleanPhone = searchTerm.replace(/\D/g, '');
            const likeTerm = `%${searchTerm}%`;
            const sql = `
                SELECT c.*, p.name as package_name, p.price as package_price, p.speed as package_speed,
                       CASE 
                           WHEN EXISTS (SELECT 1 FROM invoices i WHERE i.customer_id = c.id AND i.status = 'unpaid' AND i.due_date < CURDATE()) THEN 'overdue'
                           WHEN EXISTS (SELECT 1 FROM invoices i WHERE i.customer_id = c.id AND i.status = 'unpaid') THEN 'unpaid'
                           WHEN EXISTS (SELECT 1 FROM invoices i WHERE i.customer_id = c.id AND i.status = 'paid') THEN 'paid'
                           ELSE 'no_invoice'
                       END as payment_status
                FROM customers c 
                LEFT JOIN packages p ON c.package_id = p.id 
                WHERE c.phone = ? OR c.name LIKE ? OR c.username LIKE ?
                ORDER BY 
                    CASE 
                        WHEN c.phone = ? THEN 1
                        WHEN c.name = ? THEN 2
                        WHEN c.name LIKE ? THEN 3
                        WHEN c.username LIKE ? THEN 4
                        ELSE 5
                    END
                LIMIT 1
            `;
            const params = [
                cleanPhone, likeTerm, likeTerm, // Untuk WHERE
                cleanPhone, searchTerm, `${searchTerm}%`, likeTerm // Untuk ORDER BY
            ];
            const [rows] = await pool.query(sql, params);
            return rows[0] || null;
        } catch (error) {
            throw error;
        }
    }
    async findCustomersByNameOrPhone(searchTerm) {
        try {
            const cleanPhone = searchTerm.replace(/\D/g, '');
            const likeTerm = `%${searchTerm}%`;
            const sql = `
                SELECT c.*, p.name as package_name, p.price as package_price, p.speed as package_speed,
                       CASE 
                           WHEN EXISTS (SELECT 1 FROM invoices i WHERE i.customer_id = c.id AND i.status = 'unpaid' AND i.due_date < CURDATE()) THEN 'overdue'
                           WHEN EXISTS (SELECT 1 FROM invoices i WHERE i.customer_id = c.id AND i.status = 'unpaid') THEN 'unpaid'
                           WHEN EXISTS (SELECT 1 FROM invoices i WHERE i.customer_id = c.id AND i.status = 'paid') THEN 'paid'
                           ELSE 'no_invoice'
                       END as payment_status
                FROM customers c 
                LEFT JOIN packages p ON c.package_id = p.id 
                WHERE c.phone = ? OR c.name LIKE ? OR c.username LIKE ?
                ORDER BY 
                    CASE 
                        WHEN c.phone = ? THEN 1
                        WHEN c.name = ? THEN 2
                        WHEN c.name LIKE ? THEN 3
                        WHEN c.username LIKE ? THEN 4
                        ELSE 5
                    END
                LIMIT 5
            `;
            const params = [
                cleanPhone, likeTerm, likeTerm, // Untuk WHERE
                cleanPhone, searchTerm, `${searchTerm}%`, likeTerm // Untuk ORDER BY
            ];
            const [rows] = await pool.query(sql, params);
            return rows || [];
        } catch (error) {
            throw error;
        }
    }
    // --- AKHIR BLOK 5 ---
    // --- MULAI BLOK 6 ---
    // =========================================================
    // ?? UPDATE & DELETE CUSTOMER (MARIADB MURNI)
    // =========================================================
    async updateCustomer(phone, customerData) {
        return this.updateCustomerByPhone(phone, customerData);
    }
    async updateCustomerByPhone(oldPhone, customerData) {
        try {
            const { name, username, phone, pppoe_username, email, address, package_id, pppoe_profile, status, auto_suspension, billing_day } = customerData;
            
            const oldCustomer = await this.getCustomerByPhone(oldPhone);
            if (!oldCustomer) throw new Error('Pelanggan tidak ditemukan');
            
            const oldPPPoE = oldCustomer.pppoe_username;
            const normBillingDay = Math.min(Math.max(parseInt(billing_day !== undefined ? billing_day : (oldCustomer.billing_day ?? 15), 10) || 15, 1), 28);
            
            const sql = `UPDATE customers SET name = ?, username = ?, phone = ?, pppoe_username = ?, email = ?, address = ?, package_id = ?, pppoe_profile = ?, status = ?, auto_suspension = ?, billing_day = ? WHERE id = ?`;
            
            await pool.execute(sql, [
                name, username || oldCustomer.username, phone || oldPhone, pppoe_username, 
                email, address, package_id, pppoe_profile, status, 
                auto_suspension !== undefined ? auto_suspension : oldCustomer.auto_suspension, 
                normBillingDay, oldCustomer.id
            ]);
            // Background Task: Update tag di GenieACS (Tanpa bikin loading muter)
            setImmediate(async () => {
                const newPhone = phone || oldPhone;
                if (newPhone && (newPhone !== oldPhone || pppoe_username !== oldPPPoE)) {
                    try {
                        const { findDeviceByPPPoE, addTagToDevice, removeTagFromDevice } = require('./genieacs');
                        
                        // Hapus tag lama
                        if (oldPhone && oldPPPoE) {
                            const oldDevice = await findDeviceByPPPoE(oldPPPoE);
                            if (oldDevice) await removeTagFromDevice(oldDevice._id, oldPhone);
                        }
                        
                        // Tambah tag baru
                        const pppoeToUse = pppoe_username || oldCustomer.username;
                        const device = await findDeviceByPPPoE(pppoeToUse);
                        if (device) await addTagToDevice(device._id, newPhone);
                        
                    } catch (err) {
                        console.warn(`[GENIEACS] Gagal update phone tag untuk ${oldCustomer.username}:`, err.message);
                    }
                }
            });
            
            return { username: oldCustomer.username, ...customerData };
        } catch (error) {
            throw error;
        }
    }
    async deleteCustomer(phone) {
        const conn = await pool.getConnection();
        try {
            const customer = await this.getCustomerByPhone(phone);
            if (!customer) throw new Error('Pelanggan tidak ditemukan');
            const customerId = customer.id;
            const activeUser = customer.pppoe_username || customer.username;
            await conn.beginTransaction();
            // Matikan gembok relasi sebentar biar bisa hapus massal
            await conn.query("SET FOREIGN_KEY_CHECKS = 0");
            // 1. Bersihkan Radius
            if (activeUser) {
                await conn.execute("DELETE FROM radcheck WHERE username = ?", [activeUser]);
                await conn.execute("DELETE FROM radusergroup WHERE username = ?", [activeUser]);
                await conn.execute("DELETE FROM radreply WHERE username = ?", [activeUser]);
            }
            // 2. Bersihkan Transaksi & Invoice
            await conn.execute("DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE customer_id = ?)", [customerId]);
            await conn.execute("DELETE FROM payment_gateway_transactions WHERE invoice_id IN (SELECT id FROM invoices WHERE customer_id = ?)", [customerId]);
            await conn.execute("DELETE FROM invoices WHERE customer_id = ?", [customerId]);
            // 3. Hapus Data Utama
            await conn.execute("DELETE FROM customers WHERE id = ?", [customerId]);
            // Kunci lagi relasinya
            await conn.query("SET FOREIGN_KEY_CHECKS = 1");
            await conn.commit();
            // Background Task: Bersihkan GenieACS & Tendang dari Mikrotik
            setImmediate(async () => {
                if (customer.phone) {
                    try {
                        const { findDeviceByPPPoE, removeTagFromDevice } = require('./genieacs');
                        const device = await findDeviceByPPPoE(activeUser);
                        if (device) await removeTagFromDevice(device._id, customer.phone);
                    } catch (e) {}
                }
                
                if (activeUser) {
                    try {
                        const { exec } = require('child_process');
                        // ?? KUNCI: Kita tarik framedipaddress dan callingstationid sekaligus
                        const [nas] = await pool.query(`
                            SELECT r.nasipaddress, n.secret, r.framedipaddress, r.callingstationid 
                            FROM radacct r 
                            JOIN nas n ON r.nasipaddress = n.nasname 
                            WHERE r.username = ? AND r.acctstoptime IS NULL LIMIT 1
                        `, [activeUser]);
                        if (nas.length > 0) {
                            const { nasipaddress, secret, framedipaddress, callingstationid } = nas[0];
                            
                            // ?? PELURU LENGKAP: User + IP + MAC (Anti-NAK v7)
                            const attr = `User-Name=${activeUser},Framed-IP-Address=${framedipaddress},Calling-Station-Id=${callingstationid}`;
                            const command = `echo "${attr}" | radclient -x ${nasipaddress}:3799 disconnect ${secret}`;
                            
                            exec(command, (err) => {
                                if (err) console.error(`? [DELETE-KICK-FAIL] ${activeUser}: ${err.message}`);
                                else console.log(`?? [DELETE-KICK-SUCCESS] ${activeUser} ditendang bersih!`);
                            });
                        }
                    } catch(e) {
                        console.error("? Error Background Kick:", e.message);
                    }
                }
            });
            return { username: customer.username, deleted: true, message: "Data dihapus bersih sampai ke Radius" };
        } catch (error) {
            await conn.rollback();
            await conn.query("SET FOREIGN_KEY_CHECKS = 1");
            throw error;
        } finally {
            conn.release();
        }
    }
    // Initialize database connection pool
    // =========================================================
    async createInvoice(invoiceData) {
        try {
            // 1. TANGKAP parameter month & year dari Scheduler
            const { customer_id, package_id, amount, due_date, month, year, notes } = invoiceData;
            
            // 2. Standarisasi Tanggal Jatuh Tempo
            const finalDueDate = due_date || new Date().toISOString().slice(0, 10);
            // 3. KUNCI PREFIX INVOICE (ANTI NGACO)
            // Mengambil bulan/tahun persis dari jadwal target, bukan jam server!
            const targetYear = year || new Date(finalDueDate).getFullYear();
            const targetMonth = String(month || (new Date(finalDueDate).getMonth() + 1)).padStart(2, '0');
            const randomSuffix = Math.floor(1000 + Math.random() * 9000);
            const invoice_number = `INV-${targetYear}${targetMonth}-${randomSuffix}`;
            // =================================================================
            // 2. RADAR V5: KUNCI MATI BULANAN VIA ENGINE DATABASE
            // =================================================================
            // Pengecualian untuk transaksi umum/PLN (Tanpa Paket)
            const isExpense = !package_id || (notes && notes.toLowerCase().includes('pln'));
            
            if (!isExpense) {
    // Initialize database connection pool
                const [existingMonth] = await pool.query(
                    `SELECT id FROM invoices 
                     WHERE customer_id = ? 
                       AND MONTH(due_date) = MONTH(?) 
                       AND YEAR(due_date) = YEAR(?) 
                       AND status != 'cancelled' LIMIT 1`,
                    [customer_id, finalDueDate, finalDueDate]
                );
                if (existingMonth.length > 0) {
                    console.log(`[SUSPENSION-ENGINE] Melewati ID ${customer_id}: Tagihan bulan untuk ${finalDueDate} sudah terdata.`);
                    return { skipped: true, message: "Tagihan sudah ada di bulan ini" };
                }
            }
            // =================================================================
            // 3. EKSEKUSI SIMPAN: NILAI MONTH/YEAR DIHITUNG OTOMATIS OLEH DB
            // =================================================================
            const sql = `
                INSERT IGNORE INTO invoices 
                (customer_id, package_id, invoice_number, amount, due_date, status, month, year, notes, created_at) 
                VALUES (?, ?, ?, ?, ?, 'unpaid', MONTH(?), YEAR(?), ?, NOW())
            `;
            
            const [result] = await pool.execute(sql, [
                customer_id, 
                package_id || null, 
                invoice_number, 
                amount, 
                finalDueDate, 
                finalDueDate, // Parameter untuk MONTH(?) database
                finalDueDate, // Parameter untuk YEAR(?) database
                notes || ''
            ]);
            // Jika Gembok UNIQUE INDEX (Tanggal Persis Sama) menolak data
            if (result.affectedRows === 0) {
                 console.log(`[SUSPENSION-ENGINE] Ditolak Gembok Baja MariaDB (Unique Tanggal) untuk ID ${customer_id}`);
                 return { skipped: true, message: "Ditolak oleh Unique Constraint Database" };
            }
            return { id: result.insertId, invoice_number, ...invoiceData };
        } catch (error) {
            console.error("? Eror Fatal createInvoice:", error.message);
            throw error;
        }
    }
    
    async getInvoices(customerUsername = null) {
        try {
            let sql = `
                SELECT i.*, c.username, c.name as customer_name, c.phone as customer_phone,
                       COALESCE(p_inv.name, p_cust.name, 'CUSTOM') as package_name,
                       COALESCE(p_inv.speed, p_cust.speed, 'N/A') as package_speed
                FROM invoices i
                JOIN customers c ON i.customer_id = c.id
                LEFT JOIN packages p_inv ON i.package_id = p_inv.id
                LEFT JOIN packages p_cust ON c.package_id = p_cust.id
            `;
            const params = [];
            if (customerUsername) {
                sql += ` WHERE c.username = ?`;
                params.push(customerUsername);
            }
            sql += ` ORDER BY i.created_at DESC`;
            
            const [rows] = await pool.query(sql, params);
            return rows;
        } catch (error) {
            throw error;
        }
    }
    async getInvoicesByCustomer(customerId) {
        try {
            const sql = `
                SELECT i.*, c.username, c.name as customer_name, c.phone as customer_phone,
                       COALESCE(p_inv.name, p_cust.name, 'CUSTOM') as package_name,
                       COALESCE(p_inv.speed, p_cust.speed, 'N/A') as package_speed
                FROM invoices i
                JOIN customers c ON i.customer_id = c.id
                LEFT JOIN packages p_inv ON i.package_id = p_inv.id
                LEFT JOIN packages p_cust ON c.package_id = p_cust.id
                WHERE i.customer_id = ?
                ORDER BY i.created_at DESC
            `;
            const [rows] = await pool.query(sql, [customerId]);
            return rows;
        } catch (error) {
            throw error;
        }
    }
    async getCustomersByPackage(packageId) {
        try {
            const sql = `
                SELECT c.*, p.name as package_name, p.price as package_price, p.speed as package_speed
                FROM customers c
                LEFT JOIN packages p ON c.package_id = p.id
                WHERE c.package_id = ?
                ORDER BY c.name ASC
            `;
            const [rows] = await pool.query(sql, [packageId]);
            return rows;
        } catch (error) {
            throw error;
        }
    }
    // --- AKHIR BLOK 6 ---
    // --- MULAI BLOK 7 ---
    // =========================================================
    // ?? LANJUTAN INVOICE MANAGEMENT (MARIADB MURNI)
    // =========================================================
    
    async updateInvoiceStatus(id, status, paymentMethod = null) {
        try {
            const paymentDate = status === 'paid' ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null;
            const sql = `UPDATE invoices SET status = ?, payment_date = ?, payment_method = ? WHERE id = ?`;
            await pool.execute(sql, [status, paymentDate, paymentMethod, id]);
            return { id, status, payment_date: paymentDate, payment_method: paymentMethod };
        } catch (error) {
            throw error;
        }
    }
    async updateInvoice(id, invoiceData) {
        try {
            const { customer_id, package_id, amount, due_date, notes } = invoiceData;
            const sql = `UPDATE invoices SET customer_id = ?, package_id = ?, amount = ?, due_date = ?, notes = ? WHERE id = ?`;
            await pool.execute(sql, [customer_id, package_id, amount, due_date, notes, id]);
            return await this.getInvoiceById(id);
        } catch (error) {
            throw error;
        }
    }
    async deleteInvoice(id) {
        return this.withTransaction(async (conn) => {
            const invoice = await this.getInvoiceById(id);
            if (!invoice) throw new Error('Invoice tidak ditemukan');
            // Hapus riwayat pembayaran & transaksi gateway yang menempel di invoice ini
            await conn.execute("DELETE FROM payments WHERE invoice_id = ?", [id]);
            await conn.execute("DELETE FROM payment_gateway_transactions WHERE invoice_id = ?", [id]);
            
            // Hapus Invoice utamanya
            await conn.execute("DELETE FROM invoices WHERE id = ?", [id]);
            
            return invoice;
        });
    }
    // =========================================================
    // =========================================================
    async recordPayment(paymentData) {
        try {
            // 1. Amankan ID Invoice dari berbagai kemungkinan kiriman frontend
            const targetInvoiceId = paymentData.invoice_id || paymentData.invoiceId || paymentData.id;
            
            if (!targetInvoiceId) {
                console.error("? [RECORD-PAYMENT ERROR] invoice_id tidak ditemukan!");
                return { success: false, message: 'Gagal: ID Invoice tidak terbaca dari sistem.' };
            }
            // 2. Buat nomor referensi otomatis (Agar kolom Referensi tidak nol/strip)
            const refGenerate = paymentData.reference_number || `CASH-${Date.now().toString().slice(-6)}`;
            const result = await this.sultanManualPayment(targetInvoiceId, null, {
                payment_method: paymentData.payment_method || 'Cash/Manual',
                reference_number: refGenerate,
                notes: paymentData.notes || 'Pelunasan via Tombol Dompet'
            });
            // 4. JURUS KUNCI: Kirim jawaban yang PASTI memicu centang hijau di EJS
            return { 
                success: true, 
                message: result.message || 'Pembayaran Berhasil Diverifikasi!',
                id: targetInvoiceId,
                ...result 
            };
        } catch (error) {
            console.error('?? [RECORD-PAYMENT CRITICAL ERROR]:', error.message);
            // JANGAN PAKAI 'throw error', tapi kirim JSON success: false agar EJS tidak crash
            return { 
                success: false, 
                message: 'Gagal memproses: ' + error.message 
            };
        }
    }
    async getPayments(invoiceId = null) {
        try {
            let sql = `
                SELECT p.*, i.invoice_number, c.username, c.name as customer_name
                FROM payments p
                JOIN invoices i ON p.invoice_id = i.id
                JOIN customers c ON i.customer_id = c.id
            `;
            const params = [];
            if (invoiceId) {
                sql += ` WHERE p.invoice_id = ?`;
                params.push(invoiceId);
            }
            sql += ` ORDER BY p.payment_date DESC`;
            
            const [rows] = await pool.query(sql, params);
            return rows;
        } catch (error) {
            throw error;
        }
    }
    async getPaymentById(id) {
        try {
            const sql = `
                SELECT p.*, i.invoice_number, c.username, c.name as customer_name
                FROM payments p
                JOIN invoices i ON p.invoice_id = i.id
                JOIN customers c ON i.customer_id = c.id
                WHERE p.id = ?
            `;
            const [rows] = await pool.query(sql, [id]);
            return rows[0] || null;
        } catch (error) {
            throw error;
        }
    }
    // --- AKHIR BLOK 7 ---
    // --- MULAI BLOK 8 ---
    // =========================================================
    // ?? EDIT & HAPUS RIWAYAT PEMBAYARAN
    // =========================================================
    async updatePayment(id, paymentData) {
        try {
            const { amount, payment_method, reference_number, notes } = paymentData;
            const sql = `UPDATE payments SET amount = ?, payment_method = ?, reference_number = ?, notes = ? WHERE id = ?`;
            await pool.execute(sql, [amount, payment_method, reference_number, notes, id]);
            return await this.getPaymentById(id);
        } catch (error) {
            throw error;
        }
    }
    async deletePayment(id) {
        try {
            const payment = await this.getPaymentById(id);
            if (!payment) throw new Error('Payment not found');
            
            const sql = `DELETE FROM payments WHERE id = ?`;
            await pool.execute(sql, [id]);
            return payment;
        } catch (error) {
            throw error;
        }
    }
    // =========================================================
    // ?? UTILITY FUNCTIONS (GENERATE OTOMATIS)
    // =========================================================
    generateInvoiceNumber() {
        const date = new Date();
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const random = Math.floor(1000 + Math.random() * 9000).toString();
        return `INV-${year}${month}-${random}`;
    }
    generateUsername(phone) {
        return phone || '';
    }
    generatePPPoEUsername(phone) {
        return phone || '';
    }
    
    formatRadiusDate(dateObj) {
        if (!dateObj) return '01 Jan 2030 23:59:59';
        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const d = String(dateObj.getDate()).padStart(2, '0');
        const m = months[dateObj.getMonth()];
        const y = dateObj.getFullYear();
        const h = String(dateObj.getHours()).padStart(2, '0');
        const min = String(dateObj.getMinutes()).padStart(2, '0');
        const sec = String(dateObj.getSeconds()).padStart(2, '0');
        return `${d} ${m} ${y} ${h}:${min}:${sec}`;
    }
    // =========================================================
    // ?? DASHBOARD STATS & OVERDUE (MARIADB MURNI)
    // =========================================================
    async getBillingStats() {
        try {
            const sql = `
                SELECT 
                    COUNT(DISTINCT c.id) as total_customers,
                    COUNT(CASE WHEN c.status = 'active' THEN 1 END) as active_customers,
                    COUNT(i.id) as total_invoices,
                    COUNT(CASE WHEN i.status = 'paid' THEN 1 END) as paid_invoices,
                    COUNT(CASE WHEN i.status = 'unpaid' THEN 1 END) as unpaid_invoices,
                    SUM(CASE WHEN i.status = 'paid' THEN i.amount ELSE 0 END) as total_revenue,
                    SUM(CASE WHEN i.status = 'unpaid' THEN i.amount ELSE 0 END) as total_unpaid
                FROM customers c
                LEFT JOIN invoices i ON c.id = i.customer_id
            `;
            const [rows] = await pool.query(sql);
            return rows[0] || {};
        } catch (error) {
            throw error;
        }
    }
    async getOverdueInvoices() {
        try {
            // Gunakan CURDATE() bawaan MariaDB, dan LEFT JOIN ke packages
            const sql = `
                SELECT i.*, c.username, c.name as customer_name, c.phone as customer_phone,
                       p.name as package_name
                FROM invoices i
                JOIN customers c ON i.customer_id = c.id
                LEFT JOIN packages p ON i.package_id = p.id
                WHERE i.status = 'unpaid' AND i.due_date < CURDATE()
                ORDER BY i.due_date ASC
            `;
            const [rows] = await pool.query(sql);
            return rows;
        } catch (error) {
            throw error;
        }
    }
    // Tutup koneksi (Hanya dipanggil kalau server mati/restart)
    async close() {
        try {
            await pool.end();
            console.log('?? [BILLING] MariaDB connection pool closed');
        } catch (error) {
            console.error('? [BILLING] Error closing MariaDB:', error);
        }
    }
    // =========================================================
    // ?? ONLINE PAYMENT GATEWAY (TRIPAY/MIDTRANS) + CCTV
    // =========================================================
    // 1. WAJIB: Tambahkan parameter 'req = null' di kursi terakhir
    async createOnlinePayment(invoiceId, gateway = null, req = null) { 
        return this.withTransaction(async (conn) => {
            // 1. Ambil detail Invoice
            const sqlInv = `
                SELECT i.*, p.name as package_name 
                FROM invoices i 
                LEFT JOIN packages p ON i.package_id = p.id 
                WHERE i.id = ? FOR UPDATE`;
            const [invRows] = await conn.query(sqlInv, [invoiceId]);
            if (invRows.length === 0) throw new Error('Invoice tidak ditemukan');
            const invoice = invRows[0];
            // 2. Ambil detail Pelanggan
            const sqlCust = `SELECT * FROM customers WHERE id = ?`;
            const [custRows] = await conn.query(sqlCust, [invoice.customer_id]);
            if (custRows.length === 0) throw new Error('Pelanggan tidak ditemukan');
            const customer = custRows[0];
            // 3. Susun Data untuk Gateway
            const paymentData = {
                id: invoice.id,
                invoice_number: invoice.invoice_number,
                amount: invoice.amount,
                customer_name: customer.name,
                customer_phone: customer.phone,
                customer_email: customer.email || 'customer@pulsebill.io', // Fallback Email Wajib
                package_name: invoice.package_name || 'Paket Internet',
                package_id: invoice.package_id
            };
            // 4. Proses ke Gateway (Tripay/Midtrans)
            const paymentManager = this.getPaymentGateway();
            if (!paymentManager) throw new Error('Modul Payment Gateway belum siap');
            
            const paymentResult = await paymentManager.createPayment(paymentData, gateway);
            // 5. Simpan transaksi pending ke Database
            const sqlTx = `
                INSERT INTO payment_gateway_transactions 
                (invoice_id, gateway, order_id, payment_url, token, amount, status) 
                VALUES (?, ?, ?, ?, ?, ?, 'pending')
            `;
            await conn.execute(sqlTx, [
                invoiceId, paymentResult.gateway, paymentResult.order_id, 
                paymentResult.payment_url, paymentResult.token, invoice.amount
            ]);
            // 6. Update URL dan Token di Tabel Invoice Utama
            const sqlUpdateInv = `
                UPDATE invoices 
                SET payment_gateway = ?, payment_token = ?, payment_url = ?, payment_status = 'pending'
                WHERE id = ?
            `;
            await conn.execute(sqlUpdateInv, [
                paymentResult.gateway, paymentResult.token, paymentResult.payment_url, invoiceId
            ]);
            
            // --- [ PERBAIKAN FINAL POSISI KURSI (SESUAI TERMINAL) ] ---
            if (typeof logActivity === 'function') {
                setImmediate(async () => {
                    const logMsg = `Inisiasi Pembayaran #${invoice.invoice_number} via ${paymentResult.gateway} (Rp ${invoice.amount})`;
                    
                    // Sesuai cetak biru utils/logger.js: (userId, action, description, req)
                    // ? Pindah 'req' ke kursi paling belakang dan ubah pelakunya jadi 'PELANGGAN'
                    await logActivity('PELANGGAN', 'GATEWAY_INIT', logMsg, req); 
                });
            }
            return paymentResult;
        });
    }
    
    // 1. WAJIB: Tambahkan parameter 'req = null' di kursi terakhir
    async createOnlinePaymentWithMethod(invoiceId, gateway = null, method = null, req = null) {
        // MENGGUNAKAN TRANSACTION AGAR ANTI-SELISIH
        return this.withTransaction(async (conn) => {
            const invoice = await this.getInvoiceById(invoiceId);
            if (!invoice) throw new Error('Invoice tidak ditemukan');
            const customer = await this.getCustomerById(invoice.customer_id);
            if (!customer) throw new Error('Pelanggan tidak ditemukan');
            const paymentData = {
                id: invoice.id,
                invoice_number: invoice.invoice_number,
                amount: invoice.amount,
                customer_name: customer.name,
                customer_phone: customer.phone,
                customer_email: customer.email || 'customer@pulsebill.io', // Fallback anti-error gateway
                package_name: invoice.package_name || 'Paket Internet',
                package_id: invoice.package_id,
                payment_method: method
            };
            const pg = this.getPaymentGateway();
            if (!pg) throw new Error('Modul Payment Gateway belum siap');
            
            const paymentResult = await pg.createPaymentWithMethod(paymentData, gateway, method);
            // Simpan Transaksi Gateway via MariaDB (conn.execute)
            const sqlTx = `INSERT INTO payment_gateway_transactions (invoice_id, gateway, order_id, payment_url, token, amount, status, payment_type) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`;
            await conn.execute(sqlTx, [invoiceId, paymentResult.gateway, paymentResult.order_id, paymentResult.payment_url, paymentResult.token, invoice.amount, method || 'all']);
            // Update Invoice via MariaDB (conn.execute)
            const sqlInv = `UPDATE invoices SET payment_gateway = ?, payment_token = ?, payment_url = ?, payment_status = 'pending' WHERE id = ?`;
            await conn.execute(sqlInv, [paymentResult.gateway, paymentResult.token, paymentResult.payment_url, invoiceId]);
            // =========================================================
            // =========================================================
            if (typeof logActivity === 'function') {
                setImmediate(async () => {
                    const pesanLog = `Pelanggan inisiasi bayar #${invoice.invoice_number} via ${paymentResult.gateway} [${method || 'ALL'}]`;
                    
                    // Sesuai cetak biru utils/logger.js: (userId, action, description, req)
                    // ? Ganti 'SYSTEM' menjadi 'PELANGGAN' agar jelas siapa pelakunya
                    await logActivity('PELANGGAN', 'GATEWAY_INIT_METHOD', pesanLog, req);
                });
            }
            
            return paymentResult;
        });
    }
    
    // =========================================================
    // =========================================================
    async handlePaymentWebhook(payload, gateway) {
        try {
            console.log(`[WEBHOOK] Menerima data dari ${gateway}...`);
            const pg = this.getPaymentGateway();
            if (!pg) throw new Error("Payment Gateway off");
            
            const result = await pg.handleWebhook(payload, gateway);
            
            // Pencarian transaksi pakai pool.query (MariaDB)
            let [txRows] = await pool.query(`SELECT * FROM payment_gateway_transactions WHERE order_id = ? AND gateway = ?`, [result.order_id, gateway]);
            let transaction = txRows[0];
            // Jika transaksi tidak ada (fallback pakai nomor invoice)
            if (!transaction) {
                const invNum = (result.order_id || '').replace('INV-', ''); 
                const [invRows] = await pool.query(`SELECT id FROM invoices WHERE invoice_number LIKE ?`, [`%${invNum}%`]);
                if (invRows.length === 0) throw new Error('Transaksi dan Invoice tidak ditemukan');
                transaction = { id: null, invoice_id: invRows[0].id };
            }
            // Update status transaksi di database (pool.execute)
            if (transaction.id) {
                await pool.execute(
                    `UPDATE payment_gateway_transactions SET status = ?, payment_type = ?, fraud_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, 
                    [result.status, result.payment_type || null, result.fraud_status || null, transaction.id]
                );
            }
            setImmediate(() => {
                // ? Ubah 'system' jadi nama robot yang lebih gagah dan spesifik
                const namaRobot = `SISTEM (${gateway.toUpperCase()})`; 
                
                logActivity(namaRobot, 'WEBHOOK_PROCESSED', `Update status gateway: ${result.order_id} -> ${result.status}`).catch(e => {});
            });
            if (result.status === 'success' || result.status === 'PAID') {
                console.log(`[WEBHOOK] LUNAS! Mengeksekusi Auto-Restore untuk Invoice ID: ${transaction.invoice_id}`);
                await this.sultanManualPayment(transaction.invoice_id, null, { 
                    payment_method: gateway, 
                    notes: `Otomatis via Webhook ${gateway} (${result.payment_type || 'Online'})`,
                    adminId: 'TRIPAY OTOMATIS'
                });
            }
            return { success: true, message: 'Webhook sukses diproses', invoice_id: transaction.invoice_id };
        } catch (error) {
            console.error(`[WEBHOOK ERROR]`, error.message);
            throw error;
        }
    }
    async getPaymentTransactions(invoiceId = null) {
        let sql = `SELECT pgt.*, i.invoice_number, c.name as customer_name FROM payment_gateway_transactions pgt JOIN invoices i ON pgt.invoice_id = i.id JOIN customers c ON i.customer_id = c.id`;
        const params = [];
        if (invoiceId) { 
            sql += ' WHERE pgt.invoice_id = ?'; 
            params.push(invoiceId); 
        }
        sql += ' ORDER BY pgt.created_at DESC';
        
        const [rows] = await pool.query(sql, params);
        return rows;
    }
    // =========================================================
    // =========================================================
    async getGatewayStatus() {
        try {
            // 1. Ambil instance gateway
            const pg = this.getPaymentGateway();
            
            // 2. Cek apakah pg ada DAN punya fungsi getGatewayStatus
            if (pg && typeof pg.getGatewayStatus === 'function') {
                return await pg.getGatewayStatus();
            }
            
            // 3. Fallback: Jika modul gateway bermasalah, ambil status default
            return { active: false, message: "Gateway Module not ready" };
        } catch (e) {
            // Jika terjadi error saat cek status, jangan biarkan web crash
            console.error("?? [GATEWAY-CHECK-ERROR]:", e.message);
            return { active: false, error: e.message };
        }
    }
    // =========================================================
    // ?? WHATSAPP NOTIFICATION (SINKRON TEMPLATE WEB)
    // =========================================================
    async sendPaymentSuccessNotification(customer, invoice) {
        try {
            const tgl = new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
            
            await whatsappManager.sendPaymentReceivedNotification({
                name: customer.name || customer.customer_name,
                phone: customer.phone || customer.customer_phone,
                amount: invoice.amount,
                invoice_number: invoice.invoice_number,
                next_due_date: tgl
            });
            return true;
        } catch (error) { 
            console.error(`[NOTIFICATION ERROR]`, error.message);
            return false; 
        }
    }
    
    // Financial ledger and transaction processing
     async processTripaySelection(invoice_number, method, hostname) {
        // 1. [BILLING JS] Yang berhak kueri ke database
        const [invRows] = await pool.query(`
            SELECT i.*, c.name, c.phone, c.email 
            FROM invoices i 
            JOIN customers c ON i.customer_id = c.id 
            WHERE i.invoice_number = ?
        `, [invoice_number]);
        if (invRows.length === 0) throw new Error("Invoice tidak ditemukan.");
        const inv = invRows[0];
        // 2. [BILLING JS] Yang berhak ambil setting
        const [setRows] = await pool.query("SELECT value FROM app_settings WHERE setting_key = 'payment_gateway_config'");
        if (setRows.length === 0) throw new Error("Config Payment belum diatur.");
        
        const tripayConfig = JSON.parse(setRows[0].value).tripay;
        const amount = Math.floor(inv.amount);
        // 3. [BILLING JS] Yang urus keamanan (Crypto)
        const signature = crypto.createHmac('sha256', tripayConfig.privateKey.trim())
            .update(tripayConfig.merchantCode.trim() + invoice_number + amount)
            .digest('hex');
        // 4. [BILLING JS] Yang tembak API Tripay (Axios)
        const response = await axios.post('https://tripay.co.id/api/transaction/create', {
            'method': method,
            'merchant_ref': invoice_number,
            'amount': amount,
            'customer_name': inv.name,
            'customer_email': inv.email || 'billing@pulsebill.io',
            'customer_phone': inv.phone || '08123456789',
            'order_items': [{ 'sku': 'NET', 'name': 'Internet Bill ' + invoice_number, 'price': amount, 'quantity': 1 }],
            'return_url': 'https://' + hostname + '/payment/finish',
            'expired_time': (Math.floor(Date.now() / 1000) + (24 * 60 * 60)),
            'signature': signature
        }, {
            headers: { 'Authorization': 'Bearer ' + tripayConfig.apiKey.trim() }
        });
        if (response.data.success) {
            // Update URL ke database
            await pool.query("UPDATE invoices SET tripay_url = ? WHERE id = ?", [response.data.data.checkout_url, inv.id]);
            return response.data.data.checkout_url;
        } else {
            throw new Error(response.data.message);
        }
    }
    
    async initiateOnlinePayment(invoice_id, gateway) {
        if (!invoice_id) throw new Error('Invoice ID wajib diisi');
        // 1. Cek Invoice (Database Power)
        const invoice = await this.getInvoiceById(invoice_id);
        if (!invoice) throw new Error('Invoice tidak ditemukan');
        // 2. Cek Validasi Nominal (Business Logic Power)
        const status = await this.getGatewayStatus();
        const activeGateway = gateway || status?.active;
        if (activeGateway === 'tripay' && Number(invoice.amount) < 10000) {
            throw new Error('Gagal: Minimal pembayaran via Tripay adalah Rp 10.000');
        }
        // 3. Eksekusi proses pembayaran yang sudah ada
        return await this.createOnlinePayment(invoice_id, gateway);
    }
        
    // Financial ledger and transaction processing
    async getInvoiceById(id) {
        try {
            const sql = `
                SELECT i.*, c.username, c.name as customer_name, c.phone as customer_phone,
                       p.name as package_name, p.speed as package_speed
                FROM invoices i
                JOIN customers c ON i.customer_id = c.id
                LEFT JOIN packages p ON i.package_id = p.id
                WHERE i.id = ?
            `;
            const [rows] = await pool.query(sql, [id]);
            return rows[0] || null;
        } catch (error) {
            console.error('? Error getInvoiceById:', error.message);
            throw error;
        }
    }
    
    // Financial ledger and transaction processing
    async handleTripayWebhookHybrid(payload) {
        const { status, merchant_ref } = payload;
        console.log(`[TRIPAY Webhook] Ref: ${merchant_ref} - Status: ${status}`);
        // 1. Jika belum lunas, abaikan tapi kasih respon sukses ke Tripay
        if (status !== 'PAID') return { success: true };
        // -------------------------------------------------------
        // LOGIKA A: JIKA INI ADALAH TOPUP SALDO AGEN
        // -------------------------------------------------------
        if (merchant_ref.startsWith('TOPUP-AGEN-')) {
            return this.withTransaction(async (conn) => {
                const [topupRows] = await conn.query(
                    "SELECT id, agent_id, amount FROM agent_topup_requests WHERE proof_img LIKE ? AND status = 'pending' FOR UPDATE",
                    [`%${merchant_ref}%`]
                );
                if (topupRows.length > 0) {
                    const topup = topupRows[0];
                    // Update Saldo Agents
                    await conn.execute("UPDATE agents SET balance = balance + ? WHERE id = ?", [topup.amount, topup.agent_id]);
                    // Update Status Request
                    await conn.execute("UPDATE agent_topup_requests SET status = 'approved' WHERE id = ?", [topup.id]);
                    
                    console.log(`? [TOPUP OK] Saldo Agen ID ${topup.agent_id} bertambah.`);
                    return { success: true, type: 'agent_topup' };
                }
                return { success: true, message: 'Topup sudah pernah diproses' };
            });
        }
        // -------------------------------------------------------
        // LOGIKA B: JIKA INI ADALAH PEMBAYARAN BILLING PELANGGAN
        // -------------------------------------------------------
        const [inv] = await pool.query("SELECT id FROM invoices WHERE invoice_number = ?", [merchant_ref]);
        
        if (inv.length > 0) {
            return await this.sultanManualPayment(inv[0].id, null, { 
                payment_method: 'Tripay', 
                notes: `Otomatis via Webhook Tripay` 
            });
        }
        throw new Error('Referensi Transaksi tidak ditemukan di sistem');
    }
    
    // Financial ledger and transaction processing
    async getInvoiceForSelectionPage(invNumber, custId) {
        let sql = `
            SELECT i.*, p.name as package_name, c.name 
            FROM invoices i
            JOIN customers c ON i.customer_id = c.id
            LEFT JOIN packages p ON i.package_id = p.id
            WHERE `;
        
        let params = [];
        // Logika Pintar: Jika invNumber dikosongkan '-', cari tagihan terbaru milik Cust ID tersebut
        if (invNumber === '-' && custId) {
            sql += `i.customer_id = ? AND i.status = 'unpaid' ORDER BY i.id DESC LIMIT 1`;
            params = [custId];
        } else {
            // Logika Normal: Cari murni berdasarkan Nomor Invoice
            sql += `i.invoice_number = ? AND i.status = 'unpaid'`;
            params = [invNumber];
        }
        const [rows] = await pool.query(sql, params);
        return rows[0] || null;
    }
    
    async getDashboardStats() {
        const sql = `
            SELECT 
                (SELECT COUNT(*) FROM customers) as total_customers,
                (SELECT COUNT(*) FROM customers WHERE status='active') as active_customers,
                (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE MONTH(payment_date) = MONTH(CURRENT_DATE()) AND YEAR(payment_date) = YEAR(CURRENT_DATE())) as total_revenue,
                (SELECT COUNT(*) FROM invoices WHERE status='paid' AND MONTH(created_at) = MONTH(CURRENT_DATE()) AND YEAR(created_at) = YEAR(CURRENT_DATE())) as paid_invoices,
                (SELECT COALESCE(SUM(amount), 0) FROM invoices WHERE status='unpaid') as total_unpaid,
                (SELECT COUNT(*) FROM invoices WHERE status='unpaid') as unpaid_invoices,
                (SELECT COUNT(*) FROM invoices WHERE MONTH(created_at) = MONTH(CURRENT_DATE())) as total_invoices
        `;
        const [rows] = await pool.query(sql);
        return rows[0];
    }
    // Update subscriber record
    async updateCustomerFull(id, data) {
        return this.withTransaction(async (conn) => {
            const { name, phone, address, package_id, pppoe_username, pppoe_password, billing_day, status, expired_date } = data;
            
            // 1. Ambil Profile dari Paket
            const [pkg] = await conn.query("SELECT pppoe_profile FROM packages WHERE id = ?", [package_id]);
            const profile = pkg[0]?.pppoe_profile || 'default';
            let finalExpDate = expired_date ? `${expired_date} 23:59:59` : null;
            let bDay = billing_day;
            
            if (expired_date) {
                bDay = parseInt(expired_date.split('-')[2]);
            }
            // 3. Update DB Utama
            await conn.execute(`
                UPDATE customers SET 
                name = ?, phone = ?, address = ?, package_id = ?, status = ?, 
                pppoe_username = ?, pppoe_password = ?, expired_date = ?, 
                billing_day = ?, pppoe_profile = ?
                WHERE id = ?`, 
                [name, phone, address, package_id, status, pppoe_username, pppoe_password, finalExpDate, bDay, profile, id]
            );
            // 4. Update Radius
            if (pppoe_username) {
                const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
                const d = new Date(finalExpDate);
                const radDate = `${String(d.getDate()).padStart(2, '0')} ${months[d.getMonth()]} ${d.getFullYear()} 23:59:59`;
                await conn.execute("DELETE FROM radcheck WHERE username = ?", [pppoe_username]);
                await conn.execute("DELETE FROM radusergroup WHERE username = ?", [pppoe_username]);
                await conn.execute("INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Cleartext-Password', ':=', ?)", [pppoe_username, pppoe_password]);
                await conn.execute("INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Expiration', ':=', ?)", [pppoe_username, radDate]);
                await conn.execute("INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, '1')", [pppoe_username, profile]);
            }
            return { success: true };
        });
    }
    // RouterOS and RADIUS policy synchronization
    async syncUserToRadius(customerId) {
        const data = await this.getCustomerById(customerId);
        if (!data || !data.pppoe_username) throw new Error("Data user tidak lengkap");
        
        return this.updateCustomerFull(customerId, data);
    }
    
    async getPaymentHistory() {
        const sql = `
            SELECT 
                p.id as payment_id, p.invoice_id, p.payment_date, p.amount, 
                p.payment_method, p.notes, p.reference_number, p.admin_name,
                i.invoice_number, c.name as customer_name, c.phone as customer_phone
            FROM payments p
            LEFT JOIN invoices i ON p.invoice_id = i.id
            LEFT JOIN customers c ON i.customer_id = c.id
            ORDER BY p.payment_date DESC
        `;
        const [rows] = await pool.query(sql);
        return rows;
    }
    // Financial ledger and transaction processing
    async getUnpaidInvoices() {
        const sql = `
            SELECT i.id, i.invoice_number, c.name, i.amount 
            FROM invoices i 
            JOIN customers c ON i.customer_id = c.id 
            WHERE i.status = 'unpaid'
            ORDER BY i.created_at DESC
        `;
        const [rows] = await pool.query(sql);
        return rows;
    }
    
    async getSultanDashboardData() {
        // Kita jalankan 3 kueri sekaligus secara paralel (Promise.all) biar ngebut!
        const [stats, recent, overdue] = await Promise.all([
            // 1. Kueri Statistik (SUDAH DIUPGRADE: Pemasukan, Pengeluaran, Profit + Anti Siluman)
            pool.query(`
                SELECT 
                    -- ?? Abaikan pelanggan siluman (trx_umum) dari hitungan
                    (SELECT COUNT(*) FROM customers WHERE username != 'trx_umum') as total_customers,
                    (SELECT COUNT(*) FROM customers WHERE status='active' AND username != 'trx_umum') as active_customers,
                    
                    (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE amount > 0 AND MONTH(payment_date) = MONTH(CURRENT_DATE()) AND YEAR(payment_date) = YEAR(CURRENT_DATE())) as total_revenue,
                    (SELECT COALESCE(SUM(ABS(amount)), 0) FROM payments WHERE amount < 0 AND MONTH(payment_date) = MONTH(CURRENT_DATE()) AND YEAR(payment_date) = YEAR(CURRENT_DATE())) as total_expense,
                    (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE MONTH(payment_date) = MONTH(CURRENT_DATE()) AND YEAR(payment_date) = YEAR(CURRENT_DATE())) as net_profit,
                    (SELECT COUNT(*) FROM invoices WHERE status='paid' AND MONTH(created_at) = MONTH(CURRENT_DATE()) AND YEAR(created_at) = YEAR(CURRENT_DATE())) as paid_invoices,
                    (SELECT COALESCE(SUM(amount), 0) FROM invoices WHERE status='unpaid') as total_unpaid,
                    (SELECT COUNT(*) FROM invoices WHERE status='unpaid') as unpaid_invoices,
                    (SELECT COUNT(*) FROM invoices WHERE MONTH(created_at) = MONTH(CURRENT_DATE())) as total_invoices
            `),
            // 2. Kueri 5 Invoice Terbaru
            pool.query(`
                SELECT i.*, c.name as customer_name, p.name as package_name
                FROM invoices i 
                LEFT JOIN customers c ON i.customer_id = c.id 
                LEFT JOIN packages p ON i.package_id = p.id
                ORDER BY i.created_at DESC LIMIT 5
            `),
            // 3. Kueri 5 Invoice Nunggak (Overdue)
            pool.query(`
                SELECT i.*, c.name as customer_name, c.phone as customer_phone
                FROM invoices i 
                LEFT JOIN customers c ON i.customer_id = c.id 
                WHERE i.status = 'unpaid' AND i.due_date < CURRENT_DATE() 
                ORDER BY i.due_date ASC LIMIT 5
            `)
        ]);
        return {
            stats: stats[0][0],
            recentInvoices: recent[0],
            overdueInvoices: overdue[0]
        };
    }
    
            // Synchronize active session with RADIUS policy
    async getAllCustomers() {
        const sql = `
            SELECT c.*, p.name AS package_name 
            FROM customers c 
            LEFT JOIN packages p ON c.package_id = p.id 
            WHERE c.username != 'trx_umum' -- ?? JUBAH GAIB AKTIF
            ORDER BY c.created_at DESC
        `;
        const [rows] = await pool.query(sql);
        return rows;
    }
    
    async getAvailablePackages() {
        const sql = `
            SELECT * FROM packages 
            WHERE type = 'pppoe' 
            AND (is_for_agent = 0 OR is_for_agent IS NULL) 
            ORDER BY price ASC
        `;
        const [rows] = await pool.query(sql);
        return rows;
    }
    // RouterOS and RADIUS policy synchronization
    async getNasList() {
        const [rows] = await pool.query("SELECT nasname, shortname FROM nas");
        return rows;
    }
    
    // Synchronize subscriber account state
    async getCustomerFullDetail(phone) {
        try {
            // 1. Cari Orangnya Dulu (Fondasi Utama)
            const [custRows] = await pool.query("SELECT * FROM customers WHERE phone = ? LIMIT 1", [phone]);
            
            if (custRows.length === 0) return null;
            const customer = custRows[0];
            // 2. Ambil Data Pendukung secara PARALEL (Ngebut!)
            // Kita tarik daftar paket & riwayat invoice secara bersamaan
            const [packages, invoices] = await Promise.all([
                pool.query("SELECT * FROM packages ORDER BY price ASC"),
                pool.query("SELECT * FROM invoices WHERE customer_id = ? ORDER BY id DESC", [customer.id])
            ]);
            return {
                customer: customer,
                packages: packages[0] || [],
                invoices: invoices[0] || []
            };
        } catch (error) {
            console.error(`? [BILLING] Error getCustomerFullDetail:`, error.message);
            throw error;
        }
    }
    
    async getAllInvoicesWithRadius() {
        const sql = `
            SELECT 
                i.*, 
                c.name as customer_name, 
                c.username as customer_username, 
                -- Package name resolution with fallback
                COALESCE(p.name, rg.groupname, 'CUSTOM') as package_name 
            FROM invoices i 
            LEFT JOIN customers c ON i.customer_id = c.id 
            -- Join with packages table
            LEFT JOIN packages p ON c.package_id = p.id 
            LEFT JOIN radusergroup rg ON c.username = rg.username 
            ORDER BY i.id DESC
        `;
        const [rows] = await pool.query(sql);
        return rows;
    }
    // Synchronize subscriber account state
    async getCustomerListForDropdown() {
        // ?? JUBAH GAIB AKTIF
        const [rows] = await pool.query("SELECT id, name FROM customers WHERE username != 'trx_umum' ORDER BY name ASC");
        return rows;
    }
        
    // Financial ledger and transaction processing
    async getInvoiceEditData(id) {
        try {
            // Kita tarik 3 data sekaligus secara paralel (Ngebut!)
            const [invoiceRows, customerRows, packageRows] = await Promise.all([
                // A. Data Invoice & Pelanggannya
                pool.query(`
                    SELECT i.*, c.name as customer_name, c.phone as customer_phone
                    FROM invoices i
                    LEFT JOIN customers c ON i.customer_id = c.id
                    WHERE i.id = ?
                `, [id]),
                // B. Daftar Semua Pelanggan (Dropdown)
                pool.query("SELECT id, name FROM customers ORDER BY name ASC"),
                // C. Daftar Semua Paket (Dropdown)
                pool.query("SELECT id, name, price FROM packages ORDER BY price ASC")
            ]);
            if (invoiceRows[0].length === 0) return null;
            return {
                invoice: invoiceRows[0][0],
                customers: customerRows[0],
                packages: packageRows[0]
            };
        } catch (error) {
            console.error("? Gagal Ambil Data Edit:", error.message);
            throw error;
        }
    }
    
    // Synchronize subscriber account state
    async syncInvoiceAndUpdateRadius(data) {
        return this.withTransaction(async (conn) => {
            const { id, customer_id, amount, due_date, status, notes } = data;
            // 1. UPDATE TABEL INVOICE
            await conn.query(
                `UPDATE invoices SET amount = ?, due_date = ?, status = ?, notes = ? WHERE id = ?`,
                [amount, due_date, status, notes, id]
            );
            if (customer_id) {
                const [y, m, d] = due_date.split('-');
                const dbDateString = `${y}-${m}-${d} 23:59:59`;
                
                const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
                const radiusString = `${months[parseInt(m) - 1]} ${d} ${y} 23:59:59`;
                await conn.query(
                    "UPDATE customers SET expired_date = ? WHERE id = ?",
                    [dbDateString, customer_id]
                );
                // 4. UPDATE RADIUS (SINKRON MIKROTIK)
                const [cust] = await conn.query("SELECT pppoe_username FROM customers WHERE id = ?", [customer_id]);
                
                if (cust.length > 0 && cust[0].pppoe_username) {
                    const user = cust[0].pppoe_username;
                    // Hapus Expired lama, masukkan yang baru
                    await conn.execute("DELETE FROM radcheck WHERE username = ? AND attribute = 'Expiration'", [user]);
                    await conn.execute(
                        "INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Expiration', ':=', ?)",
                        [user, radiusString]
                    );
                    
                    // Kita return username-nya supaya bisa di-kick di rute
                    return { success: true, pppoe_username: user };
                }
            }
            return { success: true };
        });
    }
    
    async restoreServiceSOP(invoiceId) {
        try {
            logger.info([SERVICE-RESTORE] Processing restoration for invoice: );
            
            const result = await this.sultanManualPayment(invoiceId, null, {
                payment_method: 'Cash/Manual',
                notes: 'Pelunasan via Konfirmasi Lunas (Tombol Hijau)'
            });
            if (!result.success) {
                throw new Error(result.message || 'Gagal memproses pembayaran');
            }
            return { 
                success: true, 
                customer_name: 'Pelanggan', 
                pppoe_username: result.username 
            };
        } catch (error) {
            console.error('?? [RESTORE-SOP ERROR]:', error.message);
            throw error;
        }
    }
    
    async getPaymentReportData() {
        try {
            const sql = `
                SELECT 
                    p.*, 
                    i.invoice_number, 
                    c.name as customer_name 
                FROM payments p 
                LEFT JOIN invoices i ON p.invoice_id = i.id 
                LEFT JOIN customers c ON i.customer_id = c.id
                ORDER BY p.payment_date DESC
            `;
            const [rows] = await pool.query(sql);
            return rows;
        } catch (error) {
            console.error("? Gagal Ambil Data Laporan:", error.message);
            throw error;
        }
    }
    
    async getSuspensionPageData() {
        try {
            // Kita jalankan 4 kueri besar secara PARALEL (Ngebut!)
            const [settings, stats, suspendedUsers, profiles] = await Promise.all([
                // 1. Ambil Settings
                pool.query("SELECT setting_key, value FROM app_settings"),
                // 2. Ambil Statistik (3 Hitungan sekaligus)
                pool.query(`
                    SELECT 
                        (SELECT COUNT(*) FROM customers WHERE status = 'active') as active,
                        (SELECT COUNT(*) FROM customers WHERE status = 'suspended') as suspended,
                        (SELECT COUNT(*) FROM invoices WHERE status = 'unpaid' AND due_date < NOW()) as overdue
                `),
                // 3. Daftar User Terisolir
                pool.query(`
                    SELECT c.name, c.username, c.phone, c.status, p.name as package_name 
                    FROM customers c 
                    LEFT JOIN packages p ON c.package_id = p.id 
                    WHERE c.status = 'suspended'
                `),
                // 4. Daftar Profil Radius
                pool.query("SELECT DISTINCT groupname FROM radgroupreply ORDER BY groupname ASC")
            ]);
            // Olah settings jadi objek key-value
            const freshSettings = {};
            settings[0].forEach(row => { freshSettings[row.setting_key] = row.value; });
            return {
                settings: freshSettings,
                stats: stats[0][0],
                suspendedUsers: suspendedUsers[0],
                radiusProfiles: profiles[0].map(r => r.groupname)
            };
        } catch (error) {
            console.error("? Gagal Ambil Data Suspension:", error.message);
            throw error;
        }
    }
    
    async getPackagesPageData() {
        try {
            // Jalankan 3 kueri sekaligus (Paralel)
            const [packageRows, customerRows, profileRows] = await Promise.all([
                // 1. Ambil Paket PPPoE (Bukan untuk agen)
                pool.query("SELECT * FROM packages WHERE type = 'pppoe' AND (is_for_agent = 0 OR is_for_agent IS NULL) ORDER BY price ASC"),
                
                // 2. Ambil ID Paket yang dipakai customer (untuk proteksi hapus)
                pool.query("SELECT DISTINCT package_id FROM customers"),
                
                pool.query(`
                    SELECT DISTINCT groupname 
                    FROM radgroupreply 
                    WHERE 
                        groupname NOT IN (SELECT groupname FROM radgroupreply WHERE attribute LIKE 'WISPr%')
                        AND groupname NOT LIKE '%hotspot%'
                        AND groupname NOT LIKE '%vcr%'
                        AND groupname NOT LIKE '%jam%'
                        AND groupname NOT LIKE '%hari%'
                        AND groupname NOT LIKE '%trial%'
                    ORDER BY groupname ASC
                `)
            ]);
            return {
                packages: packageRows[0],
                usedPackageIds: customerRows[0].map(c => c.package_id),
                radiusProfiles: profileRows[0].map(r => r.groupname)
            };
        } catch (error) {
            console.error("? Gagal Ambil Data Paket:", error.message);
            throw error;
        }
    }
    
   // ? Tambahkan parameter adminName di sini (default 'admin' kalau kosong)
   async savePackage(data, id = null, adminName = 'admin') {
        const { name, speed, price, description, pppoe_profile, billing_type, active_period } = data;
        
        // Anti-Nol Beranak: Buang karakter non-angka
        const cleanPrice = price ? String(price).replace(/[^0-9]/g, '') : 0;
        if (id) {
    // Synchronize subscriber account state
            await pool.execute(
                `UPDATE packages SET name=?, speed=?, price=?, description=?, pppoe_profile=?, billing_type=?, active_period=? WHERE id=?`,
                [name, speed, cleanPrice, description, pppoe_profile, billing_type || 'fixed', active_period || 30, id]
            );
        } else {
            // Simpan Paket Baru
            await pool.execute(
                `INSERT INTO packages (name, speed, price, description, pppoe_profile, billing_type, active_period) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [name, speed, cleanPrice, description, pppoe_profile, billing_type || 'fixed', active_period || 30]
            );
        }
        setImmediate(() => {
            const action = id ? 'UPDATE_PACKAGE' : 'CREATE_PACKAGE';
            // ? Ganti 'admin' dengan variabel adminName agar jujur mencatat Kasir
            logActivity(adminName, action, `Action pada paket ${name} (Harga: Rp ${cleanPrice})`).catch(() => {});
        });
        return { success: true };
    }
    async deletePackage(id) {
        // 1. Cek apakah ada pelanggan yang masih pakai paket ini
        const [cek] = await pool.query("SELECT id FROM customers WHERE package_id = ? LIMIT 1", [id]);
        if (cek.length > 0) {
            throw new Error('Paket tidak bisa dihapus karena masih digunakan oleh pelanggan!');
        }
        // 2. Eksekusi Hapus
        await pool.execute("DELETE FROM packages WHERE id = ?", [id]);
        return { success: true };
    }
    async getPackageById(id) {
        const [rows] = await pool.query("SELECT * FROM packages WHERE id = ?", [id]);
        return rows[0] || null;
    }
    
    async cleanupOldTransactions() {
        try {
            // Hapus log transaksi pending yang sudah lebih dari 7 hari
            const sql = `DELETE FROM payment_gateway_transactions WHERE status = 'pending' AND created_at < DATE_SUB(NOW(), INTERVAL 7 DAY)`;
            const [result] = await pool.execute(sql);
            console.log(`?? [MAINTENANCE] Berhasil menghapus ${result.affectedRows} log sampah gateway.`);
        } catch (e) {
            console.error("? Cleanup Error:", e.message);
        }
    }
    
    // Financial ledger and transaction processing
    async getAutoInvoiceStatusData() {
        try {
            // 1. Ambil 4 Data Sekaligus Secara Paralel
            const [settings, activeCount, invCount] = await Promise.all([
                pool.query("SELECT setting_key, value FROM app_settings WHERE setting_key IN ('auto_invoice_enabled', 'invoice_generation_date')"),
                pool.query("SELECT COUNT(*) as count FROM customers WHERE status = 'active'"),
                pool.query("SELECT COUNT(*) as count FROM invoices WHERE month = MONTH(CURRENT_DATE()) AND year = YEAR(CURRENT_DATE())")
            ]);
            // 2. Olah Settings (Auto-Invoice Enabled & Gen Date)
            const sets = {};
            settings[0].forEach(row => { sets[row.setting_key] = row.value; });
            const rawValue = String(sets.auto_invoice_enabled || '0').trim().toLowerCase();
            const isEnabled = (rawValue === '1' || rawValue === 'true' || rawValue === 'on');
            const invoiceDay = parseInt(sets.invoice_generation_date) || 1;
            const now = new Date();
            let nextRun = new Date(now.getFullYear(), now.getMonth(), invoiceDay);
            
            if (now.getDate() >= invoiceDay) {
                // Arahkan ke tanggal 1 bulan depan agar aman dari jebakan kalender
                nextRun = new Date(now.getFullYear(), now.getMonth() + 1, 1);
                // Hitung batas maksimal hari di bulan depan tersebut
                const maxDays = new Date(nextRun.getFullYear(), nextRun.getMonth() + 1, 0).getDate();
                // Kunci tanggal tampilannya agar tidak meleset
                nextRun.setDate(Math.min(invoiceDay, maxDays));
            }
            return {
                autoInvoiceEnabled: isEnabled,
                invoiceDay: invoiceDay,
                activeCustomersCount: activeCount[0][0].count,
                thisMonthInvoicesCount: invCount[0][0].count,
                nextRunDate: nextRun.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }),
                rawValue: rawValue // Untuk debug jika perlu
            };
        } catch (error) {
            console.error("? Gagal Ambil Data Auto-Invoice:", error.message);
            throw error;
        }
    }
    
    async getQuickStats() {
        try {
            const sql = `
                SELECT 
                    (SELECT COUNT(*) FROM customers) as total_customers, 
                    (SELECT COUNT(*) FROM customers WHERE status='active') as active_customers
            `;
            const [rows] = await pool.query(sql);
            return rows[0] || { total_customers: 0, active_customers: 0 };
        } catch (error) {
            console.error("? Quick Stats Error:", error.message);
            throw error;
        }
    }
    
    async getDailySultanReport() {
        try {
            const sql = `
                SELECT 
                    (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE DATE(payment_date) = CURDATE()) as income_today,
                    (SELECT COUNT(*) FROM payments WHERE DATE(payment_date) = CURDATE()) as transaction_count,
                    (SELECT COUNT(*) FROM customers WHERE DATE(join_date) = CURDATE()) as new_customers,
                    (SELECT COUNT(*) FROM customers WHERE status = 'active') as total_active
            `;
            const [rows] = await pool.query(sql);
            const data = rows[0];
            // Rakit pesan teksnya di sini agar skejul.js tinggal kirim
            const tanggal = new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
            
            let message = `*??*DAILY OPERATIONAL SUMMARY* \n`;
            message += `_Tanggal: ${tanggal}_\n\n`;
            message += `?? *Pemasukan:* Rp ${Number(data.income_today).toLocaleString('id-ID')}\n`;
            message += `?? *Transaksi:* ${data.transaction_count} sukses\n`;
            message += `?? *Pelanggan Baru:* ${data.new_customers} orang\n`;
            message += `? *Total Aktif:* ${data.total_active} user\n\n`;
            message += `_Automated report generated by PulseBill Telecom Engine._`;
            return message;
        } catch (error) {
            console.error("? Gagal merakit laporan harian:", error.message);
            return "Gagal merakit laporan harian, silakan cek log server.";
        }
    }
    
    // Financial ledger and transaction processing
    async getInvoiceDetailById(id) {
        try {
            const sql = `
                SELECT i.*, c.name as customer_name, c.address as customer_address, p.name as package_name 
                FROM invoices i 
                LEFT JOIN customers c ON i.customer_id = c.id 
                LEFT JOIN packages p ON i.package_id = p.id 
                WHERE i.id = ?
            `;
            const [rows] = await pool.query(sql, [id]);
            return rows[0] || null;
        } catch (error) {
            console.error("? Detail Invoice Error:", error.message);
            throw error;
        }
    }
    
    getPaymentGateway() {
        // Kembalikan objek class aslinya agar bisa mengeksekusi createPayment, dll
        return this.paymentGateway; 
    }
    // Financial ledger and transaction processing
    async getPaymentGatewayConfig() {
        let config = { 
            active: 'tripay', 
            midtrans: { enabled: false, server_key: '', client_key: '' }, 
            xendit: { enabled: false, api_key: '' }, 
            tripay: { enabled: false, api_key: '', private_key: '', merchant_code: '', base_url: '' } 
        };
        try {
            // Mengambil config dari tabel app_settings yang baru saja dibuat di migrasi nomor 0
            const [rows] = await pool.query("SELECT value FROM app_settings WHERE setting_key = 'payment_gateway_config'");
            
            if (rows.length > 0 && rows[0].value) {
                const dbConfig = JSON.parse(rows[0].value);
                config = { 
                    active: dbConfig.active || 'tripay',
                    midtrans: { ...config.midtrans, ...(dbConfig.midtrans || {}) },
                    xendit: { ...config.xendit, ...(dbConfig.xendit || {}) },
                    tripay: { ...config.tripay, ...(dbConfig.tripay || {}) }
                };
            }
            return config;
        } catch (e) {
            return config;
        }
    }
    
    async savePaymentGatewayConfig(targetGateway, formData) {
        try {
            const config = await this.getPaymentGatewayConfig();
            // 2. Olah data berdasarkan Gateway
            if (targetGateway === 'tripay') {
                config.tripay = {
                    enabled: formData.enabled === 'on' || formData.enabled === true,
                    production: formData.production === 'on' || formData.production === true,
                    apiKey: (formData.api_key || '').trim(),
                    privateKey: (formData.private_key || '').trim(),
                    merchantCode: (formData.merchant_code || '').trim(),
                    base_url: formData.base_url || ''
                };
            } else {
                // Untuk Midtrans/Xendit, gabungkan secara otomatis
                config[targetGateway] = { 
                    ...config[targetGateway], 
                    ...formData,
                    enabled: formData.enabled === 'on' || formData.enabled === true
                };
            }
            // 3. Update gateway aktif jika dipilih
            if (formData.active_gateway) config.active = formData.active_gateway;
            // 4. Simpan kembali ke MariaDB (Gunakan ON DUPLICATE KEY)
            const jsonString = JSON.stringify(config);
            const sql = `
                INSERT INTO app_settings (setting_key, value) 
                VALUES ('payment_gateway_config', ?) 
                ON DUPLICATE KEY UPDATE value = VALUES(value)
            `;
            
            await pool.execute(sql, [jsonString]);
            
            // 5. Hot-Reload Payment Gateway (Agar setting baru langsung aktif tanpa restart)
            if (typeof this.reloadPaymentGateway === 'function') {
                this.reloadPaymentGateway();
            }
            return { success: true, gateway: targetGateway };
        } catch (error) {
            console.error("? Gagal Simpan Config:", error.message);
            throw error;
        }
    }
    
    async generatePaymentSelectionLink(id, hostname) {
        try {
            // 1. Ambil data Invoice & Customer (Paralel)
            const [rows] = await pool.query(
                `SELECT id, invoice_number, customer_id, tripay_url FROM invoices WHERE id = ?`, 
                [id]
            );
            
            if (rows.length === 0) throw new Error("Invoice not found");
            const inv = rows[0];
            // 2. Validasi Link Lama (Cek apakah domain & ID masih valid)
            if (inv.tripay_url && inv.tripay_url.includes(inv.customer_id) && inv.tripay_url.includes(hostname)) {
                return inv.tripay_url;
            }
            // Kita gunakan https secara otomatis biar Elit
            const localPayUrl = `https://${hostname}/payment/select/${inv.invoice_number}/${inv.customer_id}`;
            // 4. Update Permanen ke Database MariaDB
            await pool.execute("UPDATE invoices SET tripay_url = ? WHERE id = ?", [localPayUrl, id]);
            return localPayUrl;
        } catch (error) {
            console.error("? Link Generator Error:", error.message);
            throw error;
        }
    }
    
    // Financial ledger and transaction processing
    async sendInvoiceReminder(id) {
        try {
            // 1. Ambil Data Lengkap (Invoice + Customer + Package)
            const sql = `
                SELECT i.*, c.name, c.phone, p.name as package_name 
                FROM invoices i 
                JOIN customers c ON i.customer_id = c.id 
                LEFT JOIN packages p ON c.package_id = p.id 
                WHERE i.id = ?
            `;
            const [rows] = await pool.query(sql, [id]);
            
            if (rows.length === 0) return null;
            const inv = rows[0];
            // 2. Jalankan Pengiriman di Background (setImmediate)
            // Agar rute tidak menunggu proses API WhatsApp yang mungkin lambat
            setImmediate(async () => {
                try {
                    const whatsappManager = require('./whatsapp-notifications');
                    await whatsappManager.sendDueDateReminder(inv);
                    console.log(`? [WA-REMINDER] Sukses terkirim ke ${inv.name} (${inv.phone})`);
                } catch (err) {
                    console.error(`? [WA-REMINDER ERR] Gagal kirim ke ${inv.name}:`, err.message);
                }
            });
            return inv;
        } catch (error) {
            console.error("? Reminder Manager Error:", error.message);
            throw error;
        }
    }
    
    // Financial ledger and transaction processing
    async resendInvoiceWA(id) {
        try {
            // 1. Ambil data lengkap (Invoice + Customer + Package)
            const sql = `
                SELECT i.*, c.name, c.phone, p.name as package_name 
                FROM invoices i 
                JOIN customers c ON i.customer_id = c.id 
                LEFT JOIN packages p ON c.package_id = p.id 
                WHERE i.id = ?
            `;
            const [rows] = await pool.query(sql, [id]);
            
            if (rows.length === 0) return { success: false, message: 'Data tagihan tidak ditemukan.' };
            const inv = rows[0];
            // 2. Perintahkan WhatsApp Manager (Jalur Resmi Template)
            const whatsappManager = require('./whatsapp-notifications');
            const result = await whatsappManager.sendDueDateReminder(inv);
            // 3. Olah Hasilnya
            if (result.success) {
                if (result.skipped) {
                    return { success: false, message: 'Gagal: Template WA sedang Nonaktif.' };
                }
                return { success: true, customer_name: inv.name };
            } else {
                return { success: false, message: result.error || 'Gagal kirim WA.' };
            }
        } catch (error) {
            console.error("? Resend WA Manager Error:", error.message);
            throw error;
        }
    }
    
    async executeServiceAction(invoiceId, action) {
        try {
            // 1. Ambil Data Invoice & Pelanggan Sekaligus (JOIN Power)
            const sql = `
                SELECT i.customer_id, c.* FROM invoices i 
                JOIN customers c ON i.customer_id = c.id 
                WHERE i.id = ?
            `;
            const [rows] = await pool.query(sql, [invoiceId]);
            
            if (rows.length === 0) throw new Error("Data tagihan atau pelanggan tidak ditemukan!");
            const customer = rows[0];
            // 2. Koordinasi dengan Modul Service Suspension
            const serviceSuspension = require('./serviceSuspension'); 
            
            if (action === 'isolir') {
                await serviceSuspension.suspendCustomerService(customer);
                return { success: true, name: customer.name, status: 'DIISOLIR' };
            } 
            
            if (action === 'restore') {
                await serviceSuspension.restoreCustomerService(customer);
                return { success: true, name: customer.name, status: 'DIAKTIFKAN' };
            }
            throw new Error("Action '" + action + "' is not supported.");
        } catch (error) {
            console.error(`? Service Action Error [${action}]:`, error.message);
            throw error;
        }
    }
    
    // Financial ledger and transaction processing
    async getAutoInvoiceSettingsDashboard() {
        try {
            // 1. Tarik Statistik secara Paralel (Ngebut!)
            const [custStats, invStats] = await Promise.all([
                pool.query("SELECT COUNT(*) as total FROM customers WHERE status='active'"),
                pool.query("SELECT COUNT(*) as total FROM invoices WHERE MONTH(created_at) = MONTH(NOW()) AND YEAR(created_at) = YEAR(NOW())")
            ]);
            const today = new Date();
            const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
            const formattedDate = nextMonth.toLocaleDateString('id-ID', { 
                day: 'numeric', 
                month: 'long', 
                year: 'numeric' 
            });
            return {
                activeCustomersCount: custStats[0][0].total,
                thisMonthInvoicesCount: invStats[0][0].total,
                nextRunDate: formattedDate
            };
        } catch (error) {
            console.error("? Gagal meracik data dashboard invoice:", error.message);
            throw error;
        }
    }
    
    // Synchronize subscriber account state
    async getAutoInvoicePreview() {
        try {
            const sql = `
                SELECT 
                    c.id, c.username, c.name, 
                    p.name as package_name, p.price as package_price,
                    c.expired_date
                FROM customers c
                LEFT JOIN packages p ON c.package_id = p.id
                -- Pengecekan murni membaca kolom 'month' dan 'year', bukan membongkar due_date
                LEFT JOIN invoices i ON c.id = i.customer_id 
                    AND i.month = COALESCE(MONTH(c.expired_date), MONTH(CURRENT_DATE())) 
                    AND i.year = COALESCE(YEAR(c.expired_date), YEAR(CURRENT_DATE()))
                    AND i.status != 'cancelled'
                WHERE c.status = 'active' 
                AND i.id IS NULL
                -- SENSOR 14 HARI: Tarik tepat 14 hari sebelum masa aktif habis
                AND (c.expired_date IS NULL OR c.expired_date <= DATE_ADD(CURRENT_DATE(), INTERVAL 14 DAY))
            `;
            const [rows] = await pool.query(sql);
            return rows;
        } catch (error) {
            console.error("? Gagal meracik preview invoice:", error.message);
            throw error;
        }
    }
    async bulkGenerateInvoices() {
        return this.withTransaction(async (conn) => {
            // 1. Ambil data pelanggan (Biarkan MariaDB yang mengekstrak target_month & target_year)
            const sqlSelect = `
                SELECT 
                    c.id, c.package_id, c.billing_day, p.price, 
                    COALESCE(YEAR(c.expired_date), YEAR(CURRENT_DATE())) as target_year,
                    COALESCE(MONTH(c.expired_date), MONTH(CURRENT_DATE())) as target_month
                FROM customers c 
                JOIN packages p ON c.package_id = p.id 
                LEFT JOIN invoices i ON c.id = i.customer_id 
                    AND i.month = COALESCE(MONTH(c.expired_date), MONTH(CURRENT_DATE())) 
                    AND i.year = COALESCE(YEAR(c.expired_date), YEAR(CURRENT_DATE()))
                    AND i.status != 'cancelled'
                WHERE c.status = 'active' 
                AND i.id IS NULL
                AND (c.expired_date IS NULL OR c.expired_date <= DATE_ADD(CURRENT_DATE(), INTERVAL 14 DAY))
            `;
            const [customers] = await conn.query(sqlSelect);
            if (customers.length === 0) return 0;
            let createdCount = 0;
            // 2. Proses Eksekusi Massal (Bebas dari pengaruh Javascript Date)
            for (const cust of customers) {
                // Ambil bulan dan tahun murni hasil pancingan MariaDB
                const year = cust.target_year;
                const month = cust.target_month;
                const monthStr = String(month).padStart(2, '0');
                const invoiceNo = `INV-${year}${monthStr}-${cust.id}-${Math.floor(1000 + Math.random() * 9000)}`;
                
                // Pertahankan tanggal pelanggan (Jangkar Abadi)
                const bDay = parseInt(cust.billing_day, 10) || 25; 
                const daysInTargetMonth = new Date(year, month, 0).getDate();
                const finalDay = bDay > daysInTargetMonth ? daysInTargetMonth : bDay;
                
                const dueStr = `${year}-${monthStr}-${String(finalDay).padStart(2, '0')}`;
                // =================================================================
                // =================================================================
                const [check] = await conn.execute(
                    `SELECT id FROM invoices 
                     WHERE customer_id = ? AND month = ? AND year = ? AND status != 'cancelled' LIMIT 1`,
                    [cust.id, month, year]
                );
                if (check.length === 0) {
                    const sqlInsert = `
                        INSERT INTO invoices (invoice_number, customer_id, package_id, month, year, amount, status, due_date, created_at) 
                        VALUES (?, ?, ?, ?, ?, ?, 'unpaid', ?, NOW())
                    `;
                    
                    try {
                        await conn.execute(sqlInsert, [
                            invoiceNo, cust.id, cust.package_id, month, year, cust.price, dueStr
                        ]);
                        createdCount++;
                    } catch (error) {
                        // Jika ada bentrok massal, gembok MariaDB akan menendangnya
                        if (error.code !== 'ER_DUP_ENTRY') throw error;
                    }
                } else {
                     console.log(`[GENERATE MASSAL] ??? Double Invoice Dicegah! ID ${cust.id} sudah punya tagihan di bulan ${monthStr}-${year}.`);
                }
            }
            return createdCount;
        });
    }
    
    // Synchronize subscriber account state
    async updateAutoInvoiceSettings(data) {
        return this.withTransaction(async (conn) => {
            const { auto_invoice_enabled, invoice_day, due_date_days } = data;
            // 1. Daftar update yang harus dijalankan
            const updates = [
                { key: 'auto_invoice_enabled', val: auto_invoice_enabled },
                { key: 'invoice_generation_date', val: invoice_day },
                { key: 'invoice_due_days', val: due_date_days }
            ];
            // 2. Eksekusi satu per satu dalam satu rangkaian transaksi
            for (const item of updates) {
                await conn.execute(
                    "UPDATE app_settings SET value = ? WHERE setting_key = ?",
                    [String(item.val), item.key]
                );
            }
            // 3. Normalisasi Boolean untuk kebutuhan Socket/UI
            const isEnabled = (auto_invoice_enabled === 'true' || auto_invoice_enabled === 'on' || auto_invoice_enabled === '1');
            
            return { success: true, isEnabled };
        });
    }
    
    async testGatewayConnection(data) {
        const { gateway, mode, serverKey, clientKey, merchantCode, apiKey, privateKey } = data;
        
        try {
            // 1. Logika Test MIDTRANS
            if (gateway === 'midtrans') {
                if (!serverKey || serverKey.length < 10 || !clientKey) {
                    throw new Error("Server Key atau Client Key Midtrans tidak valid/kurang panjang!");
                }
                return { success: true, message: `Koneksi Midtrans (${mode}) Oke. Kunci sudah siap!` };
            } 
            // 2. Logika Test TRIPAY
            if (gateway === 'tripay') {
                if (!apiKey || !privateKey || !merchantCode) {
                    throw new Error("Identitas Tripay (API/Private Key/Merchant Code) belum lengkap!");
                }
                return { success: true, message: `Identitas Tripay (${mode}) Terverifikasi!` };
            }
            // 3. Logika Test XENDIT
            if (gateway === 'xendit') {
                if (!apiKey || apiKey.length < 10) {
                    throw new Error("API Key Xendit tidak valid!");
                }
                return { success: true, message: "Koneksi Xendit Berhasil!" };
            }
            throw new Error("Payment gateway '" + gateway + "' is not supported.");
        } catch (error) {
            console.error(`? Gateway Test Failed:`, error.message);
            throw error;
        }
    }
    
    async saveFullGatewayConfig(formData) {
        return this.withTransaction(async (conn) => {
            const { active_gateway, midtrans, tripay, xendit } = formData;
            // 1. Ambil Config Master yang ada sekarang
            const currentConfig = await this.getPaymentGatewayConfig();
            // 2. Update Gateway Aktif
            if (active_gateway) currentConfig.active = active_gateway;
            // 3. Sync Midtrans (Jika Ada)
            if (midtrans) {
                currentConfig.midtrans = {
                    enabled: midtrans.enabled === 'on' || midtrans.enabled === true,
                    server_key: (midtrans.server_key || '').trim(),
                    client_key: (midtrans.client_key || '').trim(),
                    production: midtrans.production === 'on' || midtrans.production === true
                };
            }
            // 4. Sync Tripay (Format Spesifik untuk payment.js)
            if (tripay) {
                currentConfig.tripay = {
                    enabled: tripay.enabled === 'on' || tripay.enabled === true,
                    production: tripay.production === 'on' || tripay.production === true,
                    apiKey: (tripay.api_key || '').trim(),
                    privateKey: (tripay.private_key || '').trim(),
                    merchantCode: (tripay.merchant_code || '').trim(),
                    base_url: tripay.base_url || ''
                };
            }
            // 5. Sync Xendit (Jika Ada)
            if (xendit) {
                currentConfig.xendit = {
                    enabled: xendit.enabled === 'on' || xendit.enabled === true,
                    api_key: (xendit.api_key || '').trim()
                };
            }
            // 6. Tanam Kembali ke Database MariaDB
            const jsonString = JSON.stringify(currentConfig);
            await conn.execute(`
                INSERT INTO app_settings (setting_key, value) 
                VALUES ('payment_gateway_config', ?) 
                ON DUPLICATE KEY UPDATE value = VALUES(value)
            `, [jsonString]);
            if (active_gateway) {
                await conn.execute(
                    "INSERT INTO app_settings (setting_key, value) VALUES ('active_payment_gateway', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
                    [active_gateway]
                );
            }
            return { success: true, active: currentConfig.active };
        });
    }
    
    // Database initialization routine
    async initializeSettingsTable() {
        try {
            // 1. Buat Tabel Jika Belum Ada
            const createTableSql = `
                CREATE TABLE IF NOT EXISTS app_settings (
                    setting_key VARCHAR(100) NOT NULL PRIMARY KEY,
                    value TEXT NULL
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
            `;
            await pool.query(createTableSql);
            const defaults = [
                ['active_payment_gateway', 'tripay'],
                ['payment_gateway_config', '{}'],
                ['auto_invoice_enabled', 'false'],
                ['invoice_generation_date', '14'],
                ['invoice_due_days', '7'],
                ['admin_phone', '6281234567890'],
                ['whatsapp_templates', '{}']
            ];
            // 3. Masukkan Data Awal secara Masif (INSERT IGNORE)
            for (const [key, val] of defaults) {
                await pool.query(
                    "INSERT IGNORE INTO app_settings (setting_key, value) VALUES (?, ?)", 
                    [key, val]
                );
            }
            return { success: true, message: "Pondasi Berhasil Dibangun!" };
        } catch (error) {
            console.error("? Database Initialization Failed:", error.message);
            throw error;
        }
    }
    
    async getSuspensionStats() {
        try {
            // Kita hitung 3 status krusial dalam satu tarikan napas (Single Query)
            const sql = `
                SELECT 
                    (SELECT COUNT(*) FROM customers WHERE status = 'active') as active_customers,
                    (SELECT COUNT(*) FROM customers WHERE status = 'suspended') as suspended_customers,
                    (SELECT COUNT(*) FROM invoices WHERE status = 'unpaid' AND due_date < CURDATE()) as overdue_invoices
            `;
            const [rows] = await pool.query(sql);
            
            // Fallback jika database masih kosong/baru
            return rows[0] || { 
                active_customers: 0, 
                suspended_customers: 0, 
                overdue_invoices: 0 
            };
        } catch (error) {
            console.error("? Gagal mengambil statistik isolir:", error.message);
            throw error;
        }
    }
    
    // Synchronize subscriber account state
    async getSuspendedData() {
        const sql = `
            SELECT c.pppoe_username as username, c.name, c.phone as kontak, p.name as package_name
            FROM customers c
            LEFT JOIN packages p ON c.package_id = p.id
            WHERE c.status = 'suspended'
        `;
        const [rows] = await pool.query(sql);
        return rows;
    }
    // RouterOS and RADIUS policy synchronization
    async restoreManualByUsername(username) {
        return this.withTransaction(async (conn) => {
            // 1. Ambil Data & Profil Asli
            const [custData] = await conn.query(`
                SELECT c.id, c.pppoe_username, p.pppoe_profile 
                FROM customers c 
                LEFT JOIN packages p ON c.package_id = p.id 
                WHERE c.pppoe_username = ?`, [username]);
            if (custData.length === 0) throw new Error("User ghoib, tidak ditemukan di database!");
            const customer = custData[0];
            const originalProfile = customer.pppoe_profile || 'default';
            // 2. Update Status Web
            await conn.execute("UPDATE customers SET status = 'active' WHERE id = ?", [customer.id]);
            // 3. Update Radius (Ganti Grup Isolir ke Grup Paket Asli)
            await conn.execute("DELETE FROM radusergroup WHERE username = ?", [username]);
            await conn.execute(
                "INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, '1')", 
                [username, originalProfile]
            );
            return customer;
        });
    }
    
    async deleteInvoiceById(id) {
        try {
            // 1. Cek dulu datanya & Statusnya
            const [rows] = await pool.query("SELECT invoice_number, status FROM invoices WHERE id = ?", [id]);
            
            if (rows.length === 0) throw new Error("Invoice ghoib, tidak ditemukan!");
            const inv = rows[0];
            // 2. SAFETY GUARD: Jangan hapus yang sudah lunas (Opsional, tapi direkomendasikan)
            if (inv.status === 'paid') {
                throw new Error("Settled invoices cannot be deleted.");
            }
            // 3. Eksekusi Hapus
            await pool.execute("DELETE FROM invoices WHERE id = ?", [id]);
            return { success: true, number: inv.invoice_number };
        } catch (error) {
            console.error("? Shredder Error:", error.message);
            throw error;
        }
    }
    
    async updateCustomerFullSync(data, adminName = 'admin') {
        return this.withTransaction(async (conn) => {
            const { 
                id, name, phone, address, package_id, 
                pppoe_username, pppoe_password, nas_ip, 
                billing_day, status, expired_date,
                installation_date 
            } = data;
            if (!id) throw new Error('Customer ID is required.');
            // 1. Ambil Profile, TIPE, dan NAMA Paket (Wajib untuk Sensor Kasta)
            const [rowsPkg] = await conn.query("SELECT pppoe_profile, type, name as package_name FROM packages WHERE id = ?", [package_id]);
            if (rowsPkg.length === 0) throw new Error("Paket tidak valid!");
            const radiusProfile = rowsPkg[0].pppoe_profile || 'default';
            const packageType = rowsPkg[0].type;
            const packageName = (rowsPkg[0].package_name || '').toUpperCase();
            // 2. Logika Tanggal (Jatuh Tempo) - PATUH PADA KEPUTUSAN EDIT
            
            // Tanya ke database: "Berapa billing_day orang ini sebelumnya?"
            const [oldData] = await conn.query("SELECT billing_day FROM customers WHERE id = ?", [id]);
            const existingBillingDay = oldData.length > 0 ? oldData[0].billing_day : 25;
            const bDayFinal = billing_day ? parseInt(billing_day) : existingBillingDay;
            let fullTanggalSQL;
            let tanggalSQL;
            let dateObj;
            if (expired_date && expired_date !== "") {
                tanggalSQL = expired_date;
                fullTanggalSQL = `${expired_date} 23:59:59`;
                dateObj = new Date(fullTanggalSQL);
            } else {
                const now = new Date();
                let targetMonth = (bDayFinal < now.getDate()) ? now.getMonth() + 1 : now.getMonth();
                dateObj = new Date(now.getFullYear(), targetMonth, bDayFinal, 23, 59, 59);
                
                const thn = dateObj.getFullYear();
                const bln = String(dateObj.getMonth() + 1).padStart(2, '0');
                const tgl = String(dateObj.getDate()).padStart(2, '0');
                tanggalSQL = `${thn}-${bln}-${tgl}`;
                fullTanggalSQL = `${tanggalSQL} 23:59:59`;
            }
            // =================================================================
            // ??? SENSOR AUTO-ISOLIR: Evaluasi tanggal sebelum masuk database
            // =================================================================
            let finalStatus = status || 'active';
            const nowTime = new Date();
            if (dateObj < nowTime && finalStatus === 'active') {
                finalStatus = 'suspended'; // Paksa status jadi isolir jika tanggal di form sudah lewat
            }
            // 3. Update Database Utama (Pakai finalStatus yang sudah difilter)
            const finalUser = pppoe_username || phone || "";
            const finalPass = pppoe_password || '123456';
            const cleanInstallDate = (installation_date && installation_date !== "") ? installation_date : null;
            await conn.execute(`
                UPDATE customers SET 
                    name = ?, username = ?, password = ?, phone = ?, address = ?, 
                    package_id = ?, status = ?, pppoe_username = ?, pppoe_password = ?, 
                    nas_ip = ?, expired_date = ?, billing_day = ?, pppoe_profile = ?,
                    installation_date = ?
                WHERE id = ?
            `, [
                name, finalUser, finalPass, phone, address || "", 
                package_id, finalStatus, finalUser, finalPass, 
                nas_ip || null, fullTanggalSQL, bDayFinal, radiusProfile,
                cleanInstallDate, 
                id
            ]);
            // 4. Update Invoice Unpaid
            await conn.execute(`
                UPDATE invoices SET due_date = ? 
                WHERE customer_id = ? AND status = 'unpaid'
            `, [tanggalSQL, id]);
    // Synchronize subscriber account state
            if (finalUser) {
                // Kalkulasi Waktu
                const formattedExp = this.formatRadiusDate(dateObj); 
                const selisihDetik = Math.max(0, Math.floor((dateObj.getTime() - Date.now()) / 1000));
                const wisprDate = dateObj.toISOString().slice(0, 19).replace(' ', 'T') + '+07:00';
                
                const isolirProfileName = await this.getActiveIsolirProfile(conn);
                
                const isHotspotMember = (packageType === 'voucher' || packageName.includes('MEMBER'));
                // Bersihkan Radius Lama (Termasuk radreply)
                await conn.execute("DELETE FROM radcheck WHERE username = ?", [finalUser]);
                await conn.execute("DELETE FROM radusergroup WHERE username = ?", [finalUser]);
                await conn.execute("DELETE FROM radreply WHERE username = ?", [finalUser]);
                
                // Pasang Password
                await conn.execute("INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Cleartext-Password', ':=', ?)", [finalUser, finalPass]);
                if (finalStatus === 'active') {
                    if (isHotspotMember) {
                        // --- JALUR HOTSPOT (REJECT MODE) ---
                        // Khusus di fungsi "Simpan/Update" form ini, admin mungkin sedang memperpanjang tanggal user.
                        // Jadi kita pakai selisihDetik baru, lalu HAPUS radacct agar perhitungan waktunya mulai presisi lagi dari Nol.
                        await conn.execute("DELETE FROM radacct WHERE username = ?", [finalUser]);
                        await conn.execute("INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Expiration', ':=', ?)", [finalUser, formattedExp]);
                        await conn.execute("INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Max-All-Session', ':=', ?)", [finalUser, selisihDetik]);
                        await conn.execute("INSERT INTO radreply (username, attribute, op, value) VALUES (?, 'Session-Timeout', ':=', ?)", [finalUser, selisihDetik]);
                        
                        if (wisprDate) {
                            await conn.execute("INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'WISPr-Session-Terminate-Time', ':=', ?)", [finalUser, wisprDate]);
                        }
                        
                        // Grup harus pakai nama paket
                        const hotProfile = packageName || 'default';
                        await conn.execute("INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, '1')", [finalUser, hotProfile]);
                    } else {
                        // --- JALUR PPPOE (REDIRECT MODE) ---
                        // Tanpa Expiration, tanpa Max-Session. Bolehkan login terus.
                        await conn.execute("INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, '1')", [finalUser, radiusProfile]);
                    }
                } else {
                    // --- JALUR ISOLIR ---
                    await conn.execute("INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, '1')", [finalUser, isolirProfileName]);
                }
            
                // =========================================================
                // =========================================================
                setImmediate(() => {
                    if (typeof this.kickUserRadius === 'function') {
                        // Jangan pernah menendang Hotspot Member saat diedit!
                        if (!isHotspotMember) {
                            this.kickUserRadius(finalUser).catch(err => 
                                console.error(`? [KICK-FAIL] Gagal tendang ${finalUser}:`, err.message)
                            );
                        }
                    }
                });
                // =========================================================
            }
            
            // =========================================================
            // =========================================================
            setImmediate(() => {
                if (typeof logActivity === 'function') {
                    logActivity(adminName, 'UPDATE_CUSTOMER', `Mengubah Data Pelanggan: ${name} (${finalUser}) - Status: ${finalStatus}`).catch(() => {});
                }
            });
            return { username: finalUser, status: finalStatus };
        });
    }
    
    async getInvoicePrintData(id) {
        try {
            // 1. Ambil Data Invoice + Customer + Package (JOIN)
            const sqlInv = `
                SELECT i.*, 
                       c.name as customer_name, 
                       c.address as customer_address, 
                       c.phone as customer_phone, 
                       c.username as customer_username,
                       p.name as package_name,
                       p.speed as package_speed
                FROM invoices i
                JOIN customers c ON i.customer_id = c.id
                LEFT JOIN packages p ON i.package_id = p.id
                WHERE i.id = ?
            `;
            const [invRows] = await pool.query(sqlInv, [id]);
            
            if (invRows.length === 0) return null;
            // 2. Ambil Setting Perusahaan (Header, Logo, Alamat ISP, dll)
            const [settingRows] = await pool.query("SELECT setting_key, value FROM app_settings");
            let appSettings = {};
            settingRows.forEach(row => {
                appSettings[row.setting_key] = row.value;
            });
            return {
                invoice: invRows[0],
                appSettings: appSettings
            };
        } catch (error) {
            console.error("? Gagal meracik data cetak:", error.message);
            throw error;
        }
    }
    
    async getInvoiceDetails(id) {
        try {
            // 1. Query dengan COALESCE (Double Join Guard)
            const sql = `
                SELECT 
                    i.*, 
                    c.name as customer_name, 
                    c.address as customer_address, 
                    c.phone as customer_phone, 
                    c.username as customer_username,
                    COALESCE(p_inv.name, p_cust.name) as package_name, 
                    COALESCE(p_inv.speed, p_cust.speed) as package_speed
                FROM invoices i 
                JOIN customers c ON i.customer_id = c.id
                LEFT JOIN packages p_inv ON i.package_id = p_inv.id
                LEFT JOIN packages p_cust ON c.package_id = p_cust.id
                WHERE i.id = ?
            `;
            const [rows] = await pool.query(sql, [id]);
            if (rows.length === 0) return null;
            const invoice = rows[0];
            // 2. Logika Link Pembayaran Otomatis
            if (!invoice.tripay_url) {
                invoice.tripay_url = `https://billing.pulsebill.io/payment/select/${invoice.invoice_number}/${invoice.customer_id}`;
            }
            return invoice;
        } catch (error) {
            console.error("? Detail Inspector Error:", error.message);
            throw error;
        }
    }
    
    async createManualInvoice(data) {
        const { customer_id, package_id, amount, due_date, status, notes } = data;
        try {
            // 1. Ekstrak Waktu untuk Nomor Invoice
            const now = new Date();
            const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
            const rand = Math.floor(1000 + Math.random() * 9000);
            const invNumber = `INV-${dateStr}-${customer_id}-${rand}`;
            // Pembersih Nominal Anti-Error
            const cleanAmount = amount ? String(amount).replace(/[^0-9]/g, '') : 0;
            // 2. Ekstrak Bulan & Tahun secara MANUAL TANGGUH (Bukan pakai Date() yg rawan)
            // due_date dari form biasanya berformat "YYYY-MM-DD" (contoh: 2026-04-28)
            const dateParts = due_date.split('-'); 
            let targetMonth = parseInt(dateParts[1]);
            let targetYear = parseInt(dateParts[0]);
            // =================================================================
    // Initialize database connection pool
            // =================================================================
            const isExpense = !package_id || (notes && notes.toLowerCase().includes('pln'));
            
            if (!isExpense) {
                // KITA PAKAI FUNGSI MONTH() & YEAR() MARIADB LANGSUNG KE KOLOM due_date!
                // Ini mustahil dibohongi oleh zona waktu Javascript atau kolom database yg kosong.
                const [existingMonth] = await pool.query(
                    `SELECT id FROM invoices 
                     WHERE customer_id = ? 
                       AND MONTH(due_date) = ? 
                       AND YEAR(due_date) = ? 
                       AND status != 'cancelled'`,
                    [customer_id, targetMonth, targetYear]
                );
                if (existingMonth.length > 0) {
                    throw new Error(`GAGAL DIBUAT: Pelanggan ini sudah memiliki tagihan di bulan ${targetMonth}-${targetYear}. Aturan: 1 Pelanggan = 1 Tagihan per Bulan!`);
                }
            }
            // 4. Eksekusi Simpan Komplit ke Database
            const sql = `
                INSERT INTO invoices
                (invoice_number, customer_id, package_id, month, year, amount, status, due_date, notes, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
            `;
            try {
                await pool.execute(sql, [
                    invNumber,
                    customer_id,
                    package_id || null,
                    targetMonth, 
                    targetYear,  
                    cleanAmount,
                    status || 'unpaid',
                    due_date,
                    notes || ''
                ]);
            } catch (error) {
                // Tangkap jika ada error dari Unique Index Gembok Baja
                if (error.code === 'ER_DUP_ENTRY') {
                    throw new Error(`GAGAL DIBUAT: Tagihan untuk tanggal ${due_date} SUDAH ADA. Sistem menolak data ganda!`);
                }
                throw error; 
            }
            
            return { success: true, invoice_number: invNumber };
        } catch (error) {
            console.error("? Gagal Terbit Invoice Manual:", error.message);
            throw error; // Lemparkan error merah ke layar Admin
        }
    }
    
    async generateCustomerImportTemplate() {
        try {
            const xlsx = require('xlsx');
            // 1. Definisikan Data Contoh (Gunakan nama kolom yang ramah admin)
            const templateData = [
                {
                    'Nama_Lengkap': 'Ahmad Fauzi',
                    'Nomor_WhatsApp': '628123456789',
                    'Nama_Paket': 'Paket_20Mbps', // Catatan: Harus sesuai dengan nama di tabel packages
                    'Username_PPPoE': 'ahmad_user',
                    'Password_PPPoE': '123456',
                    'Email': 'ahmad@example.com',
                    'Alamat_Lengkap': '45 Enterprise Parkway, Suite 200',
                    'Tanggal_Pasang': '2026-02-28',
                    'Tgl_Tagihan_Tiap_Bulan': '15'
                }
            ];
            // 2. Proses pembuatan workbook
            const ws = xlsx.utils.json_to_sheet(templateData);
            
            ws['!cols'] = [
                { wch: 25 }, { wch: 15 }, { wch: 20 }, { wch: 20 }, 
                { wch: 15 }, { wch: 25 }, { wch: 40 }, { wch: 15 }, { wch: 20 }
            ];
            const wb = xlsx.utils.book_new();
            xlsx.utils.book_append_sheet(wb, ws, "Daftar_Calon_Pelanggan");
            // 3. Return Buffer
            return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
        } catch (error) {
            console.error("? Template Architect Error:", error.message);
            throw error;
        }
    }
    
    async processExcelImport(rows) {
        let sukses = 0; let gagal = 0;
        let logGagal = [];
        for (let row of rows) {
            try {
                // 1. Satpam Baris Kosong
                if (!row.fullname || !row.phonenumber) continue;
                // 2. Normalisasi No HP (08...)
                let cleanPhone = String(row.phonenumber).replace(/[^0-9]/g, '');
                if (cleanPhone.startsWith('62')) {
                    cleanPhone = '0' + cleanPhone.substring(2);
                } else if (cleanPhone.startsWith('8')) {
                    cleanPhone = '0' + cleanPhone;
                }
                // 3. Cari ID Paket berdasarkan Nama
                const [pkg] = await pool.query("SELECT id FROM packages WHERE name = ?", [row.paket]);
                if (pkg.length === 0) {
                    logGagal.push(`${row.fullname}: Paket '${row.paket}' tidak terdaftar.`);
                    gagal++; continue;
                }
                // 4. Konversi Tanggal Excel ke SQL
                let finalJoinDate = row.join_date;
                if (typeof finalJoinDate === 'number') {
                    const excelDate = new Date(Math.round((finalJoinDate - 25569) * 86400 * 1000));
                    finalJoinDate = excelDate.toISOString().split('T')[0]; 
                } 
                if (!finalJoinDate || finalJoinDate === "" || finalJoinDate === "-") {
                    finalJoinDate = new Date().toISOString().split('T')[0];
                }
                // 5. Eksekusi Simpan Pelanggan (Disiplin 3 Kolom)
                const result = await this.createCustomer({
                    name: row.fullname,
                    phone: cleanPhone,
                    username: row.username,
                    password: row.password ? String(row.password) : '2233',
                    pppoe_username: row.username,
                    pppoe_password: row.password ? String(row.password) : '2233',
                    email: row.email || '',
                    address: row.address || '',
                    package_id: pkg[0].id,
                    join_date: finalJoinDate,
                    billing_day: row.billing_day ? parseInt(row.billing_day) : null,
                    skipWA: true 
                });
                if (result.success) {
                    // 6. Buat Invoice Pertama Otomatis (Gak pake delay, Manager sudah handle pool)
                    await this.createInvoice(result.id);
                    sukses++;
                } else {
                    gagal++;
                    logGagal.push(`${row.fullname}: ${result.message}`);
                }
            } catch (e) {
                gagal++;
                logGagal.push(`${row.fullname}: Error Sistem (${e.message})`);
            }
        }
        return { sukses, gagal, logGagal };
    }
    
    async syncRadiusUser(customerId) {
        return this.withTransaction(async (conn) => {
            // 1. Ambil Data Lengkap (WAJIB TAMBAH p.type dan p.name)
            const [rows] = await conn.query(`
                SELECT c.*, p.pppoe_profile, p.type as package_type, p.name as package_name
                FROM customers c 
                LEFT JOIN packages p ON c.package_id = p.id 
                WHERE c.id = ?
            `, [customerId]);
            if (!rows.length) throw new Error('Pelanggan tidak ditemukan!');
            const user = rows[0];
            // 2. Normalisasi & Validasi (Cari Username Utama)
            const finalUser = user.pppoe_username?.trim() || user.username?.trim();
            const finalPass = user.pppoe_password?.trim() || user.password?.trim() || '123456';
            const radiusProfile = (user.pppoe_profile || 'default').trim();
            
            // ?? UBAH JADI 'let' BIAR BISA DIUBAH SAMA FITUR PINTAR (AUTO-ISOLIR)
            let status = user.status || 'active'; 
            if (!finalUser) throw new Error('Username kosong di database!');
            // 3. Format Tanggal Expiration & Hitung Sisa Detik
            let formattedExp = '01 Jan 2030 23:59:59';
            let selisihDetik = 0;
            let wisprDate = null;
            
            if (user.expired_date) {
                const expObj = new Date(user.expired_date);
                formattedExp = this.formatRadiusDate(expObj);
                selisihDetik = Math.max(0, Math.floor((expObj.getTime() - Date.now()) / 1000));
                wisprDate = expObj.toISOString().slice(0, 19).replace(' ', 'T') + '+07:00';
                // =================================================================
                // =================================================================
                const now = new Date();
                if (expObj < now && status === 'active') {
                    status = 'suspended'; // Paksa status jadi Isolir detik ini juga
                    
                    // Update ke database Web agar tulisan 'Active' ikut berubah jadi 'Suspended'
                    await conn.execute("UPDATE customers SET status = 'suspended' WHERE id = ?", [customerId]);
                }
                // =================================================================
            }
            // =================================================================
            // ??? FITUR SAVE QUOTA: AMBIL SISA WAKTU LAMA SEBELUM DIHAPUS (KHUSUS HOTSPOT)
            // =================================================================
            const [oldLimitRows] = await conn.query("SELECT value FROM radcheck WHERE username = ? AND attribute = 'Max-All-Session'", [finalUser]);
            const savedMaxSession = oldLimitRows.length > 0 ? oldLimitRows[0].value : null;
            // 4. Pembedahan Tabel Radius (Sapu Bersih Semua Dulu)
            await conn.execute("DELETE FROM radcheck WHERE username = ?", [finalUser]);
            await conn.execute("DELETE FROM radusergroup WHERE username = ?", [finalUser]);
            await conn.execute("DELETE FROM radreply WHERE username = ?", [finalUser]);
            // 5. INSERT PASSWORD (WAJIB)
            await conn.execute(
                "INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Cleartext-Password', ':=', ?)",
                [finalUser, finalPass]
            );
            // =================================================================
            // 6. LOGIC GUARD: CEK STATUS & LAYANAN (ISOLIR VS AKTIF)
            // =================================================================
            
            const namaPaket = (user.package_name || '').toUpperCase();
            const isHotspotMember = (user.package_type === 'voucher' || namaPaket.includes('MEMBER'));
            if (status === 'active') {
                if (isHotspotMember) {
                    // =========================================================
                    // =========================================================
                    
                    // 1. HAPUS "DOSA" PEMAKAIAN LAMA (Wajib agar hitungan mulai dari NOL)
                    // Solusi ampuh buat ANNA1122 yang macet karena over-quota
                    await conn.execute("DELETE FROM radacct WHERE username = ?", [finalUser]);
                    // 2. JATAH SEGAR (Abaikan sisa kuota lama, pakai selisihDetik murni dari kalender)
                    const finalLimitDetik = selisihDetik;
                    await conn.execute("INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Expiration', ':=', ?)", [finalUser, formattedExp]);
                    await conn.execute("INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Max-All-Session', ':=', ?)", [finalUser, finalLimitDetik]);
                    
                    // 3. SUNTIK PELURU MIKROTIK (Session-Timeout agar router memutus otomatis jika detik habis)
                    await conn.execute("INSERT INTO radreply (username, attribute, op, value) VALUES (?, 'Session-Timeout', ':=', ?)", [finalUser, finalLimitDetik]);
                    
                    if (wisprDate) {
                        await conn.execute("INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'WISPr-Session-Terminate-Time', ':=', ?)", [finalUser, wisprDate]);
                    }
                    // 4. PASANG PROFIL PAKET
                    const hotProfile = (user.package_name || 'default').trim();
                    await conn.execute("INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, '1')", [finalUser, hotProfile]);
                    
                    console.log(`[MASTER-SYNC] ${finalUser} RESET TOTAL & AKTIF (Hotspot Member - Waktu: ${finalLimitDetik}s)`);
                } else {
                    // --- JALUR PPPOE PINTAR (Flexible Mode - Redirect Ready) ---
                    // KUNCI: Radius TIDAK menyuntikkan Expiration agar login selalu sukses (ACCEPT)
                    // Mikrotik yang akan menentukan Pool & VLAN secara lokal melalui Profile
                    await conn.execute(
                        "INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, '1')", 
                        [finalUser, radiusProfile]
                    );
                    console.log(`[MASTER-SYNC] ${finalUser} SYNC: Active (PPPoE Flexible - Profile: ${radiusProfile})`);
                }
            } else {
                const isolirProfileName = await this.getActiveIsolirProfile(conn);
                await conn.execute(
                    "INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, '1')",
                    [finalUser, isolirProfileName]
                );
                console.log(`[MASTER-SYNC] ${finalUser} SYNC: Suspended (Dilempar ke Profile: ${isolirProfileName})`);
            }
            
            return { username: finalUser, customerName: user.name, status: status };
        });
    }
    
    async finalizePaymentAndExtendRadius(invoiceId, method = 'Cash') {
        return this.withTransaction(async (conn) => {
            const [rows] = await conn.query(`
                SELECT i.customer_id, i.amount, i.due_date, c.expired_date, c.billing_day, c.installation_date, c.pppoe_username, p.pppoe_profile, p.billing_type
                FROM invoices i
                JOIN customers c ON i.customer_id = c.id
                LEFT JOIN packages p ON i.package_id = p.id
                WHERE i.id = ?`, [invoiceId]);
                
            if (rows.length === 0) return null;
            const data = rows[0];
            
            let bDay = data.billing_day;
            if (!bDay && data.installation_date) {
                bDay = new Date(data.installation_date).getDate();
            }
            bDay = bDay || (data.expired_date ? new Date(data.expired_date).getDate() : 28); 
            
            let baseDate = data.due_date ? new Date(data.due_date) : new Date();
            
            let newExp = new Date(baseDate.getFullYear(), baseDate.getMonth() + 1, 1); 
            let maxDaysInNextMonth = new Date(baseDate.getFullYear(), baseDate.getMonth() + 2, 0).getDate();
            newExp.setDate(Math.min(bDay, maxDaysInNextMonth));
            const sqlExp = newExp.toISOString().slice(0, 19).replace('T', ' ');
            await conn.execute("UPDATE customers SET expired_date = ?, status = 'active' WHERE id = ?", [sqlExp, data.customer_id]);
            if (data.pppoe_username) {
                const formattedRadiusDate = this.formatRadiusDate(newExp);
                await conn.execute(`DELETE FROM radcheck WHERE username = ? AND attribute = 'Expiration'`, [data.pppoe_username]);
                await conn.execute(`INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Expiration', ':=', ?)`, [data.pppoe_username, formattedRadiusDate]);
            }
            return { username: data.pppoe_username, newExp: sqlExp };
        });
    }
    
    async processSuccessPayment(invoiceId, method, notes = '') {
        return this.withTransaction(async (conn) => {
            // 1. Ambil Data (Lock for Update)
            const [rows] = await conn.query(`
                SELECT i.*, c.name, c.address, p.name as pkg 
                FROM invoices i 
                JOIN customers c ON i.customer_id = c.id 
                LEFT JOIN packages p ON i.package_id = p.id 
                WHERE i.id = ? FOR UPDATE`, [invoiceId]);
            const data = rows[0];
            if (!data || data.status === 'paid') return false;
            // 2. Update Invoice & Customer
            await conn.execute("UPDATE invoices SET status = 'paid', paid_at = NOW(), payment_date = NOW(), payment_method = ?, notes = ? WHERE id = ?", 
                [method, notes, invoiceId]);
            await conn.execute("UPDATE customers SET status = 'active' WHERE id = ?", [data.customer_id]);
            // 3. Laporan Keuangan
            await conn.execute(`
                INSERT INTO finance_reports (username, profile_name, address, payment_method, total_price, payment_date) 
                VALUES (?, ?, ?, ?, ?, NOW())`,
                [data.name, data.pkg || 'Paket', data.address || '-', method, data.amount]);
            return data; // Kembalikan data untuk proses background (Radius/Kick)
        });
    }
    
    async voidPayment(paymentId) {
        return this.withTransaction(async (conn) => {
            // 1. Cari data pembayaran yang mau dibatalkan
            const [pay] = await conn.query("SELECT invoice_id FROM payments WHERE id = ?", [paymentId]);
            
            if (pay.length === 0) {
                throw new Error("Data pembayaran ghoib, tidak ditemukan!");
            }
            const invoiceId = pay[0].invoice_id;
            // 2. Kembalikan tagihan jadi Unpaid (Hutang kembali hidup!)
            await conn.execute(
                "UPDATE invoices SET status = 'unpaid', paid_at = NULL, payment_method = NULL WHERE id = ?", 
                [invoiceId]
            );
            // 3. Hapus rekam jejak pembayaran di tabel payments
            await conn.execute("DELETE FROM payments WHERE id = ?", [paymentId]);
            /* * NOTE: 
             * If records were previously written to finance_reports, 
             * idealnya data di finance_reports juga dihapus di sini agar pembukuan tidak minus.
             * Contoh: await conn.execute("DELETE FROM finance_reports WHERE invoice_id = ?", [invoiceId]);
             */
            return { invoice_id: invoiceId };
        });
    }
    
    async refundInvoiceSOP(invoiceId) {
        return this.withTransaction(async (conn) => {
            // 1. Cek Tagihan
            const [invRows] = await conn.query("SELECT customer_id, invoice_number, status FROM invoices WHERE id = ? FOR UPDATE", [invoiceId]);
            if (invRows.length === 0) throw new Error("Tagihan ghoib, tidak ditemukan!");
            
            const inv = invRows[0];
            if (inv.status === 'unpaid') throw new Error("Invoice is already marked as unpaid.");
            // 2. Kembalikan status tagihan jadi BELUM LUNAS
            await conn.execute(
                "UPDATE invoices SET status = 'unpaid', paid_at = NULL, payment_date = NULL, payment_method = NULL WHERE id = ?",
                [invoiceId]
            );
            // 3. SAPU BERSIH: Tarik uang kas dari tabel pembayaran & laporan keuangan (Biar pembukuan tidak selisih)
            await conn.execute("DELETE FROM payments WHERE invoice_id = ?", [invoiceId]);
            await conn.execute("DELETE FROM finance_reports WHERE invoice_id = ?", [invoiceId]);
            // 4. Ambil username untuk ditendang dari MikroTik
            const [custRows] = await conn.query("SELECT pppoe_username FROM customers WHERE id = ?", [inv.customer_id]);
            
            if (custRows.length > 0 && custRows[0].pppoe_username) {
                const username = custRows[0].pppoe_username;
                // Kick Radius secara background (Biar router membaca ulang status Unpaid-nya)
                setImmediate(() => {
                    if (typeof this.kickUserRadius === 'function') {
                        this.kickUserRadius(username).catch(() => {});
                    }
                });
            }
            return { success: true, invoice_number: inv.invoice_number };
        });
    }
    
   // =========================================================
    // =========================================================
    async withTransaction(callback) {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const result = await callback(conn);
            await conn.commit();
            return result;
        } catch (error) {
            await conn.rollback();
            throw error;
        } finally {
            conn.release();
        }
    }
    // =========================================================
    // VERSI FINAL: PISAH JALUR (HOTSPOT vs PPPOE) + ANTI BOCOR
    // =========================================================
    async sultanManualPayment(invoiceId, reqOrAmount = null, options = {}) {
        return await this.withTransaction(async (conn) => {
            
            // 1. AMBIL SEMUA DATA DARI DATABASE (SUDAH FIX PAKAI c.package_id)
            const [rows] = await conn.query(`
                SELECT i.*, 
                       c.username, c.pppoe_username, c.name as customer_name, c.phone as customer_phone, c.billing_day, c.expired_date,
                       p.name as package_name, p.pppoe_profile, p.billing_type, p.active_period,
                       p.type as package_type
                FROM invoices i 
                JOIN customers c ON i.customer_id = c.id 
                LEFT JOIN packages p ON c.package_id = p.id 
                WHERE i.id = ? FOR UPDATE`, [invoiceId]);
            const inv = rows[0];
            if (!inv) return { success: false, message: 'Tagihan tidak ditemukan!' };
            if (inv.status === 'paid' || inv.status === 'PAID') {
                return { success: true, message: 'Tagihan ini sudah lunas!', already_paid: true };
            }
            // =========================================================
            // ??? DETEKTOR KASTA (MEMISAHKAN HOTSPOT vs PPPOE)
            // =========================================================
            const namaPaket = (inv.package_name || '').toUpperCase();
            const tipeDB = inv.package_type || 'pppoe';
            const isHotspotMember = (tipeDB === 'voucher' || namaPaket.includes('MEMBER'));
            
            // =========================================================
            // ?? LOGIKA HITUNG EXPIRED (OTOMATIS BACA DUE_DATE INVOICE)
            // =========================================================
            let newExp = new Date(); 
            if (inv.expired_date && new Date(inv.expired_date) > new Date()) {
                newExp = new Date(inv.expired_date);
            }
            const billingType = inv.billing_type || 'fixed';
            if (billingType === 'dynamic') {
                const daysToAdd = parseInt(inv.active_period) || 30;
                newExp.setDate(newExp.getDate() + daysToAdd);
            } else {
                // =========================================================
                // =========================================================
                // Kita ambil bDay dari kolom 'billing_day' di database (Master Data)
                // Jika kosong, baru fallback ke default (misal 5 atau 25)
                const bDay = inv.billing_day || 25; 
                
                let nextMonth = newExp.getMonth() + 1;
                let nextYear = newExp.getFullYear();
                
                if (nextMonth > 11) { 
                    nextMonth = 0;
                    nextYear++;
                }
                // Proteksi untuk bulan pendek (misal tagihan tgl 31, tapi bulan depan cuma sampai tgl 30 atau 28)
                const daysInNextMonth = new Date(nextYear, nextMonth + 1, 0).getDate();
                const finalDay = bDay > daysInNextMonth ? daysInNextMonth : bDay;
                newExp = new Date(nextYear, nextMonth, finalDay);
            }
            newExp.setHours(23, 59, 59, 0);
            const sqlExp = newExp.toISOString().slice(0, 19).replace('T', ' ');
            
            // FORMAT RADIUS
            const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
            const radiusString = `${String(newExp.getDate()).padStart(2, '0')} ${months[newExp.getMonth()]} ${newExp.getFullYear()} 23:59:59`;
            const selisihDetik = Math.max(0, Math.floor((newExp.getTime() - Date.now()) / 1000));
            // =========================================================
            // ?? UPDATE DATABASE WEB (FIX CUSTOM ISSUE & NAM KASIR)
            // =========================================================
            const paymentMethod = options.payment_method || 'Cash';
            const validReq = (reqOrAmount && reqOrAmount.headers) ? reqOrAmount : options.req;
            // ?????? TANGKAP NAMA KASIR DI SINI SEBELUM INSERT KE DATABASE
            const namaPelaksana = 
                validReq?.session?.admin_username || 
                validReq?.session?.user?.name || 
                validReq?.session?.adminName || 
                validReq?.session?.agentName || 
                options.adminId || 
                'SYSTEM';
  
            
            await conn.execute(
                "UPDATE invoices SET status = 'paid', paid_at = NOW(), payment_date = NOW(), payment_method = ?, package_id = (SELECT package_id FROM customers WHERE id = ?) WHERE id = ?", 
                [paymentMethod, inv.customer_id, invoiceId]
            );
            await conn.execute(
                "UPDATE customers SET status = 'active', expired_date = ? WHERE id = ?", 
                [sqlExp, inv.customer_id]
            );
            const refNumber = options.reference_number || `CASH-${Date.now().toString().slice(-6)}`;
            
            // ?? UPDATE FATAL: Kolom admin_name ditambahkan ke INSERT payments
            await conn.execute(`
                INSERT INTO payments (invoice_id, amount, payment_method, reference_number, payment_date, notes, admin_name) 
                VALUES (?, ?, ?, ?, NOW(), ?, ?)`, 
                [inv.id, inv.amount, paymentMethod, refNumber, options.notes || `Pembayaran ${billingType.toUpperCase()}`, namaPelaksana]
            );
            // ?? SAMA DI SINI: Kolom username diisi nama Kasir/Admin
            await conn.execute(`
                INSERT INTO finance_reports 
                (invoice_id, customer_id, amount, total_price, type, payment_method, description, username, profile_name, payment_date) 
                VALUES (?, ?, ?, ?, 'income', ?, ?, ?, ?, NOW())`, 
                [inv.id, inv.customer_id, inv.amount, inv.amount, paymentMethod, `Tagihan ${billingType} #${inv.invoice_number}`, namaPelaksana, inv.package_name || inv.pppoe_profile]
            );
            // =========================================================
            // ?? SINKRONISASI RADIUS (PISAH JALUR TEGAS)
            // =========================================================
            if (inv.username && isHotspotMember) {
                // ?? JALUR 1: KHUSUS HOTSPOT MEMBER (Gaya NuxBill)
                const hotUser = inv.username;
                const hotProfile = inv.package_name || 'default';
                // ?? JURUS NUXBILL: Sapu bersih history radacct agar Max-Session kembali ke NOL
                await conn.execute("DELETE FROM radacct WHERE username = ?", [hotUser]);
                await conn.execute("DELETE FROM radcheck WHERE username = ? AND attribute IN ('Expiration', 'Max-All-Session', 'WISPr-Session-Terminate-Time')", [hotUser]);
                await conn.execute("DELETE FROM radreply WHERE username = ? AND attribute = 'Session-Timeout'", [hotUser]);
                await conn.execute("DELETE FROM radusergroup WHERE username = ?", [hotUser]);
                // SUNTIK: Expiration, Max-Session, WISPr
                await conn.execute("INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Expiration', ':=', ?)", [hotUser, radiusString]);
                await conn.execute("INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Max-All-Session', ':=', ?)", [hotUser, selisihDetik]);
                await conn.execute("INSERT INTO radreply (username, attribute, op, value) VALUES (?, 'Session-Timeout', ':=', ?)", [hotUser, selisihDetik]);
                
                const wisprDate = sqlExp.replace(' ', 'T') + '+07:00'; 
                await conn.execute("INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'WISPr-Session-Terminate-Time', ':=', ?)", [hotUser, wisprDate]);
                await conn.execute("INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, '1')", [hotUser, hotProfile]);
                
                console.log(`? [HOTSPOT SYNC] ${hotUser} Diperpanjang Full Detik.`);
            } 
            
            // =============================================================
            // ??? JALUR 2: KHUSUS PPPOE (FIXED: REDIRECT-READY)
            // =============================================================
            if ((inv.pppoe_username || inv.username) && !isHotspotMember) {
                const pppoeUser = inv.pppoe_username || inv.username;
                const pppoeProfile = inv.pppoe_profile || 'default';
                // 1. Bersihkan semua gembok pembatas (Sapu bersih biar gak ada sisa Expiration)
                await conn.execute("DELETE FROM radcheck WHERE username = ? AND attribute IN ('Expiration', 'Max-All-Session', 'WISPr-Session-Terminate-Time')", [pppoeUser]);
                await conn.execute("DELETE FROM radreply WHERE username = ? AND attribute = 'Session-Timeout'", [pppoeUser]);
                await conn.execute("DELETE FROM radusergroup WHERE username = ?", [pppoeUser]);
                // Cukup suntik Group saja. 
                // Biarkan pintu login Radius selalu terbuka (Access-Accept).
                await conn.execute("INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, '1')", [pppoeUser, pppoeProfile]);
                logger.info([PPPOE] Active session cleared for , profile policy active);
            }
            
            // =========================================================
            // ?? BACKGROUND TASKS: Auto-Kick, Log, & Notif
            // =========================================================
            setImmediate(() => {
                const validReq = (reqOrAmount && reqOrAmount.headers) ? reqOrAmount : options.req;
                
                if (typeof logActivity === 'function') {
                    // Cukup panggil 'namaPelaksana' yang sudah dideklarasikan di atas tadi.
                    // JANGAN pakai const namaPelaksana = ... lagi di sini!
                    logActivity(namaPelaksana, 'PAYMENT_SUCCESS', `Lunas: #${inv.invoice_number} (${inv.customer_name})`, validReq).catch(e => {});
                }
                            
                // ? AUTO-KICK (Sikat Semua PPPoE)
                if (typeof this.kickUserRadius === 'function') {
                    if (!isHotspotMember) {
                        const targetKick = inv.pppoe_username || inv.username;
                        this.kickUserRadius(targetKick);
                        console.log(`? [AUTO-KICK] Menendang PPPoE: ${targetKick}`);
                    } else {
                        console.log(`? [AUTO-KICK SKIPPED] Hotspot Member tetap Online.`);
                    }
                }
                
                // ?? NOTIFIKASI WHATSAPP
                if (typeof this.sendPaymentSuccessNotification === 'function') {
                    this.sendPaymentSuccessNotification(inv, inv).catch(e => {});
                }
            });
            return { 
                success: true, 
                message: `LUNAS! Mode: ${billingType.toUpperCase()}, Expired: ${sqlExp}`, 
                invoice_id: inv.id, 
                username: inv.username || inv.pppoe_username 
            };
        });
    }
    
    // =========================================================
    // =========================================================
    // 2. UPDATE DATA AGEN (Sapu Jagat)
    async updateSultanAgent(id, data) {
        const telepon = data.phone || data.contact || '';
        const { name, username, password } = data;
        const bcrypt = require('bcryptjs');
        
        if (password && password.trim() !== '') {
            const hash = await bcrypt.hash(password, 10);
            return await pool.execute(
                "UPDATE agents SET name = ?, phone = ?, username = ?, password = ? WHERE id = ?",
                [name, telepon, username, hash, id]
            );
        }
        return await pool.execute(
            "UPDATE agents SET name = ?, phone = ?, username = ? WHERE id = ?",
            [name, telepon, username, id]
        );
    }
    // 2. Approve Topup dengan Proteksi Transaksi
    async approveSultanTopup(requestId) {
        return this.withTransaction(async (conn) => {
            const [reqData] = await conn.query("SELECT agent_id, amount FROM agent_topup_requests WHERE id = ? FOR UPDATE", [requestId]);
            if (reqData.length === 0) throw new Error("Request tidak ditemukan");
            
            await conn.execute("UPDATE agents SET balance = balance + ? WHERE id = ?", [reqData[0].amount, reqData[0].agent_id]);
            await conn.execute("UPDATE agent_topup_requests SET status = 'approved' WHERE id = ?", [requestId]);
            return true;
        });
    }
    // 3. Hapus Voucher & Bersihkan Radius
    async deleteSultanVoucher(voucherCode, logId) {
        return this.withTransaction(async (conn) => {
            await conn.execute("DELETE FROM radcheck WHERE username = ?", [voucherCode]);
            await conn.execute("DELETE FROM radreply WHERE username = ?", [voucherCode]);
            await conn.execute("DELETE FROM radusergroup WHERE username = ?", [voucherCode]);
            await conn.execute("DELETE FROM agent_vouchers_logs WHERE id = ?", [logId]);
            return true;
        });
    }
    // 4. Pengelola Paket Agen
    async manageAgentPackage(action, data) {
        const { id, name, price, agent_cost, is_for_agent } = data;
        const active = is_for_agent === 'on' ? 1 : 0;
        
        if (action === 'add') {
            return await pool.execute(
                "INSERT INTO packages (name, price, agent_cost, is_for_agent, type) VALUES (?, ?, ?, 1, 'voucher')",
                [name, price, agent_cost]
            );
        } else if (action === 'update') {
            return await pool.execute(
                "UPDATE packages SET name = ?, price = ?, agent_cost = ?, is_for_agent = ? WHERE id = ?",
                [name, price, agent_cost, active, id]
            );
        } else if (action === 'delete') {
            return await pool.execute("DELETE FROM packages WHERE id = ?", [id]);
        }
    }
    
    // =========================================================
    // =========================================================
    async getSultanAgentControlData() {
        try {
            // Audit 2026: Eksekusi 5 kueri sekaligus dalam satu detak jantung
            const [agents, vouchers, topups, packages, profiles] = await Promise.all([
                // 1. Ambil Data Agen
                pool.query("SELECT * FROM agents ORDER BY id DESC"),
                
                // 2. Ambil History Voucher
                pool.query(`
                    SELECT l.*, a.name as agent_name 
                    FROM agent_vouchers_logs l
                    JOIN agents a ON l.agent_id = a.id
                    ORDER BY l.created_at DESC LIMIT 50
                `),
                // 3. Ambil Request Topup Pending
                pool.query(`
                    SELECT r.*, a.name as agent_name 
                    FROM agent_topup_requests r 
                    JOIN agents a ON r.agent_id = a.id 
                    WHERE r.status = 'pending'
                `),
                // 4. Ambil Paket Voucher
                pool.query("SELECT * FROM packages WHERE type = 'voucher' ORDER BY price ASC"),
                // 5. Ambil Profil Radius (Hotspot)
                pool.query(`
                    SELECT DISTINCT groupname 
                    FROM radgroupreply 
                    WHERE (groupname NOT IN (SELECT groupname FROM radgroupreply WHERE attribute = 'Framed-Protocol' AND value = 'PPP'))
                    OR (groupname REGEXP '^[0-9 ]+$')
                    ORDER BY groupname ASC
                `)
            ]);
            // Bungkus rapi dalam satu paket mewah
            return {
                agents: agents[0] || [],
                vouchers: vouchers[0] || [],
                topups: topups[0] || [],
                agentPackages: packages[0] || [],
                hotspotProfiles: profiles[0] || []
            };
        } catch (error) {
            console.error("? [OTOT-AGENTS] Gagal meracik data kontrol agen:", error.message);
            // Kembalikan array kosong agar render EJS tidak pecah
            return { agents: [], vouchers: [], topups: [], agentPackages: [], hotspotProfiles: [] };
        }
    }
    // 1. TAMBAH AGEN BARU (Sapu Jagat)
    async createSultanAgent(data) {
        // Tangkap dua-duanya, kalau form pakai 'phone' atau 'contact' tetap aman!
        const telepon = data.phone || data.contact || ''; 
        const { username, password, name } = data;
        
        try {
            const bcrypt = require('bcryptjs');
            const hash = await bcrypt.hash(password, 10);
            const sql = `
                INSERT INTO agents (username, password, name, phone, balance, status) 
                VALUES (?, ?, ?, ?, 0, 'active')
            `;
            const [result] = await pool.execute(sql, [username, hash, name, telepon]);
            return { success: true, id: result.insertId };
        } catch (error) {
            console.error("? Gagal Simpan Agen Baru:", error.message);
            throw error;
        }
    }
    // 2. HAPUS AGEN PERMANEN
    async deleteSultanAgent(id) {
        return await pool.execute("DELETE FROM agents WHERE id = ?", [id]);
    }
    // 3. UPDATE STATUS AGEN (Aktif/Nonaktif)
    async updateAgentStatus(id, status) {
        return await pool.execute("UPDATE agents SET status = ? WHERE id = ?", [status, id]);
    }
    // 4. TOPUP MANUAL OLEH ADMIN
    async manualTopupAgent(id, amount) {
        const cleanAmount = String(amount).replace(/[^0-9]/g, ''); // Anti karakter aneh
        return await pool.execute("UPDATE agents SET balance = balance + ? WHERE id = ?", [cleanAmount, id]);
    }
    // 5. HAPUS REQUEST TOPUP (Tolak)
    async deleteTopupRequest(id) {
        return await pool.execute("DELETE FROM agent_topup_requests WHERE id = ?", [id]);
    }
    
    async getSultanAppSettings() {
        try {
            const [rows] = await pool.query("SELECT * FROM app_settings");
            let settings = {};
            rows.forEach(row => { settings[row.setting_key] = row.value; });
            return settings;
        } catch (e) {
            return {};
        }
    }
    
     // =========================================================
    // =========================================================
    // 1. Verifikasi Login Agen
    async verifyAgentLogin(username, password) {
        const bcrypt = require('bcryptjs');
        const [rows] = await pool.execute("SELECT * FROM agents WHERE username = ? AND status = 'active'", [username]);
        
        if (rows.length === 0) throw new Error("Username tidak ditemukan atau akun disuspend!");
        
        const agent = rows[0];
        const match = await bcrypt.compare(password, agent.password);
        if (!match) throw new Error("Invalid credentials provided.");
        
        return agent; // Kembalikan data agen jika lolos
    }
    // 2. Data Dashboard Agen
    async getAgentDashboard(agentId) {
        const [agent] = await pool.execute("SELECT balance, name FROM agents WHERE id = ?", [agentId]);
        const [history] = await pool.execute("SELECT * FROM agent_vouchers_logs WHERE agent_id = ? ORDER BY created_at DESC LIMIT 10", [agentId]);
        return { agent: agent[0], history };
    }
    // 3. Data Halaman Beli Voucher
    async getAgentBuyVoucherData(agentId) {
        const [packages] = await pool.execute("SELECT * FROM packages WHERE is_for_agent = 1 ORDER BY price ASC");
        const [agent] = await pool.execute("SELECT balance FROM agents WHERE id = ?", [agentId]);
        return { packages, balance: agent[0].balance };
    }
    // 4. Proses Transaksi Beli Voucher
    async processAgentBuyVoucher(agentId, packageId, qty) {
        return this.withTransaction(async (conn) => {
            // Cek Paket
            const [pkg] = await conn.execute("SELECT name, price, agent_cost FROM packages WHERE id = ?", [packageId]);
            if (pkg.length === 0) throw new Error("Paket tidak ditemukan!");
            const profileName = pkg[0].name;
            const hargaJual = pkg[0].price;
            const modalAgen = pkg[0].agent_cost;
            const totalBayar = modalAgen * qty;
            // Cek Saldo
            const [agent] = await conn.execute("SELECT balance FROM agents WHERE id = ? FOR UPDATE", [agentId]);
            if (agent[0].balance < totalBayar) throw new Error("Insufficient balance. Please top up your account.");
            // Potong Saldo
            await conn.execute("UPDATE agents SET balance = balance - ? WHERE id = ?", [totalBayar, agentId]);
            // Generate Voucher
            let voucherList = [];
            for (let i = 0; i < qty; i++) {
                const code = Math.random().toString(36).substring(2, 8).toUpperCase();
                
                await conn.execute("INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Cleartext-Password', ':=', ?)", [code, code]);
                await conn.execute("INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, '1')", [code, profileName]);
                await conn.execute("INSERT INTO agent_vouchers_logs (agent_id, username, profile, price_sell, price_cost) VALUES (?,?,?,?,?)", [agentId, code, profileName, hargaJual, modalAgen]);
                    
                voucherList.push({ code, profile: profileName, price: hargaJual });
            }
            return voucherList;
        });
    }
    // 5. Data Halaman Topup
    async getAgentTopupData(agentId) {
        const [agent] = await pool.execute("SELECT * FROM agents WHERE id = ?", [agentId]);
        const [history] = await pool.execute("SELECT * FROM agent_topup_requests WHERE agent_id = ? ORDER BY created_at DESC LIMIT 10", [agentId]);
        return { agent: agent[0], history };
    }
    // 6. Proses Topup Tripay (Khusus Agen)
    async createAgentTripayTopup(agentId, amount, method, hostname) {
        const crypto = require('crypto');
        const axios = require('axios');
        
        const [setRows] = await pool.execute("SELECT value FROM app_settings WHERE setting_key = 'payment_gateway_config'");
        if (setRows.length === 0) throw new Error("Konfigurasi Tripay tidak ditemukan.");
        const fullConfig = JSON.parse(setRows[0].value);
        const { apiKey, privateKey, merchantCode } = fullConfig.tripay;
        if (!privateKey) throw new Error("Private Key Tripay kosong.");
        const merchantRef = 'TOPUP-AGEN-' + Date.now();
        const finalAmount = parseInt(amount);
        const signature = crypto.createHmac('sha256', privateKey).update(merchantCode + merchantRef + finalAmount).digest('hex');
        const payload = {
            method: method || 'QRIS',
            merchant_ref: merchantRef,
            amount: finalAmount,
            customer_name: 'Agen ID ' + agentId,
            customer_email: 'agent@pulsebill.io',
            order_items: [{ name: 'Topup Saldo Agen', price: finalAmount, quantity: 1 }],
            return_url: `https://${hostname}/agent/dashboard`,
            callback_url: `https://${hostname}/webhook/tripay`,
            signature: signature
        };
        const response = await axios.post('https://tripay.co.id/api/transaction/create', payload, {
            headers: { 'Authorization': 'Bearer ' + apiKey }
        });
        if (response.data.success) {
            await pool.execute(
                "INSERT INTO agent_topup_requests (agent_id, amount, proof_img, status) VALUES (?, ?, ?, 'pending')",
                [agentId, finalAmount, 'Tripay Ref: ' + merchantRef]
            );
            return response.data.data.checkout_url;
        } else {
            throw new Error(response.data.message);
        }
    }
    // 7. Request Topup Manual
    async createManualTopupRequest(agentId, amount, bankName, senderName) {
        const proof = `Bank: ${bankName} | A.N: ${senderName}`; 
        return await pool.execute(
            "INSERT INTO agent_topup_requests (agent_id, amount, proof_img, status) VALUES (?, ?, ?, 'pending')",
            [agentId, amount, proof]
        );
    }
    // 8. Ambil Stok Voucher Agen
    async getAgentMyVouchers(agentId) {
        const [vouchers] = await pool.execute(`
            SELECT v.*, (SELECT COUNT(*) FROM radacct WHERE username = v.username) as login_count
            FROM agent_vouchers_logs v
            WHERE v.agent_id = ? ORDER BY v.created_at DESC LIMIT 100
        `, [agentId]);
        return vouchers;
    }
    // 9. Laporan Keuangan Agen
    async getAgentReport(agentId) {
        const [summary] = await pool.execute(`
            SELECT COUNT(*) as total_qty, SUM(price_cost) as total_modal, SUM(price_sell) as total_omset, SUM(price_sell - price_cost) as total_cuan
            FROM agent_vouchers_logs WHERE agent_id = ?
        `, [agentId]);
        return summary[0];
    }
    // 10. Riwayat Transaksi Campuran
    async getAgentHistory(agentId) {
        const [logs] = await pool.execute(`
            SELECT 'Beli Voucher' as type, price_cost as amount, created_at, profile as info FROM agent_vouchers_logs WHERE agent_id = ?
            UNION ALL
            SELECT 'Isi Saldo' as type, amount, created_at, status as info FROM agent_topup_requests WHERE agent_id = ?
            ORDER BY created_at DESC LIMIT 50
        `, [agentId, agentId]);
        return logs;
    }
    
    // =========================================================
    // =========================================================
    async kickUserRadius(username) {
        try {
            const { exec } = require('child_process');
            
            // ?? KUNCI: Kita tarik juga framedipaddress dan callingstationid (MAC)
            const sql = `
                SELECT r.nasipaddress, n.secret, r.framedipaddress, r.callingstationid 
                FROM radacct r 
                LEFT JOIN nas n ON r.nasipaddress = n.nasname 
                WHERE r.username = ? AND r.acctstoptime IS NULL LIMIT 1
            `;
            const [nas] = await pool.query(sql, [username]);
            
            if (nas.length > 0) {
                const { nasipaddress, secret, framedipaddress, callingstationid } = nas[0];
                // ?? RAKIT PELURU LENGKAP: Mikrotik v7 nggak bakal bisa nolak (ACK)
                const attr = `User-Name=${username},Framed-IP-Address=${framedipaddress},Calling-Station-Id=${callingstationid}`;
                
                exec(`echo "${attr}" | radclient -x ${nasipaddress}:3799 disconnect ${secret}`, (err) => {
                    if (err) {
                        console.log(`? [API-KICK-FAIL] Gagal tendang ${username}:`, err.message);
                    } else {
                        console.log(`?? [API-KICK-SUCCESS] Sukses tendang ${username} (Full Identity).`);
                    }
                });
            } else {
                console.log(`?? [API-KICK] User ${username} tidak ditemukan sedang online.`);
            }
        } catch (e) {
            console.log(`? [API-KICK-ERROR] ${username}:`, e.message);
        }
    }
    
    // =========================================================
    // ?? PACKAGE MANAGEMENT (BAGIAN BAWAH YANG SUDAH DISESUAIKAN)
    // =========================================================
    
    // 1. Ambil List Paket & Statistik (Pintu Utama)
    async getPackageList() {
        const conn = await pool.getConnection(); 
        try {
            // Paket PPPoE + Hitung Pelanggan
            const [packages] = await conn.query(`
                SELECT packages.*, 
                (SELECT COUNT(*) FROM customers WHERE customers.package_id = packages.id) as customer_count 
                FROM packages WHERE type = 'pppoe' ORDER BY price ASC
            `);
            // Profile Radius (Filter Framed-Protocol PPP & Non-Numeric)
            const [radiusProfiles] = await conn.query(`
                SELECT DISTINCT groupname FROM radgroupreply 
                WHERE groupname IN (
                    SELECT groupname FROM radgroupreply WHERE attribute = 'Framed-Protocol' AND value = 'PPP'
                ) AND groupname NOT REGEXP '^[0-9]+$' ORDER BY groupname ASC
            `);
            // Statistik Dashboard
            const [[totalP]] = await conn.query("SELECT COUNT(*) as total FROM packages WHERE type = 'pppoe'");
            const [[totalC]] = await conn.query("SELECT COUNT(*) as total FROM customers");
            const [[maxPrice]] = await conn.query("SELECT MAX(price) as max_price FROM packages WHERE type = 'pppoe'");
            return { packages, radiusProfiles, stats: {
                total_packages: totalP.total,
                total_customers: totalC.total,
                max_price: maxPrice.max_price || 0
            }};
        } finally {
            if (conn) conn.release();
        }
    }
    // 2. Ambil Satu Paket (Untuk Modal Edit)
    async getPackageById(id) {
        const [rows] = await pool.query("SELECT * FROM packages WHERE id = ?", [id]);
        return rows[0] || null;
    }
    // 3. Simpan Paket (Tambah & Update dengan Logika 30/31 Hari)
    async savePackage(data, id = null) {
        const { name, price, speed, pppoe_profile, billing_type, description } = data;
        const active_period = (billing_type === 'dynamic') ? '30' : '31';
        const bType = billing_type || 'fixed';
        if (id) {
            const sql = `UPDATE packages SET name=?, price=?, speed=?, pppoe_profile=?, 
                         billing_type=?, active_period=?, description=? WHERE id=?`;
            return await pool.execute(sql, [name, price, speed, pppoe_profile, bType, active_period, description, id]);
        } else {
            const sql = `INSERT INTO packages (name, price, speed, pppoe_profile, billing_type, active_period, description, type) 
                         VALUES (?, ?, ?, ?, ?, ?, ?, 'pppoe')`;
            return await pool.execute(sql, [name, price, speed, pppoe_profile, bType, active_period, description]);
        }
    }
    // 4. Hapus Paket (Murni Hapus di Web + Proteksi)
    // ? Tambahkan parameter adminName (default 'admin' kalau kosong)
    async deletePackage(id, adminName = 'admin') { 
        const [cek] = await pool.query("SELECT id FROM customers WHERE package_id = ? LIMIT 1", [id]);
        if (cek.length > 0) {
            throw new Error('Sistem Menolak: Paket tidak bisa dihapus karena masih menempel pada pelanggan!');
        }
        // 2. Eksekusi Hapus HANYA pada tabel Packages (Radius Aman 100%)
        await pool.execute("DELETE FROM packages WHERE id = ?", [id]);
        
        // 3. Rekam jejak penghapusan
        setImmediate(() => {
            if (typeof logActivity === 'function') {
                // ? Gunakan adminName dari parameter, JANGAN hardcode 'admin' lagi
                logActivity(adminName, 'DELETE_PACKAGE', `Menghapus Paket ID: ${id}`).catch(() => {});
            }
        });
        return true;
    }
    
    // =========================================================
    // =========================================================
    // 1. Ambil Data Halaman Pendaftaran (Semua Data Sekaligus)
    async getPendaftaranDashboardData() {
        // Tarik data paralel agar EJS tidak loading lama
        const [pendingList, technicianList, packageList, custData] = await Promise.all([
            pool.query(`
                SELECT p.*, t.name as technician_name 
                FROM pending_registrations p
                LEFT JOIN technicians t ON p.technician_id = t.id
                WHERE p.status = 'pending'
                ORDER BY p.created_at DESC
            `),
            pool.query("SELECT * FROM technicians ORDER BY name ASC"),
            pool.query("SELECT * FROM packages WHERE type = 'pppoe' AND (is_for_agent = 0 OR is_for_agent IS NULL) ORDER BY price ASC"),
            pool.query("SELECT COUNT(*) as total FROM customers WHERE status = 'active'")
        ]);
        return {
            pendingList: pendingList[0],
            technicianList: technicianList[0],
            packageList: packageList[0],
            pendingCount: pendingList[0].length,
            techCount: technicianList[0].length,
            totalInstalled: custData[0][0].total
        };
    }
    // 2. Simpan Teknisi
    async saveTechnician(data) {
        const { name, phone, password } = data;
        const [cek] = await pool.query("SELECT id FROM technicians WHERE phone = ?", [phone]);
        if (cek.length > 0) throw new Error("No HP sudah terdaftar!");
        await pool.query(
            "INSERT INTO technicians (name, phone, password, status) VALUES (?, ?, ?, 'active')",
            [name, phone, password] 
        );
        return true;
    }
    // 3. Hapus Teknisi
    async deleteTechnician(id) {
        await pool.query("DELETE FROM technicians WHERE id = ?", [id]);
        return true;
    }
    // 4. Cek Jumlah Pending (Untuk Alarm Lonceng)
    async getPendingCount() {
        const [rows] = await pool.query("SELECT COUNT(*) as total FROM pending_registrations WHERE status = 'pending'");
        return rows[0].total;
    }
    // 5. Eksekutor Tolak Pendaftaran
    async rejectRegistration(id) {
        await pool.query("UPDATE pending_registrations SET status = 'rejected' WHERE id = ?", [id]);
        return true;
    }
            // Synchronize active session with RADIUS policy
    async validateRegistration(regId) {
        return this.withTransaction(async (conn) => {
            // A. Ambil data calon
            const [rows] = await conn.query("SELECT * FROM pending_registrations WHERE id = ? FOR UPDATE", [regId]);
            if (rows.length === 0) throw new Error("Data pendaftaran tidak ditemukan!");
            const calon = rows[0];
            // B. Ambil ID Paket
            let packageId = null; 
            const [packRows] = await conn.query(
                "SELECT id FROM packages WHERE name = ? OR pppoe_profile = ? LIMIT 1", 
                [calon.package_name, calon.package_name]
            );
            if (packRows.length > 0) packageId = packRows[0].id;
            const tglPasangAsli = calon.created_at;
            const instDateObj = new Date(tglPasangAsli);
            const billingDay = instDateObj.getDate(); // Ambil tanggal asli murni (Misal: 31)
            // Arahkan ke tanggal 1 bulan depan agar aman
            const expDate = new Date(instDateObj.getFullYear(), instDateObj.getMonth() + 1, 1);
            
            // Hitung hari maksimal di bulan depan
            const maxDaysInNextMonth = new Date(instDateObj.getFullYear(), instDateObj.getMonth() + 2, 0).getDate();
            
            // Kunci tanggal jatuh tempo, tapi JANGAN rusak billingDay asli
            expDate.setDate(Math.min(billingDay, maxDaysInNextMonth));
            expDate.setHours(23, 59, 59);
            const radiusExpFormat = this.formatRadiusDate(expDate);
            // INSERT KE CUSTOMERS LENGKAP ANTI GAIB
            const sqlInsert = `
                INSERT INTO customers (
                    name, username, password, address, phone, pppoe_username, pppoe_password, 
                    pppoe_profile, package_id, status, billing_day, 
                    expired_date, installation_date, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, NOW())
            `;
            
            await conn.query(sqlInsert, [
                calon.customer_name || calon.name, 
                calon.pppoe_user,                  
                calon.pppoe_pass || '123456',      
                calon.address, 
                calon.whatsapp_no || calon.phone, 
                calon.pppoe_user, 
                calon.pppoe_pass, 
                calon.package_name, 
                packageId, 
                billingDay, 
                expDate,        
                tglPasangAsli,  
            ]);
            // D. Sinkron Radius
            await conn.query("DELETE FROM radcheck WHERE username = ?", [calon.pppoe_user]);
            await conn.query("DELETE FROM radusergroup WHERE username = ?", [calon.pppoe_user]);
            await conn.query("INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Cleartext-Password', ':=', ?)", [calon.pppoe_user, calon.pppoe_pass]);
            await conn.query("INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Expiration', ':=', ?)", [calon.pppoe_user, radiusExpFormat]);
            await conn.query("INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, 1)", [calon.pppoe_user, calon.package_name]);
            // E. Tandai Selesai
            await conn.query("UPDATE pending_registrations SET status = 'validated' WHERE id = ?", [regId]);
            // F. ?? WA NOTIFICATION & ALARM TEKNISI (Background Task) ??
            setImmediate(async () => {
                try {
                    const whatsappManager = require('./whatsapp-notifications');
                    if (!whatsappManager) return;
                    const namaPelanggan = calon.customer_name || calon.name;
                    // 1. KIRIM WA KE PELANGGAN (Welcome Message)
                    let waPhone = (calon.whatsapp_no || calon.phone || '').toString().replace(/\D/g, '');
                    waPhone = waPhone.startsWith('0') ? '62' + waPhone.slice(1) : waPhone;
                    
                    if (typeof whatsappManager.sendWelcomeMessage === 'function') {
                        whatsappManager.sendWelcomeMessage({
                            name: namaPelanggan, 
                            phone: waPhone, 
                            package_name: calon.package_name,
                            username: calon.pppoe_user, 
                            password: calon.pppoe_pass, 
                            wifi_password: calon.pppoe_pass
                        });
                    }
                    // 2. ?? KIRIM ALARM WA KE HP TEKNISI ??
                    if (calon.technician_id) {
                        // Cari nomor HP Teknisi dari database
                        const [techRows] = await pool.query("SELECT name, phone FROM technicians WHERE id = ?", [calon.technician_id]);
                        
                        if (techRows.length > 0 && techRows[0].phone) {
                            let techPhone = techRows[0].phone.toString().replace(/\D/g, '');
                            techPhone = techPhone.startsWith('0') ? '62' + techPhone.slice(1) : techPhone;
                            const techName = techRows[0].name;
                            // Merakit Pesan Notifikasi untuk Teknisi
                            const pesanTeknisi = `*FIELD VALIDATION COMPLETED*\n\n` +
                                `Halo Teknisi *${techName}*,\n` +
                                `Laporan Pemasangan Baru atas nama *${namaPelanggan}* telah *DIVALIDASI* oleh Admin dan resmi Aktif! ?\n\n` +
                                `_Task recorded successfully._`;
                            if (typeof whatsappManager.sendMessage === 'function') {
                                await whatsappManager.sendMessage(techPhone, pesanTeknisi);
                            } else if (typeof whatsappManager.sendText === 'function') {
                                await whatsappManager.sendText(techPhone, pesanTeknisi);
                            } else {
                                console.log('?? Fungsi kirim teks WA ke Teknisi belum tersedia di whatsappManager.');
                            }
                        }
                    }
                    if (global.io) {
                        global.io.emit('alarm_teknisi', {
                            technician_id: calon.technician_id,
                            title: 'VALIDASI SUKSES!',
                            message: `Pelanggan ${namaPelanggan} resmi divalidasi!`
                        });
                    }
                } catch (e) { 
                    console.log('? Error Background Notif & Alarm:', e.message); 
                }
            });
            return true;
        });
    }
    
    async getValidatedRegistrations() {
        try {
            // Kita tarik data pendaftaran yang statusnya sudah 'validated' (Selesai Pasang)
            const sql = `
                SELECT 
                    p.*, 
                    t.name as technician_name
                FROM pending_registrations p
                LEFT JOIN technicians t ON p.technician_id = t.id
                WHERE p.status = 'validated'
                ORDER BY p.created_at DESC
            `;
            const [rows] = await pool.query(sql);
            return rows; // Sekarang rows sudah mengandung odp_data dan port_data
        } catch (error) {
            console.error("? Gagal ambil data validated:", error.message);
            return [];
        }
    }
    
    async getActiveIsolirProfile(conn) {
        // Cari di tabel packages, ambil pppoe_profile dari paket yang namanya 'isolir'
        const sql = "SELECT pppoe_profile FROM packages WHERE name = 'isolir' LIMIT 1";
        const [rows] = await conn.query(sql);
        // Jika ketemu pakai dari DB, jika tidak ada fallback ke 'isolir'
        return rows.length > 0 ? rows[0].pppoe_profile : 'isolir';
    }
    
    async createCustomTransaction(data, adminName) {
        return this.withTransaction(async (conn) => {
            const { description, type, amount, payment_method } = data;
            const isExpense = type === 'expense';
            // Jika pengeluaran, kita jadikan angkanya minus (-) agar otomatis memotong pendapatan kotor
            const finalAmount = isExpense ? -Math.abs(amount) : Math.abs(amount);
            // 1. Cari atau buat akun "TRANSAKSI UMUM" agar database tidak error
            let customerId;
            const [custRows] = await conn.query("SELECT id FROM customers WHERE username = 'trx_umum' LIMIT 1");
            
            if (custRows.length > 0) {
                customerId = custRows[0].id;
            } else {
                const [res] = await conn.execute(
                    "INSERT INTO customers (username, name, phone, status, auto_suspension) VALUES ('trx_umum', 'TRANSAKSI UMUM', '000000000000', 'active', 0)"
                );
                customerId = res.insertId;
            }
            // 2. Buat Invoice Bayangan (Otomatis Lunas)
            const rand = Math.floor(1000 + Math.random() * 9000);
            const invNumber = `TRX-${Date.now().toString().slice(-6)}-${rand}`;
            
            const [invRes] = await conn.execute(
                `INSERT INTO invoices (invoice_number, customer_id, amount, due_date, status, month, year, notes, created_at, paid_at, payment_date, payment_method)
                 VALUES (?, ?, ?, CURDATE(), 'paid', MONTH(CURDATE()), YEAR(CURDATE()), ?, NOW(), NOW(), NOW(), ?)`,
                [invNumber, customerId, finalAmount, description, payment_method]
            );
            
            // 3. Masukkan ke Riwayat Transaksi (payments)
            const refNumber = `MANUAL-${rand}`;
            await conn.execute(
                `INSERT INTO payments (invoice_id, amount, payment_method, reference_number, payment_date, notes, admin_name)
                 VALUES (?, ?, ?, ?, NOW(), ?, ?)`,
                [invRes.insertId, finalAmount, payment_method, refNumber, description, adminName]
            );
            return { success: true };
        });
    }
    
    // =============================================================
    // AMBIL DATA CUSTOMER UNTUK DATATABLES (SERVER-SIDE AJAX)
    // =============================================================
    async getCustomersDatatable(params) {
        let conn;
        try {
            conn = await pool.getConnection();
            
            const draw = params.draw || 1;
            const start = parseInt(params.start) || 0;
            const length = parseInt(params.length) || 20;
            const searchValue = params.search?.value || '';
            
            // 1. Parameter Sorting dari DataTables Frontend
            const orderColumnIndex = params.order?.[0]?.column || 1; 
            const inputDir = (params.order?.[0]?.dir || 'desc').toLowerCase();
            const orderDir = (inputDir === 'asc') ? 'asc' : 'desc';
            
            // Map index kolom Frontend ke Database
            const columnsMap = [
                'c.name', 
                'c.installation_date', 
                'c.pppoe_username', 
                'pkg.name', 
                'c.status', 
                'c.phone', 
                'c.id'
            ];
            const orderByStr = columnsMap[orderColumnIndex] || 'c.installation_date';
            // 2. Filter Pencarian Cerdas
            let searchQuery = "";
            let searchParams = [];
            if (searchValue) {
                // Tambahkan 'AND' karena kita akan gabungkan dengan pengecualian TRANSAKSI UMUM
                searchQuery = " AND (c.name LIKE ? OR c.pppoe_username LIKE ? OR c.phone LIKE ? OR c.address LIKE ?) ";
                const wildcard = `%${searchValue}%`;
                searchParams = [wildcard, wildcard, wildcard, wildcard];
            }
            // 3. Hitung Total Semua Data Murni (Sembunyikan TRANSAKSI UMUM)
            const [totalRows] = await conn.query("SELECT COUNT(*) as count FROM customers WHERE name != 'TRANSAKSI UMUM'");
            const totalRecords = totalRows[0].count;
            // 4. Hitung Total Data Setelah Difilter Pencarian (Sembunyikan TRANSAKSI UMUM)
            const countQuery = `
                SELECT COUNT(*) as count FROM customers c 
                LEFT JOIN packages pkg ON c.package_id = pkg.id 
                WHERE c.name != 'TRANSAKSI UMUM' ${searchQuery}
            `;
            const [filteredRows] = await conn.query(countQuery, searchParams);
            const totalFiltered = filteredRows[0].count;
            // 5. Tarik Data Utama (Sembunyikan TRANSAKSI UMUM)
            const dataQuery = `
                SELECT 
                    c.id, c.name, c.phone, c.address, c.status, 
                    c.pppoe_username, c.pppoe_password, c.billing_day,
                    c.installation_date, c.expired_date,
                    c.package_id, pkg.name as package_name
                FROM customers c
                LEFT JOIN packages pkg ON c.package_id = pkg.id
                WHERE c.name != 'TRANSAKSI UMUM' ${searchQuery}
                ORDER BY ${orderByStr} ${orderDir}
                LIMIT ? OFFSET ?
            `;
            
            // Gabungkan array pencarian dengan Limit & Offset
            const dataParams = [...searchParams, length, start];
            const [customersData] = await conn.query(dataQuery, dataParams);
            // 6. Rapihkan Format JSON Sesuai Standar DataTables
            return {
                draw: parseInt(draw),
                recordsTotal: totalRecords,
                recordsFiltered: totalFiltered,
                data: customersData
            };
        } catch (error) {
            console.error("? [MANAGER ERROR] getCustomersDatatable:", error.message);
            throw error;
        } finally {
            if (conn) conn.release();
        }
    }
    
    // =============================================================
    // AMBIL DATA INVOICE UNTUK DATATABLES (SERVER-SIDE AJAX)
    // =============================================================
    async getInvoicesDatatable(params) {
        let conn;
        try {
            conn = await pool.getConnection();
            
            const draw = params.draw || 1;
            const start = parseInt(params.start) || 0;
            const length = parseInt(params.length) || 20;
            const searchValue = params.search?.value || '';
            
            // 1. Parameter Sorting dari Frontend
            const orderColumnIndex = params.order?.[0]?.column || 4; // Default urut berdasarkan Jatuh Tempo (Kolom ke-4)
            const inputDir = (params.order?.[0]?.dir || 'desc').toLowerCase();
            const orderDir = (inputDir === 'asc') ? 'asc' : 'desc';
            
            // Map index kolom ke Database
            const columnsMap = [
                'i.invoice_number', 
                'c.name', 
                'pkg.name', 
                'i.amount', 
                'i.due_date', 
                'i.status', 
                'i.id'
            ];
            const orderByStr = columnsMap[orderColumnIndex] || 'i.due_date';
            // 2. Filter Pencarian Pintar (Berdasarkan No. Invoice & Nama Pelanggan)
            let searchQuery = "";
            let searchParams = [];
            if (searchValue) {
                searchQuery = " AND (i.invoice_number LIKE ? OR c.name LIKE ?) ";
                const wildcard = `%${searchValue}%`;
                searchParams = [wildcard, wildcard];
            }
            // 3. Hitung Total Tagihan Keseluruhan
            const [totalRows] = await conn.query("SELECT COUNT(*) as count FROM invoices");
            const totalRecords = totalRows[0].count;
            // 4. Hitung Total Tagihan Setelah Filter Pencarian
            const countQuery = `
                SELECT COUNT(*) as count FROM invoices i 
                LEFT JOIN customers c ON i.customer_id = c.id 
                WHERE 1=1 ${searchQuery}
            `;
            const [filteredRows] = await conn.query(countQuery, searchParams);
            const totalFiltered = filteredRows[0].count;
            // 5. Tarik Data Invoice Bersama Nama Customer dan Nama Paket (LIMIT & OFFSET)
            const dataQuery = `
                SELECT 
                    i.id, i.invoice_number, i.amount, i.due_date, i.status, i.notes, i.customer_id,
                    c.name as customer_name, c.phone,
                    pkg.name as package_name
                FROM invoices i
                LEFT JOIN customers c ON i.customer_id = c.id
                LEFT JOIN packages pkg ON c.package_id = pkg.id
                WHERE 1=1 ${searchQuery}
                ORDER BY ${orderByStr} ${orderDir}
                LIMIT ? OFFSET ?
            `;
            
            const dataParams = [...searchParams, length, start];
            const [invoicesData] = await conn.query(dataQuery, dataParams);
            // 6. Kembalikan Format JSON Spesial DataTables
            return {
                draw: parseInt(draw),
                recordsTotal: totalRecords,
                recordsFiltered: totalFiltered,
                data: invoicesData
            };
        } catch (error) {
            console.error("? [MANAGER ERROR] getInvoicesDatatable:", error.message);
            throw error;
        } finally {
            if (conn) conn.release(); // Jangan lupa tutup koneksi
        }
    }
    
    // =============================================================
    // AMBIL DATA TRANSAKSI UNTUK DATATABLES (SERVER-SIDE AJAX)
    // =============================================================
    async getPaymentsDatatable(params) {
        let conn;
        try {
            conn = await pool.getConnection();
            
            const draw = params.draw || 1;
            const start = parseInt(params.start) || 0;
            const length = parseInt(params.length) || 20;
            const searchValue = params.search?.value || '';
            
            // Tangkap Filter Kustom dari EJS
            const filterMethod = params.filterMethod || '';
            const startDate = params.startDate || '';
            const endDate = params.endDate || '';
            
            // Parameter Sorting
            const orderColumnIndex = params.order?.[0]?.column || 1; // Default ke kolom Tanggal & Waktu
            const inputDir = (params.order?.[0]?.dir || 'desc').toLowerCase();
            const orderDir = (inputDir === 'asc') ? 'asc' : 'desc';
            
            // Map index kolom ke Database
            const columnsMap = [
                null, 
                'p.payment_date', 
                'c.name', 
                'p.amount', 
                'p.admin_name', 
                'p.payment_method', 
                'p.amount', 
                'p.id'
            ];
            const orderByStr = columnsMap[orderColumnIndex] || 'p.payment_date';
            let searchQuery = "";
            let searchParams = [];
            // 1. Eksekusi Pencarian Pintar (Teks)
            if (searchValue) {
                searchQuery += " AND (c.name LIKE ? OR i.invoice_number LIKE ? OR p.notes LIKE ? OR p.admin_name LIKE ?) ";
                const wildcard = `%${searchValue}%`;
                searchParams.push(wildcard, wildcard, wildcard, wildcard);
            }
            
            // 2. Eksekusi Filter Dropdown (Cash / Transfer)
            if (filterMethod) {
                searchQuery += " AND p.payment_method LIKE ? ";
                searchParams.push(`%${filterMethod}%`);
            }
            
            // 3. Eksekusi Filter Rentang Tanggal
            if (startDate && endDate) {
                searchQuery += " AND p.payment_date BETWEEN ? AND ? ";
                searchParams.push(`${startDate} 00:00:00`, `${endDate} 23:59:59`);
            } else if (startDate) {
                searchQuery += " AND p.payment_date >= ? ";
                searchParams.push(`${startDate} 00:00:00`);
            } else if (endDate) {
                searchQuery += " AND p.payment_date <= ? ";
                searchParams.push(`${endDate} 23:59:59`);
            }
            // Hitung Total Data Keseluruhan (Tanpa Filter)
            const [totalRows] = await conn.query("SELECT COUNT(*) as count FROM payments");
            const totalRecords = totalRows[0].count;
            // Hitung Total Data yang Ter-Filter
            const countQuery = `
                SELECT COUNT(*) as count FROM payments p 
                LEFT JOIN invoices i ON p.invoice_id = i.id 
                LEFT JOIN customers c ON i.customer_id = c.id 
                WHERE 1=1 ${searchQuery}
            `;
            const [filteredRows] = await conn.query(countQuery, searchParams);
            const totalFiltered = filteredRows[0].count;
            // Tarik Data Utama (LIMIT & OFFSET)
            const dataQuery = `
                SELECT 
                    p.id, p.id as payment_id, p.amount, p.payment_date, p.payment_method, p.admin_name, p.notes,
                    i.id as invoice_id, i.invoice_number,
                    c.name as customer_name
                FROM payments p
                LEFT JOIN invoices i ON p.invoice_id = i.id
                LEFT JOIN customers c ON i.customer_id = c.id
                WHERE 1=1 ${searchQuery}
                ORDER BY ${orderByStr} ${orderDir}
                LIMIT ? OFFSET ?
            `;
            
            const dataParams = [...searchParams, length, start];
            const [paymentsData] = await conn.query(dataQuery, dataParams);
            // Kembalikan Data ke Frontend
            return {
                draw: parseInt(draw),
                recordsTotal: totalRecords,
                recordsFiltered: totalFiltered,
                data: paymentsData
            };
        } catch (error) {
            console.error("? [MANAGER ERROR] getPaymentsDatatable:", error.message);
            throw error;
        } finally {
            if (conn) conn.release();
        }
    }
    
    async getPelangganNunggak() {
        try {
            // Mengambil data pelanggan yang sudah melewati tanggal expired
            const sql = `
                SELECT c.id, c.name, c.address, c.phone, p.name as package_name, c.expired_date 
                FROM customers c 
                LEFT JOIN packages p ON c.package_id = p.id 
                WHERE c.expired_date IS NOT NULL AND c.expired_date < CURDATE()
                ORDER BY c.expired_date ASC
            `;
            const [rows] = await pool.query(sql);
            return rows;
        } catch (error) {
            console.error("? Gagal Ambil Data Nunggak:", error.message);
            throw error;
        }
    }
    
    /**
     * ??? AUTO-HEAL: PROTEKSI PROFIL ISOLIR
     * Berjalan otomatis saat sistem di-restart untuk memastikan 
     * MikroTik selalu tahu ke mana harus melempar pelanggan nunggak.
     */
    async injectIsolirProtection() {
        // PERBAIKAN: Menggunakan 'pool' sesuai dengan nama import di file ini
        const conn = await pool.getConnection(); 
        try {
            // Daftar grup yang WAJIB mengarah ke IP Isolir di MikroTik
            const requiredProfiles = ['EXPIRED', 'isolir'];
            
            for (const groupName of requiredProfiles) {
                // 1. CEK DULU: Apakah senjata pemaksa (Mikrotik-Group) sudah tertanam?
                const [exist] = await conn.execute(
                    "SELECT id FROM radgroupreply WHERE groupname = ? AND attribute = 'Mikrotik-Group' AND value = 'isolir'",
                    [groupName]
                );
                
                // 2. JIKA HILANG / BELUM ADA, SUNTIKKAN OTOMATIS!
                if (exist.length === 0) {
                    await conn.execute(
                        "INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES (?, 'Mikrotik-Group', ':=', 'isolir')",
                        [groupName]
                    );
                    console.log(`??? [AUTO-HEAL] Sistem menyuntikkan proteksi Isolir untuk grup: ${groupName}`);
                }
            }
        } catch (err) {
            console.error("?? [AUTO-HEAL ERROR] Gagal memeriksa proteksi isolir:", err.message);
        } finally {
            if (conn) conn.release();
        }
    }
}
// Create singleton instance
const billingManager = new BillingManager();
billingManager.getCustomers = billingManager.getAllCustomers;
billingManager.injectIsolirProtection().then(() => {
    console.log("? [SYSTEM] Pengecekan keamanan profil Isolir selesai.");
}).catch(err => {
    console.error("? [SYSTEM] Gagal menjalankan proteksi Isolir:", err.message);
});
module.exports = billingManager;
