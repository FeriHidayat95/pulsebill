const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
// --- AWAL JARING PENGAMAN ANTI-LOGOUT (TAMBAHKAN INI) ---
process.on('uncaughtException', (err) => {
    if (err.message.includes('!empty') || err.message.includes('unknown reply')) {
        // Handle transient MikroTik v7 socket events
    } else {
        console.error('?? [SYSTEM ERROR]:', err.message);
    }
});
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const session = require('express-session');
const multer = require('multer');
const expressLayouts = require('express-ejs-layouts');
// --- CONFIG IMPORTS ---
const logger = require('./config/logger');
const whatsapp = require('./config/whatsapp');
const { getSetting } = require('./config/settingsManager');
const invoiceScheduler = require('./config/scheduler');
const pppoeMonitor = require('./config/pppoe-monitor');
const pppoeCommands = require('./config/pppoe-commands');
const genieacsCommands = require('./config/genieacs-commands');
const rxPowerMonitor = require('./config/rxPowerMonitor');
const { addCustomerTag } = require('./config/customerTag');
// === OTOMATISASI & CRON JOBS ===
const cron = require('node-cron');
// [DIHAPUS] const checkDueInvoicesAndNotify = require('./cron/reminder_job'); <- SUDAH TIDAK DIPAKAI
const cleanGhostSessions = require('./cron/ghost_cleaner');
const billingManager = require('./config/billing'); // INI JALUR RESMI KITA
global.billingManager = billingManager;
const { RadiusManager } = require('./config/RadiusManager'); // Pastikan path-nya benar
global.RadiusManager = RadiusManager;
const whatsappNotifications = require('./config/whatsapp-notifications');
// ======================================
// --- ROUTE IMPORTS ---
// Admin Auth & Middleware
const { router: adminAuthRouter, adminAuth } = require('./routes/adminAuth');
const { blockTechnicianAccess } = require('./middleware/technicianAccessControl');
// Admin Feature Routes
const adminDashboardRouter = require('./routes/adminDashboard');
const adminGenieacsRouter = require('./routes/adminGenieacs');
const adminMikrotikRouter = require('./routes/adminMikrotik');
const adminNASRouter = require('./routes/adminNAS');
const adminRadiusRouter = require('./routes/adminRadius');
const adminHotspotRouter = require('./routes/adminHotspot');
const adminUsersRouter = require('./routes/adminUsers');
const voucherMonitorRouter = require('./routes/adminVoucherMonitor');
const adminSettingRouter = require('./routes/adminSetting');
const adminLogsRouter = require('./routes/adminLogs');
const adminTroubleReportRouter = require('./routes/adminTroubleReport');
const adminBillingRouter = require('./routes/adminBilling');
const controlPendaftaran = require('./routes/controlPendaftaran');
const teknisiRoute = require('./routes/teknisi');
const adminAgentRouter = require('./routes/adminAgent');
const agentRoutes = require('./routes/agent');
// Customer & Public Routes
const paymentRouter = require('./routes/payment'); 
const testTroubleReportRouter = require('./routes/testTroubleReport');
const troubleReportRouter = require('./routes/troubleReport');
const apiDashboardRouter = require('./routes/apiDashboard');
const customerPortal = require('./routes/customerPortal');
const customerBillingRouter = require('./routes/customerBilling');
// --- INISIALISASI ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.set('socketio', io);
global.io = io;
app.get('/favicon.ico', (req, res) => res.status(204).end());
const VERSION = '1.0.0';
// Global Status WhatsApp
global.whatsappStatus = {
    connected: false,
    qrCode: null,
    phoneNumber: null,
    connectedSince: null,
    status: 'disconnected'
};
// TOMBOL TEMBAK INVOICE VIA BROWSER
app.get('/cron/trigger-invoices', async (req, res) => {
    try {
        const count = await billingManager.generateMonthlyInvoices();
        res.send(`?? DORRR! ${count} Invoice terbit & WA Terkirim!`);
    } catch (e) {
        res.send("Operation failed: " + e.message);
    }
});
    // Synchronize subscriber account state
app.get('/cron/trigger-suspensions', async (req, res) => {
    try {
        // Kalau filenya ada di folder yang sama, pakai './serviceSuspension'
        const suspensionManager = require('./config/serviceSuspension'); 
        
        const result = await suspensionManager.checkAndSuspendOverdueCustomers();
        
        res.send(`?? DORRR! ${result.count} Pelanggan Telat Berhasil Di-Isolir (RTO).`);
    } catch (e) {
        res.send("Suspension execution failed: " + e.message);
    }
});
// --- VIEW ENGINE ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
// app.use(expressLayouts);
// app.set('layout', 'main_layout');
app.use((req, res, next) => {
    const { getSettingsWithCache } = require('./config/settingsManager'); // Sesuaikan path-nya
    const settings = getSettingsWithCache() || {};
    
    // Ini rahasianya: res.locals bikin variabel bisa dibaca di SEMUA EJS
    res.locals.company_header = settings.company_header || "Gembok Radius";
    res.locals.title = "Billing System"; // Sekalian buat title default
    res.locals.onlineCount = 0; 
    res.locals.users = [];
    res.locals.currentPath = req.path;
    next();
});
// --- MIDDLEWARE DASAR ---
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
// =========================================================
// =========================================================
const rateLimit = require('express-rate-limit');
// Penjaga Khusus Pintu Login (Semua Login: Admin, Teknisi, Agen, Customer)
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // Waktu blokir: 15 Menit
    max: 10, // Maksimal 10x percobaan login salah dari IP yang sama
    message: { 
        success: false, 
        message: '?? Terlalu banyak percobaan login gagal dari jaringan Anda. Silakan coba lagi setelah 15 menit.' 
    },
    standardHeaders: true, // Mengirim info limit di header (standar baru)
    legacyHeaders: false,  // Matikan header standar lama
});
// Penjaga Khusus Form EJS (Untuk menghindari serangan form bot massal)
const generalLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 menit
    max: 1000, // Standard API rate limit threshold
    message: "Too many requests. Please try again in a few minutes.", // Ganti pesannya biar jelas
    standardHeaders: true,
    legacyHeaders: false,
});
// Terapkan perlindungan
app.use('/customer/login', loginLimiter);
app.use('/admin/login', loginLimiter);
app.use('/teknisi/login', loginLimiter); // Jika ada
app.use('/agent/login', loginLimiter);   // Jika ada
// --- STATIC FILES ---
app.use('/public', express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));
app.use('/docs', express.static(path.join(__dirname, 'docs'), { maxAge: '1h', etag: true }));
app.use('/', generalLimiter);
// TAMBAHKAN BARIS INI (Wajib ada agar Node.js percaya pada jalur HTTPS)
app.set('trust proxy', 1);
    // RouterOS and RADIUS policy synchronization
const MySQLStore = require('express-mysql-session')(session);
const sessionStoreOptions = {
    host: process.env.DB_HOST || getSetting('db_host', 'localhost'),
    user: process.env.DB_USER || getSetting('db_user', 'root'),       
    password: process.env.DB_PASSWORD || getSetting('db_password', ''),   
    database: process.env.DB_NAME || getSetting('db_name', 'pulsebill_db'),
    createDatabaseTable: true,
    schema: {
        tableName: 'sessions' 
    }
};
const sessionStore = new MySQLStore(sessionStoreOptions);
const sessionSecret = getSetting('session_secret', 'rahasia-portal-anda');
app.use(session({
    key: 'pulsebill_session_id', 
    secret: sessionSecret,
    store: sessionStore,     
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false, // <--- WAJIB TRUE KARENA SUDAH HTTPS
        // 1 TAHUN (Anti-Logout)
        maxAge: 31536000000, 
        httpOnly: true,
        sameSite: 'lax'
    }
}));
// --- WHATSAPP SESSION CHECK ---
const sessionDir = getSetting('whatsapp_session_path', './whatsapp-session');
if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
}
io.on('connection', (socket) => {
    logger.info('?? [SOCKET] Real-time client connected');
});
// ================= ROUTING (JALUR WEB) =================
// 1. Root & Health
app.get('/', (req, res) => res.redirect('/customer/login'));
app.get('/health', (req, res) => res.json({ status: 'ok', version: VERSION }));
app.use('/teknisi', teknisiRoute);
app.use('/', agentRoutes);
// 2. Customer & Public Routes
app.use('/customer/billing', customerBillingRouter);
app.use('/customer/trouble', troubleReportRouter);
app.use('/customer', customerPortal);
// 3. Payment Routes (Gateway & Callback)
app.use('/payment', paymentRouter); 
// 4. Admin Routes (Dilindungi Login)
app.use('/admin', adminAuthRouter); 
// Dashboard & Fitur Utama
app.use('/admin', adminDashboardRouter);
app.use('/admin/users', adminUsersRouter);
app.use('/admin', adminGenieacsRouter);
app.use('/admin', adminMikrotikRouter);
app.use('/admin', adminRadiusRouter);
app.use('/admin', blockTechnicianAccess, adminNASRouter);
app.use('/admin/hotspot', adminHotspotRouter);
app.use('/adminVoucherMonitor', voucherMonitorRouter);
// Menu Setting & Trouble
app.use('/admin/setting', adminAuth, adminSettingRouter);
app.use('/admin/logs', adminAuth, adminLogsRouter);
app.use('/admin/trouble', adminAuth, adminTroubleReportRouter);
// Menu Billing & Paket
app.use('/admin/billing', adminAuth, adminBillingRouter); 
app.use('/admin/packages', require('./routes/adminPackages'));
app.use('/admin/finance', adminAuth, require('./routes/adminFinance'));
app.use('/admin/pendaftaran', controlPendaftaran);
app.use('/', adminAuth, adminAgentRouter);
// 5. API & Testing
app.use('/api', apiDashboardRouter);
app.use('/test/trouble', testTroubleReportRouter);
// ================= STARTUP SERVICES =================
// Connect WhatsApp & Monitors
(async () => {
    try {
        const sock = await whatsapp.connectToWhatsApp();
        if (sock) {
            whatsapp.setSock(sock);
            
            // === [PENTING] SAMBUNGKAN KABEL WA KE NOTIFIKASI ===
            whatsappNotifications.setSock(sock);
            // ===================================================
            
            // Inject socket ke modul-modul lain
            pppoeMonitor.setSock(sock);
            pppoeCommands.setSock(sock);
            genieacsCommands.setSock(sock);
            rxPowerMonitor.setSock(sock);
            
            const troubleReport = require('./config/troubleReport');
            troubleReport.setSockInstance(sock);
            logger.info('WhatsApp connected successfully');
            // Start Monitoring jika ada setting Mikrotik
            // if (getSetting('mikrotik_host') && getSetting('mikrotik_user')) {
            //    pppoeMonitor.initializePPPoEMonitoring().catch(err => logger.error('PPPoE Monitor Error:', err));
            // }
            // try {
            //    rxPowerMonitor.startRXPowerMonitoring();
            // } catch (err) { logger.error('RX Power Monitor Error:', err); }
        }
    } catch (err) {
        logger.error('Error connecting to WhatsApp:', err);
    }
})();
// ================= START SERVER =================
function startServer(portToUse) {
    const port = parseInt(portToUse);
    if (isNaN(port)) {
        logger.error(`Port tidak valid: ${portToUse}`);
        process.exit(1);
    }
    
    try {
        // ?? GANTI app.listen menjadi server.listen
        server.listen(port, () => {
            logger.info(`?? PulseBill server listening on port ${port}`);
            logger.info(`?? Web Admin: http://localhost:${port}/admin/login`);
        }).on('error', (err) => {
            if (err.code === 'EADDRINUSE') logger.error(`? Port ${port} sudah dipakai!`);
            else logger.error('? Server Error:', err.message);
            process.exit(1);
        });
    } catch (error) {
        logger.error(`? Fatal Error:`, error.message);
        process.exit(1);
    }
}
const port = getSetting('server_port', 3001);
startServer(port);
module.exports = app;
