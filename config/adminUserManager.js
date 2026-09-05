const pool = require('./database'); // Pastikan ini mengarah ke koneksi MariaDB Bos

// [READ] Ambil semua data user
async function getAllUsers() {
    const [rows] = await pool.query("SELECT id, username, name, role, created_at FROM admins ORDER BY id ASC");
    return rows;
}

// [CREATE] Tambah user baru
async function addUser(data) {
    const { username, name, password, role } = data;
    await pool.query(
        "INSERT INTO admins (username, name, password, role) VALUES (?, ?, ?, ?)", 
        [username, name, password, role]
    );
}

// [UPDATE] Edit user yang sudah ada
async function updateUser(data) {
    const { id, username, name, role, password } = data;
    
    // Kalau password diisi, ubah passwordnya. Kalau kosong, abaikan password.
    if (password && password.trim() !== '') {
        await pool.query(
            "UPDATE admins SET username = ?, name = ?, role = ?, password = ? WHERE id = ?", 
            [username, name, role, password, id]
        );
    } else {
        await pool.query(
            "UPDATE admins SET username = ?, name = ?, role = ? WHERE id = ?", 
            [username, name, role, id]
        );
    }
}

// [DELETE] Hapus user
async function deleteUser(id) {
    // Pengamanan Ekstra di level Database
    if (id == 1) {
        throw new Error("Pemberontakan Ditolak: Sultan Utama tidak boleh dihapus!");
    }
    await pool.query("DELETE FROM admins WHERE id = ?", [id]);
}

// Ekspor semua fungsi agar bisa dipakai oleh Resepsionis (Router)
module.exports = {
    getAllUsers,
    addUser,
    updateUser,
    deleteUser
};