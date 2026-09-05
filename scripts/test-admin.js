#!/usr/bin/env node

// Script untuk test admin functionality
const fs = require('fs');
const path = require('path');

// Load settings
const { getSetting } = require('../config/settingsManager');
const settings = {};
settings.admins = getSetting('admins', []);
settings.technician_numbers = getSetting('technician_numbers', []);

console.log('=== Test Admin Functionality ===\n');

// Test admin numbers
console.log('ðŸ“‹ Admin Configuration:');
console.log(`Admin numbers: ${JSON.stringify(settings.admins)}`);
console.log(`Technician numbers: ${JSON.stringify(settings.technician_numbers)}`);
console.log('');

// Test isAdminNumber function
function testIsAdminNumber(number) {
    try {
        const cleanNumber = number.replace(/\D/g, '');
        
        // Cek admin dari settings.json
        const adminNumbers = settings.admins || [];
        for (const adminNumber of adminNumbers) {
            const cleanAdminNumber = adminNumber.replace(/\D/g, '');
            if (cleanNumber === cleanAdminNumber) {
                return true;
            }
        }
        
        // Cek technician numbers dari settings.json
        const technicianNumbers = settings.technician_numbers || [];
        for (const techNumber of technicianNumbers) {
            const cleanTechNumber = techNumber.replace(/\D/g, '');
            if (cleanNumber === cleanTechNumber) {
                return true;
            }
        }
        
        return false;
    } catch (error) {
        console.error('Error in testIsAdminNumber:', error);
        return false;
    }
}

// Test beberapa nomor
const testNumbers = [
    '6281234567890',
    '081234567890',
    '081234567891',
    '081234567892',
    '081234567890' // Nomor test yang bukan admin
];

console.log('ðŸ” Testing Admin Number Validation:');
for (const number of testNumbers) {
    const isAdmin = testIsAdminNumber(number);
    console.log(`${number}: ${isAdmin ? 'âœ… Admin' : 'âŒ Not Admin'}`);
}
console.log('');

// Test message
const testMessage = `ðŸ§ª *TEST ADMIN BOT*\n\n` +
    `âœ… Ini adalah pesan test untuk memverifikasi fungsi admin\n` +
    `ðŸ“… Waktu: ${new Date().toLocaleString()}\n\n` +
    `ðŸ”§ Jika Anda menerima pesan ini, berarti:\n` +
    `â€¢ Fungsi isAdminNumber berfungsi dengan baik\n` +
    `â€¢ Pengiriman pesan ke admin berhasil\n` +
    `â€¢ Bot siap digunakan\n\n` +
    `ðŸ¢ *ALIJAYA DIGITAL NETWORK*`;

console.log('ðŸ“ Test message yang akan dikirim:');
console.log(testMessage);
console.log('');

// Cek file superadmin.txt
try {
    const superAdminPath = path.join(__dirname, '../config/superadmin.txt');
    if (fs.existsSync(superAdminPath)) {
        const superAdmin = fs.readFileSync(superAdminPath, 'utf8').trim();
        console.log(`ðŸ‘‘ Super admin: ${superAdmin}`);
    } else {
        console.log('âŒ File superadmin.txt tidak ditemukan');
    }
} catch (error) {
    console.log('âŒ Error reading superadmin.txt:', error.message);
}

console.log('');
console.log('âœ… Script test admin selesai.');
console.log('ðŸ’¡ Tips: Jalankan aplikasi dengan "node scripts/restart-on-error.js"');
console.log('ðŸ“± Test dengan mengirim pesan "menu" atau "admin" ke bot WhatsApp'); 