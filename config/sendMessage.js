const { delay } = require('@whiskeysockets/baileys'); 
let sock = null;
// Fungsi untuk set instance sock
function setSock(sockInstance) {
    sock = sockInstance;
}
// Helper function untuk format nomor telepon
function formatPhoneNumber(number) {
    if (!number) return '';
    
    // Pastikan input adalah string agar tidak error saat .replace
    let cleaned = String(number).replace(/\D/g, '');
    
    // Hapus awalan 0 jika ada
    if (cleaned.startsWith('0')) {
        cleaned = cleaned.substring(1);
    }
    
    // Tambahkan kode negara 62 jika belum ada
    if (!cleaned.startsWith('62')) {
        cleaned = '62' + cleaned;
    }
    
    return cleaned;
}
// Helper function untuk mendapatkan header dan footer dari settings
function getHeaderFooter() {
    try {
        const { getSettingsWithCache } = require('./settingsManager');
        const settings = getSettingsWithCache();
        
        return {
            header: settings.company_header || 'PULSEBILL TELECOM',
            footer: settings.footer_info || 'Internet Tanpa Batas'
        };
    } catch (error) {
        return {
            header: 'PULSEBILL TELECOM',
            footer: 'Internet Tanpa Batas'
        };
    }
}
// Helper function untuk memformat pesan dengan header dan footer
function formatMessageWithHeaderFooter(message, includeHeader = true, includeFooter = true) {
    const { header, footer } = getHeaderFooter();
    
    let formattedMessage = '';
    
    // Gunakan Emoji yang Benar (Gedung)
    if (includeHeader) {
        formattedMessage += `?? *${header}*\n\n`;
    }
    
    formattedMessage += message;
    
    if (includeFooter) {
        formattedMessage += `\n\n${footer}`;
    }
    
    return formattedMessage;
}
// Fungsi untuk mengirim pesan (Support Text & Media)
async function sendMessage(number, message) {
    // --- KLEP PENGAMAN 1: Cek apakah socket benar-benar siap ---
    if (!sock || !sock.user) {
        console.log(`[WA-SKIP] ?? WA sedang OFF/Belum Login. Pesan ke ${number} ditahan.`);
        return false;
    }
    try {
        let jid;
        const strNumber = String(number);
        // Handling JID (Group atau Personal)
        if (strNumber.endsWith('@g.us') || strNumber.endsWith('@s.whatsapp.net')) {
            jid = strNumber;
        } else {
            const formattedNumber = formatPhoneNumber(strNumber);
            jid = `${formattedNumber}@s.whatsapp.net`;
        }
        
        // Format pesan dengan header dan footer
        let formattedMessage;
        
        if (typeof message === 'string') {
            formattedMessage = { text: formatMessageWithHeaderFooter(message) };
        } else if (message.text) {
            formattedMessage = { 
                ...message, 
                text: formatMessageWithHeaderFooter(message.text) 
            };
        } else if (message.caption) {
             formattedMessage = {
                ...message,
                caption: formatMessageWithHeaderFooter(message.caption)
             };
        } else {
            formattedMessage = message;
        }
        
        await sock.sendMessage(jid, formattedMessage);
        return true;
    } catch (error) {
        // Kalau errornya 408 (Time-out karena WA mati/lemot), jangan tampilkan log merah panjang!
        if (error?.output?.statusCode === 408) {
            console.log(`[WA-TIMEOUT] ? Pesan ke ${number} gagal (WA sedang offline/delay).`);
        } else {
            console.error(`[WA-ERROR] Gagal kirim ke ${number}:`, error.message || error);
        }
        return false;
    }
}
// Fungsi untuk mengirim pesan ke grup nomor (Broadcast)
async function sendGroupMessage(numbers, message) {
    try {
        // --- KLEP PENGAMAN 2: Cegah Looping Sia-sia ---
        if (!sock || !sock.user) {
            console.log(`[WA-SKIP] ?? WA OFF. Broadcast massal dibatalkan sementara.`);
            return { success: false, sent: 0, failed: numbers.length || 0, results: [] };
        }
        const results = [];
        let sent = 0;
        let failed = 0;
        let numberArray = numbers;
        if (typeof numbers === 'string') {
            numberArray = numbers.split(',').map(n => n.trim());
        }
        if (!Array.isArray(numberArray)) {
             console.error('Invalid numbers format');
             return { success: false, sent: 0, failed: 0, results: [] };
        }
        for (const number of numberArray) {
            try {
                let cleanNumber = formatPhoneNumber(number);
                
                if (cleanNumber.length < 10) {
                    console.warn(`[WA-SKIP] Nomor tidak valid: ${number}`);
                    failed++;
                    results.push({ number, success: false, error: 'Invalid format' });
                    continue;
                }
                // Eksekusi (Aman karena sendMessage sudah punya peredam 408)
                const isSent = await sendMessage(cleanNumber, message);
                
                if (isSent) {
                    console.log(`[WA-SENT] ?? Pesan meluncur ke: ${cleanNumber}`);
                    sent++;
                    results.push({ number: cleanNumber, success: true });
                } else {
                    failed++;
                    results.push({ number: cleanNumber, success: false, error: 'Send failed' });
                }
                
                const randomDelay = Math.floor(Math.random() * 2000) + 1500;
                await new Promise(resolve => setTimeout(resolve, randomDelay));
            } catch (error) {
                console.error(`[WA-LOOP-ERR] Error ke ${number}:`, error.message);
                failed++;
                results.push({ number, success: false, error: error.message });
            }
        }
        return { success: sent > 0, sent, failed, results };
    } catch (error) {
        console.error('Error in sendGroupMessage:', error);
        return { success: false, sent: 0, failed: numbers ? numbers.length : 0, results: [] };
    }
}
// Fungsi untuk mengirim pesan ke grup teknisi
async function sendTechnicianMessage(message, priority = 'normal') {
    try {
        const { getSetting } = require('./settingsManager');
        const technicianNumbers = [];
        
        let i = 0;
        while (true) {
            const number = getSetting(`technician_numbers.${i}`, '');
            if (!number) break;
            technicianNumbers.push(number);
            i++;
        }
        
        const technicianGroupId = getSetting('technician_group_id', '');
        let sentToGroup = false;
        let sentToNumbers = false;
        // PERBAIKAN EMOJI
        let priorityIcon = '';
        if (priority === 'high') {
            priorityIcon = '?? *PENTING* ';
        } else if (priority === 'low') {
            priorityIcon = '?? *Info* ';
        }
        const priorityMessage = priorityIcon + message;
        // Kirim ke grup jika ada ID grupnya
        if (technicianGroupId) {
            try {
                // Pastikan ID grup valid (berakhiran @g.us)
                const groupId = technicianGroupId.endsWith('@g.us') ? technicianGroupId : `${technicianGroupId}@g.us`;
                await sendMessage(groupId, priorityMessage);
                sentToGroup = true;
                console.log(`Pesan dikirim ke grup teknisi: ${groupId}`);
            } catch (e) {
                console.error('Gagal mengirim ke grup teknisi:', e);
            }
        }
        
        // Kirim ke nomor teknisi secara personal (PM)
        if (technicianNumbers && technicianNumbers.length > 0) {
            console.log(`?? Mengirim ke ${technicianNumbers.length} nomor teknisi`);
            const result = await sendGroupMessage(technicianNumbers, priorityMessage);
            sentToNumbers = result.success;
        } else {
            // Fallback ke admin
            console.log(`?? Tidak ada nomor teknisi, fallback ke admin`);
            const adminNumber = getSetting('admins.0', '');
            
            if (adminNumber) {
                console.log(`?? Fallback: Mengirim ke admin ${adminNumber}`);
                const adminResult = await sendMessage(adminNumber, priorityMessage);
                sentToNumbers = adminResult;
            }
        }
        return sentToGroup || sentToNumbers;
    } catch (error) {
        console.error('Error sending message to technician group:', error);
        return false;
    }
}
module.exports = {
    setSock,
    sendMessage,
    sendGroupMessage,
    sendTechnicianMessage,
    formatMessageWithHeaderFooter,
    getHeaderFooter
};
