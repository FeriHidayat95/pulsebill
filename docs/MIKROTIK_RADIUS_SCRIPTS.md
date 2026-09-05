# Script Konfigurasi Mikrotik untuk RADIUS Server

## 🎯 Script Siap Pakai - Tinggal Copy Paste!

### **📋 Persiapan:**
1. Login ke Mikrotik via Winbox/SSH/Telnet
2. Ganti `IP_GEMBOK_BILL_SERVER` dengan IP server GEMBOK-Bill Anda
3. Copy paste script sesuai kebutuhan

---

## 🔧 **Script 1: Konfigurasi Dasar RADIUS**

### **Basic RADIUS Setup (Recommended)**
```bash
# Hapus konfigurasi RADIUS lama (jika ada)
/radius remove [find]

# Tambah RADIUS server untuk Authentication dan Accounting
/radius add address=192.168.1.100 secret=testing123 service=ppp timeout=3s src-address=192.168.1.1
/radius add address=192.168.1.100 secret=testing123 service=ppp timeout=3s src-address=192.168.1.1

# Set PPPoE server menggunakan RADIUS
/interface pppoe-server server set default-profile=default use-radius=yes

# Buat PPP Profile untuk RADIUS
/ppp profile add name="radius-profile" use-radius=yes local-address=192.168.100.1 remote-address=192.168.100.2-192.168.100.254

# Set profile RADIUS sebagai default
/interface pppoe-server server set default-profile=radius-profile

# Enable RADIUS accounting
/ppp aaa set use-radius=yes accounting=yes interim-update=5m
```

---

## 🚀 **Script 2: Konfigurasi Lengkap dengan Hotspot**

### **RADIUS untuk PPPoE + Hotspot**
```bash
# === RADIUS CONFIGURATION ===
/radius remove [find]

# RADIUS untuk PPP (PPPoE)
/radius add address=192.168.1.100 secret=testing123 service=ppp timeout=3s src-address=192.168.1.1
/radius add address=192.168.1.100 secret=testing123 service=ppp timeout=3s src-address=192.168.1.1

# RADIUS untuk Hotspot
/radius add address=192.168.1.100 secret=testing123 service=hotspot timeout=3s src-address=192.168.1.1
/radius add address=192.168.1.100 secret=testing123 service=hotspot timeout=3s src-address=192.168.1.1

# === PPPoE CONFIGURATION ===
# Buat PPP Profile RADIUS
/ppp profile add name="radius-pppoe" use-radius=yes local-address=192.168.100.1 remote-address=192.168.100.2-192.168.100.254 dns-server=8.8.8.8,8.8.4.4

# Set PPPoE server
/interface pppoe-server server set default-profile=radius-pppoe use-radius=yes

# Enable PPP AAA
/ppp aaa set use-radius=yes accounting=yes interim-update=5m

# === HOTSPOT CONFIGURATION ===
# Buat Hotspot Profile RADIUS
/ip hotspot profile add name="radius-hotspot" use-radius=yes dns-name=hotspot.local

# Set Hotspot server menggunakan RADIUS
/ip hotspot set [find] profile=radius-hotspot

# Enable Hotspot AAA
/ip hotspot aaa set use-radius=yes accounting=yes interim-update=5m
```

---

## ⚡ **Script 3: Quick Setup (Minimal)**

### **Setup Cepat - Hanya PPPoE**
```bash
# Quick RADIUS setup untuk PPPoE
/radius add address=192.168.1.100 secret=testing123 service=ppp
/interface pppoe-server server set use-radius=yes
/ppp aaa set use-radius=yes accounting=yes
```

---

## 🔧 **Script 4: Advanced Configuration**

### **Konfigurasi Advanced dengan Bandwidth Control**
```bash
# === ADVANCED RADIUS SETUP ===
/radius remove [find]

# Primary RADIUS server
/radius add address=192.168.1.100 secret=testing123 service=ppp,hotspot timeout=3s src-address=192.168.1.1

# Backup RADIUS server (optional - jika ada server backup)
# /radius add address=192.168.1.101 secret=testing123 service=ppp,hotspot timeout=3s src-address=192.168.1.1

# === PPP PROFILES ===
# Profile untuk customer biasa
/ppp profile add name="radius-customer" use-radius=yes local-address=192.168.100.1 remote-address=192.168.100.2-192.168.100.100 dns-server=8.8.8.8,1.1.1.1 rate-limit=10M/10M

# Profile untuk customer premium
/ppp profile add name="radius-premium" use-radius=yes local-address=192.168.101.1 remote-address=192.168.101.2-192.168.101.100 dns-server=8.8.8.8,1.1.1.1 rate-limit=50M/50M

# === PPPoE SERVER ===
/interface pppoe-server server set default-profile=radius-customer use-radius=yes

# === AAA SETTINGS ===
/ppp aaa set use-radius=yes accounting=yes interim-update=5m

# === FIREWALL RULES (Optional - untuk keamanan) ===
# Allow RADIUS traffic
/ip firewall filter add chain=input protocol=udp dst-port=1812,1813 src-address=192.168.1.100 action=accept comment="Allow RADIUS"

# === LOGGING (Optional - untuk monitoring) ===
/system logging add topics=radius action=memory
```

---

## 🛠️ **Script 5: Troubleshooting & Testing**

### **Script untuk Test dan Debug**
```bash
# === TEST RADIUS CONNECTION ===
# Test koneksi ke RADIUS server
/radius incoming monitor duration=10

# Lihat status RADIUS
/radius print detail

# === MONITORING COMMANDS ===
# Monitor PPPoE sessions
/interface pppoe-server monitor [find name="pppoe-out1"]

# Lihat active PPP connections
/ppp active print detail

# Monitor RADIUS accounting
/radius incoming print

# Lihat log RADIUS
/log print where topics~"radius"

# === RESET COMMANDS (jika ada masalah) ===
# Reset semua PPP sessions
/ppp active remove [find]

# Restart PPPoE server
/interface pppoe-server server disable [find]
/interface pppoe-server server enable [find]
```

---

## 📝 **Script 6: Backup & Restore**

### **Backup Konfigurasi RADIUS**
```bash
# Export konfigurasi RADIUS
/radius export file=radius-backup

# Export PPP profiles
/ppp profile export file=ppp-profiles-backup

# Export AAA settings
/ppp aaa export file=aaa-backup

# Buat backup lengkap
/export file=mikrotik-full-backup
```

---

## 🎯 **Template Customization**

### **Sebelum menggunakan, ganti variabel berikut:**

| **Variabel** | **Contoh** | **Deskripsi** |
|--------------|------------|---------------|
| `192.168.1.100` | IP Server GEMBOK-Bill | IP server tempat RADIUS berjalan |
| `192.168.1.1` | IP Mikrotik | IP interface Mikrotik yang connect ke server |
| `testing123` | Secret RADIUS | Password rahasia untuk komunikasi |
| `192.168.100.1` | Gateway PPPoE | IP local untuk PPPoE pool |
| `192.168.100.2-192.168.100.254` | Pool PPPoE | Range IP untuk client PPPoE |

### **Contoh Customization:**
```bash
# SEBELUM (template)
/radius add address=192.168.1.100 secret=testing123 service=ppp

# SESUDAH (disesuaikan dengan setup Anda)
/radius add address=10.0.0.50 secret=mySecretKey123 service=ppp
```

---

## 🚨 **Troubleshooting Commands**

### **Jika ada masalah, gunakan command ini:**

```bash
# 1. Cek koneksi ke RADIUS server
/radius incoming print

# 2. Test authentication manual
/radius incoming monitor duration=30

# 3. Lihat log error
/log print where topics~"radius" and message~"error"

# 4. Reset RADIUS configuration
/radius remove [find]
# Lalu jalankan script setup lagi

# 5. Restart PPP service
/ppp active remove [find]
/interface pppoe-server server set use-radius=no
/interface pppoe-server server set use-radius=yes

# 6. Cek status PPPoE server
/interface pppoe-server server print detail

# 7. Monitor real-time connections
/interface pppoe-server monitor [find name="pppoe-out1"]
```

---

## 🎉 **Verification Commands**

### **Pastikan konfigurasi berhasil:**

```bash
# 1. Cek RADIUS servers terdaftar
/radius print

# 2. Cek PPP profiles menggunakan RADIUS
/ppp profile print detail where use-radius=yes

# 3. Cek AAA settings
/ppp aaa print

# 4. Test user login
# (User coba login PPPoE dengan username/password dari billing)

# 5. Monitor active sessions
/ppp active print

# 6. Lihat RADIUS accounting data
/radius incoming print detail
```

---

## 📞 **Support Information**

**Default RADIUS Settings untuk GEMBOK-Bill:**
- **Authentication Port**: `1812`
- **Accounting Port**: `1813`  
- **Default Secret**: `testing123`
- **Service**: `ppp` untuk PPPoE, `hotspot` untuk Hotspot
- **Timeout**: `3s`

**NAS Client yang perlu ditambah di GEMBOK-Bill:**
- **IP**: IP Mikrotik Anda
- **Secret**: Same as configured in Mikrotik
- **Name**: Identificator (contoh: "Main Router")

---

**🎯 Pilih script yang sesuai dengan kebutuhan Anda dan copy-paste ke terminal Mikrotik!** 

**✅ Urutan yang disarankan:**
1. Gunakan **Script 1** (Basic) untuk testing
2. Jika berhasil, upgrade ke **Script 2** (Lengkap) 
3. Gunakan **Script 5** untuk troubleshooting jika ada masalah
