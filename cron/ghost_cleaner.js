const dbPool = require('../config/database');
const nasManager = require('../config/nasManager');
const RosApi = require('node-routeros').RouterOSAPI;

async function cleanGhostSessions() {
    let conn;
    try {
        // 1. Ambil User yang tercatat ONLINE di Database (acctstoptime IS NULL)
        conn = await dbPool.getConnection();
        const [dbUsers] = await conn.query(`
            SELECT radacctid, username, nasipaddress 
            FROM radacct 
            WHERE acctstoptime IS NULL
        `);

        if (dbUsers.length === 0) {
            conn.release();
            return; // Gak ada user online, skip.
        }

        // Kelompokkan user berdasarkan Router (NAS)
        const usersByNas = {};
        dbUsers.forEach(u => {
            if (!usersByNas[u.nasipaddress]) usersByNas[u.nasipaddress] = [];
            usersByNas[u.nasipaddress].push(u);
        });

        // 2. Loop setiap Router Mikrotik
        const allNas = await nasManager.getAllNAS();
        
        for (const nas of allNas) {
            const targetUsers = usersByNas[nas.nasname];
            if (!targetUsers || targetUsers.length === 0) continue;

            try {
                // Koneksi ke Mikrotik
                const api = new RosApi({
                    host: nas.nasname,
                    user: nas.api_user,
                    password: nas.api_password,
                    port: parseInt(nas.api_port) || 8728,
                    timeout: 5
                });
                await api.connect();

                // Ambil User Realtime di Mikrotik (PPPoE & Hotspot)
                const pppActive = await api.write('/ppp/active/print');
                const hotspotActive = await api.write('/ip/hotspot/active/print');
                api.close();

                // Gabungkan list user online Mikrotik
                const realOnlineUsers = new Set([
                    ...pppActive.map(u => u.name),
                    ...hotspotActive.map(u => u.user)
                ]);

                // 3. Bandingkan! Siapa yang Hantu?
                const ghostIds = [];
                for (const dbUser of targetUsers) {
                    // Kalau user ada di DB, tapi GAK ADA di Mikrotik => HANTU!
                    if (!realOnlineUsers.has(dbUser.username)) {
                        ghostIds.push(dbUser.radacctid);
                        console.log(`[GHOST-CLEANER] Menghapus sesi hantu: ${dbUser.username} di ${nas.shortname}`);
                    }
                }

                // 4. Bersihkan Hantu di Database
                if (ghostIds.length > 0) {
                    // Trik IN (?) array binding
                    const placeholders = ghostIds.map(() => '?').join(',');
                    await conn.query(
                        `UPDATE radacct SET 
                            acctstoptime = NOW(), 
                            acctterminatecause = 'Ghost-Session-Cleanup' 
                         WHERE radacctid IN (${placeholders})`,
                        ghostIds
                    );
                }

            } catch (err) {
                console.error(`[GHOST-CLEANER] Gagal connect ke Mikrotik ${nas.shortname}:`, err.message);
                // Lanjut ke NAS berikutnya, jangan berhenti total
            }
        }

    } catch (e) {
        console.error('[GHOST-CLEANER] Error Utama:', e.message);
    } finally {
        if (conn) conn.release();
    }
}

module.exports = cleanGhostSessions;