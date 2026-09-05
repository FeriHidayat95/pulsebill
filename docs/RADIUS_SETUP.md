# RADIUS Server Setup dan Konfigurasi

## 🎯 Overview

RADIUS Server terintegrasi dengan sistem billing GEMBOK-Bill untuk autentikasi PPPoE dan Hotspot pengguna secara otomatis. Server ini akan mengautentikasi user berdasarkan data customer di sistem billing.

## 🚀 Fitur RADIUS Server

### ✅ **Authentication (Port 1812)**
- Autentikasi PPPoE users
- Autentikasi Hotspot users  
- Integrasi dengan sistem billing
- Bandwidth control berdasarkan package
- Session timeout management

### ✅ **Accounting (Port 1813)**
- Session tracking
- Bandwidth monitoring
- Connection logging
- Real-time session management

### ✅ **Management Features**
- Web-based admin panel
- NAS client management
- Active session monitoring
- Real-time server status

## 🔧 Setup dan Konfigurasi

### **1. Start RADIUS Server**

1. Login ke Admin Panel
2. Buka menu **"RADIUS Server"**
3. Klik **"Start Server"**
4. Server akan aktif di port **1812** (Auth) dan **1813** (Accounting)

### **2. Konfigurasi NAS Client**

Tambah setiap Mikrotik sebagai NAS client:

**Default NAS Clients:**
- `127.0.0.1` - Secret: `testing123`
- `192.168.1.1` - Secret: `mikrotik123`

**Menambah NAS Client Baru:**
1. Di halaman RADIUS Server admin
2. Klik **"Tambah NAS Client"**
3. Isi:
   - **IP Address**: IP Mikrotik (contoh: `192.168.10.1`)
   - **Secret**: Password rahasia (contoh: `secret123`)
   - **Name**: Nama identifikasi (contoh: `Mikrotik Tower 1`)

## 🔌 Konfigurasi Mikrotik

### **A. Konfigurasi RADIUS Client**

```bash
# Tambah RADIUS server
/radius
add address=IP_GEMBOK_BILL_SERVER secret=testing123 service=ppp timeout=3s

# Contoh jika GEMBOK-Bill di 192.168.1.100
/radius
add address=192.168.1.100 secret=testing123 service=ppp timeout=3s
```

### **B. Konfigurasi PPPoE Server**

```bash
# Set PPPoE server menggunakan RADIUS
/interface pppoe-server server
set default-profile=default use-radius=yes

# Atau edit existing PPPoE server
/interface pppoe-server server
set [find] use-radius=yes
```

### **C. Konfigurasi PPP Profile**

```bash
# Buat profile default untuk RADIUS
/ppp profile
add name="radius-profile" use-radius=yes local-address=192.168.100.1 remote-address=192.168.100.2-192.168.100.254

# Set as default profile
/interface pppoe-server server
set default-profile=radius-profile
```

### **D. Konfigurasi Hotspot (Opsional)**

```bash
# Setup RADIUS untuk Hotspot
/ip hotspot profile
set [find] use-radius=yes

# Add RADIUS untuk hotspot service
/radius
add address=IP_GEMBOK_BILL_SERVER secret=testing123 service=hotspot timeout=3s
```

## 🔐 User Authentication Flow

### **1. PPPoE Authentication**
```
1. User dial PPPoE dengan username/password
2. Mikrotik kirim Access-Request ke RADIUS server
3. RADIUS server cek di database billing:
   - Username ada?
   - Password benar?
   - Status customer aktif?
   - Ada paket aktif?
4. Jika OK: Access-Accept + bandwidth attributes
5. Jika gagal: Access-Reject
```

### **2. Bandwidth Control**
RADIUS server otomatis set bandwidth berdasarkan paket customer:

- **Upload Speed**: Dari `package.upload_speed`
- **Download Speed**: Dari `package.download_speed`
- **Session Timeout**: Default 1 jam
- **Idle Timeout**: Default 5 menit

### **3. Session Management**
- Session tracking real-time
- Accounting data (RX/TX bytes)
- Connection duration monitoring
- Automatic session cleanup

## 📊 Monitoring dan Management

### **Admin Panel Features:**

**🖥️ Server Status**
- Running/Stopped status
- Port configuration
- Active NAS clients
- Active sessions count

**🌐 NAS Client Management**
- Add/Remove NAS clients
- IP address validation
- Secret management
- Client identification

**👥 Active Sessions**
- Real-time session list
- Username dan session ID
- NAS IP dan Framed IP
- Start time dan duration
- RX/TX bytes monitoring

### **API Endpoints:**

```bash
# Get server status
GET /admin/radius/status

# Get active sessions
GET /admin/radius/sessions

# Get NAS clients
GET /admin/radius/nas

# Start/Stop server
POST /admin/radius/start
POST /admin/radius/stop

# Manage NAS clients
POST /admin/radius/nas/add
POST /admin/radius/nas/remove
```

## 🚨 Troubleshooting

### **Common Issues:**

**1. RADIUS Server tidak start**
- Check port 1812/1813 tidak digunakan aplikasi lain
- Check permissions untuk bind ke port
- Lihat log error di `/logs/error.log`

**2. Authentication gagal**
- Pastikan NAS client IP dan secret benar
- Check username/password di database billing
- Pastikan customer status = 'active'
- Check customer punya paket aktif

**3. Mikrotik tidak bisa connect**
- Check firewall rules
- Pastikan RADIUS service enabled
- Verify secret match antara Mikrotik dan RADIUS server
- Check routing antara Mikrotik dan GEMBOK-Bill server

### **Debug Commands:**

```bash
# Test RADIUS dari Mikrotik
/radius incoming print

# Monitor RADIUS traffic
/radius incoming monitor

# Check PPPoE sessions
/interface pppoe-server print

# Debug PPP
/ppp active print detail
```

### **Log Monitoring:**

Check log files:
- `/logs/info.log` - Normal operations
- `/logs/error.log` - Error messages
- `/logs/warn.log` - Warnings

## 🔧 Advanced Configuration

### **Database Integration**

RADIUS server terintegrasi langsung dengan:
- **Customer table**: Authentication data
- **Packages table**: Bandwidth limits
- **Billing table**: Subscription status

### **Custom Attributes**

Support RADIUS attributes:
- `Session-Timeout`: Durasi maksimal session
- `Idle-Timeout`: Timeout ketika idle
- `Framed-IP-Address`: Static IP assignment
- `WISPr-Bandwidth-Max-Up`: Upload bandwidth limit
- `WISPr-Bandwidth-Max-Down`: Download bandwidth limit

### **Security Features**

- **Shared Secret**: Secure communication dengan NAS
- **IP-based NAS validation**: Hanya NAS terdaftar yang bisa connect
- **Session validation**: Prevent session hijacking
- **Password encryption**: RADIUS password encryption

## 📈 Performance Tips

### **Optimization:**

1. **Database Indexing**: Index pada customer.username untuk query cepat
2. **Connection Pooling**: Reuse database connections
3. **Memory Management**: Cleanup inactive sessions
4. **Logging Level**: Sesuaikan level logging untuk production

### **Scaling:**

- Support multiple NAS clients
- Session limit berdasarkan server resources
- Database performance optimization
- Load balancing untuk multiple RADIUS servers

## 📞 Support

Jika ada masalah dengan RADIUS server:

1. Check admin panel untuk status dan error
2. Review log files untuk detail error
3. Verify Mikrotik configuration
4. Test authentication manual
5. Contact technical support

---

**🎉 Selamat! RADIUS Server sudah siap digunakan!**

Sistem sekarang dapat melakukan autentikasi PPPoE/Hotspot otomatis berdasarkan data customer di sistem billing.
