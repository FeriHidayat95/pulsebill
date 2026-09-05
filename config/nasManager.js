const dbPool = require('./database'); // Menggunakan koneksi MySQL yang ada timezone +07:00

const nasManager = {
    // 1. AMBIL SEMUA DATA NAS
    getAllNAS: async () => {
        try {
            const [rows] = await dbPool.execute('SELECT * FROM nas ORDER BY id DESC');
            return rows || [];
        } catch (err) {
            console.error("[DB ERROR] getAllNAS:", err.message);
            throw err;
        }
    },

    // 2. AMBIL NAS BERDASARKAN ID
    getNASById: async (id) => {
        try {
            const [rows] = await dbPool.execute('SELECT * FROM nas WHERE id = ?', [id]);
            return rows[0] || null;
        } catch (err) {
            console.error("[DB ERROR] getNASById:", err.message);
            throw err;
        }
    },

    // 3. TAMBAH NAS (SUNTIK SEMUA KOLOM)
    addNAS: async (data) => {
        try {
            const sql = 'INSERT INTO nas (nasname, shortname, secret, api_user, api_password, api_port) VALUES (?, ?, ?, ?, ?, ?)';
            const [result] = await dbPool.execute(sql, [
                data.nasname, 
                data.shortname, 
                data.secret, 
                data.api_user, 
                data.api_password, 
                data.api_port || 8728
            ]);
            return result.insertId;
        } catch (err) {
            console.error("[DB ERROR] addNAS:", err.message);
            throw err;
        }
    },

    // 4. UPDATE NAS (DENGAN LOGIKA PASSWORD OPSIONAL)
    updateNAS: async (id, data) => {
        try {
            let sql = 'UPDATE nas SET nasname=?, shortname=?, secret=?, api_user=?, api_port=?';
            let params = [data.nasname, data.shortname, data.secret, data.api_user, data.api_port];

            // PENTING: Fitur jangan dipotong - Tetap cek jika password diisi atau tidak
            if (data.api_password && data.api_password.trim() !== "") { 
                sql += ', api_password=?'; 
                params.push(data.api_password); 
            }

            sql += ' WHERE id=?';
            params.push(id);

            const [result] = await dbPool.execute(sql, params);
            return result;
        } catch (err) {
            console.error("[DB ERROR] updateNAS:", err.message);
            throw err;
        }
    },

    // 5. HAPUS NAS
    deleteNAS: async (id) => {
        try {
            const [result] = await dbPool.execute('DELETE FROM nas WHERE id = ?', [id]);
            return result;
        } catch (err) {
            console.error("[DB ERROR] deleteNAS:", err.message);
            throw err;
        }
    }
};

module.exports = nasManager;