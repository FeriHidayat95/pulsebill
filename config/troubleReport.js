const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { getSetting } = require('./settingsManager');
const { sendMessage, setSock } = require('./sendMessage');
// Tambahkan import whatsapp manager yang benar
const whatsappNotifications = require('./whatsapp-notifications'); 
// Helper function untuk format tanggal Indonesia yang benar
function formatIndonesianDateTime(date = new Date()) {
  try {
    let targetDate = new Date(date);
    const currentYear = targetDate.getFullYear();
    if (currentYear > 2024) {
      const yearDiff = currentYear - 2024;
      targetDate = new Date(targetDate.getTime() - (yearDiff * 365 * 24 * 60 * 60 * 1000));
    }
    
    const options = {
      timeZone: 'Asia/Jakarta',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    };
    
    const formatter = new Intl.DateTimeFormat('id-ID', options);
    const parts = formatter.formatToParts(targetDate);
    
    const day = parts.find(part => part.type === 'day').value;
    const month = parts.find(part => part.type === 'month').value;
    const year = parts.find(part => part.type === 'year').value;
    const hour = parts.find(part => part.type === 'hour').value;
    const minute = parts.find(part => part.type === 'minute').value;
    const second = parts.find(part => part.type === 'second').value;
    
    return `${day}/${month}/${year} ${hour}:${minute}:${second}`;
  } catch (error) {
    const d = new Date(date);
    const day = d.getDate().toString().padStart(2, '0');
    const month = (d.getMonth() + 1).toString().padStart(2, '0');
    const year = 2024; 
    const hour = d.getHours().toString().padStart(2, '0');
    const minute = d.getMinutes().toString().padStart(2, '0');
    const second = d.getSeconds().toString().padStart(2, '0');
    
    return `${day}/${month}/${year} ${hour}:${minute}:${second}`;
  }
}
const troubleReportPath = path.join(__dirname, '../logs/trouble_reports.json');
function ensureTroubleReportFile() {
  try {
    if (!fs.existsSync(path.dirname(troubleReportPath))) {
      fs.mkdirSync(path.dirname(troubleReportPath), { recursive: true });
    }
    
    if (!fs.existsSync(troubleReportPath)) {
      fs.writeFileSync(troubleReportPath, JSON.stringify([], null, 2), 'utf8');
      logger.info(`File laporan gangguan dibuat: ${troubleReportPath}`);
    }
  } catch (error) {
    logger.error(`Gagal membuat file laporan gangguan: ${error.message}`);
  }
}
function getAllTroubleReports() {
  ensureTroubleReportFile();
  try {
    const data = fs.readFileSync(troubleReportPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    logger.error(`Gagal membaca laporan gangguan: ${error.message}`);
    return [];
  }
}
function getTroubleReportById(id) {
  const reports = getAllTroubleReports();
  return reports.find(report => report.id === id);
}
function getTroubleReportsByPhone(phone) {
  const reports = getAllTroubleReports();
  return reports.filter(report => report.phone === phone);
}
function createTroubleReport(reportData) {
  try {
    const reports = getAllTroubleReports();
    const id = `TR${Date.now().toString().slice(-6)}${Math.random().toString(36).substring(2, 5).toUpperCase()}`;
    
    const newReport = {
      id,
      status: 'open',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...reportData
    };
    
    reports.push(newReport);
    fs.writeFileSync(troubleReportPath, JSON.stringify(reports, null, 2), 'utf8');
    
    // --- PENAMBAHAN FUNGSI WA OTOMATIS (JALUR TERMINAL PROVEN) ---
    setImmediate(async () => {
        try {
            const { sendTechnicianMessage } = require('./sendMessage');
            const pesanAdmin = `?? *TIKET GANGGUAN BARU* ??\n\n` +
                               `?? *ID Tiket*: ${newReport.id}\n` +
                               `?? *Nama*: ${newReport.name || 'Pelanggan'}\n` +
                               `?? *Kontak*: ${newReport.phone}\n` +
                               `?? *Kategori*: ${newReport.category}\n` +
                               `?? *Keluhan*: ${newReport.description}\n\n` +
                               `_Cek Dashboard Admin sekarang!_`;
            // Tembak langsung ke semua nomor teknisi/admin yang ada di settings.json!
            const success = await sendTechnicianMessage(pesanAdmin, 'high');
            if (success) {
                logger.info(`[WA-REPORT] Tembakan Operation successful Meluncur!`);
            } else {
                logger.warn(`[WA-REPORT] Tembakan gagal, cek koneksi WA.`);
            }
        } catch (e) {
            logger.error(`[WA-REPORT-ERR] Gagal kirim notifikasi: ${e.message}`);
        }
    });
    
    return newReport;
  } catch (error) {
    logger.error(`Gagal membuat laporan gangguan: ${error.message}`);
    return null;
  }
}
function updateTroubleReportStatus(id, status, notes, sendNotification = true) {
  try {
    const reports = getAllTroubleReports();
    const reportIndex = reports.findIndex(report => report.id === id);
    
    if (reportIndex === -1) return null;
    
    reports[reportIndex].status = status;
    reports[reportIndex].updatedAt = new Date().toISOString();
    
    if (notes) {
      if (!reports[reportIndex].notes) reports[reportIndex].notes = [];
      
      const noteEntry = { timestamp: new Date().toISOString(), content: notes, status };
      if (sendNotification) noteEntry.notificationSent = true;
      
      reports[reportIndex].notes.push(noteEntry);
    }
    
    fs.writeFileSync(troubleReportPath, JSON.stringify(reports, null, 2), 'utf8');
    
    if (sendNotification) {
      sendStatusUpdateToCustomer(reports[reportIndex]);
      logger.info(`Notifikasi status laporan ${id} terkirim ke pelanggan`);
    } else {
      logger.info(`Update status laporan ${id} tanpa notifikasi ke pelanggan`);
    }
    
    return reports[reportIndex];
  } catch (error) {
    logger.error(`Gagal mengupdate status laporan gangguan: ${error.message}`);
    return null;
  }
}
async function sendNotificationToTechnicians(report) {
  try {
    logger.info(`?? Mencoba mengirim notifikasi laporan gangguan ${report.id} ke teknisi dan admin`);
    
    const technicianGroupId = getSetting('technician_group_id', '');
    const companyHeader = getSetting('company_header', 'ALIJAYA DIGITAL NETWORK');
    
    const message = `?? *LAPORAN GANGGUAN BARU*
*${companyHeader}*
?? *ID Tiket*: ${report.id}
?? *Pelanggan*: ${report.name || 'N/A'}
?? *No. HP*: ${report.phone || 'N/A'}
?? *Lokasi*: ${report.location || 'N/A'}
?? *Kategori*: ${report.category || 'N/A'}
?? *Waktu Laporan*: ${formatIndonesianDateTime(new Date(report.createdAt))}
?? *Deskripsi Masalah*:
${report.description || 'Tidak ada deskripsi'}
?? *Status*: ${report.status.toUpperCase()}
?? *PRIORITAS TINGGI* - Silakan segera ditindaklanjuti!`;
    let sentSuccessfully = false;
    
    if (technicianGroupId && technicianGroupId !== '') {
      try {
        const result = await sendMessage(technicianGroupId, message);
        if (result) sentSuccessfully = true;
      } catch (error) {}
    }
    
    const { sendTechnicianMessage } = require('./sendMessage');
    try {
      const techResult = await sendTechnicianMessage(message, 'high');
      if (techResult) sentSuccessfully = true;
    } catch (error) {}
    
    if (!sentSuccessfully) {
      try {
        const adminNumber = getSetting('admins.0', '');
        if (adminNumber && adminNumber !== '') {
          const adminMessage = `?? *FALLBACK NOTIFICATION*\n\n?? Notifikasi teknisi gagal!\n\n${message}`;
          const adminResult = await sendMessage(adminNumber, adminMessage);
          if (adminResult) sentSuccessfully = true;
        }
      } catch (adminError) {}
    }
    
    if (!sentSuccessfully) {
      try {
        let i = 0;
        while (i < 5) {
          const adminNumber = getSetting(`admins.${i}`, '');
          if (!adminNumber) break;
          
          try {
            const emergencyMessage = `?? *EMERGENCY NOTIFICATION*\n\n? Semua teknisi gagal menerima notifikasi!\n\n${message}`;
            const result = await sendMessage(adminNumber, emergencyMessage);
            if (result) {
              sentSuccessfully = true;
              break; 
            }
          } catch (e) {}
          i++;
        }
      } catch (emergencyError) {}
    }
    
    try {
      let i = 0;
      let adminNotified = false;
      while (i < 3) { 
        const adminNumber = getSetting(`admins.${i}`, '');
        if (!adminNumber) break;
        
        try {
          const adminMessage = `?? *LAPORAN GANGGUAN - ADMIN NOTIFICATION*\n\n${message}\n\n?? *Info Admin*:\nNotifikasi ini dikirim ke admin untuk monitoring dan koordinasi dengan teknisi.`;
          const adminResult = await sendMessage(adminNumber, adminMessage);
          
          if (adminResult) {
            adminNotified = true;
            sentSuccessfully = true;
            break; 
          }
        } catch (adminError) {}
        i++;
      }
    } catch (adminError) {}
    
    return sentSuccessfully;
  } catch (error) {
    logger.error(`? Error mengirim notifikasi ke teknisi: ${error.message}`);
    return false;
  }
}
async function sendStatusUpdateToCustomer(report) {
  try {
    if (!report.phone) return false;
    
    const waJid = report.phone.replace(/^0/, '62') + '@s.whatsapp.net';
    const companyHeader = getSetting('company_header', 'ISP Monitor');
    
    const statusMap = {
      'open': 'Dibuka',
      'in_progress': 'Sedang Ditangani',
      'resolved': 'Terselesaikan',
      'closed': 'Ditutup'
    };
    
    const latestNote = report.notes && report.notes.length > 0 
      ? report.notes[report.notes.length - 1].content 
      : '';
    
    let message = `?? *UPDATE LAPORAN GANGGUAN*
    
*${companyHeader}*
?? *ID Tiket*: ${report.id}
?? *Update Pada*: ${formatIndonesianDateTime(new Date(report.updatedAt))}
?? *Status Baru*: ${statusMap[report.status] || report.status.toUpperCase()}
${latestNote ? `?? *Catatan Teknisi*:
${latestNote}
` : ''}`;
    
    if (report.status === 'open') {
      message += `Laporan Anda telah diterima dan akan segera ditindaklanjuti oleh tim teknisi kami.`;
    } else if (report.status === 'in_progress') {
      message += `Tim teknisi kami sedang menangani laporan Anda. Mohon kesabarannya.`;
    } else if (report.status === 'resolved') {
      message += `? Laporan Anda telah diselesaikan. Jika masalah sudah benar-benar teratasi, silakan tutup laporan ini melalui portal pelanggan.\n\nJika masalah masih berlanjut, silakan tambahkan komentar pada laporan ini.`;
    } else if (report.status === 'closed') {
      message += `?? Terima kasih telah menggunakan layanan kami. Laporan ini telah ditutup.`;
    }
    
    message += `\n\nJika ada pertanyaan, silakan hubungi kami.`;
    const result = await sendMessage(waJid, message);
    return !!result;
  } catch (error) {
    logger.error(`? Error mengirim update status ke pelanggan: ${error.message}`);
    return false;
  }
}
ensureTroubleReportFile();
function setSockInstance(sockInstance) {
  setSock(sockInstance);
}
function deleteTroubleReport(id) {
  try {
    const reports = getAllTroubleReports();
    const exists = reports.find(r => r.id === id);
    if (!exists) return false;
    const newReports = reports.filter(report => report.id !== id);
    fs.writeFileSync(troubleReportPath, JSON.stringify(newReports, null, 2), 'utf8');
    
    logger.info(`??? Laporan gangguan ${id} berhasil dihapus permanen.`);
    return true;
  } catch (error) {
    logger.error(`Gagal menghapus laporan: ${error.message}`);
    return false;
  }
}
module.exports = {
  getAllTroubleReports,
  getTroubleReportById,
  getTroubleReportsByPhone,
  createTroubleReport,
  updateTroubleReportStatus,
  sendNotificationToTechnicians,
  sendStatusUpdateToCustomer,
  setSockInstance,
  deleteTroubleReport
};
