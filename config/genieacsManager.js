// config/genieacsManager.js
const axios = require('axios');
const { getDevices } = require('./genieacs');
const { getSetting } = require('./settingsManager');
const billingManager = require('./billing');
class GenieacsManager {
    // 1. Helper Path
    parameterPaths = {
        pppUsername: [
            // Virtual Parameters (Bawaan)
            'VirtualParameters.pppoeUsername',
            'VirtualParameters.pppUsername',
            
            // --- Jalur TR-098 (ZTE, Huawei Lama) ---
            'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username',
            'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.Username',
            
            // --- SOLDER BARU: Jalur TR-181 (G665 XPON, G667, V-SOL, Nokia) ---
            'Device.PPP.Interface.1.Username',
            'Device.PPP.Interface.2.Username',
            'Device.PPP.Interface.3.Username',
            'Device.PPP.Interface.4.Username'
        ],
        rxPower: [
            // Virtual Parameters (Bawaan)
            'VirtualParameters.RXPower',
            'VirtualParameters.redaman',
            
            // --- Jalur TR-098 (ZTE, Huawei Lama) ---
            'InternetGatewayDevice.WANDevice.1.WANPONInterfaceConfig.RXPower',
            
            // --- SOLDER BARU: Jalur TR-181 (G665 XPON, dll) ---
            'Device.Optical.Interface.1.OpticalSignalLevel'
        ]
    };
    // 2. Helper Pembaca Data (ANTI [object Object])
    getParameterWithPaths(device, paths) {
        for (const path of paths) {
            const parts = path.split('.');
            let current = device;
            // Alur Kerja: Menelusuri rantai objek (misal: VirtualParameters.RXPower)
            for (const part of parts) {
                if (current && typeof current === 'object' && part in current) {
                    current = current[part];
                } else {
                    current = undefined;
                    break;
                }
            }
            if (current !== undefined && current !== null) {
                // VERIFIKASI: Jika data berupa objek GenieACS, ambil properti _value
                if (typeof current === 'object' && current._value !== undefined) {
                    const val = current._value;
                    if (val !== undefined && val !== null && val !== '') return String(val);
                }
                
                // VERIFIKASI: Jika data sudah berupa teks/angka biasa, langsung ambil
                if (typeof current !== 'object') {
                    return String(current);
                }
            }
        }
        return '-'; // Kembali ke strip jika benar-benar tidak ditemukan
    }
    async getDeviceList() {
        const devicesRaw = await getDevices();
        // SOLDER: Panggil data pelanggan dari MariaDB
        const customers = await billingManager.getAllCustomers(); 
        const now = Date.now();
        const devices = devicesRaw.map(device => {
            const pppoeUser = this.getParameterWithPaths(device, this.parameterPaths.pppUsername);
            // SOLDER: Cari jodoh di MariaDB (Anti-Case Sensitive)
            const pelanggan = customers.find(c => {
                const dbUser = String(c.pppoe_username || '').toLowerCase();
                const acsUser = String(pppoeUser || '').toLowerCase();
                return dbUser === acsUser && acsUser !== '-' && acsUser !== '';
            });
            // Ambil Tag Asli ACS
            let acsTag = (Array.isArray(device.Tags) && device.Tags.length > 0) ? device.Tags.join(', ')
                       : (typeof device.Tags === 'string' && device.Tags) ? device.Tags
                       : (Array.isArray(device._tags) && device._tags.length > 0) ? device._tags.join(', ')
                       : (typeof device._tags === 'string' && device._tags) ? device._tags : '-';
            // SOLDER: Jika Tag ACS kosong, paksa isi pakai No. HP dari MariaDB
            const finalTag = (acsTag === '-' && pelanggan) ? (pelanggan.phone || '-') : acsTag;
            // --- SOLDER BARU: Jurus Sapu Bersih User Konek ---
            let rawUserKonek = this.getParameterWithPaths(device, [
                'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.TotalAssociations',
                'InternetGatewayDevice.LANDevice.1.Hosts.HostNumberOfEntries',
                'Device.WiFi.AccessPoint.1.AssociatedDeviceNumberOfEntries',
                'Device.Hosts.HostNumberOfEntries'
            ]);
            
            // Jika hasil dari ACS adalah strip '-', kosong, atau undefined, PAKSA jadi '0'
            if (rawUserKonek === '-' || !rawUserKonek) {
                rawUserKonek = '0';
            }
            return {
                id: device._id || '-',
                serialNumber: device.DeviceID?.SerialNumber || device._id || '-',
                model: device.DeviceID?.ProductClass || device.InternetGatewayDevice?.DeviceInfo?.ModelName?._value || '-',
                lastInform: device._lastInform ? new Date(device._lastInform).toLocaleString('id-ID') : '-',
                pppoeUsername: pppoeUser,
                ssid: device.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration?.['1']?.SSID?._value || device.VirtualParameters?.SSID || '-',
                password: device.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration?.['1']?.KeyPassphrase?._value || '-',
                
                // Gunakan variabel yang sudah di-filter Anti-Strip di atas
                userKonek: rawUserKonek, 
                
                rxPower: this.getParameterWithPaths(device, this.parameterPaths.rxPower),
                tag: finalTag // Data MariaDB resmi numpang di sini agar dibaca EJS
            };
        });
        const genieacsTotal = devicesRaw.length;
        const genieacsOnline = devicesRaw.filter(dev => dev._lastInform && (now - new Date(dev._lastInform).getTime()) < 3600 * 1000).length;
        
        return {
            devices,
            genieacsTotal,
            genieacsOnline,
            genieacsOffline: genieacsTotal - genieacsOnline
        };
    }
    getAxiosConfig() {
        return {
            url: getSetting('genieacs_url', 'http://localhost:7557'),
            auth: {
                username: getSetting('genieacs_username', 'admin'),
                password: getSetting('genieacs_password', 'password')
            }
        };
    }
    // Synchronize subscriber account state
    async updateSSIDOptimized(deviceId, newSSID) {
        try {
            const config = this.getAxiosConfig();
            const encodedId = encodeURIComponent(deviceId);
            const axiosOpts = { auth: config.auth, timeout: 10000 };
            const tasks = [
                axios.post(`${config.url}/devices/${encodedId}/tasks`, {
                    name: "setParameterValues",
                    parameterValues: [["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID", newSSID, "xsd:string"]]
                }, axiosOpts),
                axios.post(`${config.url}/devices/${encodedId}/tasks`, {
                    name: "setParameterValues",
                    parameterValues: [["InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID", `${newSSID}-5G`, "xsd:string"]]
                }, axiosOpts).catch(() => null),
                axios.post(`${config.url}/devices/${encodedId}/tasks`, {
                    name: "refreshObject", objectName: "InternetGatewayDevice.LANDevice.1.WLANConfiguration"
                }, axiosOpts).catch(() => null)
            ];
            const results = await Promise.allSettled(tasks);
            if (results[0].status === 'fulfilled') return { success: true };
            throw new Error(results[0].reason?.message || 'Gagal eksekusi task GenieACS');
        } catch (e) {
            console.error('SSID Update Error:', e.message);
            return { success: false, message: e.message };
        }
    }
    // Synchronize subscriber account state
    async updatePasswordOptimized(deviceId, newPassword) {
        try {
            const config = this.getAxiosConfig();
            const encodedId = encodeURIComponent(deviceId);
            const axiosOpts = { auth: config.auth, timeout: 10000 };
            const tasks = [
                axios.post(`${config.url}/devices/${encodedId}/tasks`, {
                    name: "setParameterValues",
                    parameterValues: [["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase", newPassword, "xsd:string"]]
                }, axiosOpts),
                axios.post(`${config.url}/devices/${encodedId}/tasks`, {
                    name: "setParameterValues",
                    parameterValues: [["InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.KeyPassphrase", newPassword, "xsd:string"]]
                }, axiosOpts).catch(() => null),
                axios.post(`${config.url}/devices/${encodedId}/tasks`, {
                    name: "refreshObject", objectName: "InternetGatewayDevice.LANDevice.1.WLANConfiguration"
                }, axiosOpts).catch(() => null)
            ];
            const results = await Promise.allSettled(tasks);
            if (results[0].status === 'fulfilled') return { success: true };
            throw new Error(results[0].reason?.message || 'Gagal eksekusi task GenieACS');
        } catch (e) {
            return { success: false, message: e.message };
        }
    }
    async updateTag(deviceId, newTag) {
        try {
            const config = this.getAxiosConfig();
            const encodedId = encodeURIComponent(deviceId);
            // Solder: Langsung ganti seluruh array tag dengan tag yang baru. 
            // Cukup 1x request ke server .18, lebih cepat dan hardware tidak capek.
            await axios.put(`${config.url}/devices/${encodedId}`, 
                { _tags: [newTag] }, 
                { auth: config.auth }
            );
            
            return { success: true };
        } catch (e) {
            console.error(`Gagal update tag untuk ${deviceId}:`, e.message);
            return { success: false, message: 'Gagal update ke ACS: ' + e.message };
        }
    }
    async restartDevice(deviceId) {
        const config = this.getAxiosConfig();
        await axios.post(`${config.url}/devices/${encodeURIComponent(deviceId)}/tasks?connection_request`, 
            { name: 'reboot' }, 
            { auth: config.auth, headers: { 'Content-Type': 'application/json' } }
        );
        return { success: true };
    }
}
module.exports = new GenieacsManager();
