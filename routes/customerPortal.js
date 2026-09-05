const dbPool = require('../config/database');
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { findDeviceByTag } = require('../config/addWAN');
const { findDeviceByPPPoE } = require('../config/genieacs');
const { sendMessage } = require('../config/sendMessage');
const { getSettingsWithCache, getSetting } = require('../config/settingsManager');
const billingManager = require('../config/billing');
const router = express.Router();
// Validasi nomor pelanggan - PRIORITAS KE BILLING SYSTEM
async function isValidCustomer(phone) {
  try {
    // 1. Cek di database billing terlebih dahulu
    const customer = await billingManager.getCustomerByPhone(phone);
    if (customer) {
      console.log(`âœ… Customer found in billing database: ${phone}`);
      return true; // Pelanggan valid jika ada di billing
    }
    
    // 2. Jika tidak ada di billing, cek di GenieACS sebagai fallback
    let device = await findDeviceByTag(phone);
    
    // Jika tidak ditemukan di GenieACS, coba cari berdasarkan PPPoE username dari billing
    if (!device) {
      try {
        const customer = await billingManager.getCustomerByPhone(phone);
        if (customer && customer.pppoe_username) {
          const { findDeviceByPPPoE } = require('../config/genieacs');
          device = await findDeviceByPPPoE(customer.pppoe_username);
        }
      } catch (error) {
        console.error('Error finding device by PPPoE username:', error);
      }
    }
    
    if (device) {
      console.log(`âœ… Customer found in GenieACS: ${phone}`);
      return true;
    }
    
    console.log(`âŒ Customer not found in billing or GenieACS: ${phone}`);
    return false;
    
  } catch (error) {
    console.error('Error in isValidCustomer:', error);
    return false;
  }
}
// Simpan OTP sementara di memory (bisa diganti redis/db)
const otpStore = {};
// parameterPaths dan getParameterWithPaths dari WhatsApp bot
const parameterPaths = {
  rxPower: [
    'VirtualParameters.RXPower',
    'VirtualParameters.redaman',
    'InternetGatewayDevice.WANDevice.1.WANPONInterfaceConfig.RXPower'
  ],
  pppoeIP: [
    'VirtualParameters.pppoeIP',
    'VirtualParameters.pppIP',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress'
  ],
  pppUsername: [
    'VirtualParameters.pppoeUsername',
    'VirtualParameters.pppUsername',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username'
  ],
  uptime: [
    'VirtualParameters.getdeviceuptime',
    'InternetGatewayDevice.DeviceInfo.UpTime'
  ],
  userConnected: [
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.TotalAssociations'
  ]
};
function getParameterWithPaths(device, paths) {
  for (const path of paths) {
    const parts = path.split('.');
    let value = device;
    
    // Alur: Telusuri folder satu per satu (misal: InternetGatewayDevice -> LANDevice -> dst)
    for (const part of parts) {
      if (value && typeof value === 'object' && part in value) {
        value = value[part];
      } else {
        value = undefined;
        break;
      }
    }
    // Eksekusi Akhir: Jika ketemu, pastikan yang diambil isinya (_value), bukan bungkusnya
    if (value !== undefined && value !== null) {
      // Jika ternyata ini objek GenieACS, ambil _value nya
      if (typeof value === 'object' && value._value !== undefined) {
        return String(value._value);
      }
      // Jika sudah teks/angka murni, langsung kirim
      if (typeof value !== 'object') {
        return String(value);
      }
    }
  }
  return '0'; // Jika tidak ada perangkat konek atau jalur buntu
}
// Helper: Ambil info perangkat dan user terhubung - PRIORITAS KE BILLING SYSTEM
async function getCustomerDeviceData(phone) {
  try {
    // 1. Ambil data customer dari billing terlebih dahulu
    const customer = await billingManager.getCustomerByPhone(phone);
    let device = null;
    let billingData = null;
    
    if (customer) {
      console.log(`âœ… Customer found in billing: ${customer.name} (${phone})`);
      
      // 2. Coba ambil data device dari GenieACS jika ada
      device = await findDeviceByTag(phone);
      
      // Jika tidak ditemukan, coba cari berdasarkan PPPoE username dari billing
      if (!device && customer.pppoe_username) {
        try {
          const { findDeviceByPPPoE } = require('../config/genieacs');
          device = await findDeviceByPPPoE(customer.pppoe_username);
        } catch (error) {
          console.error('Error finding device by PPPoE username:', error);
        }
      }
      
      // 3. Siapkan data billing
      try {
        const invoices = await billingManager.getInvoicesByCustomer(customer.id);
        billingData = {
          customer: customer,
          invoices: invoices || []
        };
      } catch (error) {
        console.error('Error getting billing data:', error);
        billingData = {
          customer: customer,
          invoices: []
        };
      }
    } else {
      // Fallback: coba cari di GenieACS saja
      device = await findDeviceByTag(phone);
      
      if (!device) {
        try {
          const customer = await billingManager.getCustomerByPhone(phone);
          if (customer && customer.pppoe_username) {
            const { findDeviceByPPPoE } = require('../config/genieacs');
            device = await findDeviceByPPPoE(customer.pppoe_username);
          }
        } catch (error) {
          console.error('Error finding device by PPPoE username:', error);
        }
      }
    }
    
    // 4. Jika tidak ada device di GenieACS, buat data default
    if (!device) {
      console.log(`âš ï¸ No device found in GenieACS for: ${phone}`);
      
      // Buat data default berdasarkan customer billing
      const defaultData = {
        phone: phone,
        ssid: customer ? 'WiFi-' + customer.username : 'WiFi-Default',
        status: 'Unknown',
        lastInform: '-',
        softwareVersion: '-',
        rxPower: '-',
        pppoeIP: '-',
        pppoeUsername: customer ? customer.pppoe_username : '-',
        totalAssociations: '0',
        connectedUsers: [],
        billingData: billingData
      };
      
      return defaultData;
    }
    
    // 5. Jika ada device di GenieACS, ambil data lengkap
    const ssid = device?.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration?.['1']?.SSID?._value || '-';
    const lastInform =
      device?._lastInform
        ? new Date(device._lastInform).toLocaleString('id-ID')
        : device?.Events?.Inform
          ? new Date(device.Events.Inform).toLocaleString('id-ID')
          : device?.InternetGatewayDevice?.DeviceInfo?.['1']?.LastInform?._value
            ? new Date(device.InternetGatewayDevice.DeviceInfo['1'].LastInform._value).toLocaleString('id-ID')
            : '-';
    const status = lastInform !== '-' ? 'Online' : 'Unknown';
    
    // User terhubung (WiFi)
    let connectedUsers = [];
    try {
      const totalAssociations = getParameterWithPaths(device, parameterPaths.userConnected);
      if (totalAssociations && totalAssociations !== 'N/A' && totalAssociations > 0) {
        connectedUsers = Array.from({ length: parseInt(totalAssociations) }, (_, i) => ({
          id: i + 1,
          name: `User ${i + 1}`,
          ip: `192.168.1.${100 + i}`,
          mac: `00:11:22:33:44:${(50 + i).toString(16).padStart(2, '0')}`,
          connected: true
        }));
      }
    } catch (error) {
      console.error('Error getting connected users:', error);
    }
    
    // Ambil data lainnya
    const softwareVersion = device?.InternetGatewayDevice?.DeviceInfo?.['1']?.SoftwareVersion?._value || '-';
    const rxPower = getParameterWithPaths(device, parameterPaths.rxPower);
    const pppoeIP = getParameterWithPaths(device, parameterPaths.pppoeIP);
    const pppoeUsername = getParameterWithPaths(device, parameterPaths.pppUsername);
    const totalAssociations = getParameterWithPaths(device, parameterPaths.userConnected);
    
    return {
      phone: phone,
      ssid: ssid,
      status: status,
      lastInform: lastInform,
      softwareVersion: softwareVersion,
      rxPower: rxPower,
      pppoeIP: pppoeIP,
      pppoeUsername: pppoeUsername,
      totalAssociations: totalAssociations,
      connectedUsers: connectedUsers,
      billingData: billingData
    };
    
  } catch (error) {
    console.error('Error in getCustomerDeviceData:', error);
    
    // Return data minimal jika terjadi error
    return {
      phone: phone,
      ssid: '-',
      status: 'Error',
      lastInform: '-',
      softwareVersion: '-',
      rxPower: '-',
      pppoeIP: '-',
      pppoeUsername: '-',
      totalAssociations: '0',
      connectedUsers: [],
      billingData: null
    };
  }
}
// Helper: Update SSID (real ke GenieACS) - Legacy
async function updateSSID(phone, newSSID) {
  try {
    // Cari device berdasarkan nomor telepon (tag)
    let device = await findDeviceByTag(phone);
    
    // Jika tidak ditemukan, coba cari berdasarkan PPPoE username dari billing
    if (!device) {
      try {
        const customer = await billingManager.getCustomerByPhone(phone);
        if (customer && customer.pppoe_username) {
          const { findDeviceByPPPoE } = require('../config/genieacs');
          device = await findDeviceByPPPoE(customer.pppoe_username);
        }
      } catch (error) {
        console.error('Error finding device by PPPoE username:', error);
      }
    }
    
    if (!device) return false;
    const deviceId = device._id;
    const encodedDeviceId = encodeURIComponent(deviceId);
    const settings = getSettingsWithCache();
    const genieacsUrl = settings.genieacs_url || 'http://localhost:7557';
    const username = settings.genieacs_username || '';
    const password = settings.genieacs_password || '';
    // Update SSID 2.4GHz
    await axios.post(
      `${genieacsUrl}/devices/${encodedDeviceId}/tasks?connection_request`,
      {
        name: "setParameterValues",
        parameterValues: [
          ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID", newSSID, "xsd:string"]
        ]
      },
      { auth: { username, password } }
    );
    // Update SSID 5GHz (index 5-8, ambil yang berhasil saja)
    const newSSID5G = `${newSSID}-5G`;
    const ssid5gIndexes = [5, 6, 7, 8];
    for (const idx of ssid5gIndexes) {
      try {
        await axios.post(
          `${genieacsUrl}/devices/${encodedDeviceId}/tasks?connection_request`,
          {
            name: "setParameterValues",
            parameterValues: [
              [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${idx}.SSID`, newSSID5G, "xsd:string"]
            ]
          },
          { auth: { username, password } }
        );
        break;
      } catch (e) {}
    }
    // Hanya refresh, tidak perlu reboot
    await axios.post(
      `${genieacsUrl}/devices/${encodedDeviceId}/tasks?connection_request`,
      { name: "refreshObject", objectName: "InternetGatewayDevice.LANDevice.1.WLANConfiguration" },
      { auth: { username, password } }
    );
    return true;
  } catch (e) {
    return false;
  }
}
// Helper: Update SSID Optimized (seperti WhatsApp command) - Fast Response
async function updateSSIDOptimized(phone, newSSID) {
  try {
    console.log(`ðŸ”„ Optimized SSID update for phone: ${phone} to: ${newSSID}`);
    
    // Cari device berdasarkan nomor pelanggan
    let device = await findDeviceByTag(phone);
    if (!device) {
      try {
        const customer = await billingManager.getCustomerByPhone(phone);
        if (customer && customer.pppoe_username) {
          const { findDeviceByPPPoE } = require('../config/genieacs');
          device = await findDeviceByPPPoE(customer.pppoe_username);
        }
      } catch (error) {
        console.error('Error finding device by PPPoE username:', error);
      }
    }
    
    if (!device) {
      return { success: false, message: 'Device tidak ditemukan' };
    }
    
    const deviceId = device._id;
    const encodedDeviceId = encodeURIComponent(deviceId);
    const settings = getSettingsWithCache();
    const genieacsUrl = settings.genieacs_url || 'http://localhost:7557';
    const username = settings.genieacs_username || '';
    const password = settings.genieacs_password || '';
    
    // Buat nama SSID 5G berdasarkan SSID 2.4G (seperti di WhatsApp)
    const newSSID5G = `${newSSID}-5G`;
    
    // Concurrent API calls untuk speed up
    const axiosConfig = {
      auth: { username, password },
      timeout: 10000 // 10 second timeout
    };
    
    // Update SSID 2.4GHz dan 5GHz secara concurrent
    const tasks = [];
    
    // Task 1: Update SSID 2.4GHz
    tasks.push(
      axios.post(
        `${genieacsUrl}/devices/${encodedDeviceId}/tasks`,
        {
          name: "setParameterValues",
          parameterValues: [
            ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID", newSSID, "xsd:string"]
          ]
        },
        axiosConfig
      )
    );
    
    // Task 2: Update SSID 5GHz (coba index 5 dulu, yang paling umum)
    tasks.push(
      axios.post(
        `${genieacsUrl}/devices/${encodedDeviceId}/tasks`,
        {
          name: "setParameterValues",
          parameterValues: [
            ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID", newSSID5G, "xsd:string"]
          ]
        },
        axiosConfig
      ).catch(() => null) // Ignore error jika index 5 tidak ada
    );
    
    // Task 3: Refresh object
    tasks.push(
      axios.post(
        `${genieacsUrl}/devices/${encodedDeviceId}/tasks`,
        {
          name: "refreshObject",
          objectName: "InternetGatewayDevice.LANDevice.1.WLANConfiguration"
        },
        axiosConfig
      ).catch(() => null) // Ignore error jika refresh gagal
    );
    
    // Jalankan semua tasks secara concurrent
    const results = await Promise.allSettled(tasks);
    
    // Check results
    const mainTaskSuccess = results[0].status === 'fulfilled';
    const wifi5GFound = results[1].status === 'fulfilled';
    
    if (mainTaskSuccess) {
      console.log(`âœ… SSID update completed for ${phone}: ${newSSID}`);
      return { success: true, wifi5GFound };
    } else {
      console.error(`âŒ SSID update failed for ${phone}: ${results[0].reason?.message || 'Unknown error'}`);
      return { success: false, message: 'Gagal update SSID' };
    }
    
  } catch (error) {
    console.error('Error in updateSSIDOptimized:', error);
    return { success: false, message: error.message };
  }
}
// Helper: Add admin number and company info to customer data
function addAdminNumber(customerData) {
  const adminNumber = getSetting('admins.0', '+15550192834');
  const companyHeader = getSetting('company_header', 'PulseBill Telecom');
  
  // Convert to display format (remove country code if present)
  const displayNumber = adminNumber.startsWith('62') ? '0' + adminNumber.slice(2) : adminNumber;
  
  if (customerData && typeof customerData === 'object') {
    customerData.adminNumber = displayNumber;
    customerData.adminNumberWA = adminNumber;
    customerData.companyHeader = companyHeader;
  }
  return customerData;
}
// Helper: Update Password (real ke GenieACS) - Legacy
async function updatePassword(phone, newPassword) {
  try {
    if (newPassword.length < 8) return false;
    
    // Cari device berdasarkan nomor telepon (tag)
    let device = await findDeviceByTag(phone);
    
    // Jika tidak ditemukan, coba cari berdasarkan PPPoE username dari billing
    if (!device) {
      try {
        const customer = await billingManager.getCustomerByPhone(phone);
        if (customer && customer.pppoe_username) {
          const { findDeviceByPPPoE } = require('../config/genieacs');
          device = await findDeviceByPPPoE(customer.pppoe_username);
        }
      } catch (error) {
        console.error('Error finding device by PPPoE username:', error);
      }
    }
    
    if (!device) return false;
    const deviceId = device._id;
    const encodedDeviceId = encodeURIComponent(deviceId);
    const settings = getSettingsWithCache();
    const genieacsUrl = settings.genieacs_url || 'http://localhost:7557';
    const username = settings.genieacs_username || '';
    const password = settings.genieacs_password || '';
    const tasksUrl = `${genieacsUrl}/devices/${encodedDeviceId}/tasks`;
    // Update password 2.4GHz
    await axios.post(`${tasksUrl}?connection_request`, {
      name: "setParameterValues",
      parameterValues: [
        ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase", newPassword, "xsd:string"],
        ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase", newPassword, "xsd:string"]
      ]
    }, { auth: { username, password } });
    // Update password 5GHz
    await axios.post(`${tasksUrl}?connection_request`, {
      name: "setParameterValues",
      parameterValues: [
        ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.KeyPassphrase", newPassword, "xsd:string"],
        ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.PreSharedKey.1.KeyPassphrase", newPassword, "xsd:string"]
      ]
    }, { auth: { username, password } });
    // Refresh
    await axios.post(`${tasksUrl}?connection_request`, {
      name: "refreshObject",
      objectName: "InternetGatewayDevice.LANDevice.1.WLANConfiguration"
    }, { auth: { username, password } });
    return true;
  } catch (e) {
    return false;
  }
}
// Helper: Update Password Optimized (seperti WhatsApp command) - Fast Response
async function updatePasswordOptimized(phone, newPassword) {
  try {
    console.log(`ðŸ”„ Optimized password update for phone: ${phone}`);
    
    // Cari device berdasarkan nomor pelanggan
    let device = await findDeviceByTag(phone);
    if (!device) {
      try {
        const customer = await billingManager.getCustomerByPhone(phone);
        if (customer && customer.pppoe_username) {
          const { findDeviceByPPPoE } = require('../config/genieacs');
          device = await findDeviceByPPPoE(customer.pppoe_username);
        }
      } catch (error) {
        console.error('Error finding device by PPPoE username:', error);
      }
    }
    
    if (!device) {
      return { success: false, message: 'Device tidak ditemukan' };
    }
    
    const deviceId = device._id;
    const encodedDeviceId = encodeURIComponent(deviceId);
    const settings = getSettingsWithCache();
    const genieacsUrl = settings.genieacs_url || 'http://localhost:7557';
    const username = settings.genieacs_username || '';
    const password = settings.genieacs_password || '';
    
    // Concurrent API calls untuk speed up
    const axiosConfig = {
      auth: { username, password },
      timeout: 10000 // 10 second timeout
    };
    
    // Update password 2.4GHz dan 5GHz secara concurrent
    const tasks = [];
    
    // Task 1: Update password 2.4GHz
    tasks.push(
      axios.post(
        `${genieacsUrl}/devices/${encodedDeviceId}/tasks`,
        {
          name: "setParameterValues",
          parameterValues: [
            ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase", newPassword, "xsd:string"]
          ]
        },
        axiosConfig
      )
    );
    
    // Task 2: Update password 5GHz (coba index 5 dulu)
    tasks.push(
      axios.post(
        `${genieacsUrl}/devices/${encodedDeviceId}/tasks`,
        {
          name: "setParameterValues",
          parameterValues: [
            ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.KeyPassphrase", newPassword, "xsd:string"]
          ]
        },
        axiosConfig
      ).catch(() => null) // Ignore error jika index 5 tidak ada
    );
    
    // Task 3: Refresh object
    tasks.push(
      axios.post(
        `${genieacsUrl}/devices/${encodedDeviceId}/tasks`,
        {
          name: "refreshObject",
          objectName: "InternetGatewayDevice.LANDevice.1.WLANConfiguration"
        },
        axiosConfig
      ).catch(() => null) // Ignore error jika refresh gagal
    );
    
    // Jalankan semua tasks secara concurrent
    const results = await Promise.allSettled(tasks);
    
    // Check results
    const mainTaskSuccess = results[0].status === 'fulfilled';
    
    if (mainTaskSuccess) {
      console.log(`âœ… Password update completed for ${phone}`);
      return { success: true };
    } else {
      console.error(`âŒ Password update failed for ${phone}: ${results[0].reason?.message || 'Unknown error'}`);
      return { success: false, message: 'Gagal update password' };
    }
    
  } catch (error) {
    console.error('Error in updatePasswordOptimized:', error);
    return { success: false, message: error.message };
  }
}
// GET: Login page (SUDAH DILENGKAPI SATPAM SESI)
router.get('/login', (req, res) => {
  // 1. CEK SESI: Apakah HP pelanggan masih membawa kunci login?
  if (req.session && req.session.phone) {
      // 2. JIKA YA: Langsung tendang ke Dashboard, jangan tampilkan form login!
      return res.redirect('/customer/dashboard');
  }
  // 3. JIKA TIDAK: Baru tampilkan halaman form login seperti biasa
  const settings = getSettingsWithCache();
  res.render('login', { settings, error: null });
});
// GET: Base customer portal - redirect appropriately
router.get('/', (req, res) => {
  const phone = req.session && req.session.phone;
  if (phone) return res.redirect('/customer/dashboard');
  return res.redirect('/customer/login');
});
// POST: Proses login - Triple Validation (User + Pass + Phone) - MODE FLEKSIBEL (08/628 OK)
router.post('/login', async (req, res) => {
  try {
    // 1. Ambil data dari form (DITAMBAHKAN 'remember' UNTUK CEK CHECKBOX)
    let { username, password, phone, remember } = req.body;
    const settings = getSettingsWithCache();
    
    if (!username || !password || !phone) {
      return res.status(400).json({ success: false, message: 'Username, Password, dan No WA wajib diisi!' });
    }
    // --- 2. PENYULAP NO HP (NORMALISASI) ---
    // Buang semua karakter non-angka
    let cleanPhone = phone.replace(/[^0-9]/g, '');
    // Jika diawali 628, ubah jadi 08
    if (cleanPhone.startsWith('628')) {
      cleanPhone = '0' + cleanPhone.substring(2);
    } 
    // Jika diawali 8 saja, tambahkan 0 di depan
    else if (cleanPhone.startsWith('8')) {
      cleanPhone = '0' + cleanPhone;
    }
    // 3. Validasi format setelah dinormalkan
    if (!cleanPhone.match(/^08[0-9]{8,13}$/)) {
      return res.status(400).json({ success: false, message: 'Format Nomor HP tidak dikenal (Gunakan 08 atau 628)' });
    }
    // --- 4. VALIDASI DATABASE (Pencarian Fleksibel) ---
    // Kita cari yang Username & Password cocok, DAN (Phone-nya 08 ATAU 628)
    const [rows] = await dbPool.query(
      "SELECT * FROM customers WHERE username = ? AND password = ? AND (phone = ? OR phone = ?)", 
      [username, password, cleanPhone, phone] 
    );
    if (rows.length === 0) {
      return res.status(401).json({ 
        success: false, 
        message: 'Kombinasi Username, Password, atau No WhatsApp tidak sesuai!' 
      });
    }
    const customer = rows[0];
    // 5. Logika OTP (Jika diaktifkan)
    if (settings.customerPortalOtp === true || String(settings.customerPortalOtp).toLowerCase() === 'true') {
      const otpLength = parseInt(settings.otp_length || '6', 10);
      const min = Math.pow(10, otpLength - 1);
      const max = Math.pow(10, otpLength) - 1;
      const otp = Math.floor(min + Math.random() * (max - min)).toString();
      const expiryMin = parseInt(settings.otp_expiry_minutes || '5', 10);
      
      // Simpan OTP berdasarkan phone resmi dari database (biar konsisten)
      otpStore[customer.phone] = { otp, expires: Date.now() + (isNaN(expiryMin) ? 5 : expiryMin) * 60 * 1000 };
      
      try {
        // JID WA selalu butuh format 62
        const waJid = customer.phone.replace(/^0/, '62') + '@s.whatsapp.net';
        const msg = `?? *KODE OTP PORTAL PELANGGAN*\n\n` +
          `Halo *${customer.name}*,\n` +
          `Kode OTP Anda adalah: *${otp}*\n\n` +
          `?? Kode ini berlaku selama ${(isNaN(expiryMin) ? 5 : expiryMin)} menit\n` +
          `?? Jangan bagikan kode ini kepada siapapun`;
        
        await sendMessage(waJid, msg);
        console.log(`[OTP SENT] User: ${customer.username}, Phone: ${customer.phone}`);
      } catch (error) {
        console.error(`[OTP ERROR]`, error);
      }
      
      return res.json({ success: true, message: 'OTP dikirim', redirect: `/customer/otp?phone=${customer.phone}` });
    } else {
      req.session.phone = customer.phone;
      req.session.customer_username = customer.username;
      req.session.customer_phone = customer.phone;
      req.session.customerId = customer.id;
      req.session.customerName = customer.name;
      // SET DURASI COOKIE BERDASARKAN CHECKBOX "INGAT SAYA" DARI EJS
      if (remember === 'true' || remember === true) {
          const satuTahun = 31536000000;
          req.session.cookie.maxAge = satuTahun;
          req.session.cookie.expires = new Date(Date.now() + satuTahun); 
      } else {
          req.session.cookie.expires = false; // Hilang saat tab ditutup
      }
      // SIMPAN PAKSA KE DATABASE SEBELUM MENGIRIM JAWABAN KE HP
      req.session.save((err) => {
          if (err) {
              console.error('? Gagal menyimpan session ke database:', err);
              return res.status(500).json({ success: false, message: 'Gagal membuat sesi login' });
          }
          
          console.log(`? [LOGIN SUCCESS] User: ${customer.username} | Phone: ${customer.phone} | Remember: ${remember}`);
          return res.json({ success: true, message: 'Login berhasil', redirect: '/customer/dashboard' });
      });
    }
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan sistem' });
  }
});
// GET: Halaman OTP
router.get('/otp', (req, res) => {
  const { phone } = req.query;
  const settings = getSettingsWithCache();
  res.render('otp', { phone, error: null, otp_length: settings.otp_length || 6, settings });
});
// POST: Verifikasi OTP
router.post('/otp', async (req, res) => {
  const { phone, otp } = req.body;
  const data = otpStore[phone];
  const settings = getSettingsWithCache();
  if (!data || data.otp !== otp || Date.now() > data.expires) {
    return res.render('otp', { phone, error: 'OTP salah atau sudah kadaluarsa.', otp_length: settings.otp_length || 6, settings });
  }
  // Sukses login
  delete otpStore[phone];
  req.session = req.session || {};
  req.session.phone = phone;
  
  // Set customer_username untuk konsistensi dengan billing
  try {
    const billingManager = require('../config/billing');
    const customer = await billingManager.getCustomerByPhone(phone);
    if (customer) {
      req.session.customer_username = customer.username;
      req.session.customer_phone = phone;
      console.log(`âœ… [OTP_LOGIN] Set session customer_username: ${customer.username} for phone: ${phone}`);
    } else {
      // Customer belum ada di billing, set temporary username
      req.session.customer_username = `temp_${phone}`;
      req.session.customer_phone = phone;
      console.log(`âš ï¸ [OTP_LOGIN] No billing customer found for phone: ${phone}, set temp username`);
    }
  } catch (error) {
    console.error(`âŒ [OTP_LOGIN] Error getting customer from billing:`, error);
    // Fallback ke temporary username
    req.session.customer_username = `temp_${phone}`;
    req.session.customer_phone = phone;
  }
  
  return res.redirect('/customer/dashboard');
});
// GET: Halaman billing pelanggan
router.get('/billing', async (req, res) => {
  const phone = req.session && req.session.phone;
  if (!phone) return res.redirect('/customer/login');
  const settings = getSettingsWithCache();
  
  try {
    const customer = await billingManager.getCustomerByPhone(phone);
    
    if (!customer) {
      // Pelanggan belum ada di sistem billing, tapi tetap bisa akses halaman billing
      console.log(`âš ï¸ [BILLING_REDIRECT] Customer not found in billing system for phone: ${phone}, but allowing access`);
      
      // Buat session customer_username sementara berdasarkan phone
      req.session.customer_username = `temp_${phone}`;
      req.session.customer_phone = phone; // Backup phone untuk referensi
      
      // Redirect ke billing dashboard yang akan menangani customer tanpa data billing
      return res.redirect('/customer/billing/dashboard');
    }
    
    const invoices = await billingManager.getInvoicesByCustomer(customer.id);
    
    // Set customer_username session for customer billing compatibility
    req.session.customer_username = customer.username;
    req.session.customer_phone = phone; // Backup phone untuk referensi
    console.log(`âœ… [BILLING_REDIRECT] Set session customer_username: ${customer.username} for phone: ${phone}`);
    
    // Redirect to new customer billing dashboard with payment method selection
    res.redirect('/customer/billing/dashboard');
  } catch (error) {
    console.error('Error loading billing page:', error);
    res.render('error', { 
      message: 'Terjadi kesalahan saat memuat data tagihan',
      settings 
    });
  }
});
// POST: Restart device
router.post('/restart-device', async (req, res) => {
  // Prioritas: customer_username dari billing, fallback ke phone
  const customerUsername = req.session && req.session.customer_username;
  const phone = req.session && req.session.phone;
  
  if (!customerUsername && !phone) {
    return res.status(401).json({ success: false, message: 'Session tidak valid' });
  }
  
  try {
    console.log(`ðŸ”„ Restart device request from customer: ${customerUsername || phone}`);
    console.log(`ðŸ”„ Session data - customer_username: ${customerUsername}, phone: ${phone}`);
    
    // Ambil data customer dari billing
    let customer = null;
    if (phone) {
      try {
        const billingManager = require('../config/billing');
        customer = await billingManager.getCustomerByPhone(phone);
        console.log(`ðŸ“‹ [RESTART] Customer from billing:`, customer ? {
          id: customer.id, 
          username: customer.username, 
          pppoe_username: customer.pppoe_username,
          phone: customer.phone
        } : 'Not found');
      } catch (error) {
        console.error(`âŒ [RESTART] Error getting customer from billing:`, error);
      }
    }
    
    let device = null;
    
    // Prioritas 1: Cari berdasarkan PPPoE Username dari billing
    if (customer && customer.pppoe_username) {
      console.log(`ðŸ” [RESTART] Searching by PPPoE username: ${customer.pppoe_username}`);
      try {
        device = await findDeviceByPPPoE(customer.pppoe_username);
        if (device) {
          console.log(`âœ… [RESTART] Device found by PPPoE username: ${customer.pppoe_username}`);
        }
      } catch (error) {
        console.error(`âŒ [RESTART] Error finding device by PPPoE:`, error);
      }
    }
    
    // Prioritas 2: Fallback ke pencarian berdasarkan tag (berbagai format)
    if (!device) {
      const searchVariants = [];
      
      if (customer) {
        // Gunakan data customer dari billing
        searchVariants.push(
          customer.username,           // Username billing
          customer.phone,             // Phone dari billing 
          customer.pppoe_username     // PPPoE username
        );
        
        // Extract nomor dari customer username jika format cust_xxxx_xxxxxx
        if (customer.username && customer.username.startsWith('cust_')) {
          const extracted = customer.username.replace(/^cust_/, '').replace(/_/g, '');
          searchVariants.push(extracted);
          searchVariants.push('0' + extracted);
        }
      }
      
      // Selalu coba dengan phone variants, bahkan tanpa billing data
      if (phone) {
        searchVariants.push(
          phone,                          // Format asli (081234567890)
          phone.replace(/^0/, '62'),     // 6281234567890  
          phone.replace(/^0/, '+62'),    // +6281234567890
          phone.replace(/^0/, ''),       // 87828060111
          phone.substring(1)             // 87828060111
        );
      }
      
      // Jika tidak ada billing data, coba dengan customerUsername dari session
      if (!customer && customerUsername) {
        console.log(`ðŸ“± [RESTART] No billing data, trying session customerUsername: ${customerUsername}`);
        searchVariants.push(customerUsername);
        
        // Extract dari customer username jika format cust_xxxx_xxxxxx
        if (customerUsername.startsWith('cust_')) {
          const extracted = customerUsername.replace(/^cust_/, '').replace(/_/g, '');
          searchVariants.push(extracted);
          searchVariants.push('0' + extracted);
        }
      }
      
      // Remove duplicates dan filter empty values
      const uniqueVariants = [...new Set(searchVariants.filter(v => v && v.trim()))];
      console.log(`ðŸ“± [RESTART] Searching device by tag with variants:`, uniqueVariants);
      
      // Cari device berdasarkan tag variants
      for (const variant of uniqueVariants) {
        console.log(`ðŸ” [RESTART] Trying tag variant: ${variant}`);
        device = await findDeviceByTag(variant);
        if (device) {
          console.log(`âœ… [RESTART] Device found by tag variant: ${variant}`);
          break;
        }
      }
    }
    
    if (!device) {
      console.log(`âŒ Device not found for customer: ${customerUsername || phone}`);
      console.log(`âŒ Customer data:`, customer ? {
        username: customer.username,
        pppoe_username: customer.pppoe_username,
        phone: customer.phone
      } : 'No billing data');
      return res.status(404).json({ 
        success: false, 
        message: `Perangkat tidak ditemukan untuk customer: ${customerUsername || phone}` 
      });
    }
    
    console.log(`âœ… Device found: ${device._id}`);
    
    // Cek status device
    const lastInform = device._lastInform ? new Date(device._lastInform) : null;
    const minutesAgo = lastInform ? Math.floor((Date.now() - lastInform.getTime()) / (1000 * 60)) : 999;
    
    if (minutesAgo > 5) {
      console.log(`âš ï¸ Device is offline. Last inform: ${lastInform ? lastInform.toLocaleString() : 'Never'}`);
      console.log(`â° Time since last inform: ${minutesAgo} minutes`);
      return res.status(400).json({ 
        success: false, 
        message: 'Perangkat offline. Restart hanya tersedia untuk perangkat yang online.' 
      });
    }
    
    console.log(`âœ… Device is online. Last inform: ${lastInform.toLocaleString()}`);
    
    // Ambil konfigurasi GenieACS
    const settings = getSettingsWithCache();
    const genieacsUrl = settings.genieacs_url || 'http://localhost:7557';
    const username = settings.genieacs_username || 'admin';
    const password = settings.genieacs_password || 'admin';
    
    console.log(`ðŸ”— GenieACS URL: ${genieacsUrl}`);
    
    // Encode device ID
    const deviceId = device._id;
    let encodedDeviceId = deviceId;
    
    try {
      // Coba encode device ID
      encodedDeviceId = encodeURIComponent(deviceId);
      console.log(`ðŸ”§ Using encoded device ID: ${encodedDeviceId}`);
    } catch (error) {
      console.log(`ðŸ”§ Using original device ID: ${deviceId}`);
    }
    
    // Kirim task restart ke GenieACS
    try {
      console.log(`ðŸ“¤ Sending restart task to GenieACS for device: ${deviceId}`);
      
      const response = await axios.post(`${genieacsUrl}/devices/${encodedDeviceId}/tasks`, {
        name: "reboot"
      }, {
        auth: { username, password },
        timeout: 10000
      });
      
      console.log(`âœ… GenieACS response:`, response.data);
      console.log(`ðŸ”„ Restart command sent successfully. Device will be offline during restart process.`);
      
      // Kirim notifikasi WhatsApp ke pelanggan
      try {
        const waJid = phone.replace(/^0/, '62') + '@s.whatsapp.net';
        const msg = `ðŸ”„ *RESTART PERANGKAT*\n\nPerintah restart telah dikirim ke perangkat Anda.\n\nâ° Perangkat akan restart dalam beberapa detik dan koneksi internet akan terputus sementara (1-2 menit).\n\nðŸ“± Silakan tunggu hingga perangkat selesai restart.`;
        await sendMessage(waJid, msg);
        console.log(`âœ… WhatsApp notification sent to ${phone}`);
      } catch (e) {
        console.error('âŒ Gagal mengirim notifikasi restart:', e);
      }
      
      res.json({ 
        success: true, 
        message: 'Perintah restart berhasil dikirim. Perangkat akan restart dalam beberapa detik.' 
      });
      
    } catch (taskError) {
      console.error(`âŒ Error sending restart task:`, taskError.response?.data || taskError.message);
      
      // Fallback: coba dengan device ID asli
      try {
        console.log(`ðŸ”„ Trying with original device ID: ${deviceId}`);
        const response = await axios.post(`${genieacsUrl}/devices/${deviceId}/tasks`, {
          name: "reboot"
        }, {
          auth: { username, password },
          timeout: 10000
        });
        
        console.log(`âœ… Fallback restart successful`);
        res.json({ 
          success: true, 
          message: 'Perintah restart berhasil dikirim. Perangkat akan restart dalam beberapa detik.' 
        });
        
      } catch (fallbackError) {
        console.error(`âŒ Fallback restart failed:`, fallbackError.response?.data || fallbackError.message);
        res.status(500).json({ 
          success: false, 
          message: 'Gagal mengirim perintah restart. Silakan coba lagi atau hubungi admin.' 
        });
      }
    }
    
  } catch (error) {
    console.error('âŒ Error restart device:', error.message);
    console.error('âŒ Error details:', error.response?.data || error);
    res.status(500).json({ 
      success: false, 
      message: 'Terjadi kesalahan saat restart perangkat. Silakan coba lagi.' 
    });
  }
});
// GET: Dashboard pelanggan
router.get('/dashboard', async (req, res) => {
  const phone = req.session && req.session.phone;
  if (!phone) return res.redirect('/customer/login');
  const settings = getSettingsWithCache();
  
  try {
    const data = await getCustomerDeviceData(phone);
    
    // Pastikan data tidak null
    if (!data) {
      console.log(`âŒ No data returned for phone: ${phone}`);
      return res.render('dashboard', { 
        customer: { phone, ssid: '-', status: 'Tidak ditemukan', lastInform: '-' }, 
        connectedUsers: [], 
        notif: 'Data perangkat tidak ditemukan.',
        settings,
        billingData: null
      });
    }
    
    const customerWithAdmin = addAdminNumber(data);
    res.render('dashboard', { 
      customer: customerWithAdmin, 
      connectedUsers: data.connectedUsers || [],
      settings,
      billingData: data.billingData || null,
      notif: null
    });
  } catch (error) {
    console.error('Error loading dashboard:', error);
    // Fallback jika ada error, tetap tampilkan data minimal
    const fallbackCustomer = addAdminNumber({ 
      phone, 
      ssid: '-', 
      status: 'Error', 
      lastInform: '-',
      softwareVersion: '-',
      rxPower: '-',
      pppoeIP: '-',
      pppoeUsername: '-',
      totalAssociations: '0'
    });
    res.render('dashboard', { 
      customer: fallbackCustomer, 
      connectedUsers: [], 
      notif: 'Terjadi kesalahan saat memuat data.',
      settings,
      billingData: null
    });
  }
});
// POST: Ganti SSID (Legacy - redirect to homepage with notification)
router.post('/change-ssid', async (req, res) => {
  const phone = req.session && req.session.phone;
  if (!phone) return res.redirect('/customer/login');
  const { ssid } = req.body;
  const ok = await updateSSIDOptimized(phone, ssid);
  if (ok) {
    // Kirim notifikasi WhatsApp ke pelanggan
    const waJid = phone.replace(/^0/, '62') + '@s.whatsapp.net';
    const msg = `âœ… *PERUBAHAN NAMA WIFI*\n\nNama WiFi Anda telah diubah menjadi:\nâ€¢ WiFi 2.4GHz: ${ssid}\nâ€¢ WiFi 5GHz: ${ssid}-5G\n\nSilakan hubungkan ulang perangkat Anda ke WiFi baru.`;
    try { await sendMessage(waJid, msg); } catch (e) {}
  }
  const data = await getCustomerDeviceData(phone);
  const customerWithAdmin = addAdminNumber(data || { phone, ssid: '-', status: '-', lastChange: '-' });
  res.render('dashboard', { 
    customer: customerWithAdmin, 
    connectedUsers: data ? data.connectedUsers : [], 
    notif: ok ? 'Nama WiFi (SSID) berhasil diubah.' : 'Gagal mengubah SSID.',
    settings: getSettingsWithCache()
  });
});
// API: Ganti SSID (Ajax endpoint - optimized like WhatsApp)
router.post('/api/change-ssid', async (req, res) => {
  const phone = req.session && req.session.phone;
  if (!phone) return res.status(401).json({ success: false, message: 'Session tidak valid' });
  
  const { ssid } = req.body;
  
  if (!ssid || ssid.length < 3 || ssid.length > 32) {
    return res.status(400).json({ success: false, message: 'SSID harus berisi 3-32 karakter!' });
  }
  
  try {
    // Kirim response cepat ke frontend
    res.json({ 
      success: true, 
      message: 'SSID sedang diproses...',
      newSSID: ssid,
      processing: true
    });
    
    // Proses update di background (non-blocking)
    updateSSIDOptimized(phone, ssid).then(result => {
      if (result.success) {
        // Kirim notifikasi WhatsApp ke pelanggan (non-blocking)
        const waJid = phone.replace(/^0/, '62') + '@s.whatsapp.net';
        const msg = `âœ… *PERUBAHAN NAMA WIFI*\n\nNama WiFi Anda telah diubah menjadi:\nâ€¢ WiFi 2.4GHz: ${ssid}\nâ€¢ WiFi 5GHz: ${ssid}-5G\n\nSilakan hubungkan ulang perangkat Anda ke WiFi baru.`;
        sendMessage(waJid, msg).catch(e => {
          console.error('Error sending WhatsApp notification:', e);
        });
        
        console.log(`âœ… SSID update completed for ${phone}: ${ssid}`);
      } else {
        console.error(`âŒ SSID update failed for ${phone}: ${result.message}`);
      }
    }).catch(error => {
      console.error('Error in background SSID update:', error);
    });
    
  } catch (error) {
    console.error('Error in change SSID API:', error);
    res.status(500).json({ success: false, message: 'Terjadi kesalahan server' });
  }
});
// POST: Ganti Password (Legacy - untuk backward compatibility)
router.post('/change-password', async (req, res) => {
  const phone = req.session && req.session.phone;
  if (!phone) return res.redirect('/customer/login');
  const { password } = req.body;
  const ok = await updatePassword(phone, password);
  if (ok) {
    // Kirim notifikasi WhatsApp ke pelanggan
    const waJid = phone.replace(/^0/, '62') + '@s.whatsapp.net';
    const msg = `âœ… *PERUBAHAN PASSWORD WIFI*\n\nPassword WiFi Anda telah diubah menjadi:\nâ€¢ Password Baru: ${password}\n\nSilakan hubungkan ulang perangkat Anda dengan password baru.`;
    try { await sendMessage(waJid, msg); } catch (e) {}
  }
  const data = await getCustomerDeviceData(phone);
  const customerWithAdmin = addAdminNumber(data || { phone, ssid: '-', status: '-', lastChange: '-' });
  res.render('dashboard', { 
    customer: customerWithAdmin, 
    connectedUsers: data ? data.connectedUsers : [], 
    notif: ok ? 'Password WiFi berhasil diubah.' : 'Gagal mengubah password.',
    settings: getSettingsWithCache()
  });
});
// API: Ganti Password (Ajax endpoint - optimized like WhatsApp)
router.post('/api/change-password', async (req, res) => {
  const phone = req.session && req.session.phone;
  if (!phone) return res.status(401).json({ success: false, message: 'Session tidak valid' });
  
  const { password } = req.body;
  
  if (!password || password.length < 8 || password.length > 63) {
    return res.status(400).json({ success: false, message: 'Password harus berisi 8-63 karakter!' });
  }
  
  try {
    // Kirim response cepat ke frontend
    res.json({ 
      success: true, 
      message: 'Password sedang diproses...',
      processing: true
    });
    
    // Proses update di background (non-blocking)
    updatePasswordOptimized(phone, password).then(result => {
      if (result.success) {
        // Kirim notifikasi WhatsApp ke pelanggan (non-blocking)
        const waJid = phone.replace(/^0/, '62') + '@s.whatsapp.net';
        const msg = `âœ… *PERUBAHAN PASSWORD WIFI*\n\nPassword WiFi Anda telah diubah menjadi:\nâ€¢ Password Baru: ${password}\n\nSilakan hubungkan ulang perangkat Anda dengan password baru.`;
        sendMessage(waJid, msg).catch(e => {
          console.error('Error sending WhatsApp notification:', e);
        });
        
        console.log(`âœ… Password update completed for ${phone}`);
      } else {
        console.error(`âŒ Password update failed for ${phone}: ${result.message}`);
      }
    }).catch(error => {
      console.error('Error in background password update:', error);
    });
    
  } catch (error) {
    console.error('Error in change password API:', error);
    res.status(500).json({ success: false, message: 'Terjadi kesalahan server' });
  }
});
// POST: Logout pelanggan
// Logout route - support both GET and POST methods
router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/customer/login');
  });
});
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/customer/login');
  });
});
// Import dan gunakan route laporan gangguan
const troubleReportRouter = require('./troubleReport');
router.use('/trouble', troubleReportRouter);
module.exports = router; 
