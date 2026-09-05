# Hotspot + RADIUS Setup Guide

## 🎯 **Overview**
Setup Hotspot Mikrotik dengan autentikasi RADIUS server GEMBOK-Bill untuk mendapatkan **login page otomatis** dengan **autentikasi terpusat**.

## 🚀 **Keuntungan Hotspot + RADIUS**

### ✅ **Yang Didapat:**
- **Login page otomatis** dari Mikrotik
- **Interface web** yang sudah jadi
- **Styling** bisa dikustomisasi
- **RADIUS** handle autentikasi
- **Database GEMBOK-Bill** untuk user management
- **Accounting** dan monitoring lengkap

### ❌ **Yang TIDAK Perlu:**
- Buat login page sendiri
- Handle session management
- Setup web server
- Konfigurasi interface manual

## 🔧 **Setup Mikrotik**

### **1. Generate Script**
1. Buka **RADIUS Server Management**
2. Klik **"Generate Script"**
3. Pilih **"Hotspot + RADIUS"**
4. Isi konfigurasi:
   - **IP Server**: IP GEMBOK-Bill
   - **IP Mikrotik**: IP interface Mikrotik
   - **RADIUS Secret**: Password rahasia
5. Klik **"Hotspot + RADIUS"**
6. Copy script yang dihasilkan

### **2. Eksekusi di Mikrotik**
```bash
# Paste script ke terminal Mikrotik
# Tekan Enter untuk eksekusi
```

### **3. Konfigurasi Interface**
**PENTING:** Ganti `ether1` dengan interface yang benar:
```bash
# Cek interface yang tersedia
/interface print

# Update hotspot interface jika perlu
/ip hotspot set [find] interface=YOUR_INTERFACE_NAME
```

## 🌐 **Cara Kerja**

### **Flow Autentikasi:**
1. **User** buka hotspot → Redirect ke login page Mikrotik
2. **Input** username/password
3. **Mikrotik** kirim ke RADIUS server
4. **RADIUS** validasi dengan database GEMBOK-Bill
5. **Response** success/error ke Mikrotik
6. **User** bisa internet jika valid

### **Login Page:**
- **URL**: `http://192.168.88.1` (default)
- **Interface**: Login form Mikrotik
- **Styling**: Bisa dikustomisasi
- **Language**: Bisa diubah ke Indonesia

## ⚙️ **Konfigurasi Lanjutan**

### **Customize Login Page:**
```bash
# Upload custom HTML
/tool fetch url="http://your-server.com/login.html" dst-path=login.html

# Set custom login page
/ip hotspot profile set radius-hotspot login-page=login.html
```

### **Change DNS:**
```bash
# Set DNS server
/ip hotspot profile set radius-hotspot dns-server=8.8.8.8,8.8.4.4
```

### **Bandwidth Control:**
```bash
# Add bandwidth limit
/ip hotspot profile set radius-hotspot rate-limit=1M/1M
```

## 🔍 **Monitoring & Testing**

### **Check Status:**
```bash
# Check RADIUS status
/radius print

# Check hotspot profile
/ip hotspot profile print detail where use-radius=yes

# Check active users
/ip hotspot active print

# Check RADIUS traffic
/radius incoming monitor duration=10
```

### **Test User:**
1. **Connect** ke hotspot
2. **Buka browser** → Redirect ke login page
3. **Input** username/password dari GEMBOK-Bill
4. **Login** → Harusnya bisa internet

## 🚨 **Troubleshooting**

### **Login Page Tidak Muncul:**
```bash
# Check hotspot status
/ip hotspot print

# Check interface
/interface print

# Restart hotspot
/ip hotspot disable [find]
/ip hotspot enable [find]
```

### **RADIUS Tidak Connect:**
```bash
# Check RADIUS config
/radius print

# Test connection
/radius incoming monitor duration=10

# Check firewall
/ip firewall filter print
```

### **User Tidak Bisa Login:**
1. **Check** username/password di GEMBOK-Bill
2. **Check** RADIUS server running
3. **Check** network connectivity
4. **Check** RADIUS secret match

## 📱 **Mobile Optimization**

### **Responsive Design:**
- Login page Mikrotik sudah responsive
- Bisa diakses dari mobile/tablet
- Auto-detect screen size

### **Custom Mobile Page:**
```bash
# Upload mobile-optimized HTML
/tool fetch url="http://your-server.com/mobile-login.html" dst-path=mobile-login.html

# Set mobile login page
/ip hotspot profile set radius-hotspot login-page=mobile-login.html
```

## 🎨 **Customization**

### **Branding:**
- **Logo**: Upload custom logo
- **Colors**: Custom CSS
- **Text**: Custom messages
- **Language**: Multi-language support

### **Advanced Features:**
- **Splash page**: Custom welcome page
- **Terms**: Accept terms & conditions
- **Social login**: Facebook/Google (advanced)
- **Payment**: Integrate payment gateway

## 🔐 **Security Best Practices**

### **RADIUS Secret:**
- Gunakan secret yang kuat
- Jangan share ke public
- Update secara berkala

### **Network Security:**
- **Firewall** untuk hotspot network
- **VLAN** untuk isolasi
- **MAC filtering** jika perlu

### **User Management:**
- **Password policy** di GEMBOK-Bill
- **Session timeout**
- **Bandwidth limits**

---

## 🎉 **Kesimpulan**

Dengan **Hotspot + RADIUS**, Anda mendapatkan:
- ✅ **Login page otomatis** dari Mikrotik
- ✅ **Autentikasi terpusat** via RADIUS
- ✅ **User management** via GEMBOK-Bill
- ✅ **Monitoring** dan accounting lengkap
- ✅ **Customization** yang fleksibel

**Tidak perlu buat web interface sendiri!** 🚀✨
