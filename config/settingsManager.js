const fs = require('fs');
const path = require('path');
const performanceMonitor = require('./performanceMonitor');
const { exec } = require('child_process');
const dbPool = require('./database');
const backupDir = path.join(process.cwd(), 'data', 'backup');
const settingsPath = path.join(__dirname, '../settings.json')
if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
// In-memory cache untuk performa
let settingsCache = null;
let lastModified = null;
let cacheExpiry = null;
const CACHE_TTL = 5000; // 5 detik cache
function loadSettingsFromFile() {
  const startTime = Date.now();
  let wasCacheHit = false;
  
  try {
    const stats = fs.statSync(settingsPath);
    const fileModified = stats.mtime.getTime();
    
    // Jika file tidak berubah dan cache masih valid, gunakan cache
    if (settingsCache && 
        lastModified === fileModified && 
        cacheExpiry && 
        Date.now() < cacheExpiry) {
      wasCacheHit = true;
      performanceMonitor.recordCall(startTime, wasCacheHit);
      return settingsCache;
    }
    
    // Baca file dan update cache
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    settingsCache = JSON.parse(raw);
    lastModified = fileModified;
    cacheExpiry = Date.now() + CACHE_TTL;
    
    performanceMonitor.recordCall(startTime, wasCacheHit);
    return settingsCache;
  } catch (e) {
    // Log error agar kalau JSON rusak/typo langsung ketahuan di console/PM2
    console.error('\n[CRITICAL ERROR] Gagal membaca settings.json:', e.message, '\n');
    performanceMonitor.recordCall(startTime, wasCacheHit);
    return settingsCache || {};
  }
}
function getSettingsWithCache() {
  return loadSettingsFromFile();
}
function getSetting(key, defaultValue) {
  const settings = getSettingsWithCache();
  return settings[key] !== undefined ? settings[key] : defaultValue;
}
async function setSetting(key, value) {
  try {
    // 1. SIMPAN KE DATABASE MARIADB (SOP SATU PINTU & TEKNIK UPSERT)
    const sql = `
        INSERT INTO app_settings (setting_key, value) 
        VALUES (?, ?) 
        ON DUPLICATE KEY UPDATE value = VALUES(value)
    `;
    await dbPool.execute(sql, [key, String(value)]);
    // 2. SIMPAN KE FILE JSON (Untuk Backup & Cache Kinerja)
    const settings = getSettingsWithCache();
    settings[key] = value;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    
    // 3. INVALIDATE CACHE
    settingsCache = settings;
    lastModified = fs.statSync(settingsPath).mtime.getTime();
    cacheExpiry = Date.now() + CACHE_TTL;
    
    return true;
  } catch (e) {
    console.error(`[SETTINGS] Gagal menyimpan ${key}:`, e.message);
    return false;
  }
}
// Clear cache function untuk debugging/maintenance
function clearSettingsCache() {
  settingsCache = null;
  lastModified = null;
  cacheExpiry = null;
}
async function logActivity(userId, action, description, req) {
    try {
        const ip = req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || 'SYSTEM_INTERNAL';
        await dbPool.query(
            "INSERT INTO activity_logs (user_id, user_type, action, description, ip_address) VALUES (?, 'admin', ?, ?, ?)",
            [userId || 'admin', action, description, ip]
        );
    } catch (err) {
        console.error('Pena Log Error (Ignored):', err?.message);
    }
}
async function getActivityLogs(limit = 50) {
    const [logs] = await dbPool.query(`SELECT * FROM activity_logs ORDER BY created_at DESC LIMIT ?`, [limit]);
    return logs;
}
async function clearOldActivityLogs(days = 30) {
    await dbPool.query(`DELETE FROM activity_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)`, [days]);
    return true;
}
    // Database initialization routine
async function createDatabaseBackup(adminUsername, req) {
    return new Promise((resolve, reject) => {
        try {
            const dbConfig = dbPool.pool.config.connectionConfig;
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `gembok_backup_${timestamp}.sql`;
            const filepath = path.join(backupDir, filename);
            const cmd = `mysqldump -h ${dbConfig.host} -u ${dbConfig.user} -p"${dbConfig.password}" ${dbConfig.database} > "${filepath}"`;
            exec(cmd, (error, stdout, stderr) => {
                if (error) {
                    console.error(`Backup Fail: ${stderr}`);
                    return reject(new Error('Gagal membuat file backup SQL.'));
                }
                logActivity(adminUsername, 'DATABASE_BACKUP', `Sukses membuat backup file: ${filename}`, req);
                resolve({ filename });
            });
        } catch (e) {
            reject(e);
        }
    });
}
    // Database initialization routine
async function restoreDatabase(backup_file, adminUsername, req) {
    return new Promise((resolve, reject) => {
        try {
            const dbConfig = dbPool.pool.config.connectionConfig;
            const filepath = path.join(backupDir, backup_file);
            if (!fs.existsSync(filepath)) return reject(new Error('File fisik tidak ditemukan di server.'));
            const cmd = `mysql -h ${dbConfig.host} -u ${dbConfig.user} -p"${dbConfig.password}" ${dbConfig.database} < "${filepath}"`;
            exec(cmd, (error, stdout, stderr) => {
                if (error) {
                    console.error(`Restore Fail: ${stderr}`);
                    return reject(new Error('Gagal Restore. Pastikan file SQL valid.'));
                }
                logActivity(adminUsername, 'DATABASE_RESTORE', `Sukses memulihkan database dari file: ${backup_file}`, req);
                resolve(true);
            });
        } catch (e) {
            reject(e);
        }
    });
}
function getBackupsList() {
    if (!fs.existsSync(backupDir)) return [];
    return fs.readdirSync(backupDir)
        .filter(file => file.endsWith('.sql'))
        .map(file => {
            const stats = fs.statSync(path.join(backupDir, file));
            return { filename: file, size: stats.size, created: stats.mtime };
        })
        .sort((a, b) => b.created - a.created);
}
// 6. UPDATE MODULE.EXPORTS (Tambahkan fungsi-fungsi baru ke daftar ekspor)
// Ganti module.exports yang lama dengan yang baru ini:
module.exports = { 
  getSettingsWithCache, 
  getSetting, 
  setSetting, 
  clearSettingsCache,
  getPerformanceStats: () => performanceMonitor.getStats(),
  getPerformanceReport: () => performanceMonitor.getPerformanceReport(),
  getQuickStats: () => performanceMonitor.getQuickStats(),
  // --- TAMBAHAN BARU ---
  logActivity,
  getActivityLogs,
  clearOldActivityLogs,
  createDatabaseBackup,
  restoreDatabase,
  getBackupsList,
  backupDir // Diexport untuk keperluan download di router
};
